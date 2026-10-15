// MODULE: agents-cli.mjs - Epic 60: `bmn team`, `bmn roster …` and `bmn rules …`, owner commands that need no control socket
import { writeSync } from 'node:fs'
import { RosterError, collisionWords, projectChoiceCollisions, projectChoiceFor, projectChoiceProblem, roleChain, roleChainText, rosterPath, team, teamLine } from './agents-roster.mjs'
import { diffLine, listGenerations, machineDiff, readApproved, readApprovedWithFile, readValidRoster } from './agents-state.mjs'

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

export function err(text) {
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

       bmn team ask --role R (--question TEXT | --question-file PATH|-) [...]   bmn team ask --help
       bmn team asks [show|wait|stop|export <id>]

Prints the approved team, one line per enabled active agent in roster order: id, name, class,
app, model, provider, whether that provider may see private work, roles, efforts and context
limit. --all adds disabled and proposed agents, marked. Reads only the approved team
(Preferences > Team); a roster edit takes effect once the owner approves it there. Exit 5 when
nothing is approved yet, 6 when approved state is corrupt.`

export const ROSTER_USAGE = `Usage: bmn roster validate [--json]          Check ~/.config/bmn/agents/roster.md; exit 4 lists each error and line
       bmn roster status [--json]            Approved version and every pending file difference
       bmn roster role <role> [--project <path>] [--json]
                                             The approved chain: ordered candidates, eligibility, then, rules;
                                             with --project, the owner's choice for the role there
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
       bmn roster fence [--live] [--json]    Owner-run: test that the installed Codex keeps a research run fenced
                                             (a stand-in provider on this computer; bmn roster fence --help)

Machine fields take effect only after the owner approves them in BMN (Preferences > Team); no
command approves (exit 12). Works with BMN closed; only visibility --refresh and fence --live use the network.
Exit: 0 PASS, 2 usage, 3 roster missing, 4 invalid, 5 nothing approved, 6 state corrupt,
10 refusal, 11 receipt stale or invalid.`

/** What `team` and `roster role` answer from: the approved version, and nothing once the team file is gone (60.1 AC4). */
function approvedData() {
  return readApprovedWithFile()
}

export async function runTeam(argv) {
  // Epic 72: `bmn team ask` and `bmn team asks`; a bare `bmn team` is the team as before.
  if (argv[0] === 'ask' || argv[0] === 'asks') {
    const { runTeamAsk, runTeamAsks } = await import('./agents-team-cli.mjs')
    return argv[0] === 'ask' ? runTeamAsk(argv.slice(1)) : runTeamAsks(argv.slice(1))
  }
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
  if (action === 'fence') {
    const { runFenceCommand } = await import('./agents-fence.mjs')
    return runFenceCommand(rest)
  }
  return usage(`roster expects validate, status, role, route, visibility, check, explain, bind or fence, not ${action}`)
}

/**
 * Two choices for one role in one project, its linked worktrees counted as it (73.2 AC1, epic recheck 2): in the file, an approval
 * of it would be refused; in the approved team (a folder became a linked worktree after it was approved), that role's asks there are refused.
 */
async function choiceCollisionNotes(fileChoices) {
  const { canonicalProject } = await import('./agents-team-inputs.mjs')
  const notes = projectChoiceCollisions(fileChoices, canonicalProject).map((group) => ({ code: 'PROJECT_CHOICE_COLLISION', line: null,
    message: `in the file, ${collisionWords(group)}; one choice per project and role, so approving the file is refused until one is removed` }))
  let approved = null
  try {
    approved = readApproved().data.project_choices
  } catch (error) {
    if (!(error instanceof RosterError)) throw error
  }
  for (const group of projectChoiceCollisions(approved, canonicalProject, new Date())) {
    notes.push({ code: 'PROJECT_CHOICE_COLLISION', line: null, message: `in the approved team, ${collisionWords(group)}; asks for ${group.role} there are refused until the owner removes one in the file and approves it` })
  }
  return notes
}

async function rosterValidate(argv) {
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
    const warnings = [...roster.warnings, ...await choiceCollisionNotes(roster.data.project_choices)]
    if (asJson) {
      out(JSON.stringify({ ok: true, file: roster.path, hash: roster.hash, agents: roster.data.agents.length, warnings }, null, 2))
    } else {
      const lines = [`${roster.path} is valid: ${roster.data.agents.length} agent${roster.data.agents.length === 1 ? '' : 's'}, ${roster.data.roles.length} role${roster.data.roles.length === 1 ? '' : 's'}.`]
      for (const warning of warnings) lines.push(`  note, line ${warning.line ?? '?'}: ${warning.code}: ${warning.message}`)
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

/**
 * Each candidate with the items that apply its agent's context limit to a run (60.9 AC2) and those
 * that give the run exactly its agent's tools (60.12 AC5). An app's version is asked once, and only
 * when one of its agents has a limit or tools of its own.
 */
async function withContext(data, chain) {
  const { contextItems, contextTests, provenControls, CONTEXT_CONTROLS } = await import('./agents-context.mjs')
  const { TOOL_APPS, appTools, toolItems, toolsTests } = await import('./agents-tools.mjs')
  const byId = new Map(data.agents.map((agent) => [agent.id, agent]))
  const versions = new Map()
  let tests
  let toolTests
  let versionOf
  const version = async (harness, command) => {
    if (!versions.has(harness)) {
      versionOf ??= (await import('./agents-check.mjs')).harnessVersion
      versions.set(harness, versionOf(command, process.env))
    }
    return versions.get(harness)
  }
  const withTools = async (agent, candidate) => {
    // Once the team lists any tool, every candidate's run is kept to its own set, an empty one too.
    if ((data.tools ?? []).length === 0) return { ...candidate, tools: toolItems(agent, data, { isolation: false, variable: false }) }
    toolTests ??= toolsTests()
    const proven = TOOL_APPS[agent.harness] === undefined ? { isolation: false, variable: false } : appTools(agent.harness, { version: await version(agent.harness, TOOL_APPS[agent.harness].command), tests: toolTests })
    return { ...candidate, tools: toolItems(agent, data, proven) }
  }
  const describe = async (candidate) => {
    const agent = byId.get(candidate.agent)
    // An agent called by BMN takes no dispatch: it has no command to carry a context limit or tools.
    if (agent === undefined || agent.harness === 'bmn') return candidate
    if (agent.context_limit === undefined || CONTEXT_CONTROLS[agent.harness] === undefined) return withTools(agent, { ...candidate, context: contextItems(agent, { limit: false, compact: false }) })
    tests ??= contextTests()
    return withTools(agent, { ...candidate, context: contextItems(agent, provenControls(agent.harness, await version(agent.harness, CONTEXT_CONTROLS[agent.harness].command), tests)) })
  }
  // For a read-only role each candidate carries what its command must hold, by its app (63.2).
  const READ_ONLY_ITEMS = chain.read_only === true ? (await import('./agents-check.mjs')).READ_ONLY_ITEMS : {}
  // An OpenCode candidate runs only in the one form the check reads (70.2): BMN puts its folder in place
  // here and hands over the environment and arguments, whatever the role.
  let openCode
  const held = async (candidate) => {
    const described = await describe(candidate)
    const harness = byId.get(candidate.agent)?.harness
    if (harness === 'opencode') {
      openCode ??= (await import('./agents-opencode.mjs')).installOpenCodeFolder()
      const { folder, ...items } = openCode
      return { ...described, opencode: { folder, ...items }, ...(chain.read_only === true ? { read_only: { argv: items.argv.slice(items.argv.indexOf('--agent'), items.argv.indexOf('--agent') + 2), harness: 'opencode' } } : {}) }
    }
    const items = chain.read_only === true ? READ_ONLY_ITEMS[harness] : undefined
    return items === undefined ? described : { ...described, read_only: { argv: items } }
  }
  const candidates = []
  for (const candidate of chain.candidates) candidates.push(await held(candidate))
  return { ...chain, candidates, ...(chain.small_work === undefined ? {} : { small_work: await held(chain.small_work) }) }
}

/** The roles whose runs look things up, and the one line that tells them how (64.2 AC3). */
export const WEB_QUESTION_ROLES = ['helper', 'browser']
export const WEB_QUESTION_LINE = 'to search the web, ask with `bmn research ask` (the question on standard input, or --question-file)'

/**
 * What the project's approved choice for a role means now (73.2 AC3, AC4): who it names and whether
 * it applies, cannot be asked, or ended. A choice for a repository covers its linked worktrees.
 */
async function projectChoiceView(data, roleId, named) {
  const { askProject, canonicalProject } = await import('./agents-team-inputs.mjs')
  const project = askProject(named)
  const canonical = canonicalProject(project)
  const found = projectChoiceFor(data, canonical, roleId, canonicalProject)
  if (found === null) return { project, project_choice: null }
  // Two choices that still apply there decide nothing: the role's asks are refused until the owner removes one (epic recheck 2).
  if (found.collision !== undefined) {
    return { project, project_choice: { state: 'collision', role: roleId, project: canonical, ids: found.collision.choices.map((choice) => choice.id), choices: found.collision.choices, reason: collisionWords(found.collision) } }
  }
  const { choice, ended } = found
  const problem = ended ? null : projectChoiceProblem(data, choice)
  return {
    project,
    project_choice: { ...choice, state: ended ? 'ended' : problem === null ? 'applies' : 'unavailable', ...(problem === null ? {} : { reason: problem }), ...(project !== canonical ? { worktree_of: canonical } : {}) }
  }
}

function projectChoiceText(view) {
  const choice = view.project_choice
  const where = `  project ${view.project}: `
  if (choice === null) return `${where}no choice of the owner's; the chain applies`
  if (choice.state === 'collision') return `${where}${choice.reason}; asks for the role there are refused until the owner removes one of them`
  const named = `${choice.agent}${choice.effort === undefined ? '' : `@${choice.effort}`}`
  if (choice.state === 'ended') return `${where}the owner's choice ${choice.id} (${named}) ended on ${choice.ends}; the chain applies`
  if (choice.state === 'unavailable') return `${where}the owner's choice ${choice.id} names ${named}, which cannot be asked now: ${choice.reason}; asks for the role there are refused until the owner changes the choice`
  return `${where}${named} by the owner's choice ${choice.id}${choice.ends === undefined ? '' : ` until ${choice.ends}`}; asks there go to ${choice.agent}, and naming someone else is refused (whether its app can answer and the ask's data may reach it is judged per ask)`
}

