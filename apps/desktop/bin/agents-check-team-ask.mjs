// MODULE: agents-check-team-ask.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: a teammate's ask (Epic 72) and the route inspection
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RosterError, appName, canonicalJson, classRefusal, isRetired, publicOnlyReasons, retiredWords, sha256 } from './agents-roster.mjs'
import { readApproved, readValidRoster, stateDirectory } from './agents-state.mjs'
import { checkContext, contextItems, provenControls, provenPrecedence } from './agents-context.mjs'
import { ASK_APPS, ASK_FORMS_CHECKED, ASK_READS, ASK_RUN_FILES, ASK_UNSUPPORTED, appSearchPath, askCommand, askFormName, askProgram, askReads, claudePictureMessage, sameProgram } from './agents-team-forms.mjs'
import { BROWSER_STATEMENT, browserOrigin } from './agents-team-browser.mjs'
import { OPENCODE_ASK_AGENTS, openCodeAskConfig } from './agents-opencode.mjs'
import { NEXT_STEP, Refusal, TESTED_HARNESS_VERSIONS, readText, refuse } from './agents-check-base.mjs'
import { dispatchEnvironment, parseDispatch, parseOpenCode } from './agents-check-argv.mjs'
import { inspectOpenCode, resolveClaudeRoute, resolveCodexRoute, resolveOpenCodeRoute } from './agents-check-routes.mjs'
import { canonicalDirectory, committedBlob, destinationOf, harnessVersion, hashFile, privateWorkAnswer, readReceiptFile, receiptHash, workspaceVisibility } from './agents-check-workspace.mjs'
import { activeAgent, checkModelAndEffort, checkRoleEffort, evaluate, evaluateResearch, matchedDestination, receiptAnswer, receiptRoute, versionStanding } from './agents-check-evaluate.mjs'
import { isObject } from './shared-helpers.mjs'

// ---------------------------------------------------------------------------------------------
// A teammate's ask (Epic 72)

/** Where BMN keeps one folder per ask: its inputs and record. */
export function teamRunsDirectory() {
  return `${stateDirectory()}/team/runs`
}

/** BMN's git, the one a form that reads history runs first on its PATH (72.1 AC1). */
const ASK_GIT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ask-git.sh')

/**
 * Whether each input of an ask may go to this destination (R72-NFR5, NFR6), decided before anything
 * leaves. A private ask: the destination's private-work answer, a folder exception counting only for
 * an input inside its canonical root; an input whose root BMN cannot establish needs the provider's
 * own permission. A public ask: the asker's declaration, verified: a question carries no project
 * read; a file or picture is byte-identical to a file of the verified public commit of its project.
 * A project is never public: a teammate that works in one reads with its app's own tools, beyond
 * what the asker hands over (72.9). Returns each input with its basis.
 */
export function askConsent(data, destination, inputs, label, now = new Date(), note = () => {}) {
  const decided = []
  for (const input of inputs) {
    if (label === 'private') {
      const answer = privateWorkAnswer(data, destination, input.root ?? null)
      if (!answer.allowed) refuse('PRIVATE_NOT_ALLOWED', `${input.label} is private work and ${answer.reason}${input.root === null || input.root === undefined ? ' (BMN cannot tell which folder it comes from, so no folder exception covers it)' : ''}`)
      decided.push({ kind: input.kind, label: input.label, root: input.root ?? null, basis: answer.exception ? `exception ${answer.exception.id}` : 'the provider may see private work' })
      continue
    }
    if (input.kind === 'question') {
      decided.push({ kind: 'question', label: input.label, root: input.root ?? null, basis: 'declared public by the asker' })
      continue
    }
    if (input.kind === 'project' || input.kind === 'mode' || input.kind === 'browser') refuse('PUBLIC_NOT_VERIFIED', `${input.label} is read with the app's own tools, beyond what you hand over, so the ask is private`)
    if (input.root === null || input.root === undefined) refuse('PUBLIC_NOT_VERIFIED', `${input.label} is in no project BMN knows to be public`)
    const visibility = workspaceVisibility(input.root, now)
    if (!visibility.public) refuse('PUBLIC_NOT_VERIFIED', `${input.label} is in ${input.root}, which is not proven public (${visibility.reason}); run bmn roster visibility --refresh`)
    const commit = visibility.record.commit
    const blob = committedBlob(input.root, commit, input.relative)
    if (blob === null || sha256(blob) !== input.sha256) refuse('PUBLIC_NOT_VERIFIED', `${input.label} is not byte-identical to ${input.relative} in commit ${commit.slice(0, 12)}, the one GitHub serves for ${visibility.record.origin}`)
    decided.push({ kind: input.kind, label: input.label, root: input.root, basis: `byte-identical to ${input.relative} in the public commit ${commit.slice(0, 12)}` })
  }
  note(`data ${label}: ${decided.map((entry) => `${entry.label} (${entry.basis})`).join('; ')}`)
  return decided
}

