// MODULE: session-messages-dialog.tsx - the owner's reading of one workspace's messages between sessions: list, Paste, pauses (Epic 66)
import { useEffect, useRef, useState } from 'react'
import {
  ROSTER_APP_NAMES, SESSION_MESSAGE_HANDOVER, SESSION_MESSAGE_LIST_LIMIT, SESSION_MESSAGE_PAIR_HOURLY,
  SESSION_MESSAGE_WORKSPACE_HOURLY, SESSION_MESSAGES_HELP, sessionMessageFirstLine, sessionMessageStateWord,
  type SessionMessageListing, type SessionMessageListRow, type SessionMessagePairPause, type WorkspaceRecord
} from '@bmn/protocol'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import { boundedRead } from './bounded-read'
import { relativeAge } from './session-presentation'
import './session-messages.css'

const appName = (app: string): string => (ROSTER_APP_NAMES as Readonly<Record<string, string | undefined>>)[app] ?? app
const localTime = (iso: string): string => new Date(iso).toLocaleString()

/**
 * Which apps' agents get a waiting message from their own hook, with the version that was measured on, and
 * which get one only by the owner's Paste: the same fact `bmn hooks check` says per app.
 */
export function messageHandover(): { byHook: string; byPaste: string } {
  const apps = Object.keys(ROSTER_APP_NAMES)
  const measured = apps.filter((app) => SESSION_MESSAGE_HANDOVER[app] !== undefined)
  const rest = apps.filter((app) => SESSION_MESSAGE_HANDOVER[app] === undefined)
  return {
    byHook: measured.length === 0 ? 'no app'
      : measured.map((app) => `${appName(app)} (measured on ${appName(app)} ${SESSION_MESSAGE_HANDOVER[app]!.version})`).join(', '),
    byPaste: rest.map(appName).join(', ')
  }
}

export interface MessageRowView {
  message: SessionMessageListRow
  /** "Lead → Planner": the names the two sessions have now. */
  route: string
  state: string
  firstLine: string
}

/** The list's rows, newest first as the host gave them, and never more than the list's bound. */
export function messageRows(listing: Pick<SessionMessageListing, 'messages'>, now: number): MessageRowView[] {
  return listing.messages.slice(0, SESSION_MESSAGE_LIST_LIMIT).map((message) => ({
    message,
    route: `${message.senderName} → ${message.receiverName}`,
    state: sessionMessageStateWord(message, now),
    firstLine: sessionMessageFirstLine(message.text)
  }))
}

/** What the opened message offers: the Paste button and what it would do, or why there is none. */
export type MessagePasteControl =
  | { offered: true; label: string; disabled: boolean; note: string }
  | { offered: false; note: string }

/**
 * Paste is offered for a message nobody has claimed, waiting or expired, while both its sessions are still in
 * the workspace it was sent in. Once claimed, by a Paste or by a hook, BMN never offers it again by itself.
 */
export function messagePasteControl(
  message: SessionMessageListRow, now: number, receiverIncarnationId: string | null, pasting: boolean
): MessagePasteControl {
  const receiver = message.receiverName
  const hook = message.claimedApp === null ? "the agent's hook" : `${appName(message.claimedApp)}'s hook`
  const measured = message.claimedApp === null ? undefined : SESSION_MESSAGE_HANDOVER[message.claimedApp]
  switch (message.state) {
    case 'pasted':
      return { offered: false, note: `You pasted it into ${receiver}. Enter was not pressed.` }
    case 'paste-uncertain':
      return { offered: false, note: `BMN could not confirm this paste. Look at ${receiver}'s input; BMN does not paste it again.` }
    case 'taken':
      return { offered: false, note: `Taken by ${hook} and not confirmed as printed. BMN does not offer it again.` }
    case 'printed':
      return {
        offered: false,
        note: `Printed for the agent by ${hook}: printed, not proven read.` +
          (measured === undefined ? '' : ` Hand-over measured on ${appName(message.claimedApp!)} ${measured.version}.`)
      }
    case 'waiting': {
      if (!message.membersPresent) {
        return { offered: false, note: 'One of its sessions has left this workspace, so nothing delivers this message. You can still read it here.' }
      }
      const label = `Paste into ${receiver}`
      if (pasting) return { offered: true, label, disabled: true, note: 'Pasting…' }
      if (receiverIncarnationId === null) return { offered: true, label, disabled: true, note: `${receiver} is not running. Start it to paste.` }
      const expired = Date.parse(message.expiresAt) <= now
      return {
        offered: true, label, disabled: false,
        note: message.detail ?? (expired
          ? 'Expired: no hook hands it over any more. Your Paste still does, without pressing Enter.'
          : 'Appends the stamp and the text to its input. Enter is not pressed.')
      }
    }
  }
}

