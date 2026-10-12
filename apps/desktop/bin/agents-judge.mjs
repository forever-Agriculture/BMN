// MODULE: agents-judge.mjs - Epic 65: one checked call to the team's judge (Jev). A text and typed questions go to the approved host, numbers come back, and BMN reads them under the one rule the proof tested; every call is counted, and the key it uses appears nowhere
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { JUDGE_ROLE, RosterError, agentState, calledParties, isCalled, judges } from './agents-roster.mjs'
import { readApproved, stateDirectory } from './agents-state.mjs'
import { workspaceRoot, workspaceVisibility } from './agents-check.mjs'
import { isPublicAddress, publicHostName, resolveHost, takeLock } from './agents-research.mjs'
import { writePrivate } from './agents-rules.mjs'

/**
 * Jev writes no text. One call carries a text (`state`) and a map of typed questions about it, and
 * numbers come back: how true a statement is (`noul`), one label with a confidence (`choice`), a
 * number on a rubric (`score`). The proof in ~/code/jev-eval fixed one rule before its first run and
 * measured only that rule, so it is the only reading BMN gives (R65-FR2): an answer at or above the
 * line says something, and everything else, a failed call included, is "no answer". An answer is
 * advice: nothing in BMN grants, accepts, stops, spends or hides anything because of one (R65-NFR4).
 */

/** The line of the proof: a number at or above it is read, one below it is not. */
export const LINE = 0.9
/** An answer this close to the line, on either side, is marked: the proof saw such answers change between repeats. */
export const NEAR = 0.02
export const NO_ANSWER = 'no answer'
/**
 * The path the proof called on the approved host (450 calls on 2026-10-12); the host itself is the
 * agent's, from the approved team. OpenCode's docs also name `/inference/v1/systemone`; its public
 * source routes both. No call from BMN's own tests reaches either: the first real one is the owner's.
 */
export const SYSTEM_ONE_PATH = '/zen/v1/systemone'
export const DEADLINE_MS = 5000
export const DEADLINE_MAX_MS = 30_000
/** The vendor's limits (TypeSafe AI's models page, 2026-10-12): 255 choices, 2 to 10 score levels, 64k tokens a request of which 32k for the text and the longest question. */
export const MAX_CHOICES = 255
export const MIN_LEVELS = 2
export const MAX_LEVELS = 10
/**
 * BMN's own size limits, in bytes. A token is at least one byte, so a request of this many bytes
 * is well inside the vendor's 64k tokens whatever the language of the text.
 */
export const STATE_MAX_BYTES = 24_000
export const REQUEST_MAX_BYTES = 48_000
export const MAX_QUESTIONS = 64
const ANSWER_MAX_BYTES = 256 * 1024
/** How many calls the record lists; the month totals beside them count every call. */
export const CALLS_KEPT = 200
const MONTHS_KEPT = 13
const PURPOSES_KEPT = 40
export const NO_PURPOSE = 'unnamed'
const PURPOSE = /^[a-z0-9][a-z0-9-]{0,31}$/
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export const EXIT = { ok: 0, usage: 2, refusal: 10, timeout: 11, failed: 12, shape: 13 }

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const bytes = (text) => Buffer.byteLength(text, 'utf8')
const words = (value, most) => typeof value === 'string' && value.trim() !== '' && bytes(value) <= most
const unit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

// ---------------------------------------------------------------------------------------------
// The questions: Jev's own map, checked before any request (65.2 AC1)

/**
 * Why a value is not a map of typed questions Jev takes, or null. The message names the question
 * and the fault. A `noul` is a statement; a `choice` adds `criteria`, a map of 2 to 255 labels each
 * with its meaning; a `score` adds `criteria`, a list of 2 to 10 levels from the lowest up.
 */
