// MODULE: update-restart.test.ts - Epic 125 (125.4, 125.5): states that are never guessed, the notices, Cancel's result, the one typed line, and nothing typed into Codex
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPDATE_RESTART_LIMIT_MS, UPDATE_RESTART_TELL_MS, UPDATE_RESTART_CONTINUE, UPDATE_RESTART_CHECK, UPDATE_RESTART_CARRY_ON, updateRestartNotice, updateRestartWords,
  type SessionResumeResult, type UpdateRestartMember } from '@bmn/protocol'
import { UpdateRestart, restartStateAtPress, resumedStart, type RestartTarget } from './update-restart'
import type { WakeObservation, WakeAttention } from './away-wake'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
type Agent = 'claude' | 'codex' | 'bash'
function setup(agent: Agent = 'claude', atPress: UpdateRestartMember['atPress'] = 'working') {
  const root = mkdtempSync(join(tmpdir(), 'restart-test-')); roots.push(root)
  let time = Date.parse('2026-11-13T12:00:00Z'), incarnation = 'old', conversation = 'conversation', generation = 0
  let seen: WakeObservation | undefined = { sessionId: 's', incarnationId: 'old', agent, event: 'PostToolUse', source: null, plugin: null, observedAt: new Date(time).toISOString(), foreground: 'front' }
  let open: WakeAttention[] = []
  let lines = agent === 'codex' ? ['› ', '', 'gpt-6'] : ['──────────────', '❯ ', '──────────────']
  const write = vi.fn()
  const notify = vi.fn(async (_member: UpdateRestartMember, _words: string) => { void _member; void _words })
  const targets: RestartTarget[] = [{ sessionId: 's', incarnationId: 'old', name: 'Synthetic', workspace: 'Test', agent, conversation, atPress }]
  const options = {
    mainLifetime: 'first',
    freeze: vi.fn(async () => undefined), thaw: vi.fn(),
    path: join(root, 'restart.json'), now: () => new Date(time), monotonic: () => time, targets: async () => structuredClone(targets),
    binding: async () => conversation, currentBinding: () => conversation,
    proof: { now: () => new Date(time), observation: () => seen, liveIncarnation: () => incarnation,
      foreground: () => 'front', generation: () => ({ generation, pending: 0 }),
      screen: async () => ({ lines, cursor: { x: 0, y: 1 } }), write },
    openAttention: async () => open, notify,
    resume: vi.fn(async (_member?: UpdateRestartMember) => { void _member; incarnation = 'new'; seen = undefined; return { sessionId: 's', incarnationId: 'new', attachmentId: 'a', streamSeq: 0, captureStartedAt: new Date(time).toISOString(), modes: [], launch: { cwd: root, executable: agent } } as SessionResumeResult })
  }
  let coordinator = new UpdateRestart(options)
  const hook = (event = 'PostToolUse', extra = {}) => coordinator.hook({ sessionId: 's', incarnationId: 'old', agent, event, source: null, turn: { conversation, nested: false }, ...extra })
  const observe = (event: string, id = incarnation, source: string | null = null): void => { seen = { sessionId: 's', incarnationId: id, agent, event, source, plugin: null, observedAt: new Date(++time).toISOString(), foreground: 'front' } }
  const member = (): UpdateRestartMember => coordinator.snapshot()!.members[0]!
  return { get coordinator() { return coordinator }, options, targets, write, notify, hook, observe, member,
    /** The notice handed at a tool call, printed by the hook and acknowledged. */
    told: async () => { const notice = await hook(); coordinator.printed('s', 'old', notice!.claim); return notice! },
    reopen: () => { coordinator = new UpdateRestart(options); return coordinator },
    /** BMN closed and a new main process opened it: every member stopped, then recovered. */
    closeAndReopen: async (build = '1234567') => {
      coordinator.tick(true)
      for (const m of coordinator.snapshot()!.members) await coordinator.stop(m.sessionId, m.incarnationId, async () => 'confirmed')
      coordinator = new UpdateRestart({ ...options, mainLifetime: 'next' })
      await coordinator.recover(build)
      return coordinator
    },
    confirmStops: async () => { for (const m of coordinator.snapshot()!.members) await coordinator.stop(m.sessionId, m.incarnationId, async () => 'confirmed') },
    setTime: (ms: number) => { time += ms }, setOpen: (rows: WakeAttention[]) => { open = rows },
    setLines: (value: string[]) => { lines = value }, setConversation: (v: string) => { conversation = v },
    changeGeneration: () => { generation++ } }
}
/** The resumed Claude Code run reported its start and two quiet seconds passed. */
const resumedAndQuiet = (f: ReturnType<typeof setup>): void => { f.observe('SessionStart', 'new', 'resume'); f.setTime(2500) }

