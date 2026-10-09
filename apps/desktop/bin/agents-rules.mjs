// MODULE: agents-rules.mjs - Epic 60.4: one rules master rendered into each harness's own rules file, with check, install, restore and probes
import { spawnSync } from 'node:child_process'
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { HARNESSES, RosterError, agentState, agentsDirectory, canonicalJson, sha256 } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { AgentsUsageError, EXIT, failWith, out, readOptions, usage } from './agents-cli.mjs'
import { absoluteUncollapsed, pathState, replaceFileSafely, restorePathState } from './safe-config-write.mjs'
import { unifiedDiff } from './text-diff.mjs'

/**
 * The owner edits one file, `~/.config/bmn/agents/global-rules.md`. BMN renders it per harness and
 * writes each harness's own rules file as a generated regular file. A harness whose approved route
 * is not High gets the restricted rendering: the header and the sections the owner marked
 * shareable, never an empty file. Restrictions govern only the global files BMN writes, not
 * project files or skills a harness reads in a workspace.
 */

export const TEAM_LIMIT_BYTES = 1200
const TEAM_MARKER = '<!-- bmn:team -->'
const OPEN_HARNESS = /^<!--\s*bmn:harness\s+([a-z ,]+?)\s*-->$/
const CLOSE_HARNESS = /^<!--\s*\/bmn:harness\s*-->$/
const OPEN_SHAREABLE = /^<!--\s*bmn:shareable\s*-->$/
const CLOSE_SHAREABLE = /^<!--\s*\/bmn:shareable\s*-->$/
const ANY_MARKER = /<!--\s*\/?bmn:/

export function masterPath() {
  return `${agentsDirectory()}/global-rules.md`
}

function rulesStateDirectory() {
  return `${agentsDirectory()}/state/rules`
}

function lastWrittenPath() {
  return `${rulesStateDirectory()}/last-written.json`
}

function transactionsDirectory() {
  return `${rulesStateDirectory()}/transactions`
}

function historyDirectory() {
  return `${rulesStateDirectory()}/master-history`
}

function probeLogPath() {
  return `${agentsDirectory()}/state/probes.jsonl`
}

/** Each harness's own global rules file, resolved the way `bmn hooks` resolves its config folder. */
export function targetPath(harness, environment = process.env) {
  const home = environment.HOME || homedir()
  if (harness === 'claude') return `${absoluteUncollapsed(environment.CLAUDE_CONFIG_DIR || `${home}/.claude`)}/CLAUDE.md`
  if (harness === 'codex') return `${absoluteUncollapsed(environment.CODEX_HOME || `${home}/.codex`)}/AGENTS.md`
  if (harness === 'opencode') {
    return `${absoluteUncollapsed(environment.OPENCODE_CONFIG_DIR || `${environment.XDG_CONFIG_HOME || `${home}/.config`}/opencode`)}/AGENTS.md`
  }
  if (harness === 'cursor') return `${home}/.cursor/rules/bmn-global-rules.mdc`
  throw new RosterError('MASTER_INVALID', `unknown harness ${harness}`)
}

// ---------------------------------------------------------------------------------------------
// The master

/**
 * Parses the master into ordered parts: plain text (every harness), harness-limited sections,
 * shareable sections and the single team placeholder. Markers sit alone on their line; unknown
 * harnesses and unclosed, nested or duplicate markers are MASTER_INVALID with their lines.
 */
export function parseMaster(text) {
  const errors = []
  const parts = []
  let open = null
  let teamLine = null
  const lines = text.split('\n')
  lines.forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    let match
    if ((match = OPEN_HARNESS.exec(trimmed))) {
      const names = match[1].split(/[\s,]+/).filter(Boolean)
      const unknown = names.filter((name) => !HARNESSES.includes(name))
      if (unknown.length > 0) errors.push({ code: 'MASTER_INVALID', line, message: `unknown harness ${unknown.join(', ')} (use ${HARNESSES.join(', ')})` })
      if (open !== null) errors.push({ code: 'MASTER_INVALID', line, message: `marker nested inside the ${open.kind} section opened at line ${open.line}` })
      else open = { kind: 'harness', line, harnesses: names, lines: [] }
      return
    }
    if (OPEN_SHAREABLE.test(trimmed)) {
      if (open !== null) errors.push({ code: 'MASTER_INVALID', line, message: `marker nested inside the ${open.kind} section opened at line ${open.line}` })
      else open = { kind: 'shareable', line, lines: [] }
      return
    }
    if (CLOSE_HARNESS.test(trimmed) || CLOSE_SHAREABLE.test(trimmed)) {
      const kind = CLOSE_HARNESS.test(trimmed) ? 'harness' : 'shareable'
      if (open === null || open.kind !== kind) {
        errors.push({ code: 'MASTER_INVALID', line, message: `closing ${kind} marker with no matching opening marker` })
      } else {
        parts.push(open)
        open = null
      }
      return
    }
    if (trimmed === TEAM_MARKER) {
      if (teamLine !== null) errors.push({ code: 'MASTER_INVALID', line, message: `duplicate ${TEAM_MARKER} (first at line ${teamLine})` })
      else teamLine = line
      const team = { kind: 'team', line }
      if (open !== null) open.lines.push(team)
      else parts.push(team)
      return
    }
    if (ANY_MARKER.test(trimmed)) {
      errors.push({ code: 'MASTER_INVALID', line, message: `unrecognised bmn marker "${trimmed.slice(0, 60)}"` })
      return
    }
    const entry = { kind: 'text', text: raw }
    if (open !== null) open.lines.push(entry)
    else parts.push(entry)
  })
  if (open !== null) errors.push({ code: 'MASTER_INVALID', line: open.line, message: `${open.kind} section opened here is never closed` })
  return { parts, errors }
}

