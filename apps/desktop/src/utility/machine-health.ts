// MODULE: machine-health.ts - reads the machine's temperatures, battery and mains from sysfs and judges them against fixed limits
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HEALTH_LIMITS } from '@bmn/protocol'

/** Every value is null when its sensor is absent or unreadable: "not measured", never "fine". */
export interface HealthReadings {
  /** Hottest reading of the hwmon named k10temp or coretemp, in whole °C. */
  cpuC: number | null
  /** Hottest reading of the hwmon named amdgpu. */
  integratedGpuC: number | null
  /** Hottest reading over every hwmon named nvme. */
  driveC: number | null
  /** Asked from nvidia-smi only while every NVIDIA card is awake; a sleeping card is not measured. */
  nvidiaGpuC: number | null
  /** True when every NVIDIA card is asleep: nothing is measured because nothing there makes heat. */
  nvidiaGpuAsleep?: boolean
  /**
   * null only when the machine was read to have no battery of its own. When that could not be read (the
   * supplies cannot be listed, or one does not say what it is) this is a battery with nothing known.
   */
  battery: {
    /** What the battery says of itself: "1" is true, "0" is false, anything else is not known. */
    present: boolean | null
    percent: number | null
    status: string | null
    millivolts: number | null
    /** Cells in series, from the pack's design voltage; null when that cannot be read. */
    cells: number | null
  } | null
  mainsOnline: boolean | null
}

export const HEALTH_PROBLEM_KINDS = [
  'cpu-unreadable', 'cpu-critical', 'cpu-hot', 'nvidia-gpu-hot', 'integrated-gpu-hot', 'drive-hot',
  'battery-gone', 'battery-voltage', 'mains-offline'
] as const
export type HealthProblemKind = typeof HEALTH_PROBLEM_KINDS[number]

/** Runs one program without a shell and returns its standard output, or throws. */
export type HealthCommand = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>

export interface HealthReaderOptions {
  /** The sysfs root, `/sys` on a real machine; tests pass a fixture tree. */
  root?: string
  run?: HealthCommand
}

const NVIDIA_VENDOR = '0x10de'
const NVIDIA_TIMEOUT_MS = 10_000
const NVIDIA_ARGS = ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'] as const
const CPU_SENSORS: ReadonlySet<string> = new Set(['k10temp', 'coretemp'])
/** A lithium cell's nominal voltage sits between 3.6 and 3.85 V, so the design voltage names the count. */
const NOMINAL_CELL_VOLTS = 3.75
const STATUS_CHARS = 24

/** The real runner: no shell, a hard stop at the time limit, a few bytes of output at most. */
export const runHealthCommand: HealthCommand = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(String(stdout)))
})

async function line(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8')
    const end = text.indexOf('\n')
    return (end === -1 ? text : text.slice(0, end)).trim()
  } catch {
    return null
  }
}

async function entries(path: string): Promise<string[]> {
  try { return await readdir(path) } catch { return [] }
}

/** The names in a folder, or null when it cannot be listed: "nothing there" and "cannot look" differ. */
async function listing(path: string): Promise<string[] | null> {
  try { return await readdir(path) } catch { return null }
}

function wholeNumber(text: string | null): number | null {
  return text !== null && /^\d{1,12}$/.test(text) ? Number(text) : null
}

function hotter(left: number | null, right: number | null): number | null {
  if (left === null) return right
  return right === null ? left : Math.max(left, right)
}

