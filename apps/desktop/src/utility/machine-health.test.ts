// MODULE: machine-health.test.ts - the sensor reader on fixture trees and the judge at each limit
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  batteryWatched,
  judgeMachineHealth,
  readMachineHealth,
  runHealthCommand,
  type HealthCommand,
  type HealthReadings
} from './machine-health'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** Writes a sysfs-shaped tree: each key is a path under the root, each value the file's one line. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-health-test-'))
  roots.push(root)
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), `${value}\n`)
  }
  return root
}

const LAPTOP = {
  'class/hwmon/hwmon0/name': 'ADP0',
  'class/hwmon/hwmon1/name': 'BAT0',
  'class/hwmon/hwmon2/name': 'nvme',
  'class/hwmon/hwmon2/temp1_input': '41850',
  'class/hwmon/hwmon2/temp2_input': '47850',
  'class/hwmon/hwmon3/name': 'nvme',
  'class/hwmon/hwmon3/temp1_input': '52999',
  'class/hwmon/hwmon4/name': 'k10temp',
  'class/hwmon/hwmon4/temp1_input': '61375',
  'class/hwmon/hwmon4/temp1_max': '110000',
  'class/hwmon/hwmon5/name': 'amdgpu',
  'class/hwmon/hwmon5/temp1_input': '58000',
  'class/power_supply/ADP0/type': 'Mains',
  'class/power_supply/ADP0/online': '1',
  'class/power_supply/BAT0/type': 'Battery',
  'class/power_supply/BAT0/present': '1',
  'class/power_supply/BAT0/capacity': '77',
  'class/power_supply/BAT0/status': 'Not charging',
  'class/power_supply/BAT0/voltage_now': '11629000',
  'class/power_supply/BAT0/voltage_min_design': '11400000',
  'bus/pci/devices/0000:01:00.0/vendor': '0x10de',
  'bus/pci/devices/0000:01:00.0/class': '0x030000',
  'bus/pci/devices/0000:01:00.0/power/runtime_status': 'suspended',
  'bus/pci/devices/0000:05:00.0/vendor': '0x1002',
  'bus/pci/devices/0000:05:00.0/class': '0x030000',
  'bus/pci/devices/0000:05:00.0/power/runtime_status': 'active'
}

const refuse: HealthCommand = () => Promise.reject(new Error('no process may start'))

