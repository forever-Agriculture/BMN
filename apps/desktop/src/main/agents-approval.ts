// MODULE: agents-approval.ts - Epic 60.2: the only writer of approved roster generations, used by the Agents panel
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { RosterError, agentsDirectory, parseRoster, rewriteRoster, rosterPath, sha256, type RosterData } from '../../bin/agents-roster.mjs'
import {
  approvalLockPath, buildGeneration, currentPointerPath, generationNumbers, generationPath, generationsDirectory, historyLogPath,
  readApproved, readGeneration, stateDirectory, type Generation
} from '../../bin/agents-state.mjs'
import { pathState, replaceFileSafely, type PathState } from '../../bin/safe-config-write.mjs'

/**
 * Approval is workflow protection against same-user processes, not an OS boundary
 * (docs/agent-control.md, "What the app enforces"): it makes a roster edit take effect only after
 * the owner saw it in BMN. The CLI never imports this module; a source test proves that.
 */

export interface ApprovalSeams {
  now?: () => Date
  /** Runs once the lock is held, before the revision check: the concurrency test's seam. */
  afterLock?: () => void
  /** Runs after the generation is durable and before `current` moves: the crash test's seam. */
  beforePointer?: () => void
  /** Runs after the roster file is written and before the generation is published. */
  beforePublish?: () => void
  /** Process start identity for lock liveness; Linux reads /proc. */
  startIdentity?: (pid: number) => string | null
}

/** What the panel showed: the approved generation (null when none) and the roster file hash. */
export interface ShownRevision {
  generation: number | null
  fileHash: string
}

function linuxStartIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null
  } catch {
    return null
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

/** Writes `text` so a crash leaves either the old file or the whole new one: temp, fsync, rename, fsync the folder. */
function writeDurably(path: string, text: string): void {
  ensurePrivateDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    renameSync(temporary, path)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* never renamed */ }
    throw error
  }
  const folder = openSync(dirname(path), 'r')
  try { fsyncSync(folder) } finally { closeSync(folder) }
}

function logHistory(entry: Record<string, unknown>, now: Date): void {
  ensurePrivateDirectory(stateDirectory())
  appendFileSync(historyLogPath(), `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`, { mode: 0o600 })
}

/**
 * One approval at a time, across processes: `approve.lock` records pid and start time. A lock
 * whose process is gone, or whose pid now belongs to a different process, is broken with a logged
 * note; a live one makes this approval a REVISION_CONFLICT (exit-7 semantics).
 */
function withLock<T>(seams: ApprovalSeams, work: () => T): T {
  const identity = seams.startIdentity ?? linuxStartIdentity
  const now = seams.now ?? (() => new Date())
  ensurePrivateDirectory(stateDirectory())
  const path = approvalLockPath()
  const mine = JSON.stringify({ pid: process.pid, start: identity(process.pid) })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, mine, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holder: { pid?: unknown; start?: unknown } = {}
      try { holder = JSON.parse(readFileSync(path, 'utf8')) as typeof holder } catch { /* unreadable: treat as stale */ }
      const live = typeof holder.pid === 'number' && identity(holder.pid) !== null && identity(holder.pid) === holder.start
      if (live) throw new RosterError('REVISION_CONFLICT', 'another approval is in progress; reload and try again')
      try { unlinkSync(path) } catch { /* another breaker got there first */ }
      logHistory({ event: 'lock-broken', holder }, now())
      continue
    }
    try {
      return work()
    } finally {
      try { unlinkSync(path) } catch { /* already gone */ }
    }
  }
  throw new RosterError('REVISION_CONFLICT', 'could not take the approval lock; reload and try again')
}

/**
 * The generation a write builds on. Corrupt state counts as none here, so the owner can recover
 * by approving or restoring from the panel (which shows it as corrupt, generation null); readers
 * keep exiting 6 until that new generation is published.
 */
