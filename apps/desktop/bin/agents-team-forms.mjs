// MODULE: agents-team-forms.mjs - Epic 72: the one read-only form of each app for each access mode, as Story 72.1 measured them, and which app versions they are proven on
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { INSIDE, appPaths, containerArgv } from './agents-container.mjs'
import { openCodeAskHome, openCodeEnvironment } from './agents-opencode.mjs'

/**
 * A teammate's ask runs its app in exactly one form per access mode (R72-NFR2), each one measured
 * in its container against a stand-in provider (72.1, `reference-72-team-ask/RESULT.md`). Only
 * the app versions measured here may use a mode that depends on that proof (R72-NFR10): another
 * version shows the mode unmeasured until its rows are measured again.
 *
 * `proven`: confined and working. `unavailable`: measured, and no form keeps it confined on this
 * computer. `no-history`: confined, with no tool that reads the project's Git history.
 */
export const ASK_FORMS_PROVEN = Object.freeze({
  codex: { '0.162.1': { question: 'proven', files: 'proven', project: 'unavailable', pictures: 'proven', browser: 'proven' } },
  claude: { '2.1.300': { question: 'proven', files: 'proven', project: 'proven', pictures: 'proven', browser: 'proven' } },
  opencode: { '2.0.29': { question: 'proven', files: 'proven', project: 'no-history', pictures: 'unmeasured' } }
})

/**
 * What BMN offers beyond its access modes: picture asks, since Story 72.8, where 72.1 proved them; browser asks, since
 * Story 74.3, where 74.1 measured an app's browser tool inside its containment (records in reference-74-browser/RESULT.md).
 */
export const ASK_OFFERED = Object.freeze({ pictures: true, browser: true })

/** Why a measured mode is unavailable, in the words the refusal gives. */
export const UNAVAILABLE_WHY = Object.freeze({
  codex: {
    project: 'Codex runs every command of a project ask in its own bubblewrap sandbox, and on this computer a sandbox inside BMN\'s container is refused (AppArmor\'s unprivileged-namespace restriction); without that sandbox Codex would read its own sign-in, so project asks on Codex are unavailable here (72.1)'
  },
  opencode: {
    project: 'OpenCode\'s read-only agent has no tool that reads the project\'s Git history, so its project form is not offered (72.1, 72.5); ask it with --access files and the files it needs',
    pictures: 'BMN never measured a picture ask on OpenCode (72.1 measured Codex and Claude Code), so OpenCode teammates are not asked about pictures; ask a Codex or Claude Code teammate',
    browser: 'BMN never measured a browser ask on OpenCode (74.1 measured Codex and Claude Code), so OpenCode teammates are not asked to check an app; ask a Codex or Claude Code teammate'
  }
})

/** The standing of one app version's mode: `proven`, `unavailable`, `no-history` or `unmeasured`. */
export function formStanding(harness, version, mode) {
  return ASK_FORMS_PROVEN[harness]?.[version]?.[mode] ?? 'unmeasured'
}

/** What a teammate may read: the question only, the named files, or one project read-only (R72-FR2). */
export const ASK_ACCESS = Object.freeze(['question', 'files', 'project'])

/** The parts of one ask's folder under BMN's state (`team/runs/<id>/`), as the contract's record table names them. */
export const ASK_RUN_FILES = Object.freeze({
  request: 'request.json', manifest: 'inputs/manifest.json', prompt: 'inputs/prompt.md', rules: 'inputs/rules.md', files: 'inputs/files',
  pictures: 'inputs/pictures', message: 'inputs/message.jsonl',
  projectManifest: 'project-manifest.json', snapshots: 'snapshots', receipt: 'receipt.json', answer: 'answer.md', outcome: 'outcome.json', question: 'question.md',
  home: 'home', inputs: 'inputs', project: 'project'
})

/** The name a receipt gives each form, per app and access mode. */
export const ASK_FORM_NAMES = Object.freeze({
  codex: { question: 'codex-no-tools', files: 'codex-no-tools', project: 'codex-project' },
  claude: { question: 'claude-no-tools', files: 'claude-no-tools', project: 'claude-project-read' },
  opencode: { question: 'opencode-asker', files: 'opencode-asker', project: 'opencode-project-read' }
})
/** The name a receipt gives a browser ask's form (74.3): the app's question form with BMN's filtered browser tools. */
export const ASK_BROWSER_FORM_NAMES = Object.freeze({ codex: 'codex-browser', claude: 'claude-browser' })

