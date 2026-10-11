// MODULE: agents-research.mjs - Story 60.10, first release: BMN writes the research prompt, runs one checked run per provider, accepts only a typed answer, reads each cited page itself and keeps what was found
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { APP_NAMES, EFFORTS, RESEARCH_APPS, agentState, namedResearchers, researcherProposal } from './agents-roster.mjs'
import { readApproved, stateDirectory } from './agents-state.mjs'
import { CODEX_RESEARCH_ANSWER, CODEX_RESEARCH_CONFIG, CODEX_RESEARCH_DISABLED, CODEX_RESEARCH_HOME, RESEARCH_TOOLS, evaluateResearch, harnessVersion, prepareResearchRun, removeResearchCodexFolders, researchRunsDirectory } from './agents-check.mjs'
import { contextItems, provenControls } from './agents-context.mjs'
import { writePrivate } from './agents-rules.mjs'

/**
 * Research asks one of the owner's agents for published facts about the team's models: the price
 * per million tokens and the context window, each with the page that shows it. BMN writes the
 * prompt (model names and the source list, nothing else), starts the run only after the check
 * passes it, accepts only an answer of the exact shape below, and then reads every cited page
 * itself: a value counts as verified only when BMN's own read shows that number beside that model.
 * Nothing here changes the team; Apply prices and Add to team stage changes the owner approves.
 * Scores, cost per task and recommendations are a later release.
 */

export { RESEARCH_APPS }
/** One research ends after this long, whatever it has found. */
export const RESEARCH_LIMIT_MS = 20 * 60 * 1000
/** How many models that are not on the team one research may list. */
export const MAX_LISTED = 20
/** How many of the team's models one run is asked about. */
const BATCH_SIZE = 8
/** How many different pages BMN reads for one run's answer. */
const MAX_PAGES = 24
const MAX_ANSWER_BYTES = 4 * 1024 * 1024
const MAX_RUNS_KEPT = 12
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
/** The sources a value may come from, best first (first release: prices and capacity only). */
export const SOURCE_RANKS = ['Provider pages', 'Other sites']

export function researchDirectory() {
  return `${stateDirectory()}/research`
}

export function researchResultsPath() {
  return `${researchDirectory()}/results.json`
}

function researchSettingsPath() {
  return `${researchDirectory()}/settings.json`
}

// ---------------------------------------------------------------------------------------------
// What is asked: the team's model names, one run per provider

/**
 * The team's model names, each once, grouped by the provider that serves them. A name no command
 * line could carry is left out rather than sent.
 */
export function researchSubjects(data) {
  const groups = []
  for (const provider of [...data.providers].sort((a, b) => a.id.localeCompare(b.id))) {
    const models = [...new Set(data.agents.filter((agent) => agent.provider === provider.id && MODEL_ID.test(agent.model)).map((agent) => agent.model))].sort()
    if (models.length > 0) groups.push({ provider: provider.id, name: provider.name, sites: [...(provider.sites ?? [])], models })
  }
  return groups
}

/** The runs of one research: a provider's models, at most a few per run, with how many other models each may list. */
export function researchBatches(data) {
  const batches = []
  for (const group of researchSubjects(data)) {
    for (let index = 0; index < group.models.length; index += BATCH_SIZE) {
      batches.push({ ...group, models: group.models.slice(index, index + BATCH_SIZE), discover: index === 0 })
    }
  }
  const discovering = batches.filter((batch) => batch.discover).length
  const each = discovering === 0 ? 0 : Math.max(1, Math.floor(MAX_LISTED / discovering))
  let left = MAX_LISTED
  return batches.map(({ discover, ...batch }) => {
    const listed = discover ? Math.min(each, left) : 0
    left -= listed
    return { ...batch, listed }
  })
}

/**
 * The prompt of one run. It holds the model names, the provider's own sites as the first source
 * and the shape of the answer: no agent names, notes, rules, prices, folders or keys.
 */
