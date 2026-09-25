import { Terminal } from '@xterm/headless'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  type ProtocolMethod,
  type SavedOutputCaptureOutcome,
  type SessionStopCause
} from '@bmn/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  adoptsStartedAttachment,
  connectRendererChannel,
  createRendererRecoveryCoalescer,
  recoverExistingSessionRenderer,
  recoverExistingSessionRenderers,
  recoverRendererView,
  scheduleTerminalViewRecovery,
  wireLiveWindowLifecycle,
  watchHostLoss
} from './host-loss'
import {
  createApplicationLifecycle,
  runningTargetForRuntime,
  stopAndDisposeCurrentTarget,
  type BackgroundChoiceDecision,
  type CloseChoicePrompt,
  type CloseDecision,
  type RunningSessionTarget
} from './app-lifecycle'
import { acquireRootScopedSingleInstance, focusExistingWindow } from './single-instance'
import { captureWebContents, captureSavedOutputForLifecycle } from './saved-output-capture-ipc'

const encoder = new TextEncoder()

function write(terminal: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function terminalState(terminal: Terminal): {
  buffer: string
  cursor: [number, number]
  lines: string[]
} {
  const buffer = terminal.buffer.active
  return {
    buffer: buffer.type,
    cursor: [buffer.cursorX, buffer.cursorY],
    lines: Array.from({ length: terminal.rows }, (_, index) =>
      buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? ''
    )
  }
}

const yi = encoder.encode('Ї')
const CONTINUITY_GAPS: Array<{
  name: string
  prefix: string | Uint8Array
  suffix: string | Uint8Array
  expected: ReturnType<typeof terminalState>
}> = [
  {
    name: 'partial CSI discarded',
    prefix: 'before\u001b[31',
    suffix: 'mX',
    expected: {
      buffer: 'normal',
      cursor: [7, 0],
      lines: ['beforeX', '', '', '', '', '', '', '']
    }
  },
  {
    name: 'partial UTF-8 discarded',
    prefix: new Uint8Array([...encoder.encode('before'), yi[0]!]),
    suffix: yi.slice(1),
    expected: {
      buffer: 'normal',
      cursor: [7, 0],
      lines: ['beforeЇ', '', '', '', '', '', '', '']
    }
  },
  {
    name: 'scrolling-region continuation',
    prefix: '\u001b[1;1Htop\u001b[2;1Htwo\u001b[3;1Hthree\u001b[4;1Hfour\u001b[5;1Houtside\u001b[2;4r\u001b[4;1H',
    suffix: '\nX',
    expected: {
      buffer: 'normal',
      cursor: [1, 3],
      lines: ['top', 'three', 'four', 'X', 'outside', '', '', '']
    }
  },
  {
    name: 'saved-cursor continuation',
    prefix: '\u001b[2;3Hsaved\u001b7\u001b[5;10Hcurrent',
    suffix: '\u001b8X',
    expected: {
      buffer: 'normal',
      cursor: [8, 1],
      lines: ['', '  savedX', '', '', '         current', '', '', '']
    }
  }
]

function lifecycleHarness(options: {
  hideWindow?: () => void
  keepResident?: () => boolean
  handleClose?: (event: { preventDefault(): void }) => void
} = {}): {
  didFinishLoad(): void
  rendererGone(reason: string): void
  close(): { preventDefault: ReturnType<typeof vi.fn> }
  deliverStartup: ReturnType<typeof vi.fn>
  recoverRenderer: ReturnType<typeof vi.fn>
  reloadRenderer: ReturnType<typeof vi.fn>
} {
  let didFinishLoad = (): void => undefined
  let rendererGone: (reason: string) => void = () => undefined
  let close: (event: { preventDefault(): void }) => void = () => undefined
  const deliverStartup = vi.fn()
  const recoverRenderer = vi.fn()
  const reloadRenderer = vi.fn()
  wireLiveWindowLifecycle({
    onDidFinishLoad: (listener) => (didFinishLoad = listener),
    onRendererGone: (listener) => (rendererGone = listener),
    onClose: (listener) => (close = listener),
    deliverStartup,
    recoverRenderer,
    shouldReloadRenderer: () => true,
    reloadRenderer,
    keepResident: options.keepResident ?? (() => true),
    hideWindow: options.hideWindow ?? (() => undefined),
    ...(options.handleClose ? { handleClose: options.handleClose } : {})
  })
  return {
    didFinishLoad,
    rendererGone,
    close: () => {
      const preventDefault = vi.fn()
      close({ preventDefault })
      return { preventDefault }
    },
    deliverStartup,
    recoverRenderer,
    reloadRenderer
  }
}

describe('host loss feedback', () => {
  it('coalesces an in-flight recovery and re-posts startup after the reloaded context finishes', async () => {
    let releaseFirst = (): void => undefined
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    let browserContext = 'old-context'
    let calls = 0
    const postedContexts: string[] = []
    const recover = createRendererRecoveryCoalescer(async () => {
      calls += 1
      const targetContext = browserContext
      if (calls === 1) await firstBlocked
      postedContexts.push(targetContext)
    })

    const first = recover({ request: 'renderer-gone' })
    browserContext = 'reloaded-context'
    void recover({ request: 'did-finish-load' })
    void recover({ request: 'coalesced-extra-request' })
    releaseFirst()
    await first

    expect(calls).toBe(2)
    expect(postedContexts).toEqual(['old-context', 'reloaded-context'])
  })

  it('resolves the host before creating recovery ports and closes both ports on connect failure', () => {
    const unavailable = new Error('host unavailable')
    const createChannelBeforeClient = vi.fn(() => ({ hostPort: 'host', rendererPort: 'renderer' }))
    expect(() => connectRendererChannel({
      requireClient: () => { throw unavailable },
      createChannel: createChannelBeforeClient,
      connect: vi.fn(),
      closeHostPort: vi.fn(),
      closeRendererPort: vi.fn()
    })).toThrow(unavailable)
    expect(createChannelBeforeClient).not.toHaveBeenCalled()

    const connectFailure = new Error('connect failed')
    const closeHostPort = vi.fn()
    const closeRendererPort = vi.fn()
    expect(() => connectRendererChannel({
      requireClient: () => ({ id: 'client' }),
      createChannel: () => ({ hostPort: 'host', rendererPort: 'renderer' }),
      connect: () => { throw connectFailure },
      closeHostPort,
      closeRendererPort
    })).toThrow(connectFailure)
    expect(closeHostPort).toHaveBeenCalledWith('host')
    expect(closeRendererPort).toHaveBeenCalledWith('renderer')
  })

  it('clears the live runtime and publishes a Feedback-notice next step', () => {
    let listener: ((error: Error) => void) | undefined
    const source = {
      onExit(next: (error: Error) => void) {
        listener = next
        return () => undefined
      }
    }
    const clearRuntime = vi.fn()
    const publish = vi.fn()
    watchHostLoss(source, { isCurrent: () => true, clearRuntime, publish })

    listener?.(new Error('utility host exited with code 9'))

    expect(clearRuntime).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith({
      ok: false,
      code: 'IO_ERROR',
      message:
        'The terminal host exited unexpectedly. Fix: restart BMN; the shell process ended with the terminal host.'
    })
  })

  it('suppresses a stale host exit after a new runtime becomes current', () => {
    let listener: ((error: Error) => void) | undefined
    const source = {
      onExit(next: (error: Error) => void) {
        listener = next
        return () => undefined
      }
    }
    const clearRuntime = vi.fn()
    const publish = vi.fn()
    watchHostLoss(source, { isCurrent: () => false, clearRuntime, publish })

    listener?.(new Error('stale utility host exited'))

    expect(clearRuntime).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it.each(CONTINUITY_GAPS)('keeps the same xterm through hide/show: $name', async ({ prefix, suffix, expected }) => {
    const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 100, allowProposedApi: true })
    const liveWindow = {
      hide: vi.fn(),
      renderer: {
        terminal,
        selection: { start: [2, 1], end: [7, 1] },
        scrollPosition: 3
      }
    }
    const lifecycle = lifecycleHarness({ hideWindow: liveWindow.hide })
    try {
      await write(liveWindow.renderer.terminal, prefix)

      const close = lifecycle.close()
      expect(close.preventDefault).toHaveBeenCalledOnce()
      expect(liveWindow.hide).toHaveBeenCalledOnce()
      expect(lifecycle.recoverRenderer).not.toHaveBeenCalled()

      await write(liveWindow.renderer.terminal, suffix)
      expect(liveWindow.renderer.selection).toEqual({ start: [2, 1], end: [7, 1] })
      expect(liveWindow.renderer.scrollPosition).toBe(3)
      expect([liveWindow.renderer.terminal.cols, liveWindow.renderer.terminal.rows]).toEqual([
        40,
        8
      ])
      expect(terminalState(liveWindow.renderer.terminal)).toEqual(expected)
    } finally {
      terminal.dispose()
    }
  })

  it('preserves alternate screen, dimensions, wrapping, modes, selection, and scroll position by hiding the live view', async () => {
    const terminal = new Terminal({ cols: 12, rows: 4, scrollback: 100, allowProposedApi: true })
    const liveWindow = {
      hide: vi.fn(),
      renderer: { terminal, selection: 'row 2: cols 3-8', scrollPosition: 17 }
    }
    const lifecycle = lifecycleHarness({ hideWindow: liveWindow.hide })
    try {
      await write(
        liveWindow.renderer.terminal,
        'normal\u001b[?1049h\u001b[?1h\u001b[?7l\u001b[2;3HALTERNATE'
      )
      const modes = { ...liveWindow.renderer.terminal.modes }

      const close = lifecycle.close()
      expect(close.preventDefault).toHaveBeenCalledOnce()
      expect(liveWindow.hide).toHaveBeenCalledOnce()
      await write(liveWindow.renderer.terminal, '!')

      expect(liveWindow.renderer.selection).toBe('row 2: cols 3-8')
      expect(liveWindow.renderer.scrollPosition).toBe(17)
      expect(liveWindow.renderer.terminal.buffer.active.type).toBe('alternate')
      expect([liveWindow.renderer.terminal.cols, liveWindow.renderer.terminal.rows]).toEqual([
        12,
        4
      ])
      expect(liveWindow.renderer.terminal.modes).toEqual(modes)
      expect(
        liveWindow.renderer.terminal.buffer.active.getLine(1)?.translateToString(true)
      ).toBe('  ALTERNATE!')
    } finally {
      terminal.dispose()
    }
  })

  it('reattaches a replacement renderer to the same session and forces repaint with a size bump', async () => {
    const calls: string[] = []
    const oldAttachment = {
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      attachmentId: 'old-attachment',
      streamSeq: 0 as const,
      captureStartedAt: '2026-09-13T10:00:00.000Z'
    }
    const session = { sessionId: 'session-1', incarnationId: 'incarnation-1' }
    const newAttachment = { ...oldAttachment, attachmentId: 'new-attachment' }
    const channel = { hostPort: { side: 'host' }, rendererPort: { side: 'renderer' } }

    const recovered = await recoverRendererView(
      {
        session,
        attachment: oldAttachment,
        dimensions: { cols: 80, rows: 24 }
      },
      {
        detach: async (attachmentId) => {
          calls.push(`detach:${attachmentId}`)
        },
        createChannel: () => {
          calls.push('create-channel')
          return channel
        },
        connectHostPort: (port) => {
          expect(port).toBe(channel.hostPort)
          calls.push('connect-host-port')
        },
        attach: async (session) => {
          expect(session).toEqual({ sessionId: 'session-1', incarnationId: 'incarnation-1' })
          calls.push('attach-existing-session')
          return newAttachment
        },
        resize: async (attachmentId, dimensions) => {
          calls.push(`resize:${attachmentId}:${dimensions.cols}x${dimensions.rows}`)
        },
        isMissingAttachment: () => false,
        closeRendererPort: vi.fn()
      }
    )

    expect(calls).toEqual([
      'detach:old-attachment',
      'create-channel',
      'connect-host-port',
      'attach-existing-session',
      'resize:new-attachment:81x24',
      'resize:new-attachment:80x24'
    ])
    expect(recovered).toEqual({ attachment: newAttachment, rendererPort: channel.rendererPort })
  })

  it('reattaches after the dead renderer lease has already expired', async () => {
    const missing = new Error('old attachment is gone')
    const attach = vi.fn(async () => ({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      attachmentId: 'replacement',
      streamSeq: 0 as const,
      captureStartedAt: '2026-09-13T10:00:00.000Z'
    }))

    await expect(
      recoverRendererView(
        {
          session: { sessionId: 'session-1', incarnationId: 'incarnation-1' },
          attachment: {
            sessionId: 'session-1',
            incarnationId: 'incarnation-1',
            attachmentId: 'expired',
            streamSeq: 0,
            captureStartedAt: '2026-09-13T10:00:00.000Z'
          },
          dimensions: { cols: 1_000, rows: 24 }
        },
        {
          detach: async () => Promise.reject(missing),
          createChannel: () => ({ hostPort: 'host', rendererPort: 'renderer' }),
          connectHostPort: () => undefined,
          attach,
          resize: async () => undefined,
          isMissingAttachment: (error) => error === missing,
          closeRendererPort: vi.fn()
        }
      )
    ).resolves.toMatchObject({ attachment: { attachmentId: 'replacement' } })
    expect(attach).toHaveBeenCalledOnce()
  })

  it('cleans up a replacement lease and port when its repaint fails', async () => {
    const repaintFailure = new Error('resize failed')
    const detach = vi
      .fn<(attachmentId: string) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
    const closeRendererPort = vi.fn()

    await expect(
      recoverRendererView(
        {
          session: { sessionId: 'session-1', incarnationId: 'incarnation-1' },
          attachment: {
            sessionId: 'session-1',
            incarnationId: 'incarnation-1',
            attachmentId: 'expired',
            streamSeq: 0,
            captureStartedAt: '2026-09-13T10:00:00.000Z'
          },
          dimensions: { cols: 80, rows: 24 }
        },
        {
          detach,
          createChannel: () => ({ hostPort: 'host', rendererPort: 'renderer' }),
          connectHostPort: () => undefined,
          attach: async () => ({
            sessionId: 'session-1',
            incarnationId: 'incarnation-1',
            attachmentId: 'replacement',
            streamSeq: 0,
            captureStartedAt: '2026-09-13T10:00:00.000Z'
          }),
          resize: async () => Promise.reject(repaintFailure),
          isMissingAttachment: () => false,
          closeRendererPort
        }
      )
    ).rejects.toBe(repaintFailure)
    expect(detach).toHaveBeenNthCalledWith(1, 'expired')
    expect(detach).toHaveBeenNthCalledWith(2, 'replacement')
    expect(closeRendererPort).toHaveBeenCalledWith('renderer')
  })

  it('recovers after a replacement renderer loads and reloads only after an abnormal loss', () => {
    const lifecycle = lifecycleHarness()

    lifecycle.didFinishLoad()
    expect(lifecycle.deliverStartup).toHaveBeenCalledOnce()
    expect(lifecycle.recoverRenderer).not.toHaveBeenCalled()

    lifecycle.didFinishLoad()
    expect(lifecycle.deliverStartup).toHaveBeenCalledOnce()
    expect(lifecycle.recoverRenderer).toHaveBeenCalledOnce()

    lifecycle.rendererGone('clean-exit')
    expect(lifecycle.reloadRenderer).not.toHaveBeenCalled()
    lifecycle.rendererGone('crashed')
    expect(lifecycle.reloadRenderer).toHaveBeenCalledOnce()
  })

  it('composes renderer recovery from attach-existing-session operations without spawning', async () => {
    const calls: string[] = []
    const oldAttachment = {
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      attachmentId: 'old-attachment',
      streamSeq: 0 as const,
      captureStartedAt: '2026-09-13T10:00:00.000Z'
    }
    const replacement = { ...oldAttachment, attachmentId: 'replacement' }
    const client = {
      async request<Result>(method: ProtocolMethod, params: object): Promise<Result> {
        if (method === METHOD_REGISTRY.sessionCreate) throw new Error('spawn must not be reachable')
        if (method === METHOD_REGISTRY.terminalDetach) {
          calls.push(`detach:${(params as { attachmentId: string }).attachmentId}`)
          return { detached: true } as Result
        }
        if (method === METHOD_REGISTRY.terminalAttach) {
          const session = params as { sessionId: string; incarnationId: string }
          calls.push(`attach:${session.sessionId}:${session.incarnationId}`)
          return replacement as Result
        }
        const resize = params as { attachmentId: string; cols: number; rows: number }
        calls.push(`resize:${resize.attachmentId}:${resize.cols}x${resize.rows}`)
        return { cols: resize.cols, rows: resize.rows } as Result
      },
      attachTerminalPort: (port: { side: string }) => {
        expect(port.side).toBe('host')
        calls.push('connect-host-port')
      }
    }

    const recovered = await recoverExistingSessionRenderer(
      {
        client,
        session: { sessionId: 'session-1', incarnationId: 'incarnation-1' },
        attachment: oldAttachment,
        dimensions: { cols: 80, rows: 24 }
      },
      {
        createChannel: () => ({
          hostPort: { side: 'host' },
          rendererPort: { side: 'renderer' }
        }),
        isMissingAttachment: () => false,
        closeRendererPort: vi.fn()
      }
    )

    expect(calls).toEqual([
      'detach:old-attachment',
      'connect-host-port',
      'attach:session-1:incarnation-1',
      'resize:replacement:81x24',
      'resize:replacement:80x24'
    ])
    expect(recovered.attachment).toEqual(replacement)
  })

  it('recovers a registry through one replacement renderer port without spawning', async () => {
    const hostPorts: string[] = []
    const request = vi.fn(async (method: ProtocolMethod, params: object) => {
      if (method === METHOD_REGISTRY.sessionCreate) throw new Error('spawn must not be reachable')
      if (method === METHOD_REGISTRY.terminalAttach) {
        const identity = params as { sessionId: string; incarnationId: string }
        return { ...identity, attachmentId: `new-${identity.sessionId}`, streamSeq: 0, captureStartedAt: '2026-09-13T10:00:00Z' }
      }
      return params
    })
    const client = {
      request: request as <Result>(method: ProtocolMethod, params: object) => Promise<Result>,
      attachTerminalPort: (port: string) => hostPorts.push(port)
    }
    const runtimes = ['a', 'b'].map((sessionId) => ({
      client,
      session: { sessionId, incarnationId: `inc-${sessionId}` },
      attachment: {
        sessionId,
        incarnationId: `inc-${sessionId}`,
        attachmentId: `old-${sessionId}`,
        streamSeq: 0 as const,
        captureStartedAt: '2026-09-13T09:00:00Z'
      },
      dimensions: { cols: 80, rows: 24 }
    }))

    const recovered = await recoverExistingSessionRenderers(runtimes, {
      createChannel: () => ({ hostPort: 'one-host-port', rendererPort: 'one-renderer-port' }),
      isMissingAttachment: () => false,
      closeRendererPort: vi.fn(),
      isGone: () => false
    })

    expect(hostPorts).toEqual(['one-host-port'])
    expect(recovered.rendererPort).toBe('one-renderer-port')
    expect(recovered.attachments.map((item) => item.sessionId)).toEqual(['a', 'b'])
    expect(request.mock.calls.some(([method]) => method === METHOD_REGISTRY.sessionCreate)).toBe(false)
  })

  it.each([
    { stage: 'detaching its expired lease', failingMethod: METHOD_REGISTRY.terminalDetach },
    { stage: 'repainting its replacement lease', failingMethod: METHOD_REGISTRY.terminalResize }
  ])(
    'disposes earlier replacement leases and the shared port once when a later session fails $stage',
    async ({ failingMethod }) => {
      const failure = new Error('host refused session b')
      const hostPorts: string[] = []
      const request = vi.fn(async (method: ProtocolMethod, params: object) => {
        const target = params as { sessionId?: string; attachmentId?: string }
        const belongsToB = target.sessionId === 'b' || target.attachmentId?.endsWith('-b') === true
        if (method === failingMethod && belongsToB) throw failure
        if (method === METHOD_REGISTRY.terminalAttach) {
          const identity = params as { sessionId: string; incarnationId: string }
          return { ...identity, attachmentId: `new-${identity.sessionId}`, streamSeq: 0, captureStartedAt: '2026-09-13T10:00:00Z' }
        }
        return params
      })
      const client = {
        request: request as <Result>(method: ProtocolMethod, params: object) => Promise<Result>,
        attachTerminalPort: (port: string) => hostPorts.push(port)
      }
      const runtimes = ['a', 'b', 'c'].map((sessionId) => ({
        client,
        session: { sessionId, incarnationId: `inc-${sessionId}` },
        attachment: {
          sessionId,
          incarnationId: `inc-${sessionId}`,
          attachmentId: `old-${sessionId}`,
          streamSeq: 0 as const,
          captureStartedAt: '2026-09-13T09:00:00Z'
        },
        dimensions: { cols: 80, rows: 24 }
      }))
      const closeRendererPort = vi.fn()

      await expect(
        recoverExistingSessionRenderers(runtimes, {
          createChannel: () => ({ hostPort: 'one-host-port', rendererPort: 'one-renderer-port' }),
          isMissingAttachment: () => false,
          closeRendererPort,
          isGone: () => false
        })
      ).rejects.toBe(failure)

      const detached = request.mock.calls
        .filter(([method]) => method === METHOD_REGISTRY.terminalDetach)
        .map(([, params]) => (params as { attachmentId: string }).attachmentId)
      expect(detached).toContain('new-a')
      expect(detached).not.toContain('old-c')
      expect(hostPorts).toEqual(['one-host-port'])
      expect(closeRendererPort).toHaveBeenCalledTimes(1)
      expect(closeRendererPort).toHaveBeenCalledWith('one-renderer-port')
    }
  )

  it.each([
    { proof: 'the host reported its exit', provenGone: true },
    { proof: 'nothing proves it gone', provenGone: false }
  ])(
    'skips a session that ended before recovery and tolerates a missing reattach only when $proof',
    async ({ provenGone }) => {
      const missing = { protocolError: { data: { code: ERROR_CODES.notFound } } }
      const ended = new Set(['b'])
      const hostPorts: string[] = []
      const request = vi.fn(async (method: ProtocolMethod, params: object) => {
        const identity = params as { sessionId: string; incarnationId: string }
        if (method === METHOD_REGISTRY.terminalAttach) {
          if (identity.sessionId === 'c') {
            // Session c's shell exits while recovery runs: its attach answers after the exit report.
            if (provenGone) ended.add('c')
            throw missing
          }
          return { ...identity, attachmentId: `new-${identity.sessionId}`, streamSeq: 0, captureStartedAt: '2026-09-13T10:00:00Z' }
        }
        return params
      })
      const client = {
        request: request as <Result>(method: ProtocolMethod, params: object) => Promise<Result>,
        attachTerminalPort: (port: string) => hostPorts.push(port)
      }
      const runtimes = ['a', 'b', 'c', 'd'].map((sessionId) => ({
        client,
        session: { sessionId, incarnationId: `inc-${sessionId}` },
        attachment: {
          sessionId,
          incarnationId: `inc-${sessionId}`,
          attachmentId: `old-${sessionId}`,
          streamSeq: 0 as const,
          captureStartedAt: '2026-09-13T09:00:00Z'
        },
        dimensions: { cols: 80, rows: 24 }
      }))
      const closeRendererPort = vi.fn()
      const recovery = recoverExistingSessionRenderers(runtimes, {
        createChannel: () => ({ hostPort: 'one-host-port', rendererPort: 'one-renderer-port' }),
        isMissingAttachment: (error) => error === missing,
        closeRendererPort,
        isGone: (runtime) => ended.has(runtime.session.sessionId)
      })

      if (!provenGone) {
        await expect(recovery).rejects.toBe(missing)
        expect(closeRendererPort).toHaveBeenCalledOnce()
        return
      }
      const recovered = await recovery
      const attached = request.mock.calls
        .filter(([method]) => method === METHOD_REGISTRY.terminalAttach)
        .map(([, params]) => (params as { sessionId: string }).sessionId)
      expect(attached).toEqual(['a', 'c', 'd'])
      expect(recovered.attachments.map((item) => item.sessionId)).toEqual(['a', 'd'])
      expect(recovered.gone.map((runtime) => runtime.session.sessionId)).toEqual(['b', 'c'])
      expect(recovered.rendererPort).toBe('one-renderer-port')
      expect(hostPorts).toEqual(['one-host-port'])
      expect(closeRendererPort).not.toHaveBeenCalled()
    }
  )

  it('keeps the replacement port connected when every snapshot session has ended', async () => {
    const hostPorts: string[] = []
    const request = vi.fn(async () => {
      throw new Error('an ended session must not be reattached')
    })
    const client = {
      request: request as <Result>(method: ProtocolMethod, params: object) => Promise<Result>,
      attachTerminalPort: (port: string) => hostPorts.push(port)
    }
    const ended = {
      client,
      session: { sessionId: 'a', incarnationId: 'inc-a' },
      attachment: {
        sessionId: 'a',
        incarnationId: 'inc-a',
        attachmentId: 'old-a',
        streamSeq: 0 as const,
        captureStartedAt: '2026-09-13T09:00:00Z'
      },
      dimensions: { cols: 80, rows: 24 }
    }

    const recovered = await recoverExistingSessionRenderers([ended], {
      createChannel: () => ({ hostPort: 'one-host-port', rendererPort: 'one-renderer-port' }),
      isMissingAttachment: () => false,
      closeRendererPort: vi.fn(),
      isGone: () => true
    })

    expect(request).not.toHaveBeenCalled()
    expect(recovered).toEqual({ attachments: [], gone: [ended], rendererPort: 'one-renderer-port' })
    expect(hostPorts).toEqual(['one-host-port'])
  })

  it('schedules a fresh renderer for bounded-queue and sequence failures', () => {
    const reload = vi.fn()
    const scheduled: Array<() => void> = []
    const view = { isDestroyed: () => false, reload }

    expect(
      scheduleTerminalViewRecovery('output-overflow', view, (operation) => scheduled.push(operation))
    ).toEqual({ recovering: true })
    expect(reload).not.toHaveBeenCalled()
    scheduled[0]?.()
    expect(reload).toHaveBeenCalledOnce()
    expect(() => scheduleTerminalViewRecovery('invalid', view)).toThrow(
      'Terminal recovery reason is invalid'
    )
  })

})

const RUNNING_TARGET: RunningSessionTarget = {
  sessionId: 'session-1',
  incarnationId: 'incarnation-1',
  executable: '/usr/bin/claude',
  processState: 'live'
}

/** Every unset target answered the same way, the shape the native fallback still produces. */
function everyTarget(
  targets: readonly RunningSessionTarget[],
  choice: 'hide' | 'stop'
): CloseDecision {
  return {
    kind: 'proceed',
    choices: Object.fromEntries(targets.map((target) => [target.sessionId, choice])),
    remember: true
  }
}

function applicationLifecycleHarness(options: {
  targets?: RunningSessionTarget[]
  closeResponse?: (prompt: CloseChoicePrompt) => CloseDecision
  quitResponse?: 'quit' | 'cancel'
  captureOutcome?: SavedOutputCaptureOutcome
} = {}) {
  const state = {
    targets: options.targets ?? [{ ...RUNNING_TARGET }]
  }
  const saveBackgroundChoice = vi.fn((decisions: readonly BackgroundChoiceDecision[]) => {
    for (const decision of decisions) decision.target.backgroundChoice = decision.choice
  })
  const promptForClose = vi.fn(async (prompt: CloseChoicePrompt) =>
    options.closeResponse ? options.closeResponse(prompt) : everyTarget(prompt.targets, 'hide')
  )
  const promptForQuit = vi.fn(async () => options.quitResponse ?? ('cancel' as const))
  const stopTargets = vi.fn(async (
    targets: readonly RunningSessionTarget[],
    cause: SessionStopCause
  ) => {
    void cause
    state.targets = state.targets.filter(
      (current) =>
        !targets.some(
          (target) =>
            target.sessionId === current.sessionId &&
            target.incarnationId === current.incarnationId
        )
    )
  })
  const flushSavedOutput = vi.fn(async () =>
    options.captureOutcome ?? { status: 'saved' as const }
  )
  const hideWindow = vi.fn()
  const quitApplication = vi.fn()
  const restartForUpdate = vi.fn()
  const reportFailure = vi.fn()
  const lifecycle = createApplicationLifecycle({
    runningTargets: () => state.targets,
    saveBackgroundChoice,
    promptForClose,
    promptForQuit,
    flushSavedOutput,
    stopTargets,
    hideWindow,
    quitApplication,
    restartForUpdate,
    reportFailure
  })
  return {
    lifecycle,
    state,
    saveBackgroundChoice,
    promptForClose,
    promptForQuit,
    flushSavedOutput,
    stopTargets,
    hideWindow,
    quitApplication,
    restartForUpdate,
    reportFailure
  }
}

function preventableEvent() {
  return { preventDefault: vi.fn() }
}

describe('Story 1.4 application lifecycle', () => {
  it('completes quit after a destroyed startup-failure window', async () => {
    const destroyedWindow = {
      isDestroyed: () => true,
      get webContents(): never {
        throw new Error('Object has been destroyed')
      }
    }
    const quitApplication = vi.fn()
    const lifecycle = createApplicationLifecycle({
      runningTargets: () => [],
      saveBackgroundChoice: vi.fn(),
      promptForClose: vi.fn(async () => ({ kind: 'cancel' }) as const),
      promptForQuit: vi.fn(async () => 'cancel' as const),
      flushSavedOutput: () => captureSavedOutputForLifecycle(
        undefined,
        captureWebContents(false, destroyedWindow),
        undefined
      ),
      stopTargets: vi.fn(async () => undefined),
      hideWindow: vi.fn(),
      quitApplication,
      restartForUpdate: vi.fn(),
      reportFailure: vi.fn()
    })

    lifecycle.beforeQuit(preventableEvent())

    await vi.waitFor(() => expect(quitApplication).toHaveBeenCalledOnce())
  })

  it('projects only utility-reported live or exit-unconfirmed incarnations as running', () => {
    expect(runningTargetForRuntime(RUNNING_TARGET)).toEqual(RUNNING_TARGET)
    expect(runningTargetForRuntime({ ...RUNNING_TARGET, processState: 'exit-unconfirmed' })).toMatchObject({
      processState: 'exit-unconfirmed'
    })
    expect(runningTargetForRuntime({ ...RUNNING_TARGET, processState: 'exited' })).toBeUndefined()
  })

  it.each(['native Stop', 'native Quit'] as const)(
    'flushes pending terminal output before %s stops the process',
    async (action) => {
      let liveBuffer = 'older\npending output'
      let savedResult = ''
      const quitApplication = vi.fn()
      const lifecycle = createApplicationLifecycle({
        runningTargets: () => [
          ...(action === 'native Stop'
            ? [{ ...RUNNING_TARGET, backgroundChoice: 'stop' as const }]
            : [RUNNING_TARGET])
        ],
        saveBackgroundChoice: vi.fn(),
        promptForClose: vi.fn(async (prompt: CloseChoicePrompt) => everyTarget(prompt.targets, 'stop')),
        promptForQuit: vi.fn(async () => 'quit' as const),
        flushSavedOutput: async () => {
          savedResult = liveBuffer
          return { status: 'saved' }
        },
        stopTargets: async () => {
          liveBuffer = ''
        },
        hideWindow: vi.fn(),
        quitApplication,
        restartForUpdate: vi.fn(),
        reportFailure: vi.fn()
      })

      if (action === 'native Stop') lifecycle.closeLastWindow(preventableEvent())
      else lifecycle.beforeQuit(preventableEvent())
      await vi.waitFor(() => expect(quitApplication).toHaveBeenCalledOnce())

      expect(savedResult).toContain('pending output')
      expect(liveBuffer).toBe('')
    }
  )

  it('freezes the toolbar Stop target before waiting for final capture', async () => {
    let releaseCapture: (() => void) | undefined
    const first = { ...RUNNING_TARGET }
    const replacement = {
      ...RUNNING_TARGET,
      incarnationId: 'incarnation-2'
    }
    let targets = [first]
    const stopTargets = vi.fn(async () => undefined)
    const lifecycle = createApplicationLifecycle({
      runningTargets: () => targets,
      saveBackgroundChoice: vi.fn(),
      promptForClose: vi.fn(async () => ({ kind: 'cancel' }) as const),
      promptForQuit: vi.fn(async () => 'cancel' as const),
      flushSavedOutput: () => new Promise((resolve) => {
        releaseCapture = () => resolve({ status: 'saved' })
      }),
      stopTargets,
      hideWindow: vi.fn(),
      quitApplication: vi.fn(),
      restartForUpdate: vi.fn(),
      reportFailure: vi.fn()
    })

    const stopping = lifecycle.stopCurrentTarget()
    targets = [replacement]
    releaseCapture?.()
    await stopping

    expect(stopTargets).toHaveBeenCalledWith([first], 'explicit')
  })
  it('disposes and unlatches after both missing-target and genuine stop failures', async () => {
    const stopHarness = (code: string) => {
      let stopInProgress = false
      const events: string[] = []
      const error = {
        protocolError: { data: { code } }
      }
      const result = stopAndDisposeCurrentTarget({
        setStopInProgress: (inProgress) => {
          stopInProgress = inProgress
          events.push(`stop-in-progress:${inProgress}`)
        },
        requestStop: async () => {
          events.push(`request:${stopInProgress}`)
          throw error
        },
        dispose: async () => {
          events.push(`dispose:${stopInProgress}`)
        },
        clearCurrent: () => {
          events.push(`clear:${stopInProgress}`)
        }
      })
      return { error, events, result, stopInProgress: () => stopInProgress }
    }

    const alreadyStopped = stopHarness(ERROR_CODES.notFound)
    await expect(alreadyStopped.result).resolves.toBeUndefined()
    expect(alreadyStopped.events).toEqual([
      'stop-in-progress:true',
      'request:true',
      'dispose:true',
      'clear:true',
      'stop-in-progress:false'
    ])
    expect(alreadyStopped.stopInProgress()).toBe(false)

    const unknownOutcome = stopHarness(ERROR_CODES.ioError)
    await expect(unknownOutcome.result).rejects.toBe(unknownOutcome.error)
    expect(unknownOutcome.events).toEqual(alreadyStopped.events)
    expect(unknownOutcome.stopInProgress()).toBe(false)
  })

  it('routes the real window-close seam through the Story 1.4 lifecycle coordinator', async () => {
    const application = applicationLifecycleHarness({
      targets: [{ ...RUNNING_TARGET, backgroundChoice: 'hide' }]
    })
    const windowLifecycle = lifecycleHarness({
      handleClose: (event) => application.lifecycle.closeLastWindow(event)
    })

    const close = windowLifecycle.close()

    expect(close.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(application.hideWindow).toHaveBeenCalledOnce())
    expect(application.hideWindow).toHaveBeenCalledOnce()
  })

  it('applies a saved Hide choice on last-window close without prompting', async () => {
    const harness = applicationLifecycleHarness({
      targets: [{ ...RUNNING_TARGET, backgroundChoice: 'hide' }]
    })
    const event = preventableEvent()

    harness.lifecycle.closeLastWindow(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(harness.hideWindow).toHaveBeenCalledOnce())
    expect(harness.promptForClose).not.toHaveBeenCalled()
    expect(harness.stopTargets).not.toHaveBeenCalled()
    expect(harness.hideWindow).toHaveBeenCalledOnce()
    expect(harness.quitApplication).not.toHaveBeenCalled()
    expect(harness.flushSavedOutput).not.toHaveBeenCalled()
  })

  it('applies a saved Stop choice to the exact current incarnation without prompting', async () => {
    const target = { ...RUNNING_TARGET, backgroundChoice: 'stop' as const }
    const harness = applicationLifecycleHarness({ targets: [target] })

    harness.lifecycle.closeLastWindow(preventableEvent())

    await vi.waitFor(() => expect(harness.quitApplication).toHaveBeenCalledOnce())
    expect(harness.promptForClose).not.toHaveBeenCalled()
    expect(harness.stopTargets).toHaveBeenCalledWith([target], 'close-last-window')
    expect(harness.flushSavedOutput.mock.invocationCallOrder[0]).toBeLessThan(
      harness.stopTargets.mock.invocationCallOrder[0]!
    )
    expect(harness.hideWindow).not.toHaveBeenCalled()
    const approvedClose = preventableEvent()
    harness.lifecycle.closeLastWindow(approvedClose)
    expect(approvedClose.preventDefault).not.toHaveBeenCalled()
  })

  it('offers Hide, Stop, and Cancel for unset choices and names every exact target', async () => {
    const second = {
      sessionId: 'session-2',
      incarnationId: 'incarnation-2',
      executable: '/usr/bin/codex',
      processState: 'live' as const
    }
    const harness = applicationLifecycleHarness({
      targets: [{ ...RUNNING_TARGET }, second]
    })

    harness.lifecycle.closeLastWindow(preventableEvent())

    await vi.waitFor(() => expect(harness.hideWindow).toHaveBeenCalledOnce())
    expect(harness.promptForClose).toHaveBeenCalledWith({
      message: 'Close the last window?',
      detail:
        'Choose what to do with these running targets:\n\n' +
        'Session: session-1\nProcess: /usr/bin/claude\nIncarnation: incarnation-1\nState: live\n\n' +
        'Session: session-2\nProcess: /usr/bin/codex\nIncarnation: incarnation-2\nState: live',
      buttons: ['Minimize (keep running)', 'Stop', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      targets: [expect.objectContaining({ sessionId: 'session-1' }), second]
    })
    expect(harness.saveBackgroundChoice).toHaveBeenCalledWith([
      { target: expect.objectContaining({ sessionId: 'session-1' }), choice: 'hide' },
      { target: second, choice: 'hide' }
    ])
    expect(harness.state.targets).toHaveLength(2)
    expect(harness.stopTargets).not.toHaveBeenCalled()
  })

  it('keeps the sessions the owner kept and stops only the ones they marked', async () => {
    const second = {
      sessionId: 'session-2',
      incarnationId: 'incarnation-2',
      executable: '/usr/bin/codex',
      processState: 'live' as const
    }
    const harness = applicationLifecycleHarness({
      targets: [{ ...RUNNING_TARGET }, second],
      closeResponse: () => ({
        kind: 'proceed',
        choices: { 'session-2': 'stop' },
        remember: false
      })
    })

    harness.lifecycle.closeLastWindow(preventableEvent())

    await vi.waitFor(() => expect(harness.hideWindow).toHaveBeenCalledOnce())
    // An unmentioned session is kept, never stopped by omission.
    expect(harness.stopTargets).toHaveBeenCalledWith([second], 'close-last-window')
    expect(harness.flushSavedOutput).toHaveBeenCalledWith([second])
    expect(harness.saveBackgroundChoice).not.toHaveBeenCalled()
    expect(harness.quitApplication).not.toHaveBeenCalled()
  })

  it('stops every session and quits when the owner stopped them all', async () => {
    const harness = applicationLifecycleHarness({
      closeResponse: (prompt) => everyTarget(prompt.targets, 'stop')
    })

    harness.lifecycle.closeLastWindow(preventableEvent())

    await vi.waitFor(() => expect(harness.quitApplication).toHaveBeenCalledOnce())
    expect(harness.stopTargets).toHaveBeenCalledWith(
      [expect.objectContaining({ sessionId: 'session-1', backgroundChoice: 'stop' })],
      'close-last-window'
    )
    expect(harness.hideWindow).not.toHaveBeenCalled()
  })

  it('treats Cancel as a genuine no-op and leaves every process running', async () => {
    const harness = applicationLifecycleHarness({ closeResponse: () => ({ kind: 'cancel' }) })

    harness.lifecycle.closeLastWindow(preventableEvent())

    await vi.waitFor(() => expect(harness.promptForClose).toHaveBeenCalledOnce())
    expect(harness.state.targets).toEqual([RUNNING_TARGET])
    expect(harness.saveBackgroundChoice).not.toHaveBeenCalled()
    expect(harness.stopTargets).not.toHaveBeenCalled()
    expect(harness.hideWindow).not.toHaveBeenCalled()
    expect(harness.quitApplication).not.toHaveBeenCalled()
    expect(harness.flushSavedOutput).not.toHaveBeenCalled()
  })

  it.each(['native Stop', 'native Quit'] as const)(
    'completes %s after unavailable capture has been durably disclosed',
    async (action) => {
    const harness = applicationLifecycleHarness({
      targets: [{ ...RUNNING_TARGET, backgroundChoice: 'stop' }],
      quitResponse: 'quit',
      captureOutcome: {
        status: 'unavailable',
        reason: 'no-renderer',
        detail: 'durable final-capture disclosure recorded'
      }
    })

      if (action === 'native Stop') harness.lifecycle.closeLastWindow(preventableEvent())
      else harness.lifecycle.beforeQuit(preventableEvent())

      await vi.waitFor(() => expect(harness.quitApplication).toHaveBeenCalledOnce())
      expect(harness.flushSavedOutput).toHaveBeenCalledOnce()
      expect(harness.stopTargets).toHaveBeenCalledWith([
        expect.objectContaining({ sessionId: 'session-1', incarnationId: 'incarnation-1' })
      ], action === 'native Stop' ? 'close-last-window' : 'application-quit')
      expect(harness.reportFailure).not.toHaveBeenCalled()
    }
  )

  it('shows a hidden primary window for a second launch and prevents duplicate startup', () => {
    let notifyPrimary: (() => void) | undefined
    const hiddenWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }
    const primary = {
      setPath: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((_event: 'second-instance', listener: () => void) => {
        notifyPrimary = listener
      }),
      quit: vi.fn()
    }
    const secondary = {
      setPath: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      quit: vi.fn()
    }
    const duplicateStartup = vi.fn()

    expect(
      acquireRootScopedSingleInstance(primary, '/data/root', () => focusExistingWindow(hiddenWindow))
    ).toBe(true)
    if (acquireRootScopedSingleInstance(secondary, '/data/root', () => undefined)) {
      duplicateStartup()
    }
    notifyPrimary?.()

    expect(secondary.quit).toHaveBeenCalledOnce()
    expect(duplicateStartup).not.toHaveBeenCalled()
    expect(hiddenWindow.show).toHaveBeenCalledOnce()
    expect(hiddenWindow.focus).toHaveBeenCalledOnce()
  })

  it('lists exact running targets and asks Quit or Cancel before quitting', async () => {
    const harness = applicationLifecycleHarness({ quitResponse: 'quit' })
    const event = preventableEvent()

    harness.lifecycle.beforeQuit(event)

    await vi.waitFor(() => expect(harness.quitApplication).toHaveBeenCalledOnce())
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(harness.promptForQuit).toHaveBeenCalledWith({
      message: 'Quit BMN and stop the running sessions?',
      detail:
        'Quit applies to these running targets:\n\n' +
        'Session: session-1\nProcess: /usr/bin/claude\nIncarnation: incarnation-1\nState: live',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      targets: [RUNNING_TARGET]
    })
    expect(harness.stopTargets).toHaveBeenCalledWith([RUNNING_TARGET], 'application-quit')
    expect(harness.flushSavedOutput.mock.invocationCallOrder[0]).toBeLessThan(
      harness.stopTargets.mock.invocationCallOrder[0]!
    )
  })

  it('does not restart for an update while any session is running', () => {
    const harness = applicationLifecycleHarness()

    harness.lifecycle.updateDownloaded()

    expect(harness.restartForUpdate).not.toHaveBeenCalled()
    expect(harness.state.targets).toEqual([RUNNING_TARGET])
  })

  it('flushes and restarts exactly once for a downloaded update when no session is running', async () => {
    const harness = applicationLifecycleHarness({ targets: [] })

    harness.lifecycle.updateDownloaded()

    await vi.waitFor(() => expect(harness.restartForUpdate).toHaveBeenCalledOnce())
    expect(harness.flushSavedOutput).toHaveBeenCalledOnce()
    expect(harness.stopTargets).toHaveBeenCalledWith([], 'update-restart')
    expect(harness.restartForUpdate).toHaveBeenCalledOnce()
  })
})

describe('adopting the attachment a start reports', () => {
  it('adopts a start that names an incarnation this window is not running', () => {
    expect(adoptsStartedAttachment(undefined, { incarnationId: 'incarnation-1' })).toBe(true)
    expect(adoptsStartedAttachment({ incarnationId: 'incarnation-1' }, { incarnationId: 'incarnation-2' }))
      .toBe(true)
  })

  /**
   * A retried cohort action replays the recorded start. Its attachment was revoked when the
   * renderer recovered that same incarnation, so putting it back would leave the pane writing to
   * a lease the host no longer honours.
   */
  it('keeps the current attachment when the start replays an incarnation already adopted', () => {
    expect(adoptsStartedAttachment({ incarnationId: 'incarnation-1' }, { incarnationId: 'incarnation-1' }))
      .toBe(false)
  })
})
