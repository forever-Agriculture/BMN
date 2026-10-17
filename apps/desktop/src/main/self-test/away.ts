// MODULE: away.ts - Electron self-test for the one away state: set and ended from the app, the CLI and Telegram through the fake Bot API, every surface reading the same record (Story 76.3, 76.6 AC4)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { METHOD_REGISTRY, type AppSettings, type ControlInfo, type OwnerAwayView, type TelegramStatus } from '@bmn/protocol'
import type { SelfTestHost } from '../index'
import type { PtyHostClient } from '../pty-host-client'
import { SELF_TEST_TELEGRAM_CHAT_ID, type SelfTestRecorder } from './taps'

export async function runAwaySelfTest(host: SelfTestHost, client: PtyHostClient, taps: SelfTestRecorder): Promise<object> {
  const began = Date.now()
  const phase = (name: string): void => { console.error(`[BMN] away step: ${name} +${Date.now() - began}ms`) }
  const window = host.applicationWindow!
  const renderer = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const until = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
    const by = Date.now() + 15000
    while (Date.now() < by) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Away self-test: ${label}`)
  }
  const original = (await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram
  const control = await client.request<ControlInfo>(METHOD_REGISTRY.controlInfo, {})
  // The CLI runs as the executable it is: a Node script in a checkout, a shell launcher in a packaged build.
  const cli = (...args: string[]): string =>
    execFileSync(control.cliPath, ['--owner', '--socket', control.socketPath, ...args], { encoding: 'utf8' })
  const shown = (): Promise<OwnerAwayView> => renderer<OwnerAwayView>('window.aiTerminal.getAway()')
  const bot = await taps.telegram()
  const sent = (from: number): string[] => bot.calls.slice(from).filter(call => call.method === 'sendMessage').map(call => String(call.body.text))
  try {
    phase('configure')
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...original, enabled: true, allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null } })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' })
    await until(async () => (await client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})).state === 'polling' ? true : undefined, 'fake connector')

    phase('app')
    const fromApp = await renderer<OwnerAwayView>("window.aiTerminal.setAway('away', 'self-test note')")
    assert.equal(fromApp.state, 'away'); assert.equal(fromApp.source, 'app'); assert.equal(fromApp.note, 'self-test note')
    const appBack = await renderer<OwnerAwayView>("window.aiTerminal.setAway('back')")
    assert.equal(appBack.state, 'back'); assert.equal(appBack.endedBy, 'app')

    phase('cli')
    const cliAway = JSON.parse(cli('away', '--json')) as OwnerAwayView
    assert.equal(cliAway.state, 'away'); assert.equal(cliAway.source, 'cli')
    assert.equal((await shown()).revision, cliAway.revision)
    const cliBack = JSON.parse(cli('back', '--json')) as OwnerAwayView
    assert.equal(cliBack.state, 'back'); assert.equal(cliBack.endedBy, 'cli')
    assert.equal((await shown()).state, 'back')

    phase('telegram')
    const from = bot.calls.length
    bot.say('/away train to Kyiv')
    const phoneAway = await until(async () => { const view = await shown(); return view.state === 'away' && view.source === 'telegram' ? view : undefined }, '/away from Telegram')
    assert.equal(phoneAway.note, 'train to Kyiv')
    await until(async () => sent(from).some(text => /^Away since .*Note kept on the laptop\./.test(text)) ? true : undefined, '/away reply')
    assert.ok(!sent(from).some(text => text.includes('train to Kyiv')), 'the reply never echoes the note')
    bot.say('/back')
    await until(async () => (await shown()).state === 'back' ? true : undefined, '/back from Telegram')
    const backReply = await until(async () => sent(from).find(text => text.startsWith('Back. Away ')), '/back reply')
    assert.match(backReply, /(Nothing waits on you\.|Waiting on you\n)/)
    assert.equal((await shown()).endedBy, 'telegram')

    phase('summary')
    const payload = await renderer<{ away: OwnerAwayView; decisions: unknown; activity: unknown }>('window.aiTerminal.awaySummary()')
    assert.equal(payload.away.periodId, (await shown()).periodId)
    assert.ok(payload.decisions !== null && payload.activity !== null)
    return { app: true, cli: true, telegramAway: true, telegramBack: true, noteNotEchoed: true, backReply: backReply.split('\n')[0], summaryRead: true }
  } finally {
    phase('cleanup')
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: original })
  }
}
