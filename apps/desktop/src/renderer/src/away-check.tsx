// MODULE: away-check.tsx - the Away check in the window head: a state, not attention (Story 76.3, Fable's notes 76.1)
import { awayMomentWords, awaySinceWords, type OwnerAwayView, type OwnerGrantView } from '@bmn/protocol'

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
 * Story 84.3 (the notes §2): beside the check while he is leaving, or while a run's card is open: "leaving" (muted), or
 * "2 cards" in gold, the cards' only place. Both open Before you go.
 */
export function awayGrantWords(grant: OwnerGrantView | null | undefined, now: Date, sessionName: (sessionId: string) => string | null): { words: string; label: string; title: string; cards: boolean } | null {
  const period = grant?.period ?? null
  const cards = grant?.openCards ?? 0
  if (period === null || (period.state !== 'leaving' && cards === 0) || (period.state !== 'leaving' && period.state !== 'away')) return null
  if (cards > 0) {
    const askers = [...new Set(period.runs.filter((run) => run.card.state === 'open').map((run) => (run.card.sessionId && sessionName(run.card.sessionId)) || run.title))]
    const who = askers.length <= 1 ? askers[0] ?? 'A run' : `${askers.slice(0, -1).join(', ')} and ${askers.at(-1)}`
    const plural = cards === 1 ? 'card' : 'cards'
    return {
      words: `${cards} ${plural}`, label: `${cards} ${plural} before you go`, cards: true,
      title: `${who} ${askers.length > 1 ? 'ask' : 'asks'} before you go.\nA card you leave unanswered grants nothing. Away does not wait for them.`
    }
  }
  const said = period.startedBy === 'agent' ? `said to ${(period.agentSessionId && sessionName(period.agentSessionId)) || 'an agent'}`
    : period.startedBy === 'cli' ? 'said with bmn away --leaving' : period.startedBy === 'telegram' ? 'said from Telegram' : 'said here'
  return {
    words: 'leaving', label: 'Leaving: before you go', cards: false,
    title: `Leaving since ${awayMomentWords(period.startedAt, now)} · ${said}\nRuns were told and may each ask on one card. Check Away when you go.`
  }
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
  /** Story 84.3: the departure's cards, and the one route to them. */
  grant?: OwnerGrantView | null
  onOpenGrants?(): void
}): React.JSX.Element {
  const away = props.view?.state === 'away' && props.view.since !== null
  const words = away ? awaySinceWords(props.view!.since!, props.now) : 'Away'
  const title = awayTooltip(props.view, props.now, props.sessionName)
  const grant = props.onOpenGrants ? awayGrantWords(props.grant, props.now, props.sessionName) : null
  const leaving = props.grant?.period?.state === 'leaving'
  const box = (
    <input id="away-check-box" type="checkbox" checked={away} disabled={props.view === null}
      aria-label={away ? 'Away; uncheck when you are back' : leaving ? 'Away; check it when you go' : undefined}
      onChange={(event) => props.onChange(event.target.checked ? 'away' : 'back')} />
  )
  const extra = grant === null ? null : (
    <>
      <span className="away-grant-separator" aria-hidden="true">·</span>
      <button type="button" className={grant.cards ? 'away-grant cards' : 'away-grant'} aria-label={grant.label} title={grant.title} onClick={props.onOpenGrants}>
        {grant.words}
      </button>
    </>
  )
  if (away && props.onOpenSummary) {
    return (
      <span className="away-check" data-away title={title}>
        {box}
        <button type="button" className="away-words" onClick={props.onOpenSummary}>{words}</button>
        {extra}
      </span>
    )
  }
  if (extra !== null) {
    // The words stay the box's label; the grant's button sits beside them, outside the label.
    return (
      <span className="away-check" data-away={away || undefined} title={title}>
        {box}
        <label htmlFor="away-check-box" className="away-words">{words}</label>
        {extra}
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
