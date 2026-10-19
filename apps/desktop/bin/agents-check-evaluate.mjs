// MODULE: agents-check-evaluate.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: evaluating a dispatch, a research run and the fence test's record
import { lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { APP_NAMES, agentState, canonicalJson, classRefusal, isCalled, namedResearchers, retiredWords, roleEfforts, sha256 } from './agents-roster.mjs'
import { readApproved, readValidRoster, stateDirectory } from './agents-state.mjs'
import { CLAUDE_CONTEXT_KEY, checkContext, provenControls, provenPrecedence } from './agents-context.mjs'
import { appTools, checkRunTools } from './agents-tools.mjs'
import { OPENCODE_FOLDER_SHA256, OPENCODE_FORM_TESTED, OPENCODE_HELPER_AGENT, OPENCODE_HELPER_AGENT_SHA256, OPENCODE_RESEARCH_AGENT, installOpenCodeFolder, openCodeEnvironment } from './agents-opencode.mjs'
import { NEXT_STEP, OPENCODE_NEXT_STEP, RESEARCH_FENCE_VERSIONS, RESUME_TESTED_VERSIONS, Refusal, TESTED_HARNESS_VERSIONS, WEB_NEXT_STEP, WEB_TOOLS_NOTE, listDirectory, namesWebTool, reachedForWeb, readText, refuse } from './agents-check-base.mjs'
import { dispatchEnvironment, harnessOf, parseDispatch } from './agents-check-argv.mjs'
import { resolveClaudeRoute, resolveCodexRoute, resolveOpenCodeRoute } from './agents-check-routes.mjs'
import { boundSession, canonicalDirectory, committedBlob, destinationOf, ensurePrivateDirectory, harnessVersion, hashFile, inside, isObject, isString, packetManifest, privateWorkAnswer, readReceiptFile, receiptHash, sessionRecord, stricter, workspaceRoot, workspaceVisibility, writeState } from './agents-check-workspace.mjs'

export { activeAgent, checkModelAndEffort, checkRoleEffort, matchedDestination, receiptAnswer, receiptRoute }

// ---------------------------------------------------------------------------------------------
// Evaluating a dispatch

/** The approved agent a check is about, or the first refusal that applies to it. */
function activeAgent(generation, id) {
  const agent = generation.data.agents.find((candidate) => candidate.id === id)
  if (agent === undefined) refuse('UNKNOWN_AGENT', `no agent ${id} in approved version ${generation.number}`)
  // An agent BMN itself calls runs in no agent app: there is no command of it to check (65.1 AC4).
  if (isCalled(agent)) refuse('CALLED_BY_BMN', `${agent.id} is called by BMN itself and runs in no agent app, so no dispatch command is checked for it`)
  const state = agentState(agent)
  if (state === 'retired') refuse('APP_RETIRED', `${agent.id} runs in ${retiredWords(agent.harness)}`)
  if (state === 'proposed') refuse('PROPOSED', `${agent.id} is proposed, not approved as active`)
  if (state === 'disabled') refuse('DISABLED', `${agent.id} is disabled`)
  return agent
}

function checkModelAndEffort(agent, resolution, note) {
  const model = resolution.model
  if (model === null) refuse('MODEL_MISMATCH', `the command names no model; ${agent.id} is ${agent.model}`)
  if (model.value !== agent.model && !(agent.aliases ?? []).includes(model.value)) {
    refuse('MODEL_MISMATCH', `${model.source} ${model.value} is not ${agent.model}${agent.aliases?.length ? ` or ${agent.aliases.join(', ')}` : ''}`)
  }
  note(`model ${model.value} (${model.source})`)
  const effort = resolution.effort
  if (effort === null) refuse('EFFORT_UNSUPPORTED', 'the command names no effort')
  if (!agent.efforts.includes(effort.value)) refuse('EFFORT_UNSUPPORTED', `${effort.source} ${effort.value} is not among ${agent.id}'s efforts (${agent.efforts.join(', ')})`)
  note(`effort ${effort.value} (${effort.source})`)
  return { model, effort }
}

/** A role that names efforts for the agent allows no other, also where the agent itself lists it (63.2 AC1). */
function checkRoleEffort(role, agent, effort, note) {
  const named = roleEfforts(role, agent.id)
  if (named.length === 0) return
  if (!named.includes(effort.value)) {
    refuse('EFFORT_UNSUPPORTED', `${effort.source} ${effort.value} is not an effort the role ${role.id} names for ${agent.id} (${named.join(', ')})`, `role ${role.id} allows ${named.join(', ')}`)
  }
  note(`role ${role.id} names ${named.join(', ')} for ${agent.id}`)
}

/** The Claude Code tools that cannot change a file: the only ones a run for a read-only role may be given (63.2 AC3). */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
/**
 * The owner-authorized write-attempt test behind the Claude Code form (2026-10-11, Haiku, empty
 * throwaway folders; `scripts/test/claude-write-attempt.sh`, results in docs/agent-control.md). With a
 * tool list of Read, Grep and Glob and no MCP server the run is offered exactly those three tools,
 * with or without --safe-mode. The tool list alone is not enough: the owner's MCP tools stay offered.
 * `--permission-mode plan` is not accepted: the app refused the Write tool, but no shell command was
 * attempted under it, and with the owner's settings his MCP tools stay offered there too.
 */
export const CLAUDE_READ_ONLY_TESTED = { version: '2.1.296', on: '2026-10-11' }
/** What a command for a read-only role must carry, per app, as `bmn roster role --json` hands it out. */
export const READ_ONLY_ITEMS = {
  codex: ['--sandbox', 'read-only', '-c', 'approval_policy="never"'],
  claude: ['--tools', CLAUDE_READ_ONLY_TOOLS.join(','), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
}

/**
 * A run for a role the approved team marks read-only must not be able to write (63.2 AC2, AC3).
 * Codex: the sandbox resolves to read-only and approvals to never, from the command, the selected
 * profile or the owner's own file. Claude Code: the one form the write-attempt test showed. Returns
 * what the receipt records, or refuses with READ_ONLY_REQUIRED and says what the command must carry.
 */
function checkReadOnly(role, parsed, resolution, version, note) {
  const stop = (why, must) => refuse('READ_ONLY_REQUIRED', `${role.id} is a read-only role and ${why}; the command must carry ${must}`)
  if (parsed.harness === 'opencode') {
    // The only OpenCode form the check reads runs BMN's own agent from BMN's own folder, both checked whole above.
    note(`read-only role: BMN's agent ${OPENCODE_HELPER_AGENT} (only reading inside the project; the form shown on OpenCode ${OPENCODE_FORM_TESTED.version}${version === OPENCODE_FORM_TESTED.version ? '' : `; this is ${version ?? 'a version BMN cannot read'}`})`)
    return { mode: 'read-only', source: `--agent ${OPENCODE_HELPER_AGENT}`, agent_sha256: OPENCODE_HELPER_AGENT_SHA256, form_tested_on: OPENCODE_FORM_TESTED.version }
  }
  if (parsed.harness === 'codex') {
    const must = '--sandbox read-only and -c approval_policy="never"'
    const { sandbox, approvals } = resolution.access
    if (sandbox === null) stop('the command names no sandbox', must)
    if (sandbox.unresolved) stop(`its sandbox cannot be resolved: ${sandbox.unresolved}`, must)
    if (sandbox.value !== 'read-only') stop(`${sandbox.source} gives the run the ${sandbox.value} sandbox`, must)
    if (approvals === null) stop('nothing says the run may never ask for more access', must)
    if (approvals.unresolved) stop(`whether it may ask for more access cannot be resolved: ${approvals.unresolved}`, must)
    if (approvals.value !== 'never') stop(`${approvals.source} lets the run ask for more access (${approvals.value})`, must)
    note(`read-only role: sandbox read-only (${sandbox.source}), approvals never (${approvals.source})`)
    return { mode: 'read-only', source: sandbox.source, approval_policy: 'never', approval_source: approvals.source }
  }
  const must = `--tools naming only ${CLAUDE_READ_ONLY_TOOLS.join(', ')} (or '' for none), --strict-mcp-config and --mcp-config '{"mcpServers":{}}'`
  if (parsed.tools === undefined) stop('the command names no tool list, so the run gets the tools that write', must)
  const names = parsed.tools.split(/[,\s]+/).filter((name) => name !== '')
  const writing = names.filter((name) => !CLAUDE_READ_ONLY_TOOLS.includes(name))
  if (writing.length > 0) stop(`--tools gives the run ${writing.join(', ')}`, must)
  if (!parsed.strictMcp) stop('without --strict-mcp-config the run is offered your MCP tools, which BMN cannot hold to reading', must)
  // The form the write-attempt test showed names an empty server list; the same command without one was not tried, so it is not accepted.
  if (parsed.mcpConfig === undefined) stop('the command names no empty MCP server list, which is part of the form the write test showed', must)
  if (!emptyMcpConfig(parsed.mcpConfig)) stop('--mcp-config gives the run an MCP server, which BMN cannot hold to reading', must)
  if (parsed.permissionMode === 'bypassPermissions') stop('--permission-mode bypassPermissions switches every permission check off', must)
  note(`read-only role: tools ${names.join(', ') || 'none'}, no MCP server (the form shown on Claude Code ${CLAUDE_READ_ONLY_TESTED.version}${version === CLAUDE_READ_ONLY_TESTED.version ? '' : `; this is ${version ?? 'a version BMN cannot read'}`})`)
  return { mode: 'read-only', source: '--tools', tools: names, form_tested_on: CLAUDE_READ_ONLY_TESTED.version }
}

/** The destination the command reaches, matched against the agent's approved host (60.3 AC4). */
function matchedDestination(data, agent, harness, route, note) {
  const destination = destinationOf(data, harness, route)
  if (!destination.known) refuse('HOST_UNKNOWN', `the destination cannot be resolved: ${destination.reason}`)
  if (agent.host === null) refuse('HOST_UNKNOWN', `${agent.id}'s approved host is unknown (null)`)
  if (agent.host === 'default') {
    if (!destination.default || destination.unapproved !== undefined || destination.provider !== agent.provider) {
      refuse('HOST_MISMATCH', `the command reaches ${destination.host}, the roster approved default:${agent.provider}`)
    }
  } else if (destination.default || destination.host !== agent.host.toLowerCase()) {
    refuse('HOST_MISMATCH', `the command reaches ${destination.host}, the roster approved ${agent.host}`)
  } else if (destination.provider !== agent.provider) {
    refuse('HOST_UNKNOWN', `no provider in the approved roster lists ${destination.host} as ${agent.provider}'s host`)
  }
  note(`destination ${destination.host}, provider ${destination.provider} (${destination.basis}${route.sources.length ? `; decided by ${route.sources.join(', ')}` : ''})`)
  return destination
}

/** Whether dotted version `a` is later than `b`; false when either does not read as numbers. */
function laterVersion(a, b) {
  const parts = (text) => text.split(/[-+]/)[0].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
  const [left, right] = [parts(a), parts(b)]
  if ([...left, ...right].some(Number.isNaN)) return false
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

/**
 * The word beside an app's version: `tested`, `newer than BMN tested`, `not a version BMN tested`
 * or `version unreadable`. It refuses nothing; BMN reads where an app sends data the same way on
 * every version.
 */
export function versionStanding(harness, version, tested = TESTED_HARNESS_VERSIONS) {
  if (version === null) return { tested: false, state: 'version unreadable' }
  const known = tested[harness] ?? []
  if (known.includes(version)) return { tested: true, state: 'tested' }
  const newer = known.length > 0 && known.every((entry) => laterVersion(version, entry))
  return { tested: false, state: newer ? 'newer than BMN tested' : 'not a version BMN tested' }
}

function receiptRoute(destination, route) {
  return { provider: destination.provider, host: destination.host, basis: destination.basis, sources: route.sources, harness_provider: destination.harness_provider }
}

function receiptAnswer(answer) {
  return { answer: answer.answer, allowed: answer.allowed, ...(answer.exception ? { exception: answer.exception } : {}) }
}

/**
 * Evaluates one dispatch against the approved generation. Returns `{ verdict: 'PASS', receipt, steps }`
 * or `{ verdict: 'REFUSED', code, message, next, steps }`; `steps` is what `explain` prints.
 * `publicRules` is the public rules rendering a packet's --append-system-prompt must equal;
 * `testedVersions` and `resumeVersions` are the tests' seams for the version lists.
 */
export function evaluate(inputs, {
  environment = process.env, cwd: processCwd = process.cwd(), publicRules = null, now = new Date(),
  testedVersions = TESTED_HARNESS_VERSIONS, resumeVersions = RESUME_TESTED_VERSIONS, contextTestLog = undefined, toolsTestLog = undefined, toolsPolicyRoot = undefined
} = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
    // A missing or invalid team file stops here (R60-NFR1); a valid one that differs from the approved version is a pending edit.
    const file = readValidRoster()
    const generation = readApproved()
    const data = generation.data
    note(`approved version ${generation.number}`)
    const agent = activeAgent(generation, inputs.agent)
    note(`agent ${agent.id}: ${agent.class}, ${agent.harness} ${agent.model}, provider ${agent.provider}`)
    const role = data.roles.find((candidate) => candidate.id === inputs.role)
    if (role === undefined) refuse('ROLE_UNKNOWN', `no role ${inputs.role} in the approved ## roles`)
    if (!agent.roles.includes(role.id)) refuse('ROLE_INELIGIBLE', `${agent.id} does not hold role ${role.id}`)
    const classRule = classRefusal(agent.class, role.id)
    if (classRule !== null) refuse(classRule.code, `${agent.id} is a ${agent.class}; ${classRule.rule}`)
    note(`role ${role.id}: held`)

    const parsed = parseDispatch(inputs.argv)
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    if (parsed.ephemeral) refuse('ROUTE_UNSUPPORTED', 'codex exec --ephemeral belongs to a research run (bmn roster check --research)')
    if (agent.harness !== parsed.harness) {
      refuse('ROUTE_UNSUPPORTED', `${agent.id} runs on ${agent.harness}, the command is ${parsed.harness}`)
    }
    const cwd = canonicalDirectory(inputs.cwd ?? processCwd, processCwd)
    const resolution = parsed.harness === 'codex'
      ? resolveCodexRoute(parsed, environment, cwd ?? processCwd)
      : parsed.harness === 'opencode' ? resolveOpenCodeRoute(parsed) : resolveClaudeRoute(parsed, environment, cwd ?? processCwd)
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    if (parsed.resume && !(version !== null && (resumeVersions[parsed.harness] ?? []).includes(version))) {
      refuse('ROUTE_UNSUPPORTED', `resume is not checked on ${parsed.harness} ${version ?? '(version unreadable)'}: BMN has not tested that a resume on this version talks to the current configuration's destination; start a fresh checked dispatch`)
    }
    note(`dispatch form: ${parsed.envMode === 'clean' ? 'env -i ' : ''}${parsed.harness === 'codex' ? `codex exec${parsed.resume ? ' resume' : ''}` : parsed.harness === 'opencode' ? 'opencode run' : 'claude -p'}`)
    // The tools of this run (60.12 AC5): once the team lists any, the run is kept to exactly its agent's set and
    // shut off from everything else, judged with the run's own environment and the folder it works in (Codex's
    // `-C` where it gives one). The test log is read only then. A version without a run seen kept to its tools,
    // or a place its test did not cover, is refused here; a wrong set further down, each in its place in the order.
    const packetRun = inputs.packet !== undefined
    const runFolder = cwd ?? processCwd
    const tools = checkRunTools(agent, data, parsed,
      (data.tools ?? []).length > 0 ? appTools(parsed.harness, { version, tests: toolsTestLog }) : { isolation: false, variable: false },
      { packet: packetRun, profile: typeof resolution.profile === 'string', environment: dispatchEnvironment(parsed, environment),
        cwd: parsed.cd === undefined ? runFolder : (canonicalDirectory(parsed.cd, runFolder) ?? null), ...(toolsPolicyRoot === undefined ? {} : { policyRoot: toolsPolicyRoot }) })
    if (tools.refusal?.code === 'ROUTE_UNSUPPORTED') refuse('ROUTE_UNSUPPORTED', tools.refusal.message)

    // OpenCode names a model with its provider; an agent that names the model alone is read with its provider.
    const named = parsed.harness === 'opencode' && !agent.model.includes('/') ? { ...agent, model: `${agent.provider}/${agent.model}` } : agent
    const { model, effort } = checkModelAndEffort(named, resolution, note)
    checkRoleEffort(role, agent, effort, note)
    // A role that may write is judged as before and its receipt carries nothing more (63.2 AC5).
    const readOnly = role.read_only === true ? checkReadOnly(role, parsed, resolution, version, note) : null
    // Required only where the owner's test proved the setting on this version (60.9 AC1, AC2).
    // The test log is read only for an agent that has a limit.
    const context = checkContext(agent, resolution.context, agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(parsed.harness, version, contextTestLog),
      agent.context_limit === undefined ? [] : provenPrecedence(parsed.harness, version, contextTestLog))
    if (context.refusal) refuse('CONTEXT_MISMATCH', context.refusal, context.why)
    note(context.note)
    if (tools.refusal) refuse(tools.refusal.code, tools.refusal.message)
    note(tools.note)
    const route = resolution.route
    const destination = matchedDestination(data, agent, parsed.harness, route, note)

    if (typeof inputs.workspace !== 'string' || inputs.workspace.split('/').includes('..')) refuse('WORKSPACE_UNKNOWN', 'the workspace path contains ..')
    const workspace = canonicalDirectory(inputs.workspace, processCwd)
    if (workspace === null) refuse('WORKSPACE_UNKNOWN', `${inputs.workspace} is not an existing directory`)
    // The home folder and / hold every project, sign-in and configuration: never one workspace (R72-FR9).
    const homes = [environment.HOME, homedir()].filter((path) => typeof path === 'string' && isAbsolute(path)).flatMap((path) => {
      // Only where the home folder really is: no file in it is opened.
      try {
        return [realpathSync(path)]
      } catch {
        return [path]
      }
    })
    if (workspace === '/' || homes.includes(workspace)) refuse('WORKSPACE_UNKNOWN', `${workspace === '/' ? '/ is the whole file system' : `${workspace} is the home folder`}, never a workspace: name the project folder the dispatch works in`)
    if (cwd === null) refuse('WORKSPACE_MISMATCH', `--cwd ${inputs.cwd} is not an existing directory without ..`)
    // An unreadable packet is a packet refusal, reported in its place in the order, after every earlier one.
    const packet = inputs.packet === undefined ? null : canonicalDirectory(inputs.packet, processCwd)
    const packetMissing = inputs.packet !== undefined && packet === null
    const within = (dir) => inside(dir, workspace) || (packet !== null && inside(dir, packet))
    if (!within(cwd)) refuse('WORKSPACE_MISMATCH', `cwd ${cwd} is outside the workspace${packet ? ' and the packet' : ''}`)
    // Every directory the agent would work in.
    const reached = [cwd]
    if (parsed.cd !== undefined) {
      const target = canonicalDirectory(parsed.cd, cwd)
      if (target === null || !within(target)) refuse('WORKSPACE_MISMATCH', `-C ${parsed.cd} is outside the workspace${packet ? ' and the packet' : ''}`)
      reached.push(target)
    }
    for (const dir of parsed.addDir ?? []) {
      const target = canonicalDirectory(dir, cwd)
      if (target === null || !inside(target, workspace)) refuse('WORKSPACE_MISMATCH', `--add-dir ${dir} is outside the workspace`)
      reached.push(target)
    }
    // An exception and a public record belong to one workspace root. A directory with another root
    // (a repository nested in the workspace, a subfolder of a workspace outside Git) or in a packet
    // outside it is another workspace (60.8 AC6): the exception does not cover the dispatch, and
    // work in a nested workspace is private.
    const root = workspaceRoot(workspace)
    const nested = reached.find((dir) => inside(dir, workspace) && workspaceRoot(dir) !== root)
    const answer = privateWorkAnswer(data, destination, nested === undefined && reached.every((dir) => inside(dir, workspace)) ? root : null)
    note(`private work: ${answer.reason}`)
    const visibility = workspaceVisibility(workspace, now)
    const dataLabel = stricter(stricter(visibility.public ? 'public' : 'private', inputs.data), nested === undefined ? 'public' : 'private')
    note(`workspace ${workspace}: ${visibility.public ? `public (${visibility.reason})` : `private (${visibility.reason})`}; data ${dataLabel}${nested === undefined ? '' : ` (${nested} is another workspace inside this one)`}`)
    let stdin = null
    let stdinProblem = null
    if (inputs.stdin !== undefined) {
      const path = isAbsolute(inputs.stdin) ? inputs.stdin : `${cwd}/${inputs.stdin}`
      try {
        stdin = { path: realpathSync(path), sha256: hashFile(realpathSync(path)) }
      } catch {
        stdinProblem = `--stdin ${inputs.stdin} cannot be read`
      }
    }
    // For a destination that may receive private work an unreadable prompt is a workspace problem,
    // reported here; for a public-only one it is a packet problem, reported last.
    if (stdinProblem !== null && answer.allowed && inputs.packet === undefined) refuse('WORKSPACE_MISMATCH', stdinProblem)

    let resume = null
    if (parsed.resume) {
      if (packet !== null) refuse('RESUME_UNBOUND', 'a resume never passes in packet mode')
      if (inputs.resumeOf === undefined) refuse('RESUME_UNBOUND', 'codex exec resume needs --resume-of <receipt of the dispatch that started it>')
      const original = readReceiptFile(inputs.resumeOf)
      if (original === null) refuse('RESUME_UNBOUND', `${inputs.resumeOf} is not an intact version-1 receipt`)
      if (boundSession(original.receipt_hash) !== parsed.resume.id) {
        refuse('RESUME_UNBOUND', `BMN holds no binding of that receipt to session ${parsed.resume.id} (bmn roster bind, when the session starts)`)
      }
      const same = original.mode === 'dispatch' && original.agent === agent.id && original.model === model.value && original.harness === parsed.harness
        && original.workspace === workspace && original.public_status?.public === visibility.public
        && canonicalJson(original.route) === canonicalJson(receiptRoute(destination, route))
      if (!same) refuse('RESUME_UNBOUND', 'the original receipt\'s agent, model, workspace, public status or destination differs from this dispatch')
      const record = sessionRecord(resolution.configHome, parsed.resume.id)
      if (record === null) refuse('RESUME_UNBOUND', `no single readable Codex session record for ${parsed.resume.id}`)
      let recordCwd = null
      try {
        recordCwd = typeof record.cwd === 'string' ? realpathSync(record.cwd) : null
      } catch {
        recordCwd = null
      }
      if (record.id !== parsed.resume.id || recordCwd === null || !inside(recordCwd, workspace) || record.provider !== original.route.harness_provider) {
        refuse('RESUME_UNBOUND', 'the session record\'s id, cwd or provider does not match this dispatch')
      }
      resume = { session_id: parsed.resume.id, original_receipt_hash: original.receipt_hash, original_receipt: inputs.resumeOf, data: original.data }
      note(`resume bound to receipt ${original.receipt_hash.slice(0, 12)} and session ${parsed.resume.id}`)
    }
    const effectiveData = resume === null ? dataLabel : stricter(dataLabel, resume.data)

    if (effectiveData === 'private' && version === null) {
      refuse('HARNESS_UNKNOWN', `${parsed.harness}: BMN cannot read this app's version, so it cannot tell which program would run`)
    }
    const standing = versionStanding(parsed.harness, version, testedVersions)
    note(`${parsed.harness} ${version ?? '(version unreadable)'}: ${standing.state}`)

    let manifest = null
    if (!answer.allowed) {
      if (effectiveData === 'private') refuse('DATA_FORBIDDEN', `private work never goes there: ${answer.reason}`)
      if (parsed.harness !== 'claude') refuse('PACKET_INVALID', `public work reaches a public-only destination only as a packet through claude -p, not ${parsed.harness}`)
      if (packetMissing) refuse('PACKET_INVALID', `--packet ${inputs.packet} is not an existing directory`)
      if (packet === null) refuse('PACKET_INVALID', 'a public-only destination receives public work only in packet mode (--packet)')
      if (parsed.envMode !== 'clean') refuse('PACKET_INVALID', 'packet mode needs env -i')
      if (!parsed.safeMode) refuse('PACKET_INVALID', 'packet mode needs --safe-mode')
      if (parsed.tools !== '') refuse('PACKET_INVALID', "packet mode needs --tools ''")
      if (parsed.addDir.length > 0) refuse('PACKET_INVALID', 'packet mode allows no --add-dir')
      if (parsed.settings !== undefined) refuse('PACKET_INVALID', 'packet mode allows no --settings')
      if (parsed.mcpConfig !== undefined && !emptyMcpConfig(parsed.mcpConfig)) refuse('PACKET_INVALID', 'packet mode allows only an empty --mcp-config')
      if (!inside(cwd, packet)) refuse('PACKET_INVALID', 'packet mode runs from inside the packet')
      if (stdinProblem !== null) refuse('PACKET_INVALID', stdinProblem)
      if (stdin === null || !inside(stdin.path, packet)) refuse('PACKET_INVALID', '--stdin must name the prompt file inside the packet')
      if (parsed.appendSystemPrompt !== undefined && parsed.appendSystemPrompt !== (typeof publicRules === 'function' ? publicRules() : publicRules)) {
        refuse('PACKET_INVALID', '--append-system-prompt must be the public rules rendering or absent')
      }
      if (!visibility.public) refuse('PACKET_INVALID', `the workspace whose files the packet carries is not proven public (${visibility.reason}); run bmn roster visibility --refresh`)
      manifest = packetManifest(packet)
      const prompt = relative(packet, stdin.path).split(sep).join('/')
      for (const file of manifest) {
        if (file.name === prompt) continue
        const blob = committedBlob(workspace, visibility.record.commit, file.name)
        if (blob === null || sha256(blob) !== file.sha256) {
          refuse('PACKET_INVALID', `${file.name} is not byte-identical to a file in commit ${visibility.record.commit.slice(0, 12)}, the one GitHub serves for ${visibility.record.origin}`)
        }
      }
      note(`packet ${packet}: ${manifest.length} file(s); the prompt is lead-authored, not verified`)
    } else if (packetMissing) {
      refuse('PACKET_INVALID', `--packet ${inputs.packet} is not an existing directory`)
    } else if (stdinProblem !== null) {
      refuse('PACKET_INVALID', stdinProblem)
    } else if (packet !== null) {
      manifest = packetManifest(packet)
    }

    const body = {
      version: 1, mode: 'dispatch', verdict: 'PASS', agent: agent.id, class: agent.class, harness: parsed.harness, model: model.value,
      role: role.id, effort: effort.value, context_limit_applied: context.applied,
      // A limit of the agent's own that this run does not get, with the reason: whether BMN will test the version by itself or its own testing is switched off (63.1).
      ...(agent.context_limit !== undefined && context.applied === null ? { context_limit_note: context.note } : {}),
      // What the check saw of a read-only role's run: its sandbox and approvals (Codex) or its tool list (Claude Code).
      ...(readOnly === null ? {} : { sandbox: readOnly }),
      // The tools this run was given and a hash of their definitions: variable names, never a value.
      // Bound whenever the run was kept to a set, an empty one too; a run of a team without tools carries no such entry.
      // A run whose tools BMN could not judge (Codex) says so, so no receipt reads as kept to a set that was not checked.
      ...(tools.hash !== undefined ? { tools: { applied: tools.applied, sha256: tools.hash } } : tools.unchecked ? { tools: { checked: false } } : {}),
      workspace, cwd,
      public_status: { public: visibility.public, reason: visibility.reason, ...(visibility.public ? { commit: visibility.record.commit } : {}) },
      data: effectiveData,
      argv_sha256: sha256(canonicalJson(inputs.argv)),
      harness_version: { version, state: standing.state },
      route: receiptRoute(destination, route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: file.hash,
      ...(resume ? { resume: { session_id: resume.session_id, original_receipt_hash: resume.original_receipt_hash, original_receipt: resume.original_receipt } } : {}),
      ...(packet !== null ? { packet: { path: packet, manifest, prompt: 'lead-authored, not verified' } } : {}),
      ...(stdin !== null ? { stdin } : {}),
      issued_at: now.toISOString()
    }
    // Said beside the PASS, never inside the receipt: what passed and its receipt stay what they were.
    const webNote = parsed.harness === 'claude' && namesWebTool(parsed.tools)
    if (webNote) note(WEB_TOOLS_NOTE)
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps, ...(webNote ? { note: WEB_TOOLS_NOTE } : {}) }
  } catch (error) {
    if (error instanceof Refusal) {
      const next = error.code === 'ROUTE_UNSUPPORTED' && Array.isArray(inputs.argv) && reachedForWeb(inputs.argv, error.message) ? WEB_NEXT_STEP
        : error.code === 'ROUTE_UNSUPPORTED' && openCodeCommand(inputs.argv) ? OPENCODE_NEXT_STEP : NEXT_STEP[error.code]
      return { verdict: 'REFUSED', code: error.code, message: error.message, next, steps, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    }
    throw error
  }
}

/** Whether a refused command is an OpenCode one, so its next step names the OpenCode form. */
function openCodeCommand(argv) {
  if (!Array.isArray(argv)) return false
  const index = argv.length > 0 && basename(argv[0]) === 'env' ? argv.findIndex((argument, position) => position > 0 && argument !== '-i' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) : 0
  return index >= 0 && typeof argv[index] === 'string' && harnessOf(argv[index]) === 'opencode'
}

function emptyMcpConfig(text) {
  try {
    const servers = JSON.parse(text)?.mcpServers
    return isObject(servers) && Object.keys(servers).length === 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Research runs (60.3 AC11)

export const RESEARCH_TOOLS = 'WebSearch,WebFetch'
/** What a research run's `env -i` may carry: where the app lives, how to find it, its destination and the agent's context limit. */
const RESEARCH_ENVIRONMENT = {
  claude: ['HOME', 'PATH', 'ANTHROPIC_BASE_URL', CLAUDE_CONTEXT_KEY], codex: ['HOME', 'PATH', 'CODEX_HOME'],
  // OpenCode's are BMN's folder and switches, each with its one value, which the route reader holds the run to.
  opencode: ['PATH', ...Object.keys(openCodeEnvironment('/'))]
}
/**
 * The `-c` items every Codex research run carries: no MCP server, live web search, none of the
 * tools that run a command, start another agent or reach a connected app, and none of the texts
 * Codex adds by itself (skills, connected apps, how to work with other agents, the machine and
 * folder it runs in, a project's rules file). Codex has no list of allowed tools, so its research
 * form is these switches, the features below switched off by name, a read-only sandbox and a Codex
 * folder of the run's own: no setting keeps Codex from sending the rules file of the folder it is
 * signed in from (63.3, the fence test of 2026-10-11).
 */
export const CODEX_RESEARCH_CONFIG = ['mcp_servers={}', 'web_search="live"', 'features.shell_tool=false', 'features.unified_exec=false',
  'features.multi_agent=false', 'features.apps=false', 'features.plugins=false', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'include_apps_instructions=false', 'include_collaboration_mode_instructions=false', 'include_environment_context=false', 'project_doc_max_bytes=0']
/** The features a Codex research run switches off by name: reading a picture, goals, drawing, sleeping and hooks. */
/** The settings a research command names for itself beside the fixed ones: the agent's effort and its context limit. */
const CODEX_RESEARCH_OWN_KEYS = ['model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit']
export const CODEX_RESEARCH_DISABLED = ['view_image', 'goals', 'image_generation', 'sleep_tool', 'hooks']
/** The file a Codex research run writes its answer to, beside the prompt and outside the empty folder. */
export const CODEX_RESEARCH_ANSWER = 'answer.md'
/** The Codex folder of one research run, inside the run's own folder, and the one thing in it: a link to the owner's sign-in file. */
export const CODEX_RESEARCH_HOME = 'codex'
export const CODEX_SIGN_IN = 'auth.json'
/**
 * The tools Codex keeps offering under the research form, each looked at on Codex 0.162.1
 * (2026-10-11) with the fence test: none reads or writes a file of the owner's. `exec` runs a
 * script that reaches only the `exec:` tools below it (a patch is refused by the read-only sandbox,
 * the MCP listings have no server, `web__run` asks the provider's own search service); `wait`
 * waits for such a script; the two `request_user_input` tools ask a question no one answers in a
 * run without a person; the `collaboration` tools find no other agent, and starting one fails in a
 * run that keeps no session. A tool that is not here fails the fence test, so the offer of a Codex
 * version that adds one stays closed until that tool is looked at and added here.
 */
export const CODEX_RESEARCH_TOOLS_SEEN = ['custom:functions.exec', 'exec:apply_patch', 'exec:clock__curr_time', 'exec:list_mcp_resource_templates',
  'exec:list_mcp_resources', 'exec:read_mcp_resource', 'exec:web__run', 'function:collaboration.followup_task', 'function:collaboration.interrupt_agent',
  'function:collaboration.list_agents', 'function:collaboration.send_message', 'function:collaboration.spawn_agent', 'function:collaboration.wait_agent',
  'function:functions.request_user_input', 'function:functions.request_user_input_async', 'function:functions.wait']

/**
 * The tools OpenCode offers a research run, looked at on OpenCode 2.0.29 (2026-10-14): only its web
 * search, which sends the search text to the search service its folder names. A tool that is not
 * here fails the fence test (70.3), as for Codex.
 */
export const OPENCODE_RESEARCH_TOOLS_SEEN = ['function:websearch']
const RESEARCH_TOOLS_SEEN = { codex: CODEX_RESEARCH_TOOLS_SEEN, opencode: OPENCODE_RESEARCH_TOOLS_SEEN }

/** Names the research form of an app as it is built now: a fence test counts only for the form it tested. */
export function researchFormHash(harness) {
  if (harness === 'opencode') return sha256(canonicalJson({ environment: RESEARCH_ENVIRONMENT.opencode, agent: OPENCODE_RESEARCH_AGENT, folder: OPENCODE_FOLDER_SHA256, titled: true })).slice(0, 16)
  return sha256(canonicalJson(harness === 'codex'
    ? { environment: RESEARCH_ENVIRONMENT.codex, config: CODEX_RESEARCH_CONFIG, disabled: CODEX_RESEARCH_DISABLED, sandbox: 'read-only', strict: true }
    : { environment: RESEARCH_ENVIRONMENT[harness] ?? [], tools: RESEARCH_TOOLS })).slice(0, 16)
}

export function researchRunsDirectory() {
  return `${stateDirectory()}/research/runs`
}

/** The owner's own Codex sign-in file as a research run links to it. BMN names it and never reads it. */
function codexSignInFile(environment = process.env) {
  return `${environment.HOME ?? ''}/.codex/${CODEX_SIGN_IN}`
}

/** Removes the Codex folder of every research run: the one a run just ended with, and any a crash left behind. */
export function removeResearchCodexFolders(only = null) {
  let names
  try {
    names = only === null ? readdirSync(researchRunsDirectory()) : [basename(only.folder)]
  } catch {
    return
  }
  // A link is removed as a link; what it points at is never touched.
  for (const name of names) rmSync(`${researchRunsDirectory()}/${name}/${CODEX_RESEARCH_HOME}`, { recursive: true, force: true })
}

/**
 * The folder BMN makes for one research run: the prompt it wrote, its hash, and an empty folder
 * the app runs in. The check passes a research dispatch only from here with exactly this prompt.
 * For Codex (`harness`) it also holds the run's own Codex folder with one link in it, to the
 * owner's sign-in file. A Codex folder an earlier run left behind is removed first, whatever app this run uses.
 */
export function prepareResearchRun(prompt, { now = new Date(), id = `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${sha256(`${prompt}\n${process.pid}\n${now.getTime()}`).slice(0, 8)}`, harness = undefined, environment = process.env } = {}) {
  const folder = `${researchRunsDirectory()}/${id}`
  // One research runs at a time, so a Codex folder that is still there was left by a run that never ended.
  removeResearchCodexFolders()
  ensurePrivateDirectory(`${folder}/cwd`)
  writeState(`${folder}/prompt.md`, prompt)
  writeState(`${folder}/run.json`, `${JSON.stringify({ version: 1, id, prompt_sha256: sha256(prompt), created_at: now.toISOString() })}\n`)
  const run = { id, folder, prompt: `${folder}/prompt.md`, cwd: `${folder}/cwd` }
  // An OpenCode run starts from BMN's own OpenCode folder, put in order here as `roster role` does.
  if (harness === 'opencode') installOpenCodeFolder()
  if (harness !== 'codex') return run
  ensurePrivateDirectory(`${folder}/${CODEX_RESEARCH_HOME}`)
  symlinkSync(codexSignInFile(environment), `${folder}/${CODEX_RESEARCH_HOME}/${CODEX_SIGN_IN}`)
  return { ...run, codex: `${folder}/${CODEX_RESEARCH_HOME}` }
}

/**
 * Why a run's Codex folder is not the one BMN makes, or null: a real folder that holds one thing,
 * a link to the owner's sign-in file. Only names are read; the sign-in file never is.
 */
function codexFolderProblem(folder, signIn) {
  const only = `a Codex research run's own Codex folder holds only a link to the owner's sign-in file (${signIn})`
  let names
  try {
    if (!lstatSync(folder).isDirectory()) return only
    names = listDirectory(folder).map((entry) => entry.name)
  } catch {
    return `${only}, and ${folder} is not there`
  }
  if (names.length !== 1 || names[0] !== CODEX_SIGN_IN) return `${only}; ${folder} holds ${names.length === 0 ? 'nothing' : names.join(', ')}`
  try {
    const link = `${folder}/${CODEX_SIGN_IN}`
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== signIn) return `${only}; ${link} is not that link`
  } catch {
    return only
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// The fence test's record (63.3)

export function fenceTestsPath() {
  return `${stateDirectory()}/fence-tests.jsonl`
}

/** Every recorded fence test, oldest first; a line BMN cannot read is skipped, never guessed. */
export function fenceTests() {
  let text
  try {
    text = readText(fenceTestsPath())
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const entry = JSON.parse(line)
      if (isObject(entry) && isString(entry.harness) && Array.isArray(entry.models)) entries.push(entry)
    } catch {
      // A torn line proves nothing.
    }
  }
  return entries
}

/**
 * How an app version stands for research with one model: `passed` only where the latest fence test
 * of exactly this version and of the research form as it is built now passed for that model, named
 * no tool BMN has not looked at, and no later comparison under the provider's own model list
 * found another tool list. `why` is `untested`, `failed` or `live` otherwise; `tools` is what the
 * test saw offered. `live` is the last comparison under the provider's model list, or null.
 */
export function fenceStanding(harness, version, model, tests = fenceTests()) {
  const form = researchFormHash(harness)
  const last = (catalog) => {
    let found = null
    for (const entry of tests) {
      if (entry.harness !== harness || entry.version !== version || entry.form !== form || (entry.catalog ?? 'bundled') !== catalog) continue
      // A comparison that showed nothing neither opens nor closes anything.
      if (catalog === 'live' && entry.verdict !== 'pass' && entry.verdict !== 'fail') continue
      const one = entry.models.find((candidate) => isObject(candidate) && candidate.model === model)
      if (one !== undefined) found = { entry, model: one }
    }
    return found
  }
  if (typeof version !== 'string') return { passed: false, why: 'untested', tools: [], live: null }
  const test = last('bundled')
  if (test === null) return { passed: false, why: 'untested', tools: [], live: null }
  const tools = Array.isArray(test.model.tools) ? test.model.tools.filter(isString) : []
  const unseen = tools.filter((tool) => !(RESEARCH_TOOLS_SEEN[harness] ?? []).includes(tool))
  if (test.entry.verdict !== 'pass' || test.model.verdict !== 'pass' || unseen.length > 0) {
    const reasons = [...(Array.isArray(test.model.reasons) ? test.model.reasons : []), ...(Array.isArray(test.entry.reasons) ? test.entry.reasons : []), ...unseen.map((tool) => `a tool BMN has not looked at: ${tool}`)]
    return { passed: false, why: 'failed', tools, live: null, at: test.entry.at, reasons: reasons.filter(isString) }
  }
  const compared = last('live')
  const live = compared === null ? null : { at: compared.entry.at, same: compared.entry.verdict === 'pass' && compared.model.verdict === 'pass', entry: compared.model.catalog_entry ?? null }
  if (live !== null && !live.same) {
    return { passed: false, why: 'live', tools, live, at: test.entry.at, reasons: (Array.isArray(compared.model.reasons) ? compared.model.reasons : []).filter(isString) }
  }
  return { passed: true, tools, live, at: test.entry.at }
}

/** Why `argv` is not exactly the research form, or null when it is. */
export function researchFormProblem(parsed) {
  if (parsed.envMode !== 'clean') return 'a research run needs env -i'
  const carried = RESEARCH_ENVIRONMENT[parsed.harness]
  const extra = Object.keys(parsed.assignments).filter((key) => !carried.includes(key))
  if (extra.length > 0) return `a research run's env -i carries only ${carried.join(', ')}, not ${extra.join(', ')}`
  if (parsed.harness === 'codex') {
    if (parsed.resume !== null) return 'a research run never resumes a session'
    if (parsed.sandbox !== 'read-only') return 'a research run needs --sandbox read-only'
    if (!parsed.skipGit || !parsed.ephemeral) return 'a research run needs --skip-git-repo-check and --ephemeral'
    if (parsed.json || parsed.cd !== undefined || parsed.profile !== undefined) return 'a research run takes no --json, --cd or --profile'
    if (parsed.output === undefined) return 'a research run writes its answer with -o'
    const fixed = parsed.config.filter((entry) => CODEX_RESEARCH_CONFIG.includes(entry))
    if (fixed.length !== CODEX_RESEARCH_CONFIG.length || new Set(fixed).size !== fixed.length) {
      return `a research run carries exactly ${CODEX_RESEARCH_CONFIG.map((entry) => `-c ${entry}`).join(' ')}`
    }
    // Beside the fixed settings a research command names its effort and, where the agent has one, its context limit: nothing else, each once.
    const own = parsed.config.filter((entry) => !CODEX_RESEARCH_CONFIG.includes(entry)).map((entry) => entry.split('=')[0])
    const stray = own.find((key) => !CODEX_RESEARCH_OWN_KEYS.includes(key))
    if (stray !== undefined) return `a research run carries no setting beside its fixed ones, its effort and its context limit, not -c ${stray}`
    if (new Set(own).size !== own.length) return 'a research run names its effort and its context limit once each'
    if (parsed.strictConfig !== true) return 'a research run needs --strict-config, so that a setting Codex does not know stops the run'
    if (parsed.disable.length !== CODEX_RESEARCH_DISABLED.length || !CODEX_RESEARCH_DISABLED.every((feature) => parsed.disable.includes(feature))) {
      return `a research run carries exactly ${CODEX_RESEARCH_DISABLED.map((feature) => `--disable ${feature}`).join(' ')}`
    }
    const home = parsed.assignments.CODEX_HOME
    if (home === undefined || !isAbsolute(home) || home.split('/').includes('..') || basename(home) !== CODEX_RESEARCH_HOME) {
      return 'a research run names the Codex folder BMN made for it (CODEX_HOME), so that Codex reads nothing from the owner\'s own'
    }
    return null
  }
  if (parsed.harness === 'opencode') {
    // BMN's folder and switches with their one value each; the parser holds --standalone, --format json and no prompt on the line.
    const off = Object.entries(openCodeEnvironment()).find(([name, value]) => parsed.assignments[name] !== value)
    if (off !== undefined) return `a research run carries ${off[0]}=${off[1]}, BMN's own folder and switches for OpenCode runs`
    if (parsed.agent !== OPENCODE_RESEARCH_AGENT) return `a research run runs BMN's research agent (--agent ${OPENCODE_RESEARCH_AGENT})`
    if (parsed.title === undefined) return 'a research run names its title (--title), so OpenCode makes no request of its own to name the session'
    return null
  }
  if (!parsed.safeMode) return 'a research run needs --safe-mode'
  if (parsed.tools !== RESEARCH_TOOLS) return `a research run needs --tools '${RESEARCH_TOOLS}'`
  if (!parsed.strictMcp || parsed.mcpConfig === undefined || !emptyMcpConfig(parsed.mcpConfig)) return 'a research run needs --strict-mcp-config and an empty --mcp-config'
  if (!parsed.noPersistence) return 'a research run needs --no-session-persistence'
  if (parsed.outputFormat !== 'json') return 'a research run needs --output-format json'
  if (parsed.settings !== undefined || parsed.addDir.length > 0 || parsed.appendSystemPrompt !== undefined || parsed.permissionMode !== undefined) {
    return 'a research run takes no --settings, --add-dir, --append-system-prompt or --permission-mode'
  }
  return null
}

/**
 * Evaluates a research run: an approved, active agent the team names a researcher, on a known
 * destination and a tested or accepted app version, the exact fenced argv, run from the empty
 * folder BMN made, fed the prompt BMN wrote. A Codex run passes only on a version whose fence test
 * is on record as passed (`fenceTestLog`, read from the record by default); a public-only
 * destination passes only on an app version whose fence was verified.
 * `inputs.dry` asks only whether this agent could research with this argv: everything but the
 * folder and the prompt, and no receipt. `inputs.settled` is a receipt checked again after its run,
 * whose Codex folder is gone by then.
 */
export function evaluateResearch(inputs, {
  environment = process.env, cwd: processCwd = process.cwd(), now = new Date(),
  testedVersions = TESTED_HARNESS_VERSIONS, fenceVersions = RESEARCH_FENCE_VERSIONS, contextTestLog = undefined, fenceTestLog = undefined
} = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
    // A missing or invalid team file stops here (R60-NFR1); a valid one that differs from the approved version is a pending edit.
    const file = readValidRoster()
    const generation = readApproved()
    const data = generation.data
    note(`approved version ${generation.number}`)
    const agent = activeAgent(generation, inputs.agent)
    note(`agent ${agent.id}: ${agent.class}, ${agent.harness} ${agent.model}, provider ${agent.provider}`)
    // Who researches is part of the approved team (63.3). A team that names no one is one from before the mark.
    const named = namedResearchers(data)
    if (named !== null && !named.includes(agent.id)) {
      refuse('NOT_A_RESEARCHER', `${agent.id} is not one of the team's researchers (${named.length === 0 ? 'the team names none' : named.join(', ')})`)
    }
    const parsed = parseDispatch(inputs.argv, { research: true })
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    if (agent.harness !== parsed.harness) refuse('ROUTE_UNSUPPORTED', `${agent.id} runs on ${agent.harness}, the command is ${parsed.harness}`)
    const form = researchFormProblem(parsed)
    if (form !== null) refuse('ROUTE_UNSUPPORTED', form)
    // A dry question may name a folder that is not there yet, shaped like a run's own: it is read as named.
    const cwd = canonicalDirectory(inputs.cwd ?? processCwd, processCwd)
      ?? (inputs.dry === true && typeof inputs.cwd === 'string' && isAbsolute(inputs.cwd) && !inputs.cwd.split('/').includes('..') ? inputs.cwd : null)
    // The fixed research switches are not part of where Codex sends data; the route reader sees the rest.
    const resolution = parsed.harness === 'codex'
      ? resolveCodexRoute({ ...parsed, config: parsed.config.filter((entry) => !CODEX_RESEARCH_CONFIG.includes(entry)) }, environment, cwd ?? processCwd)
      : parsed.harness === 'opencode' ? resolveOpenCodeRoute(parsed, { agent: OPENCODE_RESEARCH_AGENT, folder: inputs.dry !== true }) : resolveClaudeRoute(parsed, environment, cwd ?? processCwd)
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    const versionEnvironment = dispatchEnvironment(parsed, environment)
    // Like appVersion and the fence test, query the executable with bare HOME/PATH. Native Codex
    // creates startup aliases even for --version; probing in the run's auth-only folder dirties it.
    // The research command retains its own CODEX_HOME and every folder/form restriction below.
    if (parsed.harness === 'codex') delete versionEnvironment.CODEX_HOME
    const version = harnessVersion(parsed.command, versionEnvironment)
    note(parsed.harness === 'codex' ? 'dispatch form: env -i codex exec from a Codex folder of its own, read-only, web search, no command or app tools'
      : parsed.harness === 'opencode' ? 'dispatch form: env -i opencode run from BMN\'s OpenCode folder, its research agent, web search only' : 'dispatch form: env -i claude -p, web tools only')
    // An OpenCode agent's model is named with its provider, as `-m` names it.
    const { model, effort } = checkModelAndEffort(parsed.harness === 'opencode' && !agent.model.includes('/') ? { ...agent, model: `${agent.provider}/${agent.model}` } : agent, resolution, note)
    const context = checkContext(agent, resolution.context, agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(parsed.harness, version, contextTestLog),
      agent.context_limit === undefined ? [] : provenPrecedence(parsed.harness, version, contextTestLog))
    if (context.refusal) refuse('CONTEXT_MISMATCH', context.refusal, context.why)
    note(context.note)
    const route = resolution.route
    const destination = matchedDestination(data, agent, parsed.harness, route, note)

    // The run's Codex folder lies beside the empty folder it starts in; a dry question names both as they will be.
    if (parsed.harness === 'codex' && cwd !== null && parsed.assignments.CODEX_HOME !== `${dirname(cwd)}/${CODEX_RESEARCH_HOME}` && (inputs.dry !== true || basename(cwd) === 'cwd')) {
      refuse('WORKSPACE_MISMATCH', `a Codex research run uses the Codex folder BMN made for it, ${dirname(cwd)}/${CODEX_RESEARCH_HOME}`)
    }
    let stdin = null
    if (inputs.dry !== true) {
      const runs = canonicalDirectory(researchRunsDirectory(), processCwd)
      const run = cwd === null ? null : dirname(cwd)
      if (cwd === null || runs === null || dirname(run) !== runs || basename(cwd) !== 'cwd') {
        refuse('WORKSPACE_MISMATCH', 'a research run starts in the empty folder BMN made for it')
      }
      if (listDirectory(cwd).length > 0) refuse('WORKSPACE_MISMATCH', `${cwd} is not empty`)
      let record = null
      try {
        record = JSON.parse(readText(`${run}/run.json`))
      } catch {
        record = null
      }
      try {
        const path = realpathSync(isAbsolute(inputs.stdin) ? inputs.stdin : `${cwd}/${inputs.stdin}`)
        stdin = { path, sha256: hashFile(path) }
      } catch {
        stdin = null
      }
      if (!isObject(record) || stdin === null || stdin.path !== `${run}/prompt.md` || stdin.sha256 !== record.prompt_sha256) {
        refuse('WORKSPACE_MISMATCH', '--stdin must be the research prompt BMN wrote for this run, unchanged')
      }
      if (parsed.harness === 'codex' && (isAbsolute(parsed.output) ? parsed.output : `${cwd}/${parsed.output}`) !== `${run}/${CODEX_RESEARCH_ANSWER}`) {
        refuse('WORKSPACE_MISMATCH', `a research run writes its answer to ${CODEX_RESEARCH_ANSWER} beside BMN's prompt`)
      }
      if (parsed.harness === 'codex' && inputs.settled !== true) {
        const problem = codexFolderProblem(`${run}/${CODEX_RESEARCH_HOME}`, codexSignInFile(parsed.assignments))
        if (problem !== null) refuse('WORKSPACE_MISMATCH', problem)
      }
      note(`research run ${basename(run)}: BMN's prompt, an empty folder`)
    }

    if (version === null) {
      refuse('HARNESS_UNKNOWN', `${parsed.harness}: BMN cannot read this app's version, so it cannot tell which program would run`)
    }
    const tested = versionStanding(parsed.harness, version, testedVersions)
    note(`${parsed.harness} ${version}: ${tested.state}`)
    const answer = privateWorkAnswer(data, destination, null)
    note(`private work: ${answer.reason}`)
    // Claude Code's research form is the one 60.10 names; Codex researches only on a version whose fence the owner's
    // test showed, for this model and for the form as it is built now (63.3). That its provider may see private work
    // is another question: research must send only what BMN wrote, and only that test shows it.
    const standing = parsed.harness === 'claude' ? null : fenceStanding(parsed.harness, version, model.value, fenceTestLog)
    const fenced = standing === null ? (fenceVersions[parsed.harness] ?? []).includes(version) : standing.passed
    if (standing !== null) note(`fence test of ${parsed.harness} ${version} with ${model.value}: ${standing.passed ? `passed${standing.live === null && parsed.harness === 'codex' ? ', not yet compared under the provider\'s own model list' : ''}` : standing.why}`)
    if (parsed.harness !== 'claude' && !fenced) {
      const app = APP_NAMES[parsed.harness]
      const reason = standing?.reasons?.[0]
      if (standing?.why === 'failed') refuse('ROUTE_UNSUPPORTED', `the fence test of ${parsed.harness} ${version} with ${model.value} did not pass${reason === undefined ? '' : ` (${reason})`}, so no research runs there: pick another researcher`, 'fence-failed')
      if (standing?.why === 'live') refuse('ROUTE_UNSUPPORTED', `under the provider's own model list ${app} ${version} offers ${model.value} other tools than the fence test saw${reason === undefined ? '' : ` (${reason})`}, so no research runs there until that is looked at`, 'fence-live')
      refuse('ROUTE_UNSUPPORTED', `research runs in ${app} only on a version whose fence test passed, and none is on record for ${parsed.harness} ${version} with ${model.value}: the owner runs \`bmn roster fence\`, or picks a researcher on Claude Code`, 'fence-untested')
    }
    if (!answer.allowed && !fenced) {
      refuse('PACKET_INVALID', `a public-only researcher runs only on an app version whose fence BMN verified; ${parsed.harness} ${version} is not one`)
    }
    if (inputs.dry === true) return { verdict: 'PASS', dry: true, version, steps, ...(standing === null ? {} : { fence: { tools: standing.tools, compared: standing.live !== null } }) }
    const body = {
      version: 1, mode: 'research', verdict: 'PASS', agent: agent.id, class: agent.class, harness: parsed.harness, model: model.value,
      effort: effort.value, context_limit_applied: context.applied,
      ...(agent.context_limit !== undefined && context.applied === null ? { context_limit_note: context.note } : {}),
      cwd,
      argv_sha256: sha256(canonicalJson(inputs.argv)),
      harness_version: { version, state: tested.state },
      ...(standing === null ? {} : { fence: { form: researchFormHash(parsed.harness), tested_at: standing.at, tools: standing.tools } }),
      route: receiptRoute(destination, route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: file.hash,
      stdin,
      issued_at: now.toISOString()
    }
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps }
  } catch (error) {
    if (error instanceof Refusal) {
      return { verdict: 'REFUSED', code: error.code, message: error.message, next: error.code === 'WORKSPACE_MISMATCH' ? 'start the research from BMN (Team, Models), which writes the prompt and the folder' : NEXT_STEP[error.code], steps, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    }
    throw error
  }
}
