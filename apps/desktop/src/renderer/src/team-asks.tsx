// MODULE: team-asks.tsx - Story 73.1: Preferences › Agents › Asks: a read-only record of every ask his agents made on this computer, newest first, with what was readable and what the teammate's mode could read (72.9), who answered and its sub-agents, the answer as the teammate's own words, the usage, Stop, Copy, Export and Remove
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { TeamAskDetail, TeamAskLine, TeamAskProjectState, TeamAskState, TeamAskSubagentView, TeamAskUsageView, TeamAsksSnapshot } from '@bmn/protocol'
import { plural, thousandsWithCommas } from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { roleName } from './roster-staging'
import { displayPath } from './session-presentation'
import { PageHead } from './team-preferences'
import { askerName, firstLine, whenWords } from './web-questions'

/** How many asks show before the rest go under "Earlier". */
const SHOWN = 12
/** An agent may ask at any moment; an ask under way moves faster. */
const IDLE_POLL_MS = 4000
const BUSY_POLL_MS = 1500

/** One or two plain words per outcome, in weight; no colour says more. */
export const ASK_OUTCOME_WORDS: Readonly<Record<TeamAskState, string>> = {
  running: 'Asking now', answered: 'Answered', failed: 'Failed', refused: 'Refused', 'out-of-time': 'Out of time', stopped: 'Stopped', 'not-attributed': 'Not attributed', interrupted: 'Cut short'
}


export function outcomeWords(state: string): string {
  return ASK_OUTCOME_WORDS[state as TeamAskState] ?? (state.charAt(0).toUpperCase() + state.slice(1).replace(/-/gu, ' '))
}

