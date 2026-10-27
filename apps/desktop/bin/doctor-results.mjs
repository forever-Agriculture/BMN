// MODULE: doctor-results.mjs - Strict projection of transient doctor reports into credential-free facts
import { stripVTControlCharacters } from 'node:util'
import { validateLeftovers } from './doctor-leftover-results.mjs'

export const CHECKS = Object.freeze(['hooks', 'skills', 'tools', 'rules', 'claude', 'codex', 'leftovers'])
export const STATES = Object.freeze(['passed', 'problems', 'partial', 'failed', 'timeout', 'unsupported', 'unqualified', 'interrupted'])
export const PROBLEMS = Object.freeze({
  'additional-details': ['Additional details could not be safely interpreted', 'Inspect the app doctor yourself.'],
  'leftover-file-bound': ['{count} {noun} too large to check', 'Items that depend on these files were not fully checked. The read limit for these files is 1 MiB each.'],
  'leftover-folder-bound': ['{count} {noun} too large to check', 'Items inside were not fully checked. BMN reads up to 1,024 entries, 16 MiB and 12 levels per folder.'],
  'leftover-database-bound': ['{count} {noun} too large to check', 'Dependent memory rows were not fully checked. BMN reads up to 512 MiB per database or WAL.'],
  'leftover-source-changed': ['{count} {noun} changed during the check', 'Some items or locations could not be verified. Checked again at the next run.'],
  'leftover-unreadable': ['{count} {noun} could not be read', 'Check read permission. BMN leaves it.'],
  'leftover-step': ['{count} {noun} did not finish', 'Checked again at the next run.'],
  'missing-program': ['MCP program is missing', 'Install the program or update its MCP configuration.'],
  'endpoint-unreachable': ['MCP endpoint could not be reached', 'Check its address and connection.'],
  'config-invalid': ['Configuration could not be loaded', 'Repair the app configuration.'],
  'auth-check': ['Authentication needs attention', 'Check the app sign-in and credentials.'],
  'installation-check': ['Installation needs attention', 'Repair the app installation.'],
  'search-check': ['Search program needs attention', 'Repair the app installation.'],
  'network-check': ['Provider connection needs attention', 'Check sign-in, network and proxy settings.'],
  'runtime-check': ['App runtime needs attention', 'Inspect the app doctor yourself.'],
  'sandbox-check': ['App sandbox needs attention', 'Inspect the app doctor yourself.'],
  'state-check': ['App state needs attention', 'Inspect the app doctor yourself.'],
  'disk-check': ['Disk space needs attention', 'Inspect the app doctor yourself.'],
  'terminal-check': ['Terminal environment needs attention', 'Warning from BMN’s unattended check. Your interactive terminal was not assessed.'],
  'updates-check': ['App updates need attention', 'Inspect the app doctor yourself.'],
  'hook-check': ['Hook is not wired', 'Review Hooks in Health.'],
  'skill-check': ['Skill needs attention', 'Review Skills in Health.'],
  'tool-check': ['Tool needs attention', 'Review Tools in Health.'],
  'rules-check': ['Rules file needs attention', 'Review Rules files in Health.']
})

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** The codes of BMN's own area checks, whose findings name their cause: the entry's state word, never its name or path (96 Astra review). */
const AREA_CODES = Object.freeze(['hook-check', 'skill-check', 'tool-check', 'rules-check'])
const CAUSE = /^[a-z][a-z-]{0,30}(?::[A-Za-z][\w.]{0,39})?$/u
const fact = (code, item = 1, app, cause) => ({ code, item, ...(['claude', 'codex', 'opencode'].includes(app) ? { app } : {}),
  ...(AREA_CODES.includes(code) && typeof cause === 'string' && CAUSE.test(cause) ? { cause } : {}) })
const result = (problems, partial = false) => ({
  state: partial ? 'partial' : problems.length > 0 ? 'problems' : 'passed',
  problems: partial ? [...problems, fact('additional-details')] : problems
})
const invalid = () => result([], true)
const completeApps = (rows, key) => rows.length === 3 &&
  new Set(rows.map((row) => row?.[key])).size === 3 &&
  rows.every((row) => ['claude', 'codex', 'opencode'].includes(row?.[key]))
