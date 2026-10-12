// MODULE: agents-ask.test.ts - Epic 64.1: one web question behind the research fence, over a synthetic team, a stand-in app and made-up pages; no provider and no real site is reached
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ASK_KEPT, ASK_MAX_CHARS, ASK_PER_DAY, MARKS, RESEARCH_USAGE, agentsMayAsk, askEnvironment, askPrompt, askedCount, askedToday, askerOf, askerWords, answerLines, markClaims,
  noResearcherWords, parseAskAnswer, questionProblem, questionsPath, readQuestions, removeQuestions, runAsk, setAgentsMayAsk, type QuestionRecord
} from '../../bin/agents-ask.mjs'
import { CODEX_RESEARCH_TOOLS_SEEN, researchFormHash, researchRunsDirectory, type FenceTestEntry } from '../../bin/agents-check.mjs'
import { RESEARCH_RUNNING, chooseResearcher, researchArgv, researchLockHolder, researchLockPath, runResearch, takeResearchLock, type PageRead } from '../../bin/agents-research.mjs'
import { readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster } from '../main/agents-approval'

const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const BIN = fileURLToPath(new URL('../../bin/', import.meta.url))
const NOW = new Date('2026-10-12T12:00:00.000Z')
/** A made-up key of the shape a provider gives out; it must appear in nothing BMN prints or keeps. */
const PLANTED = 'sk-synthetic-Zx81QpLmN47vTyUo02KdEa'
const QUESTION = 'How do people use the Jev 1.13 model, according to public pages?'
/** The body of `noResearcherWords` in a source file: the lines that make its three sentences. */
const wordsBody = (path: string): string[] => {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const from = source.indexOf('export function noResearcherWords(')
  return source.slice(source.indexOf('\n', from) + 1, source.indexOf('\n}', from)).split('\n').map((line) => line.trim())
}

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