/** "a", "a and b", "a, b and c". */
const listWords = (parts: string[]): string => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`)

/** What the teammate could read, as one phrase: "the question only", "the question and 3 files", "the question, 1 file and its working folder", "… · public". */
export function readsWords(reads: TeamAskLine['reads'], data: 'public' | 'private'): string {
  const parts = [reads.files > 0 ? plural(reads.files, 'file') : null, reads.pictures > 0 ? plural(reads.pictures, 'picture') : null, reads.reach,
    reads.browser === undefined ? null : `the app at ${reads.browser.origin}${reads.browser.interact ? ', clicking and typing' : ', looking only'}`].filter((part): part is string => part !== null)
  const words = parts.length === 0 ? 'the question only' : listWords(['the question', ...parts])
  return data === 'public' ? `${words} · public` : words
}

/** One page a browser ask visited: its address and the title the app gave it, both the app's own text. */
function pageWords(page: NonNullable<TeamAskDetail['browser']>['pages'][number]): string {
  return page.title === null || page.title === '' ? page.url : `${page.url} · ${page.title}`
}

/** A project's state at one end of an ask: "a1b2c3d4e5f6, clean", "a1b2c3d4e5f6, 2 changes", "not a Git working tree". */
export function projectStateWords(state: TeamAskProjectState | null): string {
  if (state === null) return 'not read'
  if (state.commit === null && state.clean === null) return state.reason ?? 'not a Git working tree'
  const tree = state.clean === null ? 'its tree unread' : state.clean ? 'clean' : state.changed === null ? 'changed' : plural(state.changed, 'change')
  return `${state.commit === null ? 'no commit' : state.commit.slice(0, 12)}, ${tree}`
}

/** One sub-agent: "Check the tests · Codex sub-agent · gpt-5.5 high · 2,410 in · 96 out", or why its usage is not added. */
export function subagentWords(entry: TeamAskSubagentView): string {
  const model = [entry.model, entry.effort].filter((part) => part !== null).join(' ')
  const usage = entry.usage === null ? entry.usageNote
    : [entry.usage.input === null ? null : `${thousandsWithCommas(entry.usage.input)} in`, entry.usage.output === null ? null : `${thousandsWithCommas(entry.usage.output)} out`].filter((part) => part !== null).join(' · ') || 'usage unknown'
  const own = entry.ownTokens === null ? null : `${thousandsWithCommas(entry.ownTokens)} tokens of its own`
  return [entry.name ?? entry.role ?? `session ${entry.session}`, entry.kind, model === '' ? null : model, usage, own].filter((part) => part !== null && part !== '').join(' · ')
}

/** "48 s", "4 min 12 s", "30 min": a line's short time. */
export function shortTook(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds} s`
  return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`
}

/** "2 minutes 4 seconds": the opened ask's time. */
function longTook(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return plural(seconds, 'second')
  return seconds % 60 === 0 ? plural(minutes, 'minute') : `${plural(minutes, 'minute')} ${plural(seconds % 60, 'second')}`
}

/** How long a run took, or has taken so far by the main process's clock, in milliseconds; null where it never started. */
export function elapsedMs(line: TeamAskLine): number | null {
  const started = line.startedAt === null ? Number.NaN : Date.parse(line.startedAt)
  const until = line.state === 'running' ? (line.now === undefined ? Number.NaN : Date.parse(line.now)) : line.endedAt === null ? Number.NaN : Date.parse(line.endedAt)
  return Number.isFinite(started) && Number.isFinite(until) ? Math.max(0, until - started) : null
}

function billingWords(billing: string): string {
  return billing === 'subscription' ? 'subscription' : billing === 'per_token' ? 'paid per token' : 'billing unknown'
}

export function costWords(cost: number | null): string {
  if (cost === null) return 'cost unknown'
  // A real cost too small for four places (an OpenCode Go ask's $0.0000458) is not shown as nothing.
  return cost > 0 && cost < 0.00005 ? 'under $0.0001' : `$${cost.toFixed(4)}`
}

/** A line's usage: tokens in and out, the cost the app reported or "cost unknown", and the billing basis. */
export function usageWords(line: Pick<TeamAskLine, 'state' | 'usage'>): string {
  if (line.state === 'running') return 'usage at the end'
  const usage = line.usage
  if (usage === null) return line.state === 'refused' ? 'no usage' : 'usage unknown'
  if (usage.input === null && usage.output === null && usage.reportedCost === null) return `usage unknown · ${billingWords(usage.billing)}`
  return [usage.input === null ? null : `${thousandsWithCommas(usage.input)} in`, usage.output === null ? null : `${thousandsWithCommas(usage.output)} out`, costWords(usage.reportedCost), billingWords(usage.billing), usage.complete === false ? 'incomplete' : null]
    .filter((part) => part !== null).join(' · ')
}

/** The opened ask's usage, every count the app reported. */
export function fullUsageWords(usage: TeamAskUsageView | null): string {
  if (usage === null) return 'not reported'
  const counts: Array<[number | null, string]> = [[usage.input, 'in'], [usage.cached, 'cached'], [usage.output, 'out'], [usage.reasoning, 'reasoning']]
  const incomplete = usage.complete === false ? [`incomplete: ${usage.incompleteReason ?? 'not every usage record was read'}`] : []
  return [...counts.filter(([value]) => value !== null).map(([value, word]) => `${thousandsWithCommas(value as number)} ${word}`), costWords(usage.reportedCost), billingWords(usage.billing), ...incomplete].join(' · ')
}

/** Bytes as the page says them: "41 KB", "2.8 MB". */
export function sizeWords(bytes: number | null): string {
  if (bytes === null) return 'size unknown'
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

interface TeamAsksState {
  snapshot: TeamAsksSnapshot | null
  loadError: string | null
  /** A Stop, a removal or an export is on its way. */
  busy: boolean
  /** What the last Stop, removal, export or copy said, or null. */
  notice: { ok: boolean; text: string } | null
  detail(id: string): Promise<TeamAskDetail>
  stop(id: string): void
  remove(id: string | null): void
  exportAsk(id: string): void
  copy(text: string): void
}

/** What the page shows, read when it opens and again while it stays open: an agent may ask at any moment. */
export function useTeamAsksState(): TeamAsksState {
  const [snapshot, setSnapshot] = useState<TeamAsksSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const adopt = useCallback((next: TeamAsksSnapshot): void => {
    if (!alive.current) return
    setSnapshot(next)
    setLoadError(null)
  }, [])
  const load = useCallback(async (): Promise<void> => {
    try {
      adopt(await window.aiTerminal.teamAsks())
    } catch (error) {
      if (alive.current) setLoadError(failureDetail(error, 'Could not read the asks'))
    }
  }, [adopt])
  const moving = snapshot?.asks.some((line) => line.state === 'running') ?? false
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), moving ? BUSY_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [load, moving])
  const act = useCallback((task: () => Promise<TeamAsksSnapshot>, failed: string): void => {
    setBusy(true)
    setNotice(null)
    task().then(adopt, (error: unknown) => { if (alive.current) setNotice({ ok: false, text: failureDetail(error, failed) }) }).finally(() => { if (alive.current) setBusy(false) })
  }, [adopt])
  return {
    snapshot, loadError, busy, notice,
    detail: (id) => window.aiTerminal.teamAskDetail(id),
    stop: (id) => act(() => window.aiTerminal.stopTeamAsk(id), 'The ask could not be stopped'),
    remove: (id) => act(() => window.aiTerminal.removeTeamAsks(id), id === null ? 'The asks could not be removed' : 'The ask could not be removed'),
    exportAsk: (id) => {
      setBusy(true)
      setNotice(null)
      window.aiTerminal.exportTeamAsk(id).then((done) => {
        if (alive.current && done.output !== null) setNotice({ ok: true, text: `Exported ${plural(done.files, 'file')} to ${done.output}` })
      }, (error: unknown) => { if (alive.current) setNotice({ ok: false, text: failureDetail(error, 'The ask could not be exported') }) })
        .finally(() => { if (alive.current) setBusy(false) })
    },
    copy: (text) => {
      window.aiTerminal.writeClipboardText(text).then(() => { if (alive.current) setNotice({ ok: true, text: 'Answer copied.' }) },
        (error: unknown) => { if (alive.current) setNotice({ ok: false, text: failureDetail(error, 'Could not copy to the clipboard') }) })
    }
  }
}

export interface TeamAsksProps {
  snapshot: TeamAsksSnapshot
  busy: boolean
  notice?: { ok: boolean; text: string } | null
  home: string | null
  sessionName(id: string): string | undefined
  detail(id: string): Promise<TeamAskDetail>
  stop(id: string): void
  remove(id: string | null): void
  exportAsk(id: string): void
  copy(text: string): void
  /** The ask that is open when the page first shows; the owner opens and closes them after that. */
  initiallyOpen?: string
  /** That ask as already read, so it shows at once. */
  initialDetail?: TeamAskDetail
  now?: Date
}

/** Agents › Asks: the places in use, every ask newest first, an opened one in place, and Remove all. Asking is the agents'; the page only reads and controls. */
export function TeamAsks(props: TeamAsksProps): React.JSX.Element {
  const { snapshot } = props
  const headId = useId()
  const [openId, setOpenId] = useState<string | null>(props.initiallyOpen ?? null)
  const [confirming, setConfirming] = useState(false)
  const ended = snapshot.asks.filter((line) => line.state !== 'running')
  const running = snapshot.asks.length - ended.length
  const line = (record: TeamAskLine): React.JSX.Element => (
    <AskLine key={record.id} line={record} open={openId === record.id} busy={props.busy} home={props.home} sessionName={props.sessionName} now={props.now}
      initialDetail={props.initialDetail?.line.id === record.id ? props.initialDetail : undefined}
      toggle={() => setOpenId(openId === record.id ? null : record.id)} detail={props.detail} stop={() => props.stop(record.id)}
      remove={() => { setOpenId(null); props.remove(record.id) }} exportAsk={() => props.exportAsk(record.id)} copy={props.copy} />
  )
  return (
    <>
      <PageHead title="Asks" status={`${snapshot.places.used} of ${snapshot.places.capacity} places in use`} />
      <section className="team-asks" aria-labelledby={headId}>
        <h4 className="group-head" id={headId}>Every ask<span className="caption">{"your agents', newest first"}</span></h4>
        {props.notice ? <p className={props.notice.ok ? 'page-note' : 'preferences-error'} role={props.notice.ok ? 'status' : 'alert'}>{props.notice.text}</p> : null}
        {snapshot.asks.length === 0 ? (
          <p className="page-note">{`No asks yet. Your agents' asks are kept here with their answers, ${snapshot.keptDays} days after each ends.`}</p>
        ) : <div className="question-lines">{snapshot.asks.slice(0, SHOWN).map(line)}</div>}
        {snapshot.asks.length > SHOWN ? (
          <details className="advanced">
            <summary>Earlier · {plural(snapshot.asks.length - SHOWN, 'ask')}</summary>
            <div className="question-lines">{snapshot.asks.slice(SHOWN).map(line)}</div>
          </details>
        ) : null}
        {ended.length === 0 ? null : confirming ? (
          <div className="page-note with-action" role="group" aria-label="Remove all asks">
            <span className="note-text">{`Remove ${ended.length === 1 ? 'the one ended ask' : `all ${ended.length} ended asks`}? Their questions, answers and records are deleted.${running > 0 ? ` ${running === 1 ? 'The ask under way stays' : `The ${running} asks under way stay`}.` : ''}`}</span>
            <button type="button" className="small" disabled={props.busy} onClick={() => { setConfirming(false); setOpenId(null); props.remove(null) }}>Remove all</button>
            <button type="button" className="small" autoFocus onClick={() => setConfirming(false)}>Keep</button>
          </div>
        ) : (
          <div className="page-foot">
            <p className="preferences-help">{`${plural(snapshot.asks.length, 'ask')} kept ${snapshot.keptDays} days after each ends, or until removed. Export writes an allowlisted record: no sign-in, no app home.`}</p>
            <span className="spacer" />
            <button type="button" className="small" onClick={() => setConfirming(true)}>Remove all…</button>
          </div>
        )}
      </section>
    </>
  )
}

