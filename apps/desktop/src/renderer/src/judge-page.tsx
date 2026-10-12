// MODULE: judge-page.tsx - Epic 65: the page of an agent BMN itself calls (Jev): who gets its requests, what it cost this month and last, the monthly limit, Try it and the last calls
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  JUDGE_TRY_STATEMENT_MAX, JUDGE_TRY_TEXT_MAX,
  type JudgeCallView, type JudgeMonthView, type JudgeTotalsView, type JudgeTryReply, type JudgeView, type RosterAgentShape, type RosterPrivateWork
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Segmented } from './history-preferences'
import { PRIVATE_WORK_WORDS, dayWords, priceWords, siteOf, thousands, type CalledParty } from './roster-staging'
import { Dot } from './roster-marks'
import { Row, Switch } from './team-preferences'
import { askerName, whenWords } from './web-questions'

/** How often the page reads the calls again: an agent or a script may ask at any moment. */
const POLL_MS = 4000

export interface CalledParties { receives: CalledParty; runs: CalledParty; allowed: boolean; reason: string }

/** Dollars as the page says them: a plain zero, otherwise as many places as the amount needs to be told from its neighbours. */
export function usd(value: number, places: number): string {
  return value === 0 ? '$0' : `$${value.toFixed(places)}`
}

/** A limit with two places, or as many as it needs: a limit of $0.005 never reads "$0.01" or "$0.00". */
export function limitUsd(value: number): string {
  return `$${value.toFixed(4).replace(/0{1,2}$/, '')}`
}

/** "October" for "2026-10". */
export function monthName(month: string): string {
  return new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))
}

