import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })
import { disposableProviderEnvironment } from './disposable-provider-env.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profiles() {
  const root = process.platform === 'win32'
    ? join(tmpdir(), 'bmn-cross-harness-profiles-' + randomUUID())
    : mkdtempSync(join(tmpdir(), 'bmn-cross-harness-profiles-'))
  roots.push(root)
  if (process.platform === 'win32') ensurePrivateDirectories([root, join(root, 'claude'), join(root, 'codex')])
  else {
    mkdirSync(join(root, 'claude'), { mode: 0o700 })
    mkdirSync(join(root, 'codex'), { mode: 0o700 })
  }
  return root
}

describe('disposable provider trial environment', () => {
  it('refuses to launch without explicitly provisioned disposable profiles', () => {
    expect(() => disposableProviderEnvironment('/tmp/runtime', undefined)).toThrow(/UNVERIFIED/)
    expect(() => disposableProviderEnvironment('/tmp/runtime', '/tmp/bmn-cross-harness-profiles-missing'))
      .toThrow(/does not exist/)
    expect(() => disposableProviderEnvironment('/tmp/runtime', homedir())).toThrow(/disposable system-temp/)
  })

  it('uses private disposable profiles and drops inherited credentials and owner roots', () => {
    const root = profiles()
    const env = disposableProviderEnvironment('/tmp/trial-runtime', root, {
      PATH: '/usr/bin', HOME: '/home/owner', CLAUDE_CONFIG_DIR: '/home/owner/.claude',
      CODEX_HOME: '/home/owner/.codex', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret'
    })
    expect(env).toMatchObject({
      HOME: join('/tmp/trial-runtime', 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'), PATH: '/usr/bin'
    })
    expect(JSON.stringify(env)).not.toContain('/home/owner')
    expect(JSON.stringify(env)).not.toContain('secret')
  })

  it.runIf(process.platform === 'win32')('keeps native prerequisites and replaces every owner profile root', () => {
    const root = profiles(), runtime = join(tmpdir(), 'bmn-synthetic-runtime')
    const env = disposableProviderEnvironment(runtime, root, {
      Path: 'synthetic-path', systemroot: 'C:\\Windows', windir: 'C:\\Windows', comspec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.EXE;.CMD', TEMP: tmpdir(), TMP: tmpdir(),
      USERPROFILE: 'C:\\owner', APPDATA: 'C:\\owner\\Roaming', LOCALAPPDATA: 'C:\\owner\\Local',
      OPENAI_API_KEY: 'synthetic-secret', ANTHROPIC_API_KEY: 'synthetic-secret', BMN_TOKEN: 'synthetic-secret'
    })
    expect(env).toMatchObject({ PATH: 'synthetic-path', SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
      USERPROFILE: join(runtime, 'home'), APPDATA: join(runtime, 'config'), LOCALAPPDATA: join(runtime, 'data'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') })
    expect(JSON.stringify(env)).not.toContain('synthetic-secret')
    expect(JSON.stringify(env)).not.toContain('C:\\\\owner')
    expect(() => disposableProviderEnvironment(runtime, root, { PATH: 'one', Path: 'two' })).toThrow(/Conflicting/)
  })
  it('refuses symlinked or shared profile directories', () => {
    const root = profiles()
    const alias = `${root}-alias`
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    roots.push(alias)
    expect(() => disposableProviderEnvironment('/tmp/runtime', alias)).toThrow(/symlink/)
    rmSync(join(root, 'codex'), { recursive: true })
    symlinkSync(join(root, 'claude'), join(root, 'codex'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => disposableProviderEnvironment('/tmp/runtime', root)).toThrow(/symlink/)
    rmSync(join(root, 'codex'))
    if (process.platform === 'win32') ensurePrivateDirectories([join(root, 'codex')])
    else mkdirSync(join(root, 'codex'), { mode: 0o700 })
    expect(() => disposableProviderEnvironment('/tmp/runtime', root)).not.toThrow()
    if (process.platform === 'win32') {
      const script = "$ErrorActionPreference='Stop';$p=ConvertFrom-Json ([Console]::In.ReadToEnd());$a=[IO.Directory]::GetAccessControl($p);$sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')));[IO.Directory]::SetAccessControl($p,$a)"
      const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { input: JSON.stringify(root), encoding: 'utf8', timeout: 15000, windowsHide: true })
      expect(result.status).toBe(0)
      expect(() => disposableProviderEnvironment('/tmp/runtime', root)).toThrow(/secure/)
    } else {
      chmodSync(root, 0o755)
      expect(() => disposableProviderEnvironment('/tmp/runtime', root)).toThrow(/private/)
    }
  })
})
