// MODULE: agents-check-workspace.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: harness versions, workspaces and their public status, destinations, receipts and session bindings
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { RosterError, canonicalJson, resolvedDirectory, sha256 } from './agents-roster.mjs'
import { stateDirectory } from './agents-state.mjs'
import { OPENCODE_SESSION_ID } from './agents-opencode.mjs'
import { BINDING_WINDOW_MS, VISIBILITY_MAX_AGE_MS, firstLine, listDirectory, readBytes, readText, refuse, traceRead } from './agents-check-base.mjs'

export { boundSession, canonicalDirectory, committedBlob, ensurePrivateDirectory, hashFile, inside, isObject, isString, packetManifest, readReceiptFile, stricter, writeState }

/**
 * `<harness> --version`, the only thing BMN runs. It is asked afresh for every decision and
 * resolved through PATH by the same exec the dispatch uses, so the version always belongs to the
 * program that would run: nothing is remembered, because no file identity can tell that a stable
 * launcher now starts another program. A failure reads as no version (null).
 */
export function harnessVersion(command, environment) {
  try {
    const text = execFileSync(command, ['--version'], { env: environment, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Workspaces and their public status

function canonicalDirectory(path, from) {
  if (path.split('/').includes('..')) return null
  const absolute = isAbsolute(path) ? path : `${from}/${path}`
  try {
    traceRead?.(absolute)
    const real = realpathSync(absolute)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function inside(child, parent) {
  if (child === parent) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Whether `marker` is what Git leaves at a top-level: a `.git` folder that holds a HEAD, or the
 * `.git` file a linked worktree or a submodule has. A stray empty `.git` folder is neither, and
 * Git itself reads past it.
 */
function repositoryMarker(marker) {
  traceRead?.(marker)
  try {
    if (!statSync(marker).isDirectory()) return true
    const head = join(marker, 'HEAD')
    traceRead?.(head)
    statSync(head)
    return true
  } catch {
    return false
  }
}

/**
 * The workspace a directory belongs to: its Git top-level (the nearest folder holding a
 * repository's `.git`), or the directory itself outside Git. A nested repository has its own
 * top-level, so an exception for the outer one never covers it (60.8 AC6). `directory` is
 * canonical already.
 */
export function workspaceRoot(directory) {
  let current = directory
  for (;;) {
    if (repositoryMarker(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return directory
    current = parent
  }
}

export function visibilityDirectory() {
  return `${stateDirectory()}/visibility`
}

export function visibilityPath(workspace) {
  return `${visibilityDirectory()}/${sha256(workspace)}.json`
}

/** `github.com/<owner>/<name>` for a GitHub remote URL in any of Git's spellings, else null. */
export function normalizedGithubOrigin(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git:\/\/github\.com\/|(?:[^@/]+@)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null
  return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}`
}

/**
 * Git, asked about this workspace's own repository and nothing else: no `GIT_*` variable may point
 * it at another repository, object store or configuration, and replacement refs are off, so an
 * object name always reads the object with that hash (60.3 AC6).
 */
function git(workspace, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  return execFileSync('git', ['--no-replace-objects', '-C', workspace, ...args],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024, ...options, env: { ...env, GIT_NO_REPLACE_OBJECTS: '1' } })
}

/** The workspace's `origin` as git would use it: `{ origin }`, or `{ reason }` when there is none or it is not GitHub. */
export function workspaceOrigin(workspace) {
  let url
  try {
    url = git(workspace, ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return { reason: 'no origin' }
  }
  const origin = normalizedGithubOrigin(url)
  return origin === null ? { reason: 'not GitHub' } : { origin }
}

const PRIVATE_REASONS = ['no origin', 'not GitHub', 'private repository', 'check failed']

/**
 * Whether a workspace is proven public (60.3 AC5): only by a visibility record that is well
 * formed, younger than 7 days, not dated in the future, names this canonical path and the
 * workspace's current origin, and says GitHub reports that repository public. Anything else is
 * private, with the reason in words. No network call: `bmn roster visibility --refresh` writes
 * the record.
 */
export function workspaceVisibility(workspace, now = new Date()) {
  let text
  try {
    text = readText(visibilityPath(workspace))
  } catch (error) {
    return { public: false, reason: error.code === 'ENOENT' ? 'no record' : 'malformed' }
  }
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return { public: false, reason: 'malformed' }
  }
  const checkedAt = isObject(record) && typeof record.checked_at === 'string' ? Date.parse(record.checked_at) : Number.NaN
  if (!isObject(record) || record.version !== 1 || record.workspace !== workspace || Number.isNaN(checkedAt) || checkedAt > now.getTime()
    || !['public', 'private'].includes(record.visibility)) return { public: false, reason: 'malformed' }
  if (now.getTime() - checkedAt >= VISIBILITY_MAX_AGE_MS) return { public: false, reason: 'stale', record }
  if (record.visibility === 'private') {
    return { public: false, reason: PRIVATE_REASONS.includes(record.reason) ? record.reason : 'private repository', record }
  }
  if (typeof record.origin !== 'string' || !/^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(record.origin) || !Number.isSafeInteger(record.repository_id)
    || record.repository_id <= 0 || !isString(record.default_branch) || typeof record.commit !== 'string' || !/^[0-9a-f]{40}$/.test(record.commit)) {
    return { public: false, reason: 'malformed' }
  }
  const current = workspaceOrigin(workspace)
  if (current.origin === undefined) return { public: false, reason: current.reason, record }
  if (current.origin !== record.origin) return { public: false, reason: 'origin changed', record }
  return { public: true, reason: `GitHub reports ${record.origin} public`, record }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value) {
  return typeof value === 'string' && value !== ''
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

/** BMN-managed state, written whole and private: temp, fsync, rename, read back (R60-NFR2). */
function writeState(path, text) {
  ensurePrivateDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, path)
  if (readFileSync(path, 'utf8') !== text) throw new RosterError('STATE_CORRUPT', `${path} did not read back`)
}

/**
 * Asks GitHub, without credentials, whether the workspace's origin is public and which commit its
 * default branch is at, and writes one record (60.3 AC10). A missing origin, another host, a
 * private or missing repository, an error or a timeout records private. The only network call in
 * the roster commands; `api` and `request` are the tests' stub seam.
 */
export async function refreshVisibility(workspacePath, { now = new Date(), api = 'https://api.github.com', request = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const workspace = canonicalDirectory(workspacePath, process.cwd())
  if (workspace === null) throw new RosterError('WORKSPACE_UNKNOWN', `${workspacePath} is not an existing directory without ..`)
  const base = { version: 1, workspace, checked_at: now.toISOString() }
  const origin = workspaceOrigin(workspace)
  let record
  if (origin.origin === undefined) {
    record = { ...base, origin: null, visibility: 'private', reason: origin.reason }
  } else {
    const [, owner, name] = origin.origin.split('/')
    const ask = async (path, accept) => {
      const response = await request(`${api}/repos/${owner}/${name}${path}`, {
        headers: { accept, 'user-agent': 'bmn-roster-visibility' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), credentials: 'omit'
      })
      return response
    }
    try {
      const repository = await ask('', 'application/vnd.github+json')
      if (repository.status === 404) {
        record = { ...base, origin: origin.origin, visibility: 'private', reason: 'private repository' }
      } else if (!repository.ok) {
        record = { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
      } else {
        const body = await repository.json()
        const isPublic = isObject(body) && body.private === false && (body.visibility === undefined || body.visibility === 'public')
        if (!isPublic) {
          record = { ...base, origin: origin.origin, visibility: 'private', reason: 'private repository' }
        } else if (!Number.isSafeInteger(body.id) || !isString(body.default_branch) || !/^[A-Za-z0-9._/-]{1,255}$/.test(body.default_branch)) {
          record = { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
        } else {
          const commit = await ask(`/commits/${encodeURIComponent(body.default_branch)}`, 'application/vnd.github.sha')
          const sha = commit.ok ? (await commit.text()).trim() : ''
          record = /^[0-9a-f]{40}$/.test(sha)
            ? { ...base, origin: origin.origin, repository_id: body.id, visibility: 'public', default_branch: body.default_branch, commit: sha }
            : { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
        }
      }
    } catch {
      record = { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
    }
  }
  writeState(visibilityPath(workspace), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

// ---------------------------------------------------------------------------------------------
// Destinations and private work

/**
 * Which roster provider a resolved route reaches, and how BMN knows (60.3 AC4). A harness's own
 * default names the provider approved in `## harness-routes` (an `observed-default` entry holds
 * only while the harness's default provider is still that one); an explicit host names the
 * provider whose `hosts` list it. `harness_provider` is the provider id the harness itself uses.
 */
export function destinationOf(data, harness, route) {
  if (route.basis === 'unknown') return { known: false, reason: route.reason }
  // An OpenCode run in BMN's own folder: its -m alone decides, and BMN wrote and checked everything else it reads.
  if (route.basis === 'folder') return { known: true, default: true, provider: route.provider, host: `default:${route.provider}`, basis: 'observed-default', harness_provider: route.provider }
  if (route.basis === 'default') {
    const approved = data.harness_routes.find((entry) => entry.harness === harness)
    if (approved === undefined) return { known: false, reason: `no approved destination for ${harness} in ## harness-routes` }
    if (approved.basis === 'observed-default' && approved.provider !== route.provider) {
      return { known: true, default: true, provider: route.provider, host: `default:${route.provider}`, basis: 'observed-default', harness_provider: route.provider, unapproved: approved.provider }
    }
    return { known: true, default: true, provider: approved.provider, host: `default:${approved.provider}`, basis: approved.basis, harness_provider: route.provider }
  }
  const owner = data.providers.find((provider) => provider.hosts.some((host) => host.toLowerCase() === route.host))
  return { known: true, default: false, provider: owner?.id ?? null, host: route.host, basis: 'explicit', harness_provider: route.provider }
}

/**
 * Whether a destination may receive private work (60.3 AC4): its provider answers `allowed` and
 * the destination is evidenced (an observed default, or an explicit listed host); or it is
 * evidenced that way and an exception names that provider and this workspace's root. An
 * owner-declared destination is public work only and no exception applies to it. `root` is the
 * canonical root every directory of the dispatch belongs to, or null when they do not share one.
 * An exception's folder is compared as approved, text against that real path, and no link in it
 * is followed: wherever a link points later, the approval never comes to mean another folder.
 */
export function privateWorkAnswer(data, destination, root) {
  const provider = data.providers.find((entry) => entry.id === destination.provider)
  const answer = provider?.private_work ?? 'public_only'
  const name = provider?.name ?? destination.provider
  if (destination.basis === 'owner-declared') return { allowed: false, answer, reason: `the destination is owner-declared, not inspected, so ${name} gets public work only` }
  if (answer === 'allowed') return { allowed: true, answer, reason: `${name} may see private work` }
  const exception = root === null ? undefined
    : data.exceptions.find((entry) => entry.provider === destination.provider && entry.folder === root)
  if (exception !== undefined) return { allowed: true, answer, exception: { id: exception.id, scope: 'this workspace' }, reason: `${name} is allowed in this workspace (exception ${exception.id})` }
  const linked = root === null ? undefined
    : data.exceptions.find((entry) => entry.provider === destination.provider && resolvedDirectory(entry.folder) === root)
  return { allowed: false, answer, reason: `${name} gets public work only${linked === undefined ? '' : ` (exception ${linked.id} names this workspace through a link, not by its real path, and counts for nothing)`}` }
}

// ---------------------------------------------------------------------------------------------
// The evaluation

function stricter(a, b) {
  return a === 'private' || b === 'private' ? 'private' : 'public'
}

function hashFile(path) {
  return sha256(readBytes(path))
}

/** Every regular file under the packet, relative paths sorted; a link or special file is invalid. */
function packetManifest(packet) {
  const files = []
  const walk = (directory, prefix) => {
    for (const entry of listDirectory(directory)) {
      const path = `${directory}/${entry.name}`
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, name)
      else if (entry.isFile()) files.push({ name, sha256: hashFile(path) })
      else refuse('PACKET_INVALID', `${name} in the packet is not a regular file`)
    }
  }
  walk(packet, '')
  return files.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/**
 * The blob `name` holds in the tree of `commit`, read from the workspace's local object store, or
 * null when that object is missing (never fetched), is not a file, or the name is not in the tree.
 */
function committedBlob(workspace, commit, name) {
  try {
    if (git(workspace, ['cat-file', '-t', `${commit}:${name}`], { encoding: 'utf8' }).trim() !== 'blob') return null
    return git(workspace, ['cat-file', 'blob', `${commit}:${name}`])
  } catch {
    return null
  }
}

function readReceiptFile(path) {
  let receipt
  try {
    receipt = JSON.parse(readText(path))
  } catch {
    return null
  }
  if (receipt === null || typeof receipt !== 'object' || receipt.version !== 1 || typeof receipt.receipt_hash !== 'string') return null
  const rest = { ...receipt }
  delete rest.receipt_hash
  return receiptHash(rest) === receipt.receipt_hash ? receipt : null
}

export function receiptHash(body) {
  return sha256(canonicalJson(body))
}

/** Every `<sessions>/YYYY/MM/DD/rollout-*-<id>.jsonl` under a Codex home: none when the session was never saved there, more than one when the id is not one session's. */
export function sessionRecordFiles(codexHome, id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id) || codexHome === null) return []
  const root = `${codexHome}/sessions`
  const found = []
  const walk = (directory, depth) => {
    let entries
    try {
      entries = listDirectory(directory)
    } catch {
      return
    }
    for (const entry of entries) {
      if (depth < 3 && entry.isDirectory() && /^\d+$/.test(entry.name)) walk(`${directory}/${entry.name}`, depth + 1)
      else if (depth === 3 && entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`${id}.jsonl`)) found.push(`${directory}/${entry.name}`)
    }
  }
  walk(root, 0)
  return found
}

/** Finds `<sessions>/YYYY/MM/DD/rollout-*-<id>.jsonl` and returns its first-line metadata. */
export function sessionRecord(codexHome, id) {
  const found = sessionRecordFiles(codexHome, id)
  return found.length === 1 ? sessionRecordAt(found[0]) : null
}

/** The first-line metadata of one Codex session record file; null when it cannot be read as one. */
export function sessionRecordAt(path) {
  let line
  try {
    line = firstLine(path)
  } catch {
    return null
  }
  if (line === null) return null
  try {
    const record = JSON.parse(line)
    const payload = record?.type === 'session_meta' ? record.payload : null
    if (payload === null || typeof payload !== 'object') return null
    return { id: payload.id, cwd: payload.cwd, provider: payload.model_provider, cli_version: payload.cli_version }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Session bindings (60.3 AC8): which receipt started which Codex session

const SESSION_ID = /^[0-9a-f-]{8,64}$/i

export function bindingPath(receiptHashValue) {
  return `${stateDirectory()}/bindings/${receiptHashValue}.json`
}

/**
 * Records that the dispatch a receipt checked started `sessionId`. Accepted once per receipt and
 * only within 10 minutes of the receipt's `issued_at`; a later resume passes only for that session.
 * An OpenCode research run binds its session as well, so its usage is read by the session its check passed (70.4 AC4).
 */
export function bindSession(receiptFile, sessionId, { now = new Date() } = {}) {
  const receipt = readReceiptFile(receiptFile)
  if (receipt === null) throw new RosterError('RECEIPT_INVALID', `${receiptFile} is not an intact version-1 receipt`)
  if (receipt.harness === 'opencode') {
    if (receipt.mode !== 'dispatch' && receipt.mode !== 'research') throw new RosterError('RECEIPT_INVALID', 'only the receipt of an OpenCode dispatch or research run can be bound to a session')
    if (!OPENCODE_SESSION_ID.test(sessionId)) throw new RosterError('RECEIPT_INVALID', `${sessionId} is not an OpenCode session id`)
  } else {
    if (receipt.mode !== 'dispatch' || receipt.harness !== 'codex') throw new RosterError('RECEIPT_INVALID', 'only the receipt of a Codex dispatch can be bound to a session')
    if (!SESSION_ID.test(sessionId)) throw new RosterError('RECEIPT_INVALID', `${sessionId} is not a Codex session id`)
  }
  const age = now.getTime() - Date.parse(receipt.issued_at)
  if (!(age >= 0 && age <= BINDING_WINDOW_MS)) throw new RosterError('RECEIPT_INVALID', 'a session is bound within 10 minutes of the check that preceded it; start a fresh checked dispatch')
  const path = bindingPath(receipt.receipt_hash)
  ensurePrivateDirectory(dirname(path))
  const text = `${JSON.stringify({ version: 1, receipt_hash: receipt.receipt_hash, session_id: sessionId, bound_at: now.toISOString() })}\n`
  let handle
  try {
    handle = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw new RosterError('RECEIPT_INVALID', 'this receipt is already bound to a session; a binding is accepted once')
    throw error
  }
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  return { receipt_hash: receipt.receipt_hash, session_id: sessionId }
}

function boundSession(receiptHashValue) {
  try {
    const binding = JSON.parse(readText(bindingPath(receiptHashValue)))
    return isObject(binding) && binding.receipt_hash === receiptHashValue && typeof binding.session_id === 'string' ? binding.session_id : null
  } catch {
    return null
  }
}
