import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORKSPACE_MARKER,
  WORKSPACE_MARKERS,
  APP_EVENT_TOPICS,
  DEFAULT_APP_SETTINGS,
  isAppEventMessage,
  ERROR_CODES,
  FrameDecoder,
  MalformedFrameError,
  FrameTooLargeError,
  MAX_CONTROL_FRAME_BYTES,
  MAX_TERMINAL_CHUNK_BYTES,
  METHOD_REGISTRY,
  PROTOCOL_VERSION,
  RESTORED_VIEW_NOTICE,
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_PARSER_ATOM_BYTES,
  TERMINAL_ACKNOWLEDGEMENT_DEADLINE_MS,
  TERMINAL_UNDELIVERED_OUTPUT_BYTES,
  TERMINAL_SAVED_OUTPUT_BYTES,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  TERMINAL_SCROLLBACK_LINES,
  TruncatedFrameError,
  encodeFrame,
  isCompatibleProtocol,
  isRpcEnvelope,
  isLaunchTemplateRecord,
  isSessionCreateParams,
  isSessionRecord,
  isSessionStopParams,
  isSessionUpdateParams,
  isTemplateCreateParams,
  isTerminalByteMessage,
  isTerminalExitMessage,
  isTerminalViewDisconnectedMessage,
  isSessionProcessStateChangedMessage,
  isWorkspaceCreateParams,
  isWorkspaceLayoutState,
  isWorkspaceMarker,
  isWorkspaceRecord,
  isWorkspaceUpdateParams,
  emptyWorkspaceLayout,
  type RpcRequest
} from './index'

const hello: RpcRequest = {
  jsonrpc: '2.0',
  id: 'hello-1',
  method: METHOD_REGISTRY.hello,
  params: {
    protocol: PROTOCOL_VERSION,
    clientVersion: '0.1.0',
    instanceId: 'test-instance'
  }
}

