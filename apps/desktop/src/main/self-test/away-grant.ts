// MODULE: away-grant.ts - Electron self-test for the Away grant: a departure from the CLI, cards asked over the socket, answered in the window and on the fake Telegram, and every grant ended at Back (Story 84.3)
import assert from 'node:assert/strict'
import { MessageChannelMain } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import type { DatabaseConnection } from '../../utility/database-initialization'
import { GRANT_RECORD_KEY, METHOD_REGISTRY, type AppSettings, type ControlInfo, type OwnerAwayView, type OwnerDepartureReply, type OwnerGrantView, type TelegramStatus } from '@bmn/protocol'
import type { SelfTestHost } from '../index'
import type { PtyHostClient } from '../pty-host-client'
import { SELF_TEST_TELEGRAM_CHAT_ID, type SelfTestRecorder } from './taps'
import { waitForRendererLoad } from './probes'
import { checkDeparturePresentation, refocusWindow } from './departure-presentation'
import { seedNightPlan } from '../../../../../scripts/test/night-grant-fixture.mjs'

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
  const until = async <T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 15000): Promise<T> => {
    const by = Date.now() + timeoutMs
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
  let second: ReturnType<SelfTestHost['createWindow']> | undefined
  let answerSyncMs: number
  let goSyncMs: number
  const secondRenderer = <T>(code: string): Promise<T> => second!.webContents.executeJavaScript(code)
  const texts = (from: number, method: 'sendMessage' | 'editMessageText'): string[] =>
    bot.calls.slice(from).filter(call => call.method === method).map(call => String(call.body.text))
  try {
    phase('configure')
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...original, enabled: true, allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null } })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' })
    await until(async () => (await client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})).state === 'polling' ? true : undefined, 'fake connector')
    await client.request(METHOD_REGISTRY.presenceSet, { away: false })

    phase('one actual presentation across a focus handoff')
    const channel = new MessageChannelMain()
    client.attachTerminalPort(channel.port1)
    second = host.createWindow(await host.loadApplicationStartup(true), { forceHidden: true, terminalPort: channel.port2 })
    await waitForRendererLoad(second)
    const presentation = await checkDeparturePresentation(client, window, second, cli)
    phase(`presentation proof ${JSON.stringify(presentation)}`)

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
    assert.ok(texts(start, 'sendMessage').some(text => text.includes('Run at the desk')), 'a getting-ready card goes immediately')
    assert.equal(texts(start, 'sendMessage').filter(text => text.startsWith('Before you go · getting ready')).length, 1, 'one shared head')

    phase('second real renderer')
    await until(async () => await secondRenderer<boolean>('Boolean(document.querySelector("button.away-grant"))') ? true : undefined, 'second window departure head')
    const secondOpenAt = Date.now()
    await secondRenderer('document.querySelector("button.away-grant").click()')
    await until(async () => await secondRenderer<boolean>("Boolean(document.querySelector('article[data-run-id=\"run-desk\"]'))") && Date.parse((await grant()).period!.collection!.autoAwayAt) >= secondOpenAt + 600_000 ? true : undefined, 'second window list opened against the current revision')

    phase('window answer')
    const period = (await grant()).period!
    const answerAt = Date.now()
    const answered = await renderer<{ outcome: string }>(`window.aiTerminal.answerGrant(${JSON.stringify({ periodId: period.periodId, runId: 'run-desk', cardRevision: desk.card.revision, choices: { rounds: 2 }, expectedRevision: (await grant()).revision, operationKey: 'self-test-desk' })})`)
    assert.equal(answered.outcome, 'granted')
    await until(async () => await secondRenderer<boolean>("document.querySelector('article[data-run-id=\"run-desk\"] .grant-line-seen')?.textContent?.startsWith(\"2 \u00b7 answered\") === true") ? true : undefined, 'the answer drawn in the second window', 1000)
    answerSyncMs = Date.now() - answerAt
    assert.ok(answerSyncMs <= 1000, `Second-window answer took ${answerSyncMs}ms`)

    assert.match(cli(['grant', '--run', 'run-desk']), /Extra repair rounds: 2 per boundary; none used\./)
    const stale = await renderer<{ outcome: string; reason?: string }>(`window.aiTerminal.answerGrant(${JSON.stringify({ periodId: period.periodId, runId: 'run-desk', cardRevision: desk.card.revision, choices: { rounds: 4 }, expectedRevision: 0, operationKey: 'self-test-desk-2' })})`)
    assert.deepEqual([stale.outcome, stale.reason], ['refused', 'stale'])
    // A use is the run's own record: the owner's token cannot make one (the unit tests record uses from a session).
    assert.throws(() => cli(['grant', 'use', '--run', 'run-desk', '--use-id', 'u-1', '--boundary', '80.3']), /Only a session's agent records a use/)

    phase('phone walk')
    const phone = bot.calls.length
    ask('run-phone', 'Run on the phone')
    bot.tapOn('Run on the phone', [{ tap: 'Choose…' }, { tap: '4' }, { tap: 'No' }, { tap: 'Yes' }])
    const walked = await until(async () => { const found = await run('run-phone'); return found?.card.state === 'answered' ? found : undefined }, 'answered from Telegram')
    assert.equal(walked.answer?.via, 'telegram')
    assert.deepEqual(walked.answer?.choices, { rounds: 4, 'merge-12': 'no', 'push-81': 'yes' })
    assert.equal((await renderer<OwnerAwayView>('window.aiTerminal.getAway()')).state, 'back', 'phone answers do not start Away')
    assert.ok(texts(phone, 'sendMessage').some(text => text.includes('Before you go · asked') && text.includes('proposed 3')), 'the overview went while getting ready')
    assert.ok(texts(phone, 'editMessageText').some(text => text.includes('Before you go · 3 of 3') && !text.includes('Nothing is granted until this answer.')), 'each pick is saved immediately')
    const phoneAnswerAt = Date.parse(walked.answer!.at)
    await until(async () => await renderer<boolean>("document.querySelector('article[data-run-id=\"run-phone\"] .grant-line-seen')?.textContent?.startsWith('4 · answered') === true") ? true : undefined, 'phone answer drawn in the window', Math.max(1, 5000 - (Date.now() - phoneAnswerAt)))
    const phoneAnswerSyncMs = Date.now() - phoneAnswerAt
    assert.ok(phoneAnswerSyncMs <= 5000, `Phone answer reached the window in ${phoneAnswerSyncMs}ms`)
    phase('phone proposal bulk preserves the saved line')
    // Bind the simulated phone to the outgoing card. Its Grant button appears only after one line is saved.
    bot.tapOn('Run partial on the phone', [{ tap: 'Grant' }])
    ask('run-partial', 'Run partial on the phone', [TERMS[0], TERMS[2]])
    const partialView = await until(async () => {
      const view = await grant()
      return view.period?.runs.find(item => item.runId === 'run-partial')?.phone ? view : undefined
    }, 'partial phone overview saved')
    const firstPick = await renderer<{ outcome: string }>(`window.aiTerminal.answerGrant(${JSON.stringify({ periodId: partialView.period!.periodId, runId: 'run-partial', cardRevision: 1, choices: { rounds: 4 }, expectedRevision: partialView.revision, operationKey: 'self-test-partial-four' })})`)
    assert.equal(firstPick.outcome, 'granted')
    const savedLine = JSON.stringify((await run('run-partial'))!.answer!.lines!.rounds)
    const partial = await until(async () => { const found = await run('run-partial'); return found?.card.state === 'answered' ? found : undefined }, 'remaining displayed phone proposal')
    assert.deepEqual(partial.answer!.choices, { rounds: 4, 'push-81': 'yes' })
    assert.equal(JSON.stringify(partial.answer!.lines!.rounds), savedLine, 'bulk preserves saved line value/source/time')
    const ready = await grant()
    const goAt = Date.now()
    await renderer(`window.aiTerminal.departure(${JSON.stringify({ action: 'go', periodId: ready.period!.periodId, expectedRevision: ready.revision, operationKey: 'self-test-go' })})`)
    assert.equal((await renderer<OwnerAwayView>('window.aiTerminal.getAway()')).state, 'away')
    await until(async () => await secondRenderer<boolean>('document.querySelector("#away-check-box")?.checked === true && document.querySelector(".grant-footer") === null') ? true : undefined, 'Go drawn in the second window', 1000)
    goSyncMs = Date.now() - goAt
    assert.ok(goSyncMs <= 1000, `Second-window Go took ${goSyncMs}ms`)

    await until(async () => texts(phone, 'editMessageText').some(text => text.includes('✓ Granted until you are back: 4 rounds per boundary · push to the default branch in tools. Not granted: merge PR 12 at 3f2a9c1.')) ? true : undefined, 'the phone ending', Math.max(1, 5000 - (Date.now() - goAt)))
    const phoneGoSyncMs = Date.now() - goAt
    assert.ok(phoneGoSyncMs <= 5000, `Go reached the phone in ${phoneGoSyncMs}ms`)
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
    const laptopAnswerAt = Date.now()
    await renderer(`window.aiTerminal.answerGrant(${JSON.stringify({ periodId: period.periodId, runId: 'run-typed', cardRevision: typedRun.card.revision, choices: { 'push-81': 'yes' }, expectedRevision: (await grant()).revision, operationKey: 'self-test-typed' })})`)
    await until(async () => texts(typed, 'editMessageText').some(text => text.includes('Answered at the laptop: granted push to the default branch in tools.')) ? true : undefined, 'the laptop answer on the phone', Math.max(1, 5000 - (Date.now() - laptopAnswerAt)))
    const laptopPhoneSyncMs = Date.now() - laptopAnswerAt
    assert.ok(laptopPhoneSyncMs <= 5000, `Laptop answer reached the phone in ${laptopPhoneSyncMs}ms`)

    phase('phone login check')
    const accessStart = bot.calls.length
    const accessCommand = 'gh auth login --hostname ' + 'sample-'.repeat(100) + 'end'
    const accessTitle = 'Synthetic login check'
    ask('run-access', accessTitle, [{ kind: 'access', id: 'login', name: 'Sample sign-in',
      command: accessCommand, reason: 'The fixture started signed out' }])
    bot.tapOn(accessTitle, [{ tap: 'Done' }])
    const access = await until(async () => (await run('run-access'))?.access?.[0], 'Done persisted from Telegram')
    assert.equal(access.item, 'login')
    assert.equal(access.outcome, null)
    assert.ok(texts(accessStart, 'sendMessage').some(text => text.includes(accessCommand)), 'the whole sign-in command reached fake Telegram')
    await until(async () => bot.calls.slice(accessStart).some(call => call.method === 'answerCallbackQuery' &&
      call.body.text === 'Check requested.') ? true : undefined, 'Done callback acknowledges the check')

    phase('phone limit approval')
    const dataHome = process.env.BMN_DATA_HOME
    assert.ok(dataHome && /^bmn-(electron-self-test|packaged-smoke)-/u.test(basename(dirname(dirname(dataHome)))),
      'the phone limit uses only the disposable self-test root')
    const project = join(dirname(dirname(dataHome)), 'phone-night-plan')
    const { written, plan } = seedNightPlan(project, control.cliPath, process.env)
    const title = 'Synthetic phone limit'
    const card = written('phone-card.json', JSON.stringify({ title, scope: 'One synthetic review boundary', terms: [
      { id: 'raise', kind: 'limit', project, epic: 7, name: 'rechecks', from: 4, to: 6, reason: 'Two checks still wait' }
    ] }))
    const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
    const script = written('phone-probe.sh', `set -eu
${shellQuote(control.cliPath)} grant ask --run phone-limit-epic-7 --card-file - < ${shellQuote(card)}
while [ ! -f begin-apply ]; do sleep 0.05; done
${shellQuote(control.cliPath)} grant apply --run phone-limit-epic-7 --item raise --use-id phone-demo --json > apply.json
touch apply-finished
`)
    await renderer(`(async () => {
      const [workspace] = await window.aiTerminal.listWorkspaces(false)
      await window.aiTerminal.createSession({ workspaceId: workspace.workspaceId, name: 'Phone limit fixture', cwd: ${JSON.stringify(project)},
        executable: '/bin/bash', argv: ['--noprofile', '--norc', ${JSON.stringify(script)}], cols: 100, rows: 24, backgroundChoice: 'stop' })
    })()`)
    const limitStart = bot.calls.length
    bot.tapOn(title, [{ tap: 'Yes' }])
    await until(async () => (await run('phone-limit-epic-7'))?.answer?.choices.raise === 'yes' ? true : undefined, 'limit Yes persisted from Telegram')
    await until(async () => texts(limitStart, 'editMessageText').some(text => /approved, waiting to write/iu.test(text)) ? true : undefined, 'pending write drawn on Telegram')
    written('begin-apply', '')
    await until(async () => existsSync(join(project, 'apply-finished')) ? true : undefined, 'the bound test session applied the Telegram approval')
    assert.equal(JSON.parse(readFileSync(join(project, 'apply.json'), 'utf8')).state, 'written')
    const allowance = plan('allowances', '7')
    assert.deepEqual(allowance.current.fields.limits.rechecks, { limit: 6, ceiling: 6, per: 'boundary', unit: 'count' })
    assert.match(allowance.changes.at(-1)!.source, /night list: Yes to .* in Telegram/u)
    await until(async () => texts(limitStart, 'editMessageText').some(text => /use bmn plan allow to lower it/iu.test(text)) ? true : undefined, 'durable write drawn on Telegram')

    phase('back')
    const back = bot.calls.length
    ask('run-open', 'Run left open', [TERMS[0]])
    await until(async () => texts(back, 'sendMessage').some(text => text.includes('Run left open')) ? true : undefined, 'the open card sent')
    const backAt = Date.now()
    await renderer("window.aiTerminal.setAway('back')")
    await until(async () => texts(back, 'editMessageText').some(text => text.includes('Withdrawn: you are back.')) ? true : undefined, 'withdrawn at Back', Math.max(1, 5000 - (Date.now() - backAt)))
    await until(async () => texts(back, 'editMessageText').some(text => /Ended .*: you are back\./.test(text)) ? true : undefined, 'answered cards ended at Back', Math.max(1, 5000 - (Date.now() - backAt)))
    const phoneBackSyncMs = Date.now() - backAt
    assert.ok(phoneBackSyncMs <= 5000, `Back reached the phone in ${phoneBackSyncMs}ms`)
    assert.match(cli(['grant', '--run', 'run-phone']), /^No grant for run run-phone: /)
    assert.equal((await grant()).openCards, 0)
    phase('real grant-record reset across two windows')
    const reset = await checkGrantReset(client, window, second, cli)
    phase(`reset proof ${JSON.stringify(reset)}`)
    return { reset, phonePreservedSavedLine: true, presentation: { repeatedPhoneCreatesNoFact: true, oneModalDuringDelayedAckAndFocusHandoff: true, passiveFocus: true, manualReopen: true }, phone: { phoneAnswerSyncMs, phoneGoSyncMs, laptopPhoneSyncMs, phoneBackSyncMs, accessDone: true, limitApplied: true }, twoWindows: { answerSyncMs, goSyncMs }, gettingReadyHead: true, immediateCards: true, windowAnswer: true, alreadyAnswered: true, ownerUseRefused: true, phoneWalk: true, typedReply: true, laptopAnswerOnPhone: true, withdrawnAtBack: true, grantsEnded: true }
  } finally {
    second?.destroy()
    phase('cleanup')
    await client.request(METHOD_REGISTRY.presenceSet, { away: null }).catch(() => undefined)
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: original })
  }
}

