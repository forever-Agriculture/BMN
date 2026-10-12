// MODULE: health-alerts.test.ts - when the health watch sends, repeats, clears and switches itself off, on an injected clock
import type { TelegramHealthAlerts } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { HealthAlerts, buildHealthMessage, nextLocalTime } from './health-alerts'
import type { HealthReadings } from './machine-health'
import { TelegramConnectorError } from './telegram-connector'

const healthy: HealthReadings = {
  cpuC: 60, integratedGpuC: 58, driveC: 45, nvidiaGpuC: null,
  battery: { present: true, percent: 80, status: 'Charging', millivolts: 11_600, cells: 3 }, mainsOnline: true
}
const unplugged: HealthReadings = { ...healthy, mainsOnline: false, battery: { ...healthy.battery!, status: 'Discharging' } }
const hotDrive: HealthReadings = { ...healthy, driveC: 81 }

/** A watch on a clock the test moves; `store` plays the one raw setting and survives a new watch. */
function world(start = '2026-03-10T10:00:00', store: { value?: unknown } = {}) {
  const state = {
    now: new Date(start), settings: { enabled: true, offAt: null } as TelegramHealthAlerts, ready: true,
    readings: healthy, sent: [] as string[], checks: 0, turnedOff: 0, failure: undefined as unknown, writes: 0,
    /** The write with this number fails, as when BMN ends there; a check waits for `hold`. */
    failWrite: 0, hold: undefined as Promise<void> | undefined
  }
  const watch = new HealthAlerts({
    read: async () => store.value,
    write: async value => {
      state.writes += 1
      if (state.writes === state.failWrite) throw new Error('synthetic crash')
      store.value = JSON.parse(JSON.stringify(value))
    },
    settings: () => state.settings,
    ready: () => state.ready,
    now: () => new Date(state.now),
    monotonic: () => state.now.getTime(),
    host: () => 'synthetic-host',
    check: async () => { state.checks += 1; await state.hold; return state.readings },
    send: async html => {
      if (state.failure !== undefined) { const failure = state.failure; state.failure = undefined; throw failure }
      state.sent.push(html)
    },
    // One step, as in the store: the saved switch and the watch's state change together.
    turnOff: async value => { state.turnedOff += 1; state.settings = { enabled: false, offAt: null }; store.value = JSON.parse(JSON.stringify(value)) }
  })
  const advance = async (seconds: number): Promise<void> => {
    state.now = new Date(state.now.getTime() + seconds * 1000)
    await watch.sweep()
  }
  return { state, watch, store, advance }
}

