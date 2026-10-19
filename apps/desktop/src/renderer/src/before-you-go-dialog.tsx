// MODULE: before-you-go-dialog.tsx - Before you go: each run's Away grant card, answered here; the departure's head line and its two ways out (Story 84.3, the notes 84.2)
import { useEffect, useRef, useState } from 'react'
import {
  awayMomentWords,
  GRANT_RULE_LINE,
  grantAnswerWords,
  grantButtonWords,
  grantCardHasRuleLine,
  grantChoiceLabel,
  grantNoChoices,
  grantProposedChoices,
  grantProposedPrefix,
  grantRefusalWords,
  grantTermChoices,
  grantTermLabel,
  type GrantChoice,
  type GrantRefusalReason,
  type GrantRun,
  type OwnerGrantView
} from '@bmn/protocol'
import { Dialog } from './dialog'
import { Segmented } from './history-preferences'
import './before-you-go.css'

export interface GrantAnswerReply {
  outcome: 'granted' | 'repeated' | 'refused'
  reason?: GrantRefusalReason
  detail?: string
}

const APP_NAMES: Readonly<Record<string, string>> = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' })

/** "told Builder and Night", "told Builder, Night, Docs and 2 more" (the notes §2). */
export function toldWords(told: readonly string[], name: (sessionId: string) => string | null): string {
  const names = told.map((sessionId) => name(sessionId) ?? 'a session')
  if (names.length === 0) return 'no run told yet'
  if (names.length > 3) return `told ${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  return `told ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`
}

/** One run's card: where-line, title, scope, each term with its choice, then Grant (the notes §1). */
function GrantCard(props: {
  run: GrantRun
  periodId: string
  now: Date
  place(sessionId: string): { workspace: string; session: string }
  sessionName(sessionId: string): string | null
  onAnswer(answer: { periodId: string; runId: string; cardRevision: number; choices: Record<string, GrantChoice> }): Promise<GrantAnswerReply>
  onAnswered(): void
}): React.JSX.Element {
  const { run } = props
  const card = run.card
  const [choices, setChoices] = useState<Record<string, GrantChoice>>(() => grantProposedChoices(card.terms))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A new revision draws the card again from its own proposals (the notes §1, changed while open). Every refresh reads the
  // terms anew, so only the period, run and revision say it is another card: his unsent choices stay through the rest.
  useEffect(() => { setChoices(grantProposedChoices(card.terms)); setError(null) }, [props.periodId, run.runId, card.revision])
  const open = card.state === 'open'
  const place = card.sessionId === null ? { workspace: 'BMN', session: 'bmn grant' } : props.place(card.sessionId)
  const asker = card.sessionId === null ? 'the owner\'s CLI' : props.sessionName(card.sessionId) ?? 'a session'
  const app = card.agentCli === null ? '' : ` (${APP_NAMES[card.agentCli] ?? card.agentCli})`
  const send = (picked: Record<string, GrantChoice>): void => {
    setSaving(true)
    setError(null)
    void props.onAnswer({ periodId: props.periodId, runId: run.runId, cardRevision: card.revision, choices: picked })
      .then((reply) => {
        if (reply.outcome === 'refused') {
          setError(grantRefusalWords(reply.reason ?? 'invalid', {
            at: reply.reason === 'answered' ? run.answer?.at ?? null : card.askedAt, via: run.answer?.via ?? null, by: asker, now: props.now
          }))
        } else props.onAnswered()
      })
      .catch(() => setError(grantRefusalWords('invalid')))
      .finally(() => setSaving(false))
  }
  const answeredLines = (): string[] => {
    if (run.answer === null || run.answer.cardRevision !== card.revision) return []
    const where = run.answer.via === 'app' ? 'here' : 'from Telegram'
    const at = awayMomentWords(run.answer.at, props.now)
    const { granted, notGranted } = grantAnswerWords(run.answer.terms, run.answer.choices)
    if (granted.length === 0) return [`Granted none ${where} at ${at}.`]
    return [`Granted ${where} at ${at}, until you are back: ${granted.join(' · ')}`, ...(notGranted.length === 0 ? [] : [`Not granted: ${notGranted.join(', ')}`])]
  }
  const earlier = open && run.answer !== null && run.answer.cardRevision !== card.revision
  const label = `Away grant · ${run.title} · ${place.workspace} › ${place.session}`
  return (
    <article className={`attention-item grant-card ${open ? 'request' : 'cleared'}`} data-run-id={run.runId} data-card-revision={card.revision} aria-label={label}>
      <div className="where">
        {open ? <span className="status-dot needs-you" aria-hidden="true" /> : null}
        <span>{place.workspace}</span><span className="separator">›</span><span className="name" title={place.session}>{place.session}</span>
        <span className="attention-kind">Away grant</span>
        <span className="age">{awayMomentWords(card.askedAt, props.now)}</span>
      </div>
      <h3>{run.title}</h3>
      <p className="grant-scope" title={card.scope}>Scope: {card.scope}</p>
      {open ? <div className="grant-terms">
        {card.terms.map((term) => {
          const id = `grant-${run.runId}-${term.id}`.replace(/[^A-Za-z0-9_-]/g, '-')
          const reason = `${grantProposedPrefix(term)}${term.reason}`
          return (
            <div className="grant-term" key={term.id}>
              <div className="grant-term-words">
                <span id={id} className="grant-term-label">{grantTermLabel(term)}</span>
                <span className="grant-term-reason" title={reason}>{reason}</span>
              </div>
              <Segmented labelledBy={id} fit options={grantTermChoices(term)} value={choices[term.id] ?? term.proposed}
                disabled={saving} optionLabel={(choice) => grantChoiceLabel(term, choice)}
                onChange={(choice) => setChoices((current) => ({ ...current, [term.id]: choice }))} />
            </div>
          )
        })}
      </div> : null}
      {open && grantCardHasRuleLine(card.terms) ? <p className="grant-rule">{GRANT_RULE_LINE}</p> : null}
      <p className="seen">Asked {awayMomentWords(card.askedAt, props.now)} by {asker}{app}{card.change ? ` · changed: ${card.change}` : ''}
        {run.phone !== null && run.phone.cardRevision === card.revision && open ? ' · Phone: sent' : ''}</p>
      {earlier ? <p className="seen">Your earlier answer holds until you answer this card.</p> : null}
      {answeredLines().map((line) => <p key={line} className="grant-answered">{line}</p>)}
      {card.state === 'withdrawn' ? <p className="grant-answered">{card.withdrawnFor === 'back' ? 'Withdrawn: you are back.' : 'Withdrawn: you did not leave.'}</p> : null}
      {open && error !== null ? <p className="inline-error" role="alert">{error}</p> : null}
      {open ? <div className="actions">
        <button type="button" className="primary" disabled={saving} onClick={() => send(choices)}>
          {saving ? 'Granting…' : grantButtonWords(card.terms, choices)}
        </button>
        <button type="button" className="ghost" disabled={saving} onClick={() => send(grantNoChoices(card.terms))}>Grant none</button>
      </div> : null}
    </article>
  )
}

/**
 * Before you go (the notes §2–§3): the open cards oldest first, then the answered ones. Focus starts on the first open
 * card's first term at its chosen choice, never on No or on Grant; after an answer it moves to the next open card.
 */
export function BeforeYouGoDialog(props: {
  grant: OwnerGrantView
  now: Date
  place(sessionId: string): { workspace: string; session: string }
  sessionName(sessionId: string): string | null
  onAnswer(answer: { periodId: string; runId: string; cardRevision: number; choices: Record<string, GrantChoice> }): Promise<GrantAnswerReply>
  onAwayNow(): void
  onNotLeaving(): void
  onClose(): void
}): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const [focusNext, setFocusNext] = useState(0)
  const period = props.grant.period
  const leaving = period?.state === 'leaving'
  const runs = period?.runs ?? []
  const byAsked = (a: GrantRun, b: GrantRun): number => a.card.askedAt.localeCompare(b.card.askedAt)
  const open = runs.filter((run) => run.card.state === 'open').sort(byAsked)
  const answered = runs.filter((run) => run.card.state !== 'open' && run.card.state !== 'nothing').sort(byAsked)
  const nothing = runs.filter((run) => run.card.state === 'nothing').sort(byAsked)
  useEffect(() => {
    if (focusNext === 0) return
    const root = body.current
    const target = root?.querySelector<HTMLElement>('.grant-card.request [role="radio"][tabindex="0"]')
      ?? (leaving ? root?.querySelector<HTMLElement>('.grant-footer button') : root?.closest('dialog')?.querySelector<HTMLElement>('.app-dialog-heading button'))
    target?.focus()
  }, [focusNext, leaving])
  const close = (): void => {
    props.onClose()
    // The opener ("2 cards") is gone once the last card is answered: focus goes to the Away box (the notes §3).
    requestAnimationFrame(() => {
      if (document.activeElement === null || document.activeElement === document.body) document.querySelector<HTMLElement>('.away-check input')?.focus()
    })
  }
  const head = period === null ? 'Not leaving' : `${period.state === 'away' ? 'Away' : 'Leaving'} since ${awayMomentWords(period.awayAt ?? period.startedAt, props.now)} · ${toldWords(period.told, props.sessionName)}`
  return (
    <Dialog label="Before you go" onClose={close} className="before-you-go-dialog">
      <div ref={body} className="before-you-go">
        <p className="grant-head-line">{head}</p>
        <p className="grant-head-note">A card you leave unanswered grants nothing. Every grant ends when you are back.</p>
        {props.grant.read === 'unknown' ? <p className="inline-error" role="alert">Grant records could not be read, so nothing is granted.</p> : null}
        {open.length === 0 && answered.length === 0 && nothing.length === 0 ? <p className="grant-empty">No card yet. A run that needs nothing asks nothing.</p> : null}
        {[...open, ...answered].map((run) => (
          <GrantCard key={`${run.runId}:${run.card.revision}`} run={run} periodId={period!.periodId} now={props.now} place={props.place}
            sessionName={props.sessionName} onAnswer={props.onAnswer} onAnswered={() => setFocusNext((count) => count + 1)} />
        ))}
        {nothing.map((run) => <p key={run.runId} className="grant-nothing">{run.title} needs nothing.</p>)}
        {leaving ? <div className="grant-footer">
          <button type="button" onClick={props.onAwayNow}>Away now</button>
          <button type="button" className="ghost" title="Withdraws the open cards; nothing is granted." onClick={props.onNotLeaving}>Not leaving</button>
        </div> : null}
      </div>
    </Dialog>
  )
}
