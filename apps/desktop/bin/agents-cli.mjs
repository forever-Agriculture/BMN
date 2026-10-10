// MODULE: agents-cli.mjs - Epic 60: `bmn team`, `bmn roster …` and `bmn rules …`, owner commands that need no control socket
import { writeSync } from 'node:fs'
import { RosterError, roleChain, roleChainText, rosterPath, team, teamLine } from './agents-roster.mjs'
import { diffLine, listGenerations, machineDiff, readApproved, readValidRoster } from './agents-state.mjs'

/** Exit codes shared by every Epic 60 command (the epic's shared contract). */
export const EXIT = {
  ok: 0, usage: 2, ROSTER_MISSING: 3, MASTER_MISSING: 3, ROSTER_INVALID: 4, MASTER_INVALID: 4, NOT_APPROVED: 5, STATE_CORRUPT: 6,
  REVISION_CONFLICT: 7, refusal: 10, MASTER_EXISTS: 10, RECEIPT_INVALID: 11, OWNER_APPROVAL_IN_APP: 12, HISTORY_UNAVAILABLE: 13
}

export class AgentsUsageError extends Error {}

/** Written synchronously: these commands finish at once and a pipe could lose an async write. */
export function out(text) {
  writeSync(1, text.endsWith('\n') ? text : `${text}\n`)
}

function err(text) {
  writeSync(2, text.endsWith('\n') ? text : `${text}\n`)
}

export function exitFor(code) {
  if (Object.hasOwn(EXIT, code)) return EXIT[code]
  return 1
}

/** Prints a RosterError the way every Epic 60 command does and returns its exit code. */
export function failWith(error, asJson) {
  if (!(error instanceof RosterError)) throw error
  if (asJson) {
    out(JSON.stringify({ ok: false, code: error.code, message: error.message,
      ...(error.errors ? { errors: error.errors } : {}), ...(error.lastGood !== undefined ? { last_good_generation: error.lastGood } : {}) }, null, 2))
  } else {
    err(`bmn: ${error.code}: ${error.message}`)
    for (const entry of error.errors ?? []) err(`  line ${entry.line ?? '?'}: ${entry.code}: ${entry.message}`)
  }
  return exitFor(error.code)
}

/**
 * A strict option reader: `--name value`, `--name=value` and flags, everything after `--` kept as
 * the dispatch argv. Unknown options are usage errors, never ignored.
 */
export function readOptions(argv, { flags = [], values = [] } = {}) {
  const positionals = []
  const options = Object.create(null)
  let rest = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      rest = argv.slice(index + 1)
      break
    }
    if (!argument.startsWith('--') || argument === '--') {
      if (argument.startsWith('-') && argument !== '-') throw new AgentsUsageError(`unknown option ${argument}`)
      positionals.push(argument)
      continue
    }
    const equals = argument.indexOf('=')
    const name = argument.slice(2, equals === -1 ? undefined : equals)
    if (options[name] !== undefined) throw new AgentsUsageError(`--${name} given more than once`)
    if (flags.includes(name)) {
      if (equals !== -1) throw new AgentsUsageError(`--${name} does not take a value`)
      options[name] = true
    } else if (values.includes(name)) {
      const value = equals !== -1 ? argument.slice(equals + 1) : argv[index + 1]
      if (value === undefined) throw new AgentsUsageError(`--${name} requires a value`)
      if (equals === -1) index += 1
      options[name] = value
    } else {
      throw new AgentsUsageError(`unknown option --${name}`)
    }
  }
  return { positionals, options, rest }
}

export const TEAM_USAGE = `Usage: bmn team [--all] [--json]

Prints the approved team, one line per enabled active agent in roster order: id, name, class,
app, model, provider, whether that provider may see private work, roles, efforts and context
limit. --all adds disabled and proposed agents, marked. Reads only the approved team
(Preferences > Team); a roster edit takes effect once the owner approves it there. Exit 5 when
nothing is approved yet, 6 when approved state is corrupt.`

