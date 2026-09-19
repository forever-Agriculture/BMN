// MODULE: voice-engine.ts - local Whisper dictation: pinned models, verified download, WAV checks and whisper-cli runs
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { vocabularyPrompt, type VoiceLanguage, type VoiceModelId } from '@bmn/protocol'

export interface VoiceModel {
  id: VoiceModelId
  label: string
  file: string
  bytes: number
  sha256: string
}

/** Multilingual whisper.cpp models, pinned by size and sha256 so a changed upstream file is refused. */
export const VOICE_MODELS: readonly VoiceModel[] = Object.freeze([
  {
    id: 'base',
    label: 'Base — faster',
    file: 'ggml-base.bin',
    bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  },
  {
    id: 'small',
    label: 'Small — more accurate, about 3× slower',
    file: 'ggml-small.bin',
    bytes: 487_601_967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
  }
])

export const VOICE_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_MAX_SECONDS = 120
/** Two minutes of 16 kHz mono 16-bit PCM plus a generous header allowance. */
export const VOICE_MAX_WAV_BYTES = VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE * 2 + 4_096
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 180_000
const MAX_TRANSCRIPT_OUTPUT_BYTES = 1024 * 1024

export class VoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceError'
  }
}

export function voiceModel(id: unknown): VoiceModel {
  const model = VOICE_MODELS.find((candidate) => candidate.id === id)
  if (!model) throw new VoiceError('Unknown voice model')
  return model
}

/** A model counts as installed only at its pinned size; the hash was checked before it was renamed into place. */
export async function modelInstalled(directory: string, model: VoiceModel): Promise<boolean> {
  try {
    const info = await stat(join(directory, model.file))
    return info.isFile() && info.size === model.bytes
  } catch {
    return false
  }
}

export interface DownloadOptions {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  signal: AbortSignal
  onProgress(receivedBytes: number): void
  baseUrl?: string
}

/** Streams the model to a `.part` file, checks size and sha256, then renames it into place. */
export async function downloadModel(directory: string, model: VoiceModel, options: DownloadOptions): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const partial = join(directory, `${model.file}.part`)
  const response = await options.fetch(`${options.baseUrl ?? VOICE_MODEL_BASE_URL}${model.file}`, { signal: options.signal })
  if (!response.ok || !response.body) throw new VoiceError(`Model download failed: HTTP ${response.status}`)
  const hash = createHash('sha256')
  const file = await open(partial, 'w', 0o600)
  let received = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength
      if (received > model.bytes) throw new VoiceError('Model download is larger than the pinned size')
      hash.update(chunk)
      await file.write(chunk)
      options.onProgress(received)
    }
    await file.sync()
  } catch (error) {
    await file.close()
    await rm(partial, { force: true })
    throw error
  }
  await file.close()
  if (received !== model.bytes || hash.digest('hex') !== model.sha256) {
    await rm(partial, { force: true })
    throw new VoiceError('Downloaded model failed its checksum; nothing was installed')
  }
  await rename(partial, join(directory, model.file))
}

/** Accepts only what the recorder produces and whisper-cli reads directly: 16 kHz mono 16-bit PCM WAV. */
export function validateWav(bytes: Uint8Array): { durationSeconds: number } {
  if (bytes.byteLength < 44) throw new VoiceError('Recording is empty')
  if (bytes.byteLength > VOICE_MAX_WAV_BYTES) throw new VoiceError(`Recording is longer than ${VOICE_MAX_SECONDS / 60} minutes`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE' || text(12) !== 'fmt ' || text(36) !== 'data') {
    throw new VoiceError('Recording is not a WAV file')
  }
  const format = view.getUint16(20, true)
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const bitsPerSample = view.getUint16(34, true)
  const dataBytes = view.getUint32(40, true)
  if (format !== 1 || channels !== 1 || sampleRate !== VOICE_SAMPLE_RATE || bitsPerSample !== 16) {
    throw new VoiceError('Recording must be 16 kHz mono 16-bit PCM')
  }
  if (dataBytes !== bytes.byteLength - 44) throw new VoiceError('Recording length does not match its header')
  return { durationSeconds: dataBytes / 2 / VOICE_SAMPLE_RATE }
}

/** Whisper's encoder sees 30 seconds of audio as 1,500 frames. */
const WHISPER_WINDOW_FRAMES = 1_500
const WHISPER_FRAMES_PER_SECOND = 50

