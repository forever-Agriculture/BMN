import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findWindowsExecutable, npmNodeShimTarget, windowsDefaultShell, windowsEnvironment, windowsEnvironmentValue, windowsPtyArgumentTail } from './windows-launch'

describe('Windows launch lookup', () => {
  it('selects the system command interpreter ahead of a PATH lookalike', () => {
    const probe = () => true
    expect(findWindowsExecutable('cmd.exe', 'C:\\work', { SystemRoot: 'D:\\Windows', Path: 'C:\\untrusted' }, probe))
      .toBe('D:\\Windows\\System32\\cmd.exe')
    expect(findWindowsExecutable('.\\cmd.exe', 'C:\\chosen', { SystemRoot: 'D:\\Windows' }, probe))
      .toBe('C:\\chosen\\cmd.exe')
  })

  it('uses child PATH/PATHEXT order, case-insensitive keys and absolute quoted paths', () => {
    const available = new Set(['c:\\tools\\agent.cmd', 'd:\\my tools\\agent.exe'])
    const probe = (path: string): boolean => available.has(path.toLowerCase())
    expect(findWindowsExecutable('agent', 'C:\\work', { Path: 'relative;.;C:\\Tools;"D:\\My Tools"', Pathext: '.CMD;.EXE' }, probe))
      .toBe('C:\\Tools\\agent.CMD')
    expect(findWindowsExecutable('agent', 'C:\\work', { Path: '"D:\\My Tools";C:\\Tools', PATHEXT: '.EXE;.CMD' }, probe))
      .toBe('D:\\My Tools\\agent.EXE')
  })

  it('resolves explicit relative/UNC paths against the selected cwd without searching other folders', () => {
    const attempts: string[] = []
    const probe = (path: string): boolean => { attempts.push(path); return true }
    expect(findWindowsExecutable('.\\bin\\tool.exe', 'C:\\work', {}, probe)).toBe('C:\\work\\bin\\tool.exe')
    expect(findWindowsExecutable('\\\\server\\share\\tool.exe', 'C:\\work', {}, probe)).toBe('\\\\server\\share\\tool.exe')
    expect(findWindowsExecutable('tool', 'C:\\work', { PATH: '.;relative' }, probe)).toBeNull()
    expect(attempts).toHaveLength(2)
  })

  it('normalizes aliases with explicit later-layer overrides and removals', () => {
    const result = windowsEnvironment({ Path: 'first', PATH: 'second', SystemRoot: 'C:\\Windows', TMP: 'old' }, { path: 'third', tmp: undefined })
    expect(result).toEqual({ PATH: 'third', SystemRoot: 'C:\\Windows' })
    expect(windowsEnvironmentValue(result, 'systemroot')).toBe('C:\\Windows')
  })

  it('defaults to native PowerShell and honors explicit configured shells', () => {
    expect(windowsDefaultShell({ SystemRoot: 'D:\\Windows', SHELL: '/bin/bash' })).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windowsDefaultShell({ bmn_shell: 'C:\\Tools\\pwsh.exe' })).toBe('C:\\Tools\\pwsh.exe')
  })
})

describe('explicit batch and npm shim semantics', () => {
  it('keeps authored batch text in the single raw command tail', () => {
    expect(windowsPtyArgumentTail('C:\\Windows\\System32\\cmd.exe', ['/d', '/v:off', '/s', '/c', '"C:\\my scripts\\build.cmd" %NAME% & echo ok']))
      .toBe('/d /v:off /s /c ""C:\\my scripts\\build.cmd" %NAME% & echo ok"')
    expect(() => windowsPtyArgumentTail('cmd.exe', ['/c', 'one', 'two'])).toThrow('one command-text argument')
  })

  it('recognizes a real cmd-shim-generated fixture and refuses modified batch code', () => {
    const fixture = readFileSync(new URL('./fixtures/npm-node.cmd', import.meta.url), 'utf8')
    expect(npmNodeShimTarget(fixture)).toBe('..\\package\\entry.js')
    expect(npmNodeShimTarget(fixture.replace('SETLOCAL', 'SETLOCAL\r\necho custom setup'))).toBeNull()
    expect(npmNodeShimTarget(fixture + 'echo extra\r\n')).toBeNull()
    expect(npmNodeShimTarget(fixture.replace('"%_prog%"  ', '"%_prog%" --custom '))).toBeNull()
  })
})
