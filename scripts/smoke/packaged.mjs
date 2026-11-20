// MODULE: packaged.mjs - smoke-tests the packaged BMN build with its own HOME and XDG roots, so it runs while the owner's BMN is open
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliModules } from '../lib/cli-modules.mjs'
import { packagedApp } from '../lib/packaged-app.mjs'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
// `--root FOLDER` smokes a build other than the live one: the update checks its staged build before swapping it in.
const rootIndex = process.argv.indexOf('--root')
const root = rootIndex > 0 ? resolve(process.argv[rootIndex + 1] ?? '') : undefined
const { binary: packagedBinary, resources: packagedResources } = packagedApp(repoRoot, { root })
const packagedTerminfo = join(packagedResources, 'terminfo/x/xterm-sixel-256color')
/**
 * The BMN folders a build would make under HOME if it ignored its XDG roots. The smoke gives the candidate a HOME of
 * its own, apart from its temporary XDG roots (Story 134.2, D2): it never reads or writes the owner's real folders,
 * so it runs while his BMN is open and writing them, and a path that leaks to HOME still fails here.
 */
export const homeBmnFolders = (home) => ['.config', '.local/share', '.local/state', '.cache']
  .flatMap((base) => ['bmn', 'ai-terminal'].map((name) => join(home, base, name)))

/** Fails when the candidate wrote anything into its HOME's BMN folders. */
export function assertHomeUntouched(home, exists = existsSync) {
  const written = homeBmnFolders(home).filter((path) => exists(path))
  if (written.length > 0) throw new Error(`the packaged build wrote into HOME instead of its XDG roots: ${written.join(', ')}`)
}

/** The live BMN session's own variables; a candidate under test must never reach the BMN the owner is using. */
const LIVE_SESSION_VARIABLES = ['BMN_SESSION_ID', 'BMN_TOKEN', 'BMN_CONTROL_SOCKET', 'BMN_CLI_BIN_DIR']

/** The environment every candidate process gets: its own HOME and XDG roots, synthetic agent config folders. */
export function isolatedEnvironment(roots, environment = process.env) {
  const isolated = { ...environment }
  for (const name of LIVE_SESSION_VARIABLES) delete isolated[name]
  return {
    ...isolated,
    HOME: roots.home,
    XDG_CONFIG_HOME: roots.config,
    XDG_DATA_HOME: roots.data,
    XDG_STATE_HOME: roots.state,
    XDG_CACHE_HOME: roots.cache,
    XDG_RUNTIME_DIR: roots.runtime,
    // Hook checks in the packaged self-test must see synthetic config paths, never the
    // owner's real Claude, Codex or OpenCode files.
    CLAUDE_CONFIG_DIR: join(roots.config, 'claude'),
    CODEX_HOME: join(roots.config, 'codex'),
    OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'),
    BMN_CONFIG_HOME: join(roots.config, 'bmn'),
    BMN_DATA_HOME: join(roots.data, 'bmn'),
    BMN_STATE_HOME: join(roots.state, 'bmn'),
    BMN_RUNTIME_HOME: join(roots.runtime, 'bmn')
  }
}

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

const directlyInvoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (directlyInvoked) await smoke()