describe('what BMN knows at the press (125.4 AC2, D4)', () => {
  it('reads an agent session from the latest hook event of its live run, and says so when it has none', () => {
    const idle = (): boolean => false, busy = (): boolean => true
    expect(restartStateAtPress('claude', { event: 'Stop', source: null }, busy)).toBe('ended')
    expect(restartStateAtPress('claude', { event: 'Notification', source: null }, busy)).toBe('ended')
    expect(restartStateAtPress('codex', { event: 'Stop', source: null }, busy)).toBe('ended')
    expect(restartStateAtPress('codex', { event: 'SessionStart', source: 'resume' }, busy)).toBe('ended')
    expect(restartStateAtPress('claude', { event: 'PreToolUse', source: null }, idle)).toBe('working')
    expect(restartStateAtPress('claude', { event: 'UserPromptSubmit', source: null }, idle)).toBe('working')
    expect(restartStateAtPress('claude', { event: 'Stop', source: 'subagent' }, idle)).toBe('working')
    // A finished event while one of its requests waits on the owner is not a session at rest.
    expect(restartStateAtPress('claude', { event: 'Notification', source: null }, idle, true)).toBe('working')
    // No event of this run: BMN does not know, whatever the terminal's activity says.
    expect(restartStateAtPress('claude', undefined, idle)).toBe('unknown')
    expect(restartStateAtPress('codex', undefined, idle)).toBe('unknown')
    expect(restartStateAtPress('bash', undefined, idle)).toBe('ended')
    expect(restartStateAtPress('bash', undefined, busy)).toBe('working')
  })
  it.each(['claude', 'codex'] as const)('a %s session whose turn had ended reads Ready at once and gets no notice', async agent => {
    const f = setup(agent, 'ended')
    await f.coordinator.begin('1234567')
    expect(f.member()).toMatchObject({ ready: true, notice: 'none' })
    expect(updateRestartWords(f.member(), 'waiting')).toBe('Ready')
    expect(await f.hook()).toBeNull()
  })
  it.each([['claude', 'working'], ['claude', 'unknown'], ['codex', 'working'], ['codex', 'unknown']] as const)('a %s session that is %s reads Not told yet, never Ready or Reaching a safe point', async (agent, atPress) => {
    const f = setup(agent, atPress)
    await f.coordinator.begin('1234567')
    expect(f.member()).toMatchObject({ ready: false, notice: 'queued' })
    expect(updateRestartWords(f.member(), 'waiting')).toBe('Not told yet')
    // With no tool call nothing changes, however long it waits and whatever else it reports.
    f.setTime(60_000); f.coordinator.advance(); await f.hook('Stop'); await f.hook('UserPromptSubmit')
    expect(updateRestartWords(f.member(), 'waiting')).toBe('Not told yet')
  })
  it('refuses a stored record that calls a session ready without an ended turn or a printed notice', async () => {
    const f = setup('codex', 'unknown')
    await f.coordinator.begin('1234567')
    const stored = JSON.parse(readFileSync(f.options.path, 'utf8'))
    stored.members[0].ready = true
    writeFileSync(f.options.path, JSON.stringify(stored))
    expect(() => f.reopen()).toThrow(/invalid/u)
  })
})

