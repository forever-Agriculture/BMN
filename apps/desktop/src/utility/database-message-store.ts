// MODULE: database-message-store.ts - messages sessions of one workspace leave each other, and handoffs between any two: peers, limits, pauses that lift by themselves, the one claim (Epic 66, Stories 75.4, 75.5)
import {
  ERROR_CODES,
  SESSION_MESSAGE_EXPIRY_MS,
  SESSION_MESSAGE_HOUR_MS,
  SESSION_MESSAGE_LIST_LIMIT,
  SESSION_MESSAGE_MAX_WAITING,
  SESSION_MESSAGE_NOT_A_PEER,
  SESSION_MESSAGE_PAIR_HOURLY,
  SESSION_MESSAGE_SEND_GAP_MS,
  SESSION_MESSAGE_WORKSPACE_HOURLY,
  SESSION_MESSAGES_OFF,
  SESSION_MESSAGES_PAUSED,
  isSessionMessageState,
  type SessionMessageListing,
  type SessionMessageListRow,
  type SessionMessageRecord
} from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'
import { WorkspaceStoreError } from './database-workspace-store'

interface MessageRow {
  message_id: string
  workspace_id: string
  sender_session_id: string
  receiver_session_id: string
  sender_root: string
  stamp: string
  text: string
  sent_at: string
  expires_at: string
  state: string
  claimed_app: string | null
  kind: 'message' | 'handoff'
}

interface MemberRow {
  session_id: string
  name: string
  workspace_id: string
  archived_at: string | null
  workspace_name: string
  workspace_archived_at: string | null
  session_messages_paused_at: string | null
  session_messages_counted_from: string | null
}

/**
 * Story 75.5: the delivery record of a handoff names its message by this key. Every other message has none, so a
 * message is a handoff by its record, never by what its text says.
 */
export const HANDOFF_MESSAGE_KEY = 'handoff-message:'

/** Whether the message row under `alias` is a handoff. */
function isHandoff(alias: string): string {
  return `EXISTS (SELECT 1 FROM input_draft d WHERE d.origin_key = '${HANDOFF_MESSAGE_KEY}' || ${alias}.message_id)`
}

const MESSAGE_COLUMNS = `m.message_id, m.workspace_id, m.sender_session_id, m.receiver_session_id, m.sender_root, m.stamp, m.text,
  m.sent_at, m.expires_at, m.state, m.claimed_app, CASE WHEN ${isHandoff('m')} THEN 'handoff' ELSE 'message' END AS kind`

function refuse(message: string): never {
  throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, message)
}

function messageRecord(row: MessageRow): SessionMessageRecord {
  if (!isSessionMessageState(row.state)) throw new WorkspaceStoreError(ERROR_CODES.ioError, 'A stored message is invalid')
  return {
    messageId: row.message_id, kind: row.kind, workspaceId: row.workspace_id, senderSessionId: row.sender_session_id,
    receiverSessionId: row.receiver_session_id, senderRoot: row.sender_root, stamp: row.stamp, text: row.text,
    sentAt: row.sent_at, expiresAt: row.expires_at, state: row.state, claimedApp: row.claimed_app
  }
}

/** A session with what decides whether it can take part: its workspace, both archive marks, the pause. */
function member(database: DatabaseConnection, sessionId: string): MemberRow | undefined {
  return database.prepare(
    `SELECT s.session_id, s.name, s.workspace_id, s.archived_at,
            w.name AS workspace_name, w.archived_at AS workspace_archived_at,
            w.session_messages_paused_at, w.session_messages_counted_from
     FROM session s JOIN workspace w ON w.workspace_id = s.workspace_id
     WHERE s.session_id = ?`
  ).get(sessionId) as MemberRow | undefined
}

/** A pair is stored once, whichever of the two sent: the smaller id first. */
function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function pairRow(
  database: DatabaseConnection, workspaceId: string, a: string, b: string
): { paused_at: string | null; counted_from: string | null } | undefined {
  const [first, second] = ordered(a, b)
  return database.prepare(
    `SELECT paused_at, counted_from FROM session_message_pair
     WHERE workspace_id = ? AND first_session_id = ? AND second_session_id = ?`
  ).get(workspaceId, first, second) as { paused_at: string | null; counted_from: string | null } | undefined
}

