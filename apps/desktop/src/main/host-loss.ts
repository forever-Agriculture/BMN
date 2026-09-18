import { ERROR_CODES, METHOD_REGISTRY, type ProtocolMethod } from '@bmn/protocol'

interface HostExitSource {
  onExit(listener: (error: Error) => void): () => void
}

interface HostLossNotice {
  ok: false
  code: string
  message: string
}

interface SessionIdentity {
  sessionId: string
  incarnationId: string
}

interface AttachmentIdentity extends SessionIdentity {
  attachmentId: string
  streamSeq: 0
  captureStartedAt: string
}

interface TerminalDimensions {
  cols: number
  rows: number
}

interface RendererRecoveryRuntime {
  session: SessionIdentity
  attachment: AttachmentIdentity
  dimensions: TerminalDimensions
}

interface RendererRecoveryActions<HostPort, RendererPort> {
  detach(attachmentId: string): Promise<unknown>
  createChannel(): { hostPort: HostPort; rendererPort: RendererPort }
  connectHostPort(port: HostPort): void
  attach(session: SessionIdentity): Promise<AttachmentIdentity>
  resize(attachmentId: string, dimensions: TerminalDimensions): Promise<unknown>
  isMissingAttachment(error: unknown): boolean
  closeRendererPort(port: RendererPort): void
}

interface ExistingSessionRecoveryRuntime<HostPort> extends RendererRecoveryRuntime {
  client: {
    request<Result = unknown>(method: ProtocolMethod, params: object): Promise<Result>
    attachTerminalPort(port: HostPort): void
  }
}

interface ExistingSessionRecoveryActions<HostPort, RendererPort> {
  createChannel(): { hostPort: HostPort; rendererPort: RendererPort }
  isMissingAttachment(error: unknown): boolean
  closeRendererPort(port: RendererPort): void
}

interface RegistryRecoveryActions<HostPort, RendererPort, Runtime>
  extends ExistingSessionRecoveryActions<HostPort, RendererPort> {
  /**
   * True only when the still-connected host has reported this incarnation no longer live, or main no
   * longer holds it as the current runtime: the proof that the process is gone.
   */
  isGone(runtime: Runtime): boolean
}

/** Coalesces concurrent recovery requests while guaranteeing one rerun for work requested in flight. */
export function createRendererRecoveryCoalescer<Argument extends object>(
  recover: (argument: Argument) => Promise<void>
): (argument: Argument) => Promise<void> {
  let running = false
  let pending: Argument | undefined

  const request = async (argument: Argument): Promise<void> => {
    if (running) {
      pending = argument
      return
    }
    running = true
    let current = argument
    try {
      while (true) {
        pending = undefined
        await recover(current)
        if (!pending) break
        current = pending
      }
    } finally {
      running = false
      if (pending) {
        const rerun = pending
        pending = undefined
        await request(rerun)
      }
    }
  }
  return request
}

export function connectRendererChannel<Client, HostPort, RendererPort>(actions: {
  requireClient(): Client
  createChannel(): { hostPort: HostPort; rendererPort: RendererPort }
  connect(client: Client, hostPort: HostPort): void
  closeHostPort(hostPort: HostPort): void
  closeRendererPort(rendererPort: RendererPort): void
}): { hostPort: HostPort; rendererPort: RendererPort } {
  // Resolve the failure-prone client before allocating native ports.
  const client = actions.requireClient()
  const channel = actions.createChannel()
  try {
    actions.connect(client, channel.hostPort)
    return channel
  } catch (error) {
    try {
      actions.closeHostPort(channel.hostPort)
    } catch {
      // Preserve the connection failure while still attempting to close the peer port.
    }
    try {
      actions.closeRendererPort(channel.rendererPort)
    } catch {
      // Preserve the connection failure.
    }
    throw error
  }
}

/**
 * Reattaches every session in a registry snapshot through one replacement renderer port. The one
 * rule for sessions that end around recovery: a runtime proven gone (`isGone`) before its reattach
 * is skipped, and a reattach failure is tolerated only when that runtime is proven gone after the
 * failure; both are returned in `gone` for the caller to prune. Every other failure fails recovery.
 */
