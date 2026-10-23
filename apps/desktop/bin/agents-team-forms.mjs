// MODULE: agents-team-forms.mjs - Epic 72: each app's own read-only command for an ask, as Story 72.9 measured it: Codex's sandbox, Claude Code's tool permissions and OpenCode's agent permissions, each with every tool its mode keeps read-only
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OPENCODE_FORM_TESTED, openCodeAskConfig, openCodeEnvironment, openCodeFolder } from './agents-opencode.mjs'
import { BROWSER_SERVER, browserServer, browserTools } from './agents-team-browser.mjs'
import { realOrNull } from './shared-helpers.mjs'

/**
 * A teammate's ask runs its app in that app's own read-only mode, with all the tools the mode keeps
 * read-only (R72-NFR2): the command dev-auto builds by hand for a helper, checked and launched by BMN.
 * Each form was measured in 72.9 against a stand-in provider, the parent and a forced sub-agent trying
 * every write (`reference-72-team-ask/RESULT-v8.md`). The app runs as the owner's user with its own
 * home, sign-in and session records; BMN adds no container, copy or sign-in of its own (R72-NFR3).
 * An app version BMN has not checked still runs, and its record names that version (R72-FR8, NFR10).
 */

/** The apps whose teammates BMN asks. */
export const ASK_APPS = Object.freeze(['codex', 'claude', 'opencode'])

/** The app version each form was last checked on with 72.9's measurement script, and when (R72-FR8). Never a gate. */
export const ASK_FORMS_CHECKED = Object.freeze({
  codex: { version: '0.162.1', on: '2026-10-15' },
  claude: { version: '2.1.300', on: '2026-10-15' },
  opencode: OPENCODE_FORM_TESTED
})

/** What an app's form does not offer, and why, in the words a refusal gives (R72-NFR12). */
export const ASK_UNSUPPORTED = Object.freeze({
  opencode: {
    pictures: 'BMN never measured a picture ask on OpenCode (72.1 measured Codex and Claude Code), so OpenCode teammates are not asked about pictures; ask a Codex or Claude Code teammate',
    browser: 'BMN adds a browser only to Codex and Claude Code (74.3), so OpenCode teammates do not check apps in a browser; ask a Codex or Claude Code teammate'
  }
})

/** The parts of one ask's folder under BMN's state (`team/runs/<id>/`), as the contract's record table names them. */
export const ASK_RUN_FILES = Object.freeze({
  request: 'request.json', manifest: 'inputs/manifest.json', prompt: 'inputs/prompt.md', rules: 'inputs/rules.md', files: 'inputs/files',
  pictures: 'inputs/pictures', message: 'inputs/message.jsonl', inputs: 'inputs',
  snapshots: 'snapshots', receipt: 'receipt.json', answer: 'answer.md', outcome: 'outcome.json', question: 'question.md',
  // The empty folder a teammate works in when the ask names no project, BMN's git for the forms that read history, Codex's last message.
  work: 'work', bin: 'bin', codexAnswer: 'codex-answer.md', projectStart: 'project-start.json',
  // A browser ask's server folder (its screenshots, once finished) and BMN's record of it (74.3).
  browser: 'browser', browserRecord: 'browser.json'
})

/**
 * What each form's own mode can read, as 72.9 AC1 recorded it: the record, `bmn team asks show` and
 * Agents › Asks say it, and consent is judged for it (R72-NFR6): `computer` reads any file the owner's
 * user can read, `folder` only its working folder, `text` nothing beyond the asker's text.
 */
export const ASK_READS = Object.freeze({
  'codex-read-only': { scope: 'computer', reach: 'any file your user can read', words: 'Codex\'s read-only sandbox: any file your user can read, with its shell, Git, web search and sub-agents; it writes nothing' },
  'claude-read-tools': { scope: 'folder', reach: 'its working folder', words: 'Claude Code with --restricted: its working folder only, with Read, Grep, Glob, Git history through BMN\'s git, web search and sub-agents; it writes nothing' },
  'opencode-reader': { scope: 'folder', reach: 'the project folder', words: 'OpenCode with BMN\'s read-only broker: the project folder only, with read, glob, grep, bounded Git history, web search and one read-only sub-agent; it writes nothing' },
  'opencode-asker': { scope: 'text', reach: 'nothing beyond your text', words: 'only your question and the files\' text: OpenCode with every action denied' }
})

/** An ask's OpenCode session title: with one named, OpenCode makes no request of its own to name the session (70.3). */
const OPENCODE_ASK_TITLE = 'BMN ask'