function approve(text: string): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), text)
  let generation: number | null
  try {
    generation = JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation
  } catch {
    generation = null
  }
  approveRoster({ generation, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

/** The same file with `researcher: true` on each named agent's own entry. */
const naming = (text: string, ...ids: string[]): string => ids.reduce((all, id) => {
  const roles = all.indexOf('\nroles:', all.indexOf(`## ${id}\n`))
  const end = all.indexOf('\n', roles + 1)
  return `${all.slice(0, end)}\nresearcher: true${all.slice(end)}`
}, text)

/**
 * A stand-in for an agent app. It records what it was started with and answers from `plan.json`.
 * Claude Code prints a result object; Codex writes its last message to the `-o` file.
 */
function stubApp(name: 'claude' | 'codex', version: string): void {
  writeFileSync(join(stubs, name), `#!${process.execPath}
const fs = require('node:fs')
const home = process.env.HOME
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }
const prompt = fs.readFileSync(0, 'utf8')
fs.appendFileSync(home + '/calls.log', JSON.stringify({ app: ${JSON.stringify(name)}, argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), files: fs.readdirSync('.'), prompt }) + '\\n')
const plan = JSON.parse(fs.readFileSync(home + '/plan.json', 'utf8'))
setTimeout(() => {
  if (plan.exit) process.exit(plan.exit)
  if (${JSON.stringify(name)} === 'codex') fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], plan.text)
  else console.log(JSON.stringify({ type: 'result', is_error: false, result: plan.text }))
}, plan.delay ?? 0)
`)
  chmodSync(join(stubs, name), 0o755)
}

interface Plan { text?: string; delay?: number; exit?: number }
const plan = (entry: Plan): void => writeFileSync(join(home, 'plan.json'), JSON.stringify(entry))
const calls = (): { app: string; argv: string[]; env: Record<string, string>; cwd: string; files: string[]; prompt: string }[] =>
  (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])

const USES = 'https://docs.example.org/jev/uses'
const BLOG = 'https://blog.example.org/jev'
const GONE = 'https://gone.example.org/jev'
const PAGES: Record<string, string> = {
  [USES]: '<html><body><h1>Uses</h1><p>Teams use Jev for intent routing: &ldquo;Which team should handle this?&rdquo; with billing, shipping and returns.</p><script>var hidden = "urgency detection is common"</script></body></html>',
  [BLOG]: '<main><p>Jev reached the gateway in September and costs little per call.</p></main>'
}
const fetchPage = async (address: string): Promise<PageRead> => (PAGES[address] === undefined ? { ok: false, reason: 'the site answered 404' } : { ok: true, text: PAGES[address]! })

const ANSWER = {
  version: 1,
  answer: 'People use Jev mostly to route requests by intent.',
  claims: [
    { claim: 'Jev is used for intent routing.', source: USES, passage: 'Teams use Jev for intent routing: "Which team should handle this?"' },
    { claim: 'Urgency detection is a common use.', source: USES, passage: 'urgency detection is common' },
    { claim: 'A vendor page lists four patterns.', source: GONE, passage: 'four patterns: speculative fan-out' }
  ],
  not_found: ['an independent accuracy measurement']
}
const answered = (): void => plan({ text: JSON.stringify(ANSWER) })

const ask = (options: Partial<Parameters<typeof runAsk>[0]> = {}) => runAsk({ question: QUESTION, environment: env, now: () => NOW, fetchPage, ...options })
/** Everything BMN keeps or made under the research state folder, as one text. */
const everythingKept = (): string => {
  const read = (folder: string): string => (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).map((entry) =>
    (entry.isDirectory() ? read(join(folder, entry.name)) : `${entry.name}\n${readFileSync(join(folder, entry.name), 'utf8')}`)).join('\n') : '')
  return read(join(home, '.config/bmn/agents/state/research'))
}
const FENCED: FenceTestEntry[] = [{
  harness: 'codex', at: '2026-10-10T11:00:00.000Z', version: '0.161.0', form: researchFormHash('codex'), catalog: 'bundled', verdict: 'pass', reasons: [],
  models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map((id) => ({ model: id, verdict: 'pass' as const, tools: [...CODEX_RESEARCH_TOOLS_SEEN], reasons: [] }))
}]
const SAME = async () => ({ ok: true, compared: true })

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-ask-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stubApp('claude', '2.1.295 (Claude Code)')
  stubApp('codex', 'codex-cli 0.161.0')
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  approve(EXAMPLE)
  chooseResearcher('fable')
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('what leaves (64.1 AC1, AC2)', () => {
  it('the prompt is the frame and the question, and nothing else', async () => {
    answered()
    const result = await ask()
    expect(result).toMatchObject({ ok: true, outcome: 'answered', researcher: 'fable' })
    const [call] = calls()
    expect(calls()).toHaveLength(1)
    expect(call!.prompt).toBe(askPrompt(QUESTION))
    const frame = askPrompt('')
    expect(askPrompt(QUESTION)).toBe(`${frame.slice(0, -1)}${QUESTION}\n`)
    // The frame asks for web search and page reads only, one JSON object, and forbids guessing.
    expect(frame).toContain('Use web search and page reads only.')
    expect(frame).toContain('Answer with one JSON object and nothing else')
    expect(frame).toContain('A claim without a page is left out. Never guess')
    for (const word of ['fable', 'Fable', home, 'roster', 'BMN']) expect(frame).not.toContain(word)
    // The command is the research form of the team's agent, from the folder BMN made, with a bare environment.
    const agent = readApproved().data.agents.find((entry) => entry.id === 'fable')!
    const run = { folder: join(call!.cwd, '..') }
    expect(['claude', ...call!.argv]).toEqual(researchArgv(agent, { environment: env, run }).slice(researchArgv(agent, { environment: env, run }).indexOf('claude')))
    expect(Object.keys(call!.env).filter((name) => !['HOME', 'PATH'].includes(name) && !name.startsWith('__') && name !== '_')).toEqual([])
    expect(call!.files).toEqual([])
    expect(realpathSync(join(call!.cwd, '..', '..'))).toBe(realpathSync(researchRunsDirectory()))
    expect(readFileSync(join(call!.cwd, '..', 'prompt.md'), 'utf8')).toBe(askPrompt(QUESTION))
    expect(JSON.parse(readFileSync(join(call!.cwd, '..', 'receipt.json'), 'utf8'))).toMatchObject({ mode: 'research', verdict: 'PASS', agent: 'fable' })
  })

  it('a refused check starts no app and is given in the check\'s own words', async () => {
    approve(naming(EXAMPLE, 'opus'))
    answered()
    const result = await ask({ agent: 'fable' })
    expect(result).toMatchObject({ ok: false, outcome: 'refused', code: 'NOT_A_RESEARCHER' })
    expect(result.message).toContain('fable is not one of the team\'s researchers (opus)')
    expect(result.next).toContain('pick a researcher the team names')
    expect(calls()).toEqual([])
    // An agent the team does not have is refused before anything is made.
    const unknown = await ask({ agent: 'nobody' })
    expect(unknown).toMatchObject({ ok: false, outcome: 'refused' })
    expect(unknown.message).toContain('nobody')
    expect(calls()).toEqual([])
    expect(readQuestions().map((entry) => [entry.outcome, entry.code, entry.question])).toEqual([['refused', 'NOT_A_RESEARCHER', QUESTION], ['refused', unknown.code, QUESTION]])
  })
})

