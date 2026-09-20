// MODULE: companion-ipc.ts - renderer channels for artifacts, attention, progress, drafts, settings, Telegram and backup
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  type AppEventMessage,
  type AppSettings,
  type ArtifactRecord,
  type AttentionKind,
  type AttentionRecord,
  type ProtocolMethod
} from '@bmn/protocol'
import {
  BrowserWindow,
  clipboard,
  dialog,
  shell,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { MainIpcError } from './workspace-ipc'

interface CompanionHostClient {
  request<Result>(method: ProtocolMethod, params: object): Promise<Result>
}

interface CompanionIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown): void
}

export interface CompanionIpcActions {
  client(): CompanionHostClient
  senderIsAllowed(event: IpcMainInvokeEvent): boolean
  /** Dialogs stay disabled in automated runs so no test can block on a native picker. */
  dialogsEnabled(): boolean
}

const ROUTES = {
  'aiterm:artifact:list': METHOD_REGISTRY.artifactList,
  'aiterm:artifact:preview': METHOD_REGISTRY.artifactPreview,
  'aiterm:artifact:deliver': METHOD_REGISTRY.artifactDeliver,
  'aiterm:attention:list': METHOD_REGISTRY.attentionList,
  'aiterm:attention:seen': METHOD_REGISTRY.attentionSeen,
  'aiterm:attention:resolve': METHOD_REGISTRY.attentionResolve,
  'aiterm:hook-events:list': METHOD_REGISTRY.hookEventsList,
  'aiterm:progress:list': METHOD_REGISTRY.progressList,
  'aiterm:draft:list': METHOD_REGISTRY.draftList,
  'aiterm:draft:save': METHOD_REGISTRY.draftSave,
  'aiterm:draft:retry': METHOD_REGISTRY.draftRetry,
  'aiterm:draft:send': METHOD_REGISTRY.draftSend,
  'aiterm:draft:discard': METHOD_REGISTRY.draftDiscard,
  'aiterm:settings:get': METHOD_REGISTRY.settingsGet,
  'aiterm:settings:put': METHOD_REGISTRY.settingsPut,
  'aiterm:telegram:configure': METHOD_REGISTRY.telegramConfigure,
  'aiterm:telegram:status': METHOD_REGISTRY.telegramStatus,
  'aiterm:telegram:test': METHOD_REGISTRY.telegramTest,
  'aiterm:control:info': METHOD_REGISTRY.controlInfo
} as const

const PASTE_IMAGE_TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']])

/** Media types an external viewer may open directly; anything else must be saved first. */
const OPENABLE_MEDIA = /^(image\/(png|jpeg|gif|webp)|text\/plain|application\/pdf)$/

function objectParams(params: unknown): Record<string, unknown> {
  if (params === undefined) return {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new MainIpcError(ERROR_CODES.invalidArgument, 'IPC parameters must be an object')
  }
  return params as Record<string, unknown>
}

function requiredText(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new MainIpcError(ERROR_CODES.invalidArgument, `${key} is required`)
  }
  return value
}

function windowFor(sender: WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined
}

