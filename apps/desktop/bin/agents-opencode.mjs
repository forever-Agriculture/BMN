// MODULE: agents-opencode.mjs - Epic 70: the OpenCode folder BMN keeps for helper runs, its read-only agent, the one `opencode run` form the check reads, and Luna through OpenCode Go
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from './agents-roster.mjs'
import { stateDirectory } from './agents-state.mjs'

/**
 * An OpenCode helper run is checked only in the form Story 70.1 measured on OpenCode 2.0.29
 * (`plan/references/reference-70-opencode-helpers/RESULT.md`): `env -i` with a home,
 * configuration, data, state and cache folder of BMN's own, the project's own OpenCode configuration
 * switched off, and `opencode run --standalone --format json --agent bmn-helper -m <model#effort>
 * --title <title>` reading its prompt from standard input. BMN's configuration folder holds its own
 * files and nothing else, so no rules file, agent, skill, plugin or MCP server of the owner's is read,
 * and its agent denies every action but reading inside the project.
 */
export const OPENCODE_FORM_TESTED = { version: '2.0.32', on: '2026-10-23' }

/** The measured Linux binaries also load machine-wide sources, outside BMN's configuration folder. */
export function openCodeManagedProblem() {
  const path = '/etc/opencode'
  const problem = 'OpenCode managed configuration cannot be isolated for this BMN run'
  let before, fd
  try { before = lstatSync(path, { bigint: true }) }
  catch (error) { return error.code === 'ENOENT' ? null : problem }
  try {
    if (!before.isDirectory() || before.isSymbolicLink()) return problem
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const same = stat => stat.isDirectory() && ['dev', 'ino', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key])
    if (!same(fstatSync(fd, { bigint: true }))) return problem
    const stream = opendirSync(`/proc/self/fd/${fd}`)
    let occupied
    try { occupied = stream.readSync() !== null } finally { stream.closeSync() }
    return occupied || !same(fstatSync(fd, { bigint: true })) || !same(lstatSync(path, { bigint: true })) ? problem : null
  } catch { return problem }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** BMN's read-only agent, as `--agent` names it. */
export const OPENCODE_HELPER_AGENT = 'bmn-helper'

/** BMN's research agent (70.3): web search and nothing else. */
export const OPENCODE_RESEARCH_AGENT = 'bmn-researcher'

/**
 * The search service OpenCode's `websearch` tool asks. 70.1 showed TinyFish and Tavily answering
 * without an account; a run that names none turns its first search into a question, which a run
 * nobody watches cancels. The search text goes to that service, not to the model's provider.
 */
const OPENCODE_WEBSEARCH_PROVIDER = 'tinyfish'

/** An OpenCode session id (`ses_` and 26 characters), the one shape `roster bind` takes for an OpenCode receipt. */
export const OPENCODE_SESSION_ID = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/

/**
 * The agent 70.1 measured: every action denied, then reading inside the project allowed. With it
 * OpenCode offers only `read`, `glob` and `grep`, and refuses every other tool, a read outside the
 * project and a question, with and without `--auto`.
 */
const PROJECT_READ_PERMISSION = Object.freeze([
  { action: '*', resource: '*', effect: 'deny' },
  ...['bmn_read', 'bmn_glob', 'bmn_grep'].map(action => ({ action, resource: '*', effect: 'allow' }))
])
const ASK_READER_PERMISSION = Object.freeze([
  ...PROJECT_READ_PERMISSION,
  ...['bmn_git', 'websearch', 'bmn_subagent'].map(action => ({ action, resource: '*', effect: 'allow' }))
])
const agentText = (description, permissions, prompt) => `---
description: ${description}
mode: primary
permissions: ${JSON.stringify(permissions)}
---

${prompt}
`
const HELPER_AGENT_TEXT = agentText('BMN read-only helper', PROJECT_READ_PERMISSION,
  'You are a read-only helper started by BMN. Use the BMN project tools; you cannot change anything.')
