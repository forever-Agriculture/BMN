// MODULE: away-check.tsx - the Away check in the window head: a state, not attention (Story 76.3, Fable's notes 76.1)
import { awaySinceWords, type OwnerAwayView } from '@bmn/protocol'

/** Who said it, as the tooltip words it (Fable 76.1 §1). */
export function awaySourceWords(view: Pick<OwnerAwayView, 'source' | 'agentSessionId'>, sessionName: (sessionId: string) => string | null): string {
  switch (view.source) {
    case 'app': return 'set here'
    case 'cli': return 'set with bmn away'
    case 'telegram': return 'set from Telegram'
    case 'agent': return `set by ${(view.agentSessionId && sessionName(view.agentSessionId)) || 'an agent'} on your words`
    default: return 'set'
  }
}

/** The tooltip: what the check does, or since when, who set it, his note, and how it ends. */
export function awayTooltip(view: OwnerAwayView | null, now: Date, sessionName: (sessionId: string) => string | null): string {
  if (view?.state !== 'away' || view.since === null) {
    return 'Away: every agent is told, decides what is ordinary and leaves what is yours as cards.\nUncheck, bmn back or /back when you return.'
  }
  return [
    `${awaySinceWords(view.since, now)} · ${awaySourceWords(view, sessionName)}`,
    ...(view.note ? [`Note: ${view.note}`] : []),
    'The words open the summary so far. Uncheck when you are back.'
  ].join('\n')
}

/**
 * A native checkbox and its words, first in the head's actions. Checking says away at once and asks nothing; only the box
 * (or bmn back, /back, his words to an agent) ends it; desk input never does.
 */
export function AwayCheck(props: {
  view: OwnerAwayView | null
  now: Date
  sessionName(sessionId: string): string | null
  onChange(to: 'away' | 'back'): void
  /** Checked, the words are a button that opens the summary so far (76.3 AC3); only the box ends away. */
  onOpenSummary?(): void
}): React.JSX.Element {
  const away = props.view?.state === 'away' && props.view.since !== null
  const words = away ? awaySinceWords(props.view!.since!, props.now) : 'Away'
  const title = awayTooltip(props.view, props.now, props.sessionName)
  const box = (
    <input type="checkbox" checked={away} disabled={props.view === null} aria-label={away ? 'Away; uncheck when you are back' : undefined}
      onChange={(event) => props.onChange(event.target.checked ? 'away' : 'back')} />
  )
  if (away && props.onOpenSummary) {
    return (
      <span className="away-check" data-away title={title}>
        {box}
        <button type="button" className="away-words" onClick={props.onOpenSummary}>{words}</button>
      </span>
    )
  }
  return (
    <label className="away-check" data-away={away || undefined} title={title}>
      {box}
      <span className="away-words">{words}</span>
    </label>
  )
}