describe('the notice and the turn end after it (125.4 AC3)', () => {
  it.each(['claude', 'codex'] as const)('prints the %s notice at the next tool call, then Reaching a safe point, then Ready only on a turn end after it', async agent => {
    const f = setup(agent)
    await f.coordinator.begin('1234567')
    const notice = await f.hook()
    expect(notice!.text).toBe(updateRestartNotice(agent, f.coordinator.snapshot()!.closesAt))
    expect(notice!.text).toMatch(/^BMN closes for an update by \d\d:\d\d\. Reach a safe point, write your handoff and end your turn\. /u)
    expect(notice!.text).toContain(agent === 'claude' ? 'BMN will resume this session and tell you to continue. If no line comes, wait for the owner.'
      : 'BMN will resume this session and type nothing into it. Do not continue until the owner tells you to.')
    // Handed is not printed: a turn end before the hook says it printed the notice changes nothing.
    expect(updateRestartWords(f.member(), 'waiting')).toBe('Not told yet')
    await f.hook('Stop')
    expect(f.member().ready).toBe(false)
    expect(f.coordinator.printed('s', 'old', notice!.claim)).toBe(true)
    expect(f.member().printedAt).not.toBeNull()
    expect(updateRestartWords(f.member(), 'waiting')).toBe('Reaching a safe point')
    // A second tool call hands nothing again; a child's stop and the owner's interruption are not its turn end.
    expect(await f.hook()).toBeNull()
    await f.hook('Stop', { source: 'subagent' }); await f.hook('Stop', { source: 'interrupted' })
    await f.hook('Stop', { turn: { conversation: 'conversation', nested: true } })
    expect(f.member().ready).toBe(false)
    await f.hook('Stop')
    expect(updateRestartWords(f.member(), 'waiting')).toBe('Ready')
  })
  it('hands no notice to a session without an agent, or to another run or conversation of the session', async () => {
    const shell = setup('bash')
    await shell.coordinator.begin('1234567')
    expect(shell.member().notice).toBe('none')
    expect(await shell.hook()).toBeNull()
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    expect(await f.hook('PostToolUse', { incarnationId: 'another' })).toBeNull()
    expect(await f.hook('PostToolUse', { turn: { conversation: 'another', nested: false } })).toBeNull()
    expect(f.member().notice).toBe('queued')
  })
})

describe('closing (125.4 AC4, AC5)', () => {
  it('closes by itself once every row is ready and writes each row as ready', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    f.coordinator.advance()
    expect(f.coordinator.snapshot()!.phase).toBe('waiting')
    await f.told(); await f.hook('Stop'); f.coordinator.advance()
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'closing', members: [{ atClose: 'ready' }] })
  })
  it('closes at the limit and writes a row that was not ready as not ready at close', async () => {
    const f = setup('codex', 'unknown')
    await f.coordinator.begin('1234567')
    f.setTime(UPDATE_RESTART_LIMIT_MS - 9000); f.coordinator.advance()
    expect(f.coordinator.snapshot()!.phase).toBe('waiting')
    f.setTime(1000); f.coordinator.advance()
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'closing', members: [{ atClose: 'not-ready', ready: false }] })
  })
  it('Restart now closes at once and records each row as it was', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.told()
    f.coordinator.tick(true)
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'closing', members: [{ atClose: 'not-ready', notice: 'printed' }] })
  })
  it('a cancelled attempt cannot force a later attempt into closing', async () => {
    const f = setup()
    await f.coordinator.begin('1234567', 'first'); f.coordinator.cancel()
    await f.coordinator.begin('1234567', 'second')
    f.coordinator.tick(true, 'first')
    expect(f.coordinator.snapshot()!.phase).toBe('waiting')
  })
})