describe('protocol surface', () => {
  it('uses Black for new or missing appearance settings', () => {
    expect(DEFAULT_APP_SETTINGS.appearance).toEqual({
      identity: 'knight',
      colorMode: 'black',
      terminalFontSize: 14
    })
  })

  it('exports the exact shell, saved-output, conversation-resume and companion method set', () => {
    expect(new Set(Object.values(METHOD_REGISTRY))).toEqual(
      new Set([
        'hello',
        'health.get',
        'workspace.list',
        'workspace.create',
        'workspace.update',
        'session.create',
        'session.list',
        'session.update',
        'session.binding.get',
        'session.binding.replace',
        'session.binding.clear',
        'session.relaunch',
        'session.resume',
        'session.resume.preview',
        'session.stop',
        'session.cohort.list',
        'session.cohort.offered',
        'session.cohort.resume',
        'template.list',
        'template.create',
        'layout.get',
        'layout.put',
        'terminal.attach',
        'terminal.activate',
        'terminal.write',
        'terminal.resize',
        'terminal.detach',
        'terminal.snapshot.save',
        'terminal.savedOutput.finalCaptureUnavailable',
        'terminal.savedOutput.get',
        'artifact.list',
        'artifact.import',
        'artifact.importBytes',
        'artifact.saveAs',
        'artifact.preview',
        'artifact.deliver',
        'file.reference.read',
        'attention.list',
        'attention.seen',
        'attention.resolve',
        'attention.terminalNotice',
        'hookEvents.list',
        'progress.list',
        'draft.list',
        'draft.save',
        'draft.retry',
        'draft.send',
        'draft.discard',
        'settings.get',
        'settings.put',
        'backup.export',
        'backup.verify',
        'telegram.configure',
        'telegram.status',
        'telegram.test',
        'control.info',
        'presence.set'
      ])
    )
    expect(Object.values(METHOD_REGISTRY)).toHaveLength(57)
  })

  it('exports the initial stable error codes', () => {
    expect(new Set(Object.values(ERROR_CODES))).toEqual(
      new Set([
        'UNAUTHORIZED',
        'INVALID_ARGUMENT',
        'NOT_FOUND',
        'REVISION_CONFLICT',
        'IO_ERROR',
        'PROTOCOL_MISMATCH'
      ])
    )
  })

  it('rejects invalid names, positions, and missing revisions', () => {
    expect(isWorkspaceCreateParams({ name: '' })).toBe(false)
    expect(isWorkspaceCreateParams({ name: 'Personal', position: 1.5 })).toBe(false)
    expect(isWorkspaceUpdateParams({ workspaceId: 'workspace-1', name: 'Renamed' })).toBe(false)
    expect(isSessionUpdateParams({
      sessionId: 'session-1',
      expectedRevision: 1,
      position: -1
    })).toBe(false)
    expect(isSessionStopParams({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      cause: 'application-quit'
    })).toBe(true)
    expect(isSessionStopParams({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      cause: 'application-quit',
      signal: 15
    })).toBe(false)
    expect(isSessionStopParams({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      cause: 'unknown'
    })).toBe(false)
    expect(isSessionUpdateParams({
      sessionId: 'session-1',
      expectedRevision: 1,
      cwd: '/workspace',
      executable: '/bin/bash',
      argv: ['--noprofile']
    })).toBe(true)
    expect(isSessionUpdateParams({
      sessionId: 'session-1',
      expectedRevision: 1,
      argv: ['okay', 2]
    })).toBe(false)
    expect(isSessionUpdateParams({ sessionId: 'session-1', expectedRevision: 1, archived: true })).toBe(true)
    expect(isSessionUpdateParams({ sessionId: 'session-1', expectedRevision: 1, archived: 'yes' })).toBe(false)
  })

  it('owns layout validity including pane uniqueness and selected membership', () => {
    const valid = {
      workspaceId: 'workspace-1',
      selectedSessionId: 'session-1',
      split: {
        orientation: 'side-by-side',
        panes: [{ sessionId: 'session-1', ratio: 1 }]
      },
      sessionView: {
        'session-1': { scrollLine: 12, followTail: false }
      },
      revision: 1
    } as const
    expect(isWorkspaceLayoutState(valid, ['session-1', 'session-2'])).toBe(true)
    expect(isWorkspaceLayoutState({
      ...valid,
      split: {
        ...valid.split,
        panes: [
          { sessionId: 'session-1', ratio: 0.5 },
          { sessionId: 'session-1', ratio: 0.5 }
        ]
      }
    }, ['session-1', 'session-2'])).toBe(false)
    expect(isWorkspaceLayoutState({
      ...valid,
      selectedSessionId: 'session-2'
    }, ['session-1', 'session-2'])).toBe(false)
  })

  const closedLayout = {
    workspaceId: 'workspace-1',
    selectedSessionId: 'session-1',
    split: {
      orientation: 'side-by-side',
      panes: [{ sessionId: 'session-1', ratio: 1 }]
    },
    sessionView: {
      'session-1': { scrollLine: 12, followTail: false }
    },
    revision: 1
  }
  const layoutSessions = ['session-1', 'session-2']

  it.each([
    ['root orderedSessionIds', { ...closedLayout, orderedSessionIds: ['session-1'] }],
    ['root sessionOrder', { ...closedLayout, sessionOrder: ['session-1'] }],
    ['split.collapsed', { ...closedLayout, split: { ...closedLayout.split, collapsed: true } }],
    ['pane pinned', {
      ...closedLayout,
      split: { ...closedLayout.split, panes: [{ sessionId: 'session-1', ratio: 1, pinned: true }] }
    }],
    ['view pinnedLine', {
      ...closedLayout,
      sessionView: { 'session-1': { scrollLine: 12, followTail: false, pinnedLine: 4 } }
    }]
  ])('closes the layout shape: rejects unknown key %s', (_level, candidate) => {
    expect(isWorkspaceLayoutState(closedLayout, layoutSessions)).toBe(true)
    expect(isWorkspaceLayoutState(candidate, layoutSessions)).toBe(false)
  })

  it('rejects a layout missing a required key at any level', () => {
    const noView = Object.fromEntries(Object.entries(closedLayout).filter(([key]) => key !== 'sessionView'))
    expect(isWorkspaceLayoutState(noView, layoutSessions)).toBe(false)
    expect(isWorkspaceLayoutState({
      ...closedLayout,
      sessionView: { 'session-1': { followTail: true } }
    }, layoutSessions)).toBe(false)
  })

  it('owns the single empty layout and it satisfies the closed layout rule', () => {
    const empty = emptyWorkspaceLayout('workspace-9')
    expect(empty).toEqual({
      workspaceId: 'workspace-9',
      selectedSessionId: null,
      split: { orientation: 'side-by-side', panes: [] },
      sessionView: {},
      revision: 1
    })
    expect(isWorkspaceLayoutState(empty, [])).toBe(true)
    expect(emptyWorkspaceLayout('workspace-9')).not.toBe(empty)
  })

  const workspaceRecord = {
    workspaceId: 'workspace-1',
    name: 'Personal',
    defaultCwd: null,
    position: 0,
    marker: 'none',
    archivedAt: null,
    revision: 1
  }
  const sessionRecord = {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    name: 'Shell',
    cwd: '/workspace',
    executable: '/bin/bash',
    argv: [],
    position: 0,
    backgroundChoice: null,
    revision: 1,
    createdAt: '2026-09-13T00:00:00.000Z',
    archivedAt: null,
    lastProcess: {
      incarnationId: 'incarnation-1',
      state: 'exited',
      exitCode: 0,
      signal: 1,
      detail: null
    }
  }
  const templateRecord = {
    templateId: 'template-1',
    name: 'Shell',
    executable: '/bin/bash',
    argv: [],
    cwd: '/workspace',
    backgroundChoice: null,
    revision: 1,
    createdAt: '2026-09-13T00:00:00.000Z'
  }
  const sessionCreate = {
    workspaceId: 'workspace-1',
    name: 'Shell',
    cwd: '/workspace',
    executable: '/bin/bash',
    argv: [],
    cols: 80,
    rows: 24
  }
  const templateCreate = { name: 'Shell', executable: '/bin/bash', argv: [], cwd: '/workspace' }

  it('accepts only a non-empty per-record launch-disabled reason', () => {
    expect(isSessionRecord({
      ...sessionRecord,
      argv: [],
      launchDisabledReason: 'Stored arguments are unreadable; edit and save this session.'
    })).toBe(true)
    expect(isSessionRecord({ ...sessionRecord, launchDisabledReason: '' })).toBe(false)
    expect(isSessionRecord({ ...sessionRecord, archivedAt: '2026-09-14T10:00:00.000Z' })).toBe(true)
    expect(isSessionRecord({ ...sessionRecord, archivedAt: 'yesterday' })).toBe(false)
    expect(isSessionRecord(Object.fromEntries(Object.entries(sessionRecord).filter(([key]) => key !== 'archivedAt'))))
      .toBe(false)
    expect(isLaunchTemplateRecord({
      ...templateRecord,
      argv: [],
      launchDisabledReason: 'Stored arguments are unreadable; recreate this template.'
    })).toBe(true)
    expect(isLaunchTemplateRecord({ ...templateRecord, launchDisabledReason: '' })).toBe(false)
  })

  it.each([
    ['WorkspaceRecord', isWorkspaceRecord as (value: unknown) => boolean, workspaceRecord],
    ['SessionRecord', isSessionRecord as (value: unknown) => boolean, sessionRecord],
    ['LaunchTemplateRecord', isLaunchTemplateRecord as (value: unknown) => boolean, templateRecord],
    ['WorkspaceCreateParams', isWorkspaceCreateParams as (value: unknown) => boolean, { name: 'Personal' }],
    ['WorkspaceUpdateParams', isWorkspaceUpdateParams as (value: unknown) => boolean, {
      workspaceId: 'workspace-1', expectedRevision: 1, name: 'Renamed'
    }],
    ['SessionCreateParams', isSessionCreateParams as (value: unknown) => boolean, sessionCreate],
    ['SessionUpdateParams', isSessionUpdateParams as (value: unknown) => boolean, {
      sessionId: 'session-1', expectedRevision: 1, name: 'Renamed'
    }],
    ['SessionStopParams', isSessionStopParams as (value: unknown) => boolean, {
      sessionId: 'session-1', incarnationId: 'incarnation-1', cause: 'explicit'
    }],
    ['TemplateCreateParams', isTemplateCreateParams as (value: unknown) => boolean, templateCreate]
  ])('closes the %s shape: accepts the exact shape and rejects an unknown key', (_name, validate, exact) => {
    expect(validate(exact)).toBe(true)
    expect(validate({ ...exact, sessionOrder: ['session-1'] })).toBe(false)
  })

  it('names exactly the six curated workspace markers and rejects anything else', () => {
    expect(WORKSPACE_MARKERS).toEqual(['none', 'slate', 'teal', 'blue', 'violet', 'rose'])
    expect(DEFAULT_WORKSPACE_MARKER).toBe('none')
    for (const marker of WORKSPACE_MARKERS) expect(isWorkspaceMarker(marker)).toBe(true)
    for (const rejected of ['magenta', 'gold', 'NONE', '', 'needs-you', null, 7, undefined]) {
      expect(isWorkspaceMarker(rejected)).toBe(false)
    }
  })

  it('carries a marker through the workspace record and both parameter shapes', () => {
    expect(isWorkspaceRecord({ ...workspaceRecord, marker: 'violet' })).toBe(true)
    expect(isWorkspaceRecord({ ...workspaceRecord, marker: 'chartreuse' })).toBe(false)
    // The record's shape is closed, so a stored workspace without a marker is not a valid record.
    expect(isWorkspaceRecord(
      Object.fromEntries(Object.entries(workspaceRecord).filter(([key]) => key !== 'marker'))
    )).toBe(false)

    expect(isWorkspaceCreateParams({ name: 'Personal', marker: 'teal' })).toBe(true)
    expect(isWorkspaceCreateParams({ name: 'Personal', marker: 'teal-ish' })).toBe(false)
    expect(isWorkspaceUpdateParams({
      workspaceId: 'workspace-1', expectedRevision: 1, marker: 'rose'
    })).toBe(true)
    expect(isWorkspaceUpdateParams({
      workspaceId: 'workspace-1', expectedRevision: 1, marker: 'rosy'
    })).toBe(false)
    // A marker alone is a change, so choosing one needs no other field.
    expect(isWorkspaceUpdateParams({
      workspaceId: 'workspace-1', expectedRevision: 1, marker: 'none'
    })).toBe(true)
  })
})

