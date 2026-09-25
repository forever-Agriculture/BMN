import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERROR_CODES } from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeWav } from '../renderer/src/voice-wav'
import { SPEECH_DETECTOR_FILE, SPEECH_MODEL_FILE, VOICE_MODELS } from './voice-engine'
import { installVoiceIpcHandlers, type VoiceIpcOptions } from './voice-ipc'

type Handler = (event: IpcMainInvokeEvent, params?: unknown) => unknown

let folder: string
const allowed = { allowed: true } as unknown as IpcMainInvokeEvent
const stranger = { allowed: false } as unknown as IpcMainInvokeEvent

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'voice-ipc-test-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

function install(overrides: Partial<VoiceIpcOptions> = {}): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  installVoiceIpcHandlers({ handle: (channel, listener) => handlers.set(channel, listener) }, {
    senderIsAllowed: (event) => (event as unknown as { allowed: boolean }).allowed,
    binary: join(folder, 'whisper-cli'),
    modelFolder: async () => ({ path: join(folder, 'models'), custom: false }),
    chooseFolder: async () => null,
    ...overrides
  })
  return handlers
}

async function installEngine(): Promise<void> {
  for (const name of ['whisper-cli', SPEECH_DETECTOR_FILE]) {
    await writeFile(join(folder, name), '#!/bin/sh\n')
    await chmod(join(folder, name), 0o755)
  }
  await writeFile(join(folder, SPEECH_MODEL_FILE), '')
}

async function installEngineAndBase(): Promise<void> {
  await installEngine()
  await mkdir(join(folder, 'models'))
  await writeFile(join(folder, 'models', 'ggml-base.bin'), '')
  await truncate(join(folder, 'models', 'ggml-base.bin'), VOICE_MODELS[0]!.bytes)
}

const wav = encodeWav(new Float32Array(8_000), 16_000)