export function installCompanionIpcHandlers(ipc: CompanionIpcRegistrar, actions: CompanionIpcActions): void {
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, params: Record<string, unknown>) => unknown
  ): void => {
    ipc.handle(channel, (event, params) => {
      if (!actions.senderIsAllowed(event)) {
        throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
      }
      return listener(event, objectParams(params))
    })
  }
  const requireDialogs = (): void => {
    if (!actions.dialogsEnabled()) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'File dialogs are unavailable in this run')
    }
  }
  const findArtifact = async (artifactId: string): Promise<ArtifactRecord> => {
    const artifacts = await actions.client().request<ArtifactRecord[]>(METHOD_REGISTRY.artifactList, {})
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId)
    if (!artifact) throw new MainIpcError(ERROR_CODES.notFound, 'The artifact was not found')
    return artifact
  }

  for (const [channel, method] of Object.entries(ROUTES)) {
    handle(channel, (_event, params) => actions.client().request(method, params))
  }

  handle('aiterm:artifact:import-pick', async (event, params) => {
    const sessionId = requiredText(params, 'sessionId')
    requireDialogs()
    const owner = windowFor(event.sender)
    const options = { title: 'Attach files', properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled) return []
    const imported: ArtifactRecord[] = []
    for (const path of picked.filePaths) {
      imported.push(await actions.client().request<ArtifactRecord>(METHOD_REGISTRY.artifactImport, { sessionId, path }))
    }
    return imported
  })

  handle('aiterm:artifact:import-paths', async (_event, params) => {
    const sessionId = requiredText(params, 'sessionId')
    const paths = params.paths
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 32 || !paths.every((path) => typeof path === 'string')) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Choose between 1 and 32 files')
    }
    const imported: ArtifactRecord[] = []
    for (const path of paths as string[]) {
      imported.push(await actions.client().request<ArtifactRecord>(METHOD_REGISTRY.artifactImport, { sessionId, path }))
    }
    return imported
  })

  handle('aiterm:artifact:paste-image', async (_event, params) => {
    const sessionId = requiredText(params, 'sessionId')
    const items = await clipboard.read()
    const item = items.find((candidate) => candidate.types.some((type) => PASTE_IMAGE_TYPES.has(type)))
    const type = item?.types.find((candidate) => PASTE_IMAGE_TYPES.has(candidate))
    if (!item || !type) return null
    const blob = await item.getType(type) as Blob
    const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..*$/, '')
    return actions.client().request<ArtifactRecord>(METHOD_REGISTRY.artifactImportBytes, {
      sessionId,
      name: `pasted-image-${stamp}.${PASTE_IMAGE_TYPES.get(type)}`,
      bytes: new Uint8Array(await blob.arrayBuffer())
    })
  })

  handle('aiterm:clipboard:read-text', async () => ({ text: await clipboard.readText() }))

  handle('aiterm:clipboard:write-text', async (_event, params) => {
    const value = params.text
    if (typeof value !== 'string' || value.length > 8 * 1024 * 1024) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Clipboard text is invalid')
    }
    await clipboard.writeText(value)
    return { written: true }
  })

  handle('aiterm:artifact:save-as', async (event, params) => {
    const artifact = await findArtifact(requiredText(params, 'artifactId'))
    requireDialogs()
    const owner = windowFor(event.sender)
    const options = { title: 'Save a copy', defaultPath: artifact.originalName }
    const chosen = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return { saved: null }
    const result = await actions.client().request<{ sha256: string; byteLength: number }>(
      METHOD_REGISTRY.artifactSaveAs,
      // The native dialog already confirmed replacing an existing file.
      { artifactId: artifact.artifactId, destinationPath: chosen.filePath, overwrite: true }
    )
    return { saved: chosen.filePath, ...result }
  })

  handle('aiterm:artifact:open', async (_event, params) => {
    const artifact = await findArtifact(requiredText(params, 'artifactId'))
    if (!OPENABLE_MEDIA.test(artifact.mediaType)) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Save a copy to open this file type')
    }
    await actions.client().request(METHOD_REGISTRY.artifactPreview, { artifactId: artifact.artifactId })
    const failure = await shell.openPath(artifact.storedPath)
    if (failure) throw new MainIpcError(ERROR_CODES.ioError, failure.slice(0, 200))
    return { opened: true }
  })

  handle('aiterm:artifact:show', async (_event, params) => {
    const artifact = await findArtifact(requiredText(params, 'artifactId'))
    shell.showItemInFolder(artifact.storedPath)
    return { shown: true }
  })

  handle('aiterm:backup:export', async (event) => {
    requireDialogs()
    const owner = windowFor(event.sender)
    const options = { title: 'Choose where to save the backup', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null
    return actions.client().request(METHOD_REGISTRY.backupExport, { directory: picked.filePaths[0] })
  })

  handle('aiterm:backup:verify', async (event, params) => {
    let directory = typeof params.directory === 'string' ? params.directory : undefined
    if (!directory) {
      requireDialogs()
      const owner = windowFor(event.sender)
      const options = { title: 'Choose a backup folder to verify', properties: ['openDirectory'] as Array<'openDirectory'> }
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return null
      directory = picked.filePaths[0]
    }
    return actions.client().request(METHOD_REGISTRY.backupVerify, { directory })
  })
}

