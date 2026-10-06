// Consistent SQLite recovery snapshots. Called only after both native leases
// and observed application/utility exit; never automatically restores old data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { writeConfigSafely } from '../../apps/desktop/bin/safe-config-write.mjs'

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function schema(database) {
  const present = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get()
  assert.ok(present, 'Existing data has no recognized migration metadata')
  const rows = database.prepare('SELECT version FROM schema_migration ORDER BY version').all()
  assert.ok(rows.length > 0 && rows.every((row, index) => row.version === index + 1), 'Data has incomplete or unrecognized migration metadata')
  return rows.at(-1).version
}

function integrity(database) {
  const rows = database.prepare('PRAGMA quick_check').all()
  assert.ok(rows.length === 1 && Object.values(rows[0])[0] === 'ok', 'SQLite recovery data did not verify')
}

function ordinaryFile(path) {
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Recovery refuses nonordinary files')
}

/** Constructor is loaded from the validated candidate's bundled native module. */
export async function inspectWindowsReleaseData({ databasePath, supportedSchemaVersion, snapshotPath, snapshotId, Database }) {
  assert.ok(isAbsolute(databasePath) && Number.isSafeInteger(supportedSchemaVersion) && supportedSchemaVersion >= 1)
  assert.equal(typeof Database, 'function', 'Bundled SQLite constructor required')
  if (!existsSync(databasePath)) return { schemaVersion: null }
  ordinaryFile(databasePath)
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const version = schema(database)
    assert.ok(version <= supportedSchemaVersion, 'Candidate cannot read the existing newer data schema')
    integrity(database)
    if (version === supportedSchemaVersion) return { schemaVersion: version }
    assert.ok(isAbsolute(snapshotPath)); assert.match(snapshotId, /^[a-zA-Z0-9_-]{1,128}$/)
    assert.equal(existsSync(snapshotPath), false, 'Recovery never overwrites an existing snapshot')
    const parent = lstatSync(dirname(snapshotPath))
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), 'Private snapshot directory must be provisioned by the caller')
    const canonicalData = realpathSync.native(databasePath), snapshotDirectory = realpathSync.native(dirname(snapshotPath))
    const same = relative(dirname(canonicalData), snapshotDirectory)
    assert.ok(!same.startsWith('..') && !isAbsolute(same), 'Snapshot must stay in the provisioned data directory')
    // Reserve a current-user-only file before SQLite opens it. On Windows chmod
    // is not an ACL; use the same verified native writer as configuration files.
    writeConfigSafely(snapshotPath, null, '')
    await database.backup(snapshotPath)
    ordinaryFile(snapshotPath)
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true })
    try { integrity(snapshot); assert.equal(schema(snapshot), version) } finally { snapshot.close() }
    const sha256 = await digest(snapshotPath)
    return { schemaVersion: version, snapshot: { id: snapshotId, sha256, verified: true } }
  } finally { database.close() }
}
