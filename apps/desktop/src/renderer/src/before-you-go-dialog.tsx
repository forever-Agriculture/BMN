// MODULE: before-you-go-dialog.tsx - the departure list: passive first focus, immediate line saves and one explicit Go
import { useLayoutEffect, useRef, useState } from 'react'
import {
  awayMomentWords, departureCounts, departureOmittedLines, departureSessionState, grantChoice, GRANT_RULE_LINE, grantAnswerWords, grantNothingWords, grantAccessStatus, grantLimitWords, grantCardHasRuleLine, grantChoiceLabel,
  grantOpenProposals, grantProposedPrefix, grantRefusalWords, grantTermChoices, grantTermLabel,
  type GrantChoice, type GrantRefusalReason, type GrantRun, type OwnerGrantView
} from '@bmn/protocol'
import { Dialog } from './dialog'
import { Segmented } from './history-preferences'
import './before-you-go.css'

interface GrantAnswerReply { outcome: 'granted' | 'repeated' | 'refused'; reason?: GrantRefusalReason; detail?: string }
export function toldWords(told: readonly string[], name: (id: string) => string | null): string {
  const names = told.map(id => name(id) ?? 'a session')
  if (names.length === 0) return 'no run told yet'
  if (names.length > 3) return `told ${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  return `told ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`
}
interface AnswerInput {
  periodId: string; runId: string; cardRevision: number; choices: Record<string, GrantChoice>; expectedRevision?: number; lineId?: string
}

function GrantCard(props: {
  run: GrantRun; grant: OwnerGrantView; now: Date; place(id: string): { workspace: string; session: string }
  onAnswer(answer: AnswerInput): Promise<GrantAnswerReply>
  unreadable: boolean
  held?: GrantRun
  onShow?(): void
}): React.JSX.Element {
  const { run, grant } = props
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const restoreFocus = useRef<Element | null>(null)
  useLayoutEffect(() => {
    if (saving) return
    const focused = restoreFocus.current
    restoreFocus.current = null
    if (focused instanceof HTMLElement && focused.isConnected &&
      (document.activeElement === document.body || document.activeElement === focused)) focused.focus()
  }, [saving])
  const card = run.card
  const held = props.held !== undefined
  const period = grant.period!
  const answer = run.answer?.cardRevision === card.revision ? run.answer : null
  const priorGranted = answer === null && run.answer !== null && (period.state === 'leaving' || period.state === 'away')
    ? grantAnswerWords(run.answer.terms, run.answer.choices).granted : []
  const editable = !held && period.state === 'leaving'
  const place = card.sessionId === null ? { workspace: 'BMN', session: run.title } : props.place(card.sessionId)
  const offer = grant.offers?.find(other => other.runId === run.runId)
  const proposals = grantOpenProposals(card.terms, answer?.choices, offer?.choices)
  const send = async (choices: Record<string, GrantChoice>, lineId?: string): Promise<void> => {
    if (props.unreadable) return
    restoreFocus.current = document.activeElement
    setSaving(true); setError(null)
    try {
      const result = await props.onAnswer({ periodId: period.periodId, runId: run.runId, cardRevision: card.revision,
        expectedRevision: grant.revision, choices, ...(lineId === undefined ? {} : { lineId }) })
      if (result.outcome === 'refused') setError(result.detail ?? grantRefusalWords(result.reason ?? 'invalid'))
    } catch { setError('Could not save this answer. Look again before trying.') }
    finally { setSaving(false) }
  }
  return <article className={`attention-item grant-card ${card.terms.some(term => grantChoice(answer?.choices, term.id) === undefined) && card.state !== 'withdrawn' ? 'request' : 'cleared'}`} data-run-id={run.runId} data-card-revision={card.revision} aria-label={`Away grant · ${run.title} · ${place.workspace} › ${place.session}`}>
    <div className="where"><span>{place.workspace}</span><span className="separator">›</span><span className="name">{place.session}</span><span className="attention-kind">Away grant</span></div>
    <h3>{run.title}</h3>
    {held ? <p className="grant-changed">Changed at {awayMomentWords(props.held!.card.askedAt, props.now)}: {props.held!.card.change ?? 'the run asked again'}. <button type="button" aria-disabled={props.unreadable || undefined} onClick={props.unreadable ? undefined : props.onShow}>Show</button></p> : null}
    <p className="grant-scope" title={card.scope}>Scope: {card.scope}</p>
    {priorGranted.length > 0 ? <p className="grant-answered">Earlier answer still holds: {priorGranted.join(' · ')}. A new answer replaces it.</p> : null}
    <div className="grant-terms">{card.terms.map(term => {
      const id = `grant-${run.runId}-${term.id}`.replace(/[^A-Za-z0-9_-]/gu, '-')
      const picked = grantChoice(answer?.choices, term.id)
      const prior = grantChoice(offer?.choices, term.id)
      const reason = picked !== undefined ? term.reason : prior === undefined ? `${grantProposedPrefix(term)}${term.reason}`
        : `As you granted ${awayMomentWords(offer!.at, props.now)} · ${grantChoiceLabel(term, prior)} · not granted until your tap`
      const limitState = term.kind === 'limit' ? period.limitApplies?.findLast(entry =>
        entry.runId === run.runId && entry.item === term.id && entry.cardRevision === card.revision) : undefined
      const disabled = held || saving || card.state === 'withdrawn' || !editable && picked !== undefined ||
        limitState?.state === 'written' || limitState?.state === 'writing'
      const access = term.kind === 'access' ? grantAccessStatus(run, term.id, props.now) : null
      return <div className="grant-term" key={term.id}>
        <div className="grant-term-words">
          <span id={id} className={`grant-term-label${term.kind === 'command' || term.kind === 'message' || term.kind === 'access' ? ' exact' : ''}`}>{grantTermLabel(term)}</span>
          {term.kind === 'access' ? <button type="button" className="grant-copy" onClick={() => void navigator.clipboard.writeText(term.command)}>Copy command</button> : null}
          <span className="grant-term-reason" title={reason}>{reason}{picked === undefined && offer?.changed.includes(term.id) ? ' · changed' : ''}</span>
        </div>
        {access ? <button type="button" disabled={held || saving || card.state === 'withdrawn' || props.unreadable || !access.canCheck}
          onClick={() => void send({ [term.id]: 'done' }, term.id)}>{access.button}</button>
          : <Segmented labelledBy={id} fit manualActivation again options={grantTermChoices(term)} value={picked ?? null}
          disabled={disabled} unavailable={props.unreadable} optionLabel={choice => choice === null ? '' : grantChoiceLabel(term, choice)}
          onChange={choice => { if (choice !== null) void send({ [term.id]: choice }, term.id) }} />}
        <p className="grant-line-seen">{access ? access.words : term.kind === 'limit' ? grantLimitWords(period, run, term, props.now) : picked === undefined ? 'Not answered' : `${grantChoiceLabel(term, picked)} · answered ${(answer?.lines?.[term.id]?.via ?? answer?.via) === 'telegram' ? 'from Telegram' : 'here'} ${awayMomentWords(answer?.lines?.[term.id]?.at ?? answer!.at, props.now)}`}</p>
      </div>
    })}</div>
    {grantCardHasRuleLine(card.terms) ? <p className="grant-rule">{GRANT_RULE_LINE}</p> : null}
    <p className="seen">Asked {awayMomentWords(card.askedAt, props.now)}{card.change ? ` · changed: ${card.change}` : ''}</p>
    {card.state === 'withdrawn' ? <p className="grant-answered">Withdrawn: {card.withdrawnFor === 'back' ? 'you are back' : 'you did not leave'}.</p> : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {editable && card.state !== 'withdrawn' ? <div className="actions"><button type="button" disabled={saving || Object.keys(proposals).length === 0} aria-disabled={props.unreadable || undefined}
      onClick={() => void send(proposals)}>All as proposed</button></div> : null}
  </article>
}

export function BeforeYouGoDialog(props: {
  grant: OwnerGrantView; now: Date; place(id: string): { workspace: string; session: string }; sessionName(id: string): string | null
  unreadable?: boolean; onAnswer(answer: AnswerInput): Promise<GrantAnswerReply>; onAwayNow(): void; onNotLeaving(): void; onClose(): void
  onSameAgain?(): void; onListAction?(): void; onPresented?(): void; actionError?: string | null
}): React.JSX.Element {
  const unreadable = props.unreadable === true || props.grant.read === 'unknown'
  const period = props.grant.period
  const leaving = period?.state === 'leaving'
  const counts = period === null ? { asked: 0, asking: 0, lines: 0, notTold: 0 } : departureCounts(period, props.now)
  const initialOrder = useRef<string[]>([])
  const displayed = useRef(new Map<string, GrantRun>())
  const [holding, setHolding] = useState(false)
  const [, redraw] = useState(0)
  const runs = period?.runs ?? []
  // Existing line rows keep their position after answers and new arrivals.
  for (const run of runs) if (!run.card.nothing && !initialOrder.current.includes(run.runId)) initialOrder.current.push(run.runId)
  for (const run of runs) {
    const before = displayed.current.get(run.runId)
    if (!holding || before === undefined || before.card.revision === run.card.revision) displayed.current.set(run.runId, run)
  }
  const ordered = initialOrder.current.map(id => displayed.current.get(id)).filter((run): run is GrantRun => run !== undefined && !run.card.nothing)
  const unseenRevision = ordered.some(run => { const latest = runs.find(other => other.runId === run.runId); return latest !== undefined && latest.card.revision !== run.card.revision })
  const same = (props.grant.offers ?? []).reduce((sum, offer) => sum + Object.keys(offer.choices).filter(id => {
    const run = runs.find(other => other.runId === offer.runId)
    return run?.answer?.cardRevision !== run?.card.revision || grantChoice(run?.answer?.choices, id) === undefined
  }).length, 0)
  const head = period === null ? 'Not leaving' : `${leaving ? 'Getting ready' : period.state === 'away' ? 'Away' : 'Not leaving'} since ${awayMomentWords(period.awayAt ?? period.startedAt, props.now)} · asked ${counts.asked} ${counts.asked === 1 ? 'session' : 'sessions'} · ${counts.asking} still answering · ${counts.lines ? `${counts.lines} ${counts.lines === 1 ? 'line' : 'lines'} to answer` : 'nothing to answer'}`
  return <Dialog label="Before you go" onClose={props.onClose} className="before-you-go-dialog" initialFocus=".grant-list" onPresented={() => props.onPresented?.()}>
    <div className="before-you-go">
      <div className="grant-heading">
        <p className="grant-head-line">{head}{period?.collection?.autoStartedAt ? ' · started by itself' : ''}</p>
        {departureOmittedLines(period?.collection).map(line => <p className="grant-head-note grant-omitted" key={line}>{line}</p>)}
        <p className="grant-head-note">{leaving ? `Away starts on Go, or by itself at ${awayMomentWords(period!.collection?.autoAwayAt ?? period!.startedAt, props.now)}. ` : ''}A line you leave unanswered grants nothing.</p>
        {period?.collection?.phone.state === 'unreachable' || period?.collection?.phone.state === 'uncertain' ? <p className="grant-head-note">The phone was not reached. You can answer here.</p> : null}
        {unreadable ? <p className="inline-error" role="alert">Grant records could not be read, so nothing is granted.{period === null ? '' : ' Showing the last list.'}</p> : null}
        {props.actionError ? <p className="inline-error" role="alert">{props.actionError}</p> : null}
      </div>
      <div className="grant-list" tabIndex={-1} aria-label="Sessions before you go"
        onPointerEnter={() => setHolding(true)} onPointerLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setHolding(false) }}
        onFocusCapture={() => setHolding(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !event.currentTarget.matches(':hover')) setHolding(false) }}>
        {ordered.map(run => {
          const latest = runs.find(other => other.runId === run.runId)
          const held = latest !== undefined && latest.card.revision !== run.card.revision ? latest : undefined
          return <GrantCard key={run.runId} run={run} grant={props.grant} now={props.now} place={props.place} onAnswer={props.onAnswer} unreadable={unreadable}
            {...(held === undefined ? {} : { held })} onShow={() => { if (latest !== undefined) displayed.current.set(run.runId, latest); redraw(value => value + 1); props.onListAction?.() }} />
        })}
        {(period?.collection?.sessions ?? []).filter(session => !ordered.some(run => run.card.sessionId === session.sessionId && !run.card.nothing)).map(session => {
          const row = departureSessionState(period!, session, props.now)
          const words = row.state === 'nothing' ? 'needs nothing' : row.state === 'no-answer' ? 'no answer' : row.state === 'not-told' ? 'not told'
            : row.state === 'not-selected' ? 'not asked' : 'asking'
          return <div className="grant-session-row" data-state={row.state} data-contradicted={row.runs.some(run => (run.card.despiteFacts?.length ?? 0) > 0) || undefined} key={session.sessionId}><span>{session.name}</span><span>{words}{row.reason ? `: ${row.reason}` : ''}</span></div>
        })}
        {runs.filter(run => run.card.nothing && !(period?.collection?.sessions ?? []).some(session => session.sessionId === run.card.sessionId)).map(run => <p className="grant-nothing" key={run.runId}>{run.title} needs nothing: {grantNothingWords(run.card)}</p>)}
        {runs.filter(run => run.card.nothing && run.answer !== null && (period?.state === 'leaving' || period?.state === 'away')).map(run => {
          const granted = grantAnswerWords(run.answer!.terms, run.answer!.choices).granted
          return granted.length > 0 ? <p className="grant-answered" key={`prior-${run.runId}`}>{run.title}: Earlier answer still holds: {granted.join(' · ')}. A new answer replaces it.</p> : null
        })}
        {(props.grant.notAskedAgain ?? []).map(run => <p className="grant-nothing" key={run.runId}>{run.title}: you granted {run.granted.join(' · ')} at {awayMomentWords(run.at, props.now)}; has not asked again. Nothing is granted.</p>)}
        {runs.length === 0 && !period?.collection?.sessions.length ? <p className="grant-empty">No session to ask.</p> : null}
      </div>
      {leaving ? <div className="grant-footer">
        {same > 0 && props.onSameAgain ? <button type="button" disabled={unseenRevision} aria-disabled={unreadable || undefined} onClick={unreadable ? undefined : props.onSameAgain}>Grant the same {same}</button> : null}
        <button type="button" className="primary grant-go" aria-disabled={unreadable || undefined} onClick={unreadable ? undefined : props.onAwayNow}>{counts.asking > 0 ? 'Go now' : 'Go'}</button>
        <button type="button" className="ghost" onClick={props.onNotLeaving}>Not leaving</button>
      </div> : null}
    </div>
  </Dialog>
}