export function questionsProblem(questions) {
  const fault = (question, message) => ({ code: 'QUESTIONS_INVALID', ...(question === null ? {} : { question }), message: question === null ? message : `question ${question}: ${message}` })
  if (!isObject(questions)) return fault(null, 'the questions file must hold one JSON object: a map of question id to question')
  const ids = Object.keys(questions)
  if (ids.length === 0) return fault(null, 'the questions file holds no question')
  if (ids.length > MAX_QUESTIONS) return fault(null, `the questions file holds ${ids.length} questions; one call takes at most ${MAX_QUESTIONS}`)
  for (const id of ids) {
    const question = questions[id]
    if (!QUESTION_ID.test(id)) return fault(id.slice(0, 40), 'its id must be 1 to 64 letters, digits, dots, dashes or underscores')
    if (!isObject(question)) return fault(id, 'it must be an object with a type and instructions')
    if (!['noul', 'choice', 'score'].includes(question.type)) return fault(id, `its type must be noul, choice or score${typeof question.type === 'string' ? `, not ${question.type.slice(0, 40)}` : ''}`)
    if (!words(question.instructions, 4000)) return fault(id, 'its instructions must be a text of 1 to 4,000 bytes')
    const allowed = question.type === 'noul' ? ['type', 'instructions'] : ['type', 'instructions', 'criteria']
    const extra = Object.keys(question).find((key) => !allowed.includes(key))
    if (extra !== undefined) return fault(id, `a ${question.type} question has no field ${extra.slice(0, 40)}`)
    if (question.type === 'choice') {
      if (!isObject(question.criteria)) return fault(id, 'a choice needs criteria: a map of each label to what it means')
      const labels = Object.keys(question.criteria)
      if (labels.length < 2 || labels.length > MAX_CHOICES) return fault(id, `a choice takes 2 to ${MAX_CHOICES} labels, and this one has ${labels.length}`)
      const bad = labels.find((label) => !words(label, 200) || !words(question.criteria[label], 2000))
      if (bad !== undefined) return fault(id, `label ${JSON.stringify(bad.slice(0, 40))} needs a name of 1 to 200 bytes and a meaning of 1 to 2,000 bytes`)
    }
    if (question.type === 'score') {
      if (!Array.isArray(question.criteria)) return fault(id, 'a score needs criteria: a list of its levels, from the lowest up')
      if (question.criteria.length < MIN_LEVELS || question.criteria.length > MAX_LEVELS) return fault(id, `a score takes ${MIN_LEVELS} to ${MAX_LEVELS} levels, and this one has ${question.criteria.length}`)
      if (!question.criteria.every((level) => words(level, 2000))) return fault(id, 'each level of a score must be a text of 1 to 2,000 bytes')
    }
  }
  return null
}

/** Why a text and its questions are too large for one call, or null. */
export function sizeProblem(state, questions) {
  if (typeof state !== 'string' || state.trim() === '') return { code: 'STATE_EMPTY', message: 'the text is empty' }
  const longest = Math.max(...Object.values(questions).map((question) => bytes(JSON.stringify(question))))
  if (bytes(state) + longest > STATE_MAX_BYTES) {
    return { code: 'TOO_LARGE', message: `the text with its longest question is ${bytes(state) + longest} bytes; one call takes at most ${STATE_MAX_BYTES}, which keeps it well inside the model's limit in any language` }
  }
  const whole = bytes(JSON.stringify({ state, questions }))
  if (whole > REQUEST_MAX_BYTES) return { code: 'TOO_LARGE', message: `the text and all its questions are ${whole} bytes; one call takes at most ${REQUEST_MAX_BYTES}` }
  return null
}

// ---------------------------------------------------------------------------------------------
// The reading: the proof's rule, and nothing it did not measure (65.2 AC4)

const near = (...numbers) => numbers.some((number) => Math.abs(number - LINE) <= NEAR + 1e-9)
const atLine = (number) => number >= LINE - 1e-12

/**
 * BMN's reading of one answer to one question, or null where the answer is not Jev's shape for
 * that question. A `noul` at the line or above reads "yes"; a low one is not read as "no", since
 * the proof did not measure that. A `choice` reads its label where its confidence and the winning
 * probability are both at the line. A `score` reads its number, marked sure, where its confidence
 * is at the line. Everything else reads "no answer".
 */
export function readingOf(question, answer) {
  if (!isObject(answer) || answer.type !== question.type) return null
  if (question.type === 'noul') {
    if (!unit(answer.noul)) return null
    return { reading: atLine(answer.noul) ? 'yes' : NO_ANSWER, ...(near(answer.noul) ? { near: true } : {}) }
  }
  if (!unit(answer.confidence) || !isObject(answer.probabilities) || !Object.values(answer.probabilities).every(unit)) return null
  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria)
    if (typeof answer.choice !== 'string' || !labels.includes(answer.choice) || !Object.keys(answer.probabilities).every((label) => labels.includes(label))) return null
    const winning = answer.probabilities[answer.choice]
    if (!unit(winning)) return null
    return { reading: atLine(answer.confidence) && atLine(winning) ? answer.choice : NO_ANSWER, ...(near(answer.confidence, winning) ? { near: true } : {}) }
  }
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length) return null
  return atLine(answer.confidence) ? { reading: answer.score, sure: true, ...(near(answer.confidence) ? { near: true } : {}) } : { reading: NO_ANSWER, ...(near(answer.confidence) ? { near: true } : {}) }
}

/**
 * Jev's numbers for a call, each kept as it came and nothing else of the body: only the fields of
 * the question's own type, numbers and the caller's own labels. `{ ok, answers, readings, tokens }`,
 * or `{ ok: false }` where the body is not Jev's shape for these questions.
 */