export function researchPrompt(batch) {
  const sites = batch.sites.length > 0 ? ` (${batch.sites.join(', ')})` : ''
  const lines = [
    'Look up published facts about these AI models. Use web search and page reads only.',
    '',
    'Models:',
    ...batch.models.map((model) => `- ${model}`),
    '',
    'Sources, in this order:',
    `1. Provider pages: the provider's own pricing and model pages${sites}`,
    '2. Other sites, cited, never overriding a provider page',
    '',
    'For each model find its API price in US dollars per million tokens (input, cached input, output) and its context window in tokens.',
    batch.listed > 0
      ? `Then list up to ${batch.listed} other models the same provider publishes on those pages today, with the same facts, marked "listed": true.`
      : 'List no other models.',
    '',
    'Answer with one JSON object and nothing else, in this shape:',
    '{"version":1,"models":[{"id":"<the name exactly as given above; for a listed model the id the provider publishes>","provider":"<the provider\'s name>","listed":false,"published_name":"<the model\'s name as the cited page shows it>","price":{"input":0,"cached_input":0,"output":0,"source":"https://…","as_of":"YYYY-MM-DD"},"context_window":{"tokens":0,"source":"https://…","as_of":"YYYY-MM-DD"}}]}',
    '',
    'Rules:',
    '- Every model above appears exactly once with "listed": false.',
    '- "source" is the https address of the page that shows the value; "as_of" is the date you read it.',
    '- When no page shows a price or a context window, give the string "unavailable" in its place. "cached_input" may be null.',
    '- Never guess, estimate or compute a value. Give only numbers a page shows.'
  ]
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------
// Who may research, and the exact command

/** The effort a research run uses: the lowest the agent has, since the work is looking numbers up. */
export function researchEffort(agent) {
  return EFFORTS.find((effort) => agent.efforts.includes(effort)) ?? agent.efforts[0]
}

/**
 * The one command a research run is: `env -i` with the home folder and the program path, then the
 * app's research form (60.3 AC11). `run` is the folder BMN made for it, or null for the question
 * "could this agent research at all". A Codex run is also pointed at a Codex folder of its own
 * (63.3): the one in `run`, or `codexHome` where there is no run yet.
 */
export function researchArgv(agent, { environment = process.env, run = null, version = null, contextTests = undefined, codexHome = undefined } = {}) {
  const effort = researchEffort(agent)
  const proven = agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(agent.harness, version, contextTests)
  const context = contextItems(agent, proven)
  const head = ['/usr/bin/env', '-i', `HOME=${environment.HOME ?? ''}`, `PATH=${environment.PATH ?? ''}`]
  if (agent.harness === 'codex') {
    const home = run?.codex ?? codexHome ?? (run === null ? CODEX_RESEARCH_HOME : `${run.folder}/${CODEX_RESEARCH_HOME}`)
    return [...head, `CODEX_HOME=${home}`, 'codex', 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--strict-config',
      ...CODEX_RESEARCH_DISABLED.flatMap((feature) => ['--disable', feature]),
      ...CODEX_RESEARCH_CONFIG.flatMap((entry) => ['-c', entry]), '-m', agent.model, '-c', `model_reasoning_effort="${effort}"`,
      ...(context.argv ?? []), '-o', run === null ? CODEX_RESEARCH_ANSWER : `${run.folder}/${CODEX_RESEARCH_ANSWER}`, '-']
  }
  // An agent on a host of its own is sent there by name; one on the provider's default carries no address at all.
  const host = agent.host === null || agent.host === 'default' ? [] : [`ANTHROPIC_BASE_URL=https://${agent.host}`]
  return [...head, ...host, ...(context.env ?? []),
    'claude', '-p', '--model', agent.model, '--effort', effort, '--safe-mode', '--tools', RESEARCH_TOOLS,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'json']
}

/**
 * The version of the agent's app as a research run starts it: the same program path and the same
 * bare environment. The command needs it before the check runs, since an agent's context limit
 * goes into the command only on a version the owner's test proved.
 */
function appVersion(agent, environment) {
  return harnessVersion(agent.harness, { HOME: environment.HOME ?? '', PATH: environment.PATH ?? '' })
}

/** Why an agent is not offered as the researcher, in a few plain words; the check's own message stays beside it. */
function whyNot(agent, code, detail = undefined) {
  const app = APP_NAMES[agent.harness] ?? agent.harness
  if (code === 'PACKET_INVALID') return 'its provider gets public work only'
  if (code === 'CONTEXT_MISMATCH') {
    // Not "not supported yet": an untested limit is simply left out. What stops a run is a limit that cannot be what the app gets.
    if (detail === 'conflict') return 'two settings name different context sizes for it'
    if (detail === 'unresolved') return `BMN cannot read which context size ${app} would use`
    return detail === 'out-of-range' ? `${app} does not take its context limit` : 'its context limit does not reach its command'
  }
  if (code === 'HARNESS_UNKNOWN') return `${app} was not found`
  // The fence test is of exactly the installed version (63.3): each of its three standings has words of its own.
  if (code === 'ROUTE_UNSUPPORTED' && detail === 'fence-untested') return `the fence test has not run for this version of ${app} yet`
  if (code === 'ROUTE_UNSUPPORTED' && detail === 'fence-failed') return `the fence test of this version of ${app} did not pass`
  if (code === 'ROUTE_UNSUPPORTED' && detail === 'fence-live') return `${app} offers it other tools than the fence test saw`
  if (code === 'ROUTE_UNSUPPORTED') return `BMN has not yet tested that ${app} keeps a research run to the web`
  return `BMN cannot check ${app}'s research command`
}

/** A name in `folder` under which nothing lies, not even a link. */
function absentFolder(folder) {
  for (;;) {
    const path = `${folder}/offer-${randomBytes(8).toString('hex')}`
    try {
      lstatSync(path)
    } catch {
      return path
    }
  }
}

/**
 * The team's researchers and whether each could research now: the same check a run must pass,
 * without a folder or a prompt. `reason` says why not, in the check's own words. Who researches is
 * part of the approved team (63.3): only the agents it names are listed, and an agent it does not
 * name is not here at all. A team that names none is one from before the mark and lists every
 * active agent, as it did.
 */
export function researchers({ environment = process.env, now = new Date(), fenceVersions = undefined, fenceTests = undefined } = {}) {
  let generation
  try {
    generation = readApproved()
  } catch {
    return []
  }
  // A run starts in <runs>/<its id>/cwd, an empty folder BMN makes for it, and the settings files in
  // and above a folder count for the app, each by where it lies from the run. So the question is asked
  // from a folder of that very shape, and the offer and the run's own check read the same files in the
  // same parts. The folder is one that is not there, as a run's own is not before BMN makes it: a
  // name of its own could hold files no run would ever read.
  let runs = researchRunsDirectory()
  try {
    runs = realpathSync(runs)
  } catch {
    // No research has run yet: the folder's name is all there is.
  }
  const from = `${absentFolder(runs)}/cwd`
  const found = []
  const named = namedResearchers(generation.data)
  for (const agent of generation.data.agents) {
    if (agentState(agent) !== 'active' || (named !== null && !named.includes(agent.id))) continue
    if (!RESEARCH_APPS.includes(agent.harness)) {
      found.push({ id: agent.id, name: agent.name, harness: agent.harness, ok: false, why: `its app is ${APP_NAMES[agent.harness] ?? agent.harness}`, reason: `${APP_NAMES[agent.harness] ?? agent.harness} has no research form BMN can check` })
      continue
    }
    let result
    try {
      result = evaluateResearch({ agent: agent.id, argv: researchArgv(agent, { environment, version: appVersion(agent, environment), codexHome: `${dirname(from)}/${CODEX_RESEARCH_HOME}` }), dry: true },
        { environment, cwd: from, now, ...(fenceVersions === undefined ? {} : { fenceVersions }), ...(fenceTests === undefined ? {} : { fenceTestLog: fenceTests }) })
    } catch (error) {
      result = { verdict: 'REFUSED', message: error instanceof Error ? error.message : String(error) }
    }
    found.push({
      id: agent.id, name: agent.name, harness: agent.harness, ok: result.verdict === 'PASS',
      ...(result.verdict === 'PASS' ? (result.fence === undefined ? {} : { fence: result.fence }) : { why: whyNot(agent, result.code, result.detail), reason: result.message })
    })
  }
  return found
}

/**
 * Who researches, as the team says it: `named` are the agents it names (null for a team from before
 * the mark, where the choice still waits for the owner), `proposed` is who BMN would name then.
 */
export function researcherChoice() {
  try {
    const data = readApproved().data
    return { named: namedResearchers(data), proposed: researcherProposal(data) }
  } catch {
    return { named: null, proposed: [] }
  }
}

function researchSettings() {
  try {
    const value = JSON.parse(readFileSync(researchSettingsPath(), 'utf8'))
    return { researcher: typeof value?.researcher === 'string' ? value.researcher : null, dropped: typeof value?.dropped === 'string' ? value.dropped : null }
  } catch {
    return { researcher: null, dropped: null }
  }
}

/** The researcher the owner last picked, or null. */
export function chosenResearcher() {
  return researchSettings().researcher
}

export function chooseResearcher(id) {
  writePrivate(researchSettingsPath(), `${JSON.stringify({ version: 1, researcher: id })}\n`)
}

/**
 * The owner's pick as it stands against the team (63.3 AC8): a researcher he picked that the team
 * no longer names falls back to none picked. `dropped` names that agent until he picks again or a
 * research starts, so Models can say it once; it is written only the one time the pick falls back.
 */
export function settledResearcher() {
  const settings = researchSettings()
  let named
  try {
    named = namedResearchers(readApproved().data)
  } catch {
    return settings
  }
  if (settings.researcher === null || named === null || named.includes(settings.researcher)) return settings
  const fallen = { researcher: null, dropped: settings.researcher }
  writePrivate(researchSettingsPath(), `${JSON.stringify({ version: 1, ...fallen })}\n`)
  return fallen
}

/** The note about a fallen-back pick has been said, or acted on. */
export function forgetDroppedResearcher() {
  const settings = researchSettings()
  if (settings.dropped !== null) writePrivate(researchSettingsPath(), `${JSON.stringify({ version: 1, researcher: settings.researcher })}\n`)
}

// ---------------------------------------------------------------------------------------------
// The answer: one typed object, or the run failed

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key))

