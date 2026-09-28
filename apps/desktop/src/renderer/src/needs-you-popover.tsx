// MODULE: needs-you-popover.tsx - unresolved requests, unread sessions and recent request history under the header count
import { useEffect, useRef } from 'react'
import { stripFormatCharacters, type AttentionPrompt, type AttentionRecord } from '@bmn/protocol'
import { attentionProvenance, expiryText, isActionableAttention, openAttentionGroups, relativeAge } from './session-presentation'

export interface SessionPlace {
  workspace: string
  session: string
}

export interface UnreadEntry {
  sessionId: string
  reason: string
  at: string
}

/**
 * The agent's own question or permission, read-only: the owner answers in the terminal (or from Telegram);
 * this only shows what is being asked, option by option, instead of the flattened text. The command, folder
 * and option labels are stored exactly as the harness sent them, so they are cleaned here (Story 34.1).
 */
function PromptDetail(props: { prompt: AttentionPrompt }): React.JSX.Element {
  const { prompt } = props
  if (prompt.type === 'permission') {
    return (
      <div className="attention-prompt">
        {prompt.command ? <pre>{stripFormatCharacters(prompt.command)}</pre> : null}
        {prompt.cwd ? <span className="attention-prompt-where">in {stripFormatCharacters(prompt.cwd)}</span> : null}
      </div>
    )
  }
  const several = prompt.questions.length > 1
  return (
    <div className="attention-prompt">
      {prompt.questions.map((question, index) => (
        <section key={index} aria-label={question.header ?? `Question ${index + 1}`}>
          {several || question.header ? (
            <span className="attention-prompt-header">
              {several ? `${index + 1} of ${prompt.questions.length}` : null}
              {several && question.header ? ' · ' : null}
              {question.header}
            </span>
          ) : null}
          {several ? <p className="attention-prompt-text">{question.text}</p> : null}
          <ol>
            {question.options.map((option, optionIndex) => (
              <li key={optionIndex}>
                <span className="attention-prompt-label">{stripFormatCharacters(option.label)}</span>
                {option.description ? <span className="attention-prompt-description">{option.description}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
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
    return <><span>{place.workspace}</span><span className="separator">›</span><span className="name" title={place.session}>{place.session}</span></>
  }

  const kindLabel = (request: AttentionRecord): string =>
    request.kind === 'notice' ? 'Update' : `${request.kind[0]!.toUpperCase()}${request.kind.slice(1)}`

  const attentionItem = (request: AttentionRecord): React.JSX.Element => {
    const actionable = isActionableAttention(request)
    const place = props.place(request.sessionId)
    const age = relativeAge(request.openedAt, props.now)
    const expiry = expiryText(request.expiresAt, props.now)
    return (
      <article
        key={request.requestId}
        className={`attention-item ${actionable ? 'request' : 'update'}`}
        aria-label={[kindLabel(request), request.title, `${place.workspace} › ${place.session}`, age, expiry].filter(Boolean).join(' · ')}
      >
        <div className="where">
          <span className={`status-dot ${actionable ? 'needs-you' : ''}`} aria-hidden="true" />
          {where(request.sessionId)}
          <span className="attention-kind">{kindLabel(request)}</span>
          <span className="age">{expiry ? `${age} · ${expiry}` : age}</span>
        </div>
        <h3>{request.title}</h3>
        {request.prompt ? <PromptDetail prompt={request.prompt} /> : request.body ? <pre>{request.body}</pre> : null}
        <p className="seen">
          {actionable
            ? request.seenAt
              ? `Seen ${relativeAge(request.seenAt, props.now)} · still waiting for your response`
              : 'Not seen yet · needs your response'
            : request.seenAt
              ? `Seen ${relativeAge(request.seenAt, props.now)} · informational update`
              : 'Not seen yet · informational update'}
          {' · '}
          <span className="provenance">{attentionProvenance(request)}</span>
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => props.onOpenSession(request.sessionId, request)}>
            {request.kind === 'handoff' ? 'Open handoff' : actionable ? 'Open session' : 'Open update'}
          </button>
          <button type="button" onClick={() => props.onAcknowledge(request)} disabled={actionable && !!request.seenAt}>
            {actionable ? 'Acknowledge' : 'Dismiss'}
          </button>
          {actionable && request.kind !== 'handoff' ? (
            <button type="button" title="Close this request after answering it in the terminal" onClick={() => props.onMarkAnswered(request)}>
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
        <span>{responses.length} need response · {updates.length} {updates.length === 1 ? 'update' : 'updates'} · {props.unread.length} unread</span>
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
              <span>{request.title} · {attentionProvenance(request)}</span>
              <span className="age">{relativeAge(request.resolvedAt ?? request.openedAt, props.now)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}