/** The smoke itself; run directly, never on import (the tests read its isolation helpers). */
async function smoke() {
  // Test-only switch: lets a real update run prove what a failed smoke leaves behind.
  if (process.env.BMN_SMOKE_FORCE_FAILURE === '1') throw new Error('packaged smoke failed on purpose (BMN_SMOKE_FORCE_FAILURE=1)')
  if (!existsSync(packagedBinary)) throw new Error(`packaged binary is missing: ${packagedBinary}`)
  if (!existsSync(packagedTerminfo)) throw new Error(`packaged Sixel terminfo is missing: ${packagedTerminfo}`)
  if (!existsSync(join(packagedResources, 'self-test/remote-answers/claude/ask-single.pre-tool-use.json'))) {
    throw new Error(`packaged self-test fixtures are missing: ${join(packagedResources, 'self-test/remote-answers')}`)
  }
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
  // The bmn CLI loads its parts by relative path on BMN's own runtime. A part the build left out breaks
  // its command, and the prompt guard reads its own missing file as "no guard": load every one here.
  const packagedCli = [
    ...cliModules(join(repoRoot, 'apps/desktop/bin')).map(name => join(packagedResources, 'bin', name)),
    ...readdirSync(join(repoRoot, 'scripts/plan')).filter(name => name.endsWith('.mjs')).map(name => join(packagedResources, 'scripts/plan', name))
  ]
  if (!existsSync(join(packagedResources, 'scripts/plan/cutover-watchdog.py'))) throw new Error('packaged migration watchdog is missing')
  const missingCli = packagedCli.filter(file => !existsSync(file))
  if (missingCli.length > 0) throw new Error(`packaged bmn CLI files are missing: ${missingCli.join(', ')}`)

  const originalRuntime = process.env.XDG_RUNTIME_DIR
  const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
  const waylandDisplay =
    originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
      ? join(originalRuntime, originalWaylandDisplay)
      : originalWaylandDisplay

  await withTemporaryRoot(temporaryRootContracts.packagedSmoke, async ({ roots }) => {
    const cliLoad = spawnSync(packagedBinary, [
      '-e', 'Promise.all(process.argv.slice(1).map(file => import(file))).catch(error => { console.error(error.message); process.exit(1) })',
      ...packagedCli
    ], { encoding: 'utf8', timeout: 60_000, env: { ...isolatedEnvironment(roots), ELECTRON_RUN_AS_NODE: '1' } })
    if (cliLoad.status !== 0) {
      throw new Error(`packaged bmn CLI does not load: ${(cliLoad.stderr || cliLoad.error?.message || `exit ${cliLoad.status}`).slice(-1_000)}`)
    }
    // The self-test hands window focus back and forth. On the owner's desktop his own windows (and the
    // launcher's "BMN is updating" window) take that focus mid-run, so the smoke gets a display of its own.
    const privateDisplay = process.env.BMN_SMOKE_OWNER_DISPLAY !== '1' && spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status === 0
    const selfTest = privateDisplay
      ? ['xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', packagedBinary, '--ozone-platform=x11', '--self-test']
      : [packagedBinary, ...(!waylandDisplay && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--self-test']
    const result = spawnSync(selfTest[0], selfTest.slice(1), {
      encoding: 'utf8',
      // The self-test covers renderer and host restarts, remote answers and agent history; it took
      // about two minutes by Epic 31, so the bound leaves room for slower machines and later phases.
      timeout: 300_000,
      env: {
        ...isolatedEnvironment(roots),
        // The synthetic session fixtures run on this Node, as in the source self-test.
        BMN_SELF_TEST_NODE: process.execPath,
        ...(privateDisplay ? { WAYLAND_DISPLAY: '' } : waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
      }
    })
    // A timeout keeps the output so far; the self-test prints its phases on stderr, so its last lines
    // name the phase it was in.
    if (result.error) {
      throw new Error(`packaged self-test failed: ${result.error.message}; last stderr=${JSON.stringify(result.stderr?.slice(-2_000) ?? '')}`)
    }
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
      receipt.sixelPty?.beforeMB !== 0 || !(receipt.sixelPty?.afterMB > 0) ||
      receipt.sixelPty?.layer !== true ||
      !(receipt.sixelRender?.ownStorageMB > 0 && receipt.sixelRender?.ownLayer === true &&
        receipt.sixelRender?.otherStorageMB === 0 && receipt.sixelRender?.otherImageUnchanged === true) ||
      receipt.cspProbe?.evalRefused !== true || receipt.cspProbe?.wasmAllowed !== true ||
      receipt.graphicsTerminfo?.sixelResolved !== true ||
      receipt.graphicsTerminfo?.standardResolved !== true ||
      receipt.graphicsTerminfo?.initialTerm !== 'xterm-sixel-256color' ||
      receipt.graphicsTerminfo?.fallbackTerm !== 'xterm-256color' ||
      receipt.graceful !== true
    ) {
      throw new Error(`packaged self-test receipt was incomplete: ${JSON.stringify(receipt)}`)
    }
    assertHomeUntouched(roots.home)
    console.log(JSON.stringify({ packagedSmoke: 'passed', binary: packagedBinary, voiceEngine: packagedWhisper, ...receipt }))
  })
}