async function nvidiaTemperature(root: string, run: HealthCommand): Promise<{ celsius: number | null; asleep: boolean }> {
  const devices = join(root, 'bus', 'pci', 'devices')
  const cards: Array<string | null> = []
  for (const device of await entries(devices)) {
    const base = join(devices, device)
    if (await line(join(base, 'vendor')) !== NVIDIA_VENDOR) continue
    if (!(await line(join(base, 'class')))?.startsWith('0x03')) continue
    cards.push(await line(join(base, 'power', 'runtime_status')))
  }
  // The question goes to every card, and it wakes a suspended one and keeps it awake. So it is asked
  // only while every card is already awake; a sleeping card makes no heat.
  if (cards.length === 0 || cards.some(status => status !== 'active')) {
    return { celsius: null, asleep: cards.length > 0 && cards.every(status => status === 'suspended') }
  }
  try {
    // One line per card: the hottest counts, as for every other sensor.
    let hottest: number | null = null
    for (const answer of (await run('nvidia-smi', NVIDIA_ARGS, NVIDIA_TIMEOUT_MS)).split('\n')) {
      if (/^\d{1,3}$/.test(answer.trim())) hottest = hotter(hottest, Number(answer.trim()))
    }
    return { celsius: hottest, asleep: false }
  } catch {
    return { celsius: null, asleep: false }
  }
}

/** One read of the machine. It starts at most one process (nvidia-smi) and changes nothing. */
export async function readMachineHealth(options: HealthReaderOptions = {}): Promise<HealthReadings> {
  const root = options.root ?? '/sys'
  let cpuC: number | null = null
  let integratedGpuC: number | null = null
  let driveC: number | null = null
  const hwmon = join(root, 'class', 'hwmon')
  // Sensors are found by their name: the hwmonN number moves between boots.
  for (const directory of await entries(hwmon)) {
    const base = join(hwmon, directory)
    const name = await line(join(base, 'name'))
    if (name === null || !(CPU_SENSORS.has(name) || name === 'amdgpu' || name === 'nvme')) continue
    let hottest: number | null = null
    for (const file of await entries(base)) {
      if (!/^temp\d+_input$/.test(file)) continue
      const milli = wholeNumber(await line(join(base, file)))
      if (milli !== null) hottest = hotter(hottest, Math.floor(milli / 1000))
    }
    if (CPU_SENSORS.has(name)) cpuC = hotter(cpuC, hottest)
    else if (name === 'amdgpu') integratedGpuC = hotter(integratedGpuC, hottest)
    else driveC = hotter(driveC, hottest)
  }

  let battery: HealthReadings['battery'] = null
  let mainsOnline: boolean | null = null
  const supplies = join(root, 'class', 'power_supply')
  const listed = await listing(supplies)
  // "No battery" is said only when every supply could be asked what it is and none was the machine's own.
  let allNamed = listed !== null
  for (const directory of (listed ?? []).sort()) {
    const base = join(supplies, directory)
    const type = await line(join(base, 'type'))
    if (type === null) allNamed = false
    if (type === 'Battery' && battery === null) {
      // A peripheral's battery (a mouse, a headset) says what it powers; the machine's own does not.
      if (await line(join(base, 'scope')) === 'Device') continue
      const micro = wholeNumber(await line(join(base, 'voltage_now')))
      const design = wholeNumber(await line(join(base, 'voltage_min_design')))
      const cells = design === null ? null : Math.round(design / 1_000_000 / NOMINAL_CELL_VOLTS)
      const status = await line(join(base, 'status'))
      const present = await line(join(base, 'present'))
      battery = {
        present: present === '1' ? true : present === '0' ? false : null,
        percent: wholeNumber(await line(join(base, 'capacity'))),
        status: status === null ? null : status.replace(/[^A-Za-z ]/g, '').slice(0, STATUS_CHARS),
        millivolts: micro === null ? null : Math.round(micro / 1000),
        cells: cells !== null && cells >= 1 && cells <= 8 ? cells : null
      }
    } else if (type === 'Mains' || type === 'USB') {
      const online = await line(join(base, 'online'))
      if (online === '1') mainsOnline = true
      else if (online === '0' && mainsOnline === null) mainsOnline = false
    }
  }
  if (battery === null && !allNamed) battery = { present: null, percent: null, status: null, millivolts: null, cells: null }
  const nvidia = await nvidiaTemperature(root, options.run ?? runHealthCommand)
  return { cpuC, integratedGpuC, driveC, battery, mainsOnline, nvidiaGpuC: nvidia.celsius, ...(nvidia.asleep ? { nvidiaGpuAsleep: true } : {}) }
}

