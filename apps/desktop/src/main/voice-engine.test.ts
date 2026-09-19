import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav, mixToMono } from '../renderer/src/voice-wav'
import {
  SPEECH_DETECTOR_FILE,
  SPEECH_MODEL_FILE,
  SPEECH_THRESHOLD,
  VOICE_MAX_WAV_BYTES,
  VOICE_MODELS,
  downloadModel,
  engineFiles,
  modelInstalled,
  runWhisper,
  speechDetectionArguments,
  speechSegmentsFromOutput,
  transcribeRecording,
  transcriptFromOutput,
  validateWav,
  voiceModel,
  whisperArguments,
  redactVocabulary,
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

async function fakeBinary(script: string, name = 'whisper-cli'): Promise<string> {
  const path = join(folder, name)
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
  return path
}

/** A stand-in for whisper.cpp's speech-segment tool that reports the given output. */
async function speechDetector(script = 'echo; echo "Detected 1 speech segments:"'): Promise<{ binary: string; modelPath: string }> {
  return { binary: await fakeBinary(script, SPEECH_DETECTOR_FILE), modelPath: '/vad.bin' }
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

  it('passes the approved vocabulary as one --prompt value and nothing when the list is empty', () => {
    const base = { modelPath: '/m.bin', wavPath: '/r.wav', language: 'en' as const, threads: 6, durationSeconds: 45 }
    const without = whisperArguments(base)
    expect(whisperArguments({ ...base, vocabulary: [] })).toEqual(without)
    expect(without).not.toContain('--prompt')
    const args = whisperArguments({ ...base, vocabulary: ['BMN', 'dev-auto', 'Олександр'] })
    expect(args.slice(0, without.length)).toEqual(without)
    expect(args.slice(without.length)).toEqual(['--prompt', 'BMN, dev-auto, Олександр'])
    expect(args).not.toContain('--carry-initial-prompt')
  })

  it('blanks the vocabulary out of a surfaced engine error', async () => {
    const echoing = await fakeBinary('echo "bad prompt: $*" >&2; exit 2')
    const vocabulary = ['SecretProject', 'dev-auto']
    const wav = encodeWav(new Float32Array(16_000), 16_000)
    const failure = await transcribeRecording({ binary: echoing, modelPath: '/m.bin', speechDetector: await speechDetector(), language: 'en', wav, vocabulary, temporaryRoot: folder })
      .then(() => 'resolved', (error: Error) => error.message)
    expect(failure).toMatch(/^Voice engine failed \(exit 2\): bad prompt:/)
    expect(failure).toContain('[vocabulary]')
    expect(failure).not.toContain('SecretProject')
    expect(failure).not.toContain('dev-auto')
    expect(redactVocabulary('plain', [])).toBe('plain')
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
    const output = await transcribeRecording({ binary, modelPath: '/m.bin', speechDetector: await speechDetector(), language: 'auto', wav, temporaryRoot: folder })
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
    // `stat` has no portable flags, so Node reports the mode the recording was written with.
    const printMode = `${JSON.stringify(process.execPath)} -p '(require("fs").statSync(process.argv[1]).mode & 0o777).toString(8)'`
    const binary = await fakeBinary(`test -f "$4" && ${printMode} "$4" && echo transcribed`)
    const wav = encodeWav(new Float32Array(1_600), 16_000)
    const detector = await speechDetector()
    await expect(transcribeRecording({ binary, modelPath: '/m.bin', speechDetector: detector, language: 'auto', wav, temporaryRoot: audioRoot }))
      .resolves.toBe('600 transcribed')
    const failing = await fakeBinary('exit 1')
    await expect(transcribeRecording({ binary: failing, modelPath: '/m.bin', speechDetector: detector, language: 'auto', wav, temporaryRoot: audioRoot }))
      .rejects.toThrow(/Voice engine failed/)
    expect(await readdir(audioRoot)).toEqual([])
  })
})

