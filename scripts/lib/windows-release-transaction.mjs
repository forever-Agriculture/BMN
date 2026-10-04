// Windows payload activation. The native adapter owns the exclusive installation
// lease, process observation, payload validation, isolated smoke and data backup.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const phases = new Set(['waiting', 'staging', 'validating', 'checking-data', 'publishing', 'activating', 'refreshing', 'complete', 'failed'])

export function releaseDescriptor(value) {
  assert.ok(value && typeof value === 'object', 'Missing release identity')
  assert.match(value.commit, /^[a-f0-9]{40}$/, 'Release must name an immutable commit')
  assert.match(value.payloadSha256, /^[a-f0-9]{64}$/, 'Release must name its payload manifest hash')
  assert.ok(Number.isSafeInteger(value.schemaVersion) && value.schemaVersion >= 0, 'Unknown candidate schema')
  return { commit: value.commit, payloadSha256: value.payloadSha256, schemaVersion: value.schemaVersion }
}

function sameRelease(a, b) {
  return a?.commit === b?.commit && a?.payloadSha256 === b?.payloadSha256 && a?.schemaVersion === b?.schemaVersion
}

export function releaseDirectory(root, release) {
  const descriptor = releaseDescriptor(release)
  return join(root, 'versions', `${descriptor.commit}-${descriptor.payloadSha256}`)
}

function ordinary(path, directory) {
  const info = lstatSync(path)
  assert.equal(info.isSymbolicLink(), false, 'Installation refuses links')
  assert.equal(directory ? info.isDirectory() : info.isFile() && info.nlink === 1, true, 'Unexpected installation object')
}

function readJson(path) {
  if (!existsSync(path)) return null
  ordinary(path, false)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function atomicJson(path, value) {
  if (existsSync(path)) ordinary(path, false)
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, path)
    assert.deepEqual(readJson(path), value, 'Installation state did not read back')
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function readWindowsInstallation(root) {
  if (!existsSync(root)) return null
  ordinary(root, true)
  const value = readJson(join(root, 'installation.json'))
  if (value === null) return null
  assert.equal(value.format, 1, 'Unsupported installation state')
  releaseDescriptor(value.current)
  if (value.previous !== null) releaseDescriptor(value.previous)
  return value
}

/**
 * Never overwrite a payload, delete a previous generation, or launch real-data
 * migrations during validation. Startup and updates share the adapter's native
 * lease, so another launcher cannot enter between the exit check and activation.
 */
export async function activateWindowsRelease({ root, candidate, withLease, waitForExit, stage, validate, smoke, inspectData, refreshMetadata, checkpoint = async () => {}, beforeActivate = async () => {} }) {
  const release = releaseDescriptor(candidate)
  for (const fn of [withLease, waitForExit, stage, validate, smoke, inspectData, refreshMetadata]) {
    assert.equal(typeof fn, 'function', 'All native release capabilities are required')
  }
  // First install has no parent for the native lease file yet. Do not read or
  // replace transaction state here; create/inspect only the installation root.
  mkdirSync(root, { recursive: true, mode: 0o700 }); ordinary(root, true)
  return withLease(async () => {
    ordinary(root, true)
    const versions = join(root, 'versions')
    mkdirSync(versions, { mode: 0o700, recursive: true }); ordinary(versions, true)
    const manifestPath = join(root, 'installation.json')
    const journalPath = join(root, 'update.json')
    const previousState = readWindowsInstallation(root)
    const oldJournal = readJson(journalPath)
    if (oldJournal !== null) {
      assert.equal(oldJournal.format, 1)
      assert.ok(phases.has(oldJournal.phase), 'Unsupported update phase')
      releaseDescriptor(oldJournal.candidate)
      assert.ok(oldJournal.phase === 'complete' || sameRelease(oldJournal.candidate, release),
        'A different unfinished update needs explicit recovery')
    }
    const target = releaseDirectory(root, release)
    // A crash after atomic activation leaves a truthful selected payload. Retry
    // only metadata repair; never reapply migrations or silently roll it back.
    const activated = sameRelease(previousState?.current, release)
    let journal = { format: 1, candidate: release, previous: activated ? previousState.previous : previousState?.current ?? null,
      phase: activated ? 'refreshing' : 'waiting', activated, snapshot: activated ? previousState.snapshot : null }
    const record = async phase => {
      journal = { ...journal, phase }
      atomicJson(journalPath, journal)
      await checkpoint(phase)
    }
    try {
      if (!activated) {
        await record('waiting')
        await waitForExit()
        await record('staging')
        const stagingRoot = join(root, 'staging')
        mkdirSync(stagingRoot, { mode: 0o700, recursive: true }); ordinary(stagingRoot, true)
        const staged = join(stagingRoot, `${release.commit}-${randomUUID()}`)
        mkdirSync(staged, { mode: 0o700 })
        journal.staging = staged.slice(stagingRoot.length + 1)
        await record('staging')
        // A failed attempt is retained and never reused as a complete payload.
        // Smoke outside versions/ so the installed-selection guard cannot open
        // real data or mistake a staged validation process for normal startup.
        await stage(staged)
        ordinary(staged, true)
        await record('validating')
        await validate(staged, release)
        await smoke(staged) // Adapter must use disposable profiles, never owner data.
        await record('checking-data')
        const data = await inspectData(release)
        assert.ok(data && (data.schemaVersion === null || (Number.isSafeInteger(data.schemaVersion) && data.schemaVersion >= 0)), 'Data compatibility was not measured')
        assert.ok(data.schemaVersion === null || data.schemaVersion <= release.schemaVersion, 'Candidate cannot read the existing newer schema')
        if (data.schemaVersion !== null && data.schemaVersion < release.schemaVersion) {
          assert.ok(data.snapshot?.verified === true, 'Migration needs a verified consistent data snapshot')
          assert.match(data.snapshot.id, /^[a-zA-Z0-9_-]{1,128}$/)
          assert.match(data.snapshot.sha256, /^[a-f0-9]{64}$/)
          journal.snapshot = { id: data.snapshot.id, sha256: data.snapshot.sha256 }
        }
        await record('publishing')
        if (existsSync(target)) {
          ordinary(target, true)
          await validate(target, release)
        } else renameSync(staged, target)
        await record('activating')
        await beforeActivate()
        // All supported selection writers must hold this same lease. This check
        // detects callback-time drift; it does not fence arbitrary raw owner edits.
        assert.deepEqual(readWindowsInstallation(root), previousState, 'Installation selection changed during validation')
        atomicJson(manifestPath, { format: 1, current: release,
          previous: previousState?.current ?? null, snapshot: journal.snapshot })
        journal.activated = true
        await record('refreshing')
      } else {
        ordinary(target, true)
        await validate(target, release)
        await record('refreshing')
      }
      await refreshMetadata(target, release)
      await record('complete')
      return readWindowsInstallation(root)
    } catch (error) {
      // A failed atomic replacement may have succeeded before readback/receipt.
      // Selection, not the in-memory flag, determines recovery responsibility.
      journal = { ...journal, phase: 'failed', activated: sameRelease(readWindowsInstallation(root)?.current, release) }
      atomicJson(journalPath, journal)
      throw error
    }
  })
}
