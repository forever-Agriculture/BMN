// MODULE: turn-changes-host.test.ts - turn changes in the host, through its real control socket: the workspace's switch, a turn from a hook's marks, the pause that only the window sees, and no file name or content in anything a token can read
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ERROR_CODES, METHOD_REGISTRY, TURN_FILES_LIMIT, TURN_LABELS, TURN_LIST_LIMIT, TURN_SECRET_PLATE, TURN_SWITCH_FOLDER, TURN_WORDINGS,
  type AppEventMessage, type TurnDetail, type TurnDetailAnswer, type TurnDifferenceAnswer, type TurnSessionView, type TurnShownLine, type TurnSummary
} from '@bmn/protocol'
import { CompanionService } from './companion-service'
import type { DatabaseWorkerClient } from './database-client'
import { COMPANION_OPERATIONS, type CompanionOperationName } from './database-companion-store'
import { selectConversationRoutes } from './database-binding-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { listTurns, sweepTurns, type TurnRow } from './database-turn-store'
import { createWorkspace, listSessions, listWorkspaces, selectWorkspace, updateWorkspace } from './database-workspace-store'
import type { SessionManager } from './session-manager'
import { DEFAULT_WORKSPACE_ID } from './store-schema'
import { refusal } from './turn-changes-capture'
import { TurnChangesEngine, inProcessKeeper, inProcessPort, type TurnChangesPort } from './turn-changes-engine'
import type { TurnCaptureRecord } from './turn-changes-store'
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
  states: () => Promise<TurnSessionView[]>
  /** The window's own reads, as its channels reach the host. */
  window: <Result>(method: string, params: Record<string, unknown>) => Promise<Result>
}

const hosts: Host[] = []
let requests = 0
async function host(name: string, wrap: (port: TurnChangesPort) => TurnChangesPort = (port) => port): Promise<Host> {
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
    turnChanges: { ...wrap(inProcessPort(engine)), removeCaptures: inProcessKeeper(engine).removeCaptures },
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
    states: () => service.route(METHOD_REGISTRY.turnChangesState, {}) as Promise<TurnSessionView[]>,
    window: <Result>(method: string, params: Record<string, unknown>) => service.route(method, params) as Promise<Result>
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
    expect(await h.states()).toEqual([{ sessionId: 's1', state: 'recording', app: null, pausedRoot: null, pauseReason: null, latest: null, removalPending: false }])
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

    expect(await h.states()).toMatchObject([{ sessionId: 's1', state: 'paused', app: 'codex', pausedRoot: h.at.base, pauseReason: 'failed' }])
    expect(await h.prompt('t-4', h.at.base)).toBe('paused')
    expect(await h.service.route(METHOD_REGISTRY.attentionList, {})).toEqual([])
    for (const token of [h.session, h.owner]) {
      const snapshot = JSON.stringify((await h.call(token, 'state.snapshot')).result)
      expect(snapshot).not.toMatch(/paus|Three scans|recording/i)
    }
    expect(h.emitted.filter((event) => event.topic === 'attention')).toEqual([])

    expect(await h.service.route(METHOD_REGISTRY.turnChangesResume, { sessionId: 's1' })).toEqual({ resumed: true })
    expect(await h.states()).toMatchObject([{ sessionId: 's1', state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null }])
    expect(await h.service.route(METHOD_REGISTRY.turnChangesResume, { sessionId: 's1' })).toEqual({ resumed: false })
    h.foreground.folder = h.at.repo
    expect(await h.prompt('t-5')).toBe('captured, confirmed')
  })
})

