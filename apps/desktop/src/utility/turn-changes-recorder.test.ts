// MODULE: turn-changes-recorder.test.ts - every move of a turn on a real store, a real database and made-up repositories: the confirmation, the ends, overlapping prompts, the last scan, the wordings and labels, the pause, the switch and a restart
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TURN_LABELS, TURN_PAUSE_REASONS, TURN_RETRY_AFTER_MS, TURN_RETRY_MAX_MS, TURN_WORDINGS } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { listTurns, listUnclosedTurns, nextTurnNumber, putTurn, type TurnRow } from './database-turn-store'
import { DEFAULT_WORKSPACE_ID } from './store-schema'
import { refusal, type CaptureSeams, type TurnLimits } from './turn-changes-capture'
import { TurnChangesClient } from './turn-changes-client'
import { TurnChangesEngine, inProcessKeeper, inProcessPort, type TurnCaptureRequest, type TurnChangesPort } from './turn-changes-engine'
import { TurnRecorder, turnLabelTime, turnPausesFile, type TurnMarkCall, type TurnObservation, type TurnRecorderOptions } from './turn-changes-recorder'
import { TURN_STORE_FOLDER } from './turn-changes-store'
import { readAppVersion, type VersionPlaces } from './turn-changes-version'
import { filesUnder, scratch, sleep, write, type Place } from './test-fixtures/turn-changes/fixtures'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const CONVERSATION = '01a0b657-21a8-7f00-addd-b73646828f5b'
const OTHER = '11a0b657-21a8-7f00-addd-b73646828f5b'
const SESSION = 's-one'
const here = dirname(fileURLToPath(import.meta.url))
const AGENT = '34817:7001:555:1:2'
/** Generous for a loaded machine; the tests of the limit give their own. */
const ROOMY = 5_000

interface World {
  at: Place
  database: DatabaseConnection
  engine: TurnChangesEngine
  recorder: TurnRecorder
  foreground: { identity: string | null; folder: string }
  version: { value: string | null; calls: number }
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
function world(name: string, options: { app?: string; limits?: Partial<TurnLimits>; port?: (port: TurnChangesPort, at: Place) => TurnChangesPort; limitMs?: number; defer?: (work: () => void) => void; now?: () => number; pauses?: TurnRecorderOptions['pauses'] } = {}): World {
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
  const version: World['version'] = { value: app === 'codex' ? '0.162.1' : '2.1.296', calls: 0 }
  const shared = { value: false }
  const changes: Array<string | null> = []
  const hints = join(at.base, 'hints')
  const once = <Result>(work: () => Result): Promise<Result> => Promise.resolve(database.transaction(work)())
  const port = inProcessPort(engine)
  const recorder = new TurnRecorder({
    port: options.port ? options.port(port, at) : port,
    keeper: inProcessKeeper(engine),
    foreground: { identity: () => foreground.identity, folder: (identity) => (identity === foreground.identity ? foreground.folder : null) },
    database: {
      putTurn: (input) => once(() => putTurn(database, input)),
      nextTurnNumber: (sessionId) => once(() => nextTurnNumber(database, sessionId)),
      listUnclosedTurns: () => once(() => listUnclosedTurns(database))
    },
    version: () => {
      version.calls += 1
      return version.value
    },
    ...(options.defer ? { defer: options.defer } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.pauses ? { pauses: options.pauses } : {}),
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
const clients: TurnChangesClient[] = []
afterEach(async () => {
  for (const made of worlds) await made.recorder.idle()
  for (const client of clients.splice(0)) await client.close()
  for (const made of worlds.splice(0)) {
    made.engine.close()
    made.database.close()
    made.at.done()
  }
})

/** A world whose captures are held where a test says: its port asks the engine itself, as the in-process port does, with these seams. */
function seamed(name: string, seams: (request: TurnCaptureRequest) => CaptureSeams, options: { limits?: Partial<TurnLimits>; limitMs?: number } = {}): World {
  const made: World = world(name, {
    ...options,
    port: (port) => ({
      ...port,
      capture: (request, signal) => {
        const cancel = (): void => made.engine.cancel(request.job)
        signal?.addEventListener('abort', cancel, { once: true })
        return made.engine.capture(request, seams(request)).finally(() => signal?.removeEventListener('abort', cancel))
      }
    })
  })
  return made
}

// The worker is the product's own file, run by plain Node.
const WORKER = join(here, 'turn-changes-worker.ts')
const RESOLVE = pathToFileURL(join(here, 'test-fixtures/turn-changes/ts-resolve.mjs')).href

/** A world whose captures and publications run in the real worker thread; `held` runs on this thread right after a publication was asked for. */
function inWorker(name: string, held: (w: World) => void, options: { now?: () => number } = {}): World {
  let made: World | null = null
  made = world(name, {
    ...options,
    port: (_port, at) => {
      const client = new TurnChangesClient(WORKER, { dataRoot: at.dataRoot, home: at.home }, { execArgv: ['--import', RESOLVE] })
      clients.push(client)
      return {
        capture: (request, signal) => client.capture(request, signal),
        publish: (capture, until, signal) => {
          const asked = client.publish(capture, until, signal)
          held(made as World)
          return asked
        },
        discard: (capture) => client.discard(capture),
        compare: (request, signal) => client.compare(request, signal),
        difference: (request, signal) => client.difference(request, signal)
      }
    }
  })
  return made
}

/** This thread is held: none of its timers fires and no message reaches it meanwhile. */
function busy(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Held.
  }
}

async function eventually(check: () => boolean, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) return false
    await sleep(10)
  }
  return true
}

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

