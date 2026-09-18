import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  type SavedOutputFinalCaptureUnavailable,
  type SavedOutputProcessState,
  type SavedOutputSnapshot,
  type SavedOutputUnreadableEntry
} from '@bmn/protocol'
import type { SavedOutputStore, SessionIdentity } from './session-manager'

const RETENTION_FILE = '_retention.json'
const LEGACY_VIEW_EPOCH = 'legacy'

interface StoredFinalCaptureUnavailable extends SavedOutputFinalCaptureUnavailable {
  recordType: 'final-capture-unavailable'
}

interface ScannedCapture {
  path: string
  snapshot: SavedOutputSnapshot
}

interface ScannedFailure {
  path: string
  record: StoredFinalCaptureUnavailable
}

interface ScanResult {
  captures: ScannedCapture[]
  failures: ScannedFailure[]
  unreadable: SavedOutputUnreadableEntry[]
  pruned: number
}

function encoded(value: string): string {
  return encodeURIComponent(value)
}

function snapshotFileName(identity: SessionIdentity & { viewEpoch: string }): string {
  return `${encoded(identity.sessionId)}--${encoded(identity.incarnationId)}--${encoded(identity.viewEpoch)}.snapshot.json`
}

function failureFileName(identity: SessionIdentity & { viewEpoch: string }): string {
  return `${encoded(identity.sessionId)}--${encoded(identity.incarnationId)}--${encoded(identity.viewEpoch)}.loss.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isProcessState(value: unknown): value is SavedOutputProcessState {
  return value === 'live' || value === 'exited' || value === 'interrupted'
}

function commonSnapshotFields(value: Record<string, unknown>): boolean {
  return (
    isText(value.sessionId) &&
    isText(value.incarnationId) &&
    isDate(value.capturedAt) &&
    isDate(value.captureStartedAt) &&
    typeof value.content === 'string' &&
    isCount(value.retainedLines) &&
    isCount(value.lineLimit) &&
    isCount(value.snapshotLimitBytes) &&
    isProcessState(value.processState)
  )
}

function currentSnapshotMeasurements(value: Record<string, unknown>): boolean {
  return (
    typeof value.snapshotTruncated === 'boolean' &&
    isCount(value.snapshotDroppedLines) &&
    (value.snapshotDroppedBytes === null || isCount(value.snapshotDroppedBytes)) &&
    isCount(value.transportDroppedBytes)
  )
}

function legacyRoundOneMeasurements(value: Record<string, unknown>): boolean {
  return (
    isCount(value.limitBytes) &&
    isCount(value.retainedBytes) &&
    isCount(value.droppedBytes) &&
    typeof value.truncated === 'boolean'
  )
}

function parseSnapshot(value: unknown):
  | { kind: 'capture'; snapshot: SavedOutputSnapshot }
  | { kind: 'unsupported' }
  | { kind: 'invalid' } {
  if (!isRecord(value)) return { kind: 'invalid' }
  if (value.formatVersion !== undefined && value.formatVersion !== SAVED_OUTPUT_FORMAT_VERSION) {
    return { kind: 'unsupported' }
  }
  if (!commonSnapshotFields(value)) return { kind: 'invalid' }
  if (value.formatVersion === SAVED_OUTPUT_FORMAT_VERSION) {
    if (!isText(value.viewEpoch) || !currentSnapshotMeasurements(value)) return { kind: 'invalid' }
    return { kind: 'capture', snapshot: value as unknown as SavedOutputSnapshot }
  }
  if (currentSnapshotMeasurements(value)) {
    return {
      kind: 'capture',
      snapshot: {
        ...(value as unknown as Omit<SavedOutputSnapshot, 'formatVersion' | 'viewEpoch'>),
        formatVersion: 1,
        viewEpoch: LEGACY_VIEW_EPOCH
      }
    }
  }
  if (!legacyRoundOneMeasurements(value)) return { kind: 'invalid' }
  return {
    kind: 'capture',
    snapshot: {
      formatVersion: 1,
      sessionId: value.sessionId as string,
      incarnationId: value.incarnationId as string,
      viewEpoch: LEGACY_VIEW_EPOCH,
      capturedAt: value.capturedAt as string,
      captureStartedAt: value.captureStartedAt as string,
      content: value.content as string,
      retainedLines: value.retainedLines as number,
      lineLimit: value.lineLimit as number,
      snapshotLimitBytes: value.snapshotLimitBytes as number,
      snapshotTruncated: null,
      snapshotDroppedLines: null,
      snapshotDroppedBytes: null,
      transportDroppedBytes: null,
      processState: value.processState as SavedOutputProcessState
    }
  }
}

function parseFailure(value: unknown):
  | { kind: 'failure'; record: StoredFinalCaptureUnavailable }
  | { kind: 'unsupported' }
  | { kind: 'invalid' } {
  if (!isRecord(value) || value.recordType !== 'final-capture-unavailable') {
    return { kind: 'invalid' }
  }
  if (value.formatVersion !== SAVED_OUTPUT_FORMAT_VERSION) {
    return value.formatVersion === undefined ? { kind: 'invalid' } : { kind: 'unsupported' }
  }
  const validReason =
    value.reason === 'no-renderer' ||
    value.reason === 'renderer-destroyed' ||
    value.reason === 'not-acknowledged-in-time' ||
    value.reason === 'capture-persist-failure'
  if (
    !isText(value.sessionId) ||
    !isText(value.incarnationId) ||
    !isText(value.viewEpoch) ||
    !isDate(value.unavailableAt) ||
    !validReason ||
    !isText(value.detail) ||
    (value.lastCaptureAt !== null && !isDate(value.lastCaptureAt)) ||
    !isProcessState(value.processState)
  ) {
    return { kind: 'invalid' }
  }
  return { kind: 'failure', record: value as unknown as StoredFinalCaptureUnavailable }
}

function identityFrom(value: unknown, name: string): Partial<SessionIdentity & { viewEpoch: string }> {
  if (isRecord(value)) {
    const identity = {
      ...(isText(value.sessionId) ? { sessionId: value.sessionId } : {}),
      ...(isText(value.incarnationId) ? { incarnationId: value.incarnationId } : {}),
      ...(isText(value.viewEpoch) ? { viewEpoch: value.viewEpoch } : {})
    }
    if (Object.keys(identity).length > 0) return identity
  }
  const raw = name
    .replace(/\.snapshot\.json$/, '')
    .replace(/\.loss\.json$/, '')
    .replace(/\.json$/, '')
  const parts = raw.split('--')
  try {
    return {
      ...(parts[0] ? { sessionId: decodeURIComponent(parts[0]) } : {}),
      ...(parts[1] ? { incarnationId: decodeURIComponent(parts[1]) } : {}),
      ...(parts[2] ? { viewEpoch: decodeURIComponent(parts[2]) } : {})
    }
  } catch {
    return {}
  }
}

function unreadableEntry(
  source: string,
  reason: SavedOutputUnreadableEntry['reason'],
  value?: unknown
): SavedOutputUnreadableEntry {
  return { source, reason, ...identityFrom(value, source) }
}

function publicFailure(
  record: StoredFinalCaptureUnavailable
): SavedOutputFinalCaptureUnavailable {
  return {
    formatVersion: record.formatVersion,
    sessionId: record.sessionId,
    incarnationId: record.incarnationId,
    viewEpoch: record.viewEpoch,
    unavailableAt: record.unavailableAt,
    reason: record.reason,
    detail: record.detail,
    lastCaptureAt: record.lastCaptureAt,
    processState: record.processState
  }
}

export class FileSavedOutputStore implements SavedOutputStore {
  constructor(
    private readonly directory: string,
    private readonly removeFile: (path: string) => Promise<void> = unlink
  ) {}

  async save(snapshot: SavedOutputSnapshot): Promise<void> {
    await this.atomicWrite(snapshotFileName(snapshot), snapshot)
    await this.prune()
  }

  async load(
    identity: SessionIdentity,
    viewEpoch?: string
  ): Promise<SavedOutputSnapshot | undefined> {
    const { snapshots } = await this.loadCatalog()
    return snapshots.find(
      (snapshot) =>
        snapshot.sessionId === identity.sessionId &&
        snapshot.incarnationId === identity.incarnationId &&
        (viewEpoch === undefined || snapshot.viewEpoch === viewEpoch)
    )
  }

  async loadCatalog(): Promise<{
    snapshots: SavedOutputSnapshot[]
    finalCaptureUnavailable: SavedOutputFinalCaptureUnavailable[]
    unreadable: SavedOutputUnreadableEntry[]
    pruned: number
  }> {
    const scanned = await this.scan()
    return {
      snapshots: scanned.captures
        .map(({ snapshot }) => snapshot)
        .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt)),
      finalCaptureUnavailable: scanned.failures
        .map(({ record }) => publicFailure(record))
        .sort((left, right) => Date.parse(right.unavailableAt) - Date.parse(left.unavailableAt)),
      unreadable: scanned.unreadable,
      pruned: scanned.pruned
    }
  }

  async recordFinalCaptureUnavailable(
    input: Omit<SavedOutputFinalCaptureUnavailable, 'formatVersion' | 'lastCaptureAt'>
  ): Promise<SavedOutputFinalCaptureUnavailable> {
    const latest = await this.load(input)
    const record: StoredFinalCaptureUnavailable = {
      ...input,
      formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
      recordType: 'final-capture-unavailable',
      lastCaptureAt: latest?.capturedAt ?? null
    }
    await this.atomicWrite(failureFileName(record), record)
    await this.prune()
    return publicFailure(record)
  }

  async markProcessState(
    identity: SessionIdentity,
    processState: Exclude<SavedOutputProcessState, 'live'>
  ): Promise<void> {
    const scanned = await this.scan()
    const writes: Promise<void>[] = []
    for (const capture of scanned.captures) {
      if (
        capture.snapshot.sessionId === identity.sessionId &&
        capture.snapshot.incarnationId === identity.incarnationId
      ) {
        writes.push(this.atomicWrite(basename(capture.path), {
          ...capture.snapshot,
          formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
          processState
        }))
      }
    }
    for (const failure of scanned.failures) {
      if (
        failure.record.sessionId === identity.sessionId &&
        failure.record.incarnationId === identity.incarnationId
      ) {
        writes.push(this.atomicWrite(basename(failure.path), { ...failure.record, processState }))
      }
    }
    await Promise.all(writes)
  }

  /** Removes every saved-output file of the given sessions, readable or not; used when sessions are deleted. */
  async removeSessions(sessionIds: readonly string[]): Promise<number> {
    if (sessionIds.length === 0) return 0
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    const prefixes = sessionIds.map((sessionId) => `${encoded(sessionId)}--`)
    const owned = names.filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    await Promise.all(owned.map(async (name) => {
      try {
        await this.removeFile(join(this.directory, name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }))
    return owned.length
  }

  private async atomicWrite(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const destination = join(this.directory, name)
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, destination)
  }

  private async scan(): Promise<ScanResult> {
    let names: string[]
    try {
      names = (await readdir(this.directory)).filter((name) => name.endsWith('.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { captures: [], failures: [], unreadable: [], pruned: 0 }
      }
      throw error
    }
    const captures: ScannedCapture[] = []
    const failures: ScannedFailure[] = []
    const unreadable: SavedOutputUnreadableEntry[] = []
    let pruned = 0
    for (const name of names.sort()) {
      const path = join(this.directory, name)
      let value: unknown
      try {
        value = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        unreadable.push(unreadableEntry(name, 'invalid'))
        continue
      }
      if (name === RETENTION_FILE) {
        if (isRecord(value) && isCount(value.pruned)) pruned = value.pruned
        else unreadable.push(unreadableEntry(name, 'invalid', value))
        continue
      }
      if (isRecord(value) && value.recordType === 'final-capture-unavailable') {
        const parsed = parseFailure(value)
        const namedIdentity = identityFrom(undefined, name)
        if (
          parsed.kind === 'failure' &&
          namedIdentity.sessionId === parsed.record.sessionId &&
          namedIdentity.incarnationId === parsed.record.incarnationId &&
          namedIdentity.viewEpoch === parsed.record.viewEpoch
        ) failures.push({ path, record: parsed.record })
        else if (parsed.kind === 'failure') unreadable.push(unreadableEntry(name, 'invalid', value))
        else unreadable.push(unreadableEntry(name, parsed.kind === 'unsupported' ? 'unsupported-format' : 'invalid', value))
        continue
      }
      const parsed = parseSnapshot(value)
      const namedIdentity = identityFrom(undefined, name)
      const namedViewMatches = parsed.kind === 'capture' && (
        namedIdentity.viewEpoch === undefined ||
        namedIdentity.viewEpoch === parsed.snapshot.viewEpoch
      )
      if (
        parsed.kind === 'capture' &&
        namedIdentity.sessionId === parsed.snapshot.sessionId &&
        namedIdentity.incarnationId === parsed.snapshot.incarnationId &&
        namedViewMatches
      ) captures.push({ path, snapshot: parsed.snapshot })
      else if (parsed.kind === 'capture') unreadable.push(unreadableEntry(name, 'invalid', value))
      else unreadable.push(unreadableEntry(name, parsed.kind === 'unsupported' ? 'unsupported-format' : 'invalid', value))
    }
    return { captures, failures, unreadable, pruned }
  }

  private async prune(): Promise<void> {
    const scanned = await this.scan()
    const records = [
      ...scanned.captures.map(({ path, snapshot }) => ({ path, at: snapshot.capturedAt })),
      ...scanned.failures.map(({ path, record }) => ({ path, at: record.unavailableAt }))
    ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    const excess = records.length - TERMINAL_SAVED_OUTPUT_RETENTION
    if (excess <= 0) return
    await Promise.all(records.slice(0, excess).map(async ({ path }) => {
      try {
        await this.removeFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }))
    await this.atomicWrite(RETENTION_FILE, {
      formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
      pruned: scanned.pruned + excess
    })
  }
}