describe('JSON-RPC envelope', () => {
  it('accepts a valid hello and checks protocol-major compatibility', () => {
    expect(isRpcEnvelope(hello)).toBe(true)
    expect(isCompatibleProtocol(PROTOCOL_VERSION)).toBe(true)
    expect(isCompatibleProtocol({ major: 2, minor: 0 })).toBe(false)
  })

  it('rejects unknown methods and unsafe error shapes', () => {
    expect(isRpcEnvelope({ ...hello, method: 'artifact.delete' })).toBe(false)
    expect(
      isRpcEnvelope({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: '', data: { code: 'IO_ERROR', retryable: false } }
      })
    ).toBe(false)
  })
})

describe('4-byte big-endian framing', () => {
  it('round-trips a split frame and encodes the byte length in big-endian order', () => {
    const frame = encodeFrame(hello)
    const bodyBytes = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)
    expect(bodyBytes).toBe(frame.byteLength - 4)

    const decoder = new FrameDecoder()
    const output = [
      ...decoder.push(frame.subarray(0, 2)),
      ...decoder.push(frame.subarray(2, 7)),
      ...decoder.push(frame.subarray(7))
    ]
    decoder.finish()
    expect(output).toEqual([hello])
  })

  it('decodes multiple frames from one chunk', () => {
    const first = encodeFrame(hello)
    const second = encodeFrame({ jsonrpc: '2.0', id: 2, result: { healthy: true } })
    const both = new Uint8Array(first.byteLength + second.byteLength)
    both.set(first)
    both.set(second, first.byteLength)
    expect(new FrameDecoder().push(both)).toHaveLength(2)
  })

  it('rejects an oversized declared frame before allocating its body', () => {
    const allocateBody = vi.fn((size: number) => new Uint8Array(size))
    const decoder = new FrameDecoder(allocateBody)
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, MAX_CONTROL_FRAME_BYTES + 1, false)

    expect(() => decoder.push(header)).toThrow(FrameTooLargeError)
    expect(allocateBody).not.toHaveBeenCalled()
  })

  it('rejects a truncated stream', () => {
    const frame = encodeFrame(hello)
    const decoder = new FrameDecoder()
    decoder.push(frame.subarray(0, frame.byteLength - 1))
    expect(() => decoder.finish()).toThrow(TruncatedFrameError)
  })

  it('rejects a zero-length frame with the typed malformed-frame error', () => {
    expect(() => new FrameDecoder().push(new Uint8Array(4))).toThrow(MalformedFrameError)
  })

  it('fails closed on non-JSON and can decode a later valid frame', () => {
    const malformedBody = new TextEncoder().encode('not-json')
    const malformed = new Uint8Array(4 + malformedBody.byteLength)
    new DataView(malformed.buffer).setUint32(0, malformedBody.byteLength, false)
    malformed.set(malformedBody, 4)
    const decoder = new FrameDecoder()

    expect(() => decoder.push(malformed)).toThrow(MalformedFrameError)
    expect(() => decoder.finish()).not.toThrow()
    expect(decoder.push(encodeFrame(hello))).toEqual([hello])
  })
})