export const ROSTER_USAGE = `Usage: bmn roster validate [--json]          Check ~/.config/bmn/agents/roster.md; exit 4 lists each error and line
       bmn roster status [--json]            Approved version and every pending file difference
       bmn roster role <role> [--json]       The approved chain: ordered candidates, eligibility, then, rules
       bmn roster route --agent <id> [--json] [-- <dispatch argv>]
                                             Which provider and host a dispatch would reach (inspection only)
       bmn roster visibility <workspace> [--refresh] [--json]
                                             Whether a workspace is proven public; --refresh asks GitHub once
       bmn roster check --agent <id> --role <role> --workspace <path> --data private|public
                        [--cwd <dir>] [--stdin <file>] [--packet <dir>] [--resume-of <receipt>] [--json]
                        -- <dispatch argv>   PASS or the first refusal, before work leaves for another agent
       bmn roster explain <same as check>    The same evaluation in words
       bmn roster check --verify <receipt> -- <dispatch argv>
                                             Recompute a receipt; exit 11 on any difference
       bmn roster check --research --agent <id> --stdin <prompt> [--json] -- <dispatch argv>
                                             Check a research run
       bmn roster bind --receipt <file> --session <id>
                                             Bind a started session to its receipt, for a later resume

Machine fields take effect only after the owner approves them in BMN (Preferences > Team); no
command approves (exit 12). Works with BMN closed; only visibility --refresh uses the network.
Exit: 0 PASS, 2 usage, 3 roster missing, 4 invalid, 5 nothing approved, 6 state corrupt,
10 refusal, 11 receipt stale or invalid.`

function approvedData() {
  return readApproved()
}

export async function runTeam(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['all', 'json', 'help'] })
    if (parsed.options.help) {
      out(TEAM_USAGE)
      return 0
    }
    if (parsed.positionals.length > 0 || parsed.rest !== null) throw new AgentsUsageError('team takes no arguments')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  try {
    const generation = approvedData()
    const entries = team(generation.data, parsed.options.all === true)
    if (asJson) {
      out(JSON.stringify({ ok: true, generation: generation.number, agents: entries }, null, 2))
    } else if (entries.length === 0) {
      out(`No ${parsed.options.all ? '' : 'enabled active '}agents in approved version ${generation.number}.`)
    } else {
      out([...entries.map(teamLine), `(approved version ${generation.number})`].join('\n'))
    }
    return 0
  } catch (error) {
    return failWith(error, asJson)
  }
}

export function usage(message) {
  err(`bmn: ${message}\nRun "bmn roster --help" or "bmn rules --help" for usage.`)
  return 2
}

export async function runRoster(argv) {
  const [action, ...rest] = argv
  if (action === undefined || action === '--help' || action === '-h' || action === 'help') {
    out(ROSTER_USAGE)
    return action === undefined ? 2 : 0
  }
  if (action === 'approve' || action === 'restore' || action === 'revert') {
    err('bmn: OWNER_APPROVAL_IN_APP: roster changes are approved, reverted and restored only in BMN Preferences > Team; nothing was changed')
    return EXIT.OWNER_APPROVAL_IN_APP
  }
  if (action === 'validate') return rosterValidate(rest)
  if (action === 'status') return rosterStatus(rest)
  if (action === 'role') return rosterRole(rest)
  if (action === 'route' || action === 'check' || action === 'explain' || action === 'visibility' || action === 'bind') {
    const { runCheckCommand } = await import('./agents-check.mjs')
    return runCheckCommand(action, rest)
  }
  return usage(`roster expects validate, status, role, route, visibility, check, explain or bind, not ${action}`)
}

function rosterValidate(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json'] })
    if (parsed.positionals.length > 0 || parsed.rest !== null) throw new AgentsUsageError('roster validate takes no arguments')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  try {
    const roster = readValidRoster()
    if (asJson) {
      out(JSON.stringify({ ok: true, file: roster.path, hash: roster.hash, agents: roster.data.agents.length, warnings: roster.warnings }, null, 2))
    } else {
      const lines = [`${roster.path} is valid: ${roster.data.agents.length} agent${roster.data.agents.length === 1 ? '' : 's'}, ${roster.data.roles.length} role${roster.data.roles.length === 1 ? '' : 's'}.`]
      for (const warning of roster.warnings) lines.push(`  note, line ${warning.line ?? '?'}: ${warning.code}: ${warning.message}`)
      lines.push('Validation reads the file; nothing in it takes effect until it is approved in BMN Preferences > Team.')
      out(lines.join('\n'))
    }
    return 0
  } catch (error) {
    return failWith(error, asJson)
  }
}