  /** What a "before" leaves whose publication was stopped: no capture, no byte under the stores, and a turn that goes on without it. */
  const keptNothing = async (w: World): Promise<void> => {
    await w.recorder.idle()
    const store = w.engine.store(SESSION, w.at.repo)
    await store.settled()
    expect(store.captures()).toEqual([])
    // In the worker thread its bytes go after the answer: a moment later.
    expect(await eventually(() => filesUnder(join(w.at.dataRoot, TURN_STORE_FOLDER)) === 0)).toBe(true)
    expect(w.turns()[0]).toMatchObject({ state: 'open', before: null, wording: TURN_WORDINGS.beforeUnavailable(), totals: null })
    // The turn goes on: its end still scans, and that scan is its only one.
    expect(await w.end()).toBe('queued')
    expect(w.turns()[0]).toMatchObject({ state: 'provisional', before: null, wording: TURN_WORDINGS.beforeUnavailable(), totals: null })
    expect(w.turns()[0]?.after).not.toBeNull()
  }

  it('stops the publication of a confirmed "before" when the time of its call passes meanwhile: the answer is late and nothing of it is kept', async () => {
    // The confirmation comes in time. The publication is held at its third file until the time of the call is over.
    const w = seamed('confirm-past-time', (request) => (request.publish ? {} : { beforeMove: (moved) => (moved === 2 ? sleep(450) : undefined) }), { limitMs: 300 })
    for (let n = 0; n < 6; n += 1) write(w.at.repo, `f${n}.txt`, `content ${n}\n`)
    await sleep(25)
    expect(await w.mark('start', { requestId: 'held' })).toBe('captured')
    expect(await w.mark('confirm', { requestId: 'held' })).toBe('late')
    await keptNothing(w)
  })

  it('stops it too when the connection drops while it is published', async () => {
    let reached = (): void => undefined
    const moving = new Promise<void>((resolve) => {
      reached = resolve
    })
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = seamed('confirm-dropped', (request) => (request.publish ? {} : {
      beforeMove: async (moved) => {
        if (moved !== 2) return
        reached()
        await held
      }
    }))
    for (let n = 0; n < 6; n += 1) write(w.at.repo, `f${n}.txt`, `content ${n}\n`)
    await sleep(25)
    expect(await w.mark('start', { requestId: 'gone' })).toBe('captured')
    const answer = w.mark('confirm', { requestId: 'gone' })
    await moving
    w.recorder.dropped(SESSION, 'gone')
    release()
    expect(await answer).toBe('late')
    await keptNothing(w)
  })