export interface MessagePeers {
  /** False unless the caller is an unarchived session of an unarchived workspace: messages are on in every one. */
  on: boolean
  /** True while the hourly limit holds the caller's workspace. */
  paused: boolean
  peers: Array<{ sessionId: string; name: string }>
}

/**
 * Messages a workspace sent since `since`, or those two sessions sent each other in any workspace, oldest first: a
 * handoff between two workspaces is stored under its sender's, and the pair's hour counts both ways (Story 75.5).
 */
function sentSince(database: DatabaseConnection, workspaceId: string, since: string, pair?: [string, string]): string[] {
  const rows = (pair === undefined
    ? database.prepare('SELECT sent_at FROM session_message WHERE workspace_id = ? AND sent_at > ? ORDER BY sent_at')
      .all(workspaceId, since)
    : database.prepare(
        `SELECT sent_at FROM session_message
         WHERE sent_at > ?
           AND ((sender_session_id = ? AND receiver_session_id = ?) OR (sender_session_id = ? AND receiver_session_id = ?))
         ORDER BY sent_at`
      ).all(since, pair[0], pair[1], pair[1], pair[0])) as Array<{ sent_at: string }>
  return rows.map((row) => row.sent_at)
}

/** When enough of these messages have left the last hour for the count to be under `limit`: then a send is allowed. */
function allowedAgainAt(sent: readonly string[], limit: number, now: string): string {
  const leaving = sent[sent.length - limit]
  return leaving === undefined ? now : new Date(Date.parse(leaving) + SESSION_MESSAGE_HOUR_MS).toISOString()
}

/**
 * Story 75.4: a pause the hourly limit made lifts by itself once the rolling count is under the limit again, for
 * the workspace and for each of its pairs. The counting history is left as it is and no refused send comes back:
 * a refused send was never stored. Asked before anything that a pause decides.
 */
function liftLimitPauses(database: DatabaseConnection, workspaceId: string, now: string): void {
  const workspace = database.prepare(
    'SELECT session_messages_paused_at AS at, session_messages_counted_from AS counted FROM workspace WHERE workspace_id = ?'
  ).get(workspaceId) as { at: string | null; counted: string | null } | undefined
  if (workspace?.at != null &&
    sentSince(database, workspaceId, countedSince(now, workspace.counted)).length < SESSION_MESSAGE_WORKSPACE_HOURLY) {
    database.prepare(
      'UPDATE workspace SET session_messages_paused_at = NULL, session_messages_paused_by = NULL WHERE workspace_id = ?'
    ).run(workspaceId)
  }
  const pairs = database.prepare(
    `SELECT first_session_id, second_session_id, counted_from FROM session_message_pair
     WHERE workspace_id = ? AND paused_at IS NOT NULL`
  ).all(workspaceId) as Array<{ first_session_id: string; second_session_id: string; counted_from: string | null }>
  for (const pair of pairs) {
    const sent = sentSince(database, workspaceId, countedSince(now, pair.counted_from), [pair.first_session_id, pair.second_session_id])
    if (sent.length >= SESSION_MESSAGE_PAIR_HOURLY) continue
    database.prepare(
      `UPDATE session_message_pair SET paused_at = NULL
       WHERE workspace_id = ? AND first_session_id = ? AND second_session_id = ?`
    ).run(workspaceId, pair.first_session_id, pair.second_session_id)
  }
}

/**
 * Who the caller may message: every other unarchived session of its own workspace that is not paused with the
 * caller. Nothing about a peer's activity is read here; what runs in a peer's terminal is the host's question.
 */
export function messagePeers(database: DatabaseConnection, callerSessionId: string, now: string): MessagePeers {
  const caller = member(database, callerSessionId)
  if (!caller || caller.archived_at !== null || caller.workspace_archived_at !== null) {
    return { on: false, paused: false, peers: [] }
  }
  liftLimitPauses(database, caller.workspace_id, now)
  const paused = (member(database, callerSessionId)?.session_messages_paused_at ?? null) !== null
  const rows = database.prepare(
    `SELECT session_id, name FROM session
     WHERE workspace_id = ? AND archived_at IS NULL AND session_id <> ?
     ORDER BY position, created_at, session_id`
  ).all(caller.workspace_id, callerSessionId) as Array<{ session_id: string; name: string }>
  return {
    on: true,
    paused,
    peers: rows
      .filter((row) => (pairRow(database, caller.workspace_id, callerSessionId, row.session_id)?.paused_at ?? null) === null)
      .map((row) => ({ sessionId: row.session_id, name: row.name }))
  }
}