export async function recoverExistingSessionRenderers<
  HostPort,
  RendererPort,
  Runtime extends ExistingSessionRecoveryRuntime<HostPort>
>(
  runtimes: readonly Runtime[],
  actions: RegistryRecoveryActions<HostPort, RendererPort, Runtime>
): Promise<{
  attachments: Array<{ sessionId: string; attachment: AttachmentIdentity }>
  gone: Runtime[]
  rendererPort: RendererPort
}> {
  if (runtimes.length === 0) throw new Error('At least one live session is required for recovery')
  const channel = actions.createChannel()
  const gone: Runtime[] = []
  let connected = false
  let portClosed = false
  const closeChannel = (): void => {
    if (portClosed) return
    portClosed = true
    actions.closeRendererPort(channel.rendererPort)
  }
  const attachments: Array<{
    sessionId: string
    attachment: AttachmentIdentity
    client: ExistingSessionRecoveryRuntime<HostPort>['client']
  }> = []
  const connectHostPort = (runtime: Runtime): void => {
    if (connected) return
    runtime.client.attachTerminalPort(channel.hostPort)
    connected = true
  }
  try {
    for (const runtime of runtimes) {
      if (actions.isGone(runtime)) {
        gone.push(runtime)
        continue
      }
      let recovered: { attachment: AttachmentIdentity }
      try {
        recovered = await recoverRendererView(runtime, {
          detach: (attachmentId) =>
            runtime.client.request(METHOD_REGISTRY.terminalDetach, { attachmentId }),
          createChannel: () => channel,
          connectHostPort: () => connectHostPort(runtime),
          attach: (session) =>
            runtime.client.request<AttachmentIdentity>(METHOD_REGISTRY.terminalAttach, session),
          resize: (attachmentId, dimensions) =>
            runtime.client.request(METHOD_REGISTRY.terminalResize, { attachmentId, ...dimensions }),
          isMissingAttachment: actions.isMissingAttachment,
          // The shared port stays open for the other sessions; the outer catch closes it on failure.
          closeRendererPort: () => undefined
        })
      } catch (error) {
        if (!actions.isGone(runtime)) throw error
        gone.push(runtime)
        continue
      }
      attachments.push({
        sessionId: runtime.session.sessionId,
        attachment: recovered.attachment,
        client: runtime.client
      })
    }
    // Sessions created after recovery stream through this port even when every snapshot entry ended.
    connectHostPort(runtimes[0]!)
  } catch (error) {
    // A partial registry recovery must not leave replacement leases or the shared host port behind.
    for (const item of attachments) {
      try {
        await item.client.request(METHOD_REGISTRY.terminalDetach, {
          attachmentId: item.attachment.attachmentId
        })
      } catch {
        // Preserve the recovery failure; closing the channel revokes any lease this detach missed.
      }
    }
    closeChannel()
    throw error
  }
  return {
    attachments: attachments.map(({ sessionId, attachment }) => ({ sessionId, attachment })),
    gone,
    rendererPort: channel.rendererPort
  }
}

interface LiveWindowLifecycleActions {
  onDidFinishLoad(listener: () => void): void
  onRendererGone(listener: (reason: string) => void): void
  onClose(listener: (event: { preventDefault(): void }) => void): void
  deliverStartup(): void
  recoverRenderer(): void
  shouldReloadRenderer(): boolean
  reloadRenderer(): void
  keepResident(): boolean
  hideWindow(): void
  handleClose?(event: { preventDefault(): void }): void
}

export function scheduleTerminalViewRecovery(
  reason: unknown,
  view: { isDestroyed(): boolean; reload(): void },
  schedule: (operation: () => void) => void = (operation) => setTimeout(operation, 0)
): { recovering: true } {
  if (
    reason !== 'output-overflow' &&
    reason !== 'sequence-gap' &&
    reason !== 'acknowledgement-timeout'
  ) {
    throw new Error('Terminal recovery reason is invalid')
  }
  schedule(() => {
    if (!view.isDestroyed()) view.reload()
  })
  return { recovering: true }
}