function sourceProblem(value, today) {
  if (typeof value.source !== 'string' || value.source.length > 200 || !/^https:\/\/\S+$/.test(value.source)) return 'a source must be an https address of at most 200 characters'
  try {
    const url = new URL(value.source)
    if (url.username !== '' || url.password !== '') return 'a source address carries no sign-in'
  } catch {
    return 'a source is not an address'
  }
  if (typeof value.as_of !== 'string' || !DATE.test(value.as_of) || Number.isNaN(Date.parse(`${value.as_of}T00:00:00Z`))) return 'as_of must be a date, YYYY-MM-DD'
  if (value.as_of > today) return 'as_of is a date that has not come yet'
  return null
}

/**
 * Reads a researcher's answer for one run. It must be exactly one JSON object of the asked shape:
 * every asked model once, no more listed models than allowed, every value with its page and date
 * or the word "unavailable". Anything else fails the run; BMN never repairs or fills an answer.
 */
export function parseAnswer(text, batch, { now = new Date() } = {}) {
  const fail = (reason) => ({ ok: false, reason })
  if (typeof text !== 'string') return fail('the answer is not text')
  let body = text.trim()
  const fenced = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  if (fenced) body = fenced[1].trim()
  let answer
  try {
    answer = JSON.parse(body)
  } catch {
    return fail('the answer is not one JSON object')
  }
  if (!isObject(answer) || answer.version !== 1 || !Array.isArray(answer.models) || !onlyKeys(answer, ['version', 'models'])) return fail('the answer is not the asked shape (version 1 and a list of models)')
  const today = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const models = []
  const seen = new Set()
  let listed = 0
  for (const entry of answer.models) {
    if (!isObject(entry) || !onlyKeys(entry, ['id', 'provider', 'listed', 'published_name', 'price', 'context_window'])) return fail('a model in the answer has a field BMN did not ask for')
    if (typeof entry.id !== 'string' || !MODEL_ID.test(entry.id)) return fail('a model in the answer has no usable id')
    if (seen.has(entry.id)) return fail(`${entry.id} is in the answer twice`)
    seen.add(entry.id)
    if (typeof entry.provider !== 'string' || entry.provider.trim() === '' || entry.provider.length > 60) return fail(`${entry.id}: the provider's name is missing or too long`)
    if (typeof entry.listed !== 'boolean') return fail(`${entry.id}: "listed" must be true or false`)
    if (entry.published_name !== undefined && (typeof entry.published_name !== 'string' || entry.published_name.trim() === '' || entry.published_name.length > 80)) return fail(`${entry.id}: the published name is empty or too long`)
    const asked = batch.models.includes(entry.id)
    if (asked === entry.listed) return fail(asked ? `${entry.id} was asked about and cannot be a listed model` : `${entry.id} was not asked about and is not marked as listed`)
    if (entry.listed) listed += 1
    let price = null
    if (entry.price !== 'unavailable') {
      if (!isObject(entry.price) || !onlyKeys(entry.price, ['input', 'cached_input', 'output', 'source', 'as_of'])) return fail(`${entry.id}: the price is neither "unavailable" nor the asked shape`)
      if (!amount(entry.price.input) || !amount(entry.price.output)) return fail(`${entry.id}: input and output must be numbers from 0 to 1000000`)
      if (entry.price.cached_input !== undefined && entry.price.cached_input !== null && !amount(entry.price.cached_input)) return fail(`${entry.id}: cached_input must be a number or null`)
      const problem = sourceProblem(entry.price, today)
      if (problem !== null) return fail(`${entry.id}: ${problem}`)
      price = { input: entry.price.input, output: entry.price.output, ...(typeof entry.price.cached_input === 'number' ? { cached_input: entry.price.cached_input } : {}), source: entry.price.source, as_of: entry.price.as_of }
    }
    let window = null
    if (entry.context_window !== 'unavailable') {
      if (!isObject(entry.context_window) || !onlyKeys(entry.context_window, ['tokens', 'source', 'as_of'])) return fail(`${entry.id}: the context window is neither "unavailable" nor the asked shape`)
      if (!Number.isInteger(entry.context_window.tokens) || entry.context_window.tokens < 1000 || entry.context_window.tokens > 100_000_000) return fail(`${entry.id}: the context window must be a whole number of tokens`)
      const problem = sourceProblem(entry.context_window, today)
      if (problem !== null) return fail(`${entry.id}: ${problem}`)
      window = { tokens: entry.context_window.tokens, source: entry.context_window.source, as_of: entry.context_window.as_of }
    }
    models.push({ id: entry.id, provider: entry.provider.trim(), listed: entry.listed, ...(entry.published_name === undefined ? {} : { published_name: entry.published_name.trim() }), price, context_window: window })
  }
  const missing = batch.models.filter((model) => !seen.has(model))
  if (missing.length > 0) return fail(`the answer leaves out ${missing.join(', ')}`)
  if (listed > batch.listed) return fail(`the answer lists ${listed} other models; ${batch.listed} were asked for`)
  return { ok: true, models }
}

