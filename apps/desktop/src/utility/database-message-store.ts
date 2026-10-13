// MODULE: database-message-store.ts - messages sessions of one workspace leave each other: peers, limits, pauses, the one claim (Epic 66)
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
}

interface MemberRow {
  session_id: string
  name: string
  workspace_id: string
  archived_at: string | null
  receive_messages: number
  workspace_name: string
  workspace_archived_at: string | null
  session_messages: number
  session_messages_paused_at: string | null
  session_messages_counted_from: string | null
}

const MESSAGE_COLUMNS = `message_id, workspace_id, sender_session_id, receiver_session_id, sender_root, stamp, text,
  sent_at, expires_at, state, claimed_app`

function refuse(message: string): never {
  throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, message)
}

function messageRecord(row: MessageRow): SessionMessageRecord {
  if (!isSessionMessageState(row.state)) throw new WorkspaceStoreError(ERROR_CODES.ioError, 'A stored message is invalid')
  return {
    messageId: row.message_id, workspaceId: row.workspace_id, senderSessionId: row.sender_session_id,
    receiverSessionId: row.receiver_session_id, senderRoot: row.sender_root, stamp: row.stamp, text: row.text,
    sentAt: row.sent_at, expiresAt: row.expires_at, state: row.state, claimedApp: row.claimed_app
  }
}

