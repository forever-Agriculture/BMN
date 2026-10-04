import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWindowsRelease, readWindowsInstallation, releaseDirectory } from '../lib/windows-release-transaction.mjs'
import { nativeTimings } from './native-timings.test-support.mjs'

const roots = []
const pendingDiagnostics = []
afterEach(() => {
  const traces = pendingDiagnostics.splice(0)
  for (const trace of traces) trace.mark('cleanup:begin')
  try { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) }
  finally { for (const trace of traces) { trace.mark('cleanup:end'); trace.report() } }
})
const hash = value => createHash('sha256').update(value).digest('hex')
const release = (label, schemaVersion = 23) => ({ commit: hash(label).slice(0, 40), payloadSha256: hash(label), schemaVersion })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-windows-install-')); roots.push(root)
  let held = false
  const calls = []
  const options = {
    root, candidate: release('old'),
    withLease: async callback => {
      if (held) throw new Error('Installation already leased')
      held = true
      try { return await callback() } finally { held = false }
    },
    waitForExit: vi.fn(async () => { expect(held).toBe(true); calls.push('wait') }),
    stage: vi.fn(async target => { expect(held).toBe(true); calls.push('stage'); writeFileSync(join(target, 'BMN.exe'), 'old') }),
    validate: vi.fn(async (target, descriptor) => { calls.push('validate'); expect(hash(readFileSync(join(target, 'BMN.exe')))).toBe(descriptor.payloadSha256) }),
    smoke: vi.fn(async () => { calls.push('smoke') }),
    inspectData: vi.fn(async () => ({ schemaVersion: 23 })),
    refreshMetadata: vi.fn(async () => { calls.push('metadata') })
  }
  const update = label => ({ ...options, candidate: release(label),
    stage: vi.fn(async target => { calls.push('stage'); writeFileSync(join(target, 'BMN.exe'), label) }) })
  return { root, options, calls, update, journal: () => JSON.parse(readFileSync(join(root, 'update.json'), 'utf8')) }
}

