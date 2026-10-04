import { EventEmitter } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { assertWindowsWorkerImage, windowsInstalledEngineLocation, delegateWindowsInstalledEngine as delegateInstalledEngine } from '../lib/windows-installed-engine.mjs'
import { createWindowsWorkerImage, sealWindowsReleasePayload } from '../lib/windows-release-payload.mjs'
import { activateWindowsRelease, releaseDirectory } from '../lib/windows-release-transaction.mjs'
import { queueWindowsSourceUpdate } from '../lib/windows-source-update.mjs'
import { resumeWindowsSourceUpdate } from '../lib/windows-source-resume.mjs'

const delegateWindowsInstalledEngine = (entry, argv, options = {}) => delegateInstalledEngine(entry, argv,
  { native: { acquireInstallLease: () => ({ close() {} }) }, ...options })
const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-version-engine-')); roots.push(root)
  const install = join(root, 'installed'), source = join(root, 'new-runtime'), bootstrap = join(install, 'bootstrap')
  mkdirSync(join(source, 'resources/install'), { recursive: true }); mkdirSync(join(bootstrap, 'resources/install'), { recursive: true })
  writeFileSync(join(source, 'BMN.exe'), 'synthetic-runtime-45'); writeFileSync(join(source, 'resources/app.asar'), 'synthetic-application')
  writeFileSync(join(source, 'resources/install/worker.cjs'), 'synthetic-current-engine')
  writeFileSync(join(bootstrap, 'BMN.exe'), 'synthetic-runtime-44'); writeFileSync(join(bootstrap, 'resources/install/worker.cjs'), 'synthetic-pinned-resolver')
  createWindowsWorkerImage(source)
  const descriptor = await sealWindowsReleasePayload(source, { commit: 'a'.repeat(40), schemaVersion: 23, electronVersion: '45.0.0' })
  await activateWindowsRelease({ root: install, candidate: descriptor, withLease: fn => fn(), waitForExit: async () => {},
    stage: target => cpSync(source, target, { recursive: true }), validate: async () => {}, smoke: async () => {},
    inspectData: async () => ({ schemaVersion: null }), refreshMetadata: async () => {} })
  const entry = join(bootstrap, 'resources/install/worker.cjs'), target = releaseDirectory(install, descriptor)
  return { root, install, source, bootstrap, entry, target, descriptor }
}
function starter(exit = 47, signal) {
  return vi.fn(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', exit, signal)); return child })
}
it('delegates a retained old bootstrap to the selected new runtime with literal argv and exit code', async () => {
  const f = await fixture(), start = starter(), argv = ['雪', 'a b', 'quote"value', 'C:\\with space\\', '%PATH%', '^&']
  const result = await delegateWindowsInstalledEngine(f.entry, argv, { start, environment: { SYNTHETIC: 'value' } })
  expect(result).toMatchObject({ root: f.install, mode: 'bootstrap', delegated: true, exitCode: 47 })
  expect(start).toHaveBeenCalledWith(join(f.target, 'BMN-worker.exe'), [join(f.target, 'resources/install/worker.cjs'), ...argv],
    { env: { SYNTHETIC: 'value', ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true })
  expect(readFileSync(join(f.bootstrap, 'BMN.exe'), 'utf8')).toBe('synthetic-runtime-44')
})
it('derives the versioned root and never delegates the engine again', async () => {
  const f = await fixture(), start = starter(), entry = join(f.target, 'resources/install/worker.cjs')
  expect(windowsInstalledEngineLocation(entry)).toEqual({ root: f.install, payload: f.target, mode: 'engine' })
  expect(await delegateWindowsInstalledEngine(entry, [], { start })).toMatchObject({ delegated: false, payload: f.target })
  expect(start).not.toHaveBeenCalled()
  expect(() => windowsInstalledEngineLocation(join(f.root, 'resources/install/worker.cjs'))).toThrow('location')
})
it.each(['missing', 'corrupt'])('refuses GUI and source resume for %s selection but permits pinned uninstall recovery', async mode => {
  const f = await fixture(), start = starter()
  if (mode === 'missing') rmSync(join(f.install, 'installation.json'))
  else writeFileSync(join(f.target, 'resources/install/worker.cjs'), 'corrupt')
  await expect(delegateWindowsInstalledEngine(f.entry, [], { start })).rejects.toThrow('offline installer')
  await expect(delegateWindowsInstalledEngine(f.entry, ['--resume'], { start })).rejects.toThrow('offline installer')
  expect(await delegateWindowsInstalledEngine(f.entry, ['--uninstall'], { start })).toMatchObject({ delegated: false, mode: 'bootstrap' })
  expect(start).not.toHaveBeenCalled()
})
it('propagates a child spawn failure and a signal exit without running fallback data operations', async () => {
  const f = await fixture()
  const start = vi.fn(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('synthetic spawn failure'))); return child })
  await expect(delegateWindowsInstalledEngine(f.entry, [], { start })).rejects.toThrow('spawn failure')
  expect(await delegateWindowsInstalledEngine(f.entry, [], { start: starter(null, 'SIGTERM') })).toMatchObject({ exitCode: 1 })
})
it('uses the delegated runtime identity for a source update after an offline runtime upgrade', async () => {
  const f = await fixture(), requestPath = join(f.install, 'requests/source-update.json')
  mkdirSync(join(f.install, 'requests'))
  const identity = { repo: join(f.root, 'repo'), node: process.execPath, pnpm: join(f.root, 'pnpm.cjs'),
    sourceState: { branch: 'main', head: f.descriptor.commit, originHead: f.descriptor.commit, status: '' } }
  queueWindowsSourceUpdate(requestPath, identity)
  const installPayload = vi.fn(async () => ({ current: f.descriptor }))
  const result = await delegateWindowsInstalledEngine(f.entry, [], { start: (exe, argv) => {
    const child = new EventEmitter()
    // Synthetic ABI identity is read from the selected runtime's manifest; no
    // native Electron or DLL loading is claimed by this orchestration test.
    const location = windowsInstalledEngineLocation(argv[0])
    const runtimeVersion = JSON.parse(readFileSync(join(location.payload, 'bmn-release.json'), 'utf8')).electronVersion
    resumeWindowsSourceUpdate(location.root, { runtimeVersion, native: { acquireInstallLease: () => ({ close() {} }) },
      privateDirectories: () => {}, dataRoot: join(f.root, 'data'), readSourceState: async () => identity.sourceState,
      waitForExit: async () => {}, buildSnapshot: async () => ({ ...f.descriptor, root: f.target }), validate: async () => {},
      installPayload, notify: async () => {}, cleanup: () => {} }).then(request => child.emit('exit', request.phase === 'complete' ? 0 : 1)).catch(error => child.emit('error', error))
    expect(exe).toBe(join(f.target, 'BMN-worker.exe')); return child
  } })
  expect(result.exitCode).toBe(0); expect(installPayload).toHaveBeenCalledOnce()
})