/** A session with what decides whether it can take part: its workspace, both archive marks, both switches, the pause. */
function member(database: DatabaseConnection, sessionId: string): MemberRow | undefined {
  return database.prepare(
    `SELECT s.session_id, s.name, s.workspace_id, s.archived_at, s.receive_messages,
            w.name AS workspace_name, w.archived_at AS workspace_archived_at, w.session_messages,
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
  /** False while the caller's workspace has messages off, or the caller is not an open session of an open workspace. */
  on: boolean
  /** True while the owner, or the hourly limit, has paused the caller's workspace. */
  paused: boolean
  peers: Array<{ sessionId: string; name: string }>
}

/**
 * Who the caller may message: every other unarchived session of its own workspace that has "Receive messages"
 * on and is not paused with the caller, and nobody while the workspace's switch is off. Nothing about a peer's
 * activity is read here.
 */
export function messagePeers(database: DatabaseConnection, callerSessionId: string): MessagePeers {
  const caller = member(database, callerSessionId)
  if (!caller || caller.archived_at !== null || caller.workspace_archived_at !== null || caller.session_messages !== 1) {
    return { on: false, paused: false, peers: [] }
  }
  const rows = database.prepare(
    `SELECT session_id, name FROM session
     WHERE workspace_id = ? AND archived_at IS NULL AND receive_messages = 1 AND session_id <> ?
     ORDER BY position, created_at, session_id`
  ).all(caller.workspace_id, callerSessionId) as Array<{ session_id: string; name: string }>
  return {
    on: true,
    paused: caller.session_messages_paused_at !== null,
    peers: rows
      .filter((row) => (pairRow(database, caller.workspace_id, callerSessionId, row.session_id)?.paused_at ?? null) === null)
      .map((row) => ({ sessionId: row.session_id, name: row.name }))
  }
}

export function getSessionMessage(database: DatabaseConnection, messageId: string): SessionMessageRecord {
  const row = database.prepare(`SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE message_id = ?`).get(messageId) as MessageRow | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The message was not found')
  return messageRecord(row)
}

/** The later of an hour ago and the last Resume: where an hourly count starts. */
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
 * (one wording for every other case), the limits must hold, and the row carries the workspace the sender is
 * in at this moment. A refusal stores nothing, except the send one past an hourly limit, which stores the pause
 * it caused and says so. Only messages still waiting and unexpired count as waiting: an expired one waits for
 * the owner alone and holds nobody back.
 */
export function sendSessionMessage(database: DatabaseConnection, p: {
  messageId: string
  senderSessionId: string
  receiverSessionId: string
  senderRoot: string
  stamp: string
  text: string
}, now: string): SendOutcome {
  const peers = messagePeers(database, p.senderSessionId)
  if (!peers.on) refuse(SESSION_MESSAGES_OFF)
  const receiver = peers.peers.find((peer) => peer.sessionId === p.receiverSessionId)
  if (!receiver) refuse(SESSION_MESSAGE_NOT_A_PEER)
  if (peers.paused) refuse(SESSION_MESSAGES_PAUSED)
  const sender = member(database, p.senderSessionId)!
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
  const between = database.prepare(
    `SELECT COUNT(*) AS count FROM session_message
     WHERE workspace_id = ? AND sent_at > ?
       AND ((sender_session_id = ? AND receiver_session_id = ?) OR (sender_session_id = ? AND receiver_session_id = ?))`
  ).get(sender.workspace_id, countedSince(now, pair?.counted_from ?? null), first, second, second, first) as { count: number }
  const names = { senderName: sender.name, receiverName: receiver.name, workspaceName: sender.workspace_name }
  if (between.count >= SESSION_MESSAGE_PAIR_HOURLY) {
    database.prepare(
      `INSERT INTO session_message_pair(workspace_id, first_session_id, second_session_id, paused_at, counted_from)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(workspace_id, first_session_id, second_session_id) DO UPDATE SET paused_at = excluded.paused_at`
    ).run(sender.workspace_id, first, second, now)
    return {
      accepted: false, paused: 'pair', ...names,
      reason: `You and that session exchanged ${SESSION_MESSAGE_PAIR_HOURLY} messages in an hour; messages between you are paused until the owner resumes them`
    }
  }
  const inWorkspace = database.prepare(
    'SELECT COUNT(*) AS count FROM session_message WHERE workspace_id = ? AND sent_at > ?'
  ).get(sender.workspace_id, countedSince(now, sender.session_messages_counted_from)) as { count: number }
  if (inWorkspace.count >= SESSION_MESSAGE_WORKSPACE_HOURLY) {
    database.prepare(
      "UPDATE workspace SET session_messages_paused_at = ?, session_messages_paused_by = 'limit' WHERE workspace_id = ?"
    ).run(now, sender.workspace_id)
    return {
      accepted: false, paused: 'workspace', ...names,
      reason: `Sessions in this workspace exchanged ${SESSION_MESSAGE_WORKSPACE_HOURLY} messages in an hour; messages here are paused until the owner resumes them`
    }
  }
  database.prepare(
    `INSERT INTO session_message(message_id, workspace_id, sender_session_id, receiver_session_id, sender_root, stamp, text,
       sent_at, expires_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`
  ).run(
    p.messageId, sender.workspace_id, p.senderSessionId, p.receiverSessionId, p.senderRoot, p.stamp, p.text,
    now, new Date(Date.parse(now) + SESSION_MESSAGE_EXPIRY_MS).toISOString()
  )
  return { accepted: true, messageId: p.messageId, state: 'waiting' }
}

/** The sender's own messages, newest first: where each went and where it stands. Nothing of the receiver's activity. */
export function listSentMessages(
  database: DatabaseConnection, senderSessionId: string, messageId: string | null
): Array<Pick<SessionMessageRecord, 'messageId' | 'receiverSessionId' | 'state' | 'sentAt' | 'expiresAt'>> {
  const rows = (messageId === null
    ? database.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE sender_session_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 50`
      ).all(senderSessionId)
    : database.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE sender_session_id = ? AND message_id = ?`
      ).all(senderSessionId, messageId)) as MessageRow[]
  return rows.map(messageRecord).map((record) => ({
    messageId: record.messageId, receiverSessionId: record.receiverSessionId, state: record.state,
    sentAt: record.sentAt, expiresAt: record.expiresAt
  }))
}

/** Whether both sessions of a message are still unarchived members of the workspace it was sent in. */
function stillMembers(database: DatabaseConnection, row: MessageRow): boolean {
  return [row.sender_session_id, row.receiver_session_id].every((sessionId) => {
    const session = member(database, sessionId)
    return !!session && session.archived_at === null && session.workspace_id === row.workspace_id
  })
}

/**
 * The owner's view of one workspace: its latest messages, newest first, whatever became of their sessions
 * since, and what is paused there.
 */
export function listWorkspaceMessages(database: DatabaseConnection, workspaceId: string): SessionMessageListing {
  const workspace = database.prepare(
    'SELECT session_messages_paused_at AS at, session_messages_paused_by AS by FROM workspace WHERE workspace_id = ?'
  ).get(workspaceId) as { at: string | null; by: string | null } | undefined
  if (!workspace) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The workspace was not found')
  const rows = database.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE workspace_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`
  ).all(workspaceId, SESSION_MESSAGE_LIST_LIMIT) as MessageRow[]
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
    `SELECT first_session_id, second_session_id, paused_at FROM session_message_pair
     WHERE workspace_id = ? AND paused_at IS NOT NULL ORDER BY paused_at, first_session_id, second_session_id`
  ).all(workspaceId) as Array<{ first_session_id: string; second_session_id: string; paused_at: string }>
  return {
    messages,
    workspacePause: workspace.at === null ? null : { at: workspace.at, by: workspace.by === 'limit' ? 'limit' : 'owner' },
    pairPauses: pairs.map((pair) => ({
      firstSessionId: pair.first_session_id, firstName: named(pair.first_session_id),
      secondSessionId: pair.second_session_id, secondName: named(pair.second_session_id), pausedAt: pair.paused_at
    }))
  }
}

