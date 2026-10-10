// MODULE: agents-research.mjs - Story 60.10, first release: BMN writes the research prompt, runs one checked run per provider, accepts only a typed answer, reads each cited page itself and keeps what was found
import { spawn } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { APP_NAMES, EFFORTS, agentState } from './agents-roster.mjs'
import { readApproved, stateDirectory } from './agents-state.mjs'
import { CODEX_RESEARCH_ANSWER, CODEX_RESEARCH_CONFIG, RESEARCH_TOOLS, evaluateResearch, harnessVersion, prepareResearchRun } from './agents-check.mjs'
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

/** The agent apps that have a research form the check admits. */
export const RESEARCH_APPS = ['claude', 'codex']
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
 * "could this agent research at all".
 */
export function researchArgv(agent, { environment = process.env, run = null, version = null, contextTests = undefined } = {}) {
  const effort = researchEffort(agent)
  const proven = agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(agent.harness, version, contextTests)
  const context = contextItems(agent, proven)
  const head = ['/usr/bin/env', '-i', `HOME=${environment.HOME ?? ''}`, `PATH=${environment.PATH ?? ''}`]
  if (agent.harness === 'codex') {
    return [...head, 'codex', 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
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
function whyNot(agent, code) {
  const app = APP_NAMES[agent.harness] ?? agent.harness
  if (code === 'PACKET_INVALID') return 'its provider gets public work only'
  if (code === 'CONTEXT_MISMATCH') return 'its context limit is not supported yet'
  if (code === 'HARNESS_UNKNOWN') return `${app} was not found`
  return `BMN cannot check ${app}'s research command`
}

/**
 * The approved, active agents and whether each could research now: the same check a run must
 * pass, without a folder or a prompt. `reason` says why not, in the check's own words.
 */
export function researchers({ environment = process.env, now = new Date() } = {}) {
  let generation
  try {
    generation = readApproved()
  } catch {
    return []
  }
  const found = []
  for (const agent of generation.data.agents) {
    if (agentState(agent) !== 'active') continue
    if (!RESEARCH_APPS.includes(agent.harness)) {
      found.push({ id: agent.id, name: agent.name, harness: agent.harness, ok: false, why: `its app is ${APP_NAMES[agent.harness] ?? agent.harness}`, reason: `${APP_NAMES[agent.harness] ?? agent.harness} has no research form BMN can check` })
      continue
    }
    let result
    try {
      result = evaluateResearch({ agent: agent.id, argv: researchArgv(agent, { environment, version: appVersion(agent, environment) }), dry: true }, { environment, cwd: environment.HOME ?? '/', now })
    } catch (error) {
      result = { verdict: 'REFUSED', message: error instanceof Error ? error.message : String(error) }
    }
    found.push({ id: agent.id, name: agent.name, harness: agent.harness, ok: result.verdict === 'PASS', ...(result.verdict === 'PASS' ? {} : { why: whyNot(agent, result.code), reason: result.message }) })
  }
  return found
}

/** The researcher the owner last picked, or null. */
export function chosenResearcher() {
  try {
    const value = JSON.parse(readFileSync(researchSettingsPath(), 'utf8'))
    return typeof value?.researcher === 'string' ? value.researcher : null
  } catch {
    return null
  }
}

export function chooseResearcher(id) {
  writePrivate(researchSettingsPath(), `${JSON.stringify({ version: 1, researcher: id })}\n`)
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

/** One GET to an address BMN already checked: the name is resolved once, so the answer cannot move between the check and the read. */
function getOnce(url, { address, family }, { timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer)
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
    call.end()
  })
}

/**
 * Reads one cited page the way anyone could: https only, the default port, no sign-in in the
 * address, no cookies, at most three redirects each checked the same way, ten seconds and two
 * megabytes in all. A name that resolves to this machine or a private network is never asked.
 * `selfTestPages` serves names under `.test` from a folder; such a name can never be a real site.
 */
export async function fetchPublicPage(address, { timeoutMs = 10_000, maxBytes = 2 * 1024 * 1024, redirects = 3, resolve = resolveHost, transport = getOnce, selfTestPages = null } = {}) {
  const deadline = Date.now() + timeoutMs
  let current = address
  for (let hop = 0; hop <= redirects; hop += 1) {
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
      addresses = await resolve(host)
    } catch {
      return { ok: false, reason: 'the site could not be found' }
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) return { ok: false, reason: 'not a public address' }
    const left = deadline - Date.now()
    if (left <= 0) return { ok: false, reason: 'the page did not answer in time' }
    const answer = await transport(url, addresses[0], { timeoutMs: left, maxBytes })
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

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function dollars(value) {
  const [whole, fraction = ''] = String(value).split('.')
  const digits = fraction.replace(/0+$/, '')
  return new RegExp(`\\$\\s?${escape(whole)}${digits === '' ? '(?:\\.0+)?' : `\\.${digits}0*`}(?!\\d)(?![.,]\\d)`)
}

const PER_MILLION = /(?:\/|per)\s*(?:1\s*)?(?:m\b|mtok|million)|1m tokens|million tokens/i

/**
 * Whether the page shows this price beside this model: the input and the output amount, in
 * dollars, in the stretch after one of the model's names, with the page saying the unit is a
 * million tokens. A number that stands beside another model, or without the unit, proves nothing.
 */
export function priceShown(text, names, others, price) {
  if (!PER_MILLION.test(text)) return { shown: false, why: 'the page does not say the price is per million tokens' }
  const places = stretches(text, names, others)
  if (places.length === 0) return { shown: false, why: 'the page does not name this model' }
  const hit = places.find((place) => dollars(price.input).test(place) && dollars(price.output).test(place))
  if (hit === undefined) return { shown: false, why: 'the page does not show this price beside the model' }
  return { shown: true, cached: price.cached_input === undefined ? undefined : dollars(price.cached_input).test(hit) }
}

function tokenForms(tokens) {
  const forms = [String(tokens), tokens.toLocaleString('en-US'), tokens.toLocaleString('en-US').replace(/,/g, ' ')]
  if (tokens % 1_000_000 === 0) forms.push(`${tokens / 1_000_000}M`, `${tokens / 1_000_000} million`)
  else if (tokens % 100_000 === 0) forms.push(`${tokens / 1_000_000}M`)
  if (tokens % 1000 === 0) forms.push(`${tokens / 1000}K`)
  return forms
}

/** Whether the page shows this context window beside this model, in a stretch that speaks of context or tokens. */
export function windowShown(text, names, others, tokens) {
  const places = stretches(text, names, others)
  if (places.length === 0) return { shown: false, why: 'the page does not name this model' }
  const pattern = new RegExp(`(?<![\\d.,])(?:${tokenForms(tokens).map(escape).join('|')})(?![\\d])`, 'i')
  const hit = places.some((place) => pattern.test(place) && /context|tokens/i.test(place))
  return hit ? { shown: true } : { shown: false, why: 'the page does not show this context window beside the model' }
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

/**
 * Reads each cited page once and marks every value: verified when BMN's own read shows it beside
 * the model, else unverified with the reason. A cached-input price the page does not show is dropped.
 */
export async function verifyModels(models, sites, { fetchPage = fetchPublicPage } = {}) {
  const pages = new Map()
  const read = async (address) => {
    if (!pages.has(address)) {
      if (pages.size >= MAX_PAGES) return { ok: false, reason: 'the answer cites more pages than BMN reads for one run' }
      const page = await fetchPage(address)
      pages.set(address, page.ok ? { ok: true, text: pageText(page.text) } : page)
    }
    return pages.get(address)
  }
  const allNames = models.flatMap((model) => [model.id, ...(model.published_name ? [model.published_name] : [])])
  const checked = []
  for (const model of models) {
    const names = [model.id, ...(model.published_name ? [model.published_name] : [])]
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
 */
export async function runResearch({
  researcher, only = null, environment = process.env, now = () => new Date(), signal = undefined, onProgress = () => {},
  fetchPage = fetchPublicPage, limitMs = RESEARCH_LIMIT_MS, contextTests = undefined
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
  onProgress({ done, total })
  for (const batch of batches) {
    if (signal?.aborted) ended = 'stopped'
    else if (Date.now() >= deadline) ended = 'limit'
    if (ended !== null) break
    const prompt = researchPrompt(batch)
    const run = prepareResearchRun(prompt, { now: now() })
    const argv = researchArgv(agent, { environment, run, version: appVersion(agent, environment), contextTests })
    const verdict = evaluateResearch({ agent: agent.id, argv, stdin: run.prompt, cwd: run.cwd }, { environment, cwd: run.cwd, now: now(), ...(contextTests === undefined ? {} : { contextTestLog: contextTests }) })
    if (verdict.verdict !== 'PASS') {
      // The same refusal would meet every later run: nothing more is started.
      failures.push(`BMN did not start the run: ${verdict.message}`)
      ended = 'refused'
      break
    }
    writePrivate(`${run.folder}/receipt.json`, `${JSON.stringify(verdict.receipt)}\n`)
    const result = await runOnce(argv, run, { signal, deadline })
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
        const checked = await verifyModels(answer.models, batch.sites, { fetchPage })
        found.push(...checked.map((model) => ({ ...model, provider_id: batch.provider })))
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