async function rosterRole(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json'], values: ['project'] })
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
      chain = await withContext(generation.data, roleChain(generation.data, parsed.positionals[0]))
    } catch (error) {
      if (error instanceof RosterError && error.code === 'ROLE_UNKNOWN') {
        if (asJson) out(JSON.stringify({ ok: false, verdict: 'REFUSED', code: 'ROLE_UNKNOWN', message: error.message }, null, 2))
        else err(`bmn: ROLE_UNKNOWN: ${error.message}`)
        return EXIT.refusal
      }
      throw error
    }
    let choice
    try {
      choice = parsed.options.project === undefined ? undefined : await projectChoiceView(generation.data, chain.role, parsed.options.project)
    } catch (error) {
      if (error?.code === 'PROJECT_INVALID') {
        if (asJson) out(JSON.stringify({ ok: false, verdict: 'REFUSED', code: error.code, message: error.message }, null, 2))
        else err(`bmn: ${error.code}: ${error.message}`)
        return EXIT.refusal
      }
      throw error
    }
    // A run for one of these roles is the one that goes looking things up (64.2 AC3).
    const web = WEB_QUESTION_ROLES.includes(chain.role) ? WEB_QUESTION_LINE : undefined
    if (asJson) out(JSON.stringify({ ok: true, generation: generation.number, ...chain, ...(web === undefined ? {} : { web_question: web }), ...(choice ?? {}) }, null, 2))
    else out(`${roleChainText(chain)}${web === undefined ? '' : `\n  web: ${web}`}${choice === undefined ? '' : `\n${projectChoiceText(choice)}`}\n(approved version ${generation.number})`)
    return 0
  } catch (error) {
    return failWith(error, asJson)
  }
}

export async function runRules(argv) {
  const { runRulesCommand } = await import('./agents-rules.mjs')
  return runRulesCommand(argv)
}

export async function runSkills(argv) {
  const { runSkillsCommand } = await import('./agents-skills.mjs')
  return runSkillsCommand(argv)
}

export async function runTools(argv) {
  const { runToolsCommand } = await import('./agents-tools.mjs')
  return runToolsCommand(argv)
}

export async function runContext(argv) {
  const { runContextCommand } = await import('./agents-context.mjs')
  return runContextCommand(argv)
}