export function readBody(questions, body) {
  if (!isObject(body) || !isObject(body.answers)) return { ok: false }
  const answers = {}
  const readings = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id]
    const reading = readingOf(question, answer)
    if (reading === null) return { ok: false }
    answers[id] = question.type === 'noul' ? { type: 'noul', noul: answer.noul }
      : question.type === 'choice' ? { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: { ...answer.probabilities } }
        : { type: 'score', score: answer.score, confidence: answer.confidence, probabilities: { ...answer.probabilities } }
    readings[id] = reading
  }
  const tokens = isObject(body.usage) && Number.isSafeInteger(body.usage.input_tokens) && body.usage.input_tokens >= 0 ? body.usage.input_tokens : null
  return { ok: true, answers, readings, tokens }
}

const noAnswers = (questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, { reading: NO_ANSWER }]))

/** With `--twice`: a reading is kept only where both calls gave the same one. */
export function agreed(first, second) {
  const out = {}
  for (const id of Object.keys(first)) {
    const [one, other] = [first[id], second[id]]
    const same = one.reading !== NO_ANSWER && one.reading === other?.reading
    out[id] = { reading: same ? one.reading : NO_ANSWER, ...(same && one.sure === true && other.sure === true ? { sure: true } : {}), ...(one.near === true || other?.near === true ? { near: true } : {}), ...(same ? {} : one.reading !== other?.reading ? { differed: true } : {}) }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The key: read for one request, held in memory, written nowhere (R65-NFR3)

/** OpenCode's own sign-in file, where its key lies. BMN reads it and never writes it. */
export function openCodeSignInFile(environment = process.env) {
  const data = typeof environment.XDG_DATA_HOME === 'string' && environment.XDG_DATA_HOME.startsWith('/') ? environment.XDG_DATA_HOME : `${environment.HOME ?? homedir()}/.local/share`
  return `${data}/opencode/auth.json`
}

/** The entries of the sign-in file that hold a key the gateway takes, in the order BMN tries them; the proof used the first. */
const KEY_ENTRIES = ['opencode-go', 'opencode']

/** The key for one request, or null where OpenCode is not signed in. Nothing of the file is kept or said. */
function readKey(environment) {
  let entries
  try {
    entries = JSON.parse(readFileSync(openCodeSignInFile(environment), 'utf8'))
  } catch {
    return null
  }
  if (!isObject(entries)) return null
  for (const name of KEY_ENTRIES) {
    const key = entries[name]?.key
    if (typeof key === 'string' && /^[\x21-\x7e]{8,512}$/.test(key)) return key
  }
  return null
}

/** `text` with the key taken out, in case a server sent it back: the last guard, behind giving out nothing a server said. */
function withoutKey(text, key) {
  return key === null || key === '' ? text : text.split(key).join('[key]')
}

// ---------------------------------------------------------------------------------------------
// The request: one POST to the approved host and path (65.2 AC3)

/** One POST to an address BMN already checked. No redirect is followed: a 3xx is an answer like any other status. */
function postOnce({ host, address, family, port, plain }, { path, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false
    const settle = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const call = (plain ? httpRequest : httpsRequest)({
      protocol: plain ? 'http:' : 'https:', hostname: host, port, path, method: 'POST', agent: false, ...(plain ? {} : { servername: host }),
      headers: { ...headers, 'content-length': Buffer.byteLength(body), 'accept-encoding': 'identity' },
      lookup: (_host, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family))
    }, (response) => {
      const status = response.statusCode ?? 0
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > ANSWER_MAX_BYTES) {
          call.destroy()
          return settle({ status, tooLarge: true })
        }
        chunks.push(chunk)
      })
      response.on('end', () => settle({ status, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', () => settle({ network: true }))
    })
    const timer = setTimeout(() => {
      call.destroy()
      settle({ timeout: true })
    }, timeoutMs)
    call.on('error', () => settle({ network: true }))
    call.end(body)
  })
}

/**
 * Where a request for `host` goes. The approved host is looked up once and must lead to public
 * addresses only. A name under `.test` can never be a real site: it is the stand-in server of
 * BMN's own tests, reached on this computer at the port the test names, and at no other time.
 * The command line reads that port from its environment like the tests do. That opens nothing: a
 * request goes there only when the team the owner approved names a host under `.test`, and a process
 * that can set the variable runs as him and could read OpenCode's sign-in file itself.
 */
