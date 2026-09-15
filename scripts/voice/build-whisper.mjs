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
const stamp = `whisper.cpp ${WHISPER_VERSION} ${SOURCE_SHA256}${PATCHES.map((patch) => ` +${patch.id}`).join('')}\n`

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
if (!process.argv.includes('--force') && existsSync(binary) && readText(join(output, 'VERSION')) === stamp) {
  console.log(`whisper.cpp ${WHISPER_VERSION} is already built at ${binary}`)
  process.exit(0)
}

await sourceTarball()
if (!existsSync(join(source, 'CMakeLists.txt'))) {
  rmSync(source, { recursive: true, force: true })
  run('tar', ['-xzf', tarball, '-C', cache])
}
applyPatches()

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
run(command, [...prefix, '--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j', String(availableParallelism())])

const built = join(build, 'bin', 'whisper-cli')
if (!commandWorks(built, ['--help'])) throw new Error(`built whisper-cli does not run: ${built}`)
mkdirSync(output, { recursive: true })
copyFileSync(built, `${binary}.part`)
chmodSync(`${binary}.part`, 0o755)
renameSync(`${binary}.part`, binary)
copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE'))
writeFileSync(join(output, 'VERSION'), stamp)
console.log(`built whisper.cpp ${WHISPER_VERSION} at ${binary}`)
