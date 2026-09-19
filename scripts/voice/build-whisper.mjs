// MODULE: build-whisper.mjs - builds the pinned whisper.cpp command-line engine into apps/desktop/resources/whisper
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WHISPER_VERSION = '1.9.4'
const SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_VERSION}.tar.gz`
const SOURCE_SHA256 = '57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae'
// Used through uvx only when cmake is not installed.
const CMAKE_VERSION = '4.1.2'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(repository, 'apps/desktop/resources/whisper')
const cache = join(repository, 'node_modules/.cache/whisper.cpp')
const tarball = join(cache, `whisper.cpp-${WHISPER_VERSION}.tar.gz`)
const source = join(cache, `whisper.cpp-${WHISPER_VERSION}`)
const build = join(source, 'build')

// Upstream applies audio_ctx only after language detection, so with "Detect automatically" every dictation first
// encoded a full 30-second window: 3.6 s of a 3-second phrase on a 6-core CPU, against 1.2 s with the language set.
const PATCHES = [
  {
    id: 'audio-ctx-before-language-detection',
    file: 'src/whisper.cpp',
    anchor: '    // auto-detect language if not specified\n',
    insert: [
      '    // aiterm patch audio-ctx-before-language-detection: detection encodes only the recording, like transcription',
      '    if (params.audio_ctx > 0 && params.audio_ctx <= whisper_n_audio_ctx(ctx)) {',
      '        state->exp_n_audio_ctx = params.audio_ctx;',
      '    }',
      ''
    ].join('\n')
  }
]
// Whisper invents text for silence, so BMN transcribes only recordings in which whisper.cpp's stock speech-segment tool
// finds speech. Its Silero model ships in the source archive under a test name; the bytes equal ggml-org/whisper-vad's
// ggml-silero-v6.2.0.bin (MIT, snakers4/silero-vad) and are pinned here as well.
const SPEECH_DETECTOR = 'whisper-vad-speech-segments'
const SPEECH_MODEL = {
  source: 'models/for-tests-silero-v6.2.0-ggml.bin',
  file: 'ggml-silero-v6.2.0.bin',
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'
}
const stamp = `whisper.cpp ${WHISPER_VERSION} ${SOURCE_SHA256}${PATCHES.map((patch) => ` +${patch.id}`).join('')} +${SPEECH_DETECTOR} +${SPEECH_MODEL.file}\n`

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Applies each patch once; an anchor that is missing or not unique stops the build instead of guessing. */
function applyPatches() {
  for (const patch of PATCHES) {
    const path = join(source, patch.file)
    const text = readFileSync(path, 'utf8')
    if (text.includes(`aiterm patch ${patch.id}:`)) continue
    if (text.split(patch.anchor).length !== 2) throw new Error(`whisper.cpp patch ${patch.id} does not match ${patch.file}; nothing was built`)
    writeFileSync(`${path}.part`, text.replace(patch.anchor, `${patch.insert}${patch.anchor}`))
    renameSync(`${path}.part`, path)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`)
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

function cmake() {
  if (commandWorks('cmake', ['--version'])) return { command: 'cmake', prefix: [] }
  if (commandWorks('uvx', ['--version'])) return { command: 'uvx', prefix: ['--from', `cmake==${CMAKE_VERSION}`, 'cmake'] }
  throw new Error('whisper.cpp needs cmake; install cmake or uv (https://docs.astral.sh/uv/) and run again')
}

