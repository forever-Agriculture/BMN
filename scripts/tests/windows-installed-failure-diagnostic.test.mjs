import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { installedFailureDiagnostic, captureInstalledSourceBindings, installedSmokeOutcome } from '../test/fixtures/windows-installed-failure-diagnostic.mjs'

const marker = 'SYNTHETIC_SECRET_NEVER_RECORD', module = 'scripts/lib/windows-installed-worker.mjs'
const repo = '/private/bmn', frame = `    at functionName(file://${repo}/${module}:147:9)`
const readSource = () => Buffer.from('bound-source'), sourceBindings = captureInstalledSourceBindings(repo, { readSource })

it.each(['win32', 'linux'])('binds %s runtime-file locations while excluding messages, values, names and outside paths', platform => {
  const root = platform === 'win32' ? 'D:\\a\\BMN\\BMN' : repo
  const url = platform === 'win32' ? 'file:///D:/a/BMN/BMN/' + module : 'file://' + repo + '/' + module
  const error = new assert.AssertionError({ message: marker, actual: { secret: marker }, expected: {}, operator: 'deepStrictEqual' })
  error.stack = `AssertionError: ${marker}\n    at unsafeName(${url}:147:9)\n    at other(/outside/${marker}/scripts/lib/windows-installed-worker.mjs:2:3)`
  const options = { platform, readSource }; options.sourceBindings = captureInstalledSourceBindings(root, options)
  const result = installedFailureDiagnostic(error, root, options)
  expect(result.frames).toHaveLength(1)
  expect(result.frames[0]).toMatchObject({ module, line: 147, column: 9, coordinateKind: 'runtime-file', sourceStatus: 'matched' })
  expect(result.frames[0].sourceSha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(JSON.stringify(result)).not.toContain(marker)
})

it.each([
  ['secret name', { name: marker, message: marker, actual: marker, stack: 'Error\n'+frame }, { readSource, sourceBindings }, 'matched'],
  ['source mismatch', { name: 'Error', stack: 'Error\n'+frame }, { sourceBindings, readSource: () => Buffer.from('changed-source') }, 'mismatch'],
  ['missing source', { name: 'Error', stack: 'Error\n'+frame }, { sourceBindings, readSource: () => { throw Error(marker) } }, 'unavailable'],
  ['oversized source', { name: 'Error', stack: 'Error\n'+frame }, { sourceBindings, readSource: () => Buffer.alloc(1024*1024+1) }, 'unavailable']
])('retains the primary failure with %s', (_name, error, options, status) => {
  const result = installedFailureDiagnostic(error, repo, { platform: 'linux', ...options })
  expect(result.frames[0].sourceStatus).toBe(status)
  if (status !== 'matched') expect(result.frames[0].sourceSha256).toBeUndefined()
  if (error.name === marker) expect(result.name).toBe('UNKNOWN')
  expect(JSON.stringify(result)).not.toContain(marker)
})

it.each([null, marker, { name: 'Error', stack: 'bad\n    at not-a-source' },
  { name: 'Error', stack: 'Error\n'+Array(32).fill('    at unknown').join('\n')+'\n'+frame },
  { name: 'Error', stack: 'Error\n'+'x'.repeat(65536)+'\n'+frame }])('reports unavailable locations without guessing or masking a nonstandard primary throw', error => {
  const result = installedFailureDiagnostic(error, repo, { platform: 'linux' })
  expect(result.frames).toEqual([]); expect(result.locationStatus).toBe('unavailable')
  expect(JSON.stringify(result)).not.toContain(marker)
})
it('limits frames and survives secondary diagnostic getters', () => {
  expect(installedFailureDiagnostic({ name: 'Error', stack: 'Error\n'+Array(20).fill(frame).join('\n') }, repo,
    { platform: 'linux', readSource, sourceBindings }).frames).toHaveLength(6)
  const result = installedFailureDiagnostic({ get name() { throw Error(marker) } }, repo)
  expect(result.diagnosticUnavailable).toBe(true); expect(JSON.stringify(result)).not.toContain(marker)
})

it('reads actual ordinary source files with bounds and refuses hardlinked or oversized replacements', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-source-diagnostic-')), directory = join(root, 'scripts/lib'), path = join(root, module)
  try {
    mkdirSync(directory, { recursive: true }); writeFileSync(path, 'bound actual source')
    const binding = captureInstalledSourceBindings(root)
    const error = { name: 'Error', stack: `Error\n    at real(${pathToFileURL(path).href}:1:2)` }
    expect(installedFailureDiagnostic(error, root, { sourceBindings: binding }).frames[0].sourceStatus).toBe('matched')
    writeFileSync(path, 'changed actual source')
    expect(installedFailureDiagnostic(error, root, { sourceBindings: binding }).frames[0].sourceStatus).toBe('mismatch')
    linkSync(path, join(directory, 'linked.mjs'))
    expect(captureInstalledSourceBindings(root)[module]).toBeNull()
    rmSync(join(directory, 'linked.mjs')); writeFileSync(path, Buffer.alloc(1024*1024+1))
    expect(captureInstalledSourceBindings(root)[module]).toBeNull()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('keeps only the bounded synthetic smoke outcome and drops unexpected names', () => {
  const smokeOutcome = { status: 1, signal: 'SIGNAL_' + marker, errorCode: marker, durationMs: 4200, stdoutBytes: 0, stderrBytes: marker,
    receipts: ['session-roundtrip', marker, 'x'.repeat(49)], failure: 'hook card missing\u001b[31m' + 'y'.repeat(900),
    phases: ['renderer preload integration', `agent history {"path":"C:\\${marker}"}`], cleanupErrorCode: marker }
  const result = installedSmokeOutcome({ smokeOutcome })
  expect(result).toMatchObject({ status: 1, signal: null, errorCode: null, durationMs: 4200, receipts: ['session-roundtrip'], stdoutBytes: 0, stderrBytes: null, phaseCount: 2, lastPhase: 'agent history', cleanupErrorCode: 'other' })
  expect(installedSmokeOutcome({ smokeOutcome: { ...smokeOutcome, cleanupErrorCode: 'EBUSY' } }).cleanupErrorCode).toBe('EBUSY')
  expect(installedSmokeOutcome({ smokeOutcome: { status: 1 } }).cleanupErrorCode).toBeNull()
  expect(result.failure).toHaveLength(800); expect(result.failure).not.toContain('\u001b')
  expect(installedSmokeOutcome(new Error('no outcome'))).toBeUndefined()
  expect(installedSmokeOutcome({ get smokeOutcome() { throw Error(marker) } })).toEqual({ unavailable: true })
})
