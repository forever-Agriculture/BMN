/* global document */
// MODULE: qa-broker-live.test.mjs - opt-in real socket/SQLite/browser/service counters; native identity is injected
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ID } from '../../shared/protocol/src/index.ts'
import { initializeDatabase } from '../../apps/desktop/src/utility/database-initialization.ts'
import { COMPANION_OPERATIONS as store } from '../../apps/desktop/src/utility/database-companion-store.ts'
import { ControlAuth } from '../../apps/desktop/src/utility/control-auth.ts'
import { ControlServer, MemoryReceiptStore } from '../../apps/desktop/src/utility/control-server.ts'
import { QaSessions } from '../../apps/desktop/src/utility/qa-sessions.ts'
import { BrowserAccountsStore } from '../../apps/desktop/bin/browser-accounts-store.mjs'
import { AccountBrowserRelay } from '../../apps/desktop/bin/browser-account-relay.mjs'
import { call } from '../../apps/desktop/bin/bmn-commands.mjs'
import { gateQaRequest, syntheticPaidContract } from '../../apps/desktop/bin/qa-request-gate.mjs'
import { processIdentity } from '../../apps/desktop/bin/browser-process.mjs'
import { writeWhole } from '../../apps/desktop/bin/agents-team-supervisor.mjs'
import { recordProcess } from './browser-accounts-fixture.mjs'

const enabled = process.env.BMN_QA_BROKER_LIVE === '1'
const Sqlite = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('better-sqlite3')
const fixtures = []
if (enabled) recordProcess(process.pid, '100.6 synthetic socket/browser/counter harness')
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })

async function fixture(name, fault = null) {
  const base = resolve('.dev-auto/evidence/100.6/live'); mkdirSync(base, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(base, name + '-')), runtime = mkdtempSync(`/run/user/${process.getuid()}/b100-broker-`)
  const now = () => new Date().toISOString(), counters = { report: 0, brainstorm: 0, read: 0, unknown: 0, websocket: 0 }
  const markup = `<!doctype html><meta charset="utf-8"><title>Synthetic activity counter</title><body data-serial="0">
    <h1>Synthetic ordinary account</h1><p id="status">Ready</p>
    <button id="report">Generate report</button><button id="brainstorm">Start brainstorm</button><button id="race">Two report requests</button>
    <button id="read">Read POST</button><button id="unknown">Unsupported action</button><button id="get-effect">GET effect</button><button id="beacon">Beacon</button><button id="websocket">WebSocket</button>
    <script>let serial=0;async function act(fn){try{await fn();statusText('done')}catch{statusText('held')}document.body.dataset.serial=++serial}function statusText(t){document.querySelector('#status').textContent=t}
    const post=p=>fetch(p,{method:'POST',headers:{'X-Synthetic-Secret':'synthetic-header-canary'},body:'synthetic-body-canary'}).then(r=>{if(!r.ok)throw Error('held')});
    document.querySelector('#report').onclick=()=>act(()=>post('/paid/report'));document.querySelector('#brainstorm').onclick=()=>act(()=>post('/paid/brainstorm'));
    document.querySelector('#race').onclick=()=>act(()=>Promise.allSettled([post('/paid/report'),post('/paid/report')]));document.querySelector('#read').onclick=()=>act(()=>post('/read'));
    document.querySelector('#unknown').onclick=()=>act(()=>post('/unknown/private-path-value'));document.querySelector('#get-effect').onclick=()=>act(()=>fetch('/paid/report'));
    document.querySelector('#beacon').onclick=()=>act(async()=>{navigator.sendBeacon('/paid/report','synthetic-body-canary')});
    document.querySelector('#websocket').onclick=()=>act(()=>new Promise(ok=>{let w=new WebSocket(location.origin.replace('http','ws'));w.onclose=ok;w.onerror=ok}));</script>`
  const service = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'qa=synthetic-account; SameSite=Strict; Path=/' }).end(markup); return }
    if (request.method === 'GET' && request.url === '/favicon.ico') { response.writeHead(204).end(); return }
    if (request.method === 'POST' && request.url === '/read') { counters.read++; response.writeHead(200).end('read'); return }
    if (request.method === 'POST' && ['/paid/report', '/paid/brainstorm'].includes(request.url)) {
      if (!request.headers.cookie?.includes('qa=synthetic-account')) { response.writeHead(401).end(); return }
      counters[request.url.endsWith('report') ? 'report' : 'brainstorm']++
      if (fault === 'redirect') response.writeHead(307, { Location: '/paid/report?again=1' }).end()
      else setTimeout(() => response.writeHead(200).end('synthetic-response-canary'), 30)
      return
    }
    counters.unknown++; response.writeHead(404).end()
  })
  service.on('upgrade', (_request, socket) => { counters.websocket++; socket.destroy() })
  await new Promise(ok => service.listen(0, '127.0.0.1', ok))
  const origin = `http://127.0.0.1:${service.address().port}`, contract = syntheticPaidContract(origin), dbPath = join(root, 'state.sqlite')
  let database = new Sqlite(dbPath); initializeDatabase(database, now())
  for (const [id, cwd, argv] of [['caller', root, '[]'], ['qa', join(root, 'qa'), '["--run","run-a"]']]) {
    database.prepare('INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position) VALUES(?,?,?,?,?,?,1,?,0)').run(id, DEFAULT_WORKSPACE_ID, id, cwd, '/bin/bash', argv, now())
  }
  store.reserveQaRun(database, { id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-key', inputSha256: 'a'.repeat(64),
    brief: { accounts: [{ alias: 'Synthetic only', permission: 'look-only' }] }, folder: join(root, 'qa'), state: 'preparing', sessionId: null, incarnationId: null, createdAt: now(), failure: null, connection: null, result: null })
  store.bindQaRun(database, 'run-a', 'qa', 'qa-inc')
  // These are injected identities for the browser-path proof, never A1 or native qualification.
  store.bindQaAgent(database, 'run-a', { pid: 101, ticks: '100', at: now() }); store.connectQaRelay(database, 'run-a', { pid: 102, ticks: '101', at: now() })
  const account = { id: 'synthetic-account', name: 'Synthetic only', origins: [origin], test: false, qaRevision: 1 }
  const db = { companion: async (operation, ...args) => store[operation](database, ...args) }, live = id => id === 'qa' ? 'qa-inc' : id === 'caller' ? 'caller-inc' : undefined
  const sessions = new QaSessions({ database: db, live, now, data: root, cliPath: resolve('apps/desktop/bin/bmn'), accounts: {
    account: () => account, contract: address => address === origin ? contract : null, qualified: () => true, changed: () => {}
  } })
  const auth = new ControlAuth(), token = auth.sessionToken('qa', 'qa-inc'), socket = join(runtime, 'control.sock')
  const handlers = new Proxy({ qaSession: async () => true, qaRequest: (scope, method, params) => sessions.request(scope, method, params),
    isCurrentIncarnation: (id, incarnation) => live(id) === incarnation, reportRefusal: () => {} }, { get: (target, key) => key in target ? target[key] : () => { throw Error(`Unexpected test handler ${String(key)}`) } })
  const controller = new ControlServer({ socketPath: socket, auth, handlers, receipts: new MemoryReceiptStore(), now: () => new Date() }); await controller.listen()
  const rpc = (method, params) => call(socket, token, method, params)
  const grant = await rpc('qa.grant.ask', { id: 'run-a', key: 'planning-1', accountId: account.id, origin,
    limits: [{ activity: 'report.generate', count: 1 }, { activity: 'brainstorm.start', count: 1 }], expiresAt: new Date(Date.now() + 3600000).toISOString() })
  let drop = fault
  const broker = {
    policy: async () => ({ active: true, contract }),
    reserve: async operation => { const result = await rpc('qa.reserve', { ...operation, grantId: grant.id }); if (drop === 'reserve') throw Error('synthetic lost reserve reply'); return result },
    send: async id => { const result = await rpc('qa.send', { id }); if (drop === 'send') throw Error('synthetic lost commitment reply'); return result },
    settle: (id, state, status) => rpc('qa.settle', { id, state, status }),
    observe: request => rpc('qa.audit', { accountId: account.id, request, held: false }),
    hold: (request, reason) => rpc('qa.hold', { accountId: account.id, request, reason }), gap: gap => rpc('qa.audit.close', { gap })
  }
  const browserStore = new BrowserAccountsStore({ environment: { PATH: process.env.PATH, HOME: join(root, 'home'), BMN_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: runtime } })
  const relay = new AccountBrowserRelay({ store: browserStore, allowed: false, qa: true, beforeReady: async context => {
    await context.route('**/*', route => gateQaRequest(route, broker, async () => { await context.close() }))
    await context.routeWebSocket(/.*/, socket => socket.close())
    for (const page of context.pages()) await page.close()
  } })
  const started = async () => {
    await relay.start()
    for (const name of readdirSync(join(browserStore.runtime(), '.launches'))) {
      const launch = JSON.parse(readFileSync(join(browserStore.runtime(), '.launches', name), 'utf8'))
      for (const key of ['launcher', 'monitor', 'init']) { const identity = launch[key]; if (identity && processIdentity(identity.pid).ticks === identity.ticks) recordProcess(identity.pid, `100.6 counter Chrome ${key}`) }
    }
    const result = await relay.tool('browser_navigate', { url: origin }); expect(result.isError).not.toBe(true)
  }
  const result = { counters, grant, account, rpc, root,
    approve: () => store.answerQaGrantCard(database, { requestId: grant.card.id, revision: grant.card.revision, approved: true, via: 'app', operationKey: 'synthetic-owner-answer', runIncarnationId: 'qa-inc' }, now()),
    click: async (id, mayClose = false) => {
      const page = relay.context.pages()[0], serial = await page.getAttribute('body', 'data-serial')
      const response = await relay.tool('browser_click', { target: '#' + id })
      if (!mayClose) { expect(response.isError).not.toBe(true); await page.waitForFunction(prior => document.body.dataset.serial !== prior, serial, { timeout: 5000 }) }
    },
    restart: async () => { await relay.end(false); database.close(); database = new Sqlite(dbPath); store.recoverQaGrantUses(database, now()); drop = null; await started() },
    records: () => store.qaAuditRecords(database, 'run-a'), cards: () => store.listAttention(database),
    uses: () => database.prepare('SELECT record_json FROM qa_grant_use').all().map(row => JSON.parse(row.record_json)),
    close: async () => {
      writeWhole(join(root, 'receipt.json'), JSON.stringify({ scope: 'real socket/SQLite/browser/service path; injected native identity, anonymous synthetic profile; not owner-window/A1/account qualification', counters, audit: store.qaAuditSummary(database, 'run-a'), uses: result.uses() }, null, 2) + '\n')
      await relay.end(false); await controller.close(); service.closeAllConnections(); await new Promise(ok => service.close(ok)); database.close(); rmSync(runtime, { recursive: true, force: true })
    }
  }
  fixtures.push(result); await started(); return result
}