describe('Cancel (125.4 AC5, D4)', () => {
  it('withdraws a notice that was not printed and lists nobody', async () => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    f.coordinator.cancel()
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'cancelled', members: [{ notice: 'withdrawn', tell: 'unnecessary', atClose: null }] })
    expect(await f.hook()).toBeNull()
    expect(f.options.thaw).toHaveBeenCalled()
  })
  it.each(['claude', 'codex'] as const)('a %s session that was told and still works is told to carry on at its next tool call, by its hook', async agent => {
    const f = setup(agent)
    await f.coordinator.begin('1234567')
    await f.told()
    f.coordinator.cancel()
    expect(f.member()).toMatchObject({ tell: 'pending', tellUntil: null })
    // However long its tool takes, it is not given up while it still works.
    f.setTime(10 * 60_000); f.coordinator.advance(); await f.coordinator.tell()
    expect(f.member().tell).toBe('pending')
    const carry = await f.hook()
    expect(carry!.text).toBe(UPDATE_RESTART_CARRY_ON)
    expect(f.coordinator.printed('s', 'old', carry!.claim)).toBe(true)
    expect(f.member().tell).toBe('told')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('a Claude Code session whose turn ended after the notice gets the line typed once under the idle proof', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.told(); await f.hook('Stop'); f.observe('Stop')
    f.coordinator.cancel()
    await f.coordinator.tell(); await f.coordinator.tell()
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith('s', UPDATE_RESTART_CARRY_ON)
    expect(f.member().tell).toBe('told')
  })
  it('a Codex session whose turn ended after the notice is listed, in the words for an observed stop, and never typed into', async () => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    await f.told(); await f.hook('Stop'); f.observe('Stop')
    f.coordinator.cancel()
    await f.coordinator.tell(); f.setTime(UPDATE_RESTART_TELL_MS * 2); f.coordinator.advance(); await f.coordinator.tell()
    expect(f.member().tell).toBe('not-told')
    expect(updateRestartWords(f.member(), 'cancelled')).toBe('Stopped for the restart · type continue')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('a Claude Code session whose idle proof does not hold is listed after its time, with nothing typed', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.told(); await f.hook('Stop'); f.observe('Stop')
    f.setLines(['──────────────', '❯ a draft the owner is writing', '──────────────'])
    f.coordinator.cancel()
    await f.coordinator.tell()
    expect(f.member().tell).toBe('pending')
    f.setTime(UPDATE_RESTART_TELL_MS + 1); f.coordinator.advance()
    expect(f.member().tell).toBe('not-told')
    expect(updateRestartWords(f.member(), 'cancelled')).toBe('Stopped for the restart · type continue')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('a notice that was handed but never acknowledged ends as Not told to carry on', async () => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    const notice = await f.hook()
    f.coordinator.cancel()
    expect(f.member().tell).toBe('pending')
    f.setTime(UPDATE_RESTART_TELL_MS + 1); f.coordinator.advance()
    expect(f.member().tell).toBe('not-told')
    expect(updateRestartWords(f.member(), 'cancelled')).toBe('Not told to carry on')
    // The acknowledgement arrives after all: the session was told to stop, so it is told to carry on at its next tool call.
    expect(f.coordinator.printed('s', 'old', notice!.claim)).toBe(true)
    expect(f.member()).toMatchObject({ notice: 'printed', tell: 'pending' })
    expect((await f.hook())!.text).toBe(UPDATE_RESTART_CARRY_ON)
  })
  it('a turn end that came before the hook said it printed the notice is kept: Claude Code gets the line, Codex is listed (review F5)', async () => {
    const claude = setup('claude')
    await claude.coordinator.begin('1234567')
    const handed = await claude.hook()
    claude.coordinator.cancel(); claude.coordinator.dismiss()
    await claude.hook('Stop'); claude.observe('Stop')
    expect(claude.coordinator.printed('s', 'old', handed!.claim)).toBe(true)
    expect(claude.member()).toMatchObject({ notice: 'printed', tell: 'pending' })
    expect(claude.member().carryFinishedAt).toBeDefined()
    expect(claude.member().tellUntil).not.toBeNull()
    await claude.coordinator.tell()
    expect(claude.write).toHaveBeenCalledWith('s', UPDATE_RESTART_CARRY_ON)
    expect(claude.member().tell).toBe('told')

    const codex = setup('codex')
    await codex.coordinator.begin('1234567')
    const given = await codex.hook()
    codex.coordinator.cancel(); codex.coordinator.dismiss()
    await codex.hook('Stop')
    expect(codex.coordinator.printed('s', 'old', given!.claim)).toBe(true)
    expect(codex.member()).toMatchObject({ tell: 'not-told', reason: 'BMN types nothing into Codex' })
    expect(codex.member().late).toMatchObject({ words: 'Stopped for the restart · type continue' })
    expect(codex.notify).toHaveBeenCalledTimes(1)
    expect(codex.write).not.toHaveBeenCalled()
  })
  it('a session that went on after that turn end is told at its next tool call instead', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    const handed = await f.hook()
    f.coordinator.cancel()
    await f.hook('Stop'); await f.hook('UserPromptSubmit')
    f.coordinator.printed('s', 'old', handed!.claim)
    expect(f.member()).toMatchObject({ notice: 'printed', tell: 'pending', tellUntil: null })
    expect(f.member().carryFinishedAt).toBeUndefined()
    expect((await f.hook())!.text).toBe(UPDATE_RESTART_CARRY_ON)
  })
  it('a stop with work in flight is never a resting point (review F3)', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.told()
    await f.hook('Stop', { source: 'continues' })
    expect(f.member().ready).toBe(false)
    await f.hook('Stop')
    expect(f.member().ready).toBe(true)
    expect(restartStateAtPress('claude', { event: 'Stop', source: 'continues' }, () => false)).toBe('working')
    expect(restartStateAtPress('claude', { event: 'Stop', source: null }, () => false)).toBe('ended')
  })
  it('a late turn end after the dialog closed: a Claude Code session gets the typed line', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.told()
    f.coordinator.cancel(); f.coordinator.dismiss()
    await f.hook('Stop'); f.observe('Stop')
    expect(f.member().carryFinishedAt).toBeDefined()
    await f.coordinator.tell()
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith('s', UPDATE_RESTART_CARRY_ON)
    expect(f.member()).toMatchObject({ tell: 'told' })
    expect(f.member().late).toBeUndefined()
    expect(f.notify).not.toHaveBeenCalled()
    // The same finished turn is not answered by the hook as well.
    expect(await f.hook()).toBeNull()
  })
  it('a late turn end after the dialog closed: a Codex session gets one notice in Needs You, stored, and nothing typed', async () => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    await f.told()
    f.coordinator.cancel(); f.coordinator.dismiss()
    await f.hook('Stop'); f.observe('Stop')
    await f.hook('Stop'); await f.coordinator.tell(); f.coordinator.advance()
    await Promise.resolve(); await Promise.resolve()
    expect(f.notify).toHaveBeenCalledTimes(1)
    expect(f.notify.mock.calls[0]![1]).toBe('Stopped for the restart · type continue')
    expect(f.member()).toMatchObject({ tell: 'not-told', late: { words: 'Stopped for the restart · type continue', noticed: true } })
    expect(f.write).not.toHaveBeenCalled()
    // The stored result survives a restart of the process that kept it.
    expect(f.reopen().snapshot()!.members[0]!.late).toMatchObject({ words: 'Stopped for the restart · type continue', noticed: true })
  })
  it('while the dialog is still open a result is a row, not a notice', async () => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    await f.told()
    f.coordinator.cancel()
    await f.hook('Stop')
    expect(f.member().tell).toBe('not-told')
    expect(f.member().late).toBeUndefined()
    expect(f.notify).not.toHaveBeenCalled()
  })
  it('an old notice acknowledgement cannot confirm a later carry-on', async () => {
    const f = setup()
    await f.coordinator.begin('1234567')
    const notice = await f.told()
    f.coordinator.cancel()
    await f.hook()
    expect(f.coordinator.printed('s', 'old', notice.claim)).toBe(false)
    expect(f.member().tell).toBe('claimed')
    f.setTime(UPDATE_RESTART_TELL_MS + 1); f.coordinator.advance()
    expect(f.member()).toMatchObject({ tell: 'not-told', reason: 'delivery unconfirmed' })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('cancels while a stop is in flight, resumes that session once and types the carry-on line only into Claude Code', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const f = setup(agent)
      await f.coordinator.begin('1234567')
      await f.told()
      f.coordinator.tick(true)
      let finish!: (value: 'confirmed') => void
      const stopping = f.coordinator.stop('s', 'old', () => new Promise(resolve => { finish = resolve }))
      f.coordinator.cancel()
      expect(f.coordinator.snapshot()!.phase).toBe('cancelling')
      const recovering = f.coordinator.recoverCancelled()
      finish('confirmed'); await stopping; await recovering
      expect(f.options.resume).toHaveBeenCalledTimes(1)
      resumedAndQuiet(f)
      await f.coordinator.tell(); await f.coordinator.tell()
      if (agent === 'claude') {
        expect(f.write).toHaveBeenCalledTimes(1)
        expect(f.write).toHaveBeenCalledWith('s', UPDATE_RESTART_CARRY_ON)
        expect(f.coordinator.snapshot()).toMatchObject({ phase: 'cancelled', members: [{ tell: 'told' }] })
      } else {
        expect(f.write).not.toHaveBeenCalled()
        expect(f.coordinator.snapshot()).toMatchObject({ phase: 'cancelled', members: [{ tell: 'not-told' }] })
        expect(updateRestartWords(f.member(), 'cancelled')).toBe('Not told to carry on')
      }
    }
  })
  it('aborts before stopping, and refuses to abort once stopping began', async () => {
    const f = setup()
    await f.coordinator.begin('1234567')
    f.coordinator.tick(true)
    f.coordinator.abort('the launcher did not answer')
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'cancelled', error: 'the launcher did not answer' })
    const g = setup()
    await g.coordinator.begin('1234567'); g.coordinator.tick(true)
    void g.coordinator.stop('s', 'old', () => new Promise(() => undefined))
    expect(() => g.coordinator.abort('late')).toThrow(/Stopping has begun/u)
  })
})

