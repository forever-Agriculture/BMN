import processes from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { measureInstalledQueryPair } from '../test/fixtures/windows-installed-query-pair.mjs'
import { observeWindowsInstallCommands } from '../test/fixtures/windows-install-command-observer.mjs'
import { installedCimPreflightSource } from '../test/fixtures/windows-installed-cim-preflight.mjs'
import { windowsEnvironmentFingerprint } from '../test/fixtures/windows-subprocess-provenance.mjs'
import { candidateQueryPrefix, exactInstalledQueries } from '../test/fixtures/windows-installed-query-source.mjs'

it('invokes six actual bundled helpers once, preserving original failure and scoped candidate evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bmn-cim-source-pair-')), originalSpawn = processes.spawnSync
  const systemRoot = process.env.SystemRoot
  let report, samples = 0
  const operations = []
  try {
    process.env.SystemRoot ??= 'C:\\Windows'
    const observer = observeWindowsInstallCommands((_exe, args, options) => {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
      if (script === installedCimPreflightSource) return { status: 0, stdout: '{}', stderr: '', pid: 42 }
      const known = [...exactInstalledQueries.entries()].find(([hash]) => hash === operations.at(-1).sourceSha256)
      expect(known).toBeDefined(); expect(options.timeout).toBe(30000); expect(options.maxBuffer).toBeUndefined()
      expect(script.includes('$__bmnStage')).toBe(false); samples++
      return script.startsWith(candidateQueryPrefix)
        ? { status: 0, stdout: '[]', stderr: '', pid: 42 }
        : { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: { code: 'ETIMEDOUT' }, pid: 42 }
    }, row => operations.push(row), { candidateCommit: 'a'.repeat(40), artifactSha256: 'b'.repeat(64) })
    processes.spawnSync = observer; syncBuiltinESMExports()
    const explicitPreflight = environment => {
      const result = processes.spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(installedCimPreflightSource, 'utf16le').toString('base64')],
        { env: environment, timeout: 30000, encoding: 'utf8', maxBuffer: 256 * 1024, windowsHide: true })
      return { completed: result.status === 0, environmentFingerprint: windowsEnvironmentFingerprint(environment) }
    }
    // Each output remains private and disposable; no helper reaches uninstall.
    mkdirSync(join(directory, 'bundles'))
    const selection = join(directory, 'selection'); mkdirSync(selection)
    writeFileSync(join(selection, 'installation.json'), JSON.stringify({ format: 1,
      current: { commit: 'a'.repeat(40), payloadSha256: 'b'.repeat(64), schemaVersion: 23 }, previous: null, snapshot: null }))
    await measureInstalledQueryPair({ directory: join(directory, 'bundles'), root: selection, operations,
      explicitPreflight, record: value => { report = value } })
    expect(samples).toBe(6); expect(report.status).toBe('FAIL'); expect(report.candidateHelpers).toBe('PASS')
    expect(report.installerAcceptance).toBe('UNVERIFIED')
    expect(report.rows.map(row => row.status)).toEqual(['FAIL', 'FAIL', 'FAIL', 'PASS', 'PASS', 'PASS'])
    expect(observer.diagnosticFailures).toEqual([])
    for (const variant of ['original', 'candidate']) {
      expect(report.bindings.modules[variant].bundleSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(report.bindings.modules[variant].dependencyCount).toBeGreaterThan(4)
    }
  } finally {
    processes.spawnSync = originalSpawn; syncBuiltinESMExports()
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot
    rmSync(directory, { recursive: true, force: true })
  }
})