describe('Windows versioned release activation', () => {
  it('refuses source drift inside the lease immediately before selecting a candidate', async () => {
    const trace = nativeTimings('selection-source-drift')
    const measured = options => {
      const value = { ...options, checkpoint: async phase => trace.mark(`journal-committed:${phase}`) }
      for (const name of ['withLease', 'waitForExit', 'stage', 'validate', 'smoke', 'inspectData', 'refreshMetadata', 'beforeActivate']) {
        if (!options[name]) continue
        value[name] = async (...args) => {
          trace.mark(`${name}:begin`)
          try { return await options[name](...args) } finally { trace.mark(`${name}:end`) }
        }
      }
      return value
    }
    try {
      const f = trace.measure('fixture', fixture); await activateWindowsRelease(measured(f.options))
      trace.mark('first-install:end')
      const before = readFileSync(join(f.root, 'installation.json'))
      await expect(activateWindowsRelease(measured({ ...f.update('new'), beforeActivate: async () => { throw new Error('queued source changed') } })))
        .rejects.toThrow('queued source changed')
      trace.mark('refusal:end')
      expect(readFileSync(join(f.root, 'installation.json'))).toEqual(before)
      expect(f.journal()).toMatchObject({ phase: 'failed', activated: false })
      trace.mark('assertions:end')
    } finally { pendingDiagnostics.push(trace) }
    // Diagnostic observation budget; finite stage timings precede any attribution.
  }, process.platform === 'win32' ? 30000 : 5000)
  it('prepares a first-install parent before the native lease opens its file', async () => {
    const f = fixture(), options = { ...f.options, root: join(f.root, 'first install') }
    options.withLease = async operation => {
      expect(existsSync(options.root), 'native OPEN_ALWAYS requires its parent').toBe(true)
      return f.options.withLease(operation)
    }
    await activateWindowsRelease(options)
    expect(readWindowsInstallation(options.root).current).toEqual(release('old'))
  })

  it('retries a partial stage in a new directory and smokes before publishing a selected version', async () => {
    const f = fixture(); await activateWindowsRelease(f.options)
    const next = f.update('new'), directories = []
    next.stage = async target => {
      directories.push(target)
      writeFileSync(join(target, 'BMN.exe'), directories.length === 1 ? 'partial' : 'new')
      if (directories.length === 1) throw new Error('stage interrupted')
    }
    next.smoke = async staged => {
      expect(staged).toContain('staging')
      expect(existsSync(releaseDirectory(f.root, release('new')))).toBe(false)
      expect(readWindowsInstallation(f.root).current).toEqual(release('old'))
    }
    await expect(activateWindowsRelease(next)).rejects.toThrow('stage interrupted')
    await expect(activateWindowsRelease(next)).resolves.toMatchObject({ current: release('new') })
    expect(directories).toHaveLength(2); expect(directories[0]).not.toBe(directories[1])
    expect(readFileSync(join(directories[0], 'BMN.exe'), 'utf8')).toBe('partial')
  })
  it('holds the native lease through wait, validation and activation and retains both payloads', async () => {
    const f = fixture(); await activateWindowsRelease(f.options); f.calls.length = 0
    const next = f.update('new'); const result = await activateWindowsRelease(next)
    expect(f.calls).toEqual(['wait', 'stage', 'validate', 'smoke', 'metadata'])
    expect(result).toMatchObject({ current: release('new'), previous: release('old'), snapshot: null })
    expect(readFileSync(join(releaseDirectory(f.root, release('old')), 'BMN.exe'), 'utf8')).toBe('old')
    expect(readFileSync(join(releaseDirectory(f.root, release('new')), 'BMN.exe'), 'utf8')).toBe('new')
    expect(f.journal()).toMatchObject({ phase: 'complete', activated: true })
  })

  it.each(['stage', 'validate', 'smoke', 'inspectData'])('preserves the selected and previous generation when %s fails', async method => {
    const f = fixture(); await activateWindowsRelease(f.options); await activateWindowsRelease(f.update('second'))
    const before = readFileSync(join(f.root, 'installation.json'))
    const next = f.update('third'); next[method] = vi.fn(async () => { throw new Error('injected failure') })
    await expect(activateWindowsRelease(next)).rejects.toThrow('injected failure')
    expect(readFileSync(join(f.root, 'installation.json'))).toEqual(before)
    expect(f.journal()).toMatchObject({ phase: 'failed', activated: false })
    for (const label of ['old', 'second']) expect(existsSync(releaseDirectory(f.root, release(label)))).toBe(true)
  })

  it('rejects unknown/newer data and migration without a verified snapshot before selection changes', async () => {
    for (const data of [undefined, { schemaVersion: 24 }, { schemaVersion: 22 }, { schemaVersion: 22, snapshot: { verified: false } }]) {
      const f = fixture(); await activateWindowsRelease(f.options)
      const next = f.update('new'); next.inspectData = async () => data
      await expect(activateWindowsRelease(next)).rejects.toThrow()
      expect(readWindowsInstallation(f.root).current).toEqual(release('old'))
      expect(f.journal().activated).toBe(false)
    }
  })

  it('records a verified migration snapshot without touching the owner data through the transaction', async () => {
    const f = fixture(); await activateWindowsRelease(f.options)
    const next = f.update('new'); next.candidate.schemaVersion = 24
    next.inspectData = async () => ({ schemaVersion: 23, snapshot: { id: 'before-24', sha256: hash('snapshot'), verified: true } })
    const result = await activateWindowsRelease(next)
    expect(result.snapshot).toEqual({ id: 'before-24', sha256: hash('snapshot') })
    expect(result.previous).toEqual(release('old'))
  })

  it('repairs metadata after activation failure without rerunning smoke or data migration', async () => {
    const f = fixture(); await activateWindowsRelease(f.options)
    const next = f.update('new'); next.refreshMetadata = async () => { throw new Error('shortcut failed') }
    await expect(activateWindowsRelease(next)).rejects.toThrow('shortcut failed')
    expect(readWindowsInstallation(f.root)).toMatchObject({ current: release('new'), previous: release('old') })
    expect(f.journal()).toMatchObject({ phase: 'failed', activated: true })
    const retry = f.update('new'); f.calls.length = 0
    await activateWindowsRelease(retry)
    expect(f.calls).toEqual(['validate', 'metadata'])
    expect(f.journal()).toMatchObject({ phase: 'complete', previous: release('old') })
  })

  it('reconciles a process interruption just after selection changed using the manifest', async () => {
    const f = fixture(); await activateWindowsRelease(f.options)
    const next = f.update('new'); await activateWindowsRelease(next)
    // A terminated worker cannot write its final receipt. Preserve the observed
    // activation pointer and reproduce its last durable pre-activation journal.
    writeFileSync(join(f.root, 'update.json'), JSON.stringify({ format: 1, phase: 'activating', activated: false, candidate: release('new') }))
    f.calls.length = 0; await activateWindowsRelease(f.update('new'))
    expect(f.calls).toEqual(['validate', 'metadata'])
    expect(readWindowsInstallation(f.root).previous).toEqual(release('old'))
  })

  it('refuses a stale lease or different unfinished request and never replaces its selection', async () => {
    const f = fixture(); await activateWindowsRelease(f.options)
    const next = f.update('new')
    next.inspectData = async () => {
      const state = readWindowsInstallation(f.root); state.current = release('outside-change')
      writeFileSync(join(f.root, 'installation.json'), JSON.stringify(state))
      return { schemaVersion: 23 }
    }
    await expect(activateWindowsRelease(next)).rejects.toThrow('selection changed')
    expect(readWindowsInstallation(f.root).current).toEqual(release('outside-change'))
    await expect(activateWindowsRelease(f.update('other'))).rejects.toThrow('different unfinished update')
    expect(f.journal().candidate).toEqual(release('new'))
  })

  it('rejects traversal and missing capability adapters before writing installation state', async () => {
    const f = fixture()
    await expect(activateWindowsRelease({ ...f.options, candidate: { ...release('old'), commit: '../escape' } })).rejects.toThrow()
    await expect(activateWindowsRelease({ ...f.options, withLease: undefined })).rejects.toThrow()
    expect(readWindowsInstallation(f.root)).toBeNull()
  })
})
