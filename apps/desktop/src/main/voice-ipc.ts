// MODULE: voice-ipc.ts - renderer channels for voice status, model folder, model download and transcription
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ERROR_CODES,
  VOICE_LANGUAGES,
  validateVocabulary,
  type VoiceLanguage,
  type VoiceStatus
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import {
  VOICE_MODELS,
  downloadModel,
  modelInstalled,
  transcribeRecording,
  voiceModel,
  type DownloadOptions
} from './voice-engine'
import { MainIpcError } from './workspace-ipc'

interface VoiceIpcRegistrar {
  handle(channel: `aiterm:${string}`, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown): void
}

export interface VoiceIpcOptions {
  senderIsAllowed(event: IpcMainInvokeEvent): boolean
  /** Path to the whisper-cli binary built by `pnpm run voice:build`. */
  binary: string
  /** The owner's chosen model folder, or the default one inside the app data folder. */
  modelFolder(): Promise<{ path: string; custom: boolean }>
  /** Asks the owner for a folder; resolves null when they cancel. */
  chooseFolder(event: IpcMainInvokeEvent): Promise<string | null>
  fetch?: DownloadOptions['fetch']
  transcribe?: typeof transcribeRecording
}

interface DownloadState {
  receivedBytes: number
  error?: string
  controller?: AbortController
}

function invalid(message: string): never {
  throw new MainIpcError(ERROR_CODES.invalidArgument, message)
}

function objectParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid('Voice parameters must be an object')
  return params as Record<string, unknown>
}

function modelParam(params: Record<string, unknown>) {
  try {
    return voiceModel(params.model)
  } catch {
    return invalid('Unknown voice model')
  }
}

function userMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** The default folder is created on first download; a chosen folder must already exist so an unmounted disk is not silently replaced. */
async function currentFolder(options: VoiceIpcOptions): Promise<VoiceStatus['modelFolder']> {
  const folder = await options.modelFolder()
  return { ...folder, available: !folder.custom || await isDirectory(folder.path) }
}

function requireAvailable(folder: VoiceStatus['modelFolder']): void {
  if (!folder.available) {
    throw new MainIpcError(ERROR_CODES.notFound, `Voice model folder ${folder.path} is not available; is its disk mounted?`)
  }
}

export function installVoiceIpcHandlers(ipc: VoiceIpcRegistrar, options: VoiceIpcOptions): void {
  const downloads = new Map<string, DownloadState>()
  let transcribing = false
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (!options.senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
  }

  ipc.handle('aiterm:voice:status', async (event): Promise<VoiceStatus> => {
    authorize(event)
    const folder = await currentFolder(options)
    return {
      engineAvailable: existsSync(options.binary),
      modelFolder: folder,
      models: await Promise.all(VOICE_MODELS.map(async (model) => {
        const download = downloads.get(model.id)
        return {
          id: model.id,
          label: model.label,
          bytes: model.bytes,
          installed: folder.available && await modelInstalled(folder.path, model),
          ...(download ? { download: { receivedBytes: download.receivedBytes, ...(download.error ? { error: download.error } : {}) } } : {})
        }
      }))
    }
  })

  ipc.handle('aiterm:voice:download', async (event, params) => {
    authorize(event)
    const model = modelParam(objectParams(params))
    if (downloads.get(model.id)?.controller) return { started: false }
    const folder = await currentFolder(options)
    requireAvailable(folder)
    if (await modelInstalled(folder.path, model)) return { started: false }
    const controller = new AbortController()
    const state: DownloadState = { receivedBytes: 0, controller }
    downloads.set(model.id, state)
    // The renderer polls voice status for progress; the download outlives the request that started it.
    void downloadModel(folder.path, model, {
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      signal: controller.signal,
      onProgress: (receivedBytes) => {
        state.receivedBytes = receivedBytes
      }
    }).then(
      () => downloads.delete(model.id),
      (error: unknown) => {
        delete state.controller
        if (controller.signal.aborted) downloads.delete(model.id)
        else state.error = userMessage(error, 'Model download failed')
      }
    )
    return { started: true }
  })

  ipc.handle('aiterm:voice:choose-folder', async (event) => {
    authorize(event)
    const path = await options.chooseFolder(event)
    return path ? { path } : null
  })

  ipc.handle('aiterm:voice:cancel-download', (event, params) => {
    authorize(event)
    const model = modelParam(objectParams(params))
    const state = downloads.get(model.id)
    state?.controller?.abort()
    if (state && !state.controller) downloads.delete(model.id)
    return { cancelled: !!state }
  })

  ipc.handle('aiterm:voice:transcribe', async (event, params) => {
    authorize(event)
    const values = objectParams(params)
    const model = modelParam(values)
    const language = values.language as VoiceLanguage
    if (!VOICE_LANGUAGES.some((candidate) => candidate.code === language)) invalid('Voice language is not supported')
    if (!(values.wav instanceof Uint8Array)) invalid('Recording must be WAV bytes')
    // The renderer's snapshot is re-checked here: the same rules as storage, so nothing else reaches argv.
    const vocabulary = validateVocabulary(values.vocabulary ?? [])
    if (!vocabulary.ok) invalid(vocabulary.reason)
    if (!existsSync(options.binary)) {
      throw new MainIpcError(ERROR_CODES.notFound, 'Voice engine is not built; run pnpm run voice:build')
    }
    const folder = await currentFolder(options)
    requireAvailable(folder)
    if (!(await modelInstalled(folder.path, model))) {
      throw new MainIpcError(ERROR_CODES.notFound, `Download the ${model.id} voice model in Preferences first`)
    }
    if (transcribing) throw new MainIpcError(ERROR_CODES.ioError, 'Another recording is still being transcribed')
    transcribing = true
    try {
      const text = await (options.transcribe ?? transcribeRecording)({
        binary: options.binary,
        modelPath: join(folder.path, model.file),
        language,
        wav: values.wav,
        vocabulary: vocabulary.words
      })
      return { text }
    } finally {
      transcribing = false
    }
  })
}
