// MODULE: database-push-policy-store.ts - the owner's push and merge policy as one raw setting, changed only by one serialised operation (Story 83.3)
import {
  PUSH_POLICY_KEY,
  applyPushPolicyChange,
  readPushPolicy,
  type PushPolicyChange,
  type PushPolicyChangeResult,
  type PushPolicyRead
} from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'

function readRow(database: DatabaseConnection): PushPolicyRead {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(PUSH_POLICY_KEY) as { value_json: string } | undefined
  return readPushPolicy(row?.value_json)
}

/** The stored policy; a row that cannot be read is `unknown` and stays as it is. */
export function getPushPolicy(database: DatabaseConnection): PushPolicyRead {
  return readRow(database)
}

/** Reads, decides and writes in the worker's one transaction, so two changes at once apply one after another. */
export function changePushPolicy(database: DatabaseConnection, change: PushPolicyChange, now: string): PushPolicyChangeResult {
  const result = applyPushPolicyChange(readRow(database), change, now)
  if (result.outcome === 'changed') {
    database.prepare(
      `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(PUSH_POLICY_KEY, JSON.stringify(result.record), now)
  }
  return result
}

export const PUSH_POLICY_OPERATIONS = Object.freeze({ getPushPolicy, changePushPolicy })
