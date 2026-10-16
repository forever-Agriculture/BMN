// MODULE: turn-changes-card.tsx - the card a paused recording of turn changes shows once on its own session, with when BMN tries again (Epic 69, Story 75.4)
import { useEffect, useRef } from 'react'
import { TURN_PAUSE_REASONS, type TurnRecordingState } from '@bmn/protocol'
import { guardPath } from './session-guard-card'
import type { SessionPlace } from './session-request-card'
import { turnAppName, turnRetryWords } from './turn-changes-presentation'

export const TURN_PAUSE_HEADING = 'Recording what each turn changes is paused here'

/**
 * Recording paused for a session's work tree after three scans in a row failed or read nothing new. The card
 * shows once for a pause, under that session's header; after it the header's plate reads "Paused". It lives in
 * the window only, as the prompt guard's card does: it is not a request and reaches no snapshot, token or phone.
 * It only says so: BMN tries again by itself (Story 75.4), and nothing here is pressed but Close.
 */
export function TurnPauseCard(props: {
  state: TurnRecordingState
  place: SessionPlace
  home: string | null
  anchor: HTMLElement | null
  onClose(returnFocus: boolean): void
}): React.JSX.Element {
  const element = useRef<HTMLElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useEffect(() => {
    element.current?.querySelector<HTMLButtonElement>('.actions button')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!element.current?.contains(target) && !props.anchor?.contains(target)) onClose.current(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [props.anchor])

  const rect = props.anchor?.getBoundingClientRect()
  const top = rect ? Math.min(rect.bottom + 6, window.innerHeight - 140) : 90
  return <section ref={element} className="session-request-card session-guard-card" role="dialog" aria-label="Turn changes"
    style={rect ? { top, '--request-top': `${top}px`, left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)) } as React.CSSProperties : undefined}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(true) }
    }}>
    <header><strong>Paused</strong><span>stays on this computer</span>
      <button type="button" aria-label="Close turn changes" onClick={() => props.onClose(true)}>×</button></header>
    <article className="attention-item update" aria-label={`Paused · ${props.place.workspace} › ${props.place.session}`}>
      <div className="where">
        <span className="status-dot" aria-hidden="true" />
        <span>{props.place.workspace}</span><span className="separator">›</span><span className="name" title={props.place.session}>{props.place.session}</span>
        {props.state.app === null ? null : <span className="attention-kind">{turnAppName(props.state.app)}</span>}
      </div>
      <h3>{TURN_PAUSE_HEADING}</h3>
      <dl className="guard-facts">
        {props.state.pausedRoot ? <><dt>Work tree</dt><dd className="mono" title={props.state.pausedRoot}>{guardPath(props.state.pausedRoot, props.home)}</dd></> : null}
        {props.state.pauseReason === null ? null : <><dt>Reason</dt><dd>{TURN_PAUSE_REASONS[props.state.pauseReason]}</dd></>}
      </dl>
      <p className="seen">BMN scans nothing here for now and {turnRetryWords(props.state.retryAt, Date.now())}. Each try that fails waits longer.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={() => props.onClose(true)}>Close</button>
      </div>
    </article>
  </section>
}
