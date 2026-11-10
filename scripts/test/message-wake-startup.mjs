// MODULE: message-wake-startup.mjs - bounded native startup and unconditional cleanup for 113.7
import { classifyScreen, startupStep } from './away-skills-startup.mjs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { processTree } from './away-skills-processes.mjs'

/** Socket instructions belong only to commands that actually use the BMN socket. */
export function messageSocketGuidance(app, commands, audience) {
  if (app !== 'codex' || !commands.some(command => /^bmn\s/u.test(command))) return ''
  if (audience === 'sender') return 'For each bmn socket call request sandbox_permissions=require_escalated on the first attempt, justification: synthetic BMN socket check. Keep auto_review and honor any refusal. '
  if (audience === 'receiver') return ' For every bmn command request sandbox_permissions=require_escalated on its first attempt, justification: synthetic BMN socket check. Keep the approval reviewer; if refused, report refusal and stop.'
  throw new Error('Unknown socket guidance audience')
}

/** Resolve an inner marker PID only within an existing, identity-pinned owned tree.
 * The returned host identity is for observation, never a cleanup authority.
 */
export function messageProcessIdentity({ root, marker, argv, uid = process.getuid() }, proc = '/proc') {
  const fail = reason => ({ identity: null, reason })
  const stat = pid => {
    const value = readFileSync(join(proc, String(pid), 'stat'), 'utf8'), end = value.lastIndexOf(')')
    const fields = value.slice(end+1).trim().split(/\s+/u)
    return { pid, ppid: Number(fields[1]), start_ticks: fields[19], state: fields[0], comm: value.slice(value.indexOf('(')+1, end) }
  }
  const live = row => row && !['Z', 'X', 'x'].includes(row.state)
  try {
    if (!root || !Number.isSafeInteger(root.pid) || root.pid <= 0 || !/^\d+$/u.test(root.start_ticks) ||
        !marker || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || !/^\d+$/u.test(marker.start_ticks) ||
        !Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string') || !Number.isSafeInteger(uid)) return fail('Invalid identity inputs')
    const before = stat(root.pid)
    if (!live(before) || before.start_ticks !== root.start_ticks) return fail('Owned root changed')
    const matches = []
    for (const row of processTree(root.pid, proc)) {
      if (row.pid === root.pid || row.start_ticks !== marker.start_ticks || !row.comm.startsWith('python3')) continue
      const directory = join(proc, String(row.pid)), status = readFileSync(join(directory, 'status'), 'utf8')
      const namespace = status.match(/^NSpid:\s*(\d+(?:[\t ]+\d+)*)\s*$/mu)?.[1].split(/\s+/u).map(Number)
      const owner = status.match(/^Uid:\s*(\d+(?:[\t ]+\d+){3})\s*$/mu)?.[1].split(/\s+/u).map(Number)
      const command = readFileSync(join(directory, 'cmdline'), 'utf8').split('\0')
      if (command.at(-1) === '') command.pop()
      const current = stat(row.pid)
      if (live(current) && current.start_ticks === row.start_ticks && current.ppid === row.ppid && current.comm === row.comm &&
          namespace?.[0] === row.pid && namespace.at(-1) === marker.pid && owner?.[0] === uid && owner[1] === uid &&
          command.length === argv.length && command.every((value, index) => value === argv[index])) matches.push(current)
    }
    const after = stat(root.pid)
    if (!live(after) || after.start_ticks !== root.start_ticks) return fail('Owned root changed during resolution')
    if (matches.length !== 1) return fail(matches.length ? 'Ambiguous marker identity' : 'No exact owned marker identity')
    const current = stat(matches[0].pid)
    if (!live(current) || current.start_ticks !== marker.start_ticks || current.ppid !== matches[0].ppid) return fail('Marker identity changed during resolution')
    return { identity: current, reason: null }
  } catch { return fail('Process identity could not be read') }
}

const staticProfileFiles = ['claude/settings.json', 'codex/hooks.json', 'codex/config.toml']
const optionalProfileFiles = ['claude/CLAUDE.md', 'claude/settings.local.json', 'codex/AGENTS.md', 'codex/requirements.toml']
const digest = text => createHash('sha256').update(text).digest('hex')
const { parse: parseToml } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('smol-toml')
const table = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const codexDrift = () => { throw new Error('Retained profile configuration drifted: invalid Codex config') }
// Parsing integers as BigInt preserves the distinction from TOML floats such as 1.0.
// Only safe integers are admitted; dates, floats and non-finite values fail closed.
const typedToml = value => {
  if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return ['integer', String(value)]
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value]
  if (Array.isArray(value)) return ['array', value.map(typedToml)]
  if (table(value)) return ['table', Object.keys(value).sort().map(key => [key, typedToml(value[key])])]
  return codexDrift()
}
function codexConfiguration(text) {
  let configuration
  try {
    configuration = parseToml(text, { integersAsBigInt: true, unsafeKeyBehaviour: 'throw' })
    typedToml(configuration)
    assertMessageSetupConfiguration(configuration)
  } catch { return codexDrift() }
  return configuration
}
/** Both static seals and qualification inputs use this same protected, typed projection. */
export function messageCodexConfigurationBinding(text, fixtures) {
  const configuration = codexConfiguration(text), protectedPart = structuredClone(configuration)
  const nux = protectedPart.tui?.model_availability_nux
  if (nux !== undefined) {
    if (!table(nux)) return codexDrift()
    for (const [key, value] of Object.entries(nux)) {
      if (typeof value !== 'bigint' || value < 0n || value > 4294967295n) return codexDrift()
      nux[key] = 'u32' // The key set stays bound; only the native tooltip count changes.
    }
  }
  if (table(protectedPart.projects)) {
    for (const fixture of fixtures) {
      const project = protectedPart.projects[fixture]
      if (table(project) && project.trust_level === 'trusted') {
        delete project.trust_level
        if (!Object.keys(project).length) delete protectedPart.projects[fixture]
      }
    }
    if (!Object.keys(protectedPart.projects).length) delete protectedPart.projects
  }
  return { encoding: 'codex-config-semantic-v1', sha256: digest(JSON.stringify(typedToml(protectedPart))), rawSha256: digest(text) }
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
function claudeSetupSemantics(text) {
  let settings
  try { settings = JSON.parse(text) } catch { throw new Error('Retained profile configuration drifted: invalid Claude settings') }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Retained profile configuration drifted: invalid Claude settings')
  delete settings.theme
  return digest(JSON.stringify(canonical(settings)))
}
/** A closed nonsecret projection; credentials and native transcripts are never read or hashed. */
export function messageProfileSnapshot(profiles, fixtures) {
  const identity = path => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('Bundle directories must be private real directories')
    return { path: realpathSync(path), device: String(stat.dev), inode: String(stat.ino) }
  }
  const directories = { profiles: identity(profiles), homes: ['claude', 'codex'].map(name => identity(join(profiles, name))), fixtures: fixtures.map(identity) }
  let codexConfigRawSha256
  const files = Object.fromEntries([...staticProfileFiles, ...optionalProfileFiles].map(name => {
    const path = join(profiles, name)
    let stat
    try { stat = lstatSync(path) } catch (error) {
      if (error.code === 'ENOENT' && optionalProfileFiles.includes(name)) return [name, null]
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`Unsafe static profile file: ${name}`)
    const bytes = readFileSync(path)
    if (name === 'codex/config.toml') {
      const { rawSha256, ...semantic } = messageCodexConfigurationBinding(bytes.toString('utf8'), directories.fixtures.map(row => row.path))
      codexConfigRawSha256 = rawSha256
      return [name, { ...semantic, mode: stat.mode & 0o777 }]
    }
    return [name, { sha256: digest(bytes), mode: stat.mode & 0o777 }]
  }))
  const statePath = join(profiles, 'claude/.claude.json')
  if (existsSync(statePath) && lstatSync(statePath).isSymbolicLink()) throw new Error('Native onboarding state must belong to the bundle')
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
  return {
    version: 1,
    static: { ...directories, files },
    codexConfigRawSha256,
    claudeSetupSemanticsSha256: claudeSetupSemantics(readFileSync(join(profiles, 'claude/settings.json'), 'utf8')),
    onboarding: {
      hasCompletedOnboarding: state.hasCompletedOnboarding === true,
      fixtures: fixtures.map(path => ({ path: realpathSync(path), hasTrustDialogAccepted: state.projects?.[realpathSync(path)]?.hasTrustDialogAccepted === true }))
    }
  }
}