const RESEARCH_AGENT_TEXT = agentText('BMN researcher', [
  { action: '*', resource: '*', effect: 'deny' }, { action: 'websearch', resource: '*', effect: 'allow' }
], 'You are a researcher started by BMN. Search the web and answer the request; you cannot read or change anything on this computer.')

/** BMN's agents for an asked teammate: the project reader with its read-only sub-agent, and the asker with every action denied (72.5). */
export const OPENCODE_ASK_AGENTS = Object.freeze({ reader: 'bmn-ask-reader', asker: 'bmn-ask-asker', subagent: 'bmn-reader' })

/**
 * The agents of one ask on OpenCode, given in OPENCODE_CONFIG_CONTENT so that BMN's OpenCode folder
 * (its OpenCode Go sign-in) is used as it is, its files unchanged (72.9 AC1): `reader` for a private
 * project ask, `asker` for any other. A private ask carries the owner's rules in the agent's prompt;
 * BMN's folder holds no rules file. Returns `{ agent, content }`.
 */
export function openCodeAskConfig(kind, rules = null) {
  const own = (text) => (rules === null ? text : `${text}\n\n${rules}`)
  const agent = kind === 'reader'
    ? {
        [OPENCODE_ASK_AGENTS.reader]: { description: 'BMN asked teammate, read-only', mode: 'primary', system: own('You are a read-only teammate asked by BMN. Use the BMN project tools for files, searches, Git history and your one bounded read-only child.'), permissions: ASK_READER_PERMISSION },
        [OPENCODE_ASK_AGENTS.subagent]: { description: 'BMN read-only sub-agent', mode: 'subagent', system: 'You are a read-only sub-agent started by BMN\'s teammate.', permissions: ASK_READER_PERMISSION.filter(rule => rule.action !== 'bmn_subagent') }
      }
    : { [OPENCODE_ASK_AGENTS.asker]: { description: 'BMN asked teammate, no tools', mode: 'primary', system: own('You are a teammate asked one question by BMN; you have no tools.'), permissions: [{ action: '*', resource: '*', effect: 'deny' }] } }
  return { agent: kind === 'reader' ? OPENCODE_ASK_AGENTS.reader : OPENCODE_ASK_AGENTS.asker, content: JSON.stringify({ agents: agent }) }
}

/**
 * OpenCode's own settings for the folder: no update, no sharing, no file snapshots, and the search
 * service for the research agent. It names no model or provider.
 */
const CONFIG_TEXT = `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', snapshot: false, websearch: { provider: OPENCODE_WEBSEARCH_PROVIDER }, plugins: ['./plugins/bmn-reader'] }, null, 2)}\n`

let configFiles

/**
 * One of the reader plugin's files, named by its place beside this module: there for the command line, in the packaged app's `bin` folder, or in
 * the app's `bin` folder beside its built files. The main process bundles this module without them beside it, and its
 * own tests plan from this folder's mark (Story 90.9: none started while reading beside the bundle threw).
 */
function pluginFile(beside) {
  const own = fileURLToPath(beside)
  const name = basename(own)
  const places = [own, ...(typeof process.resourcesPath === 'string' ? [join(process.resourcesPath, 'bin', name)] : []), join(dirname(own), '..', '..', 'bin', name)]
  return readFileSync(places.find((place) => existsSync(place)) ?? places[0], 'utf8')
}

/**
 * Every file of BMN's OpenCode configuration folder, by its path inside `config/opencode`. Read on
 * first use, from where `pluginFile` finds them.
 */