describe('the health watch', () => {
  it('reads nothing and sends nothing while it is off', async () => {
    const { state, advance } = world()
    state.settings = { enabled: false, offAt: null }
    state.readings = unplugged
    await advance(0); await advance(120)
    expect(state.checks).toBe(0)
    expect(state.sent).toEqual([])
  })

  it('checks at most once a minute and says nothing while the machine is healthy', async () => {
    const { state, advance } = world()
    await advance(0)
    await advance(30)
    expect(state.checks).toBe(1)
    await advance(30)
    expect(state.checks).toBe(2)
    await advance(59)
    expect(state.checks).toBe(2)
    expect(state.sent).toEqual([])
  })

  it('sends one alert for a new problem, repeats it at ten minutes and not before, then one all-clear', async () => {
    const { state, advance } = world()
    await advance(0)
    state.readings = unplugged
    await advance(60)
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0]).toContain('<b>Health alert</b>')
    expect(state.sent[0]).toContain('Mains power lost, on battery at 80%')
    for (let minute = 0; minute < 9; minute++) await advance(60)
    expect(state.sent).toHaveLength(1)
    await advance(60)
    expect(state.sent).toHaveLength(2)
    state.readings = healthy
    await advance(60)
    expect(state.sent).toHaveLength(3)
    expect(state.sent[2]).toContain('<b>Back to normal</b>')
    await advance(60); await advance(600)
    expect(state.sent).toHaveLength(3)
  })

  it('sends at once when the set of problems changes, and not when a reading only wobbles', async () => {
    const { state, advance } = world()
    state.readings = hotDrive
    await advance(0)
    state.readings = { ...hotDrive, driveC: 84 }
    await advance(60)
    state.readings = { ...hotDrive, driveC: 80 }
    await advance(60)
    expect(state.sent).toHaveLength(1)
    state.readings = { ...hotDrive, mainsOnline: false }
    await advance(60)
    expect(state.sent).toHaveLength(2)
    expect(state.sent[1]).toContain('Drive at 81 °C')
    expect(state.sent[1]).toContain('Mains power lost')
    state.readings = unplugged
    await advance(60)
    expect(state.sent).toHaveLength(3)
    expect(state.sent[2]).not.toContain('Drive at')
  })

  it('alerts a hot CPU only on the third reading in a row and keeps the count across a restart', async () => {
    const first = world()
    first.state.readings = { ...healthy, cpuC: 96 }
    await first.advance(0); await first.advance(60)
    expect(first.state.sent).toEqual([])
    const second = world('2026-03-10T10:02:00', first.store)
    second.state.readings = { ...healthy, cpuC: 97 }
    await second.advance(0)
    expect(second.state.sent).toHaveLength(1)
    expect(second.state.sent[0]).toContain('CPU at 97 °C for 3 checks in a row')
  })

  it('tries a refused send again at the next check', async () => {
    const { state, advance } = world()
    state.readings = unplugged
    state.failure = new TelegramConnectorError('http', 'Too many requests', 429)
    await advance(0)
    expect(state.sent).toEqual([])
    await advance(60)
    expect(state.sent).toHaveLength(1)
  })

  it('does not repeat a send whose answer was lost before the ten-minute repeat', async () => {
    const { state, advance } = world()
    state.readings = unplugged
    state.failure = new TelegramConnectorError('network', 'The answer never came')
    await advance(0)
    for (let minute = 0; minute < 9; minute++) await advance(60)
    expect(state.sent).toEqual([])
    await advance(60)
    expect(state.sent).toHaveLength(1)
  })

  it('says an all-clear again at the repeat when its answer was lost, also across a restart', async () => {
    const first = world()
    first.state.readings = unplugged
    await first.advance(0)
    first.state.readings = healthy
    first.state.failure = new TelegramConnectorError('network', 'The answer never came')
    await first.advance(60)
    expect(first.state.sent).toHaveLength(1)
    expect(first.store.value).toMatchObject({ sent: [], unconfirmed: true })
    const second = world('2026-03-10T10:03:00', first.store)
    for (let minute = 0; minute < 7; minute++) await second.advance(60)
    expect(second.state.sent).toEqual([])
    await second.advance(60)
    expect(second.state.sent).toHaveLength(1)
    expect(second.state.sent[0]).toContain('Back to normal')
    expect(second.store.value).not.toHaveProperty('unconfirmed')
    await second.advance(600); await second.advance(600)
    expect(second.state.sent).toHaveLength(1)
  })

  it('tries an all-clear Telegram refused again at the next check', async () => {
    const { state, advance } = world()
    state.readings = unplugged
    await advance(0)
    state.readings = healthy
    state.failure = new TelegramConnectorError('http', 'Too many requests', 429)
    await advance(60)
    expect(state.sent).toHaveLength(1)
    await advance(60)
    expect(state.sent).toHaveLength(2)
    expect(state.sent[1]).toContain('Back to normal')
  })

  it('does not say an alert twice when BMN ended between the send and its record', async () => {
    const first = world()
    first.state.readings = unplugged
    // The record after the send is the one that never happens.
    first.state.failWrite = 2
    await expect(first.advance(0)).rejects.toThrow('synthetic crash')
    expect(first.state.sent).toHaveLength(1)
    expect(first.store.value).toMatchObject({ sent: ['mains-offline'], unconfirmed: true })
    const second = world('2026-03-10T10:01:00', first.store)
    second.state.readings = unplugged
    for (let minute = 0; minute < 8; minute++) await second.advance(60)
    expect(second.state.sent).toEqual([])
    await second.advance(60)
    expect(second.state.sent).toHaveLength(1)
    expect(second.store.value).not.toHaveProperty('unconfirmed')
  })

  it('does not call a problem over when its reading falls silent: no "Back to normal" on a reading it cannot take', async () => {
    const { state, advance } = world()
    state.readings = unplugged
    await advance(0)
    expect(state.sent).toHaveLength(1)
    state.readings = { ...unplugged, mainsOnline: null }
    await advance(60); await advance(60)
    expect(state.sent).toHaveLength(1)
    await advance(480)
    expect(state.sent).toHaveLength(2)
    expect(state.sent[1]).toContain('Health alert')
    expect(state.sent[1]).toContain('Mains power was lost and can no longer be read')
    state.readings = healthy
    await advance(60)
    expect(state.sent[2]).toContain('Back to normal')

    const drive = world()
    drive.state.readings = hotDrive
    await drive.advance(0)
    drive.state.readings = { ...healthy, driveC: null }
    await drive.advance(60)
    expect(drive.state.sent).toHaveLength(1)
    drive.state.readings = healthy
    await drive.advance(60)
    expect(drive.state.sent[1]).toContain('Back to normal')
  })

  it.each([
    ['no battery supply', null],
    ['a battery that says it is not present', { ...healthy.battery!, present: false }]
  ] as const)('never watches battery or mains on a machine that started with %s, also when a battery appears and across a restart', async (_label, start) => {
    const first = world()
    first.state.readings = { ...healthy, battery: start, mainsOnline: false }
    await first.advance(0)
    // The decision is stored though no message went out.
    expect(first.store.value).toMatchObject({ batteryAtStart: false, sent: [] })
    // A battery put in later, on battery power and at a wrong voltage: still not this watch's business.
    const inserted: HealthReadings = { ...unplugged, battery: { ...unplugged.battery!, millivolts: 1 } }
    first.state.readings = inserted
    await first.advance(60)
    const second = world('2026-03-10T10:05:00', first.store)
    second.state.readings = inserted
    await second.advance(0)
    // The same watch after its settings were read again (a restart, a save of another field).
    await second.watch.configure()
    await second.advance(60)
    expect([...first.state.sent, ...second.state.sent]).toEqual([])
    expect(first.store.value).toMatchObject({ batteryAtStart: false })
  })

  it('leaves the question open while no reading can tell, raising nothing, and decides on the first reading that can', async () => {
    const unknown: HealthReadings = { ...healthy, battery: { present: null, percent: null, status: null, millivolts: null, cells: null }, mainsOnline: false }
    // Unknown, unknown, then a battery: watched from there.
    const laptop = world()
    laptop.state.readings = unknown
    await laptop.advance(0)
    // Open is how a watch starts: nothing was decided, so nothing says "true" or "false".
    const decided = (): unknown => (laptop.store.value as { batteryAtStart?: unknown } | undefined)?.batteryAtStart ?? null
    expect(decided()).toBeNull()
    // Still open after a restart.
    const restarted = world('2026-03-10T10:01:00', laptop.store)
    restarted.state.readings = unknown
    await restarted.advance(0)
    expect(restarted.state.sent).toEqual([])
    expect(decided()).toBeNull()
    restarted.state.readings = unplugged
    await restarted.advance(60)
    expect(laptop.store.value).toMatchObject({ batteryAtStart: true })
    expect(restarted.state.sent).toHaveLength(1)
    expect(restarted.state.sent[0]).toContain('Mains power lost')
    // Unknown, then read as absent, then a battery: not watched.
    const desktop = world()
    desktop.state.readings = unknown
    await desktop.advance(0)
    desktop.state.readings = { ...healthy, battery: null, mainsOnline: false }
    await desktop.advance(60)
    expect(desktop.store.value).toMatchObject({ batteryAtStart: false })
    desktop.state.readings = unplugged
    await desktop.advance(60)
    expect(desktop.state.sent).toEqual([])
  })

  it.each([
    ['no battery supply', null],
    ['a battery that says it is not present', { ...healthy.battery!, present: false }],
    ['a battery that cannot say whether it is present', { present: null, percent: null, status: null, millivolts: null, cells: null }]
  ] as const)('reports a battery that was there as gone on %s, and ends it only on a battery read as present', async (_label, gone) => {
    const { state, store, advance } = world()
    await advance(0)
    expect(store.value).toMatchObject({ batteryAtStart: true })
    state.readings = { ...healthy, battery: gone }
    await advance(60)
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0]).toContain('Battery no longer detected')
    await advance(60)
    expect(state.sent).toHaveLength(1)
    state.readings = healthy
    await advance(60)
    expect(state.sent).toHaveLength(2)
    expect(state.sent[1]).toContain('Back to normal')
    expect(store.value).toMatchObject({ batteryAtStart: true, sent: [] })
  })

  it('decides anew after the owner switched the watch off and on', async () => {
    const { state, watch, store, advance } = world()
    state.readings = { ...healthy, battery: null, mainsOnline: false }
    await advance(0)
    expect(store.value).toMatchObject({ batteryAtStart: false })
    state.settings = { enabled: false, offAt: null }
    await watch.configure()
    expect(store.value).toMatchObject({ batteryAtStart: null })
    state.settings = { enabled: true, offAt: null }
    await watch.configure()
    state.readings = unplugged
    await advance(60)
    expect(store.value).toMatchObject({ batteryAtStart: true })
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0]).toContain('Mains power lost')
  })

  it('neither repeats a delivered alert nor loses the all-clear it owes across a restart', async () => {
    const first = world()
    first.state.readings = unplugged
    await first.advance(0)
    expect(first.state.sent).toHaveLength(1)
    const second = world('2026-03-10T10:03:00', first.store)
    second.state.readings = unplugged
    await second.advance(0)
    expect(second.state.sent).toEqual([])
    const third = world('2026-03-10T10:05:00', first.store)
    await third.advance(0)
    expect(third.state.sent).toHaveLength(1)
    expect(third.state.sent[0]).toContain('Back to normal')
  })

  it('waits while Telegram is away and tells what it owes when it is back', async () => {
    const { state, advance } = world()
    state.readings = unplugged
    await advance(0)
    state.ready = false
    state.readings = healthy
    await advance(60); await advance(60)
    expect(state.sent).toHaveLength(1)
    state.ready = true
    await advance(60)
    expect(state.sent).toHaveLength(2)
    expect(state.sent[1]).toContain('Back to normal')
  })

  it('remembers a battery seen at the start and reports it gone; a machine without one never has battery or mains problems', async () => {
    const laptop = world()
    await laptop.advance(0)
    laptop.state.readings = { ...healthy, battery: null, mainsOnline: null }
    await laptop.advance(60)
    expect(laptop.state.sent[0]).toContain('Battery no longer detected')
    const desktop = world()
    desktop.state.readings = { ...healthy, battery: null, mainsOnline: false }
    await desktop.advance(0); await desktop.advance(60)
    expect(desktop.state.sent).toEqual([])
  })

  it('never runs two checks at once: a sweep that meets a running check joins it', async () => {
    const { state, watch } = world()
    const first = watch.sweep()
    const second = watch.sweep()
    expect(second).toBe(first)
    await first
    expect(state.checks).toBe(1)
  })

  it('stores kinds, times and counts only: no reading, host name or message text', async () => {
    const { state, store, advance } = world()
    state.readings = unplugged
    await advance(0)
    expect(store.value).toEqual({
      version: 1, sent: ['mains-offline'], sentAt: state.now.toISOString(), cpuHotStreak: 0, batteryAtStart: true, offAt: null, offDeadline: null
    })
    expect(JSON.stringify(store.value)).not.toMatch(/synthetic-host|Mains|80|°C/)
  })

  it('starts over from an unreadable stored state', async () => {
    const { state, advance } = world('2026-03-10T10:00:00', { value: { version: 1, sent: ['a secret sentence'], sentAt: null } })
    state.readings = unplugged
    await advance(0)
    expect(state.sent).toHaveLength(1)
  })
})

