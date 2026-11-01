/* global document, addEventListener */
// MODULE: qa-workers-live.test.mjs - opt-in real Chrome proof that no worker traffic leaves a QA browser around its routes and their audit
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { browserLibraries } from '../../apps/desktop/bin/browser-accounts-engine.mjs'
import { gateQaRequest, qaNoWorkers } from '../../apps/desktop/bin/qa-request-gate.mjs'

const enabled = process.env.BMN_QA_WORKERS_LIVE === '1'

/** Runs in the page: a blob SharedWorker, a blob dedicated Worker and a data: frame's SharedWorker each POST and open a WebSocket. */
function probe(origin) {
  const start = (kind, name, origin) => {
    const hit = `${origin}/hit/${name}`, socket = `${origin.replace('http', 'ws')}/ws/${name}`
    const code = `fetch(${JSON.stringify(hit)}, { method: 'POST', mode: 'no-cors', body: 'synthetic' }).catch(() => {}); try { new WebSocket(${JSON.stringify(socket)}) } catch {}`
    try {
      const Kind = kind === 'shared' ? globalThis.SharedWorker : globalThis.Worker
      if (typeof Kind !== 'function') return 'missing'
      new Kind(globalThis.URL.createObjectURL(new globalThis.Blob([code], { type: 'text/javascript' }))); return 'started'
    } catch { return 'refused' }
  }
  const frame = new Promise(done => {
    addEventListener('message', event => done(event.data), { once: true }); setTimeout(() => done('silent'), 3000)
    const element = document.createElement('iframe')
    element.src = 'data:text/html,' + encodeURIComponent(`<script>parent.postMessage((${start})('shared', 'frame', ${JSON.stringify(origin)}), '*')</script>`)
    document.body.append(element)
  })
  return frame.then(inFrame => ({ shared: start('shared', 'shared', origin), dedicated: start('dedicated', 'dedicated', origin), frame: inFrame }))
}

/** The routes as they were before the fix: every GET fetched and fulfilled unchanged, everything else held. */
async function plainRoute(route) {
  if (route.request().method() !== 'GET') { await route.abort('blockedbyclient'); return }
  const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 })
  try { await route.fulfill({ response }) } finally { await response.dispose() }
}

async function arm(name, { script, gate }) {
  const counters = { hit: {}, ws: {}, other: 0 }, held = [], count = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1 }
  const service = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>Synthetic worker probe</title><body><p>Synthetic worker probe</p>'); return }
    const hit = /^\/hit\/(\w+)$/.exec(request.url ?? '')
    if (hit) { count(counters.hit, hit[1]); response.writeHead(204).end(); return }
    if (request.url !== '/favicon.ico') counters.other++
    response.writeHead(404).end()
  })
  service.on('upgrade', (request, socket) => { count(counters.ws, (request.url ?? '').split('/').pop()); socket.destroy() })
  await new Promise(ok => service.listen(0, '127.0.0.1', ok))
  const origin = `http://127.0.0.1:${service.address().port}`, base = resolve('.dev-auto/evidence/switch/workers-live')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const profile = mkdtempSync(join(base, name + '-'))
  const context = await browserLibraries().chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', acceptDownloads: false })
  try {
    // The relay's order: the worker rule, then the routes, before any page opens (qa-browser-relay.mjs beforeReady).
    if (script) await context.addInitScript(qaNoWorkers)
    const broker = { policy: async () => ({ active: true, contract: null, origins: [origin] }), observe: async () => {}, hold: async request => { held.push(request.path) }, gap: async () => {} }
    await context.route('**/*', gate ? route => gateQaRequest(route, broker, async () => {}) : plainRoute)
    await context.routeWebSocket(/.*/, socket => socket.close())
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(origin)
    const started = await page.evaluate(probe, origin)
    await new Promise(ok => setTimeout(ok, 2500))
    return { name, started, counters, held }
  } finally {
    await context.close(); service.closeAllConnections(); await new Promise(ok => service.close(ok)); rmSync(profile, { recursive: true, force: true })
  }
}

const leaks = ({ counters }) => Object.values(counters.hit).concat(Object.values(counters.ws)).reduce((sum, value) => sum + value, 0)

it.skipIf(!enabled)('worker requests and sockets bypass plain routes, and neither the QA policy nor its init script lets one start', async () => {
  const results = []
  for (const [name, options] of [['unprotected', {}], ['policy-only', { gate: true }], ['script-only', { script: true }], ['qa', { script: true, gate: true }]]) results.push(await arm(name, options))
  const receipt = { scope: 'system Chrome through the pinned patched Playwright, headless, synthetic loopback service; no account or profile data', results }
  writeFileSync(resolve('.dev-auto/evidence/switch/workers-live/receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  const [unprotected, ...guarded] = results
  // The hazard in this browser: without the rule a SharedWorker's POST reaches the service although every route holds POSTs.
  expect(unprotected.counters.hit.shared).toBeGreaterThan(0)
  for (const result of guarded) {
    expect(result.counters, result.name).toEqual({ hit: {}, ws: {}, other: 0 })
    expect(leaks(result), result.name).toBe(0)
  }
  // Under the policy alone a constructor still returns but its worker never loads; the init script leaves no constructor at all.
  for (const result of guarded.filter(result => result.name !== 'policy-only')) expect(Object.values(result.started), result.name).toEqual(['missing', 'missing', 'missing'])
}, 120_000)
