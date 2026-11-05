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
  sessionMessageExpiredLine,
  sessionMessageReceiverRefusal,
  sessionMessageStamp,
  sessionMessageStampAtDelivery,
  sessionMessageStateWord,
  stripFormatCharacters,
  type MessageDestination,
  type SessionAgentNow,
  type SessionMessageListing,
  type SessionMessageReceipt,
  type SessionMessageTaken,
  type SessionPeer,
  type SessionReceiverWord,
  type SessionRecord
} from '@bmn/protocol'
import type { DatabaseWorkerClient } from './database-client'
import type { HandoffAttachmentSource, MessageTakeCandidate, SendOutcome } from './database-message-store'
import { HostControlError, invalidHostControl } from './session-manager'

export type { MessageDestination }

interface SessionMessagesOptions {
  database: Pick<DatabaseWorkerClient, 'companion'>
  liveIncarnationId(sessionId: string): string | null | undefined
  /** A session as the host knows it now, read afresh. */
  session(sessionId: string): Promise<SessionRecord | undefined>
  /** What holds a session's terminal now: the agent in front, its shell, another program, or nothing running. */
  foreground(sessionId: string): SessionAgentNow
  /** One word per receiver, for its sender (Story 110.2): BMN's latest word on it, read together. */
  receiversNow(sessionIds: readonly string[]): Promise<ReadonlyMap<string, SessionReceiverWord>>
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
/** How long after BMN types a line its prompt event may still be taken for that line, not his. */
const TYPED_LINE_SEEN_MS = 60_000
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
 * only through its own hook; `MessageWake` may type the one fixed line that asks for a tool call, and no message.
 * Nothing here opens a request except the one notice of a pause.
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
  /**
   * Story 110.3 (D12): each run's wake depth. His typed prompt or a run's start sets it to 0; a message handed over raises it
   * to that message's depth if higher; a message sent has it plus 1. Held for this run of BMN only: after a restart nothing
   * reads it until the next turn starts, and a depth BMN cannot read wakes no one.
   */
  private readonly depths = new Map<string, { incarnationId: string; depth: number | null }>()
  /** Where each session's agent sends its work, as its hook last said: a wake asks the provider before a paid turn starts. */
  private readonly destinations = new Map<string, { incarnationId: string; destination: MessageDestination }>()
  /** When BMN last typed a line into a session, and whether its prompt event was seen: BMN's own line is no owner's prompt. */
  private readonly typed = new Map<string, { at: number; seen: boolean }>()
  /** Why a waiting message was not woken, for its sender: this run only, since it may name a limit of the owner's team. */
  private readonly wakeNotes = new Map<string, string>()

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
  }): Promise<{ messageId: string; state: 'waiting'; receiverNow: SessionReceiverWord }> {
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
    const wakeDepth = this.nextDepth(p.senderSessionId, p.senderIncarnationId)
    // The reads above took time, and the terminal may have been given another process meanwhile. This is the
    // last look: a send is the word of the process that was running when the store was asked, and a process
    // that ends after that does not cancel it. A message outlives its sender's process in any case.
    this.sameProcess(p.senderSessionId, p.senderIncarnationId)
    const receiverRefusal = sessionMessageReceiverRefusal(this.options.foreground(p.destinationSessionId),
      (app) => appName(app) ?? 'an app')
    const outcome = await this.options.database.companion('sendSessionMessage', {
      messageId: randomUUID(), senderSessionId: p.senderSessionId, receiverSessionId: p.destinationSessionId,
      senderRoot, stamp, text: cleaned.text, receiverRefusal, wakeDepth
    }, this.iso())
    this.options.changed()
    if (outcome.accepted) {
      return { messageId: outcome.messageId, state: outcome.state, receiverNow: (await this.words([p.destinationSessionId])).get(p.destinationSessionId) ?? 'not heard from' }
    }
    return this.paused(outcome, p)
  }

  /** The receivers' words; a store that cannot say leaves "not heard from", and never holds a send's answer back. */
  private async words(sessionIds: readonly string[]): Promise<ReadonlyMap<string, SessionReceiverWord>> {
    return this.options.receiversNow(sessionIds).catch(() => new Map<string, SessionReceiverWord>())
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
  }): Promise<{ senderRoot: string; stamp: string; receiverRefusal: string | null; wakeDepth: number | null }> {
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
      senderRoot, stamp, wakeDepth: this.nextDepth(p.senderSessionId, p.senderIncarnationId),
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

  /** `bmn tell cancel`: the caller's own waiting message can no longer be handed over. */
  async cancel(senderSessionId: string, messageId: string): Promise<{ messageId: string; state: string }> {
    const { state } = await this.options.database.companion('withdrawSessionMessage', senderSessionId, messageId, this.iso())
    this.options.changed()
    return { messageId, state }
  }

  /** `bmn tell status`: the caller's own sent messages, where each stands, and one word for its receiver now. */
  async status(senderSessionId: string, messageId: string | null): Promise<{ messages: SessionMessageReceipt[] }> {
    const messages = await this.options.database.companion('listSentMessages', senderSessionId, messageId)
    if (messageId !== null && messages.length === 0) {
      throw new HostControlError(ERROR_CODES.notFound, 'No message of yours has that id')
    }
    const now = this.options.now().getTime()
    const words = await this.words([...new Set(messages.map((message) => message.receiverSessionId))])
    return {
      messages: messages.map((message) => ({
        messageId: message.messageId, receiverSessionId: message.receiverSessionId,
        state: sessionMessageStateWord(message, now), sentAt: message.sentAt,
        receiverNow: words.get(message.receiverSessionId) ?? 'not heard from',
        wake: this.wakeWord(message)
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
   * lasts; a later one from another folder is not held up behind it. One message per event. Beside it goes the one line
   * for the oldest message this session sent that expired and it was not told of (Story 110.2 AC3), once.
   */
  async take(p: {
    sessionId: string
    incarnationId: string
    pid: number
    app: string
    destination: MessageDestination
  }): Promise<{ message: SessionMessageTaken | null; expired?: string }> {
    if (SESSION_MESSAGE_HANDOVER[p.app] === undefined) return { message: null }
    if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) return { message: null }
    this.destinations.set(p.sessionId, { incarnationId: p.incarnationId, destination: p.destination })
    const database = this.options.database
    const told = await database.companion('claimExpiredNotice', p.sessionId, this.iso())
    const expired = told === null ? {} : { expired: sessionMessageExpiredLine(told) }
    const candidates = await database.companion('messageTakeCandidates', p.sessionId, this.iso())
    // One question per folder: the messages of one repository share its answer for this event.
    const ask = this.providerQuestions(p.destination)
    for (const candidate of candidates) {
      const refusal = await this.providerRefusal(candidate, ask)
      if (refusal !== null) {
        const detail = `Not handed over by the hook: ${stripFormatCharacters(refusal)}.`.slice(0, 400)
        if (this.hold(candidate.messageId, detail)) this.options.changed()
        continue
      }
      // The answers above took time: a hook of a process this terminal no longer runs is handed nothing.
      if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) return { message: null, ...expired }
      const claimId = randomUUID()
      const claim = await database.companion('claimMessageForHook', {
        messageId: candidate.messageId, receiverSessionId: p.sessionId, incarnationId: p.incarnationId,
        pid: p.pid, app: p.app, claimId
      }, this.iso())
      // Lost to another claim, or a condition ended between the two reads: nothing more on this event.
      if (!claim.claimed || claim.record === null) return { message: null, ...expired }
      // The store answers later than it was asked. A claim that landed for a process the terminal stopped running
      // meanwhile is never answered with the text; it is given back so the terminal's next process may have the
      // message. Giving back is best effort: if it fails, the message stays "taken, not confirmed", which the
      // owner reads and no route offers again.
      if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) {
        await database.companion('releaseMessageClaim', { messageId: candidate.messageId, claimId }).catch(() => undefined)
        this.options.changed()
        return { message: null, ...expired }
      }
      this.held.delete(candidate.messageId)
      this.wakeNotes.delete(candidate.messageId)
      this.raiseDepth(p.sessionId, p.incarnationId, candidate.wakeDepth)
      this.options.changed()
      const stamp = sessionMessageStampAtDelivery(claim.record.stamp, claim.record.sentAt, this.options.now().getTime())
      return { message: { messageId: claim.record.messageId, claimId, stamp, text: claim.record.text }, ...expired }
    }
    return { message: null, ...expired }
  }

  /** One provider question per folder for one destination, answered at most once; an unreadable team refuses. */
  private providerQuestions(destination: MessageDestination): (root: string) => Promise<{ allowed: boolean; reason: string }> {
    const answers = new Map<string, { allowed: boolean; reason: string }>()
    return async (root) => {
      let answer = answers.get(root)
      if (answer === undefined) {
        try {
          answer = await this.options.providerAnswer(destination, root)
        } catch {
          answer = { allowed: false, reason: 'BMN could not read the approved team' }
        }
        answers.set(root, answer)
      }
      return answer
    }
  }

  /** Why this destination's provider may not have this message: its files' folders first, then the folder it came from. */
  private async providerRefusal(candidate: Pick<MessageTakeCandidate, 'attachments' | 'senderRoot'>, ask: (root: string) => Promise<{ allowed: boolean; reason: string }>): Promise<string | null> {
    for (const file of candidate.attachments) {
      const root = await this.attachmentRoot(file)
      if (root === null) return `BMN cannot tell which folder ${cleanSessionMessageName(file.name)} came from`
      const answer = await ask(root)
      if (!answer.allowed) return answer.reason
    }
    const answer = await ask(candidate.senderRoot)
    return answer.allowed ? null : answer.reason
  }

  // ---- Story 110.3: the wake's part of a session's state

  /** A turn began: his typed prompt or a run's start sets the depth to 0; BMN's own line does not (D12). */
  turnStarted(sessionId: string, incarnationId: string): void {
    const typed = this.typed.get(sessionId)
    if (typed !== undefined && !typed.seen && this.options.now().getTime() - typed.at < TYPED_LINE_SEEN_MS) {
      typed.seen = true
      return
    }
    this.depths.set(sessionId, { incarnationId, depth: 0 })
  }

  /** BMN typed a line into this session, the Away wake's or a message's: the prompt event that follows is not his. */
  bmnTyped(sessionId: string): void {
    this.typed.set(sessionId, { at: this.options.now().getTime(), seen: false })
    for (const oldest of this.typed.keys()) {
      if (this.typed.size <= HELD_MAX) break
      this.typed.delete(oldest)
    }
  }

  typedAt(sessionId: string): number | null {
    return this.typed.get(sessionId)?.at ?? null
  }

  private depthOf(sessionId: string, incarnationId: string): number | null {
    const known = this.depths.get(sessionId)
    return known?.incarnationId === incarnationId ? known.depth : null
  }

  private nextDepth(sessionId: string, incarnationId: string): number | null {
    const depth = this.depthOf(sessionId, incarnationId)
    return depth === null ? null : depth + 1
  }

  /** A message handed over raises the session's depth to its own if higher, in a running turn or a woken one; unknown stays unknown. */
  private raiseDepth(sessionId: string, incarnationId: string, messageDepth: number | null): void {
    const depth = this.depthOf(sessionId, incarnationId)
    this.depths.set(sessionId, { incarnationId, depth: depth === null || messageDepth === null ? null : Math.max(depth, messageDepth) })
  }

  /** The hook's word, at the end of a turn, on where this session's agent sends its work; the wake asks about it before typing. */
  rememberDestination(sessionId: string, incarnationId: string, destination: MessageDestination): void {
    if (this.options.liveIncarnationId(sessionId) !== incarnationId) return
    this.destinations.set(sessionId, { incarnationId, destination })
  }

  /** Why a wake must not start a turn for this message: no paid turn starts for text its provider may not read. */
  async wakeRefusal(sessionId: string, incarnationId: string, messageId: string): Promise<string | null> {
    const known = this.destinations.get(sessionId)
    if (known?.incarnationId !== incarnationId) return 'BMN does not know yet which provider its agent uses'
    const candidates = await this.options.database.companion('messageTakeCandidates', sessionId, this.iso())
    const candidate = candidates.find((one) => one.messageId === messageId)
    if (candidate === undefined) return 'it was taken, withdrawn or paused'
    const refusal = await this.providerRefusal(candidate, this.providerQuestions(known.destination))
    return refusal === null ? null : 'its provider may not read this message'
  }

  wakeCandidates(sessionId: string): Promise<MessageTakeCandidate[]> {
    return this.options.database.companion('messageTakeCandidates', sessionId, this.iso())
  }

  /** What a message's sender reads about its wake; a stored message from before this story simply has none. */
  noteWake(messageId: string, reason: string | null): void {
    if (reason === null) { this.wakeNotes.delete(messageId); return }
    if (this.wakeNotes.get(messageId) === reason) return
    this.wakeNotes.delete(messageId)
    this.wakeNotes.set(messageId, reason)
    for (const oldest of this.wakeNotes.keys()) {
      if (this.wakeNotes.size <= HELD_MAX) break
      this.wakeNotes.delete(oldest)
    }
    this.options.changed()
  }

  private wakeWord(message: { messageId: string; state: string; wokenAt?: string | null | undefined }): string | null {
    if (message.wokenAt) return `woken at ${message.wokenAt}`
    if (message.state !== 'waiting') return null
    const note = this.wakeNotes.get(message.messageId)
    return note === undefined ? null : `not woken: ${note}`
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
    const found = this.options.database.companion('messagesForHook', p.sessionId, this.iso()).catch(() => false)
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
   * not apply. A message's expiry only ends hand-over and deletes nothing.
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
