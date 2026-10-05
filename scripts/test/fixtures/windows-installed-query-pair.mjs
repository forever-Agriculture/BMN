// One finite, diagnostic-only comparison. Both modules contain actual worker
// helpers; the candidate changes only their trusted CimCmdlets import preamble.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateQueryPrefix, originalQueryPrefix } from './windows-installed-query-source.mjs'
import { sha256, windowsEnvironmentFingerprint } from './windows-subprocess-provenance.mjs'

const workerPath = fileURLToPath(new URL('../../lib/windows-installed-worker.mjs', import.meta.url))
const requireApp = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))
const requireVite = createRequire(requireApp.resolve('vite/package.json'))
export async function buildInstalledQueryPair(directory) {
  const source = readFileSync(workerPath, 'utf8')
  const expression = 'script = ' + JSON.stringify(originalQueryPrefix) + ' + script'
  assert.equal(source.split(expression).length, 2, 'Original helper preamble changed')
  const candidate = source.replace(expression, 'script = ' + JSON.stringify(candidateQueryPrefix) + ' + script')
  const exports = '\nexport { observeWindowsMappedEnginePayloads };\n'
  const modules = {}, bindings = { originalSourceSha256: sha256(Buffer.from(source)), candidateSourceSha256: sha256(Buffer.from(candidate)),
    soleRelevantDelta: 'trusted-CimCmdlets-manifest-import', exportOnly: 'observeWindowsMappedEnginePayloads', modules: {} }
  for (const [variant, contents] of [['original', source], ['candidate', candidate]]) {
    const output = join(directory, variant + '.cjs')
    const built = await requireVite('esbuild').build({ stdin: { contents: contents + exports, resolveDir: dirname(workerPath), sourcefile: 'windows-installed-worker.mjs' },
      outfile: output, bundle: true, platform: 'node', target: 'node24', format: 'cjs', metafile: true, define: { 'import.meta.url': 'undefined' } })
    bindings.modules[variant] = { exportedSourceSha256: sha256(Buffer.from(contents + exports)), bundleSha256: sha256(readFileSync(output)),
      dependencyCount: Object.keys(built.metafile.inputs).length }
    modules[variant] = createRequire(output)(output)
    for (const name of ['observeWindowsApps', 'observeWindowsSelectedApps', 'observeWindowsMappedEnginePayloads']) assert.equal(typeof modules[variant][name], 'function')
  }
  return { modules, bindings }
}