/** One finished turn in a repository with a made-up secret: a changed config file, an added text file. */
async function windowTurn(h: Host): Promise<string> {
  await h.switchOn(true)
  write(h.at.repo, `config/${MARKER}-payments.yaml`, `provider: stripe\napi_key: ${MARKER}-key-one\n`)
  h.at.git(h.at.repo, 'add', '-A')
  h.at.git(h.at.repo, 'commit', '-qm', 'made-up second')
  await sleep(25)
  expect(await h.prompt('t-1')).toBe('captured, confirmed')
  write(h.at.repo, `config/${MARKER}-payments.yaml`, `provider: stripe\napi_key: ${MARKER}-key-two\nretries: 3\n`)
  write(h.at.repo, `${MARKER}-added.txt`, `${MARKER}-content one\ntwo\n`)
  await sleep(25)
  expect(await h.mark({ edge: 'end', kind: 'finished', turn: 't-1' })).toBe('queued')
  await h.idle()
  return h.turns()[0]!.turnId
}

describe('what the window reads (Story 69.5)', () => {
  it('gives each session where recording stands with its latest turn, a turn\'s labels and files by path, and a file\'s difference with every secret value masked', async () => {
    const h = await host('window')
    const turnId = await windowTurn(h)

    expect(await h.states()).toEqual([{
      sessionId: 's1', state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null, removalPending: false,
      latest: expect.objectContaining({
        turnId, number: 1, app: 'codex', appVersion: '0.162.1', end: 'finished', state: 'provisional', totalsState: 'complete',
        totals: { files: 2, added: 4, removed: 1 }, wording: null
      })
    }])
    const list = await h.window<TurnSummary[]>(METHOD_REGISTRY.turnChangesList, { sessionId: 's1' })
    expect(list.map((turn) => turn.turnId)).toEqual([turnId])
    // A summary is fixed words and counts: it cannot hold a file's name.
    expect(Object.keys(list[0]!).sort()).toEqual(['app', 'appVersion', 'end', 'endedAt', 'number', 'startedAt', 'state', 'totals', 'totalsState', 'turnId', 'wording'])
    expect(await h.window(METHOD_REGISTRY.turnChangesList, { sessionId: 's-other' })).toEqual([])

    const turn = await h.window<TurnDetailAnswer>(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId })
    if (!turn.kept) throw new Error('the turn is kept')
    expect(turn.detail).toMatchObject({ workTree: h.at.repo, from: 0, total: 2, unavailable: null })
    expect(turn.detail.labels).toEqual(expect.arrayContaining([TURN_LABELS.covered(), TURN_LABELS.after()]))
    expect(turn.detail.files).toEqual([
      { path: `${MARKER}-added.txt`, state: 'added', added: 2, removed: 0, note: null, opens: true },
      { path: `config/${MARKER}-payments.yaml`, state: 'changed', added: 2, removed: 1, note: null, opens: true }
    ])

    const answer = await h.window<TurnDifferenceAnswer>(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path: `config/${MARKER}-payments.yaml` })
    if (!answer.kept || !('difference' in answer) || answer.difference.state !== 'text') throw new Error('a text difference is shown')
    expect(answer.difference).toMatchObject({ added: 2, removed: 1, more: 0 })
    const lines = answer.difference.hunks.flatMap((hunk) => hunk.lines).filter((line): line is TurnShownLine => line.kind !== '\\')
    expect(lines.map((line) => `${line.kind}${line.a ?? ''}/${line.b ?? ''} ${line.text}`)).toEqual([
      ' 1/1 provider: stripe', `-2/ api_key: ${TURN_SECRET_PLATE}`, `+/2 api_key: ${TURN_SECRET_PLATE}`, '+/3 retries: 3'
    ])
    // Not even the window is handed a value: what it shows, copies and finds is the plate.
    expect(JSON.stringify(answer)).not.toMatch(/key-one|key-two/)

    // A turn is read only under its own session, and a path neither scan holds has nothing that differs.
    expect(await h.window(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's-other', turnId })).toEqual({ kept: false })
    expect(await h.window(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's-other', turnId, path: `${MARKER}-added.txt` })).toEqual({ kept: false })
    expect(await h.window(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path: 'no/such/file' }))
      .toEqual({ kept: true, difference: { state: 'text', added: 0, removed: 0, hunks: [], more: 0 } })
    expect(TURN_LIST_LIMIT).toBe(50)
  })

  it('is refused on the control socket, for a session\'s token and for the owner\'s', async () => {
    const h = await host('refused')
    const turnId = await windowTurn(h)
    const path = `config/${MARKER}-payments.yaml`
    // The window's own route answers each of them.
    expect((await h.window<TurnDifferenceAnswer>(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path })).kept).toBe(true)
    h.heard.length = 0

    const reads: Array<[string, Record<string, unknown>]> = [
      [METHOD_REGISTRY.turnChangesState, {}],
      [METHOD_REGISTRY.turnChangesList, { sessionId: 's1' }],
      [METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId }],
      [METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path }],
      [METHOD_REGISTRY.turnChangesResume, { sessionId: 's1' }]
    ]
    for (const token of [h.session, h.owner]) {
      for (const [method, params] of reads) {
        const answer = await h.call(token, method, params)
        expect(answer.result, `${method} answered a token`).toBeUndefined()
        expect(answer.error?.data.code).toBe(ERROR_CODES.invalidArgument)
        expect(answer.error?.message).toBe(`Unknown method: ${method}`)
      }
    }
    expect(h.heard).toHaveLength(10)
    // The only marker a refusal carries is the one the caller itself sent: none.
    expect(h.heard.join('\n')).not.toContain(MARKER)
  })

  it('answers "no longer kept" for a turn that was removed, and says while a removal waits for the session', async () => {
    const h = await host('removed')
    const turnId = await windowTurn(h)
    expect((await h.states())[0]).toMatchObject({ removalPending: false })

    // The keep rule removes the turn; the job for its bytes waits for the sweep to run it.
    h.database.transaction(() => sweepTurns(h.database, { now: new Date(Date.now() + 2 * 86_400_000).toISOString(), keepDays: 1 }))()
    expect(await h.window(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId })).toEqual({ kept: false })
    expect(await h.window(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path: `${MARKER}-added.txt` })).toEqual({ kept: false })
    expect(await h.window(METHOD_REGISTRY.turnChangesList, { sessionId: 's1' })).toEqual([])
    expect(await h.states()).toEqual([{ sessionId: 's1', state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null, latest: null, removalPending: true }])

    // With the switch off and its last turn gone, the session is still listed while its bytes wait to be removed:
    // "Removal pending" stays readable, and the menu's entry stays open...
    await h.switchOn(false)
    await h.idle()
    expect(await h.states()).toEqual([{ sessionId: 's1', state: 'off', app: null, pausedRoot: null, pauseReason: null, latest: null, removalPending: true }])
    // ...and not once nothing of it is kept or waits.
    h.database.prepare('DELETE FROM turn_removal_job').run()
    expect(await h.states()).toEqual([])
  })

  it('answers "no longer kept" when the turn is removed while its files or a difference are being read', async () => {
    const waiting: Array<() => void> = []
    const held = { on: false }
    const afterwards = async <Answer>(answer: Answer): Promise<Answer> => {
      if (held.on) await new Promise<void>((resolve) => { waiting.push(resolve) })
      return answer
    }
    // The worker has answered; the answer is on its way to the window when the turn goes.
    const h = await host('removed-meanwhile', (port) => ({
      ...port,
      compare: async (request, signal) => afterwards(await port.compare(request, signal)),
      difference: async (request, signal) => afterwards(await port.difference(request, signal))
    }))
    const turnId = await windowTurn(h)
    held.on = true
    const files = h.window<TurnDetailAnswer>(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId })
    const difference = h.window<TurnDifferenceAnswer>(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path: `${MARKER}-added.txt` })
    await expect.poll(() => waiting.length).toBe(2)
    h.database.transaction(() => sweepTurns(h.database, { now: new Date(Date.now() + 2 * 86_400_000).toISOString(), keepDays: 1 }))()
    held.on = false
    for (const release of waiting) release()
    expect(await files).toEqual({ kept: false })
    expect(await difference).toEqual({ kept: false })
  })

  it('reaches every file of a turn a page at a time: the last of 2,001 changed files opens like the first', async () => {
    const h = await host('pages')
    await h.switchOn(true)
    const scan = async (job: string, base: string | null = null): Promise<TurnCaptureRecord> => {
      const answer = await h.engine.capture({ job, session: 's1', folder: h.at.repo, base, publish: true })
      if (!('record' in answer) || answer.state !== 'whole') throw new Error(`the scan is whole: ${answer.state}`)
      return answer.record
    }
    const before = await scan('before')
    const name = (index: number): string => `made-up/f-${String(index).padStart(4, '0')}.txt`
    for (let index = 0; index <= TURN_FILES_LIMIT; index += 1) write(h.at.repo, name(index), `line of ${index}\n`)
    await sleep(25)
    // As a turn's second scan is taken: it looks at what became of the first one's paths.
    const after = await scan('after', before.id)
    const turnId = 't-many'
    const row = (record: TurnCaptureRecord): Record<string, unknown> => ({
      captureId: record.id, sessionId: 's1', workTree: record.root, scanStartedMs: record.startedAt, scanEndedMs: record.endedAt,
      headStart: record.headStart, headEnd: record.headEnd, state: record.state, bound: record.bound, size: record.bytesStored
    })
    await h.service['options'].database.companion('putTurn', {
      turn: {
        turnId, number: 1, sessionId: 's1', incarnationId: 'incarnation-1', foreground: '34817:7001:555:1:2', app: 'codex', appVersion: '0.162.1',
        conversation: CONVERSATION, appTurnId: null, namedFolder: before.root, workTree: before.root, state: 'closed', endKind: 'finished',
        startedAt: NOW, endedAt: NOW, totalsState: 'complete', totals: { files: TURN_FILES_LIMIT + 1, added: TURN_FILES_LIMIT + 1, removed: 0 }, wording: null,
        labels: [], before: before.id, after: after.id
      },
      captures: [row(before), row(after)]
    } as never)
    const read = async (from?: number): Promise<TurnDetail> => {
      const answer = await h.window<TurnDetailAnswer>(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId, ...(from === undefined ? {} : { from }) })
      if (!answer.kept) throw new Error('the turn is kept')
      return answer.detail
    }

    const first = await read()
    expect(first).toMatchObject({ from: 0, total: TURN_FILES_LIMIT + 1, unavailable: null })
    expect(first.files).toHaveLength(TURN_FILES_LIMIT)
    expect(first.files[0]).toEqual({ path: name(0), state: 'added', added: 1, removed: 0, note: null, opens: true })
    expect(first.files.at(-1)?.path).toBe(name(TURN_FILES_LIMIT - 1))
    // The file the first page does not hold is on the next one, and opens.
    const second = await read(TURN_FILES_LIMIT)
    expect(second).toMatchObject({ from: TURN_FILES_LIMIT, total: TURN_FILES_LIMIT + 1 })
    expect(second.files).toEqual([{ path: name(TURN_FILES_LIMIT), state: 'added', added: 1, removed: 0, note: null, opens: true }])
    const answer = await h.window<TurnDifferenceAnswer>(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path: name(TURN_FILES_LIMIT) })
    if (!answer.kept || !('difference' in answer) || answer.difference.state !== 'text') throw new Error('a text difference is shown')
    expect(answer.difference).toMatchObject({ added: 1, removed: 0, more: 0 })
    expect(answer.difference.hunks.flatMap((hunk) => hunk.lines)).toMatchObject([{ kind: '+', a: null, b: 1, text: `line of ${TURN_FILES_LIMIT}` }])
    // A page past the last is answered with the last; a start that is no page's is refused.
    expect(await read(TURN_FILES_LIMIT * 3)).toMatchObject({ from: TURN_FILES_LIMIT, files: [{ path: name(TURN_FILES_LIMIT) }] })
    for (const from of [1, -TURN_FILES_LIMIT, 1.5, `${TURN_FILES_LIMIT}`]) {
      await expect(h.window(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId, from })).rejects.toThrow('from must be where a page starts')
    }
  }, 60_000)

  it('still lists a session whose switch went off beside its kept turn, as off', async () => {
    const h = await host('off-kept')
    const turnId = await windowTurn(h)
    await h.switchOn(false)
    await h.idle()
    expect(await h.states()).toMatchObject([{ sessionId: 's1', state: 'off', app: null, latest: { turnId }, removalPending: false }])
    // What was kept can still be read.
    expect((await h.window<TurnDetailAnswer>(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId })).kept).toBe(true)
  })

  it('gives way to a prompt\'s scan: a read still in the worker is stopped, and asked again once the prompt has gone on', async () => {
    let asked = 0
    const h = await host('give-way', (port) => ({
      ...port,
      difference: async (request, signal) => {
        asked += 1
        if (asked > 1) return port.difference(request, signal)
        // The first read is in the worker until it is stopped; it answers as a stopped comparison does.
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
        return refusal('cancelled', 'cancelled')
      }
    }))
    const turnId = await windowTurn(h)
    const reading = h.window<TurnDifferenceAnswer>(METHOD_REGISTRY.turnChangesDifference, { sessionId: 's1', turnId, path: `${MARKER}-added.txt` })
    await expect.poll(() => asked).toBe(1)

    expect(await h.prompt('t-2')).toBe('captured, confirmed')
    expect(await reading).toMatchObject({ kept: true, difference: { state: 'text', added: 2, removed: 0 } })
    expect(asked).toBe(2)
  })

  it('says so, in fixed words, when prompts keep stopping a read', async () => {
    let asked = 0
    const h = await host('gave-up', (port) => ({
      ...port,
      compare: async () => {
        asked += 1
        return refusal('cancelled', 'cancelled')
      }
    }))
    await h.switchOn(true)
    // A turn whose totals were stored, so that opening it compares its two scans again.
    const turnId = await (async () => {
      const id = 't-kept'
      h.database.prepare(
        `INSERT INTO turn_capture(capture_id, session_id, work_tree, scan_started_ms, scan_ended_ms, head_start, head_end, state, bound, size)
         VALUES ('c-1', 's1', ?, 1, 2, NULL, NULL, 'whole', NULL, 1), ('c-2', 's1', ?, 3, 4, NULL, NULL, 'whole', NULL, 1)`
      ).run(h.at.repo, h.at.repo)
      await h.service['options'].database.companion('putTurn', { turn: {
        turnId: id, number: 1, sessionId: 's1', incarnationId: 'incarnation-1', foreground: '34817:7001:555:1:2', app: 'codex', appVersion: '0.162.1',
        conversation: CONVERSATION, appTurnId: null, namedFolder: h.at.repo, workTree: h.at.repo, state: 'closed', endKind: 'finished',
        startedAt: NOW, endedAt: NOW, totalsState: 'complete', totals: { files: 1, added: 1, removed: 0 }, wording: null, labels: [], before: 'c-1', after: 'c-2'
      } })
      return id
    })()

    expect(await h.window(METHOD_REGISTRY.turnChangesTurn, { sessionId: 's1', turnId })).toMatchObject({
      kept: true, detail: { files: [], unavailable: 'BMN was scanning for a prompt; open it again' }
    })
    expect(asked).toBe(3)
  })

  it('tells the window when the sweep removed something', async () => {
    const h = await host('swept')
    h.emitted.length = 0
    h.service.turnsChanged()
    expect(h.emitted).toEqual([{ kind: 'app-event', topic: 'turns', sessionId: null }])
  })
})