export function readMaster(path = masterPath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new RosterError('MASTER_MISSING', error.code === 'ENOENT' ? `no rules master at ${path}` : `cannot read ${path} (${error.code})`)
  }
  const parsed = parseMaster(text)
  if (parsed.errors.length > 0) {
    throw new RosterError('MASTER_INVALID', `${path} is not a valid rules master (${parsed.errors.length} error${parsed.errors.length === 1 ? '' : 's'})`, { errors: parsed.errors })
  }
  return { path, text, hash: sha256(text), parts: parsed.parts }
}

// ---------------------------------------------------------------------------------------------
// Rendering

function approvedOrNull() {
  try {
    return readApproved()
  } catch (error) {
    if (error instanceof RosterError && (error.code === 'NOT_APPROVED' || error.code === 'STATE_CORRUPT')) return null
    throw error
  }
}

/** The Team expansion: one line per enabled active agent, then a pointer; at most TEAM_LIMIT_BYTES. */
export function teamExpansion(generation) {
  const pointer = 'Ask `bmn team` for details.'
  if (generation === null) return { form: 'pointer (nothing approved)', text: pointer }
  const agents = generation.data.agents.filter((agent) => agentState(agent) === 'active')
  const withRoles = agents.map((agent) => `- ${agent.name}: ${agent.title}, ${agent.harness}, roles ${agent.roles.join(', ') || 'none'}, security ${agent.security}`)
  const full = [...withRoles, pointer].join('\n')
  if (Buffer.byteLength(full) <= TEAM_LIMIT_BYTES) return { form: 'full', text: full }
  const withoutRoles = [...agents.map((agent) => `- ${agent.name}: ${agent.title}, ${agent.harness}, security ${agent.security}`), pointer].join('\n')
  if (Buffer.byteLength(withoutRoles) <= TEAM_LIMIT_BYTES) return { form: 'without roles', text: withoutRoles }
  return { form: 'pointer only', text: pointer }
}

/** The approved route for a harness, and whether it gets the full or the restricted rendering. */
export function routeFor(harness, generation) {
  const route = generation?.data.harness_routes.find((entry) => entry.harness === harness)
  if (route === undefined) return { restricted: true, reason: generation === null ? 'nothing is approved' : 'no approved route', route: null }
  if (route.security === 'low') return { restricted: true, reason: `${route.basis === 'owner-declared' ? 'owner-declared ' : ''}Low route`, route }
  return { restricted: false, reason: route.basis === 'owner-declared' ? 'owner-declared High route' : 'High route', route }
}

function renderLines(entries, harness, team) {
  const out = []
  for (const entry of entries) {
    if (entry.kind === 'text') out.push(entry.text)
    else if (entry.kind === 'team') out.push(team.text)
    else if (entry.kind === 'shareable') out.push(...renderLines(entry.lines, harness, team))
    else if (entry.kind === 'harness' && entry.harnesses.includes(harness)) out.push(...renderLines(entry.lines, harness, team))
  }
  return out
}

/** The exact bytes BMN writes for `harness`, with what decided them. */
export function render(master, harness, generation, { restricted = null } = {}) {
  if (!HARNESSES.includes(harness)) throw new RosterError('MASTER_INVALID', `unknown harness ${harness}`)
  const decision = routeFor(harness, generation)
  const isRestricted = restricted ?? decision.restricted
  const team = teamExpansion(generation)
  const header = `> Generated by BMN from ${master.path} (master sha256 ${master.hash}); edit the master, not this file.`
  let body
  if (isRestricted) {
    const shared = master.parts.filter((part) => part.kind === 'shareable').map((part) => renderLines(part.lines, harness, team).join('\n').trim()).filter(Boolean)
    body = shared.length > 0
      ? shared.join('\n\n')
      : 'BMN restricted these rules for a route that is not High, and the owner marked none of them shareable.'
  } else {
    body = renderLines(master.parts, harness, team).join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
  }
  const frontmatter = harness === 'cursor' ? '---\ndescription: The owner\'s global rules, generated by BMN\nalwaysApply: true\n---\n' : ''
  const text = `${frontmatter}${header}\n\n${body}\n`
  return { harness, text, hash: sha256(text), restricted: isRestricted, reason: decision.reason, team_form: team.form, bytes: Buffer.byteLength(text) }
}

/** The restricted rendering for `harness` from the current master and approval (60.3 packet mode). */
export function restrictedRendering(harness) {
  return render(readMaster(), harness, approvedOrNull(), { restricted: true }).text
}

// ---------------------------------------------------------------------------------------------
// State files (private, under state/rules)

function ensurePrivate(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

function writePrivate(path, text) {
  ensurePrivate(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, path)
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new RosterError('STATE_CORRUPT', `${path} cannot be read`)
  }
}

export function lastWritten() {
  return readJson(lastWrittenPath(), {})
}

// ---------------------------------------------------------------------------------------------
// Check

/** One state per target, by precedence: unreadable, missing, link, unmanaged, edited-outside, stale, current. */
export function checkTargets(environment = process.env) {
  const master = readMaster()
  const generation = approvedOrNull()
  const records = lastWritten()
  return HARNESSES.map((harness) => {
    const path = targetPath(harness, environment)
    const rendering = render(master, harness, generation)
    const base = { harness, path, restricted: rendering.restricted, reason: rendering.reason, rendered_hash: rendering.hash }
    let state
    try {
      state = pathState(path)
    } catch (error) {
      return { ...base, state: 'unreadable', detail: error.code ?? error.message }
    }
    if (state.kind === 'missing') return { ...base, state: 'missing' }
    if (state.kind === 'link') return { ...base, state: 'link', link_target: state.target }
    const hash = sha256(state.text)
    if (records[path] === undefined) return { ...base, state: 'unmanaged' }
    if (records[path] !== hash) return { ...base, state: 'edited-outside' }
    if (hash !== rendering.hash) return { ...base, state: 'stale' }
    return { ...base, state: 'current' }
  })
}

