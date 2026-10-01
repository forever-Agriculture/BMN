// MODULE: needs-you-popover.tsx - unresolved requests, unread sessions and recent request history under the header count
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { stripFormatCharacters, manualChoiceQuestion, type AttentionPrompt, type AttentionPromptQuestion, type AttentionRecord } from '@bmn/protocol'
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

function QuestionChoices(props: {
  questions: AttentionPromptQuestion[]
  feedback: string
  onCopy?: ((text: string) => Promise<void>) | undefined
}): React.JSX.Element {
  const id = useId()
  const [answers, setAnswers] = useState(() => props.questions.map(() => ({ selected: [] as number[], other: '', typed: false })))
  const [copying, setCopying] = useState(false)
  const pendingCopy = useRef(false)
  const copyButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!copying && props.feedback) {
      copyButton.current?.focus()
      copyButton.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [copying, props.feedback])
  const values = props.questions.map((question, index) => {
    const answer = answers[index]!
    const selected = answer.selected.map((option) => question.options[option]!.label)
    if (answer.typed || question.options.length === 0) {
      if (!answer.other.trim()) return null
      selected.push(answer.other.trim())
    }
    return selected.length ? selected.join(', ') : null
  })
  const ready = values.every((value) => value !== null)
  return (
    <div className="attention-question-choices">
      {props.questions.map((question, index) => {
        const answer = answers[index]!
        const update = (change: Partial<typeof answer>): void => {
          setAnswers((current) => current.map((value, row) => row === index ? { ...value, ...change } : value))
        }
        return (
          <fieldset key={index} disabled={copying}>
            <legend>{stripFormatCharacters(question.text)}</legend>
            {question.options.map((option, optionIndex) => (
              <label key={optionIndex}>
                <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${id}-${index}`}
                  checked={answer.selected.includes(optionIndex)} onChange={() => {
                    update({ selected: question.multiSelect
                      ? answer.selected.includes(optionIndex) ? answer.selected.filter((value) => value !== optionIndex) : [...answer.selected, optionIndex]
                      : [optionIndex], ...(!question.multiSelect ? { typed: false } : {}) })
                  }} />
                <span><span className="attention-prompt-label">{stripFormatCharacters(option.label)}</span>
                  {option.description ? <span className="attention-prompt-description">{stripFormatCharacters(option.description)}</span> : null}</span>
              </label>
            ))}
            {question.options.length > 0 && question.custom !== false ? (
              <label><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${id}-${index}`}
                checked={answer.typed} onChange={() => update({ typed: !answer.typed, ...(!question.multiSelect ? { selected: [] } : {}) })} />
                {question.options.some((option) => /^other(?:\.{3}|…)?$/i.test(option.label.trim())) ? 'Write answer' : 'Other'}</label>
            ) : null}
            {question.options.length === 0 && question.custom === false ? <p>Answer this question in the terminal.</p> : null}
            {(answer.typed || question.options.length === 0) && question.custom !== false ? (
              <label className="attention-other">Your answer
                <textarea rows={2} value={answer.other} onChange={(event) => update({ other: event.target.value })} />
              </label>
            ) : null}
          </fieldset>
        )
      })}
      <p className="attention-copy-note">Copy your answer, then paste it into the terminal.</p>
      {props.feedback ? <p role="status" className="inline-error">{props.feedback}</p> : null}
      <button ref={copyButton} type="button" disabled={!ready || copying || !props.onCopy} onClick={() => {
        if (!ready || pendingCopy.current || !props.onCopy) return
        pendingCopy.current = true
        setCopying(true)
        const text = values.map((value, index) => values.length === 1 ? value!
          : `${stripFormatCharacters(props.questions[index]!.text)}: ${value!}`).join('\n')
        // The popover owns the outcome so it remains visible when this question is replaced.
        void props.onCopy(text).catch(() => undefined)
          .finally(() => { pendingCopy.current = false; setCopying(false) })
      }}>{copying ? 'Copying…' : 'Copy answer'}</button>
    </div>
  )
}

