// MODULE: agents-approval.ts - Epic 60.2: the only writer of approved roster generations, used by the Agents panel
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ID_PATTERN, RESERVED_SECTIONS, RosterError, SHARED_SECTIONS, agentsDirectory, outsideYamlBlocks, parseRoster, rewriteRoster, rosterPath, sha256,
  splitSections, type RosterData
} from '../../bin/agents-roster.mjs'
import {
  approvalLockPath, buildGeneration, currentPointerPath, generationNumbers, generationPath, generationsDirectory, historyLogPath,
  readApproved, readGeneration, restoreProblem, stateDirectory, type Generation
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
  /** Process start identity recorded in the lock; Linux reads /proc. */
  startIdentity?: (pid: number) => string | null
  /** The flock(1) executable; tests point it at a missing one to see the approval fail closed. */
  flockCommand?: string
  /**
   * Judges app destinations an approval would newly record as inspected (60.6 AC4): throws to
   * refuse. The app passes one that inspects each app again; without it every such change is refused.
   */
  checkInspectedRoutes?: (routes: InspectedRoute[]) => void
}

export interface InspectedRoute { harness: string; provider: string }

/** What the panel showed: the approved generation (null when none), the roster file hash and, when given, what the roster path linked to. */
export interface ShownRevision {
  generation: number | null
  fileHash: string
  /** The roster path's link target as shown, or null for a regular file; omitted by callers that do not track it. */
  link?: string | null
  /** The real folder that held the roster as shown (every link on the way followed); omitted or null when not tracked. */
  directory?: string | null
}

/** App destinations `next` records as inspected (`observed-default`) that `previous` did not record that way. */
export function newlyInspected(previous: RosterData | null, next: RosterData): InspectedRoute[] {
  const before = new Map((previous?.harness_routes ?? []).map((route) => [route.harness, route]))
  return next.harness_routes
    .filter((route) => route.basis === 'observed-default' && (before.get(route.harness)?.basis !== route.basis || before.get(route.harness)?.provider !== route.provider))
    .map((route) => ({ harness: route.harness, provider: route.provider }))
}

