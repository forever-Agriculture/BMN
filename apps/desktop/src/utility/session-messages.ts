// MODULE: session-messages.ts - what the host does with a message between sessions: stamp and store, the owner's Paste, the hook's take (Epic 66)
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  ERROR_CODES,
  ROSTER_APP_NAMES,
  SESSION_MESSAGE_HANDOVER,
  SESSION_MESSAGE_PAIR_HOURLY,
  SESSION_MESSAGE_WAITING_CHECK_MS,
  SESSION_MESSAGE_WORKSPACE_HOURLY,
  cleanSessionMessageName,
  cleanSessionMessageText,
  sessionMessagePayload,
  sessionMessageStamp,
  sessionMessageStateWord,
  stripFormatCharacters,
  type MessageDestination,
  type SessionMessageListing,
  type SessionMessageReceipt,
  type SessionMessageRecord,
  type SessionMessageTaken,
  type SessionPeer,
  type SessionRecord
} from '@bmn/protocol'
import type { DatabaseWorkerClient } from './database-client'
import { HostControlError } from './session-manager'

export type { MessageDestination }

export interface SessionMessagesOptions {
  database: Pick<DatabaseWorkerClient, 'companion'>
  liveIncarnationId(sessionId: string): string | null | undefined
  /** A session as the host knows it now, read afresh. */
  session(sessionId: string): Promise<SessionRecord | undefined>
  /** The agent app BMN last saw in a session (`claude`, `codex`, …), or null when it has seen none. */
  lastApp(sessionId: string): Promise<string | null>
  /** Appends text to a session's input as one bracketed paste, without Enter. */
  paste(sessionId: string, payload: string): void
  /** Opens the one notice a pause made by an hourly limit gets, on the session whose send was refused. */
  notice(p: { sessionId: string; incarnationId: string; requestKey: string; title: string; body: string }): Promise<void>
  /** Something the Messages dialog shows has changed. */
  changed(): void
  now(): Date
  /**
   * The Git root (or the folder itself) a resolved, existing folder belongs to, by the prompt guard's own rule.
   * The host does not work it out: the app's entry point answers (see `MessageTeamQuestion`).
   */
  sourceRoot(folder: string): Promise<string> | string
  /**
   * Whether the provider behind `destination` may see private work under `senderRoot`, by the approved team
   * read at this moment. Answered by the app's entry point: the host never reads the team's files. It fails
   * when the team cannot be read or the app does not answer; that is a refusal, never a pass.
   */
  providerAnswer(destination: MessageDestination, senderRoot: string): Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string }
  /** The confirmed "Keep agent history" days: a number, null for Never, undefined when none is confirmed. */
  confirmedKeepDays(): Promise<number | null | undefined>
}

const DAY_MS = 86_400_000
/** How many held-back reasons one run keeps; the oldest leave first. */
const HELD_MAX = 500

function invalid(message: string): never {
  throw new HostControlError(ERROR_CODES.invalidArgument, message)
}

function appName(app: string | null): string | null {
  return app !== null && Object.hasOwn(ROSTER_APP_NAMES, app) ? ROSTER_APP_NAMES[app as keyof typeof ROSTER_APP_NAMES] : null
}

/**
 * Messages between the sessions of one workspace. Nothing here types into a terminal except `paste`, on the
 * owner's press, and nothing here opens a request except the one notice of a pause.
 */
export class SessionMessages {
  /**
   * Why a hook was not handed a waiting message, by message id. The reason names a provider of the owner's
   * team, and nothing of the team may reach the database, a Backup export, Telegram or a log (R60-NFR3): it
   * lives here for this run only, as a prompt guard stop does, and the next refused event writes it again.
   */
  private readonly held = new Map<string, string>()

  constructor(private readonly options: SessionMessagesOptions) {}

  private hold(messageId: string, reason: string): boolean {
    if (this.held.get(messageId) === reason) return false
    this.held.delete(messageId)
    this.held.set(messageId, reason)
    for (const oldest of this.held.keys()) {
      if (this.held.size <= HELD_MAX) break
      this.held.delete(oldest)
    }
    return true
  }

