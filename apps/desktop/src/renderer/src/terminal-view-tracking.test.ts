// MODULE: terminal-view-tracking.test.ts - real xterm output, capture, router and writer composed as main.tsx composes them
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyWorkspaceLayout,
  type LayoutPutParams,
  type SavedOutputCapture,
  type SessionRecord,
  type WorkspaceLayoutState
} from '@bmn/protocol'
import { createLayoutWriter } from './layout-writer'
import { startSavedOutputCapture } from './terminal-history'
import { TerminalOutputFlow } from './terminal-output-flow'
import { trackTerminalView } from './terminal-view-tracking'
import {
  FOLLOW_TAIL_VIEW,
  applySessionView,
  captureLayoutScroll,
  selectLayoutSession,
  sessionLayoutView,
  type SessionViewUpdate
} from './workspace-layout'

const record = (sessionId: string, workspaceId: string): SessionRecord => ({
  sessionId,
  workspaceId,
  name: sessionId,
  cwd: '/workspace',
  executable: '/bin/bash',
  argv: [],
  position: 0,
  backgroundChoice: null,
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z',
  archivedAt: null,
  lastProcess: null
})

const records = [record('active-a', 'workspace-active'), record('inactive-a', 'workspace-inactive')]
const activeLayout = selectLayoutSession(emptyWorkspaceLayout('workspace-active'), 'active-a', ['active-a'])
const inactiveLayout = selectLayoutSession(emptyWorkspaceLayout('workspace-inactive'), 'inactive-a', ['inactive-a'])

