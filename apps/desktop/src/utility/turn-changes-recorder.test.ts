// MODULE: turn-changes-recorder.test.ts - every move of a turn on a real store, a real database and made-up repositories: the confirmation, the ends, overlapping prompts, the last scan, the wordings and labels, the pause, the switch and a restart
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TURN_LABELS, TURN_PAUSE_REASONS, TURN_WORDINGS } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { listTurns, listUnclosedTurns, nextTurnNumber, putTurn, type TurnRow } from './database-turn-store'
import { DEFAULT_WORKSPACE_ID } from './store-schema'
import { refusal, type TurnLimits } from './turn-changes-capture'
import { TurnChangesEngine, inProcessKeeper, inProcessPort, type TurnChangesPort } from './turn-changes-engine'
import { TurnRecorder, turnLabelTime, type TurnMarkCall, type TurnObservation } from './turn-changes-recorder'
import { TURN_STORE_FOLDER } from './turn-changes-store'
import { mayAskProgram, readAppVersion, startedPrograms, turnAppVersion, type VersionSeams } from './turn-changes-version'
import { filesUnder, scratch, sleep, write, type Place } from './test-fixtures/turn-changes/fixtures'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const CONVERSATION = '01a0b657-21a8-7f00-addd-b73646828f5b'
const OTHER = '11a0b657-21a8-7f00-addd-b73646828f5b'
const SESSION = 's-one'
const AGENT = '34817:7001:555:1:2'
/** Generous for a loaded machine; the tests of the limit give their own. */
const ROOMY = 5_000

interface World {
  at: Place
  database: DatabaseConnection
  engine: TurnChangesEngine
  recorder: TurnRecorder
  foreground: { identity: string | null; folder: string }
  version: { value: string | null }
  shared: { value: boolean }
  changes: Array<string | null>
  hints: string
  mark: (edge: TurnMarkCall['edge'], extra?: Partial<TurnMarkCall>) => Promise<string>
  /** A prompt as the hook sends it: the mark, then the confirmation when BMN holds a "before". */
  prompt: (extra?: Partial<TurnMarkCall>) => Promise<string>
  end: (extra?: Partial<TurnMarkCall>) => Promise<string>
  event: (event: string, extra?: Partial<TurnObservation>) => Promise<void>
  /** A file changes, and stays still for the moment a scan asks for. */
  edit: (name: string, content: string) => Promise<void>
  turns: () => TurnRow[]
  staged: () => number
}

