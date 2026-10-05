// Synthetic files only. This child dies after the actual transaction selects its
// payload, before the actual source updater can record durable completion.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resumeWindowsSourceUpdate } from '../../lib/windows-source-resume.mjs'
import { activateWindowsRelease } from '../../lib/windows-release-transaction.mjs'
import { sealWindowsReleasePayload, validateWindowsReleasePayload } from '../../lib/windows-release-payload.mjs'

const [root, commit, mode = 'selection'] = process.argv.slice(2)
assert.match(commit, /^[a-f0-9]{40}$/u)
let candidate
if (mode === 'selection') {
  const payloadRoot = join(root, 'built')
  mkdirSync(join(payloadRoot, 'resources'), { recursive: true })
  writeFileSync(join(payloadRoot, 'BMN.exe'), 'synthetic runtime')
  writeFileSync(join(payloadRoot, 'BMN-worker.exe'), 'synthetic runtime')
  writeFileSync(join(payloadRoot, 'resources/app.asar'), 'first frozen artifact')
  candidate = { root: payloadRoot, ...await sealWindowsReleasePayload(payloadRoot,
    { commit, schemaVersion: 23, electronVersion: '44.3.0' }) }
}
const installation = join(root, 'installation')
await resumeWindowsSourceUpdate(installation, {
  dataRoot: join(root, 'data'), runtimeVersion: '44.3.0',
  native: { acquireInstallLease: () => ({ close() {} }) }, privateDirectories: () => {},
  readSourceState: async () => ({ branch: 'main', head: commit, originHead: commit, status: '' }),
  waitForExit: async () => {}, buildSnapshot: async () => { assert.ok(candidate, 'Recovery attempted a rebuild'); return candidate },
  validate: async (...args) => {
    await validateWindowsReleasePayload(...args)
    if (mode === 'validation') { writeFileSync(join(root, 'recovery-crash-point'), mode); process.kill(process.pid, 'SIGKILL') }
  },
  installPayload: async options => {
    await activateWindowsRelease({ root: installation, candidate: options.descriptor,
      requireAlreadySelected: options.requireAlreadySelected, beforeActivate: options.beforeActivate,
      withLease: operation => operation(), waitForExit: async () => {},
      stage: async target => cpSync(options.source, target, { recursive: true }),
      validate: validateWindowsReleasePayload, smoke: async () => {},
      inspectData: async () => { writeFileSync(join(root, 'first-inspection'), '1'); return { schemaVersion: 23 } },
      refreshMetadata: async () => {
        if (mode === 'metadata') { writeFileSync(join(root, 'recovery-crash-point'), mode); process.kill(process.pid, 'SIGKILL') }
      } })
    if (mode === 'selection') { writeFileSync(join(root, 'selection-before-crash'), '1'); process.kill(process.pid, 'SIGKILL') }
    return { current: options.descriptor }
  }, notify: async () => {
    if (mode === 'completion') { writeFileSync(join(root, 'recovery-crash-point'), mode); process.kill(process.pid, 'SIGKILL') }
  }, cleanup: () => { throw new Error('Crash cannot run cleanup') }
})
throw new Error('Synthetic crash point was not reached')