  /** The list as the owner reads it: each waiting message with the reason a hook was not handed it, if any. */
  private shown(listing: SessionMessageListing): SessionMessageListing {
    return {
      ...listing,
      messages: listing.messages.map((message) => ({
        ...message, detail: message.state === 'waiting' ? this.held.get(message.messageId) ?? null : null
      }))
    }
  }

  /** A send speaks for the process its token was given to, and for no later one in that terminal. */
  private sameProcess(sessionId: string, incarnationId: string): void {
    if (this.options.liveIncarnationId(sessionId) !== incarnationId) invalid('The sending session is running a different process now')
  }

  private iso(): string {
    return this.options.now().toISOString()
  }

  /** `bmn peers`: the sessions the caller may message, each with the app BMN last saw there. Nothing else. */
  async peers(sessionId: string): Promise<{ on: boolean; paused: boolean; peers: SessionPeer[] }> {
    const found = await this.options.database.companion('messagePeers', sessionId)
    const peers = await Promise.all(found.peers.map(async (peer) => ({
      sessionId: peer.sessionId, name: cleanSessionMessageName(peer.name), app: appName(await this.options.lastApp(peer.sessionId))
    })))
    return { on: found.on, paused: found.paused, peers }
  }

  /**
   * `bmn tell`: BMN, not the sender, says where the message is from. The sender's source root comes from the
   * folder the sending command itself ran in, links resolved; the terminal's start folder is never used in its
   * place, because an agent typed after a `cd` works elsewhere. This is workflow protection, not proof against
   * a program that reports a false folder.
   */
  async send(p: {
    senderSessionId: string
    senderIncarnationId: string
    destinationSessionId: string
    text: string
    senderCwd: string
  }): Promise<{ messageId: string; state: 'waiting' }> {
    this.sameProcess(p.senderSessionId, p.senderIncarnationId)
    const cleaned = cleanSessionMessageText(p.text)
    if ('problem' in cleaned) invalid(cleaned.problem)
    const sender = await this.options.session(p.senderSessionId)
    if (!sender) invalid('The sending session is unavailable')
    const folder = await this.existingFolder(p.senderCwd)
    if (folder === null) invalid('BMN cannot find the folder this command ran in; run bmn tell from an existing folder')
    let senderRoot: string
    try {
      senderRoot = await this.options.sourceRoot(folder)
    } catch {
      return invalid('BMN cannot tell which repository the folder this command ran in belongs to; try again')
    }
    const stamp = sessionMessageStamp({
      sessionId: sender.sessionId, name: sender.name, folder: senderRoot,
      app: appName(await this.options.lastApp(sender.sessionId))
    })
    // The reads above took time, and the terminal may have been given another process meanwhile. This is the
    // last look: a send is the word of the process that was running when the store was asked, and a process
    // that ends after that does not cancel it. A message outlives its sender's process in any case.
    this.sameProcess(p.senderSessionId, p.senderIncarnationId)
    const outcome = await this.options.database.companion('sendSessionMessage', {
      messageId: randomUUID(), senderSessionId: p.senderSessionId, receiverSessionId: p.destinationSessionId,
      senderRoot, stamp, text: cleaned.text
    }, this.iso())
    this.options.changed()
    if (outcome.accepted) return { messageId: outcome.messageId, state: outcome.state }
    const sent = cleanSessionMessageName(outcome.senderName)
    const received = cleanSessionMessageName(outcome.receiverName)
    await this.options.notice(outcome.paused === 'pair'
      ? {
          sessionId: p.senderSessionId, incarnationId: p.senderIncarnationId,
          requestKey: `watch:messages:${p.destinationSessionId}`,
          title: `${sent} and ${received} exchanged ${SESSION_MESSAGE_PAIR_HOURLY} messages in an hour; messages between them are paused`,
          body: 'Open the workspace menu, Messages…, to read them and to resume. BMN stopped nothing else.'
        }
      : {
          sessionId: p.senderSessionId, incarnationId: p.senderIncarnationId,
          requestKey: 'watch:messages:workspace',
          title: `Sessions in ${cleanSessionMessageName(outcome.workspaceName)} exchanged ${SESSION_MESSAGE_WORKSPACE_HOURLY} messages in an hour; messages in it are paused`,
          body: 'Open the workspace menu, Messages…, to read them and to resume. BMN stopped nothing else.'
        }).catch(() => undefined)
    return invalid(outcome.reason)
  }