/**
 * Encoder frames that cover the recording plus a second of margin, rounded up to 64; null keeps the full window.
 * Whisper otherwise encodes a whole 30-second window even for a 3-second phrase, which is most of the wait.
 */
function audioContextFrames(durationSeconds: number): number | null {
  const frames = Math.ceil(((durationSeconds + 1) * WHISPER_FRAMES_PER_SECOND) / 64) * 64
  return frames < WHISPER_WINDOW_FRAMES ? frames : null
}

export function whisperArguments(options: {
  modelPath: string
  wavPath: string
  language: VoiceLanguage
  durationSeconds: number
  threads?: number
  /** Approved vocabulary; an empty list leaves the arguments exactly as without one. */
  vocabulary?: readonly string[] | undefined
}): string[] {
  const threads = options.threads ?? Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
  const audioContext = audioContextFrames(options.durationSeconds)
  const prompt = vocabularyPrompt(options.vocabulary ?? [])
  // Greedy decoding (-bs 1 -bo 1) keeps dictation fast; -nt -np print only the transcript on stdout.
  // The prompt is one argv value: whisper reads it as the text preceding the recording, never as a rule.
  return [
    '-m', options.modelPath,
    '-f', options.wavPath,
    '-l', options.language,
    '-t', String(threads),
    '-bs', '1',
    '-bo', '1',
    '-nt',
    '-np',
    ...(audioContext === null ? [] : ['-ac', String(audioContext)]),
    ...(prompt.length === 0 ? [] : ['--prompt', prompt])
  ]
}

/** Engine output shown to the owner must not echo the vocabulary, so the prompt and each word are blanked. */
export function redactVocabulary(text: string, vocabulary: readonly string[]): string {
  if (vocabulary.length === 0) return text
  let redacted = text.split(vocabularyPrompt(vocabulary)).join('[vocabulary]')
  for (const word of vocabulary) redacted = redacted.split(word).join('[vocabulary]')
  return redacted
}

/** Joins whisper-cli's lines and drops non-speech markers such as [BLANK_AUDIO] or (silence). */
export function transcriptFromOutput(stdout: string): string {
  return stdout
    .replace(/\[[^\]\n]*\]|\((?:silence|music|noise|inaudible)[^)\n]*\)/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export interface WhisperRun {
  binary: string
  args: string[]
  timeoutMs?: number | undefined
  spawnProcess?: typeof spawn | undefined
  /** Words that must not appear in a surfaced error line. */
  vocabulary?: readonly string[] | undefined
}

export function runWhisper(run: WhisperRun): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = (run.spawnProcess ?? spawn)(run.binary, run.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, text = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(text)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new VoiceError('Transcription took too long and was stopped'))
    }, run.timeoutMs ?? VOICE_TRANSCRIBE_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_TRANSCRIPT_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(new VoiceError('Transcription output was too large'))
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000)
    })
    child.once('error', (error) => finish(new VoiceError(`Voice engine could not start: ${error.message}`)))
    child.once('close', (code, signal) => {
      if (code === 0) finish(null, transcriptFromOutput(stdout))
      else {
        const detail = redactVocabulary(stderr.trim().split('\n').at(-1) ?? '', run.vocabulary ?? [])
        finish(new VoiceError(`Voice engine failed (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ''}`))
      }
    })
  })
}

/** Writes the recording to a private temporary folder, runs whisper-cli and always removes the audio. */
export async function transcribeRecording(options: {
  binary: string
  modelPath: string
  language: VoiceLanguage
  wav: Uint8Array
  /** Already validated by the caller's boundary; joined with `, ` as the initial prompt. */
  vocabulary?: readonly string[] | undefined
  temporaryRoot?: string
  timeoutMs?: number | undefined
  spawnProcess?: typeof spawn | undefined
}): Promise<string> {
  const { durationSeconds } = validateWav(options.wav)
  const folder = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'bmn-voice-'))
  try {
    const wavPath = join(folder, 'recording.wav')
    await writeFile(wavPath, options.wav, { mode: 0o600 })
    return await runWhisper({
      binary: options.binary,
      args: whisperArguments({
        modelPath: options.modelPath,
        wavPath,
        language: options.language,
        durationSeconds,
        vocabulary: options.vocabulary
      }),
      timeoutMs: options.timeoutMs,
      spawnProcess: options.spawnProcess,
      vocabulary: options.vocabulary
    })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
