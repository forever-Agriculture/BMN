// MODULE: session-guard-card.tsx - Story 60.8: the card a stopped prompt raises on its own session, with Allow here and Keep blocked
import { useEffect, useRef } from 'react'
import { ROSTER_APP_NAMES, stripFormatCharacters, type GuardStop } from '@bmn/protocol'
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
 * What BMN did, in two words. BMN answers the app's prompt hook with "stop"; that the installed
 * version of the app obeys has not been shown by a live test yet (60.8, R60-NFR4), so the card
 * and the mark say what BMN did, never that the prompt went nowhere.
 */
export const GUARD_STOP_WORDS = 'Told to stop'

/** The words on the session's own mark, in its pane header. */
export function guardMark(stop: GuardStop): string {
  if (stop.outcome === 'stop') return GUARD_STOP_WORDS
  return stop.cause === 'public-only' || stop.cause === 'declared' ? 'Public-only provider on private work' : 'Unknown destination on private work'
}

/** What happens next, in one sentence under the agent's own line. */
export function guardNote(stop: GuardStop): string {
  const app = ROSTER_APP_NAMES[stop.agent]
  if (stop.outcome === 'warn') return `${app} cannot be told to stop a prompt, so this one went on. BMN only warns in ${app}.`
  if (stop.allow) return `Allow here adds this one workspace for ${stop.providerName ?? 'this provider'} to your team as a new version. Then send the prompt again.`
  return 'Send the prompt again once this is fixed.'
}

/** What a stop is, and what is not yet known about it; nothing for a warning, whose note already says the prompt went on. */
export function guardCaveat(stop: GuardStop): string | null {
  const app = ROSTER_APP_NAMES[stop.agent]
  return stop.outcome === 'stop' ? `BMN told ${app} to stop this prompt. No test has yet shown that this version of ${app} obeys, so check that the agent did not answer.` : null
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
    <header><strong>{stop.outcome === 'stop' ? GUARD_STOP_WORDS : 'Prompt went on'}</strong><span>stays on this computer</span>
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
      {guardCaveat(stop) ? <p className="seen">{guardCaveat(stop)}</p> : null}
      <p className="seen">{guardNote(stop)}</p>
      {props.refusal ? <p className="guard-refusal" role="alert">{props.refusal}</p> : null}
      <div className="actions">
        {stop.allow ? <button type="button" className="primary" disabled={props.busy} onClick={props.onAllow}>Allow here</button> : null}
        {stop.kept ? null
          : <button type="button" className={stop.allow ? undefined : 'primary'} disabled={props.busy} onClick={props.onKeep}
            title="Close this card; the session keeps its mark.">{stop.outcome === 'warn' ? 'Dismiss' : stop.allow ? 'Keep blocked' : 'Close'}</button>}
      </div>
    </article>
  </section>
}
