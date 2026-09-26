// MODULE: file-reference-ipc.ts - renderer channels to read a referenced file, choose a base folder and show the file
import { isAbsolute, normalize } from 'node:path'
import {
  ERROR_CODES,
  FILE_REFERENCE_MAX_LENGTH,
  METHOD_REGISTRY,
  hasControlOrFormatCharacter,
  type FileReferencePasteParams,
  type FileReferencePasteReceipt,
  type FileReferenceSearchParams,
  type FileReferenceSearchResult,
  type FileReferenceReadResult,
  type ProtocolMethod
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { MainIpcError } from './workspace-ipc'

interface FileReferenceIpcRegistrar {
  handle(channel: `aiterm:${string}`, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown): void
}

export interface FileReferenceIpcActions {
  client(): { request<Result>(method: ProtocolMethod, params: object): Promise<Result> }
  senderIsAllowed(event: IpcMainInvokeEvent): boolean
  /** Asks the owner for a base folder for one opening; resolves null when they cancel. */
  chooseFolder(event: IpcMainInvokeEvent): Promise<string | null>
  /** Reveals the file in the system file manager; it never opens or runs the file. */
  showInFolder(path: string): void
  /** Only the focused owner window may confirm a paste. */
  ownerFocused(event: IpcMainInvokeEvent): boolean
}

function invalid(message: string): never {
  throw new MainIpcError(ERROR_CODES.invalidArgument, message)
}

function objectParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid('File reference parameters must be an object')
  return params as Record<string, unknown>
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > FILE_REFERENCE_MAX_LENGTH) {
    invalid(`${name} must be text of at most ${FILE_REFERENCE_MAX_LENGTH} characters`)
  }
  return value
}

/** An absolute, already-normalized path without control characters, as the reader reports it. */
function displayedFilePath(value: unknown): string {
  const path = boundedText(value, 'The file path')
  if (hasControlOrFormatCharacter(path) || !isAbsolute(path) || normalize(path) !== path) invalid('The file path must be an absolute path')
  return path
}

/** Files each window was shown most recently; Show in folder reveals only one of these. */
const SHOWN_FILES_PER_WINDOW = 32

export function installFileReferenceIpcHandlers(ipc: FileReferenceIpcRegistrar, actions: FileReferenceIpcActions): void {
  const shownFiles = new Map<number, string[]>()
  const remember = (senderId: number, path: string): void => {
    const files = (shownFiles.get(senderId) ?? []).filter((file) => file !== path)
    files.push(path)
    shownFiles.set(senderId, files.slice(-SHOWN_FILES_PER_WINDOW))
  }
  const handle = (
    channel: `aiterm:${string}`,
    listener: (event: IpcMainInvokeEvent, params: unknown) => unknown
  ): void => {
    ipc.handle(channel, (event, params) => {
      if (!actions.senderIsAllowed(event)) {
        throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
      }
      return listener(event, params)
    })
  }

  handle('aiterm:file-reference:read', (event, params) => {
    const input = objectParams(params)
    const baseDirectory = input.baseDirectory
    if (baseDirectory !== undefined && baseDirectory !== null) boundedText(baseDirectory, 'The chosen folder')
    // Only the three known fields cross to the utility, which parses and checks all of them again.
    return actions.client().request<FileReferenceReadResult>(METHOD_REGISTRY.fileReferenceRead, {
      sessionId: boundedText(input.sessionId, 'The source session'),
      reference: boundedText(input.reference, 'The file reference'),
      baseDirectory: baseDirectory ?? null
    }).then((result) => {
      if (result.status === 'ready') remember(event.sender.id, result.canonicalPath)
      return result
    })
  })

  handle('aiterm:file-reference:choose-base', (event) => actions.chooseFolder(event))

  handle('aiterm:file-reference:show', (event, params) => {
    const path = displayedFilePath(objectParams(params).path)
    if (!shownFiles.get(event.sender.id)?.includes(path)) invalid('Only a file shown in the preview can be revealed')
    actions.showInFolder(path)
    return { shown: true }
  })

  handle('aiterm:file-reference:paste', (event, params) => {
    const input = objectParams(params)
    if (!actions.ownerFocused(event)) invalid('The window lost focus; choose the destination again')
    const sourcePath = displayedFilePath(input.sourcePath)
    if (!shownFiles.get(event.sender.id)?.includes(sourcePath)) {
      invalid('Open this file in the preview again before sending it')
    }
    const line = input.line
    const column = input.column
    if ((line !== null && (!Number.isSafeInteger(line) || Number(line) < 1)) ||
      (column !== null && (!Number.isSafeInteger(column) || Number(column) < 1))) {
      invalid('The reference position is invalid')
    }
    const request: FileReferencePasteParams = {
      requestId: boundedText(input.requestId, 'The paste request'),
      sessionId: boundedText(input.sessionId, 'The destination session'),
      expectedIncarnationId: boundedText(input.expectedIncarnationId, 'The destination process'),
      sourcePath,
      line: line as number | null,
      column: column as number | null
    }
    return actions.client().request<FileReferencePasteReceipt>(METHOD_REGISTRY.fileReferencePaste, request)
  })

  handle('aiterm:file-reference:search', (_event, params) => {
    const input = objectParams(params)
    const request: FileReferenceSearchParams = {
      ownerId: boundedText(input.ownerId, 'The palette'),
      requestId: boundedText(input.requestId, 'The search'),
      workspaceId: boundedText(input.workspaceId, 'The workspace'),
      sessionId: input.sessionId === null ? null : boundedText(input.sessionId, 'The selected session'),
      query: boundedText(input.query, 'The search query')
    }
    if (request.query.length > 256) invalid('The search query is too long')
    return actions.client().request<FileReferenceSearchResult>(METHOD_REGISTRY.fileReferenceSearch, request)
  })

  handle('aiterm:file-reference:search-cancel', (_event, params) => {
    const input = objectParams(params)
    return actions.client().request(METHOD_REGISTRY.fileReferenceSearchCancel, {
      ownerId: boundedText(input.ownerId, 'The palette'),
      requestId: boundedText(input.requestId, 'The search')
    })
  })
}
