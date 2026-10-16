// MODULE: session-messages-dialog.tsx - the owner's reading of one workspace's messages between sessions, read-only (Epic 66, Story 75.4)
import { useEffect, useRef, useState } from 'react'
import {
  ROSTER_APP_NAMES, SESSION_MESSAGE_HANDOVER, SESSION_MESSAGE_LIST_LIMIT, SESSION_MESSAGE_PAIR_HOURLY,
  SESSION_MESSAGES_HELP, sessionMessageFirstLine, sessionMessageStateWord,
  type SessionMessageListing, type SessionMessageListRow, type SessionMessagePairPause, type WorkspaceRecord
} from '@bmn/protocol'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import { boundedRead } from './bounded-read'
import { relativeAge } from './session-presentation'
import './session-messages.css'

const appName = (app: string): string => (ROSTER_APP_NAMES as Readonly<Record<string, string | undefined>>)[app] ?? app
const localTime = (iso: string): string => new Date(iso).toLocaleString()
const clockTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Which apps' agents get a waiting message from their own hook, with the version that was measured on: the same
 * fact `bmn hooks check` says per app. A message to a session running any other app is refused to its sender.
 */
export function messageHandover(): string {
  const measured = Object.keys(ROSTER_APP_NAMES).filter((app) => SESSION_MESSAGE_HANDOVER[app] !== undefined)
  return measured.length === 0 ? 'no app'
    : measured.map((app) => `${appName(app)} (measured on ${appName(app)} ${SESSION_MESSAGE_HANDOVER[app]!.version})`).join(', ')
}

export interface MessageRowView {
  message: SessionMessageListRow
  /** "Lead → Planner": the names the two sessions have now. */
  route: string
  state: string
  firstLine: string
}

/**
 * The list's rows, newest first as the host gave them, and never more than the list's bound. A handoff BMN hands
 * over itself (Story 75.5) is a row of the same shape whose state says "handoff" first.
 */
export function messageRows(listing: Pick<SessionMessageListing, 'messages'>, now: number): MessageRowView[] {
  return listing.messages.slice(0, SESSION_MESSAGE_LIST_LIMIT).map((message) => ({
    message,
    route: `${message.senderName} → ${message.receiverName}`,
    state: message.kind === 'handoff' ? `handoff · ${sessionMessageStateWord(message, now)}` : sessionMessageStateWord(message, now),
    firstLine: sessionMessageFirstLine(message.text)
  }))
}

/** What the opened message says beside its text: where it stands, in words. Nothing here can be pressed. */
export function messageNote(message: SessionMessageListRow, now: number): string {
  const receiver = message.receiverName
  const hook = message.claimedApp === null ? "the agent's hook" : `${appName(message.claimedApp)}'s hook`
  const measured = message.claimedApp === null ? undefined : SESSION_MESSAGE_HANDOVER[message.claimedApp]
  switch (message.state) {
    // The owner's Paste is gone (Story 75.4); a message stored with either of its states still reads as it did.
    case 'pasted':
      return `You pasted it into ${receiver}. Enter was not pressed.`
    case 'paste-uncertain':
      return `BMN could not confirm this paste. Look at ${receiver}'s input; BMN does not paste it again.`
    case 'taken':
      return `Taken by ${hook} and not confirmed as printed. BMN does not offer it again.`
    case 'printed':
      return `Printed for the agent by ${hook}: printed, not proven read.` +
        (measured === undefined ? '' : ` Hand-over measured on ${appName(message.claimedApp!)} ${measured.version}.`)
    case 'waiting':
      if (!message.membersPresent) return 'One of its sessions has left this workspace, so nothing delivers this message.'
      if (Date.parse(message.expiresAt) <= now) return 'Expired: no hook hands it over any more.'
      return message.detail ?? `Waits for the agent in ${receiver} to take it after a tool call.`
  }
}

/** "New ones" for the whole workspace: accepted, or held by the hourly limit until it lets go by itself. */
export function messagePauseWords(
  listing: Pick<SessionMessageListing, 'workspacePause' | 'messages'>, now: number, clock: (iso: string) => string = clockTime
): string {
  const pause = listing.workspacePause
  if (pause === null) return 'Accepted'
  const held = listing.messages.filter((message) => message.state === 'waiting' && message.membersPresent &&
    Date.parse(message.expiresAt) > now).length
  return `Paused by the limit until ${clock(pause.until)}${held === 0 ? '' : ` · ${held} held`}`
}

