// Real Windows ACL regressions; the Linux mode test is in private-directory.test.ts.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensurePrivateDirectories } from './private-directory'

const temporary: string[] = []
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-windows-acl-'))
  temporary.push(root)
  return root
}
function powershell(path: string, operation: string): string {
  const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); $path=ConvertFrom-Json ([Console]::In.ReadToEnd()); $item=if ([System.IO.Directory]::Exists($path)) { New-Object System.IO.DirectoryInfo($path) } else { New-Object System.IO.FileInfo($path) }; ${operation}`
  const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { input: JSON.stringify(path), encoding: 'utf8', timeout: 15_000, windowsHide: true })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
const broaden = `$acl=$item.GetAccessControl(); $acl.SetAccessRuleProtection($true,$true); $everyone=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,'ReadAndExecute','Allow'); $acl.AddAccessRule($rule); $item.SetAccessControl($acl)`
const sddl = `$item.GetAccessControl().Sddl`

describe.skipIf(process.platform !== 'win32')('native Windows private roots', () => {
  it('creates private roots and accepts inherited files on restart', { timeout: 60_000 }, () => {
    const root = join(fixture(), 'new 数据')
    ensurePrivateDirectories([root])
    mkdirSync(join(root, 'child'))
    writeFileSync(join(root, 'child', 'state.txt'), 'synthetic')
    expect(() => ensurePrivateDirectories([root])).not.toThrow()
  })
  it('refuses an existing shared directory without altering its ACL', { timeout: 60_000 }, () => {
    const root = join(fixture(), 'shared')
    mkdirSync(root)
    powershell(root, broaden)
    const before = powershell(root, sddl)
    expect(() => ensurePrivateDirectories([root])).toThrow(/could not secure/)
    expect(powershell(root, sddl)).toBe(before)
  })
  it('refuses a protected broadly readable child without altering it', { timeout: 60_000 }, () => {
    const root = join(fixture(), 'private')
    ensurePrivateDirectories([root])
    const child = join(root, 'credentials-fixture.txt')
    writeFileSync(child, 'synthetic; not a credential')
    powershell(child, broaden)
    const before = powershell(child, sddl)
    expect(() => ensurePrivateDirectories([root])).toThrow(/could not secure/)
    expect(powershell(child, sddl)).toBe(before)
  })
})
