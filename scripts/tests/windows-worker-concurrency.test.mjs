// Actual async queue/lease orchestration with synthetic process observations.
// No native process, provider, owner profile or Windows registry is touched.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { delegateWindowsInstalledEngine } from '../lib/windows-installed-engine.mjs'
import { createWindowsWorkerImage, sealWindowsReleasePayload } from '../lib/windows-release-payload.mjs'
import { releaseDirectory } from '../lib/windows-release-transaction.mjs'
import { queueWindowsSourceUpdate } from '../lib/windows-source-update.mjs'
import { resumeWindowsSourceUpdate } from '../lib/windows-source-resume.mjs'
import { waitForWindowsAppsToExit } from '../lib/windows-installed-worker.mjs'

it('completes two concurrent installed starts without waiting on the worker blocked by the first request lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-concurrent-workers-')), processes = new Map(), locks = new Map()
  let pid = 100, activations = 0
  const native = { acquireInstallLease(path, exclusive) {
    const state = locks.get(path) ?? { shared: 0, exclusive: false }
    if (state.exclusive || (exclusive && state.shared)) throw Object.assign(new Error('synthetic sharing conflict'), { windowsError: 32 })
    if (exclusive) state.exclusive = true; else state.shared++
    locks.set(path, state)
    return { close() { if (exclusive) state.exclusive = false; else state.shared-- } }
  } }
  const payload = join(root, 'candidate'), requests = join(root, 'requests')
  mkdirSync(join(payload, 'resources/install'), { recursive: true }); mkdirSync(requests)
  writeFileSync(join(payload, 'BMN.exe'), 'synthetic-runtime')
  writeFileSync(join(payload, 'resources/app.asar'), 'synthetic-application')
  writeFileSync(join(payload, 'resources/install/worker.cjs'), 'synthetic-worker')
  createWindowsWorkerImage(payload)
  const descriptor = await sealWindowsReleasePayload(payload, { commit: 'a'.repeat(40), schemaVersion: 23, electronVersion: '45.0.0' })
  writeFileSync(join(root, 'installation.json'), JSON.stringify({ format: 1, current: descriptor, previous: null, snapshot: null }))
  const sourceState = { branch: 'main', head: descriptor.commit, originHead: descriptor.commit, status: '' }
  queueWindowsSourceUpdate(join(requests, 'source-update.json'), { repo: join(root, 'repo'), node: process.execPath,
    pnpm: join(root, 'pnpm.cjs'), sourceState })
  const entry = join(root, 'bootstrap/resources/install/worker.cjs')
  const start = (executable) => {
    const child = new EventEmitter(), ownPid = ++pid
    processes.set(ownPid, basename(executable))
    setImmediate(async () => {
      try {
        const result = await resumeWindowsSourceUpdate(root, { native, runtimeVersion: '45.0.0', privateDirectories: () => {},
          readSourceState: async () => sourceState,
          waitForExit: () => waitForWindowsAppsToExit({ ownPid,
            observe: () => [...processes].filter(([, image]) => image === 'BMN.exe').map(([processPid]) => processPid), wait: () => delay(5) }),
          buildSnapshot: async () => ({ ...descriptor, root: payload }), validate: async () => {}, cleanup: () => {}, notify: async () => {},
          installPayload: async () => { activations++; return { current: descriptor } } })
        child.emit('exit', result.phase === 'complete' ? 0 : 1)
      } catch (error) { child.emit('error', error) }
      finally { processes.delete(ownPid) }
    })
    return child
  }
  const options = { native, start, validate: async path => {
    expect(path).toBe(releaseDirectory(root, descriptor))
    expect(JSON.parse(readFileSync(join(payload, 'bmn-release.json'), 'utf8')).electronVersion).toBe('45.0.0')
  } }
  const runs = [delegateWindowsInstalledEngine(entry, [], options), delegateWindowsInstalledEngine(entry, [], options)]
  try {
    const result = await Promise.race([Promise.all(runs), delay(1200).then(() => { throw Error('Concurrent worker process-wait cycle') })])
    expect(result.every(row => row.exitCode === 0)).toBe(true); expect(activations).toBe(1)
  } finally {
    // Release simulated blockers so even the original-defect run leaves no
    // pending work or fixture directories after recording its bounded failure.
    processes.clear(); await Promise.allSettled(runs)
    expect([...locks.values()].every(state => !state.shared && !state.exclusive)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