// The producer's qualified vocabulary, not arbitrary state prefixes or user-provided optional flags.
const HOOK_EVENTS = Object.freeze({
  claude: ['Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'],
  codex: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt'],
  opencode: ['plugin', 'cli.json']
})
const CODEX_OPTIONAL_HOOKS = ['PermissionRequest', 'PostCompact']
const CODEX_CHECKS = Object.freeze({
  'app_server.status': 'runtime-check', 'auth.credentials': 'auth-check', 'config.load': 'config-invalid',
  'git.environment': 'runtime-check', installation: 'installation-check', 'mcp.config': 'tool-check',
  'network.env': 'network-check', 'network.provider_reachability': 'network-check',
  'network.websocket_reachability': 'network-check', 'runtime.provenance': 'runtime-check',
  'runtime.search': 'search-check', 'sandbox.filesystem_paths': 'sandbox-check',
  'sandbox.helpers': 'sandbox-check', 'security.endpoint': 'network-check', 'state.paths': 'state-check',
  'state.rollout_db_parity': 'state-check', 'system.disk': 'disk-check',
  'system.environment': 'runtime-check', 'terminal.env': 'terminal-check',
  'terminal.title': 'terminal-check', 'updates.status': 'updates-check'
})

/** Never return text, keys, names, URLs or paths from a child, including a doctor's remediation. */
export function parseCodexDoctor(text, exitCode, { readOnlySandbox = false } = {}) {
  let data
  try { data = JSON.parse(text) } catch { return invalid() }
  if (!object(data) || data.schemaVersion !== 1 || !object(data.checks) ||
    !['ok', 'warning', 'fail'].includes(data.overallStatus) || ![0, 1].includes(exitCode)) return invalid()
  const problems = []
  let partial = Object.keys(data.checks).length === 0
  let failures = 0
  for (const [id, row] of Object.entries(data.checks)) {
    if (!Object.hasOwn(CODEX_CHECKS, id) || !object(row) || row.id !== id || !['ok', 'warning', 'fail', 'skipped'].includes(row.status)) {
      partial = true
      continue
    }
    if (row.status === 'skipped') { partial = true; continue }
    if (row.status === 'ok') continue
    failures += 1
    // SQLite cannot create a missing WAL shared-memory file in this sandbox. Access failure is
    // incomplete evidence, whereas a real integrity fault retains the app's state warning.
    if (readOnlySandbox && object(row.details)) {
      const accessError = (value) => typeof value === 'string' && /^error returned from database: \(code: 14\) unable to open database file$/.test(value)
      const integrity = Object.entries(row.details).filter(([key]) => key.endsWith(' DB integrity')).map(([, value]) => value)
      if (id === 'state.paths' && integrity.some(accessError) && integrity.every(value => accessError(value) || value === 'ok' || value === 'skipped (missing)') ||
        id === 'state.rollout_db_parity' && accessError(row.details['rollout DB read error'])) {
        partial = true
        continue
      }
    }
    if (id !== 'mcp.config') { problems.push(fact(CODEX_CHECKS[id], problems.length + 1)); continue }
    if (!object(row.details)) { partial = true; continue }
    const before = problems.length
    for (const [key, value] of Object.entries(row.details)) {
      if (['configured servers', 'disabled servers', 'stdio servers', 'streamable_http servers'].includes(key) &&
        typeof value === 'string' && /^\d+$/.test(value)) continue
      if (typeof value === 'string' && /^stdio command ".*" is not resolvable \(not found on PATH\)$/.test(value)) {
        problems.push(fact('missing-program', problems.length + 1))
      } else if (key === 'optional reachability failed' && typeof value === 'string' &&
        value.endsWith('(HEAD connect failed; GET connect failed)')) {
        problems.push(fact('endpoint-unreachable', problems.length + 1))
      } else partial = true
    }
    if (problems.length === before) partial = true
  }
  if ((data.overallStatus === 'ok') !== (failures === 0) || (exitCode === 1 && failures === 0)) partial = true
  // A failed config load legitimately prevents subsequent checks. Otherwise the complete known schema is required.
  if (data.checks['config.load']?.status !== 'fail' && Object.keys(CODEX_CHECKS).some((id) => !Object.hasOwn(data.checks, id))) partial = true
  return result(problems, partial)
}