it.skipIf(!enabled)('real service counters stay zero before approval and stop at the exact approved activities', async () => {
  const f = await fixture('exact')
  await f.click('report'); expect(f.counters.report).toBe(0)
  await expect(f.rpc('qa.grant.answer', { approved: true })).rejects.toThrow()
  f.approve(); await f.click('report'); expect(f.counters.report).toBe(1)
  await f.click('report'); expect(f.counters.report).toBe(1)
  expect(f.cards().some(card => card.state === 'open')).toBe(true)
  await f.click('brainstorm'); expect(f.counters.brainstorm).toBe(1)
  await f.click('read'); expect(f.counters.read).toBe(1)
  await f.click('unknown'); await f.click('get-effect'); await f.click('beacon'); await f.click('websocket')
  expect(f.counters).toEqual({ report: 1, brainstorm: 1, read: 1, unknown: 0, websocket: 0 })
  expect(JSON.stringify(f.records())).not.toMatch(/synthetic-(body|header|response)-canary|private-path-value/)
}, 60000)

it.skipIf(!enabled)('concurrent UI requests execute only one paid operation', async () => {
  const f = await fixture('concurrent'); f.approve(); await f.click('race')
  expect(f.counters.report).toBe(1); expect(f.uses()).toHaveLength(1)
}, 60000)

it.skipIf(!enabled).each(['reserve', 'send'])('a lost %s reply cannot send or regain allowance after ledger recovery', async fault => {
  const f = await fixture('lost-' + fault, fault); f.approve(); await f.click('report', true)
  expect(f.counters.report).toBe(0); expect(f.uses()).toHaveLength(1)
  await f.restart(); expect(f.uses()[0].state).toBe('uncertain')
  await f.click('report'); await f.click('brainstorm')
  expect(f.counters.report).toBe(0); expect(f.counters.brainstorm).toBe(0)
}, 60000)

it.skipIf(!enabled)('a real redirect consumes one operation and cannot trigger a second send', async () => {
  const f = await fixture('redirect', 'redirect'); f.approve(); await f.click('report')
  expect(f.counters.report).toBe(1); expect(f.uses()[0].state).toBe('uncertain')
  await f.click('brainstorm'); expect(f.counters.brainstorm).toBe(0)
}, 60000)
