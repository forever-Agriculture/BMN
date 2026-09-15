import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav, mixToMono } from '../renderer/src/voice-wav'
import {
  VOICE_MAX_WAV_BYTES,
  VOICE_MODELS,
  downloadModel,
  modelInstalled,
  runWhisper,
  transcribeRecording,
  transcriptFromOutput,
  validateWav,
  voiceModel,
  whisperArguments,
  type VoiceModel
} from './voice-engine'

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'voice-engine-test-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

function modelFor(content: Uint8Array): VoiceModel {
  return {
    id: 'base',
    label: 'Test',
    file: 'ggml-test.bin',
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex')
  }
}

function bodyResponse(chunks: Uint8Array[], status = 200): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  }), { status })
}

async function fakeBinary(script: string): Promise<string> {
  const path = join(folder, 'whisper-cli')
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
  return path
}

describe('voice WAV encoding and validation', () => {
  it('encodes mono 16 kHz PCM that the engine accepts with the right duration', () => {
    const wav = encodeWav(new Float32Array(16_000).fill(0.25), 16_000)
    expect(wav.byteLength).toBe(44 + 32_000)
    expect(validateWav(wav)).toEqual({ durationSeconds: 1 })
  })

  it('mixes channels to mono and clamps samples', () => {
    expect(Array.from(mixToMono([new Float32Array([1, 0]), new Float32Array([0, 0])]))).toEqual([0.5, 0])
    const wav = encodeWav(new Float32Array([2, -2]), 16_000)
    const view = new DataView(wav.buffer)
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([32_767, -32_768])
  })

  it('refuses other formats, truncated data and recordings over the limit', () => {
    const stereo = encodeWav(new Float32Array(10), 16_000)
    new DataView(stereo.buffer).setUint16(22, 2, true)
    expect(() => validateWav(stereo)).toThrow(/16 kHz mono/)
    expect(() => validateWav(encodeWav(new Float32Array(10), 44_100))).toThrow(/16 kHz mono/)
    expect(() => validateWav(encodeWav(new Float32Array(10), 16_000).subarray(0, 50))).toThrow(/does not match/)
    expect(() => validateWav(new Uint8Array(VOICE_MAX_WAV_BYTES + 1))).toThrow(/longer than/)
    expect(() => validateWav(new TextEncoder().encode('not a wav file at all, just some text padding it out'))).toThrow(/not a WAV/)
  })
})

