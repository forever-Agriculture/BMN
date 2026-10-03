// Public JFK/silence fixtures only; never reads a microphone or owner model folder.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { msvcEnvironment } from '../lib/msvc.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const flag = process.argv.indexOf('--resources')
const resources = flag < 0 ? join(repo, 'apps/desktop/resources') : resolve(process.argv[flag + 1])
const engine = join(resources, 'whisper')
const suffix = process.platform === 'win32' ? '.exe' : ''
const whisper = join(engine, 'whisper-cli' + suffix)
const detector = join(engine, 'whisper-vad-speech-segments' + suffix)
const stamp = readFileSync(join(engine, 'VERSION'), 'utf8')
assert.match(stamp, /x64-portable/, 'Acceptance exercises the distributed CPU baseline')
const model = { file: 'ggml-base.bin', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' }
const cache = join(repo, 'node_modules/.cache/bmn-voice-smoke')
mkdirSync(cache, { recursive: true })
const modelPath = join(cache, model.file)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (!existsSync(modelPath) || hash(readFileSync(modelPath)) !== model.sha256) {
  const partial = modelPath + '.' + randomUUID() + '.part'
  const response = await fetch('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + model.file,
    { signal: AbortSignal.timeout(120000) })
  assert.ok(response.ok && response.body, `Public model HTTP ${response.status}`)
  const file = await open(partial, 'wx', 0o600)
  const digest = createHash('sha256')
  let size = 0
  try {
    for await (const bytes of response.body) {
      size += bytes.length
      assert.ok(size <= model.bytes, 'Model exceeds pinned size')
      digest.update(bytes)
      await file.write(bytes)
    }
    assert.equal(size, model.bytes)
    assert.equal(digest.digest('hex'), model.sha256)
    await file.sync()
  } catch (error) {
    await file.close()
    await rm(partial, { force: true })
    throw error
  }
  await file.close()
  assert.equal(hash(readFileSync(partial)), model.sha256, 'Check installed bytes, not only the received stream')
  renameSync(partial, modelPath)
}
const root = mkdtempSync(join(tmpdir(), 'bmn-voice-engine-acceptance-'))
const receipt = { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  resources, stamp, model: { file: model.file, sha256: model.sha256 }, crossCpu: 'UNVERIFIED', checks: [] }
const run = (binary, args) => {
  const started = Date.now()
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true })
  assert.equal(result.error, undefined, 'Engine must finish within its bound')
  assert.equal(result.status, 0, 'Engine must run successfully')
  receipt.checks.push({ executable: binary, elapsedMs: Date.now() - started, exit: result.status })
  return result.stdout
}
try {
  const silence = Buffer.alloc(44 + 32000)
  silence.write('RIFF'); silence.writeUInt32LE(36 + 32000, 4); silence.write('WAVEfmt ', 8); silence.writeUInt32LE(16, 16)
  silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22); silence.writeUInt32LE(16000, 24); silence.writeUInt32LE(32000, 28)
  silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write('data', 36); silence.writeUInt32LE(32000, 40)
  const quiet = join(root, 'silence.wav')
  writeFileSync(quiet, silence)
  const speech = join(repo, 'node_modules/.cache/whisper.cpp/whisper.cpp-1.9.4/samples/jfk.wav')
  const detect = wav => run(detector, ['-f', wav, '-vm', join(engine, 'ggml-silero-v6.2.0.bin'), '-vt', '0.3', '-vspd', '0', '-t', '1', '-np'])
  assert.match(detect(quiet), /Detected 0 speech segments/u)
  assert.match(detect(speech), /Detected [1-9]\d* speech segments/u)
  const text = run(whisper, ['-m', modelPath, '-f', speech, '-l', 'en', '-t', '2', '-bs', '1', '-bo', '1', '-nt', '-np', '-ac', '640'])
  assert.match(text.toLowerCase().replace(/\s+/gu, ' '), /ask not.*country/u)
  receipt.speech = true; receipt.silence = true; receipt.transcription = true
  if (process.platform === 'win32') {
    const dependencies = []
    for (const binary of [whisper, detector]) {
      const result = spawnSync('dumpbin.exe', ['/DEPENDENTS', binary], { env: msvcEnvironment(), encoding: 'utf8', timeout: 30000 })
      assert.equal(result.status, 0, 'Inspect the actual PE runtime imports')
      const names = [...result.stdout.matchAll(/[\w-]+\.dll/giu)].map(match => match[0])
      assert.ok(names.length > 0)
      assert.ok(!names.some(name => /^(?:vcruntime|msvcp|vcomp|libomp|ggml|whisper)/iu.test(name)), 'Compiler/engine DLL dependencies must not be missing from the package')
      dependencies.push({ binary, dlls: [...new Set(names)].sort() })
    }
    receipt.dependencies = dependencies
  }
  receipt.passed = true
} finally {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(repo, 'test-results'), { recursive: true })
  writeFileSync(join(repo, 'test-results', flag < 0 ? 'voice-engine.json' : 'packaged-voice-engine.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