  private async existingFolder(path: string): Promise<string | null> {
    if (!isAbsolute(path)) return null
    try {
      const real = await realpath(path)
      return (await stat(real)).isDirectory() ? real : null
    } catch {
      return null
    }
  }

  /** `bmn tell status`: the caller's own sent messages and where each stands. Nothing of a receiver's activity. */
  async status(senderSessionId: string, messageId: string | null): Promise<{ messages: SessionMessageReceipt[] }> {
    const messages = await this.options.database.companion('listSentMessages', senderSessionId, messageId)
    if (messageId !== null && messages.length === 0) {
      throw new HostControlError(ERROR_CODES.notFound, 'No message of yours has that id')
    }
    const now = this.options.now().getTime()
    return {
      messages: messages.map((message) => ({
        messageId: message.messageId, receiverSessionId: message.receiverSessionId,
        state: sessionMessageStateWord(message, now), sentAt: message.sentAt
      }))
    }
  }

  async list(workspaceId: string): Promise<SessionMessageListing> {
    return this.shown(await this.options.database.companion('listWorkspaceMessages', workspaceId))
  }

  async pause(workspaceId: string, paused: boolean): Promise<SessionMessageListing> {
    const listing = await this.options.database.companion('setWorkspaceMessagePause', workspaceId, paused, this.iso())
    this.options.changed()
    return this.shown(listing)
  }

  async resumePair(workspaceId: string, firstSessionId: string, secondSessionId: string): Promise<SessionMessageListing> {
    const listing = await this.options.database.companion('resumeMessagePair', workspaceId, firstSessionId, secondSessionId, this.iso())
    this.options.changed()
    return this.shown(listing)
  }

  /**
   * The owner's Paste: one claim, then the stamp and text appended to the receiving session's input without
   * Enter, as a handoff is pasted. `expectedIncarnationId` is the receiving process the owner was shown; a
   * different one now refuses before anything is written. A claim BMN could not finish stays uncertain and is
   * never repeated by BMN. No provider check is made: this is the owner's own explicit transfer.
   */
  async paste(messageId: string, expectedIncarnationId: string): Promise<SessionMessageRecord> {
    const database = this.options.database
    const message = await database.companion('getSessionMessage', messageId)
    if (message.state !== 'waiting') return message
    if (this.options.liveIncarnationId(message.receiverSessionId) !== expectedIncarnationId) {
      throw new HostControlError(ERROR_CODES.revisionConflict, "The receiving session's process changed; open Messages again")
    }
    const claim = await database.companion('claimMessageForPaste', messageId, expectedIncarnationId, this.iso())
    if (!claim.claimed) return claim.record
    this.held.delete(messageId)
    this.options.changed()
    if (this.options.liveIncarnationId(message.receiverSessionId) !== expectedIncarnationId) {
      await database.companion('finishMessagePaste', messageId, 'waiting')
      this.options.changed()
      throw new HostControlError(ERROR_CODES.revisionConflict, "The receiving session's process changed; open Messages again")
    }
    this.options.paste(message.receiverSessionId, sessionMessagePayload(message))
    const record = await database.companion('finishMessagePaste', messageId, 'pasted')
    this.options.changed()
    return record
  }