/**
 * What one ask's command is built from: its form, the agent's model, the chosen effort, the folder it
 * works in, the pictures' paths, the owner's rules where the form carries them, and the agent's context
 * limit where the owner's test proved its setting on this app version (60.9), as `evaluate` applies it.
 */
export function askRequest(agent, version, { form, effort, cwd, folder, rules = null, pictures = [], browser = null, environment = process.env, contextTestLog = undefined }) {
  const proven = agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(agent.harness, version, contextTestLog)
  const items = contextItems(agent, proven)
  return { form, model: agent.model, provider: agent.provider, effort, cwd, folder, rules, pictures, browser, environment, context: items.state === 'applied' ? { argv: items.argv, env: items.env } : { argv: [], env: [] } }
}

/**
 * What a form's own mode reads beyond the asker's text, as an input whose consent is decided like
 * any other (R72-NFR6): a mode that reads the whole computer needs the provider's own permission, one
 * kept in its working folder that folder's, and one that reads only the asker's text nothing more.
 */
export function modeInput(form, appWords, project, browser = null) {
  const reads = askReads(form, browser)
  if (reads.scope === 'computer') return { kind: 'mode', label: `what ${appWords}'s ${browser?.interact === true ? 'interactive Playwright scripts' : 'read-only mode'} can read (${reads.reach})`, root: null }
  if (reads.scope === 'folder' && project !== null) return { kind: 'mode', label: `what ${appWords}'s read-only mode can read (the project ${project})`, root: project }
  return null
}

/**
 * The destination an agent's ask reaches when the check passes it: its approved host, or the app's
 * approved default. Used to decide consent before anything is copied (R72-NFR6); the check itself
 * then reads the run's real destination and refuses any other.
 */
export function expectedDestination(data, agent) {
  if (agent.host !== 'default') return { provider: agent.provider, basis: 'explicit' }
  const approved = data.harness_routes.find((entry) => entry.harness === agent.harness)
  return approved === undefined ? { provider: agent.provider, basis: 'owner-declared' } : { provider: approved.provider, basis: approved.basis }
}

/**
 * Evaluates one teammate's ask (R72-NFR1): the same approved team, agent, role, destination,
 * private-work and context answers as `evaluate`, judged for the command BMN built for the ask: the
 * app's own read-only form (72.9), recomputed here from the run's folder and compared whole, so the
 * receipt is for exactly what will start. Consent covers what the form's mode can read, not only the
 * inputs named (R72-NFR6). `inputs`: `{ agent, role, effort, data, run, argv, cwd }`, `run` the
 * folder BMN made for the ask. The existing entry points are not changed by it; a dispatch command is
 * not an ask and an ask's command is not a dispatch.
 */
