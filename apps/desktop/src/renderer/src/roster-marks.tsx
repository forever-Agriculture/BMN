// MODULE: roster-marks.tsx - Epic 60.5: shape carries meaning (a chess piece per class, a table for Team, a book for Rules); colour stays text grey
import type { RosterClass } from '@bmn/protocol'
import { CLASS_WORDS } from './roster-staging'

/** Filled 24-unit silhouettes, one per class. */
const PIECES: Readonly<Record<RosterClass, string>> = {
  knight: 'M7 19.5h11.3c.2-5.2-.6-9.4-3-12.2-1.4-1.6-3.2-2.6-5.1-2.8L9.6 2.6 8.3 4.9C6.8 5.7 5.7 7.1 5.1 8.9L3.7 12.4c-.3.9.2 1.7 1.1 1.9l1.3.3c.6.1 1.2-.1 1.6-.6l1.5-1.6c.9.1 1.8-.2 2.4-.8-.3 2.8-1.9 5.2-4.7 7.9zM9 7.3a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8zM5.5 20.5h13a1 1 0 0 1 1 1v.5h-15v-.5a1 1 0 0 1 1-1z',
  queen: 'M7 16.3 4.4 8.2l2.9 3.3.9-5.3 2.5 4.6L12 5.6l1.3 5.2 2.5-4.6.9 5.3 2.9-3.3L17 16.3zM12 2.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM8.2 3.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM15.8 3.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM4.4 5.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM19.6 5.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM8 17.3h8v1.4H8zM5.5 19.7h13a1 1 0 0 1 1 1V22h-15v-1.3a1 1 0 0 1 1-1z',
  bishop: 'M12 2a1.3 1.3 0 1 0 0 2.6A1.3 1.3 0 0 0 12 2zM12 5.3c-2.9 2.1-4.6 4.7-4.6 7.1 0 1.9 1.1 3.3 2.6 3.9h4c1.5-.6 2.6-2 2.6-3.9 0-2.4-1.7-5-4.6-7.1zM13.6 8.6l-3 3 .8.8 3-3zM8.8 17.3h6.4v1.4H8.8zM5.5 19.7h13a1 1 0 0 1 1 1V22h-15v-1.3a1 1 0 0 1 1-1z',
  pawn: 'M12 2.5A3.2 3.2 0 0 0 10 8.2c-.9.4-1.5 1.1-1.5 1.8h7c0-.7-.6-1.4-1.5-1.8A3.2 3.2 0 0 0 12 2.5zM9.6 11.2h4.8c.2 2.9 1.4 5.3 3.1 7.3H6.5c1.7-2 2.9-4.4 3.1-7.3zM5.5 19.5h13a1 1 0 0 1 1 1V22h-15v-1.5a1 1 0 0 1 1-1z'
}

/** The class's chess piece. Beside the class word it is decoration; alone, it is named. */
export function Piece(props: { agentClass: RosterClass; named?: boolean; plate?: boolean }): React.JSX.Element {
  const piece = (
    <svg className="piece" viewBox="0 0 24 24" fillRule="evenodd" focusable="false" {...(props.named ? { role: 'img', 'aria-label': CLASS_WORDS[props.agentClass].name } : { 'aria-hidden': true })}>
      <path fill="currentColor" d={PIECES[props.agentClass]} />
    </svg>
  )
  return props.plate ? <span className="piece-plate">{piece}</span> : piece
}

/** Team: three people at a round table. */
export function TeamIcon(): React.JSX.Element {
  return (
    <svg className="page-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M1.8 9.2c.3-1.8 1.2-2.8 2.2-2.8s1.9 1 2.2 2.8M5.8 8.2c.3-1.8 1.2-2.8 2.2-2.8s1.9 1 2.2 2.8M9.8 9.2c.3-1.8 1.2-2.8 2.2-2.8s1.9 1 2.2 2.8" />
      <g fill="currentColor" stroke="none"><circle cx="4" cy="4.6" r="1.35" /><circle cx="8" cy="3.6" r="1.35" /><circle cx="12" cy="4.6" r="1.35" /></g>
      <ellipse cx="8" cy="11.6" rx="6.6" ry="2.5" />
    </svg>
  )
}

/** Rules: an open book. */
export function RulesIcon(): React.JSX.Element {
  return (
    <svg className="page-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.5 3.2h4.3c.7 0 1.2.5 1.2 1.2v9.1c0-.7-.5-1.2-1.2-1.2H2.5zM13.5 3.2H9.2c-.7 0-1.2.5-1.2 1.2v9.1c0-.7.5-1.2 1.2-1.2h4.3z" />
    </svg>
  )
}

/** The attention dot: something here waits for the owner. */
export function Dot(props: { label: string }): React.JSX.Element {
  return <span className="needs-dot" role="img" aria-label={props.label} title={props.label} />
}