async function sourceTarball() {
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  if (existsSync(tarball) && sha256(readFileSync(tarball)) === SOURCE_SHA256) return
  console.log(`downloading ${SOURCE_URL}`)
  const response = await fetch(SOURCE_URL)
  if (!response.ok) throw new Error(`whisper.cpp download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha256(bytes) !== SOURCE_SHA256) throw new Error('whisper.cpp source failed its pinned checksum; nothing was built')
  mkdirSync(cache, { recursive: true })
  writeFileSync(`${tarball}.part`, bytes)
  renameSync(`${tarball}.part`, tarball)
}

const binary = join(output, 'whisper-cli')
const detector = join(output, SPEECH_DETECTOR)
const speechModel = join(output, SPEECH_MODEL.file)
if (!process.argv.includes('--force') && [binary, detector, speechModel].every(existsSync) && readText(join(output, 'VERSION')) === stamp) {
  console.log(`whisper.cpp ${WHISPER_VERSION} is already built at ${binary}`)
  process.exit(0)
}

await sourceTarball()
if (!existsSync(join(source, 'CMakeLists.txt'))) {
  rmSync(source, { recursive: true, force: true })
  run('tar', ['-xzf', tarball, '-C', cache])
}
applyPatches()

// A build folder configured at another checkout path (the repository was once renamed) is refused by cmake; start over.
const configuredFor = /^CMAKE_CACHEFILE_DIR:INTERNAL=(.*)$/mu.exec(readText(join(build, 'CMakeCache.txt')))?.[1]
if (configuredFor !== undefined && configuredFor !== build) rmSync(build, { recursive: true, force: true })

const { command, prefix } = cmake()
// GGML_NATIVE tunes the engine for this computer's CPU; the build is for this machine, not for distribution.
run(command, [
  ...prefix,
  '-S', source,
  '-B', build,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DGGML_NATIVE=ON'
])
run(command, [...prefix, '--build', build, '--config', 'Release', '--target', 'whisper-cli', SPEECH_DETECTOR, '-j', String(availableParallelism())])

const modelBytes = readFileSync(join(source, SPEECH_MODEL.source))
if (createHash('sha256').update(modelBytes).digest('hex') !== SPEECH_MODEL.sha256) {
  throw new Error(`${SPEECH_MODEL.source} failed its pinned checksum; nothing was installed`)
}

// A detector that never hears speech would silently disable dictation, so prove it on speech and on silence.
function speechSegments(wav) {
  const result = spawnSync(join(build, 'bin', SPEECH_DETECTOR), ['-f', wav, '-vm', join(source, SPEECH_MODEL.source), '-vt', '0.3', '-vspd', '0', '-np'], { encoding: 'utf8' })
  const match = /Detected (\d+) speech segments/u.exec(result.stdout ?? '')
  if (result.status !== 0 || !match) throw new Error(`built ${SPEECH_DETECTOR} gave no result for ${wav}`)
  return Number(match[1])
}
const silence = Buffer.alloc(44 + 32_000)
silence.write('RIFF', 0); silence.writeUInt32LE(36 + 32_000, 4); silence.write('WAVEfmt ', 8); silence.writeUInt32LE(16, 16)
silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22); silence.writeUInt32LE(16_000, 24); silence.writeUInt32LE(32_000, 28)
silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write('data', 36); silence.writeUInt32LE(32_000, 40)
writeFileSync(join(build, 'silence.wav'), silence)
if (speechSegments(join(source, 'samples', 'jfk.wav')) === 0 || speechSegments(join(build, 'silence.wav')) !== 0) {
  throw new Error(`built ${SPEECH_DETECTOR} does not tell speech from silence; nothing was installed`)
}

mkdirSync(output, { recursive: true })
for (const [name, target] of [['whisper-cli', binary], [SPEECH_DETECTOR, detector]]) {
  const built = join(build, 'bin', name)
  if (!commandWorks(built, ['--help'])) throw new Error(`built ${name} does not run: ${built}`)
  copyFileSync(built, `${target}.part`)
  chmodSync(`${target}.part`, 0o755)
  renameSync(`${target}.part`, target)
}
writeFileSync(`${speechModel}.part`, modelBytes)
renameSync(`${speechModel}.part`, speechModel)
copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE'))
writeFileSync(join(output, 'VERSION'), stamp)
console.log(`built whisper.cpp ${WHISPER_VERSION} at ${binary}`)