  it('has the worker itself stop a confirmed "before" whose call\'s time passes while this thread is held, so that no timer of it can fire', async () => {
    let skew = 0
    const asked: number[] = []
    // This thread is held for 300 ms right after it asked for the publication, which takes about 60 ms.
    const w = inWorker('worker-held-past-time', () => {
      asked.push(Date.now())
      busy(300)
    }, { now: () => Date.now() + skew })
    for (let n = 0; n < 3_000; n += 1) write(w.at.repo, `d${n % 40}/f${n}.txt`, `content ${n}\n`)
    await sleep(25)
    const until = Date.now() + 4_000
    expect(await w.mark('start', { requestId: 'held', until })).toBe('captured')
    expect(w.staged()).toBeGreaterThan(3_000)
    // The confirmation comes 10 ms before the call's time is over, as this thread counts it.
    skew = until - 10 - Date.now()
    expect(await w.mark('confirm', { requestId: 'held' })).toBe('late')
    // It was asked for, inside the time: the stop came from the worker.
    expect(asked).toHaveLength(1)
    await keptNothing(w)
  }, 30_000)

  it('has the worker hear a dropped connection through the word it reads at every step, while this thread is held after the drop', async () => {
    const asked: number[] = []
    const w = inWorker('worker-held-dropped', (made) => {
      asked.push(Date.now())
      made.recorder.dropped(SESSION, 'gone')
      busy(300)
    })
    for (let n = 0; n < 3_000; n += 1) write(w.at.repo, `d${n % 40}/f${n}.txt`, `content ${n}\n`)
    await sleep(25)
    expect(await w.mark('start', { requestId: 'gone' })).toBe('captured')
    expect(await w.mark('confirm', { requestId: 'gone' })).toBe('late')
    expect(asked).toHaveLength(1)
    await keptNothing(w)
  }, 30_000)

  it('answers a mark whose time has already passed as late', async () => {
    const w = world('passed')
    expect(await w.mark('start', { until: Date.now() - 1 })).toBe('late')
    expect(w.turns()[0]).toMatchObject({ before: null, wording: TURN_WORDINGS.beforeUnavailable() })
  })

  const NEXT_AGENT = '34817:7200:999:1:2'
  const published = (w: World): number => {
    const folder = join(w.at.dataRoot, TURN_STORE_FOLDER, SESSION)
    if (!existsSync(folder)) return 0
    return readdirSync(folder).reduce((sum, key) => sum + (existsSync(join(folder, key, 'captures')) ? readdirSync(join(folder, key, 'captures')).length : 0), 0)
  }
  const captureRows = (w: World): number => (w.database.prepare('SELECT count(*) AS n FROM turn_capture').get() as { n: number }).n

  it('never publishes a "before" during whose scan another process took the agent\'s place, with no event in between', async () => {
    const world_: { made: World | null } = { made: null }
    // The scan is done and its answer on its way when the terminal's foreground is another process.
    const replacedMeanwhile = (port: TurnChangesPort): TurnChangesPort => ({
      ...port,
      capture: async (request, signal) => {
        const answer = await port.capture(request, signal)
        if (!request.publish && world_.made) world_.made.foreground.identity = NEXT_AGENT
        return answer
      }
    })
    const w = world('replaced-in-scan', { port: replacedMeanwhile })
    world_.made = w
    expect(await w.mark('start', { requestId: 'old-agent' })).toBe('unavailable')
    // A confirmation that comes all the same finds nothing to publish.
    expect(await w.mark('confirm', { requestId: 'old-agent' })).toBe('late')
    await w.recorder.idle()
    expect(w.staged()).toBe(0)
    expect(published(w)).toBe(0)
    expect(captureRows(w)).toBe(0)
    expect(w.turns()).toHaveLength(1)
    expect(w.turns()[0]).toMatchObject({
      foreground: AGENT, state: 'closed', endKind: 'not-observed', before: null, after: null, totalsState: 'none', totals: null,
      wording: TURN_WORDINGS.beforeUnavailable()
    })
    // An agent that left is not a scan that failed: nothing counts towards the pause.
    expect(w.recorder.states()).toEqual([expect.objectContaining({ sessionId: SESSION, state: 'recording', pausedRoot: null })])
  })