/** The answer text inside what the app printed: Claude Code's result object, or the file Codex wrote. */
export function answerText(harness, stdout, run) {
  if (harness === 'codex') {
    try {
      return { ok: true, text: readFileSync(`${run.folder}/${CODEX_RESEARCH_ANSWER}`, 'utf8') }
    } catch {
      return { ok: false, reason: 'Codex wrote no answer' }
    }
  }
  let printed
  try {
    printed = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: 'Claude Code did not print a result' }
  }
  if (!isObject(printed) || printed.is_error === true || typeof printed.result !== 'string') return { ok: false, reason: 'Claude Code reported an error instead of an answer' }
  return { ok: true, text: printed.result }
}

// ---------------------------------------------------------------------------------------------
// Reading a cited page: one plain public GET, no cookies, never a private or local address

/** Whether an address is on the public internet: not this machine, a private network, a link-local or a reserved range. */
export function isPublicAddress(address) {
  const kind = isIP(address)
  if (kind === 4) {
    const [a, b, c] = address.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (kind === 6) {
    const lower = address.toLowerCase()
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPublicAddress(mapped[1])
    if (lower === '::' || lower === '::1' || lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return false
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff') || lower.startsWith('2001:db8:')) return false
    return true
  }
  return false
}

function resolveHost(host) {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)))
  })
}

/** The longest BMN waits for one cited page, the name lookup and every redirect included. */
const PAGE_LIMIT_MS = 10_000

/** `work`, given up after `ms` or at Stop: a name server that never answers must not hold a research open. */
function within(work, ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => end(reject, Object.assign(new Error('stopped'), { code: 'STOPPED' }))
    const timer = setTimeout(() => end(reject, Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms)
    const end = (settle, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      settle(value)
    }
    if (signal?.aborted) return stop()
    signal?.addEventListener('abort', stop, { once: true })
    work.then((value) => end(resolve, value), (error) => end(reject, error))
  })
}

/** One GET to an address BMN already checked: the name is resolved once, so the answer cannot move between the check and the read. */
function getOnce(url, { address, family }, { timeoutMs, maxBytes, signal }) {
  return new Promise((resolve) => {
    const stop = () => {
      call.destroy()
      done({ failed: 'the research was stopped' })
    }
    const done = (value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve(value)
    }
    const call = httpsRequest({
      protocol: 'https:', hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: 'GET', servername: url.hostname, agent: false,
      headers: { 'user-agent': 'BMN model research (reads one cited page)', accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8', 'accept-encoding': 'identity' },
      lookup: (_host, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family))
    }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) {
        response.resume()
        return done({ status, location: response.headers.location ?? null })
      }
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          call.destroy()
          return done({ status, tooLarge: true })
        }
        chunks.push(chunk)
      })
      response.on('end', () => done({ status, type: String(response.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', () => done({ failed: 'the page stopped arriving' }))
    })
    const timer = setTimeout(() => {
      call.destroy()
      done({ failed: 'the page did not answer in time' })
    }, timeoutMs)
    call.on('error', () => done({ failed: 'the page could not be reached' }))
    signal?.addEventListener('abort', stop, { once: true })
    call.end()
  })
}

/**
 * Reads one cited page the way anyone could: https only, the default port, no sign-in in the
 * address, no cookies, at most three redirects each checked the same way, ten seconds and two
 * megabytes in all, the name lookups counted in those ten seconds. A name that resolves to this
 * machine or a private network is never asked. `signal` (Stop) ends the read at once.
 * `selfTestPages` serves names under `.test` from a folder; such a name can never be a real site.
 */