function currentGeneration(): Generation | null {
  try {
    return readApproved()
  } catch (error) {
    if (error instanceof RosterError && (error.code === 'NOT_APPROVED' || error.code === 'STATE_CORRUPT')) return null
    throw error
  }
}

function checkShown(shown: ShownRevision, current: Generation | null, fileHash: string): void {
  if ((current?.number ?? null) !== shown.generation || fileHash !== shown.fileHash) {
    throw new RosterError('REVISION_CONFLICT', 'the roster or its approval changed since it was shown; reload to see the current state')
  }
}

/** Generation first, durable; only then `current` moves. An unfinished generation is never pointed to. */
function publish(data: RosterData, rosterFileHash: string, parent: Generation | null, seams: ApprovalSeams,
  kind: 'approval' | 'restore' = 'approval', restoredFrom?: number): Generation {
  const now = (seams.now ?? (() => new Date()))()
  ensurePrivateDirectory(generationsDirectory())
  const number = Math.max(0, ...generationNumbers()) + 1
  const generation = buildGeneration({
    number, parent: parent?.number ?? null, data, rosterFileHash, kind, now,
    ...(restoredFrom === undefined ? {} : { restoredFrom })
  })
  writeDurably(generationPath(number), `${JSON.stringify(generation, null, 2)}\n`)
  if (readGeneration(number)?.hash !== generation.hash) throw new RosterError('STATE_CORRUPT', `generation ${number} did not read back`)
  seams.beforePointer?.()
  writeDurably(currentPointerPath(), `${JSON.stringify({ generation: number, hash: generation.hash })}\n`)
  logHistory({ event: kind, generation: number, parent: parent?.number ?? null, roster_file_hash: rosterFileHash,
    ...(restoredFrom === undefined ? {} : { restored_from: restoredFrom }) }, now)
  return generation
}

function readFileState(): { state: PathState; text: string; hash: string } {
  const state = pathState(rosterPath())
  if (state.kind === 'missing') throw new RosterError('ROSTER_MISSING', `no roster at ${rosterPath()}`)
  // A linked roster is read through its link, as every reader does.
  const text = state.kind === 'file' ? state.text : readFileSync(rosterPath(), 'utf8')
  return { state, text, hash: sha256(text) }
}

function validData(text: string): RosterData {
  const parsed = parseRoster(text)
  if (parsed.data === null) {
    throw new RosterError('ROSTER_INVALID', 'the roster is not valid; nothing was approved', { errors: parsed.errors })
  }
  return parsed.data
}

/** Approves the roster file exactly as shown (60.2 AC1, AC4). */
export function approveRoster(shown: ShownRevision, seams: ApprovalSeams = {}): Generation {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    const file = readFileState()
    checkShown(shown, current, file.hash)
    return publish(validData(file.text), file.hash, current, seams)
  })
}

/** Section ids a row names: an agent id, `roles`, `data-labels` or `harness-routes`. */
const SHARED_SECTIONS = ['roles', 'data-labels', 'harness-routes'] as const

/** The approved data with the named sections taken from the file, in the file's agent order. */
export function mergeSections(approved: RosterData, file: RosterData, scope: readonly string[]): RosterData {
  const fromFile = new Map(file.agents.map((agent) => [agent.id, agent]))
  const fromApproved = new Map(approved.agents.map((agent) => [agent.id, agent]))
  const agents = [...new Set([...file.agents.map((agent) => agent.id), ...approved.agents.map((agent) => agent.id)])]
    .map((id) => (scope.includes(id) ? fromFile.get(id) : fromApproved.get(id)))
    .filter((agent): agent is RosterData['agents'][number] => agent !== undefined)
  return {
    ...approved,
    agents,
    roles: scope.includes('roles') ? file.roles : approved.roles,
    data_labels: scope.includes('data-labels') ? file.data_labels : approved.data_labels,
    harness_routes: scope.includes('harness-routes') ? file.harness_routes : approved.harness_routes
  }
}