export interface HealthJudgement {
  problems: HealthProblemKind[]
  /** Readings in a row with the CPU at the hot limit or above, this one included. */
  cpuHotStreak: number
}

/**
 * Whether this watch covers the battery and mains: decided once, by the first reading that can tell, and
 * kept for the whole watch. A machine read to have no battery (no such supply, or one that says it is
 * not present) is not covered, also when a battery appears later. A reading that cannot tell decides
 * nothing: the question stays open (null), so an unreadable start neither exempts the machine for good
 * nor starts a watch on a battery nobody saw.
 */
export function batteryWatched(decided: boolean | null, battery: HealthReadings['battery']): boolean | null {
  if (decided !== null) return decided
  if (battery === null) return false
  return battery.present
}

/**
 * Judges one reading. `cpuHotStreak` is the count before this reading; `batteryAtStart` says whether the
 * machine had a battery when the watch was switched on: without one, or while that is not yet known,
 * there is no battery or mains problem. A battery that was there is gone when the reading shows no
 * battery, one that says it is not present, or one that cannot say; only a battery read as present ends it.
 * `standing` is the problem set the owner was last told. A problem in it ends only on a reading that
 * shows it over: while that reading cannot be taken the problem stands, so a sensor that falls silent
 * is never read as "back to normal". An NVIDIA card that went to sleep is over: it makes no heat.
 */
export function judgeMachineHealth(
  readings: HealthReadings,
  cpuHotStreak: number,
  batteryAtStart: boolean,
  standing: readonly HealthProblemKind[] = []
): HealthJudgement {
  const found = new Set<HealthProblemKind>()
  let streak = 0
  if (readings.cpuC === null) {
    found.add('cpu-unreadable')
  } else {
    streak = readings.cpuC >= HEALTH_LIMITS.cpuHot ? cpuHotStreak + 1 : 0
    if (readings.cpuC >= HEALTH_LIMITS.cpuCritical) found.add('cpu-critical')
    else if (streak >= HEALTH_LIMITS.cpuHotReadings) found.add('cpu-hot')
  }
  const stands = (kind: HealthProblemKind): boolean => standing.includes(kind)
  if (readings.nvidiaGpuC === null ? stands('nvidia-gpu-hot') && readings.nvidiaGpuAsleep !== true : readings.nvidiaGpuC >= HEALTH_LIMITS.nvidiaGpu) found.add('nvidia-gpu-hot')
  if (readings.integratedGpuC === null ? stands('integrated-gpu-hot') : readings.integratedGpuC >= HEALTH_LIMITS.integratedGpu) found.add('integrated-gpu-hot')
  if (readings.driveC === null ? stands('drive-hot') : readings.driveC >= HEALTH_LIMITS.drive) found.add('drive-hot')
  if (batteryAtStart) {
    const battery = readings.battery
    if (battery === null || battery.present !== true) {
      found.add('battery-gone')
      if (stands('battery-voltage')) found.add('battery-voltage')
    } else if (battery.millivolts === null || battery.cells === null) {
      if (stands('battery-voltage')) found.add('battery-voltage')
    } else {
      const perCell = battery.millivolts / 1000 / battery.cells
      if (perCell < HEALTH_LIMITS.cellVoltsMin || perCell > HEALTH_LIMITS.cellVoltsMax) found.add('battery-voltage')
    }
    if (readings.mainsOnline === null ? stands('mains-offline') : !readings.mainsOnline) found.add('mains-offline')
  }
  return { problems: HEALTH_PROBLEM_KINDS.filter(kind => found.has(kind)), cpuHotStreak: Math.min(streak, 1_000_000) }
}