export async function fetchPublicPage(address, { timeoutMs = PAGE_LIMIT_MS, maxBytes = 2 * 1024 * 1024, redirects = 3, resolve = resolveHost, transport = getOnce, selfTestPages = null, signal = undefined } = {}) {
  const deadline = Date.now() + timeoutMs
  let current = address
  for (let hop = 0; hop <= redirects; hop += 1) {
    if (signal?.aborted) return { ok: false, reason: 'the research was stopped' }
    let url
    try {
      url = new URL(current)
    } catch {
      return { ok: false, reason: 'not an address' }
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) return { ok: false, reason: 'not a plain https address' }
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (host.endsWith('.test')) {
      if (selfTestPages === null) return { ok: false, reason: 'not a public address' }
      const path = decodeURIComponent(url.pathname)
      if (path.split('/').includes('..') || !/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: 'not a public address' }
      try {
        return { ok: true, text: readFileSync(`${selfTestPages}/${host}${path}`, 'utf8') }
      } catch {
        return { ok: false, reason: 'the page could not be read' }
      }
    }
    if (isIP(host) !== 0 || host.startsWith('[') || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      return { ok: false, reason: 'not a public address' }
    }
    let addresses
    try {
      const wait = deadline - Date.now()
      if (wait <= 0) return { ok: false, reason: 'the page did not answer in time' }
      addresses = await within(Promise.resolve(resolve(host)), wait, signal)
    } catch (error) {
      return { ok: false, reason: error?.code === 'STOPPED' ? 'the research was stopped' : error?.code === 'TIMEOUT' ? 'the page did not answer in time' : 'the site could not be found' }
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) return { ok: false, reason: 'not a public address' }
    const left = deadline - Date.now()
    if (left <= 0) return { ok: false, reason: 'the page did not answer in time' }
    const answer = await transport(url, addresses[0], { timeoutMs: left, maxBytes, signal })
    if (answer.failed) return { ok: false, reason: answer.failed }
    if (answer.tooLarge) return { ok: false, reason: 'the page is too large to read' }
    if (answer.status >= 300 && answer.status < 400) {
      if (!answer.location) return { ok: false, reason: 'the page moved without saying where' }
      try {
        current = new URL(answer.location, url).href
      } catch {
        return { ok: false, reason: 'the page moved to something that is not an address' }
      }
      continue
    }
    if (answer.status !== 200) return { ok: false, reason: `the site answered ${answer.status}` }
    if (!/^(text\/html|application\/xhtml\+xml|application\/json|text\/plain)\b/i.test(answer.type)) return { ok: false, reason: 'the page is not text' }
    return { ok: true, text: answer.body }
  }
  return { ok: false, reason: 'the page moved too many times' }
}

// ---------------------------------------------------------------------------------------------
// Does the page show the value beside the model?

const ENTITIES = { amp: '&', nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", dollar: '$' }

/** A page's words: scripts and styles dropped, tags to spaces, the few entities a price uses decoded. */
export function pageText(html) {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all)
    .replace(/\s+/g, ' ')
}

/** How far after a model's name its own numbers may stand. */
const NEAR = 600

/** Each stretch of the page that follows one of the model's names and ends where another model's name begins. */
function stretches(text, names, others) {
  const lower = text.toLowerCase()
  const found = []
  for (const name of names) {
    const needle = name.toLowerCase()
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      // A longer name that merely starts with this one (…-mini, … Pro) is another model.
      if (/[a-z0-9]/.test(lower[at - 1] ?? ' ')) continue
      const after = lower[at + needle.length] ?? ' '
      if (/[a-z0-9]/.test(after) || ((after === '-' || after === '.') && /[a-z0-9]/.test(lower[at + needle.length + 1] ?? ''))) continue
      let end = Math.min(lower.length, at + needle.length + NEAR)
      for (const other of others) {
        const next = lower.indexOf(other.toLowerCase(), at + needle.length)
        if (next !== -1 && next < end) end = next
      }
      found.push(text.slice(at + needle.length, end))
    }
  }
  return found
}

/**
 * Each value in a stretch with the word that says what it is. A value takes the word that stands
 * next to it: within `reach` characters, with no other value in between. Where a word stands on
 * both sides ("Input $2 Output $8": is "Output" the $2's or the $8's?) the stretch's own order
 * decides: one that leads with a word reads word-then-value, one that leads with a value reads
 * value-then-word. `kind` is null where no word stands there; `style` is `none` where the
 * stretch has no such words at all.
 */
function labelled(place, valuePattern, wordPattern, kindOf, reach = 60) {
  const tokens = [
    ...[...place.matchAll(valuePattern)].map((match) => ({ at: match.index, end: match.index + match[0].length, value: match[1] ?? match[0] })),
    ...[...place.matchAll(wordPattern)].map((match) => ({ at: match.index, end: match.index + match[0].length, kind: kindOf(match[0]) }))
  ].sort((one, other) => one.at - other.at)
  const style = !tokens.some((token) => token.kind !== undefined) ? 'none' : tokens[0].kind !== undefined ? 'before' : 'after'
  const values = tokens.flatMap((token, index) => {
    if (token.kind !== undefined) return []
    const before = tokens[index - 1]?.kind !== undefined && token.at - tokens[index - 1].end <= reach ? tokens[index - 1] : undefined
    const after = tokens[index + 1]?.kind !== undefined && tokens[index + 1].at - token.end <= reach ? tokens[index + 1] : undefined
    const word = before !== undefined && after !== undefined ? (style === 'before' ? before : after) : before ?? after
    return [{ value: token.value, kind: word?.kind ?? null }]
  })
  return { style, values }
}

const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)(?![\d])/g
const PRICE_WORDS = /\b(?:cach(?:ed?|ing)(?:[\s-]+(?:input|read|write|hit)s?)?|input|prompt|output|completion)\b/gi
const priceKind = (word) => (/^cach/i.test(word) ? 'cached' : /^(?:input|prompt)$/i.test(word) ? 'input' : 'output')
const amountIs = (text, wanted) => Math.abs(Number(text.replace(/,/g, '')) - wanted) < 1e-9

const PER_MILLION = /(?:\/|per)\s*(?:1\s*)?(?:m\b|mtok|million)|1m tokens|million tokens/i