describe('the answer and its marks (64.1 AC3)', () => {
  it('reads each cited page itself and marks every claim', async () => {
    answered()
    const result = await ask()
    expect(result.answer).toBe(ANSWER.answer)
    expect(result.claims!.map((claim) => claim.mark)).toEqual([MARKS.found, MARKS.missing, MARKS.unreadable])
    expect(result.claims![2]!.why).toBe('the site answered 404')
    expect(result.counts).toEqual({ found: 1, not_found: 1, unreadable: 1 })
    expect(result.not_found).toEqual(ANSWER.not_found)
    // The claims come back as they were given, with the mark added.
    expect(result.claims!.map(({ claim, source, passage }) => ({ claim, source, passage }))).toEqual(ANSWER.claims)
    const lines = answerLines(result, 'Fable').join('\n')
    expect(lines).toContain('Claims (1 with the passage found on the page, 1 read but not found, 1 on a page BMN could not read):')
    expect(lines).toContain(`${MARKS.unreadable} (the site answered 404)`)
    expect(lines).toContain('Asked of Fable')
  })

  it('reads a page once, only inside the question\'s time, and never after Stop', async () => {
    let reads = 0
    const counting = async (address: string): Promise<PageRead> => { reads += 1; return fetchPage(address) }
    const claims = ANSWER.claims.map((claim) => ({ ...claim }))
    expect((await markClaims(claims, { fetchPage: counting })).map((claim) => claim.mark)).toEqual([MARKS.found, MARKS.missing, MARKS.unreadable])
    expect(reads).toBe(2)
    const late = await markClaims(claims, { fetchPage: counting, deadline: Date.now() - 1 })
    expect(late.map((claim) => [claim.mark, claim.why])).toEqual(claims.map(() => [MARKS.unreadable, 'the question\'s time ran out']))
    const stopped = new AbortController()
    stopped.abort()
    expect((await markClaims(claims, { fetchPage: counting, signal: stopped.signal })).every((claim) => claim.why === 'the question was stopped')).toBe(true)
    expect(reads).toBe(2)
  })

  it.each([
    ['prose', 'People use it for routing.'],
    ['another version', JSON.stringify({ ...ANSWER, version: 2 })],
    ['a field BMN did not ask for', JSON.stringify({ ...ANSWER, confidence: 0.9 })],
    ['a claim without a page', JSON.stringify({ ...ANSWER, claims: [{ claim: 'x', passage: 'a passage long enough to count' }] })],
    ['a page that is not https', JSON.stringify({ ...ANSWER, claims: [{ claim: 'x', source: 'http://docs.example.org/a', passage: 'a passage long enough to count' }] })],
    ['a passage too short to mean anything', JSON.stringify({ ...ANSWER, claims: [{ claim: 'x', source: USES, passage: 'Jev' }] })],
    ['more claims than asked for', JSON.stringify({ ...ANSWER, claims: Array.from({ length: 13 }, () => ANSWER.claims[0]) })],
    ['no answer text', JSON.stringify({ ...ANSWER, answer: '  ' })]
  ])('an answer that is not the asked shape (%s) is no usable answer, never repaired', async (_label, text) => {
    expect(parseAskAnswer(text).ok).toBe(false)
    plan({ text })
    const result = await ask()
    expect(result).toMatchObject({ ok: false, outcome: 'no-answer' })
    expect(result.note).toMatch(/^no usable answer: /)
    expect(result.run).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/)
    expect(result.claims).toBeUndefined()
    expect(readQuestions()[0]).toMatchObject({ outcome: 'no-answer', run: result.run, question: QUESTION })
  })

  it('takes an answer in a code fence and one with no claims', () => {
    expect(parseAskAnswer(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``)).toMatchObject({ ok: true, answer: ANSWER.answer })
    expect(parseAskAnswer(JSON.stringify({ version: 1, answer: 'No page says.', claims: [], not_found: ['anything'] }))).toEqual({ ok: true, answer: 'No page says.', claims: [], notFound: ['anything'] })
  })
})

describe('who answers (64.1 AC4)', () => {
  it('goes to the researcher picked on Models, or to the one named where the team names it', async () => {
    approve(naming(EXAMPLE, 'opus', 'fable'))
    chooseResearcher('opus')
    answered()
    expect((await ask()).researcher).toBe('opus')
    expect((await ask({ agent: 'fable' })).researcher).toBe('fable')
    expect(calls().map((call) => call.argv[call.argv.indexOf('--model') + 1])).toEqual(['claude-opus-5-5', 'claude-fable-5-1'])
    expect(readQuestions().map((entry) => [entry.researcher, entry.researcher_name])).toEqual([['opus', 'Opus'], ['fable', 'Fable']])
  })

  it('says why nobody can research now in the words Models uses, and starts nothing', async () => {
    // The command and the Models page say it with the same sentences: the two functions' bodies are the same lines.
    expect(wordsBody('../../bin/agents-ask.mjs')).toHaveLength(4)
    expect(wordsBody('../../bin/agents-ask.mjs')).toEqual(wordsBody('../renderer/src/models-preferences.tsx'))
    // The team names one researcher and its app is not installed.
    approve(naming(EXAMPLE, 'opus'))
    chooseResearcher('opus')
    rmSync(join(stubs, 'claude'))
    answered()
    const result = await ask()
    expect(result).toMatchObject({ ok: false, outcome: 'refused', code: 'NO_RESEARCHER' })
    expect(result.message).toContain(noResearcherWords(['opus']))
    expect(result.message).toContain('Research needs one of the researchers your team names')
    expect(result.message).toContain('Opus: Claude Code was not found')
    expect(calls()).toEqual([])
    expect(existsSync(researchRunsDirectory())).toBe(false)
  })

  it('says so when the picked researcher is no longer one the team names', async () => {
    approve(naming(EXAMPLE, 'opus'))
    const result = await ask()
    expect(result).toMatchObject({ ok: false, outcome: 'refused', code: 'NO_RESEARCHER' })
    expect(result.message).toContain('Fable is no longer one of your team\'s researchers, so no researcher is picked')
    expect(calls()).toEqual([])
  })
})