const CLAUDE_WARNING = [
  [/^Native installation exists but ~\/\.local\/bin is not in your PATH$/, 'installation-check'],
  [/^Running native installation but config install method is '.+'$/, 'installation-check'],
  [/^claude command at .+ missing or broken(?: \(.+\))?$/, 'installation-check'],
  [/^Search: (?!OK).+$/, 'search-check']
]
const CLAUDE_METADATA = /^(?:Running: (?:native|npm|local) \(\d+\.\d+\.\d+\)|Commit: .+|Platform: .+|Path: .+|Config install method: .+|Search: OK \(.+\)|Auto-updates: .+|Auto-update channel: .+|Last update attempt: .+|Managed settings \(remote\): .+|Organization policy: .+|Remote Control|Remote Control requires .+| {2}Fix: .+|For a full setup checkup .+)$/
const CLAUDE_REMOTE = /^(?:Not signed in to claude\.ai|claude\.ai subscription auth not active|Sign-in is missing the user:profile scope|Organization not resolved|Org policy not loaded, see the Organization policy line above \(allow_remote_control\)|Feature-flag evaluation disabled \(disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\)|Remote Control availability could not be verified \(no server response this session\))$/

export function parseClaudeDoctor(text, exitCode) {
  const lines = stripVTControlCharacters(text).split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines[0] !== 'Claude Code doctor' || ![0, 1].includes(exitCode)) return invalid()
  const problems = []
  let warnings = null
  let seenWarnings = 0
  let partial = !lines.some((line) => /^Running: (?:native|npm|local) \(\d+\.\d+\.\d+\)$/.test(line))
  for (const line of lines.slice(1)) {
    const count = /^(\d+) warnings? found$/.exec(line)
    if (count) { warnings = Number(count[1]); continue }
    // Claude 2.1.308 says "No installation issues found."; earlier versions use the two shorter lines.
    if (['No issues found', 'No warnings found', 'No installation issues found.'].includes(line)) { warnings = 0; continue }
    if (line.startsWith('- ')) {
      const content = line.slice(2)
      if (warnings === null && CLAUDE_REMOTE.test(content)) {
        if (content === 'Not signed in to claude.ai' && !problems.some((row) => row.code === 'auth-check')) problems.push(fact('auth-check', problems.length + 1))
        continue
      }
      seenWarnings += 1
      const mapping = CLAUDE_WARNING.find(([pattern]) => pattern.test(content))
      if (mapping) problems.push(fact(mapping[1], problems.length + 1))
      else partial = true
      continue
    }
    if (line.startsWith("Organization policy: Couldn't load")) problems.push(fact('auth-check', problems.length + 1))
    if (!CLAUDE_METADATA.test(line)) partial = true
  }
  if (warnings === null || warnings !== seenWarnings || (exitCode === 1 && problems.length === 0)) partial = true
  return result(problems, partial)
}