/** Whether one stretch shows this price: `{ cached }` when it does, null when it does not. */
function priceIn(place, price) {
  const { style, values } = labelled(place, DOLLARS, PRICE_WORDS, priceKind)
  // A row of bare amounts says nothing about which is which: a table's own header may give the output first, and
  // in a page read as plain text nothing ties a header to this row. Such a price is never counted as shown.
  if (style === 'none') return null
  const shows = (kind, wanted) => values.some((entry) => entry.kind === kind && amountIs(entry.value, wanted))
  if (!shows('input', price.input) || !shows('output', price.output)) return null
  return { cached: price.cached_input === undefined ? undefined : shows('cached', price.cached_input) }
}

/**
 * Whether the page shows this price beside this model: in the stretch after one of the model's
 * names, the input amount standing beside the word for an input price and the output amount
 * beside the word for an output price (a cached price beside its own word), with the page saying
 * the unit is a million tokens. A number that stands beside another model, under the other word,
 * without a word of its own (a bare row of a table) or without the unit proves nothing.
 */
export function priceShown(text, names, others, price) {
  if (!PER_MILLION.test(text)) return { shown: false, why: 'the page does not say the price is per million tokens' }
  const places = stretches(text, names, others)
  if (places.length === 0) return { shown: false, why: 'the page does not name this model' }
  for (const place of places) {
    const hit = priceIn(place, price)
    if (hit !== null) return { shown: true, cached: hit.cached }
  }
  return { shown: false, why: 'the page does not show this price beside the model' }
}

function tokenForms(tokens) {
  const forms = [String(tokens), tokens.toLocaleString('en-US'), tokens.toLocaleString('en-US').replace(/,/g, ' ')]
  if (tokens % 1_000_000 === 0) forms.push(`${tokens / 1_000_000}M`, `${tokens / 1_000_000} million`)
  else if (tokens % 100_000 === 0) forms.push(`${tokens / 1_000_000}M`)
  if (tokens % 1000 === 0) forms.push(`${tokens / 1000}K`)
  return forms
}

const WINDOW_WORDS = /\b(?:context(?:\s+(?:window|length|size))?|max(?:imum)?\s+output(?:\s+tokens)?|output\s+(?:tokens|limit|length)|max(?:imum)?\s+(?:completion\s+)?tokens|completion\s+tokens)\b/gi
/** A count of tokens as pages write one: four digits or more, grouped or not, or a number with K, M or million. Never an amount of money. */
const TOKEN_COUNTS = /(?<![\d.,$\w])(?:\d{1,3}(?:[, ]\d{3})+|\d+(?:\.\d+)?\s?(?:K|M|million)\b|\d{4,})(?![\d])/gi

/**
 * Whether the page shows this context window beside this model: the number standing with the
 * word "context" in a stretch after one of the model's names. The same number as an output limit
 * ("max output 128,000 tokens"), or with no word saying what it counts, proves nothing.
 */
export function windowShown(text, names, others, tokens) {
  const places = stretches(text, names, others)
  if (places.length === 0) return { shown: false, why: 'the page does not name this model' }
  const forms = tokenForms(tokens).map((form) => form.toLowerCase())
  const isIt = (value) => forms.includes(value.toLowerCase().replace(/\s+(?=k$|m$)/, ''))
  const hit = places.some((place) => labelled(place, TOKEN_COUNTS, WINDOW_WORDS, (word) => (/^context/i.test(word) ? 'context' : 'output')).values.some((entry) => entry.kind === 'context' && isIt(entry.value)))
  return hit ? { shown: true } : { shown: false, why: 'the page does not show this context window beside the model' }
}

/**
 * The words of a model's name: its letters and digits in order, without a provider in front
 * ("openai/…") or a date at the end.
 */
function nameWords(name) {
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  return (bare.toLowerCase().match(/[a-z]+|\d+/g) ?? []).filter((word) => !/^\d{6,}$/.test(word)).join(' ')
}

/**
 * The names a page may show a model under: its id and, where the researcher gave one, a published
 * name made of the id's own words ("Claude Opus 5.5" for `claude-opus-5-5`). Any other name is the
 * researcher's word for which row is this model's, and BMN does not take it.
 */
export function ownNames(model) {
  const published = typeof model.published_name === 'string' && nameWords(model.published_name) === nameWords(model.id) ? [model.published_name] : []
  return [model.id, ...published]
}

/** Which source list a page belongs to: the provider's own sites first, anything else second. Decided from the address, never from the answer. */
export function sourceRank(address, sites) {
  let host
  try {
    host = new URL(address).hostname.toLowerCase()
  } catch {
    return 2
  }
  return sites.some((site) => host === site.toLowerCase() || host.endsWith(`.${site.toLowerCase()}`)) ? 1 : 2
}

/** How close to the research's time limit a page read counts as having run into it. */
const CLOCK_SLACK_MS = 5

/**
 * Reads each cited page once and marks every value: verified when BMN's own read shows it beside
 * the model, else unverified with the reason. A cached-input price the page does not show is dropped,
 * and so is a published name that is not the id's own words. `signal` (Stop) and `deadline` (the
 * research's own limit, on the machine's clock) end the reading: a page not read by then leaves its
 * values unverified, and `report.cut` says which of the two ended it.
 */