/**
 * The owner's "Pause messages" and "Resume" for a whole workspace. A pause is stored beside the switch and not
 * in it, so switching messages off and on lifts none. Resume starts the hourly count again from this moment:
 * otherwise the very next message would pause the workspace once more.
 */
export function setWorkspaceMessagePause(
  database: DatabaseConnection, workspaceId: string, paused: boolean, now: string
): SessionMessageListing {
  const updated = paused
    ? database.prepare(
        `UPDATE workspace SET session_messages_paused_at = COALESCE(session_messages_paused_at, ?),
           session_messages_paused_by = COALESCE(session_messages_paused_by, 'owner')
         WHERE workspace_id = ?`
      ).run(now, workspaceId)
    : database.prepare(
        `UPDATE workspace SET session_messages_counted_from = CASE WHEN session_messages_paused_at IS NULL
             THEN session_messages_counted_from ELSE ? END,
           session_messages_paused_at = NULL, session_messages_paused_by = NULL
         WHERE workspace_id = ?`
      ).run(now, workspaceId)
  if (Number(updated.changes) !== 1) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The workspace was not found')
  return listWorkspaceMessages(database, workspaceId)
}

/** The owner's Resume for two sessions the hourly limit paused; their count starts again from this moment. */
export function resumeMessagePair(
  database: DatabaseConnection, workspaceId: string, a: string, b: string, now: string
): SessionMessageListing {
  const [first, second] = ordered(a, b)
  database.prepare(
    `UPDATE session_message_pair SET paused_at = NULL, counted_from = ?
     WHERE workspace_id = ? AND first_session_id = ? AND second_session_id = ? AND paused_at IS NOT NULL`
  ).run(now, workspaceId, first, second)
  return listWorkspaceMessages(database, workspaceId)
}

/**
 * The owner's Paste takes the message out of `waiting` in one step: whoever changes that row first has it, so
 * two presses, or a press and a hook, cannot both deliver. A message whose sender or receiver left its
 * workspace is delivered by no route. Neither a pause nor the expiry stops the owner's own Paste. The claim
 * records the receiving process the owner was shown.
 */
export function claimMessageForPaste(
  database: DatabaseConnection, messageId: string, receiverIncarnationId: string, now: string
): { record: SessionMessageRecord; claimed: boolean } {
  const row = database.prepare(`SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE message_id = ?`).get(messageId) as MessageRow | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The message was not found')
  if (row.state !== 'waiting') return { record: messageRecord(row), claimed: false }
  if (!stillMembers(database, row)) {
    refuse('A session of this message has left the workspace it was sent in, so it is not delivered')
  }
  const updated = database.prepare(
    `UPDATE session_message SET state = 'paste-uncertain', claimed_incarnation_id = ?, claimed_at = ?
     WHERE message_id = ? AND state = 'waiting'`
  ).run(receiverIncarnationId, now, messageId)
  return { record: getSessionMessage(database, messageId), claimed: Number(updated.changes) === 1 }
}

/**
 * Ends an owner's Paste that was claimed: `pasted` once the text was written to the terminal, or back to
 * `waiting` when BMN stopped before writing anything. A claim nobody finished stays `paste-uncertain`.
 */
