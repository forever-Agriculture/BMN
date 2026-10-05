import { expect, it } from 'vitest'
import { observeWindowsInstallCommands } from '../test/fixtures/windows-install-command-observer.mjs'

it('retains the original call and result while collecting only diagnostic protocol records', () => {
  const original = "$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));\nGet-CimInstance Win32_Process -Filter \"Name='BMN.exe'\" | ConvertTo-Json"
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(original, 'utf16le').toString('base64')]
  const options = { env: { SystemRoot: 'C:\\Windows' }, input: 'synthetic input', timeout: 30000 }
  const result = { status: 1, stdout: '', stderr: 'raw unrecorded error\nBMN_INSTALL_DIAGNOSTIC:{"kind":"failure","stage":"operation","hresult":-1}\n', error: undefined }
  const records = []
  const observed = observeWindowsInstallCommands((exe, actualArgs, actualOptions) => {
    expect(exe).toBe('C:\\Windows\\powershell.exe'); expect(actualOptions).toBe(options)
    expect(actualArgs.slice(0, -1)).toEqual(args.slice(0, -1))
    const script = Buffer.from(actualArgs.at(-1), 'base64').toString('utf16le')
    expect(script).toContain(original.split('\n').at(-1))
    expect(script.indexOf('Import-Module')).toBeLessThan(script.indexOf("$__bmnStage='dependencies'"))
    expect(script.indexOf("$__bmnStage='operation'")).toBeLessThan(script.indexOf('Get-CimInstance Win32_Process'))
    return result
  }, row => records.push(row))
  expect(observed('C:\\Windows\\powershell.exe', args, options)).toBe(result)
  expect(records[1]).toMatchObject({ operation: 'observe-apps', phase: 'end', exitCode: 1,
    metadata: [{ kind: 'failure', stage: 'operation', hresult: -1 }] })
  expect(JSON.stringify(records)).not.toContain('raw unrecorded error')
})
it('passes unrelated native calls through without instrumentation', () => {
  const args = ['--synthetic'], options = { timeout: 30000 }, result = { status: 0 }, records = []
  const observe = observeWindowsInstallCommands((exe, actualArgs, actualOptions) => {
    expect(exe).toBe('BMN-shortcut.exe'); expect(actualArgs).toBe(args); expect(actualOptions).toBe(options); return result
  }, row => records.push(row))
  expect(observe('BMN-shortcut.exe', args, options)).toBe(result); expect(records).toEqual([])
})
it('records a terminal diagnostic even when the real subprocess call throws', () => {
  const records = [], error = new Error('unrecorded error')
  const observe = observeWindowsInstallCommands(() => { throw error }, row => records.push(row))
  expect(() => observe('C:\\Windows\\powershell.exe', ['-EncodedCommand', Buffer.from('exit 1', 'utf16le').toString('base64')], {})).toThrow(error)
  expect(records.map(row => row.phase)).toEqual(['begin', 'end'])
  expect(JSON.stringify(records)).not.toContain(error.message)
})