/**
 * Approves only the named sections' outside changes (60.5 AC3: one row, one Approve). The file is
 * left as it is; the other sections stay pending. Refused when the approved result would not be a
 * valid roster on its own, for example a role chain naming an agent whose change is still pending.
 */
export function approveSections(shown: ShownRevision, scope: string[], seams: ApprovalSeams = {}): Generation {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    const file = readFileState()
    checkShown(shown, current, file.hash)
    const fileData = validData(file.text)
    if (current === null) return publish(fileData, file.hash, current, seams)
    const unknown = scope.filter((id) => !(SHARED_SECTIONS as readonly string[]).includes(id)
      && !fileData.agents.some((agent) => agent.id === id) && !current.data.agents.some((agent) => agent.id === id))
    if (scope.length === 0 || unknown.length > 0) throw new RosterError('INVALID_VALUE', `no section ${unknown.join(', ') || '(none named)'} to approve`)
    const parsed = parseRoster(rewriteRoster(file.text, mergeSections(current.data, fileData, scope)))
    if (parsed.data === null) {
      throw new RosterError('ROSTER_INVALID', 'this change depends on another pending change; approve them together or revert one', { errors: parsed.errors })
    }
    return publish(parsed.data, file.hash, current, seams)
  })
}

/** Writes the roster backup BMN keeps of the file it is about to replace (R60-NFR2 "record prior state"). */
function keepPriorState(state: PathState, now: Date): void {
  const folder = `${stateDirectory()}/roster-backups`
  ensurePrivateDirectory(folder)
  writeFileSync(`${folder}/${now.toISOString().replaceAll(':', '-')}.json`, JSON.stringify(state), { mode: 0o600 })
}

/**
 * A panel save: the file is rewritten to hold `data` and that exact data is approved. The file is
 * written first and the generation second, so a crash between them leaves only a pending
 * difference that takes no effect (60.2 AC4).
 */
export function saveAndApprove(shown: ShownRevision, data: RosterData, seams: ApprovalSeams = {}): Generation {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    const file = readFileState()
    checkShown(shown, current, file.hash)
    const nextText = rewriteRoster(file.text, data)
    const nextData = validData(nextText)
    if (nextText !== file.text) {
      keepPriorState(file.state, (seams.now ?? (() => new Date()))())
      replaceFileSafely(rosterPath(), file.state, nextText)
    }
    seams.beforePublish?.()
    return publish(nextData, sha256(nextText), current, seams)
  })
}

/**
 * "Revert file to approved": the approved machine data goes back into the affected yaml blocks;
 * every byte outside them is unchanged (60.2 AC6). `scope` limits it to the given sections.
 * No generation is written.
 */
export function revertFileToApproved(shown: ShownRevision, scope: string[] | null = null, seams: ApprovalSeams = {}): { changed: boolean } {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    if (current === null) throw new RosterError('NOT_APPROVED', 'nothing is approved yet, so there is nothing to revert to')
    const file = readFileState()
    checkShown(shown, current, file.hash)
    const nextText = rewriteRoster(file.text, current.data, { scope })
    if (nextText === file.text) return { changed: false }
    if (scope === null) validData(nextText)
    keepPriorState(file.state, (seams.now ?? (() => new Date()))())
    replaceFileSafely(rosterPath(), file.state, nextText)
    return { changed: true }
  })
}

/** "Restore this approval": an earlier generation's data becomes a new generation (60.2 AC6). */
export function restoreGeneration(shown: ShownRevision, number: number, seams: ApprovalSeams = {}): Generation {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    const file = readFileState()
    checkShown(shown, current, file.hash)
    const earlier = readGeneration(number)
    if (earlier === null) throw new RosterError('STATE_CORRUPT', `generation ${number} is missing or does not verify`)
    return publish(earlier.data, earlier.roster_file_hash, current, seams, 'restore', number)
  })
}

export function agentsStateRoot(): string {
  return agentsDirectory()
}