export function openCodeConfigFiles() {
  configFiles ??= Object.freeze({
    'opencode.json': CONFIG_TEXT,
    'plugins/bmn-reader/package.json': JSON.stringify({ name: 'bmn-read-only', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' } }) + '\n',
    'plugins/bmn-reader/index.mjs': pluginFile(new URL('./opencode-reader-plugin.mjs', import.meta.url)),
    'plugins/bmn-reader/opencode-project-reader.mjs': pluginFile(new URL('./opencode-project-reader.mjs', import.meta.url)),
    'plugins/bmn-reader/opencode-project-git.mjs': pluginFile(new URL('./opencode-project-git.mjs', import.meta.url)),
    'plugins/bmn-reader/opencode-reader-child.mjs': pluginFile(new URL('./opencode-reader-child.mjs', import.meta.url)),
    'plugins/bmn-reader/opencode-child-accounting.mjs': pluginFile(new URL('./opencode-child-accounting.mjs', import.meta.url)),
    'plugins/bmn-reader/ask-git.sh': pluginFile(new URL('./ask-git.sh', import.meta.url)),
    [`agents/${OPENCODE_HELPER_AGENT}.md`]: HELPER_AGENT_TEXT,
    [`agents/${OPENCODE_RESEARCH_AGENT}.md`]: RESEARCH_AGENT_TEXT
  })
  return configFiles
}

/** A mark of the agent's text, carried on a receipt. */
export const OPENCODE_HELPER_AGENT_SHA256 = sha256(HELPER_AGENT_TEXT)

/** A mark of the whole folder as BMN writes it: a fence test counts only for the research form it tested. */
export function openCodeFolderSha256() {
  return sha256(JSON.stringify(Object.entries(openCodeConfigFiles()).sort(([one], [other]) => one.localeCompare(other))))
}

/** Where BMN keeps the folder: under its own state, never in the owner's OpenCode folders. */
export function openCodeFolder() {
  return `${stateDirectory()}/opencode`
}

/** The five folders of a run, under `base`. */
export function openCodeFolders(base = openCodeFolder()) {
  return { home: `${base}/home`, config: `${base}/config`, data: `${base}/data`, state: `${base}/state`, cache: `${base}/cache` }
}

/**
 * What a run carries after `env -i`, besides PATH. OPENCODE_DISABLE_PROJECT_CONFIG is part of the
 * form: without it a repository's own opencode.json or .opencode folder replaces BMN's agent and the
 * address requests go to, and runs its own plugin (70.1, case h1). With OPENCODE_DISABLE_MODELS_FETCH
 * the run takes its models from the list built into OpenCode and does not fetch models.opencode.ai
 * first; that list holds OpenCode Go's models (probe of 70.2).
 */
export function openCodeEnvironment(base = openCodeFolder()) {
  const folders = openCodeFolders(base)
  return {
    HOME: folders.home, XDG_CONFIG_HOME: folders.config, XDG_DATA_HOME: folders.data, XDG_STATE_HOME: folders.state, XDG_CACHE_HOME: folders.cache,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1'
  }
}

/** The arguments of the form after `opencode`, model and title left to the lead. */
const OPENCODE_RUN_ARGV = ['run', '--standalone', '--format', 'json', '--agent', OPENCODE_HELPER_AGENT]

/** A research run's title: with one named, OpenCode makes no request of its own to name the session. */
const OPENCODE_RESEARCH_TITLE = 'BMN research'

/**
 * The one command a research run on OpenCode is (70.3): BMN's folder, the research agent, the
 * agent's model at `effort`, a title, the prompt on standard input.
 */
export function openCodeResearchArgv(agent, effort, { path = process.env.PATH ?? '', base = openCodeFolder() } = {}) {
  const model = agent.model.includes('/') ? agent.model : `${agent.provider}/${agent.model}`
  return ['/usr/bin/env', '-i', ...Object.entries(openCodeEnvironment(base)).map(([name, value]) => `${name}=${value}`), `PATH=${path}`,
    'opencode', 'run', '--standalone', '--format', 'json', '--agent', OPENCODE_RESEARCH_AGENT, '-m', `${model}#${effort}`, '--title', OPENCODE_RESEARCH_TITLE]
}

/**
 * The answer of a finished `opencode run --format json`: the last `text` event's words, or why
 * there is none (an `error` event, or no text at all).
 */
export function openCodeAnswer(stdout) {
  let text = null
  let error = null
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return { ok: false, reason: 'OpenCode printed a line that is not JSON' }
    }
    if (event?.type === 'text' && typeof event.part?.text === 'string') text = event.part.text
    if (event?.type === 'error') error = typeof event.error?.message === 'string' ? event.error.message : 'an error'
  }
  if (error !== null) return { ok: false, reason: `OpenCode reported an error: ${error.slice(0, 200)}` }
  return text === null ? { ok: false, reason: 'OpenCode printed no answer' } : { ok: true, text }
}

