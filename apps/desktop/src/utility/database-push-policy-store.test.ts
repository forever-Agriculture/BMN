// MODULE: database-push-policy-store.test.ts - Story 83.3: the push policy as one revisioned raw setting, its empty start and its unknown state
import { createRequire } from 'node:module'
import {
  PUSH_POLICY_KEY,
  PUSH_POLICY_POINTER,
  githubRepositoryFromRemote,
  pushPolicyStanding,
  pushPolicyStatus,
  readPushPolicy
} from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changePushPolicy, getPushPolicy } from './database-push-policy-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { LEVEL_WORDS, remoteRepository } from '../../bin/policy-cli.mjs'
import { PUSH_LEVEL_WORDS } from '@bmn/protocol'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const T0 = '2026-10-18T19:10:00.000Z'
const T1 = '2026-10-18T19:20:00.000Z'
let database: DatabaseConnection

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, T0)
})
afterEach(() => database.close())

const stored = (): string | undefined =>
  (database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(PUSH_POLICY_KEY) as { value_json: string } | undefined)?.value_json

describe('push policy store (Story 83.3)', () => {
  it('starts with no owner allowed, writes nothing until a change, and authorizes nothing by itself', () => {
    const start = getPushPolicy(database)
    expect(start).toEqual({ state: 'read', record: { version: 1, revision: 0, owners: [], levels: [] } })
    expect(stored()).toBeUndefined()
    expect(pushPolicyStanding(start, true)).toEqual({ authorizes: false, why: 'no owner is allowed in Health' })
  })

  it('changes one owner or one level at a time against the revision Health saw, lower-cased, and refuses a stale one', () => {
    const allowed = changePushPolicy(database, { kind: 'owner', login: 'Octo-Org', allowed: true, expectedRevision: 0 }, T0)
    expect(allowed).toMatchObject({ outcome: 'changed', record: { revision: 1, owners: [{ login: 'octo-org', allowed: true, changedAt: T0 }] } })
    expect(changePushPolicy(database, { kind: 'owner', login: 'octo-org', allowed: false, expectedRevision: 0 }, T1).outcome).toBe('stale')
    const raised = changePushPolicy(database, { kind: 'level', repository: 'Octo-Org/Widgets.git', level: 'merge-and-push-main', expectedRevision: 1 }, T1)
    expect(raised).toMatchObject({ outcome: 'changed', record: { revision: 2, levels: [{ repository: 'octo-org/widgets', level: 'merge-and-push-main' }] } })
    // Back to PRs only is the absence of a raise; the same level again changes nothing.
    expect(changePushPolicy(database, { kind: 'level', repository: 'octo-org/widgets', level: 'merge-and-push-main', expectedRevision: 2 }, T1).outcome).toBe('unchanged')
    expect(changePushPolicy(database, { kind: 'level', repository: 'octo-org/widgets', level: 'prs-only', expectedRevision: 2 }, T1))
      .toMatchObject({ outcome: 'changed', record: { revision: 3, levels: [] } })
    expect(getPushPolicy(database)).toMatchObject({ state: 'read', record: { revision: 3, owners: [{ login: 'octo-org', allowed: true }] } })
  })

  it('refuses a change that names no valid owner, repository or level', () => {
    expect(changePushPolicy(database, { kind: 'owner', login: 'bad login', allowed: true, expectedRevision: 0 }, T0).outcome).toBe('invalid')
    expect(changePushPolicy(database, { kind: 'level', repository: 'octo/../x', level: 'prs-only', expectedRevision: 0 }, T0).outcome).toBe('invalid')
    expect(changePushPolicy(database, { kind: 'level', repository: 'octo/widgets', level: 'admin' as never, expectedRevision: 0 }, T0).outcome).toBe('invalid')
    expect(stored()).toBeUndefined()
  })

  it('reads a row it cannot read as unknown, counts it as denied and never writes over it', () => {
    database.prepare('INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)').run(PUSH_POLICY_KEY, JSON.stringify({ version: 1, revision: 4, owners: [{ login: 'octo', allowed: 'yes' }], levels: [] }), T0)
    const read = getPushPolicy(database)
    expect(read).toEqual({ state: 'unknown', reason: 'the stored policy has an owner it cannot read' })
    expect(pushPolicyStanding(read, true).authorizes).toBe(false)
    const before = stored()
    expect(changePushPolicy(database, { kind: 'owner', login: 'octo', allowed: true, expectedRevision: 4 }, T1).outcome).toBe('unknown')
    expect(stored()).toBe(before)
    expect(pushPolicyStatus(read, true)).toMatchObject({ state: 'unknown', allowed: [], levels: [] })
    for (const raw of ['not json', '[]', '{"version":2,"revision":0,"owners":[],"levels":[]}', '{"version":1,"revision":-1,"owners":[],"levels":[]}']) {
      expect(readPushPolicy(raw).state).toBe('unknown')
    }
  })

  it('authorizes only while an owner is allowed and the rules master carries the pointer', () => {
    changePushPolicy(database, { kind: 'owner', login: 'octo', allowed: true, expectedRevision: 0 }, T0)
    const read = getPushPolicy(database)
    expect(pushPolicyStanding(read, true)).toEqual({ authorizes: true, why: null })
    expect(pushPolicyStanding(read, false)).toEqual({ authorizes: false, why: 'the rules master does not carry the policy pointer' })
    expect(pushPolicyStanding(read, null)).toEqual({ authorizes: false, why: 'the rules master could not be read' })
    // Denying every owner is the off switch.
    changePushPolicy(database, { kind: 'owner', login: 'octo', allowed: false, expectedRevision: 1 }, T1)
    expect(pushPolicyStanding(getPushPolicy(database), true).authorizes).toBe(false)
    expect(PUSH_POLICY_POINTER).toBe('bmn policy --repo')
  })

  it('reads a GitHub remote the same way in the app and in `bmn policy`, and keeps the level words the same', () => {
    const cases: Array<[string, string | null]> = [
      ['https://github.com/Octo/Widgets.git', 'octo/widgets'],
      ['git@github.com:octo/widgets.git', 'octo/widgets'],
      ['ssh://git@github.com/octo/widgets', 'octo/widgets'],
      ['git@github-work:octo-org/svc.api.git', 'octo-org/svc.api'],
      ['git@gitlab.com:octo/widgets.git', null],
      ['https://example.com/octo/widgets.git', null],
      ['/srv/git/local.git', null]
    ]
    for (const [url, expected] of cases) {
      expect(githubRepositoryFromRemote(url)).toBe(expected)
      expect(remoteRepository(url)).toBe(expected)
    }
    expect(LEVEL_WORDS).toEqual(PUSH_LEVEL_WORDS)
  })
})