export function evaluateAsk(inputs, { environment = process.env, now = new Date(), testedVersions = TESTED_HARNESS_VERSIONS, contextTestLog = undefined, program: givenProgram = undefined, version: givenVersion = undefined } = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
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
    if (!ASK_APPS.includes(agent.harness)) refuse('ACCESS_UNAVAILABLE', `${appName(agent.harness)} teammates are not asked through BMN yet`)

    // The run's own folder, as BMN made it, and the inputs it holds.
    const runs = canonicalDirectory(teamRunsDirectory(), '/')
    const folder = typeof inputs.run === 'string' ? canonicalDirectory(inputs.run, '/') : null
    if (folder === null || runs === null || dirname(folder) !== runs) refuse('WORKSPACE_MISMATCH', 'an ask runs from the folder BMN made for it')
    let manifest
    try {
      manifest = JSON.parse(readText(`${folder}/${ASK_RUN_FILES.manifest}`))
    } catch {
      manifest = null
    }
    if (!isObject(manifest) || manifest.version !== 2 || typeof manifest.form !== 'string' || !Object.hasOwn(ASK_READS, manifest.form) || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.pictures)) {
      refuse('WORKSPACE_MISMATCH', `${folder} holds no intact ask manifest`)
    }
    const project = typeof manifest.project?.root === 'string' ? manifest.project.root : null
    const label = inputs.data === 'public' ? 'public' : 'private'
    if (manifest.data !== label) refuse('WORKSPACE_MISMATCH', `the ask's manifest is for a ${manifest.data} ask, not a ${label} one`)
    const prompt = `${folder}/${ASK_RUN_FILES.prompt}`
    let promptHash = null
    try {
      promptHash = hashFile(prompt)
    } catch {
      promptHash = null
    }
    if (promptHash === null || promptHash !== manifest.prompt_sha256) refuse('WORKSPACE_MISMATCH', 'the prompt is not the one BMN wrote for this ask')
    // Each picture is the treated copy BMN made, in its own place under the run's inputs (72.8 AC2).
    for (const picture of manifest.pictures) {
      let hash = null
      try {
        if (!isObject(picture) || typeof picture.copy !== 'string' || !/^pictures\/\d+\.(png|jpg|webp)$/u.test(picture.copy)) throw new Error('not a picture place')
        hash = hashFile(`${folder}/${ASK_RUN_FILES.inputs}/${picture.copy}`)
      } catch {
        hash = null
      }
      if (hash === null || hash !== picture.sha256) refuse('WORKSPACE_MISMATCH', `the picture ${picture.label} is not the copy BMN made for this ask`)
    }

    // The app as installed: its version is recorded and shown, never a gate (R72-NFR10).
    const program = givenProgram ?? askProgram(agent.harness, environment)
    if (program === null) refuse('HARNESS_UNKNOWN', `${appName(agent.harness)} is not on PATH (BMN's own folder left out), so BMN cannot tell which program would run`)
    const version = givenVersion !== undefined ? givenVersion : harnessVersion(program.launcher, { PATH: appSearchPath(environment), HOME: environment.HOME ?? '' })
    if (version === null) refuse('HARNESS_UNKNOWN', `${agent.harness}: BMN cannot read this app's version, so it cannot tell which program would run`)
    const tested = versionStanding(agent.harness, version, testedVersions)
    const checked = ASK_FORMS_CHECKED[agent.harness]
    note(`${agent.harness} ${version}: ${tested.state}; its ask form was last checked on ${checked.version} (${checked.on})`)
    if (manifest.pictures.length > 0 && ASK_UNSUPPORTED[agent.harness]?.pictures !== undefined) refuse('ACCESS_UNAVAILABLE', ASK_UNSUPPORTED[agent.harness].pictures)
    // A browser ask (74.3): the asker's loopback origin, stated disposable, on an app that takes the browser's server.
    const browser = manifest.browser ?? null
    if (browser !== null) {
      if (ASK_UNSUPPORTED[agent.harness]?.browser !== undefined) refuse('ACCESS_UNAVAILABLE', ASK_UNSUPPORTED[agent.harness].browser)
      if (browserOrigin(browser.origin).origin !== browser.origin || typeof browser.interact !== 'boolean') refuse('WORKSPACE_MISMATCH', 'the ask\'s browser is not a loopback origin BMN wrote')
      if (browser.statement !== BROWSER_STATEMENT) refuse('WORKSPACE_MISMATCH', 'a browser ask needs the asker\'s statement that the app is a disposable test instance')
    }

    // The form: the app's one read-only form, OpenCode's asker where it may read nothing but the asker's text.
    const form = askFormName(agent.harness, { project, label, textOnly: publicOnlyReasons(agent, data).length > 0 })
    const reads = askReads(form, browser)
    if (manifest.form !== form) refuse('WORKSPACE_MISMATCH', `the ask's manifest names the form ${manifest.form}, not ${form}`)
    // A public ask goes only through a form that reads nothing beyond the asker's text (R72-NFR5).
    if (label === 'public' && ASK_READS[form].scope !== 'text') refuse('PUBLIC_NOT_VERIFIED', `${agent.id} works with ${appName(agent.harness)}'s own tools, which read beyond what you hand over, so its asks are private (R72-NFR5)`)
    const cwd = project ?? `${folder}/${ASK_RUN_FILES.work}`
    if (inputs.cwd !== cwd) refuse('WORKSPACE_MISMATCH', `the ask runs in ${cwd}, not ${inputs.cwd}`)

    // The command BMN builds for this ask, recomputed; the one given must be it, whole.
    const proven = agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(agent.harness, version, contextTestLog)
    let rules = null
    try {
      rules = readText(`${folder}/${ASK_RUN_FILES.rules}`)
    } catch (error) {
      if (error.code !== 'ENOENT') refuse('WORKSPACE_MISMATCH', 'the instruction snapshot of this ask cannot be read')
    }
    if (rules !== null && (agent.harness !== 'opencode' || label !== 'private')) refuse('WORKSPACE_MISMATCH', 'only a private OpenCode ask carries the owner\'s rules: Codex and Claude Code read their own')
    const request = askRequest(agent, version, { form, effort: inputs.effort, cwd, folder, rules, pictures: manifest.pictures.map((picture) => `${folder}/${ASK_RUN_FILES.inputs}/${picture.copy}`), browser: browser === null ? null : { origin: browser.origin, interact: browser.interact }, environment, contextTestLog })
    const built = askCommand(agent.harness, program, request)
    if (!Array.isArray(inputs.argv) || canonicalJson(inputs.argv) !== canonicalJson(built.argv)) {
      const at = Array.isArray(inputs.argv) ? built.argv.findIndex((value, index) => inputs.argv[index] !== value) : 0
      refuse('ROUTE_UNSUPPORTED', `the command is not the ask BMN builds for ${agent.id}${at === -1 ? ' (it carries more)' : ` (it differs at argument ${at})`}`)
    }
    note(`the command is BMN's ${form} form for ${appName(agent.harness)}, in ${cwd}`)
    if (browser !== null) note(`with the browser for ${browser.origin}${browser.interact ? ', looking and interacting' : ', looking only'}`)
    // Claude Code reads its pictures from one message on standard input: that message must be the pictures and the prompt, whole.
    let message = null
    if (built.stdin === 'stream-json') {
      let expected = null
      try {
        const pictures = manifest.pictures.map((picture) => ({ media_type: picture.media_type, bytes: readFileSync(`${folder}/${ASK_RUN_FILES.inputs}/${picture.copy}`) }))
        expected = sha256(claudePictureMessage(pictures, readText(prompt)))
        message = hashFile(`${folder}/${ASK_RUN_FILES.message}`)
      } catch {
        message = null
      }
      if (message === null || message !== expected) refuse('WORKSPACE_MISMATCH', 'the picture message on standard input is not the pictures and the prompt BMN wrote for this ask')
      note(`standard input: one message, ${manifest.pictures.length} picture(s) and the prompt`)
    }
    // The forms that read history run BMN's own git, first on their PATH: it must be BMN's, byte for byte.
    let git = null
    if (built.environment.PATH.startsWith(`${folder}/${ASK_RUN_FILES.bin}:`)) {
      try {
        git = hashFile(`${folder}/${ASK_RUN_FILES.bin}/git`)
      } catch {
        git = null
      }
      if (git === null || git !== hashFile(ASK_GIT_SCRIPT)) refuse('WORKSPACE_MISMATCH', 'the run\'s git is not BMN\'s own (bin/ask-git.sh)')
    }

    // The snapshots this check judges are the ones the start uses (72.3 AC1): the app's program as it is now, and the environment the command carries.
    const snapshots = `${folder}/${ASK_RUN_FILES.snapshots}`
    let identity = null
    let environmentSnapshot = null
    try {
      identity = JSON.parse(readText(`${snapshots}/executable.json`))
      environmentSnapshot = JSON.parse(readText(`${snapshots}/environment.json`))
    } catch {
      identity = null
    }
    if (!isObject(identity) || !isObject(identity.launcher) || !isObject(identity.payload) || !sameProgram(identity, program)) refuse('HARNESS_UNKNOWN', `${appName(agent.harness)}'s program is not the one BMN recorded for this ask`)
    if (!isObject(environmentSnapshot) || environmentSnapshot.sha256 !== sha256(JSON.stringify(built.environment))) refuse('WORKSPACE_MISMATCH', 'the environment of this ask is not the one BMN recorded')
    note(`snapshots: program ${identity.payload.sha256.slice(0, 12)}, environment ${environmentSnapshot.names.join(', ')}`)

    // Where it goes, read as `roster check` reads the same app's dispatch from the same folder: the same answers evaluate gives.
    const parsed = agent.harness === 'codex'
      ? { harness: 'codex', command: program.launcher, envMode: 'clean', assignments: built.environment, config: [...request.context.argv.filter((_, index) => index % 2 === 1), `model_reasoning_effort=${inputs.effort}`, 'mcp_servers={}', 'approval_policy="never"'], disable: [], model: agent.model, sandbox: 'read-only', resume: null, cd: cwd }
      : agent.harness === 'claude'
        ? { harness: 'claude', command: program.launcher, envMode: 'clean', assignments: built.environment, addDir: [], model: agent.model, effort: inputs.effort }
        // OpenCode's command read by the same parser as every OpenCode dispatch.
        : parseOpenCode(built.command.slice(1), { harness: 'opencode', command: program.launcher, envMode: 'clean', assignments: built.environment })
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    const own = agent.harness === 'opencode' ? openCodeAskConfig(form === 'opencode-reader' ? 'reader' : 'asker', rules) : null
    const resolution = agent.harness === 'codex' ? resolveCodexRoute(parsed, {}, cwd)
      : agent.harness === 'claude' ? resolveClaudeRoute(parsed, {}, cwd)
        : resolveOpenCodeRoute(parsed, { agent: own.agent, folder: true, inline: own.content })
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    // OpenCode names a model with its provider (`-m opencode-go/gpt-6-luna`), as research's check reads it.
    const { model, effort } = checkModelAndEffort(agent.harness === 'opencode' && !agent.model.includes('/') ? { ...agent, model: `${agent.provider}/${agent.model}` } : agent, resolution, note)
    checkRoleEffort(role, agent, effort, note)
    const context = checkContext(agent, resolution.context, proven, agent.context_limit === undefined ? [] : provenPrecedence(agent.harness, version, contextTestLog))
    if (context.refusal) refuse('CONTEXT_MISMATCH', context.refusal, context.why)
    note(context.note)
    const destination = matchedDestination(data, agent, agent.harness, resolution.route, note)

    // Consent covers the inputs named and what the form's own mode can read (R72-NFR6).
    const reading = modeInput(form, appName(agent.harness), project, browser)
    const consent = askConsent(data, destination, [...manifest.inputs, ...(reading === null ? [] : [reading])], label, now, note)
    const answer = privateWorkAnswer(data, destination, null)
    note(`private work: ${answer.reason}`)

    const body = {
      version: 1, mode: 'ask', verdict: 'PASS', agent: agent.id, class: agent.class, harness: agent.harness, model: model.value,
      role: role.id, effort: effort.value, context_limit_applied: context.applied,
      ...(agent.context_limit !== undefined && context.applied === null ? { context_limit_note: context.note } : {}),
      form, reads: { scope: reads.scope, words: reads.words, folder: cwd }, project, cwd, ...(manifest.pictures.length > 0 ? { pictures: manifest.pictures.length } : {}),
      sandbox: agent.harness === 'codex' ? { mode: 'read-only', source: '--sandbox read-only', approval_policy: 'never', tools: 'Codex\'s own: shell, Git, web search, sub-agents' }
        : agent.harness === 'claude' ? { mode: 'read-only', source: '--permission-mode dontAsk --restricted', tools: ['Read', 'Grep', 'Glob', 'git log', 'git show', 'git diff', 'git blame', 'WebSearch', 'Agent'] }
          : { mode: 'read-only', source: '--agent', agent: own.agent, tools: form === 'opencode-reader' ? ['read', 'glob', 'grep', 'list', 'git log', 'git show', 'git diff', 'git blame', 'websearch', `subagent ${OPENCODE_ASK_AGENTS.subagent}`] : [] },
      run: basename(folder), data: label, consent,
      inputs_sha256: sha256(canonicalJson(manifest)),
      snapshots: {
        executable: { launcher: identity.launcher.sha256, payload: identity.payload.sha256 },
        environment: environmentSnapshot.sha256, rules: rules === null ? null : sha256(rules), prompt: promptHash, ...(message === null ? {} : { message }), ...(git === null ? {} : { git })
      },
      argv_sha256: sha256(canonicalJson(built.argv)),
      harness_version: { version, state: tested.state, form_checked_on: checked },
      route: receiptRoute(destination, resolution.route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: file.hash,
      issued_at: now.toISOString()
    }
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps, argv: built.argv, form: built }
  } catch (error) {
    if (error instanceof Refusal) return { verdict: 'REFUSED', code: error.code, message: error.message, next: NEXT_STEP[error.code], steps, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    throw error
  }
}