/** "bash (Claude Code) asked Astra" with the effort in figures' weight. */
function AskedWhom(props: { line: TeamAskLine; sessionName(id: string): string | undefined }): React.JSX.Element {
  const { line } = props
  return <span>{`${askerName(line.by, props.sessionName)} asked ${line.agentName ?? 'the team'}`}{line.effort ? <> <span className="num">{line.effort}</span></> : null}</span>
}

/** One ask: its first line; when, who asked whom, the role, the project, what was readable, the time and the usage; the outcome at the far end. */
function AskLine(props: {
  line: TeamAskLine; open: boolean; busy: boolean; home: string | null; now?: Date | undefined; initialDetail?: TeamAskDetail | undefined
  sessionName(id: string): string | undefined; toggle(): void; detail(id: string): Promise<TeamAskDetail>
  stop(): void; remove(): void; exportAsk(): void; copy(text: string): void
}): React.JSX.Element {
  const { line } = props
  const bodyId = useId()
  const going = line.state === 'running'
  const took = elapsedMs(line)
  const timeFacts = took === null ? null : going ? `${shortTook(took)} of ${line.timeLimitMinutes ?? '?'} min` : shortTook(took)
  const at = line.askedAt ?? line.startedAt
  return (
    <div className={`question${props.open ? ' open' : ''}${line.state === 'answered' ? '' : ' quiet'}`} data-ask={line.id}>
      <div className="ask-line-row">
        <button type="button" className="question-line" aria-expanded={props.open} aria-controls={props.open ? bodyId : undefined} onClick={props.toggle}>
          <span className="question-text">
            <span className="one-line">{line.question === null ? 'The question was not recorded' : firstLine(line.question)}</span>
            <span className="model-facts">
              <span className="when">{at === null ? 'unknown time' : whenWords(at, props.now)}</span>
              <AskedWhom line={line} sessionName={props.sessionName} />
              {line.role ? <span>{roleName(line.role)}</span> : null}
              {line.project ? <span className="mono path-fact">{displayPath(line.project, props.home)}</span> : null}
              <span>{readsWords(line.reads, line.data)}</span>
              {timeFacts ? <span className="num">{timeFacts}</span> : null}
              <span>{usageWords(line)}</span>
            </span>
            {line.reason && !going ? <span className="reason">{line.reason}</span> : null}
          </span>
          <span className="outcome">{outcomeWords(line.state)}</span>
        </button>
        {going ? <button type="button" className="small stop" disabled={props.busy} aria-label={`Stop the ask to ${line.agentName ?? 'the team'}`} onClick={props.stop}>Stop</button> : null}
      </div>
      {props.open ? <AskBody id={bodyId} line={line} busy={props.busy} initial={props.initialDetail} detail={props.detail} remove={props.remove} exportAsk={props.exportAsk} copy={props.copy} home={props.home} /> : null}
    </div>
  )
}