export function getSessionMessage(database: DatabaseConnection, messageId: string): SessionMessageRecord {
  const row = database.prepare(`SELECT ${MESSAGE_COLUMNS} FROM session_message m WHERE m.message_id = ?`).get(messageId) as MessageRow | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The message was not found')
  return messageRecord(row)
}

/** The later of an hour ago and the last owner's Resume, from before Story 75.4: where an hourly count starts. */
function countedSince(now: string, countedFrom: string | null): string {
  const hourAgo = new Date(Date.parse(now) - SESSION_MESSAGE_HOUR_MS).toISOString()
  return countedFrom !== null && countedFrom > hourAgo ? countedFrom : hourAgo
}

export type SendOutcome =
  | { accepted: true; messageId: string; state: 'waiting' }
  /** The send that went one past an hourly limit: it stored a pause, so it is an answer and not a thrown refusal. */
  | {
      accepted: false
      paused: 'pair' | 'workspace'
      reason: string
      senderName: string
      receiverName: string
      workspaceName: string
    }

/**
 * One transaction decides and stores a message: the caller must be able to see the receiver in `bmn peers`
 * (one wording for every other case), the receiver must run an agent whose hook takes messages (the host's
 * `receiverRefusal`, asked only after that), the limits must hold, and the row carries the workspace the sender
 * is in at this moment. A refusal stores nothing, except the send one past an hourly limit, which stores the pause
 * it caused and says so. Only messages still waiting and unexpired count as waiting: an expired one is delivered
 * by no route and holds nobody back.
 */
export function sendSessionMessage(database: DatabaseConnection, p: {
  messageId: string
  senderSessionId: string
  receiverSessionId: string
  senderRoot: string
  stamp: string
  text: string
  /** Why the receiver cannot take a message now (Story 75.4), or null: what runs in its terminal is the host's to say. */
  receiverRefusal: string | null
}, now: string): SendOutcome {
  const peers = messagePeers(database, p.senderSessionId, now)
  if (!peers.on) refuse(SESSION_MESSAGES_OFF)
  const receiver = peers.peers.find((peer) => peer.sessionId === p.receiverSessionId)
  if (!receiver) refuse(SESSION_MESSAGE_NOT_A_PEER)
  if (p.receiverRefusal !== null) refuse(p.receiverRefusal)
  if (peers.paused) refuse(SESSION_MESSAGES_PAUSED)
  const sender = member(database, p.senderSessionId)!
  const paused = limitOutcome(database, sender, p.receiverSessionId, receiver.name, now)
  if (paused !== null) return paused
  insertMessage(database, { ...p, workspaceId: sender.workspace_id }, now)
  return { accepted: true, messageId: p.messageId, state: 'waiting' }
}

/**
 * Story 75.5: a handoff travels as a message, under the same limits, counted in the workspace its sender is in.
 * Unlike a message it may go to a session of another workspace, through this path only: `bmn tell` still reaches
 * peers alone. Both sessions and their workspaces must be unarchived, and the receiver must run an agent that takes
 * messages. The delivery record and the stored file are the caller's, in the same transaction.
 */
export function admitHandoff(database: DatabaseConnection, p: {
  messageId: string
  senderSessionId: string
  receiverSessionId: string
  senderRoot: string
  stamp: string
  text: string
  receiverRefusal: string | null
}, now: string): SendOutcome {
  const unavailable = (session: MemberRow | undefined): boolean =>
    !session || session.archived_at !== null || session.workspace_archived_at !== null
  let sender = member(database, p.senderSessionId)
  if (unavailable(sender)) refuse('The handoff source session is unavailable')
  const receiver = member(database, p.receiverSessionId)
  if (p.receiverSessionId === p.senderSessionId || unavailable(receiver)) refuse('The handoff destination is unavailable; choose it again')
  if (p.receiverRefusal !== null) refuse(p.receiverRefusal)
  liftLimitPauses(database, sender!.workspace_id, now)
  sender = member(database, p.senderSessionId)!
  if (sender.session_messages_paused_at !== null) refuse(SESSION_MESSAGES_PAUSED)
  if ((pairRow(database, sender.workspace_id, p.senderSessionId, p.receiverSessionId)?.paused_at ?? null) !== null) {
    refuse('Messages and handoffs between you and that session are paused by the hourly limit; they are allowed again when the count falls')
  }
  const paused = limitOutcome(database, sender, p.receiverSessionId, receiver!.name, now)
  if (paused !== null) return paused
  insertMessage(database, { ...p, workspaceId: sender.workspace_id }, now)
  return { accepted: true, messageId: p.messageId, state: 'waiting' }
}

