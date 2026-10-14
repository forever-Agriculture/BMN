// MODULE: agents-team-forms.mjs - Epic 72: the one read-only form of each app for each access mode, as Story 72.1 measured them, and which app versions they are proven on
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { INSIDE, appPaths, containerArgv } from './agents-container.mjs'

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
  codex: { '0.162.1': { question: 'proven', files: 'proven', project: 'unavailable', pictures: 'proven' } },
  claude: { '2.1.300': { question: 'proven', files: 'proven', project: 'proven', pictures: 'proven' } },
  opencode: { '2.0.29': { question: 'proven', files: 'proven', project: 'no-history', pictures: 'unmeasured' } }
})

/** Why a measured mode is unavailable, in the words the refusal gives. */
export const UNAVAILABLE_WHY = Object.freeze({
  codex: {
    project: 'Codex runs every command of a project ask in its own bubblewrap sandbox, and on this computer a sandbox inside BMN\'s container is refused (AppArmor\'s unprivileged-namespace restriction); without that sandbox Codex would read its own sign-in, so project asks on Codex are unavailable here (72.1)'
  },
  opencode: {
    project: 'OpenCode\'s read-only agent has no tool that reads the project\'s Git history, so its project form is not offered yet (72.5 measures one)',
    pictures: 'pictures for OpenCode teammates are not measured'
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
  projectManifest: 'project-manifest.json', snapshots: 'snapshots', receipt: 'receipt.json', answer: 'answer.md', outcome: 'outcome.json',
  home: 'home', inputs: 'inputs', project: 'project'
})

/** The name a receipt gives each form, per app and access mode. */
export const ASK_FORM_NAMES = Object.freeze({
  codex: { question: 'codex-no-tools', files: 'codex-no-tools', project: 'codex-project' },
  claude: { question: 'claude-no-tools', files: 'claude-no-tools', project: 'claude-project-read' }
})

/** Codex with every tool off, as its research form and the 72.1 question/files form; `--ephemeral`, because only a run that keeps no session makes every sub-agent start fail. */
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

/** Where an app's sign-in is inside the run's home, and the owner's own file bound there read-write (72.1 AC5: renewals land in his file). */
export function signInBind(harness, environment = process.env) {
  const home = environment.HOME ?? ''
  if (harness === 'codex') return { from: `${environment.CODEX_HOME || `${home}/.codex`}/auth.json`, to: `${INSIDE.home}/codex/auth.json`, writable: true }
  if (harness === 'claude') return { from: `${environment.CLAUDE_CONFIG_DIR || `${home}/.claude`}/.credentials.json`, to: `${INSIDE.home}/.claude/.credentials.json`, writable: true }
  return null
}

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
 * `{ access, model, effort, rules, pictures }` with `pictures` the inside paths of the pictures.
 * Returns `{ command, environment, cwd, home: { [relative path]: text }, mountPoints, stdin }`;
 * `stdin` is `text` (the prompt as it is) or `stream-json` (one user message with the pictures).
 */
export function askCommand(harness, program, { access, model, effort, rules = null, pictures = [], context = { argv: [], env: [] } }) {
  // The agent's context limit, where the owner's test proved the setting on this app version (60.9): `-c` items for Codex, environment for Claude Code.
  const contextEnvironment = Object.fromEntries(context.env.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
  if (harness === 'codex') {
    const home = { 'codex/config.toml': '' }
    if (rules !== null) home['codex/AGENTS.md'] = rules
    return {
      command: [program.payload, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--strict-config', '-c', 'approval_policy="never"', ...CODEX_ASK_NO_TOOLS,
        ...pictures.flatMap((path) => ['-i', path]), ...context.argv, '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--json', '-C', INSIDE.work, '-o', `${INSIDE.home}/answer.md`, '-'],
      environment: { HOME: INSIDE.home, CODEX_HOME: `${INSIDE.home}/codex`, PATH: '/usr/bin:/bin', CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: program.root, RUST_LOG: CODEX_ASK_LOG },
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
      cwd: project ? INSIDE.project : INSIDE.work, home: {}, mountPoints: ['.claude/.credentials.json'], stdin: pictures.length > 0 ? 'stream-json' : 'text'
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

/** Whether BMN builds an ask form for an app yet: OpenCode's arrives with Story 72.5. */
export const ASK_APPS = Object.freeze(['codex', 'claude'])

/**
 * The whole command of one ask: the app's form inside the run's container. `run`: the run's own
 * `{ home, inputs, project }` folders on this computer. The owner's sign-in file is bound onto the
 * empty file the run's home holds at its place (72.1 AC5). Returns `{ argv, form }`.
 */
export function askArgv(harness, program, run, request, environment = process.env) {
  const form = askCommand(harness, program, request)
  const signIn = signInBind(harness, environment)
  const argv = containerArgv({
    app: program.paths, home: run.home, inputs: run.inputs, project: request.access === 'project' ? run.project : null,
    binds: signIn === null ? [] : [signIn], environment: form.environment, cwd: form.cwd, command: form.command
  })
  return { argv, form }
}

/** Standard input for a picture ask on Claude Code: one user message, the pictures first, then the question. */
export function claudePictureMessage(pictures, prompt) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [...pictures.map((picture) => ({ type: 'image', source: { type: 'base64', media_type: picture.media_type, data: picture.bytes.toString('base64') } })), { type: 'text', text: prompt }] } })}\n`
}
