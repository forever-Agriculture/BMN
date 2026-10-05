import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { observeWindowsInstallCommands } from '../test/fixtures/windows-install-command-observer.mjs'
import { installedCimPreflightSource } from '../test/fixtures/windows-installed-cim-preflight.mjs'
import { windowsEnvironmentFingerprint } from '../test/fixtures/windows-subprocess-provenance.mjs'

const powershell = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'C:\\Windows\\powershell.exe'
const source = readFileSync(new URL('../lib/windows-installed-worker.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const prefix = "$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));\n"
const actualQueries = []
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'powershell' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.includes('Get-CimInstance ')) {
    actualQueries.push(prefix + node.arguments[0].text)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
const argv = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

it('retains the original call and result while collecting only diagnostic protocol records', () => {
  const original = "$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));\nGet-CimInstance Win32_Process -Filter \"Name='BMN.exe'\" | ConvertTo-Json"
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(original, 'utf16le').toString('base64')]
  const options = { env: { SystemRoot: 'C:\\Windows' }, input: 'synthetic input', timeout: 30000 }
  const result = { status: 1, stdout: '', stderr: 'raw unrecorded error\nBMN_INSTALL_DIAGNOSTIC:{"kind":"failure","stage":"operation","hresult":-1}\n', error: undefined }
  const records = []
  const observed = observeWindowsInstallCommands((exe, actualArgs, actualOptions) => {
    expect(exe).toBe(powershell); expect(actualOptions).toBe(options)
    expect(actualArgs.slice(0, -1)).toEqual(args.slice(0, -1))
    const script = Buffer.from(actualArgs.at(-1), 'base64').toString('utf16le')
    expect(script).toContain(original.split('\n').at(-1))
    expect(script.indexOf('Import-Module')).toBeLessThan(script.indexOf("$__bmnStage='dependencies'"))
    expect(script.indexOf("$__bmnStage='operation'")).toBeLessThan(script.indexOf('Get-CimInstance Win32_Process'))
    return result
  }, row => records.push(row))
  expect(observed(powershell, args, options)).toBe(result)
  expect(records[1]).toMatchObject({ operation: 'other-powershell', directOriginal: false, phase: 'end', exitCode: 1,
    metadata: [{ kind: 'failure', stage: 'operation', hresult: -1 }] })
  expect(JSON.stringify(records)).not.toContain('raw unrecorded error')
})
it('passes all three exact actual worker query sources and options untouched', () => {
  expect(actualQueries).toHaveLength(3)
  for (const script of actualQueries) {
    const args = argv(script), options = { env: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\synthetic' }, encoding: 'utf8', timeout: 30000 }
    const result = { status: 0, stdout: '[]', stderr: '', pid: 42 }, records = []
    const observe = observeWindowsInstallCommands((exe, actualArgs, actualOptions) => {
      expect(exe).toBe(powershell); expect(actualArgs).toBe(args); expect(actualOptions).toBe(options)
      expect(Buffer.from(actualArgs.at(-1), 'base64').toString('utf16le')).toBe(script)
      return result
    }, row => records.push(row), { candidateCommit: 'a'.repeat(40), artifactSha256: 'b'.repeat(64) })
    expect(observe(powershell, args, options)).toBe(result)
    expect(records[1]).toMatchObject({ directOriginal: true, bindingComplete: true, environmentUnchanged: true, exitObserved: true, ownedProcessPid: 42 })
    expect(records[0].sourceSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(records[0].environmentFingerprint).toBe(windowsEnvironmentFingerprint(options.env))
  }
})
it('keeps the explicit preflight separate and refuses unknown query bytes as original proof', () => {
  const records = [], result = { status: 0, stdout: '[]', stderr: '' }, args = argv(installedCimPreflightSource)
  const observe = observeWindowsInstallCommands((_exe, actualArgs) => { expect(actualArgs).toBe(args); return result }, row => records.push(row))
  observe(powershell, args, {})
  expect(records[1]).toMatchObject({ operation: 'explicit-cim-preflight', explicitPreflight: true, directOriginal: false })
  for (const script of [actualQueries[0] + ' ', actualQueries[0].replace(prefix, '$differentPrefix=1;')]) {
    const rows = [], observe = observeWindowsInstallCommands((_exe, actualArgs) => {
      expect(Buffer.from(actualArgs.at(-1), 'base64').toString('utf16le')).not.toBe(script); return result
    }, row => rows.push(row))
    observe(powershell, argv(script), {})
    expect(rows[0].directOriginal).toBe(false)
  }
})
it('retains timeout/result identity and never masks a primary throw with recording failure', () => {
  const args = argv(actualQueries[0]), error = new Error('synthetic primary'), timeout = { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' }
  const rows = [], observeTimeout = observeWindowsInstallCommands(() => timeout, row => rows.push(row))
  expect(observeTimeout(powershell, args, { timeout: 30000 })).toBe(timeout)
  expect(rows[1]).toMatchObject({ launchError: 'ETIMEDOUT', exitCode: null, signal: 'SIGTERM' })
  let invoked = false
  const observeThrow = observeWindowsInstallCommands(() => { invoked = true; throw error }, () => { throw new Error('synthetic recorder') })
  expect(() => observeThrow(powershell, args, {})).toThrow(error)
  expect(invoked).toBe(true); expect(observeThrow.diagnosticFailures).toHaveLength(2)
  const result = { status: 0, stdout: '[]', stderr: '' }, observeSuccess = observeWindowsInstallCommands(() => result, () => { throw error })
  expect(observeSuccess(powershell, args, {})).toBe(result)
  expect(observeSuccess.diagnosticFailures.length).toBeGreaterThan(0) // Driver vetoes acceptance.
})
it('makes malformed, clipped and untrusted-path metadata explicit without persisting raw errors', () => {
  const rows = [], result = { status: 1, stderr: 'private raw error\nBMN_INSTALL_DIAGNOSTIC:{broken\n' +
    'BMN_INSTALL_DIAGNOSTIC:' + 'x'.repeat(8200) + '\n' +
    'BMN_INSTALL_DIAGNOSTIC:{"kind":"dependency","name":"Get-Command","moduleBase":"C:\\\\private\\\\fixture"}\n' }
  const observe = observeWindowsInstallCommands(() => result, row => rows.push(row))
  expect(observe(powershell, argv('exit 1'), {})).toBe(result)
  expect(observe.diagnosticFailures.map(row => row.category)).toEqual(['metadata-malformed', 'metadata-clipped', 'metadata-untrusted-path'])
  expect(JSON.stringify(rows)).not.toContain('private raw error'); expect(JSON.stringify(rows)).not.toContain('private\\fixture')
})
it('fingerprints case-insensitive environment names canonically and refuses ambiguous aliases before launch', () => {
  expect(windowsEnvironmentFingerprint({ Path: 'one', SystemRoot: 'two' })).toBe(windowsEnvironmentFingerprint({ systemroot: 'two', PATH: 'one' }))
  let invoked = false
  const observe = observeWindowsInstallCommands(() => { invoked = true }, () => {})
  expect(() => observe(powershell, argv(actualQueries[0]), { env: { Path: 'one', PATH: 'two' } })).toThrow(/cannot be identified/u)
  expect(invoked).toBe(false)
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
  expect(() => observe(powershell, ['-EncodedCommand', Buffer.from('exit 1', 'utf16le').toString('base64')], {})).toThrow(error)
  expect(records.map(row => row.phase)).toEqual(['begin', 'end'])
  expect(JSON.stringify(records)).not.toContain(error.message)
})
