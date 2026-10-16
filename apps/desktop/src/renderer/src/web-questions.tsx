// MODULE: web-questions.tsx - Story 64.3: Preferences › Agents › Models › Web questions: what was asked of the web and by whom, the owner's own Ask, the question under way, and the switch for agents
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ROSTER_APP_NAMES, WEB_QUESTION_MARKS, type RosterHarness, type WebQuestionAsker, type WebQuestionClaim, type WebQuestionOutcome, type WebQuestionView, type WebQuestionsSnapshot } from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Row, Switch, shortDate } from './team-preferences'

/** How many kept questions show before the rest go under "Earlier". */
const SHOWN = 8
/** How often the page asks what is kept: an agent may ask at any moment, and a question under way moves faster. */
const IDLE_POLL_MS = 4000
const BUSY_POLL_MS = 1500

/** One or two plain words per outcome; no colour says more. */
export const OUTCOME_WORDS: Readonly<Record<WebQuestionOutcome, string>> = {
  running: 'Asking now', answered: 'Answered', 'no-answer': 'No answer', failed: 'Failed', stopped: 'Stopped', limit: 'Hit a limit', refused: 'Refused', interrupted: 'Cut short'
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1)
const thousands = (count: number): string => count.toLocaleString('en-US')

/** Who asked, as the page names them: a session by the name it has in BMN, where it is still there. */
export function askerName(by: WebQuestionAsker, sessionName: (id: string) => string | undefined): string {
  if (by.kind === 'owner') return 'You'
  if (by.kind === 'shell') return 'A shell'
  const name = sessionName(by.session) ?? 'A closed session'
  if (by.app === undefined) return `${name}'s shell`
  return `${name} (${ROSTER_APP_NAMES[by.app as RosterHarness] ?? by.app})`
}

/** A question's first line, or the words for a text BMN did not keep. */
export function firstLine(question: string | null): string {
  return question === null ? 'Words not kept' : question.trim().split('\n', 1)[0] ?? ''
}

/** "42 seconds", "1 minute 12 seconds". */
export function tookWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return plural(seconds, 'second')
  return seconds % 60 === 0 ? plural(minutes, 'minute') : `${plural(minutes, 'minute')} ${plural(seconds % 60, 'second')}`
}

/** What a closed line says of an answer's claims, so the owner sees which answers hold before opening one. */
export function evidenceWords(counts: WebQuestionView['counts']): string | null {
  if (counts === undefined) return null
  const all = counts.found + counts.not_found + counts.unreadable
  if (all === 0) return null
  return counts.found === 0 ? `no evidence for its ${all === 1 ? 'claim' : `${all} claims`}` : `evidence for ${counts.found} of ${plural(all, 'claim')}`
}

/** "Today 14:02" for a question of this local day, the short date otherwise. */
export function whenWords(at: string, now: Date = new Date()): string {
  const time = new Date(at)
  const sameDay = time.getFullYear() === now.getFullYear() && time.getMonth() === now.getMonth() && time.getDate() === now.getDate()
  return sameDay ? `Today ${clockWords(at)}` : shortDate(at)
}