export function assertMessageProfileSeal(seal, current, { ownerSetup = false, preparedClaudeSettings = null } = {}) {
  // Native Codex writes its setup/trust state to config.toml. Hook declarations,
  // instructions and directory identities stay fixed, including before the first seal.
  const staticPart = profile => ownerSetup && profile?.static
    ? { ...profile.static, files: { ...profile.static.files, 'codex/config.toml': null } }
    : profile?.static
  const expected = staticPart(seal), received = staticPart(current)
  const beforeClaude = expected?.files?.['claude/settings.json'], afterClaude = received?.files?.['claude/settings.json']
  if (ownerSetup && beforeClaude && afterClaude && beforeClaude.sha256 !== afterClaude.sha256 &&
      typeof preparedClaudeSettings === 'string' && digest(preparedClaudeSettings) === beforeClaude.sha256 &&
      current.claudeSetupSemanticsSha256 === claudeSetupSemantics(preparedClaudeSettings)) {
    received.files['claude/settings.json'] = { ...afterClaude, sha256: beforeClaude.sha256 }
  }
  if (seal?.version !== 1 || current?.version !== 1 || JSON.stringify(expected) !== JSON.stringify(received)) throw new Error('Retained profile or static configuration drifted; no launch permitted')
  if (!current.onboarding.hasCompletedOnboarding) throw new Error('Owner onboarding is required before launch')
}

