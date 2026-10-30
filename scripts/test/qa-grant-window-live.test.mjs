/* global window */
// MODULE: qa-grant-window-live.test.mjs - opt-in actual owner-window grant answer; synthetic setup only, no service execution
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { expect, it } from 'vitest'
import { reserveQaRun } from '../../apps/desktop/src/utility/database-qa-store.ts'
import { openQaGrantRequest } from '../../apps/desktop/src/utility/database-companion-store.ts'
import { getQaGrant } from '../../apps/desktop/src/utility/database-qa-grant-store.ts'
import { syntheticPaidContract } from '../../apps/desktop/bin/qa-request-gate.mjs'
import { writeWhole } from '../../apps/desktop/bin/agents-team-supervisor.mjs'
import { recordProcess } from './browser-accounts-fixture.mjs'

it.skipIf(process.env.BMN_QA_GRANT_WINDOW_LIVE !== '1')('the actual owner-window card approves or denies only its immutable synthetic planning grant', async () => {
  const require = createRequire(resolve('apps/desktop/package.json')), Sqlite = require('better-sqlite3')
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const binary = realpathSync('/home/oleksandr/code/BMN/apps/desktop/node_modules/electron/dist/electron')
  assert.equal(hash(binary), hash(join(dirname(require.resolve('electron')), 'dist/electron')), 'approved explicit runtime must match the candidate pin')
  const base = resolve('.dev-auto/evidence/100.6/owner-window'); mkdirSync(base, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(base, 'planning-')), home = join(root, 'home'), runtime = mkdtempSync(`/run/user/${process.getuid()}/b100-card-`)
  const save = (name, value) => writeWhole(join(root, name), JSON.stringify(value, null, 2) + '\n')
  recordProcess(process.pid, '100.6 synthetic owner-window grant harness')
  const team = join(home, '.config/bmn/agents'), ownerTeam = join(process.env.HOME, '.config/bmn/agents')
  const pointer = JSON.parse(readFileSync(join(ownerTeam, 'state/current'), 'utf8')), generation = `${String(pointer.generation).padStart(6, '0')}.json`
  mkdirSync(join(team, 'state/generations'), { recursive: true, mode: 0o700 })
  for (const file of ['roster.md', 'state/current', `state/generations/${generation}`]) copyFileSync(join(ownerTeam, file), join(team, file))
  const environment = { PATH: process.env.PATH, HOME: home, SHELL: '/bin/bash', TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, 'share'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_RUNTIME_DIR: runtime, BMN_CONFIG_HOME: join(home, '.config/bmn'), BMN_DATA_HOME: join(root, 'data'), BMN_STATE_HOME: join(root, 'state'), BMN_RUNTIME_HOME: join(runtime, 'bmn'),
    BMN_LAUNCH_CWD: root, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/unused-bus`, GTK_USE_PORTAL: '0', NO_AT_BRIDGE: '1' }
  let app, database, receipt
  try {
    app = await electron.launch({ executablePath: binary, chromiumSandbox: true, args: ['--ozone-platform=headless', '--ozone-override-screen-size=1440,1000', resolve('apps/desktop'), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'], cwd: root, env: environment })
    recordProcess(app.process().pid, '100.6 isolated owner-window Electron app')
    const page = await app.firstWindow(); await page.waitForSelector('.session-row', { timeout: 30000 })
    const security = await page.evaluate(() => window.aiTerminal.security)
    expect(security).toMatchObject({ sandboxed: true, contextIsolated: true })
    const native = await app.evaluate(({ app, BrowserWindow }) => ({ version: process.versions.electron, appPath: app.getAppPath(),
      renderers: BrowserWindow.getAllWindows().map(window => ({ pid: window.webContents.getOSProcessId(), sandbox: window.webContents.getLastWebPreferences().sandbox, isolation: window.webContents.getLastWebPreferences().contextIsolation })) }))
    expect(native.appPath).toBe(resolve('apps/desktop'))
    for (const renderer of native.renderers) {
      const status = readFileSync(`/proc/${renderer.pid}/status`, 'utf8')
      expect(status).toMatch(/NoNewPrivs:\s+1/); expect(status).toMatch(/Seccomp:\s+2/)
      expect(renderer.sandbox).toBe(true); expect(renderer.isolation).toBe(true)
    }
    const caller = await page.evaluate(async () => {
      const workspaces = await window.aiTerminal.listWorkspaces()
      const sessions = await window.aiTerminal.listSessions(workspaces[0].workspaceId)
      return sessions[0]
    })
    assert(caller, 'isolated shell caller required')
    // Test-fixture setup writes only this running app's disposable SQLite. Answering uses the real UI/preload/main/host path.
    database = new Sqlite(join(root, 'data/state.sqlite3')); database.pragma('busy_timeout = 5000'); database.pragma('foreign_keys = ON')
    const now = new Date().toISOString(), origin = 'http://127.0.0.1:4173', contract = syntheticPaidContract(origin)
    reserveQaRun(database, { id: 'synthetic-planning-run', callerSessionId: caller.sessionId, workspaceId: caller.workspaceId, key: 'synthetic-planning', inputSha256: 'a'.repeat(64),
      brief: { version: 2, mode: 'session', accounts: [{ alias: 'Synthetic ordinary', intent: 'ordinary-granted' }] }, folder: join(root, 'qa'), state: 'preparing', sessionId: null, incarnationId: null, createdAt: now, failure: null, connection: null, result: null })
    const open = id => openQaGrantRequest(database, { id, key: id, incarnationId: null, terms: { version: 1, qaId: 'synthetic-planning-run',
      account: { id: 'synthetic-account', alias: 'Synthetic ordinary', revision: 1 }, origin, contract: { id: contract.id, sha256: contract.sha256 },
      limits: [{ activity: 'report.generate', count: 1 }, { activity: 'brainstorm.start', count: 1 }], expiresAt: new Date(Date.now() + 3600000).toISOString() } }, now)
    const denied = open('synthetic-denied'), approved = open('synthetic-approved')
    expect(getQaGrant(database, denied.grant.id).state).toBe('pending'); expect(getQaGrant(database, approved.grant.id).state).toBe('pending')
    // Reload the window only; the running utility/SQLite owner stays alive, so this preparing planning grant remains eligible.
    await page.reload(); await page.waitForSelector(`[data-session-requests="${caller.sessionId}"]`, { timeout: 30000 })
    await page.locator(`[data-session-requests="${caller.sessionId}"]`).click()
    const denyCard = page.locator(`[data-request-id="${denied.card.requestId}"]`), approveCard = page.locator(`[data-request-id="${approved.card.requestId}"]`)
    expect(await denyCard.isVisible()).toBe(true); expect(await approveCard.isVisible()).toBe(true)
    for (const card of [denyCard, approveCard]) {
      const text = await card.innerText()
      expect(text).toContain('Synthetic ordinary'); expect(text).toContain(origin); expect(text).toContain('Report generation: at most 1'); expect(text).toContain('Brainstorming sessions: at most 1')
      expect(text).not.toMatch(/QA run:|Site contract:|report\.generate|brainstorm\.start/)
    }
    await page.screenshot({ path: join(root, 'planning-cards.png') })
    await denyCard.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect.poll(() => getQaGrant(database, denied.grant.id).state, { timeout: 5000 }).toBe('denied')
    await approveCard.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect.poll(() => getQaGrant(database, approved.grant.id).state, { timeout: 5000 }).toBe('approved')
    const stale = await page.evaluate(async ({ id, revision }) => { try { await window.aiTerminal.answerQaGrant(id, revision, 0); return 'accepted' } catch { return 'refused' } }, { id: approved.card.requestId, revision: approved.card.revision })
    expect(stale).toBe('refused')
    expect(database.prepare('SELECT COUNT(*) AS n FROM qa_grant_use').get().n).toBe(0)
    await page.screenshot({ path: join(root, 'planning-answered.png') })
    receipt = { pass: true, scope: 'actual isolated owner-window planning grant card -> preload/main/CompanionService/SQLite; synthetic fixture setup; no native QA, account qualification, browser/service execution or installed-build claim',
      security, native, denied: getQaGrant(database, denied.grant.id), approved: getQaGrant(database, approved.grant.id), staleReply: stale, activityUses: 0, realModelCalled: false, personalAccounts: false }
  } finally {
    if (database) database.close()
    if (app) {
      const page = app.windows().find(window => !window.isClosed())
      if (page) await page.evaluate(async () => { for (const workspace of await window.aiTerminal.listWorkspaces()) for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) if (['live', 'starting'].includes(session.lastProcess?.state)) await window.aiTerminal.stopSession(session.sessionId) })
      await app.close()
    }
    rmSync(runtime, { recursive: true, force: true })
    save('receipt.json', receipt ?? { pass: false, scope: 'owner-window planning-card check did not finish; see test log', realModelCalled: false, personalAccounts: false })
  }
}, 90000)