/** `--verify`: recomputes everything but `issued_at` from the receipt's stored inputs. */
export function verifyReceipt(path, argv, options = {}) {
  const receipt = readReceiptFile(path)
  if (receipt === null) return { ok: false, reason: `${path} is not an intact version-1 receipt` }
  let result
  try {
    result = evaluateReceipt(receipt, argv, options)
  } catch (error) {
    // Approved state that is missing or corrupt now means the receipt cannot be reproduced.
    if (error instanceof RosterError) return { ok: false, reason: `the receipt cannot be checked again: ${error.code}: ${error.message}` }
    throw error
  }
  if (result.verdict !== 'PASS') return { ok: false, reason: `the dispatch no longer passes: ${result.code}: ${result.message}` }
  return sameReceipt(receipt, result.receipt)
}

/** The receipt's dispatch, evaluated as of now: a public record that went stale since issuance no longer reproduces it. */
function evaluateReceipt(receipt, argv, options) {
  if (receipt.mode === 'research') return evaluateResearch({ agent: receipt.agent, cwd: receipt.cwd, stdin: receipt.stdin?.path, argv, settled: true }, options)
  return evaluate({
    agent: receipt.agent, role: receipt.role, workspace: receipt.workspace, data: receipt.data, cwd: receipt.cwd, argv,
    ...(receipt.stdin ? { stdin: receipt.stdin.path } : {}),
    ...(receipt.packet ? { packet: receipt.packet.path } : {}),
    ...(receipt.resume ? { resumeOf: receipt.resume.original_receipt } : {})
  }, options)
}

