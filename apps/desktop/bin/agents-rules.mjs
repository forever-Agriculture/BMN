// MODULE: agents-rules.mjs - Epic 60.4: one rules master rendered into each harness's own rules file, with check, install, restore and probes
import { spawnSync } from 'node:child_process'
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { APP_NAMES, HARNESSES, RosterError, agentState, agentsDirectory, canonicalJson, harnessPrivateWork, sha256 } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { AgentsUsageError, EXIT, failWith, out, readOptions, usage } from './agents-cli.mjs'
import { absoluteUncollapsed, pathState, replaceFileSafely, resolvedPath, restorePathState, sameState } from './safe-config-write.mjs'
import { unifiedDiff } from './text-diff.mjs'

/**
 * The owner edits one file, `~/.config/bmn/agents/global-rules.md`. BMN renders it per app and
 * writes each app's own rules file as a generated regular file. An app whose approved destination
 * may receive private work gets the full rendering; any other gets the public rendering: the
 * header and the sections the owner marked public, never an empty file. This governs only the
 * global files BMN writes, not project files or skills an app reads in a workspace.
 */

/** The Team phrase names agents only while it stays this short; longer, it points at `bmn team`. */
export const TEAM_LIMIT_BYTES = 400
export const TEAM_MARKER = '<!-- bmn:team -->'
const TEAM_POINTER = ' (roles, efforts and limits: `bmn team`)'
const TEAM_FALLBACK = 'the agents `bmn team` lists'
const OPEN_APPS = /^<!--\s*bmn:apps\s+([a-z ,]+?)\s*-->$/
const CLOSE_APPS = /^<!--\s*\/bmn:apps\s*-->$/
const OPEN_PUBLIC = /^<!--\s*bmn:public\s*-->$/
const CLOSE_PUBLIC = /^<!--\s*\/bmn:public\s*-->$/
const ANY_MARKER = /<!--\s*\/?bmn:/
const EARLIER_MARKER = /<!--\s*\/?bmn:(harness|shareable)\b/
/** What the owner reads for each rendering kind. */
export const KIND_WORDS = { full: 'Full rules', public: 'Public sections only' }

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
 * Parses the master into ordered parts: plain text (every app), sections limited to some apps,
 * public sections and the single team placeholder, which may sit inside a sentence. Section
 * markers sit alone on their line; unknown app names and unclosed, nested or duplicate markers
 * are MASTER_INVALID with their lines.
 */