/** "Pause messages" or "Resume" for the whole workspace, and the words beside it. */
export function messagePauseControl(
  listing: Pick<SessionMessageListing, 'workspacePause'>, time: (iso: string) => string = localTime
): { paused: boolean; words: string; action: 'Pause messages' | 'Resume' } {
  const pause = listing.workspacePause
  if (pause === null) return { paused: false, words: 'Accepted', action: 'Pause messages' }
  return {
    paused: true,
    words: pause.by === 'owner' ? `Paused by you, ${time(pause.at)}`
      : `Paused ${time(pause.at)}: sessions here exchanged ${SESSION_MESSAGE_WORKSPACE_HOURLY} messages in an hour`,
    action: 'Resume'
  }
}

/** Two sessions the hourly limit paused: who, and since when. */
export function messagePairPauseWords(pair: SessionMessagePairPause, time: (iso: string) => string = localTime): string {
  return `${pair.firstName} and ${pair.secondName} exchanged ${SESSION_MESSAGE_PAIR_HOURLY} messages in an hour; paused ${time(pair.pausedAt)}`
}

/** The switch's two help lines, read before it goes on: with it on, agents here can name and influence each other. */
export function MessagesSwitchDialog(props: { workspaceName: string; onConfirm(): void; onClose(): void }): React.JSX.Element {
  return (
    <Dialog label={`Sessions here may message each other — ${props.workspaceName}`} onClose={props.onClose} className="session-messages-switch">
      <ul>
        {SESSION_MESSAGES_HELP.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p className="dialog-note">BMN stamps where each message is from and never presses Enter for one. Messages… in this menu is where you read, paste and pause them.</p>
      <div className="dialog-actions">
        <button type="button" className="ghost" autoFocus onClick={props.onClose}>Cancel</button>
        <button type="button" className="primary" onClick={() => { props.onClose(); props.onConfirm() }}>Switch on</button>
      </div>
    </Dialog>
  )
}

/**
 * One workspace's latest messages between its sessions. Reading changes nothing; Paste is the only thing here
 * that writes to a terminal, on the owner's press and without Enter.
 */
export function SessionMessagesDialog(props: {
  workspace: WorkspaceRecord
  now: number
  /** Bumped by the host whenever a message or a pause changed, so an open list reads again. */
  revision: number
  /** The live process of a session as the window shows it, or null while it is not running. */
  incarnationOf(sessionId: string): string | null
  onClose(): void
}): React.JSX.Element {
  const workspaceId = props.workspace.workspaceId
  const [listing, setListing] = useState<SessionMessageListing | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [pastingId, setPastingId] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const sequence = useRef(0)
  const mounted = useRef(true)

  async function load(): Promise<void> {
    const request = ++sequence.current
    try {
      const found = await boundedRead(window.aiTerminal.listSessionMessages(workspaceId))
      if (!mounted.current || request !== sequence.current) return
      setListing(found)
      setUnavailable(false)
    } catch (cause) {
      if (!mounted.current || request !== sequence.current) return
      setListing(null)
      setUnavailable(true)
      setError(failureDetail(cause, 'Messages are unavailable'))
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

  /** A pause or a resume answers with the list as it stands afterwards. */
  async function change(run: () => Promise<SessionMessageListing>, fallback: string): Promise<void> {
    setChanging(true)
    setError(null)
    setNotice(null)
    const request = ++sequence.current
    try {
      const found = await run()
      if (mounted.current && request === sequence.current) setListing(found)
    } catch (cause) {
      if (mounted.current) setError(failureDetail(cause, fallback))
    } finally {
      if (mounted.current) setChanging(false)
    }
  }

  async function paste(message: SessionMessageListRow): Promise<void> {
    const incarnationId = props.incarnationOf(message.receiverSessionId)
    if (incarnationId === null || pastingId !== null) return
    setPastingId(message.messageId)
    setError(null)
    setNotice(null)
    try {
      const record = await window.aiTerminal.pasteSessionMessage(message.messageId, incarnationId)
      if (!mounted.current) return
      if (record.state === 'pasted') setNotice(`Pasted into ${message.receiverName}. Enter was not pressed.`)
      else setError(`Not pasted: this message is already ${sessionMessageStateWord(record, Date.now())}.`)
    } catch (cause) {
      if (mounted.current) setError(failureDetail(cause, 'The message was not pasted'))
    } finally {
      if (mounted.current) {
        setPastingId(null)
        void load()
      }
    }
  }

  const on = props.workspace.sessionMessages === true
  const rows = listing ? messageRows(listing, props.now) : []
  const pause = listing ? messagePauseControl(listing) : null
  const handover = messageHandover()

  return (
    <Dialog label={`Messages — ${props.workspace.name}`} onClose={props.onClose} className="session-messages-dialog">
      <section className="inspector-section">
        <h3>
          This workspace
          {pause ? (
            <button type="button" disabled={changing}
              onClick={() => void change(() => window.aiTerminal.pauseSessionMessages(workspaceId, !pause.paused),
                pause.paused ? 'Messages were not resumed' : 'Messages were not paused')}>
              {pause.action}
            </button>
          ) : null}
        </h3>
        <dl className="kv">
          <dt>Messages</dt>
          <dd>{on ? 'On: sessions here may message each other' : 'Off. The switch is in this workspace’s menu: Sessions here may message each other'}</dd>
          <dt>New ones</dt>
          <dd>{pause ? pause.words : '…'}</dd>
          <dt>By its own hook</dt>
          <dd title={`A working agent gets a waiting message after a tool call: ${handover.byHook}`}>{handover.byHook}</dd>
          <dt>By your Paste</dt>
          <dd>Any session; the only way for {handover.byPaste}</dd>
        </dl>
        {SESSION_MESSAGES_HELP.map((line) => <small key={line}>{line}</small>)}
      </section>
      {listing && listing.pairPauses.length > 0 ? (
        <section className="inspector-section">
          <h3>Paused pairs</h3>
          <ul className="message-pairs">
            {listing.pairPauses.map((pair) => (
              <li key={`${pair.firstSessionId} ${pair.secondSessionId}`}>
                <span>{messagePairPauseWords(pair)}</span>
                <button type="button" disabled={changing}
                  onClick={() => void change(() => window.aiTerminal.resumeSessionMessagePair(workspaceId, pair.firstSessionId, pair.secondSessionId),
                    'The pair was not resumed')}>
                  Resume
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="inspector-section">
        <h3>
          Latest messages
          <button type="button" onClick={() => { setError(null); setNotice(null); void load() }}>Refresh</button>
        </h3>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        {notice ? <p className="dialog-note" role="status">{notice}</p> : null}
        {listing === null && !unavailable ? <p className="dialog-note" role="status">Reading…</p> : null}
        {unavailable ? <p className="dialog-note" role="status">Messages are unavailable. Try Refresh.</p> : null}
        {listing !== null && rows.length === 0 ? (
          <p className="dialog-note">{on ? 'No messages yet. An agent leaves one with bmn tell.' : 'No messages. Nothing can be sent while the switch is off.'}</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="message-list" aria-label={`Latest messages, at most ${SESSION_MESSAGE_LIST_LIMIT}`}>
            {rows.map((row) => {
              const { message } = row
              const open = openId === message.messageId
              const control = open
                ? messagePasteControl(message, props.now, props.incarnationOf(message.receiverSessionId), pastingId === message.messageId)
                : null
              return (
                <li key={message.messageId}>
                  <button type="button" className="message-row" aria-expanded={open}
                    onClick={() => setOpenId(open ? null : message.messageId)}>
                    <span className="age">{relativeAge(message.sentAt, props.now)}</span>
                    <span className="route" title={row.route}>{row.route}</span>
                    <span className="state">{row.state}</span>
                    <span className="first-line">{row.firstLine}</span>
                  </button>
                  {open && control ? (
                    <div className="message-detail">
                      <pre className="message-text" aria-label="Message text">{message.text}</pre>
                      <p className="message-stamp" aria-label="Stamp">{message.stamp}</p>
                      <dl className="kv">
                        <dt>Sender’s folder</dt>
                        <dd className="path" title={message.senderRoot}><bdi>{message.senderRoot}</bdi></dd>
                        <dt>Sent</dt>
                        <dd>{localTime(message.sentAt)}</dd>
                      </dl>
                      <div className="message-actions">
                        {control.offered ? (
                          <button type="button" className="primary" disabled={control.disabled} onClick={() => void paste(message)}>
                            {control.label}
                          </button>
                        ) : null}
                        <small>{control.note}</small>
                      </div>
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
