// MODULE: turn-changes-card.tsx - Story 69.4: what the owner reads before he switches "Record what each turn changes" on, and the card a paused recording raises on its own session
import { useEffect, useRef } from 'react'
import { TURN_CHANGES_HELP, TURN_CHANGES_SWITCH, TURN_PAUSE_REASONS, type TurnRecordingState } from '@bmn/protocol'
import { Dialog } from './dialog'
import { guardPath } from './session-guard-card'
import type { SessionPlace } from './session-request-card'

/** The words on the session's own mark, in its pane header. */
export const TURN_PAUSED_WORDS = 'Recording paused'

/** The switch's help, read before it goes on: with it on, BMN keeps copies of the work tree's files, secrets included. */
export function TurnChangesSwitchDialog(props: { workspaceName: string; onConfirm(): void; onClose(): void }): React.JSX.Element {
  return (
    <Dialog label={`${TURN_CHANGES_SWITCH} — ${props.workspaceName}`} onClose={props.onClose} className="session-messages-switch">
      <ul>
        {TURN_CHANGES_HELP.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p className="dialog-note">Recorded for Claude Code and Codex sessions in this workspace. Nothing is written into your repository, and no agent or phone can read a copy.</p>
      <div className="dialog-actions">
        <button type="button" className="ghost" autoFocus onClick={props.onClose}>Cancel</button>
        <button type="button" className="primary" onClick={() => { props.onClose(); props.onConfirm() }}>Switch on</button>
      </div>
    </Dialog>
  )
}

/**
 * Recording paused for a session's work tree after three scans in a row failed or read nothing new. It lives in
 * the window only, as the prompt guard's card does: it is not a request and reaches no snapshot, token or phone.
 */
export function TurnPauseCard(props: {
  state: TurnRecordingState
  place: SessionPlace
  home: string | null
  anchor: HTMLElement | null
  onResume(): void
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
  const reason = props.state.pauseReason === null ? TURN_PAUSED_WORDS : TURN_PAUSE_REASONS[props.state.pauseReason]
  return <section ref={element} className="session-request-card session-guard-card" role="dialog" aria-label="Turn changes"
    style={rect ? { top, '--request-top': `${top}px`, left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)) } as React.CSSProperties : undefined}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(true) }
    }}>
    <header><strong>{TURN_PAUSED_WORDS}</strong><span>stays on this computer</span>
      <button type="button" aria-label="Close turn changes" onClick={() => props.onClose(true)}>×</button></header>
    <article className="attention-item update" aria-label={`${TURN_PAUSED_WORDS} · ${props.place.workspace} › ${props.place.session}`}>
      <div className="where">
        <span className="status-dot" aria-hidden="true" />
        <span>{props.place.workspace}</span><span className="separator">›</span><span className="name" title={props.place.session}>{props.place.session}</span>
      </div>
      <h3>Turn changes are not recorded here</h3>
      <p className="guard-line">{reason}</p>
      {props.state.pausedRoot ? <dl className="guard-facts">
        <dt>Work tree</dt><dd className="mono" title={props.state.pausedRoot}>{guardPath(props.state.pausedRoot, props.home)}</dd>
      </dl> : null}
      <p className="seen">BMN scans nothing here until you resume. Resume is also in the workspace's menu.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={props.onResume}>Resume</button>
        <button type="button" onClick={() => props.onClose(true)}>Close</button>
      </div>
    </article>
  </section>
}