/** Where a browser ask's own files are inside the container: BMN's script that connects to the filter's socket, and the socket's folder. */
export const BROWSER_INSIDE = Object.freeze({ folder: `${INSIDE.root}/browser`, socket: `${INSIDE.root}/browser/mcp.sock`, script: `${INSIDE.inputs}/browser/ask-browser-space.mjs` })
/** How long the app waits for the browser to start and for one of its tools to answer (as 74.1 ran them). */
const BROWSER_START_SECONDS = 60
const BROWSER_TOOL_SECONDS = 240

/** The browser as a teammate's MCP server: BMN's script on Node, one connection to the filter in front of the browser. */
function browserServer(browser) {
  return { command: browser.node, args: [BROWSER_INSIDE.script, 'connect', BROWSER_INSIDE.socket] }
}

/**
 * A question form with the browser's tools (74.3): Codex with its code-mode host on, the one way 0.162.1 offers MCP tools
 * to the model (74.1 measured that the host has no network, file or process API), the browser the only MCP server and only
 * the ask's tools enabled; Claude Code with the browser as its only MCP server and only those tools allowed. BMN's filter
 * offers and allows no other tool whatever the app is told (agents-team-browser.mjs).
 */
function withBrowser(harness, command, environment, browser) {
  const server = browserServer(browser)
  const out = [...command]
  if (harness === 'codex') {
    const host = out.indexOf('code_mode_host')
    if (host < 1 || out[host - 1] !== '--disable') throw new Error('the Codex question form has no --disable code_mode_host')
    out.splice(host - 1, 2)
    const at = out.indexOf('mcp_servers={}')
    if (at < 0) throw new Error('the Codex question form has no mcp_servers={}')
    const list = (values) => `[${values.map((value) => JSON.stringify(value)).join(',')}]`
    out[at] = `mcp_servers={browser={command=${JSON.stringify(server.command)},args=${list(server.args)},enabled_tools=${list(browser.tools)},default_tools_approval_mode="approve",startup_timeout_sec=${BROWSER_START_SECONDS},tool_timeout_sec=${BROWSER_TOOL_SECONDS}}}`
    return { command: out, environment }
  }
  const at = out.indexOf('{"mcpServers":{}}')
  if (at < 0) throw new Error('the Claude Code form has no empty MCP configuration')
  out[at] = JSON.stringify({ mcpServers: { browser: server } })
  const mode = out.indexOf('--permission-mode')
  out.splice(mode, 0, '--allowedTools', browser.tools.map((tool) => `mcp__browser__${tool}`).join(','))
  return { command: out, environment: { ...environment, MCP_TIMEOUT: String(BROWSER_START_SECONDS * 1000), MCP_TOOL_TIMEOUT: String(BROWSER_TOOL_SECONDS * 1000) } }
}

/** An ask's OpenCode session title: with one named, OpenCode makes no request of its own to name the session (70.3). */
export const OPENCODE_ASK_TITLE = 'BMN ask'

/** Codex with every tool off that a setting turns off, as its research form and the 72.1 question/files form; `--ephemeral` keeps no session. Six sub-agent tools stay offered on 0.162.1 and a sub-agent does start (74.3): its own session in the turn log leaves the ask not attributed. */
export const CODEX_ASK_NO_TOOLS = Object.freeze(['--ephemeral', '--disable', 'view_image', '--disable', 'goals', '--disable', 'image_generation', '--disable', 'sleep_tool', '--disable', 'hooks', '--disable', 'code_mode_host',
  '-c', 'mcp_servers={}', '-c', 'web_search="disabled"', '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.multi_agent=false',
  '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '-c', 'include_apps_instructions=false',
  '-c', 'include_collaboration_mode_instructions=false', '-c', 'include_environment_context=false', '-c', 'project_doc_max_bytes=0'])

/** Codex logs the turn span that names its model and effort only at this level; the log holds no prompt or answer text (72.1 AC2). */
export const CODEX_ASK_LOG = 'codex_core=info,codex_core::stream_events_utils=debug'