describe('voice IPC', () => {
  it('refuses renderers that are not the app window', async () => {
    const handlers = install()
    expect(Array.from(handlers.keys()).sort()).toEqual([
      'aiterm:voice:cancel-download',
      'aiterm:voice:choose-folder',
      'aiterm:voice:download',
      'aiterm:voice:status',
      'aiterm:voice:transcribe'
    ])
    for (const [channel, handler] of handlers) {
      await expect((async () => handler(stranger, { model: 'base', language: 'auto', wav }))(), channel)
        .rejects.toMatchObject({ code: ERROR_CODES.unauthorized })
    }
  })

  it('reports a missing engine and models, and explains what to do before transcribing', async () => {
    const handlers = install()
    await expect(handlers.get('aiterm:voice:status')!(allowed)).resolves.toEqual({
      engineAvailable: false,
      modelFolder: { path: join(folder, 'models'), custom: false, available: true },
      models: VOICE_MODELS.map((model) => ({ id: model.id, label: model.label, bytes: model.bytes, installed: false }))
    })
    const transcribe = handlers.get('aiterm:voice:transcribe')!
    await expect(transcribe(allowed, { model: 'base', language: 'auto', wav })).rejects.toThrow(/pnpm run voice:build/)
    // An engine built before the speech check existed lacks the detector and its model: it is not usable yet.
    await writeFile(join(folder, 'whisper-cli'), '')
    await writeFile(join(folder, SPEECH_DETECTOR_FILE), '')
    await expect(transcribe(allowed, { model: 'base', language: 'auto', wav })).rejects.toThrow(/pnpm run voice:build/)
    expect((await handlers.get('aiterm:voice:status')!(allowed) as { engineAvailable: boolean }).engineAvailable).toBe(false)
    await installEngine()
    expect((await handlers.get('aiterm:voice:status')!(allowed) as { engineAvailable: boolean }).engineAvailable).toBe(true)
    await expect(transcribe(allowed, { model: 'base', language: 'auto', wav })).rejects.toThrow(/Download the base voice model/)
    await expect(transcribe(allowed, { model: 'large', language: 'auto', wav })).rejects.toThrow(/Unknown voice model/)
    await expect(transcribe(allowed, { model: 'base', language: 'xx', wav })).rejects.toThrow(/not supported/)
    await expect(transcribe(allowed, { model: 'base', language: 'auto', wav: 'text' })).rejects.toThrow(/WAV bytes/)
  })

  it('transcribes one recording at a time with the chosen model and language', async () => {
    await installEngineAndBase()
    let release: (text: string) => void = () => undefined
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const handlers = install({ transcribe })
    const first = handlers.get('aiterm:voice:transcribe')!(allowed, { model: 'base', language: 'uk', wav }) as Promise<unknown>
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    await expect(handlers.get('aiterm:voice:transcribe')!(allowed, { model: 'base', language: 'uk', wav }))
      .rejects.toThrow(/still being transcribed/)
    release('привіт')
    await expect(first).resolves.toEqual({ text: 'привіт' })
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      binary: join(folder, 'whisper-cli'),
      modelPath: join(folder, 'models', 'ggml-base.bin'),
      language: 'uk',
      wav,
      vocabulary: [],
      speechDetector: { binary: join(folder, SPEECH_DETECTOR_FILE), modelPath: join(folder, SPEECH_MODEL_FILE) }
    }))
  })

  it('re-validates the vocabulary snapshot with the storage rules before it reaches the engine', async () => {
    await installEngineAndBase()
    const transcribe = vi.fn(async () => 'hello')
    const handlers = install({ transcribe })
    const handler = handlers.get('aiterm:voice:transcribe')!
    await expect(handler(allowed, { model: 'base', language: 'en', wav, vocabulary: [' BMN ', 'dev-auto'] })).resolves.toEqual({ text: 'hello' })
    expect(transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ vocabulary: ['BMN', 'dev-auto'] }))
    for (const vocabulary of [['a,b'], ['BMN', 'bmn'], 'BMN', [1], Array.from({ length: 31 }, (_, index) => `w${index}`)]) {
      await expect(handler(allowed, { model: 'base', language: 'en', wav, vocabulary }))
        .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
    }
    // The refusal travels in the IPC error envelope, so it must not quote the vocabulary.
    const refusal = await Promise.resolve(handler(allowed, { model: 'base', language: 'en', wav, vocabulary: ['PrivateProject', 'privateproject'] }))
      .then(() => new Error('accepted'), (error: unknown) => error as Error)
    expect(refusal.message).toMatch(/in the list twice/)
    expect(refusal.message.toLowerCase()).not.toContain('privateproject')
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('uses the chosen model folder and refuses to download or transcribe while it is missing', async () => {
    await installEngineAndBase()
    const chosen = { path: join(folder, 'unmounted-disk', 'whisper') }
    const fetch = vi.fn()
    const transcribe = vi.fn(async () => 'hello')
    const chooseFolder = vi.fn(async () => chosen.path)
    const handlers = install({ modelFolder: async () => ({ path: chosen.path, custom: true }), chooseFolder, fetch, transcribe })
    const status = async () => handlers.get('aiterm:voice:status')!(allowed) as Promise<{ modelFolder: unknown; models: Array<{ installed: boolean }> }>

    await expect(handlers.get('aiterm:voice:choose-folder')!(allowed)).resolves.toEqual({ path: chosen.path })
    expect(chooseFolder).toHaveBeenCalledWith(allowed)
    expect((await status()).modelFolder).toEqual({ path: chosen.path, custom: true, available: false })
    expect((await status()).models.every((model) => !model.installed)).toBe(true)
    await expect(handlers.get('aiterm:voice:download')!(allowed, { model: 'base' }))
      .rejects.toMatchObject({ code: ERROR_CODES.notFound, message: expect.stringMatching(/not available; is its disk mounted/) })
    await expect(handlers.get('aiterm:voice:transcribe')!(allowed, { model: 'base', language: 'en', wav }))
      .rejects.toThrow(/not available; is its disk mounted/)
    expect(fetch).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()

    chosen.path = join(folder, 'models')
    expect((await status()).modelFolder).toEqual({ path: chosen.path, custom: true, available: true })
    await expect(handlers.get('aiterm:voice:transcribe')!(allowed, { model: 'base', language: 'en', wav })).resolves.toEqual({ text: 'hello' })
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ modelPath: join(folder, 'models', 'ggml-base.bin') }))
  })

  it('returns null when the owner cancels the folder picker', async () => {
    await expect(install().get('aiterm:voice:choose-folder')!(allowed)).resolves.toBeNull()
  })

  it('shows download progress, keeps a failure visible until dismissed, and cancels', async () => {
    let push: (chunk: Uint8Array) => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk)
        fail = (error) => controller.error(error)
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      }
    })))
    const handlers = install({ fetch })
    const status = async () => (await handlers.get('aiterm:voice:status')!(allowed) as { models: Array<{ download?: unknown }> }).models[0]!
    await expect(handlers.get('aiterm:voice:download')!(allowed, { model: 'base' })).resolves.toEqual({ started: true })
    await expect(handlers.get('aiterm:voice:download')!(allowed, { model: 'base' })).resolves.toEqual({ started: false })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    push(new Uint8Array(1_000))
    await vi.waitFor(async () => expect((await status()).download).toEqual({ receivedBytes: 1_000 }))
    fail(new Error('connection reset'))
    await vi.waitFor(async () => expect((await status()).download).toEqual({ receivedBytes: 1_000, error: 'connection reset' }))
    expect(handlers.get('aiterm:voice:cancel-download')!(allowed, { model: 'base' })).toEqual({ cancelled: true })
    expect((await status()).download).toBeUndefined()

    await handlers.get('aiterm:voice:download')!(allowed, { model: 'base' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    handlers.get('aiterm:voice:cancel-download')!(allowed, { model: 'base' })
    await vi.waitFor(async () => expect((await status()).download).toBeUndefined())
  })

  it('reserves the download slot before the first await, so two rapid requests run one transfer', async () => {
    let resolveFolder!: (folder: { path: string; custom: boolean }) => void
    // One shared gated promise: every caller of modelFolder awaits the same resolution.
    const gatedFolder = new Promise<{ path: string; custom: boolean }>((resolve) => { resolveFolder = resolve })
    const modelFolder = (): Promise<{ path: string; custom: boolean }> => gatedFolder
    let fail: (error: Error) => void = () => undefined
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        fail = (error) => controller.error(error)
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      }
    })))
    const handlers = install({ modelFolder, fetch })
    const download = handlers.get('aiterm:voice:download')!
    const status = async () => (await handlers.get('aiterm:voice:status')!(allowed) as { models: Array<{ download?: unknown }> }).models[0]!

    // Both requests pass the controller check while the folder lookup is still pending.
    const first = download(allowed, { model: 'base' }) as Promise<{ started: boolean }>
    const second = download(allowed, { model: 'base' }) as Promise<{ started: boolean }>
    resolveFolder({ path: join(folder, 'models'), custom: false })
    await expect(first).resolves.toEqual({ started: true })
    await expect(second).resolves.toEqual({ started: false })
    // The refused request never reached the transfer: the first one alone owns the model's .part file.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    fail(new Error('connection reset'))
    await vi.waitFor(async () => expect((await status()).download).toEqual({ receivedBytes: 0, error: 'connection reset' }))
    expect(handlers.get('aiterm:voice:cancel-download')!(allowed, { model: 'base' })).toEqual({ cancelled: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('releases the reservation on every early exit, and a later download starts cleanly', async () => {
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      }
    })))
    let chosen: { path: string; custom: boolean } | null = null
    const handlers = install({
      fetch,
      modelFolder: async () => {
        if (chosen) return chosen
        throw new Error('folder settings unreadable')
      }
    })
    const download = handlers.get('aiterm:voice:download')!
    const cancel = handlers.get('aiterm:voice:cancel-download')!

    // The folder lookup itself throws after the reservation was claimed.
    await expect(download(allowed, { model: 'base' })).rejects.toThrow(/folder settings unreadable/)
    // The chosen folder is unavailable, so the disk check refuses the download.
    chosen = { path: join(folder, 'unmounted-disk', 'whisper'), custom: true }
    await expect(download(allowed, { model: 'base' }))
      .rejects.toMatchObject({ code: ERROR_CODES.notFound, message: expect.stringMatching(/not available; is its disk mounted/) })
    expect(fetch).not.toHaveBeenCalled()
    // The model is already installed, so no transfer is needed.
    chosen = { path: join(folder, 'models'), custom: false }
    await installEngineAndBase()
    await expect(download(allowed, { model: 'base' })).resolves.toEqual({ started: false })
    // Each early exit released its own reservation: with the model file gone, a download starts.
    await rm(join(folder, 'models', 'ggml-base.bin'))
    await expect(download(allowed, { model: 'base' })).resolves.toEqual({ started: true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(cancel(allowed, { model: 'base' })).toEqual({ cancelled: true })
    await vi.waitFor(async () => {
      const status = await handlers.get('aiterm:voice:status')!(allowed) as { models: Array<{ download?: unknown }> }
      expect(status.models[0]!.download).toBeUndefined()
    })
  })

  it('keeps a failed transfer\'s error until Dismiss: a retry over it is refused and the error survives', async () => {
    let fail: (error: Error) => void = () => undefined
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        fail = (error) => controller.error(error)
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      }
    })))
    const handlers = install({ fetch })
    const status = async () => (await handlers.get('aiterm:voice:status')!(allowed) as { models: Array<{ download?: unknown }> }).models[0]!
    await expect(handlers.get('aiterm:voice:download')!(allowed, { model: 'base' })).resolves.toEqual({ started: true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    fail(new Error('connection reset'))
    await vi.waitFor(async () => expect((await status()).download).toEqual({ receivedBytes: 0, error: 'connection reset' }))

    // The owner has not dismissed the error, so a new request may not claim over it.
    await expect(handlers.get('aiterm:voice:download')!(allowed, { model: 'base' })).resolves.toEqual({ started: false })
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect((await status()).download).toEqual({ receivedBytes: 0, error: 'connection reset' })

    // Dismiss is the only exit; afterwards a download starts cleanly.
    expect(handlers.get('aiterm:voice:cancel-download')!(allowed, { model: 'base' })).toEqual({ cancelled: true })
    await vi.waitFor(async () => expect((await status()).download).toBeUndefined())
    await expect(handlers.get('aiterm:voice:download')!(allowed, { model: 'base' })).resolves.toEqual({ started: true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    handlers.get('aiterm:voice:cancel-download')!(allowed, { model: 'base' })
  })

  it('gives up its reservation when cancelled before the transfer starts, without fetching', async () => {
    let resolveFolder!: (folder: { path: string; custom: boolean }) => void
    let settled = false
    const modelFolder = (): Promise<{ path: string; custom: boolean }> =>
      settled
        ? Promise.resolve({ path: join(folder, 'models'), custom: false })
        : new Promise((resolve) => { resolveFolder = resolve })
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      }
    })))
    const handlers = install({ modelFolder, fetch })
    const download = handlers.get('aiterm:voice:download')!

    const first = download(allowed, { model: 'base' }) as Promise<{ started: boolean }>
    expect(handlers.get('aiterm:voice:cancel-download')!(allowed, { model: 'base' })).toEqual({ cancelled: true })
    resolveFolder({ path: join(folder, 'models'), custom: false })
    settled = true
    await expect(first).resolves.toEqual({ started: false })
    expect(fetch).not.toHaveBeenCalled()
    // The cancelled request released its reservation, so the slot is free again.
    await expect(download(allowed, { model: 'base' })).resolves.toEqual({ started: true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    handlers.get('aiterm:voice:cancel-download')!(allowed, { model: 'base' })
    const status = async () => (await handlers.get('aiterm:voice:status')!(allowed) as { models: Array<{ download?: unknown }> }).models[0]!
    await vi.waitFor(async () => expect((await status()).download).toBeUndefined())
  })
})