describe('terminal byte messages', () => {
  it('accepts only utility-owned terminal process-state transitions', () => {
    expect(isSessionProcessStateChangedMessage({
      kind: 'session-process-state-changed',
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      state: 'exit-unconfirmed'
    })).toBe(true)
    expect(isSessionProcessStateChangedMessage({
      kind: 'session-process-state-changed',
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      state: 'live'
    })).toBe(false)
  })
  it('exports distinct parser-atom, undelivered-output, and acknowledgement limits', () => {
    expect(TERMINAL_PARSER_ATOM_BYTES).toBe(64 * 1024)
    expect(TERMINAL_UNDELIVERED_OUTPUT_BYTES).toBe(16 * 1024 * 1024)
    expect(TERMINAL_ACKNOWLEDGEMENT_DEADLINE_MS).toBe(5_000)
    expect(TERMINAL_SCROLLBACK_LINES).toBe(10_000)
    expect(TERMINAL_SAVED_OUTPUT_BYTES).toBe(64 * 1024 * 1024)
    expect(TERMINAL_SAVED_OUTPUT_RETENTION).toBe(100)
    expect(SAVED_OUTPUT_FORMAT_VERSION).toBe(2)
  })

  it('exports the renderer-restoration disclosure copy', () => {
    expect(RESTORED_VIEW_NOTICE).toBe(
      'View restored after renderer loss. The process kept running. Earlier output is in Saved Output.'
    )
  })

  it('accepts stream sequence zero and enforces the 256 KiB chunk limit', () => {
    expect(
      isTerminalByteMessage({ attachmentId: 'attachment-1', streamSeq: 0, bytes: new Uint8Array(1) })
    ).toBe(true)
    expect(
      isTerminalByteMessage({
        attachmentId: 'attachment-1',
        streamSeq: 1,
        bytes: new Uint8Array(MAX_TERMINAL_CHUNK_BYTES + 1)
      })
    ).toBe(false)
  })

  it('accepts only bounded terminal view-disconnect reasons', () => {
    expect(
      isTerminalViewDisconnectedMessage({
        kind: 'terminal-view-disconnected',
        attachmentId: 'attachment',
        reason: 'sequence-gap'
      })
    ).toBe(true)
    expect(
      isTerminalViewDisconnectedMessage({
        kind: 'terminal-view-disconnected',
        attachmentId: 'attachment',
        reason: 'acknowledgement-timeout'
      })
    ).toBe(true)
    expect(
      isTerminalViewDisconnectedMessage({
        kind: 'terminal-view-disconnected',
        attachmentId: 'attachment',
        reason: 'unknown'
      })
    ).toBe(false)
  })

  it('accepts only bounded terminal-exit notifications', () => {
    expect(
      isTerminalExitMessage({
        kind: 'terminal-exit',
        state: 'exited',
        attachmentId: 'attachment-1',
        exitCode: 23,
        signal: 15
      })
    ).toBe(true)
    expect(
      isTerminalExitMessage({
        kind: 'terminal-exit',
        state: 'exited',
        attachmentId: 'attachment-1',
        exitCode: 'success'
      })
    ).toBe(false)
    expect(
      isTerminalExitMessage({
        kind: 'terminal-exit',
        state: 'interrupted',
        attachmentId: 'attachment-1',
        cause: 'unobserved-loss',
        reason: 'SIGKILL was sent but a PTY exit event was not observed'
      })
    ).toBe(true)
    expect(
      isTerminalExitMessage({
        kind: 'terminal-exit',
        state: 'interrupted',
        attachmentId: 'attachment-1',
        cause: 'application-quit',
        exitCode: 0,
        signal: 15
      })
    ).toBe(true)
    expect(
      isTerminalExitMessage({
        kind: 'terminal-exit',
        state: 'interrupted',
        attachmentId: 'attachment-1',
        reason: 'missing the closed cause discriminator'
      })
    ).toBe(false)
    expect(
      isTerminalExitMessage({
        kind: 'terminal-exit',
        state: 'interrupted',
        attachmentId: 'attachment-1',
        cause: 'application-quit',
        exitCode: 0,
        reason: 'lifecycle messages do not carry free text'
      })
    ).toBe(false)
    expect(
      isTerminalExitMessage({
        kind: 'terminal-exit',
        state: 'interrupted',
        attachmentId: 'attachment-1',
        cause: 'unobserved-loss',
        reason: 'x'.repeat(241)
      })
    ).toBe(false)
  })
})

describe('app events', () => {
  // A topic the validator does not know is dropped between the utility process and the window, so
  // every declared topic must pass: 'conversations' was declared and rejected, and a hook-driven
  // rebinding never reached the renderer.
  it.each(APP_EVENT_TOPICS)('carries the %s topic across the process boundary', (topic) => {
    expect(isAppEventMessage({ kind: 'app-event', topic, sessionId: 'session-1' })).toBe(true)
    expect(isAppEventMessage({ kind: 'app-event', topic, sessionId: null })).toBe(true)
  })

  it('refuses a message that is not a declared app event', () => {
    expect(isAppEventMessage({ kind: 'app-event', topic: 'invented', sessionId: null })).toBe(false)
    expect(isAppEventMessage({ kind: 'other', topic: 'attention', sessionId: null })).toBe(false)
    expect(isAppEventMessage({ kind: 'app-event', topic: 'attention', sessionId: 7 })).toBe(false)
  })
})
