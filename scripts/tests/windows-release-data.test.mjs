import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import files, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import processes from 'node:child_process'
import { inspectWindowsReleaseData } from '../lib/windows-release-data.mjs'
import { nativeTimings } from './native-timings.test-support.mjs'

const requireApp = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const Database = requireApp('better-sqlite3'), roots = []
const actualSpawnSync = processes.spawnSync, actualCreateReadStream = files.createReadStream
let activeTrace
const pendingDiagnostics = []
beforeEach(({ task }) => {
  activeTrace = nativeTimings(`release-data:${task.name}`)
  pendingDiagnostics.push(activeTrace)
  vi.spyOn(processes, 'spawnSync').mockImplementation((...args) => activeTrace.measure('native-reservation', () => actualSpawnSync(...args)))
  vi.spyOn(files, 'createReadStream').mockImplementation((...args) => {
    const trace = activeTrace
    trace.mark('digest:begin')
    const stream = actualCreateReadStream(...args)
    stream.once('end', () => trace.mark('digest:end'))
    stream.once('error', () => trace.mark('digest:error'))
    return stream
  })
  syncBuiltinESMExports()
})
afterEach(() => {
  const traces = pendingDiagnostics.splice(0)
  for (const trace of traces) trace.mark('cleanup:begin')
  try { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) }
  finally {
    for (const trace of traces) { trace.mark('cleanup:end'); trace.report() }
    activeTrace = undefined
    vi.mocked(processes.spawnSync).mockRestore(); vi.mocked(files.createReadStream).mockRestore(); syncBuiltinESMExports()
  }
})
function measuredDatabase(trace) {
  return function (...args) {
    const database = trace.measure('database-open', () => new Database(...args))
    const prepare = database.prepare.bind(database), close = database.close.bind(database), backup = database.backup.bind(database)
    database.prepare = (...query) => {
      const statement = trace.measure('query-prepare', () => prepare(...query))
      for (const name of ['get', 'all']) {
        const execute = statement[name].bind(statement)
        statement[name] = (...values) => trace.measure(`query-${name}`, () => execute(...values))
      }
      return statement
    }
    database.close = () => trace.measure('database-close', close)
    database.backup = async (...values) => {
      trace.mark('sqlite-backup:begin')
      try { return await backup(...values) } finally { trace.mark('sqlite-backup:end') }
    }
    return database
  }
}
function fixture(version) {
  const trace = activeTrace
  trace.mark('fixture:begin')
  const root = mkdtempSync(join(tmpdir(), 'bmn-release-data-')); roots.push(root)
  const databasePath = join(root, 'state.sqlite3'), snapshotPath = join(root, 'before-migration.sqlite3')
  const database = trace.measure('fixture-db-open', () => new Database(databasePath))
  try {
    // This fixture represents already committed data, not migration throughput.
    trace.measure('fixture-seed-transaction', () => database.transaction(() => {
      database.exec("CREATE TABLE schema_migration(version INTEGER PRIMARY KEY); CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES ('preserved')")
      const insert = database.prepare('INSERT INTO schema_migration VALUES (?)')
      for (let n = 1; n <= version; n++) insert.run(n)
    })())
    expect(database.prepare('SELECT version FROM schema_migration ORDER BY version').all())
      .toEqual(Array.from({ length: version }, (_, i) => ({ version: i + 1 })))
    expect(database.prepare('SELECT value FROM synthetic').all()).toEqual([{ value: 'preserved' }])
  } finally { trace.measure('fixture-db-close', () => database.close()) }
  trace.mark('fixture:end')
  return { databasePath, snapshotPath, snapshotId: 'synthetic-before-migration', supportedSchemaVersion: 23, Database: measuredDatabase(trace) }
}
describe('release data compatibility and snapshot', () => {
  it('checks a matching schema read-only without producing a snapshot', async () => {
    const trace = activeTrace
    const f = fixture(23), before = trace.measure('before-bytes', () => readFileSync(f.databasePath))
    trace.mark('inspect:begin')
    expect(await inspectWindowsReleaseData(f)).toEqual({ schemaVersion: 23 })
    trace.mark('inspect:end')
    expect(readFileSync(f.databasePath)).toEqual(before); expect(existsSync(f.snapshotPath)).toBe(false)
    trace.mark('assertions:end')
  }, 5000)
  it('makes and verifies a consistent private recovery file before a newer migration', async () => {
    const f = fixture(22), before = readFileSync(f.databasePath), result = await inspectWindowsReleaseData(f)
    expect(result).toEqual({ schemaVersion: 22, snapshot: { id: f.snapshotId, verified: true,
      sha256: createHash('sha256').update(readFileSync(f.snapshotPath)).digest('hex') } })
    const snapshot = new Database(f.snapshotPath, { readonly: true })
    try { expect(snapshot.prepare('SELECT value FROM synthetic').get()).toEqual({ value: 'preserved' }) } finally { snapshot.close() }
    expect(readFileSync(f.databasePath)).toEqual(before)
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('never overwrites')
  }, 5000)
  it('refuses a newer or unrecognized schema before writing any recovery file', async () => {
    const f = fixture(24), before = readFileSync(f.databasePath)
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('newer data schema')
    expect(readFileSync(f.databasePath)).toEqual(before); expect(existsSync(f.snapshotPath)).toBe(false)
    const database = new Database(f.databasePath); database.exec('DROP TABLE schema_migration'); database.close()
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('no recognized')
    expect(existsSync(f.snapshotPath)).toBe(false)
  }, 5000)
  it('supports a provisioned snapshot subdirectory and refuses a sibling outside data', async () => {
    const f = fixture(22), snapshots = join(f.databasePath, '..', 'snapshots')
    mkdirSync(snapshots)
    f.snapshotPath = join(snapshots, 'recovery.sqlite3')
    expect((await inspectWindowsReleaseData(f)).snapshot.verified).toBe(true)
    const outside = mkdtempSync(join(tmpdir(), 'bmn-release-outside-')); roots.push(outside)
    f.snapshotPath = join(outside, 'forbidden.sqlite3')
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('provisioned data directory')
    expect(existsSync(f.snapshotPath)).toBe(false)
  }, 5000)
  it('backs up committed WAL data consistently without losing uncheckpointed records', async () => {
    const f = fixture(22), writer = new Database(f.databasePath)
    try {
      writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0')
      writer.prepare('INSERT INTO synthetic VALUES (?)').run('committed in WAL')
      const result = await inspectWindowsReleaseData(f)
      expect(result.snapshot.verified).toBe(true)
      const snapshot = new Database(f.snapshotPath, { readonly: true })
      try { expect(snapshot.prepare('SELECT value FROM synthetic ORDER BY rowid').all())
        .toEqual([{ value: 'preserved' }, { value: 'committed in WAL' }]) } finally { snapshot.close() }
      expect(writer.prepare('SELECT count(*) AS total FROM synthetic').get()).toEqual({ total: 2 })
    } finally { writer.close() }
  }, 5000)
})
