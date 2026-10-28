// MODULE: team-browser-scripts.mjs - Real interactive Playwright callbacks through the browser ask's relay, with synthetic loopback data only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { browserRecord, browserServer, browserTemporary, browserTools, sessionCalls } from '../../apps/desktop/bin/agents-team-browser.mjs'
import { recordProcess, stopProcess } from './browser-accounts-fixture.mjs'

const out = resolve(process.argv[2] || '.dev-auto/evidence/browser-script-20261028/live')
mkdirSync(out, { recursive: true })
assert(browserTools(true).includes('browser_run_code_unsafe'), 'interactive asks must offer the actual pinned callback tool')
assert(browserTools(true).includes('browser_evaluate'), 'interactive asks must offer page evaluation')
assert(!browserTools(false).includes('browser_run_code_unsafe'), 'look-only scope')
recordProcess(process.pid, '74.5 isolated synthetic browser callback driver')
const site = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><html><head><title>Synthetic scripted check</title></head><body><main><h1>Script check</h1><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').value=String(Number(document.querySelector(\'output\').value)+1)">Add</button><output>0</output></main></body></html>')
})
await new Promise(ok => site.listen(0, '127.0.0.1', ok))
const origin = `http://127.0.0.1:${site.address().port}`
const browser = { origin, interact: true, tools: browserTools(true) }
const folder = join(out, `run-${process.pid}`), own = join(folder, 'browser')
mkdirSync(own, { recursive: true })
const server = browserServer(browser, folder)
writeFileSync(join(out, 'server.json'), JSON.stringify({ ...server, allowedTools: browserTools(true) }, null, 2))
const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'] })
const entry = recordProcess(child.pid, '74.5 candidate browser ask relay and isolated MCP server')
let ended = false, next = 0, stderr = ''
const closed = once(child, 'close').then(() => { ended = true })
child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000) })
const pending = new Map()
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id); clearTimeout(waiter.timer)
  if (message.error) waiter.reject(new Error(message.error.message))
  else waiter.resolve(message.result)
})
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++next
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30_000)
  pending.set(id, { resolve, reject, timer })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const call = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args })
  assert(!result.isError, `${name}: ${JSON.stringify(result)}`)
  return result
}
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
const value = result => {
  const block = /^### Result\n([\s\S]*?)(?=\n### |$)/mu.exec(text(result))
  assert(block, 'native MCP returned a result section')
  return JSON.parse(block[1])
}
const cases = []
let failure, assertionFailure
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bmn-synthetic-script-check', version: '1' } })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const { tools } = await rpc('tools/list', {})
  for (const name of browserTools(true)) assert(tools.some(tool => tool.name === name), `server contract: ${name}`)
  await call('browser_navigate', { url: origin })
  for (const width of [360, 1440]) for (const theme of ['light', 'dark', 'gold']) {
    const code = `async page => {
      await page.setViewportSize({ width: ${width}, height: 900 });
      await page.goto(${JSON.stringify(`${origin}/?theme=${theme}`)});
      await page.getByLabel('Name').fill('synthetic');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('output').value === '2');
      const state = await page.evaluate(() => ({ name: document.querySelector('#name').value,
        count: document.querySelector('output').value, width: innerWidth,
        theme: new URL(location.href).searchParams.get('theme') }));
      if (state.name !== 'synthetic' || state.count !== '2' || state.width !== ${width} || state.theme !== ${JSON.stringify(theme)})
        throw new Error('Callback assertions failed: ' + JSON.stringify(state));
      return { marker: 'callback-${width}-${theme}', assertions: 4, ...state };
    }`
    const result = value(await call('browser_run_code_unsafe', { code }))
    assert.deepEqual(result, { marker: `callback-${width}-${theme}`, assertions: 4, name: 'synthetic', count: '2', width, theme })
    const evaluated = value(await call('browser_evaluate', { function: '() => document.querySelector("output").value' }))
    assert.equal(evaluated, '2')
    const screenshot = `script-${width}-${theme}.png`
    await call('browser_take_screenshot', { filename: screenshot, type: 'png', fullPage: true })
    cases.push({ width, theme, assertions: 4, screenshot, result })
  }
  const rejected = await rpc('tools/call', { name: 'browser_run_code_unsafe', arguments: {
    code: 'async page => { if (await page.title() !== "intentionally impossible") throw new Error("synthetic assertion fence"); }'
  } })
  assert.equal(rejected.isError, true, 'a failing callback assertion must propagate as an error')
  assert(text(rejected).includes('synthetic assertion fence'))
  assertionFailure = { isError: rejected.isError, text: text(rejected) }
  writeFileSync(join(out, 'assertion-failure.json'), JSON.stringify(assertionFailure, null, 2))
  await call('browser_close', {})
} catch (error) { failure = error }
finally {
  child.stdin.end()
  let timeout
  try { await Promise.race([closed, new Promise(ok => { timeout = setTimeout(ok, 5000) })]) }
  finally { clearTimeout(timeout) }
  if (!ended) { stopProcess(entry); await closed }
  lines.close()
  for (const waiter of pending.values()) clearTimeout(waiter.timer)
  site.closeAllConnections(); await new Promise(ok => site.close(ok))
  writeFileSync(join(out, 'stderr.log'), stderr)
  rmSync(browserTemporary(folder), { recursive: true, force: true })
}
if (failure) throw failure
const { record } = browserRecord(folder, browser)
const calls = readdirSync(own).filter(name => /^session-[0-9]+$/u.test(name))
  .flatMap(name => sessionCalls(readFileSync(join(own, name, 'session.md'), 'utf8')))
assert.equal(cases.length, 6)
assert.equal(calls.filter(call => call.tool === 'browser_run_code_unsafe').length, 6, 'six successful callbacks are in the native session log')
assert.equal(record.screenshots.length, 6, 'real server screenshots retained by BMN')
writeFileSync(join(out, 'browser.json'), JSON.stringify(record, null, 2))
writeFileSync(join(out, 'result.json'), JSON.stringify({ result: 'PASS', cases, calls: record.calls, assertionFailure,
  checks: ['existing tools retained; native callback and evaluate offered only with --interact',
    'candidate browserServer/relay and pinned MCP execute six complete callbacks with assertions',
    'real screenshot artifacts and completed calls retained through browserRecord/sessionCalls'],
  limits: ['native session log records successful calls; assertion failure is retained separately',
    'no provider/installed-helper claim; native client argv tested separately; no real accounts or Q-Automations retry'] }, null, 2))
console.log('PASS: six real Playwright callbacks, evaluation and retained screenshots through the candidate relay')