/** Codex logs the turn span that names each thread's model and effort only at this level; the log holds no prompt or answer text (72.1 AC2). */
const CODEX_ASK_LOG = 'codex_core=info,codex_core::stream_events_utils=debug'

/** Claude Code's read tools, web search and sub-agents; Bash only for Git's four read commands, through BMN's git first on PATH (72.9 AC1). A browser ask replaces the empty MCP configuration and allows its browser tools (74.3). */
export const CLAUDE_ASK_TOOLS = Object.freeze(['--restricted', '--tools', 'Read,Grep,Glob,Bash,WebSearch,Agent',
  '--allowedTools', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)', 'WebSearch', 'Agent',
  '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--output-format', 'stream-json', '--verbose'])

/** PATH without BMN's own wrappers, so the app found is the one the owner installed. */
export function appSearchPath(environment = process.env) {
  return (environment.PATH ?? '').split(':').filter((entry) => entry !== '' && !entry.includes('/resources/bin') && !entry.endsWith('/apps/desktop/bin')).join(':')
}

function onPath(name, path) {
  for (const folder of path.split(':')) {
    if (folder === '') continue
    const candidate = `${folder}/${name}`
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The installed program of an app, from the owner's PATH (BMN's own folders left out): the launcher
 * an ask runs and, for Codex's npm launcher, the native payload it starts. Returns `{ launcher, payload }` or null.
 */
export function askProgram(harness, environment = process.env) {
  const name = harness === 'claude' ? 'claude' : harness === 'opencode' ? 'opencode' : 'codex'
  const launcher = onPath(name, appSearchPath(environment))
  if (launcher === null) return null
  const real = realOrNull(launcher)
  if (real === null) return null
  if (harness === 'codex' && real.endsWith('/bin/codex.js')) {
    const payload = `${dirname(dirname(real))}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
    return existsSync(payload) ? { launcher, payload } : null
  }
  return { launcher, payload: real }
}

/**
 * The name of the form an ask gets: the app's one form, and OpenCode's asker where it may read nothing but the
 * asker's text: a public ask, an ask with no project, and a private ask to a teammate whose provider takes public
 * work only (`textOnly`). Those providers still get the text-only form; the project reader uses BMN's
 * confined broker rather than OpenCode's native filesystem tools.
 */
export function askFormName(harness, { project, label, textOnly = false }) {
  if (harness === 'codex') return 'codex-read-only'
  if (harness === 'claude') return 'claude-read-tools'
  return project !== null && label === 'private' && !textOnly ? 'opencode-reader' : 'opencode-asker'
}

const pairs = (environment) => Object.entries(environment).map(([name, value]) => `${name}=${value}`)

/** Codex's MCP configuration for an ask: none, or the browser's server with only its tools enabled and approved (74.3 AC1). */
function codexServers(browser, folder) {
  if (browser === null || browser === undefined) return 'mcp_servers={}'
  const server = browserServer(browser, folder)
  const list = (items) => `[${items.map((item) => JSON.stringify(item)).join(',')}]`
  return `mcp_servers={${BROWSER_SERVER}={command=${JSON.stringify(server.command)},args=${list(server.args)},enabled_tools=${list(browserTools(browser.interact))},default_tools_approval_mode="approve",startup_timeout_sec=60,tool_timeout_sec=240}}`
}

/** Claude Code's tool permissions for an ask: its read tools, and for a browser ask the browser's server and its tools by their MCP names (74.3 AC1). */
function claudeTools(browser, folder) {
  if (browser === null || browser === undefined) return [...CLAUDE_ASK_TOOLS]
  const tools = [...CLAUDE_ASK_TOOLS]
  tools[tools.indexOf('--mcp-config') + 1] = JSON.stringify({ mcpServers: { [BROWSER_SERVER]: browserServer(browser, folder) } })
  tools.splice(tools.indexOf('--permission-mode'), 0, ...browserTools(browser.interact).map((tool) => `mcp__${BROWSER_SERVER}__${tool}`))
  return tools
}

/**
 * The command of one ask: `env -i` with the app's environment, then the app in its form. `request`:
 * `{ form, model, provider, effort, cwd, folder, pictures, rules, context, environment, browser }`: `cwd` the
 * project or the run's empty work folder, `folder` the run's folder, `pictures` their paths in it,
 * `rules` the owner's rules for an OpenCode private ask (Codex and Claude Code read their own),
 * `environment` the asker's, for HOME, PATH and the apps' own home folders, `browser` a browser ask's
 * `{ origin, interact }` or null. Returns
 * `{ argv, environment, cwd, stdin }`; `stdin` is `text` (the prompt) or `stream-json` (Claude
 * Code's one user message with the pictures).
 */
export function askCommand(harness, program, request) {
  const asker = request.environment ?? process.env
  const home = asker.HOME ?? ''
  const path = appSearchPath(asker)
  // The agent's context limit, where the owner's test proved the setting on this app version (60.9): `-c` items for Codex, environment for Claude Code.
  const context = request.context ?? { argv: [], env: [] }
  const contextEnvironment = Object.fromEntries(context.env.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
  const pictures = request.pictures ?? []
  let environment
  let command
  let stdin = 'text'
  if (harness === 'codex') {
    // dev-auto's command (models.md:154-160), without --ephemeral, in the owner's own Codex home.
    environment = { HOME: home, PATH: path, RUST_LOG: CODEX_ASK_LOG, ...(asker.CODEX_HOME ? { CODEX_HOME: asker.CODEX_HOME } : {}) }
    command = [program.launcher, 'exec', '--skip-git-repo-check', '-C', request.cwd, '-m', request.model, '-c', `model_reasoning_effort=${request.effort}`,
      '-c', codexServers(request.browser, request.folder), '-c', 'approval_policy="never"', '--sandbox', 'read-only', ...pictures.flatMap((picture) => ['-i', picture]), ...context.argv,
      '--json', '-o', join(request.folder, ASK_RUN_FILES.codexAnswer), '-']
  } else if (harness === 'claude') {
    environment = { HOME: home, PATH: `${join(request.folder, ASK_RUN_FILES.bin)}:${path}`, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(asker.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: asker.CLAUDE_CONFIG_DIR } : {}), ...contextEnvironment }
    command = [program.launcher, '-p', '--model', request.model, '--effort', request.effort, ...claudeTools(request.browser, request.folder), ...(pictures.length > 0 ? ['--input-format', 'stream-json'] : [])]
    if (pictures.length > 0) stdin = 'stream-json'
  } else if (harness === 'opencode') {
    if (request.browser) throw new Error(ASK_UNSUPPORTED.opencode.browser)
    // BMN's own OpenCode folder (its OpenCode Go sign-in), the form's agents given inline: the folder's files stay as they are.
    const reader = request.form === 'opencode-reader'
    const own = openCodeAskConfig(reader ? 'reader' : 'asker', request.rules ?? null)
    environment = { ...openCodeEnvironment(openCodeFolder()), PATH: reader ? `${join(request.folder, ASK_RUN_FILES.bin)}:${path}` : path, OPENCODE_CONFIG_CONTENT: own.content }
    const reference = request.model.includes('/') ? request.model : `${request.provider}/${request.model}`
    command = [program.launcher, 'run', '--standalone', '--format', 'json', '--agent', own.agent, '-m', `${reference}#${request.effort}`, '--title', OPENCODE_ASK_TITLE]
  } else {
    throw new Error(`no ask form for ${harness}`)
  }
  return { argv: ['/usr/bin/env', '-i', ...pairs(environment), ...command], environment, command, cwd: request.cwd, stdin }
}

/** One file of an app's program as it is now: its hash and what tells a replaced or changed file (72.3 AC1). */
function programFile(path) {
  const real = realpathSync(path)
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const handle = openSync(real, 'r')
  try {
    for (let read = readSync(handle, buffer); read > 0; read = readSync(handle, buffer)) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(handle)
  }
  return { path, real, sha256: hash.digest('hex'), ...programStat(path) }
}

/** What changes when a file is replaced or written: its device, inode, size and times, through any link to it. */
function programStat(path) {
  const link = lstatSync(path, { bigint: true })
  const stat = statSync(path, { bigint: true })
  return {
    real: realpathSync(path), link: link.isSymbolicLink() ? String(link.ino) : null,
    dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs)
  }
}

/** The identity of an app's program: its launcher and its native payload, hashed and stated. */
export function executableIdentity(program) {
  return { launcher: programFile(program.launcher), payload: programFile(program.payload) }
}

/** Whether the program is the very one an identity names, by its files' state (cheap enough for the moment before start). */
export function sameProgram(identity, program) {
  const same = (recorded, path) => {
    try {
      const now = programStat(path)
      return ['real', 'link', 'dev', 'ino', 'size', 'mtime_ns', 'ctime_ns'].every((key) => now[key] === recorded[key])
    } catch {
      return false
    }
  }
  return same(identity.launcher, program.launcher) && same(identity.payload, program.payload)
}

/** Standard input for a picture ask on Claude Code: one user message, the pictures first, then the question. */
export function claudePictureMessage(pictures, prompt) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [...pictures.map((picture) => ({ type: 'image', source: { type: 'base64', media_type: picture.media_type, data: picture.bytes.toString('base64') } })), { type: 'text', text: prompt }] } })}\n`
}
