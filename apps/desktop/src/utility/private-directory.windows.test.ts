// Real Windows ACL regressions; the Linux mode test is in private-directory.test.ts.
import { spawnSync } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensurePrivateDirectories } from './private-directory'

const temporary: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})
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
  it('refuses a root junction without changing its target ACL', { timeout: 60_000 }, () => {
    const parent = fixture()
    const target = join(parent, 'private')
    const link = join(parent, 'junction')
    ensurePrivateDirectories([target])
    symlinkSync(target, link, 'junction')
    const before = powershell(target, sddl)
    expect(() => ensurePrivateDirectories([link])).toThrow(/could not secure/)
    expect(powershell(target, sddl)).toBe(before)
  })
  it('refuses a wide directory at the entry limit without timing out', { timeout: 60_000 }, () => {
    const root = join(fixture(), 'wide')
    ensurePrivateDirectories([root])
    for (let index = 0; index < 10_000; index++) writeFileSync(join(root, `${index}.txt`), '')
    const spawn = vi.spyOn(childProcess, 'spawnSync')
    const started = performance.now()
    expect(() => ensurePrivateDirectories([root])).toThrow(/could not secure/)
    const elapsedMs = Math.round(performance.now() - started)
    const result = spawn.mock.results[0]!.value as ReturnType<typeof spawnSync>
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(String(result.stderr)).toContain('exceeded its entry limit')
    expect(elapsedMs).toBeLessThan(15_000)
    console.info(JSON.stringify({ windowsRootEntryLimit: 'passed', entries: 10_000, elapsedMs }))
  })
})
