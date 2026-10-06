import { configureDatabase } from './database-config'
import { DATABASE_MIGRATIONS } from './store-schema'

export type SqlValue = string | number | null

export interface DatabaseStatement {
  run(...values: SqlValue[]): { changes: number | bigint }
  get(...values: SqlValue[]): unknown
  all(...values: SqlValue[]): unknown[]
}

export interface DatabaseConnection {
  pragma(source: string): unknown
  exec(source: string): void
  prepare(source: string): DatabaseStatement
  transaction<Return>(operation: () => Return): () => Return
  close(): void
}

export interface DatabaseInitialization {
  schemaTables: string[]
  database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
  interruptedIncarnations: number
}

export const APPLICATION_INTERRUPTION_REASON =
  'BMN ended before this process incarnation reported an exit'

export function databaseSettings(
  database: DatabaseConnection
): { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number } {
  const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
  const busyTimeout = database.prepare('PRAGMA busy_timeout').get() as { timeout: number }
  return {
    journalMode: journal.journal_mode.toLowerCase(),
    foreignKeys: foreignKeys.foreign_keys === 1,
    busyTimeoutMs: busyTimeout.timeout
  }
}

export function initializeDatabase(
  database: DatabaseConnection,
  now: string = new Date().toISOString()
): DatabaseInitialization {
  // An older payload must not switch journal mode, apply migrations or label
  // running sessions interrupted before it knows that this schema is supported.
  const hasMigrations = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'"
  ).get() !== undefined
  const appliedRows = hasMigrations
    ? database.prepare('SELECT version FROM schema_migration').all() as Array<{ version: number }>
    : []
  const supported = new Set(DATABASE_MIGRATIONS.map(migration => migration.version))
  if (appliedRows.some(row => !supported.has(row.version))) {
    throw new Error('BMN refuses an unsupported data schema. Use a compatible version or recover the matching verified data snapshot; no migrations were applied.')
  }
  configureDatabase(database)
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
  const applied = new Set(appliedRows.map((row) => row.version))
  for (const migration of DATABASE_MIGRATIONS) {
    if (applied.has(migration.version)) continue
    database.transaction(() => {
      database.exec(migration.sql)
      database
        .prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)')
        .run(migration.version, now)
    })()
  }

  const interrupted = database
    .prepare(
      `UPDATE process_incarnation
       SET state = 'interrupted', exited_at = ?, exit_code = NULL,
           exit_signal = NULL, exit_detail = ?
       WHERE state IN ('starting', 'running')`
    )
    .run(now, APPLICATION_INTERRUPTION_REASON)
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as Array<{ name: string }>
  return {
    schemaTables: tables.map((row) => row.name),
    database: databaseSettings(database),
    interruptedIncarnations: Number(interrupted.changes)
  }
}