const lines = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}\r\n`).join('')

function layoutHost() {
  const stored: Record<string, WorkspaceLayoutState> = {
    'workspace-active': activeLayout,
    'workspace-inactive': inactiveLayout
  }
  const puts: LayoutPutParams[] = []
  const failures: string[] = []
  const writer = createLayoutWriter({
    put: async (params) => {
      puts.push(structuredClone(params))
      const current = stored[params.workspaceId]!
      if (params.expectedRevision !== current.revision) {
        throw { name: 'BridgeError', code: 'REVISION_CONFLICT', message: 'stale layout' }
      }
      stored[params.workspaceId] = { ...params.state, revision: current.revision + 1 }
      return stored[params.workspaceId]!
    },
    get: async (workspaceId) => ({ layout: stored[workspaceId]!, notice: null }),
    publish: () => undefined,
    notice: () => undefined,
    failure: (message) => failures.push(message)
  })
  writer.reset(Object.values(stored))
  return { writer, puts, failures }
}

/** Mounts one session exactly as SessionTerminal composes output flow, capture, tracking and routing. */
function mountSession(
  sessionId: string,
  host: ReturnType<typeof layoutHost>,
  report?: (update: SessionViewUpdate) => void
) {
  const terminal = new Terminal({ cols: 24, rows: 4, scrollback: 500, allowProposedApi: true })
  const saves: SavedOutputCapture[] = []
  const failures: string[] = []
  const capture = startSavedOutputCapture(
    terminal,
    async (snapshot) => {
      saves.push(snapshot)
    },
    (message) => failures.push(message)
  )
  const schedule = vi.fn(() => capture.schedule())
  const tracking = trackTerminalView({
    terminal,
    capture: { write: capture.write, schedule },
    view: () => sessionLayoutView(host.writer.layouts(), records, sessionId),
    report: report ?? ((update) => applySessionView(host.writer, records, sessionId, update)),
    onFailure: (message) => failures.push(message)
  })
  const flow = new TerminalOutputFlow()
  flow.attach(`attachment-${sessionId}`)
  const acknowledged: number[] = []
  let streamSeq = 0
  const output = (text: string): Promise<void> =>
    new Promise((resolve) => {
      const accepted = flow.accept(
        { attachmentId: `attachment-${sessionId}`, streamSeq: streamSeq++, bytes: new TextEncoder().encode(text) },
        {
          write: (bytes, settled) => tracking.write(bytes, () => {
            settled()
            resolve()
          }),
          acknowledge: (_attachmentId, seq) => acknowledged.push(seq),
          recover: (reason) => failures.push(`recover:${reason}`)
        }
      )
      if (!accepted) resolve()
    })
  const dispose = (): void => {
    tracking.dispose()
    capture.dispose()
    terminal.dispose()
  }
  return { terminal, capture, schedule, tracking, output, acknowledged, saves, failures, dispose }
}

describe('terminal view tracking', () => {
  it('a following session of an inactive workspace receiving output issues zero layout writes while capture advances', async () => {
    const host = layoutHost()
    const session = mountSession('inactive-a', host)
    try {
      for (let chunk = 0; chunk < 6; chunk += 1) await session.output(lines(`chunk${chunk}`, 8))
      await host.writer.idle('workspace-inactive')

      expect(host.puts).toEqual([])
      expect(session.terminal.buffer.active.baseY).toBeGreaterThan(40)
      expect(session.terminal.buffer.active.viewportY).toBe(session.terminal.buffer.active.baseY)
      expect(sessionLayoutView(host.writer.layouts(), records, 'inactive-a')).toEqual(FOLLOW_TAIL_VIEW)
      expect(session.acknowledged).toEqual([0, 1, 2, 3, 4, 5])
      expect(session.schedule).toHaveBeenCalledTimes(6)
      await session.capture.captureNow()
      expect(session.saves.at(-1)?.content).toContain('chunk5-7')
      expect(session.failures).toEqual([])
    } finally {
      session.dispose()
    }
  })

  it('writes a user scroll away once to the session own workspace; output while reading keeps the viewport', async () => {
    const host = layoutHost()
    const session = mountSession('inactive-a', host)
    try {
      await session.output(lines('before', 20))
      session.terminal.scrollLines(-3)
      const line = session.terminal.buffer.active.viewportY
      await host.writer.idle('workspace-inactive')
      expect(host.puts).toHaveLength(1)
      expect(host.puts[0]).toMatchObject({
        workspaceId: 'workspace-inactive',
        expectedRevision: 1,
        state: { sessionView: { 'inactive-a': { scrollLine: line, followTail: false } } }
      })

      await session.output(lines('after', 20))
      await session.output(lines('later', 20))
      await host.writer.idle('workspace-inactive')
      expect(session.terminal.buffer.active.viewportY).toBe(line)
      expect(host.puts).toHaveLength(1)
      expect(session.acknowledged).toEqual([0, 1, 2])
    } finally {
      session.dispose()
    }
  })

  it('records a user scroll made inside an output window once that window closes', async () => {
    const host = layoutHost()
    const session = mountSession('inactive-a', host)
    try {
      await session.output(lines('before', 20))
      const pending = session.output(lines('during', 5))
      session.terminal.scrollLines(-4)
      expect(session.acknowledged).toEqual([0])
      await pending
      await host.writer.idle('workspace-inactive')
      expect(session.terminal.buffer.active.viewportY).toBeLessThan(session.terminal.buffer.active.baseY)
      expect(host.puts).toHaveLength(1)
      expect(host.puts[0]!.state.sessionView['inactive-a']).toEqual({
        scrollLine: session.terminal.buffer.active.viewportY,
        followTail: false
      })
    } finally {
      session.dispose()
    }
  })

  it('a thrown view transition never breaks acknowledgement or saved-output capture', async () => {
    const host = layoutHost()
    // The pre-fix failure: routing an inactive-workspace session against the ACTIVE workspace ids.
    const session = mountSession('inactive-a', host, (update) => {
      if (update.kind === 'scrolled-away') {
        captureLayoutScroll(activeLayout, 'inactive-a', update.scrollLine, ['active-a'])
      }
    })
    try {
      await session.output(lines('first', 20))
      session.terminal.scrollLines(-2)
      const pending = session.output(lines('during', 6))
      session.terminal.scrollLines(-1)
      expect(session.acknowledged).toEqual([0])
      await pending
      await session.output(lines('last', 6))

      expect(session.failures).toContain('Workspace layout transition produced an invalid state')
      expect(session.acknowledged).toEqual([0, 1, 2])
      expect(session.schedule).toHaveBeenCalledTimes(3)
      await session.capture.captureNow()
      expect(session.saves.at(-1)?.content).toContain('last-5')
      expect(host.puts).toEqual([])
    } finally {
      session.dispose()
    }
  })

  it('does not report programmatic viewport changes made quietly', async () => {
    const host = layoutHost()
    const session = mountSession('inactive-a', host)
    try {
      await session.output(lines('restore', 20))
      session.tracking.quietly(() => session.terminal.scrollToLine(2))
      await host.writer.idle('workspace-inactive')
      expect(host.puts).toEqual([])
    } finally {
      session.dispose()
    }
  })
})
