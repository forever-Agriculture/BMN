// MODULE: turn-changes-host.test.ts - turn changes in the host, through its real control socket: the workspace's switch, a turn from a hook's marks, the pause that only the window sees, and no file name or content in anything a token can read
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { METHOD_REGISTRY, TURN_SWITCH_FOLDER, TURN_WORDINGS, type AppEventMessage, type TurnRecordingState } from '@bmn/protocol'
import { CompanionService } from './companion-service'
import type { DatabaseWorkerClient } from './database-client'
import { COMPANION_OPERATIONS, type CompanionOperationName } from './database-companion-store'
import { selectConversationRoutes } from './database-binding-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { listTurns, type TurnRow } from './database-turn-store'
import { createWorkspace, listSessions, listWorkspaces, selectWorkspace, updateWorkspace } from './database-workspace-store'
import type { SessionManager } from './session-manager'
import { DEFAULT_WORKSPACE_ID } from './store-schema'
import { TurnChangesEngine, inProcessKeeper, inProcessPort } from './turn-changes-engine'
import { scratch, sleep, write, type Place } from './test-fixtures/turn-changes/fixtures'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const NOW = '2026-10-13T12:00:00.000Z'
const CONVERSATION = '01a0b657-21a8-7f00-addd-b73646828f5b'
const MARKER = 'MARKER-69-4'

interface Answer {
  result?: unknown
  error?: { message: string; data: { code: string } }
}

/** One connection: auth, then each request in order. Everything the socket said comes back, errors included. */
type Request = [method: string, params?: unknown]
function ask(
  socketPath: string, token: string, requests: Array<Request | ((answers: Answer[]) => Request | undefined)>, keepOpen = false
): Promise<{ answers: Answer[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const answers: Answer[] = []
    let buffer = ''
    const send = (id: number, method: string, params: unknown): void => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    }
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => send(0, 'auth', { token }))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let cut = buffer.indexOf('\n'); cut !== -1; cut = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, cut)) as Answer & { id: number }
        buffer = buffer.slice(cut + 1)
        if (message.id !== 0) answers.push(message)
        const entry = requests[answers.length]
        const next = typeof entry === 'function' ? entry(answers) : entry
        if (message.id === 0 && message.error) reject(new Error(message.error.message))
        else if (next) send(answers.length + 1, next[0], next[1])
        else {
          if (!keepOpen) socket.destroy()
          resolve({ answers, close: () => socket.destroy() })
        }
      }
    })
  })
}

interface Host {
  at: Place
  root: string
  database: DatabaseConnection
  service: CompanionService
  engine: TurnChangesEngine
  emitted: AppEventMessage[]
  foreground: { folder: string }
  session: string
  owner: string
  socket: string
  /** Everything a token was told, as text. */
  heard: string[]
  call: (token: string, method: string, params?: unknown) => Promise<Answer>
  mark: (params: Record<string, unknown>) => Promise<string>
  /** A prompt as the hook sends it: the mark and, when BMN holds a "before", the confirmation on the same connection. */
  prompt: (turn: string, folder?: string) => Promise<string>
  switchOn: (on: boolean, workspaceId?: string) => Promise<void>
  idle: () => Promise<void>
  turns: () => TurnRow[]
  states: () => Promise<TurnRecordingState[]>
}