async function destination(host, environment, timeoutMs) {
  if (host.endsWith('.test')) {
    const port = Number(environment.BMN_JUDGE_TEST_PORT)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return { failed: 'the approved host is a test name and no test is running' }
    return { host, address: '127.0.0.1', family: 4, port, plain: true }
  }
  if (!publicHostName(host)) return { failed: 'the approved host is not a public name' }
  let timer
  try {
    const addresses = await Promise.race([resolveHost(host), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), timeoutMs) })])
    if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) return { failed: 'the approved host does not lead to a public address' }
    return { host, address: addresses[0].address, family: addresses[0].family, port: 443, plain: false }
  } catch (error) {
    return error?.code === 'TIMEOUT' ? { timeout: true } : { network: true }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Asks once, inside `deadline`: no redirect followed, no retry after a 4xx, one retry after a
 * network error or a 5xx while time is left. Resolves `{ ok, answers, readings, tokens }` or
 * `{ ok: false, outcome: 'timeout' | 'failed' | 'shape', note }`. `note` is BMN's own words and a
 * status number: nothing a server said is passed on.
 */
async function askOnce({ host, model, state, questions, key, environment, deadline }) {
  const body = JSON.stringify({ model, state, questions })
  let last = { ok: false, outcome: 'failed', note: 'the request was not made' }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let left = deadline - Date.now()
    if (left <= 0) return attempt === 0 ? { ok: false, outcome: 'timeout', note: 'no answer came inside the time for the call' } : last
    const to = await destination(host, environment, left)
    if (to.failed !== undefined) return { ok: false, outcome: 'failed', note: to.failed }
    left = deadline - Date.now()
    const answer = to.timeout === true || left <= 0 ? { timeout: true } : to.network === true ? { network: true }
      : await postOnce(to, { path: SYSTEM_ONE_PATH, body, timeoutMs: left, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'BMN judge', 'x-opencode-session': randomUUID() } })
    if (answer.timeout === true) return { ok: false, outcome: 'timeout', note: 'no answer came inside the time for the call' }
    if (answer.network === true) {
      last = { ok: false, outcome: 'failed', note: 'the approved host could not be reached' }
      continue
    }
    if (answer.tooLarge === true) return { ok: false, outcome: 'shape', note: 'the answer was larger than any answer of Jev\'s' }
    if (answer.status >= 500) {
      last = { ok: false, outcome: 'failed', note: `the approved host answered ${answer.status}` }
      continue
    }
    if (answer.status >= 300 && answer.status < 400) return { ok: false, outcome: 'failed', note: `the approved host answered ${answer.status}, a redirect, and BMN follows none` }
    if (answer.status !== 200) return { ok: false, outcome: 'failed', note: `the approved host answered ${answer.status}` }
    let parsed
    try {
      parsed = JSON.parse(answer.body)
    } catch {
      return { ok: false, outcome: 'shape', note: 'the answer was not Jev\'s shape' }
    }
    const read = readBody(questions, parsed)
    return read.ok ? read : { ok: false, outcome: 'shape', note: 'the answer was not Jev\'s shape for these questions' }
  }
  return last
}

// ---------------------------------------------------------------------------------------------
// The record: every call counted, no text kept (65.2 AC7)

export function judgeDirectory() {
  return `${stateDirectory()}/judge`
}

export function judgeRecordPath() {
  return `${judgeDirectory()}/calls.json`
}

function judgeSettingsPath() {
  return `${judgeDirectory()}/settings.json`
}

const monthOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
const emptyTotals = () => ({ calls: 0, requests: 0, input_tokens: 0, cost_usd: 0 })
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
const dollars = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
const totalsOf = (value) => (isObject(value) ? { calls: count(value.calls), requests: count(value.requests), input_tokens: count(value.input_tokens), cost_usd: dollars(value.cost_usd) } : emptyTotals())

/**
 * The record: the last calls, and beside them the totals of each month, in all and per purpose
 * word. The totals count every call that made a request, also those the list no longer shows.
 * A missing or damaged file reads as empty.
 */
export function readJudgeRecord() {
  try {
    const value = JSON.parse(readFileSync(judgeRecordPath(), 'utf8'))
    if (isObject(value) && value.version === 1 && Array.isArray(value.calls) && isObject(value.months)) {
      const months = {}
      for (const [month, entry] of Object.entries(value.months)) {
        if (!/^\d{4}-\d{2}$/.test(month) || !isObject(entry)) continue
        months[month] = { ...totalsOf(entry), refused: count(entry.refused), purposes: Object.fromEntries(Object.entries(isObject(entry.purposes) ? entry.purposes : {}).filter(([word]) => PURPOSE.test(word)).map(([word, totals]) => [word, totalsOf(totals)])) }
      }
      return { calls: value.calls.filter((entry) => isObject(entry) && typeof entry.at === 'string' && typeof entry.outcome === 'string'), months }
    }
  } catch {
    // Nothing recorded yet.
  }
  return { calls: [], months: {} }
}

/** The totals of `now`'s month and the one before it: `{ month, calls, requests, input_tokens, cost_usd, refused, purposes }` each. */
export function judgeTotals(now = new Date(), record = readJudgeRecord()) {
  const of = (date) => {
    const month = monthOf(date)
    return { month, ...emptyTotals(), refused: 0, purposes: {}, ...(record.months[month] ?? {}) }
  }
  return { current: of(now), previous: of(new Date(now.getFullYear(), now.getMonth() - 1, 1)) }
}

