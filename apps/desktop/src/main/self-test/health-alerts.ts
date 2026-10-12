// MODULE: health-alerts.ts - Electron self-test of the health watch: a fixture sensor tree, a fake Bot API, one alert and one all-clear
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { METHOD_REGISTRY, type AppSettings, type TelegramStatus } from '@bmn/protocol'
import type { SelfTestHost } from '../index'
import type { PtyHostClient } from '../pty-host-client'
import { SELF_TEST_TELEGRAM_CHAT_ID, type SelfTestRecorder } from './taps'

/** Where the self-test host reads sensors: a tree this phase writes, never the machine's own. */
export function selfTestSysfsRoot(): string | undefined {
  return process.env.BMN_STATE_HOME ? join(process.env.BMN_STATE_HOME, 'health-sysfs') : undefined
}

export async function runHealthAlertsSelfTest(host: SelfTestHost, client: PtyHostClient, taps: SelfTestRecorder): Promise<object> {
  const root = selfTestSysfsRoot()!
  const file = (path: string, value: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), `${value}\n`)
  }
  const sensors = (driveMilli: number): void => {
    file('class/hwmon/hwmon3/name', 'k10temp'); file('class/hwmon/hwmon3/temp1_input', '61000')
    file('class/hwmon/hwmon1/name', 'nvme'); file('class/hwmon/hwmon1/temp1_input', String(driveMilli))
    file('class/power_supply/ADP0/type', 'Mains'); file('class/power_supply/ADP0/online', '1')
    file('class/power_supply/BAT0/type', 'Battery'); file('class/power_supply/BAT0/present', '1')
    file('class/power_supply/BAT0/capacity', '77'); file('class/power_supply/BAT0/status', 'Charging')
    file('class/power_supply/BAT0/voltage_now', '11600000'); file('class/power_supply/BAT0/voltage_min_design', '11400000')
    // An awake NVIDIA card: the self-test host answers the question with a failure, so it reads "not measured".
    file('bus/pci/devices/0000:01:00.0/vendor', '0x10de'); file('bus/pci/devices/0000:01:00.0/class', '0x030000')
    file('bus/pci/devices/0000:01:00.0/power/runtime_status', 'active')
  }
  sensors(45_000)
  const original = (await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram
  const bot = await taps.telegram(), window = host.applicationWindow!
  const renderer = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const clock = (value: string | null): Promise<{ health?: unknown }> =>
    client.request(METHOD_REGISTRY.healthGet, { selfTestQuietClock: value === null ? null : new Date(value).toISOString() })
  const connected = async (): Promise<void> => {
    const by = Date.now() + 15_000
    while (Date.now() < by) {
      if ((await client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})).state === 'polling') return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Health alerts self-test: fake connector')
  }
  const from = bot.calls.length
  const sends = (): Array<{ text: string; html: boolean }> => bot.calls.slice(from).filter(call => call.method === 'sendMessage')
    .map(call => ({ text: String(call.body.text), html: call.body.parse_mode === 'HTML' }))
  // Quiet hours cover the whole run: a health alert is sent anyway.
  const base = { ...original, enabled: true, allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null, notifyOn: 'attention' as const,
    quietHours: { enabled: true, start: '09:00', end: '23:00', allowKinds: [], allowSessions: [] }, morningDigest: { enabled: false, time: '08:00' } }
  try {
    await clock('2001-02-05T10:00:00')
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...base, healthAlerts: { enabled: false, offAt: null } } })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' }); await connected()
    // Off: a reading over its limit is not read and not told.
    sensors(90_000)
    await clock('2001-02-05T10:02:00')
    assert.equal(sends().length, 0, 'the watch spoke while off')
    sensors(45_000)

    // The row's values save and come back through the window's own bridge.
    const saved = await renderer<AppSettings>(`(async () => {
      const settings = await window.aiTerminal.getSettings()
      return window.aiTerminal.putSettings('telegram', { ...settings.telegram, healthAlerts: { enabled: true, offAt: '12:00' } })
    })()`)
    assert.deepEqual(saved.telegram.healthAlerts, { enabled: true, offAt: '12:00' })
    assert.deepEqual((await renderer<AppSettings>('window.aiTerminal.getSettings()')).telegram.healthAlerts, { enabled: true, offAt: '12:00' })
    await connected()

    await clock('2001-02-05T10:03:00'); await clock('2001-02-05T10:04:00')
    assert.equal(sends().length, 0, 'the watch spoke about a healthy machine')

    sensors(81_000)
    await clock('2001-02-05T10:05:00')
    assert.equal(sends().length, 1, 'a reading over its limit sent no alert, or more than one')
    const alert = sends()[0]!
    assert.ok(alert.html); assert.match(alert.text, /<b>Health alert<\/b>/); assert.match(alert.text, /Drive at 81 °C/)
    assert.match(alert.text, /NVIDIA GPU\s+not measured/); assert.match(alert.text, /10:05/)
    sensors(84_000)
    const during = await clock('2001-02-05T10:06:00')
    assert.equal(sends().length, 1, 'a wobbling reading sent again')

    // The test message reports the readings and leaves the stored state as it was.
    await client.request(METHOD_REGISTRY.telegramHealthTest, {})
    assert.equal(sends().length, 2); assert.match(sends()[1]!.text, /Health alerts: test/); assert.match(sends()[1]!.text, /A real check would alert now\./)
    assert.deepEqual((await clock('2001-02-05T10:06:30')).health, during.health)

    sensors(45_000)
    const cleared = await clock('2001-02-05T10:07:00')
    assert.equal(sends().length, 3); assert.match(sends()[2]!.text, /<b>Back to normal<\/b>/)
    await clock('2001-02-05T10:08:00')
    assert.equal(sends().length, 3, 'the all-clear was sent twice')

    // Kinds, times and counts only.
    const stored = JSON.stringify(during.health)
    assert.match(stored, /"sent":\["drive-hot"\]/)
    assert.ok(!/Drive|°C|Health|normal|81|84/.test(stored), 'the stored state holds message text or a reading')
    assert.deepEqual(Object.keys(cleared.health as object).sort(), ['batteryAtStart', 'cpuHotStreak', 'offAt', 'offDeadline', 'sent', 'sentAt', 'version'])

    // The switch-off time: the watch saves itself as off, clears the time and says so once.
    await clock('2001-02-05T11:59:00')
    assert.deepEqual((await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram.healthAlerts, { enabled: true, offAt: '12:00' })
    await clock('2001-02-05T12:00:10')
    assert.deepEqual((await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram.healthAlerts, { enabled: false, offAt: null })
    assert.equal(sends().length, 4); assert.match(sends()[3]!.text, /Health alerts are off/)
    sensors(90_000)
    await clock('2001-02-05T12:05:00'); await clock('2001-02-06T12:00:10')
    assert.equal(sends().length, 4, 'the watch spoke or switched itself back on after its switch-off time')
    return { offSends: 0, healthySends: 0, alerts: 1, wobbleResends: 0, testMessages: 1, allClears: 1, sentInQuietHours: true,
      storedText: false, rowSavedAndReloaded: true, switchedItselfOff: true, offMessages: 1 }
  } finally {
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: original }); await clock(null)
  }
}
