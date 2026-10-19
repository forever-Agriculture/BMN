// MODULE: agents-check.mjs - Epic 60.3: `bmn roster check|explain|route|visibility|bind`, the fail-closed check before work leaves for another agent
import { RosterError, publicOnlyReasons } from './agents-roster.mjs'
import { readApprovedWithFile } from './agents-state.mjs'
import { AgentsUsageError, EXIT, err, failWith, out, readOptions, usage } from './agents-cli.mjs'
import { publicRendering } from './agents-rules.mjs'
import { bindSession, canonicalDirectory, refreshVisibility, workspaceVisibility } from './agents-check-workspace.mjs'
import { evaluate, evaluateResearch } from './agents-check-evaluate.mjs'
import { inspectRoute, verifyReceipt } from './agents-check-team-ask.mjs'
export { BINDING_WINDOW_MS, OPENCODE_NEXT_STEP, REFUSALS, RESEARCH_FENCE_VERSIONS, RESUME_TESTED_VERSIONS, TESTED_HARNESS_VERSIONS, VISIBILITY_MAX_AGE_MS, WEB_NEXT_STEP, WEB_QUESTION_COMMAND, WEB_TOOLS_NOTE, setReadTracer } from './agents-check-base.mjs'
export { parseDispatch, readCodexConfig } from './agents-check-argv.mjs'
export { contextTestSources, limitStanding, resolveClaudeRoute, resolveCodexRoute, resolveOpenCodeRoute } from './agents-check-routes.mjs'
export { bindSession, bindingPath, destinationOf, harnessVersion, normalizedGithubOrigin, privateWorkAnswer, receiptHash, refreshVisibility, sessionRecord, sessionRecordAt, sessionRecordFiles, visibilityDirectory, visibilityPath, workspaceOrigin, workspaceRoot, workspaceVisibility } from './agents-check-workspace.mjs'
export { consequences } from './agents-check-consequences.mjs'
export { CLAUDE_READ_ONLY_TESTED, CLAUDE_READ_ONLY_TOOLS, CODEX_RESEARCH_ANSWER, CODEX_RESEARCH_CONFIG, CODEX_RESEARCH_DISABLED, CODEX_RESEARCH_HOME, CODEX_RESEARCH_TOOLS_SEEN, CODEX_SIGN_IN, OPENCODE_RESEARCH_TOOLS_SEEN, READ_ONLY_ITEMS, RESEARCH_TOOLS, codexSignInFile, evaluate, evaluateResearch, fenceStanding, fenceTests, fenceTestsPath, prepareResearchRun, removeResearchCodexFolders, researchFormHash, researchFormProblem, researchRunsDirectory, versionStanding } from './agents-check-evaluate.mjs'
export { askConsent, askRequest, evaluateAsk, expectedDestination, inspectRoute, modeInput, teamRunsDirectory, verifyReceipt } from './agents-check-team-ask.mjs'

export { publicOnlyReasons }

/**
 * The check answers one question immediately before a dispatch: may this exact command, run from
 * this directory with this input, send this work to this agent? It reads the approved roster
 * generation only, resolves where the command would really go from a fixed list of configuration
 * keys, and refuses unless every answer is known and allowed. Everything is private unless a
 * visibility record proves it public, and a provider sees private work only when the owner's
 * approved answer, or an exception for that one workspace, says so. It governs only dispatches
 * that call it, and the window between the check and the exec stays open (docs/agent-control.md).
 */

// ---------------------------------------------------------------------------------------------
// CLI

const CHECK_VALUES = ['agent', 'role', 'workspace', 'data', 'cwd', 'stdin', 'packet', 'resume-of', 'verify']

/** Read only when a packet dispatch carries --append-system-prompt, so other checks never open the master. */
function publicClaudeRules() {
  try {
    return publicRendering('claude')
  } catch {
    return null
  }
}