/** The owner's monthly limit: off until he switches it on (65 (c) as he replaced it). */
export function judgeLimit() {
  try {
    const value = JSON.parse(readFileSync(judgeSettingsPath(), 'utf8'))
    if (isObject(value) && isObject(value.limit) && typeof value.limit.usd === 'number' && Number.isFinite(value.limit.usd) && value.limit.usd > 0) return { on: value.limit.on === true, usd: value.limit.usd }
  } catch {
    // Never set.
  }
  return { on: false, usd: 1 }
}

/** A limit in dollars with two places, or as many as it needs: a limit of $0.005 never reads "$0.01" or "$0.00". */
export function limitWords(usd) {
  return usd.toFixed(4).replace(/0{1,2}$/, '')
}

export function setJudgeLimit({ on, usd }) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || usd > 10_000) throw new RosterError('LIMIT_INVALID', 'a monthly limit is an amount of dollars above 0')
  writePrivate(judgeSettingsPath(), `${JSON.stringify({ version: 1, limit: { on: on === true, usd } })}\n`)
}

const RECORD_WAIT_MS = 5000
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Adds one call to the record: one writer at a time across processes, the file replaced whole. */
async function recordCall(line, now) {
  let lock
  for (const until = Date.now() + RECORD_WAIT_MS; ;) {
    lock = takeLock(`${judgeRecordPath()}.writing`, { kind: 'writer' })
    if (lock.held === undefined) break
    if (Date.now() >= until) throw new Error('the record of calls is being written by another BMN process')
    await pause(10)
  }
  try {
    const record = readJudgeRecord()
    const month = monthOf(now)
    const totals = record.months[month] ?? { ...emptyTotals(), refused: 0, purposes: {} }
    if (line.requests === 0) totals.refused += 1
    else {
      // A purpose past the most BMN keeps a month goes under one common word; the month's own totals still hold it.
      const word = totals.purposes[line.purpose] !== undefined || Object.keys(totals.purposes).length < PURPOSES_KEPT ? line.purpose : 'other'
      const purpose = totals.purposes[word] ?? emptyTotals()
      for (const sum of [totals, purpose]) {
        sum.calls += 1
        sum.requests += line.requests
        sum.input_tokens += line.input_tokens
        sum.cost_usd = Math.round((sum.cost_usd + line.cost_usd) * 1e12) / 1e12
      }
      totals.purposes[word] = purpose
    }
    record.months[month] = totals
    const months = Object.fromEntries(Object.entries(record.months).sort(([one], [other]) => (one < other ? -1 : 1)).slice(-MONTHS_KEPT))
    writePrivate(judgeRecordPath(), `${JSON.stringify({ version: 1, months, calls: [...record.calls, line].slice(-CALLS_KEPT) }, null, 1)}\n`)
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------------------------------------
// One call

const NEXT = {
  NO_JUDGE: 'the owner adds and approves a judge in Preferences › Team (BMN proposes Jev there)',
  JUDGE_PROPOSED: 'the owner approves the judge in Preferences › Team first',
  JUDGE_DISABLED: 'the owner switches the judge on in Preferences › Team',
  NOT_A_JUDGE: 'name a judge from `bmn roster role judge`, or leave --agent out',
  HOST_NOT_APPROVED: 'the owner lists the agent\'s host under its provider in the team file and approves it',
  FREE_MODEL: 'ask the paid model: leave --model out, and the team names no model ending in -free',
  MODEL_NOT_OWN: 'leave --model out: a judge is asked by its own model only',
  PRIVATE_NOT_ALLOWED: 'send only text that is public and say so with --data public, or ask the owner: he allows private work for both providers in Preferences › Team',
  WORKSPACE_PRIVATE: 'refresh the workspace\'s record with `bmn roster visibility --refresh` if its repository is public, or ask the owner: he allows private work for both providers in Preferences › Team',
  LIMIT_REACHED: 'the owner raises the monthly limit or switches it off on the judge\'s page in Preferences › Team; otherwise ask again next month',
  NO_KEY: 'sign in to OpenCode on this computer (`opencode auth login`); BMN reads the key from OpenCode\'s own sign-in file and keeps none',
  QUESTIONS_INVALID: 'see `bmn judge --help` for the three question types',
  TOO_LARGE: 'send a shorter text, or fewer questions in one call',
  STATE_EMPTY: 'pass the text to judge with --state-file <path>'
}

/** The judge a call goes to, or the refusal: an approved, active, switched-on agent called by BMN that the role names. */
function pickedJudge(data, wanted) {
  const named = judges(data)
  if (wanted !== null) {
    const agent = data.agents.find((entry) => entry.id === wanted)
    if (agent === undefined || !isCalled(agent) || !named.includes(agent)) return { code: 'NOT_A_JUDGE', message: `${wanted} is not a judge on the approved team` }
    const state = agentState(agent)
    if (state === 'proposed') return { code: 'JUDGE_PROPOSED', message: `${agent.name} is proposed, not approved as active` }
    if (state === 'disabled') return { code: 'JUDGE_DISABLED', message: `${agent.name} is switched off` }
    return { agent }
  }
  const active = named.find((agent) => agentState(agent) === 'active')
  if (active !== undefined) return { agent: active }
  if (named.length === 0) return { code: 'NO_JUDGE', message: `the approved team has no judge: no agent called by BMN holds the role ${JUDGE_ROLE}` }
  const first = named[0]
  return agentState(first) === 'proposed' ? { code: 'JUDGE_PROPOSED', message: `${first.name} is proposed, not approved as active` } : { code: 'JUDGE_DISABLED', message: `${first.name} is switched off` }
}

/**
 * One call to the judge. Nothing is sent unless every check passes (65.2 AC2); a refusal has a
 * code, plain words and a `next`. The result holds Jev's numbers unchanged and BMN's reading of
 * each; a timeout, a failed request and an answer that is not Jev's shape all read "no answer"
 * for every question. One line goes into the record whatever happened, with no text in it.
 */
export async function runJudge({
  state, questions, data: declared, workspace = null, purpose = NO_PURPOSE, twice = false, agent: wanted = null, model: wantedModel = null, by = { kind: 'shell' },
  environment = process.env, now = () => new Date(), deadlineMs = DEADLINE_MS
} = {}) {
  const started = now()
  const clock = Date.now()
  const stateHash = typeof state === 'string' ? createHash('sha256').update(state).digest('hex') : null
  const line = { at: started.toISOString(), by, purpose, agent: null, model: null, requests: 0, input_tokens: 0, cost_usd: 0, took_ms: 0, outcome: 'refused', ...(stateHash === null ? {} : { state_sha256: stateHash }) }
  const keep = async (result) => {
    line.took_ms = Date.now() - clock
    try {
      await recordCall(line, started)
    } catch (error) {
      result.note = `${result.note === undefined ? '' : `${result.note} `}BMN could not write this call into its record: ${error instanceof Error ? error.message : String(error)}.`
    }
    return { ...result, took_ms: line.took_ms }
  }
  const refused = (code, message) => {
    line.outcome = 'refused'
    line.code = code
    return keep({ ok: false, outcome: 'refused', code, message, ...(NEXT[code] === undefined ? {} : { next: NEXT[code] }) })
  }

  // The shape first: a wrong file is told what is wrong with it before anything else is looked at (AC1).
  const shape = questionsProblem(questions) ?? sizeProblem(state, questions)
  if (shape !== null) return refused(shape.code, shape.message)
  if (declared !== 'public' && declared !== 'private') return refused('DATA_UNDECLARED', 'say whether the text is public or private with --data public|private')

  let team
  try {
    team = readApproved().data
  } catch (error) {
    if (!(error instanceof RosterError)) throw error
    return refused(error.code, error.message)
  }
  const picked = pickedJudge(team, wanted)
  if (picked.agent === undefined) return refused(picked.code, picked.message)
  const agent = picked.agent
  line.agent = agent.id
  line.model = agent.model
  // The paid model only, whatever a privacy switch reads that day (R65-NFR2): checked in code, on both names.
  if (agent.model.endsWith('-free') || (wantedModel !== null && wantedModel.endsWith('-free'))) return refused('FREE_MODEL', `${wantedModel !== null && wantedModel.endsWith('-free') ? wantedModel : agent.model} is a free model; BMN asks the paid model only`)
  if (wantedModel !== null && wantedModel !== agent.model) return refused('MODEL_NOT_OWN', `${agent.name} is asked by its own model ${agent.model}, not ${wantedModel}`)
  const receiver = team.providers.find((provider) => provider.id === agent.provider)
  if (typeof agent.host !== 'string' || receiver === undefined || !receiver.hosts.some((host) => host.toLowerCase() === agent.host.toLowerCase())) {
    return refused('HOST_NOT_APPROVED', `${agent.name}'s host ${agent.host} is not one its provider ${receiver?.name ?? agent.provider} lists in the approved team`)
  }

  // Private text goes to Jev only where the owner allowed it for both who receives the request and who runs the model (R65-NFR1).
  const parties = calledParties(team, agent)
  if (!parties.allowed) {
    if (declared === 'private') return refused('PRIVATE_NOT_ALLOWED', `the text is declared private, and ${agent.name} gets public text only (${parties.reason})`)
    if (workspace !== null) {
      let root
      try {
        root = workspaceRoot(realpathSync(workspace))
      } catch {
        return refused('WORKSPACE_PRIVATE', `the workspace ${workspace} could not be read, so BMN does not hold it public, and ${agent.name} gets public text only (${parties.reason})`)
      }
      const visibility = workspaceVisibility(root, started)
      if (!visibility.public) return refused('WORKSPACE_PRIVATE', `BMN does not hold the workspace ${root} public (${visibility.reason}), and ${agent.name} gets public text only (${parties.reason})`)
    }
  }

  const limit = judgeLimit()
  if (limit.on) {
    const spent = judgeTotals(started).current.cost_usd
    if (spent >= limit.usd) return refused('LIMIT_REACHED', `this month's calls to ${agent.name} cost $${spent.toFixed(4)}, which reaches the monthly limit of $${limitWords(limit.usd)}; asking is stopped until next month or a higher limit`)
  }

  const key = readKey(environment)
  if (key === null) return refused('NO_KEY', 'BMN found no key for OpenCode\'s gateway in OpenCode\'s sign-in file on this computer')

  const deadline = clock + Math.min(Math.max(1, deadlineMs), DEADLINE_MAX_MS)
  const price = typeof agent.price?.input === 'number' ? agent.price.input : 0
  const call = () => askOnce({ host: agent.host.toLowerCase(), model: agent.model, state, questions, key, environment, deadline })
  const add = (answer) => {
    line.requests += 1
    if (answer.ok && answer.tokens !== null) {
      line.input_tokens += answer.tokens
      line.cost_usd = Math.round((line.cost_usd + (answer.tokens * price) / 1e6) * 1e12) / 1e12
    }
  }
  const first = await call()
  add(first)
  const failed = (answer) => {
    line.outcome = answer.outcome
    return keep({ ok: false, outcome: answer.outcome, agent: agent.id, model: agent.model, note: withoutKey(answer.note, key), readings: noAnswers(questions), requests: line.requests, input_tokens: line.input_tokens, cost_usd: line.cost_usd })
  }
  if (!first.ok) return failed(first)
  let second = null
  if (twice) {
    second = await call()
    add(second)
    if (!second.ok) return failed(second)
  }
  line.outcome = 'answered'
  return keep({
    ok: true, outcome: 'answered', agent: agent.id, model: agent.model, answers: first.answers, ...(second === null ? {} : { second: second.answers }),
    readings: second === null ? first.readings : agreed(first.readings, second.readings), requests: line.requests, input_tokens: line.input_tokens, cost_usd: line.cost_usd
  })
}

// ---------------------------------------------------------------------------------------------
// The command: bmn judge ask

export const JUDGE_USAGE = `Usage: bmn judge ask --state-file <path>|- --questions-file <path> --data public|private
                     [--workspace <path>] [--purpose <word>] [--twice] [--timeout <seconds>]
                     [--agent <id>] [--model <name>] [--json]

Asks the team's judge (Jev) typed questions about one text and prints its numbers with BMN's
reading of each. The judge writes no text; it answers with numbers.

  --state-file      the text to judge, from a file or standard input (-)
  --questions-file  a JSON map of question id to question:
                      {"type":"noul","instructions":"<a statement that is true or false of the text>"}
                      {"type":"choice","instructions":"…","criteria":{"<label>":"<what it means>",…}}
                      {"type":"score","instructions":"…","criteria":["<lowest level>",…,"<highest>"]}
  --data            public, or private: private text is sent only where the owner allowed private
                    work for both the gateway and the model's maker
  --workspace       where the text comes from; with --data public it must be a workspace BMN holds public
  --purpose         one word for the record: a project, dev-auto, brain (lower case, digits, dashes)
  --twice           ask twice and keep a reading only where both agree; counted as two requests
  --timeout         seconds to wait for the answer: ${DEADLINE_MS / 1000} by default, ${DEADLINE_MAX_MS / 1000} at most

The reading (the rule the proof tested, and no other): a noul of ${LINE.toFixed(2)} or more reads "yes"; a choice
whose confidence and winning probability are both ${LINE.toFixed(2)} or more reads its label; a score with a
confidence of ${LINE.toFixed(2)} or more reads its number, marked sure. Everything else reads "${NO_ANSWER}": a
low noul is not a "no". An answer within ${NEAR.toFixed(2)} of the line is marked "near the line".
An answer is advice. Nothing may be granted, accepted, stopped or spent because of one.

Exit: 0 answered; 2 usage; 10 refused (a code, the reason, and what to do next); 11 no answer in
time; 12 the request failed; 13 the answer was not the judge's shape. With 11 to 13 every
question reads "${NO_ANSWER}".`

const number = (value) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000))