/** BMN's existing read-only checks are projected too: their paths and names can contain credentials. */
export function parseBmnDoctor(check, text, exitCode) {
  let data
  try { data = JSON.parse(text) } catch { return invalid() }
  if (![0, 1].includes(exitCode)) return invalid()
  const problems = []
  let partial
  let currentApp
  const add = (code, cause) => problems.push(fact(code, problems.length + 1, currentApp, cause))
  if (check === 'rules' && object(data) && Array.isArray(data.targets) && data.targets.length > 0) {
    partial = !completeApps(data.targets, 'harness') || typeof data.ok !== 'boolean'
    for (const row of data.targets) {
      currentApp = row?.harness
      if (!object(row) || !['current', 'missing', 'link', 'unmanaged', 'edited-outside', 'stale', 'unreadable'].includes(row.state)) partial = true
      else if (row.state !== 'current') add('rules-check', row.state)
    }
  } else if (check === 'hooks' && object(data) && Array.isArray(data.agents) && data.agents.length > 0) {
    partial = !completeApps(data.agents, 'agent') || typeof data.ok !== 'boolean'
    for (const app of data.agents) {
      currentApp = app?.agent
      if (!object(app) || typeof app.agent !== 'string' || !['claude', 'codex', 'opencode'].includes(app.agent) ||
        !Array.isArray(app.events) || app.events.length === 0) { partial = true; continue }
      const required = HOOK_EVENTS[app.agent]
      const seen = new Set()
      for (const event of app.events) {
        const optional = app.agent === 'codex' && CODEX_OPTIONAL_HOOKS.includes(event?.event)
        if (!object(event) || (!required.includes(event.event) && !optional) || seen.has(event.event)) { partial = true; continue }
        seen.add(event.event)
        if (typeof event.optional !== 'boolean' || event.optional !== optional) partial = true
        if (event.state === 'wired' || event.state === 'wired (older wording)' && ['claude', 'codex'].includes(app.agent)) continue
        if (event.state === 'missing') {
          if (!optional || event.optional !== true) add('hook-check', `missing:${event.event}`)
        } else if (event.state === 'wired (older wording)' && app.agent === 'opencode' && event.event === 'plugin') add('hook-check', 'older-wording:plugin')
        else partial = true
      }
      if (required.some(event => !seen.has(event))) partial = true
    }
  } else if (['skills', 'tools'].includes(check) && object(data) && Array.isArray(data.apps) && data.apps.length > 0) {
    partial = !completeApps(data.apps, 'harness')
    for (const app of data.apps) {
      currentApp = app?.harness
      if (!object(app) || app.supported !== true || app.readable === false) { partial = true; continue }
      const rows = app[check]
      if (!Array.isArray(rows)) { partial = true; continue }
      for (const row of rows) {
        if (!object(row) || typeof row.state !== 'string') partial = true
        else if (!(check === 'skills' ? ['current', 'read-directly', 'excluded'] : ['current', 'excluded']).includes(row.state)) add(check === 'skills' ? 'skill-check' : 'tool-check', row.state)
      }
      if (check === 'tools' && Array.isArray(app.unlisted)) for (const entry of app.unlisted) {
        if (entry.state === 'exposed' || entry.managed === true) add('tool-check', entry.managed === true ? 'unlisted-managed' : 'unlisted-exposed')
      }
    }
    if (check === 'skills' && data.source?.readable !== true) partial = true
  } else return invalid()
  if (['hooks', 'rules'].includes(check) && data.ok === false && problems.length === 0) partial = true
  if (exitCode === 1 && problems.length === 0) partial = true
  return result(problems, partial)
}

/** State and IPC readers rebuild the projection, dropping unknown properties at the trust boundary. */
export function projectedResult(value) {
  if (!object(value) || !STATES.includes(value.state) || !Array.isArray(value.problems)) return null
  const problems = []
  for (const row of value.problems) {
    if (!object(row) || !Object.hasOwn(PROBLEMS, row.code) || !Number.isSafeInteger(row.item) || row.item < 1 || row.item > 10000) return null
    if (row.app !== undefined && !['claude', 'codex', 'opencode'].includes(row.app)) return null
    if (row.cause !== undefined && (typeof row.cause !== 'string' || !CAUSE.test(row.cause) || !AREA_CODES.includes(row.code))) return null
    if (row.count !== undefined && (!Number.isSafeInteger(row.count) || row.count < 1 || row.count > 10000 || !row.code.startsWith('leftover-'))) return null
    if (row.code.startsWith('leftover-') && row.count === undefined) return null
    problems.push({ ...fact(row.code, row.item, row.app, row.cause), ...(row.count !== undefined ? { count: row.count } : {}) })
  }
  if (value.state === 'passed' && problems.length !== 0) return null
  if (value.state === 'problems' && problems.length === 0) return null
  if (value.leftovers !== undefined) {
    const leftovers = validateLeftovers(value.leftovers)
    if (leftovers === null) return null
    return { state: value.state, problems, leftovers }
  }
  return { state: value.state, problems }
}