describe('after reopening: Claude Code is told once, under the idle proof (125.5 AC2, AC3, AC5)', () => {
  it('the proof starts from the resumed run\'s own start and nothing else', () => {
    const seen = (agent: string, event: string, source: string | null): WakeObservation => ({ sessionId: 's', incarnationId: 'new', agent, event, source, plugin: null, observedAt: '2026-11-13T12:00:00.000Z', foreground: 'front' })
    expect(resumedStart(seen('claude', 'SessionStart', 'resume'))).toBeNull()
    expect(resumedStart(seen('claude', 'SessionStart', 'startup'))).toMatch(/not the start of its resumed run/u)
    expect(resumedStart(seen('claude', 'UserPromptSubmit', null))).toMatch(/UserPromptSubmit/u)
    expect(resumedStart(seen('codex', 'SessionStart', 'resume'))).toMatch(/types nothing/u)
  })
  it('a session that reached its safe point is resumed without a press and told to continue, once', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.told(); await f.hook('Stop')
    await f.closeAndReopen()
    expect(f.options.resume).toHaveBeenCalledTimes(1)
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'resuming', openedBuild: '1234567', members: [{ resume: 'resumed', atClose: 'ready', tell: 'pending' }] })
    // Before the resumed run reports its start nothing is typed.
    await f.coordinator.tell()
    expect(f.write).not.toHaveBeenCalled()
    expect(updateRestartWords(f.member(), 'after')).toBe('Resumed · waiting to tell')
    // A notice the closed run left open (seen live: a repeated-call notice) is nothing the resumed run waits on.
    f.setOpen([{ sessionId: 's', requestKey: 'watch:repeat', kind: 'notice', state: 'open', openedAt: '2026-11-13T12:00:00.000Z' }])
    f.observe('SessionStart', 'new', 'resume')
    await f.coordinator.tell()
    expect(f.write).not.toHaveBeenCalled() // two quiet seconds first
    f.setTime(2500)
    await f.coordinator.tell(); await f.coordinator.tell(); f.coordinator.advance()
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith('s', UPDATE_RESTART_CONTINUE)
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'complete', members: [{ tell: 'told' }] })
    expect(updateRestartWords(f.member(), 'after')).toBe('Resumed · told to continue')
  })
  it('a session that was not ready at close is told to check its work first', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.closeAndReopen()
    resumedAndQuiet(f)
    await f.coordinator.tell()
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith('s', UPDATE_RESTART_CHECK)
    expect(updateRestartWords(f.member(), 'after')).toBe('Resumed · told to check its work')
  })
  it.each([
    ['a draft in its prompt', (f: ReturnType<typeof setup>) => f.setLines(['──────────────', '❯ a draft', '──────────────'])],
    ['a dialog on its screen', (f: ReturnType<typeof setup>) => f.setLines(['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'])],
    ['a request of it open', (f: ReturnType<typeof setup>) => f.setOpen([{ sessionId: 's', requestKey: 'claude:permission', kind: 'permission', state: 'open', openedAt: '2026-11-13T12:00:00.000Z' }])],
    ['another event after its start', (f: ReturnType<typeof setup>) => f.observe('UserPromptSubmit', 'new')],
    ['a changed conversation', (f: ReturnType<typeof setup>) => f.setConversation('another')]
  ] as const)('types nothing when the proof fails (%s), and says the session was not told once its time is over', async (_name, spoil) => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.told(); await f.hook('Stop')
    await f.closeAndReopen()
    resumedAndQuiet(f); spoil(f)
    await f.coordinator.tell()
    expect(f.member().tell).toBe('pending')
    f.setTime(UPDATE_RESTART_TELL_MS); f.coordinator.advance(); await f.coordinator.tell()
    expect(f.write).not.toHaveBeenCalled()
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'complete', members: [{ tell: 'not-told' }] })
    expect(updateRestartWords(f.member(), 'after')).toBe('Resumed · not told, type continue')
  })
  it('a Claude Code session whose state BMN did not know, and that was never told to stop, is not typed into', async () => {
    const f = setup('claude', 'unknown')
    await f.coordinator.begin('1234567')
    await f.closeAndReopen()
    resumedAndQuiet(f)
    await f.coordinator.tell()
    expect(f.write).not.toHaveBeenCalled()
    expect(updateRestartWords(f.member(), 'after')).toBe('Resumed · not told, type continue')
  })
  it.each(['claude', 'codex', 'bash'] as const)('a %s session whose turn had ended before the press is resumed with nothing typed and reads Resumed', async agent => {
    const f = setup(agent, 'ended')
    await f.coordinator.begin('1234567')
    await f.closeAndReopen()
    resumedAndQuiet(f)
    await f.coordinator.tell(); f.coordinator.advance()
    expect(f.write).not.toHaveBeenCalled()
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'complete', members: [{ resume: 'resumed', tell: 'unnecessary' }] })
    expect(updateRestartWords(f.member(), 'after')).toBe('Resumed')
  })
  it('a write that throws is one attempt: nothing is typed again', async () => {
    const f = setup('claude')
    f.write.mockImplementation(() => { throw new Error('the terminal went away') })
    await f.coordinator.begin('1234567')
    await f.closeAndReopen()
    resumedAndQuiet(f)
    await f.coordinator.tell(); await f.coordinator.tell(); await f.coordinator.tell()
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.member().tell).toBe('not-told')
  })
})