async function checkGrantReset(
  client: PtyHostClient,
  focus: NonNullable<SelfTestHost['applicationWindow']>,
  other: ReturnType<SelfTestHost['createWindow']>,
  cli: (args: string[]) => string
) {
  const original = client.request.bind(client)
  const get = () => original<OwnerGrantView>(METHOD_REGISTRY.grantGet, {})
  const before = await get()
  assert.ok(before.revision > 10, 'the two running windows have a high revision before reset')
  const root = process.env.BMN_DATA_HOME
  // Both the source self-test and the packaged smoke run on a temporary root they own.
  assert.ok(root && basename(root) === 'bmn' &&
    ['bmn-electron-self-test-', 'bmn-packaged-smoke-'].some(prefix => basename(dirname(dirname(root))).startsWith(prefix)),
    'a real reset fixture requires the run-owned self-test database')
  const Sqlite = createRequire(__filename)('better-sqlite3') as new (path: string, options: { fileMustExist: boolean }) => DatabaseConnection
  const database = new Sqlite(join(root, 'state.sqlite3'), { fileMustExist: true })
  const wait = async (check: () => Promise<boolean>, label: string, ms = 5_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(label)
  }
  const ready = (window: typeof focus) => window.webContents.executeJavaScript(
    `document.querySelector('#away-check-box')?.getAttribute('aria-label') === 'Away; open Before you go'`) as Promise<boolean>
  const presentedAttempts: { periodId: string; operationKey: string; expectedGeneration: number; committed: boolean }[] = []
  const showCount = (window: typeof focus) => window.webContents.executeJavaScript('window.resetTestShows') as Promise<number>
  for (const window of [focus, other]) await window.webContents.executeJavaScript(`(() => {
    const show = HTMLDialogElement.prototype.showModal;
    window.resetTestShows = 0;
    HTMLDialogElement.prototype.showModal = function () {
      show.call(this);
      if (this.classList.contains('before-you-go-dialog')) window.resetTestShows++;
    };
  })()`)
  client.request = (async (method, params) => {
    const input = params as { action?: string; periodId?: string; operationKey?: string; expectedGeneration?: number }
    if (method !== METHOD_REGISTRY.grantDeparture || input.action !== 'presented') return original(method, params)
    assert.ok(input.periodId && input.operationKey)
    assert.equal(input.expectedGeneration, 1)
    const attempt = { periodId: input.periodId, operationKey: input.operationKey, expectedGeneration: input.expectedGeneration!, committed: false }
    presentedAttempts.push(attempt)
    if (presentedAttempts.length <= 2) throw new Error('synthetic failure before receipt commit')
    const reply = await original<OwnerDepartureReply>(method, params)
    attempt.committed = reply.outcome === 'changed'
    if (presentedAttempts.length === 3) throw new Error('synthetic lost reply after receipt commit')
    return reply
  }) as typeof client.request
  const saved = other.webContents.send.bind(other.webContents)
  other.webContents.send = (channel, ...args) => {
    if (channel !== 'aiterm:app-event' || args[0]?.topic !== 'grant') saved(channel, ...args)
  }
  try {
    // Make the other window miss just the transient unreadable state. Its next update is a real read.
    const focused = async () => focus.isFocused() && !other.isFocused() &&
      await focus.webContents.executeJavaScript('document.hasFocus()') as boolean
    focus.show()
    focus.focus()
    // GNOME on Wayland keeps focus on an already mapped window; mapping it anew hands focus over.
    await wait(focused, 'reset focus preflight', 1_000).catch(async () => {
      await refocusWindow(focus)
      await wait(focused, 'reset focus preflight')
    })
    // The preceding fixture used direct Go IPC. Its manually opened list can still cover the summary.
    const closeList = `document.querySelector('dialog.before-you-go-dialog[open] button[aria-label="Close Before you go"]')?.click()`
    for (const window of [focus, other]) await window.webContents.executeJavaScript(closeList)
    await wait(async () => (await original<OwnerAwayView>(METHOD_REGISTRY.awayGet, {})).summaryShownAt !== null,
      'previous morning summary presented')
    const dismiss = `document.querySelector('dialog.away-summary-dialog[open] button[aria-label="Close While you were away"]')?.click()`
    for (const window of [focus, other]) await window.webContents.executeJavaScript(dismiss)
    await wait(async () => await focus.webContents.executeJavaScript('document.querySelector("dialog[open]") === null'),
      'prior dialog is dismissed before the reset')
    assert.equal(database.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?')
      .run('synthetic malformed grant row', GRANT_RECORD_KEY).changes, 1)
    await client.request(METHOD_REGISTRY.grantDeparture, { action: 'start', periodId: null,
      expectedRevision: before.revision, operationKey: 'desktop-reset-surface-before-start' })
    assert.equal((await get()).read, 'unknown')
    assert.match(cli(['away', '--leaving']), /^Leaving since /)
    const current = await get()
    assert.ok(current.period?.state === 'leaving' && current.revision < before.revision, 'real database replaced the row with a lower revision')
  } finally {
    other.webContents.send = saved
    database.close()
  }
  const event = { kind: 'app-event', topic: 'grant', sessionId: null }
  focus.webContents.send('aiterm:app-event', event)
  other.webContents.send('aiterm:app-event', event)
  try {
    await wait(async () => await ready(focus) && await ready(other), 'both windows must converge after the real grant reset', 1_000)
    await wait(async () => (await get()).period?.collection?.presentedAt != null, 'one focus-owned presentation is persisted after the real reset', 12_000)
    const reset = await get()
    assert.equal(reset.generation, 1)
    assert.deepEqual(presentedAttempts.map(attempt => attempt.committed), [false, false, true])
    assert.ok(presentedAttempts.every(attempt => attempt.operationKey === presentedAttempts[0]?.operationKey))
    assert.equal(presentedAttempts[0]?.periodId, reset.period?.periodId)
    assert.deepEqual([await showCount(focus), await showCount(other)], [1, 0])
    const open = await focus.webContents.executeJavaScript(
      `document.activeElement?.classList.contains('grant-list') && !!document.querySelector('dialog.before-you-go-dialog[open]')`)
    assert.equal(open, true, 'automatic reset presentation has passive focus')
    const goAt = Date.now()
    await focus.webContents.executeJavaScript(`document.querySelector('dialog.before-you-go-dialog .grant-go').click()`)
    await wait(async () => await other.webContents.executeJavaScript("document.querySelector('#away-check-box')?.checked === true"), 'Go reaches the other window after the real reset', 1_000)
    assert.equal((await get()).period?.periodId, reset.period?.periodId)
    cli(['back'])
    return { beforeRevision: before.revision, afterRevision: reset.revision, generation: reset.generation, presentedAt: reset.period?.collection?.presentedAt, presentedAttempts, goSyncMs: Date.now() - goAt }
  } catch (error) {
    console.error('[BMN] real grant reset diagnostic', JSON.stringify({
      beforeRevision: before.revision, afterRevision: (await get()).revision,
      focusReady: await ready(focus), otherReady: await ready(other),
      showCount: [await showCount(focus), await showCount(other)], presentedAttempts,
      dialogs: await focus.webContents.executeJavaScript('Array.from(document.querySelectorAll("dialog[open]"), dialog => dialog.getAttribute("aria-label"))'),
      presented: (await get()).period?.collection?.presentedAt != null
    }))
    throw error
  } finally {
    client.request = original
  }
}