/**
 * The limits every send meets, refused in their own words: one waiting per pair, the gap between one session's
 * sends, and the receiver's queue. The send one past an hourly limit stores the pause it caused and is answered
 * with it; null lets the send through.
 */
function limitOutcome(
  database: DatabaseConnection, sender: MemberRow, receiverSessionId: string, receiverName: string, now: string
): SendOutcome | null {
  const p = { senderSessionId: sender.session_id, receiverSessionId }
  const waiting = database.prepare(
    `SELECT COUNT(*) AS count FROM session_message
     WHERE sender_session_id = ? AND receiver_session_id = ? AND state = 'waiting' AND expires_at > ?`
  ).get(p.senderSessionId, p.receiverSessionId, now) as { count: number }
  if (waiting.count > 0) refuse('Your earlier message to that session is still waiting; one at a time')
  const last = database.prepare(
    'SELECT sent_at FROM session_message WHERE sender_session_id = ? ORDER BY sent_at DESC LIMIT 1'
  ).get(p.senderSessionId) as { sent_at: string } | undefined
  if (last && Date.parse(now) - Date.parse(last.sent_at) < SESSION_MESSAGE_SEND_GAP_MS) {
    refuse(`Wait ${SESSION_MESSAGE_SEND_GAP_MS / 1000} seconds between messages`)
  }
  const queued = database.prepare(
    "SELECT COUNT(*) AS count FROM session_message WHERE receiver_session_id = ? AND state = 'waiting' AND expires_at > ?"
  ).get(p.receiverSessionId, now) as { count: number }
  if (queued.count >= SESSION_MESSAGE_MAX_WAITING) {
    refuse(`That session already has ${SESSION_MESSAGE_MAX_WAITING} messages waiting; try again later`)
  }
  const [first, second] = ordered(p.senderSessionId, p.receiverSessionId)
  const pair = pairRow(database, sender.workspace_id, first, second)
  const between = sentSince(database, sender.workspace_id, countedSince(now, pair?.counted_from ?? null), [first, second]).length
  const names = { senderName: sender.name, receiverName, workspaceName: sender.workspace_name }
  if (between >= SESSION_MESSAGE_PAIR_HOURLY) {
    database.prepare(
      `INSERT INTO session_message_pair(workspace_id, first_session_id, second_session_id, paused_at, counted_from)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(workspace_id, first_session_id, second_session_id) DO UPDATE SET paused_at = excluded.paused_at`
    ).run(sender.workspace_id, first, second, now)
    return {
      accepted: false, paused: 'pair', ...names,
      reason: `You and that session exchanged ${SESSION_MESSAGE_PAIR_HOURLY} messages in an hour; messages between you are paused, and allowed again when the count falls`
    }
  }
  const inWorkspace = sentSince(database, sender.workspace_id, countedSince(now, sender.session_messages_counted_from)).length
  if (inWorkspace >= SESSION_MESSAGE_WORKSPACE_HOURLY) {
    database.prepare(
      "UPDATE workspace SET session_messages_paused_at = ?, session_messages_paused_by = 'limit' WHERE workspace_id = ?"
    ).run(now, sender.workspace_id)
    return {
      accepted: false, paused: 'workspace', ...names,
      reason: `Sessions in this workspace exchanged ${SESSION_MESSAGE_WORKSPACE_HOURLY} messages in an hour; messages here are paused, and allowed again when the count falls`
    }
  }
  return null
}