export async function runCheckCommand(action, argv) {
  if (action === 'visibility') return visibilityCommand(argv)
  if (action === 'bind') return bindCommand(argv)
  let parsed
  try {
    parsed = readOptions(argv, action === 'route' ? { flags: ['json'], values: ['agent'] } : { flags: ['json', ...(action === 'check' ? ['research'] : [])], values: CHECK_VALUES })
    if (parsed.positionals.length > 0) throw new AgentsUsageError(`roster ${action} takes no positional arguments; the dispatch goes after --`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const options = parsed.options
  const asJson = options.json === true
  try {
    if (action === 'route') return routeCommand(options, parsed.rest, asJson)
    if (options.verify !== undefined) {
      if (action !== 'check') throw new AgentsUsageError('--verify is only for roster check')
      const others = Object.keys(options).filter((name) => !['verify', 'json'].includes(name))
      if (others.length > 0 || parsed.rest === null) throw new AgentsUsageError('roster check --verify <receipt> -- <dispatch argv> takes no other options')
      const result = verifyReceipt(options.verify, parsed.rest, { publicRules: publicClaudeRules })
      if (asJson) out(JSON.stringify({ ok: result.ok, ...(result.ok ? {} : { code: 'RECEIPT_INVALID', reason: result.reason }) }, null, 2))
      else out(result.ok ? 'Receipt verified: the same check passes with the same inputs.' : `bmn: RECEIPT_INVALID: ${result.reason}`)
      return result.ok ? 0 : EXIT.RECEIPT_INVALID
    }
    if (parsed.rest === null || parsed.rest.length === 0) throw new AgentsUsageError(`roster ${action} requires -- <dispatch argv>`)
    let result
    if (options.research === true) {
      const others = Object.keys(options).filter((name) => !['research', 'agent', 'stdin', 'cwd', 'json'].includes(name))
      if (others.length > 0) throw new AgentsUsageError('roster check --research takes --agent and --stdin (and --cwd) in place of --role, --workspace and --data')
      for (const name of ['agent', 'stdin']) if (options[name] === undefined) throw new AgentsUsageError(`roster check --research requires --${name}`)
      result = evaluateResearch({ agent: options.agent, stdin: options.stdin, argv: parsed.rest, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) })
    } else {
      for (const name of ['agent', 'role', 'workspace', 'data']) {
        if (options[name] === undefined) throw new AgentsUsageError(`roster ${action} requires --${name}`)
      }
      if (!['private', 'public'].includes(options.data)) throw new AgentsUsageError('--data must be private or public')
      result = evaluate({
        agent: options.agent, role: options.role, workspace: options.workspace, data: options.data, argv: parsed.rest,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.packet !== undefined ? { packet: options.packet } : {}), ...(options['resume-of'] !== undefined ? { resumeOf: options['resume-of'] } : {})
      }, { publicRules: publicClaudeRules })
    }
    if (action === 'explain') {
      const lines = result.steps.map((step) => `  ${step}`)
      lines.push(result.verdict === 'PASS' ? 'PASS: this dispatch may proceed.' : `REFUSED ${result.code}: ${result.message}\nNext: ${result.next}`)
      if (asJson) out(JSON.stringify({ verdict: result.verdict, steps: result.steps, ...(result.verdict === 'PASS' ? {} : { code: result.code, message: result.message, next: result.next }) }, null, 2))
      else out(lines.join('\n'))
      return result.verdict === 'PASS' ? 0 : EXIT.refusal
    }
    if (result.verdict === 'PASS') {
      const receipt = result.receipt
      out(asJson ? JSON.stringify(receipt, null, 2)
        : `PASS ${receipt.agent} ${receipt.role ?? 'research'} -> ${receipt.route.host} (${receipt.data ?? 'research'}, private work ${receipt.private_work.allowed ? 'allowed' : 'not allowed'}); receipt ${receipt.receipt_hash.slice(0, 12)}; BMN judged this command and does not run it${receipt.context_limit_note === undefined ? '' : `\n${receipt.context_limit_note}`}${result.note === undefined ? '' : `\n${result.note}`}`)
      // With --json standard output is the receipt alone, as a caller saves it; the line goes beside it.
      if (asJson && result.note !== undefined) err(`bmn: ${result.note}`)
      return 0
    }
    if (asJson) out(JSON.stringify({ verdict: 'REFUSED', code: result.code, message: result.message, next: result.next, ...(result.detail === undefined ? {} : { detail: result.detail }) }, null, 2))
    else out(`REFUSED ${result.code}: ${result.message}\nNext: ${result.next}`)
    return EXIT.refusal
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    return failWith(error, asJson)
  }
}

