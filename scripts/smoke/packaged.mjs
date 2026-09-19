import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOwnerRootsUnchanged, fingerprintOwnerRoots } from '../lib/owner-root-guard.mjs'
import { packagedApp } from '../lib/packaged-app.mjs'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const { binary: packagedBinary, resources: packagedResources } = packagedApp(repoRoot)
const ownerRoots = [
  join(homedir(), '.config/bmn'),
  join(homedir(), '.local/share/bmn'),
  join(homedir(), '.local/state/bmn'),
  join(homedir(), '.config/ai-terminal'),
  join(homedir(), '.local/share/ai-terminal'),
  join(homedir(), '.local/state/ai-terminal')
]

// The owner may already use the app, so the smoke proves it leaves their real roots untouched.
// Quit BMN first; a running copy would change these files during the smoke.
const ownerFingerprint = () => fingerprintOwnerRoots(ownerRoots, { existsSync, lstatSync, readdirSync })

function parseReceipt(stdout) {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed?.selfTest === 'session-roundtrip') return parsed
    } catch {
      // Electron may emit non-JSON diagnostics around the one self-test receipt.
    }
  }
  throw new Error(`packaged self-test emitted no session-roundtrip receipt: ${stdout.slice(-1_000)}`)
}

if (!existsSync(packagedBinary)) throw new Error(`packaged binary is missing: ${packagedBinary}`)
const packagedWhisper = join(packagedResources, 'whisper/whisper-cli')
if (!existsSync(packagedWhisper) || (statSync(packagedWhisper).mode & 0o111) === 0) {
  throw new Error(`packaged voice engine is missing or not executable: ${packagedWhisper}`)
}
if (spawnSync(packagedWhisper, ['--help'], { stdio: 'ignore' }).status !== 0) {
  throw new Error(`packaged voice engine does not run: ${packagedWhisper}`)
}
// Dictation first asks the speech detector whether a recording holds speech; one second of silence must hold none.
const packagedDetector = join(packagedResources, 'whisper/whisper-vad-speech-segments')
const silenceFolder = mkdtempSync(join(tmpdir(), 'bmn-smoke-voice-'))
try {
  const silence = Buffer.alloc(44 + 32_000)
  silence.write('RIFF', 0); silence.writeUInt32LE(36 + 32_000, 4); silence.write('WAVEfmt ', 8); silence.writeUInt32LE(16, 16)
  silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22); silence.writeUInt32LE(16_000, 24); silence.writeUInt32LE(32_000, 28)
  silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write('data', 36); silence.writeUInt32LE(32_000, 40)
  writeFileSync(join(silenceFolder, 'silence.wav'), silence)
  const detection = spawnSync(packagedDetector, [
    '-f', join(silenceFolder, 'silence.wav'), '-vm', join(packagedResources, 'whisper/ggml-silero-v6.2.0.bin'), '-vt', '0.3', '-vspd', '0', '-np'
  ], { encoding: 'utf8' })
  if (detection.status !== 0 || !/Detected 0 speech segments/u.test(detection.stdout ?? '')) {
    throw new Error(`packaged speech detector does not work: ${packagedDetector}`)
  }
} finally {
  rmSync(silenceFolder, { recursive: true, force: true })
}
const ownerRootsBefore = ownerFingerprint()

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay =
  originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
    ? join(originalRuntime, originalWaylandDisplay)
    : originalWaylandDisplay

await withTemporaryRoot(temporaryRootContracts.packagedSmoke, async ({ roots }) => {
  const result = spawnSync(packagedBinary, ['--self-test'], {
    encoding: 'utf8',
    // The self-test now covers renderer and host restarts; it takes about 40 seconds.
    timeout: 120_000,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`packaged self-test terminated by ${result.signal}`)
  if (result.status !== 0) {
    throw new Error(
      `packaged self-test exited ${result.status}; stderr=${JSON.stringify(result.stderr.slice(-1_000))}`
    )
  }
  const receipt = parseReceipt(result.stdout)
  if (
    receipt.electronVersion !== '44.3.0' ||
    receipt.nativeModules?.nodePty !== true ||
    receipt.nativeModules?.betterSqlite3 !== true ||
    receipt.helloHandshake !== true ||
    receipt.markerObserved !== true ||
    receipt.resized?.cols !== 101 ||
    receipt.resized?.rows !== 37 ||
    receipt.rendererRestartNoDuplicateProcesses !== true ||
    receipt.applicationRestartNoAutoStart !== true ||
    receipt.graceful !== true
  ) {
    throw new Error(`packaged self-test receipt was incomplete: ${JSON.stringify(receipt)}`)
  }
  assertOwnerRootsUnchanged(ownerRootsBefore, ownerFingerprint(), 'during packaged smoke')
  console.log(JSON.stringify({ packagedSmoke: 'passed', binary: packagedBinary, voiceEngine: packagedWhisper, ...receipt }))
})