function judgeInspected(previous: RosterData | null, next: RosterData, seams: ApprovalSeams): void {
  const routes = newlyInspected(previous, next)
  if (routes.length > 0) {
    if (seams.checkInspectedRoutes === undefined) {
      throw new RosterError('ROUTE_CHANGED', `where ${routes.map((route) => route.harness).join(', ')} sends data can be recorded as inspected only by BMN, in Preferences > Rules > Health`)
    }
    seams.checkInspectedRoutes(routes)
  }
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

/** The lock this process holds: its open file description (which carries the OS lock), inode and record. */
let heldLock: { fd: number; inode: number; text: string } | null = null
/** util-linux flock(1), present on every supported Linux (R60-NFR6); tests may point elsewhere. */
const FLOCK_CANDIDATES = ['/usr/bin/flock', '/bin/flock']

/**
 * Refuses a write unless this process still holds the lock on the file at the lock path: the path
 * replaced by another file (a different inode) would let a second holder lock that one.
 */
function assertLockHeld(): void {
  let inode: number | null = null
  try { inode = lstatSync(approvalLockPath()).ino } catch { /* gone */ }
  if (heldLock === null || inode !== heldLock.inode) throw new RosterError('REVISION_CONFLICT', 'the approval lock file was replaced; nothing more was written; reload and try again')
}

/** Takes the OS advisory lock on `fd` without waiting: flock(1) locks the open file description this process keeps. */
function takeAdvisoryLock(fd: number, seams: ApprovalSeams): 'held' | 'busy' {
  const command = seams.flockCommand ?? FLOCK_CANDIDATES.find((candidate) => existsSync(candidate)) ?? 'flock'
  const result = spawnSync(command, ['--nonblock', '--conflict-exit-code', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 10_000 })
  if (result.status === 0) return 'held'
  if (result.status === 75) return 'busy'
  throw new RosterError('REVISION_CONFLICT', `could not take the approval lock (${result.error?.message ?? `flock exited ${result.status ?? result.signal}`}); nothing was written`)
}

/**
 * One approval at a time, across processes (60.2 AC4): `approve.lock` is held with an OS advisory
 * lock on an open file description this process keeps until the approval ends, so a live holder
 * is never broken and a holder that dies releases it with its process. The file stays in place
 * (one inode) and records the holder's pid and start time while held; finding an earlier holder's
 * record on taking the lock means that holder died mid-approval, which is logged as a broken lock.
 * A held lock makes this approval a REVISION_CONFLICT (exit-7 semantics).
 */
function withLock<T>(seams: ApprovalSeams, work: () => T): T {
  const identity = seams.startIdentity ?? linuxStartIdentity
  const now = seams.now ?? (() => new Date())
  ensurePrivateDirectory(stateDirectory())
  const path = approvalLockPath()
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    if (takeAdvisoryLock(fd, seams) === 'busy') throw new RosterError('REVISION_CONFLICT', 'another approval is in progress; reload and try again')
    const earlier = readFileSync(fd, 'utf8')
    if (earlier.trim() !== '') {
      let holder: unknown
      try { holder = JSON.parse(earlier) } catch { holder = { unreadable: true } }
      logHistory({ event: 'lock-broken', holder }, now())
    }
    const mine = JSON.stringify({ pid: process.pid, start: identity(process.pid), nonce: randomBytes(8).toString('hex') })
    ftruncateSync(fd, 0)
    writeSync(fd, mine, 0)
    fsyncSync(fd)
    heldLock = { fd, inode: fstatSync(fd).ino, text: mine }
    try {
      return work()
    } finally {
      heldLock = null
      try { ftruncateSync(fd, 0) } catch { /* the record only names a holder; the OS lock is what counts */ }
    }
  } finally {
    closeSync(fd)
  }
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

function checkShown(shown: ShownRevision, current: Generation | null, fileHash: string, state?: PathState): void {
  const link = state === undefined ? undefined : state.kind === 'link' ? state.target : null
  // The same bytes in another folder are not the file that was shown: a link on the way moved (R60-NFR2).
  const moved = typeof shown.directory === 'string' && state !== undefined && shown.directory !== state.directory
  if ((current?.number ?? null) !== shown.generation || fileHash !== shown.fileHash || (shown.link !== undefined && link !== undefined && shown.link !== link) || moved) {
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
  assertLockHeld()
  writeDurably(generationPath(number), `${JSON.stringify(generation, null, 2)}\n`)
  if (readGeneration(number)?.hash !== generation.hash) throw new RosterError('STATE_CORRUPT', `generation ${number} did not read back`)
  seams.beforePointer?.()
  assertLockHeld()
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
    checkShown(shown, current, file.hash, file.state)
    const data = validData(file.text)
    judgeInspected(current?.data ?? null, data, seams)
    return publish(data, file.hash, current, seams)
  })
}

/** The approved data with the named sections (an agent id or a shared section) taken from the file, in the file's agent order. */
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
    providers: scope.includes('providers') ? file.providers : approved.providers,
    exceptions: scope.includes('exceptions') ? file.exceptions : approved.exceptions,
    harness_routes: scope.includes('harness-routes') ? file.harness_routes : approved.harness_routes
  }
}

/**
 * Approves only the named sections' outside changes (60.5 AC2: one row, one Keep). The file is
 * left as it is; the other sections stay pending. Refused when the approved result would not be a
 * valid roster on its own, for example a role chain naming an agent whose change is still pending.
 */
export function approveSections(shown: ShownRevision, scope: string[], seams: ApprovalSeams = {}): Generation {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    const file = readFileState()
    checkShown(shown, current, file.hash, file.state)
    const fileData = validData(file.text)
    if (current === null) {
      judgeInspected(null, fileData, seams)
      return publish(fileData, file.hash, current, seams)
    }
    const unknown = scope.filter((id) => !SHARED_SECTIONS.includes(id)
      && !fileData.agents.some((agent) => agent.id === id) && !current.data.agents.some((agent) => agent.id === id))
    if (scope.length === 0 || unknown.length > 0) throw new RosterError('INVALID_VALUE', `no section ${unknown.join(', ') || '(none named)'} to approve`)
    const parsed = parseRoster(rewriteRoster(file.text, mergeSections(current.data, fileData, scope)))
    if (parsed.data === null) {
      throw new RosterError('ROSTER_INVALID', 'this change depends on another pending change; approve them together or revert one', { errors: parsed.errors })
    }
    judgeInspected(current.data, parsed.data, seams)
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
    checkShown(shown, current, file.hash, file.state)
    const nextText = rewriteRoster(file.text, data)
    const nextData = validData(nextText)
    judgeInspected(current?.data ?? null, nextData, seams)
    if (nextText !== file.text) {
      keepPriorState(file.state, (seams.now ?? (() => new Date()))())
      assertLockHeld()
      replaceFileSafely(rosterPath(), file.state, nextText)
    }
    seams.beforePublish?.()
    return publish(nextData, sha256(nextText), current, seams)
  })
}

