#!/usr/bin/env node
// MODULE: qa-fragments-live.mjs - live browser/loopback proof of the reviewed GraphQL fragment request boundary
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { gateQaRequest, picheReadContract } from '../../apps/desktop/bin/qa-request-gate.mjs'

const evidence = resolve(process.argv[2] ?? '.dev-auto/evidence/113.8-fragments-live')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const save = (name, data) => {
  const path = join(evidence, name), temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
}
const identity = pid => ({ pid, start_ticks: readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] })
const started = { driver: identity(process.pid), browser: null, origins: null }
save('started.json', started)
const calls = [], events = [], results = [], servers = []
let browserServer, browser
const start = async handler => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  return `http://127.0.0.1:${server.address().port}`
}
const cases = [
  ['inline', 'query AutomationSession { automationSession { id } }', true],
  ['named', 'query AutomationSession { automationSession { ...Session } } fragment Session on AutomationSession { id }', true],
  ['nested-root', 'fragment Identity on AutomationSession { id } fragment Session on AutomationSession { ...Identity } fragment Root on Query { selected: automationSession { ...Session } } query AutomationSession { ...Root }', true],
  ['mutation', 'mutation AutomationSession { automationSession { id } }', false],
  ['cycle', 'query AutomationSession { automationSession { ...Session } } fragment Session on AutomationSession { ...Session }', false],
  ['missing', 'query AutomationSession { automationSession { ...Missing } }', false],
  ['extra-root', 'query AutomationSession { automationSession { id } ...Extra } fragment Extra on Query { automations { id } }', false],
  ['repeated-root', 'query AutomationSession { ...Root ...Root } fragment Root on Query { automationSession { id } }', false],
  ['introspection', 'query AutomationSession { automationSession { ...Session } } fragment Session on AutomationSession { __schema { types { name } } }', false],
  ['directive', 'query AutomationSession { automationSession { ...Session @defer } } fragment Session on AutomationSession { id }', false]
]
try {
  const api = await start((request, response) => {
    let body = ''
    request.on('data', bytes => { body += bytes })
    request.on('end', () => {
      const query = JSON.parse(body).query, digest = createHash('sha256').update(query).digest('hex')
      calls.push(digest); events.push({ kind: 'network', digest })
      response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      response.end('{"data":{"automationSession":{"id":"synthetic"}}}')
    })
  })
  const page = await start((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Synthetic fragment request checks</title><body>Ready</body>')
  })
  const signIn = await start((request, response) => { response.writeHead(404); response.end() })
  const origins = { page, api, signIn }, contract = picheReadContract(origins)
  started.origins = origins
  const broker = {
    policy: async () => ({ active: true, contract, origins: [page] }),
    observe: async meta => { events.push({ kind: 'observe', meta }) },
    hold: async meta => { events.push({ kind: 'hold', meta }) },
    reserve: async () => { throw new Error('No activity is authorized') },
    gap: async () => { throw new Error('Unexpected broker gap') }
  }
  browserServer = await chromium.launchServer({ executablePath: process.env.BMN_QA_CHROME ?? '/usr/bin/google-chrome', headless: true, chromiumSandbox: true })
  started.browser = identity(browserServer.process().pid)
  save('started.json', started)
  browser = await chromium.connect(browserServer.wsEndpoint())
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => gateQaRequest(route, broker, () => context.close()))
  const tab = await context.newPage()
  await tab.goto(page)
  for (const [name, query, allowed] of cases) {
    const before = calls.length, eventOffset = events.length
    const observed = await tab.evaluate(async ({ api, query }) => {
      try {
        const response = await fetch(`${api}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
        await response.text()
        return response.status
      } catch { return 'held' }
    }, { api, query })
    assert.equal(observed, allowed ? 200 : 'held', name)
    assert.equal(calls.length - before, allowed ? 1 : 0, `${name}: actual API sends`)
    assert.deepEqual(events.slice(eventOffset).map(event => event.kind), allowed ? ['observe', 'network'] : ['hold'], `${name}: audit before send`)
    const detail = events[eventOffset].meta.body
    assert.deepEqual(Object.keys(detail).sort(), ['kind', 'name', 'operation', 'sha256'])
    assert.equal(detail.name, allowed ? 'AutomationSession' : null)
    results.push({ name, allowed, observed, actualApiSends: calls.length - before, pass: true })
    console.log(`PASS ${name}: ${allowed ? 'audited then sent' : 'held before send'}`)
  }
  save('result.json', { version: 1, pass: true, contractSha256: contract.sha256, cases: results, apiSends: calls.length })
} catch (error) {
  save('result.json', { version: 1, pass: false, cases: results, error: error.message })
  throw error
} finally {
  await browser?.close()
  await browserServer?.close()
  await Promise.all(servers.map(server => new Promise(done => { server.closeAllConnections(); server.close(done) })))
  save('cleanup.json', { closed: true, driver: started.driver, browser: started.browser, servers: servers.length })
}