/** The answer as lines of text: one per question with its reading and the number it rests on, then what the call cost. */
export function judgeLines(result, questions) {
  const lines = []
  for (const [id, question] of Object.entries(questions)) {
    const reading = result.readings[id]
    const answer = result.answers?.[id]
    const basis = answer === undefined ? '' : question.type === 'noul' ? ` (noul ${number(answer.noul)})`
      : question.type === 'choice' ? ` (${answer.choice}, confidence ${number(answer.confidence)}, probability ${number(answer.probabilities[answer.choice])})`
        : ` (score ${number(answer.score)}, confidence ${number(answer.confidence)})`
    const said = reading.reading === NO_ANSWER ? NO_ANSWER : typeof reading.reading === 'number' ? `${number(reading.reading)}, sure` : reading.reading
    lines.push(`${id}: ${said}${basis}${reading.near === true ? ', near the line' : ''}${reading.differed === true ? ', the two calls differed' : ''}`)
  }
  lines.push(`${result.agent} (${result.model}) · ${result.requests} ${result.requests === 1 ? 'request' : 'requests'} · ${result.input_tokens} input tokens · $${result.cost_usd.toFixed(6)} · ${(result.took_ms / 1000).toFixed(1)} s`)
  return lines
}

function readInput(source) {
  return readFileSync(source === '-' ? 0 : source, 'utf8')
}