export const CLAUDE_ASK_NO_TOOLS = Object.freeze(['--tools', '', '--permission-mode', 'dontAsk'])
/** Claude Code's project form: its read tools kept in the working folder, history only through BMN's own git (bin/ask-git.sh) first on PATH. */
export const CLAUDE_ASK_PROJECT = Object.freeze(['--tools', 'Read,Grep,Glob,Bash', '--allowedTools', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)',
  '--permission-mode', 'dontAsk', '--restricted'])
export const CLAUDE_ASK_COMMON = Object.freeze(['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence',
  '--output-format', 'stream-json', '--verbose'])

/**
 * Where an app's sign-in is inside the run's home: the owner's own file bound there read-only. An ask
 * never renews his sign-in: a renewal spends his single-use refresh token outside the lock his own
 * sessions share, and a lost race wipes his file (measured 2026-10-15, records/signin/renewal-race-*).
 * So the app's renewal cannot reach its host (Codex: its renewal address; Claude Code: the sign-in
 * hosts in the run's own /etc/hosts), and an ask whose token has expired fails as a sign-in failure
 * until one of his own sessions renews it.
 */
export function signInBind(harness, environment = process.env) {
  const home = environment.HOME ?? ''
  if (harness === 'codex') return { from: `${environment.CODEX_HOME || `${home}/.codex`}/auth.json`, to: `${INSIDE.home}/codex/auth.json`, writable: false }
  if (harness === 'claude') return { from: `${environment.CLAUDE_CONFIG_DIR || `${home}/.claude`}/.credentials.json`, to: `${INSIDE.home}/.claude/.credentials.json`, writable: false }
  return null
}

/** Where Codex sends a renewal in an ask: a port nothing listens on, so it never spends the owner's refresh token. */
export const CODEX_ASK_NO_RENEWAL = 'http://127.0.0.1:1/oauth/token'
/**
 * The /etc/hosts of a Claude Code ask: the sign-in hosts at an address nothing answers on, so Claude
 * Code never renews the owner's sign-in (its local sign-in settings do not move the token host; the
 * hosts file does, measured on 2.1.300). The model host is looked up as always.
 */
export const CLAUDE_ASK_HOSTS = '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\task\n127.0.0.2\tplatform.claude.com console.anthropic.com claude.ai\n'

/** PATH without BMN's own wrappers, so the app found is the one the owner installed. */
export function appSearchPath(environment = process.env) {
  return (environment.PATH ?? '').split(':').filter((entry) => entry !== '' && !entry.includes('/resources/bin') && !entry.endsWith('/apps/desktop/bin')).join(':')
}

/** The installed program of an app, as the container binds it: `{ launcher, payload, root, paths }` or null. */
export function askProgram(harness, environment = process.env) {
  return appPaths(harness, { PATH: appSearchPath(environment) })
}

/**
 * The app's command inside the container for one ask, and what its home must hold. `request`:
 * `{ access, model, effort, rules, pictures, browser }` with `pictures` the inside paths of the pictures and `browser`,
 * for a browser ask, `{ tools, node }`: the tools BMN's filter offers and the Node that runs BMN's connection to it.
 * Returns `{ command, environment, cwd, home: { [relative path]: text }, mountPoints, stdin }`;
 * `stdin` is `text` (the prompt as it is) or `stream-json` (one user message with the pictures).
 */
