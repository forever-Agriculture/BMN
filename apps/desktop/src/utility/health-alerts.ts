// MODULE: health-alerts.ts - the health watch: when a reading is told to the owner's phone, repeated, cleared, and when the watch switches itself off
import { HEALTH_LIMITS, type TelegramHealthAlerts } from '@bmn/protocol'
import { HEALTH_PROBLEM_KINDS, batteryWatched, judgeMachineHealth, type HealthProblemKind, type HealthReadings } from './machine-health'
import { TELEGRAM_TEXT_LIMIT, escapeHtml } from './telegram-cards'
import { telegramSendDefinitelyUnsent } from './telegram-delivery'

export const HEALTH_ALERTS_KEY = 'health-alerts-v1'
const CHECK_INTERVAL_MS = HEALTH_LIMITS.checkEverySeconds * 1000
const REPEAT_MS = HEALTH_LIMITS.repeatMinutes * 60_000
const HOST_CHARS = 64

/** Kinds, times and counts only: the stored state never holds a reading, a host name or message text. */
interface HealthAlertState {
  version: 1
  /** The problem set of the last message that went out; empty after an all-clear. */
  sent: HealthProblemKind[]
  sentAt: string | null
  cpuHotStreak: number
  /**
   * Whether the machine had a battery when the watch was switched on: null until a reading could tell,
   * then true or false for as long as this watch stays on.
   */
  batteryAtStart: boolean | null
  /** The switch-off time this deadline was worked out for, and the moment it falls on. */
  offAt: string | null
  offDeadline: string | null
  /** The watch switched itself off and "Health alerts are off" has not gone out yet. */
  offNoticeOwed?: true
  /**
   * `sent` was written before its message went out and no answer confirmed it since: the send was cut
   * short, or its answer was lost. It reads as sent, and is said again at the 10-minute repeat.
   */
  unconfirmed?: true
}

export interface HealthAlertDependencies {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
  settings(): TelegramHealthAlerts
  /** Telegram is connected and polling. */
  ready(): boolean
  now(): Date
  monotonic(): number
  host(): string
  check(): Promise<HealthReadings>
  send(html: string): Promise<void>
  /** Saves the watch as off with no switch-off time and `state` as its stored state, in one step. */
  turnOff(state: unknown): Promise<void>
}

const emptyState = (): HealthAlertState =>
  ({ version: 1, sent: [], sentAt: null, cpuHotStreak: 0, batteryAtStart: null, offAt: null, offDeadline: null })

const STATE_KEYS = ['version', 'sent', 'sentAt', 'cpuHotStreak', 'batteryAtStart', 'offAt', 'offDeadline', 'offNoticeOwed', 'unconfirmed']
const OFF_NOTICE = '<b>Health alerts are off</b>\n<i>The switch-off time you set has come.</i>'
const instant = (value: unknown): boolean => value === null || typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))

/** An unreadable state starts over: a repeated alert is safer than a watch that stops. */
function loadState(value: unknown): HealthAlertState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState()
  const state = value as HealthAlertState
  const valid = state.version === 1 && Object.keys(state).every(key => STATE_KEYS.includes(key)) &&
    Array.isArray(state.sent) && state.sent.length <= HEALTH_PROBLEM_KINDS.length &&
    state.sent.every(kind => HEALTH_PROBLEM_KINDS.includes(kind)) &&
    instant(state.sentAt) && instant(state.offDeadline) &&
    Number.isSafeInteger(state.cpuHotStreak) && state.cpuHotStreak >= 0 &&
    (state.batteryAtStart === null || typeof state.batteryAtStart === 'boolean') &&
    (state.offNoticeOwed === undefined || state.offNoticeOwed === true) &&
    (state.unconfirmed === undefined || state.unconfirmed === true) &&
    (state.offAt === null || typeof state.offAt === 'string' && /^\d{2}:\d{2}$/.test(state.offAt))
  return valid ? { ...state, sent: [...state.sent] } : emptyState()
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every(kind => right.includes(kind))