function insertMessage(database: DatabaseConnection, p: {
  messageId: string
  workspaceId: string
  senderSessionId: string
  receiverSessionId: string
  senderRoot: string
  stamp: string
  text: string
}, now: string): void {
  database.prepare(
    `INSERT INTO session_message(message_id, workspace_id, sender_session_id, receiver_session_id, sender_root, stamp, text,
       sent_at, expires_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`
  ).run(
    p.messageId, p.workspaceId, p.senderSessionId, p.receiverSessionId, p.senderRoot, p.stamp, p.text,
    now, new Date(Date.parse(now) + SESSION_MESSAGE_EXPIRY_MS).toISOString()
  )
}

/**
 * The sender's own messages, newest first: where each went and where it stands. Nothing of the receiver's
 * activity. A handoff is listed by `bmn handoff status`, not here (Story 75.5).
 */
export function listSentMessages(
  database: DatabaseConnection, senderSessionId: string, messageId: string | null
): Array<Pick<SessionMessageRecord, 'messageId' | 'receiverSessionId' | 'state' | 'sentAt' | 'expiresAt'>> {
  const rows = (messageId === null
    ? database.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message m WHERE m.sender_session_id = ? AND NOT ${isHandoff('m')}
         ORDER BY m.sent_at DESC, m.rowid DESC LIMIT 50`
      ).all(senderSessionId)
    : database.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message m WHERE m.sender_session_id = ? AND m.message_id = ? AND NOT ${isHandoff('m')}`
      ).all(senderSessionId, messageId)) as MessageRow[]
  return rows.map(messageRecord).map((record) => ({
    messageId: record.messageId, receiverSessionId: record.receiverSessionId, state: record.state,
    sentAt: record.sentAt, expiresAt: record.expiresAt
  }))
}

/**
 * Whether both sessions of a message are still unarchived members of the workspace it was sent in. A handoff's
 * receiver may be in any unarchived workspace (Story 75.5).
 */
function stillMembers(database: DatabaseConnection, row: MessageRow): boolean {
  const sender = member(database, row.sender_session_id)
  const receiver = member(database, row.receiver_session_id)
  return !!sender && sender.archived_at === null && sender.workspace_id === row.workspace_id &&
    !!receiver && receiver.archived_at === null &&
    (row.kind === 'handoff' ? receiver.workspace_archived_at === null : receiver.workspace_id === row.workspace_id)
}

/**
 * The owner's view of one workspace: its latest messages, newest first, whatever became of their sessions
 * since, and what the hourly limit holds there now, with when it lets go. A handoff to one of its sessions from
 * another workspace is listed here too (Story 75.5).
 */