export function clockWords(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Why the owner's own question cannot start now, or null when it can. */
export function askWaits(snapshot: Pick<WebQuestionsSnapshot, 'holder'>, researcher: string | null): string | null {
  if (researcher === null) return 'Pick a researcher above first.'
  if (snapshot.holder === null) return null
  return snapshot.holder.kind === 'question' ? 'One question at a time: the one below is under way.' : 'Models research is running, so a question cannot start yet.'
}

export interface WebQuestionsState {
  snapshot: WebQuestionsSnapshot | null
  loadError: string | null
  /** A Stop, a removal or the switch is on its way. */
  busy: boolean
  /** The command's own refusal, or null when the question started. */
  ask(question: string): Promise<string | null>
  stop(): void
  allow(on: boolean): void
  remove(id: string | null): void
  openPage(id: string, claim: number): void
}

/** What the part shows, read when the page opens and again while it stays open: an agent may ask at any moment. */
export function useWebQuestionsState(): WebQuestionsState {
  const [snapshot, setSnapshot] = useState<WebQuestionsSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const adopt = useCallback((next: WebQuestionsSnapshot): void => {
    if (!alive.current) return
    setSnapshot(next)
    setLoadError(null)
  }, [])
  const load = useCallback(async (): Promise<void> => {
    try {
      adopt(await window.aiTerminal.webQuestions())
    } catch (error) {
      if (alive.current) setLoadError(failureDetail(error, 'Could not read the web questions'))
    }
  }, [adopt])
  const moving = snapshot?.holder != null
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), moving ? BUSY_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [load, moving])
  const act = useCallback((task: () => Promise<WebQuestionsSnapshot>, failed: string): void => {
    setBusy(true)
    task().then(adopt, (error: unknown) => { if (alive.current) setLoadError(failureDetail(error, failed)) }).finally(() => { if (alive.current) setBusy(false) })
  }, [adopt])
  return {
    snapshot, loadError, busy,
    ask: async (question) => {
      try {
        const asked = await window.aiTerminal.askWebQuestion(question)
        adopt(asked.snapshot)
        return asked.ok ? null : asked.message ?? 'The question could not be asked.'
      } catch (error) {
        return failureDetail(error, 'The question could not be asked')
      }
    },
    stop: () => act(() => window.aiTerminal.stopWebQuestion(), 'The question could not be stopped'),
    allow: (on) => act(() => window.aiTerminal.setAgentsMayAsk(on), 'Could not keep that choice'),
    remove: (id) => act(() => window.aiTerminal.removeWebQuestions(id), 'The question could not be removed'),
    openPage: (id, claim) => void window.aiTerminal.openWebQuestionPage(id, claim).catch(() => undefined)
  }
}

export interface WebQuestionsProps {
  snapshot: WebQuestionsSnapshot
  /** The name of the researcher picked in the Researcher row, or null when none is. */
  researcher: string | null
  busy: boolean
  sessionName(id: string): string | undefined
  ask(question: string): Promise<string | null>
  stop(): void
  allow(on: boolean): void
  remove(id: string | null): void
  openPage(id: string, claim: number): void
  /** The question that is open when the part first shows; the owner opens and closes them after that. */
  initiallyOpen?: string
  now?: Date
}