export function preserveLiveWindowOnClose(
  event: { preventDefault(): void },
  window: { hide(): void },
  keepResident: boolean
): boolean {
  if (!keepResident) return false
  event.preventDefault()
  window.hide()
  return true
}

export async function recoverRendererView<HostPort, RendererPort>(
  runtime: RendererRecoveryRuntime,
  actions: RendererRecoveryActions<HostPort, RendererPort>
): Promise<{ attachment: AttachmentIdentity; rendererPort: RendererPort }> {
  try {
    await actions.detach(runtime.attachment.attachmentId)
  } catch (error) {
    if (!actions.isMissingAttachment(error)) throw error
  }

  const channel = actions.createChannel()
  let attachment: AttachmentIdentity | undefined
  try {
    actions.connectHostPort(channel.hostPort)
    attachment = await actions.attach(runtime.session)
    const repaintDimensions = {
      cols: runtime.dimensions.cols < 1_000 ? runtime.dimensions.cols + 1 : runtime.dimensions.cols - 1,
      rows: runtime.dimensions.rows
    }
    await actions.resize(attachment.attachmentId, repaintDimensions)
    await actions.resize(attachment.attachmentId, runtime.dimensions)
    return { attachment, rendererPort: channel.rendererPort }
  } catch (error) {
    if (attachment) {
      try {
        await actions.detach(attachment.attachmentId)
      } catch {
        // Preserve the recovery failure; the port-close path revokes the replacement lease immediately.
      }
    }
    actions.closeRendererPort(channel.rendererPort)
    throw error
  }
}

export function recoverExistingSessionRenderer<HostPort, RendererPort>(
  runtime: ExistingSessionRecoveryRuntime<HostPort>,
  actions: ExistingSessionRecoveryActions<HostPort, RendererPort>
): Promise<{ attachment: AttachmentIdentity; rendererPort: RendererPort }> {
  return recoverRendererView(runtime, {
    detach: (attachmentId) =>
      runtime.client.request(METHOD_REGISTRY.terminalDetach, { attachmentId }),
    createChannel: actions.createChannel,
    connectHostPort: (port) => runtime.client.attachTerminalPort(port),
    attach: (session) =>
      runtime.client.request<AttachmentIdentity>(METHOD_REGISTRY.terminalAttach, session),
    resize: (attachmentId, dimensions) =>
      runtime.client.request(METHOD_REGISTRY.terminalResize, { attachmentId, ...dimensions }),
    isMissingAttachment: actions.isMissingAttachment,
    closeRendererPort: actions.closeRendererPort
  })
}

export function wireLiveWindowLifecycle(actions: LiveWindowLifecycleActions): void {
  let startupDelivered = false
  actions.onDidFinishLoad(() => {
    if (!startupDelivered) {
      startupDelivered = true
      actions.deliverStartup()
      return
    }
    actions.recoverRenderer()
  })
  actions.onRendererGone((reason) => {
    if (reason !== 'clean-exit' && actions.shouldReloadRenderer()) actions.reloadRenderer()
  })
  actions.onClose((event) => {
    if (actions.handleClose) {
      actions.handleClose(event)
      return
    }
    preserveLiveWindowOnClose(event, { hide: actions.hideWindow }, actions.keepResident())
  })
}

export function watchHostLoss(
  source: HostExitSource,
  actions: {
    isCurrent(): boolean
    clearRuntime(): void
    publish(notice: HostLossNotice): void
  }
): () => void {
  return source.onExit(() => {
    if (!actions.isCurrent()) return
    actions.clearRuntime()
    actions.publish({
      ok: false,
      code: ERROR_CODES.ioError,
      message:
        'The terminal host exited unexpectedly. Fix: restart BMN; the shell process ended with the terminal host.'
    })
  })
}
