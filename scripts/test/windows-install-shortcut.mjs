// Scratch-only native ownership checks. No HKCU or Start-menu registration.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable runner required')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const helper = join(repo, 'apps/desktop/native-out/windows-install/BMN-shortcut.exe')
assert.ok(existsSync(helper), 'Compile the native shortcut helper first')
const root = mkdtempSync(join(tmpdir(), 'bmn-shortcut-ownership-'))
const target = join(root, 'BMN-launcher.exe')
const checks = []
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const invoke = (path, destination = target) => spawnSync(helper, [destination, root, path], {
  windowsHide: true, encoding: 'utf8', timeout: 30000
})
function succeeds(path, destination = target) {
  const result = invoke(path, destination)
  assert.ok(!result.error && result.status === 0, result.stderr)
}
function refuses(name, path) {
  const before = hash(path), result = invoke(path)
  assert.ok(!result.error && result.status !== null && result.status !== 0, `${name}: refusal required`)
  assert.equal(hash(path), before, `${name}: refused artifact changed`)
  checks.push({ name, status: 'PASS' })
}
const powershell = join(windowsEnvironmentValue(process.env, 'SystemRoot'), 'System32/WindowsPowerShell/v1.0/powershell.exe')
function shell(source, path) {
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; ${source}`, 'utf16le').toString('base64')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, BMN_SHORTCUT_FIXTURE: path, BMN_SHORTCUT_TARGET: target, BMN_SHORTCUT_DIRECTORY: root },
    windowsHide: true, encoding: 'utf8', timeout: 30000
  })
  assert.ok(!result.error && result.status === 0, result.stderr)
  return result.stdout.trim()
}
try {
  writeFileSync(target, 'synthetic target; never executed')
  const legacy = join(root, 'legacy.lnk')
  shell(`$ws=New-Object -ComObject WScript.Shell; $link=$ws.CreateShortcut($env:BMN_SHORTCUT_FIXTURE);
    $link.TargetPath=$env:BMN_SHORTCUT_TARGET; $link.WorkingDirectory=$env:BMN_SHORTCUT_DIRECTORY; $link.Save();`, legacy)
  refuses('same-target interim shortcut without AppID is refused unchanged', legacy)
  const supported = join(root, 'supported.lnk')
  succeeds(supported); succeeds(supported)
  // Independent Windows shell inspection, not the helper's own readback.
  // https://learn.microsoft.com/en-us/windows/win32/shell/shellfolderitem-extendedproperty
  const identity = JSON.parse(shell(`$ws=New-Object -ComObject WScript.Shell; $link=$ws.CreateShortcut($env:BMN_SHORTCUT_FIXTURE);
    $folder=(New-Object -ComObject Shell.Application).NameSpace($env:BMN_SHORTCUT_DIRECTORY);
    $item=$folder.ParseName([IO.Path]::GetFileName($env:BMN_SHORTCUT_FIXTURE));
    if($null -eq $item){throw 'Shortcut shell item missing'};
    @{target=$link.TargetPath; directory=$link.WorkingDirectory; arguments=$link.Arguments;
      appId=$item.ExtendedProperty('System.AppUserModel.ID')} | ConvertTo-Json -Compress;`, supported))
  assert.equal(identity.target.toLowerCase(), target.toLowerCase())
  assert.equal(identity.directory.toLowerCase(), root.toLowerCase())
  assert.equal(identity.arguments, '')
  assert.equal(identity.appId, 'dev.bmn.desktop')
  checks.push({ name: 'supported creation and refresh retain target, directory, empty arguments and AppID', status: 'PASS' })
  const foreign = join(root, 'foreign.lnk'), other = join(root, 'Other.exe')
  writeFileSync(other, 'synthetic foreign target')
  succeeds(foreign, other); refuses('foreign target is refused unchanged', foreign)
  const conflict = join(root, 'conflicting-id.lnk')
  const bytes = readFileSync(supported), needle = Buffer.from('dev.bmn.desktop', 'utf16le')
  const offset = bytes.indexOf(needle)
  assert.ok(offset >= 0 && bytes.indexOf(needle, offset + needle.length) === -1, 'Expected exactly one fixture AppID')
  Buffer.from('org.bad.desktop', 'utf16le').copy(bytes, offset)
  writeFileSync(conflict, bytes)
  refuses('conflicting AppID is refused unchanged', conflict)
  const malformed = join(root, 'malformed.lnk')
  writeFileSync(malformed, 'not a shortcut')
  refuses('malformed shortcut is refused unchanged', malformed)
  const directory = join(root, 'directory.lnk')
  mkdirSync(directory)
  const result = invoke(directory)
  assert.ok(!result.error && result.status !== null && result.status !== 0)
  checks.push({ name: 'directory destination is refused', status: 'PASS' })
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-install-shortcut.json', JSON.stringify({ status: 'PASS', checks }, null, 2))
  console.log(JSON.stringify({ windowsInstallShortcut: 'PASS', checks }))
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
