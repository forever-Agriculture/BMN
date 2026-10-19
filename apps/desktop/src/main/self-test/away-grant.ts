// MODULE: away-grant.ts - Electron self-test for the Away grant: a departure from the CLI, cards asked over the socket, answered in the window and on the fake Telegram, and every grant ended at Back (Story 84.3)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { METHOD_REGISTRY, type AppSettings, type ControlInfo, type OwnerAwayView, type OwnerGrantView, type TelegramStatus } from '@bmn/protocol'
import type { SelfTestHost } from '../index'
import type { PtyHostClient } from '../pty-host-client'
import { SELF_TEST_TELEGRAM_CHAT_ID, type SelfTestRecorder } from './taps'

const TERMS = [
  { kind: 'rounds', proposed: 3, reason: 'two review boundaries are ahead' },
  { kind: 'merge', id: 'merge-12', repository: 'octo/widgets', pr: 12, headSha: '3f2a9c1', upTo: 2, proposed: 'pr', reason: 'its required checks were green' },
  { kind: 'push-default', id: 'push-81', repository: 'octo/tools', branch: 'dev-auto/epic-81', proposed: 'yes', reason: 'tools takes no PRs' }
]

export async function runAwayGrantSelfTest(host: SelfTestHost, client: PtyHostClient, taps: SelfTestRecorder): Promise<object> {
  const began = Date.now()
  const phase = (name: string): void => { console.error(`[BMN] away grant step: ${name} +${Date.now() - began}ms`) }
  const window = host.applicationWindow!
  const renderer = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const until = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
    const by = Date.now() + 15000
    while (Date.now() < by) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Away grant self-test: ${label}`)
  }
  const original = (await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram
  const control = await client.request<ControlInfo>(METHOD_REGISTRY.controlInfo, {})
  // `bmn grant`, like `bmn policy`, takes its credentials after the command.
  const owner = ['--owner', '--socket', control.socketPath]
  const cli = (args: string[], input?: string): string =>
    execFileSync(control.cliPath, args[0] === 'grant' ? [...args, ...owner] : [...owner, ...args], { encoding: 'utf8', ...(input === undefined ? {} : { input }) })
  const ask = (runId: string, title: string, terms: unknown[] = TERMS): void => {
    cli(['grant', 'ask', '--run', runId, '--card-file', '-'], JSON.stringify({ title, scope: 'Stories 80.2-80.6', terms }))
  }
  const grant = (): Promise<OwnerGrantView> => renderer<OwnerGrantView>('window.aiTerminal.getGrant()')
  const run = async (runId: string) => (await grant()).period?.runs.find(other => other.runId === runId)
  const bot = await taps.telegram()
  const texts = (from: number, method: 'sendMessage' | 'editMessageText'): string[] =>
    bot.calls.slice(from).filter(call => call.method === method).map(call => String(call.body.text))
  try {
    phase('configure')
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...original, enabled: true, allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null } })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' })
    await until(async () => (await client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})).state === 'polling' ? true : undefined, 'fake connector')
    await client.request(METHOD_REGISTRY.presenceSet, { away: false })

    phase('leaving')
    const start = bot.calls.length
    const leaving = cli(['away', '--leaving'])
    assert.match(leaving, /^Leaving since /)
    assert.equal((await renderer<OwnerAwayView>('window.aiTerminal.getAway()')).state, 'back', 'leaving is not away')
    assert.match(cli(['grant']), /^The owner is leaving since /)
    ask('run-desk', 'Run at the desk', [TERMS[0]])
    const desk = await until(async () => { const found = await run('run-desk'); return found?.card.state === 'open' ? found : undefined }, 'card in the window')
    assert.equal((await grant()).openCards, 1)
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.ok(!texts(start, 'sendMessage').some(text => text.includes('Run at the desk')), 'a leaving card waits at the desk')

    phase('window answer')
    const period = (await grant()).period!
    const answered = await renderer<{ outcome: string }>(`window.aiTerminal.answerGrant(${JSON.stringify({ periodId: period.periodId, runId: 'run-desk', cardRevision: desk.card.revision, choices: { rounds: 2 }, operationKey: 'self-test-desk' })})`)
    assert.equal(answered.outcome, 'granted')
    assert.match(cli(['grant', '--run', 'run-desk']), /Extra repair rounds: 2 per boundary; none used\./)
    const stale = await renderer<{ outcome: string; reason?: string }>(`window.aiTerminal.answerGrant(${JSON.stringify({ periodId: period.periodId, runId: 'run-desk', cardRevision: desk.card.revision, choices: { rounds: 4 }, operationKey: 'self-test-desk-2' })})`)
    assert.deepEqual([stale.outcome, stale.reason], ['refused', 'answered'])
    // A use is the run's own record: the owner's token cannot make one (the unit tests record uses from a session).
    assert.throws(() => cli(['grant', 'use', '--run', 'run-desk', '--use-id', 'u-1', '--boundary', '80.3']), /Only a session's agent records a use/)

    phase('phone walk')
    const phone = bot.calls.length
    ask('run-phone', 'Run on the phone')
    bot.tapOn('Run on the phone', [{ tap: 'Choose…' }, { tap: '4' }, { tap: 'No' }, { tap: '● Yes' }])
    const away = await renderer<OwnerAwayView>("window.aiTerminal.setAway('away')")
    assert.equal(away.state, 'away')
    const walked = await until(async () => { const found = await run('run-phone'); return found?.card.state === 'answered' ? found : undefined }, 'answered from Telegram')
    assert.equal(walked.answer?.via, 'telegram')
    assert.deepEqual(walked.answer?.choices, { rounds: 4, 'merge-12': 'no', 'push-81': 'yes' })
    assert.ok(texts(phone, 'sendMessage').some(text => text.includes('Before you go · asked') && text.includes('1. Extra repair rounds per boundary: 3')), 'the overview went at Away')
    assert.ok(texts(phone, 'editMessageText').some(text => text.includes('Before you go · 3 of 3') && text.includes('Nothing is granted until this answer.')), 'the walk reached its last step')
    await until(async () => texts(phone, 'editMessageText').some(text => text.includes('✓ Granted until you are back: 4 rounds per boundary · push to the default branch in tools. Not granted: merge PR 12 at 3f2a9c1.')) ? true : undefined, 'the phone ending')
    const status = cli(['grant', '--run', 'run-phone'])
    assert.match(status, /answered on Telegram/)
    assert.match(status, /Not granted: item merge-12/)

    phase('typed reply and the laptop answer')
    const typed = bot.calls.length
    ask('run-typed', 'Run typed to', [TERMS[2]])
    bot.tapOn('Run typed to', [{ reply: 'yes please' }])
    await until(async () => texts(typed, 'sendMessage').includes('Answer this card with its buttons.') ? true : undefined, 'the typed-reply rule')
    const typedRun = (await run('run-typed'))!
    assert.equal(typedRun.card.state, 'open', 'a typed reply grants nothing')
    await renderer(`window.aiTerminal.answerGrant(${JSON.stringify({ periodId: period.periodId, runId: 'run-typed', cardRevision: typedRun.card.revision, choices: { 'push-81': 'yes' }, operationKey: 'self-test-typed' })})`)
    await until(async () => texts(typed, 'editMessageText').some(text => text.includes('Answered at the laptop: granted push to the default branch in tools.')) ? true : undefined, 'the laptop answer on the phone')

    phase('back')
    const back = bot.calls.length
    ask('run-open', 'Run left open', [TERMS[0]])
    await until(async () => texts(back, 'sendMessage').some(text => text.includes('Run left open')) ? true : undefined, 'the open card sent')
    await renderer("window.aiTerminal.setAway('back')")
    await until(async () => texts(back, 'editMessageText').some(text => text.includes('Withdrawn: you are back.')) ? true : undefined, 'withdrawn at Back')
    await until(async () => texts(back, 'editMessageText').some(text => /Ended .*: you are back\./.test(text)) ? true : undefined, 'answered cards ended at Back')
    assert.match(cli(['grant', '--run', 'run-phone']), /^No grant for run run-phone: /)
    assert.equal((await grant()).openCards, 0)
    return { leavingHeld: true, windowAnswer: true, alreadyAnswered: true, ownerUseRefused: true, phoneWalk: true, typedReply: true, laptopAnswerOnPhone: true, withdrawnAtBack: true, grantsEnded: true }
  } finally {
    phase('cleanup')
    await client.request(METHOD_REGISTRY.presenceSet, { away: null }).catch(() => undefined)
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: original })
  }
}