export function askCommand(harness, program, { access, model, provider = null, effort, rules = null, pictures = [], context = { argv: [], env: [] }, browser = null }) {
  if (browser !== null) {
    if (access !== 'question' || pictures.length > 0 || (harness !== 'codex' && harness !== 'claude')) throw new Error(`no browser form for ${harness} with ${access} access`)
    const form = askCommand(harness, program, { access, model, provider, effort, rules, pictures, context })
    return { ...form, ...withBrowser(harness, form.command, form.environment, browser) }
  }
  // The agent's context limit, where the owner's test proved the setting on this app version (60.9): `-c` items for Codex, environment for Claude Code.
  const contextEnvironment = Object.fromEntries(context.env.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
  if (harness === 'codex') {
    const home = { 'codex/config.toml': '' }
    if (rules !== null) home['codex/AGENTS.md'] = rules
    return {
      command: [program.payload, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--strict-config', '-c', 'approval_policy="never"', ...CODEX_ASK_NO_TOOLS,
        ...pictures.flatMap((path) => ['-i', path]), ...context.argv, '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--json', '-C', INSIDE.work, '-o', `${INSIDE.home}/answer.md`, '-'],
      environment: { HOME: INSIDE.home, CODEX_HOME: `${INSIDE.home}/codex`, PATH: '/usr/bin:/bin', CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: program.root, RUST_LOG: CODEX_ASK_LOG,
        CODEX_REFRESH_TOKEN_URL_OVERRIDE: CODEX_ASK_NO_RENEWAL },
      cwd: INSIDE.work, home, mountPoints: ['codex/auth.json'], stdin: 'text'
    }
  }
  if (harness === 'claude') {
    const project = access === 'project'
    return {
      command: [program.payload, '-p', '--model', model, '--effort', effort, ...(project ? CLAUDE_ASK_PROJECT : CLAUDE_ASK_NO_TOOLS), ...CLAUDE_ASK_COMMON,
        ...(pictures.length > 0 ? ['--input-format', 'stream-json'] : []), ...(rules === null ? [] : ['--append-system-prompt', rules])],
      environment: { HOME: INSIDE.home, CLAUDE_CONFIG_DIR: `${INSIDE.home}/.claude`, PATH: project ? `${INSIDE.inputs}/bin:/usr/bin:/bin` : '/usr/bin:/bin',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ...contextEnvironment },
      cwd: project ? INSIDE.project : INSIDE.work, home: {}, mountPoints: ['.claude/.credentials.json'], stdin: pictures.length > 0 ? 'stream-json' : 'text', hosts: CLAUDE_ASK_HOSTS
    }
  }
  if (harness === 'opencode') {
    // 72.1's OpenCode form: the run's own five folders in its home, BMN's agent, the project's own configuration off.
    const own = openCodeAskHome(access, rules)
    const reference = model.includes('/') ? model : `${provider}/${model}`
    return {
      command: [program.payload, 'run', '--standalone', '--format', 'json', '--agent', own.agent, '-m', `${reference}#${effort}`, '--title', OPENCODE_ASK_TITLE],
      environment: { ...openCodeEnvironment(`${INSIDE.home}/oc`), PATH: '/usr/bin:/bin' },
      cwd: access === 'project' ? INSIDE.project : INSIDE.work, home: own.files, folders: own.folders, mountPoints: [], stdin: 'text'
    }
  }
  throw new Error(`no ask form for ${harness} yet`)
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
export function programStat(path) {
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

/** The apps whose teammates BMN asks: OpenCode's form arrived with Story 72.5. */
export const ASK_APPS = Object.freeze(['codex', 'claude', 'opencode'])

/**
 * The whole command of one ask: the app's form inside the run's container. `run`: the run's own
 * `{ home, inputs, project }` folders on this computer. The owner's sign-in file is bound read-only
 * onto the empty file the run's home holds at its place (72.1 AC5), the configuration BMN wrote for the app
 * bound read-only over itself; a form with its own `hosts` gets
 * the run's `snapshots/hosts` as /etc/hosts. Returns `{ argv, form }`.
 */
export function askArgv(harness, program, run, request, environment = process.env) {
  const form = askCommand(harness, program, request)
  const signIn = signInBind(harness, environment)
  // The configuration BMN wrote for the app is read-only inside the container: the app writes only its own runtime files there (epic review R6).
  const configuration = Object.keys(form.home).map((path) => ({ from: join(run.home, path), to: `${INSIDE.home}/${path}`, writable: false }))
  // A browser ask's container has Node, to run BMN's connection to the filter, and the filter's socket folder, both read-only (74.3).
  const browser = request.browser == null ? [] : [{ from: request.browser.node, to: request.browser.node, writable: false }, { from: join(dirname(run.home), 'browser/mcp'), to: BROWSER_INSIDE.folder, writable: false }]
  const argv = containerArgv({
    app: program.paths, home: run.home, inputs: run.inputs, project: request.access === 'project' ? run.project : null,
    binds: [...configuration, ...(signIn === null ? [] : [signIn]), ...browser], environment: form.environment, cwd: form.cwd, command: form.command,
    hosts: form.hosts === undefined ? null : join(dirname(run.home), ASK_RUN_FILES.snapshots, 'hosts')
  })
  return { argv, form }
}

/** Standard input for a picture ask on Claude Code: one user message, the pictures first, then the question. */
export function claudePictureMessage(pictures, prompt) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [...pictures.map((picture) => ({ type: 'image', source: { type: 'base64', media_type: picture.media_type, data: picture.bytes.toString('base64') } })), { type: 'text', text: prompt }] } })}\n`
}