/** Permission details remain read-only; opening or dismissing grants nothing. */
function PermissionDetail(props: { prompt: Extract<AttentionPrompt, { type: 'permission' }> }): React.JSX.Element {
  return (
    <div className="attention-prompt">
      {props.prompt.command ? <pre>{stripFormatCharacters(props.prompt.command)}</pre> : null}
      {props.prompt.cwd ? <span className="attention-prompt-where">in {stripFormatCharacters(props.prompt.cwd)}</span> : null}
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
  onCopyAnswer?(request: AttentionRecord, text: string): Promise<void>
  handoffDestination?(request: AttentionRecord): (SessionPlace & { cwd: string }) | null
  onMarkAnswered(request: AttentionRecord): void
  onClose(): void
}): React.JSX.Element {
  const element = useRef<HTMLElement>(null)
  const focusedRequest = useRef<{ id: string; revision: number } | null>(null)
  const [actionFeedback, setActionFeedback] = useState('')
  const [copyFeedbackFor, setCopyFeedbackFor] = useState<string | null>(null)
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

  useLayoutEffect(() => {
    const focused = focusedRequest.current
    if (!focused || props.requests.some(request => request.state === 'open' &&
      request.requestId === focused.id && request.revision === focused.revision)) return
    // Keep focus elsewhere if the owner moved it while this action was pending.
    if (document.activeElement !== document.body && document.activeElement !== document.documentElement) return
    const next = element.current?.querySelector<HTMLButtonElement>('.attention-group .attention-item button.primary')
    focusedRequest.current = null
    const target = next ?? props.anchor
    target?.focus()
    target?.scrollIntoView({ block: 'nearest' })
  }, [props.requests, props.anchor])

  const where = (sessionId: string): React.JSX.Element => {
    const place = props.place(sessionId)
    return <><span>{place.workspace}</span><span className="separator">›</span><span className="name" title={place.session}>{place.session}</span></>
  }

  const kindLabel = (request: AttentionRecord): string =>
    request.manualChoices ? request.kind === 'permission' ? 'Manual decision' : 'Manual question'
      : request.kind === 'notice' ? 'Update' : `${request.kind[0]!.toUpperCase()}${request.kind.slice(1)}`

  const attentionItem = (request: AttentionRecord): React.JSX.Element => {
    const actionable = isActionableAttention(request)
    const place = props.place(request.sessionId)
    const age = relativeAge(request.openedAt, props.now)
    const expiry = expiryText(request.expiresAt, props.now)
    const destination = request.kind === 'handoff' ? props.handoffDestination?.(request) : null
    return (
      <article
        key={request.requestId}
        data-request-id={request.requestId}
        data-request-revision={request.revision}
        className={`attention-item ${actionable ? 'request' : 'update'}`}
        aria-label={[kindLabel(request), request.title, `${place.workspace} › ${place.session}`, age, expiry].filter(Boolean).join(' · ')}
      >
        <div className="where">
          <span className={`status-dot ${actionable ? 'needs-you' : ''}`} aria-hidden="true" />
          {where(request.sessionId)}
          <span className="attention-kind">{kindLabel(request)}</span>
          <span className="age">{expiry ? `${age} · ${expiry}` : age}</span>
        </div>
        {!(request.manualChoices || request.prompt?.type === 'questions' && request.prompt.questions.length === 1 &&
          request.prompt.questions[0]!.text === request.title) ?
          <h3>{destination ? `Handoff to ${destination.workspace} › ${destination.session}` : request.title}</h3> : null}
        {destination ? <p className="attention-destination">{destination.cwd}</p> : null}
        {request.manualChoices || request.prompt?.type === 'questions' ? <QuestionChoices key={`${request.requestId}:${request.revision}`}
          questions={request.manualChoices ? [manualChoiceQuestion(request.title, request.manualChoices)] : request.prompt?.type === 'questions' ? request.prompt.questions : []} feedback={copyFeedbackFor === `${request.requestId}:${request.revision}` ? actionFeedback : ''}
          onCopy={props.onCopyAnswer ? async (text) => {
            setCopyFeedbackFor(`${request.requestId}:${request.revision}`)
            setActionFeedback('')
            try {
              await props.onCopyAnswer!(request, text)
              setActionFeedback('Answer copied; not submitted')
            } catch (error) {
              setActionFeedback(error instanceof Error ? error.message : 'Could not copy. Try again.')
              throw error
            }
          } : undefined} />
          : request.prompt ? <PermissionDetail prompt={request.prompt} /> : request.body ? <pre>{request.body}</pre> : null}
        {request.manualChoices && request.body ? <pre>{request.body}</pre> : null}
        <p className="seen">
          {actionable
            ? request.seenAt
              ? `Seen ${relativeAge(request.seenAt, props.now)} · awaiting answer`
              : 'Unseen · awaiting answer'
            : request.seenAt
              ? `Seen ${relativeAge(request.seenAt, props.now)} · update`
              : 'Unseen · update'}
          {' · '}
          <span className="provenance">{attentionProvenance(request)}</span>
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => props.onOpenSession(request.sessionId, request)}>
            {request.kind === 'handoff' ? 'Open handoff' : actionable ? 'Open session' : 'Open update'}
          </button>
          <button type="button" onClick={() => props.onAcknowledge(request)} title="Clear this reminder; keep the task or draft.">
            Dismiss
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
      onFocusCapture={(event) => {
        const request = (event.target as HTMLElement).closest<HTMLElement>('.attention-item[data-request-id]')
        focusedRequest.current = request ? { id: request.dataset.requestId!, revision: Number(request.dataset.requestRevision) } : null
      }}
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
      {actionFeedback && !props.requests.some(request => request.state === 'open' &&
        `${request.requestId}:${request.revision}` === copyFeedbackFor) ? <p role="status">{actionFeedback}</p> : null}
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
              <span>{request.title} · {request.resolvedBy === 'owner' && request.resolution ? request.resolution : attentionProvenance(request)}</span>
              <span className="age">{relativeAge(request.resolvedAt ?? request.openedAt, props.now)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}