describe('the switch-off time', () => {
  it('switches the watch off at the time on the same day, says so once and never switches back on', async () => {
    const { state, watch, store, advance } = world('2026-03-10T19:00:00')
    state.settings = { enabled: true, offAt: '20:00' }
    await watch.configure()
    state.readings = unplugged
    await advance(0)
    expect(state.sent).toHaveLength(1)
    await advance(59 * 60)
    expect(state.turnedOff).toBe(0)
    await advance(60)
    expect(state.turnedOff).toBe(1)
    expect(state.settings).toEqual({ enabled: false, offAt: null })
    expect(state.sent.at(-1)).toContain('Health alerts are off')
    const sent = state.sent.length
    await advance(60); await advance(86_400)
    expect(state.sent).toHaveLength(sent)
    expect(state.turnedOff).toBe(1)
    expect(store.value).toMatchObject({ sent: [], offAt: null, offDeadline: null })
  })

  it('judges the time against the moment of the save, however long a running check makes the save wait', async () => {
    const { state, watch, store, advance } = world('2026-03-10T19:58:00')
    await advance(0)
    let release = (): void => {}
    state.hold = new Promise<void>(resolve => { release = resolve })
    state.now = new Date('2026-03-10T19:59:30')
    const running = watch.sweep()
    // The owner saves 20:00 five seconds before it; the check is still reading.
    state.settings = { enabled: true, offAt: '20:00' }
    const saved = watch.configure(new Date('2026-03-10T19:59:55'))
    state.now = new Date('2026-03-10T20:00:05')
    release()
    await running; await saved
    expect(store.value).toMatchObject({ offAt: '20:00', offDeadline: new Date('2026-03-10T20:00:00').toISOString() })
    await advance(0)
    expect(state.turnedOff).toBe(1)
  })

  it('reads a time already past when saved as that time tomorrow', async () => {
    const { state, watch, advance } = world('2026-03-10T21:00:00')
    state.settings = { enabled: true, offAt: '20:00' }
    await watch.configure()
    await advance(60); await advance(22 * 3600)
    expect(state.turnedOff).toBe(0)
    await advance(3600)
    expect(state.turnedOff).toBe(1)
  })

  it('holds across midnight and across a restart that reads the same setting again', async () => {
    const first = world('2026-03-10T23:30:00')
    first.state.settings = { enabled: true, offAt: '00:30' }
    await first.watch.configure()
    await first.advance(60)
    const second = world('2026-03-11T00:10:00', first.store)
    second.state.settings = { enabled: true, offAt: '00:30' }
    await second.watch.configure()
    await second.advance(0)
    expect(second.state.turnedOff).toBe(0)
    await second.advance(20 * 60)
    expect(second.state.turnedOff).toBe(1)
  })

  it('switches off at the first sweep after a time BMN was closed across', async () => {
    const first = world('2026-03-10T19:00:00')
    first.state.settings = { enabled: true, offAt: '20:00' }
    await first.watch.configure()
    const second = world('2026-03-11T09:00:00', first.store)
    second.state.settings = { enabled: true, offAt: '20:00' }
    second.state.ready = false
    await second.watch.configure()
    await second.advance(0)
    expect(second.state.turnedOff).toBe(1)
    expect(second.state.sent).toEqual([])
    expect(second.store.value).toEqual({ version: 1, sent: [], sentAt: null, cpuHotStreak: 0, batteryAtStart: null, offAt: null, offDeadline: null, offNoticeOwed: true })
  })

  it('owes "Health alerts are off" until Telegram can send it, across a restart, and sends it once', async () => {
    const first = world('2026-03-10T19:59:00')
    first.state.settings = { enabled: true, offAt: '20:00' }
    await first.watch.configure()
    first.state.ready = false
    await first.advance(60)
    expect(first.state.turnedOff).toBe(1)
    await first.advance(30)
    expect(first.state.sent).toEqual([])
    // BMN restarts with the watch off: the saved settings are read again, and the notice is still owed.
    const second = world('2026-03-10T21:00:00', first.store)
    second.state.settings = { enabled: false, offAt: null }
    second.state.ready = false
    await second.watch.configure()
    await second.advance(30)
    expect(second.state.sent).toEqual([])
    second.state.ready = true
    await second.advance(30)
    expect(second.state.sent).toEqual(['<b>Health alerts are off</b>\n<i>The switch-off time you set has come.</i>'])
    await second.advance(30); await second.advance(86_400)
    expect(second.state.sent).toHaveLength(1)
    expect(second.state.checks).toBe(0)
    expect(second.store.value).toEqual({ version: 1, sent: [], sentAt: null, cpuHotStreak: 0, batteryAtStart: null, offAt: null, offDeadline: null })
  })

  it('tries the switch-off notice again after a send that definitely failed, and not after one that may have arrived', async () => {
    const refused = world('2026-03-10T19:59:00')
    refused.state.settings = { enabled: true, offAt: '20:00' }
    await refused.watch.configure()
    await refused.advance(30)
    refused.state.failure = new TelegramConnectorError('http', 'Too many requests', 429)
    await refused.advance(30)
    expect(refused.state.turnedOff).toBe(1)
    expect(refused.state.sent.filter(text => text.includes('Health alerts are off'))).toEqual([])
    await refused.advance(30)
    expect(refused.state.sent.filter(text => text.includes('Health alerts are off'))).toHaveLength(1)

    const lost = world('2026-03-10T19:59:00')
    lost.state.settings = { enabled: true, offAt: '20:00' }
    await lost.watch.configure()
    await lost.advance(30)
    lost.state.failure = new TelegramConnectorError('network', 'The answer never came')
    await lost.advance(30)
    await lost.advance(30); await lost.advance(600)
    expect(lost.state.sent.filter(text => text.includes('Health alerts are off'))).toEqual([])
    expect(lost.store.value).not.toHaveProperty('offNoticeOwed')
  })

  it('drops an owed switch-off notice when the owner switches the watch on again first', async () => {
    const { state, watch, store, advance } = world('2026-03-10T19:59:00')
    state.settings = { enabled: true, offAt: '20:00' }
    await watch.configure()
    state.ready = false
    await advance(60)
    expect(store.value).toMatchObject({ offNoticeOwed: true })
    state.settings = { enabled: true, offAt: null }
    await watch.configure()
    expect(store.value).not.toHaveProperty('offNoticeOwed')
    state.ready = true
    await advance(60); await advance(60)
    expect(state.sent.filter(text => text.includes('Health alerts are off'))).toEqual([])
  })

  it('forgets everything when the owner switches the watch off, so the next switch-on starts fresh', async () => {
    const { state, watch, store, advance } = world('2026-03-10T19:00:00')
    state.settings = { enabled: true, offAt: '20:00' }
    await watch.configure()
    state.readings = unplugged
    await advance(0)
    state.settings = { enabled: false, offAt: null }
    await watch.configure()
    expect(store.value).toEqual({ version: 1, sent: [], sentAt: null, cpuHotStreak: 0, batteryAtStart: null, offAt: null, offDeadline: null })
    state.settings = { enabled: true, offAt: null }
    await watch.configure()
    await advance(60)
    expect(state.sent).toHaveLength(2)
    expect(state.sent[1]).toContain('Health alert')
  })

  it('drops the moment when the time is cleared and moves it when the time changes', async () => {
    const { state, watch, store } = world('2026-03-10T19:00:00')
    state.settings = { enabled: true, offAt: '20:00' }
    await watch.configure()
    expect(store.value).toMatchObject({ offAt: '20:00', offDeadline: new Date('2026-03-10T20:00:00').toISOString() })
    state.settings = { enabled: true, offAt: '18:00' }
    await watch.configure()
    expect(store.value).toMatchObject({ offAt: '18:00', offDeadline: new Date('2026-03-11T18:00:00').toISOString() })
    state.settings = { enabled: true, offAt: null }
    await watch.configure()
    expect(store.value).toMatchObject({ offAt: null, offDeadline: null })
  })

  it('works out the next local time', () => {
    expect(nextLocalTime(new Date('2026-03-10T19:59:59'), '20:00')).toEqual(new Date('2026-03-10T20:00:00'))
    expect(nextLocalTime(new Date('2026-03-10T20:00:00'), '20:00')).toEqual(new Date('2026-03-11T20:00:00'))
    expect(nextLocalTime(new Date('2026-12-31T23:59:00'), '00:00')).toEqual(new Date('2027-01-01T00:00:00'))
  })
})