export function parseMaster(text) {
  const errors = []
  const parts = []
  let open = null
  let teamLine = null
  const lines = text.split('\n')
  const nested = (line) => errors.push({ code: 'MASTER_INVALID', line, message: `marker nested inside the ${open.kind} section opened at line ${open.line}` })
  lines.forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    let match
    if ((match = OPEN_APPS.exec(trimmed))) {
      const names = match[1].split(/[\s,]+/).filter(Boolean)
      const unknown = names.filter((name) => !HARNESSES.includes(name))
      if (unknown.length > 0) errors.push({ code: 'MASTER_INVALID', line, message: `unknown app ${unknown.join(', ')} (use ${HARNESSES.join(', ')})` })
      if (open !== null) nested(line)
      else open = { kind: 'apps', line, harnesses: names, lines: [] }
      return
    }
    if (OPEN_PUBLIC.test(trimmed)) {
      if (open !== null) nested(line)
      else open = { kind: 'public', line, lines: [] }
      return
    }
    if (CLOSE_APPS.test(trimmed) || CLOSE_PUBLIC.test(trimmed)) {
      const kind = CLOSE_APPS.test(trimmed) ? 'apps' : 'public'
      if (open === null || open.kind !== kind) {
        errors.push({ code: 'MASTER_INVALID', line, message: `closing ${kind} marker with no matching opening marker` })
      } else {
        parts.push(open)
        open = null
      }
      return
    }
    const pieces = raw.split(TEAM_MARKER)
    if (pieces.some((piece) => ANY_MARKER.test(piece))) {
      const earlier = EARLIER_MARKER.test(raw) ? ' (bmn:harness is now bmn:apps, bmn:shareable is now bmn:public)' : ''
      errors.push({ code: 'MASTER_INVALID', line, message: `unrecognised bmn marker "${trimmed.slice(0, 60)}"${earlier}; section markers sit alone on their line` })
      return
    }
    const entry = { kind: 'text', text: raw }
    if (pieces.length > 1) {
      if (teamLine !== null || pieces.length > 2) errors.push({ code: 'MASTER_INVALID', line, message: `duplicate ${TEAM_MARKER} (first at line ${teamLine ?? line})` })
      teamLine ??= line
      entry.team = true
    }
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

/**
 * The Team phrase: the enabled active agents' names grouped by app, apps in their fixed order and
 * agents in roster order, then where the details are. Longer than TEAM_LIMIT_BYTES, or with
 * nobody to name, it is the short phrase. Agents are pointed at `bmn team`, never at the roster file.
 */
export function teamPhrase(generation) {
  if (generation === null) return { form: 'short phrase (nothing approved)', text: TEAM_FALLBACK }
  const active = generation.data.agents.filter((agent) => agentState(agent) === 'active')
  if (active.length === 0) return { form: 'short phrase (no active agent)', text: TEAM_FALLBACK }
  const groups = HARNESSES.map((harness) => [APP_NAMES[harness], active.filter((agent) => agent.harness === harness).map((agent) => agent.name)])
    .filter(([, names]) => names.length > 0)
  const text = `${groups.map(([app, names]) => `${app} (${names.join(', ')})`).join(', ')}${TEAM_POINTER}`
  return Buffer.byteLength(text) <= TEAM_LIMIT_BYTES ? { form: 'names by app', text } : { form: 'short phrase (names too long)', text: TEAM_FALLBACK }
}

/**
 * Which rendering an app gets and why, from the approved roster: full only when its approved
 * destination may receive private work; public for a public-only, unknown or owner-declared one.
 */
export function routeFor(harness, generation) {
  const answer = harnessPrivateWork(generation?.data ?? null, harness)
  return { kind: answer.allowed ? 'full' : 'public', reason: answer.reason, route: answer.route, provider: answer.provider }
}

function renderLines(entries, harness, team) {
  const out = []
  for (const entry of entries) {
    if (entry.kind === 'text') out.push(entry.team ? entry.text.replace(TEAM_MARKER, () => team.text) : entry.text)
    else if (entry.kind === 'public') out.push(...renderLines(entry.lines, harness, team))
    else if (entry.kind === 'apps' && entry.harnesses.includes(harness)) out.push(...renderLines(entry.lines, harness, team))
  }
  return out
}

/** The exact bytes BMN writes for `harness`, with what decided them. `kind` and `team` override the approved answer for previews. */
export function render(master, harness, generation, { kind = null, team = null } = {}) {
  if (!HARNESSES.includes(harness)) throw new RosterError('MASTER_INVALID', `unknown app ${harness}`)
  const decision = routeFor(harness, generation)
  const used = kind ?? decision.kind
  const phrase = team ?? teamPhrase(generation)
  const header = `> Generated by BMN from ${master.path} (master sha256 ${master.hash}); edit the master, not this file.`
  let body
  if (used === 'public') {
    const shared = master.parts.filter((part) => part.kind === 'public').map((part) => renderLines(part.lines, harness, phrase).join('\n').trim()).filter(Boolean)
    body = shared.length > 0
      ? shared.join('\n\n')
      : 'BMN gives this app only the rules its owner marked public, and none are marked.'
  } else {
    body = renderLines(master.parts, harness, phrase).join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
  }
  const frontmatter = harness === 'cursor' ? '---\ndescription: The owner\'s global rules, generated by BMN\nalwaysApply: true\n---\n' : ''
  const text = `${frontmatter}${header}\n\n${body}\n`
  return { harness, text, hash: sha256(text), kind: used, reason: decision.reason, team_form: phrase.form, bytes: Buffer.byteLength(text) }
}

/** The public rendering for `harness` from the current master and approval (60.3 packet mode). */
export function publicRendering(harness) {
  return render(readMaster(), harness, approvedOrNull(), { kind: 'public' }).text
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
    const base = { harness, path, kind: rendering.kind, reason: rendering.reason, rendered_hash: rendering.hash }
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
 * Re-inspection before a full rendering leaves BMN: the app must still resolve to the default of
 * the provider the approved roster names, and its version must be readable, so that BMN knows a
 * program is there to inspect. Any installed version is supported (owner decision 2026-10-10).
 * A public rendering needs none, and an owner-declared destination never gets a full one
 * (routeFor), so nothing here rests on the owner's word. `remedy` says where the owner fixes it.
 */
async function routeStillMatches(harness, decision, environment) {
  if (decision.kind !== 'full') return { ok: true, inspected: null }
  const { inspectRoute } = await import('./agents-check.mjs')
  const inspected = inspectRoute({ harness }, null, environment, environment.HOME || homedir())
  if (inspected.basis !== 'default' || inspected.provider !== decision.route.provider) {
    return {
      ok: false, remedy: "set the app's destination again in Preferences > Rules > Health",
      reason: `${APP_NAMES[harness]} now sends data to ${inspected.host ?? 'an unknown destination'}${inspected.reason ? ` (${inspected.reason})` : ''}, not default:${decision.route.provider}`
    }
  }
  if (inspected.version === null) {
    return {
      ok: false, remedy: 'install the app or put it on PATH, or keep the public sections only',
      reason: `${APP_NAMES[harness]} is not installed, or its version cannot be read, so BMN cannot tell which program would read these rules`
    }
  }
  return { ok: true, inspected }
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
      return { code: 'ROUTE_CHANGED', message: `refusing a full rendering for ${harness}: ${route.reason}; ${route.remedy}`, plans: [], planHash: null }
    }
    const path = targetPath(harness, environment)
    const prior = pathState(path)
    const records = lastWritten()
    if (prior.kind === 'file' && prior.text === rendering.text && records[path] === rendering.hash) continue
    const change = prior.kind === 'link' ? 'link' : prior.kind === 'missing' ? 'missing'
      : records[path] === undefined ? 'unmanaged' : records[path] !== sha256(prior.text) ? 'edited-outside' : 'stale'
    const kind = { link: 'replaces a symbolic link', missing: 'creates the file', unmanaged: 'replaces a file BMN did not write (unmanaged)',
      'edited-outside': 'replaces a file edited outside BMN', stale: 'updates BMN\'s file' }[change]
    plans.push({ harness, path, resolved: resolvedPath(path, prior), prior, rendering, kind, change, diff: unifiedDiff(describeState(prior), rendering.text, path),
      fold: prior.kind === 'file' && records[path] !== undefined && records[path] !== sha256(prior.text) ? foldInLines(prior.text, rendering.text) : [] })
  }
  return { code: 'OK', master, plans, planHash: planHash(plans) }
}

