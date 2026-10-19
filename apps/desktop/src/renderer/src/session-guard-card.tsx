// MODULE: session-guard-card.tsx - Story 60.8: the card a stopped prompt raises on its own session, with Allow here and Keep blocked
import { useEffect, useRef } from 'react'
import { GUARD_MEASURED, ROSTER_APP_NAMES, stripFormatCharacters, type GuardStop } from '@bmn/protocol'
import { relativeAge } from './session-presentation'
import type { SessionPlace } from './session-request-card'

/** A path under the owner's home folder written with `~`, as the agent's own line writes it. */
export function guardPath(path: string, home: string | null): string {
  if (home === null || home === '' || home === '/') return path
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Who the card is about: the team's agent with its provider, or the provider alone. */
function guardSubject(stop: GuardStop): string {
  const provider = stop.providerName ?? stop.providerId ?? 'This provider'
  return stop.agentName ? `${stop.agentName} (${provider})` : provider
}

export function guardTitle(stop: GuardStop): string {
  const app = ROSTER_APP_NAMES[stop.agent]
  if (stop.allow) return `Allow ${guardSubject(stop)} in this workspace?`
  switch (stop.cause) {
    case 'public-only':
    case 'declared': return `${stop.providerName ?? 'This provider'} can't see private work here`
    case 'unknown': return `BMN can't tell where this ${app} session sends work`
    case 'state': return 'BMN can\'t read the approved team'
    case 'process': return `BMN can't read how this ${app} session was started`
    case 'slow': return 'The check took too long'
  }
}

/**
 * What BMN did, in two words. BMN answers the app's prompt hook with "stop"; a live test showed
 * the app obeys on the versions in `GUARD_MEASURED` only (60.8, R60-NFR4), and BMN does not know
 * the session's version, so the card and the mark say what BMN did, never that the prompt went nowhere.
 */
export const GUARD_STOP_WORDS = 'Told to stop'

/** What happens next, in one sentence under the agent's own line. */
export function guardNote(stop: GuardStop): string {
  if (stop.allow) return `Allow here adds this one workspace for ${stop.providerName ?? 'this provider'} to your team as a new version. Then send the prompt again.`
  return 'Send the prompt again once this is fixed.'
}

/** What a stop is, and what is known about it. */
function guardCaveat(stop: GuardStop): string {
  const app = ROSTER_APP_NAMES[stop.agent]
  const measured = GUARD_MEASURED[stop.agent]
  return measured === undefined
    ? `BMN told ${app} to stop this prompt. No test has shown that this version of ${app} obeys; check that it did not answer.`
    : `BMN told ${app} to stop this prompt. A live test showed ${app} ${measured} obeys; on another version, check that it did not answer.`
}

export function SessionGuardCard(props: {
  stop: GuardStop
  place: SessionPlace
  home: string | null
  now: number
  anchor: HTMLElement | null
  busy: boolean
  /** Why the last Allow here was refused; null when none was. */
  refusal: string | null
  onAllow(): void
  onKeep(): void
  onClose(returnFocus: boolean): void
}): React.JSX.Element {
  const { stop } = props
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
  const title = guardTitle(stop)
  return <section ref={element} className="session-request-card session-guard-card" role="dialog" aria-label="Prompt guard"
    style={rect ? { top, '--request-top': `${top}px`, left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)) } as React.CSSProperties : undefined}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(true) }
    }}>
    <header><strong>{GUARD_STOP_WORDS}</strong><span>stays on this computer</span>
      <button type="button" aria-label="Close prompt guard" onClick={() => props.onClose(true)}>×</button></header>
    <article className={`attention-item ${stop.kept ? 'update' : 'request'}`} aria-label={`${title} · ${props.place.workspace} › ${props.place.session}`}>
      <div className="where">
        <span className={`status-dot ${stop.kept ? '' : 'needs-you'}`} aria-hidden="true" />
        <span>{props.place.workspace}</span><span className="separator">›</span><span className="name" title={props.place.session}>{props.place.session}</span>
        <span className="attention-kind">{ROSTER_APP_NAMES[stop.agent]}</span>
        <span className="age">{relativeAge(stop.at, props.now)}</span>
      </div>
      <h3>{title}</h3>
      <p className="guard-line">{stripFormatCharacters(stop.line)}</p>
      {stop.workspace ? <dl className="guard-facts">
        <dt>Workspace</dt><dd className="mono" title={stop.workspace}>{guardPath(stop.workspace, props.home)}</dd>
        {stop.host && !stop.host.startsWith('default:') ? <><dt>Address</dt><dd className="mono">{stop.host}</dd></> : null}
      </dl> : null}
      <p className="seen">{guardCaveat(stop)}</p>
      <p className="seen">{guardNote(stop)}</p>
      {props.refusal ? <p className="guard-refusal" role="alert">{props.refusal}</p> : null}
      <div className="actions">
        {stop.allow ? <button type="button" className="primary" disabled={props.busy} onClick={props.onAllow}>Allow here</button> : null}
        {stop.kept ? null
          : <button type="button" className={stop.allow ? undefined : 'primary'} disabled={props.busy} onClick={props.onKeep}
            title="Close this card; the session keeps its mark.">{stop.allow ? 'Keep blocked' : 'Close'}</button>}
      </div>
    </article>
  </section>
}