  /**
   * `message.take`, asked by the receiving agent's own hook after a tool call: the oldest message that may be
   * handed over at this moment, claimed in one step, or nothing. The store answers for expiry, memberships,
   * switches and pauses; this asks, per message, whether the provider the hook resolved may see private work in
   * the root stored with that message. A message refused for its provider stays waiting and the list says why
   * for as long as this run lasts; a later one from another folder is not held up behind it. One message per event.
   */
  async take(p: {
    sessionId: string
    incarnationId: string
    pid: number
    app: string
    destination: MessageDestination
  }): Promise<{ message: SessionMessageTaken | null }> {
    if (SESSION_MESSAGE_HANDOVER[p.app] === undefined) return { message: null }
    if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) return { message: null }
    const database = this.options.database
    const candidates = await database.companion('messageTakeCandidates', p.sessionId, this.iso())
    // One question per folder: the messages of one sender's repository share its answer for this event.
    const answers = new Map<string, { allowed: boolean; reason: string }>()
    for (const candidate of candidates) {
      let answer = answers.get(candidate.senderRoot)
      if (answer === undefined) {
        try {
          answer = await this.options.providerAnswer(p.destination, candidate.senderRoot)
        } catch {
          answer = { allowed: false, reason: 'BMN could not read the approved team' }
        }
        answers.set(candidate.senderRoot, answer)
      }
      if (!answer.allowed) {
        const detail = `Not handed over by the hook: ${stripFormatCharacters(answer.reason)}. Paste hands it over on your word.`.slice(0, 400)
        if (this.hold(candidate.messageId, detail)) this.options.changed()
        continue
      }
      // The answers above took time: a hook of a process this terminal no longer runs is handed nothing.
      if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) return { message: null }
      const claimId = randomUUID()
      const claim = await database.companion('claimMessageForHook', {
        messageId: candidate.messageId, receiverSessionId: p.sessionId, incarnationId: p.incarnationId,
        pid: p.pid, app: p.app, claimId
      }, this.iso())
      // Lost to the owner's Paste, or a condition ended between the two reads: nothing more on this event.
      if (!claim.claimed || claim.record === null) return { message: null }
      // The store answers later than it was asked. A claim that landed for a process the terminal stopped running
      // meanwhile is never answered with the text; it is given back so the terminal's next process may have the
      // message. Giving back is best effort: if it fails, the message stays "taken, not confirmed", which the
      // owner reads and no route offers again.
      if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) {
        await database.companion('releaseMessageClaim', { messageId: candidate.messageId, claimId }).catch(() => undefined)
        this.options.changed()
        return { message: null }
      }
      this.held.delete(candidate.messageId)
      this.options.changed()
      return { message: { messageId: claim.record.messageId, claimId, stamp: claim.record.stamp, text: claim.record.text } }
    }
    return { message: null }
  }

  /**
   * Whether a hook's report of an event should be told that something waits: only for an app whose hook hands
   * messages over, on the event it answers, from the session's live process, and only when the store would let
   * a hook have one. It says nothing about the message, and a wrong answer costs one unanswered `message.take`.
   */
  async waiting(p: { sessionId: string; incarnationId: string | null; agent: string; event: string }): Promise<boolean> {
    if (SESSION_MESSAGE_HANDOVER[p.agent]?.event !== p.event || p.incarnationId === null) return false
    if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) return false
    // This answer rides on the report of every such event, so a slow store may not hold it: no word in time
    // means nothing is handed over on this event, and the message waits for the next.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), SESSION_MESSAGE_WAITING_CHECK_MS) })
    const found = this.options.database.companion('messageTakeCandidates', p.sessionId, this.iso())
      .then((candidates) => candidates.length > 0, () => false)
    try {
      return await Promise.race([found, late])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The hook's word that it printed what it took: accepted only from the claiming session and process. */
  async report(p: {
    sessionId: string
    incarnationId: string
    pid: number
    messageId: string
    claimId: string
  }): Promise<{ recorded: boolean }> {
    const result = await this.options.database.companion('reportMessagePrinted', {
      messageId: p.messageId, claimId: p.claimId, receiverSessionId: p.sessionId, incarnationId: p.incarnationId, pid: p.pid
    })
    if (result.recorded) this.options.changed()
    return result
  }

  /**
   * Deletes messages sent longer ago than the owner's confirmed "Keep agent history" days. No confirmed limit,
   * or Never, deletes none; a shorter limit he has not confirmed is not `confirmedKeepDays` yet, so it does
   * not apply. The two-hour expiry only ends hand-over and deletes nothing.
   */
  async sweep(): Promise<number> {
    const days = await this.options.confirmedKeepDays()
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return 0
    const cutoff = new Date(this.options.now().getTime() - days * DAY_MS).toISOString()
    const deleted = await this.options.database.companion('deleteMessagesSentBefore', cutoff)
    if (deleted > 0) this.options.changed()
    return deleted
  }
}