export const messageCodexConfiguration = Object.freeze({ approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write', model: 'gpt-6-luna', model_reasoning_effort: 'low' })
export function assertMessageSetupConfiguration(configuration) {
  if (Object.entries(messageCodexConfiguration).some(([key, value]) => configuration[key] !== value) || configuration.profile !== undefined || configuration.model_provider !== undefined || Object.keys(configuration.model_providers ?? {}).length || Object.keys(configuration.mcp_servers ?? {}).length) throw new Error('Owner setup changed the declared native access or model configuration')
}

/** Pure one-time migration proof; the caller may write only bundle-root harness receipts. */
export function messageProfileSealMigration(seal, current, { preimage, currentConfig, expectedRawSha256, expectedChanges }) {
  const fail = () => { throw new Error('Retained profile seal migration drifted; no native launch permitted') }
  const legacy = seal?.static?.files?.['codex/config.toml'], now = current?.static?.files?.['codex/config.toml']
  if (seal?.version !== 1 || current?.version !== 1 || legacy?.encoding !== undefined || legacy?.sha256 !== digest(preimage) || legacy?.mode !== 0o600 || now?.mode !== 0o600 ||
      current.codexConfigRawSha256 !== expectedRawSha256 || digest(currentConfig) !== expectedRawSha256 || !seal.onboarding?.hasCompletedOnboarding || !current.onboarding?.hasCompletedOnboarding) return fail()
  const withoutConfig = snapshot => ({ ...snapshot.static, files: { ...snapshot.static.files, 'codex/config.toml': null } })
  if (JSON.stringify(withoutConfig(seal)) !== JSON.stringify(withoutConfig(current))) return fail()
  const fixtures = seal.static.fixtures.map(row => row.path)
  const before = messageCodexConfigurationBinding(preimage, fixtures), after = messageCodexConfigurationBinding(currentConfig, fixtures)
  if (before.sha256 !== after.sha256 || now.encoding !== after.encoding || now.sha256 !== after.sha256) return fail()
  const changes = []
  const diff = (left, right, path = []) => {
    if (table(left) && table(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) diff(left[key], right[key], [...path, key])
    } else if (JSON.stringify(left === undefined ? null : typedToml(left)) !== JSON.stringify(right === undefined ? null : typedToml(right))) changes.push({ path, before: left === undefined ? null : typedToml(left), after: right === undefined ? null : typedToml(right) })
  }
  diff(codexConfiguration(preimage), codexConfiguration(currentConfig))
  if (JSON.stringify(changes) !== JSON.stringify(expectedChanges)) return fail()
  assertMessageProfileSeal(current, current)
  return { seal: current, receipt: { version: 1, encoding: after.encoding, preimageSha256: before.rawSha256, currentRawSha256: after.rawSha256, protectedSha256: after.sha256, changes, otherStaticUnchanged: true, onboardingComplete: true } }
}

/** A missing child antecedent leaves acceptance unproved but need not erase independent evidence. */
export function recordMessageVerdict(verdicts, name, value, { independentMayContinue = false } = {}) {
  verdicts[name] = value
  if (value.pass !== true && !independentMayContinue) throw new Error(`UNVERIFIED: ${name}; stop this method before dependent scenarios`)
}

const HOOK_QUERY_REASONS = [[/^no answer in /u, 'timeout'], [/^Codex ended without answering$/u, 'ended'], [/^an answer BMN cannot read$/u, 'unreadable'],
  [/^Codex refused the question$/u, 'initialize-rejected'], [/^this Codex cannot list its hooks$/u, 'method-missing'], [/^E[A-Z0-9_]+$/u, 'spawn-error'],
  [/^Codex could not load its settings$/u, 'settings-errors'], [/^Codex does not list BMN's /u, 'entry-missing'], [/^Codex lists another command /u, 'command-mismatch'],
  [/^Codex said something BMN does not know /u, 'entry-unknown']]
const HOOK_TRUST = new Set(['trusted', 'managed', 'untrusted', 'modified'])
const hookCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null

/** Why the harness could not enter a query's process in its inventory, as a closed code. */
export function messageRegistrationCode(error) {
  if (error === null || error === undefined) return null
  const text = String(error?.message ?? '')
  return /would exceed recovery bound/u.test(text) ? 'handoff-bound' : /Missing handoff Started inventory/u.test(text) ? 'handoff-heading'
    : Number.isInteger(error?.status) || typeof error?.signal === 'string' ? 'handoff-check' : 'unknown'
}

/** What one local hooks/list query came to, as closed values only: no output, command, path or error text. */
export function messageHookQueryProjection({ invocation, phase, fixture, answer, approval, entries, timing, actors, registration = null }) {
  const state = ['approved', 'not-approved', 'unverified'].includes(approval?.state) ? approval.state : 'unknown'
  const reason = state === 'approved' ? null : state === 'not-approved' ? 'entries-off'
    : HOOK_QUERY_REASONS.find(([pattern]) => pattern.test(String(approval?.reason ?? answer?.reason ?? '')))?.[1] ?? 'unknown'
  const listed = new Map((Array.isArray(answer?.hooks) ? answer.hooks : []).filter(row => row !== null && typeof row === 'object').map(row => [row.key, row]))
  return { invocation, phase, fixture, registration, answerState: ['read', 'unread'].includes(answer?.state) ? answer.state : 'unknown', reason,
    warnings: hookCount(answer?.warnings), errors: hookCount(answer?.errors), approvalState: state,
    entries: entries.map(entry => {
      const row = listed.get(entry.key)
      return { event: entry.event, present: row !== undefined, enabled: typeof row?.enabled === 'boolean' ? row.enabled : null,
        trustStatus: row === undefined ? null : HOOK_TRUST.has(row.trustStatus) ? row.trustStatus : 'unknown', commandMatches: row !== undefined && row.command === entry.command }
    }), timing, actors }
}

/** Every required query leaves its projection before any guard can throw; cleanup runs first and a failed save stops progress. */
export async function collectMessageHookQueries({ folders, entries, phase, nextInvocation, ask, approvalFrom, startActor, finishActor, save, now = Date.now }) {
  const results = [], sha = text => createHash('sha256').update(text).digest('hex')
  for (const [index, cwd] of folders.entries()) {
    const actors = [], invocation = nextInvocation(), timing = { startedAt: now(), answeredAt: null, cleanedAt: null }
    let answer, askError = null, cleanupError = null, startError = null
    try {
      answer = await ask({ cwd, limitMs: 10000, start: (program, args, options) => {
        let actor
        try { actor = startActor(program, args, options, { invocation, index }) } catch (error) { startError = error; throw error }
        actors.push(actor); return actor.child
      } })
      timing.answeredAt = now()
    } catch (error) { askError = error }
    const registrationError = actors.find(actor => actor.registrationError)?.registrationError ?? null
    for (const actor of actors) { try { await finishActor(actor) } catch (error) { cleanupError ??= error } }
    timing.cleanedAt = now()
    const approval = answer === undefined ? { state: 'unverified', reason: 'unknown' } : approvalFrom(answer, entries)
    save(messageHookQueryProjection({ invocation, phase, fixture: { index, cwdSha256: sha(cwd) }, answer, approval, entries, timing,
      registration: startError ? 'start-failed' : messageRegistrationCode(registrationError),
      actors: actors.map(actor => ({ pid: actor.child?.pid ?? null, startTicks: actor.identities?.[0]?.start_ticks ?? null, exited: actor.exited === true,
        exitCode: actor.child?.exitCode ?? null, signal: typeof actor.child?.signalCode === 'string' ? actor.child.signalCode : null,
        killed: actor.stop?.killed?.length ?? null, remaining: actor.stop?.remaining?.length ?? null })) }))
    if (startError) throw new Error('Hook query process could not be started by the harness', { cause: startError })
    if (registrationError) throw new Error(`Hook query inventory registration failed (${messageRegistrationCode(registrationError)}); no approval answer is implied`, { cause: registrationError })
    if (askError) throw askError
    if (cleanupError) throw cleanupError
    const listed = new Map((answer.hooks ?? []).map(row => [row.key, row]))
    const statuses = entries.map(entry => ({ key: entry.key, event: entry.event, expectedCommandSha256: sha(entry.command), enabled: listed.get(entry.key)?.enabled ?? null, trustStatus: listed.get(entry.key)?.trustStatus ?? null }))
    results.push({ cwd, approval, statuses, processExitVerified: true, actors: actors.map(actor => ({ identity: actor.row, exited: actor.exited, cleanup: actor.stop })) })
  }
  return results
}

/** Two real starts and complete shutdowns per receiver; paths alone cannot transfer qualification. */
export function assertMessageQualifications(receipts, app, binding) {
  const stable = value => JSON.stringify({ ...value, profiles: { static: value?.profiles?.static } })
  const identities = new Set()
  for (const kind of ['claude', 'codex']) {
    const cycles = receipts?.[kind]
    if (!Array.isArray(cycles) || cycles.length !== 2) throw new Error('Two retained startup/shutdown receipts per app are required')
    let shutdownAt = 0
    for (const cycle of cycles) {
      const identity = cycle?.applicationIdentity
      const key = identity && `${identity.pid}:${identity.start_ticks}`
      if (cycle?.version !== 2 || cycle.app !== kind || cycle.pass !== true || !key || identities.has(key) ||
          !Number.isFinite(cycle.startedAt) || !Number.isFinite(cycle.shutdownAt) || cycle.startedAt <= shutdownAt || cycle.shutdownAt <= cycle.startedAt ||
          cycle.cleanup?.primary !== null || cycle.cleanup?.errors?.length !== 0 || cycle.cleanup?.stopped?.stopped !== true || cycle.cleanup.stopped.remaining?.length !== 0 ||
          cycle.evidence?.length !== 5 || cycle.evidence.some(row => row.pass !== true || !row.rootStop || !row.executionMarker || !row.session) || new Set(cycle.evidence.map(row => row.session)).size !== 5 ||
          cycle.binding?.app !== kind || cycle.binding?.profiles?.onboarding?.hasCompletedOnboarding !== true ||
          JSON.stringify(cycle.profilesAfter?.static) !== JSON.stringify(cycle.binding?.profiles?.static)) throw new Error('Incomplete or reused native startup/shutdown receipt')
      if (stable(cycle.binding) !== stable(cycles[0].binding)) throw new Error('Retained restart binding changed')
      identities.add(key); shutdownAt = cycle.shutdownAt
    }
    if (kind === app && stable(cycles[0].binding) !== stable(binding)) throw new Error('Startup qualification invalidated by current build, driver or configuration')
  }
  const common = value => JSON.stringify({ native: value.observedNative, payloads: value.nativePayloads, targets: value.targets, tests: value.testsSha256, captures: value.capturesSha256,
    build: value.qualifiedInputs.candidateBuildSha256, driver: value.qualifiedInputs.driverSha256, classifier: value.qualifiedInputs.classifierSha256, parent: value.qualifiedInputs.parentClassifierSha256 })
  if (common(receipts.claude[0].binding) !== common(receipts.codex[0].binding)) throw new Error('Both apps must qualify the same candidate and harness')
}

export function messageChildFixture(directory) {
  const pulse = join(directory, 'pulse.json'), release = join(directory, 'release'), parentReady = join(directory, 'parent-ready')
  // Typed prompts are one line: a newline submits, so the two programs are files the prompt names (method 6 repair).
  return { pulse, release, parentReady, bootstrapProgram: join(directory, 'bootstrap.py'), foregroundProgram: join(directory, 'foreground.py'),
    bootstrap: `import time\nfrom pathlib import Path\np=Path(${JSON.stringify(parentReady)})\ndeadline=time.monotonic()+240\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(0.25)\nassert p.exists(), 'parent never stopped'\n`,
    foreground: `import json,os,time\nfrom pathlib import Path\npulse=Path(${JSON.stringify(pulse)})\nrelease=Path(${JSON.stringify(release)})\nidentity=Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19]\ndeadline=time.monotonic()+600\nwhile not release.exists() and time.monotonic()<deadline:\n pulse.with_suffix('.new').write_text(json.dumps({'pid':os.getpid(),'start_ticks':identity,'at':time.time()*1000}))\n os.replace(pulse.with_suffix('.new'),pulse)\n time.sleep(0.5)\nprint('child-latch-released' if release.exists() else 'child-latch-expired',flush=True)\n` }
}

export function messageActivityFixture(directory) {
  const execution = join(directory, 'executed.json'), program = join(directory, 'foreground.py')
  return { execution, program, source: `import json,os,time\nfrom pathlib import Path\np=Path(${JSON.stringify(execution)})\nfor n in range(8):\n p.with_suffix('.new').write_text(json.dumps({'pid':os.getpid(),'pulse':n,'at':time.time()*1000}))\n os.replace(p.with_suffix('.new'),p)\n print('NATIVE_ACTIVITY_PULSE_'+str(n),flush=True)\n time.sleep(0.25)\ntime.sleep(120)\n` }
}

/** A qualified conversation's current composer; earlier prompts remain history, never startup input. */
export function messageActivityComposer(app, lines) {
  if (!['claude', 'codex'].includes(app)) return false
  const prompt = app === 'codex' ? /^›(?:\s|$)/u : /^\s*[│|]?\s*[>❯](?:\s|$)/u
  const at = lines.findLastIndex(line => prompt.test(line))
  if (at < 0 || lines.some(line => /esc to interrupt/iu.test(line))) return false
  const selected = /^\s*[›❯>]\s*\S/u, numbered = /^\s*[›❯>]?\s*\d+\.\s/u
  if (lines.some(line => selected.test(line) && numbered.test(line))) return false
  const tail = lines.slice(Math.max(0, at-1))
  if (/Hooks need review|allow (?:this|once|always)|\bapprove\b|permission request|authenticat|API key|(?:sign|log)\s?in|update available|restart to update/iu.test(tail.join('\n')) ||
      tail.some(line => /enter to (?:confirm|continue|select)|esc (?:to )?(?:back|cancel)/iu.test(line))) return false
  // The same qualified forms as startup; only the historical prompt-count rule is inapplicable here.
  const ready = app === 'codex'
    ? (screen, at) => { const header = screen.findIndex(line => /^\s*[│|]?\s*>_ OpenAI Codex \(v/u.test(line)), footer = screen.findLastIndex(line => /^\s{2}\S.* · ~?\//u.test(line)); return header >= 0 && header < at && at < footer }
    : (screen, at) => {
      const rule = line => /^─{20,}$/u.test(line ?? '')
      const header = screen.findIndex(line => /Claude Code v\d/u.test(line))
      const footer = screen.findIndex((line, index) => index > at + 1 && /⏵⏵|\? for shortcuts|accept edits|plan mode|bypass permissions|auto mode/iu.test(line))
      return header >= 0 && header < at - 1 && rule(screen[at - 1]) && rule(screen[at + 1]) && footer > at + 1
    }
  return ready(lines, at)
}

/** The owner-window terminal byte channel, exactly as a key reaches xterm's attached PTY. */
export async function messageNativeEscape({ sessionId, incarnationId, bridge = globalThis.aiTerminal }) {
  let unsubscribe, timer
  try {
    const startup = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native terminal attachment unavailable')), 1000)
      unsubscribe = bridge.onStartup(resolve)
    })
    const live = startup.liveSessions?.find(row => row.sessionId === sessionId)
    if (!live?.attachmentId || live.incarnationId !== incarnationId) throw new Error('Native terminal incarnation changed')
    bridge.sendTerminalInput(live.attachmentId, new Uint8Array([27]))
    return { attachmentId: live.attachmentId, incarnationId, bytes: [27], transportedAt: Date.now() }
  } finally { clearTimeout(timer); unsubscribe?.() }
}

/** Each CLI observes independently; the host's report.at, rather than loop completion, is measured. */
export function messageNowSampler({ argv, directory, stop, seconds = 75 }) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string') || !Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new Error('Invalid bounded Now sampler')
  const quote = text => `'${String(text).replaceAll("'", `'\\''`)}'`
  return `umask 077
mkdir -p ${quote(directory)} || exit 1
sampler_deadline=$((SECONDS+${seconds}))
sampler_index=0
sampler_status=0
while [ ! -e ${quote(stop)} ] && [ "$SECONDS" -lt "$sampler_deadline" ]; do
  sampler_index=$((sampler_index+1))
  ${argv.map(quote).join(' ')} > ${quote(directory)}/"$sampler_index".new 2> ${quote(join(directory, 'stderr'))}
  sampler_status=$?
  [ "$sampler_status" -eq 0 ] || break
  mv ${quote(directory)}/"$sampler_index".new ${quote(directory)}/"$sampler_index".json || { sampler_status=1; break; }
done
printf '%s\\n' "$sampler_status" > ${quote(join(directory, 'exit.new'))}
mv ${quote(join(directory, 'exit.new'))} ${quote(join(directory, 'exit'))}
exit "$sampler_status"`
}

/** Claude's Bash PreToolUse is guard-only; the completed echo's PostToolUse/Stop proves recording. */
export function messageRecorderHealthy(events, { incarnationId, since }) {
  return ['PostToolUse', 'Stop'].every(event => events.some(row => row.incarnationId === incarnationId && row.event === event && Date.parse(row.observedAt) >= since))
}

/** A no-event verdict requires the actual antecedent and an uninterrupted sixty-second recording. */
export function messageActivityVerdict(evidence) {
  const { samples = [], escapeAt, completedAt, lastOutputAt, firstResting = {} } = evidence
  const failures = []
  const require = (condition, reason) => { if (!condition) failures.push(reason) }
  require(evidence.executionProved === true && evidence.working?.every(value => value === true) && evidence.working.length === 4, 'Actual foreground execution and four Working views required')
  require(Number.isFinite(escapeAt) && completedAt-escapeAt >= 60000 && samples[0]?.at <= escapeAt && samples.at(-1)?.at >= escapeAt+60000, 'Record continuously from before Escape through sixty seconds')
  require(samples.length > 2 && samples.every((row, i) => row.nativeAlive === true && row.incarnationId === evidence.incarnationId && (!i || row.at-samples[i-1].at <= 2000)), 'Native identity/incarnation survival or continuous recording unproved')
  require(evidence.recorder?.before === true && evidence.recorder?.after === true, 'Probe and product recorders must be healthy before and after')
  require(Number.isFinite(lastOutputAt) && lastOutputAt >= escapeAt && lastOutputAt <= escapeAt+8000 && completedAt-lastOutputAt >= 50000, 'Returned prompt must settle and remain silent')
  require(samples.filter(row => row.at >= escapeAt+8000).length > 0 && samples.filter(row => row.at >= escapeAt+8000).every(row => row.composer === true && row.lastOutputAt === lastOutputAt), 'Returned native composer and sustained silence unproved')
  require(Object.keys(firstResting).length === 4 && Object.values(firstResting).every(at => Number.isFinite(at) && at >= lastOutputAt && at-lastOutputAt <= 2000), 'All four first-resting observations must meet the shared 2000ms bound')
  const noEventCondition = evidence.probeEventsAfter?.length === 0 && evidence.productEventsAfter?.length === 0
  if (evidence.app === 'claude') require(noEventCondition, 'Claude no-event antecedent not observed')
  return { pass: failures.length === 0, noEventCondition, failures, sharedBoundMs: 2000, route: evidence.probeEventsAfter?.map(row => row.eventName) ?? [] }
}
/** A launch typed after earlier output: the visible screen before it, then the command, compared exactly. */
export function messageLaunchEcho(before, launch) {
  if (!Array.isArray(before) || before.some(line => typeof line !== 'string') || typeof launch !== 'string' || !launch || /[\r\n]/u.test(launch)) throw new Error('Invalid launch echo inputs')
  const visible = before.map(line => line.trimEnd())
  while (visible.length && visible.at(-1) === '') visible.pop()
  if (!visible.length || !/\$$/u.test(visible.at(-1))) throw new Error('UNVERIFIED: no shell prompt before the launch')
  return `${visible.join('')} ${launch}`
}
export function classifyMessageStartup(app, lines, folder, context = null) {
  const text = lines.join('\n')
  const frame = /Choose the text style that looks best with your terminal|^\s*Accessing workspace:|^\s*Folder access|>_ OpenAI Codex \(v|Claude Code v[0-9]/mu.test(text)
  if (context && !context.appSeen && !frame) {
    const visible = [...lines]
    while (visible.length && visible.at(-1).trim() === '') visible.pop()
    if (!visible.length || visible.join('') === context.launchEcho) return { state: 'loading', detail: 'exact launch echo before app frame' }
    // A relaunch at the foot of a full screen scrolls whole earlier lines away; what remains is still an exact tail ending in the command.
    const shown = visible.join('')
    if (typeof context.launch === 'string' && context.launch && context.launchEcho.endsWith(shown) && shown.endsWith(` ${context.launch}`)) return { state: 'loading', detail: 'exact launch echo tail before app frame' }
    return { state: 'dialog', detail: 'unexpected text before app frame' }
  }
  if (context && frame) context.appSeen = true
  if (/Hooks need review|allow (?:this|once|always)|\bapprove\b|permission request|authenticat|API key|(?:sign|log)\s?in|update available|restart to update/iu.test(text)) return { state: 'dialog', detail: 'owner-only approval, authentication or update screen' }
  return classifyScreen(app, lines, folder)
}

/** Method4: the owner onboards the retained bundle; only exact fixture trust gets agent keys. */
export function messageStartupStep(history, used, { stableMs = 1500 } = {}) {
  const last = history.at(-1)
  if (!last) return { action: 'wait' }
  if (!['loading', 'composer', 'trust', 'trust-negative', 'dialog'].includes(last.state)) return { action: 'fail', reason: `unanswerable startup state: ${last.state}` }
  const next = startupStep(history, { keys: used.keys, answered: Boolean(used.trust), downSent: Boolean(used.trustDown), stableMs })
  if (next.action === 'down') return { action: 'key', key: 'ArrowDown', mark: 'trustDown' }
  if (next.action === 'enter') return { action: 'key', key: 'Enter', mark: 'trust' }
  return next
}

/** Each cleanup stage runs even if inventory, evidence retention or another stop failed. */
export async function cleanupMessageProbe({ primary = null, inventory, save, stopSessions, closeApplication, ensureStopped }) {
  const errors = []
  const attempt = async (name, action) => { try { return await action() } catch (error) { errors.push({ stage: name, reason: String(error?.message ?? error) }); return null } }
  const observation = await attempt('inventory', inventory)
  await attempt('inventory-save', () => save('inventory', observation))
  await attempt('sessions', stopSessions)
  await attempt('application', closeApplication)
  const stopped = await attempt('owned-identities', ensureStopped)
  await attempt('cleanup-save', () => save('cleanup', { stopped, errors }))
  return { primary, stopped, errors }
}
