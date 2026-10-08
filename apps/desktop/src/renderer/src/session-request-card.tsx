// MODULE: session-request-card.tsx - read-only request details and explicit owner actions over the pane
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stripFormatCharacters, manualChoiceQuestion, type AttentionRecord, type TelegramStatus } from '@bmn/protocol'
import { attentionProvenance, expiryText, isActionableAttention, openRequests, relativeAge } from './session-presentation'

export interface SessionPlace { workspace: string; session: string }
export interface ClearedNotice { request: AttentionRecord; phone: TelegramStatus['quietHours'] | undefined }

export function SessionRequestCard(props: {
  requests: AttentionRecord[]
  cleared: ClearedNotice[]
  phone?: TelegramStatus['quietHours'] | undefined
  place(sessionId: string): SessionPlace
  now: number
  anchor: HTMLElement | null
  onOpenHandoff(request: AttentionRecord): void
  onAcknowledge(request: AttentionRecord): void
  handoffDestination?(request: AttentionRecord): (SessionPlace & { cwd: string }) | null
  onMarkAnswered(request: AttentionRecord): void
  onClose(returnFocus: boolean): void
}): React.JSX.Element {
  const element = useRef<HTMLElement>(null)
  const [, resizeVersion] = useState(0)
  const focusedRequest = useRef<string | null>(null)
  const previous = useRef<string[]>([])
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  const requests = openRequests(props.requests)
  const keys = requests.map(request => `${request.requestId}:${request.revision}`)

  useEffect(() => {
    const resize = (): void => resizeVersion(value => value + 1)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    element.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!element.current?.contains(target) && !props.anchor?.contains(target)) onClose.current(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])

  useLayoutEffect(() => {
    const old = previous.current
    previous.current = keys
    const lostFocus = document.activeElement === document.body || document.activeElement === document.documentElement
    if (!requests.length && !props.cleared.length) {
      onClose.current(lostFocus || !!element.current?.contains(document.activeElement))
      return
    }
    const focused = focusedRequest.current
    if (!focused || keys.includes(focused) || !lostFocus) return
    const index = old.indexOf(focused)
    const targetKey = [...old.slice(index + 1), ...old.slice(0, Math.max(index, 0)).reverse()]
      .find(key => keys.includes(key)) ?? keys[0]
    const articles = Array.from(element.current?.querySelectorAll<HTMLElement>('article') ?? [])
    const article = articles.find(item => `${item.dataset.requestId}:${item.dataset.requestRevision}` === targetKey)
    const target = article?.querySelector<HTMLButtonElement>('button') ?? element.current?.querySelector<HTMLButtonElement>('button')
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  })

  const item = (request: AttentionRecord, cleared: boolean, phone = props.phone): React.JSX.Element => {
    const actionable = isActionableAttention(request)
    const place = props.place(request.sessionId)
    const age = relativeAge(request.openedAt, props.now)
    const expiry = expiryText(request.expiresAt, props.now)
    const kind = request.manualChoices ? request.kind === 'permission' ? 'Manual decision' : 'Manual question'
      : request.kind === 'notice' ? 'Update' : `${request.kind[0]!.toUpperCase()}${request.kind.slice(1)}`
    const destination = request.kind === 'handoff' ? props.handoffDestination?.(request) : null
    const questions = request.manualChoices ? [manualChoiceQuestion(request.title, request.manualChoices)]
      : request.prompt?.type === 'questions' ? request.prompt.questions : null
    return <article key={`${request.requestId}:${request.revision}:${cleared}`} data-request-id={request.requestId}
      data-request-revision={request.revision} data-cleared={cleared || undefined}
      className={`attention-item ${cleared ? 'cleared' : actionable ? 'request' : 'update'}`}
      aria-label={[kind, request.title, `${place.workspace} › ${place.session}`, age, expiry, cleared ? 'Cleared' : null].filter(Boolean).join(' · ')}>
      <div className="where">
        {!cleared ? <span className={`status-dot ${actionable ? 'needs-you' : ''}`} aria-hidden="true" /> : null}
        <span>{place.workspace}</span><span className="separator">›</span><span className="name" title={place.session}>{place.session}</span>
        <span className="attention-kind">{cleared ? 'Cleared update' : kind}</span>
        <span className="age">{expiry ? `${age} · ${expiry}` : age}</span>
      </div>
      {!(request.manualChoices || questions?.length === 1 && questions[0]?.text === request.title) ? <h3>{destination ? `Handoff to ${destination.workspace} › ${destination.session}` : request.title}</h3> : null}
      {destination ? <p className="attention-destination">{destination.cwd}</p> : null}
      {questions ? <div className="attention-questions">{questions.map((question, index) =>
        <section key={index} aria-label={stripFormatCharacters(question.text)}>
          <h4>{stripFormatCharacters(question.text)}</h4>
          <ul>{question.options.map((option, optionIndex) => <li key={optionIndex}>
            <span className="attention-prompt-label">{stripFormatCharacters(option.label)}</span>
            {option.description ? <span className="attention-prompt-description">{stripFormatCharacters(option.description)}</span> : null}
          </li>)}</ul>
        </section>)}</div> : request.prompt?.type === 'permission' ? <div className="attention-prompt">
          {request.prompt.command ? <pre>{stripFormatCharacters(request.prompt.command)}</pre> : null}
          {request.prompt.cwd ? <span className="attention-prompt-where">in {stripFormatCharacters(request.prompt.cwd)}</span> : null}
        </div> : null}
      {request.body && (!questions || request.manualChoices) ? <pre>{stripFormatCharacters(request.body)}</pre> : null}
      <p className="seen">{request.seenAt ? `Seen ${relativeAge(request.seenAt, props.now)}` : 'Unseen'}
        {` · ${cleared ? 'reminder cleared' : actionable ? 'awaiting answer' : 'update'} · `}
        <span className="provenance">{attentionProvenance(request)}</span></p>
      {phone?.requests[request.requestId] ? <p className="seen">{phone.requests[request.requestId] === 'uncertain'
        ? 'Phone: may not have arrived' : phone.active ? `Phone: held until ${phone.until}` : 'Phone: waiting for delivery'}</p> : null}
      {phone?.uncertainRevisions[request.requestId]?.some(revision => revision !== request.revision)
        ? <p className="seen">Phone: an earlier revision may not have arrived</p> : null}
      {!cleared ? <div className="actions">
        {request.kind === 'handoff' ? <button type="button" className="primary" onClick={() => props.onOpenHandoff(request)}>Open handoff</button> : null}
        <button type="button" className={request.kind === 'handoff' ? undefined : 'primary'}
          onClick={() => props.onAcknowledge(request)} title="Clear this reminder; keep the task or draft.">Dismiss</button>
        {actionable && request.kind !== 'handoff' ? <button type="button" title="Close this request after answering it in the terminal"
          onClick={() => props.onMarkAnswered(request)}>Mark answered</button> : null}
      </div> : null}
    </article>
  }

  const rect = props.anchor?.getBoundingClientRect()
  const top = rect ? Math.min(rect.bottom + 6, window.innerHeight - 140) : 90
  return <section ref={element} className="session-request-card" role="dialog" aria-label="Session requests"
    style={rect ? { top, '--request-top': `${top}px`, left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)) } as React.CSSProperties : undefined}
    onFocusCapture={event => {
      const article = (event.target as HTMLElement).closest<HTMLElement>('article[data-request-id]')
      focusedRequest.current = article ? `${article.dataset.requestId}:${article.dataset.requestRevision}` : null
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(true) }
    }}>
    <header><strong>Session requests</strong><span>{requests.length} open</span>
      <button type="button" aria-label="Close session requests" onClick={() => props.onClose(true)}>×</button></header>
    {requests.map(request => item(request, false))}
    {props.cleared.map(snapshot => item(snapshot.request, true, snapshot.phone))}
  </section>
}
