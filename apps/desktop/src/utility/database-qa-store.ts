// MODULE: database-qa-store.ts - one SQLite writer owns keyed QA runs, bindings and retained outcomes
import { type QaAuditState, type QaRun } from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'
import { invalidWorkspaceStore as invalid, selectSession } from './database-workspace-store'

function read(row: unknown): QaRun | null {
  if (!row) return null
  return JSON.parse((row as { record_json: string }).record_json) as QaRun
}
export function getQaRun(database: DatabaseConnection, id: string): QaRun | null {
  return read(database.prepare('SELECT record_json FROM qa_run WHERE qa_id = ?').get(id))
}
/** Internal audit helper, deliberately absent from the generic companion operation map. */
export function writeQaRunAudit(database: DatabaseConnection, id: string, audit: QaAuditState): void {
  const run = getQaRun(database, id)
  if (!run) return invalid('QA_NOT_FOUND')
  write(database, { ...run, audit })
}
/** Internal seal, absent from generic RPC operations. The ledger refuses every subsequent mutation. */
export function sealQaRunAccounts(database: DatabaseConnection, id: string, at: string): void {
  const run = getQaRun(database, id)
  if (!run) return invalid('QA_NOT_FOUND')
  if (!run.accountsSealedAt) write(database, { ...run, accountsSealedAt: at })
}
export function uncertainQaStart(database: DatabaseConnection, id: string): QaRun {
  const run = getQaRun(database, id)
  if (!run) return invalid('QA_NOT_FOUND')
  return run.state === 'preparing' ? write(database, { ...run, failure: 'QA_START_UNCERTAIN: retain this identity; recovery never relaunches' }) : run
}
function write(database: DatabaseConnection, run: QaRun): QaRun {
  database.prepare('UPDATE qa_run SET record_json = ?, session_id = ? WHERE qa_id = ?')
    .run(JSON.stringify(run), run.sessionId, run.id)
  return getQaRun(database, run.id)!
}

/** Reserving before contacting main makes uncertainty retain this identity, never a second pane. */
export function reserveQaRun(database: DatabaseConnection, run: QaRun): { created: boolean; run: QaRun } {
  return database.transaction(() => {
    const previous = read(database.prepare('SELECT record_json FROM qa_run WHERE caller_session_id = ? AND operation_key = ?')
      .get(run.callerSessionId, run.key))
    if (previous) {
      if (previous.inputSha256 !== run.inputSha256) invalid('QA_KEY_CONFLICT: the key already names a different brief')
      return { created: false, run: previous }
    }
    const caller = selectSession(database, run.callerSessionId)
    if (caller.archivedAt !== null || caller.workspaceId !== run.workspaceId) invalid('QA_CALLER_INVALID: a workspace session is required')
    database.prepare('INSERT INTO qa_run(qa_id, caller_session_id, operation_key, session_id, record_json) VALUES (?, ?, ?, NULL, ?)')
      .run(run.id, run.callerSessionId, run.key, JSON.stringify(run))
    return { created: true, run: getQaRun(database, run.id)! }
  })()
}

export function bindQaRun(database: DatabaseConnection, id: string, sessionId: string, incarnationId: string): QaRun {
  const run = getQaRun(database, id)
  if (!run) return invalid('QA_NOT_FOUND')
  if (run.sessionId !== null) {
    if (run.sessionId !== sessionId || run.incarnationId !== incarnationId) invalid('QA_BINDING_CONFLICT')
    return run
  }
  if (run.state !== 'preparing') invalid('QA_NOT_STARTING')
  const session = selectSession(database, sessionId)
  if (session.workspaceId !== run.workspaceId || session.cwd !== run.folder || !session.argv.includes(run.id)) invalid('QA_BINDING_INVALID')
  return write(database, { ...run, sessionId, incarnationId, state: 'running' })
}

export function qaRunForSession(database: DatabaseConnection, sessionId: string, incarnationId: string): QaRun | null {
  const run = read(database.prepare('SELECT record_json FROM qa_run WHERE session_id = ?').get(sessionId))
  return run?.incarnationId === incarnationId && run.state === 'running' ? run : null
}

/** Restrictions begin before main binds the incarnation and remain on a retained QA pane. */
export function isQaSession(database: DatabaseConnection, sessionId: string): boolean {
  if (database.prepare('SELECT qa_id FROM qa_run WHERE session_id = ?').get(sessionId)) return true
  let session
  try { session = selectSession(database, sessionId) } catch { return false }
  return database.prepare('SELECT record_json FROM qa_run WHERE session_id IS NULL').all().some(row => {
    const run = read(row)!
    return run.state === 'preparing' && run.folder === session.cwd && session.argv.includes('--run') && session.argv.includes(run.id)
  })
}

/** The coordinator validates the runner's direct child against the prepared command before this write. */
export function bindQaAgent(database: DatabaseConnection, id: string, agent: NonNullable<QaRun['agent']>): QaRun {
  const run = getQaRun(database, id)
  if (!run || run.state !== 'running') return invalid('QA_NOT_RUNNING')
  if (run.agent) {
    if (run.agent.pid !== agent.pid || run.agent.ticks !== agent.ticks) return invalid('QA_AGENT_BINDING_CONFLICT')
    return run
  }
  return write(database, { ...run, agent })
}

export function connectQaRelay(database: DatabaseConnection, id: string, connection: NonNullable<QaRun['connection']>): QaRun {
  const run = getQaRun(database, id)
  if (!run || run.state !== 'running') return invalid('QA_NOT_RUNNING')
  const counted = write(database, { ...run, relayConnectAttempts: (run.relayConnectAttempts ?? 0) + 1 })
  if (run.connection) {
    if (run.connection.pid !== connection.pid || run.connection.ticks !== connection.ticks) return invalid('QA_RELAY_ALREADY_CONNECTED')
    return counted
  }
  return write(database, { ...counted, connection })
}

export function finishQaRun(database: DatabaseConnection, id: string, outcome: Pick<QaRun, 'state' | 'failure' | 'result'>): QaRun {
  const run = getQaRun(database, id)
  if (!run) return invalid('QA_NOT_FOUND')
  if (['finished', 'failed', 'stopped'].includes(run.state)) return run
  if (!['finished', 'failed', 'stopped'].includes(outcome.state)) invalid('QA_OUTCOME_INVALID')
  return write(database, { ...run, ...outcome })
}

/** Restart never launches. Recover a pane created just before the response was lost, or keep failure. */
export function recoverQaRuns(database: DatabaseConnection): QaRun[] {
  const runs = database.prepare('SELECT record_json FROM qa_run').all().map(row => read(row)!)
  for (const run of runs) {
    if (run.state !== 'preparing') continue
    const candidates = database.prepare('SELECT session_id FROM session WHERE cwd = ?').all(run.folder) as { session_id: string }[]
    const matches = candidates.map(row => selectSession(database, row.session_id)).filter(row => row.argv.includes(run.id))
    if (matches.length === 1 && matches[0]!.lastProcess) {
      bindQaRun(database, run.id, matches[0]!.sessionId, matches[0]!.lastProcess!.incarnationId)
    } else finishQaRun(database, run.id, { state: 'failed', failure: 'QA_START_INTERRUPTED: no unique pane was recovered; no second pane was launched', result: null })
  }
  return runs.map(run => getQaRun(database, run.id)!)
}

export const QA_OPERATIONS = Object.freeze({ getQaRun, reserveQaRun, bindQaRun, qaRunForSession, connectQaRelay, finishQaRun, recoverQaRuns, uncertainQaStart, isQaSession, bindQaAgent })