const hosts: Host[] = []
let requests = 0
async function host(name: string): Promise<Host> {
  const at = scratch(name)
  const root = mkdtempSync(join(tmpdir(), 'bmn-th-'))
  const database = new BetterSqlite3(':memory:')
  initializeDatabase(database, NOW)
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES ('s1', ?, 'One', ?, '/bin/bash', '[]', 1, ?, 0)`
  ).run(DEFAULT_WORKSPACE_ID, at.base, NOW)
  const worker = {
    companion: async (operationName: CompanionOperationName, ...args: unknown[]) => {
      const operation = COMPANION_OPERATIONS[operationName] as (connection: DatabaseConnection, ...rest: unknown[]) => unknown
      return database.transaction(() => operation(database, ...args))()
    },
    listWorkspaces: async (includeArchived = false) => listWorkspaces(database, includeArchived),
    listSessions: async (workspaceId: string) => listSessions(database, workspaceId),
    listConversationRoutes: async () => selectConversationRoutes(database),
    getConversationBinding: async () => undefined
  } as unknown as DatabaseWorkerClient
  const manager = {
    liveIncarnationId: (sessionId: string) => (sessionId === 's1' ? 'incarnation-1' : undefined),
    foregroundProcessIdentity: (sessionId: string) => (sessionId === 's1' ? '34817:7001:555:1:2' : null),
    liveSessionIds: () => ['s1'],
    liveLaunchDirectory: () => undefined,
    writeToSession: () => undefined,
    screenMirror: () => undefined,
    stopScreenMirror: () => undefined,
    sessionWithCurrentProcessState: (session: unknown) => session
  } as unknown as SessionManager
  const engine = new TurnChangesEngine({ dataRoot: join(root, 'data'), home: at.home })
  const emitted: AppEventMessage[] = []
  const foreground = { folder: at.repo }
  const service = new CompanionService({
    database: worker, manager,
    roots: { config: join(root, 'config'), data: join(root, 'data'), state: join(root, 'state'), runtime: join(root, 'runtime') },
    cliPath: join(root, 'bin', 'bmn'),
    emit: (message) => emitted.push(message),
    now: () => new Date(),
    turnChanges: { ...inProcessPort(engine), removeCaptures: inProcessKeeper(engine).removeCaptures },
    turnVersion: () => Promise.resolve('0.162.1'),
    turnForegroundFolder: () => foreground.folder
  })
  await service.start()
  const socket = service['socketPath']
  const heard: string[] = []
  const call: Host['call'] = async (token, method, params) => {
    const { answers } = await ask(socket, token, [[method, params]])
    heard.push(JSON.stringify(answers))
    return answers[0] as Answer
  }
  const made: Host = {
    at, root, database, service, engine, emitted, foreground, socket, heard, call,
    session: service['auth'].sessionToken('s1', 'incarnation-1'),
    owner: service['auth'].ownerToken,
    mark: async (params) => {
      requests += 1
      const answer = await call(made.session, 'turn.mark', { requestId: `r-${requests}`, app: 'codex', conversation: CONVERSATION, ...params })
      return (answer.result as { status: string } | undefined)?.status ?? `error: ${answer.error?.data.code}`
    },
    prompt: async (turn, folder = at.repo) => {
      requests += 1
      const start = { requestId: `p-${requests}`, app: 'codex', conversation: CONVERSATION, turn }
      const { answers } = await ask(socket, made.session, [
        ['turn.mark', { ...start, edge: 'start', until: Date.now() + 5_000, folder }],
        (told) => (['captured', 'incomplete'].includes((told[0]?.result as { status: string } | undefined)?.status ?? '')
          ? ['turn.mark', { ...start, edge: 'confirm' }] : undefined)
      ])
      heard.push(JSON.stringify(answers))
      return answers.map((answer) => (answer.result as { status: string }).status).join(', ')
    },
    switchOn: async (on, workspaceId = DEFAULT_WORKSPACE_ID) => {
      const workspace = selectWorkspace(database, workspaceId)
      updateWorkspace(database, { workspaceId, expectedRevision: workspace?.revision ?? 1, turnChanges: on }, NOW)
      await service.sessionsChanged()
    },
    idle: () => (service['turns'] as { idle: () => Promise<void> }).idle(),
    turns: () => listTurns(database, { sessionId: 's1', limit: 50 }).reverse(),
    states: () => service.route(METHOD_REGISTRY.turnChangesState, {}) as Promise<TurnRecordingState[]>
  }
  hosts.push(made)
  return made
}
afterEach(async () => {
  for (const made of hosts.splice(0)) {
    await made.idle()
    await made.service.close()
    made.engine.close()
    made.database.close()
    rmSync(made.root, { recursive: true, force: true })
    made.at.done()
  }
})

describe('the workspace\'s switch', () => {
  it('is off until it is set, stored per workspace, and old data loads as off', async () => {
    const h = await host('switch')
    const hint = join(dirname(h.socket), TURN_SWITCH_FOLDER, 's1')
    expect(selectWorkspace(h.database, DEFAULT_WORKSPACE_ID)).not.toHaveProperty('turnChanges')
    expect(existsSync(hint)).toBe(false)
    expect(await h.states()).toEqual([])
    expect(await h.mark({ edge: 'start', until: Date.now() + 5_000, turn: 't-1', folder: h.at.repo })).toBe('off')

    await h.switchOn(true)
    expect(selectWorkspace(h.database, DEFAULT_WORKSPACE_ID)).toMatchObject({ turnChanges: true })
    expect(existsSync(hint)).toBe(true)
    expect(await h.states()).toEqual([{ sessionId: 's1', state: 'recording', app: null, pausedRoot: null, pauseReason: null }])
    expect(h.emitted).toContainEqual({ kind: 'app-event', topic: 'turns', sessionId: null })

    await h.switchOn(false)
    expect(existsSync(hint)).toBe(false)
    expect(selectWorkspace(h.database, DEFAULT_WORKSPACE_ID)).not.toHaveProperty('turnChanges')
  })

  it('closes an open turn as switched off when its session moves to a workspace whose switch is off', async () => {
    const h = await host('moved')
    await h.switchOn(true)
    expect(await h.prompt('t-1')).toBe('captured, confirmed')
    const other = createWorkspace(h.database, { name: 'Other', defaultCwd: h.at.base }, 'workspace-other', NOW)
    h.database.prepare('UPDATE session SET workspace_id = ? WHERE session_id = ?').run(other.workspaceId, 's1')
    await h.service.sessionsChanged()
    await h.idle()

    expect(h.turns()[0]).toMatchObject({ state: 'closed', endKind: 'switched-off', totals: null, wording: TURN_WORDINGS.switchedOff() })
    expect(existsSync(join(dirname(h.socket), TURN_SWITCH_FOLDER, 's1'))).toBe(false)
  })

  it('closes an open turn when its session\'s process ends', async () => {
    const h = await host('exited')
    await h.switchOn(true)
    expect(await h.prompt('t-1')).toBe('captured, confirmed')
    write(h.at.repo, 'a.txt', 'one\n')
    await sleep(25)
    h.service.sessionStateChanged('s1', 'exited')
    await h.idle()

    expect(h.turns()[0]).toMatchObject({ state: 'closed', endKind: 'not-observed', totals: { files: 1, added: 1, removed: 0 } })
  })
})

describe('a turn through the control socket', () => {
  it('records prompt, write and stop as one turn with those files, from a hook\'s marks and events alone', async () => {
    const h = await host('socket-turn')
    await h.switchOn(true)
    expect(await h.prompt('t-1')).toBe('captured, confirmed')
    write(h.at.repo, 'a.txt', 'one\ntwo\n')
    await sleep(25)
    await h.call(h.session, 'hook.observe', { agent: 'codex', event: 'PostToolUse', effects: [], conversation: CONVERSATION, turn: 't-1' })
    expect(await h.mark({ edge: 'end', kind: 'finished', turn: 't-1' })).toBe('queued')
    await h.idle()

    expect(h.turns()).toHaveLength(1)
    expect(h.turns()[0]).toMatchObject({
      sessionId: 's1', incarnationId: 'incarnation-1', app: 'codex', appVersion: '0.162.1', workTree: h.at.repo, state: 'provisional',
      endKind: 'finished', totalsState: 'complete', totals: { files: 1, added: 2, removed: 0 }
    })
    expect(h.emitted).toContainEqual({ kind: 'app-event', topic: 'turns', sessionId: 's1' })
  })

  it('cancels a "before" whose connection closes before the confirmation', async () => {
    const h = await host('socket-drop')
    await h.switchOn(true)
    const held = await ask(h.socket, h.session, [['turn.mark', {
      requestId: 'held', app: 'codex', conversation: CONVERSATION, turn: 't-1', edge: 'start', until: Date.now() + 5_000, folder: h.at.repo
    }]], true)
    expect(held.answers[0]?.result).toEqual({ status: 'captured' })
    expect(h.turns()).toHaveLength(0)
    held.close()
    await expect.poll(() => h.turns().length).toBe(1)
    expect(h.turns()[0]).toMatchObject({ before: null, wording: TURN_WORDINGS.beforeUnavailable() })
  })
})

describe('what a token can read', () => {
  it('holds no file name and no content of a capture, whether scans succeed or fail, for a session and for the owner', async () => {
    const h = await host('markers')
    await h.switchOn(true)
    write(h.at.repo, `${MARKER}-name-tracked.txt`, `${MARKER}-content-tracked\n`)
    h.at.git(h.at.repo, 'add', '-A')
    h.at.git(h.at.repo, 'commit', '-qm', 'made-up second')
    await sleep(25)

    // Scans that succeed: a whole turn with a changed, an added and a removed file.
    expect(await h.prompt('t-1')).toBe('captured, confirmed')
    write(h.at.repo, `${MARKER}-name-tracked.txt`, `${MARKER}-content-changed\n`)
    write(h.at.repo, `sub/${MARKER}-name-added.txt`, `${MARKER}-content-added\n`)
    rmSync(join(h.at.repo, 'keep.txt'))
    await sleep(25)
    expect(await h.mark({ edge: 'end', kind: 'finished', turn: 't-1' })).toBe('queued')
    await h.idle()
    expect(h.turns()[0]).toMatchObject({ totalsState: 'complete', totals: { files: 3, added: 2, removed: 2 } })

    // Scans that fail: a folder the hook names outside the work tree, a folder that is no repository, a path that is no folder.
    const elsewhere = join(h.at.base, `${MARKER}-name-elsewhere`)
    write(elsewhere, 'x.txt', 'x\n')
    expect(await h.prompt('t-2', elsewhere)).toBe('unavailable')
    h.foreground.folder = elsewhere
    expect(await h.prompt('t-3', elsewhere)).toBe('unavailable')
    h.foreground.folder = join(h.at.repo, `${MARKER}-name-tracked.txt`)
    expect(await h.prompt('t-4')).toBe('unavailable')
    h.foreground.folder = h.at.repo
    await h.idle()

    // Everything a token can ask for, refusals included.
    for (const token of [h.session, h.owner]) {
      await h.call(token, 'state.snapshot')
      await h.call(token, 'session.list')
      await h.call(token, 'turn.mark', { requestId: 'x', app: 'codex', edge: 'start', conversation: CONVERSATION, until: Date.now() + 5_000, folder: h.at.repo, files: [`${MARKER}-asked`] })
      await h.call(token, 'turn.mark', { requestId: 'y', app: 'codex', edge: 'end', kind: 'finished', conversation: CONVERSATION })
      await h.call(token, 'turn.list', { sessionId: 's1' })
      await h.call(token, 'turn.changes', { sessionId: 's1' })
      await h.call(token, 'hook.observe', { sessionId: 's1', agent: 'codex', event: 'Stop', effects: [] })
      await h.call(token, 'message.status', {})
    }
    const told = [
      ...h.heard,
      JSON.stringify(await h.service.route(METHOD_REGISTRY.attentionList, {})),
      JSON.stringify(await h.service.route(METHOD_REGISTRY.hookEventsList, { sessionId: 's1' })),
      JSON.stringify(await h.service.route(METHOD_REGISTRY.progressList, {})),
      JSON.stringify(await h.states()),
      JSON.stringify(h.emitted),
      // The rows themselves: a root, times, commits, counts and fixed words.
      JSON.stringify(h.turns()),
      JSON.stringify(h.database.prepare('SELECT * FROM turn_capture').all()),
      JSON.stringify(h.database.prepare('SELECT * FROM turn_removal_job').all())
    ].join('\n')
    expect(h.heard.length).toBeGreaterThan(20)
    expect(told).not.toContain(`${MARKER}-content`)
    expect(told.replaceAll(`${MARKER}-asked`, '').replaceAll(elsewhere, '')).not.toContain(MARKER)
    // The one place a path the hook named is kept is the turn's own row, as the folder the event named.
    expect(h.turns().map((row) => row.namedFolder)).toContain(elsewhere)
    expect(h.heard.join('\n')).not.toContain(elsewhere)
  })

  it('shows a pause in the window only: no request, no snapshot, no notice, and Resume sets the count back', async () => {
    const h = await host('held')
    await h.switchOn(true)
    h.foreground.folder = h.at.base
    for (const turn of ['t-1', 't-2', 't-3']) expect(await h.prompt(turn, h.at.base)).toBe('unavailable')
    await h.idle()

    expect(await h.states()).toEqual([{ sessionId: 's1', state: 'paused', app: 'codex', pausedRoot: h.at.base, pauseReason: 'failed' }])
    expect(await h.prompt('t-4', h.at.base)).toBe('paused')
    expect(await h.service.route(METHOD_REGISTRY.attentionList, {})).toEqual([])
    for (const token of [h.session, h.owner]) {
      const snapshot = JSON.stringify((await h.call(token, 'state.snapshot')).result)
      expect(snapshot).not.toMatch(/paus|Three scans|recording/i)
    }
    expect(h.emitted.filter((event) => event.topic === 'attention')).toEqual([])

    expect(await h.service.route(METHOD_REGISTRY.turnChangesResume, { sessionId: 's1' })).toEqual({ resumed: true })
    expect(await h.states()).toEqual([{ sessionId: 's1', state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null }])
    expect(await h.service.route(METHOD_REGISTRY.turnChangesResume, { sessionId: 's1' })).toEqual({ resumed: false })
    h.foreground.folder = h.at.repo
    expect(await h.prompt('t-5')).toBe('captured, confirmed')
  })
})