describe('after reopening: nothing is typed into Codex (125.5 AC4, D3)', () => {
  it.each([
    ['not ready at close', async (f: ReturnType<typeof setup>) => { await f.told() }, 'Resumed · not told, not ready at close'],
    ['ready after its notice', async (f: ReturnType<typeof setup>) => { await f.told(); await f.hook('Stop') }, 'Resumed · not told, type continue'],
    ['never told, the limit passed', async () => undefined, 'Resumed · not told, not ready at close']
  ] as const)('a Codex session (%s) is resumed and never typed into', async (_name, before, words) => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    await before(f)
    await f.closeAndReopen()
    expect(f.member()).toMatchObject({ resume: 'resumed', tell: 'not-told' })
    // Whatever the resumed run shows or reports, and for as long as BMN keeps asking.
    f.observe('SessionStart', 'new', 'resume'); f.setTime(2500)
    for (let n = 0; n < 5; n += 1) { await f.coordinator.tell(); f.coordinator.advance(); f.setTime(UPDATE_RESTART_TELL_MS) }
    expect(f.write).not.toHaveBeenCalled()
    expect(updateRestartWords(f.member(), 'after')).toBe(words)
    expect(f.coordinator.snapshot()!.phase).toBe('complete')
  })
  it('says so to every route that types a line, until the resumed run finishes a turn of its own', async () => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    expect(f.coordinator.typesNothingInto('s')).toBe(false)
    await f.told()
    await f.closeAndReopen()
    expect(f.coordinator.typesNothingInto('s')).toBe(true)
    f.observe('SessionStart', 'new', 'resume')
    expect(f.coordinator.typesNothingInto('s')).toBe(true)
    f.observe('UserPromptSubmit', 'new'); f.observe('Stop', 'new', 'subagent')
    expect(f.coordinator.typesNothingInto('s')).toBe(true)
    // The owner told it to continue and it finished that turn: the ordinary wakes apply again.
    f.observe('Stop', 'new')
    expect(f.coordinator.typesNothingInto('s')).toBe(false)
    expect(f.coordinator.typesNothingInto('another-session')).toBe(false)
  })
  it('never says it for a Claude Code session', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.closeAndReopen()
    expect(f.coordinator.typesNothingInto('s')).toBe(false)
  })
})