/** Agents › Models › Web questions: the switch, the owner's own Ask, the question under way and the kept ones. */
export function WebQuestions(props: WebQuestionsProps): React.JSX.Element {
  const { snapshot } = props
  const headId = useId()
  const switchId = useId()
  const askId = useId()
  const goesId = useId()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(props.initiallyOpen ?? null)
  const [confirming, setConfirming] = useState(false)
  const { perDay, minutes, characters, kept: keptLimit } = snapshot.limits
  const running = snapshot.questions.find((record) => record.outcome === 'running')
  const kept = snapshot.questions.filter((record) => record.outcome !== 'running')
  const waits = askWaits(snapshot, props.researcher)
  const canAsk = waits === null && !sending && text.trim() !== ''
  const send = async (): Promise<void> => {
    setSending(true)
    const said = await props.ask(text)
    setSending(false)
    setRefusal(said)
    if (said === null) setText('')
  }
  const line = (record: WebQuestionView): React.JSX.Element => (
    <QuestionLine key={record.id} record={record} open={openId === record.id} busy={props.busy} sessionName={props.sessionName} now={props.now}
      toggle={() => setOpenId(openId === record.id ? null : record.id)} remove={() => props.remove(record.id)} openPage={(claim) => props.openPage(record.id, claim)} />
  )
  const limits = `Limits: ${perDay} a day, ${minutes} minutes and ${thousands(characters)} characters each, one research at a time.`
  return (
    <section className="web-questions" aria-labelledby={headId}>
      <h4 className="group-head" id={headId}>Web questions<span className="caption">{"yours and your agents', newest first"}</span></h4>
      <Row label="Agents may ask the web" id={switchId}
        hint={`${snapshot.agentsMayAsk ? '' : 'Off: only your own Ask works. '}A question's words reach the search sites. ${limits}`}>
        <Switch labelledBy={switchId} on={snapshot.agentsMayAsk} disabled={props.busy} onChange={props.allow} />
        <span className="muted">{snapshot.today >= perDay ? `All ${perDay} asked today; the next can be asked tomorrow` : `${snapshot.today} of ${perDay} asked today`}</span>
      </Row>
      <Row label="Ask" id={askId}>
        <textarea className="field wide ask-field" rows={2} aria-labelledby={askId} aria-describedby={goesId} placeholder="A question for the web" value={text}
          onChange={(event) => { setText(event.currentTarget.value); setRefusal(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canAsk) { event.preventDefault(); void send() } }} />
        <div className="ask-line">
          <span className="muted" id={goesId}>{waits ?? `Goes to ${props.researcher}.`}</span>
          {text.length > characters * 0.9 ? <span className="faint">{thousands(text.length)} of {thousands(characters)} characters</span> : null}
          <button type="button" className="small" disabled={!canAsk} title="Ctrl+Enter" onClick={() => void send()}>{sending ? 'Asking…' : 'Ask'}</button>
        </div>
        {refusal !== null ? <p className="ask-reply" role="alert">Not asked: {refusal}</p> : null}
      </Row>
      {running ? (
        <div className="page-note with-action" role="status">
          <span className="note-text">
            <strong>{`${askerName(running.by, props.sessionName)} ${running.by.kind === 'owner' ? 'are' : 'is'} asking ${running.researcher ?? 'the web'}`}</strong>
            <span className="faint">{` · started ${clockWords(running.at)}`}</span>
            <span className="one-line muted">{firstLine(running.question)}</span>
          </span>
          <button type="button" className="small" disabled={props.busy} onClick={props.stop}>Stop</button>
        </div>
      ) : null}
      {kept.length === 0 && !running ? <p className="page-note">{"No questions yet. Yours and your agents' are kept here with their answers."}</p> : null}
      {kept.length > 0 ? <div className="question-lines">{kept.slice(0, SHOWN).map(line)}</div> : null}
      {kept.length > SHOWN ? (
        <details className="advanced">
          <summary>Earlier · {plural(kept.length - SHOWN, 'question')}</summary>
          <div className="question-lines">{kept.slice(SHOWN).map(line)}</div>
        </details>
      ) : null}
      {kept.length === 0 ? null : confirming ? (
        <div className="page-note with-action" role="group" aria-label="Remove all questions">
          <span className="note-text">{`Remove ${kept.length === 1 ? 'the one kept question' : `all ${kept.length} kept questions`}? Their words, answers and claims are deleted.${running ? ' The one under way stays.' : ''}`}</span>
          <button type="button" className="small" disabled={props.busy} onClick={() => { setConfirming(false); setOpenId(null); props.remove(null) }}>Remove all</button>
          <button type="button" className="small" autoFocus onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : (
        <div className="page-foot">
          <p className="preferences-help">BMN keeps the newest {keptLimit} questions with their answers.</p>
          <span className="spacer" />
          <button type="button" className="small" onClick={() => setConfirming(true)}>Remove all…</button>
        </div>
      )}
    </section>
  )
}

/** One kept question: its first line, when and who, and the outcome at the far end; the whole line opens it. */
function QuestionLine(props: {
  record: WebQuestionView; open: boolean; busy: boolean; now?: Date | undefined
  sessionName(id: string): string | undefined; toggle(): void; remove(): void; openPage(claim: number): void
}): React.JSX.Element {
  const { record } = props
  const bodyId = useId()
  const facts = evidenceWords(record.counts)
  return (
    <div className={`question${props.open ? ' open' : ''}${record.outcome === 'answered' ? '' : ' quiet'}`} data-question={record.id}>
      <button type="button" className="question-line" aria-expanded={props.open} aria-controls={props.open ? bodyId : undefined} onClick={props.toggle}>
        <span className="question-text">
          <span className="one-line">{firstLine(record.question)}</span>
          <span className="model-facts">
            <span className="when">{whenWords(record.at, props.now)}</span>
            <span>{`${askerName(record.by, props.sessionName)} asked${record.researcher ? ` ${record.researcher}` : ''}`}</span>
            {facts ? <span>{facts}</span> : null}
          </span>
        </span>
        <span className="outcome">{OUTCOME_WORDS[record.outcome]}</span>
      </button>
      {props.open ? <QuestionBody id={bodyId} record={record} busy={props.busy} remove={props.remove} openPage={props.openPage} /> : null}
    </div>
  )
}

function QuestionBody(props: { id: string; record: WebQuestionView; busy: boolean; remove(): void; openPage(claim: number): void }): React.JSX.Element {
  const { record } = props
  // Each claim keeps its place in the record: that place, never an address from this window, is what a page is opened by.
  const claims = (record.claims ?? []).map((claim, index) => ({ claim, index }))
  const found = claims.filter((entry) => entry.claim.mark === WEB_QUESTION_MARKS.found)
  const rest = claims.filter((entry) => entry.claim.mark !== WEB_QUESTION_MARKS.found)
  const shown = (entries: typeof claims): React.JSX.Element[] => entries.map((entry) => <Claim key={entry.index} claim={entry.claim} openPage={() => props.openPage(entry.index)} />)
  return (
    <div className="question-body" id={props.id}>
      {record.question === null ? <p className="muted">{"The question's words were not kept."}</p> : <p className="whole">{record.question}</p>}
      {record.note ? <p>{OUTCOME_WORDS[record.outcome]}: {record.note}</p> : null}
      {record.answer ? <><h5 className="part-label">Answer</h5><p className="whole">{record.answer}</p></> : null}
      {claims.length > 0 ? (
        <>
          <h5 className="part-label">Claims</h5>
          <p className="preferences-help">{found.length === 0 ? 'None of these is evidence: no passage was found on its page.' : `${found.length} of ${claims.length} ${found.length === 1 ? 'is' : 'are'} evidence: BMN found the passage on the page.`} Pages open in your browser.</p>
          {found.length > 0 ? <ul className="claims" aria-label="Evidence">{shown(found)}</ul> : null}
          {rest.length > 0 ? (
            <>
              <p className="part-label">Not evidence</p>
              <ul className="claims" aria-label="Not evidence">{shown(rest)}</ul>
            </>
          ) : null}
        </>
      ) : null}
      {record.notFound && record.notFound.length > 0 ? (
        <><h5 className="part-label">Looked for, not found</h5><ul className="plain-lines">{record.notFound.map((words, index) => <li key={index}>{words}</li>)}</ul></>
      ) : null}
      <div className="page-foot">
        {record.tookMs !== undefined ? <span className="faint">Took {tookWords(record.tookMs)}</span> : null}
        <span className="spacer" />
        <button type="button" className="small" disabled={props.busy} onClick={props.remove}>Remove</button>
      </div>
    </div>
  )
}

/** A claim with its mark, the passage quoted and its page; only a found passage stands on a plate. */
function Claim(props: { claim: WebQuestionClaim; openPage(): void }): React.JSX.Element {
  const { claim } = props
  const shown = claim.source.replace(/^https:\/\/(www\.)?/, '')
  return (
    <li className={claim.mark === WEB_QUESTION_MARKS.found ? 'claim found' : 'claim'}>
      <span className="mark">{capital(claim.mark)}{claim.why ? `: ${claim.why}` : ''}</span>
      <span>{claim.claim}</span>
      <span className="passage">“{claim.passage}”</span>
      {claim.source.startsWith('https://')
        ? <a className="page-link mono one-line" href={claim.source} title={claim.source} aria-label={`${shown}, opens in your browser`} onClick={(event) => { event.preventDefault(); props.openPage() }}>{shown}</a>
        : <span className="mono one-line">{claim.source}</span>}
    </li>
  )
}
