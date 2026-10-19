// MODULE: session-messages.ts - what the host does with a message or a handoff between sessions: stamp, refuse or store, the hook's take (Epic 66, Stories 75.4, 75.5)
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import {
  ERROR_CODES,
  ROSTER_APP_NAMES,
  SESSION_MESSAGE_HANDOVER,
  SESSION_MESSAGE_PAIR_HOURLY,
  SESSION_MESSAGE_WAITING_CHECK_MS,
  SESSION_MESSAGE_WORKSPACE_HOURLY,
  cleanSessionMessageName,
  cleanSessionMessageText,
  sessionHandoffStamp,
  sessionMessageReceiverRefusal,
  sessionMessageStamp,
  sessionMessageStateWord,
  stripFormatCharacters,
  type MessageDestination,
  type SessionAgentNow,
  type SessionMessageListing,
  type SessionMessageReceipt,
  type SessionMessageTaken,
  type SessionPeer,
  type SessionRecord
} from '@bmn/protocol'
import type { DatabaseWorkerClient } from './database-client'
import type { HandoffAttachmentSource, SendOutcome } from './database-message-store'
import { HostControlError, invalidHostControl } from './session-manager'

export type { MessageDestination }

interface SessionMessagesOptions {
  database: Pick<DatabaseWorkerClient, 'companion'>
  liveIncarnationId(sessionId: string): string | null | undefined
  /** A session as the host knows it now, read afresh. */
  session(sessionId: string): Promise<SessionRecord | undefined>
  /** What holds a session's terminal now: the agent in front, its shell, another program, or nothing running. */
  foreground(sessionId: string): SessionAgentNow
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

function appName(app: string | null): string | null {
  return app !== null && Object.hasOwn(ROSTER_APP_NAMES, app) ? ROSTER_APP_NAMES[app as keyof typeof ROSTER_APP_NAMES] : null
}

function agentNow(foreground: SessionAgentNow): string | null {
  return foreground.state === 'agent' ? foreground.app : null
}

/**
 * Messages between the sessions of one workspace. Nothing here types into a terminal: a message reaches an agent
 * only through its own hook. Nothing here opens a request except the one notice of a pause.
 */
export class SessionMessages {
  /**
   * Why a hook was not handed a waiting message, by message id. The reason names a provider of the owner's
   * team, and nothing of the team may reach the database, a Backup export, Telegram or a log (R60-NFR3): it
   * lives here for this run only, as a prompt guard stop does, and the next refused event writes it again.
   */
  private readonly held = new Map<string, string>()
  /** Story 75.5: the root of the folder each attached file was published from, by file, once BMN found it this run. */
  private readonly roots = new Map<string, string>()

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

  /**
   * The root of the folder an attached file was published from, by the prompt guard's rule, or null when BMN
   * cannot find that folder or tell its root: a file whose source is unknown is never handed on.
   */
  private async attachmentRoot(file: HandoffAttachmentSource): Promise<string | null> {
    const known = this.roots.get(file.artifactId)
    if (known !== undefined) return known
    if (file.sourcePath === null || !isAbsolute(file.sourcePath)) return null
    const folder = await this.existingFolder(dirname(file.sourcePath))
    if (folder === null) return null
    let root: string
    try {
      root = await this.options.sourceRoot(folder)
    } catch {
      return null
    }
    this.roots.set(file.artifactId, root)
    for (const oldest of this.roots.keys()) {
      if (this.roots.size <= HELD_MAX) break
      this.roots.delete(oldest)
    }
    return root
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
    if (this.options.liveIncarnationId(sessionId) !== incarnationId) invalidHostControl('The sending session is running a different process now')
  }

  private iso(): string {
    return this.options.now().toISOString()
  }

  /** `bmn peers`: the sessions the caller may message, each with the agent in front there now. Nothing else. */
  async peers(sessionId: string): Promise<{ on: boolean; paused: boolean; peers: SessionPeer[] }> {
    const found = await this.options.database.companion('messagePeers', sessionId, this.iso())
    const peers = found.peers.map((peer) => ({
      sessionId: peer.sessionId, name: cleanSessionMessageName(peer.name), app: appName(agentNow(this.options.foreground(peer.sessionId)))
    }))
    return { on: found.on, paused: found.paused, peers }
  }

