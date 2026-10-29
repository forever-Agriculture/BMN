// MODULE: agents-team-places.test.ts - Stories 72.4, 72.9: many asks, safely: a key, the request's hash and a capacity place reserved together across processes, crashes on either side of the start, capacity edges, nesting told from an ask's own systemd scope with a cleared environment and forged labels, sessions kept apart, credentials refused before anything starts, retention and the key window, the token ceiling and the features list; BMN's real systemd user scope, stand-in apps, a synthetic team, no provider reached
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { askFeatures, teamAsker } from '../../bin/agents-team-cli.mjs'
import type { Server } from 'node:net'
import { ASK_READS } from '../../bin/agents-team-forms.mjs'
import { nestedAsk, scopeAsk } from '../../bin/agents-team-nested.mjs'
import { keyDay, keyExpired, keyFresh, keyPath, keyedRun, makeKey, recordInterrupted, releaseReservation, removeRun, requestHash, reserveAsk, sweepRuns } from '../../bin/agents-team-places.mjs'
import { askOutcome, startAsk, stopAsk, waitAsk, watchAsk } from '../../bin/agents-team-run.mjs'
import { startTeamSupervisor } from '../../bin/agents-team-supervisor.mjs'
import { SCOPES, TOKEN_MAC, leftovers, ownSystemd, settle, standInControl, stubClaude, stubCodex, teamAskHome } from './test-fixtures/team-ask-harness'

const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const savedHome = process.env.HOME
const DEAD = { pid: 4_194_000, start: '1' }

let home: string
let stubs: string
let env: Record<string, string>
let control: Server
const runs = (): string => join(home, '.config/bmn/agents/state/team/runs')
const today = (now = new Date()): string => now.toISOString().slice(0, 10).replaceAll('-', '')
const key = (name: string): string => `${today()}-${name}`
const controlSocket = (): string => join(home, 'runtime/control/control.sock')
/** Where BMN's control service is, as BMN gives it to a session: its runtime folder, and the socket in it. */
const proof = (): Record<string, string> => ({ BMN_RUNTIME_HOME: join(home, 'runtime'), BMN_CONTROL_SOCKET: controlSocket() })
/** A session as BMN starts one: its id, its token, and BMN's control service that proves the token. */
const session = (id: string, token = id): Record<string, string> => ({ BMN_SESSION_ID: id, BMN_TOKEN: `s1.${token}.inc-1.${TOKEN_MAC}`, ...proof() })
/** The hash `bmn team ask` gives a question-only ask from a plain shell in the test's home. */
const shellHash = (question: string, extra: Record<string, unknown> = {}): string =>
  requestHash({ role: 'epic-reviewer', question, project: null, files: [], timeLimitMinutes: 30, ...extra })

