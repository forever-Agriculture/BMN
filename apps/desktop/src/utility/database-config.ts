export const DATABASE_BUSY_TIMEOUT_MS = 5_000

interface PragmaDatabase {
  pragma(source: string): unknown
}

export function configureDatabase(database: PragmaDatabase): void {
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`)
}