describe('the message', () => {
  const at = new Date('2026-03-10T07:05:00')

  it('holds a title, the local time and host, each problem with its advice, and every reading', () => {
    const text = buildHealthMessage('alert', { ...unplugged, cpuC: 101, nvidiaGpuC: 70 }, ['cpu-critical', 'mains-offline'], 1, at, 'synthetic-host')
    expect(text.split('\n').slice(0, 2)).toEqual(['<b>Health alert</b>', '<i>07:05 · synthetic-host</i>'])
    expect(text).toContain('• CPU at 101 °C, at its limit\n   <i>Stop the job or suspend the machine now.</i>')
    expect(text).toContain('• Mains power lost, on battery at 80%\n   <i>A power cut or a charger fault; the battery will run out.</i>')
    expect(text).toContain('<pre>CPU            101 °C\nNVIDIA GPU     70 °C\nIntegrated GPU 58 °C\nDrive          45 °C\nBattery        80% Discharging\nVoltage        11.6 V\nMains          OFF</pre>')
  })

  it('shows a missing reading as not measured, never as fine', () => {
    const text = buildHealthMessage('test', { cpuC: null, integratedGpuC: null, driveC: null, nvidiaGpuC: null, battery: null, mainsOnline: null }, ['cpu-unreadable'], 0, at, 'h')
    expect(text).toContain('<b>Health alerts: test</b>')
    expect(text).toContain('A real check would alert now.')
    expect(text).toContain('CPU            not measured')
    expect(text).toContain('Battery        none')
    expect(text).toContain('Mains          not measured')
  })

  it('escapes the host name and fits one message', () => {
    const text = buildHealthMessage('clear', healthy, [], 0, at, `<b>&${'x'.repeat(500)}\n`)
    expect(text).toContain('<i>07:05 · &lt;b&gt;&amp;xxx')
    expect(text).not.toContain('<b>&x')
    expect(text.length).toBeLessThan(4096)
    expect(text.split('\n')[1]!.length).toBeLessThan(120)
  })

  it('marks a test and changes no stored state when one is sent', async () => {
    const { state, watch, store } = world()
    state.readings = unplugged
    await watch.sendTest()
    expect(state.sent[0]).toContain('Health alerts: test')
    expect(state.sent[0]).toContain('Mains power lost')
    expect(store.value).toBeUndefined()
    expect(state.writes).toBe(0)
  })

  it('answers a test as the watch\'s next check would: a machine that started without a battery is not judged on one', async () => {
    const { state, watch, store, advance } = world()
    state.readings = { ...healthy, battery: null }
    await advance(0)
    const before = JSON.stringify(store.value)
    const writes = state.writes
    state.readings = unplugged
    await watch.sendTest()
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0]).toContain('A real check would find nothing wrong.')
    expect(state.sent[0]).not.toContain('Mains power lost')
    // The readings are shown as they are; nothing stored moved.
    expect(state.sent[0]).toContain('Mains          OFF')
    expect(JSON.stringify(store.value)).toBe(before)
    expect(state.writes).toBe(writes)
    // And the next real check agrees with the test.
    await advance(60)
    expect(state.sent).toHaveLength(1)
  })

  it('says so in a test when no reading could tell whether the machine has a battery, and shows it as not measured', async () => {
    const unknown: HealthReadings = { ...healthy, battery: { present: null, percent: null, status: null, millivolts: null, cells: null }, mainsOnline: false }
    const { state, watch, store, advance } = world()
    state.readings = unknown
    await watch.sendTest()
    expect(state.sent[0]).toContain('A real check would find nothing wrong in what it can read.')
    expect(state.sent[0]).toContain('Battery and mains are not checked yet: whether this machine has a battery could not be read.')
    expect(state.sent[0]).not.toContain('A real check would find nothing wrong.')
    expect(state.sent[0]).toContain('Battery        not measured')
    expect(state.sent[0]).not.toContain('Battery        none')
    expect(state.sent[0]).not.toContain('Mains power lost')
    expect(store.value).toBeUndefined()
    // The watch itself says nothing on the same reading, and keeps the question open.
    await advance(0)
    expect(state.sent).toHaveLength(1)
    expect((store.value as { batteryAtStart?: unknown } | undefined)?.batteryAtStart ?? null).toBeNull()
    // A problem found elsewhere is still said plainly, with the open question beside it.
    state.readings = { ...unknown, driveC: 90 }
    await watch.sendTest()
    expect(state.sent[1]).toContain('A real check would alert now.')
    expect(state.sent[1]).toContain('Battery and mains are not checked yet')
    // A watched battery that stops saying it is present is a problem, shown as not measured.
    const laptop = world()
    await laptop.advance(0)
    laptop.state.readings = { ...healthy, battery: unknown.battery }
    await laptop.watch.sendTest()
    expect(laptop.state.sent[0]).toContain('A real check would alert now.')
    expect(laptop.state.sent[0]).toContain('Battery no longer detected')
    expect(laptop.state.sent[0]).not.toContain('not checked yet')
  })
})