function sameReceipt(receipt, recomputed) {
  const strip = (value) => {
    const rest = { ...value }
    delete rest.receipt_hash
    delete rest.issued_at
    return rest
  }
  const before = strip(receipt)
  const after = strip(recomputed)
  if (canonicalJson(before) !== canonicalJson(after)) {
    const changed = Object.keys({ ...before, ...after }).filter((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null))
    return { ok: false, reason: `the receipt no longer matches: ${changed.join(', ')} changed` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------
// The route inspection

/**
 * Where an app's command would send data, as BMN can read it: the harness's own provider and host
 * with the deciding sources. With `data`, also the roster provider that names and whether it may
 * see private work. Inspection only: it never authorizes anything.
 */
export function inspectRoute(agent, argv, environment, processCwd, data = null) {
  let result
  if (agent.harness === 'opencode') {
    const version = harnessVersion('opencode', environment)
    result = { ...inspectOpenCode(environment), harness: 'opencode', version, version_state: versionStanding('opencode', version).state }
  } else if (isRetired(agent.harness)) {
    result = { harness: agent.harness, basis: 'unknown', provider: null, host: null, reason: retiredWords(agent.harness), sources: [], inspection_only: true }
  } else {
    const parsed = argv === null
      ? (agent.harness === 'codex' ? { harness: 'codex', command: 'codex', envMode: 'inherit', assignments: {}, config: [] } : { harness: 'claude', command: 'claude', envMode: 'inherit', assignments: {}, addDir: [] })
      : parseDispatch(argv)
    if (parsed.unsupported) return { harness: agent.harness, unsupported: parsed.unsupported }
    const resolution = parsed.harness === 'codex' ? resolveCodexRoute(parsed, environment, processCwd) : resolveClaudeRoute(parsed, environment, processCwd)
    if (resolution.unsupported) return { harness: parsed.harness, unsupported: resolution.unsupported }
    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    result = {
      harness: parsed.harness, ...resolution.route,
      model: resolution.model?.value ?? null, effort: resolution.effort?.value ?? null,
      version, version_state: versionStanding(parsed.harness, version).state
    }
  }
  if (data !== null && result.basis !== undefined) {
    const destination = destinationOf(data, result.harness, result)
    if (destination.known && destination.provider !== null) {
      result.roster_provider = destination.provider
      result.private_work = result.inspection_only || destination.unapproved !== undefined ? 'public_only' : privateWorkAnswer(data, destination, null).allowed ? 'allowed' : 'public_only'
    }
  }
  return result
}