/** The opened ask: the whole question, what it read, who answered, the answer as plain text, the usage and time, and its actions. */
function AskBody(props: {
  id: string; line: TeamAskLine; busy: boolean; home: string | null; initial?: TeamAskDetail | undefined
  detail(id: string): Promise<TeamAskDetail>; remove(): void; exportAsk(): void; copy(text: string): void
}): React.JSX.Element {
  const { line } = props
  const [detail, setDetail] = useState<TeamAskDetail | null>(props.initial ?? null)
  const [failure, setFailure] = useState<string | null>(null)
  const read = props.detail
  // Read again when the run moves on: a running ask opened now has its answer when it ends.
  useEffect(() => {
    let live = true
    read(line.id).then((next) => { if (live) { setDetail(next); setFailure(null) } }, (error: unknown) => { if (live) setFailure(failureDetail(error, 'Could not open the ask')) })
    return () => { live = false }
  }, [read, line.id, line.state, line.endedAt])
  if (failure !== null) return <div className="question-body" id={props.id}><p className="preferences-error" role="alert">{failure}</p></div>
  if (detail === null) return <div className="question-body" id={props.id}><p className="muted">Opening…</p></div>
  const name = line.agentName ?? 'The teammate'
  const going = line.state === 'running'
  const took = elapsedMs(line)
  const teammate = detail.teammate
  const appWords = [teammate.appName === null ? null : `${teammate.appName}${teammate.appVersion ? ` ${teammate.appVersion}` : ''}`, teammate.model, line.effort].filter((part) => part !== null).join(' · ')
  const session = teammate.session === null ? null : `session ${teammate.session}${teammate.sessionSource ? ` from ${teammate.sessionSource}` : ''}`
  return (
    <div className="question-body" id={props.id}>
      {detail.question === null ? <p className="muted">The question was not recorded.</p> : <p className="whole">{detail.question}</p>}
      {detail.question !== null && !detail.questionWhole ? <p className="preferences-help">Only its first line is known: this ask was made before BMN kept the question on its own.</p> : null}
      <dl className="kv ask-facts">
        <dt>Readable</dt>
        <dd className="wrap">
          {readsWords(line.reads, line.data)}
          {detail.files.map((file) => <span key={file.path}> · <span className="mono">{displayPath(file.path, props.home)}</span> {sizeWords(file.bytes)}</span>)}
        </dd>
        {line.reads.words !== null || line.reads.folder !== null ? (
          <>
            <dt>Its mode</dt>
            <dd className="wrap">
              {line.reads.words ?? 'not recorded'}
              {line.reads.folder !== null ? <span> · worked in <span className="mono">{displayPath(line.reads.folder, props.home)}</span></span> : null}
            </dd>
          </>
        ) : null}
        {detail.project?.root ? (
          <>
            <dt>Project</dt>
            <dd className="wrap">
              <span className="mono">{displayPath(detail.project.root, props.home)}</span>
              {` · at the start ${projectStateWords(detail.project.start)}`}
              {going ? '' : ` · at the end ${projectStateWords(detail.project.end)}`}
            </dd>
          </>
        ) : null}
        {detail.pictures.length > 0 ? (
          <>
            <dt>Pictures</dt>
            <dd className="wrap">
              <ul className="plain-lines" aria-label="Pictures it saw">
                {detail.pictures.map((picture, index) => <li key={index}>{pictureWords(picture)}</li>)}
              </ul>
            </dd>
          </>
        ) : null}
        {detail.browser !== null ? (
          <>
            <dt>Pages</dt>
            <dd className="wrap">
              {going ? <span className="muted">Recorded when the ask ends.</span> : detail.browser.pages.length === 0 ? <span className="muted">No page was visited.</span> : (
                <ul className="plain-lines" aria-label="Pages it visited">
                  {detail.browser.pages.map((page, index) => <li key={index} className="mono">{pageWords(page)}</li>)}
                </ul>
              )}
              {!going && detail.browser.pages.length > 0 ? <span className="faint">The app&apos;s own text, shown as plain text</span> : null}
            </dd>
            <dt>Screenshots</dt>
            <dd className="wrap">
              {going ? <span className="muted">Recorded when the ask ends.</span> : detail.browser.screenshots.length === 0 ? <span className="muted">None taken.</span> : (
                <ul className="plain-lines" aria-label="Screenshots it took">
                  {detail.browser.screenshots.map((shot) => <li key={shot.name}><span className="mono">{shot.name}</span> {sizeWords(shot.bytes)}</li>)}
                </ul>
              )}
            </dd>
            <dt>Its limit</dt>
            <dd className="wrap">{detail.browser.limit}</dd>
          </>
        ) : null}
        <dt>Teammate</dt>
        <dd className="wrap">{[name, appWords, session].filter((part) => part !== null && part !== '').join(' · ')}</dd>
        {detail.subagents.length > 0 ? (
          <>
            <dt>Sub-agents</dt>
            <dd className="wrap">
              <ul className="plain-lines" aria-label="Sub-agents it started">
                {detail.subagents.map((entry) => <li key={entry.session}>{subagentWords(entry)}</li>)}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
      {detail.answer !== null ? (
        <>
          <h5 className="part-label">Answer <span className="faint">{`· ${name}'s words, shown as plain text`}</span></h5>
          <p className="whole answer-plate">{detail.answer}</p>
        </>
      ) : going ? <p className="muted">{`${name} is answering. The answer shows here when the ask ends.`}</p>
        : line.reason ? <p>{outcomeWords(line.state)}: {line.reason}</p> : <p className="muted">No answer was kept.</p>}
      {detail.masked.length > 0 ? <p className="preferences-help">{`BMN masked what looked like ${listWords(detail.masked)} in the answer and the app's output, here, in the record and in an export.`}</p> : null}
      <dl className="kv ask-facts">
        <dt>Usage</dt>
        <dd className="wrap">{going ? 'usage at the end' : fullUsageWords(line.usage)}</dd>
        {!going && line.usage?.basis ? (
          <>
            <dt>Counted</dt>
            <dd className="wrap">{line.usage.basis}</dd>
          </>
        ) : null}
        <dt>Took</dt>
        <dd className="wrap">
          {took === null ? 'never started' : `${longTook(took)}${line.timeLimitMinutes === null ? '' : ` of ${plural(line.timeLimitMinutes, 'minute')}`}`}
          {line.keptUntil ? ` · kept until ${shortDay(line.keptUntil)}` : ''}
          {' · run '}<span className="mono">{line.id}</span>
        </dd>
      </dl>
      <div className="page-foot">
        <span className="spacer" />
        {detail.answer !== null ? <button type="button" className="small" onClick={() => props.copy(detail.answer ?? '')}>Copy</button> : null}
        <button type="button" className="small" disabled={props.busy || going} title={going ? 'Export once the ask ends' : undefined} onClick={props.exportAsk}>Export…</button>
        <button type="button" className="small" disabled={props.busy || going} title={going ? 'Stop the ask first' : undefined} onClick={props.remove}>Remove</button>
      </div>
    </div>
  )
}

/** "checkout.png · 1280 × 900 · 214 KB · PNG · took out: GPS, dates". */
export function pictureWords(picture: TeamAskDetail['pictures'][number]): string {
  const size = picture.width !== null && picture.height !== null ? `${picture.width} × ${picture.height}` : null
  const kind = picture.mediaType === '' ? null : picture.mediaType.replace(/^image\//u, '').toUpperCase()
  const out = picture.removed.length === 0 ? 'nothing taken out' : `took out: ${picture.removed.join(', ')}`
  return [picture.label, size, sizeWords(picture.bytes), kind, out].filter((part) => part !== null).join(' · ')
}

/** "14 Nov 2026". */
function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
