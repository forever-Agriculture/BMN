import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectWindowsReleaseData } from '../lib/windows-release-data.mjs'

const requireApp = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const Database = requireApp('better-sqlite3'), roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-release-data-')); roots.push(root)
  const databasePath = join(root, 'state.sqlite3'), snapshotPath = join(root, 'before-migration.sqlite3')
  const database = new Database(databasePath)
  database.exec("CREATE TABLE schema_migration(version INTEGER PRIMARY KEY); CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES ('preserved')")
  for (let n = 1; n <= version; n++) database.prepare('INSERT INTO schema_migration VALUES (?)').run(n)
  database.close()
  return { databasePath, snapshotPath, snapshotId: 'synthetic-before-migration', supportedSchemaVersion: 23, Database }
}
describe('release data compatibility and snapshot', () => {
  it('checks a matching schema read-only without producing a snapshot', async () => {
    const f = fixture(23), before = readFileSync(f.databasePath)
    expect(await inspectWindowsReleaseData(f)).toEqual({ schemaVersion: 23 })
    expect(readFileSync(f.databasePath)).toEqual(before); expect(existsSync(f.snapshotPath)).toBe(false)
  })
  it('makes and verifies a consistent private recovery file before a newer migration', async () => {
    const f = fixture(22), before = readFileSync(f.databasePath), result = await inspectWindowsReleaseData(f)
    expect(result).toEqual({ schemaVersion: 22, snapshot: { id: f.snapshotId, verified: true,
      sha256: createHash('sha256').update(readFileSync(f.snapshotPath)).digest('hex') } })
    const snapshot = new Database(f.snapshotPath, { readonly: true })
    try { expect(snapshot.prepare('SELECT value FROM synthetic').get()).toEqual({ value: 'preserved' }) } finally { snapshot.close() }
    expect(readFileSync(f.databasePath)).toEqual(before)
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('never overwrites')
  })
  it('refuses a newer or unrecognized schema before writing any recovery file', async () => {
    const f = fixture(24), before = readFileSync(f.databasePath)
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('newer data schema')
    expect(readFileSync(f.databasePath)).toEqual(before); expect(existsSync(f.snapshotPath)).toBe(false)
    const database = new Database(f.databasePath); database.exec('DROP TABLE schema_migration'); database.close()
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('no recognized')
    expect(existsSync(f.snapshotPath)).toBe(false)
  })
  it('supports a provisioned snapshot subdirectory and refuses a sibling outside data', async () => {
    const f = fixture(22), snapshots = join(f.databasePath, '..', 'snapshots')
    mkdirSync(snapshots)
    f.snapshotPath = join(snapshots, 'recovery.sqlite3')
    expect((await inspectWindowsReleaseData(f)).snapshot.verified).toBe(true)
    const outside = mkdtempSync(join(tmpdir(), 'bmn-release-outside-')); roots.push(outside)
    f.snapshotPath = join(outside, 'forbidden.sqlite3')
    await expect(inspectWindowsReleaseData(f)).rejects.toThrow('provisioned data directory')
    expect(existsSync(f.snapshotPath)).toBe(false)
  })
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
  })
})