describe('resuming keeps what it cannot confirm (125.5 AC6)', () => {
  it('a resume that fails names its reason in its row, and a reported command stays unticked', async () => {
    const f = setup('claude')
    f.options.resume.mockRejectedValueOnce(new Error('tick to run its command'))
    await f.coordinator.begin('1234567')
    await f.closeAndReopen()
    expect(f.member()).toMatchObject({ resume: 'failed', tell: 'not-told' })
    expect(updateRestartWords(f.member(), 'after')).toBe('Not resumed · tick to run its command')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('does not resume a session whose stop it could not confirm', async () => {
    const f = setup()
    await f.coordinator.begin('1234567'); f.coordinator.tick(true)
    await f.coordinator.stop('s', 'old', async () => 'unknown')
    const next = new UpdateRestart({ ...f.options, mainLifetime: 'next' })
    await next.recover('1234567')
    expect(f.options.resume).not.toHaveBeenCalled()
    expect(next.snapshot()!.members[0]).toMatchObject({ resume: 'failed', tell: 'not-told' })
  })
  it('the same main process cannot recover its own closing restart', async () => {
    const f = setup()
    await f.coordinator.begin('1234567'); f.coordinator.tick(true); await f.confirmStops()
    await f.reopen().recover('1234567')
    expect(f.options.resume).not.toHaveBeenCalled()
  })
  it('never replays a resume or a typed line whose outcome it did not learn', async () => {
    const f = setup('claude')
    await f.coordinator.begin('1234567')
    await f.closeAndReopen()
    const stored = JSON.parse(readFileSync(f.options.path, 'utf8'))
    stored.members[0].tell = 'claimed'
    writeFileSync(f.options.path, JSON.stringify(stored))
    const next = new UpdateRestart({ ...f.options, mainLifetime: 'third' })
    expect(next.snapshot()!.members[0]).toMatchObject({ tell: 'not-told', reason: 'delivery unconfirmed' })
    resumedAndQuiet(f); await next.tell()
    expect(f.write).not.toHaveBeenCalled()
    stored.members[0].tell = 'pending'; stored.members[0].resume = 'claimed'; stored.phase = 'resuming'
    writeFileSync(f.options.path, JSON.stringify(stored))
    const again = new UpdateRestart({ ...f.options, mainLifetime: 'fourth' })
    expect(again.snapshot()!.members[0]).toMatchObject({ resume: 'failed', reason: 'resume outcome unconfirmed' })
    await again.recover('1234567')
    expect(f.options.resume).toHaveBeenCalledTimes(1)
  })
  it('a restart interrupted before BMN closed lists only the sessions that were told to stop', async () => {
    const f = setup('codex')
    await f.coordinator.begin('1234567')
    await f.told()
    expect(f.reopen().snapshot()).toMatchObject({ phase: 'cancelled', members: [{ tell: 'not-told' }] })
    const g = setup('codex')
    await g.coordinator.begin('1234567')
    expect(g.reopen().snapshot()).toMatchObject({ phase: 'cancelled', members: [{ tell: 'unnecessary', notice: 'withdrawn' }] })
  })
  it('withdraws cached notices when admission fails before any notice can be printed', async () => {
    const f = setup()
    f.options.freeze.mockRejectedValueOnce(new Error('A session start has not settled; no restart began'))
    await expect(f.coordinator.begin('1234567')).rejects.toThrow(/no restart began/u)
    expect(f.coordinator.snapshot()).toMatchObject({ phase: 'cancelled', error: 'A session start has not settled; no restart began' })
    expect(f.options.thaw).toHaveBeenCalled()
  })
  it('dismissing the result keeps the record', async () => {
    const f = setup()
    await f.coordinator.begin('1234567'); f.coordinator.cancel(); f.coordinator.dismiss()
    expect(f.reopen().snapshot()).toMatchObject({ phase: 'cancelled', dismissed: true })
  })
})