  it('never publishes a "before" when another process took the agent\'s place before the confirmation, with no event in between', async () => {
    const w = world('replaced-before-confirm')
    expect(await w.mark('start', { requestId: 'old-agent' })).toBe('captured')
    expect(w.staged()).toBeGreaterThan(0)
    w.foreground.identity = NEXT_AGENT
    expect(await w.mark('confirm', { requestId: 'old-agent' })).toBe('late')
    await w.recorder.idle()
    expect(w.staged()).toBe(0)
    expect(published(w)).toBe(0)
    expect(captureRows(w)).toBe(0)
    expect(w.turns()).toHaveLength(1)
    expect(w.turns()[0]).toMatchObject({
      foreground: AGENT, state: 'closed', endKind: 'not-observed', before: null, after: null, totalsState: 'none', totals: null,
      wording: TURN_WORDINGS.beforeUnavailable()
    })
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

  it('reads the version away from the prompt\'s path: not in the call that asks, not while a mark is answered, and not while a "before" waits for its confirmation', async () => {
    const w = world('version-away')
    requests += 1
    const requestId = `p-${requests}`
    // An ordinary event of the app asks for the version while a prompt is on its way: nothing is read.
    const started = w.mark('start', { requestId })
    w.recorder.observe({ sessionId: SESSION, app: 'codex', event: 'PostToolUse', source: null, conversation: CONVERSATION, turn: 't-1', nested: false })
    expect(w.version.calls).toBe(0)
    expect(await started).toBe('captured')
    // The mark is answered and its "before" waits for the confirmation: still nothing, however long that takes.
    await sleep(40)
    expect(w.version.calls).toBe(0)
    const confirmed = w.mark('confirm', { requestId, folder: null, until: null })
    expect(w.version.calls).toBe(0)
    expect(await confirmed).toBe('confirmed')
    // The prompt is through. The version is read once, and the open turn says what it found.
    await w.recorder.idle()
    expect(w.version.calls).toBe(1)
    // Once per foreground process: neither the end nor the next turn reads it again.
    await w.edit('a.txt', 'one\n')
    expect(await w.end()).toBe('queued')
    await turn(w, 'b.txt', 'two\n', { turn: 't-2' })
    expect(w.version.calls).toBe(1)
    // Another process in the agent's place is read anew.
    w.foreground.identity = '34817:7002:556:1:2'
    await turn(w, 'c.txt', 'three\n', { turn: 't-3' })
    expect(w.version.calls).toBe(2)
  })

  it('reads the version once a "before" nobody confirmed was let go', async () => {
    const w = world('version-let-go')
    expect(await w.mark('start', { requestId: 'let-go' })).toBe('captured')
    // An event that is no tool's: a tool's would itself say that the app did not wait, and let the "before" go.
    w.recorder.observe({ sessionId: SESSION, app: 'codex', event: 'Notification', source: null, conversation: CONVERSATION, turn: 't-1', nested: false })
    await sleep(40)
    expect(w.version.calls).toBe(0)
    // The hook's connection closed before it confirmed.
    w.recorder.dropped(SESSION, 'let-go')
    await w.recorder.idle()
    await sleep(20)
    expect(w.version.calls).toBe(1)
    expect(w.staged()).toBe(0)
  })

  it('never reads it in the call that asks: the read goes through the scheduler', async () => {
    const later: Array<() => void> = []
    const w = world('version-scheduler', { defer: (work) => void later.push(work) })
    w.recorder.observe({ sessionId: SESSION, app: 'codex', event: 'PostToolUse', source: null, conversation: CONVERSATION, turn: 't-1', nested: false })
    await sleep(20)
    expect(w.version.calls).toBe(0)
    expect(later).toHaveLength(1)
    for (const work of later.splice(0)) work()
    await sleep(5)
    expect(w.version.calls).toBe(1)
  })

  /** A made-up `/proc` and home folder: BMN itself, and one process whose program lies where `program` says. */
  interface Told { view?: string; root?: 'own' | 'other'; link?: string }
  const installed = (name: string, program: string, told: Told = {}): { places: VersionPlaces; identity: string; home: string; file: string; done: () => void } => {
    const at = scratch(name, { commit: false })
    const proc = join(at.base, 'proc')
    const home = join(at.base, 'home')
    const file = join(home, program)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '#!/bin/sh\n')
    mkdirSync(join(at.base, 'elsewhere'))
    for (const pid of ['self', '7001']) {
      mkdirSync(join(proc, pid, 'ns'), { recursive: true })
      symlinkSync(pid === '7001' ? told.view ?? 'mnt:[4026531832]' : 'mnt:[4026531832]', join(proc, pid, 'ns', 'mnt'))
      symlinkSync(pid === '7001' && told.root === 'other' ? join(at.base, 'elsewhere') : at.base, join(proc, pid, 'root'))
    }
    symlinkSync(told.link ?? file, join(proc, '7001', 'exe'))
    const stat = statSync(file, { bigint: true })
    return { places: { procRoot: proc, home }, identity: `34817:7001:555:${stat.dev}:${stat.ino}`, home, file, done: at.done }
  }
  const CLAUDE = '.local/share/claude/versions'

  it('takes Claude Code\'s version from the name of the file its installer put the program in, and Codex\'s from nowhere', () => {
    const made = installed('version-claude', `${CLAUDE}/2.1.296`)
    const beta = installed('version-beta', `${CLAUDE}/2.2.0-beta.1`)
    try {
      expect(readAppVersion(made.identity, 'claude', made.places)).toBe('2.1.296')
      expect(readAppVersion(beta.identity, 'claude', beta.places)).toBe('2.2.0-beta.1')
      // No name says Codex's version, wherever its program lies; and an app that is not recorded has none.
      expect(readAppVersion(made.identity, 'codex', made.places)).toBeNull()
      expect(readAppVersion(made.identity, 'opencode', made.places)).toBeNull()
      // The process is gone, or the identity names none.
      expect(readAppVersion(made.identity.replace(':7001:', ':7002:'), 'claude', made.places)).toBeNull()
      expect(readAppVersion('34817:0:555:1:2', 'claude', made.places)).toBeNull()
      expect(readAppVersion('', 'claude', made.places)).toBeNull()
    } finally {
      made.done()
      beta.done()
    }
  })

  it('takes no version from a program that lies elsewhere, is named otherwise, is no longer that file, or is seen from another view or root', () => {
    const elsewhere = installed('version-elsewhere', 'tools/claude/versions/2.1.296')
    const deeper = installed('version-deeper', `${CLAUDE}/extra/2.1.296`)
    const unnamed = installed('version-unnamed', `${CLAUDE}/latest`)
    const short = installed('version-short', `${CLAUDE}/2.1`)
    const removed = installed('version-removed', `${CLAUDE}/2.1.296 (deleted)`)
    const otherView = installed('version-view', `${CLAUDE}/2.1.296`, { view: 'mnt:[4026532999]' })
    const otherRoot = installed('version-root', `${CLAUDE}/2.1.296`, { root: 'other' })
    const replaced = installed('version-replaced', `${CLAUDE}/2.1.296`)
    const linked = installed('version-linked', 'tools/real-program')
    const all = [elsewhere, deeper, unnamed, short, removed, otherView, otherRoot, replaced, linked]
    try {
      for (const made of [elsewhere, deeper, unnamed, short, removed, otherView, otherRoot]) {
        expect(readAppVersion(made.identity, 'claude', made.places)).toBeNull()
      }
      // The process runs another file by now than the one the identity names.
      expect(readAppVersion(replaced.identity.replace(/:\d+$/, ':1'), 'claude', replaced.places)).toBeNull()
      // A link that reads like an installed version and points at another program: the name is the link's, not the program's.
      mkdirSync(join(linked.home, CLAUDE), { recursive: true })
      symlinkSync(linked.file, join(linked.home, CLAUDE, '9.9.9'))
      rmSync(join(linked.places.procRoot as string, '7001', 'exe'))
      symlinkSync(join(linked.home, CLAUDE, '9.9.9'), join(linked.places.procRoot as string, '7001', 'exe'))
      expect(readAppVersion(linked.identity, 'claude', linked.places)).toBeNull()
    } finally {
      for (const made of all) made.done()
    }
  })

  it('runs nothing and opens nothing: a program that would leave a mark when run or read leaves none', () => {
    const made = installed('version-marker', `${CLAUDE}/9.9.9`)
    const mark = join(made.home, 'ran')
    try {
      // Run, it writes a file. Opened for reading, a pipe in its place would hold the reader for ever: it is not opened.
      writeFileSync(made.file, `#!/bin/sh\necho ran > '${mark}'\n`)
      chmodSync(made.file, 0o755)
      expect(readAppVersion(made.identity, 'claude', made.places)).toBe('9.9.9')
      expect(readAppVersion(made.identity, 'codex', made.places)).toBeNull()
      expect(existsSync(mark)).toBe(false)
      const source = readFileSync(join(here, 'turn-changes-version.ts'), 'utf8')
      expect(source).not.toMatch(/child_process|execFile|\bexec\(|\bspawn\(|openSync|readFileSync|createReadStream|readdirSync|\bopen\(/)
      expect([...source.matchAll(/import \{([^}]+)\} from 'node:fs'/g)].map((match) => match[1]?.trim())).toEqual(['lstatSync, readlinkSync, realpathSync, statSync'])
    } finally {
      made.done()
    }
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
  it('pauses a session\'s root after three scans in a row that failed, says so to the window only, and probes one turn again after the cooldown, waiting longer after each probe that fails (75.4 AC4)', async () => {
    let clock = Date.now()
    const w = world('pause', { now: () => clock })
    const prompt = (extra: Partial<TurnMarkCall>) => w.prompt({ until: clock + ROOMY, ...extra })
    // The agent stands in a folder that is no repository: every scan fails.
    w.foreground.folder = w.at.base
    for (const id of ['t-1', 't-2', 't-3']) expect(await prompt({ turn: id, folder: w.at.base })).toBe('unavailable')
    await w.recorder.idle()
    expect(w.turns().map((row) => row.wording)).toEqual([1, 2, 3].map(() => TURN_WORDINGS.beforeUnavailable()))
    expect(w.recorder.states()).toEqual([{
      sessionId: SESSION, state: 'paused', app: 'codex', pausedRoot: w.at.base, pauseReason: 'failed', retryAt: clock + TURN_RETRY_AFTER_MS
    }])
    expect(Object.keys(TURN_PAUSE_REASONS)).toContain('failed')

    // Inside the cooldown nothing is scanned and nothing is recorded.
    clock += TURN_RETRY_AFTER_MS - 1
    expect(await prompt({ turn: 't-4', folder: w.at.base })).toBe('paused')
    await w.recorder.idle()
    expect(w.turns()).toHaveLength(3)

    // Its time come, one turn is scanned as the probe: it fails, and the next wait is twice as long. The turn after it waits.
    clock += 1
    expect(await prompt({ turn: 't-5', folder: w.at.base })).toBe('unavailable')
    await w.recorder.idle()
    expect(w.turns()).toHaveLength(4)
    expect(w.recorder.states()[0]).toMatchObject({ state: 'paused', retryAt: clock + 2 * TURN_RETRY_AFTER_MS })
    expect(await prompt({ turn: 't-6', folder: w.at.base })).toBe('paused')

    // Each probe that fails doubles the wait, up to the longest.
    for (const wait of [4 * TURN_RETRY_AFTER_MS, 8 * TURN_RETRY_AFTER_MS, TURN_RETRY_MAX_MS, TURN_RETRY_MAX_MS]) {
      clock = w.recorder.states()[0]!.retryAt!
      expect(await prompt({ turn: `probe-${wait}-${clock}`, folder: w.at.base })).toBe('unavailable')
      await w.recorder.idle()
      expect(w.recorder.states()[0]).toMatchObject({ state: 'paused', retryAt: clock + wait })
    }

    // The work tree reads again: the next probe reads it, the pause lifts, and the turns after it are recorded as before.
    w.foreground.folder = w.at.repo
    clock = w.recorder.states()[0]!.retryAt!
    expect(await prompt({ turn: 't-ok' })).toBe('captured, confirmed')
    await w.recorder.idle()
    expect(w.recorder.states()).toEqual([{ sessionId: SESSION, state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null, retryAt: null }])
    expect(await w.end({ turn: 't-ok' })).toBe('queued')
    expect(await prompt({ turn: 't-next' })).toBe('captured, confirmed')
  })

  it('keeps a pause across a restart: no scan before its time, one probe after it, a longer wait when that fails, and recording once one reads (75.4 AC4)', async () => {
    let clock = Date.now()
    const w = world('pause-restart', { now: () => clock })
    const file = join(w.at.base, 'state/turn-pauses.json')
    const kept = turnPausesFile(file)
    // The first run keeps nothing yet on disk: the recorder is built again over the same options plus the file.
    const run = (): TurnRecorder => {
      const recorder = new TurnRecorder({ ...(w.recorder['options'] as TurnRecorderOptions), pauses: kept })
      recorder.setSwitches(new Set([SESSION]))
      return recorder
    }
    let recorder = run()
    let serial = 0
    const turn = async (folder: string): Promise<string> => {
      serial += 1
      const call = { sessionId: SESSION, incarnationId: 'i-1', requestId: `r-${serial}`, app: 'codex', conversation: CONVERSATION, turn: `t-${serial}`, kind: null, continued: false }
      const started = await recorder.mark({ ...call, edge: 'start', folder, until: clock + ROOMY })
      const confirmed = started === 'captured' ? await recorder.mark({ ...call, edge: 'confirm', folder: null, until: null }) : null
      await recorder.idle()
      return confirmed === null ? started : `${started}, ${confirmed}`
    }
    w.foreground.folder = w.at.base
    for (let index = 0; index < 3; index += 1) expect(await turn(w.at.base)).toBe('unavailable')
    expect(recorder.states()[0]).toMatchObject({ state: 'paused', pausedRoot: w.at.base, retryAt: clock + TURN_RETRY_AFTER_MS })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const scans = (): number => w.turns().length

    // BMN restarts inside the cooldown: the new run shows the pause before any turn, and scans nothing yet.
    recorder = run()
    expect(recorder.states()[0]).toMatchObject({ state: 'paused', pausedRoot: w.at.base, pauseReason: 'failed', retryAt: clock + TURN_RETRY_AFTER_MS })
    clock += TURN_RETRY_AFTER_MS - 1
    const before = scans()
    expect(await turn(w.at.base)).toBe('paused')
    expect(scans()).toBe(before)

    // Its time come, exactly one probe; it fails, and the wait doubles - also after another restart.
    clock += 1
    expect(await turn(w.at.base)).toBe('unavailable')
    expect(scans()).toBe(before + 1)
    expect(await turn(w.at.base)).toBe('paused')
    recorder = run()
    expect(recorder.states()[0]).toMatchObject({ state: 'paused', retryAt: clock + 2 * TURN_RETRY_AFTER_MS })

    // The work tree reads again: the next probe lifts the pause, and the file keeps none.
    w.foreground.folder = w.at.repo
    clock += 2 * TURN_RETRY_AFTER_MS
    expect(await turn(w.at.repo)).toBe('captured, confirmed')
    expect(recorder.states()[0]).toMatchObject({ state: 'recording', pausedRoot: null })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
    recorder = run()
    expect(recorder.states()[0]).toMatchObject({ state: 'recording', pausedRoot: null })
  })

  it('reads a kept file it cannot trust as no pause at all', () => {
    const w = world('pause-unreadable')
    const recorder = new TurnRecorder({ ...(w.recorder['options'] as TurnRecorderOptions), pauses: { read: () => ({ [SESSION]: { [w.at.base]: { reason: 'nonsense', retryAt: 1, probes: 0 } } }), write: () => {} } })
    recorder.setSwitches(new Set([SESSION]))
    expect(recorder.states()).toEqual([{ sessionId: SESSION, state: 'recording', app: null, pausedRoot: null, pauseReason: null, retryAt: null }])
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

  it('does not count a scan whose time passed and which kept the files it read: it has no list, and the next scan starts further on', async () => {
    // Each scan is held at its second new file until its time for reading is over (the last 100 of 800 ms): it
    // reads two files, keeps them without a list and ends "incomplete".
    const w = seamed('pause-time-read-on', () => {
      const began = performance.now()
      let seen = 0
      return {
        beforeEntry: async () => {
          seen += 1
          if (seen === 2) await sleep(Math.max(0, began + 710 - performance.now()))
        }
      }
    }, { limits: { captureMs: 800 } })
    for (let n = 0; n < 10; n += 1) write(w.at.repo, `f${n}.txt`, `content ${n}\n`)
    await sleep(25)
    expect(await w.prompt()).toBe('incomplete, confirmed')
    expect(await w.end()).toBe('queued')
    expect(await w.prompt({ turn: 't-2' })).toBe('incomplete, confirmed')
    const store = w.engine.store(SESSION, w.at.repo)
    const kept = store.captures().map((id) => store.record(id))
    expect(kept.map((record) => [record?.state, record?.bound, record?.tree, (record?.bytesRead ?? 0) > 0, (record?.bytesStored ?? 0) > 0]))
      .toEqual([1, 2, 3].map(() => ['incomplete', '0.8 s', null, true, true]))
    // Three incomplete scans in a row, and each got further: recording goes on.
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording', pausedRoot: null })
  }, 30_000)

  it('counts a scan whose time passed before anything it read was kept', async () => {
    // Each publication is held before its first file until the capture's time is over: nothing is moved in.
    const w = seamed('pause-time-kept-none', () => ({ beforeMove: (moved) => (moved === 0 ? sleep(240) : undefined) }), { limits: { captureMs: 200 } })
    for (let n = 0; n < 3; n += 1) write(w.at.repo, `f${n}.txt`, `content ${n}\n`)
    await sleep(25)
    expect(await w.prompt()).toBe('captured, confirmed')
    expect(await w.end()).toBe('queued')
    expect(w.recorder.states()[0]).toMatchObject({ state: 'recording' })
    expect(await w.prompt({ turn: 't-2' })).toBe('captured, confirmed')
    const store = w.engine.store(SESSION, w.at.repo)
    expect(store.captures().map((id) => store.record(id)).map((record) => [record?.state, record?.tree, record?.bytesStored])).toEqual([1, 2, 3].map(() => ['incomplete', null, 0]))
    expect(w.recorder.states()[0]).toMatchObject({ state: 'paused', pausedRoot: w.at.repo, pauseReason: 'incomplete' })
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
    expect(w.recorder.states()).toEqual([{ sessionId: SESSION, state: 'recording', app: 'codex', pausedRoot: null, pauseReason: null, retryAt: null }])

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

  it('says paused before anything else, and hears nothing of a session of an archived workspace', async () => {
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
