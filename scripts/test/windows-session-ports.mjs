// Native TCP attribution through retained session jobs; all servers are synthetic.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

assert.equal(process.platform, 'win32', 'Native Windows required')
const requireApp = createRequire(resolve('apps/desktop/package.json'))
const pty = requireApp('node-pty')
const root = mkdtempSync(join(tmpdir(), 'bmn-owned-ports-'))
const receipts = { checks: [], status: 'FAIL' }
const terminals = []
let browser
const unrelated = createServer(socket => socket.end('unrelated'))
const listen = (server, address) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, address, () => resolve(server.address().port))
})
async function until(check) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(40)
  }
  throw Error('Synthetic native listener readiness timed out')
}
const fixture = join(root, 'servers.cjs')
writeFileSync(fixture, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http');
const [dir,role]=process.argv.slice(2);const servers=[];
(async()=>{for(const address of ['127.0.0.1','::1']) {const server=http.createServer((request,response)=>response.end(role));servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,address,resolve)});}
fs.writeFileSync(path.join(dir,role+'.json'),JSON.stringify({pid:process.pid,ports:servers.map(s=>s.address().port)}));
if(role!=='grandchild')cp.spawn(process.execPath,[__filename,dir,role==='root'?'child':'grandchild'],{stdio:'ignore',detached:true});
if(role==='root'){process.stdin.setEncoding('utf8');process.stdin.on('data',()=>process.stdout.write('BMN_PORT_INPUT_OK\\n'));}
let closed=false;setInterval(()=>{if(!closed&&fs.existsSync(path.join(dir,'close'))){closed=true;for(const server of servers)server.close();}},20);
})().catch(()=>process.exit(7));
`)
function ownedProgram(name, executable, argv) {
  const directory = join(root, name); mkdirSync(directory)
  const terminal = pty.spawn(executable, argv, {
    cwd: directory, env: { ...process.env }, useConpty: true, useConptyDll: true
  })
  let output = ''
  terminal.onData(bytes => { output = (output + bytes).slice(-8192) })
  const exit = new Promise(resolve => terminal.onExit(resolve))
  const result = { directory, terminal, exit, output: () => output }
  terminals.push(result); return result
}
function session(name) {
  return ownedProgram(name, process.execPath, [fixture, join(root, name), 'root'])
}
async function ownedBrowser() {
  const binary = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']
    .map(key => windowsEnvironmentValue(process.env, key)).filter(Boolean)
    .map(directory => join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(existsSync)
  assert.ok(binary, "The native gate requires the runner image's installed Edge")
  const profile = join(root, 'browser', 'profile')
  const launch = ownedProgram('browser', binary, [
    '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-proxy-server',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ])
  assert.equal(launch.terminal.processOwnership, 'windows-job')
  const port = await until(() => {
    try {
      const value = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      return Number.isInteger(value) && value > 0 && value <= 65535 && value
    } catch { return undefined }
  })
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 })
  receipts.browser = { product: 'Microsoft Edge', version: browser.version(), ownedJob: true }
  const page = await browser.contexts()[0].newPage()
  return page
}
function readRoles(directory) {
  try { return ['root', 'child', 'grandchild'].map(role => ({ role, ...JSON.parse(readFileSync(join(directory, role + '.json'), 'utf8')) })) }
  catch { return undefined }
}
async function snapshot(session) {
  try { return await session.terminal.queryListeningPorts() } catch { return [] }
}
async function httpBody(address, port) {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: address, port, timeout: 2000 }, response => {
      let body = ''; response.on('data', bytes => { body += bytes }); response.once('end', () => resolve(body))
    })
    request.once('timeout', () => request.destroy(Error('Synthetic HTTP timeout'))); request.once('error', reject)
  })
}
try {
  const unrelatedPort = await listen(unrelated, '127.0.0.1')
  const first = session('first'), second = session('second')
  assert.equal(first.terminal.processOwnership, 'windows-job')
  assert.equal(typeof first.terminal.queryListeningPorts, 'function')
  const rolesA = await until(() => readRoles(first.directory)), rolesB = await until(() => readRoles(second.directory))
  const expected = roles => new Set(roles.flatMap(role => role.ports))
  const expectedA = expected(rolesA), expectedB = expected(rolesB)
  const complete = (rows, ports) => rows.length === ports.size && rows.every(row => ports.has(row.port))
  const rowsA = await until(async () => { const rows = await snapshot(first); return complete(rows, expectedA) && rows })
  const rowsB = await until(async () => { const rows = await snapshot(second); return complete(rows, expectedB) && rows })
  const page = await ownedBrowser()
  for (const [rows, roles] of [[rowsA, rolesA], [rowsB, rolesB]]) {
    for (const row of rows) {
      const role = roles.find(role => role.pid === row.pid)
      assert.ok(role && role.ports.includes(row.port)); assert.equal(row.command.toLowerCase(), 'node.exe')
      assert.ok(['127.0.0.1', '::1'].includes(row.address)); assert.notEqual(row.port, unrelatedPort)
      assert.equal(await httpBody(row.address, row.port), role.role)
      const host = row.address === '::1' ? '[::1]' : row.address
      const response = await page.goto(`http://${host}:${row.port}/`, { timeout: 5000, waitUntil: 'domcontentloaded' })
      assert.equal(response.status(), 200)
      assert.equal(await page.locator('body').innerText(), role.role)
    }
  }
  receipts.checks.push({ name: "actual owned Edge browser navigates to both sessions' IPv4/IPv6 root/child/grandchild servers", status: 'PASS' })
  await browser.close(); browser = undefined
  receipts.checks.push({ name: 'two retained jobs attribute IPv4/IPv6 root/child/grandchild HTTP listeners; unrelated listener excluded', status: 'PASS' })
  const began = Date.now(); const pending = first.terminal.queryListeningPorts()
  first.terminal.write('synthetic input\r')
  await until(() => first.output().includes('BMN_PORT_INPUT_OK')); await pending
  receipts.inputAndScanMs = Date.now() - began
  assert.ok(receipts.inputAndScanMs < 2000)
  receipts.checks.push({ name: 'input remains responsive during asynchronous native query', status: 'PASS' })
  writeFileSync(join(first.directory, 'close'), '')
  await until(async () => (await first.terminal.queryListeningPorts()).length === 0)
  receipts.checks.push({ name: 'closing all owned listeners removes current port results', status: 'PASS' })
  first.terminal.kill(); await Promise.race([first.exit, delay(5000).then(() => { throw Error('Owned session stop timed out') })])
  await assert.rejects(first.terminal.queryListeningPorts())
  assert.equal(unrelated.listening, true)
  assert.equal(complete(await second.terminal.queryListeningPorts(), expectedB), true)
  receipts.checks.push({ name: 'stopped job query refuses; another session and unrelated listener survive', status: 'PASS' })
  const inFlight = second.terminal.queryListeningPorts()
  second.terminal.kill()
  await Promise.race([second.exit, delay(5000).then(() => { throw Error('Stop during port query timed out') })])
  await inFlight.catch(() => undefined)
  assert.equal(unrelated.listening, true)
  receipts.checks.push({ name: 'Stop during a native query confirms owned exit without touching unrelated listener', status: 'PASS' })
  receipts.status = 'PASS'
} catch (error) {
  receipts.failure = { name: error.name, message: error.message }; process.exitCode = 1
} finally {
  await browser?.close().catch(() => { receipts.status = 'FAIL'; process.exitCode = 1 })
  for (const session of terminals) {
    session.terminal.kill()
    await Promise.race([session.exit, delay(5000).then(() => { throw Error('Synthetic owned process cleanup timed out') })])
      .catch(() => { receipts.status = 'FAIL'; process.exitCode = 1 })
  }
  await new Promise(resolve => unrelated.close(resolve))
  rmSync(root, { recursive: true, force: true })
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-session-ports.json', JSON.stringify(receipts, null, 2))
}
console.log(JSON.stringify(receipts))