function planHash(plans) {
  return sha256(canonicalJson(plans.map((plan) => ({
    harness: plan.harness, path: plan.path, kind: plan.kind, rendered: plan.rendering.hash,
    prior: plan.prior.kind === 'file' ? { kind: 'file', hash: sha256(plan.prior.text), directory: plan.prior.directory } : plan.prior
  }))))
}

/** The plan as the panel and `--plan --json` show it: no file bytes beyond the diffs. */
export function planView(result) {
  return {
    code: result.code, ...(result.message ? { message: result.message } : {}), plan_hash: result.planHash,
    targets: result.plans.map((plan) => ({ harness: plan.harness, path: plan.path, resolved_path: plan.resolved, kind: plan.kind, change: plan.change, rendering: plan.rendering.kind,
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
    `${plan.harness}: ${plan.path}${plan.resolved === plan.path ? '' : ` (written at ${plan.resolved})`}`,
    `  ${plan.kind}${plan.prior.kind === 'link' ? ` (link to ${plan.prior.target}; the link is replaced, its target is not touched)` : ''}`,
    `  ${KIND_WORDS[plan.rendering.kind]} (${plan.rendering.reason}); team: ${plan.rendering.team_form}`,
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
  return writeTransaction(master, plans, { now, beforeTarget })
}

/**
 * A transaction's own, new directory. The id is the second and the process, with a count added
 * when that is taken: an existing directory is never reused, so one transaction can never
 * overwrite another's manifest or backups.
 */
function newTransaction(now) {
  ensurePrivate(transactionsDirectory())
  const base = `${now.toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}-${process.pid}`
  for (let count = 1; ; count += 1) {
    const id = count === 1 ? base : `${base}-${count}`
    try {
      mkdirSync(`${transactionsDirectory()}/${id}`, { mode: 0o700 })
      return { id, folder: `${transactionsDirectory()}/${id}` }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

/**
 * Writes planned targets as one transaction: the manifest of each target's prior state and BMN's
 * last-written record first, then each file through the change-refusing, read-back flow. A
 * failure part-way stops and keeps the manifest so `restore` can undo what changed.
 */
function writeTransaction(master, plans, { now = new Date(), beforeTarget, reason = 'install' } = {}) {
  const { id, folder } = newTransaction(now)
  const records = lastWritten()
  const manifest = {
    id, created_at: now.toISOString(), master_hash: master.hash, state: 'started', reason,
    targets: plans.map((plan, index) => ({
      harness: plan.harness, path: plan.path, prior: plan.prior.kind === 'file' ? { kind: 'file', backup: `${index}.bak`, mode: plan.prior.mode } : plan.prior,
      prior_record: records[plan.path] ?? null, written_hash: plan.rendering.hash, done: false
    }))
  }
  plans.forEach((plan, index) => {
    if (plan.prior.kind === 'file') writePrivate(`${folder}/${index}.bak`, plan.prior.text)
  })
  writePrivate(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2))
  snapshotMaster(master, `${reason} ${id}`, now)
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
    written.push({ harness: plan.harness, path: plan.path, kind: plan.rendering.kind })
  }
  manifest.state = 'complete'
  writePrivate(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2))
  return { code: 'OK', transaction: id, written }
}

// ---------------------------------------------------------------------------------------------
// The Team phrase after an approval (60.4 AC6)

/**
 * What a shown Team update is bound to: the master, the file as it is (its bytes and the real
 * directory that holds it), the proposed bytes, and the whole inspection that allowed a full
 * rendering: destination, app version and the sources that decided. Any of them changing between
 * the preview and the write skips the target.
 */
function teamBinding(master, harness, path, prior, inspected, proposed) {
  return sha256(canonicalJson({
    master: master.hash, harness, path, directory: prior.directory, prior: sha256(prior.text), proposed: proposed.hash,
    route: inspected === null ? 'not inspected'
      : { basis: inspected.basis, provider: inspected.provider, host: inspected.host, version: inspected.version ?? null, sources: [...(inspected.sources ?? [])].sort() }
  }))
}

/**
 * What approving `nextData` would rewrite in the installed rules files: exactly the targets that
 * are `current` now, whose destination still inspects as approved, and whose new rendering keeps
 * its kind and differs from the installed file only inside the Team phrase. Each carries a
 * binding of the master hash, its resolved path and bytes, the inspection and the proposed bytes,
 * which the write rechecks. Every other target is left for Install.
 */
export async function planTeamUpdate(nextData, { environment = process.env } = {}) {
  let master
  let current
  try {
    master = readMaster()
    current = approvedOrNull()
  } catch (error) {
    if (error instanceof RosterError) return { targets: [] }
    throw error
  }
  const next = { data: nextData }
  const was = teamPhrase(current)
  if (was.text === teamPhrase(next).text) return { targets: [] }
  const records = lastWritten()
  const targets = []
  for (const harness of HARNESSES) {
    const path = targetPath(harness, environment)
    let prior
    try {
      prior = pathState(path)
    } catch {
      continue
    }
    const installed = render(master, harness, current)
    if (prior.kind !== 'file' || records[path] !== installed.hash || prior.text !== installed.text) continue
    const proposed = render(master, harness, next)
    if (proposed.kind !== installed.kind || proposed.text === prior.text) continue
    if (render(master, harness, next, { team: was }).text !== prior.text) continue
    const route = await routeStillMatches(harness, routeFor(harness, next), environment)
    if (!route.ok) continue
    targets.push({ harness, path, resolved_path: resolvedPath(path, prior), kind: proposed.kind, diff: unifiedDiff(prior.text, proposed.text, path), binding: teamBinding(master, harness, path, prior, route.inspected, proposed) })
  }
  return { targets }
}

/**
 * After the approval: writes, as one transaction, the targets the owner was shown whose binding
 * still holds against the generation now approved. A changed binding skips that target, and
 * nothing outside `shown` is ever written. Returns what was written and what was skipped.
 */
export async function applyTeamUpdate(shown, { environment = process.env, now = new Date(), beforeTarget } = {}) {
  if (shown.length === 0) return { code: 'OK', transaction: null, written: [], skipped: [] }
  const master = readMaster()
  const generation = approvedOrNull()
  const plans = []
  const skipped = []
  for (const target of shown) {
    if (!HARNESSES.includes(target.harness)) continue
    const path = targetPath(target.harness, environment)
    let prior
    try {
      prior = pathState(path)
    } catch {
      prior = null
    }
    const rendering = render(master, target.harness, generation)
    const route = prior?.kind === 'file' ? await routeStillMatches(target.harness, routeFor(target.harness, generation), environment) : { ok: false }
    if (!route.ok || teamBinding(master, target.harness, path, prior, route.inspected, rendering) !== target.binding) {
      skipped.push(target.harness)
      continue
    }
    plans.push({ harness: target.harness, path, prior, rendering })
  }
  if (plans.length === 0) return { code: 'OK', transaction: null, written: [], skipped }
  return { ...writeTransaction(master, plans, { now, beforeTarget, reason: 'team update' }), skipped }
}

export function listTransactions() {
  let names
  try {
    names = readdirSync(transactionsDirectory())
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  // Newest first by the time each records: an id ends in a process id, so two written in one second do not sort by name.
  return names.sort().reverse().map((id) => {
    const manifest = readJson(`${transactionsDirectory()}/${id}/manifest.json`, null)
    return manifest === null ? { id, valid: false } : { id, valid: true, created_at: manifest.created_at, state: manifest.state, reason: manifest.reason ?? 'install', targets: manifest.targets.map((target) => target.harness) }
  }).sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
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
  const targets = plans.map((plan) => ({ harness: plan.harness, path: plan.path, resolved_path: resolvedPath(plan.path, plan.current), change: plan.priorState.kind,
    becomes: plan.priorState.kind === 'link' ? `link to ${plan.priorState.target}` : plan.priorState.kind === 'missing' ? 'removed (it did not exist)' : 'its earlier bytes',
    diff: unifiedDiff(describeState(plan.current), describeState(plan.priorState), plan.path) }))
  const hash = sha256(canonicalJson(plans.map((plan) => ({ path: plan.path, directory: plan.current.directory, current: plan.current.kind === 'file' ? sha256(plan.current.text) : plan.current, prior: plan.priorState.kind === 'file' ? sha256(plan.priorState.text) : plan.priorState }))))
  if (planOnly) return { code: 'OK', plan_hash: hash, targets }
  if (expectedPlanHash !== undefined && expectedPlanHash !== hash) return { code: 'REVISION_CONFLICT', message: 'the targets changed since the restore was shown; review it again' }
  const details = targets.map((target) => `${target.harness}: ${target.path}${target.resolved_path === target.path ? '' : ` (written at ${target.resolved_path})`} -> ${target.becomes}\n${target.diff}`).join('\n\n')
  if (!await confirm(`Restore transaction ${id}?`, details, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
  const restored = []
  for (const plan of plans) {
    if (!sameState(pathState(plan.path), plan.current)) {
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

const APP_LIST = new RegExp(`(?:${Object.values(APP_NAMES).join('|')}) \\([^()\\n]*\\)(?:,? (?:and )?(?:${Object.values(APP_NAMES).join('|')}) \\([^()\\n]*\\))*`)
const IMPORT_EDITS = [
  { name: 'the opening Source: sentence is dropped', apply: (text) => text.replace(/^Source:.*?(?:\.[ \t]+|\.?$\n?)/m, '') },
  { name: 'rules are changed in BMN\'s master', apply: (text) => text.replace('change rules, skills and hooks for both', 'change rules in BMN\'s master, and skills and hooks, for both') },
  { name: 'the pointer to the agent table narrows to dispatch commands', apply: (text) => text.replace('Model roster, effort levels, safe dispatch commands and limits:', 'Safe dispatch commands:') }
]

/**
 * Today's Claude rules as the first master, unchanged except the edits it names: the `Source:`
 * sentence dropped, rules changed in BMN's master, the agent list in the Team section replaced by
 * the inline team placeholder, the pointer to the agent table narrowed to its dispatch commands,
 * and an `opencode` section appended from the OpenCode lines when there are any. The owner then
 * marks public sections on the Rules page.
 */
export function importedMaster(sourceText, opencodeText) {
  const changes = []
  let body = sourceText.replace(/\n+$/, '')
  for (const edit of IMPORT_EDITS) {
    const next = edit.apply(body)
    if (next !== body) changes.push(edit.name)
    body = next
  }
  if (!body.includes(TEAM_MARKER)) {
    const lines = body.split('\n')
    const team = lines.findIndex((line) => /^##\s+Team\b/.test(line))
    if (team !== -1) {
      let end = lines.findIndex((line, index) => index > team && /^#{1,2}\s/.test(line))
      if (end === -1) end = lines.length
      const listed = lines.findIndex((line, index) => index > team && index < end && APP_LIST.test(line))
      if (listed !== -1) {
        lines[listed] = lines[listed].replace(APP_LIST, TEAM_MARKER)
        changes.push('the agent list in the Team section becomes the team placeholder')
      } else {
        while (end > team + 1 && lines[end - 1].trim() === '') end -= 1
        lines.splice(end, 0, '', TEAM_MARKER)
        changes.push('the team placeholder is added at the end of the Team section')
      }
      body = lines.join('\n')
    }
  }
  let text = `${body}\n`
  if (opencodeText !== null && opencodeText.trim() !== '') {
    text += `\n<!-- bmn:apps opencode -->\n${opencodeText.replace(/\n+$/, '')}\n<!-- /bmn:apps -->\n`
    changes.push('the OpenCode lines become an opencode section')
  }
  return { text, changes }
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
    // The rendered hash moves with the Team phrase, so a Team change makes an earlier test stale too.
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
  return decision.route === null ? 'none' : `${decision.route.provider}/${decision.route.basis}/${decision.kind}`
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
 * route and the rendered file's hash. Sends the rules to that app's provider, so it runs only
 * where the approved destination may receive private work.
 */
export async function probe(harness, { environment = process.env, now = new Date(), timeoutMs = 180_000 } = {}) {
  const master = readMaster()
  const generation = approvedOrNull()
  const rendering = render(master, harness, generation)
  const decision = routeFor(harness, generation)
  const command = PROBE_COMMANDS[harness]
  let host = null
  const record = (outcome, detail, version = null) => {
    const entry = { harness, at: now.toISOString(), outcome, detail, version, host, route: canonicalRoute(decision), rendered_hash: rendering.hash, master_hash: master.hash }
    ensurePrivate(dirname(probeLogPath()))
    appendFileSync(probeLogPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    return entry
  }
  const { harnessVersion } = await import('./agents-check.mjs')
  const version = harnessVersion(command, environment)
  if (version === null) return record('unavailable', `${command} is not installed or did not answer --version`)
  if (decision.kind !== 'full') return record('unavailable', `${decision.reason}; a loading test would send the rules to that provider`, version)
  // Like install: the destination is inspected again right before anything is sent (60.6 AC4).
  const route = await routeStillMatches(harness, decision, environment)
  if (!route.ok) return record('unavailable', `refused: ${route.reason}; ${route.remedy}`, version)
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

export const RULES_USAGE = `Usage: bmn rules render <app>                     The exact file BMN writes for one app (stdout)
       bmn rules check [--json]                    Each target: unreadable, missing, link, unmanaged,
                                                   edited-outside, stale or current; exit 0 only if all current
       bmn rules install [app…] [--plan] [--expect-plan <hash>] [--yes] [--json]
                                                   One confirmed transaction writing every (or each named) target
       bmn rules restore --transaction <id> [--plan] [--expect-plan <hash>] [--yes] [--json]
       bmn rules restore --list                    Undo one install; links come back as links
       bmn rules history [--json]                  The master-source snapshots BMN kept
       bmn rules revert-master <revision> [--yes]  Write one snapshot back as the master (a new revision)
       bmn rules import [--from <file>] [--yes]    One-shot: today's Claude rules become the master
       bmn rules probe <app> [--json]              Owner-run: does the app load the file? Sends the rules to that
                                                   app's provider, so only where it may receive private work

Apps: ${HARNESSES.join(', ')}. The master is ~/.config/bmn/agents/global-rules.md: untagged text goes to every app;
<!-- bmn:apps codex opencode --> … <!-- /bmn:apps --> limits a section to those apps; <!-- bmn:public --> …
<!-- /bmn:public --> marks a section a public-only destination may receive; one <!-- bmn:team -->, which may sit
inside a sentence, becomes the approved team's names by app. An app whose approved destination may not receive
private work gets only the public sections. This covers only the global files BMN writes, never project files
or skills; sessions started before an install keep their old rules.
Exit: 0 ok, 2 usage, 3 master missing, 4 master invalid, 1 something not current or not written,
7 changed while reading, 10 a master already exists (import), 13 history unavailable.`

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
      if (positionals.length !== 1) return usage('rules render expects one app')
      if (!HARNESSES.includes(positionals[0])) throw new RosterError('MASTER_INVALID', `unknown app ${positionals[0]} (use ${HARNESSES.join(', ')})`)
      const rendering = render(readMaster(), positionals[0], approvedOrNull())
      writeSync(1, rendering.text)
      writeSync(2, `bmn: ${rendering.kind} rendering (${rendering.reason}); team: ${rendering.team_form}; ${rendering.bytes} bytes\n`)
      return 0
    }
    if (action === 'check') {
      if (positionals.length > 0) return usage('rules check takes no arguments')
      const targets = checkTargets()
      const ok = targets.every((target) => target.state === 'current')
      if (asJson) out(JSON.stringify({ ok, master: masterPath(), targets }, null, 2))
      else {
        out([...targets.map((target) => `${target.harness.padEnd(9)}${target.state}${target.state === 'link' ? ` -> ${target.link_target}` : ''}${target.kind === 'public' ? ` (public rendering: ${target.reason})` : ''}  ${target.path}`),
          ok ? 'Every target holds its current rendering. This says what is on disk, not that a running session loaded it.' : 'Run `bmn rules install` to write the targets that are not current.'].join('\n'))
      }
      return ok ? 0 : 1
    }
    if (action === 'install') {
      const harnesses = positionals.length === 0 ? HARNESSES : positionals
      for (const harness of harnesses) if (!HARNESSES.includes(harness)) return usage(`unknown app ${harness}`)
      if (options.plan) {
        const planned = planView(await planInstall(harnesses))
        out(asJson ? JSON.stringify(planned, null, 2) : planned.code !== 'OK' ? `${planned.code}: ${planned.message}` : planned.targets.length === 0 ? 'Every target already holds its current rendering.'
          : planned.targets.map((target) => `${target.harness}: ${target.path}\n  ${target.kind}\n${target.diff}`).join('\n\n'))
        return planned.code === 'OK' ? 0 : 1
      }
      const result = await installRules(harnesses, { yes: options.yes === true, asJson, ...(options['expect-plan'] !== undefined ? { expectedPlanHash: options['expect-plan'] } : {}) })
      if (asJson) out(JSON.stringify(result, null, 2))
      else if (result.code === 'OK') out(result.transaction === null ? result.message : [`Wrote ${result.written.length} rules file(s) in transaction ${result.transaction}:`, ...result.written.map((entry) => `  ${entry.harness}: ${entry.path}${entry.kind === 'public' ? ' (public rendering)' : ''}`), `Undo: bmn rules restore --transaction ${result.transaction}`, 'Sessions started before this keep their old rules.'].join('\n'))
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
      const expected = pathState(masterPath())
      if (expected.kind !== 'missing') throw new RosterError('MASTER_EXISTS', `${masterPath()} already exists; import is one-shot (edit it in Preferences > Rules)`)
      const source = options.from ?? targetPath('claude')
      let sourceText
      try {
        sourceText = readFileSync(source, 'utf8')
      } catch (error) {
        throw new RosterError('MASTER_MISSING', `cannot read ${source} (${error.code})`)
      }
      const adapter = existsSync(`${agentsDirectory()}/adapters/opencode.md`) ? readFileSync(`${agentsDirectory()}/adapters/opencode.md`, 'utf8') : null
      const { text, changes } = importedMaster(sourceText, adapter)
      const details = [`Master: ${masterPath()} (new)`, `From: ${source}${adapter === null ? '' : ` and ${agentsDirectory()}/adapters/opencode.md`}`,
        ...(changes.length === 0 ? ['Unchanged.'] : ['Changed:', ...changes.map((change) => `  ${change}`)]), unifiedDiff(sourceText, text, masterPath())].join('\n')
      if (!await confirm('Create the rules master from these rules?', details, { yes: options.yes === true, asJson })) return asJson ? 2 : 1
      writeMaster(expected, text, `import from ${source}`)
      out(asJson ? JSON.stringify({ code: 'OK', master: masterPath(), bytes: Buffer.byteLength(text), changes }, null, 2) : `Created ${masterPath()}. Mark any public sections in Preferences > Rules, then install.`)
      return 0
    }
    if (positionals.length !== 1 || !HARNESSES.includes(positionals[0])) return usage(`rules probe expects one app: ${HARNESSES.join(', ')}`)
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