/**
 * The session a finished `opencode run --format json` ran in: the one id of OpenCode's shape its
 * events name, or null where none is named, the events name two, or a line is not JSON.
 */
export function openCodeSession(stdout) {
  const named = new Set()
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return null
    }
    if (event !== null && typeof event === 'object' && event.sessionID !== undefined) named.add(event.sessionID)
  }
  const [session] = named
  return named.size === 1 && typeof session === 'string' && OPENCODE_SESSION_ID.test(session) ? session : null
}

/**
 * What `bmn roster role --json` hands a lead for an OpenCode candidate: the environment and the
 * arguments, then `-m <model>#<effort> --title <title>` and the prompt on standard input.
 */
function openCodeItems(base = openCodeFolder()) {
  return {
    env: Object.entries(openCodeEnvironment(base)).map(([name, value]) => `${name}=${value}`),
    argv: [...OPENCODE_RUN_ARGV],
    then: ['-m', '<provider>/<model>#<effort>', '--title', '<title>'],
    stdin: 'the prompt file',
    agent_sha256: OPENCODE_HELPER_AGENT_SHA256,
    form_tested_on: OPENCODE_FORM_TESTED.version
  }
}

function writeWhole(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, path)
  if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} did not read back`)
}

/**
 * Makes BMN's folder what the form needs, leaving what is already right: the configuration files
 * written whole, anything else in the configuration folder removed, the home folder emptied, the
 * other folders made. OpenCode searches with ripgrep; where it already keeps a copy in the owner's
 * cache, the run's cache links to it, so a run does not fetch ripgrep from the web (70.1, c1n).
 * The sign-in is not touched here.
 */
export function installOpenCodeFolder(base = openCodeFolder(), { ownerCache = `${process.env.XDG_CACHE_HOME || `${homedir()}/.cache`}/opencode` } = {}) {
  const folders = openCodeFolders(base)
  for (const folder of Object.values(folders)) {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    chmodSync(folder, 0o700)
  }
  const configFolder = `${folders.config}/opencode`
  mkdirSync(configFolder, { recursive: true, mode: 0o700 })
  const wanted = new Set(Object.keys(openCodeConfigFiles()))
  for (const entry of listAll(folders.config)) {
    const inside = entry.path.slice(`${configFolder}/`.length)
    const keep = entry.path.startsWith(`${configFolder}/`) && (wanted.has(inside) || (entry.directory && [...wanted].some((file) => file.startsWith(`${inside}/`))))
    if (!keep && entry.path !== configFolder) rmSync(entry.path, { recursive: true, force: true })
  }
  for (const [name, text] of Object.entries(openCodeConfigFiles())) {
    const path = `${configFolder}/${name}`
    let current
    try {
      current = lstatSync(path).isFile() ? readFileSync(path, 'utf8') : null
    } catch {
      current = null
    }
    if (current !== text) {
      rmSync(path, { recursive: true, force: true })
      writeWhole(path, text)
    }
  }
  for (const name of readdirSync(folders.home)) rmSync(`${folders.home}/${name}`, { recursive: true, force: true })
  const ripgrep = `${ownerCache}/bin/rg`
  const link = `${folders.cache}/opencode/bin/rg`
  if (existsSync(ripgrep)) {
    let current
    try {
      current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : ''
    } catch {
      current = null
    }
    if (current !== ripgrep) {
      rmSync(link, { force: true, recursive: true })
      mkdirSync(dirname(link), { recursive: true, mode: 0o700 })
      symlinkSync(ripgrep, link)
    }
  }
  return { folder: base, ...openCodeItems(base) }
}

function listAll(folder) {
  const found = []
  const walk = (directory) => {
    let names
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const path = `${directory}/${name}`
      const stats = lstatSync(path)
      found.push({ path, directory: stats.isDirectory(), file: stats.isFile(), link: stats.isSymbolicLink() })
      if (stats.isDirectory()) walk(path)
    }
  }
  walk(folder)
  return found
}

/**
 * Why BMN's folder is not the one the form needs, or null: the configuration folder must hold exactly
 * BMN's files, byte for byte, as plain files (no link, nothing else at any depth), and the home folder
 * nothing. OpenCode writes into neither during a run (70.1, b8).
 */
export function openCodeFolderProblem(base = openCodeFolder()) {
  const folders = openCodeFolders(base)
  const configFolder = `${folders.config}/opencode`
  const wanted = Object.keys(openCodeConfigFiles())
  let entries
  try {
    if (!lstatSync(folders.config).isDirectory() || !lstatSync(folders.home).isDirectory()) return `BMN's OpenCode folder ${base} is not there`
    entries = listAll(folders.config)
  } catch {
    return `BMN's OpenCode folder ${base} is not there`
  }
  for (const entry of entries) {
    if (entry.link) return `${entry.path} is a link, and BMN's OpenCode folder holds none`
    if (entry.directory) continue
    const inside = entry.path.startsWith(`${configFolder}/`) ? entry.path.slice(`${configFolder}/`.length) : null
    if (inside === null || !wanted.includes(inside)) return `${entry.path} is not one of BMN's OpenCode files, and OpenCode would read it`
  }
  for (const name of wanted) {
    let text
    try {
      text = readFileSync(`${configFolder}/${name}`, 'utf8')
    } catch {
      return `${configFolder}/${name} is missing`
    }
    if (text !== openCodeConfigFiles()[name]) return `${configFolder}/${name} differs from BMN's text`
  }
  if (readdirSync(folders.home).length > 0) return `${folders.home} is not empty, and OpenCode would read what is there`
  return null
}