  /**
   * `bmn tell`: BMN, not the sender, says where the message is from. The sender's source root comes from the
   * folder the sending command itself ran in, links resolved; the terminal's start folder is never used in its
   * place, because an agent typed after a `cd` works elsewhere. This is workflow protection, not proof against
   * a program that reports a false folder. A receiver whose terminal holds no agent that takes messages refuses
   * the send with the reason (Story 75.4): judged by what is in front there now, after the peer check.
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
    if ('problem' in cleaned) invalidHostControl(cleaned.problem)
    const sender = await this.options.session(p.senderSessionId)
    if (!sender) invalidHostControl('The sending session is unavailable')
    const folder = await this.existingFolder(p.senderCwd)
    if (folder === null) invalidHostControl('BMN cannot find the folder this command ran in; run bmn tell from an existing folder')
    let senderRoot: string
    try {
      senderRoot = await this.options.sourceRoot(folder)
    } catch {
      return invalidHostControl('BMN cannot tell which repository the folder this command ran in belongs to; try again')
    }
    const stamp = sessionMessageStamp({
      sessionId: sender.sessionId, name: sender.name, folder: senderRoot,
      app: appName(agentNow(this.options.foreground(sender.sessionId)))
    })
    // The reads above took time, and the terminal may have been given another process meanwhile. This is the
    // last look: a send is the word of the process that was running when the store was asked, and a process
    // that ends after that does not cancel it. A message outlives its sender's process in any case.
    this.sameProcess(p.senderSessionId, p.senderIncarnationId)
    const receiverRefusal = sessionMessageReceiverRefusal(this.options.foreground(p.destinationSessionId),
      (app) => appName(app) ?? 'an app')
    const outcome = await this.options.database.companion('sendSessionMessage', {
      messageId: randomUUID(), senderSessionId: p.senderSessionId, receiverSessionId: p.destinationSessionId,
      senderRoot, stamp, text: cleaned.text, receiverRefusal
    }, this.iso())
    this.options.changed()
    if (outcome.accepted) return { messageId: outcome.messageId, state: outcome.state }
    return this.paused(outcome, p)
  }

  /**
   * A send one past an hourly limit, a message's or a handoff's: it stored the pause it caused, which gets its one
   * notice on the sending session, and the send is refused with the reason.
   */
  async paused(
    outcome: Extract<SendOutcome, { accepted: false }>,
    p: { senderSessionId: string; senderIncarnationId: string; destinationSessionId: string }
  ): Promise<never> {
    this.options.changed()
    const sent = cleanSessionMessageName(outcome.senderName)
    const received = cleanSessionMessageName(outcome.receiverName)
    await this.options.notice(outcome.paused === 'pair'
      ? {
          sessionId: p.senderSessionId, incarnationId: p.senderIncarnationId,
          requestKey: `watch:messages:${p.destinationSessionId}`,
          title: `${sent} and ${received} exchanged ${SESSION_MESSAGE_PAIR_HOURLY} messages in an hour; messages between them are paused`,
          body: 'They are allowed again by themselves once fewer were sent in the last hour; Messages… in the command palette shows them. BMN stopped nothing else.'
        }
      : {
          sessionId: p.senderSessionId, incarnationId: p.senderIncarnationId,
          requestKey: 'watch:messages:workspace',
          title: `Sessions in ${cleanSessionMessageName(outcome.workspaceName)} exchanged ${SESSION_MESSAGE_WORKSPACE_HOURLY} messages in an hour; messages in it are paused`,
          body: 'They are allowed again by themselves once fewer were sent in the last hour; Messages… in the command palette shows them. BMN stopped nothing else.'
        }).catch(() => undefined)
    return invalidHostControl(outcome.reason)
  }