describe('what a question may not be (64.1 AC5)', () => {
  it.each([
    ['empty', '   \n', 'QUESTION_EMPTY'],
    ['too long', 'why '.repeat(ASK_MAX_CHARS / 4 + 1), 'QUESTION_TOO_LONG'],
    ['a credential-shaped word', `Is the key ${PLANTED} still valid for the gateway?`, 'QUESTION_HOLDS_CREDENTIAL'],
    ['a private key', 'What is this?\n-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n', 'QUESTION_HOLDS_CREDENTIAL'],
    ['a path inside the home folder', 'What does HOME/notes/plan.md say about pricing?', 'QUESTION_NAMES_HOME'],
    ['a path under ~', 'Why does ~/.config/bmn/agents/roster.md not load?', 'QUESTION_NAMES_HOME']
  ])('refuses a question that is %s before anything is made, and keeps none of its text', async (_label, text, code) => {
    const question = text.replace('HOME', home)
    answered()
    const result = await ask({ question })
    expect(result).toMatchObject({ ok: false, outcome: 'refused', code })
    expect(calls()).toEqual([])
    expect(existsSync(researchRunsDirectory())).toBe(false)
    expect(existsSync(researchLockPath())).toBe(false)
    // The record says that a question was refused and why; the text itself is not kept.
    expect(readQuestions()).toHaveLength(1)
    expect(readQuestions()[0]).toMatchObject({ outcome: 'refused', code, question: null })
    for (const output of [JSON.stringify(result), everythingKept()]) {
      expect(output).not.toContain(PLANTED)
      expect(output).not.toContain('synthetic')
      expect(output).not.toContain(`${home}/notes`)
    }
  })

  it('says which word looks like a key without quoting it, and lets ordinary long names through', () => {
    expect(questionProblem(`Is ${PLANTED} valid?`, { home })?.message).toBe('word 2 of the question looks like a key or a password; a web question is public text and its words reach the search sites')
    for (const fine of [QUESTION, 'What changed in claude-opus-5-5 and gpt-6.1-sol pricing on https://docs.example.org/models/pricing-2026?', 'What is CODEX_RESEARCH_DISABLED_FEATURES?', 'Where is /home documented in the FHS, and what about ~user notation?']) {
      expect(questionProblem(fine, { home })).toBeNull()
    }
    expect(questionProblem(`see ${home}`, { home })?.code).toBe('QUESTION_NAMES_HOME')
    expect(questionProblem('print $HOME/.ssh', { home })?.code).toBe('QUESTION_NAMES_HOME')
    expect(questionProblem(42, { home })?.code).toBe('QUESTION_EMPTY')
  })
})