// ---------------------------------------------------------------------------------------------
// Install and restore

/**
 * Route re-inspection before a full rendering: an observed-default route must still resolve to
 * the provider's default; an owner-declared route is the owner's statement and is not inspected.
 */
async function routeStillMatches(harness, decision, environment) {
  if (decision.restricted || decision.route === null || decision.route.basis === 'owner-declared') return { ok: true }
  const { inspectRoute } = await import('./agents-check.mjs')
  const inspected = inspectRoute({ harness }, null, environment, environment.HOME || homedir())
  const ok = inspected.basis === 'default' && inspected.provider === decision.route.provider
  return ok ? { ok: true, inspected } : { ok: false, reason: `${harness} now resolves to ${inspected.host ?? 'an unknown destination'}${inspected.reason ? ` (${inspected.reason})` : ''}, not default:${decision.route.provider}` }
}

/** Shows target, resolved path and diff on stderr every time, then asks (default No) unless --yes. */
async function confirm(question, details, { yes, asJson }) {
  if (!asJson) writeSync(2, `${details}\n`)
  if (yes) return true
  if (asJson || !process.stdin.isTTY || !process.stderr.isTTY) {
    writeSync(2, 'bmn: CONFIRMATION_REQUIRED: this needs a TTY or explicit --yes; nothing was written\n')
    return false
  }
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stderr })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      prompt.close()
      resolve(value)
    }
    prompt.on('close', () => finish(false))
    prompt.on('SIGINT', () => finish(false))
    prompt.question(`${question} [y/N] `, (answer) => finish(/^(y|yes)$/i.test(answer.trim())))
  })
}

function describeState(state) {
  if (state.kind === 'missing') return ''
  if (state.kind === 'link') return ''
  return state.text
}

/** Lines in the outside edit that the rendering lacks: what the owner may want to fold into the master. */
function foldInLines(current, rendered) {
  const wanted = new Set(rendered.split('\n'))
  return current.split('\n').filter((line) => line.trim() !== '' && !wanted.has(line))
}

function readHistoryIndex() {
  const folder = historyDirectory()
  ensurePrivate(folder)
  let index
  try {
    index = readJson(`${folder}/index.json`, { revisions: [] })
  } catch {
    throw new RosterError('HISTORY_UNAVAILABLE', 'the master history index cannot be read; nothing was written')
  }
  if (!Array.isArray(index?.revisions)) throw new RosterError('HISTORY_UNAVAILABLE', 'the master history index is corrupt; nothing was written')
  return index
}

function linkedText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function snapshotMaster(master, reason, now = new Date()) {
  const folder = historyDirectory()
  const index = readHistoryIndex()
  const last = index.revisions[index.revisions.length - 1]
  if (last?.hash === master.hash) return last
  const revision = { revision: (last?.revision ?? 0) + 1, hash: master.hash, bytes: Buffer.byteLength(master.text), at: now.toISOString(), reason }
  writePrivate(`${folder}/${String(revision.revision).padStart(6, '0')}.md`, master.text)
  writePrivate(`${folder}/index.json`, JSON.stringify({ revisions: [...index.revisions, revision] }, null, 2))
  return revision
}

/**
 * One install transaction: re-inspect routes, record each target's prior state (bytes, link
 * text or absence) and BMN's last-written records, then write each target as a regular file
 * through the confirmed, change-refusing, read-back flow. A failure part-way stops and keeps the
 * manifest so `restore` can undo what changed.
 */
/**
 * What an install would write, without writing: each target's prior state, kind of replacement,
 * rendering and diff, plus a hash of all of it that a confirmed install must match.
 */
export async function planInstall(harnesses, { environment = process.env } = {}) {
  const master = readMaster()
  const generation = approvedOrNull()
  const plans = []
  for (const harness of harnesses) {
    const rendering = render(master, harness, generation)
    const decision = routeFor(harness, generation)
    const route = await routeStillMatches(harness, decision, environment)
    if (!route.ok) {
      return { code: 'ROUTE_CHANGED', message: `refusing a full rendering for ${harness}: ${route.reason}; approve the route again in Preferences > Agents`, plans: [], planHash: null }
    }
    const path = targetPath(harness, environment)
    const prior = pathState(path)
    const records = lastWritten()
    if (prior.kind === 'file' && prior.text === rendering.text && records[path] === rendering.hash) continue
    const change = prior.kind === 'link' ? 'link' : prior.kind === 'missing' ? 'missing'
      : records[path] === undefined ? 'unmanaged' : records[path] !== sha256(prior.text) ? 'edited-outside' : 'stale'
    const kind = { link: 'replaces a symbolic link', missing: 'creates the file', unmanaged: 'replaces a file BMN did not write (unmanaged)',
      'edited-outside': 'replaces a file edited outside BMN', stale: 'updates BMN\'s file' }[change]
    plans.push({ harness, path, prior, rendering, kind, change, diff: unifiedDiff(describeState(prior), rendering.text, path),
      fold: prior.kind === 'file' && records[path] !== undefined && records[path] !== sha256(prior.text) ? foldInLines(prior.text, rendering.text) : [] })
  }
  return { code: 'OK', master, plans, planHash: planHash(plans) }
}

function planHash(plans) {
  return sha256(canonicalJson(plans.map((plan) => ({
    harness: plan.harness, path: plan.path, kind: plan.kind, rendered: plan.rendering.hash,
    prior: plan.prior.kind === 'file' ? { kind: 'file', hash: sha256(plan.prior.text) } : plan.prior
  }))))
}

