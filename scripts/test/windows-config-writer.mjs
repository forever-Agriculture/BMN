// MODULE: windows-config-writer.mjs - synthetic native ACL, sharing and replacement race acceptance
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { writeAtomically, writeConfigSafely } from '../../apps/desktop/bin/safe-config-write.mjs'

assert.equal(process.platform, 'win32', 'Native Windows required')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable runner only')
const root = mkdtempSync(join(tmpdir(), 'bmn-config-native-'))
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const receipts = { defaultOwner: null, checks: [] }
const children = new Set()
const aclSource = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
$r=ConvertFrom-Json ([Console]::In.ReadToEnd())
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if($r.protect) {
 $acl=New-Object Security.AccessControl.FileSecurity
 $owner=if($r.foreign) { New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544') } else {$sid}
 $acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
 if($r.denyDelete) {$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Delete','Deny')))}
 [IO.File]::SetAccessControl($r.path,$acl)
}
$acl=[IO.File]::GetAccessControl($r.path)
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
 @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[int]$_.AccessControlType;inherited=$_.IsInherited}
})
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 5 @{user=$sid.Value;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;rules=$rules}))
`
function acl(path, options = {}) {
  const child = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclSource, 'utf16le').toString('base64')],
    { input: JSON.stringify({ path, ...options }), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(child.status, 0, 'Synthetic ACL fixture failed')
  return JSON.parse(child.stdout)
}
function file(name, text) {
  const path = join(root, name); writeFileSync(path, text)
  receipts.defaultOwner ??= acl(path)
  acl(path, { protect: true }); return path
}
function temps() { return readdirSync(root).filter(name => name.endsWith('.tmp')) }
async function check(name, callback) {
  await callback(); receipts.checks.push({ name, status: 'PASS' })
}
async function waitFor(path) {
  const deadline = Date.now() + 12000
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, 'Synthetic handshake timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const workerSource = `const {workerData:d,parentPort} = require('node:worker_threads');
(async()=>{try {const {writeConfigSafely}=await import(d.moduleUrl); parentPort.postMessage({ok:true,result:writeConfigSafely(d.path,d.expected,d.next)})}
catch(e){parentPort.postMessage({ok:false,code:e.code,recoveryRequired:e.recoveryRequired===true})}})();`
function workerWrite(path, expected, next, gate) {
  const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl: new URL('../../apps/desktop/bin/safe-config-write.mjs', import.meta.url).href, path, expected, next },
    env: { ...process.env, NODE_ENV: 'test', BMN_CONFIG_WRITE_TEST_GATE: gate } })
  const exited = once(worker, 'exit')
  let received = false
  const result = new Promise((resolve, reject) => {
    worker.once('message', message => { received = true; resolve(message) })
    worker.once('error', reject)
    worker.once('exit', code => { if (!received || code !== 0) reject(new Error('Synthetic config worker failed')) })
  })
  return { worker, result, exited }
}
try {
  await check('protected original and backup preserve owner/DACL with Unicode', () => {
    const path = file('existing.json', 'BEFORE 雪'), before = acl(path)
    const result = writeConfigSafely(path, 'BEFORE 雪', 'AFTER 雪')
    assert.equal(readFileSync(path, 'utf8'), 'AFTER 雪')
    assert.equal(readFileSync(result.backup, 'utf8'), 'BEFORE 雪')
    assert.deepEqual(acl(path), before); assert.deepEqual(acl(result.backup), before)
    assert.deepEqual(temps(), [])
  })
  await check('staged file current-owner private before publication', () => {
    const path = file('stage.json', 'BEFORE')
    writeConfigSafely(path, 'BEFORE', 'AFTER', { beforeCommit: () => {
      const names = temps(); assert.equal(names.length, 1)
      const security = acl(join(root, names[0]))
      assert.equal(security.owner, security.user); assert.equal(security.protected, true)
      assert.deepEqual(security.rules, [{ sid: security.user, rights: 2032127, type: 0, inherited: false }])
    } })
  })
  await check('new file is private and has no backup', () => {
    const path = join(root, 'new.json'), result = writeConfigSafely(path, null, 'NEW')
    assert.equal(result.backup, null)
    const security = acl(path)
    assert.equal(security.owner, security.user); assert.equal(security.protected, true)
    assert.deepEqual(security.rules, [{ sid: security.user, rights: 2032127, type: 0, inherited: false }])
  })
  await check('foreign-owned original refused before staging', () => {
    const path = file('foreign.json', 'FOREIGN'); acl(path, { protect: true, foreign: true })
    const before = acl(path); assert.notEqual(before.owner, before.user)
    assert.throws(() => writeConfigSafely(path, 'FOREIGN', 'OURS'))
    assert.equal(readFileSync(path, 'utf8'), 'FOREIGN'); assert.deepEqual(acl(path), before); assert.deepEqual(temps(), [])
    acl(path, { protect: true })
  })
  await check('denied replacement preserves data/ACL and cleans owned stage', () => {
    const path = file('denied.json', 'BEFORE'); acl(path, { protect: true, denyDelete: true })
    const before = acl(path)
    assert.throws(() => writeConfigSafely(path, 'BEFORE', 'OURS'))
    assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.deepEqual(acl(path), before); assert.deepEqual(temps(), [])
    acl(path, { protect: true })
  })
  await check('existing write handle refuses publication without truncation', async () => {
    const path = file('sharing.json', 'BEFORE')
    const script = `$ErrorActionPreference='Stop';$r=ConvertFrom-Json ([Console]::In.ReadLine());$f=[IO.File]::Open($r.path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);[Console]::Out.WriteLine('READY');[Console]::Out.Flush();try {[Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}`
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.add(child); const exited = once(child, 'exit')
    child.stdin.write(`${JSON.stringify({ path })}\n`)
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Sharing fixture startup timed out')), 10000)
        child.stdout.once('data', data => { clearTimeout(deadline); if (data.toString().includes('READY')) resolve(); else reject(new Error('Sharing fixture failed')) })
        child.once('error', error => { clearTimeout(deadline); reject(error) })
      })
      assert.throws(() => writeConfigSafely(path, 'BEFORE', 'OURS'))
      assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.deepEqual(temps(), [])
    } finally { child.stdin.end('RELEASE\n'); await exited; children.delete(child) }
  })
  await check('failed preparation cleans its exclusively created stage', () => {
    const path = join(root, 'prepare-failure.json')
    assert.throws(() => writeAtomically(path, undefined))
    assert.equal(existsSync(path), false); assert.deepEqual(temps(), [])
  })
  await check('retained original handle rejects a racing in-place writer', async () => {
    const path = file('inplace.json', 'BEFORE'), gate = join(root, 'inplace.release')
    const pending = workerWrite(path, 'BEFORE', 'OURS', gate)
    try {
      await waitFor(`${gate}.waiting`)
      assert.throws(() => writeFileSync(path, 'THEIRS'))
      writeFileSync(gate, '')
      assert.equal((await pending.result).ok, true)
      assert.equal(readFileSync(path, 'utf8'), 'OURS')
    } finally { writeFileSync(gate, ''); await pending.exited }
  })
  await check('namespace race retains displaced edit and reports recovery without rollback', async () => {
    const path = file('rename.json', 'BEFORE'), substitute = file('substitute.json', 'THEIRS'), gate = join(root, 'rename.release')
    const pending = workerWrite(path, 'BEFORE', 'OURS', gate)
    try {
      await waitFor(`${gate}.waiting`)
      renameSync(substitute, path); writeFileSync(gate, '')
      assert.deepEqual(await pending.result, { ok: false, code: 'RECOVERY_REQUIRED', recoveryRequired: true })
      assert.equal(readFileSync(path, 'utf8'), 'OURS')
      const backups = readdirSync(root).filter(name => name.startsWith('rename.json.bmn-backup-'))
      assert.equal(backups.length, 1); assert.equal(readFileSync(join(root, backups[0]), 'utf8'), 'THEIRS')
    } finally { writeFileSync(gate, ''); await pending.exited }
  })
  receipts.status = 'PASS'
} catch (error) {
  receipts.status = 'FAIL'; receipts.failure = { name: error.name, code: error.code ?? null, message: error.message }
  process.exitCode = 1
} finally {
  for (const child of children) child.kill() // Retained native child handle; never PID lookup/kill.
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/windows-config-writer.json', JSON.stringify(receipts, null, 2))
  for (const name of readdirSync(root)) { try { acl(join(root, name), { protect: true }) } catch { /* Synthetic cleanup still attempts removal. */ } }
  rmSync(root, { recursive: true, force: true })
}
console.log(JSON.stringify(receipts))
