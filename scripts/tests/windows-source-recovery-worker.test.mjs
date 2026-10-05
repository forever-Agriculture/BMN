// Exercise all four actual recovery modules. Only OS process/ACL/lease/database
// capabilities are substituted; this is synthetic integration, not native proof.
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { queueWindowsSourceUpdate, readWindowsSourceUpdate } from '../lib/windows-source-update.mjs'
import { activateWindowsRelease, readWindowsInstallation } from '../lib/windows-release-transaction.mjs'
import { sealWindowsReleasePayload, validateWindowsReleasePayload } from '../lib/windows-release-payload.mjs'
import { workerOnlySubprocessRoute } from './windows-native-capability-routing.test-support.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)), commit = 'a'.repeat(40)
const sourceState = { branch: 'main', head: commit, originHead: commit, status: '' }
const requireVite = createRequire(createRequire(join(repo, 'apps/desktop/package.json')).resolve('vite/package.json'))
const esbuild = requireVite('esbuild')
const timeout = process.platform === 'win32' ? 90000 : 10000

async function exercise(mode, dropFlag = false) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-recovery-worker-chain-')), installation = join(root, 'installation'), payload = join(root, 'payload')
  const originalSystemRoot = process.env.SystemRoot
  const close = vi.fn(), builds = vi.fn(), cleanup = vi.fn(), metadata = vi.fn(async () => {})
  try {
    mkdirSync(join(payload, 'resources/install'), { recursive: true })
    for (const name of ['BMN.exe', 'BMN-worker.exe']) writeFileSync(join(payload, name), 'synthetic runtime')
    writeFileSync(join(payload, 'resources/app.asar'), 'synthetic archive')
    writeFileSync(join(payload, 'resources/install/BMN-launcher.exe'), 'synthetic launcher')
    const descriptor = await sealWindowsReleasePayload(payload, { commit, schemaVersion: 23, electronVersion: '44.3.0' })
    await activateWindowsRelease({ root: installation, candidate: descriptor, withLease: operation => operation(),
      waitForExit: async () => {}, stage: async target => cpSync(payload, target, { recursive: true }),
      validate: validateWindowsReleasePayload, smoke: async () => {}, inspectData: async () => ({ schemaVersion: 23 }), refreshMetadata: async () => {} })
    mkdirSync(join(installation, 'requests')); mkdirSync(join(root, 'data'))
    const requestPath = join(installation, 'requests/source-update.json'), journalPath = join(installation, 'update.json')
    queueWindowsSourceUpdate(requestPath, { repo: join(root, 'source'), node: process.execPath, pnpm: join(root, 'pnpm.cjs'), sourceState })
    writeFileSync(requestPath, JSON.stringify({ ...readWindowsSourceUpdate(requestPath), phase: 'activating', candidate: descriptor }))
    let selectedAtLease, journalAtLease, acquisition = 0
    const database = vi.fn(() => { throw new Error('Recovery attempted data inspection') })
    globalThis.__bmnRecoveryNative = { bmnInstallLeaseVersion: 1, acquireInstallLease(path) {
      if (path === join(installation, 'run.lock')) {
        acquisition++
        if (mode === 'selection') {
          const selected = readWindowsInstallation(installation); selected.current = { ...descriptor, payloadSha256: 'f'.repeat(64) }
          writeFileSync(join(installation, 'installation.json'), JSON.stringify(selected))
        }
        if (mode === 'missing-journal') rmSync(journalPath)
        if (mode === 'completed-mismatch') {
          const journal = JSON.parse(readFileSync(journalPath, 'utf8')); journal.candidate = { ...descriptor, payloadSha256: 'f'.repeat(64) }
          writeFileSync(journalPath, JSON.stringify(journal))
        }
        selectedAtLease = readWindowsInstallation(installation)
        try { journalAtLease = readFileSync(journalPath) } catch { journalAtLease = null }
      }
      return { close }
    } }
    globalThis.__bmnRecoveryDatabase = database
    const output = join(root, 'recovery-chain.mjs')
    const result = await esbuild.build({ stdin: { contents: "export { resumeWindowsSourceUpdate } from './scripts/lib/windows-source-resume.mjs'; export { installWindowsPayload } from './scripts/lib/windows-installed-worker.mjs';", resolveDir: repo },
      outfile: output, bundle: true, platform: 'node', target: 'node24', format: 'esm', metafile: true,
      define: { 'import.meta.url': 'undefined' }, plugins: [{ name: 'synthetic-native-capabilities', setup(build) {
        build.onResolve({ filter: /^node:module$/ }, args => ({ path: args.path, namespace: 'synthetic-native' }))
        build.onResolve({ filter: /^node:child_process$/ }, workerOnlySubprocessRoute(resolve(repo, 'scripts/lib/windows-installed-worker.mjs')))
        build.onLoad({ filter: /.*/, namespace: 'synthetic-native' }, args => ({ contents: args.path === 'node:module'
          ? "export const createRequire=()=>name=>{if(name==='better-sqlite3')return globalThis.__bmnRecoveryDatabase;if(name==='node-pty/lib/utils')return {loadNativeModule:()=>({module:globalThis.__bmnRecoveryNative})};throw Error('Unexpected native dependency')};"
          : "export const spawn=()=>{throw Error('Unexpected child launch')}; export const spawnSync=(_exe,args)=>{const source=Buffer.from(args.at(-1),'base64').toString('utf16le');if(!source.includes('Get-CimInstance'))throw Error('Unexpected process operation');return {status:0,stdout:JSON.stringify([process.pid]),stderr:''}};" }))
        build.onLoad({ filter: /private-directory\.ts$/ }, () => ({ contents: 'export const ensurePrivateDirectories=()=>{}; export const provisionPrivateDirectories=()=>{};' }))
        build.onLoad({ filter: /windows-installed-worker\.mjs$/ }, args => {
          let text = readFileSync(args.path, 'utf8')
          const platformFence = "assert.equal(process.platform, 'win32', 'Native Windows installer required')"
          expect(text.split(platformFence)).toHaveLength(2)
          // Substitute only this OS entry guard, keeping real filesystem path
          // rules on the host platform throughout the rest of the graph.
          text = text.replace(platformFence, "assert.equal('win32', 'win32', 'Native Windows installer required')")
          const token = 'candidate: descriptor, beforeActivate, requireAlreadySelected,'
          expect(text.split(token)).toHaveLength(2)
          return { contents: dropFlag ? text.replace(token, 'candidate: descriptor, beforeActivate,') : text, loader: 'js' }
        })
      } }] })
    for (const name of ['windows-source-update.mjs', 'windows-source-resume.mjs', 'windows-installed-worker.mjs', 'windows-release-transaction.mjs']) {
      expect(Object.keys(result.metafile.inputs).some(path => path.endsWith('/' + name))).toBe(true)
    }
    const workerInput = Object.entries(result.metafile.inputs).find(([path]) => path.endsWith('/windows-installed-worker.mjs'))[1]
    const configInput = Object.entries(result.metafile.inputs).find(([path]) => path.endsWith('/safe-config-write.mjs'))[1]
    expect(workerInput.imports.some(value => value.path === 'synthetic-native:node:child_process')).toBe(true)
    expect(configInput.imports.some(value => value.path === 'node:child_process' && value.external)).toBe(true)
    const chain = await import(pathToFileURL(output).href)
    process.env.SystemRoot = 'C:\\Windows'
    const resumed = await chain.resumeWindowsSourceUpdate(installation, { dataRoot: join(root, 'data'), runtimeVersion: '44.3.0',
      native: globalThis.__bmnRecoveryNative, readSourceState: async () => ({ ...sourceState }), waitForExit: async () => {}, buildSnapshot: builds,
      installPayload: options => chain.installWindowsPayload({ ...options, refreshMetadata: metadata }), notify: async () => {}, cleanup })
    expect(acquisition, JSON.stringify({ phase: resumed.phase, error: resumed.error })).toBe(1)
    let journalAfter
    try { journalAfter = readFileSync(journalPath) } catch { journalAfter = null }
    return { phase: resumed.phase, selectionUnchanged: JSON.stringify(readWindowsInstallation(installation)) === JSON.stringify(selectedAtLease),
      journalUnchanged: journalAtLease === null ? journalAfter === null : journalAtLease.equals(journalAfter),
      builds: builds.mock.calls.length, cleanup: cleanup.mock.calls.length, database: database.mock.calls.length,
      metadata: metadata.mock.calls.length, acquisition, closed: close.mock.calls.length }
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalSystemRoot
    delete globalThis.__bmnRecoveryNative; delete globalThis.__bmnRecoveryDatabase
    rmSync(root, { recursive: true, force: true })
  }
}

it('repairs only metadata through the actual resume, worker and transaction chain', async () => {
  expect(await exercise('nominal')).toMatchObject({ phase: 'complete', selectionUnchanged: true, builds: 0, cleanup: 0, database: 0, metadata: 1, acquisition: 1, closed: 3 })
}, timeout)
it.each(['selection', 'missing-journal', 'completed-mismatch'])('refuses a global-lease recovery race through the actual worker: %s', async mode => {
  expect(await exercise(mode)).toMatchObject({ phase: 'failed', selectionUnchanged: true, journalUnchanged: true, builds: 0, cleanup: 0, database: 0, metadata: 0, acquisition: 1, closed: 3 })
}, timeout)
it('detects a worker that drops the selected-only flag before transaction entry', async () => {
  const control = await exercise('missing-journal', true)
  expect(control).toMatchObject({ phase: 'complete', selectionUnchanged: true, journalUnchanged: false, metadata: 1 })
}, timeout)