it('requires the worker image even for worker-shaped argv and canonicalizes short names', () => {
  const options = { platform: 'win32', canonicalExecutable: value => value }
  expect(() => assertWindowsWorkerImage('C:\\payload\\BMN.exe', options)).toThrow('dedicated runtime image')
  expect(() => assertWindowsWorkerImage('C:\\payload\\BMN-WORKER.EXE', options)).not.toThrow()
  expect(() => assertWindowsWorkerImage('C:\\payload\\BMN-WO~1.EXE', { platform: 'win32',
    canonicalExecutable: () => 'C:\\payload\\BMN-worker.exe' })).not.toThrow()
})

it('fences engine creation against uninstall but releases the shared lease before waiting on the child', async () => {
  const f = await fixture(), events = [], child = new EventEmitter()
  const native = { acquireInstallLease: (_path, exclusive) => {
    expect(exclusive).toBe(false); events.push('shared-acquired')
    return { close: () => { events.push('shared-released'); setImmediate(() => child.emit('exit', 0)) } }
  } }
  const validate = async () => { events.push('validated') }
  const start = () => { events.push('child-created'); return child }
  expect((await delegateWindowsInstalledEngine(f.entry, [], { native, validate, start })).exitCode).toBe(0)
  expect(events).toEqual(['shared-acquired', 'validated', 'child-created', 'shared-released'])
})