/**
 * Whether `next` keeps every byte `before` holds outside the content of its yaml blocks. The one
 * addition allowed is whole new sections after the end of the file, which change no existing byte.
 */
function keepsBytesOutsideBlocks(before: string, next: string): boolean {
  const kept = outsideYamlBlocks(before)
  const now = outsideYamlBlocks(next)
  const last = kept.length - 1
  if (now.length < kept.length) return false
  return kept.every((piece, index) => (index < last || now.length === kept.length ? now[index] === piece : now[index]?.startsWith(piece) === true))
}

/**
 * "Revert file to approved": the approved machine data goes back into the affected yaml blocks;
 * every byte outside them is unchanged (60.2 AC6). `scope` limits it to the given sections.
 * A revert that could only be done by removing or inserting text elsewhere (a section the file
 * added, a repeated or block-less section) is refused and nothing is written. No generation is
 * written.
 */
export function revertFileToApproved(shown: ShownRevision, scope: string[] | null = null, seams: ApprovalSeams = {}): { changed: boolean } {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    if (current === null) throw new RosterError('NOT_APPROVED', 'nothing is approved yet, so there is nothing to revert to')
    const file = readFileState()
    checkShown(shown, current, file.hash, file.state)
    // By heading, not by parsed data: a section that does not validate is still the owner's text.
    const added = [...new Set(splitSections(file.text).map((section) => section.heading))].filter((id) => ID_PATTERN.test(id)
      && !RESERVED_SECTIONS.includes(id) && !current.data.agents.some((entry) => entry.id === id) && (scope === null || scope.includes(id)))
    if (added.length > 0) {
      throw new RosterError('INVALID_VALUE', `${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} new in the file; reverting would delete ${added.length === 1 ? 'its section and prose' : 'their sections and prose'}. Remove ${added.length === 1 ? 'it' : 'them'} in the file, or approve.`)
    }
    const nextText = rewriteRoster(file.text, current.data, { scope })
    if (nextText === file.text) return { changed: false }
    if (!keepsBytesOutsideBlocks(file.text, nextText)) {
      throw new RosterError('INVALID_VALUE', 'reverting would remove or insert text outside the yaml blocks (a repeated section, or one without its yaml block); fix that in the file, or approve')
    }
    // A whole revert must leave a valid file; a scoped one must not break a file that was valid
    // (reverting only the providers while an agent on a new provider stays unapproved).
    if (scope === null) validData(nextText)
    else if (parseRoster(file.text).data !== null && parseRoster(nextText).data === null) {
      throw new RosterError('INVALID_VALUE', 'reverting only this would leave the team file invalid, because another unapproved change depends on it; keep or revert that change first')
    }
    keepPriorState(file.state, (seams.now ?? (() => new Date()))())
    assertLockHeld()
    replaceFileSafely(rosterPath(), file.state, nextText)
    return { changed: true }
  })
}

/** "Restore…": an earlier version's data becomes a new generation (60.2 AC6); one approved under an earlier schema cannot be restored (AC7). */
export function restoreGeneration(shown: ShownRevision, number: number, seams: ApprovalSeams = {}): Generation {
  return withLock(seams, () => {
    seams.afterLock?.()
    const current = currentGeneration()
    const file = readFileState()
    checkShown(shown, current, file.hash, file.state)
    const problem = restoreProblem(number)
    const earlier = problem === null ? readGeneration(number) : null
    if (earlier === null) throw new RosterError(problem?.includes('earlier roster layout') ? 'INVALID_VALUE' : 'STATE_CORRUPT', problem ?? `version ${number} is missing or does not verify`)
    judgeInspected(current?.data ?? null, earlier.data, seams)
    return publish(earlier.data, earlier.roster_file_hash, current, seams, 'restore', number)
  })
}

export function agentsStateRoot(): string {
  return agentsDirectory()
}