describe('speech check before transcription', () => {
  const wav = encodeWav(new Float32Array(16_000), 16_000)

  it('finds the detector and its model beside whisper-cli and asks for any speech at all', () => {
    expect(engineFiles('/engine/whisper-cli')).toEqual({
      whisper: '/engine/whisper-cli',
      speechDetector: `/engine/${SPEECH_DETECTOR_FILE}`,
      speechModel: `/engine/${SPEECH_MODEL_FILE}`
    })
    expect(speechDetectionArguments({ modelPath: '/vad.bin', wavPath: '/r.wav', threads: 6 })).toEqual([
      '-f', '/r.wav', '-vm', '/vad.bin', '-vt', '0.3', '-vspd', '0', '-t', '6', '-np'
    ])
    expect(speechSegmentsFromOutput('\nDetected 0 speech segments:\n')).toBe(0)
    expect(speechSegmentsFromOutput('Detected 3 speech segments: Speech segment 0: start = 0.29, end = 2.20')).toBe(3)
    expect(() => speechSegmentsFromOutput('')).toThrow('Speech detection gave no result')
  })

  it('checks the detector at build and in the packaged smoke test with the threshold dictation uses', async () => {
    for (const script of ['../../../../scripts/voice/build-whisper.mjs', '../../../../scripts/smoke/packaged.mjs']) {
      const text = await readFile(fileURLToPath(new URL(script, import.meta.url)), 'utf8')
      expect(text, script).toContain(`'-vt', '${SPEECH_THRESHOLD}', '-vspd', '0'`)
    }
  })

  it('does not run Whisper on a recording without speech, so neither silence nor an echoed vocabulary is pasted', async () => {
    const whisperRan = join(folder, 'whisper-ran')
    const binary = await fakeBinary(`touch ${JSON.stringify(whisperRan)}; echo "BMN, dev-auto"`)
    const detectorArgs = join(folder, 'detector-args')
    const silent = await speechDetector(`echo "$@" > ${JSON.stringify(detectorArgs)}; echo "Detected 0 speech segments:"`)
    const options = { binary, modelPath: '/m.bin', language: 'uk' as const, wav, vocabulary: ['BMN', 'dev-auto'], temporaryRoot: folder }
    await expect(transcribeRecording({ ...options, speechDetector: silent })).resolves.toBe('')
    expect(existsSync(whisperRan)).toBe(false)
    expect(await readFile(detectorArgs, 'utf8')).toMatch(/^-f \S+\/recording\.wav -vm \/vad\.bin -vt 0\.3 -vspd 0 -t \d+ -np\n$/)

    await expect(transcribeRecording({ ...options, speechDetector: await speechDetector('echo "Detected 2 speech segments:"') }))
      .resolves.toBe('BMN, dev-auto')
    expect(existsSync(whisperRan)).toBe(true)
  })

  it('reports a failed or unreadable speech check instead of transcribing', async () => {
    const whisperRan = join(folder, 'whisper-ran')
    const binary = await fakeBinary(`touch ${JSON.stringify(whisperRan)}; echo text`)
    const options = { binary, modelPath: '/m.bin', language: 'en' as const, wav, temporaryRoot: folder }
    await expect(transcribeRecording({ ...options, speechDetector: await speechDetector('echo "error: failed to read audio" >&2; exit 2') }))
      .rejects.toThrow('Voice engine failed (exit 2): error: failed to read audio')
    await expect(transcribeRecording({ ...options, speechDetector: await speechDetector('echo usage') }))
      .rejects.toThrow('Speech detection gave no result')
    expect(existsSync(whisperRan)).toBe(false)
    expect((await readdir(folder)).filter((name) => name.startsWith('bmn-voice-'))).toEqual([])
  })

  // The real detector and model exist after `pnpm run voice:build`; whisper.cpp's JFK sample sits in its source cache.
  const engine = engineFiles(fileURLToPath(new URL('../../resources/whisper/whisper-cli', import.meta.url)))
  const jfk = fileURLToPath(new URL('../../../../node_modules/.cache/whisper.cpp/whisper.cpp-1.9.4/samples/jfk.wav', import.meta.url))
  it.skipIf(!existsSync(engine.speechDetector) || !existsSync(engine.speechModel))('finds speech in speech and none in silence or faint noise with the bundled model', async () => {
    const segments = async (samples: Float32Array | Uint8Array) => {
      const wavPath = join(folder, 'probe.wav')
      await writeFile(wavPath, samples instanceof Uint8Array ? samples : encodeWav(samples, 16_000))
      return speechSegmentsFromOutput(await runWhisper({ binary: engine.speechDetector, args: speechDetectionArguments({ modelPath: engine.speechModel, wavPath }) }))
    }
    let seed = 1
    const noise = Float32Array.from({ length: 16_000 * 3 }, () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648 - 0.5) * 0.02)
    expect(await segments(new Float32Array(16_000 * 3))).toBe(0)
    expect(await segments(noise)).toBe(0)
    if (existsSync(jfk)) expect(await segments(await readFile(jfk))).toBeGreaterThan(0)
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