function routeCommand(options, rest, asJson) {
  if (options.agent === undefined) throw new AgentsUsageError('roster route requires --agent')
  const generation = readApprovedWithFile()
  const agent = generation.data.agents.find((candidate) => candidate.id === options.agent)
  if (agent === undefined) throw new RosterError('UNKNOWN_AGENT', `no agent ${options.agent} in approved version ${generation.number}`)
  const result = inspectRoute(agent, rest, process.env, process.cwd(), generation.data)
  if (asJson) {
    out(JSON.stringify({ agent: agent.id, inspection_only: true, ...result }, null, 2))
  } else {
    const lines = [`${agent.id} (${result.harness}); inspection only, never an authorization`]
    if (result.unsupported) lines.push(`  unsupported: ${result.unsupported}`)
    else {
      lines.push(`  destination: ${result.host ?? 'unknown'} (${result.basis}${result.reason ? `: ${result.reason}` : ''})`)
      lines.push(`  decided by: ${result.sources?.length ? result.sources.join(', ') : 'defaults only'}`)
      if (result.roster_provider) lines.push(`  provider: ${result.roster_provider} (${result.private_work === 'allowed' ? 'may see private work' : 'public work only'})`)
      if (result.model) lines.push(`  model: ${result.model}`)
      if (result.version !== undefined) lines.push(`  ${result.harness} ${result.version ?? '(version unreadable)'}: ${result.version_state}`)
    }
    out(lines.join('\n'))
  }
  return result.unsupported ? EXIT.refusal : 0
}

async function visibilityCommand(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json', 'refresh'] })
    if (parsed.positionals.length !== 1 || parsed.rest !== null) throw new AgentsUsageError('roster visibility expects exactly one workspace path')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  try {
    const workspace = canonicalDirectory(parsed.positionals[0], process.cwd())
    if (workspace === null) throw new RosterError('WORKSPACE_UNKNOWN', `${parsed.positionals[0]} is not an existing directory without ..`)
    if (parsed.options.refresh === true) await refreshVisibility(workspace)
    const status = workspaceVisibility(workspace)
    const record = status.record ?? null
    if (asJson) {
      out(JSON.stringify({ workspace, public: status.public, reason: status.reason, record }, null, 2))
    } else {
      const lines = [`${workspace}: ${status.public ? 'public' : 'private'} (${status.reason})`]
      if (record !== null) {
        lines.push(`  checked ${record.checked_at}${record.origin ? `, origin ${record.origin}` : ''}`)
        if (record.visibility === 'public') lines.push(`  default branch ${record.default_branch} at ${record.commit}`)
      } else if (!parsed.options.refresh) {
        lines.push('  run with --refresh to ask GitHub once')
      }
      out(lines.join('\n'))
    }
    return 0
  } catch (error) {
    if (error instanceof RosterError && error.code === 'WORKSPACE_UNKNOWN') {
      if (asJson) out(JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2))
      else out(`bmn: ${error.code}: ${error.message}`)
      return EXIT.refusal
    }
    return failWith(error, asJson)
  }
}

function bindCommand(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json'], values: ['receipt', 'session'] })
    if (parsed.positionals.length > 0 || parsed.rest !== null) throw new AgentsUsageError('roster bind takes --receipt <file> --session <id>')
    for (const name of ['receipt', 'session']) if (parsed.options[name] === undefined) throw new AgentsUsageError(`roster bind requires --${name}`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  try {
    const bound = bindSession(parsed.options.receipt, parsed.options.session)
    out(asJson ? JSON.stringify({ ok: true, ...bound }, null, 2) : `Bound session ${bound.session_id} to receipt ${bound.receipt_hash.slice(0, 12)}.`)
    return 0
  } catch (error) {
    return failWith(error, asJson)
  }
}
