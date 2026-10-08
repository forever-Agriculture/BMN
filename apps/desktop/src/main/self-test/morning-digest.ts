import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { METHOD_REGISTRY, type AppSettings, type AttentionRecord, type DevAutoRunsResult, type SessionRecord, type TelegramStatus } from '@bmn/protocol'
import type { SelfTestHost } from '../index'
import type { PtyHostClient } from '../pty-host-client'
import { selfTestHistoryRoots } from '../agent-history-self-test'
import { SELF_TEST_TELEGRAM_CHAT_ID, type SelfTestRecorder } from './taps'

export async function runMorningDigestSelfTest(host: SelfTestHost, client: PtyHostClient, taps: SelfTestRecorder): Promise<object> {
  const began = Date.now()
  const phase = (name: string): void => { console.error(`[BMN] morning-digest step: ${name} +${Date.now() - began}ms`) }
  phase('repository-setup')
  const root = join(process.env.BMN_STATE_HOME!, 'digest-repository'), side = join(process.env.BMN_STATE_HOME!, 'digest-side'), copy = join(process.env.BMN_STATE_HOME!, 'digest-copy')
  const other = join(process.env.BMN_STATE_HOME!, 'digest-other'), home = selfTestHistoryRoots()!.home
  const git = (cwd: string, ...args: string[]): void => { execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' }) }
  const init = (cwd: string): void => {
    mkdirSync(cwd, { recursive: true }); git(cwd, 'init', '-qb', 'main')
    git(cwd, '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
  }
  const handoff = (cwd: string, owner: string, branch: string, status: string, decision: string, epics = 'Synthetic epics 57'): void => {
    mkdirSync(join(cwd, '.dev-auto'), { recursive: true })
    writeFileSync(join(cwd, '.dev-auto/handoff.md'), `- Project / selected epics: ${epics}\n- Owning checkout and branch: ${owner} / ${branch}\n- Explicit user stop: none\n## Decisions and findings\n- Decided for you: ${decision}\n## Resume\n- Next safe action: Local verification\n- Status: ${status}\n`)
  }
  init(root); git(root, 'worktree', 'add', '-qb', 'digest-side', side); git(root, 'worktree', 'add', '-qb', 'digest-copy', copy); init(other)
  handoff(root, root, 'main', `BLOCKED — synthetic ${home}/status`, `Synthetic digest choice ${home}/chosen`)
  handoff(side, side, 'digest-side', 'PAUSED — synthetic', 'Side decision')
  handoff(copy, root, 'main', 'BLOCKED — copy', 'Copy-only choice')
  handoff(other, other, 'main', 'ACTIVE', '', 'Epics 9007199254740992')
  mkdirSync(join(root, '_bmad-output/implementation-artifacts'), { recursive: true })
  writeFileSync(join(root, '_bmad-output/implementation-artifacts/sprint-status.yaml'), 'development_status:\n  epic-57: in-progress\n')
  const original = (await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram
  const bot = await taps.telegram(), window = host.applicationWindow!
  const clock = (value: string | null): Promise<{ digest?: unknown }> => client.request(METHOD_REGISTRY.healthGet, { selfTestQuietClock: value })
  const until = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
    const by = Date.now() + 15000
    while (Date.now() < by) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Digest self-test: ${label}`)
  }
  const connected = (): Promise<true> => until(async () => (await client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})).state === 'polling' ? true : undefined, 'fake connector')
  const renderer = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const fixtureIds: string[] = [], inputs = [join(root, 'input-a'), join(side, 'input-b')]
  phase('presence-read')
  const priorPresence = await client.request<{ away: boolean | null }>(METHOD_REGISTRY.healthGet, { selfTestQuietSnapshot: [] })
  try {
    phase('clock-start')
    await clock(new Date('2001-01-04T08:00:00').toISOString())
    phase('workspace-create')
    const name = `Digest ${home}/workspace`
    const workspace = await renderer<{ workspaceId: string }>(`window.aiTerminal.createWorkspace({name:${JSON.stringify(name)},defaultCwd:${JSON.stringify(root)}})`)
    const otherWorkspace = await renderer<{ workspaceId: string }>(`window.aiTerminal.createWorkspace({name:'Other digest workspace',defaultCwd:${JSON.stringify(other)}})`)
    const settings = { ...original, enabled: true, allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null, notifyOn: 'attention' as const,
      quietHours: { enabled: true, start: '22:00', end: '09:00', allowKinds: [], allowSessions: [] }, morningDigest: { enabled: false, time: '08:00' } }
    phase('configure')
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: settings })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' }); await connected()
    await client.request(METHOD_REGISTRY.presenceSet, { away: false })
    for (const [index, cwd] of [root, side].entries()) {
      const fixture = join(cwd, 'run-fixture.cjs'), title = `Run ${index === 0 ? 'A' : 'B'} owner item ${home}/request`
      writeFileSync(fixture, `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(inputs[index])},'');process.stdin.setRawMode(true);process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(inputs[index])},b));const r=cp.spawnSync('bmn',['ask','digest-${index}',${JSON.stringify(title)}],{encoding:'utf8'});if(r.status!==0)throw new Error('Synthetic ask failed');setInterval(()=>{},1000);`)
      phase(`create-live-${index}`)
      const created = await host.createSessionRuntime({ workspaceId: workspace.workspaceId, name: `Digest live ${index}`, cwd, executable: process.env.BMN_SELF_TEST_NODE!, argv: [fixture], cols: 80, rows: 24 }, true)
      fixtureIds.push(created.session.sessionId)
    }
    phase('requests-ready')
    await until(async () => {
      const rows = await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {})
      return rows.filter(row => fixtureIds.includes(row.sessionId)).length === 2 && inputs.every(existsSync) ? true : undefined
    }, 'two live owner items')
    phase('saved-directory-edit')
    const records = await renderer<SessionRecord[]>(`window.aiTerminal.listSessions(${JSON.stringify(workspace.workspaceId)})`)
    const first = records.find(row => row.sessionId === fixtureIds[0])!
    await renderer(`window.aiTerminal.updateSession({sessionId:${JSON.stringify(first.sessionId)},expectedRevision:${first.revision},cwd:${JSON.stringify(side)}})`)
    const processes = async (): Promise<string[]> => (await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, { workspaceId: workspace.workspaceId })).map(row => `${row.sessionId}:${row.lastProcess?.incarnationId}:${row.lastProcess?.state}`).sort()
    const beforeProcesses = await processes(), before = await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {})
    const read = (id?: string): Promise<DevAutoRunsResult> => renderer(`window.aiTerminal.readDevAutoRuns(${id ? JSON.stringify(id) : ''})`)
    phase('owner-reader')
    const listed = await read(workspace.workspaceId)
    assert.equal(listed.runs.length, 3)
    assert.deepEqual(listed.runs.find(run => run.checkout === root)!.ownerItems.map(item => item.sessionId), [fixtureIds[0]])
    assert.deepEqual(listed.runs.find(run => run.checkout === side)!.ownerItems.map(item => item.sessionId), [fixtureIds[1]])
    assert.equal(listed.runs.find(run => run.checkout === copy)!.ownership, 'copy'); assert.deepEqual(listed.runs.find(run => run.checkout === copy)!.ownerItems, [])
    assert.ok(listed.runs.every(run => run.workspaceIds.length === 1 && run.workspaceIds[0] === workspace.workspaceId))
    assert.equal((await read(otherWorkspace.workspaceId)).runs[0]!.board.rows.length, 0)
    await client.request(METHOD_REGISTRY.healthGet, {}) // The real shared host remains responsive after the unsafe number.
    // Owner navigation and filtered rendering run in the separate bounded Playwright proof on this build.
    phase('digest-delivery')
    const callsFrom = bot.calls.length
    await clock(new Date('2001-01-04T08:01:00').toISOString()); assert.equal(bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage').length, 0)
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...settings, morningDigest: { enabled: true, time: '08:00' } } }); await connected()
    await clock(new Date('2001-01-04T08:02:00').toISOString()); assert.equal(bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage').length, 0)
    phase('due-sweep')
    const receipt = await clock(new Date('2001-01-04T09:00:00').toISOString())
    const sends = bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage'); assert.equal(sends.length, 1)
    const text = String(sends[0]!.body.text); assert.match(text, /Synthetic digest choice ~\/chosen/); assert.ok(!text.includes(home)); assert.ok(!text.includes('Copy-only choice'))
    assert.match(text, /main[^\n]*Run A owner item/); assert.match(text, /digest-side[^\n]*Run B owner item/)
    assert.ok(receipt.digest); assert.ok(!JSON.stringify(receipt.digest).includes('Synthetic')); assert.ok(!JSON.stringify(receipt.digest).includes(home))
    await clock(new Date('2001-01-04T09:30:00').toISOString()); assert.equal(bot.calls.slice(callsFrom).filter(call => call.method === 'sendMessage').length, 1)
    phase('invariants')
    assert.deepEqual(await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}), before); assert.deepEqual(await processes(), beforeProcesses)
    const ptyInputBytes = inputs.reduce((sum, input) => sum + readFileSync(input).byteLength, 0); assert.equal(ptyInputBytes, 0)
    return { disabledSends: 0, quietSends: 0, dailyMessages: 1, ownerRunView: true, twoLiveSessions: true, copiedRunExcluded: true, editedSavedDirectoryKeepsLiveOwner: true,
      hostResponsiveAfterUnsafeEpic: true, measuredProcessChanges: 0, maskedHome: true, storedText: false, requestChanges: 0, ptyInputBytes }
  } finally {
    phase('cleanup')
    for (const id of fixtureIds) await renderer(`window.aiTerminal.stopSession(${JSON.stringify(id)})`).catch(() => undefined)
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: original }); await clock(null)
    if (priorPresence.away !== null) await client.request(METHOD_REGISTRY.presenceSet, { away: priorPresence.away })
  }
}
