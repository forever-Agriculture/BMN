// MODULE: roster-marks.tsx - Epic 60.5: shape carries meaning (sigil by title, seal by security, pips by trust); colour stays text grey
import type { RosterAgentShape } from '@bmn/protocol'
import { Icon } from './icons'

/** Knight: the shell's sword. Squire: a pennon. */
export function Sigil(props: { title: RosterAgentShape['title'] }): React.JSX.Element {
  return (
    <span className="mark" role="img" aria-label={props.title === 'knight' ? 'Knight' : 'Squire'}>
      {props.title === 'knight' ? <Icon name="sword" /> : (
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.4 1h1.3v14H3.4Zm1.3 1.6 9.2 3.3-9.2 3.3Z" /></svg>
      )}
    </span>
  )
}

/**
 * Seals are rings, a different family from the small solid trust pips: High is a ring sealed by a
 * filled core, Low the same ring left empty. No gap or arc, which would read as a refresh control.
 */
export function SealShape(props: { level: RosterAgentShape['security'] }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {props.level === 'high' ? <circle cx="8" cy="8" r="2.75" fill="currentColor" /> : null}
    </svg>
  )
}

export function Seal(props: { level: RosterAgentShape['security'] }): React.JSX.Element {
  return <span className="mark" role="img" aria-label={`Security ${props.level}`}><SealShape level={props.level} /></span>
}

/** One to three filled pips of three; empty pips are hollow. */
export function PipsShape(props: { count: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 16" aria-hidden="true" focusable="false">
      {[3, 9, 15].map((cx, index) => index < props.count
        ? <circle key={cx} cx={cx} cy="8" r="1.8" fill="currentColor" />
        : <circle key={cx} cx={cx} cy="8" r="1.4" fill="none" stroke="currentColor" strokeWidth=".8" opacity=".55" />)}
    </svg>
  )
}

export function Pips(props: { count: number }): React.JSX.Element {
  return <span className="mark pips" role="img" aria-label={`Trust ${props.count} of 3`}><PipsShape count={props.count} /></span>
}