export async function measureInstalledQueryPair({ directory, root, operations, explicitPreflight, environment = process.env, record = () => {} }) {
  const began = performance.now(), deadlineMs = 230000
  const { modules, bindings } = await buildInstalledQueryPair(directory)
  const report = { scope: 'actual-helper-cim-diagnostic-only', status: 'FAIL', bindings, deadlineMs, rows: [], installerAcceptance: 'UNVERIFIED' }
  record(report)
  const before = windowsEnvironmentFingerprint(environment), values = new Map()
  const calls = [['observe-apps', 'observeWindowsApps', []], ['observe-selected-apps', 'observeWindowsSelectedApps', [root]],
    ['observe-mapped-engines', 'observeWindowsMappedEnginePayloads', [root]]]
  for (const variant of ['original', 'candidate']) {
    if (variant === 'candidate') {
      assert.ok(performance.now() - began < deadlineMs - 30000, 'Finite CIM collection deadline reached')
      const preflightOffset = operations.length
      report.explicitPreflight = explicitPreflight(environment)
      record(report)
      assert.equal(report.explicitPreflight.completed, true, 'Explicit CIM positive control failed')
      assert.equal(report.explicitPreflight.environmentFingerprint, before, 'Explicit control environment changed')
      const receipt = operations.slice(preflightOffset).filter(row => row.phase === 'end')
      assert.equal(receipt.length, 1, 'Explicit positive control provenance is incomplete')
      const control = receipt[0], original = operations.find(row => row.phase === 'end' && row.directOriginal)
      assert.equal(control.operation, 'explicit-cim-preflight'); assert.equal(control.explicitPreflight, true)
      assert.equal(control.exitCode, 0); assert.equal(control.exitObserved, true); assert.equal(control.environmentUnchanged, true)
      for (const key of ['executableSha256', 'executablePathFingerprint', 'environmentFingerprint', 'cwdFingerprint', 'orderedFlags', 'timeout']) {
        assert.deepEqual(control[key], original[key], 'Explicit positive control provenance changed: ' + key)
      }
    }
    for (const [operation, name, args] of calls) {
      assert.ok(performance.now() - began < deadlineMs - 30000, 'Finite CIM collection deadline reached')
      const offset = operations.length
      let value, failure
      try {
        value = modules[variant][name](...args)
        assert.ok(Array.isArray(value), 'Actual helper output is incomplete')
        if (operation !== 'observe-mapped-engines') assert.ok(value.every(pid => Number.isSafeInteger(pid) && pid > 0), 'Actual process identities are incomplete')
        if (variant === 'original') values.set(operation, value)
        else if (values.has(operation)) assert.deepEqual(value, values.get(operation), 'Matched helper outputs changed')
      } catch (error) {
        failure = true
        report.lastHelperFailure = { variant, operation, category: error instanceof assert.AssertionError ? 'assertion' : 'operation',
          name: /^[A-Za-z0-9_]{1,64}$/u.test(error.name ?? '') ? error.name : 'UNKNOWN' }
        record(report)
      }
      const receipt = operations.slice(offset).filter(row => row.phase === 'end')
      assert.equal(receipt.length, 1, 'Missing or ambiguous actual-helper subprocess receipt')
      const row = receipt[0]
      assert.equal(row.operation, operation); assert.equal(row.directOriginal, variant === 'original'); assert.equal(row.directCandidate, variant === 'candidate')
      assert.equal(row.environmentFingerprint, before); assert.equal(row.environmentUnchanged, true)
      assert.equal(row.timeout, 30000); assert.equal(row.maxBuffer, 'NODE_DEFAULT'); assert.equal(row.exitObserved, true)
      assert.equal(row.bindingComplete, true); assert.equal(row.spawnThrew, false)
      assert.equal(row.encoding, 'utf8'); assert.equal(row.windowsHide, true); assert.equal(row.shell, 'NODE_DEFAULT')
      if (process.platform === 'win32') assert.match(row.executableSha256, /^[a-f0-9]{64}$/u)
      report.rows.push({ variant, operation, status: failure ? 'FAIL' : 'PASS', outputCount: value?.length ?? null, subprocessId: row.id })
      record(report)
      if (variant === 'candidate') assert.ok(!failure, 'Candidate actual helper failed')
    }
  }
  for (const operation of calls.map(call => call[0])) {
    const rows = report.rows.filter(row => row.operation === operation)
    const receipts = rows.map(row => operations.find(receipt => receipt.id === row.subprocessId && receipt.phase === 'end'))
    for (const key of ['executableSha256', 'executablePathFingerprint', 'environmentFingerprint', 'cwdFingerprint', 'encoding', 'timeout', 'maxBuffer', 'windowsHide', 'shell', 'stdio', 'inputBytes']) {
      assert.deepEqual(receipts[0][key], receipts[1][key], 'Pair provenance changed: ' + key)
    }
    assert.deepEqual(receipts[0].orderedFlags, receipts[1].orderedFlags)
  }
  assert.equal(windowsEnvironmentFingerprint(environment), before)
  report.candidateHelpers = 'PASS'; report.elapsedMs = Math.round(performance.now() - began)
  // Historical/original timeout remains a failure. This receipt never awards
  // installer acceptance, and there is no retry-until-green loop.
  report.status = report.rows.every(row => row.status === 'PASS') ? 'INCONCLUSIVE' : 'FAIL'
  record(report)
  return report
}
