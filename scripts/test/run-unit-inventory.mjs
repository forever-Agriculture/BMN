// Native CI entrypoint: preserve child exit evidence even when no test report is produced.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeUnitObservations, nativeObservationPattern, evaluateNativeObservation } from './native-unit-observations.mjs'

const root = resolve(import.meta.dirname, '../..')
const output = join(root, 'test-results')
mkdirSync(output, { recursive: true })
const receipt = { platform: process.platform, startedAt: new Date().toISOString(), children: [], completed: false }
function save() {
  const path = join(output, 'unit-process.json'), temporary = `${path}.${process.pid}.tmp`
  const serialized = JSON.stringify(receipt, null, 2)
  writeFileSync(temporary, serialized, { mode: 0o600 }); renameSync(temporary, path)
  if (readFileSync(path, 'utf8') !== serialized) throw new Error('Unit process receipt readback differs')
}
async function run(role, arguments_, cwd) {
  const entry = { role, startedAt: new Date().toISOString(), completed: false }
  receipt.children.push(entry); save()
  return await new Promise(resolve => {
    const child = spawn(process.execPath, arguments_, { cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    entry.pid = child.pid; save()
    child.once('error', error => { entry.launchError = error.code ?? 'UNKNOWN' })
    child.once('close', (code, signal) => {
      Object.assign(entry, { completed: true, exitCode: code, signal, completedAt: new Date().toISOString() })
      save(); console.info(`Unit inventory ${role}: exit=${code} signal=${signal ?? 'none'}`)
      resolve(code === 0 && !signal && !entry.launchError ? 0 : 1)
    })
  })
}
save()
if (process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true') {
  // Observe fresh fixture ownership; never repair or adopt an existing path.
  const directory = mkdtempSync(join(tmpdir(), 'bmn-unit-owner-probe-'))
  try {
    const path = join(directory, 'synthetic.txt'); writeFileSync(path, 'synthetic')
    const source = `$ErrorActionPreference='Stop';[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);$r=ConvertFrom-Json ([Console]::In.ReadToEnd());$owner=[IO.File]::GetAccessControl($r.path).GetOwner([Security.Principal.SecurityIdentifier]).Value;$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;[Console]::Out.Write((ConvertTo-Json -Compress @{ownerMatchesUser=($owner -eq $user);ownerIsAdministrators=($owner -eq 'S-1-5-32-544')}))`
    const child = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { input: JSON.stringify({ path }), encoding: 'utf8', timeout: 15000, windowsHide: true })
    receipt.windowsFixture = { systemRootKeys: Object.keys(process.env).filter(name => name.toLowerCase() === 'systemroot'),
      homePresent: typeof process.env.HOME === 'string', exitCode: child.status, launchError: child.error?.code ?? null }
    if (child.status === 0) receipt.windowsFixture.ownership = JSON.parse(child.stdout)
    save()
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
let status = await run('protocol-build', [join(root, 'shared/protocol/node_modules/typescript/bin/tsc'), '-b'], join(root, 'shared/protocol'))
if (status === 0) status = await run('vitest', [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=50%',
  '--exclude', '.claude/**', '--exclude', '.dev-auto/**', '--reporter=default', '--reporter=json',
  '--outputFile.json=test-results/unit.json'], root)
// Preserve the full inventory and its exit before isolated, serial observations.
receipt.inventoryExitCode = status; save()
if (process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' &&
    receipt.children.find(row => row.role === 'protocol-build')?.exitCode === 0) {
  for (const [index, observation] of nativeUnitObservations.entries()) {
    const pattern = nativeObservationPattern(observation)
    const observed = await run(`native-observation-${index + 1}`, [join(root, 'node_modules/vitest/vitest.mjs'),
      'run', observation.file, '-t', pattern, '--maxWorkers=1', '--exclude', '.claude/**', '--exclude', '.dev-auto/**',
      '--reporter=default', '--reporter=json', `--outputFile.json=test-results/native-observation-${index + 1}.json`], root)
    if (observed !== 0) status = 1
    let selection
    try {
      selection = evaluateNativeObservation(JSON.parse(readFileSync(join(output, `native-observation-${index + 1}.json`), 'utf8')), observation, root)
    } catch { selection = { accepted: false, executedExpected: false, missingOrInvalidReport: true } }
    receipt.children.at(-1).selection = selection; save()
    if (!selection.accepted) { status = 1; console.error(`Native observation ${index + 1} did not execute and pass the intended test within its original budget`) }
  }
}
Object.assign(receipt, { completed: true, completedAt: new Date().toISOString(), exitCode: status }); save()
writeFileSync(join(output, 'unit-exit-code'), `${status}\n`, { mode: 0o600 })
process.exitCode = status