/** Two sessions the hourly limit paused: who, since when, and when the next message between them is allowed. */
export function messagePairPauseWords(
  pair: SessionMessagePairPause, time: (iso: string) => string = localTime, clock: (iso: string) => string = clockTime
): string {
  return `${pair.firstName} and ${pair.secondName} exchanged ${SESSION_MESSAGE_PAIR_HOURLY} messages in an hour; paused ${time(pair.pausedAt)}, ` +
    `allowed again when the counts fall, by ${clock(pair.until)}`
}

/**
 * One workspace's latest messages between its sessions, read-only (Story 75.4): nothing here is pressed, and a
 * message reaches an agent only through its own hook. The list reads again whenever the host says a message or
 * a pause changed.
 */
export function SessionMessagesDialog(props: {
  workspace: WorkspaceRecord
  now: number
  /** Bumped by the host whenever a message or a pause changed, so an open list reads again. */
  revision: number
  onClose(): void
}): React.JSX.Element {
  const workspaceId = props.workspace.workspaceId
  const [listing, setListing] = useState<SessionMessageListing | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const sequence = useRef(0)
  const mounted = useRef(true)

  async function load(): Promise<void> {
    const request = ++sequence.current
    try {
      const found = await boundedRead(window.aiTerminal.listSessionMessages(workspaceId))
      if (!mounted.current || request !== sequence.current) return
      setListing(found)
      setUnavailable(null)
    } catch (cause) {
      if (!mounted.current || request !== sequence.current) return
      setListing(null)
      setUnavailable(failureDetail(cause, 'Messages are unavailable'))
    }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      sequence.current += 1
    }
  }, [workspaceId, props.revision])

  const rows = listing ? messageRows(listing, props.now) : []
  const handover = messageHandover()

  return (
    <Dialog label={`Messages — ${props.workspace.name}`} onClose={props.onClose} className="session-messages-dialog">
      <section className="inspector-section">
        <h3>This workspace</h3>
        <dl className="kv">
          <dt>New ones</dt>
          <dd>{listing ? messagePauseWords(listing, props.now) : '…'}</dd>
          <dt>By its own hook</dt>
          <dd title={`A working agent gets a waiting message after a tool call: ${handover}. A message to a session running anything else is refused.`}>{handover}</dd>
        </dl>
        {SESSION_MESSAGES_HELP.map((line) => <small key={line}>{line}</small>)}
      </section>
      {listing && listing.pairPauses.length > 0 ? (
        <section className="inspector-section">
          <h3>Paused pairs</h3>
          <ul className="message-pairs">
            {listing.pairPauses.map((pair) => (
              <li key={`${pair.firstSessionId} ${pair.secondSessionId}`}><span>{messagePairPauseWords(pair)}</span></li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="inspector-section">
        <h3>Latest messages</h3>
        {listing === null && unavailable === null ? <p className="dialog-note" role="status">Reading…</p> : null}
        {unavailable !== null ? <p className="inline-error" role="alert">{unavailable}</p> : null}
        {listing !== null && rows.length === 0 ? <p className="dialog-note">No messages yet. An agent leaves one with bmn tell.</p> : null}
        {rows.length > 0 ? (
          <ul className="message-list" aria-label={`Latest messages, at most ${SESSION_MESSAGE_LIST_LIMIT}`}>
            {rows.map((row) => {
              const { message } = row
              const open = openId === message.messageId
              return (
                <li key={message.messageId}>
                  <button type="button" className="message-row" aria-expanded={open}
                    onClick={() => setOpenId(open ? null : message.messageId)}>
                    <span className="age">{relativeAge(message.sentAt, props.now)}</span>
                    <span className="route" title={row.route}>{row.route}</span>
                    <span className="state">{row.state}</span>
                    <span className="first-line">{row.firstLine}</span>
                  </button>
                  {open ? (
                    <div className="message-detail">
                      <pre className="message-text" aria-label="Message text">{message.text}</pre>
                      <p className="message-stamp" aria-label="Stamp">{message.stamp}</p>
                      <dl className="kv">
                        <dt>Sender’s folder</dt>
                        <dd className="path" title={message.senderRoot}><bdi>{message.senderRoot}</bdi></dd>
                        <dt>Sent</dt>
                        <dd>{localTime(message.sentAt)}</dd>
                      </dl>
                      <small className="message-note">{messageNote(message, props.now)}</small>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>
    </Dialog>
  )
}