describe('whisper-cli invocation', () => {
  it('builds greedy transcript-only arguments', () => {
    expect(whisperArguments({ modelPath: '/m.bin', wavPath: '/r.wav', language: 'uk', threads: 6, durationSeconds: 45 })).toEqual([
      '-m', '/m.bin', '-f', '/r.wav', '-l', 'uk', '-t', '6', '-bs', '1', '-bo', '1', '-nt', '-np'
    ])
  })

  it('sizes the audio context to a short recording so the encoder skips the silent rest of its 30-second window', () => {
    const context = (durationSeconds: number) => {
      const args = whisperArguments({ modelPath: '/m.bin', wavPath: '/r.wav', language: 'auto', threads: 6, durationSeconds })
      const index = args.indexOf('-ac')
      return index === -1 ? null : Number(args[index + 1])
    }
    expect(context(0.3)).toBe(128)
    expect(context(3.2)).toBe(256)
    expect(context(11)).toBe(640)
    expect(context(28)).toBe(1472)
    // Near or past one window the full context is kept, so no speech is cut off.
    expect(context(29)).toBeNull()
    expect(context(120)).toBeNull()
  })

  it('passes the recording-sized audio context to the engine', async () => {
    const binary = await fakeBinary('echo "$@"')
    const wav = encodeWav(new Float32Array(16_000 * 3), 16_000)
    const output = await transcribeRecording({ binary, modelPath: '/m.bin', language: 'auto', wav, temporaryRoot: folder })
    expect(output).toMatch(/ -ac 256$/)
  })

  it('joins lines and drops non-speech markers', () => {
    expect(transcriptFromOutput('\n [BLANK_AUDIO]\n Hello there,\n  general Kenobi. (silence)\n')).toBe('Hello there, general Kenobi.')
    expect(transcriptFromOutput('[MUSIC]\n')).toBe('')
  })

  it('returns the transcript from a successful run and reports failures', async () => {
    const binary = await fakeBinary('echo " ask not"; echo "what your country can do"')
    await expect(runWhisper({ binary, args: [] })).resolves.toBe('ask not what your country can do')
    const failing = await fakeBinary('echo "error: failed to open model" >&2; exit 3')
    await expect(runWhisper({ binary: failing, args: [] })).rejects.toThrow('Voice engine failed (exit 3): error: failed to open model')
    const slow = await fakeBinary('sleep 5')
    await expect(runWhisper({ binary: slow, args: [], timeoutMs: 100 })).rejects.toThrow(/too long/)
    await expect(runWhisper({ binary: join(folder, 'missing'), args: [] })).rejects.toThrow(/could not start/)
  })

  it('removes the temporary recording after transcription, even when the engine fails', async () => {
    const audioRoot = join(folder, 'audio')
    await mkdir(audioRoot)
    const binary = await fakeBinary('test -f "$4" && stat -c %a "$4" && echo transcribed')
    const wav = encodeWav(new Float32Array(1_600), 16_000)
    await expect(transcribeRecording({ binary, modelPath: '/m.bin', language: 'auto', wav, temporaryRoot: audioRoot }))
      .resolves.toBe('600 transcribed')
    const failing = await fakeBinary('exit 1')
    await expect(transcribeRecording({ binary: failing, modelPath: '/m.bin', language: 'auto', wav, temporaryRoot: audioRoot }))
      .rejects.toThrow(/Voice engine failed/)
    expect(await readdir(audioRoot)).toEqual([])
  })
})

describe('voice model download', () => {
  it('pins every model by size and sha256', () => {
    expect(VOICE_MODELS.map((model) => model.id)).toEqual(['base', 'small'])
    for (const model of VOICE_MODELS) expect(model.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => voiceModel('large')).toThrow(/Unknown voice model/)
  })

  it('installs a verified download and reports progress', async () => {
    const content = new TextEncoder().encode('model weights '.repeat(100))
    const model = modelFor(content)
    const progress: number[] = []
    let requested = ''
    await downloadModel(folder, model, {
      fetch: async (url) => {
        requested = url
        return bodyResponse([content.subarray(0, 500), content.subarray(500)])
      },
      signal: new AbortController().signal,
      onProgress: (bytes) => progress.push(bytes)
    })
    expect(requested).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-test.bin')
    expect(progress).toEqual([500, content.byteLength])
    expect(new Uint8Array(await readFile(join(folder, model.file)))).toEqual(content)
    expect(await modelInstalled(folder, model)).toBe(true)
    expect(await readdir(folder)).toEqual([model.file])
  })

  it('installs nothing when the checksum, size or HTTP status is wrong', async () => {
    const content = new TextEncoder().encode('expected model')
    const model = modelFor(content)
    const options = (response: Response) => ({
      fetch: async () => response,
      signal: new AbortController().signal,
      onProgress: () => undefined
    })
    const tampered = new TextEncoder().encode('tampered model')
    await expect(downloadModel(folder, model, options(bodyResponse([tampered])))).rejects.toThrow(/checksum/)
    await expect(downloadModel(folder, model, options(bodyResponse([content, content])))).rejects.toThrow(/larger/)
    await expect(downloadModel(folder, model, options(bodyResponse([], 404)))).rejects.toThrow(/HTTP 404/)
    expect(await readdir(folder)).toEqual([])
    expect(await modelInstalled(folder, model)).toBe(false)
  })
})
