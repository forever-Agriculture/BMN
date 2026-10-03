// Bounded synthetic diagnosis of the native hook boundary, without provider calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
assert.equal(process.platform, 'win32')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const native = createRequire(join(repo, 'apps/desktop/package.json'))('node-pty')
const root = mkdtempSync(join(tmpdir(), 'bmn-native-hook-probe-'))
const pipe = `\\\\.\\pipe\\bmn-control-${randomBytes(16).toString('hex')}`
const endpoint = join(root, 'control.sock')
const calls = []
const server = createServer(socket => {
  let pending = ''
  socket.on('error', () => {})
  socket.on('data', data => {
    pending += data
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      const request = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1)
      // No tokens, input text or paths are recorded. This server has no app privileges.
      calls.push({ method: request.method, event: request.params?.event ?? null })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: request.method === 'auth' ? { scope: 'session', sessionId: 'synthetic', incarnationId: 'one' } : { recorded: true } }) + '\n')
    }
  })
})
const run = (args, proc) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, BMN_CONTROL_SOCKET: endpoint,
    BMN_TOKEN: 'synthetic-no-app-authority', BMN_PROC_ROOT: proc, CLAUDE_CONFIG_DIR: join(root, 'claude') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const timer = setTimeout(() => child.kill(), 10000)
  child.on('error', reject)
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  child.stdin.end(JSON.stringify({ hook_event_name: 'Stop' }))
})
const receipt = { platform: process.platform, acceptance: 'INCONCLUSIVE', scenarios: [] }
try {
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(pipe, resolve) })
  const applied = native.restrictControlPipe(pipe)
  assert.equal(applied.verifiedCurrentUserOnly, true)
  writeFileSync(endpoint, pipe + '\n')
  const proc = join(root, 'proc')
  for (const [pid, comm, parent] of [[process.pid, 'sh', 7001], [7001, 'claude', 1]]) {
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${parent} 7001 7001 34817 7001 4194304 0\n`)
  }
  const metadata = `const fs=require('node:fs'),path=require('node:path');let input,error;
try{input=fs.readFileSync(0,'utf8')}catch(e){error=e.code}
let stat;try{stat=fs.readFileSync(path.join(process.env.BMN_PROC_ROOT,String(process.ppid),'stat'),'utf8')}catch{}
console.log(JSON.stringify({ppidMatchesFixture:process.ppid===${process.pid},parentStatPresent:!!stat,inputBytes:input?.length??null,stdinError:error??null,inputObject:input?typeof JSON.parse(input)==='object':false}));`
  receipt.stdin = await run(['-e', metadata], proc)
  for (const scenario of ['foreground-fixture', 'missing-proc']) {
    calls.length = 0
    const result = await run([join(repo, 'apps/desktop/bin/bmn'), 'hook', 'claude'], scenario === 'missing-proc' ? join(root, 'absent') : proc)
    receipt.scenarios.push({ scenario, result, calls: [...calls] })
  }
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-hook-diagnostic.json', JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
