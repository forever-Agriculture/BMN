// MODULE: database-setup-store.test.ts - First-run durability, rollback and existing-profile protection
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { claimSetupDefaults, ensureSetupWorkspace, getFirstRunSetup, initializeFirstRunSetup, updateFirstRunSetup } from './database-setup-store'
import { listWorkspaces } from './database-workspace-store'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-20T00:00:00.000Z'

describe('first-run progress', () => {
  it('claims one defaults identity durably, without changing the public progress revision', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      expect(() => claimSetupDefaults(db)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
      const progress = initializeFirstRunSetup(db, false, '/synthetic-home', now)
      const first = claimSetupDefaults(db)
      expect(first).toMatchObject({ initialize: true, setupId: expect.stringMatching(/^[a-f0-9-]{36}$/) })
      expect(claimSetupDefaults(db)).toEqual({ ...first, initialize: false })
      initializeDatabase(db, now)
      expect(claimSetupDefaults(db)).toEqual({ ...first, initialize: false })
      expect(getFirstRunSetup(db)).toEqual(progress)
    } finally { db.close() }
  })

  it('never grants defaults initialization to an existing profile, including an explicitly opened Setup workspace', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      initializeFirstRunSetup(db, true, '/synthetic-home', now)
      ensureSetupWorkspace(db, '/synthetic-home', now)
      expect(() => claimSetupDefaults(db)).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    } finally { db.close() }
  })

  it('refuses a corrupt durable identity instead of creating a replacement', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      initializeFirstRunSetup(db, false, '/synthetic-home', now)
      db.prepare('UPDATE first_run_setup SET defaults_id = ? WHERE singleton = 1').run('x'.repeat(36))
      expect(() => claimSetupDefaults(db)).toThrowError(expect.objectContaining({ code: 'IO_ERROR' }))
    } finally { db.close() }
  })
  it('creates a workspace on an existing profile only for an explicit action and keeps its existing classification', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      initializeFirstRunSetup(db, true, '/synthetic-home', now)
      const created = ensureSetupWorkspace(db, '/synthetic-home', now)
      expect(created).toMatchObject({ state: 'existing', revision: 2 })
      expect(created.workspaceId).not.toBeNull()
      expect(ensureSetupWorkspace(db, '/synthetic-home', now)).toEqual(created)
      db.prepare('UPDATE workspace SET archived_at = ? WHERE workspace_id = ?').run(now, created.workspaceId)
      expect(() => ensureSetupWorkspace(db, '/synthetic-home', now)).toThrow('Restore the Setup workspace')
    } finally { db.close() }
  })
  it('creates one workspace and keeps Skip and Finish independent of session count and later profile evidence', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      expect(getFirstRunSetup(db)).toBeNull()
      const progress = initializeFirstRunSetup(db, false, '/synthetic-home', now)
      expect(progress).toMatchObject({ state: 'active', revision: 1 })
      expect(listWorkspaces(db).find(w => w.workspaceId === progress.workspaceId))
        .toMatchObject({ name: 'Setup', defaultCwd: '/synthetic-home' })
      expect(initializeFirstRunSetup(db, true, '/synthetic-home', now)).toEqual(progress)
      const skipped = updateFirstRunSetup(db, { state: 'skipped', expectedRevision: 1 }, now)
      initializeDatabase(db, now)
      expect(initializeFirstRunSetup(db, false, '/synthetic-home', now)).toEqual(skipped)
      const finished = updateFirstRunSetup(db, { state: 'finished', expectedRevision: skipped.revision }, now)
      expect(finished.state).toBe('finished')
      expect(initializeFirstRunSetup(db, false, '/synthetic-home', now)).toEqual(finished)
      expect(listWorkspaces(db).filter(w => w.name === 'Setup')).toHaveLength(1)
      expect(() => updateFirstRunSetup(db, { state: 'skipped', expectedRevision: 1 }, now))
        .toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    } finally { db.close() }
  })

  it('records an existing profile without adding a workspace and never changes its classification', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      const before = listWorkspaces(db)
      const progress = initializeFirstRunSetup(db, true, '/synthetic-home', now)
      expect(progress).toMatchObject({ state: 'existing', workspaceId: null })
      expect(initializeFirstRunSetup(db, false, '/synthetic-home', now)).toEqual(progress)
      expect(updateFirstRunSetup(db, { state: 'skipped', expectedRevision: 1 }, now)).toEqual(progress)
      expect(listWorkspaces(db)).toEqual(before)
    } finally { db.close() }
  })

  it('rolls back workspace creation if recording progress fails', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      const before = listWorkspaces(db)
      db.exec(`CREATE TRIGGER synthetic_setup_failure BEFORE INSERT ON first_run_setup
        BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`)
      expect(() => initializeFirstRunSetup(db, false, '/synthetic-home', now)).toThrow('synthetic write failure')
      expect(getFirstRunSetup(db)).toBeNull()
      expect(listWorkspaces(db)).toEqual(before)
      db.exec('DROP TRIGGER synthetic_setup_failure')
      expect(initializeFirstRunSetup(db, false, '/synthetic-home', now).state).toBe('active')
    } finally { db.close() }
  })

  it('does not recreate an archived or deleted Setup workspace', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db, now)
      const progress = initializeFirstRunSetup(db, false, '/synthetic-home', now)
      db.prepare('UPDATE workspace SET archived_at = ? WHERE workspace_id = ?').run(now, progress.workspaceId)
      expect(initializeFirstRunSetup(db, false, '/synthetic-home', now)).toEqual(progress)
      db.prepare('DELETE FROM workspace_layout WHERE workspace_id = ?').run(progress.workspaceId)
      db.prepare('DELETE FROM workspace WHERE workspace_id = ?').run(progress.workspaceId)
      expect(initializeFirstRunSetup(db, false, '/synthetic-home', now)).toMatchObject({ state: 'active', workspaceId: null })
      expect(listWorkspaces(db).filter(w => w.name === 'Setup')).toHaveLength(0)
    } finally { db.close() }
  })
})