const worlds: World[] = []
let requests = 0
function world(name: string, options: { app?: string; limits?: Partial<TurnLimits>; port?: (port: TurnChangesPort) => TurnChangesPort; limitMs?: number } = {}): World {
  const at = scratch(name)
  const database = new BetterSqlite3(':memory:')
  initializeDatabase(database, new Date().toISOString())
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES (?, ?, 'One', '/work', '/bin/bash', '[]', 1, ?, 0)`
  ).run(SESSION, DEFAULT_WORKSPACE_ID, new Date().toISOString())
  const engine = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, ...(options.limits ? { limits: options.limits } : {}) })
  const app = options.app ?? 'codex'
  const foreground: World['foreground'] = { identity: AGENT, folder: at.repo }
  const version: World['version'] = { value: app === 'codex' ? '0.162.1' : '2.1.296' }
  const shared = { value: false }
  const changes: Array<string | null> = []
  const hints = join(at.base, 'hints')
  const once = <Result>(work: () => Result): Promise<Result> => Promise.resolve(database.transaction(work)())
  const port = inProcessPort(engine)
  const recorder = new TurnRecorder({
    port: options.port ? options.port(port) : port,
    keeper: inProcessKeeper(engine),
    foreground: { identity: () => foreground.identity, folder: (identity) => (identity === foreground.identity ? foreground.folder : null) },
    database: {
      putTurn: (input) => once(() => putTurn(database, input)),
      nextTurnNumber: (sessionId) => once(() => nextTurnNumber(database, sessionId)),
      listUnclosedTurns: () => once(() => listUnclosedTurns(database))
    },
    version: () => Promise.resolve(version.value),
    shared: () => shared.value,
    hintFolder: hints,
    changed: (sessionId) => changes.push(sessionId),
    markLimitMs: options.limitMs ?? ROOMY
  })
  recorder.setSwitches(new Set([SESSION]))
  const mark: World['mark'] = (edge, extra = {}) => {
    requests += 1
    return recorder.mark({
      sessionId: SESSION, incarnationId: 'i-1', requestId: `r-${requests}`, edge, app, conversation: CONVERSATION, turn: 't-1',
      folder: edge === 'start' ? at.repo : null, until: edge === 'start' ? Date.now() + (options.limitMs ?? ROOMY) : null, kind: null, continued: false, ...extra
    })
  }
  const made: World = {
    at, database, engine, recorder, foreground, version, shared, changes, hints, mark,
    prompt: async (extra = {}) => {
      requests += 1
      const requestId = `p-${requests}`
      const status = await mark('start', { requestId, ...extra })
      if (status !== 'captured' && status !== 'incomplete') return status
      return `${status}, ${await mark('confirm', { requestId, ...extra, folder: null, until: null, continued: false })}`
    },
    end: async (extra = {}) => {
      const status = await mark('end', { kind: 'finished', ...extra })
      await recorder.idle()
      return status
    },
    event: async (event, extra = {}) => {
      recorder.observe({ sessionId: SESSION, app, event, source: null, conversation: CONVERSATION, turn: 't-1', nested: false, ...extra })
      await recorder.idle()
    },
    edit: async (file, content) => {
      write(at.repo, file, content)
      await sleep(25)
    },
    turns: () => listTurns(database, { sessionId: SESSION, limit: 100 }).reverse(),
    staged: () => {
      const folder = join(at.dataRoot, TURN_STORE_FOLDER, SESSION)
      if (!existsSync(folder)) return 0
      return readdirSync(folder).reduce((sum, key) => sum + (existsSync(join(folder, key, 'staging')) ? filesUnder(join(folder, key, 'staging')) : 0), 0)
    }
  }
  worlds.push(made)
  return made
}
afterEach(async () => {
  for (const made of worlds.splice(0)) {
    await made.recorder.idle()
    made.engine.close()
    made.database.close()
    made.at.done()
  }
})

/** A whole turn: prompt, one edit, the end. */
async function turn(w: World, file: string, content: string, extra: Partial<TurnMarkCall> = {}): Promise<void> {
  expect(await w.prompt(extra)).toBe('captured, confirmed')
  await w.edit(file, content)
  expect(await w.end(extra)).toBe('queued')
}

describe('a turn from its prompt to its end', () => {
  it('scans before and after, counts the edit, and keeps the turn provisional until the next prompt runs', async () => {
    const w = world('whole')
    await turn(w, 'a.txt', 'one\ntwo\n')

    const [first] = w.turns()
    expect(first).toMatchObject({
      number: 1, sessionId: SESSION, incarnationId: 'i-1', foreground: AGENT, app: 'codex', appVersion: '0.162.1', conversation: CONVERSATION,
      appTurnId: 't-1', namedFolder: w.at.repo, workTree: w.at.repo, state: 'provisional', endKind: 'finished',
      totalsState: 'complete', totals: { files: 1, added: 2, removed: 0 }, wording: null
    })
    expect(first?.before).not.toBeNull()
    expect(first?.after).not.toBeNull()
    expect(first?.labels).toHaveLength(3)
    expect(first?.labels[0]).toMatch(new RegExp(`^Two scans of ${w.at.repo}, the first from \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d to .*, the second from .* to .*\\. Files in a scan were read at different moments`))
    expect(first?.labels.slice(1)).toEqual([TURN_LABELS.covered(), TURN_LABELS.after()])

    await turn(w, 'b.txt', 'three\n', { turn: 't-2' })
    const [closed, second] = w.turns()
    expect(closed).toMatchObject({ number: 1, state: 'closed', endKind: 'finished', totals: { files: 1, added: 2, removed: 0 } })
    expect(second).toMatchObject({ number: 2, appTurnId: 't-2', state: 'provisional', totals: { files: 1, added: 1, removed: 0 } })
    // The earlier "after" was taken before the next "before", and they are two scans.
    expect(closed?.after).not.toBe(second?.before)
    const scans = w.database.prepare('SELECT capture_id AS id, scan_started_ms AS started, scan_ended_ms AS ended FROM turn_capture').all() as Array<{ id: string; started: number; ended: number }>
    const at = (id: string | null | undefined): { started: number; ended: number } => scans.find((scan) => scan.id === id) as { started: number; ended: number }
    expect(at(second?.before).started).toBeGreaterThanOrEqual(at(closed?.after).ended)
    expect(w.changes).toContain(SESSION)
  })

  it('answers a repeated request id as repeated and changes nothing', async () => {
    const w = world('repeat')
    expect(await w.mark('start', { requestId: 'same' })).toBe('captured')
    expect(await w.mark('start', { requestId: 'same' })).toBe('repeated')
    expect(await w.mark('confirm', { requestId: 'same' })).toBe('confirmed')
    expect(await w.mark('confirm', { requestId: 'same' })).toBe('repeated')
    expect(await w.mark('end', { requestId: 'end-1', kind: 'finished' })).toBe('queued')
    expect(await w.mark('end', { requestId: 'end-1', kind: 'interrupted' })).toBe('repeated')
    await w.recorder.idle()
    expect(w.turns()).toHaveLength(1)
    expect(w.turns()[0]).toMatchObject({ endKind: 'finished', state: 'provisional' })
  })

  it('leaves the turn open at a stop the app continues from, and takes the new id the app gives its own continuation', async () => {
    const w = world('continues', { app: 'claude' })
    expect(await w.prompt()).toBe('captured, confirmed')
    expect(await w.end({ kind: 'continues' })).toBe('queued')
    expect(w.turns()[0]).toMatchObject({ state: 'open', endKind: null })
    await w.edit('late.txt', 'written after the stop\n')
    expect(await w.mark('start', { turn: 't-2', continued: true })).toBe('continued')
    expect(await w.end({ turn: 't-2' })).toBe('queued')
    expect(w.turns()).toHaveLength(1)
    expect(w.turns()[0]).toMatchObject({ appTurnId: 't-2', state: 'provisional', endKind: 'finished', totals: { files: 1, added: 1, removed: 0 } })
  })

  it('changes nothing at a compaction', async () => {
    const w = world('compaction')
    expect(await w.prompt()).toBe('captured, confirmed')
    await w.event('PreCompact')
    await w.event('SessionStart', { source: 'compact' })
    await w.event('PostCompact')
    expect(w.turns()).toHaveLength(1)
    expect(w.turns()[0]).toMatchObject({ state: 'open', conversation: CONVERSATION })
  })

  it('reopens an ended turn at a tool event, drops its "after", and lets a later end take its place', async () => {
    const w = world('reopen')
    await turn(w, 'a.txt', 'one\n')
    const dropped = w.turns()[0]?.after
    await w.event('PostToolUse')
    expect(w.turns()[0]).toMatchObject({ state: 'open', endKind: null, endedAt: null, after: null, totals: null, totalsState: 'none' })
    await w.edit('b.txt', 'two\n')
    expect(await w.end()).toBe('queued')
    const [again] = w.turns()
    expect(again).toMatchObject({ number: 1, state: 'provisional', totals: { files: 2, added: 2, removed: 0 } })
    expect(again?.after).not.toBe(dropped)
    expect(w.turns()).toHaveLength(1)
  })

  it('reopens at a sub-agent\'s tool event, which names a turn of its own', async () => {
    const w = world('nested')
    await turn(w, 'a.txt', 'one\n')
    await w.event('PostToolUse', { turn: 'sub-turn', nested: true })
    expect(w.turns()[0]).toMatchObject({ state: 'open' })
  })

  it('ends a turn as interrupted where the app sends an interrupt', async () => {
    const w = world('interrupt')
    expect(await w.prompt()).toBe('captured, confirmed')
    await w.edit('a.txt', 'half\n')
    expect(await w.end({ kind: 'interrupted' })).toBe('queued')
    expect(w.turns()[0]).toMatchObject({ endKind: 'interrupted', state: 'provisional', totals: { files: 1, added: 1, removed: 0 } })
  })

  it('counts an event of another turn or conversation as stale and changes no turn', async () => {
    const w = world('stale')
    expect(await w.prompt()).toBe('captured, confirmed')
    expect(await w.end({ turn: 'another-turn' })).toBe('queued')
    await w.event('PostToolUse', { conversation: OTHER })
    await w.event('PostToolUse', { turn: 'another-turn' })
    expect(w.recorder.staleEvents).toBe(3)
    expect(w.turns()[0]).toMatchObject({ state: 'open', endKind: null })
  })
})

describe('the confirmation of a "before"', () => {
  it('opens the turn without a "before" when no confirmation comes, and leaves no staged bytes', async () => {
    const w = world('unconfirmed', { limitMs: 400 })
    expect(await w.mark('start')).toBe('captured')
    expect(w.staged()).toBeGreaterThan(0)
    expect(w.turns()).toHaveLength(0)
    await sleep(500)
    await w.recorder.idle()
    expect(w.staged()).toBe(0)
    expect(w.turns()[0]).toMatchObject({ state: 'open', before: null, wording: TURN_WORDINGS.beforeUnavailable(), totalsState: 'none', totals: null })
  })

  it('does the same at once when the connection drops', async () => {
    const w = world('dropped')
    expect(await w.mark('start', { requestId: 'gone' })).toBe('captured')
    w.recorder.dropped(SESSION, 'gone')
    await w.recorder.idle()
    expect(w.staged()).toBe(0)
    expect(w.turns()[0]).toMatchObject({ before: null, wording: TURN_WORDINGS.beforeUnavailable() })
    // A confirmation that comes after all is late.
    expect(await w.mark('confirm', { requestId: 'gone' })).toBe('late')
  })

  it('answers a confirmation after the time of the call as late', async () => {
    const w = world('late-confirm', { limitMs: 300 })
    expect(await w.mark('start', { requestId: 'slow' })).toBe('captured')
    await sleep(350)
    expect(await w.mark('confirm', { requestId: 'slow' })).toBe('late')
    await w.recorder.idle()
    expect(w.staged()).toBe(0)
    expect(w.turns()[0]).toMatchObject({ before: null, wording: TURN_WORDINGS.beforeUnavailable() })
  })

  it('takes a tool event before the confirmation as the app not waiting', async () => {
    const w = world('did-not-wait')
    expect(await w.mark('start', { requestId: 'early' })).toBe('captured')
    await w.event('PostToolUse')
    expect(w.staged()).toBe(0)
    expect(w.turns()[0]).toMatchObject({ before: null, wording: TURN_WORDINGS.beforeUnavailable() })
    expect(await w.mark('confirm', { requestId: 'early' })).toBe('late')
  })

  it('cancels a capture that passes the time of the call, answers late, and lets the prompt go on inside that time', async () => {
    const slow = (port: TurnChangesPort): TurnChangesPort => ({
      ...port,
      capture: async (request, signal) => {
        if (!request.publish) await sleep(250)
        return port.capture(request, signal)
      }
    })
    const w = world('budget', { port: slow, limitMs: 120 })
    const asked = Date.now()
    expect(await w.mark('start')).toBe('late')
    expect(Date.now() - asked).toBeLessThan(300)
    await sleep(350)
    await w.recorder.idle()
    expect(w.staged()).toBe(0)
    expect(w.turns()[0]).toMatchObject({ before: null, wording: TURN_WORDINGS.beforeUnavailable(), totals: null })
    // The end still scans, and that scan is the turn's only one: no totals.
    expect(await w.end()).toBe('queued')
    expect(w.turns()[0]).toMatchObject({ state: 'provisional', before: null, wording: TURN_WORDINGS.beforeUnavailable(), totals: null })
    expect(w.turns()[0]?.after).not.toBeNull()
  })

  it('answers a mark whose time has already passed as late', async () => {
    const w = world('passed')
    expect(await w.mark('start', { until: Date.now() - 1 })).toBe('late')
    expect(w.turns()[0]).toMatchObject({ before: null, wording: TURN_WORDINGS.beforeUnavailable() })
  })
})

describe('the version of the app', () => {
  it.each([
    ['0.170.0', TURN_WORDINGS.orderingUnverified('Codex', '0.170.0'), TURN_LABELS.version('Codex', '0.170.0', '0.162.1')],
    [null, TURN_WORDINGS.orderingUnverified('Codex', '(version not read)'), TURN_LABELS.version('Codex', '(version not read)', '0.162.1')]
  ])('records a turn on version %s with totals that are not complete', async (version, wording, label) => {
    const w = world('version')
    w.version.value = version
    await turn(w, 'a.txt', 'one\n')
    const [first] = w.turns()
    expect(first).toMatchObject({ appVersion: version, wording, totalsState: 'not-complete', totals: { files: 1, added: 1, removed: 0 } })
    expect(first?.labels).toContain(label)
  })

  it('reads the version only from an answer of the app itself', () => {
    expect(turnAppVersion('claude', '2.1.296 (Claude Code)\n')).toBe('2.1.296')
    expect(turnAppVersion('codex', 'codex-cli 0.162.1\n')).toBe('0.162.1')
    expect(turnAppVersion('claude', 'v24.14.0\n')).toBeNull()
    expect(turnAppVersion('codex', '2.1.296 (Claude Code)\n')).toBeNull()
    expect(turnAppVersion('opencode', '1.19.0\n')).toBeNull()
  })

  /** A made-up process table: BMN itself and one process, each with what Linux says confines it. */
  const processes = (name: string, other: { namespace?: string; privileges?: number; filter?: number } = {}): { root: string; identity: string; done: () => void } => {
    const at = scratch(name, { commit: false })
    const root = join(at.base, 'proc')
    const put = (pid: string, namespace: string, privileges: number, filter: number): void => {
      mkdirSync(join(root, pid, 'ns'), { recursive: true })
      writeFileSync(join(root, pid, 'status'), `Name:\tmade-up\nNoNewPrivs:\t${privileges}\nSeccomp:\t${filter}\nSeccomp_filters:\t0\n`)
      symlinkSync(namespace, join(root, pid, 'ns', 'mnt'))
      writeFileSync(join(root, pid, 'exe'), '')
    }
    put('self', 'mnt:[4026531832]', 0, 0)
    put('7001', other.namespace ?? 'mnt:[4026531832]', other.privileges ?? 0, other.filter ?? 0)
    const program = statSync(join(root, '7001', 'exe'), { bigint: true })
    return { root, identity: `34817:7001:555:${program.dev}:${program.ino}`, done: at.done }
  }

  it('asks only the program of a process as free as BMN itself', () => {
    const free = processes('ask-free')
    const elsewhere = processes('ask-namespace', { namespace: 'mnt:[4026532999]' })
    const landlocked = processes('ask-privileges', { privileges: 1 })
    const filtered = processes('ask-filter', { filter: 2 })
    try {
      expect(mayAskProgram(free.identity, free.root)).toBe(true)
      // Another view of the file system, new privileges given up (Landlock asks for that), a system-call filter:
      // each may be a sandbox, and a program BMN starts would run outside it.
      expect(mayAskProgram(elsewhere.identity, elsewhere.root)).toBe(false)
      expect(mayAskProgram(landlocked.identity, landlocked.root)).toBe(false)
      expect(mayAskProgram(filtered.identity, filtered.root)).toBe(false)
      // The program is no longer the file the identity names, the process is gone, or the identity names none.
      expect(mayAskProgram(free.identity.replace(/:\d+$/, ':1'), free.root)).toBe(false)
      expect(mayAskProgram('34817:7002:555:1:2', free.root)).toBe(false)
      expect(mayAskProgram('34817:0:555:1:2', free.root)).toBe(false)
      expect(mayAskProgram('', free.root)).toBe(false)
    } finally {
      for (const made of [free, elsewhere, landlocked, filtered]) made.done()
    }
  })

  it('takes no version from a program that is not the app, and asks nothing of a process the identity does not name', async () => {
    const program = statSync(`/proc/${process.pid}/exe`, { bigint: true })
    // This very test process: its program answers `--version` in Node's words, which are neither app's.
    expect(await readAppVersion(`0:${process.pid}:0:${program.dev}:${program.ino}`, 'codex')).toBeNull()
    expect(await readAppVersion(`0:${process.pid}:0:${program.dev}:${program.ino}`, 'opencode')).toBeNull()
    expect(await readAppVersion(`0:${process.pid}:0:1:2`, 'codex')).toBeNull()
  })

  it('names the programs a foreground process started itself and that still share the terminal\'s foreground with it', () => {
    const at = scratch('started-programs', { commit: false })
    const root = join(at.base, 'proc')
    const put = (pid: number, parent: number, group: number, tty: number, start: number, state = 'S'): void => {
      mkdirSync(join(root, String(pid)), { recursive: true })
      // What Linux writes: the name may hold spaces and brackets, the fields after its last bracket are fixed.
      writeFileSync(join(root, String(pid), 'stat'), `${pid} (made (up)) ${state} ${parent} ${group} ${group} ${tty} ${group} 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`)
      writeFileSync(join(root, String(pid), 'exe'), '')
    }
    try {
      // 7001 is a launcher with two threads. One started the app's own program (7005), a job in a group of its
      // own (7003) and a process that is gone (7009); the other a stopped one (7004) and one on another terminal (7006).
      for (const [task, children] of [['7001', '7005 7003 7009 7007 '], ['7002', '7004 7006 ']] as const) {
        mkdirSync(join(root, '7001', 'task', task), { recursive: true })
        writeFileSync(join(root, '7001', 'task', task, 'children'), children)
      }
      put(7005, 7001, 7001, 34817, 900)
      put(7003, 7001, 7003, 34817, 901)
      put(7004, 7001, 7001, 34817, 902, 'T')
      put(7006, 7001, 7001, 34999, 903)
      // Listed as a child, but its parent is another process by now.
      put(7007, 1, 7001, 34817, 904)
      const program = statSync(join(root, '7005', 'exe'), { bigint: true })
      expect(startedPrograms('34817:7001:555:1:2', root)).toEqual([`34817:7005:900:${program.dev}:${program.ino}`])
      // A process that started nothing, one that is gone, and an identity that names none.
      expect(startedPrograms('34817:7005:900:1:2', root)).toEqual([])
      expect(startedPrograms('34817:7999:555:1:2', root)).toEqual([])
      expect(startedPrograms('34817:0:555:1:2', root)).toEqual([])
      expect(startedPrograms('', root)).toEqual([])
      // At most eight, the lowest process ids first.
      mkdirSync(join(root, '8000', 'task', '8000'), { recursive: true })
      const many = Array.from({ length: 11 }, (_unused, at) => 8111 - at)
      writeFileSync(join(root, '8000', 'task', '8000', 'children'), `${many.join(' ')} `)
      for (const pid of many) put(pid, 8000, 8000, 34817, pid)
      expect(startedPrograms('34817:8000:555:1:2', root).map((identity) => Number(identity.split(':')[1]))).toEqual([8101, 8102, 8103, 8104, 8105, 8106, 8107, 8108])
    } finally {
      at.done()
    }
  })

  it('asks the programs a launcher started when the launcher\'s own answer is not the app\'s', async () => {
    const asked: string[] = []
    const answers: Record<string, string> = { leader: 'v24.14.0\n', tool: 'ripgrep 14.1.0\n', real: 'codex-cli 0.162.1\n' }
    /** `listed` is what the launcher's own children are at each look: before the questions, then after an answer. */
    const seams = (...listed: string[][]): VersionSeams => {
      let look = 0
      return {
        ask: async (identity) => { asked.push(identity); return answers[identity] ?? null },
        started: () => listed[Math.min(look++, listed.length - 1)] ?? []
      }
    }
    // Codex from npm: Node answers for the launcher, the native program for the launcher's child.
    expect(await readAppVersion('leader', 'codex', 2_000, seams(['tool', 'real']))).toBe('0.162.1')
    expect(asked).toEqual(['leader', 'tool', 'real'])
    // An app that answers for itself is asked alone.
    asked.length = 0
    expect(await readAppVersion('real', 'codex', 2_000, seams(['tool']))).toBe('0.162.1')
    expect(asked).toEqual(['real'])
    // No answer is the app's; the program that answered is no longer the launcher's own; the answer is another app's.
    expect(await readAppVersion('leader', 'codex', 2_000, seams(['tool', 'gone']))).toBeNull()
    expect(await readAppVersion('leader', 'codex', 2_000, seams(['real'], []))).toBeNull()
    expect(await readAppVersion('leader', 'claude', 2_000, seams(['real']))).toBeNull()
    // The time is one for all the questions: with none left, a started program is not asked.
    asked.length = 0
    expect(await readAppVersion('leader', 'codex', 0, seams(['real']))).toBeNull()
    expect(asked).toEqual(['leader'])
  })
})

describe('a prompt while a turn is open', () => {
  it.each([['t-1'], [null]])('closes the open turn of an app whose prompt event comes when the prompt is taken (turn id %s)', async (id) => {
    const w = world('taken')
    expect(await w.prompt({ turn: id })).toBe('captured, confirmed')
    await w.edit('a.txt', 'one\n')
    expect(await w.prompt({ turn: id })).toBe('captured, confirmed')
    await w.recorder.idle()
    const [first, second] = w.turns()
    expect(first).toMatchObject({ state: 'closed', endKind: 'not-observed', totalsState: 'complete', totals: { files: 1, added: 1, removed: 0 }, wording: null })
    expect(first?.labels).toContain(TURN_LABELS.endNotObserved())
    // Compared through the next prompt's "before": one scan, two turns.
    expect(first?.after).toBe(second?.before)
    expect(second).toMatchObject({ number: 2, state: 'open' })
  })

  it.each([['t-1'], [null]])('gives every prompt typed into a running turn a record of its own, all without totals (turn id %s)', async (id) => {
    const w = world('typed', { app: 'claude' })
    expect(await w.prompt({ turn: id })).toBe('captured, confirmed')
    expect(await w.mark('start', { turn: id })).toBe('overlapped')
    expect(await w.mark('start', { turn: id })).toBe('overlapped')
    await w.edit('a.txt', 'one\n')
    expect(await w.end({ turn: id })).toBe('queued')
    const turns = w.turns()
    expect(turns.map((row) => row.number)).toEqual([1, 2, 3])
    for (const row of turns) {
      expect(row).toMatchObject({ state: 'provisional', endKind: 'finished', wording: TURN_WORDINGS.overlapped(), totalsState: 'none', totals: null })
    }
    expect(w.staged()).toBe(0)
  })

  it('reads a new turn id in an app that sends nothing for an interrupt as the earlier turn ended unseen', async () => {
    const w = world('unseen', { app: 'claude' })
    expect(await w.prompt({ turn: 't-1' })).toBe('captured, confirmed')
    await w.edit('a.txt', 'one\n')
    expect(await w.prompt({ turn: 't-2' })).toBe('captured, confirmed')
    await w.recorder.idle()
    const [first, second] = w.turns()
    expect(first).toMatchObject({ state: 'closed', endKind: 'not-observed', totals: { files: 1, added: 1, removed: 0 } })
    expect(first?.after).toBe(second?.before)
  })
})

describe('an end nobody told', () => {
  const ends: Array<[string, (w: World) => Promise<void>]> = [
    ['/clear or /resume', (w) => w.event('SessionStart', { source: 'clear', conversation: OTHER, turn: null })],
    ['the conversation ending', (w) => w.event('SessionEnd', { turn: null })],
    ['another foreground agent', async (w) => {
      w.foreground.identity = '34817:7200:999:1:2'
      await w.event('PostToolUse', { conversation: OTHER })
    }],
    ['the session ending', async (w) => {
      w.foreground.identity = null
      w.recorder.sessionEnded(SESSION)
      await w.recorder.idle()
    }]
  ]

  it.each(ends)('takes one last scan of the turn\'s root at %s while the folder is the same', async (_name, close) => {
    const w = world('last-scan')
    expect(await w.prompt()).toBe('captured, confirmed')
    await w.edit('a.txt', 'one\n')
    await close(w)
    const [first] = w.turns()
    expect(first).toMatchObject({ state: 'closed', endKind: 'not-observed', totalsState: 'complete', totals: { files: 1, added: 1, removed: 0 }, wording: null })
    expect(first?.labels).toContain(TURN_LABELS.endNotObserved())
  })

  it.each(ends)('takes none at %s when another folder stands where the root was', async (_name, close) => {
    const w = world('swapped')
    expect(await w.prompt()).toBe('captured, confirmed')
    renameSync(w.at.repo, `${w.at.repo}-moved`)
    mkdirSync(w.at.repo)
    w.at.git(w.at.repo, 'init', '-q', '-b', 'main')
    write(w.at.repo, 'other.txt', 'not the turn\'s\n')
    await close(w)
    const [first] = w.turns()
    expect(first).toMatchObject({ state: 'closed', endKind: 'not-observed', after: null, totalsState: 'none', totals: null, wording: TURN_WORDINGS.finalScanUnavailable() })
  })

  it('never uses the root of a new foreground agent for an old turn', async () => {
    const w = world('new-agent')
    const elsewhere = scratch('new-agent-elsewhere')
    try {
      expect(await w.prompt()).toBe('captured, confirmed')
      await w.edit('a.txt', 'one\n')
      w.foreground.identity = '34817:7300:1000:1:2'
      w.foreground.folder = elsewhere.repo
      expect(await w.prompt({ conversation: OTHER, folder: elsewhere.repo })).toBe('captured, confirmed')
      await w.recorder.idle()
      const [first, second] = w.turns()
      expect(first).toMatchObject({ workTree: w.at.repo, endKind: 'not-observed', totals: { files: 1, added: 1, removed: 0 } })
      expect(second).toMatchObject({ workTree: elsewhere.repo, foreground: '34817:7300:1000:1:2' })
      expect(first?.after).not.toBe(second?.before)
    } finally {
      await w.recorder.idle()
      elsewhere.done()
    }
  })

  it('closes a turn stored as open at a start, and keeps what an ended one already had', async () => {
    const w = world('restart')
    await turn(w, 'a.txt', 'one\n')
    expect(await w.prompt({ turn: 't-2' })).toBe('captured, confirmed')
    await w.recorder.idle()
    w.database.prepare("UPDATE turn_record SET state = 'provisional' WHERE number = 1").run()
    await w.recorder.start()
    const [first, second] = w.turns()
    expect(first).toMatchObject({ state: 'closed', endKind: 'finished', totals: { files: 1, added: 1, removed: 0 }, wording: null })
    expect(second).toMatchObject({ state: 'closed', endKind: 'not-observed', totals: null, totalsState: 'none', wording: TURN_WORDINGS.finalScanUnavailable() })
  })
})

describe('what a turn says', () => {
  it('says that HEAD moved, that the work tree is shared, and how many files were not counted', async () => {
    const w = world('labels', { limits: { fileBytes: 64 } })
    w.shared.value = true
    expect(await w.prompt()).toBe('captured, confirmed')
    await w.edit('a.txt', 'one\n')
    write(w.at.repo, 'big.txt', 'x'.repeat(200))
    w.at.git(w.at.repo, 'add', 'a.txt')
    w.at.git(w.at.repo, 'commit', '-qm', 'made-up second')
    await sleep(25)
    expect(await w.end()).toBe('queued')
    const [first] = w.turns()
    expect(first).toMatchObject({ totalsState: 'partial', wording: TURN_WORDINGS.partial(1) })
    expect(first?.labels).toContain(TURN_LABELS.sharedWorkTree())
    expect(first?.labels).toContain(TURN_LABELS.partial(1))
    expect(first?.labels.some((label) => /^HEAD was [0-9a-f]{12} when the first scan began and [0-9a-f]{12} when it ended, [0-9a-f]{12} and [0-9a-f]{12} for the second/.test(label))).toBe(true)
  })

  it('says "Incomplete" with the bound a scan met', async () => {
    const w = world('incomplete', { limits: { readBytes: 8 } })
    write(w.at.repo, 'more.txt', 'longer than eight bytes\n')
    await sleep(25)
    expect(await w.prompt()).toBe('incomplete, confirmed')
    expect(await w.end()).toBe('queued')
    const [first] = w.turns()
    expect(first?.wording).toMatch(/^Incomplete: .+ read$/)
    expect(first).toMatchObject({ totalsState: 'none', totals: null })
  })

  it('says "Not supported here" with the fixed reason', async () => {
    const w = world('unsupported')
    mkdirSync(join(w.at.repo, 'inner'))
    const inside = world('unsupported-inner')
    try {
      // The data root of this second recorder lies in the work tree it is asked to scan.
      const engine = new TurnChangesEngine({ dataRoot: join(w.at.repo, 'inner', 'data'), home: w.at.home })
      const recorder = new TurnRecorder({
        ...inside.recorder['options'], port: inProcessPort(engine),
        foreground: { identity: () => AGENT, folder: () => w.at.repo }, hintFolder: join(w.at.base, 'hints-2')
      })
      recorder.setSwitches(new Set([SESSION]))
      const status = await recorder.mark({
        sessionId: SESSION, incarnationId: 'i-1', requestId: 'n-1', edge: 'start', app: 'codex', conversation: CONVERSATION, turn: 't-1',
        folder: w.at.repo, until: Date.now() + ROOMY, kind: null, continued: false
      })
      await recorder.idle()
      expect(status).toBe('not-supported')
      expect(inside.turns()[0]).toMatchObject({ before: null, totals: null, wording: TURN_WORDINGS.notSupported("this work tree holds BMN's data folder") })
      engine.close()
    } finally {
      await inside.recorder.idle()
    }
  })

  it('says "Difference unavailable: limit reached" when the comparison meets its limit', async () => {
    const w = world('limit', { port: (port) => ({ ...port, compare: () => Promise.resolve(refusal('unavailable', 'Difference unavailable: limit reached')) }) })
    await turn(w, 'a.txt', 'one\n')
    expect(w.turns()[0]).toMatchObject({ totalsState: 'none', totals: null, wording: TURN_WORDINGS.limitReached() })
  })

  it('writes a label\'s time as this computer\'s own date and time', () => {
    const at = new Date(2026, 9, 13, 7, 5, 9).getTime()
    expect(turnLabelTime(at)).toBe('2026-10-13 07:05:09')
  })
})

describe('the pause', () => {
  it('pauses a session\'s root after three scans in a row that failed, says so to the window only, and goes on after Resume', async () => {
    const w = world('pause')
    // The agent stands in a folder that is no repository: every scan fails.
    w.foreground.folder = w.at.base
    for (const id of ['t-1', 't-2', 't-3']) expect(await w.prompt({ turn: id, folder: w.at.base })).toBe('unavailable')
    await w.recorder.idle()
    expect(w.turns().map((row) => row.wording)).toEqual([1, 2, 3].map(() => TURN_WORDINGS.beforeUnavailable()))
    expect(w.recorder.states()).toEqual([{ sessionId: SESSION, state: 'paused', app: 'codex', pausedRoot: w.at.base, pauseReason: 'failed' }])
    expect(Object.keys(TURN_PAUSE_REASONS)).toContain('failed')

    expect(await w.prompt({ turn: 't-4', folder: w.at.base })).toBe('paused')
    await w.recorder.idle()
    expect(w.turns()).toHaveLength(3)

    expect(w.recorder.resume(SESSION)).toBe(true)
    expect(w.recorder.states()).toEqual([{ sessionId: SESSION, state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null }])
    w.foreground.folder = w.at.repo
    expect(await w.prompt({ turn: 't-5' })).toBe('captured, confirmed')
    expect(w.turns()).toHaveLength(4)
  })

  it('counts incomplete scans that read nothing new, and not the one that read on', async () => {
    const w = world('pause-incomplete', { limits: { readBytes: 8 } })
    // Git lists untracked files first, by name: the small one is read, the long one never fits.
    write(w.at.repo, 'a.txt', 'a\n')
    write(w.at.repo, 'more.txt', 'longer than eight bytes\n')
    await sleep(25)
    // The first scan reads the small file and keeps it: it got further, so it is not one of the three.
    expect(await w.prompt()).toBe('incomplete, confirmed')
    // The next three find the same file in their way and read nothing new.
    expect(await w.end()).toBe('queued')
    expect(await w.prompt({ turn: 't-2' })).toBe('incomplete, confirmed')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording' })
    expect(await w.end({ turn: 't-2' })).toBe('queued')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'paused', pausedRoot: w.at.repo, pauseReason: 'incomplete' })
    expect(TURN_PAUSE_REASONS.incomplete).toBe('Three scans in a row were incomplete and read nothing new')
  })

  it('never pauses a big work tree whose scans each read on: two turns read "Incomplete", the third has its totals', async () => {
    // A scan may read 16 bytes and the tree holds five files of 10 and one of 2: whole at the fifth scan.
    const w = world('pause-read-on', { limits: { readBytes: 16 } })
    for (const name of ['a', 'b', 'c', 'd', 'e']) write(w.at.repo, `${name}.txt`, 'nine byte\n')
    await sleep(25)
    expect(await w.prompt()).toBe('incomplete, confirmed')
    expect(await w.end()).toBe('queued')
    expect(await w.prompt({ turn: 't-2' })).toBe('incomplete, confirmed')
    expect(await w.end({ turn: 't-2' })).toBe('queued')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording', pausedRoot: null })
    expect(await w.prompt({ turn: 't-3' })).toBe('captured, confirmed')
    await w.edit('new.txt', 'x\n')
    expect(await w.end({ turn: 't-3' })).toBe('queued')
    const rows = w.turns()
    expect(rows.slice(0, 2).map((row) => [row.totals, /^Incomplete: .+ read$/.test(row.wording ?? '')])).toEqual([[null, true], [null, true]])
    expect(rows[2]).toMatchObject({ totalsState: 'complete', totals: { files: 1, added: 1, removed: 0 }, wording: null })
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording', pausedRoot: null })
  })

  it('still pauses when a failed scan follows incomplete ones that read on', async () => {
    const w = world('pause-mixed', { limits: { readBytes: 8 } })
    write(w.at.repo, 'a.txt', 'a\n')
    write(w.at.repo, 'more.txt', 'longer than eight bytes\n')
    await sleep(25)
    expect(await w.prompt()).toBe('incomplete, confirmed')
    expect(await w.end()).toBe('queued')
    expect(await w.prompt({ turn: 't-2' })).toBe('incomplete, confirmed')
    // The folder is no longer the one that was scanned: the turn's last scan fails, the third in the row.
    renameSync(w.at.repo, join(w.at.base, 'moved'))
    mkdirSync(w.at.repo)
    expect(await w.end({ turn: 't-2' })).toBe('queued')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'paused', pausedRoot: w.at.repo, pauseReason: 'mixed' })
  })
})

describe('the switch', () => {
  it('writes down for the hook which sessions record, and takes the word back when the switch goes off', () => {
    const w = world('hints')
    expect(readdirSync(w.hints)).toEqual([SESSION])
    w.recorder.setSwitches(new Set([SESSION, 's-two']))
    expect(readdirSync(w.hints).sort()).toEqual([SESSION, 's-two'])
    w.recorder.setSwitches(new Set())
    expect(readdirSync(w.hints)).toEqual([])
    expect(w.recorder.states()).toEqual([])
  })

  it('closes an open turn as switched off, without totals, when the switch goes off or the session moves away from it', async () => {
    const w = world('switched-off')
    expect(await w.prompt()).toBe('captured, confirmed')
    await w.edit('a.txt', 'one\n')
    w.recorder.setSwitches(new Set())
    await w.recorder.idle()
    expect(w.turns()[0]).toMatchObject({ state: 'closed', endKind: 'switched-off', after: null, totals: null, totalsState: 'none', wording: TURN_WORDINGS.switchedOff() })
    // With the switch off a mark is answered "off" and nothing is recorded.
    expect(await w.mark('start', { turn: 't-2' })).toBe('off')
    expect(await w.mark('end', { turn: 't-2', kind: 'finished' })).toBe('off')
    await w.event('PostToolUse')
    expect(w.turns()).toHaveLength(1)
    expect(w.staged()).toBe(0)
  })

  it('answers an app that is not recorded as not supported', async () => {
    const w = world('unrecorded', { app: 'opencode' })
    expect(await w.mark('start')).toBe('not-supported')
    expect(await w.mark('end', { kind: 'finished' })).toBe('not-supported')
    expect(w.turns()).toHaveLength(0)
  })

  it('records nothing when the terminal has no foreground agent', async () => {
    const w = world('no-agent')
    w.foreground.identity = null
    expect(await w.mark('start')).toBe('unavailable')
    expect(w.turns()).toHaveLength(0)
  })
})

describe('the app now running (Story 69.5)', () => {
  it('reads "not supported" for an app BMN does not record while that program holds the terminal, and no longer once it has gone', async () => {
    const w = world('app-now')
    await turn(w, 'a.txt', 'one\n')
    expect(w.recorder.states()).toEqual([{ sessionId: SESSION, state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null }])

    // Another program takes the terminal; until its own hook speaks nothing is known of it.
    w.foreground.identity = '34817:7002:900:1:3'
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording', app: null })
    const told = w.changes.length
    w.recorder.seen(SESSION, 'opencode')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'not-supported', app: 'opencode' })
    expect(w.changes.slice(told)).toEqual([SESSION])
    // The same word again tells the window nothing new.
    w.recorder.seen(SESSION, 'opencode')
    expect(w.changes).toHaveLength(told + 1)

    // That program ends: an old name is not said of whatever runs there next.
    w.foreground.identity = null
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording', app: null })
    w.recorder.seen(SESSION, 'opencode')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording', app: null })
    w.foreground.identity = AGENT
    w.recorder.seen(SESSION, 'codex')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording', app: 'codex' })
    // Its turn of before is still the session's only one.
    expect(w.turns()).toHaveLength(1)
  })

  it('says paused before anything else, and hears nothing of a session whose switch is off', async () => {
    const w = world('app-paused')
    w.foreground.folder = w.at.base
    for (const turnId of ['t-1', 't-2', 't-3']) expect(await w.prompt({ turn: turnId, folder: w.at.base })).toBe('unavailable')
    w.recorder.seen(SESSION, 'opencode')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'paused', app: 'opencode', pauseReason: 'failed' })

    w.recorder.setSwitches(new Set())
    w.recorder.seen(SESSION, 'opencode')
    expect(w.recorder.states()).toEqual([])
  })
})