function bmn(args: string[], extra: Record<string, string> = {}, input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BMN, ...args], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...ownSystemd(), ...extra }, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdin.end(input)
    child.on('exit', (code) => done({ code, stdout, stderr }))
  })
}
const runFolders = (): string[] => {
  try {
    return readdirSync(runs()).filter((name) => /^\d{8}T\d{6}-[0-9a-f]{8}$/.test(name))
  } catch {
    return []
  }
}
/** Stops every run this test started; a folder that never launched has nothing to stop. */
async function stopAll(): Promise<void> {
  const launched = runFolders().filter((id) => existsSync(join(runs(), id, 'launch.json')))
  for (const id of launched) {
    if (askOutcome(join(runs(), id)).exit === null) stopAsk(join(runs(), id))
  }
  for (const id of launched) await waitAsk(join(runs(), id), { timeoutMs: 8_000 })
}
const settings = (text: string): void => {
  mkdirSync(join(home, '.config/bmn/agents/state/team'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/state/team/asks-settings.json'), text)
}

beforeEach(async () => {
  ({ home, stubs, env } = teamAskHome('bmn-team-places-'))
  control = await standInControl(controlSocket())
})

afterEach(async () => {
  await new Promise((resolve) => control.close(resolve))
  await stopAll()
  await settle(() => leftovers(home).length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe('keys and the request\'s hash (72.4 AC2)', () => {
  it('a key names the UTC day it was issued: fresh around that day, expired after the window, with or without its record', () => {
    expect(keyDay('20261015-review-1')).toBe(Date.UTC(2026, 9, 15))
    for (const bad of ['review-1', '20261315-a', '20261032-a', '20261015-', '20261015-a b', `20261015-${'x'.repeat(65)}`]) expect(keyDay(bad)).toBeNull()
    expect(keyFresh('20261015-a', new Date('2026-10-15T23:59:00Z'))).toBe(true)
    // A local date ahead of or behind UTC still counts as today.
    expect(keyFresh('20261015-a', new Date('2026-10-14T22:00:00Z'))).toBe(true)
    expect(keyFresh('20261015-a', new Date('2026-10-16T23:00:00Z'))).toBe(true)
    expect(keyFresh('20261015-a', new Date('2026-10-17T00:00:00Z'))).toBe(false)
    // First used as late as possible (the end of the next day), a key still finds its run for seven days.
    expect(keyExpired('20261015-a', new Date('2026-10-23T23:59:59Z'))).toBe(false)
    expect(keyExpired('20261015-a', new Date('2026-10-24T00:00:00Z'))).toBe(true)
    expect(makeKey('shell', new Date('2026-10-15T01:00:00Z'))).toMatch(/^20261015-shell-[0-9a-f]{8}$/)
  })

  it('the same request has the same hash; any part that decides what is asked, or of whom, changes it', () => {
    const base = { role: 'epic-reviewer', question: 'Is the loop bounded?', project: '/p', files: [{ path: '/p/a.ts', sha256: 'f'.repeat(64) }], timeLimitMinutes: 30 }
    expect(requestHash(base)).toBe(requestHash({ ...base, files: [...base.files] }))
    expect(requestHash(base)).toBe(requestHash({ ...base, data: undefined }))
    for (const changed of [{ question: 'Is it bounded?' }, { role: 'designer' }, { agent: 'astra' }, { effort: 'high' }, { smallWork: true }, { project: '/q' },
      { files: [{ path: '/p/a.ts', sha256: 'e'.repeat(64) }] }, { images: [{ path: '/p/a.png', sha256: 'e'.repeat(64) }] }, { data: 'public' }, { timeLimitMinutes: 31 }, { recheckOf: '20261015T000000-00000000' }]) {
      expect(requestHash({ ...base, ...changed })).not.toBe(requestHash(base))
    }
  })

  it('key, hash and place go together: the same key and request find the first run, another request is refused, a full capacity is busy', async () => {
    const first = await reserveAsk(runs(), { scope: 'session:a', key: key('one'), hash: 'h1', id: '20261015T000001-00000001' })
    expect(first).toEqual({ reserved: '20261015T000001-00000001' })
    expect(await reserveAsk(runs(), { scope: 'session:a', key: key('one'), hash: 'h1', id: '20261015T000002-00000002' })).toMatchObject({ existing: '20261015T000001-00000001' })
    await expect(reserveAsk(runs(), { scope: 'session:a', key: key('one'), hash: 'h2', id: '20261015T000003-00000003' })).rejects.toMatchObject({ code: 'KEY_CONFLICT' })
    // A key belongs to its scope: the same words from another session are another key.
    expect(await reserveAsk(runs(), { scope: 'session:b', key: key('one'), hash: 'h2', id: '20261015T000004-00000004' })).toEqual({ reserved: '20261015T000004-00000004' })
    // Two places held by a living asker: at a capacity of two a third is busy, at three it is not.
    await expect(reserveAsk(runs(), { scope: 'session:a', key: key('two'), hash: 'h3', id: '20261015T000005-00000005' }, { capacity: 2 })).rejects.toMatchObject({ code: 'BUSY' })
    expect(await reserveAsk(runs(), { scope: 'session:a', key: key('two'), hash: 'h3', id: '20261015T000005-00000005' }, { capacity: 3 })).toEqual({ reserved: '20261015T000005-00000005' })
    // The key file names neither the scope nor the key.
    expect(readdirSync(join(runs(), '.keys')).every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true)
    // A key used for the first time must name a recent day; an expired one is gone.
    const old = new Date(Date.now() - 3 * 86_400_000)
    await expect(reserveAsk(runs(), { scope: 'session:a', key: `${today(old)}-late`, hash: 'h4', id: '20261015T000006-00000006' })).rejects.toMatchObject({ code: 'USAGE' })
    const ancient = new Date(Date.now() - 12 * 86_400_000)
    await expect(reserveAsk(runs(), { scope: 'session:a', key: `${today(ancient)}-late`, hash: 'h4', id: '20261015T000006-00000006' })).rejects.toMatchObject({ code: 'GONE' })
    // A refusal before the start gives the key back: it may then be used for any request.
    await releaseReservation(runs(), { scope: 'session:a', key: key('one'), id: '20261015T000001-00000001' })
    expect(await reserveAsk(runs(), { scope: 'session:a', key: key('one'), hash: 'h9', id: '20261015T000007-00000007' }, { capacity: 3 })).toEqual({ reserved: '20261015T000007-00000007' })
  })

  it('the places of an asker that ended before making its run are given back at the next reservation', async () => {
    await reserveAsk(runs(), { scope: 'shell', key: key('a'), hash: 'h1', id: '20261015T000001-00000001' }, { holder: DEAD })
    await reserveAsk(runs(), { scope: 'shell', key: key('b'), hash: 'h2', id: '20261015T000002-00000002' }, { holder: DEAD })
    expect(await reserveAsk(runs(), { scope: 'shell', key: key('c'), hash: 'h3', id: '20261015T000003-00000003' }, { capacity: 1 })).toEqual({ reserved: '20261015T000003-00000003' })
    expect(readdirSync(join(runs(), '.places'))).toEqual(['20261015T000003-00000003.json'])
    const entry = JSON.parse(readFileSync(keyPath(runs(), 'shell', key('a')), 'utf8'))
    expect(keyedRun(runs(), entry)).toMatchObject({ state: 'interrupted' })
  })
})

describe.skipIf(!SCOPES)('crashes on either side of the start (72.4 AC2)', { timeout: 30_000 }, () => {
  it('before the start: the run is recorded interrupted, never launched, and its supervisor, should it come, starts nothing', async () => {
    const question = 'Is the loop bounded?'
    const reserved = await reserveAsk(runs(), { scope: 'shell', key: key('crash-before'), hash: shellHash(question), id: '20261015T010000-0000000a' }, { holder: DEAD })
    const prepared = prepareAsk({ role: 'epic-reviewer', question }, { environment: env, cwd: home, home, id: reserved.reserved! })
    expect(prepared.verdict.verdict).toBe('PASS')
    // The asking command is gone; its retry with the same key and request is told, and nothing starts.
    const retry = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', question, '--key', key('crash-before'), '--json'])
    expect(retry.code, retry.stderr).toBe(1)
    expect(JSON.parse(retry.stdout)).toMatchObject({ id: prepared.id, state: 'interrupted', exit: 1 })
    expect(JSON.parse(readFileSync(join(prepared.folder, 'outcome.json'), 'utf8'))).toMatchObject({ state: 'interrupted', reason: expect.stringContaining('nothing started') })
    expect(existsSync(join(prepared.folder, 'launch.json'))).toBe(false)
    // Its start is refused, and a supervisor that comes late reads the outcome and runs nothing.
    expect(() => startAsk(prepared, { timeLimitMinutes: 1 })).toThrow(/already ended .*nothing started/)
    writeFileSync(join(prepared.folder, 'launch.json'), JSON.stringify({ version: 1, argv: prepared.argv, deadline: Date.now() + 60_000, stdin: null, finish: null }))
    expect(startTeamSupervisor(prepared.folder)).toMatchObject({ pid: expect.any(Number) })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(existsSync(join(prepared.folder, 'events.jsonl'))).toBe(false)
    expect(existsSync(join(prepared.folder, 'state.json'))).toBe(false)
    expect(runFolders()).toEqual([prepared.id])
  })

  it('after the start: the run goes on, and a retry with the key finds it and its answer; nothing starts twice', async () => {
    const question = 'Is the loop bounded? NAP'
    const reserved = await reserveAsk(runs(), { scope: 'shell', key: key('crash-after'), hash: shellHash(question), id: '20261015T020000-0000000b' }, { holder: DEAD })
    const prepared = prepareAsk({ role: 'epic-reviewer', question }, { environment: env, cwd: home, home, id: reserved.reserved! })
    startAsk(prepared, { timeLimitMinutes: 1 })
    const retry = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', question, '--key', key('crash-after')])
    expect(retry.code, retry.stderr).toBe(0)
    expect(retry.stderr).toContain(`found run ${prepared.id}, asked before; nothing started again`)
    expect(retry.stdout).toMatch(/^codex answer [0-9a-f]{8} in \S+\/work\n$/u)
    expect(runFolders()).toEqual([prepared.id])
    expect(readFileSync(join(prepared.folder, 'events.jsonl'), 'utf8').match(/thread\.started/g)).toHaveLength(1)
    // Its place is given back with its outcome.
    expect(existsSync(join(runs(), '.places', `${prepared.id}.json`))).toBe(false)
  })
})

describe.skipIf(!SCOPES)('many asks at once (72.4 AC1, AC3)', { timeout: 30_000 }, () => {
  it('separate commands submitting together never exceed the capacity; one more is busy (exit 14), and a freed place is taken again', async () => {
    settings('{"capacity": 3}\n')
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', `Bounded ${n}? SLEEP`, '--key', key(`load-${n}`), '--background', '--json'])))
    const codes = results.map((result) => result.code).sort()
    expect(codes, results.map((result) => result.stderr + result.stdout).join('\n')).toEqual([0, 0, 0, 14, 14])
    const busy = results.find((result) => result.code === 14)!
    expect(JSON.parse(busy.stdout)).toMatchObject({ version: 1, state: 'refused', exit: 14, refusal: { code: 'BUSY' } })
    expect(runFolders()).toHaveLength(3)
    // A wait that times out leaves the run going.
    const id = JSON.parse(results.find((result) => result.code === 0)!.stdout).id as string
    const waited = await bmn(['team', 'asks', 'wait', id, '--timeout', '1', '--json'])
    expect(JSON.parse(waited.stdout)).toMatchObject({ id, exit: null })
    expect(askOutcome(join(runs(), id)).exit).toBeNull()
    // Stop one: its place is free for the next ask.
    expect((await bmn(['team', 'asks', 'stop', id])).code).toBe(0)
    expect(await waitAsk(join(runs(), id), { timeoutMs: 15_000 })).toMatchObject({ state: 'stopped', exit: 16 })
    const next = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Bounded 6? SLEEP', '--key', key('load-6'), '--background'])
    expect(next.code, next.stderr).toBe(0)
  })

  it('the same key from several commands at once is one run; each command gets its id', async () => {
    const results = await Promise.all([1, 2, 3].map(() => bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Same? SLEEP', '--key', key('same'), '--background'])))
    expect(results.map((result) => result.code)).toEqual([0, 0, 0])
    expect(new Set(results.map((result) => result.stdout.trim())).size).toBe(1)
    expect(runFolders()).toEqual([results[0]!.stdout.trim()])
  })
})

describe.skipIf(!SCOPES)('who sees and controls an ask (72.4 AC2, AC4)', { timeout: 30_000 }, () => {
  it('a session must pass --key; it sees and stops only its own asks, and a forged session label sees nothing', async () => {
    const a = session('sess-a')
    const required = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--json'], a)
    expect(required.code).toBe(10)
    expect(JSON.parse(required.stdout).refusal).toMatchObject({ code: 'KEY_REQUIRED', reason: expect.stringMatching(/needs --key: today's UTC day and a name of yours, as \d{8}-review-1-[0-9a-f]{8}/) })
    expect((await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--key', 'review-1'], a)).code).toBe(2)
    const asked = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Mine? SLEEP', '--key', key('mine'), '--background'], a)
    expect(asked.code, asked.stderr).toBe(0)
    const id = asked.stdout.trim()
    expect(JSON.parse((await bmn(['team', 'asks', '--json'], a)).stdout).asks.map((entry: { id: string }) => entry.id)).toEqual([id])
    expect(JSON.parse(readFileSync(join(runs(), id, 'request.json'), 'utf8'))).toMatchObject({ key: key('mine'), key_scope: 'session:sess-a', request_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), asked_by: { kind: 'session', session: 'sess-a' } })
    const b = session('sess-b')
    expect(JSON.parse((await bmn(['team', 'asks', '--json'], b)).stdout).asks).toEqual([])
    for (const action of ['show', 'wait', 'stop', 'export']) {
      const tried = await bmn(['team', 'asks', action, id, ...(action === 'export' ? ['--output', join(home, `out-${action}`)] : []), '--json'], b)
      expect(tried.code).toBe(10)
      expect(JSON.parse(tried.stdout).refusal.code).toBe('NOT_YOURS')
    }
    // A session id that the token BMN gave does not name is a forged label: nothing is shown or asked.
    const forged = { BMN_SESSION_ID: 'sess-a', BMN_TOKEN: `s1.sess-b.inc-1.${TOKEN_MAC}`, ...proof() }
    expect(await teamAsker(forged)).toMatchObject({ kind: 'forged' })
    const shown = await bmn(['team', 'asks', 'show', id, '--json'], forged)
    expect(shown.code).toBe(10)
    expect(JSON.parse(shown.stdout).refusal).toMatchObject({ code: 'NOT_YOURS', reason: expect.stringContaining('BMN_SESSION_ID names session sess-a') })
    expect((await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--key', key('forged')], forged)).code).toBe(10)
    // Session A's id with no token, or with a made-up token naming A that BMN does not know, is refused every operation (epic review).
    const bare = { BMN_SESSION_ID: 'sess-a', ...proof() }
    const fabricated = { BMN_SESSION_ID: 'sess-a', BMN_TOKEN: `s1.sess-a.inc-1.${'b'.repeat(64)}`, ...proof() }
    const unreachable = { ...a, BMN_RUNTIME_HOME: join(home, 'no-runtime'), BMN_CONTROL_SOCKET: join(home, 'no-runtime/control/control.sock') }
    // A control service of the caller's own making, which says yes to anything, is never asked: the token goes only to BMN's (epic review R1).
    const accepted: string[] = []
    const fake = await standInControl(join(home, 'fake/control.sock'), (token) => { accepted.push(token); return 'sess-a' })
    const substituted = { BMN_SESSION_ID: 'sess-a', BMN_TOKEN: `s1.sess-a.inc-1.${'c'.repeat(64)}`, ...proof(), BMN_CONTROL_SOCKET: join(home, 'fake/control.sock') }
    for (const [who, code, words] of [[bare, 'NOT_YOURS', 'there is no BMN_TOKEN'], [fabricated, 'NOT_YOURS', 'BMN does not know the BMN_TOKEN'], [unreachable, 'SESSION_UNPROVEN', 'did not answer'],
      [substituted, 'SESSION_UNPROVEN', 'not BMN\'s own control socket']] as const) {
      expect(await teamAsker(who)).toMatchObject({ kind: code === 'NOT_YOURS' ? 'forged' : 'unproven' })
      const listed = await bmn(['team', 'asks', '--json'], who)
      expect(listed.code).toBe(10)
      expect(JSON.parse(listed.stdout).refusal).toMatchObject({ code, reason: expect.stringContaining(words) })
      for (const action of ['show', 'wait', 'stop', 'export']) {
        const tried = await bmn(['team', 'asks', action, id, ...(action === 'export' ? ['--output', join(home, `forged-${action}`)] : []), '--json'], who)
        expect(tried.code, `${action}: ${tried.stdout}`).toBe(10)
        expect(JSON.parse(tried.stdout).refusal.code).toBe(code)
      }
      const asked = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--key', key('forged-2'), '--json'], who)
      expect(JSON.parse(asked.stdout).refusal.code).toBe(code)
    }
    expect(existsSync(join(home, 'forged-export'))).toBe(false)
    await new Promise((resolve) => fake.close(resolve))
    expect(accepted).toEqual([])
    // No flag or label gives the owner's view: there is no "all".
    expect((await bmn(['team', 'asks', '--all'], b)).code).toBe(2)
    // A plain shell sees the shell's asks only.
    expect(JSON.parse((await bmn(['team', 'asks', '--json'])).stdout).asks).toEqual([])
    // The same key in another session is another key: its own run.
    const other = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Mine? SLEEP', '--key', key('mine'), '--background'], b)
    expect(other.code, other.stderr).toBe(0)
    expect(other.stdout.trim()).not.toBe(id)
    expect((await bmn(['team', 'asks', 'stop', id], a)).code).toBe(0)
  })
})

describe.skipIf(!SCOPES)('refusals, crashes and retries leave nothing behind (epic review)', { timeout: 30_000 }, () => {
  it('a credential in the question or a named file is refused before anything is written, and the key is given back; a crash after the outcome leaves nothing the next reservation does not take away (72.9 AC6)', async () => {
    const root = join(home, 'code/app')
    mkdirSync(root, { recursive: true })
    const token = `gh${'p'}_${'7Kq2'.repeat(9)}`
    writeFileSync(join(root, 'config.ts'), `export const token = '${token}'\n`)
    const named = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Is the config safe?', '--file', join(root, 'config.ts'), '--key', key('credential'), '--json'])
    expect(named.code, named.stderr).toBe(10)
    expect(JSON.parse(named.stdout).refusal).toMatchObject({ code: 'CREDENTIAL_FOUND', reason: expect.stringContaining('a GitHub token') })
    const said = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', `Is ${token} still valid?`, '--key', key('said'), '--json'])
    expect(said.code, said.stderr).toBe(10)
    expect(JSON.parse(said.stdout).refusal).toMatchObject({ code: 'CREDENTIAL_FOUND' })
    expect(named.stdout + said.stdout + named.stderr + said.stderr).not.toContain(token)
    expect(runFolders()).toEqual([])
    // The key was given back: the same key may be used for another request.
    const again = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Another question?', '--key', key('credential'), '--background'])
    expect(again.code, again.stderr).toBe(0)
    const id = again.stdout.trim()
    await waitAsk(join(runs(), id), { timeoutMs: 20_000 })
    // A crash between the outcome and the deletion of the transient state, and what a record from before 72.9 held (its
    // per-run sign-in copy and frozen project): the next reservation's sweep deletes them.
    for (const name of ['app-status', 'codex-answer.md', 'home/oc/opencode.db', 'project/src/a.ts']) {
      mkdirSync(dirname(join(runs(), id, name)), { recursive: true })
      writeFileSync(join(runs(), id, name), 'left behind\n')
    }
    await reserveAsk(runs(), { scope: 'shell', key: key('sweep'), hash: 'h-sweep', id: '20261015T060000-0000000f' })
    for (const name of ['app-status', 'codex-answer.md', 'home', 'project']) expect(existsSync(join(runs(), id, name))).toBe(false)
    expect(existsSync(join(runs(), id, 'outcome.json'))).toBe(true)
    expect(existsSync(join(runs(), id, 'answer.md'))).toBe(true)
  })

  it('an interrupted record from before 72.9 is finished by recovery, once or twice, its sign-in copy and frozen project deleted, another run untouched (72.9 AC6, full review)', () => {
    const [old, other] = ['20261014T230000-0000000a', '20261014T230000-0000000b'].map((id) => join(runs(), id))
    for (const folder of [old!, other!]) {
      for (const name of ['home/oc/opencode.db', 'project/src/a.ts']) {
        mkdirSync(dirname(join(folder, name)), { recursive: true })
        writeFileSync(join(folder, name), 'made-up\n')
      }
      writeFileSync(join(folder, 'request.json'), JSON.stringify({ version: 1, id: folder.split('/').pop(), role: 'epic-reviewer' }))
      writeFileSync(join(folder, 'state.json'), JSON.stringify({ version: 1, state: 'running' }))
    }
    for (let time = 0; time < 2; time += 1) recordInterrupted(old!, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
    expect(askOutcome(old!)).toMatchObject({ state: 'interrupted', exit: 1, reason: expect.stringContaining('its supervisor ended') })
    for (const name of ['home', 'project']) expect(existsSync(join(old!, name))).toBe(false)
    for (const name of ['home/oc/opencode.db', 'project/src/a.ts', 'state.json']) expect(existsSync(join(other!, name))).toBe(true)
    expect(existsSync(join(other!, 'outcome.json'))).toBe(false)
  })

  it('a retry that follows a key whose first ask is refused before it starts gets a refusal, never a crash (epic review)', async () => {
    const question = 'Followed? SLEEP'
    // The first command holds the key while it prepares (this test is its living holder) ...
    await reserveAsk(runs(), { scope: 'shell', key: key('follow'), hash: shellHash(question), id: '20261015T070000-00000010' })
    const retry = bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', question, '--key', key('follow'), '--json'])
    await new Promise((resolve) => setTimeout(resolve, 600))
    // ... and is refused before the start, giving the key back.
    await releaseReservation(runs(), { scope: 'shell', key: key('follow'), id: '20261015T070000-00000010' })
    const followed = await retry
    expect(followed.code, followed.stderr).toBe(10)
    expect(JSON.parse(followed.stdout).refusal).toMatchObject({ code: 'NOT_STARTED', reason: expect.stringContaining('was refused before it started') })
    expect(followed.stderr).not.toContain('ENOENT')
  })
})

describe.skipIf(!SCOPES)('retention and the key window (72.4 AC2)', { timeout: 30_000 }, () => {
  it('a removed run keeps a content-free entry, and a retry is GONE, during the window and after it', async () => {
    const asked = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Remove me?', '--key', key('removed')])
    expect(asked.code, asked.stderr).toBe(0)
    const id = /run (\S+),/.exec(asked.stderr)![1]!
    expect(removeRun(runs(), id)).toBe(true)
    expect(existsSync(join(runs(), id))).toBe(false)
    const entry = JSON.parse(readFileSync(keyPath(runs(), 'shell', key('removed')), 'utf8'))
    expect(Object.keys(entry).sort()).toEqual(['id', 'key', 'outcome', 'removed_at', 'request_sha256', 'scope', 'state', 'version'])
    expect(entry).toMatchObject({ state: 'gone', outcome: 'answered' })
    expect(JSON.stringify(entry)).not.toContain('Remove me')
    const retry = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Remove me?', '--key', key('removed'), '--json'])
    expect(retry.code).toBe(10)
    expect(JSON.parse(retry.stdout).refusal.code).toBe('GONE')
    // After the window the entry is deleted, and the key alone still says it is expired.
    const later = new Date(Date.now() + 10 * 86_400_000)
    sweepRuns(runs(), later)
    expect(existsSync(keyPath(runs(), 'shell', key('removed')))).toBe(false)
    await expect(reserveAsk(runs(), { scope: 'shell', key: key('removed'), hash: entry.request_sha256, id: '20261015T030000-0000000c' }, { now: later })).rejects.toMatchObject({ code: 'GONE' })
  })

  it('records are removed thirty days after their run ended, not before', async () => {
    const kept = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Kept?', '--key', key('kept')])
    const old = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Old?', '--key', key('old')])
    const [keptId, oldId] = [kept, old].map((result) => /run (\S+),/.exec(result.stderr)![1]!)
    const age = (id: string, days: number): void => {
      const path = join(runs(), id, 'outcome.json')
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ended_at: new Date(Date.now() - days * 86_400_000).toISOString() }))
    }
    age(keptId!, 29)
    age(oldId!, 31)
    sweepRuns(runs())
    expect(runFolders()).toEqual([keptId])
    expect(JSON.parse(readFileSync(keyPath(runs(), 'shell', key('old')), 'utf8'))).toMatchObject({ state: 'gone', id: oldId })
  })
})

describe.skipIf(!SCOPES)('the owner\'s token ceiling (72.4 AC3)', { timeout: 30_000 }, () => {
  it('a Claude Code run reaching it is stopped with that reason (exit 16)', async () => {
    settings('{"token_ceiling": 2500}\n')
    const asked = await bmn(['team', 'ask', '--role', 'designer', '--question', 'Look closely. CEILING', '--key', key('ceiling'), '--json'])
    expect(asked.code, asked.stderr).toBe(16)
    expect(JSON.parse(asked.stdout)).toMatchObject({ state: 'stopped', exit: 16, reason: expect.stringMatching(/^the run reached the owner's token ceiling: \d+ tokens, over 2500$/) })
  })

  it('counts each model call once, at its last report', () => {
    const folder = join(home, 'watched')
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder)
    const line = (id: string, input: number) => `${JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: input, output_tokens: 10 } } })}\n`
    writeFileSync(join(folder, 'events.jsonl'), line('m1', 100) + line('m1', 200))
    expect(watchAsk(folder, { token_ceiling: 300 })).toBeNull()
    writeFileSync(join(folder, 'events.jsonl'), line('m1', 100) + line('m1', 200) + line('m2', 100))
    expect(watchAsk(folder, { token_ceiling: 300 })).toBe('the run reached the owner\'s token ceiling: 320 tokens, over 300')
    expect(watchAsk(folder, null)).toBeNull()
  })
})

describe('telling an ask\'s scope (72.4 AC4, 72.9 AC4)', () => {
  it('a process in an ask\'s scope, or a cgroup under it, is inside that ask; any other is not', () => {
    const id = '20261015T040000-0000000d'
    const unit = `/user.slice/user-1000.slice/user@1000.service/app.slice/bmn-ask-${id}.scope`
    expect(scopeAsk(unit)).toBe(id)
    expect(scopeAsk(`${unit}/sandbox`)).toBe(id)
    for (const other of ['/user.slice/user-1000.slice/user@1000.service/app.slice/bmn-ask-x.scope.d', '/user.slice/bmn-asks.scope', '/user.slice/user-1000.slice/session-2.scope', '']) expect(scopeAsk(other)).toBeNull()
    const file = join(home, 'cgroup')
    writeFileSync(file, `0::${unit}\n`)
    expect(nestedAsk(file)).toBe(id)
    writeFileSync(file, '0::/user.slice/user-1000.slice/session-2.scope\n')
    expect(nestedAsk(file)).toBeNull()
    expect(nestedAsk(join(home, 'no-such-file'))).toBeNull()
  })
})

describe.skipIf(!SCOPES)('nesting (72.4 AC4)', { timeout: 30_000 }, () => {
  it('inside an ask\'s scope every BMN command is refused, its environment cleared or its labels forged; a hook does nothing', async () => {
    // A child in a scope named as an ask's runs every BMN path and reports what each said.
    const id = '20261015T040000-0000000d'
    const script = join(home, 'nested.mjs')
    writeFileSync(script, `import { spawnSync } from 'node:child_process'
const commands = [
  ['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--key', '${key('nested')}'], ['team', 'asks'], ['team', 'asks', 'show', '20261015T000000-00000000'],
  ['team'], ['roster', 'check', '--agent', 'astra', '--role', 'epic-reviewer', '--', 'codex', 'exec', 'x'], ['research', 'ask', 'x'], ['judge', 'ask', 'x'], ['peers'], ['hook', 'session-start']
]
const environments = [{}, { HOME: '/tmp/elsewhere', BMN_SESSION_ID: 'sess-x', BMN_TOKEN: 's1.sess-x.inc-1.${TOKEN_MAC}', BMN_OWNER: '1', PATH: '/usr/bin:/bin' }]
const results = []
for (const environment of environments) for (const argv of commands) {
  const done = spawnSync(process.execPath, [${JSON.stringify(BMN)}, ...argv], { env: environment, encoding: 'utf8', input: '' })
  results.push({ argv: argv.slice(0, 2).join(' '), forged: Object.keys(environment).length > 0, code: done.status, stderr: done.stderr, stdout: done.stdout })
}
process.stdout.write(JSON.stringify(results))
`)
    const child = spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=bmn-ask-${id}`, '--', process.execPath, script],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: home, ...ownSystemd() } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    await new Promise((resolve) => child.on('exit', resolve))
    const results = JSON.parse(stdout || '[]') as Array<{ argv: string; forged: boolean; code: number; stderr: string; stdout: string }>
    expect(results, stderr).toHaveLength(18)
    for (const result of results) {
      if (result.argv.startsWith('hook')) {
        expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' })
        continue
      }
      expect(result.code, `${result.argv} ${result.forged ? 'forged' : 'cleared'}: ${result.stderr}`).toBe(10)
      expect(result.stderr).toContain(`bmn: NESTED: this runs inside teammate ask ${id}`)
    }
    // Outside it the same commands behave as before.
    expect(nestedAsk()).toBeNull()
    expect((await bmn(['team'])).code).toBe(0)
  })

  it('the teammate\'s app gets none of BMN\'s environment, and a BMN command it runs is refused as nested', async () => {
    writeFileSync(join(stubs, 'codex'), `#!/bin/sh
[ "$1" = --version ] && echo "codex-cli 0.162.1" && exit 0
[ "$1" = mcp ] && [ "$2" = list ] && echo '[]' && exit 0
model=; effort=; prev=
for a in "$@"; do
  [ "$prev" = -m ] && model=$a
  case $a in model_reasoning_effort=*) effort=$(printf %s "$a" | sed 's/.*=//; s/"//g');; esac
  prev=$a
done
cat >/dev/null
out=$(${process.execPath} ${BMN} team asks 2>&1)
code=$?
seen="env=$(env | grep -c -e '^BMN_' -e 'TOKEN');code=$code;said=$(printf %s "$out" | grep -o 'bmn: NESTED' | head -n 1)"
printf '{"type":"thread.started","thread_id":"aaaaaaaa-0000-7000-8000-000000000000"}\\n'
printf 'INFO turn{thread.id=aaaaaaaa-0000-7000-8000-000000000000 model=%s codex.turn.reasoning_effort=%s}: started\\n' "$model" "$effort" >&2
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$seen"
printf '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\\n'
`)
    const asked = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'What do you see?', '--key', key('inside')], session('sess-in'))
    expect(asked.code, asked.stderr).toBe(0)
    expect(asked.stdout).toBe('env=0;code=10;said=bmn: NESTED\n')
  })
})

describe('what may be asked here (72.4 AC5)', () => {
  it('lists each installed app with the form it is asked in and what that form can read, when the form was last checked, and no version gate (72.9 AC4)', async () => {
    const features = askFeatures(env)
    const form = (name: keyof typeof ASK_READS) => ({ form: name, reads: ASK_READS[name].words })
    const notPublic = { form: null, reads: 'not offered: its tools read beyond your text, so its asks are private' }
    expect(features).toMatchObject({ version: 2, platform: 'linux', scope: { ok: SCOPES } })
    expect(features.apps).toEqual([
      { app: 'codex', installed: true, version: '0.162.1', form_checked_on: { version: '0.162.1', on: '2026-10-15' }, forms: { project: form('codex-read-only'), 'no-project': form('codex-read-only'), public: notPublic }, pictures: 'offered', browser: 'offered', usage_while_running: false },
      { app: 'claude', installed: true, version: '2.1.300', form_checked_on: { version: '2.1.300', on: '2026-10-15' }, forms: { project: form('claude-read-tools'), 'no-project': form('claude-read-tools'), public: notPublic }, pictures: 'offered', browser: 'offered', usage_while_running: true },
      { app: 'opencode', installed: false, version: null, form_checked_on: { version: '2.0.32', on: '2026-10-23' }, forms: { project: form('opencode-reader'), 'no-project': form('opencode-asker'), public: form('opencode-asker') },
        pictures: expect.stringMatching(/^not offered: /u), browser: expect.stringContaining('not offered: BMN adds a browser only to Codex and Claude Code'), usage_while_running: false }
    ])
    // A newer app is asked as it is: the form was last checked on another version, and that is all.
    stubCodex(stubs, '0.170.0')
    rmSync(join(stubs, 'claude'))
    const changed = askFeatures(env)
    expect(changed.apps[0]).toMatchObject({ version: '0.170.0', form_checked_on: { version: '0.162.1' }, forms: { project: form('codex-read-only') } })
    expect(changed.apps[1]).toMatchObject({ installed: false })
    stubClaude(stubs)
    const shown = await bmn(['team', 'ask', '--features', '--json'])
    expect(shown.code).toBe(0)
    expect(JSON.parse(shown.stdout).apps[0]).toMatchObject({ version: '0.170.0' })
    const words = await bmn(['team', 'ask', '--features'])
    expect(words.stdout).toContain(`Codex 0.170.0 (form last checked on 0.162.1, 2026-10-15): ${ASK_READS['codex-read-only'].words}; pictures offered; browser offered; usage at the end only`)
    expect((await bmn(['team', 'ask', '--features', '--role', 'designer'])).code).toBe(2)
    if (SCOPES) {
      const asked = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Newer app?', '--key', key('newer')])
      expect(asked.code, asked.stderr).toBe(0)
    }
  })
})
