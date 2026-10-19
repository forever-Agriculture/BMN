// MODULE: file-reference-ipc.ts - renderer channels to read a referenced file, choose a base folder, show the file, and Quick look's reads
import { isAbsolute, normalize } from 'node:path'
import {
  ERROR_CODES,
  FILE_REFERENCE_MAX_LENGTH,
  METHOD_REGISTRY,
  QUICK_LOOK_EDIT_MAX_BYTES,
  QUICK_LOOK_SEARCH_MAX_CHARS,
  hasControlOrFormatCharacter,
  type FileReferencePasteParams,
  type FileReferencePasteReceipt,
  type FileReferenceSearchParams,
  type FileReferenceSearchResult,
  type FileReferenceReadResult,
  type ProtocolMethod,
  type QuickLookListResult,
  type QuickLookIdentityResult,
  type QuickLookReadResult,
  type QuickLookSaveResult,
  type QuickLookRootResult,
  type QuickLookSearchResult,
  type QuickLookSource
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { invalidMainIpc, MainIpcError } from './workspace-ipc'

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

function objectParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalidMainIpc('File reference parameters must be an object')
  return params as Record<string, unknown>
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > FILE_REFERENCE_MAX_LENGTH) {
    invalidMainIpc(`${name} must be text of at most ${FILE_REFERENCE_MAX_LENGTH} characters`)
  }
  return value
}

/** An absolute, already-normalized path without control characters, as the reader reports it. */
function displayedFilePath(value: unknown): string {
  const path = boundedText(value, 'The file path')
  if (hasControlOrFormatCharacter(path) || !isAbsolute(path) || normalize(path) !== path) invalidMainIpc('The file path must be an absolute path')
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
    if ((input.sessionId !== undefined) === (input.workspaceId !== undefined)) invalidMainIpc('Choose exactly one source session or workspace')
    const baseDirectory = input.baseDirectory
    if (baseDirectory !== undefined && baseDirectory !== null) boundedText(baseDirectory, 'The chosen folder')
    // Only the three known fields cross to the utility, which parses and checks all of them again.
    return actions.client().request<FileReferenceReadResult>(METHOD_REGISTRY.fileReferenceRead, {
      ...(input.workspaceId === undefined ? { sessionId: boundedText(input.sessionId, 'The source session') }
        : { workspaceId: boundedText(input.workspaceId, 'The source workspace') }),
      reference: boundedText(input.reference, 'The file reference'),
      baseDirectory: baseDirectory ?? null
    }).then((result) => {
      if (result.status === 'ready') remember(event.sender.id, result.canonicalPath)
      return result
    })
  })

  handle('aiterm:file-reference:choose-base', (event) => actions.chooseFolder(event))

  // Quick look (Story 67.1) reaches the utility only through these window channels: no control-socket method and no
  // `bmn` command names them. Each names its source, which the utility checks is still there.
  const quickLookSource = (input: Record<string, unknown>): QuickLookSource => {
    if ((input.sessionId !== undefined) === (input.workspaceId !== undefined)) invalidMainIpc('Choose exactly one source session or workspace')
    return input.workspaceId === undefined ? { sessionId: boundedText(input.sessionId, 'The source session') }
      : { workspaceId: boundedText(input.workspaceId, 'The source workspace') }
  }

  handle('aiterm:quick-look:root', (_event, params) =>
    actions.client().request<QuickLookRootResult>(METHOD_REGISTRY.quickLookRoot, quickLookSource(objectParams(params))))

  handle('aiterm:quick-look:list', (_event, params) => {
    const input = objectParams(params)
    return actions.client().request<QuickLookListResult>(METHOD_REGISTRY.quickLookList, {
      ...quickLookSource(input), folder: displayedFilePath(input.folder)
    })
  })

  handle('aiterm:quick-look:read', (event, params) => {
    const input = objectParams(params)
    return actions.client().request<QuickLookReadResult>(METHOD_REGISTRY.quickLookRead, {
      ...quickLookSource(input), path: displayedFilePath(input.path),
      ...(input.root === undefined ? {} : { root: displayedFilePath(input.root) })
    }).then((result) => {
      // A file shown as text, or by its facts, may be revealed in its folder, as the preview's may.
      if (result.status === 'ready' || result.facts) remember(event.sender.id, result.canonicalPath ?? result.path)
      return result
    })
  })

  handle('aiterm:quick-look:identity', (_event, params) => {
    const input = objectParams(params)
    return actions.client().request<QuickLookIdentityResult>(METHOD_REGISTRY.quickLookIdentity, {
      ...quickLookSource(input), path: displayedFilePath(input.path)
    })
  })


  // Quick look's one writer (Story 68.1): the text crosses to the utility, which checks the file and the root again.
  // Nothing here logs or keeps it.
  handle('aiterm:quick-look:save', (_event, params) => {
    const input = objectParams(params)
    if (typeof input.text !== 'string' || input.text.length > QUICK_LOOK_EDIT_MAX_BYTES) invalidMainIpc('The text to save')
    return actions.client().request<QuickLookSaveResult>(METHOD_REGISTRY.quickLookSave, {
      ...quickLookSource(input),
      root: displayedFilePath(input.root),
      path: displayedFilePath(input.path),
      digest: boundedText(input.digest, 'The read to save over'),
      text: input.text
    })
  })

  // One search per window: the window is the owner, so a newer search from it aborts the older (Story 67.5).
  handle('aiterm:quick-look:search', (event, params) => {
    const input = objectParams(params)
    if (input.mode !== 'files' && input.mode !== 'contents') invalidMainIpc('Choose Files or Contents')
    const query = typeof input.query === 'string' ? input.query : invalidMainIpc('The search query')
    if (query.length > QUICK_LOOK_SEARCH_MAX_CHARS * 2) invalidMainIpc('The search query is too long')
    return actions.client().request<QuickLookSearchResult>(METHOD_REGISTRY.quickLookSearch, {
      ...quickLookSource(input),
      ownerId: `quick-look:${event.sender.id}`,
      requestId: boundedText(input.requestId, 'The search'),
      root: displayedFilePath(input.root),
      mode: input.mode,
      query,
      matchCase: input.matchCase === true,
      wholeWord: input.wholeWord === true
    })
  })

  handle('aiterm:quick-look:search-cancel', (event, params) => actions.client().request(METHOD_REGISTRY.quickLookSearchCancel, {
    ownerId: `quick-look:${event.sender.id}`,
    requestId: boundedText(objectParams(params).requestId, 'The search')
  }))

  handle('aiterm:file-reference:show', (event, params) => {
    const path = displayedFilePath(objectParams(params).path)
    if (!shownFiles.get(event.sender.id)?.includes(path)) invalidMainIpc('Only a file shown in the preview can be revealed')
    actions.showInFolder(path)
    return { shown: true }
  })

  handle('aiterm:file-reference:paste', (event, params) => {
    const input = objectParams(params)
    if (!actions.ownerFocused(event)) invalidMainIpc('The window lost focus; choose the destination again')
    const sourcePath = displayedFilePath(input.sourcePath)
    if (!shownFiles.get(event.sender.id)?.includes(sourcePath)) {
      invalidMainIpc('Open this file in the preview again before sending it')
    }
    const line = input.line
    const column = input.column
    if ((line !== null && (!Number.isSafeInteger(line) || Number(line) < 1)) ||
      (column !== null && (!Number.isSafeInteger(column) || Number(column) < 1))) {
      invalidMainIpc('The reference position is invalid')
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
    if (request.query.length > 256) invalidMainIpc('The search query is too long')
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
