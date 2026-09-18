// MODULE: needs-you-popover.tsx - unresolved requests, unread sessions and recent request history under the header count
import { useEffect, useRef } from 'react'
import type { AttentionRecord } from '@bmn/protocol'
import { isActionableAttention, openAttentionGroups, relativeAge } from './session-presentation'

export interface SessionPlace {
  workspace: string
  session: string
}

export interface UnreadEntry {
  sessionId: string
  reason: string
  at: string
}

export function NeedsYouPopover(props: {
  requests: AttentionRecord[]
  unread: UnreadEntry[]
  place(sessionId: string): SessionPlace
  now: number
  anchor: HTMLElement | null
  onOpenSession(sessionId: string, request: AttentionRecord | null): void
  onAcknowledge(request: AttentionRecord): void
  onMarkAnswered(request: AttentionRecord): void
  onClose(): void
}): React.JSX.Element {
  const element = useRef<HTMLElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  const { responses, updates } = openAttentionGroups(props.requests)
  const openCount = responses.length + updates.length
  const recent = props.requests
    .filter((request) => request.state !== 'open')
    .toSorted((left, right) =>
      (right.resolvedAt ?? right.openedAt).localeCompare(left.resolvedAt ?? left.openedAt) ||
      left.requestId.localeCompare(right.requestId))
    .slice(0, 5)

  useEffect(() => {
    element.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!element.current?.contains(target) && !props.anchor?.contains(target)) onClose.current()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])

  const where = (sessionId: string): React.JSX.Element => {
    const place = props.place(sessionId)
    return <><span>{place.workspace}</span><span className="separator">›</span><span className="name">{place.session}</span></>
  }

  const kindLabel = (request: AttentionRecord): string =>
    request.kind === 'notice' ? 'Update' : `${request.kind[0]!.toUpperCase()}${request.kind.slice(1)}`

  const attentionItem = (request: AttentionRecord): React.JSX.Element => {
    const actionable = isActionableAttention(request)
    return (
      <article key={request.requestId} className={`attention-item ${actionable ? 'request' : 'update'}`}>
        <div className="where">
          <span className={`status-dot ${actionable ? 'needs-you' : ''}`} aria-hidden="true" />
          {where(request.sessionId)}
          <span className="attention-kind">{kindLabel(request)}</span>
          <span className="age">{relativeAge(request.openedAt, props.now)}</span>
        </div>
        <h3>{request.title}</h3>
        {request.body ? <pre>{request.body}</pre> : null}
        <p className="seen">
          {actionable
            ? request.seenAt
              ? `Seen ${relativeAge(request.seenAt, props.now)} · still waiting for your response`
              : 'Not seen yet · needs your response'
            : request.seenAt
              ? `Seen ${relativeAge(request.seenAt, props.now)} · informational update`
              : 'Not seen yet · informational update'}
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => props.onOpenSession(request.sessionId, request)}>
            {actionable ? 'Open session' : 'Open update'}
          </button>
          <button type="button" onClick={() => props.onAcknowledge(request)} disabled={actionable && !!request.seenAt}>
            {actionable ? 'Acknowledge' : 'Dismiss'}
          </button>
          {actionable ? (
            <button type="button" className="ghost" title="Close this request after answering it in the terminal" onClick={() => props.onMarkAnswered(request)}>
              Mark answered
            </button>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <section
      ref={element}
      className="needs-you-popover"
      role="dialog"
      aria-label="Needs you"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
        }
      }}
    >
      <header>
        <strong>Needs you</strong>
        <span>{responses.length} need response · {updates.length} updates · {props.unread.length} unread</span>
        <kbd>Ctrl Shift U</kbd>
      </header>
      {openCount === 0 ? <p className="popover-empty">No requests or updates.</p> : null}
      {responses.length > 0 ? (
        <div className="attention-group" aria-label="Needs your response">
          <span className="eyebrow">Needs your response · {responses.length}</span>
          {responses.map(attentionItem)}
        </div>
      ) : null}
      {updates.length > 0 ? (
        <div className="attention-group" aria-label="Updates">
          <span className="eyebrow">Updates · {updates.length}</span>
          {updates.map(attentionItem)}
        </div>
      ) : null}
      {props.unread.length > 0 ? (
        <div className="popover-section">
          <span className="eyebrow">Unread</span>
          {props.unread.map((entry) => (
            <button key={entry.sessionId} type="button" className="popover-row" onClick={() => props.onOpenSession(entry.sessionId, null)}>
              <span className="status-dot" aria-hidden="true" />
              {where(entry.sessionId)}
              <span>{entry.reason}</span>
              <span className="age">{relativeAge(entry.at, props.now)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {recent.length > 0 ? (
        <div className="popover-section">
          <span className="eyebrow">Recent</span>
          {recent.map((request) => (
            <button key={request.requestId} type="button" className="popover-row" onClick={() => props.onOpenSession(request.sessionId, null)}>
              {where(request.sessionId)}
              <span>{request.title} · {request.state}</span>
              <span className="age">{relativeAge(request.resolvedAt ?? request.openedAt, props.now)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}
