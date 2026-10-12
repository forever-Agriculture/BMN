// MODULE: agents-ask-race.test.ts - Epic 64's final recheck: the day's limit holds while other BMN processes change the kept questions between two reads of one that is about to ask
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A barrier inside this process's own read of the kept questions: `before` runs when the file is
 * about to be read, `after` when it has been read and its text is not yet handed on. Each runs
 * once. What they do, other BMN processes do: this process stands still meanwhile, as a process
 * does that the system took off the processor between two reads.
 */
const barrier = vi.hoisted(() => ({ path: null as string | null, before: null as (() => void) | null, after: null as (() => void) | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = (path: unknown, ...rest: unknown[]): unknown => {
    const read = actual.readFileSync as (...args: unknown[]) => unknown
    if (barrier.path === null || path !== barrier.path) return read(path, ...rest)
    const before = barrier.before
    barrier.before = null
    before?.()
    const text = read(path, ...rest)
    const after = barrier.after
    barrier.after = null
    after?.()
    return text
  }
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

const { ASK_PER_DAY, askedCount, questionsPath, readQuestions, runAsk } = await import('../../bin/agents-ask.mjs')
const { chooseResearcher, researchLockHolder } = await import('../../bin/agents-research.mjs')
const { readValidRoster } = await import('../../bin/agents-state.mjs')
const { approveRoster } = await import('../main/agents-approval')

const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const BIN = fileURLToPath(new URL('../../bin/', import.meta.url))
const QUESTION = 'How do people use the Jev 1.13 model, according to public pages?'

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

const state = (): string => join(home, '.config/bmn/agents/state/research')
const localDay = (date: Date): string => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
const keptFile = (): { asked: { day: string; count: number }; merged: string[] } => JSON.parse(readFileSync(questionsPath(), 'utf8'))
/** How often the stand-in researcher was started. */
const launches = (): number => (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').length : 0)

/** Another BMN process changes the kept questions once: it takes in every end that lies beside the file. */
function otherProcessWrites(): void {
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { removeQuestions } from ${JSON.stringify(`${BIN}agents-ask.mjs`)}
    await removeQuestions('no-such-question')
  `], { env, encoding: 'utf8' })
  if (ran.status !== 0) throw new Error(`the other process could not write: ${ran.stderr}`)
}

/** Another BMN process asks one whole question from a shell, start to end; its researcher gives no usable answer, which is counted like any question that ran. */
function otherProcessAsks(): void {
  const ran = spawnSync(process.execPath, [join(BIN, 'bmn'), 'research', 'ask', '--json'], { input: `${QUESTION}\n`, env, encoding: 'utf8' })
  const result = JSON.parse(ran.stdout) as { outcome: string }
  if (result.outcome !== 'no-answer') throw new Error(`the other process's question ended ${result.outcome}: ${ran.stdout}`)
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-ask-race-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  // A stand-in for Claude Code: it notes that it was started and prints text that is no answer.
  writeFileSync(join(stubs, 'claude'), `#!${process.execPath}
const fs = require('node:fs')
if (process.argv[2] === '--version') { console.log('2.1.295 (Claude Code)'); process.exit(0) }
fs.readFileSync(0, 'utf8')
fs.appendFileSync(process.env.HOME + '/calls.log', 'started\\n')
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'I could not find it.' }))
`)
  chmodSync(join(stubs, 'claude'), 0o755)
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), EXAMPLE)
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
  chooseResearcher('fable')
  mkdirSync(join(state(), 'question-ends'), { recursive: true })
  barrier.path = questionsPath()
})

afterEach(() => {
  barrier.path = null
  barrier.before = null
  barrier.after = null
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('the day\'s limit while other processes write between this one\'s reads (R64-NFR3, 64.1 AC7)', () => {
  it('a refund another process took in meanwhile is not given back a second time: the twentieth question of the day is the last', async () => {
    const today = new Date()
    // Nineteen questions ran today. One more was reserved and then refused by the check: its end lies beside the kept file and gives its one back.
    const reserved = { id: '20261012T090000-qaaaaaa', at: today.toISOString(), by: { kind: 'shell' }, researcher: 'fable', researcher_name: 'Fable', question: 'Which page says it?', outcome: 'running' }
    writeFileSync(questionsPath(), JSON.stringify({ version: 1, asked: { day: localDay(today), count: ASK_PER_DAY }, merged: [], questions: [reserved] }))
    writeFileSync(join(state(), 'question-ends', `${reserved.id}.json`), JSON.stringify({ version: 1, record: { ...reserved, outcome: 'refused', code: 'ROUTE_UNSUPPORTED', note: 'refused by the check' }, day: localDay(today), refund: true }))
    expect(askedCount(today)).toBe(ASK_PER_DAY - 1)
    // This process has read the ends and is about to read the kept file. Meanwhile one process takes the end in and removes its file,
    // and another asks the day's twentieth question, whose writes no longer name the end that is gone.
    barrier.before = () => {
      otherProcessWrites()
      otherProcessAsks()
    }
    // The reader itself: it reads again, and says twenty, not nineteen.
    expect(askedCount(today)).toBe(ASK_PER_DAY)
    expect(barrier.before).toBeNull()
    expect(readQuestions().map((entry) => entry.outcome)).toEqual(['refused', 'no-answer'])
    const result = await runAsk({ question: QUESTION, environment: env })
    expect(result).toMatchObject({ ok: false, outcome: 'refused', code: 'DAY_LIMIT' })
    // The other process's question was the only one that reached a researcher.
    expect(launches()).toBe(1)
    expect(askedCount(new Date())).toBe(ASK_PER_DAY)
    expect(keptFile().asked.count).toBe(ASK_PER_DAY)
    expect(researchLockHolder()).toBeNull()
  }, 60_000)

  it('a reader that finds an end gone at every read gives nothing back twice: it says the kept file\'s own count, never less than is true', async () => {
    const today = new Date()
    const reserved = (index: number) => ({ id: `20261012T09000${index}-qaaaaaa`, at: today.toISOString(), by: { kind: 'shell' }, researcher: 'fable', researcher_name: 'Fable', question: 'Which page says it?', outcome: 'running' })
    const refund = (index: number): void => writeFileSync(join(state(), 'question-ends', `${reserved(index).id}.json`),
      JSON.stringify({ version: 1, record: { ...reserved(index), outcome: 'refused', code: 'ROUTE_UNSUPPORTED', note: 'refused by the check' }, day: localDay(today), refund: true }))
    writeFileSync(questionsPath(), JSON.stringify({ version: 1, asked: { day: localDay(today), count: 10 }, merged: [], questions: [1, 2, 3, 4, 5].map(reserved) }))
    refund(1)
    // At every read of the kept file other processes have just taken the waiting end in and written once more, so that
    // nothing names it any longer, and the next question's end has come.
    let round = 1
    const overtake = (): void => {
      otherProcessWrites()
      otherProcessWrites()
      round += 1
      refund(round)
      if (round < 5) barrier.before = overtake
    }
    barrier.before = overtake
    // Four ends were taken in (10 - 4); the fifth lies beside the file, unread by this reader. Six is said, five is true: never fewer.
    expect(askedCount(today)).toBe(6)
    expect(round).toBe(5)
    expect(keptFile().asked.count).toBe(6)
    // With nobody writing meanwhile the same reader says what is true.
    expect(askedCount(today)).toBe(5)
  }, 60_000)

  it('the limit is judged again when a question reserves its place: one that read nineteen and was overtaken is refused, and nothing is started for it', async () => {
    const today = new Date()
    writeFileSync(questionsPath(), JSON.stringify({ version: 1, asked: { day: localDay(today), count: ASK_PER_DAY - 1 }, merged: [], questions: [] }))
    // This process has read nineteen and has not yet acted on it. Meanwhile another one asks the day's twentieth question.
    barrier.after = otherProcessAsks
    const result = await runAsk({ question: QUESTION, environment: env })
    expect(barrier.after).toBeNull()
    expect(result).toMatchObject({ ok: false, outcome: 'refused', code: 'DAY_LIMIT' })
    expect(result.message).toMatch(/20 web questions were asked today/)
    expect(launches()).toBe(1)
    expect(askedCount(new Date())).toBe(ASK_PER_DAY)
    expect(keptFile().asked.count).toBe(ASK_PER_DAY)
    // The research lock it took for the question is free again, and the refusal is kept without a run of its own.
    expect(researchLockHolder()).toBeNull()
    const kept = readQuestions().find((entry) => entry.id === result.id)
    expect(kept).toMatchObject({ outcome: 'refused', code: 'DAY_LIMIT' })
    expect(kept?.run).toBeUndefined()
  }, 60_000)
})
