// MODULE: turn-changes-plate.tsx - the one quiet button in a pane's header for the session's latest turn; it opens the Turn changes dialog (Story 69.5)
import type { TurnSessionView } from '@bmn/protocol'
import { turnPlate, type TurnPlatePart } from './turn-changes-presentation'
import './turn-changes.css'

const TONE_CLASS: Readonly<Record<TurnPlatePart['tone'], string | undefined>> = { text: undefined, muted: 'old', caveat: 'caveat' }

/**
 * Sits in the header row the pane already has, between its ports and its actions, at the height of a port's
 * plate: appearing, changing and going away it changes no terminal's size. Both of its wordings are always in the
 * markup; the pane's width decides which is shown.
 */
export function TurnPlate(props: { view: TurnSessionView | null; now: number; onOpen(): void }): React.JSX.Element | null {
  const words = props.view === null ? null : turnPlate(props.view, props.now)
  if (props.view === null || words === null) return null
  return (
    <button type="button" className="turn-plate" data-turn-plate={props.view.sessionId} aria-haspopup="dialog"
      title={words.title} aria-label={words.title} onClick={props.onOpen}>
      <span className="full">{words.full.map((part) => <span key={part.text} className={TONE_CLASS[part.tone]}>{part.text}</span>)}</span>
      <span className="short"><span className={TONE_CLASS[words.short.tone]}>{words.short.text}</span></span>
    </button>
  )
}