describe('reading the machine', () => {
  it('returns the hottest reading of each named sensor, the battery and mains, and leaves a sleeping NVIDIA card alone', async () => {
    const calls: unknown[] = []
    const readings = await readMachineHealth({ root: await tree(LAPTOP), run: async (...args) => { calls.push(args); return '99\n' } })
    expect(readings).toEqual({
      cpuC: 61, integratedGpuC: 58, driveC: 52, nvidiaGpuC: null, nvidiaGpuAsleep: true,
      battery: { present: true, percent: 77, status: 'Not charging', millivolts: 11629, cells: 3 },
      mainsOnline: true
    })
    expect(calls).toEqual([])
  })

  it('asks no NVIDIA card while one of several sleeps: the question would wake it', async () => {
    const second = {
      'bus/pci/devices/0000:02:00.0/vendor': '0x10de',
      'bus/pci/devices/0000:02:00.0/class': '0x030200'
    }
    const calls: unknown[] = []
    const run: HealthCommand = async (...args) => { calls.push(args); return '70\n75\n' }
    // One awake, one asleep: not asked, and not "asleep" either, since one card is making heat unseen.
    const mixed = await readMachineHealth({ root: await tree({
      ...LAPTOP, ...second, 'bus/pci/devices/0000:01:00.0/power/runtime_status': 'active', 'bus/pci/devices/0000:02:00.0/power/runtime_status': 'suspended'
    }), run })
    expect(mixed.nvidiaGpuC).toBeNull()
    expect(mixed.nvidiaGpuAsleep).toBeUndefined()
    // A card whose state cannot be read counts as not awake.
    const unknown = await readMachineHealth({ root: await tree({ ...LAPTOP, ...second, 'bus/pci/devices/0000:01:00.0/power/runtime_status': 'active' }), run })
    expect(unknown.nvidiaGpuC).toBeNull()
    expect(calls).toEqual([])
    const awake = await readMachineHealth({ root: await tree({
      ...LAPTOP, ...second, 'bus/pci/devices/0000:01:00.0/power/runtime_status': 'active', 'bus/pci/devices/0000:02:00.0/power/runtime_status': 'active'
    }), run })
    expect(awake.nvidiaGpuC).toBe(75)
    expect(calls).toHaveLength(1)
    const asleep = await readMachineHealth({ root: await tree({ ...LAPTOP, ...second, 'bus/pci/devices/0000:02:00.0/power/runtime_status': 'suspended' }), run })
    expect(asleep).toMatchObject({ nvidiaGpuC: null, nvidiaGpuAsleep: true })
    expect(calls).toHaveLength(1)
  })

  it('finds sensors by name when the hwmon numbers are in another order', async () => {
    const reordered = await tree({
      'class/hwmon/hwmon0/name': 'amdgpu', 'class/hwmon/hwmon0/temp1_input': '58000',
      'class/hwmon/hwmon1/name': 'coretemp', 'class/hwmon/hwmon1/temp1_input': '70000', 'class/hwmon/hwmon1/temp2_input': '74999',
      'class/hwmon/hwmon7/name': 'nvme', 'class/hwmon/hwmon7/temp1_input': '39000',
      'class/hwmon/hwmon9/name': 'acpitz', 'class/hwmon/hwmon9/temp1_input': '99000'
    })
    expect(await readMachineHealth({ root: reordered, run: refuse })).toMatchObject({ cpuC: 74, integratedGpuC: 58, driveC: 39 })
  })

  it('asks an awake NVIDIA card once, with no shell and a 10 s limit', async () => {
    const calls: unknown[] = []
    const root = await tree({ ...LAPTOP, 'bus/pci/devices/0000:01:00.0/power/runtime_status': 'active' })
    const readings = await readMachineHealth({ root, run: async (...args) => { calls.push(args); return '71\n' } })
    expect(readings.nvidiaGpuC).toBe(71)
    expect(calls).toEqual([['nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], 10_000]])
    // One line per card: the hottest counts, as for every other sensor.
    expect((await readMachineHealth({ root, run: async () => '64\n88\n71\n' })).nvidiaGpuC).toBe(88)
  })

  it('reads an NVIDIA card as not measured when the question fails or answers nonsense', async () => {
    const root = await tree({ ...LAPTOP, 'bus/pci/devices/0000:01:00.0/power/runtime_status': 'active' })
    expect((await readMachineHealth({ root, run: refuse })).nvidiaGpuC).toBeNull()
    expect((await readMachineHealth({ root, run: async () => 'No devices were found\n' })).nvidiaGpuC).toBeNull()
  })

  it('stops a hung program at the time limit', async () => {
    const started = Date.now()
    await expect(runHealthCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  const unknownBattery = { present: null, percent: null, status: null, millivolts: null, cells: null }

  it('reads a machine with no sensors and no battery as not measured, never as fine', async () => {
    const root = await tree({ 'class/hwmon/hwmon0/name': 'acpitz' })
    // The supplies can be listed and there are none: this machine has no battery.
    await mkdir(join(root, 'class', 'power_supply'), { recursive: true })
    expect(await readMachineHealth({ root, run: refuse }))
      .toEqual({ cpuC: null, integratedGpuC: null, driveC: null, nvidiaGpuC: null, battery: null, mainsOnline: null })
  })

  it('does not read "cannot look" as "no battery": supplies that cannot be listed leave the battery unknown', async () => {
    const unlisted = await readMachineHealth({ root: await tree({ 'class/hwmon/hwmon0/name': 'acpitz' }), run: refuse })
    expect(unlisted).toEqual({ cpuC: null, integratedGpuC: null, driveC: null, nvidiaGpuC: null, battery: unknownBattery, mainsOnline: null })
    expect(await readMachineHealth({ root: join(tmpdir(), 'bmn-health-test-absent'), run: refuse })).toEqual(unlisted)
  })

  it('does not read a supply that will not say what it is as "no battery"', async () => {
    // BAT0 is there and its type cannot be read; the mains supply beside it still counts.
    const silent = await tree({
      'class/power_supply/ADP0/type': 'Mains', 'class/power_supply/ADP0/online': '0', 'class/power_supply/BAT0/present': '1'
    })
    expect(await readMachineHealth({ root: silent, run: refuse })).toMatchObject({ battery: unknownBattery, mainsOnline: false })
    // A battery that does say what it is is read, whatever a silent supply beside it is.
    const named = await tree({
      'class/power_supply/AAA/online': '1', 'class/power_supply/BAT0/type': 'Battery', 'class/power_supply/BAT0/present': '1'
    })
    expect((await readMachineHealth({ root: named, run: refuse })).battery).toMatchObject({ present: true })
    // Every supply named and none the machine's own battery: no battery.
    const mainsOnly = await tree({ 'class/power_supply/ADP0/type': 'Mains', 'class/power_supply/ADP0/online': '1' })
    expect((await readMachineHealth({ root: mainsOnly, run: refuse })).battery).toBeNull()
  })

  it.each([
    ['1', true], ['0', false], [null, null], ['', null], ['yes', null], ['2', null], ['01', null]
  ] as const)('reads a battery\'s "present" of %j as %j: only "1" and "0" say anything', async (present, expected) => {
    const root = await tree({
      'class/power_supply/BAT0/type': 'Battery', 'class/power_supply/BAT0/capacity': '50',
      ...(present === null ? {} : { 'class/power_supply/BAT0/present': present })
    })
    expect((await readMachineHealth({ root, run: refuse })).battery).toEqual({ ...unknownBattery, present: expected, percent: 50 })
  })

  it('ignores an unreadable value and a peripheral battery', async () => {
    const root = await tree({
      'class/hwmon/hwmon0/name': 'k10temp', 'class/hwmon/hwmon0/temp1_input': 'N/A', 'class/hwmon/hwmon0/temp2_input': '-5',
      'class/power_supply/hidpp_battery_0/type': 'Battery', 'class/power_supply/hidpp_battery_0/scope': 'Device',
      'class/power_supply/hidpp_battery_0/present': '1', 'class/power_supply/hidpp_battery_0/capacity': '50'
    })
    expect(await readMachineHealth({ root, run: refuse })).toMatchObject({ cpuC: null, battery: null })
  })

  it('reads a battery that is no longer present, and mains from a USB-C supply', async () => {
    const root = await tree({
      'class/power_supply/BAT0/type': 'Battery', 'class/power_supply/BAT0/present': '0',
      'class/power_supply/ucsi-source-psy-1/type': 'USB', 'class/power_supply/ucsi-source-psy-1/online': '0',
      'class/power_supply/ucsi-source-psy-2/type': 'USB', 'class/power_supply/ucsi-source-psy-2/online': '1'
    })
    expect(await readMachineHealth({ root, run: refuse })).toMatchObject({
      battery: { present: false, percent: null, status: null, millivolts: null, cells: null }, mainsOnline: true
    })
  })
})

const healthy: HealthReadings = {
  cpuC: 60, integratedGpuC: 58, driveC: 45, nvidiaGpuC: null,
  battery: { present: true, percent: 80, status: 'Charging', millivolts: 11_600, cells: 3 }, mainsOnline: true
}
const judge = (change: Partial<HealthReadings>, streak = 0, batteryAtStart = true) =>
  judgeMachineHealth({ ...healthy, ...change }, streak, batteryAtStart)
const battery = (change: Partial<NonNullable<HealthReadings['battery']>>) => ({ battery: { ...healthy.battery!, ...change } })

describe('judging a reading', () => {
  it('finds nothing wrong with a healthy machine', () => {
    expect(judge({})).toEqual({ problems: [], cpuHotStreak: 0 })
  })

  it.each([
    ['CPU at its limit', { cpuC: 99 }, { cpuC: 100 }, 'cpu-critical'],
    ['NVIDIA GPU', { nvidiaGpuC: 86 }, { nvidiaGpuC: 87 }, 'nvidia-gpu-hot'],
    ['integrated GPU', { integratedGpuC: 94 }, { integratedGpuC: 95 }, 'integrated-gpu-hot'],
    ['drive', { driveC: 79 }, { driveC: 80 }, 'drive-hot'],
    ['battery under-voltage (3.0 V a cell)', battery({ millivolts: 9_000 }), battery({ millivolts: 8_999 }), 'battery-voltage'],
    ['battery over-voltage (4.45 V a cell)', battery({ millivolts: 13_350 }), battery({ millivolts: 13_351 }), 'battery-voltage']
  ] as const)('%s: fine one step inside, a problem at the limit', (_label, inside, at, kind) => {
    expect(judge(inside).problems).toEqual([])
    expect(judge(at).problems).toEqual([kind])
  })

  it('takes the cell count from the pack, so a four-cell pack has its own range', () => {
    expect(judge(battery({ millivolts: 16_800, cells: 4 })).problems).toEqual([])
    expect(judge(battery({ millivolts: 16_800, cells: 3 })).problems).toEqual(['battery-voltage'])
  })

  it('does not judge a voltage it cannot place: no reading or no cell count', () => {
    expect(judge(battery({ millivolts: null })).problems).toEqual([])
    expect(judge(battery({ millivolts: 20_000, cells: null })).problems).toEqual([])
  })

  it('needs three hot CPU readings in a row and starts over after a cooler one', () => {
    const first = judge({ cpuC: 95 }, 0)
    expect(first).toEqual({ problems: [], cpuHotStreak: 1 })
    const second = judge({ cpuC: 97 }, first.cpuHotStreak)
    expect(second).toEqual({ problems: [], cpuHotStreak: 2 })
    expect(judge({ cpuC: 96 }, second.cpuHotStreak)).toEqual({ problems: ['cpu-hot'], cpuHotStreak: 3 })
    expect(judge({ cpuC: 94 }, second.cpuHotStreak)).toEqual({ problems: [], cpuHotStreak: 0 })
    expect(judge({ cpuC: 95 }, 0)).toEqual({ problems: [], cpuHotStreak: 1 })
  })

  it('says a CPU at its limit once, not also as hot for long', () => {
    expect(judge({ cpuC: 101 }, 5)).toEqual({ problems: ['cpu-critical'], cpuHotStreak: 6 })
  })

  it('makes an unreadable CPU sensor a problem of its own and resets the count', () => {
    expect(judge({ cpuC: null }, 2)).toEqual({ problems: ['cpu-unreadable'], cpuHotStreak: 0 })
  })

  it('reports mains lost and a battery that disappeared', () => {
    expect(judge({ mainsOnline: false }).problems).toEqual(['mains-offline'])
    expect(judge(battery({ present: false })).problems).toEqual(['battery-gone'])
    expect(judge({ battery: null }).problems).toEqual(['battery-gone'])
  })

  it('reads a battery that was there and can no longer say it is present as gone, never as fine', () => {
    expect(judge(battery({ present: null })).problems).toEqual(['battery-gone'])
    // Its voltage is not judged while it cannot say it is there, and a wrong voltage told before stands.
    expect(judge(battery({ present: null, millivolts: 1 })).problems).toEqual(['battery-gone'])
    expect(judgeMachineHealth({ ...healthy, ...battery({ present: null }) }, 0, true, ['battery-voltage']).problems).toEqual(['battery-gone', 'battery-voltage'])
    // Only a battery read as present ends it.
    expect(judgeMachineHealth(healthy, 0, true, ['battery-gone']).problems).toEqual([])
  })

  it('decides once whether the watch covers the battery, by the first reading that can tell', () => {
    const present = healthy.battery!
    const forms = [null, { ...present, present: false }, { ...present, present: null }, present]
    // Undecided: no battery, or one that says it is not there, is "no" for good; a present one is "yes";
    // one that cannot say leaves the question open.
    expect(forms.map(form => batteryWatched(null, form))).toEqual([false, false, null, true])
    // Decided: nothing a later reading shows changes it.
    expect(forms.map(form => batteryWatched(false, form))).toEqual([false, false, false, false])
    expect(forms.map(form => batteryWatched(true, form))).toEqual([true, true, true, true])
  })

  it('does not read unknown mains as lost', () => {
    expect(judge({ mainsOnline: null }).problems).toEqual([])
  })

  it('has no battery or mains problem on a machine that had no battery at the start', () => {
    expect(judge({ battery: null, mainsOnline: false }, 0, false).problems).toEqual([])
    expect(judge({ ...battery({ millivolts: 1 }), mainsOnline: false }, 0, false).problems).toEqual([])
  })

  it.each([
    ['a hot NVIDIA card', 'nvidia-gpu-hot', { nvidiaGpuC: null }, { nvidiaGpuC: 70 }],
    ['a hot integrated GPU', 'integrated-gpu-hot', { integratedGpuC: null }, { integratedGpuC: 70 }],
    ['a hot drive', 'drive-hot', { driveC: null }, { driveC: 50 }],
    ['a battery voltage out of range', 'battery-voltage', battery({ millivolts: null }), battery({ millivolts: 11_600 })],
    ['a battery voltage out of range, the cell count gone', 'battery-voltage', battery({ cells: null }), battery({})],
    ['mains power lost', 'mains-offline', { mainsOnline: null }, { mainsOnline: true }]
  ] as const)('keeps %s standing while its reading cannot be taken, and ends it on a reading that shows it over', (_label, kind, silent, over) => {
    expect(judgeMachineHealth({ ...healthy, ...silent }, 0, true, [kind]).problems).toEqual([kind])
    expect(judgeMachineHealth({ ...healthy, ...over }, 0, true, [kind]).problems).toEqual([])
    // A reading that was never told as a problem and cannot be taken raises nothing by itself.
    expect(judgeMachineHealth({ ...healthy, ...silent }, 0, true, []).problems).toEqual([])
  })

  it('ends a hot NVIDIA card when the card went to sleep, and keeps a wrong voltage standing when the battery is gone', () => {
    expect(judgeMachineHealth({ ...healthy, nvidiaGpuC: null, nvidiaGpuAsleep: true }, 0, true, ['nvidia-gpu-hot']).problems).toEqual([])
    expect(judgeMachineHealth({ ...healthy, battery: null }, 0, true, ['battery-voltage']).problems).toEqual(['battery-gone', 'battery-voltage'])
  })

  it('names several problems in one fixed order', () => {
    expect(judge({ cpuC: null, driveC: 90, mainsOnline: false, integratedGpuC: 99 }).problems)
      .toEqual(['cpu-unreadable', 'integrated-gpu-hot', 'drive-hot', 'mains-offline'])
  })
})

// Reads the real /sys of the machine it runs on and records the readings and the cost. It runs only when
// asked: BMN_HEALTH_REAL_SYSFS=<file to write> pnpm exec vitest run apps/desktop/src/utility/machine-health.test.ts
describe.runIf(Boolean(process.env.BMN_HEALTH_REAL_SYSFS))('the real machine (Story 62.1 AC4)', () => {
  it('reads and judges in under 150 ms of CPU and starts at most one process', async () => {
    let started = 0
    const run: HealthCommand = (file, args, timeoutMs) => { started += 1; return runHealthCommand(file, args, timeoutMs) }
    await readMachineHealth({ run })
    const runs: Array<{ cpuMs: number; wallMs: number; processes: number }> = []
    let readings: HealthReadings | undefined
    for (let index = 0; index < 5; index++) {
      started = 0
      const cpu = process.cpuUsage(), wall = performance.now()
      readings = await readMachineHealth({ run })
      const judged = judgeMachineHealth(readings, 0, readings.battery?.present === true)
      const used = process.cpuUsage(cpu)
      runs.push({ cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - wall, processes: started })
      expect(judged.problems).toBeInstanceOf(Array)
    }
    const worst = Math.max(...runs.map(entry => entry.cpuMs))
    writeFileSync(process.env.BMN_HEALTH_REAL_SYSFS!, JSON.stringify({
      readings, judged: judgeMachineHealth(readings!, 0, readings!.battery?.present === true), runs, worstCpuMs: worst
    }, null, 2))
    expect(worst).toBeLessThan(150)
    for (const entry of runs) expect(entry.processes).toBeLessThanOrEqual(1)
    expect(readings!.cpuC).not.toBeNull()
  })
})