// ---------------------------------------------------------------------------------------------
// Luna through OpenCode Go (70.4): whether the installed OpenCode lists her, and the sign-in BMN's folder needs

/** OpenCode Go, the owner's plan, as OpenCode names the provider. */
export const OPENCODE_GO_PROVIDER = 'opencode-go'

/** The model BMN proposes as the first OpenCode agent (the owner's card "Luna via Go", 2026-10-14). */
export const LUNA_GO_MODEL = 'gpt-6-luna'

/** What a listing names in place of a key: OpenCode lists a provider's models only once a key for it is named, and this one is sent nowhere. */
const LISTING_KEY = 'bmn-listing-only-not-a-key'

/** A closed port on this computer, as the proxy of a listing: whatever OpenCode tried to fetch would reach nothing. */
const NOWHERE = 'http://127.0.0.1:9'

/** The most of OpenCode's output BMN reads from one of these commands. */
const OUTPUT_LIMIT = 4 * 1024 * 1024

/**
 * Runs `opencode <args>` with exactly `env`, `input` on standard input, and reads standard output
 * only. Standard error is never read: nothing OpenCode prints there reaches a message. Resolves to
 * `{ missing: true }` where no opencode is on the PATH, otherwise `{ status, signal, stdout }`.
 */
function runOpenCode(args, { env, cwd, input = '', timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const chunks = []
    let size = 0
    let child
    try {
      child = spawn('opencode', args, { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      settle({ missing: true })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > OUTPUT_LIMIT) child.kill('SIGKILL')
      else chunks.push(chunk)
    })
    child.on('error', (error) => settle(error.code === 'ENOENT' ? { missing: true } : { status: null, signal: null, stdout: '' }))
    child.on('close', (status, signal) => settle({ status, signal, stdout: size > OUTPUT_LIMIT ? '' : Buffer.concat(chunks).toString('utf8') }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

const ended = (result) => (result.signal ? `was stopped (${result.signal})` : `ended with ${result.status}`)

/**
 * Whether the installed OpenCode lists `opencode-go/gpt-6-luna` among OpenCode Go's models (70.4
 * AC1). OpenCode lists a provider's models only where a key for it is named, and `opencode models`
 * run in the owner's own folders loads his plugins and starts his MCP servers (70.4 probe), so BMN
 * asks in an empty folder of its own: a key that is not one, the model list built into OpenCode, every
 * request sent to a closed port. Nothing of his is read, and the folder is removed after.
 */
export async function openCodeListsLuna({ environment = process.env, timeoutMs = 30_000 } = {}) {
  const base = mkdtempSync(`${tmpdir()}/bmn-opencode-list-`)
  try {
    const folders = openCodeFolders(base)
    for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true, mode: 0o700 })
    const env = {
      ...openCodeEnvironment(base), PATH: environment.PATH ?? '', HTTPS_PROXY: NOWHERE, HTTP_PROXY: NOWHERE, NO_PROXY: '127.0.0.1,localhost',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [OPENCODE_GO_PROVIDER]: { options: { apiKey: LISTING_KEY } } } })
    }
    const result = await runOpenCode(['models', '--standalone'], { env, cwd: folders.home, timeoutMs })
    if (result.missing) return { listed: false, reason: 'OpenCode is not on this computer' }
    if (result.status !== 0) return { listed: false, reason: `opencode models ${ended(result)}` }
    return { listed: result.stdout.split('\n').some((line) => line.trim() === `${OPENCODE_GO_PROVIDER}/${LUNA_GO_MODEL}`) }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

/**
 * The OpenCode Go sign-ins among what `opencode auth export` printed, or null where that is not the
 * list OpenCode 2.0.29 writes (`[{id, integrationID, label, active, value: {type, key}}]`, 70.4 probe).
 * Nothing else of it is kept.
 */
function goSignIns(stdout) {
  let entries
  try {
    entries = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  return entries.filter((entry) => entry !== null && typeof entry === 'object' && entry.integrationID === OPENCODE_GO_PROVIDER && entry.active !== false
    && entry.value?.type === 'key' && typeof entry.value.key === 'string' && entry.value.key !== '')
}

/** BMN's folder's own environment, for OpenCode's sign-in commands there. */
function folderEnvironment(base, environment) {
  return { ...openCodeEnvironment(base), PATH: environment.PATH ?? '' }
}

/**
 * Whether BMN's folder holds an OpenCode Go sign-in, as OpenCode itself says it there. `signedIn` is
 * null where OpenCode could not be asked; the folder is not made by asking.
 */
export async function openCodeGoSignedIn({ environment = process.env, base = openCodeFolder(), timeoutMs = 30_000 } = {}) {
  const folders = openCodeFolders(base)
  if (!existsSync(folders.home) || !existsSync(folders.data)) return { signedIn: false }
  const result = await runOpenCode(['auth', 'export', '--standalone'], { env: folderEnvironment(base, environment), cwd: folders.home, timeoutMs })
  if (result.missing) return { signedIn: null, reason: 'OpenCode is not on this computer' }
  if (result.status !== 0) return { signedIn: null, reason: `opencode auth export ${ended(result)} in BMN's OpenCode folder` }
  const go = goSignIns(result.stdout)
  if (go === null) return { signedIn: null, reason: 'OpenCode printed its sign-ins in a form BMN does not read' }
  return { signedIn: go.length > 0 }
}

/**
 * The owner's own OpenCode, for `auth export`: his home and data folders as his environment names
 * them, the project's configuration switched off, no update and no model list fetched.
 */
function ownerEnvironment(environment) {
  const kept = { HOME: environment.HOME || homedir(), PATH: environment.PATH ?? '' }
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    if (typeof environment[name] === 'string' && environment[name].startsWith('/')) kept[name] = environment[name]
  }
  return { ...kept, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' }
}

/** The judge's one key, chosen from OpenCode 2's export; no other sign-in escapes this call. */
export async function openCodeJudgeKey({ environment = process.env, timeoutMs = 5000 } = {}) {
  const env = ownerEnvironment(environment)
  if (typeof environment.OPENCODE_DB === 'string') env.OPENCODE_DB = environment.OPENCODE_DB
  const result = await runOpenCode(['auth', 'export', '--standalone'], {
    env, cwd: environment.HOME || homedir(), timeoutMs
  })
  if (result.missing || result.status !== 0) return { reason: 'OpenCode could not export its sign-ins on this computer' }
  let entries
  try {
    entries = JSON.parse(result.stdout)
  } catch {
    return { reason: 'OpenCode exported its sign-ins in a form BMN does not read' }
  }
  if (!Array.isArray(entries) || entries.some((entry) => entry === null || typeof entry !== 'object' ||
    typeof entry.integrationID !== 'string' || typeof entry.active !== 'boolean' ||
    entry.value === null || typeof entry.value !== 'object' || typeof entry.value.type !== 'string')) {
    return { reason: 'OpenCode exported its sign-ins in a form BMN does not read' }
  }
  for (const integration of ['opencode-go', 'opencode']) {
    const matches = entries.filter((entry) => entry.integrationID === integration && entry.active === true && entry.value.type === 'key')
    if (matches.length === 0) continue
    if (matches.length !== 1) return { reason: 'OpenCode holds more than one active API-key sign-in for the judge\'s integration' }
    const key = matches[0].value.key
    if (typeof key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(key)) return { reason: 'OpenCode exported its sign-ins in a form BMN does not read' }
    return { key }
  }
  return { reason: 'OpenCode holds no active API-key sign-in for its Go or OpenCode integration' }
}

/**
 * Copies the owner's OpenCode Go sign-in into BMN's folder, once (70.4; his card of 2026-10-14: when
 * he approves Luna (Go), BMN copies his Go key into its own folder with OpenCode's `auth export` and
 * `auth import`). `auth export` run in his folders prints every sign-in he holds; BMN keeps only
 * OpenCode Go's, in memory, and hands it to `auth import` in its folder on standard input. Nothing
 * OpenCode prints is written, logged or said. Unlike `models` and `auth list`, `auth export` loads no
 * plugin and starts no MCP server of his (70.4 probe). Where the folder already holds a Go sign-in,
 * nothing is copied.
 */
export async function copyOpenCodeGoSignIn({ environment = process.env, base = openCodeFolder(), timeoutMs = 30_000 } = {}) {
  installOpenCodeFolder(base)
  const before = await openCodeGoSignedIn({ environment, base, timeoutMs })
  if (before.signedIn === true) return { ok: true, copied: false, message: 'BMN\'s OpenCode folder already holds your OpenCode Go sign-in' }
  if (before.signedIn === null) return { ok: false, copied: false, message: `${before.reason}, so nothing was copied` }
  const folders = openCodeFolders(base)
  const exported = await runOpenCode(['auth', 'export', '--standalone'], { env: ownerEnvironment(environment), cwd: folders.home, timeoutMs })
  if (exported.missing) return { ok: false, copied: false, message: 'OpenCode is not on this computer, so nothing was copied' }
  if (exported.status !== 0) return { ok: false, copied: false, message: `OpenCode could not list your sign-ins (opencode auth export ${ended(exported)}), so nothing was copied` }
  const go = goSignIns(exported.stdout)
  if (go === null) return { ok: false, copied: false, message: 'OpenCode printed your sign-ins in a form BMN does not read, so nothing was copied' }
  if (go.length === 0) return { ok: false, copied: false, message: 'OpenCode holds no OpenCode Go sign-in on this computer: sign in with `opencode auth login`, then copy it again' }
  const imported = await runOpenCode(['auth', 'import', '--standalone'], { env: folderEnvironment(base, environment), cwd: folders.home, input: JSON.stringify(go), timeoutMs })
  if (imported.missing || imported.status !== 0) return { ok: false, copied: false, message: `OpenCode did not take the sign-in into BMN's folder (opencode auth import ${imported.missing ? 'was not found' : ended(imported)})` }
  const after = await openCodeGoSignedIn({ environment, base, timeoutMs })
  if (after.signedIn !== true) return { ok: false, copied: false, message: 'BMN\'s OpenCode folder holds no OpenCode Go sign-in after the copy' }
  return { ok: true, copied: true, message: 'BMN copied your OpenCode Go sign-in into its own OpenCode folder' }
}

// ---------------------------------------------------------------------------------------------
// A teammate's ask on OpenCode (72.5, 72.9): its sessions' own records, read after the run

function runSync(launcher, args, { env, cwd, input = '', timeoutMs = 30_000, limit = OUTPUT_LIMIT }) {
  const result = spawnSync(launcher, args, { env, cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs, maxBuffer: limit })
  if (result.error?.code === 'ENOENT') return { missing: true }
  return { status: result.status, signal: result.signal, stdout: result.error ? '' : result.stdout ?? '' }
}

/**
 * What OpenCode recorded of one of an ask's sessions (70.4): `opencode session export <id>
 * --standalone` in BMN's folder, of which only the session's info is kept: its id, its parent session
 * (a sub-agent's), agent, model and variant, tokens and reported spend, never its messages. `{ info }`
 * or `{ failed }`.
 */
export function openCodeSessionInfo(session, runBase = openCodeFolder(), { launcher = 'opencode', environment = process.env, timeoutMs = 30_000 } = {}) {
  if (!OPENCODE_SESSION_ID.test(session ?? '')) return { failed: 'the run named no OpenCode session' }
  const result = runSync(launcher, ['session', 'export', session, '--standalone'], { env: folderEnvironment(runBase, environment), cwd: openCodeFolders(runBase).home, timeoutMs, limit: 64 * 1024 * 1024 })
  if (result.missing) return { failed: 'OpenCode is not on this computer' }
  if (result.status !== 0) return { failed: `opencode session export ${ended(result)}` }
  let info
  try {
    info = JSON.parse(result.stdout)?.info
  } catch {
    return { failed: 'opencode session export printed what BMN does not read' }
  }
  if (info === null || typeof info !== 'object' || info.id !== session) return { failed: 'opencode session export named another session' }
  const number = (value) => (Number.isFinite(value) ? value : 'unknown')
  return {
    info: {
      id: info.id, parent: typeof info.parentID === 'string' ? info.parentID : null, agent: typeof info.agent === 'string' ? info.agent : null,
      model: { id: info.model?.id ?? null, provider: info.model?.providerID ?? null, variant: info.model?.variant ?? null },
      tokens: { input: number(info.tokens?.input), output: number(info.tokens?.output), reasoning: number(info.tokens?.reasoning), cache_read: number(info.tokens?.cache?.read), cache_write: number(info.tokens?.cache?.write) },
      // OpenCode's own name for what the session spent; BMN keeps it as the reported cost.
      reported_cost: number(info.cost)
    }
  }
}

/** Recover actual children through the native paginated API, never the top-level-only session list. */
export function openCodeChildSessions(session, runBase = openCodeFolder(), { launcher = 'opencode', environment = process.env, timeoutMs = 5000 } = {}) {
  if (!OPENCODE_SESSION_ID.test(session ?? '')) return { children: [], complete: false, reason: 'the parent identity is unavailable' }
  const deadline = Date.now() + timeoutMs, found = new Set(), cursors = new Set()
  let cursor
  for (let page = 0; page < 100 && Date.now() < deadline; page++) {
    const args = ['api', '--standalone', 'session.list', '--param', `parentID=${session}`, '--param', 'limit=100']
    if (cursor) args.push('--param', `cursor=${cursor}`)
    const result = runSync(launcher, args, { env: folderEnvironment(runBase, environment), cwd: openCodeFolders(runBase).home, timeoutMs: Math.max(1, deadline - Date.now()), limit: 1024 * 1024 })
    let value
    try { value = result.status === 0 ? JSON.parse(result.stdout) : null } catch { value = null }
    if (!Array.isArray(value?.data) || typeof value.cursor !== 'object' || value.cursor === null) break
    for (const child of value.data) {
      if (!OPENCODE_SESSION_ID.test(child?.id ?? '') || child.parentID !== session) return { children: [...found], complete: false, reason: 'native child enumeration returned invalid linkage' }
      found.add(child.id)
    }
    cursor = value.cursor.next
    if (cursor === undefined || cursor === null) return { children: [...found], complete: true }
    if (typeof cursor !== 'string' || cursors.has(cursor)) break
    cursors.add(cursor)
  }
  return { children: [...found], complete: false, reason: 'native child enumeration was incomplete' }
}