/** The plan as the panel and `--plan --json` show it: no file bytes beyond the diffs. */
export function planView(result) {
  return {
    code: result.code, ...(result.message ? { message: result.message } : {}), plan_hash: result.planHash,
    targets: result.plans.map((plan) => ({ harness: plan.harness, path: plan.path, kind: plan.kind, change: plan.change, restricted: plan.rendering.restricted,
      reason: plan.rendering.reason, team_form: plan.rendering.team_form, ...(plan.prior.kind === 'link' ? { link_target: plan.prior.target } : {}),
      diff: plan.diff, fold: plan.fold }))
  }
}

/**
 * One install transaction: re-inspect routes, record each target's prior state (bytes, link
 * text or absence) and BMN's last-written records, then write each target as a regular file
 * through the confirmed, change-refusing, read-back flow. A failure part-way stops and keeps the
 * manifest so `restore` can undo what changed. With `expectedPlanHash`, the plan must be exactly
 * the one the owner confirmed elsewhere (the Rules panel), or nothing is written.
 */
export async function installRules(harnesses, { yes = false, asJson = false, environment = process.env, now = new Date(), afterConfirm, beforeTarget, expectedPlanHash } = {}) {
  const planned = await planInstall(harnesses, { environment })
  if (planned.code !== 'OK') return { code: planned.code, message: planned.message, transaction: null, written: [] }
  const { master, plans } = planned
  if (expectedPlanHash !== undefined && expectedPlanHash !== planned.planHash) {
    return { code: 'REVISION_CONFLICT', message: 'the targets or the rendering changed since the plan was shown; review it again', transaction: null, written: [] }
  }
  if (plans.length === 0) return { code: 'OK', transaction: null, written: [], message: 'Every target already holds its current rendering.' }
  const details = plans.map((plan) => [
    `${plan.harness}: ${plan.path}`,
    `  ${plan.kind}${plan.prior.kind === 'link' ? ` (link to ${plan.prior.target}; the link is replaced, its target is not touched)` : ''}`,
    `  rendering: ${plan.rendering.restricted ? `restricted (${plan.rendering.reason})` : 'full'}; team: ${plan.rendering.team_form}`,
    ...(plan.fold.length ? ['  lines in the outside edit you may want to fold into the master:', ...plan.fold.map((line) => `    ${line}`)] : []),
    plan.diff
  ].join('\n')).join('\n\n')
  if (!await confirm('Write these rules files?', details, { yes, asJson })) return { code: 'NOT_CONFIRMED', transaction: null, written: [] }
  // The answer may come long after the diff: plan again and write only what was confirmed.
  afterConfirm?.()
  const confirmed = await planInstall(harnesses, { environment })
  if (confirmed.code !== 'OK') return { code: confirmed.code, message: confirmed.message, transaction: null, written: [] }
  if (confirmed.planHash !== planned.planHash) {
    return { code: 'REVISION_CONFLICT', message: 'the targets or the rendering changed while the confirmation was open; nothing was written', transaction: null, written: [] }
  }
  const id = `${now.toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}-${process.pid}`
  const folder = `${transactionsDirectory()}/${id}`
  ensurePrivate(folder)
  const records = lastWritten()
  const manifest = {
    id, created_at: now.toISOString(), master_hash: master.hash, state: 'started',
    targets: plans.map((plan, index) => ({
      harness: plan.harness, path: plan.path, prior: plan.prior.kind === 'file' ? { kind: 'file', backup: `${index}.bak`, mode: plan.prior.mode } : plan.prior,
      prior_record: records[plan.path] ?? null, written_hash: plan.rendering.hash, done: false
    }))
  }
  plans.forEach((plan, index) => {
    if (plan.prior.kind === 'file') writePrivate(`${folder}/${index}.bak`, plan.prior.text)
  })
  writePrivate(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2))
  snapshotMaster(master, `install ${id}`, now)
  const written = []
  for (const [index, plan] of plans.entries()) {
    try {
      beforeTarget?.(plan.harness, index)
      replaceFileSafely(plan.path, plan.prior, plan.rendering.text)
    } catch (error) {
      manifest.state = 'failed'
      writePrivate(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2))
      return { code: 'INSTALL_FAILED', transaction: id, written, message: `${plan.path}: ${error.code ?? 'write failed'}: ${error.message}; ${written.length} target(s) changed; undo with bmn rules restore --transaction ${id}` }
    }
    const next = lastWritten()
    next[plan.path] = plan.rendering.hash
    writePrivate(lastWrittenPath(), JSON.stringify(next, null, 2))
    manifest.targets[index].done = true
    writePrivate(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2))
    written.push({ harness: plan.harness, path: plan.path, restricted: plan.rendering.restricted })
  }
  manifest.state = 'complete'
  writePrivate(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2))
  return { code: 'OK', transaction: id, written }
}