/** Jev's number with two places, cut and never rounded: 0.899 shows 0.89, so a number under the line never looks like 0.90. */
export function cut(noul: number): string {
  return (Math.floor(noul * 100 + 1e-9) / 100).toFixed(2)
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} seconds`

/** A month's purposes, the dearest first. */
export function byCost(month: Pick<JudgeMonthView, 'purposes'>): Array<[string, JudgeTotalsView]> {
  return Object.entries(month.purposes).sort((one, other) => other[1].cost_usd - one[1].cost_usd || one[0].localeCompare(other[0]))
}

const OUTCOME_WORDS: Readonly<Record<JudgeCallView['outcome'], string>> = { answered: 'answered', refused: 'refused', timeout: 'no answer in time', failed: 'the request failed', shape: "not Jev's shape" }
const REFUSAL_WORDS: Readonly<Record<string, string>> = { LIMIT_REACHED: 'refused: monthly limit reached', PRIVATE_NOT_ALLOWED: 'refused: private text not allowed', WORKSPACE_PRIVATE: 'refused: workspace not public' }

/** How a call ended, in a few plain words; the two refusals worth telling apart are named. */
export function outcomeWords(call: Pick<JudgeCallView, 'outcome' | 'code'>): string {
  return (call.outcome === 'refused' && call.code !== undefined ? REFUSAL_WORDS[call.code] : undefined) ?? OUTCOME_WORDS[call.outcome]
}

/**
 * What he can do about a refusal, from his own page. The command's own next step is written for an
 * agent ("the owner raises the limit"); here the same step is said to him. A refusal with no entry keeps the command's.
 */
const OWN_NEXT: Readonly<Record<string, string>> = {
  NO_JUDGE: 'Add and approve a judge on Team first.',
  JUDGE_PROPOSED: 'Activate it and approve the team first.',
  JUDGE_DISABLED: 'Turn it on at the top of this page and approve the team.',
  LIMIT_REACHED: 'Raise the monthly limit above or switch it off; otherwise ask again next month.',
  PRIVATE_NOT_ALLOWED: 'Choose Public if the text is public, or allow private work for both providers above and approve the team.',
  NO_KEY: "Sign in to OpenCode on this computer (opencode auth login). BMN reads the key from OpenCode's own sign-in file and keeps none."
}

const TRY_HEADS = { timeout: 'No answer in time', failed: 'The request failed', shape: "Not Jev's shape" } as const

/** What a Try it may send as the team stands, said beside Ask. */
export function mayBeSentWords(parties: CalledParties): string {
  if (parties.allowed) return 'Private text may be sent.'
  const names = [parties.receives, parties.runs].filter((party, index, all) => party.private_work !== 'allowed' && all.findIndex((other) => other.id === party.id) === index).map((party) => party.name)
  return `Public text only: ${names.join(' and ')} ${names.length === 1 ? 'gets' : 'get'} public work only.`
}

export interface JudgeState {
  view: JudgeView | null
  loadError: string | null
  setLimit(limit: JudgeView['limit']): void
  ask(text: string, statement: string, data: 'public' | 'private'): Promise<JudgeTryReply>
}

/** The judge's calls, read when its page opens and again while it stays open. */
export function useJudgeState(): JudgeState {
  const [view, setView] = useState<JudgeView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const adopt = useCallback((next: JudgeView): void => {
    if (!alive.current) return
    setView(next)
    setLoadError(null)
  }, [])
  const load = useCallback(async (): Promise<void> => {
    try {
      adopt(await window.aiTerminal.judgeCalls())
    } catch (error) {
      if (alive.current) setLoadError(failureDetail(error, 'Could not read the calls'))
    }
  }, [adopt])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])
  return {
    view, loadError,
    setLimit: (limit) => {
      window.aiTerminal.setJudgeLimit(limit).then(adopt, (error: unknown) => { if (alive.current) setLoadError(failureDetail(error, 'Could not keep the limit')) })
    },
    ask: async (text, statement, data) => {
      try {
        const tried = await window.aiTerminal.tryJudge(text, statement, data)
        adopt(tried.view)
        return tried.reply
      } catch (error) {
        return { outcome: 'failed', note: failureDetail(error, 'BMN could not send it') }
      }
    }
  }
}

/**
 * One of the two parties with its private-work answer, and the way to change it: the answer is
 * the provider's, set once for every agent there, and staged like any other team change.
 */
function PartyRow(props: { label: string; party: CalledParty; others: readonly string[]; onAnswer(answer: RosterPrivateWork): void }): React.JSX.Element {
  const { party } = props
  const [changing, setChanging] = useState(false)
  const labelId = useId()
  const limits = party.private_work !== 'allowed'
  return (
    <Row label={props.label} id={labelId} hint={`Set once for ${party.name}; it covers every agent there${props.others.length > 1 ? `: ${props.others.join(', ')}` : ''}.`}>
      <div className="party">
        <span>{party.name}</span>
        {changing
          ? <Segmented labelledBy={labelId} fit options={['allowed', 'public_only'] as const} value={party.private_work} optionLabel={(value) => PRIVATE_WORK_WORDS[value]} onChange={props.onAnswer} />
          : (
            <>
              <span className={limits ? 'answer limits' : 'answer'}>{limits ? 'public work only' : 'private work allowed'}</span>
              <button type="button" className="small" aria-label={`Change private work for ${party.name}`} onClick={() => setChanging(true)}>Change…</button>
            </>
          )}
      </div>
    </Row>
  )
}

function Cells({ totals }: { totals: JudgeTotalsView }): React.JSX.Element {
  return <><td className="mono">{thousands(totals.calls)}</td><td className="mono">{thousands(totals.input_tokens)}</td><td className="mono">{usd(totals.cost_usd, 6)}</td></>
}

/** A dollar amount the owner types; one that is not an amount above zero stays in the field, marked, and is never handed on. */
function DollarField(props: { label: string; value: number; onChange(next: number): void }): React.JSX.Element {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const parsed = dollarsOf(text)
  return (
    <>
      <input className="field number mono" inputMode="decimal" aria-label={props.label} aria-invalid={parsed === null} value={text}
        onChange={(event) => {
          setText(event.currentTarget.value)
          const next = dollarsOf(event.currentTarget.value)
          if (next !== null) props.onChange(next)
        }} />
      {parsed === null ? <span className="field-refusal" role="alert">A limit is an amount above $0.</span> : null}
    </>
  )
}

/** A dollar amount from what the owner typed ("1", "0.50", "$2"), or null when it is not one above zero. */
export function dollarsOf(text: string): number | null {
  const digits = text.trim().replace(/^\$/, '').replace(',', '.')
  return /^\d{1,5}(\.\d{1,4})?$/.test(digits) && Number(digits) > 0 ? Number(digits) : null
}

/** The limit reached, said at the top of the page with the way out. */
export function LimitReached(props: { view: JudgeView; name: string; raise(): void }): React.JSX.Element | null {
  const { view } = props
  if (!view.reached) return null
  return (
    <div className="page-note with-action" role="status">
      <Dot label="Needs you" />
      <span className="note-text">Asking {props.name} is stopped until next month or a higher limit. This month's calls cost {usd(view.current.cost_usd, 4)}, which reaches the limit of {limitUsd(view.limit.usd)}.</span>
      <button type="button" className="small" onClick={props.raise}>Raise the limit</button>
    </div>
  )
}

/**
 * Everything below Identity on the page of an agent BMN calls: the model and its two parties, what
 * its calls cost, the monthly limit, Try it and the last calls. Rows that belong to an agent app
 * (its app, efforts, context, researcher) are not drawn at all, so nothing looks missing.
 */
export function JudgeGroups(props: {
  agent: RosterAgentShape; parties: CalledParties; state: JudgeState; limitRow: React.RefObject<HTMLDivElement | null>
  /** The names of the agents a provider's answer covers. */
  covered(providerId: string): string[]
  onAnswer(providerId: string, answer: RosterPrivateWork): void
  sessionName(id: string): string | undefined; now?: Date
}): React.JSX.Element {
  const { agent, parties } = props
  const view = props.state.view
  const costId = useId()
  const limitId = useId()
  const callsId = useId()
  const price = priceWords(agent)
  const basis = view === null ? null : [view.current, view.previous].find((month) => month.calls > 0) ?? null
  const refused = view === null ? 0 : view.current.refused + view.previous.refused
  return (
    <>
      <h4 className="group-head">Model <span className="caption">called by BMN itself, not by an agent app</span></h4>
      <Row label="Model" hint="It writes no text: it gives one number for each statement about a text."><span className="mono">{agent.model}</span></Row>
      <Row label="Role" hint="0.90 or more reads yes; anything else is no answer. An answer is advice.">Judge</Row>
      <PartyRow label="Receives the request" party={parties.receives} others={props.covered(parties.receives.id)} onAnswer={(answer) => props.onAnswer(parties.receives.id, answer)} />
      <PartyRow label="Runs the model" party={parties.runs} others={props.covered(parties.runs.id)} onAnswer={(answer) => props.onAnswer(parties.runs.id, answer)} />
      <Row label="Private text" hint="Private text may be sent only when both allow it.">
        <strong className="verdict">{parties.allowed ? 'May be sent' : 'Not sent'}</strong>
      </Row>
      <Row label="Price" hint={basis ? `About ${usd(basis.cost_usd / basis.calls, 6)} a call so far.` : undefined}>
        <span className="mono">{price ?? '—'}</span>{price ? <span className="faint"> per M tokens, in / out</span> : null}
        {agent.price?.source
          ? <div className="source">From the price page at <span className="mono" title={agent.price.source}>{siteOf(agent.price.source)}</span>{agent.price.as_of ? `, ${dayWords(agent.price.as_of)}` : ''}</div>
          : price ? null : <div className="source">No price recorded.</div>}
      </Row>

      <h4 className="group-head" id={costId}>Cost <span className="caption">this month and last, by the one-word purpose each caller gives</span></h4>
      {props.state.loadError ? <p className="preferences-error" role="alert">{props.state.loadError}</p> : null}
      {view === null ? (props.state.loadError ? null : <p className="preferences-help">Reading {agent.name}'s calls…</p>) : (
        <>
          {basis === null ? <p className="preferences-help">No calls yet. The first one you ask under Try it is counted here.</p> : (
            <table className="cost-table" aria-labelledby={costId}>
              <thead><tr><td /><th scope="col">Calls</th><th scope="col">Tokens in</th><th scope="col">Cost</th></tr></thead>
              {([['This month', view.current], ['Last month', view.previous]] as const).map(([label, month]) => (
                <tbody key={month.month}>
                  <tr className="month"><th scope="row">{label} <span className="month-name">{monthName(month.month)}</span></th><Cells totals={month} /></tr>
                  {byCost(month).map(([purpose, totals]) => <tr key={purpose}><th scope="row" title={purpose}>{purpose}</th><Cells totals={totals} /></tr>)}
                </tbody>
              ))}
            </table>
          )}
          {refused > 0 ? <p className="preferences-help">Refused and not charged: {view.current.refused} this month, {view.previous.refused} last month.</p> : null}
          <div ref={props.limitRow}>
            <Row label="Monthly limit" id={limitId} hint={!view.limit.on ? 'Off: there is no limit.'
              : view.reached ? 'Reached: asking is stopped until next month or a higher limit.'
              : `${usd(view.current.cost_usd, 4)} of ${limitUsd(view.limit.usd)} used this month.`}>
              <div className="inline">
                <Switch labelledBy={limitId} on={view.limit.on} onChange={(on) => props.state.setLimit({ ...view.limit, on })} />
                <span className="faint">$</span>
                <DollarField label="Monthly limit in dollars" value={view.limit.usd} onChange={(usdLimit) => { if (usdLimit !== view.limit.usd) props.state.setLimit({ ...view.limit, usd: usdLimit }) }} />
                <span className="faint">a month</span>
              </div>
            </Row>
          </div>
        </>
      )}

      <h4 className="group-head">Try it <span className="caption">goes by the same route and is counted like every call</span></h4>
      <TryIt name={agent.name} parties={parties} ask={props.state.ask} />

      {view === null ? null : (
        <>
          <h4 className="group-head" id={callsId}>Last calls <span className="caption">the newest 20</span></h4>
          {view.calls.length === 0 ? <p className="preferences-help">No calls yet.</p> : (
            <ul className="calls" aria-labelledby={callsId}>
              <li className="calls-head" aria-hidden="true"><span>When</span><span>Asked by</span><span>Purpose</span><span>Outcome</span></li>
              {view.calls.map((call, index) => {
                const who = call.by.kind === 'owner' ? 'You, on this page' : askerName(call.by, props.sessionName)
                return (
                  <li key={`${call.at}-${index}`} className={call.outcome === 'answered' ? 'call' : 'call loud'}>
                    <time className="when" dateTime={call.at}>{whenWords(call.at, props.now)}</time>
                    <span className="who" title={who}>{who}</span>
                    <span className="purpose" title={call.purpose}>{call.purpose}</span>
                    <span className="outcome">{outcomeWords(call)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </>
  )
}

/**
 * One statement about one pasted text, asked by the route every call takes: the page blocks
 * nothing itself, so a refusal comes from the command, in its words. The owner says whether the
 * text is private; it starts as private, which is refused wherever a provider gets public work only.
 */
function TryIt(props: { name: string; parties: CalledParties; ask: JudgeState['ask'] }): React.JSX.Element {
  const [text, setText] = useState('')
  const [statement, setStatement] = useState('')
  const [data, setData] = useState<'public' | 'private'>('private')
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<JudgeTryReply | null>(null)
  const dataId = useId()
  const ready = text.trim() !== '' && statement.trim() !== '' && !busy
  const send = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setReply(null)
    props.ask(text, statement, data).then(setReply).finally(() => setBusy(false))
  }
  return (
    <form onSubmit={send}>
      <Row label="Text" hint={`Up to ${thousands(JUDGE_TRY_TEXT_MAX)} characters.`}>
        <textarea className="field wide try-text" aria-label="Text" rows={3} maxLength={JUDGE_TRY_TEXT_MAX} placeholder="Paste the text to ask about" value={text} onChange={(event) => setText(event.currentTarget.value)} />
      </Row>
      <Row label="The text is" id={dataId} hint={mayBeSentWords(props.parties)}>
        <Segmented<'private' | 'public'> labelledBy={dataId} fit options={['private', 'public']} value={data} optionLabel={(value) => (value === 'private' ? 'Private' : 'Public')} onChange={setData} />
      </Row>
      <Row label="Statement">
        <div className="try-stack">
          <input className="field wide" aria-label="Statement" maxLength={JUDGE_TRY_STATEMENT_MAX} placeholder="A sentence that is true or false of the text" value={statement} onChange={(event) => setStatement(event.currentTarget.value)} />
          <div className="try-line">
            <span className="muted">One statement, one number.</span>
            <button type="submit" disabled={!ready}>Ask</button>
          </div>
          <div className="try-status" role="status">
            {busy ? <span className="muted">Asking {props.name}…</span> : reply ? <TryAnswer reply={reply} /> : null}
          </div>
        </div>
      </Row>
    </form>
  )
}

/** What Try it got back, in words: the number and BMN's reading, the command's own refusal, or why there is no answer. */
export function TryAnswer({ reply }: { reply: JudgeTryReply }): React.JSX.Element {
  if (reply.outcome === 'answered') {
    const yes = reply.reading === 'yes'
    const number = cut(reply.noul)
    return (
      <div className={yes ? 'try-reply said' : 'try-reply'}>
        <span className="noul mono" aria-hidden="true">{number}</span>
        <div className="reply-words">
          <strong>{yes ? 'Yes' : 'No answer'}{reply.near ? ', near the line' : ''}</strong>
          <span>{yes ? `${number} is 0.90 or more, so BMN reads yes. It is advice, not proof.` : `${number} is under 0.90, so BMN reads no answer. That is not a no.`}</span>
          <span className="reply-facts">{thousands(reply.input_tokens)} tokens in, {usd(reply.cost_usd, 6)}, {seconds(reply.took_ms)}. Counted in the calls below.</span>
        </div>
      </div>
    )
  }
  if (reply.outcome === 'refused') {
    const next = OWN_NEXT[reply.code] ?? reply.next
    return (
      <div className="try-reply">
        <div className="reply-words">
          <span><strong>Refused:</strong> {reply.message}</span>
          {next ? <span className="reply-facts">{next}</span> : null}
        </div>
      </div>
    )
  }
  return (
    <div className="try-reply">
      <div className="reply-words">
        <strong>{TRY_HEADS[reply.outcome]}</strong>
        <span>{reply.note}</span>
        <span className="reply-facts">BMN reads no answer.</span>
      </div>
    </div>
  )
}