export async function verifyModels(models, sites, { fetchPage = fetchPublicPage, signal = undefined, deadline = Infinity, report = {} } = {}) {
  const pages = new Map()
  const read = async (address) => {
    if (!pages.has(address)) {
      if (pages.size >= MAX_PAGES) return { ok: false, reason: 'the answer cites more pages than BMN reads for one run' }
      const left = deadline - Date.now()
      if (signal?.aborted || left <= 0) {
        report.cut ??= signal?.aborted ? 'stopped' : 'limit'
        return { ok: false, reason: signal?.aborted ? 'the research was stopped before BMN read this page' : 'the research reached its time limit before BMN read this page' }
      }
      const page = await fetchPage(address, { signal, timeoutMs: Math.min(PAGE_LIMIT_MS, left) })
      // A read that ran to the end of the research's time is the limit, also when it was the last page.
      // A timer may fire a millisecond before the clock shows its time, so "the end" is the last few
      // milliseconds: nothing more could be read in them anyway.
      if (signal?.aborted) report.cut ??= 'stopped'
      else if (Date.now() >= deadline - CLOCK_SLACK_MS) report.cut ??= 'limit'
      pages.set(address, page.ok ? { ok: true, text: pageText(page.text) } : page)
    }
    return pages.get(address)
  }
  const named = models.map((model) => {
    const names = ownNames(model)
    if (names.length > 1) return { model, names }
    const rest = { ...model }
    delete rest.published_name
    return { model: rest, names }
  })
  const allNames = named.flatMap((entry) => entry.names)
  const checked = []
  for (const { model, names } of named) {
    const others = allNames.filter((name) => !names.some((own) => own.toLowerCase() === name.toLowerCase()))
    let price = model.price
    if (price !== null) {
      const page = await read(price.source)
      const result = page.ok ? priceShown(page.text, names, others, price) : { shown: false, why: page.reason }
      const { cached_input: cached, ...rest } = price
      price = { ...rest, ...(cached !== undefined && result.shown && result.cached ? { cached_input: cached } : {}), rank: sourceRank(price.source, sites), verified: result.shown, ...(result.shown ? {} : { why: result.why }) }
    }
    let window = model.context_window
    if (window !== null) {
      const page = await read(window.source)
      const result = page.ok ? windowShown(page.text, names, others, window.tokens) : { shown: false, why: page.reason }
      window = { ...window, rank: sourceRank(window.source, sites), verified: result.shown, ...(result.shown ? {} : { why: result.why }) }
    }
    checked.push({ ...model, price, context_window: window })
  }
  return checked
}

// ---------------------------------------------------------------------------------------------
// What was found, kept between researches

const EMPTY = { version: 1, runs: [], models: [] }

/** Everything research has found so far. A missing or damaged file reads as nothing found. */
export function readResearch() {
  try {
    const value = JSON.parse(readFileSync(researchResultsPath(), 'utf8'))
    if (isObject(value) && value.version === 1 && Array.isArray(value.runs) && Array.isArray(value.models)) return value
  } catch {
    // Nothing found yet.
  }
  return { ...EMPTY }
}

/**
 * Adds one research to what is kept. A model keeps the date it was first seen; a model this
 * research did not find stays, with the date it was last seen. `run.kind` is `research` for the
 * whole team or `lookup` for one name, which never counts as a research of the team.
 */
export function mergeResearch(store, run, found) {
  const models = store.models.map((model) => ({ ...model }))
  for (const entry of found) {
    const at = models.findIndex((model) => model.provider_id === entry.provider_id && model.id === entry.id)
    const kept = at === -1 ? null : models[at]
    const record = {
      id: entry.id, provider: entry.provider, provider_id: entry.provider_id, listed: entry.listed,
      ...(entry.published_name ? { published_name: entry.published_name } : {}),
      // A value this research could not find does not erase one an earlier research did.
      price: entry.price ?? kept?.price ?? null, context_window: entry.context_window ?? kept?.context_window ?? null,
      first_seen: kept?.first_seen ?? run.at, first_run: kept?.first_run ?? run.id, last_seen: run.at, last_run: run.id
    }
    if (at === -1) models.push(record)
    else models[at] = record
  }
  return { version: 1, runs: [...store.runs, run].slice(-MAX_RUNS_KEPT), models }
}

export function saveResearch(store) {
  writePrivate(researchResultsPath(), `${JSON.stringify(store, null, 1)}\n`)
}

/**
 * What the Models page shows of what is kept: the last research of the team, the one before it, and
 * every model found so far, each marked when the last research saw it for the first time (`fresh`)
 * and whether that research found it at all. The page groups them against the team as it is drafted.
 */
export function researchView(store) {
  const full = store.runs.filter((run) => run.kind === 'research')
  const last = full.at(-1) ?? null
  const previous = full.at(-2) ?? null
  return {
    last: last === null ? null : { at: last.at, researcher: last.researcher_name, state: last.state, models: last.models, ...(last.note ? { note: last.note } : {}) },
    previousAt: previous?.at ?? null,
    models: store.models.map((model) => ({
      id: model.id, provider: model.provider, providerId: model.provider_id, ...(model.published_name ? { publishedName: model.published_name } : {}),
      price: model.price, contextWindow: model.context_window, firstSeen: model.first_seen, lastSeen: model.last_seen,
      fresh: last !== null && model.first_run === last.id, foundLast: last !== null && model.last_run === last.id
    }))
  }
}

// ---------------------------------------------------------------------------------------------
// Running it

/** Ends a run's whole process group: first asked, then made to. */
function endGroup(child) {
  if (child.pid === undefined) return
  const signal = (name) => {
    try {
      process.kill(-child.pid, name)
    } catch {
      // Already gone.
    }
  }
  signal('SIGTERM')
  setTimeout(() => signal('SIGKILL'), 3000).unref()
}

