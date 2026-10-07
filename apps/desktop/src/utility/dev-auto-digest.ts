import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { DevAutoRunsResult, TelegramMorningDigest } from '@bmn/protocol'
import { phoneField } from './quiet-hours-delivery'
import { TELEGRAM_TEXT_LIMIT } from './telegram-cards'
import { telegramSendDefinitelyUnsent } from './telegram-delivery'

export const DIGEST_KEY = 'dev-auto-morning-digest-v1'
const MAX_RUNS = 32 * 64
const MAX_DECISIONS = 20
const READ_INTERVAL = 10 * 60_000
const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex')
interface RunFingerprint { path: string; status: string; finished: boolean; decisions: string[] }
interface DigestState { version: 1; day: string | null; runs: RunFingerprint[] }
export interface DigestSnapshot { result: DevAutoRunsResult; workspaceNames: Record<string, string> }
export interface DigestDependencies {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
  settings(): TelegramMorningDigest
  ready(): boolean
  quiet(): boolean
  now(): Date
  monotonic(): number
  home: string
  snapshot(): Promise<DigestSnapshot>
  send(text: string): Promise<void>
}
const emptyState = (): DigestState => ({ version: 1, day: null, runs: [] })
function localDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
function loadState(value: unknown): DigestState {
  if (value === undefined || value === null) return emptyState()
  const state = value as DigestState
  const hash = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (state.version !== 1 || ![null, 'string'].includes(state.day === null ? null : typeof state.day) ||
    state.day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(state.day) ||
    !Array.isArray(state.runs) || state.runs.length > MAX_RUNS ||
    Object.keys(state).some(key => !['version', 'day', 'runs'].includes(key)) ||
    !state.runs.every(run => run && Object.keys(run).every(key => ['path', 'status', 'finished', 'decisions'].includes(key)) &&
      hash(run.path) && hash(run.status) && typeof run.finished === 'boolean' && Array.isArray(run.decisions) &&
      run.decisions.length <= MAX_DECISIONS && run.decisions.every(hash))) throw new Error('Morning digest history is unavailable')
  return state
}

/** Reads parsed fields only. Every label is masked before its final phone-length bound. */
export function buildMorningDigest(snapshot: DigestSnapshot, previous: readonly RunFingerprint[], home: string): { text: string; runs: RunFingerprint[] } {
  const before = new Map(previous.map(run => [run.path, run]))
  const sections: Array<{ heading: string; lines: string[] }> = ['Done', 'Decided for you', 'Waiting on you', 'Blocked'].map(heading => ({ heading, lines: [] }))
  const runs: RunFingerprint[] = []
  const field = (text: string): string => phoneField(text, home, 220)
  let incomplete = snapshot.result.skipped
  const candidates = snapshot.result.runs.filter(run => run.ownership !== 'copy')
  incomplete += Math.max(0, candidates.length - MAX_RUNS)
  for (const run of candidates.slice(0, MAX_RUNS)) {
    const path = fingerprint(run.checkout)
    const old = before.get(path)
    if (run.unavailable) { incomplete++; if (old) runs.push(old); continue }
    if (!run.project || !run.status || run.truncatedFields) incomplete++
    const status = run.status ?? ''
    const current = { path, status: fingerprint(status), finished: run.finished, decisions: run.decisions.slice(0, MAX_DECISIONS).map(fingerprint) }
    runs.push(current)
    const workspace = run.workspaceIds.map(id => field(snapshot.workspaceNames[id] ?? 'Workspace unavailable')).join(', ')
    const label = `${workspace} · ${field(run.branch ?? basename(run.checkout))} · ${field(run.project ?? 'Epics not recorded')}`
    if (run.finished && !old?.finished) sections[0]!.lines.push(label)
    for (let index = 0; index < Math.min(run.decisions.length, MAX_DECISIONS); index++) {
      if (!old?.decisions.includes(current.decisions[index]!)) sections[1]!.lines.push(`${label}: ${field(run.decisions[index]!)}`)
    }
    if (/^PAUSED\b/i.test(status)) sections[2]!.lines.push(`${label}: ${field(status)}`)
    for (const item of run.ownerItems) sections[2]!.lines.push(`${label}: ${field(item.title)}`)
    if (/^BLOCKED\b/i.test(status)) sections[3]!.lines.push(`${label}: ${field(status)}`)
  }
  // Incomplete discovery is not evidence that a previously seen run disappeared.
  // Keep its last fingerprints within the same bound so recovery does not invent changes.
  if (incomplete) {
    const retained = new Set(runs.map(run => run.path))
    for (const old of previous) {
      if (runs.length >= MAX_RUNS) break
      if (!retained.has(old.path)) { runs.push(old); retained.add(old.path) }
    }
  }
  const lines: string[] = []
  const allCount = sections.reduce((count, section) => count + section.lines.length, 0)
  let shown = 0
  for (const section of sections) {
    if (!section.lines.length) continue
    const heading = section.heading
    let headingShown = false
    for (const line of section.lines) {
      const next = [...lines, ...(headingShown ? [] : [heading]), line]
      if (next.join('\n').length > TELEGRAM_TEXT_LIMIT - 160) continue
      if (!headingShown) { lines.push(heading); headingShown = true }
      lines.push(line); shown++
    }
  }
  if (allCount > shown) lines.push(`${allCount - shown} more on the laptop.`)
  if (incomplete) lines.push(`Incomplete: ${incomplete} missing, unreadable or truncated sources/items. Check the laptop.`)
  return { text: lines.length ? lines.join('\n') : 'No dev-auto changes.', runs }
}

/** One daily durable claim. No agent, request, handoff or terminal mutation capabilities. */
export class DevAutoMorningDigest {
  private active: Promise<void> | undefined
  private lastRead: number | undefined
  constructor(private readonly deps: DigestDependencies) {}
  sweep(): Promise<void> {
    if (this.active) return this.active
    this.active = this.run().finally(() => { this.active = undefined })
    return this.active
  }
  private eligible(day: string): boolean {
    const settings = this.deps.settings(), now = this.deps.now()
    const minutes = now.getHours() * 60 + now.getMinutes()
    const [hour, minute] = settings.time.split(':').map(Number)
    return settings.enabled && this.deps.ready() && !this.deps.quiet() && localDay(now) === day && minutes >= hour! * 60 + minute!
  }
  private async run(): Promise<void> {
    const day = localDay(this.deps.now())
    if (!this.eligible(day)) return
    const previous = loadState(await this.deps.read())
    if (previous.day !== null && previous.day >= day) return
    if (this.lastRead !== undefined && this.deps.monotonic() - this.lastRead < READ_INTERVAL) return
    this.lastRead = this.deps.monotonic()
    const snapshot = await this.deps.snapshot()
    if (!this.eligible(day)) return
    const digest = buildMorningDigest(snapshot, previous.runs, this.deps.home)
    await this.deps.write({ version: 1, day, runs: digest.runs } satisfies DigestState)
    if (!this.eligible(day)) { await this.deps.write(previous); return }
    try { await this.deps.send(digest.text) }
    catch (error) {
      if (telegramSendDefinitelyUnsent(error)) await this.deps.write(previous)
      // A lost response may already have delivered; the durable day claim remains consumed.
    }
  }
}
