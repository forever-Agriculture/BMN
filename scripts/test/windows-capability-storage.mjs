// Disposable native CI acceptance; no owner account/profile is used as the guest.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Synthetic user/profile creation is restricted to disposable CI')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(repo, 'test-results')
mkdirSync(output, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'bmn-capability-'))
const executable = join(root, 'public', 'capability-fixture.exe')
let child
let receiptWritten = false
try {
  mkdirSync(join(root, 'public'))
  ensurePrivateDirectories([join(root, 'private')])
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const vs = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' })
  assert.equal(vs.status, 0, 'Visual Studio discovery failed')
  const installation = vs.stdout.trim()
  assert.ok(installation && !/["\r\n&|<>%^!]/.test(installation), 'Unexpected compiler installation path')
  const setup = spawnSync(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c',
    `"call "${join(installation, 'Common7', 'Tools', 'VsDevCmd.bat')}" -arch=x64 -host_arch=x64 >nul && set"`],
  { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 30000 })
  assert.equal(setup.status, 0, 'Compiler environment setup failed')
  // Keep the captured environment in memory; never write its values to evidence.
  const compilerEnvironment = Object.fromEntries(setup.stdout.split(/\r?\n/).flatMap(line => {
    const equal = line.indexOf('=')
    return equal > 0 ? [[line.slice(0, equal), line.slice(equal + 1)]] : []
  }))
  const compiled = spawnSync('cl.exe', ['/nologo', '/EHsc', '/std:c++17', '/MT', '/W4',
    join(repo, 'scripts/test/fixtures/windows-capability-storage.cpp'), `/Fe:${executable}`,
    '/link', 'advapi32.lib', 'userenv.lib', 'netapi32.lib', 'bcrypt.lib'],
  { cwd: join(root, 'public'), env: compilerEnvironment, encoding: 'utf8', timeout: 60000 })
  writeFileSync(join(output, 'windows-capability-compile.log'), (compiled.stdout ?? '') + (compiled.stderr ?? ''))
  assert.equal(compiled.error, undefined, 'Native capability fixture compiler did not finish')
  assert.equal(compiled.status, 0, 'Native capability fixture did not compile; see compile receipt')
  child = spawn(executable, ['--supervisor', root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
  const deadline = Date.now() + 45000
  let prepared
  while (Date.now() < deadline && child.exitCode === null) {
    try { prepared = JSON.parse(readFileSync(join(root, 'prepared.json'), 'utf8')); break } catch { await delay(100) }
  }
  assert.equal(prepared?.ownerPositiveControls, true, `Capability fixture did not reach preparation: ${stderr}`)
  // The exact same policy used by BMN must accept the target tree before probing.
  ensurePrivateDirectories([join(root, 'private')], 'win32', join(root, 'private'))
  const targets = ['private/strict.txt', 'private/Cache/cache.txt', 'public/diagnostic-low.txt']
  const hashes = () => Object.fromEntries(targets.map(path => [path,
    createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]))
  const before = hashes()
  writeFileSync(join(root, 'go'), '')
  const timer = setTimeout(() => child.kill(), 100000)
  const code = await exited.finally(() => clearTimeout(timer))
  let receipt
  try { receipt = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) }
  catch { receipt = { passed: false, missingSupervisorReceipt: true } }
  const result = { ...receipt, exitCode: code, stderr, acceptedByRealGuard: true, before, after: hashes(),
    platform: process.platform, os: (await import('node:os')).version() }
  writeFileSync(join(output, 'windows-capability-storage.json'), JSON.stringify(result, null, 2))
  receiptWritten = true
  assert.equal(code, 0, 'Capability acceptance failed; inspect the stage and actual access outcomes')
  assert.equal(receipt.passed, true)
  assert.deepEqual(result.after, before, 'Capability guest modified synthetic private data')
  console.log('PASS real second-user AppContainer capability isolation, controls and cleanup')
} finally {
  if (child && child.exitCode === null) {
    writeFileSync(join(root, 'abort'), '')
    const deadline = Date.now() + 75000
    while (child.exitCode === null && Date.now() < deadline) await delay(100)
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill(); await exited
    }
  }
  // The native rescue validates the generated name and SID before cleanup. It is
  // needed only if the supervisor died before finishing its own cleanup.
  if (!receiptWritten && existsSync(join(root, 'result.json'))) {
    writeFileSync(join(output, 'windows-capability-storage.json'), readFileSync(join(root, 'result.json')))
  }
  if (existsSync(join(root, 'generated-account.txt'))) {
    const rescue = spawnSync(executable, ['--cleanup', root], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.equal(rescue.error, undefined, 'Synthetic capability cleanup did not finish')
    assert.equal(rescue.status, 0, 'Synthetic capability account/profile cleanup failed')
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