/** Starts one checked run and resolves with what it printed, or with why it ended early. */
function runOnce(argv, run, { signal, deadline }) {
  return new Promise((resolve) => {
    const input = openSync(run.prompt, 'r')
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: run.cwd, env: {}, stdio: [input, 'pipe', 'ignore'], detached: true })
    } catch (error) {
      closeSync(input)
      return resolve({ ended: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
    closeSync(input)
    const chunks = []
    let size = 0
    let ended = null
    const stop = (why) => {
      ended ??= why
      endGroup(child)
    }
    const onAbort = () => stop('stopped')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timer = setTimeout(() => stop('limit'), Math.max(0, deadline - Date.now()))
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_ANSWER_BYTES) return stop('failed')
      chunks.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ended: 'failed', reason: error.code === 'ENOENT' ? 'the program was not found' : error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (ended !== null) return resolve({ ended, reason: ended === 'failed' ? 'the app printed more than BMN reads' : undefined })
      if (code !== 0) return resolve({ ended: 'failed', reason: `the app ended with code ${code}` })
      resolve({ ended: 'done', stdout: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

/**
 * One research: a checked run per provider, one after another. Each run's models are verified and
 * kept as soon as it ends, so Stop, the time limit or a failed run keeps what the earlier runs
 * found; the research is then marked partial. `only` researches one name on one provider (Look up).
 * Returns the run record and what it found; nothing is thrown for a refusal or a failed run.
 * With a Codex researcher BMN first compares the tool list under the provider's own model list with
 * the one the fence test saw (`compare`, 63.3 AC6): no run starts, and no answer is used, where
 * they differ or cannot be compared.
 */
export async function runResearch({
  researcher, only = null, environment = process.env, now = () => new Date(), signal = undefined, onProgress = () => {},
  fetchPage = fetchPublicPage, limitMs = RESEARCH_LIMIT_MS, contextTests = undefined, fenceVersions = undefined, fenceTests = undefined, compare = undefined
} = {}) {
  const started = now()
  const generation = readApproved()
  const data = generation.data
  const agent = data.agents.find((entry) => entry.id === researcher)
  const id = `${started.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${only === null ? 'team' : 'one'}`
  const record = { id, kind: only === null ? 'research' : 'lookup', at: started.toISOString(), researcher, researcher_name: agent?.name ?? researcher, state: 'complete', models: 0 }
  // A research that found nothing is reported and not kept: the page goes on showing the last one that found something.
  const finish = (state, note, found) => {
    const run = { ...record, state, models: found.length, ...(note ? { note } : {}) }
    if (found.length > 0) saveResearch(mergeResearch(readResearch(), run, found))
    return { run, found }
  }
  if (agent === undefined) return finish('failed', `no agent ${researcher} on the approved team`, [])
  let batches
  if (only === null) batches = researchBatches(data)
  else {
    const provider = data.providers.find((entry) => entry.id === only.provider)
    if (!MODEL_ID.test(only.model)) return finish('failed', 'that name cannot be researched: it holds characters a model name does not', [])
    batches = [{ provider: only.provider, name: provider?.name ?? only.provider, sites: [...(provider?.sites ?? [])], models: [only.model], listed: 0 }]
  }
  const total = batches.reduce((sum, batch) => sum + batch.models.length, 0)
  if (total === 0) return finish('failed', 'the team has no model names to research', [])
  // The limit runs on the machine's clock; `now` only dates what is kept.
  const deadline = Date.now() + limitMs
  const found = []
  const failures = []
  let done = 0
  let ended = null
  let compared = agent.harness !== 'codex'
  onProgress({ done, total })
  for (const batch of batches) {
    if (signal?.aborted) ended = 'stopped'
    else if (Date.now() >= deadline) ended = 'limit'
    if (ended !== null) break
    const prompt = researchPrompt(batch)
    const run = prepareResearchRun(prompt, { now: now(), harness: agent.harness, environment })
    const argv = researchArgv(agent, { environment, run, version: appVersion(agent, environment), contextTests })
    const verdict = evaluateResearch({ agent: agent.id, argv, stdin: run.prompt, cwd: run.cwd }, {
      environment, cwd: run.cwd, now: now(), ...(contextTests === undefined ? {} : { contextTestLog: contextTests }),
      ...(fenceVersions === undefined ? {} : { fenceVersions }), ...(fenceTests === undefined ? {} : { fenceTestLog: fenceTests })
    })
    if (verdict.verdict !== 'PASS') {
      // The same refusal would meet every later run: nothing more is started.
      removeResearchCodexFolders(run)
      failures.push(`BMN did not start the run: ${verdict.message}`)
      ended = 'refused'
      break
    }
    if (!compared) {
      // Once per research, after the check and before the first run: the fence test knew only the model list Codex was built with.
      let same
      try {
        same = await (compare ?? (await import('./agents-fence.mjs')).compareUnderProviderList)({ agent, environment, now: now(), ...(fenceTests === undefined ? {} : { tests: fenceTests }) })
      } catch (error) {
        same = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      if (!same.ok) {
        removeResearchCodexFolders(run)
        failures.push(`BMN did not start the run: ${same.reason}`)
        ended = 'refused'
        break
      }
      compared = true
    }
    writePrivate(`${run.folder}/receipt.json`, `${JSON.stringify(verdict.receipt)}\n`)
    let result
    try {
      result = await runOnce(argv, run, { signal, deadline })
    } finally {
      // The run's own Codex folder goes with the run: the link is removed, never the sign-in file it points at.
      removeResearchCodexFolders(run)
    }
    if (result.ended === 'stopped' || result.ended === 'limit') {
      ended = result.ended
      break
    }
    if (result.ended === 'failed') {
      failures.push(`${batch.name}: ${result.reason}`)
    } else {
      const text = answerText(agent.harness, result.stdout, run)
      const answer = text.ok ? parseAnswer(text.text, batch, { now: now() }) : text
      if (!answer.ok) failures.push(`${batch.name}: ${answer.reason}`)
      else {
        // Stop and the time limit hold while the cited pages are read too: what was read by then is kept, marked.
        const report = {}
        const checked = await verifyModels(answer.models, batch.sites, { fetchPage, signal, deadline, report })
        found.push(...checked.map((model) => ({ ...model, provider_id: batch.provider })))
        if (report.cut !== undefined) {
          ended = report.cut
          done += batch.models.length
          onProgress({ done, total })
          break
        }
      }
    }
    done += batch.models.length
    onProgress({ done, total })
  }
  if (ended === 'stopped') return finish(found.length > 0 ? 'partial' : 'stopped', 'Stopped before it finished.', found)
  if (ended === 'limit') return finish(found.length > 0 ? 'partial' : 'stopped', 'Ended at the 20-minute limit.', found)
  if (failures.length > 0) return finish(found.length > 0 ? 'partial' : 'failed', failures.join('; '), found)
  return finish('complete', undefined, found)
}
