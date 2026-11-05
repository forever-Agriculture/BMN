// MODULE: plan-migration-lock.d.mts - migration writer lease types
export declare function migrationPaths(repo: string): { common: string; folder: string; journal: string; lock: string }
export declare function withMigrationWriter<T>(repo: string, operation: () => Promise<T>, options?: { waitMs?: number }): Promise<T>