export function finishMessagePaste(
  database: DatabaseConnection, messageId: string, outcome: 'pasted' | 'waiting'
): SessionMessageRecord {
  const updated = database.prepare(
    `UPDATE session_message
     SET state = ?, claimed_incarnation_id = CASE WHEN ? = 'waiting' THEN NULL ELSE claimed_incarnation_id END,
         claimed_at = CASE WHEN ? = 'waiting' THEN NULL ELSE claimed_at END
     WHERE message_id = ? AND state = 'paste-uncertain'`
  ).run(outcome, outcome, outcome, messageId)
  if (Number(updated.changes) !== 1) refuse('The message has no paste in progress')
  return getSessionMessage(database, messageId)
}

/**
 * What a hook may be handed, as far as the store can tell: waiting, unexpired, both sessions still unarchived
 * members of the message's unarchived workspace, the workspace's switch and the receiver's "Receive messages"
 * on, and neither the workspace nor the pair paused. Whether the receiving agent's provider may see the
 * sender's work is the host's question, asked per message before the claim.
 */
const HOOK_ELIGIBLE = `m.state = 'waiting' AND m.expires_at > ? AND m.receiver_session_id = ?
  AND w.archived_at IS NULL AND w.session_messages = 1 AND w.session_messages_paused_at IS NULL
  AND r.archived_at IS NULL AND r.workspace_id = m.workspace_id AND r.receive_messages = 1
  AND s.archived_at IS NULL AND s.workspace_id = m.workspace_id
  AND NOT EXISTS (
    SELECT 1 FROM session_message_pair p
    WHERE p.workspace_id = m.workspace_id AND p.paused_at IS NOT NULL
      AND p.first_session_id = MIN(m.sender_session_id, m.receiver_session_id)
      AND p.second_session_id = MAX(m.sender_session_id, m.receiver_session_id))`

const HOOK_FROM = `session_message m
  JOIN workspace w ON w.workspace_id = m.workspace_id
  JOIN session r ON r.session_id = m.receiver_session_id
  JOIN session s ON s.session_id = m.sender_session_id`

/** The receiver's messages a hook may be handed, oldest first, with the root each sender's work lies in. */
export function messageTakeCandidates(
  database: DatabaseConnection, receiverSessionId: string, now: string
): Array<{ messageId: string; senderRoot: string }> {
  const rows = database.prepare(
    `SELECT m.message_id, m.sender_root FROM ${HOOK_FROM} WHERE ${HOOK_ELIGIBLE} ORDER BY m.sent_at, m.rowid`
  ).all(now, receiverSessionId) as Array<{ message_id: string; sender_root: string }>
  return rows.map((row) => ({ messageId: row.message_id, senderRoot: row.sender_root }))
}

/**
 * The hook's claim, the same one step the owner's Paste takes: the conditions are read again inside this
 * transaction and the row leaves `waiting` only if it is still there. From here the message reads "taken, not
 * confirmed" and no route offers it again by itself, whatever becomes of the answer.
 */
export function claimMessageForHook(database: DatabaseConnection, p: {
  messageId: string
  receiverSessionId: string
  incarnationId: string
  pid: number
  app: string
  claimId: string
}, now: string): { claimed: boolean; record: SessionMessageRecord | null } {
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

/** Takes back a message that was just stored, only while it still waits: one that somebody has is theirs. */
export function withdrawSessionMessage(database: DatabaseConnection, messageId: string): { withdrawn: boolean } {
  const deleted = database.prepare("DELETE FROM session_message WHERE message_id = ? AND state = 'waiting'").run(messageId)
  return { withdrawn: Number(deleted.changes) === 1 }
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

/** Deletes messages sent before `cutoff`, whatever their state, and returns how many went. */
export function deleteMessagesSentBefore(database: DatabaseConnection, cutoff: string): number {
  return Number(database.prepare('DELETE FROM session_message WHERE sent_at < ?').run(cutoff).changes)
}

/** Store functions for messages; the worker runs each in one transaction, beside the companion operations. */
export const MESSAGE_OPERATIONS = Object.freeze({
  messagePeers,
  getSessionMessage,
  sendSessionMessage,
  listSentMessages,
  listWorkspaceMessages,
  setWorkspaceMessagePause,
  resumeMessagePair,
  claimMessageForPaste,
  finishMessagePaste,
  messageTakeCandidates,
  claimMessageForHook,
  releaseMessageClaim,
  withdrawSessionMessage,
  reportMessagePrinted,
  deleteMessagesSentBefore
})
