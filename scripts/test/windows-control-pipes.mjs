// Inspect actual native pipe access before a terminal client connects.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
const root = mkdtempSync(join(tmpdir(), 'bmn-private-control-pipe-'))
let host
try {
  const fixture = join(root, 'host.cjs')
  const receipt = join(root, 'pipes.json')
  writeFileSync(fixture, `const fs=require('node:fs');
const net=require('node:net');
const native=require(${JSON.stringify(requireApp.resolve('node-pty'))});
const pipe='\\\\\\\\.\\\\pipe\\\\bmn-control-'+require('node:crypto').randomBytes(16).toString('hex');
const server=net.createServer(socket=>{socket.on('error',()=>{});socket.on('data',()=>{throw new Error('No synthetic probe should issue a command')});});
server.listen(pipe,()=>{
 const applied=native.restrictControlPipe(pipe);
 if(applied.verifiedCurrentUserOnly!==true)throw new Error('Structural control pipe proof missing');
 fs.writeFileSync(${JSON.stringify(receipt + '.tmp')},JSON.stringify([pipe]));
 fs.renameSync(${JSON.stringify(receipt + '.tmp')},${JSON.stringify(receipt)});
});
`)
  host = spawn(requireApp('electron'), [fixture], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true })
  let ready = false
  const deadline = Date.now() + 15000
  while (!ready && Date.now() < deadline && host.exitCode === null) {
    try { assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).length, 1); ready = true } catch { await delay(100) }
  }
  assert.ok(ready, 'Restricted control pipe was not created')
  const result = spawnSync(process.execPath, [join(repo, 'scripts/test/windows-storage-cross-user.mjs'), '--pipes', receipt, '--pipe-kind', 'control'], {
    cwd: repo, encoding: 'utf8', timeout: 70000, windowsHide: true
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  console.log('PASS actual native control pipe deny another ordinary account and accept the owner')
} finally {
  if (host && host.exitCode === null) {
    const exited = new Promise(resolve => host.once('exit', resolve))
    host.kill()
    await exited
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