/** The next moment the local clock shows `time`; a time already past today means tomorrow. */
export function nextLocalTime(now: Date, time: string): Date {
  const [hour, minute] = time.split(':').map(Number)
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

const degrees = (value: number | null): string => value === null ? 'not measured' : `${value} °C`
/** A problem that stands on a reading BMN can no longer take says so instead of a number. */
const hot = (what: string, value: number | null): string =>
  value === null ? `${what} was too hot and can no longer be read` : `${what} at ${value} °C`
const volts = (millivolts: number): string => `${(millivolts / 1000).toFixed(1)} V`

function problemLines(kind: HealthProblemKind, readings: HealthReadings, cpuHotStreak: number): [string, string] {
  switch (kind) {
    case 'cpu-unreadable': return ['CPU temperature cannot be read', 'The watch is blind to heat; check the machine.']
    case 'cpu-critical': return [`CPU at ${degrees(readings.cpuC)}, at its limit`, 'Stop the job or suspend the machine now.']
    case 'cpu-hot': return [`CPU at ${degrees(readings.cpuC)} for ${cpuHotStreak} checks in a row`, 'Stop the heavy job; check the vents are clear.']
    case 'nvidia-gpu-hot': return [hot('NVIDIA GPU', readings.nvidiaGpuC), 'Stop the GPU job.']
    case 'integrated-gpu-hot': return [hot('Integrated GPU', readings.integratedGpuC), 'Stop the heavy job.']
    case 'drive-hot': return [hot('Drive', readings.driveC), 'Stop the disk-heavy job.']
    case 'battery-gone': return ['Battery no longer detected', 'Have someone look at the machine.']
    case 'battery-voltage': return [
      readings.battery?.millivolts == null || readings.battery.cells === null
        ? 'Battery voltage was out of range and can no longer be read'
        : `Battery voltage ${volts(readings.battery.millivolts)}, out of range`,
      'Suspend the machine and have someone unplug it.'
    ]
    case 'mains-offline': return [
      readings.mainsOnline === null
        ? 'Mains power was lost and can no longer be read'
        : `Mains power lost${readings.battery?.percent == null ? '' : `, on battery at ${readings.battery.percent}%`}`,
      'A power cut or a charger fault; the battery will run out.'
    ]
  }
}

export type HealthMessageKind = 'alert' | 'clear' | 'test'

/**
 * Readings, the host name and fixed words only. Every reading is shown, a missing one as "not measured".
 * `batteryUnknown` marks a test made while no reading could tell whether the machine has a battery.
 */
export function buildHealthMessage(
  kind: HealthMessageKind,
  readings: HealthReadings,
  problems: readonly HealthProblemKind[],
  cpuHotStreak: number,
  now: Date,
  host: string,
  batteryUnknown = false
): string {
  const title = kind === 'alert' ? 'Health alert' : kind === 'clear' ? 'Back to normal' : 'Health alerts: test'
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const lines = [`<b>${title}</b>`, `<i>${time} · ${escapeHtml(host.replace(/\p{Cc}/gu, '').slice(0, HOST_CHARS) || 'this machine')}</i>`]
  if (kind === 'test') {
    lines.push(problems.length > 0 ? 'A real check would alert now.'
      : batteryUnknown ? 'A real check would find nothing wrong in what it can read.' : 'A real check would find nothing wrong.')
    if (batteryUnknown) lines.push('Battery and mains are not checked yet: whether this machine has a battery could not be read.')
  }
  for (const problem of problems) {
    const [what, advice] = problemLines(problem, readings, cpuHotStreak)
    lines.push('', `• ${escapeHtml(what)}`, `   <i>${escapeHtml(advice)}</i>`)
  }
  const battery = readings.battery
  const rows: Array<[string, string]> = [
    ['CPU', degrees(readings.cpuC)],
    ['NVIDIA GPU', readings.nvidiaGpuAsleep === true ? 'asleep' : degrees(readings.nvidiaGpuC)],
    ['Integrated GPU', degrees(readings.integratedGpuC)],
    ['Drive', degrees(readings.driveC)],
    ['Battery', battery === null ? 'none' : battery.present === null ? 'not measured' : !battery.present ? 'not detected'
      : `${battery.percent === null ? 'not measured' : `${battery.percent}%`}${battery.status ? ` ${battery.status}` : ''}`],
    ['Voltage', battery?.millivolts == null ? 'not measured' : volts(battery.millivolts)],
    ['Mains', readings.mainsOnline === null ? 'not measured' : readings.mainsOnline ? 'on' : 'OFF']
  ]
  lines.push('', `<pre>${rows.map(([label, value]) => `${label.padEnd(15)}${escapeHtml(value)}`).join('\n')}</pre>`)
  // Every part is fixed words or a bounded reading, so this holds; the cut is only a last guard.
  return lines.join('\n').slice(0, TELEGRAM_TEXT_LIMIT)
}

/** Reads and reports only. It never suspends, stops or changes anything because of a reading. */
export class HealthAlerts {
  private active: Promise<void> | undefined
  private lastCheck: number | undefined
  private tail: Promise<void> = Promise.resolve()
  /** Whether "Health alerts are off" is still owed; unknown until the stored state was read once. */
  private offNoticeOwed: boolean | undefined

  constructor(private readonly deps: HealthAlertDependencies) {}

  /** A sweep that meets a running one returns it: checks never queue. */
  sweep(): Promise<void> {
    if (this.active) return this.active
    this.active = this.exclusive(() => this.run()).finally(() => { this.active = undefined })
    return this.active
  }

  /** A check and a settings change both read and rewrite the stored state, so they take turns. */
  private exclusive(work: () => Promise<void>): Promise<void> {
    const turn = this.tail.then(work)
    this.tail = turn.catch(() => undefined)
    return turn
  }

  /**
   * Called when the settings were saved or loaded. Off forgets everything but an owed "Health alerts are
   * off", so the next switch-on starts fresh. A new switch-off time is turned into its moment against
   * `savedAt`, when the owner chose it, so "already past" is not judged by how long a running check made
   * the save wait; the same time read again after a restart keeps its moment.
   */
  configure(savedAt: Date = this.deps.now()): Promise<void> {
    return this.exclusive(() => this.applySettings(savedAt))
  }

  private async applySettings(savedAt: Date): Promise<void> {
    const settings = this.deps.settings()
    const state = loadState(await this.deps.read())
    if (!settings.enabled) {
      this.lastCheck = undefined
      this.offNoticeOwed = state.offNoticeOwed === true
      const kept: HealthAlertState = this.offNoticeOwed ? { ...emptyState(), offNoticeOwed: true } : emptyState()
      if (JSON.stringify(state) !== JSON.stringify(kept)) await this.deps.write(kept)
      return
    }
    // Switched on again: a notice that the watch is off would no longer be true.
    this.offNoticeOwed = false
    const { offNoticeOwed: owed, ...current } = state
    const sameTime = settings.offAt === state.offAt && (settings.offAt === null) === (state.offDeadline === null)
    if (owed === undefined && sameTime) return
    await this.deps.write({
      ...current,
      offAt: settings.offAt,
      offDeadline: sameTime ? state.offDeadline : settings.offAt === null ? null : nextLocalTime(savedAt, settings.offAt).toISOString()
    } satisfies HealthAlertState)
  }

  /**
   * "Health alerts are off" goes out once after the watch switched itself off. It waits for Telegram:
   * a watch that went off unseen would be taken for one still watching. A send that definitely failed
   * is tried again at the next sweep; one that may have arrived is not repeated.
   */
  private async sendOffNotice(): Promise<void> {
    this.offNoticeOwed ??= loadState(await this.deps.read()).offNoticeOwed === true
    if (!this.offNoticeOwed || !this.deps.ready()) return
    try {
      await this.deps.send(OFF_NOTICE)
    } catch (error) {
      if (telegramSendDefinitelyUnsent(error)) return
    }
    this.offNoticeOwed = false
    // The owner may have switched the watch on while the notice went out; its new state stays.
    if (!this.deps.settings().enabled) await this.deps.write(emptyState())
  }

  /** The current readings marked as a test; no stored state changes. */
  async sendTest(): Promise<void> {
    const readings = await this.deps.check()
    const state = this.deps.settings().enabled ? loadState(await this.deps.read()) : emptyState()
    // The watch's own rule, with nothing stored: a watch that is on answers as its next check would.
    const watched = batteryWatched(state.batteryAtStart, readings.battery)
    const judged = judgeMachineHealth(readings, state.cpuHotStreak, watched === true, state.sent)
    await this.deps.send(buildHealthMessage('test', readings, judged.problems, judged.cpuHotStreak, this.deps.now(), this.deps.host(), watched === null))
  }

  private async run(): Promise<void> {
    if (!this.deps.settings().enabled) return this.sendOffNotice()
    const now = this.deps.now()
    const state = loadState(await this.deps.read())
    if (state.offDeadline !== null && now.getTime() >= Date.parse(state.offDeadline)) {
      // The saved switch and the owed notice change together: after a crash here the watch is either
      // still on, and switches off at the next start, or off with its notice owed.
      await this.deps.turnOff({ ...emptyState(), offNoticeOwed: true } satisfies HealthAlertState)
      this.lastCheck = undefined
      this.offNoticeOwed = true
      return this.sendOffNotice()
    }
    // Nothing can be told while Telegram is away, and what is owed stays owed in the stored state.
    if (!this.deps.ready()) return
    if (this.lastCheck !== undefined && this.deps.monotonic() - this.lastCheck < CHECK_INTERVAL_MS) return
    this.lastCheck = this.deps.monotonic()
    const readings = await this.deps.check()
    // Decided by the first reading that can tell and kept while this watch is on; it is stored below
    // also when no message goes out.
    const batteryAtStart = batteryWatched(state.batteryAtStart, readings.battery)
    const judged = judgeMachineHealth(readings, state.cpuHotStreak, batteryAtStart === true, state.sent)
    const unsent: HealthAlertState = { ...state, cpuHotStreak: judged.cpuHotStreak, batteryAtStart }
    const changed = !sameSet(judged.problems, state.sent)
    const repeatDue = state.sentAt === null || now.getTime() - Date.parse(state.sentAt) >= REPEAT_MS
    // An all-clear nobody confirmed is owed again at the repeat, like an alert.
    const kind: HealthMessageKind | null = judged.problems.length > 0
      ? (changed || repeatDue ? 'alert' : null)
      : (state.sent.length > 0 || (state.unconfirmed === true && repeatDue) ? 'clear' : null)
    let next = unsent
    let stored = state
    if (kind !== null && this.deps.ready() && this.deps.settings().enabled) {
      // Recorded first, as not yet confirmed: after a crash between the record and the send's answer a
      // restart does not say it again at once, and says it again at the repeat.
      const ahead: HealthAlertState = { ...unsent, sent: judged.problems, sentAt: now.toISOString(), unconfirmed: true }
      await this.deps.write(ahead)
      stored = ahead
      try {
        await this.deps.send(buildHealthMessage(kind, readings, judged.problems, judged.cpuHotStreak, now, this.deps.host()))
        next = { ...ahead }
        delete next.unconfirmed
      } catch (error) {
        // A refusal went nowhere: what was told before stands, and the next check tries again.
        // A lost answer may have arrived: it stays recorded as unconfirmed and waits for the repeat.
        next = telegramSendDefinitelyUnsent(error) ? unsent : ahead
      }
    }
    // The owner may have switched the watch off while the check ran; its forgotten state stays forgotten.
    if (!this.deps.settings().enabled) return
    if (JSON.stringify(next) !== JSON.stringify(stored)) await this.deps.write(next)
  }
}