export async function runJudgeCommand(argv, { judge = runJudge, environment = process.env } = {}) {
  const { AgentsUsageError, out, readOptions, usage } = await import('./agents-cli.mjs')
  const { askerOf } = await import('./agents-ask.mjs')
  const [action, ...rest] = argv
  if (action === undefined || action === '--help' || action === '-h' || action === 'help') {
    out(JUDGE_USAGE)
    return action === undefined ? EXIT.usage : EXIT.ok
  }
  if (action !== 'ask') return usage(`judge expects ask, not ${action}`)
  let parsed
  let deadlineMs = DEADLINE_MS
  try {
    parsed = readOptions(rest, { flags: ['json', 'help', 'twice'], values: ['state-file', 'questions-file', 'data', 'workspace', 'purpose', 'timeout', 'agent', 'model'] })
    if (parsed.options.help) {
      out(JUDGE_USAGE)
      return EXIT.ok
    }
    if (parsed.positionals.length > 0 || parsed.rest !== null) throw new AgentsUsageError('judge ask takes the text from --state-file and the questions from --questions-file, never from an argument')
    for (const needed of ['state-file', 'questions-file', 'data']) if (parsed.options[needed] === undefined) throw new AgentsUsageError(`judge ask needs --${needed}`)
    if (parsed.options['questions-file'] === '-') throw new AgentsUsageError('--questions-file takes a path; standard input is for the text')
    if (parsed.options.data !== 'public' && parsed.options.data !== 'private') throw new AgentsUsageError('--data takes public or private')
    if (parsed.options.purpose !== undefined && !PURPOSE.test(parsed.options.purpose)) throw new AgentsUsageError('--purpose takes one word of lower-case letters, digits and dashes, at most 32 characters')
    if (parsed.options.agent !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.options.agent)) throw new AgentsUsageError('--agent takes an agent id from `bmn team`')
    if (parsed.options.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(parsed.options.model)) throw new AgentsUsageError('--model takes a model name')
    if (parsed.options.timeout !== undefined) {
      const seconds = Number(parsed.options.timeout)
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > DEADLINE_MAX_MS) throw new AgentsUsageError(`--timeout takes seconds above 0 and at most ${DEADLINE_MAX_MS / 1000}`)
      deadlineMs = Math.round(seconds * 1000)
    }
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  if (parsed.options['state-file'] === '-' && process.stdin.isTTY) return usage('judge ask reads the text from standard input (pipe it or use a heredoc) or from --state-file <path>')
  let state
  try {
    state = readInput(parsed.options['state-file'])
  } catch {
    return usage(`cannot read the text from ${parsed.options['state-file'] === '-' ? 'standard input' : parsed.options['state-file']}`)
  }
  let questions
  try {
    questions = JSON.parse(readInput(parsed.options['questions-file']))
  } catch {
    return usage(`cannot read the questions from ${parsed.options['questions-file']}: it must be one JSON object`)
  }
  const result = await judge({
    state, questions, data: parsed.options.data, workspace: parsed.options.workspace ?? null, purpose: parsed.options.purpose ?? NO_PURPOSE, twice: parsed.options.twice === true,
    agent: parsed.options.agent ?? null, model: parsed.options.model ?? null, by: askerOf(environment), environment, deadlineMs
  })
  if (parsed.options.json === true) out(JSON.stringify(result, null, 2))
  else if (result.outcome === 'answered') out(judgeLines(result, questions).join('\n'))
  else if (result.outcome === 'refused') process.stderr.write(`bmn: ${result.code}: ${result.message}\n${result.next === undefined ? '' : `  next: ${result.next}\n`}`)
  else process.stderr.write(`bmn: ${result.note}; every question reads "${NO_ANSWER}"\n`)
  return result.outcome === 'answered' ? EXIT.ok : result.outcome === 'refused' ? EXIT.refusal : result.outcome === 'timeout' ? EXIT.timeout : result.outcome === 'shape' ? EXIT.shape : EXIT.failed
}
