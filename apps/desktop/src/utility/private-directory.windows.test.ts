// Real Windows ACL regressions; the Linux mode test is in private-directory.test.ts.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensurePrivateDirectories } from './private-directory'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

const temporary: string[] = []
afterEach(() => {
  vi.clearAllMocks()
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
const networkCapability = 'S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417'
function addCapability(path: string, rights = 'Modify, Synchronize', inheritance = 'None', identity = networkCapability): void {
  powershell(path, `$acl=$item.GetAccessControl(); $identity=New-Object System.Security.Principal.SecurityIdentifier('${identity}'); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'${rights}','${inheritance}','None','Allow'); $acl.AddAccessRule($rule); $item.SetAccessControl($acl)`)
}
function aliases(path: string): { short: string; long: string } {
  const long = powershell(path, '$item.FullName')
  const short = powershell(path, `Add-Type 'using System; using System.Text; using System.Runtime.InteropServices; public static class ShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder output, uint size); }'; $buffer=New-Object System.Text.StringBuilder(32768); $length=[ShortPath]::GetShortPathName($item.FullName,$buffer,32768); if ($length -eq 0 -or $length -ge 32768) { throw 'Short path unavailable' }; $buffer.ToString()`)
  expect(short.toLowerCase(), 'native fixture requires a real 8.3 alias').not.toBe(long.toLowerCase())
  return { short, long }
}
// Native APIs preserve deliberately duplicate ACEs that AddAccessRule may merge.
function setRawAcl(path: string, descriptor: string, protectedAcl = true): void {
  powershell(path, `Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RawAcl {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool SetFileSecurityW(string path, uint information, IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static void Set(string path, string text, bool protect) {
    IntPtr sd; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, 1, out sd, out size)) throw new Win32Exception();
    try { if (!SetFileSecurityW(path, protect ? 0x80000004u : 0x20000004u, sd)) throw new Win32Exception(); }
    finally { LocalFree(sd); }
  }
}
'@
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
[RawAcl]::Set($path,'${descriptor}'.Replace('OWNER',$sid),$${protectedAcl})`)
}

describe.skipIf(process.platform !== 'win32')('native Windows private roots', () => {
  it.each([
    { name: 'duplicate explicit file owner entries', directory: false, acl: 'D:P(A;;FA;;;OWNER)(A;;FA;;;OWNER)', protectedAcl: true },
    { name: 'explicit plus inherited owner entry', directory: false, acl: 'D:(A;;FA;;;OWNER)(A;ID;FA;;;OWNER)', protectedAcl: false },
    { name: 'split direct and inheritable owner rights', directory: true, acl: 'D:P(A;;FA;;;OWNER)(A;OICIIO;FA;;;OWNER)', protectedAcl: true },
    { name: 'additional owner read rights', directory: false, acl: 'D:P(A;;FA;;;OWNER)(A;;FR;;;OWNER)', protectedAcl: true }
  ])('accepts equivalent private owner ACLs: $name', { timeout: 60_000 }, ({ directory, acl, protectedAcl }) => {
    const root = join(fixture(), 'private')
    ensurePrivateDirectories([root])
    const target = join(root, 'synthetic')
    if (directory) mkdirSync(target)
    else writeFileSync(target, 'synthetic')
    setRawAcl(target, acl, protectedAcl)
    const count = powershell(target, '@($item.GetAccessControl().GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])).Count')
    expect(Number(count), 'fixture must retain multiple owner ACEs').toBeGreaterThanOrEqual(2)
    const before = powershell(target, sddl)
    expect(() => ensurePrivateDirectories([root])).not.toThrow()
    expect(powershell(target, sddl)).toBe(before)
  })
  it.each([
    { name: 'duplicate owner plus Everyone', directory: false, acl: 'D:P(A;;FA;;;OWNER)(A;;FA;;;OWNER)(A;;FR;;;WD)' },
    { name: 'owner write denied', directory: false, acl: 'D:P(D;;WD;;;OWNER)(A;;FA;;;OWNER)' },
    { name: 'owner read only', directory: false, acl: 'D:P(A;;FR;;;OWNER)' },
    { name: 'directory without owner inheritance', directory: true, acl: 'D:P(A;;FA;;;OWNER)' },
    { name: 'directory inheritance stops after one generation', directory: true, acl: 'D:P(A;OICINP;FA;;;OWNER)' },
    { name: 'SYSTEM descendant access', directory: false, acl: 'D:P(A;;FA;;;OWNER)(A;;FR;;;SY)' },
    { name: 'misplaced capability with duplicate owner', directory: false, acl: `D:P(A;;FA;;;OWNER)(A;;FA;;;OWNER)(A;;0x1301bf;;;${networkCapability})` }
  ])('refuses unsafe or unusable effective ACLs: $name', { timeout: 60_000 }, ({ directory, acl }) => {
    const root = join(fixture(), 'private')
    ensurePrivateDirectories([root])
    const target = join(root, 'synthetic')
    if (directory) mkdirSync(target)
    else writeFileSync(target, 'synthetic')
    setRawAcl(target, acl)
    const before = powershell(target, sddl)
    expect(() => ensurePrivateDirectories([root], 'win32', root)).toThrow(/could not secure/)
    expect(powershell(target, sddl)).toBe(before)
  })
  it('uses one canonical path for Chromium scope and rejects alias overlaps before creation', { timeout: 120_000 }, () => {
    const parent = fixture()
    const root = join(parent, 'private storage')
    ensurePrivateDirectories([root])
    const { short, long } = aliases(root)
    mkdirSync(join(root, 'Cache'))
    addCapability(join(root, 'Cache'))
    expect(() => ensurePrivateDirectories([short], 'win32', long)).not.toThrow()
    expect(() => ensurePrivateDirectories([long + '\\'], 'win32', short)).not.toThrow()
    expect(() => ensurePrivateDirectories([short])).toThrow(/could not secure/)
    const before = powershell(root, sddl)
    const untouched = join(parent, 'must-not-be-created')
    const missing = join(long, 'missing-child')
    for (const [requested, data] of [
      [[untouched, short, long], long],
      [[untouched, short.toUpperCase() + '\\', long], long],
      [[untouched, short, missing], short],
      [[untouched, long, join(short, 'missing-child')], missing]
    ] as const) {
      expect(() => ensurePrivateDirectories(requested, 'win32', data)).toThrow(/could not secure|distinct|overlap/)
      expect(existsSync(untouched)).toBe(false)
      expect(existsSync(missing)).toBe(false)
      expect(powershell(root, sddl)).toBe(before)
    }
    expect(() => ensurePrivateDirectories([join(short, 'new-leaf')], 'win32', join(long, 'new-leaf'))).not.toThrow()
    expect(() => ensurePrivateDirectories([join(short, 'missing-parent', 'nested-leaf')], 'win32', join(long, 'missing-parent', 'nested-leaf'))).not.toThrow()
    expect(() => ensurePrivateDirectories([join(long, 'reverse-parent', 'nested-leaf')], 'win32', join(short, 'reverse-parent', 'nested-leaf'))).not.toThrow()
    expect(() => ensurePrivateDirectories([short, root + '-sibling'], 'win32', long)).not.toThrow()
  })
  it('accepts only scoped network capability access while retaining the strict default', { timeout: 60_000 }, () => {
    const root = join(fixture(), 'private')
    ensurePrivateDirectories([root])
    const cache = join(root, 'Cache')
    mkdirSync(cache)
    addCapability(cache)
    const before = powershell(cache, sddl)
    expect(() => ensurePrivateDirectories([root])).toThrow(/could not secure/)
    expect(() => ensurePrivateDirectories([root], 'win32', root)).not.toThrow()
    expect(powershell(cache, sddl)).toBe(before)
  })
  it.each([
    { path: 'Cache', rights: 'FullControl', inheritance: 'None', identity: networkCapability },
    { path: 'Cache', rights: 'Modify, Synchronize', inheritance: 'ObjectInherit', identity: networkCapability },
    { path: 'Cache', rights: 'Modify, Synchronize', inheritance: 'None', identity: 'S-1-1-0' },
    { path: 'CacheSibling', rights: 'Modify, Synchronize', inheritance: 'None', identity: networkCapability },
    { path: 'credentials', rights: 'Modify, Synchronize', inheritance: 'None', identity: networkCapability },
    { path: '', rights: 'Modify, Synchronize', inheritance: 'None', identity: networkCapability }
  ])('refuses unexpected capability ACLs without mutation: $path/$rights/$inheritance/$identity', { timeout: 60_000 }, ({ path, rights, inheritance, identity }) => {
    const root = join(fixture(), 'private')
    ensurePrivateDirectories([root])
    const target = join(root, path)
    if (path) mkdirSync(target)
    addCapability(target, rights, inheritance, identity)
    const before = powershell(target, sddl)
    expect(() => ensurePrivateDirectories([root], 'win32', root)).toThrow(/could not secure/)
    expect(powershell(target, sddl)).toBe(before)
  })
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
    const spawn = vi.mocked(spawnSync)
    spawn.mockClear()
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