async function rosterStatus(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json'] })
    if (parsed.positionals.length > 0 || parsed.rest !== null) throw new AgentsUsageError('roster status takes no arguments')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  let generation = null
  let approvalProblem = null
  try {
    generation = readApproved()
  } catch (error) {
    if (!(error instanceof RosterError)) throw error
    approvalProblem = error
  }
  let roster = null
  let fileProblem = null
  try {
    roster = readValidRoster()
  } catch (error) {
    if (!(error instanceof RosterError)) throw error
    fileProblem = error
  }
  const differences = generation && roster ? machineDiff(generation.data, roster.data) : null
  let effects = []
  if (roster && (differences === null || differences.length > 0) && (generation || approvalProblem?.code === 'NOT_APPROVED')) {
    const { consequences } = await import('./agents-check.mjs')
    effects = consequences(generation?.data ?? null, roster.data)
  }
  const result = {
    ok: approvalProblem === null && fileProblem === null,
    file: rosterPath(),
    ...(roster ? { file_hash: roster.hash } : {}),
    approved: generation ? { generation: generation.number, created_at: generation.created_at, roster_file_hash: generation.roster_file_hash, hash: generation.hash } : null,
    ...(approvalProblem ? { approval: { code: approvalProblem.code, message: approvalProblem.message, ...(approvalProblem.lastGood !== undefined ? { last_good_generation: approvalProblem.lastGood } : {}) } } : {}),
    ...(fileProblem ? { file_problem: { code: fileProblem.code, message: fileProblem.message, ...(fileProblem.errors ? { errors: fileProblem.errors } : {}) } } : {}),
    differences,
    consequences: effects,
    history: listGenerations().slice(0, 10)
  }
  if (asJson) {
    out(JSON.stringify(result, null, 2))
  } else {
    const lines = []
    lines.push(generation
      ? `Approved: version ${generation.number} (${generation.created_at}), from roster ${generation.roster_file_hash.slice(0, 12)}`
      : `Approved: none (${approvalProblem.code}: ${approvalProblem.message})`)
    if (fileProblem) {
      lines.push(`Roster file: ${fileProblem.code}: ${fileProblem.message}`)
      for (const entry of fileProblem.errors ?? []) lines.push(`  line ${entry.line ?? '?'}: ${entry.code}: ${entry.message}`)
    } else {
      lines.push(`Roster file: ${roster.path} (${roster.hash.slice(0, 12)})`)
    }
    if (differences !== null) {
      lines.push(differences.length === 0
        ? 'No pending differences: the file matches the approved roster.'
        : `${differences.length} pending difference${differences.length === 1 ? '' : 's'}, none in effect until approved in Preferences > Team:`)
      for (const entry of differences) lines.push(`  ${diffLine(entry)}`)
      if (effects.length > 0) lines.push('If approved:', ...effects.map((effect) => `  ${effect}`))
    } else if (generation === null && roster !== null) {
      lines.push('Nothing takes effect until the first approval in Preferences > Team.')
    }
    out(lines.join('\n'))
  }
  if (approvalProblem) return exitFor(approvalProblem.code)
  if (fileProblem) return exitFor(fileProblem.code)
  return 0
}

function rosterRole(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json'] })
    if (parsed.positionals.length !== 1 || parsed.rest !== null) throw new AgentsUsageError('roster role expects exactly one role id')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  try {
    const generation = approvedData()
    let chain
    try {
      chain = roleChain(generation.data, parsed.positionals[0])
    } catch (error) {
      if (error instanceof RosterError && error.code === 'ROLE_UNKNOWN') {
        if (asJson) out(JSON.stringify({ ok: false, verdict: 'REFUSED', code: 'ROLE_UNKNOWN', message: error.message }, null, 2))
        else err(`bmn: ROLE_UNKNOWN: ${error.message}`)
        return EXIT.refusal
      }
      throw error
    }
    if (asJson) out(JSON.stringify({ ok: true, generation: generation.number, ...chain }, null, 2))
    else out(`${roleChainText(chain)}\n(approved version ${generation.number})`)
    return 0
  } catch (error) {
    return failWith(error, asJson)
  }
}

export async function runRules(argv) {
  const { runRulesCommand } = await import('./agents-rules.mjs')
  return runRulesCommand(argv)
}