  /**
   * Story 75.5: what a handoff needs before it is stored. The sender's root comes from the folder its command ran
   * in, as a message's does; every attached file's folder must still be found and its root told, or the handoff is
   * refused, since a file whose source is unknown is never handed on. The provider is asked at hand-over, for all
   * of these roots. The receiver must run an agent that takes messages (Story 75.4).
   */
  async prepareHandoff(p: {
    senderSessionId: string
    senderIncarnationId: string
    senderCwd: string
    destinationSessionId: string
    attachments: readonly HandoffAttachmentSource[]
  }): Promise<{ senderRoot: string; stamp: string; receiverRefusal: string | null }> {
    this.sameProcess(p.senderSessionId, p.senderIncarnationId)
    const sender = await this.options.session(p.senderSessionId)
    if (!sender) invalidHostControl('The sending session is unavailable')
    const folder = await this.existingFolder(p.senderCwd)
    if (folder === null) invalidHostControl('BMN cannot find the folder this command ran in; run bmn handoff from an existing folder')
    let senderRoot: string
    try {
      senderRoot = await this.options.sourceRoot(folder)
    } catch {
      return invalidHostControl('BMN cannot tell which repository the folder this command ran in belongs to; try again')
    }
    for (const file of p.attachments) {
      if (await this.attachmentRoot(file) === null) {
        invalidHostControl(`BMN cannot tell which folder ${cleanSessionMessageName(file.name)} came from, so it hands it to nobody; nothing was sent`)
      }
    }
    const stamp = sessionHandoffStamp({
      sessionId: sender.sessionId, name: sender.name, folder: senderRoot,
      app: appName(agentNow(this.options.foreground(sender.sessionId)))
    })
    this.sameProcess(p.senderSessionId, p.senderIncarnationId)
    return {
      senderRoot, stamp,
      receiverRefusal: sessionMessageReceiverRefusal(this.options.foreground(p.destinationSessionId), (app) => appName(app) ?? 'an app')
    }
  }

  /** A handoff was stored: the Messages dialog shows it. */
  handoffQueued(): void {
    this.options.changed()
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
    return this.shown(await this.options.database.companion('listWorkspaceMessages', workspaceId, this.iso()))
  }

  /**
   * `message.take`, asked by the receiving agent's own hook after a tool call: the oldest message that may be
   * handed over at this moment, claimed in one step, or nothing. The store answers for expiry, memberships and
   * the hourly limit's pauses; this asks, per message, whether the provider the hook resolved may see private
   * work in the root stored with that message, and for a handoff in the root of every attached file's folder too
   * (Story 75.5). A message refused for its provider stays waiting and the list says why for as long as this run
   * lasts; a later one from another folder is not held up behind it. One message per event.
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
    // One question per folder: the messages of one repository share its answer for this event.
    const answers = new Map<string, { allowed: boolean; reason: string }>()
    const ask = async (root: string): Promise<{ allowed: boolean; reason: string }> => {
      let answer = answers.get(root)
      if (answer === undefined) {
        try {
          answer = await this.options.providerAnswer(p.destination, root)
        } catch {
          answer = { allowed: false, reason: 'BMN could not read the approved team' }
        }
        answers.set(root, answer)
      }
      return answer
    }
    for (const candidate of candidates) {
      let refusal: string | null = null
      for (const file of candidate.attachments) {
        const root = await this.attachmentRoot(file)
        if (root === null) {
          refusal = `BMN cannot tell which folder ${cleanSessionMessageName(file.name)} came from`
          break
        }
        const answer = await ask(root)
        if (!answer.allowed) {
          refusal = answer.reason
          break
        }
      }
      if (refusal === null) {
        const answer = await ask(candidate.senderRoot)
        if (!answer.allowed) refusal = answer.reason
      }
      if (refusal !== null) {
        const detail = `Not handed over by the hook: ${stripFormatCharacters(refusal)}.`.slice(0, 400)
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
      // Lost to another claim, or a condition ended between the two reads: nothing more on this event.
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