export function listTransactions() {
  let names
  try {
    names = readdirSync(transactionsDirectory())
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return names.sort().reverse().map((id) => {
    const manifest = readJson(`${transactionsDirectory()}/${id}/manifest.json`, null)
    return manifest === null ? { id, valid: false } : { id, valid: true, created_at: manifest.created_at, state: manifest.state, targets: manifest.targets.map((target) => target.harness) }
  })
}

/** Puts every target of a transaction back as it was before, links as links, and resets the records. */
export async function restoreTransaction(id, { yes = false, asJson = false, planOnly = false, expectedPlanHash } = {}) {
  if (!/^[0-9TZ-]+-\d+$/.test(id)) return { code: 'NOT_FOUND', message: `no transaction ${id}` }
  const folder = `${transactionsDirectory()}/${id}`
  const manifest = readJson(`${folder}/manifest.json`, null)
  if (manifest === null) return { code: 'NOT_FOUND', message: `no transaction ${id}` }
  const plans = manifest.targets.map((target) => {
    const prior = target.prior.kind === 'file'
      ? { kind: 'file', text: readFileSync(`${folder}/${target.prior.backup}`, 'utf8'), mode: target.prior.mode ?? 0o600 }
      : target.prior
    const current = pathState(target.path)
    return { ...target, priorState: prior, current }
  })
  const targets = plans.map((plan) => ({ harness: plan.harness, path: plan.path, change: plan.priorState.kind,
    becomes: plan.priorState.kind === 'link' ? `link to ${plan.priorState.target}` : plan.priorState.kind === 'missing' ? 'removed (it did not exist)' : 'its earlier bytes',
    diff: unifiedDiff(describeState(plan.current), describeState(plan.priorState), plan.path) }))
  const hash = sha256(canonicalJson(plans.map((plan) => ({ path: plan.path, current: plan.current.kind === 'file' ? sha256(plan.current.text) : plan.current, prior: plan.priorState.kind === 'file' ? sha256(plan.priorState.text) : plan.priorState }))))
  if (planOnly) return { code: 'OK', plan_hash: hash, targets }
  if (expectedPlanHash !== undefined && expectedPlanHash !== hash) return { code: 'REVISION_CONFLICT', message: 'the targets changed since the restore was shown; review it again' }
  const details = targets.map((target) => `${target.harness}: ${target.path} -> ${target.becomes}\n${target.diff}`).join('\n\n')
  if (!await confirm(`Restore transaction ${id}?`, details, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
  const restored = []
  for (const plan of plans) {
    const now = pathState(plan.path)
    if (now.kind !== plan.current.kind || now.text !== plan.current.text || now.target !== plan.current.target) {
      return { code: 'REVISION_CONFLICT', message: `${plan.path} changed while BMN was reading it; ${restored.length} target(s) restored`, restored }
    }
    restorePathState(plan.path, plan.priorState)
    const records = lastWritten()
    if (plan.prior_record === null) delete records[plan.path]
    else records[plan.path] = plan.prior_record
    writePrivate(lastWrittenPath(), JSON.stringify(records, null, 2))
    restored.push(plan.harness)
  }
  return { code: 'OK', restored }
}

// ---------------------------------------------------------------------------------------------
// Master history

export function masterHistory() {
  const folder = historyDirectory()
  let index
  try {
    index = JSON.parse(readFileSync(`${folder}/index.json`, 'utf8'))
  } catch {
    throw new RosterError('HISTORY_UNAVAILABLE', `no readable master history in ${folder}`)
  }
  if (!Array.isArray(index?.revisions)) throw new RosterError('HISTORY_UNAVAILABLE', 'the master history index is corrupt')
  return index.revisions.map((revision) => {
    let intact
    try {
      intact = sha256(readFileSync(`${folder}/${String(revision.revision).padStart(6, '0')}.md`, 'utf8')) === revision.hash
    } catch {
      intact = false
    }
    return { ...revision, intact }
  })
}

/**
 * Writes the master through the confirmed, change-refusing flow and keeps a source snapshot. A
 * master that would not render is refused. Used by `revert-master`, `import` and the Rules panel.
 */
export function writeMaster(expected, text, reason, { now = new Date() } = {}) {
  const parsed = parseMaster(text)
  if (parsed.errors.length > 0) throw new RosterError('MASTER_INVALID', 'the new master would not render', { errors: parsed.errors })
  ensurePrivate(agentsDirectory())
  // The text being replaced is kept first, so no master is lost to a save; an unreadable history
  // refuses before anything is written.
  const prior = expected.kind === 'file' ? expected.text : expected.kind === 'link' ? linkedText(masterPath()) : null
  if (prior === null) readHistoryIndex()
  else snapshotMaster({ text: prior, hash: sha256(prior) }, `before ${reason}`, now)
  const written = replaceFileSafely(masterPath(), expected, text)
  snapshotMaster({ text, hash: sha256(text) }, reason, now)
  return written
}

export async function revertMaster(revision, { yes = false, asJson = false } = {}) {
  const history = masterHistory()
  const entry = history.find((item) => item.revision === revision)
  if (entry === undefined) throw new RosterError('HISTORY_UNAVAILABLE', `no master revision ${revision}`)
  if (!entry.intact) throw new RosterError('HISTORY_UNAVAILABLE', `master revision ${revision} is corrupt`)
  const text = readFileSync(`${historyDirectory()}/${String(revision).padStart(6, '0')}.md`, 'utf8')
  const expected = pathState(masterPath())
  const details = `Master: ${masterPath()}\n${unifiedDiff(describeState(expected), text, masterPath())}`
  if (!await confirm(`Write master revision ${revision} back as the master?`, details, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
  writeMaster(expected, text, `revert to revision ${revision}`)
  return { code: 'OK', revision }
}

// ---------------------------------------------------------------------------------------------
// Import (60.7's one-shot cut-over source)

/**
 * Today's Claude rules as the first master: unchanged except an OpenCode section appended from
 * the adapter draft when one exists, and the team placeholder at the end of a `## Team` section.
 * The owner then removes the hand-kept agent list and marks shareable sections in the Rules panel.
 */
export function importedMaster(sourceText, opencodeText) {
  const lines = sourceText.replace(/\n+$/, '').split('\n')
  const team = lines.findIndex((line) => /^##\s+Team\b/.test(line))
  if (team !== -1 && !sourceText.includes(TEAM_MARKER)) {
    let end = lines.findIndex((line, index) => index > team && /^#{1,2}\s/.test(line))
    if (end === -1) end = lines.length
    while (end > team + 1 && lines[end - 1].trim() === '') end -= 1
    lines.splice(end, 0, '', TEAM_MARKER)
  }
  let text = `${lines.join('\n')}\n`
  if (opencodeText !== null && opencodeText.trim() !== '') {
    text += `\n<!-- bmn:harness opencode -->\n${opencodeText.replace(/\n+$/, '')}\n<!-- /bmn:harness -->\n`
  }
  return text
}

// ---------------------------------------------------------------------------------------------
// Probes

function probeLog() {
  try {
    return readFileSync(probeLogPath(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * The latest probe per harness. Stale when the rendering or approved route changed, or, given
 * `inspect` (the harness's current version and destination), when either differs from the probe's.
 */
export function lastProbes({ inspect } = {}) {
  const latest = {}
  for (const entry of probeLog()) latest[entry.harness] = entry
  let master = null
  let generation = null
  try {
    master = readMaster()
    generation = approvedOrNull()
  } catch {
    master = null
  }
  return HARNESSES.map((harness) => {
    const entry = latest[harness]
    if (entry === undefined) return { harness, outcome: null }
    const rendered = master === null ? null : render(master, harness, generation).hash
    const route = routeFor(harness, generation)
    let stale = rendered !== entry.rendered_hash || canonicalRoute(route) !== entry.route
    if (!stale && inspect) {
      const now = inspect(harness)
      stale = now.version !== (entry.version ?? null) || now.host !== (entry.host ?? null)
    }
    return { ...entry, stale }
  })
}

const PROBE_COMMANDS = { claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'cursor-agent' }

/** The harness's version and destination now, for marking an earlier probe stale. */
export async function probeInspector(environment = process.env) {
  const { harnessVersion, inspectRoute } = await import('./agents-check.mjs')
  return (harness) => ({
    version: harnessVersion(PROBE_COMMANDS[harness], environment),
    host: inspectRoute({ harness }, null, environment, environment.HOME || homedir()).host ?? null
  })
}

function canonicalRoute(decision) {
  return decision.route === null ? 'none' : `${decision.route.provider}/${decision.route.security}/${decision.route.basis}`
}

function hashInText(text, hash) {
  return typeof text === 'string' && text.includes(hash)
}

/**
 * A rollout up to its first tool call: what the session was given before the agent could read
 * anything itself. A hash found later may come from a tool reading the file, which proves nothing.
 */
export function beforeFirstToolCall(rollout) {
  const kept = []
  for (const line of rollout.split('\n')) {
    let type
    try {
      type = JSON.parse(line)?.payload?.type
    } catch {
      type = undefined
    }
    if (typeof type === 'string' && (type.endsWith('_call') || type.endsWith('_begin'))) break
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Runs the harness once in a throwaway folder under the home folder, without naming the expected
 * revision, and records pass, fail, inconclusive or unavailable against the harness version, the
 * route and the rendered file's hash. Sends the rules to that harness's provider: High routes only.
 */
export async function probe(harness, { environment = process.env, now = new Date(), timeoutMs = 180_000 } = {}) {
  const master = readMaster()
  const generation = approvedOrNull()
  const rendering = render(master, harness, generation)
  const decision = routeFor(harness, generation)
  const command = PROBE_COMMANDS[harness]
  let host = decision.route?.host ?? null
  const record = (outcome, detail, version = null) => {
    const entry = { harness, at: now.toISOString(), outcome, detail, version, host, route: canonicalRoute(decision), rendered_hash: rendering.hash, master_hash: master.hash }
    ensurePrivate(dirname(probeLogPath()))
    appendFileSync(probeLogPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    return entry
  }
  const { harnessVersion } = await import('./agents-check.mjs')
  const version = harnessVersion(command, environment)
  if (version === null) return record('unavailable', `${command} is not installed or did not answer --version`)
  if (decision.restricted) return record('unavailable', `the ${harness} route is not High (${decision.reason}); a probe would send the rules to that provider`, version)
  // Like install: the destination is inspected again right before anything is sent (60.6 AC4).
  const route = await routeStillMatches(harness, decision, environment)
  if (!route.ok) return record('unavailable', `refused: ${route.reason}; approve the route again in Preferences > Agents`, version)
  if (route.inspected) host = route.inspected.host ?? null
  const current = pathState(targetPath(harness, environment))
  if (current.kind !== 'file' || sha256(current.text) !== rendering.hash) {
    return record('fail', `${targetPath(harness, environment)} does not hold the current rendering; install first`, version)
  }
  const home = environment.HOME || homedir()
  const folder = mkdtempSync(`${home}/.bmn-rules-probe-`)
  const question = 'Your global instructions begin with a line saying they were generated by BMN and naming a master sha256. Reply with only that sha256 hex value, or NONE if you have no such line.'
  try {
    if (harness === 'codex') {
      const codexHome = environment.CODEX_HOME || `${home}/.codex`
      const started = Date.now()
      const run = spawnSync(command, ['exec', '--skip-git-repo-check', '-C', folder, '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-'],
        { cwd: folder, env: environment, input: question, encoding: 'utf8', timeout: timeoutMs })
      if (run.error || run.status === null) return record('inconclusive', 'codex did not finish', version)
      const rollout = findRollout(`${codexHome}/sessions`, folder, started)
      if (rollout === null) return record('inconclusive', 'no session rollout for the probe run was found', version)
      return hashInText(beforeFirstToolCall(rollout), master.hash)
        ? record('pass', 'the probe run\'s rollout carries the rendered header before any tool ran', version)
        : record('fail', 'the probe run\'s rollout does not carry the rendered header before any tool ran', version)
    }
    const args = harness === 'claude'
      ? ['-p', '--tools', '', '--no-session-persistence', '--output-format', 'text']
      : harness === 'opencode' ? ['run', question] : ['-p', question]
    const run = spawnSync(command, args, { cwd: folder, env: environment, input: harness === 'claude' ? question : '', encoding: 'utf8', timeout: timeoutMs })
    if (run.error || run.status !== 0) return record('inconclusive', `${command} did not answer (timeout or error)`, version)
    const answer = /[0-9a-f]{64}/.exec(run.stdout)?.[0] ?? null
    if (harness !== 'claude') {
      return record('inconclusive', `answered ${answer === master.hash ? 'the right hash' : answer === null ? 'no hash' : 'another hash'}, but its tools could have read the file`, version)
    }
    if (answer === null) return record('inconclusive', 'the answer named no sha256', version)
    return answer === master.hash ? record('pass', 'with tools off, Claude quoted the master hash its rules file carries', version) : record('fail', 'Claude quoted a different hash', version)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

function findRollout(root, cwd, since) {
  const found = []
  const walk = (directory, depth) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && statSync(path).mtimeMs >= since - 1000) found.push(path)
    }
  }
  walk(root, 0)
  for (const path of found) {
    const text = readFileSync(path, 'utf8')
    const first = text.slice(0, text.indexOf('\n'))
    try {
      if (JSON.parse(first)?.payload?.cwd === cwd) return text
    } catch {
      // Not a session record.
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// CLI

export const RULES_USAGE = `Usage: bmn rules render <harness>                 The exact file BMN writes for one harness (stdout)
       bmn rules check [--json]                    Each target: unreadable, missing, link, unmanaged,
                                                   edited-outside, stale or current; exit 0 only if all current
       bmn rules install [harness…] [--plan] [--expect-plan <hash>] [--yes] [--json]
                                                   One confirmed transaction writing every (or each named) target
       bmn rules restore --transaction <id> [--plan] [--expect-plan <hash>] [--yes] [--json]
       bmn rules restore --list                    Undo one install; links come back as links
       bmn rules history [--json]                  The master-source snapshots BMN kept
       bmn rules revert-master <revision> [--yes]  Write one snapshot back as the master (a new revision)
       bmn rules import [--from <file>] [--yes]    One-shot: today's Claude rules become the master
       bmn rules probe <harness> [--json]          Owner-run: does the harness load the file? Sends the rules
                                                   to that harness's provider, so High routes only

Harnesses: ${HARNESSES.join(', ')}. The master is ~/.config/bmn/agents/global-rules.md: untagged text goes to every
harness; <!-- bmn:harness codex opencode --> … <!-- /bmn:harness --> limits a section; <!-- bmn:shareable -->
… <!-- /bmn:shareable --> marks text a Low route may receive; one <!-- bmn:team --> line expands into the approved
team. A harness whose approved route is not High gets only the shareable sections. Restrictions cover only the
global files BMN writes, never project files or skills; sessions started before an install keep their old rules.
Exit: 0 ok, 2 usage, 3 master missing, 4 master invalid, 1 something not current or not written,
7 changed while reading, 13 history unavailable.`

export async function runRulesCommand(argv) {
  const [action, ...rest] = argv
  if (action === undefined || action === '--help' || action === '-h' || action === 'help') {
    out(RULES_USAGE)
    return action === undefined ? 2 : 0
  }
  let parsed
  try {
    parsed = readOptions(rest, { flags: ['json', 'yes', 'list', 'plan'], values: ['transaction', 'from', 'expect-plan'] })
    if (parsed.rest !== null) throw new AgentsUsageError('rules takes no -- arguments')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const { positionals, options } = parsed
  const asJson = options.json === true
  const allowed = { render: [], check: ['json'], install: ['json', 'yes', 'plan', 'expect-plan'], restore: ['json', 'yes', 'list', 'transaction', 'plan', 'expect-plan'], history: ['json'],
    'revert-master': ['json', 'yes'], import: ['json', 'yes', 'from'], probe: ['json'] }
  if (!Object.hasOwn(allowed, action)) return usage(`rules expects render, check, install, restore, history, revert-master, import or probe, not ${action}`)
  for (const name of Object.keys(options)) {
    if (!allowed[action].includes(name)) return usage(`rules ${action} does not accept --${name}`)
  }
  try {
    if (action === 'render') {
      if (positionals.length !== 1) return usage('rules render expects one harness')
      if (!HARNESSES.includes(positionals[0])) throw new RosterError('MASTER_INVALID', `unknown harness ${positionals[0]} (use ${HARNESSES.join(', ')})`)
      const rendering = render(readMaster(), positionals[0], approvedOrNull())
      writeSync(1, rendering.text)
      writeSync(2, `bmn: ${rendering.restricted ? `restricted rendering (${rendering.reason})` : 'full rendering'}; team: ${rendering.team_form}; ${rendering.bytes} bytes\n`)
      return 0
    }
    if (action === 'check') {
      if (positionals.length > 0) return usage('rules check takes no arguments')
      const targets = checkTargets()
      const ok = targets.every((target) => target.state === 'current')
      if (asJson) out(JSON.stringify({ ok, master: masterPath(), targets }, null, 2))
      else {
        out([...targets.map((target) => `${target.harness.padEnd(9)}${target.state}${target.state === 'link' ? ` -> ${target.link_target}` : ''}${target.restricted ? ` (restricted: ${target.reason})` : ''}  ${target.path}`),
          ok ? 'Every target holds its current rendering. This says what is on disk, not that a running session loaded it.' : 'Run `bmn rules install` to write the targets that are not current.'].join('\n'))
      }
      return ok ? 0 : 1
    }
    if (action === 'install') {
      const harnesses = positionals.length === 0 ? HARNESSES : positionals
      for (const harness of harnesses) if (!HARNESSES.includes(harness)) return usage(`unknown harness ${harness}`)
      if (options.plan) {
        const planned = planView(await planInstall(harnesses))
        out(asJson ? JSON.stringify(planned, null, 2) : planned.code !== 'OK' ? `${planned.code}: ${planned.message}` : planned.targets.length === 0 ? 'Every target already holds its current rendering.'
          : planned.targets.map((target) => `${target.harness}: ${target.path}\n  ${target.kind}\n${target.diff}`).join('\n\n'))
        return planned.code === 'OK' ? 0 : 1
      }
      const result = await installRules(harnesses, { yes: options.yes === true, asJson, ...(options['expect-plan'] !== undefined ? { expectedPlanHash: options['expect-plan'] } : {}) })
      if (asJson) out(JSON.stringify(result, null, 2))
      else if (result.code === 'OK') out(result.transaction === null ? result.message : [`Wrote ${result.written.length} rules file(s) in transaction ${result.transaction}:`, ...result.written.map((entry) => `  ${entry.harness}: ${entry.path}${entry.restricted ? ' (restricted)' : ''}`), `Undo: bmn rules restore --transaction ${result.transaction}`, 'Sessions started before this keep their old rules.'].join('\n'))
      else if (result.code !== 'NOT_CONFIRMED') writeSync(2, `bmn: ${result.code}: ${result.message}\n`)
      return result.code === 'OK' ? 0 : result.code === 'NOT_CONFIRMED' ? (asJson ? 2 : 1) : result.code === 'REVISION_CONFLICT' ? EXIT.REVISION_CONFLICT : 1
    }
    if (action === 'restore') {
      if (options.list) {
        const transactions = listTransactions()
        out(asJson ? JSON.stringify({ transactions }, null, 2) : transactions.length === 0 ? 'No install transactions.' : transactions.map((t) => `${t.id}  ${t.valid ? `${t.state}  ${t.targets.join(', ')}` : 'unreadable'}`).join('\n'))
        return 0
      }
      if (options.transaction === undefined) return usage('rules restore needs --transaction <id> or --list')
      const result = await restoreTransaction(options.transaction, { yes: options.yes === true, asJson, planOnly: options.plan === true,
        ...(options['expect-plan'] !== undefined ? { expectedPlanHash: options['expect-plan'] } : {}) })
      if (asJson) out(JSON.stringify(result, null, 2))
      else if (result.code === 'OK' && options.plan) out(result.targets.map((target) => `${target.harness}: ${target.path} -> ${target.becomes}\n${target.diff}`).join('\n\n'))
      else if (result.code === 'OK') out(`Restored ${result.restored.join(', ')} to their state before transaction ${options.transaction}.`)
      else if (result.code !== 'NOT_CONFIRMED') writeSync(2, `bmn: ${result.code}: ${result.message}\n`)
      return result.code === 'OK' ? 0 : result.code === 'REVISION_CONFLICT' ? EXIT.REVISION_CONFLICT : 1
    }
    if (action === 'history') {
      const history = masterHistory()
      out(asJson ? JSON.stringify({ revisions: history }, null, 2) : history.map((entry) => `${String(entry.revision).padStart(4)}  ${entry.at}  ${entry.hash.slice(0, 12)}  ${entry.bytes} bytes  ${entry.reason}${entry.intact ? '' : '  (corrupt)'}`).join('\n'))
      return 0
    }
    if (action === 'revert-master') {
      const revision = Number(positionals[0])
      if (positionals.length !== 1 || !Number.isSafeInteger(revision) || revision < 1) return usage('rules revert-master expects one revision number')
      const result = await revertMaster(revision, { yes: options.yes === true, asJson })
      if (asJson) out(JSON.stringify(result, null, 2))
      else if (result.code === 'OK') out(`The master now holds revision ${revision} (kept as a new revision). Run bmn rules install to write it out.`)
      return result.code === 'OK' ? 0 : 1
    }
    if (action === 'import') {
      if (positionals.length > 0) return usage('rules import takes no arguments')
      const source = options.from ?? targetPath('claude')
      const sourceText = readFileSync(source, 'utf8')
      const adapter = existsSync(`${agentsDirectory()}/adapters/opencode.md`) ? readFileSync(`${agentsDirectory()}/adapters/opencode.md`, 'utf8') : null
      const text = importedMaster(sourceText, adapter)
      const expected = pathState(masterPath())
      if (expected.kind !== 'missing') throw new RosterError('REVISION_CONFLICT', `${masterPath()} already exists; import is one-shot (edit it in Preferences > Rules)`)
      const details = `Master: ${masterPath()} (new)\nFrom: ${source}${adapter === null ? '' : ` and ${agentsDirectory()}/adapters/opencode.md as an opencode section`}\n${unifiedDiff('', text, masterPath())}`
      if (!await confirm('Create the rules master from these rules?', details, { yes: options.yes === true, asJson })) return asJson ? 2 : 1
      writeMaster(expected, text, `import from ${source}`)
      out(asJson ? JSON.stringify({ code: 'OK', master: masterPath(), bytes: Buffer.byteLength(text) }, null, 2) : `Created ${masterPath()}. Remove the hand-kept agent list around <!-- bmn:team -->, mark shareable sections, then install.`)
      return 0
    }
    if (positionals.length !== 1 || !HARNESSES.includes(positionals[0])) return usage(`rules probe expects one harness: ${HARNESSES.join(', ')}`)
    const result = await probe(positionals[0])
    out(asJson ? JSON.stringify(result, null, 2) : `${result.harness}: ${result.outcome} - ${result.detail}${result.version ? ` (${result.version})` : ''}`)
    return result.outcome === 'pass' ? 0 : 1
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    if (error?.code === 'REVISION_CONFLICT' && !(error instanceof RosterError)) {
      writeSync(2, `bmn: REVISION_CONFLICT: ${error.message}\n`)
      return EXIT.REVISION_CONFLICT
    }
    return failWith(error, asJson)
  }
}