describe('one research at a time, across the app and the command line (64.1 AC6)', () => {
  /** Another process that takes the research lock and holds it until it is killed. */
  const holder = async (kind: string): Promise<ReturnType<typeof spawn>> => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { takeResearchLock } from ${JSON.stringify(`${BIN}agents-research.mjs`)}
      const lock = takeResearchLock({ kind: ${JSON.stringify(kind)}, id: 'other-process', at: new Date().toISOString(), researcher: 'opus' })
      console.log(lock.held === undefined ? 'held' : 'refused')
      setInterval(() => {}, 1000)
    `], { env: { ...env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', (chunk: Buffer) => (String(chunk).trim() === 'held' ? resolve() : reject(new Error(String(chunk)))))
      child.once('error', reject)
    })
    return child
  }
  const ended = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL') })

  it('refuses a second question while another process asks, never queues it, and takes over a lock its holder left behind', async () => {
    answered()
    const other = await holder('question')
    try {
      expect(researchLockHolder()).toMatchObject({ kind: 'question', id: 'other-process', pid: other.pid })
      const refused = await ask()
      expect(refused).toMatchObject({ ok: false, outcome: 'refused', code: 'RESEARCH_RUNNING' })
      expect(refused.message).toContain(RESEARCH_RUNNING)
      expect(calls()).toEqual([])
      // Models research honours the same lock.
      const research = await runResearch({ researcher: 'fable', environment: env, now: () => NOW, fetchPage })
      expect(research.run).toMatchObject({ state: 'failed' })
      expect(research.run.note).toContain(RESEARCH_RUNNING)
      expect(calls()).toEqual([])
    } finally {
      await ended(other)
    }
    // The process is gone and its lock is still on the disk: it counts as none and is taken over.
    expect(existsSync(researchLockPath())).toBe(true)
    expect(researchLockHolder()).toBeNull()
    expect(await ask()).toMatchObject({ ok: true, outcome: 'answered' })
    expect(existsSync(researchLockPath())).toBe(false)
  })

  it('a question is refused while Models research runs, and the other way round, in one process too', async () => {
    const lock = takeResearchLock({ kind: 'research', id: 'models', at: NOW.toISOString(), researcher: 'opus' })
    expect(lock.held).toBeUndefined()
    const refused = await ask()
    expect(refused).toMatchObject({ outcome: 'refused', code: 'RESEARCH_RUNNING' })
    expect(refused.message).toContain('(Models research)')
    lock.release!()
    plan({ text: JSON.stringify(ANSWER), delay: 300 })
    const first = ask()
    try {
      // However busy the machine is: the first question is waited for, never given a fixed time.
      for (let waited = 0; researchLockHolder() === null && waited < 10_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(researchLockHolder()).toMatchObject({ kind: 'question', researcher: 'fable', by: { kind: 'shell' } })
      expect(await ask()).toMatchObject({ outcome: 'refused', code: 'RESEARCH_RUNNING' })
    } finally {
      // A question still going would write into the next test's folder.
      await first.catch(() => undefined)
    }
    expect(await first).toMatchObject({ outcome: 'answered' })
    expect(researchLockHolder()).toBeNull()
    expect(calls()).toHaveLength(1)
  })

  it('a lock that is not a holder\'s record, or names a process number given out again, is nobody\'s', async () => {
    mkdirSync(join(home, '.config/bmn/agents/state/research'), { recursive: true })
    writeFileSync(researchLockPath(), '{torn')
    expect(researchLockHolder()).toBeNull()
    answered()
    expect(await ask()).toMatchObject({ outcome: 'answered' })
    // This very process number, with another start time: a number that was given out again.
    writeFileSync(researchLockPath(), JSON.stringify({ version: 1, kind: 'question', id: 'old', pid: process.pid, start: '1' }))
    expect(researchLockHolder()).toBeNull()
    expect(await ask()).toMatchObject({ outcome: 'answered' })
  })
})

describe('the limits (64.1 AC7)', () => {
  it('ends a question at its time limit and at Stop, and keeps the record', async () => {
    plan({ text: JSON.stringify(ANSWER), delay: 5000 })
    const late = await ask({ limitMs: 200 })
    expect(late).toMatchObject({ ok: false, outcome: 'limit' })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const stopped = await ask({ signal: controller.signal })
    expect(stopped).toMatchObject({ ok: false, outcome: 'stopped' })
    expect(readQuestions().map((entry) => entry.outcome)).toEqual(['limit', 'stopped'])
    expect(researchLockHolder()).toBeNull()
  })

  it('refuses the 21st question of a local day and takes one again the next day', async () => {
    answered()
    const day = new Date(2026, 9, 12, 23, 30)
    const kept: QuestionRecord[] = Array.from({ length: ASK_PER_DAY }, (_unused, index) => ({
      id: `seed-${index}`, at: new Date(2026, 9, 12, 8, index).toISOString(), by: { kind: 'shell' }, researcher: 'fable', researcher_name: 'Fable', question: 'seed', outcome: 'answered'
    }))
    // A question refused before it started does not count against the day.
    kept.push({ id: 'refused', at: new Date(2026, 9, 12, 9, 0).toISOString(), by: { kind: 'shell' }, researcher: null, researcher_name: null, question: null, outcome: 'refused', code: 'QUESTION_EMPTY' })
    mkdirSync(join(home, '.config/bmn/agents/state/research'), { recursive: true })
    writeFileSync(questionsPath(), JSON.stringify({ version: 1, questions: kept }))
    expect(askedToday(readQuestions(), day)).toBe(ASK_PER_DAY)
    const refused = await ask({ now: () => day })
    expect(refused).toMatchObject({ ok: false, outcome: 'refused', code: 'DAY_LIMIT' })
    expect(refused.message).toContain(`${ASK_PER_DAY} web questions were asked today`)
    expect(calls()).toEqual([])
    // Half an hour later it is the next local day.
    expect(await ask({ now: () => new Date(2026, 9, 13, 0, 1) })).toMatchObject({ ok: true, outcome: 'answered' })
  })

  it('uses the researcher\'s lowest effort, as every research does', async () => {
    answered()
    await ask()
    const [call] = calls()
    expect(call!.argv[call!.argv.indexOf('--effort') + 1]).toBe('low')
  })
})

describe('what is kept (64.1 AC8)', () => {
  it('keeps one record of every question: who asked, when, the researcher, the exact text, the outcome, the marks and the time', async () => {
    answered()
    const result = await ask({ by: { kind: 'session', session: 'session-1', app: 'claude' } })
    const [record] = readQuestions()
    expect(readQuestions()).toHaveLength(1)
    expect(record).toMatchObject({
      id: result.id, at: NOW.toISOString(), by: { kind: 'session', session: 'session-1', app: 'claude' }, researcher: 'fable', researcher_name: 'Fable',
      question: QUESTION, outcome: 'answered', answer: ANSWER.answer, not_found: ANSWER.not_found, counts: { found: 1, not_found: 1, unreadable: 1 }
    })
    expect(record!.claims!.map((claim) => claim.mark)).toEqual([MARKS.found, MARKS.missing, MARKS.unreadable])
    expect(record!.took_ms).toBeGreaterThanOrEqual(0)
    // No page text beyond the quoted passages, no key, and a file only its owner reads.
    const text = readFileSync(questionsPath(), 'utf8')
    expect(text).not.toContain('Jev reached the gateway')
    expect(text).not.toContain('<html>')
    expect((await import('node:fs')).statSync(questionsPath()).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(home, '.config/bmn/agents/state/research')).filter((name) => name.includes('.tmp') || name.includes('.writing') || name.includes('.new'))).toEqual([])
  })

  it('keeps the last 200 and reads a question that never got its record as interrupted', async () => {
    const kept: QuestionRecord[] = Array.from({ length: ASK_KEPT + 5 }, (_unused, index) => ({
      id: `old-${index}`, at: new Date(2026, 8, 1, 0, index).toISOString(), by: { kind: 'shell' }, researcher: 'fable', researcher_name: 'Fable', question: 'old', outcome: 'answered'
    }))
    // BMN ended between the run and the write: the record still says running, and nobody holds the lock.
    kept.push({ id: 'crashed', at: new Date(2026, 8, 2).toISOString(), by: { kind: 'shell' }, researcher: 'fable', researcher_name: 'Fable', question: 'lost', outcome: 'running' })
    mkdirSync(join(home, '.config/bmn/agents/state/research'), { recursive: true })
    writeFileSync(questionsPath(), JSON.stringify({ version: 1, questions: kept }))
    expect(readQuestions().at(-1)).toMatchObject({ id: 'crashed', outcome: 'interrupted', question: 'lost' })
    answered()
    const result = await ask()
    const now = readQuestions()
    expect(now).toHaveLength(ASK_KEPT)
    expect(now.at(-1)!.id).toBe(result.id)
    expect(now.at(-2)).toMatchObject({ id: 'crashed', outcome: 'interrupted' })
    expect(now[0]!.id).toBe('old-7')
    // A damaged file reads as nothing kept, and the next question starts it again.
    writeFileSync(questionsPath(), '{not json')
    expect(readQuestions()).toEqual([])
    await ask()
    expect(readQuestions()).toHaveLength(1)
  })

  it('removes one record or all of them, and the kept text with it', async () => {
    answered()
    const first = await ask()
    const second = await ask({ question: 'What is a context window, in one sentence from a public page?' })
    removeQuestions(first.id)
    expect(readQuestions().map((entry) => entry.id)).toEqual([second.id])
    expect(readFileSync(questionsPath(), 'utf8')).not.toContain(QUESTION)
    removeQuestions()
    expect(readQuestions()).toEqual([])
    expect(readFileSync(questionsPath(), 'utf8')).not.toContain('context window')
  })

  it('gives no question back when a record is removed: the day\'s limit counts what was asked, not what is still listed', async () => {
    answered()
    const day = new Date(2026, 9, 12, 12, 0)
    const kept: QuestionRecord[] = Array.from({ length: ASK_PER_DAY - 1 }, (_unused, index) => ({
      id: `seed-${index}`, at: new Date(2026, 9, 12, 8, index).toISOString(), by: { kind: 'shell' }, researcher: 'fable', researcher_name: 'Fable', question: 'seed', outcome: 'answered'
    }))
    // One from yesterday and one refused before it started: neither counts for today, removed or not.
    kept.push({ id: 'yesterday', at: new Date(2026, 9, 11, 8, 0).toISOString(), by: { kind: 'shell' }, researcher: 'fable', researcher_name: 'Fable', question: 'old', outcome: 'answered' })
    kept.push({ id: 'refused', at: new Date(2026, 9, 12, 9, 0).toISOString(), by: { kind: 'shell' }, researcher: null, researcher_name: null, question: null, outcome: 'refused', code: 'QUESTION_EMPTY' })
    mkdirSync(join(home, '.config/bmn/agents/state/research'), { recursive: true })
    writeFileSync(questionsPath(), JSON.stringify({ version: 1, questions: kept }))
    setAgentsMayAsk(false)
    expect(askedCount(day)).toBe(ASK_PER_DAY - 1)
    removeQuestions('seed-0', day)
    removeQuestions('yesterday', day)
    expect(askedCount(day)).toBe(ASK_PER_DAY - 1)
    removeQuestions(null, day)
    expect(readQuestions()).toEqual([])
    expect(askedCount(day)).toBe(ASK_PER_DAY - 1)
    // The switch kept its place in the same file.
    expect(agentsMayAsk()).toBe(false)
    setAgentsMayAsk(true)
    expect(askedCount(day)).toBe(ASK_PER_DAY - 1)
    expect(await ask({ now: () => day })).toMatchObject({ ok: true })
    expect(await ask({ now: () => day })).toMatchObject({ ok: false, code: 'DAY_LIMIT' })
    // The next day starts at none.
    expect(askedCount(new Date(2026, 9, 13, 0, 5))).toBe(0)
  })

  it('says who asked: a BMN session with its app, the session\'s shell, or a shell outside BMN', () => {
    expect(askerOf({}, { programs: () => ['bash'] })).toEqual({ kind: 'shell' })
    expect(askerOf({ BMN_SESSION_ID: 'b2f1-session' }, { programs: () => ['bash', 'codex', 'bash'] })).toEqual({ kind: 'session', session: 'b2f1-session', app: 'codex' })
    expect(askerOf({ BMN_SESSION_ID: 'b2f1-session' }, { programs: () => ['bash', 'node'] })).toEqual({ kind: 'session', session: 'b2f1-session' })
    expect(askerOf({ BMN_SESSION_ID: 'b2f1-session', CLAUDECODE: '1' }, { programs: () => ['zsh'] })).toEqual({ kind: 'session', session: 'b2f1-session', app: 'claude' })
    expect(askerOf({ BMN_SESSION_ID: 'not a session id' }, { programs: () => [] })).toEqual({ kind: 'shell' })
    expect(askerWords({ kind: 'shell' })).toBe('from a shell')
    expect(askerWords({ kind: 'owner' })).toBe('you, on Models')
    expect(askerWords({ kind: 'session', session: 's1', app: 'codex' }, 'Epic 64')).toBe('Codex in Epic 64')
    expect(askerWords({ kind: 'session', session: 's1' })).toBe('the shell of session s1')
  })
})

describe('the switch "Agents may ask the web" (64.2 AC5, 64.3 AC4)', () => {
  it('is on until the owner switches it off; off refuses everyone but the owner\'s own Ask', async () => {
    expect(agentsMayAsk()).toBe(true)
    setAgentsMayAsk(false)
    expect(agentsMayAsk()).toBe(false)
    answered()
    const refused = await ask({ by: { kind: 'session', session: 's1', app: 'claude' } })
    expect(refused).toMatchObject({ ok: false, outcome: 'refused', code: 'ASKING_OFF' })
    expect(refused.message).toContain('ask the owner')
    expect(calls()).toEqual([])
    expect(await ask({ by: { kind: 'owner' }, owner: true })).toMatchObject({ ok: true, outcome: 'answered' })
    setAgentsMayAsk(true)
    expect(await ask()).toMatchObject({ ok: true })
  })
})

describe('a Codex researcher (64.1 AC7, AC9)', () => {
  it('runs the comparison under the provider\'s own model list first, and removes the run\'s Codex folder after', async () => {
    answered()
    let compared = 0
    const result = await ask({ agent: 'luna', fenceTests: FENCED, compare: async () => { compared += 1; expect(calls()).toEqual([]); return { ok: true, compared: true } } })
    expect(result).toMatchObject({ ok: true, outcome: 'answered', researcher: 'luna' })
    expect(compared).toBe(1)
    const [call] = calls()
    expect(call!.app).toBe('codex')
    expect(call!.prompt).toBe(askPrompt(QUESTION))
    expect(call!.env.CODEX_HOME).toBe(join(call!.cwd, '..', 'codex'))
    for (const name of readdirSync(researchRunsDirectory())) expect(existsSync(join(researchRunsDirectory(), name, 'codex'))).toBe(false)
  })

  it('starts no run where the comparison finds another tool list, or the fence test is not on record', async () => {
    answered()
    const different = await ask({ agent: 'luna', fenceTests: FENCED, compare: async () => ({ ok: false, reason: 'Codex offers another tool list under the provider\'s own model list' }) })
    expect(different).toMatchObject({ ok: false, outcome: 'refused', code: 'ROUTE_UNSUPPORTED', message: 'Codex offers another tool list under the provider\'s own model list' })
    const untested = await ask({ agent: 'luna', fenceTests: [], compare: SAME })
    expect(untested).toMatchObject({ ok: false, outcome: 'refused', code: 'ROUTE_UNSUPPORTED' })
    expect(untested.message).toContain('fence test')
    expect(calls()).toEqual([])
    for (const name of readdirSync(researchRunsDirectory())) expect(existsSync(join(researchRunsDirectory(), name, 'codex'))).toBe(false)
  })
})

describe('the command (64.1 AC1, AC10)', () => {
  const bmn = (args: string[], input: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(BIN, 'bmn'), 'research', ...args], { input, encoding: 'utf8', env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...extra } })

  it('asks from standard input or a file, with BMN closed, and prints the answer with its marks', () => {
    // The stand-in pages are not reachable from another process: every claim's page reads as not readable there.
    plan({ text: JSON.stringify({ ...ANSWER, claims: [] }) })
    const piped = bmn(['ask', '--json'], `${QUESTION}\n`)
    expect(piped.status).toBe(0)
    const result = JSON.parse(piped.stdout) as { ok: boolean; outcome: string; id: string; answer: string }
    expect(result).toMatchObject({ ok: true, outcome: 'answered', researcher: 'fable', answer: ANSWER.answer, counts: { found: 0, not_found: 0, unreadable: 0 } })
    expect(calls()[0]!.prompt).toBe(askPrompt(QUESTION))
    writeFileSync(join(home, 'question.txt'), QUESTION)
    const filed = bmn(['ask', '--question-file', join(home, 'question.txt')], '')
    expect(filed.status).toBe(0)
    expect(filed.stdout).toContain(ANSWER.answer)
    expect(filed.stdout).toContain('No claim with a page came back.')
    expect(filed.stdout).toContain('Asked of Fable')
    expect(readQuestions().map((entry) => entry.by)).toEqual([{ kind: 'shell' }, { kind: 'shell' }])
  })

  it('names the session it was asked from, and keeps BMN\'s own names and stand-in commands away from the app', () => {
    plan({ text: JSON.stringify({ ...ANSWER, claims: [] }) })
    const asked = bmn(['ask', '--json'], QUESTION, { BMN_SESSION_ID: 'session-7', BMN_TOKEN: PLANTED, PATH: `${BIN.replace(/\/$/, '')}:${stubs}:/usr/bin:/bin` })
    expect(asked.status).toBe(0)
    expect(readQuestions()[0]!.by).toMatchObject({ kind: 'session', session: 'session-7' })
    expect(JSON.stringify(calls()[0]!.env)).not.toContain(PLANTED)
    expect(calls()[0]!.env.PATH).toBe(`${stubs}:/usr/bin:/bin`)
    expect(askEnvironment({ PATH: `/a:${BIN.replace(/\/$/, '')}:/b`, BMN_TOKEN: 'x', AITERM_TOKEN: 'y', HOME: home }, BIN.replace(/\/$/, ''))).toEqual({ PATH: '/a:/b', HOME: home })
  })

  it('exits 10 on a refusal with the reason, and never prints a planted key', () => {
    answered()
    const refused = bmn(['ask'], `Is ${PLANTED} valid?`)
    expect(refused.status).toBe(10)
    expect(refused.stderr).toContain('bmn: QUESTION_HOLDS_CREDENTIAL: word 2 of the question looks like a key or a password')
    const asJson = bmn(['ask', '--json'], `Is ${PLANTED} valid?`)
    expect(asJson.status).toBe(10)
    expect(JSON.parse(asJson.stdout)).toMatchObject({ ok: false, outcome: 'refused', code: 'QUESTION_HOLDS_CREDENTIAL' })
    for (const output of [refused.stdout, refused.stderr, asJson.stdout, asJson.stderr, everythingKept()]) expect(output).not.toContain(PLANTED)
    expect(calls()).toEqual([])
    const check = bmn(['ask', '--agent', 'astra'], QUESTION)
    expect(check.status).toBe(10)
    expect(check.stderr).toMatch(/^bmn: [A-Z_]+: /)
    expect(calls()).toEqual([])
  })

  it('takes the question from nowhere else, and says how it is used', () => {
    expect(bmn(['ask', QUESTION], '').status).toBe(2)
    expect(bmn(['ask', '--agent', 'Not An Id'], QUESTION).status).toBe(2)
    expect(bmn(['ask', '--question-file', join(home, 'missing.txt')], '').status).toBe(2)
    expect(bmn(['tell'], '').status).toBe(2)
    const help = bmn(['--help'], '')
    expect(help.status).toBe(0)
    expect(help.stdout.trim()).toBe(RESEARCH_USAGE)
    expect(RESEARCH_USAGE).toContain(`${ASK_PER_DAY} a day`)
    for (const mark of Object.values(MARKS)) expect(RESEARCH_USAGE).toContain(mark)
  })

  it('ends the run on Ctrl-C and keeps the record as stopped', async () => {
    plan({ text: JSON.stringify(ANSWER), delay: 20_000 })
    const child = spawn(process.execPath, [join(BIN, 'bmn'), 'research', 'ask', '--json'], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(QUESTION)
    let printed = ''
    child.stdout.on('data', (chunk: Buffer) => { printed += String(chunk) })
    for (let waited = 0; calls().length === 0 && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls()).toHaveLength(1)
    expect(readQuestions()[0]).toMatchObject({ outcome: 'running', question: QUESTION })
    child.kill('SIGINT')
    const status = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    expect(status).toBe(1)
    expect(JSON.parse(printed)).toMatchObject({ ok: false, outcome: 'stopped' })
    expect(readQuestions()[0]).toMatchObject({ outcome: 'stopped', question: QUESTION })
    expect(researchLockHolder()).toBeNull()
  })
})

describe('what the pre-review found (Epic 64)', () => {
  it('refuses a path inside the account\'s own home folder also when HOME is unset or names another folder', () => {
    // The account's home comes from the system, not from the environment a caller hands over.
    const own = userInfo().homedir
    for (const given of ['', '/tmp/somewhere-else']) {
      expect(questionProblem(`What does ${own}/notes/plan.md say about pricing?`, { home: given })).toMatchObject({ code: 'QUESTION_NAMES_HOME' })
      expect(questionProblem(`Why is ${own} not readable?`, { home: given })).toMatchObject({ code: 'QUESTION_NAMES_HOME' })
    }
    expect(questionProblem('Why do people keep notes under /home on Linux?', { home: '' })).toBeNull()
  })

  it('takes no claim whose page address carries a sign-in part, and keeps none of it', async () => {
    const withSignIn = { ...ANSWER, claims: [{ ...ANSWER.claims[0]!, source: `https://reader:${PLANTED}@docs.example.org/jev` }] }
    expect(parseAskAnswer(JSON.stringify(withSignIn))).toMatchObject({ ok: false })
    plan({ text: JSON.stringify(withSignIn) })
    const result = await ask()
    expect(result).toMatchObject({ ok: false, outcome: 'no-answer' })
    for (const output of [JSON.stringify(result), everythingKept()]) expect(output).not.toContain(PLANTED)
  })

  it('waits for another writer\'s mark on the kept questions and takes it over once it is left behind, never writing beside it', () => {
    mkdirSync(join(home, '.config/bmn/agents/state/research'), { recursive: true })
    const mark = `${questionsPath()}.writing`
    mkdirSync(mark)
    const began = Date.now()
    removeQuestions(null, NOW)
    // The mark was another writer's until it counted as left behind; only then was the file written, and the mark taken was given back.
    expect(Date.now() - began).toBeGreaterThanOrEqual(1500)
    expect(existsSync(mark)).toBe(false)
    expect(JSON.parse(readFileSync(questionsPath(), 'utf8'))).toEqual({ version: 1, questions: [] })
    expect(statSync(questionsPath()).mode & 0o777).toBe(0o600)
  })
})