export interface AppEventForwarderOptions {
  client(): CompanionHostClient | undefined
  targets(): WebContents[]
  /** True while the owner is present and looking at the session: selected in a focused window. */
  watching(sessionId: string): boolean
  notify(notification: AttentionNotification): void
  notificationsEnabled(): boolean
  /** Workspace and session names, so a notification says where it comes from. */
  place?(sessionId: string): Promise<string | null>
}

export interface AttentionNotification {
  title: string
  body: string
  sessionId: string
  requestId: string
  kind: AttentionKind
  revision: number
}

/** Opens the exact session and closes informational notices; prompts still require answer evidence. */
export async function activateAttentionNotification(
  notification: Pick<AttentionNotification, 'sessionId' | 'requestId' | 'kind' | 'revision'>,
  actions: {
    close(): void
    openSession(sessionId: string): void
    resolveNotice(requestId: string, expectedRevision: number): Promise<unknown>
  }
): Promise<void> {
  actions.close()
  actions.openSession(notification.sessionId)
  if (notification.kind === 'notice') {
    await actions.resolveNotice(notification.requestId, notification.revision).catch(() => undefined)
  }
}

/**
 * Forwards host events to every allowed renderer and raises one desktop notification per newly opened
 * attention request, unless the owner is already looking at that session. A request in a watched session counts as
 * seen, so it is not sent on to the owner's phone.
 */
export function createAppEventForwarder(options: AppEventForwarderOptions): {
  forward(message: AppEventMessage): void
  /** Records requests already open at startup so only later ones notify. */
  prime(): Promise<void>
  /** Call when window focus, the selected session or the owner's presence changes. */
  watchChanged(): void
} {
  const notified = new Set<string>()
  let primed = false
  const markWatchedSeen = async (client: CompanionHostClient, open: AttentionRecord[]): Promise<void> => {
    for (const request of open) {
      if (request.seenAt !== null || !options.watching(request.sessionId)) continue
      await client.request(METHOD_REGISTRY.attentionSeen, { requestId: request.requestId }).catch(() => undefined)
    }
  }
  const notifyNewAttention = async (): Promise<void> => {
    const client = options.client()
    if (!client) return
    const [requests, settings] = await Promise.all([
      client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}),
      client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})
    ])
    const open = requests.filter((request) => request.state === 'open')
    await markWatchedSeen(client, open)
    const fresh = open.filter((request) => !notified.has(`${request.requestId}:${request.revision}`))
    for (const request of open) notified.add(`${request.requestId}:${request.revision}`)
    if (!primed) {
      primed = true
      return
    }
    if (!settings.notifications.desktop || !options.notificationsEnabled()) return
    for (const request of fresh) {
      if (options.watching(request.sessionId)) continue
      const place = await options.place?.(request.sessionId).catch(() => null) ?? null
      options.notify({
        title: request.kind === 'notice' ? place ?? 'BMN' : `${place ?? 'A session'} needs you`,
        body: request.title.slice(0, 200),
        sessionId: request.sessionId,
        requestId: request.requestId,
        kind: request.kind,
        revision: request.revision
      })
    }
  }
  return {
    forward: (message) => {
      for (const target of options.targets()) {
        if (!target.isDestroyed()) target.send('aiterm:app-event', message)
      }
      if (message.topic === 'attention') void notifyNewAttention().catch(() => undefined)
    },
    prime: () => notifyNewAttention().catch(() => undefined),
    watchChanged: () => {
      const client = options.client()
      if (!client) return
      void client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {})
        .then((requests) => markWatchedSeen(client, requests.filter((request) => request.state === 'open')))
        .catch(() => undefined)
    }
  }
}
