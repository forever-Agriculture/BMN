// Synthetic Electron flow: the actual renderer, main, host, DB and Bot API; no real account or phone.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { METHOD_REGISTRY, type AppSettings, type AttentionRecord, type TelegramStatus } from '@bmn/protocol'
import type { SelfTestHost } from '../index'
import type { PtyHostClient } from '../pty-host-client'
import { selfTestHistoryRoots } from '../agent-history-self-test'
import { SELF_TEST_TELEGRAM_CHAT_ID, type SelfTestRecorder } from './taps'

export async function runQuietHoursSelfTest(host: SelfTestHost, client: PtyHostClient, taps: SelfTestRecorder): Promise<object> {
  const root = join(process.env.BMN_STATE_HOME!, 'quiet-hours')
  mkdirSync(root, { recursive: true })
  const input = join(root, 'input'), fixture = join(root, 'fixture.cjs')
  const exitFixture = join(root, 'exit.cjs'), exitSignal = join(root, 'exit-now'), requestReceipt = join(root, 'request-receipt.json')
  const phase = (name: string): void => { console.error(`[BMN] quiet-hours step: ${name}`) }
  const original = (await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram
  const bot = await taps.telegram()
  const home = selfTestHistoryRoots()!.home
  const title = `Quiet synthetic question ${home}/project`
  writeFileSync(fixture, `const fs=require('node:fs'),cp=require('node:child_process');
fs.writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);
process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(input)},b));
for(const [key,kind,title] of ${JSON.stringify([['quiet-q', 'question', title], ['quiet-p', 'permission', 'Quiet synthetic permission']])}){
 const result=cp.spawnSync('bmn',['ask',key,title,'--kind',kind],{encoding:'utf8'});
 fs.writeFileSync(${JSON.stringify(requestReceipt)},JSON.stringify({status:result.status,signal:result.signal,stderr:String(result.stderr||'').split(${JSON.stringify(home)}).join('~').slice(-500)}));
 if(result.status!==0)throw new Error('Synthetic request failed');
} console.log('quiet fixture ready');setInterval(()=>{},1000);`)
  writeFileSync(exitFixture, `const fs=require('node:fs');const deadline=Date.now()+15000;
setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitSignal)}))process.exit(0);if(Date.now()>deadline)process.exit(3)},20);`)
  const setClock = (value: string | null): Promise<unknown> => client.request(METHOD_REGISTRY.healthGet, { selfTestQuietClock: value })
  const until = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
    const by = Date.now() + 15_000
    while (Date.now() < by) { const result = await read(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Quiet-hours self-test: ${label}`)
  }
  let sessionId: string | undefined
  let exitSessionId: string | undefined
  const diagnostic: Record<string, unknown> = {}
  const aliases = new Map<string, string>()
  const snapshot = async () => {
    const value = await client.request<{ rows: Array<Record<string, unknown>>; trace: Array<Record<string, unknown>>;
      ready: boolean; health: string; away: boolean | null; flushing: boolean; permits: number; exitHeld: boolean }>(METHOD_REGISTRY.healthGet,
      { selfTestQuietSnapshot: [...aliases.keys()], ...(exitSessionId ? { selfTestQuietExit: exitSessionId } : {}) })
    return { allMembers: value.rows.length === 2 && value.rows.every(row => row.member === true), exitHeld: value.exitHeld,
      rows: value.rows.map(row => [aliases.get(String(row.id)), row.revision, row.state, row.seen, row.expires,
      row.member, row.eligible, row.delivered, row.card]), ready: value.ready, health: value.health, away: value.away,
      flushing: value.flushing, permits: value.permits,
      trace: value.trace.map(row => [row.step, aliases.get(String(row.requestId)) ?? '-', row.revision ?? 0, row.result, row.away, row.ready]) }
  }
  try {
    await setClock(new Date('2001-01-02T23:00:00').toISOString())
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...original, enabled: true,
      allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null, notifyOn: 'attention-and-exit',
      quietHours: { enabled: true, start: '22:00', end: '07:00', allowKinds: [], allowSessions: [] } } })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' })
    await until(async () => (await client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})).state === 'polling' ? true : undefined, 'connector readiness')
    await client.request(METHOD_REGISTRY.presenceSet, { away: true })
    taps.captureAttentionNotifications = true
    const noticeFrom = taps.attentionNotices.length, callsFrom = bot.calls.length
    await client.request(METHOD_REGISTRY.healthGet, { selfTestQuietTrace: true })
    const workspace = await host.applicationWindow!.webContents.executeJavaScript(`window.aiTerminal.createWorkspace({name:'Quiet hours proof',defaultCwd:${JSON.stringify(root)}})`)
    phase('create-request')
    const started = await host.createSessionRuntime({ workspaceId: workspace.workspaceId, name: `Quiet ${home}/session`, cwd: root,
      executable: process.env.BMN_SELF_TEST_NODE!, argv: [fixture], cols: 80, rows: 24 }, true)
    sessionId = started.session.sessionId
    phase('create-exit')
    const exited = await host.createSessionRuntime({ workspaceId: workspace.workspaceId, name: 'Quiet exited', cwd: root,
      executable: process.env.BMN_SELF_TEST_NODE!, argv: [exitFixture], cols: 80, rows: 24 }, true)
    exitSessionId = exited.session.sessionId
    phase('signal-exit')
    writeFileSync(exitSignal, '')
    const rows = await until(async () => {
      const rows = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {})).filter(row => row.sessionId === sessionId)
      if (rows.length !== 2) return undefined
      for (const row of rows) aliases.set(row.requestId, row.kind === 'question' ? 'q' : 'p')
      const held = await snapshot()
      if (!held.allMembers || !held.exitHeld) return undefined
      diagnostic.readiness = { ownRequestsHeld: 2, ownExitHeld: true }
      return rows
    }, 'three held items')
    phase('held-3')
    assert.equal(bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage').length, 0)
    await until(async () => taps.attentionNotices.slice(noticeFrom).some(notice => notice.sessionId === sessionId) ? true : undefined, 'desktop notification path')
    // Keep the synthetic away fixture unwatched: selecting a focused pane marks requests seen.
    host.applicationWindow!.blur()
    await until(async () => !host.applicationWindow!.isFocused() ? true : undefined, 'synthetic away window unfocused')
    // Fixture creation bypasses renderer-owned creation; publish its registry before owner navigation.
    await host.recoverApplicationRenderer(host.applicationWindow!)
    await until(async () => {
      const ready = await host.applicationWindow!.webContents.executeJavaScript(`!!document.querySelector('.workspace-group[aria-label="Quiet hours proof"]') && !!document.querySelector('.session-terminal[data-session-id="${sessionId}"]')`)
      return ready ? true : undefined
    }, 'fixture renderer registry')
    await host.applicationWindow!.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    host.applicationWindow!.webContents.send('aiterm:open-session', sessionId)
    await until(async () => {
      const selected = await host.applicationWindow!.webContents.executeJavaScript(`(async()=>{
        const pane=document.querySelector('.session-terminal[data-session-id="${sessionId}"]');
        return (await window.aiTerminal.getLayout(${JSON.stringify(workspace.workspaceId)})).layout.selectedSessionId===${JSON.stringify(sessionId)} && !!pane && !pane.classList.contains('session-terminal-hidden');
      })()`)
      return selected ? true : undefined
    }, 'quiet request session selected')
    await host.applicationWindow!.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    phase('cue')
    const cue = await host.applicationWindow!.webContents.executeJavaScript(`(async()=>{
      const end=Date.now()+10000; while(!document.querySelector('[data-session-requests="${sessionId}"]') && Date.now()<end) await new Promise(r=>setTimeout(r,25));
      document.querySelector('[data-session-requests="${sessionId}"]').click();
      const by=Date.now()+10000;
      while(Date.now()<by){const items=[...document.querySelectorAll('.attention-item')];
        const item=items.find(e=>e.textContent.includes('Quiet synthetic question'));
        if(item?.textContent.includes('Phone: held until 07:00'))return item.textContent;
        await new Promise(r=>setTimeout(r,50));}
      throw new Error('Quiet hold cue missing from session requests');})()`)
    assert.match(cue, /Phone: held until 07:00/)
    assert.equal(readFileSync(input, 'utf8'), '')
    diagnostic.before = await snapshot()
    await client.request(METHOD_REGISTRY.presenceSet, { away: true })
    await until(async () => {
      const held = await snapshot()
      return held.away === true && held.allMembers && held.exitHeld ? true : undefined
    }, 'away with unchanged held requests')
    assert.equal(bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage').length, 0)
    assert.equal(host.applicationWindow!.isFocused(), false, 'Quiet fixture became watched')
    const heldRecords = await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {})
    for (const expected of rows) {
      const held = heldRecords.find(row => row.requestId === expected.requestId)
      assert.ok(held && held.sessionId === sessionId && held.revision === expected.revision &&
        held.kind === expected.kind && held.state === 'open' && held.seenAt === null, 'Quiet fixture request became seen or changed')
    }
    phase('clock-end')
    const end = await setClock(new Date('2001-01-03T07:00:00').toISOString()) as {
      ledger: { window: { summary: string; eligible: boolean } | null; entries: Array<{ requestId?: string; revision?: number; phase: string }> } }
    diagnostic.ledger = { window: end.ledger.window ? [end.ledger.window.summary, end.ledger.window.eligible] : null,
      entries: end.ledger.entries.map(entry => [aliases.get(entry.requestId ?? '') ?? 'exit', entry.revision ?? 0, entry.phase]) }
    const sends = bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage')
    diagnostic.immediate = sends.map(call => {
      const text = String(call.body.text)
      return [text.includes('Quiet hours ended') ? 'summary' : text.includes('Quiet synthetic question') ? 'q'
        : text.includes('Quiet synthetic permission') ? 'p' : 'unknown', !!call.body.reply_markup, Number(/(\d+) answered/.exec(text)?.[1] ?? 0)]
    })
    diagnostic.after = await snapshot()
    diagnostic.late = bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage').length
    assert.equal(sends.length, 3)
    assert.match(String(sends[0]!.body.text), /Quiet hours ended/)
    assert.match(String(sends[0]!.body.text), /~\/project/)
    assert.ok(!String(sends[0]!.body.text).includes(home))
    phase('ledger')
    const state = await setClock(new Date('2001-01-03T07:00:30').toISOString()) as { ledger: { entries: unknown[] } }
    assert.ok(state.ledger.entries.length <= 200)
    assert.ok(!JSON.stringify(state.ledger).includes('Quiet synthetic'))
    assert.ok(!JSON.stringify(state.ledger).includes(home))
    assert.equal(bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage').length, 3)
    assert.deepEqual((await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {})).filter(row => row.sessionId === sessionId), rows)
    assert.equal(readFileSync(input, 'utf8'), '')
    return { held: 3, summary: 1, cards: 2, needsYouCue: true, desktopNotificationPath: true, ptyInputBytes: 0, maskedHome: true, ledgerText: false }
  } finally {
    if (!diagnostic.before && aliases.size) diagnostic.before = await snapshot().catch(() => ({ unavailable: true }))
    await client.request(METHOD_REGISTRY.healthGet, { selfTestQuietTrace: false }).catch(() => undefined)
    // Fixed metadata only; never emit card text, paths, callback tokens or credentials.
    let encoded = JSON.stringify(diagnostic)
    if (encoded.length > 2_000) {
      for (const key of ['before', 'after']) {
        const value = diagnostic[key] as { trace?: unknown[] } | undefined
        if (value?.trace) value.trace = value.trace.slice(-8)
      }
      encoded = JSON.stringify(diagnostic)
    }
    console.error(`[BMN] quiet-hours diag: ${encoded.slice(0, 2_000)}`)
    if (existsSync(requestReceipt)) console.error(`[BMN] quiet-hours request fixture: ${readFileSync(requestReceipt, 'utf8')}`)
    taps.captureAttentionNotifications = false
    if (sessionId) await host.applicationWindow!.webContents.executeJavaScript(`window.aiTerminal.stopSession(${JSON.stringify(sessionId)})`).catch(() => undefined)
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: original })
    await setClock(null)
  }
}