export function listWorkspaceMessages(database: DatabaseConnection, workspaceId: string, now: string): SessionMessageListing {
  liftLimitPauses(database, workspaceId, now)
  const workspace = database.prepare(
    'SELECT session_messages_paused_at AS at, session_messages_counted_from AS counted FROM workspace WHERE workspace_id = ?'
  ).get(workspaceId) as { at: string | null; counted: string | null } | undefined
  if (!workspace) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The workspace was not found')
  const rows = database.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM session_message m
     WHERE m.workspace_id = ?
        OR (m.receiver_session_id IN (SELECT session_id FROM session WHERE workspace_id = ?) AND ${isHandoff('m')})
     ORDER BY m.sent_at DESC, m.rowid DESC LIMIT ?`
  ).all(workspaceId, workspaceId, SESSION_MESSAGE_LIST_LIMIT) as MessageRow[]
  const name = database.prepare('SELECT name FROM session WHERE session_id = ?')
  const named = (sessionId: string): string => (name.get(sessionId) as { name: string } | undefined)?.name ?? sessionId
  const messages: SessionMessageListRow[] = rows.map((row) => ({
    ...messageRecord(row),
    senderName: named(row.sender_session_id),
    receiverName: named(row.receiver_session_id),
    membersPresent: stillMembers(database, row),
    // Why a hook was not handed a message names a provider of the owner's team: the host keeps that in memory, never here.
    detail: null
  }))
  const pairs = database.prepare(
    `SELECT first_session_id, second_session_id, paused_at, counted_from FROM session_message_pair
     WHERE workspace_id = ? AND paused_at IS NOT NULL ORDER BY paused_at, first_session_id, second_session_id`
  ).all(workspaceId) as Array<{ first_session_id: string; second_session_id: string; paused_at: string; counted_from: string | null }>
  return {
    messages,
    workspacePause: workspace.at === null ? null : {
      at: workspace.at,
      until: allowedAgainAt(sentSince(database, workspaceId, countedSince(now, workspace.counted)), SESSION_MESSAGE_WORKSPACE_HOURLY, now)
    },
    pairPauses: pairs.map((pair) => ({
      firstSessionId: pair.first_session_id, firstName: named(pair.first_session_id),
      secondSessionId: pair.second_session_id, secondName: named(pair.second_session_id), pausedAt: pair.paused_at,
      until: allowedAgainAt(sentSince(database, workspaceId, countedSince(now, pair.counted_from),
        [pair.first_session_id, pair.second_session_id]), SESSION_MESSAGE_PAIR_HOURLY, now)
    }))
  }
}

/**
 * What a hook may be handed, as far as the store can tell: waiting, unexpired, both sessions still unarchived
 * members of the message's unarchived workspace (a handoff's receiver: of any unarchived workspace), and neither
 * the workspace nor the pair paused by the hourly limit, as it stands once lifted pauses are gone. Whether the
 * receiving agent's provider may see the sender's work, and every attached file's, is the host's question, asked
 * per message before the claim.
 */
const HOOK_ELIGIBLE = `m.state = 'waiting' AND m.expires_at > ? AND m.receiver_session_id = ?
  AND w.archived_at IS NULL AND w.session_messages_paused_at IS NULL
  AND r.archived_at IS NULL AND rw.archived_at IS NULL AND (r.workspace_id = m.workspace_id OR ${isHandoff('m')})
  AND s.archived_at IS NULL AND s.workspace_id = m.workspace_id
  AND NOT EXISTS (
    SELECT 1 FROM session_message_pair p
    WHERE p.workspace_id = m.workspace_id AND p.paused_at IS NOT NULL
      AND p.first_session_id = MIN(m.sender_session_id, m.receiver_session_id)
      AND p.second_session_id = MAX(m.sender_session_id, m.receiver_session_id))`

const HOOK_FROM = `session_message m
  JOIN workspace w ON w.workspace_id = m.workspace_id
  JOIN session r ON r.session_id = m.receiver_session_id
  JOIN workspace rw ON rw.workspace_id = r.workspace_id
  JOIN session s ON s.session_id = m.sender_session_id`

/** A file attached to a handoff, as the take path checks where it came from; a null source fails closed. */
export interface HandoffAttachmentSource {
  artifactId: string
  name: string
  sourcePath: string | null
}

export interface MessageTakeCandidate {
  messageId: string
  senderRoot: string
  /** Story 75.5: a handoff's attached files, each of whose folders the provider must be allowed to see too. */
  attachments: HandoffAttachmentSource[]
}

/** The receiver's messages a hook may be handed, oldest first, with the root each sender's work lies in. */
export function messageTakeCandidates(
  database: DatabaseConnection, receiverSessionId: string, now: string
): MessageTakeCandidate[] {
  liftReceiverPauses(database, receiverSessionId, now)
  const rows = database.prepare(
    `SELECT m.message_id, m.sender_root FROM ${HOOK_FROM} WHERE ${HOOK_ELIGIBLE} ORDER BY m.sent_at, m.rowid`
  ).all(now, receiverSessionId) as Array<{ message_id: string; sender_root: string }>
  const attached = database.prepare(
    `SELECT e.value AS artifact_id, a.original_name, a.source_path
     FROM input_draft d, json_each(d.artifact_ids_json) e LEFT JOIN artifact a ON a.artifact_id = e.value
     WHERE d.origin_key = ? AND json_valid(d.artifact_ids_json) ORDER BY e.key`
  )
  return rows.map((row) => ({
    messageId: row.message_id,
    senderRoot: row.sender_root,
    attachments: (attached.all(`${HANDOFF_MESSAGE_KEY}${row.message_id}`) as Array<{
      artifact_id: string; original_name: string | null; source_path: string | null
    }>).map((file) => ({ artifactId: file.artifact_id, name: file.original_name ?? file.artifact_id, sourcePath: file.source_path }))
  }))
}

/**
 * The hourly limit's pauses that decide what this receiver may be handed, lifted where the count fell: its own
 * workspace's, and those of the workspaces its waiting messages were sent in (a handoff's may be another).
 */
function liftReceiverPauses(database: DatabaseConnection, receiverSessionId: string, now: string): void {
  const receiver = member(database, receiverSessionId)
  const workspaces = new Set((database.prepare(
    "SELECT DISTINCT workspace_id FROM session_message WHERE receiver_session_id = ? AND state = 'waiting'"
  ).all(receiverSessionId) as Array<{ workspace_id: string }>).map((row) => row.workspace_id))
  if (receiver) workspaces.add(receiver.workspace_id)
  for (const workspaceId of workspaces) liftLimitPauses(database, workspaceId, now)
}

/**
 * The hook's claim in one step: the conditions are read again inside this transaction and the row leaves
 * `waiting` only if it is still there. From here the message reads "taken, not confirmed" and no route offers it
 * again by itself, whatever becomes of the answer.
 */
export function claimMessageForHook(database: DatabaseConnection, p: {
  messageId: string
  receiverSessionId: string
  incarnationId: string
  pid: number
  app: string
  claimId: string
}, now: string): { claimed: boolean; record: SessionMessageRecord | null } {
  liftReceiverPauses(database, p.receiverSessionId, now)
  const eligible = database.prepare(
    `SELECT m.message_id FROM ${HOOK_FROM} WHERE ${HOOK_ELIGIBLE} AND m.message_id = ?`
  ).get(now, p.receiverSessionId, p.messageId)
  if (!eligible) return { claimed: false, record: null }
  const updated = database.prepare(
    `UPDATE session_message
     SET state = 'taken', claim_id = ?, claimed_incarnation_id = ?, claimed_pid = ?, claimed_app = ?, claimed_at = ?
     WHERE message_id = ? AND state = 'waiting'`
  ).run(p.claimId, p.incarnationId, p.pid, p.app, now, p.messageId)
  if (Number(updated.changes) !== 1) return { claimed: false, record: null }
  return { claimed: true, record: getSessionMessage(database, p.messageId) }
}

/**
 * Gives back a hook's claim for which nothing was printed: the message waits again, as it did. Only the claim's
 * own id does it, and the take that made the claim is the only one that knows it until BMN has answered.
 */
export function releaseMessageClaim(database: DatabaseConnection, p: { messageId: string; claimId: string }): { released: boolean } {
  const updated = database.prepare(
    `UPDATE session_message
     SET state = 'waiting', claim_id = NULL, claimed_incarnation_id = NULL, claimed_pid = NULL, claimed_app = NULL, claimed_at = NULL
     WHERE message_id = ? AND state = 'taken' AND claim_id = ?`
  ).run(p.messageId, p.claimId)
  return { released: Number(updated.changes) === 1 }
}

/**
 * The hook's word that it printed what it took. Accepted only with the claim's own id, from the session and
 * process that claimed; it means printed, never read.
 */
export function reportMessagePrinted(database: DatabaseConnection, p: {
  messageId: string
  claimId: string
  receiverSessionId: string
  incarnationId: string
  pid: number
}): { recorded: boolean } {
  const updated = database.prepare(
    `UPDATE session_message SET state = 'printed'
     WHERE message_id = ? AND state = 'taken' AND claim_id = ? AND receiver_session_id = ?
       AND claimed_incarnation_id = ? AND claimed_pid = ?`
  ).run(p.messageId, p.claimId, p.receiverSessionId, p.incarnationId, p.pid)
  return { recorded: Number(updated.changes) === 1 }
}

/**
 * Deletes messages sent before `cutoff`, whatever their state, and returns how many went. A handoff's delivery
 * record goes with its message (Story 75.5); its stored files stay with the session that sent it.
 */
export function deleteMessagesSentBefore(database: DatabaseConnection, cutoff: string): number {
  database.prepare(
    `DELETE FROM input_draft WHERE origin_key IN (
       SELECT '${HANDOFF_MESSAGE_KEY}' || message_id FROM session_message WHERE sent_at < ?)`
  ).run(cutoff)
  return Number(database.prepare('DELETE FROM session_message WHERE sent_at < ?').run(cutoff).changes)
}

/** Store functions for messages; the worker runs each in one transaction, beside the companion operations. */
export const MESSAGE_OPERATIONS = Object.freeze({
  messagePeers,
  getSessionMessage,
  sendSessionMessage,
  admitHandoff,
  listSentMessages,
  listWorkspaceMessages,
  messageTakeCandidates,
  claimMessageForHook,
  releaseMessageClaim,
  reportMessagePrinted,
  deleteMessagesSentBefore
})
