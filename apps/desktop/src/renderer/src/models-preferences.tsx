// MODULE: models-preferences.tsx - Story 60.10: Preferences › Team › Models: what research found for the team's models, who researches, and Apply prices
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ROSTER_APP_NAMES, type ResearchLookup, type ResearchModelView, type ResearchSnapshot, type ResearcherView, type RosterDataShape } from '@bmn/protocol'
import { Segmented } from './history-preferences'
import {
  applyPrices, dayWords, fillFrom, priceChanges, priceText, researchGroups, researchStatus, siteOf, unverifiedWords, type PriceChange, type ResearchFill, type TeamModelRow
} from './research-view'
import { Dot } from './roster-marks'
import { thousands } from './roster-staging'
import { PageHead, Row, shortDate } from './team-preferences'
import type { TeamState } from './team-state'
import { failureDetail } from './bridge-error'

export interface ResearchState {
  snapshot: ResearchSnapshot | null
  loadError: string | null
  busy: boolean
  notice: { ok: boolean; text: string } | null
  setNotice(notice: { ok: boolean; text: string } | null): void
  /** Reads what research found and asks each agent's app whether it could research; once, when Models opens. */
  ensure(): void
  /** Reads what research found without asking any app; once, for the pages that only offer its names. */
  peek(): void
  choose(researcher: string): void
  start(): Promise<void>
  stop(): Promise<void>
  lookUp(provider: string, model: string): Promise<ResearchLookup>
}

/** How often the page asks how far a run is. */
const POLL_MS = 1500

/** Research's state, held once by the Preferences dialog so a run going on survives a look at another page. */
export function useResearchState(): ResearchState {
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const asked = useRef<'none' | 'peek' | 'full'>('none')

  const adopt = useCallback((next: ResearchSnapshot): void => {
    setSnapshot((current) => {
      // A run that just ended says how, once.
      if (current?.running && next.running === null && next.ended !== null) setNotice(next.ended)
      // A plain read does not ask the apps again; the researchers stay as last read.
      return next.researchers.length === 0 && current !== null ? { ...next, researchers: current.researchers, researcher: next.researcher ?? current.researcher } : next
    })
    setLoadError(null)
  }, [])

  const load = useCallback(async (fresh: boolean): Promise<void> => {
    try {
      adopt(await window.aiTerminal.researchSnapshot(fresh))
    } catch (error) {
      setLoadError(failureDetail(error, 'Could not read what research found'))
    }
  }, [adopt])

  const running = snapshot?.running != null
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => void load(false), POLL_MS)
    return () => clearInterval(timer)
  }, [running, load])

  const act = useCallback(async (task: () => Promise<ResearchSnapshot>, failed: string): Promise<void> => {
    setBusy(true)
    try {
      adopt(await task())
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, failed) })
    } finally {
      setBusy(false)
    }
  }, [adopt])

  const ensure = useCallback((): void => {
    if (asked.current === 'full') return
    asked.current = 'full'
    void load(true)
  }, [load])
  const peek = useCallback((): void => {
    if (asked.current !== 'none') return
    asked.current = 'peek'
    void load(false)
  }, [load])

  return {
    snapshot, loadError, busy, notice, setNotice, ensure, peek,
    choose: (researcher) => void act(() => window.aiTerminal.chooseResearcher(researcher), 'Could not keep that choice'),
    start: () => {
      const researcher = snapshot?.researcher
      if (!researcher) return Promise.resolve()
      setNotice(null)
      return act(() => window.aiTerminal.startResearch(researcher), 'The research could not start')
    },
    stop: () => act(() => window.aiTerminal.stopResearch(), 'The research could not be stopped'),
    lookUp: async (provider, model) => {
      const researcher = snapshot?.researcher
      if (!researcher) return { ok: false, message: 'No agent on your team can research.', model: null }
      setBusy(true)
      try {
        const result = await window.aiTerminal.lookUpModel(researcher, provider, model)
        await load(false)
        return result
      } catch (error) {
        return { ok: false, message: failureDetail(error, 'Look up failed'), model: null }
      } finally {
        setBusy(false)
      }
    }
  }
}

/** What the Model field offers from research: every model found, and the day of the last research. */
export function researchedModels(snapshot: ResearchSnapshot | null): { models: readonly ResearchModelView[]; day: string | null } | undefined {
  if (snapshot === null || snapshot.models.length === 0) return undefined
  return { models: snapshot.models, day: snapshot.last ? dayWords(snapshot.last.at) : null }
}

/** What the researcher gets and where it runs, for the app the chosen agent runs on. */
export function researcherHint(harness: string | undefined): string {
  const sends = 'BMN sends only your model names and the source list.'
  if (harness === 'codex') return `${sends} Research runs in a separate empty folder, read-only, with web search on and Codex's command tools off.`
  return `${sends} Research runs in a separate empty folder with web tools only.`
}

/** A price or a capacity with where it was read; an unverified value says so before its site. */
function Sourced(props: { value: { source: string; as_of: string; verified: boolean; why?: string }; of: string; what: string }): React.JSX.Element {
  return (
    <>
      {props.value.verified ? null : <span className="faint" title={unverifiedWords(props.value.why)}>unverified ·</span>}
      <span className="mono source" title={props.value.source} aria-label={`${siteOf(props.value.source)}, ${props.what} source for ${props.of}`}>{siteOf(props.value.source)}</span>
      <span className="faint">{dayWords(props.value.as_of)}</span>
    </>
  )
}

/** The agents that cannot research now, each with why in a few plain words; the check's own message stays in `bmn roster check`. */
export function notOffered(unable: readonly ResearcherView[]): string {
  return unable.length === 0 ? '' : ` Not offered: ${unable.map((entry) => (entry.why ? `${entry.name} (${entry.why})` : entry.name)).join(', ')}.`
}

function Facts(props: { model: ResearchModelView }): React.JSX.Element {
  const { model } = props
  return (
    <>
      <div className="model-facts">
        {model.price
          ? <><span className="mono">{priceText(model.price)}</span><span className="faint">per M tokens, in / out</span><Sourced value={model.price} of={model.id} what="price" /></>
          : <span className="faint">No price found</span>}
      </div>
      {model.contextWindow ? (
        <div className="model-facts">
          <span>{thousands(model.contextWindow.tokens)} tokens</span><span className="faint">context window</span><Sourced value={model.contextWindow} of={model.id} what="context window" />
        </div>
      ) : null}
    </>
  )
}

function FoundLine(props: { model: ResearchModelView; provider: string; add(): void }): React.JSX.Element {
  const { model } = props
  return (
    <div className="model-line" data-model={model.id}>
      <div className="model-text">
        <div><span className="mono">{model.id}</span> <span className="faint">{props.provider}</span></div>
        <Facts model={model} />
        {model.foundLast ? null : <div className="faint">Not found this time · last seen {dayWords(model.lastSeen)}</div>}
      </div>
      <button type="button" className="small" aria-label={`Add ${model.id} to team`} onClick={props.add}>Add to team…</button>
    </div>
  )
}

function TeamLine(props: { row: TeamModelRow; researched: boolean }): React.JSX.Element {
  const { row } = props
  return (
    <div className="model-line" data-model={row.model}>
      <div className="model-text">
        <div><span className="mono">{row.model}</span> <span className="faint">{row.agents.join(', ')} · {row.provider}</span></div>
        {row.found === null
          ? <div className="faint">{props.researched ? 'Never found by the research' : 'Not researched yet'}</div>
          : (
            <>
              <Facts model={row.found} />
              {row.differs ? <div className="faint">Your team has {row.teamHas ? priceText(row.teamHas) : 'no price'}</div> : null}
              {row.found.foundLast ? null : <div className="faint">Not found this time · last seen {dayWords(row.found.lastSeen)}</div>}
            </>
          )}
      </div>
      {row.differs ? <Dot label="Price differs from your team's" /> : <span />}
    </div>
  )
}

/** The review before prices are staged: each agent, what it records, what research found, and the page it was read on. */
function ApplyPrices(props: { changes: readonly PriceChange[]; onStage(): void; onCancel(): void }): React.JSX.Element {
  const count = props.changes.length
  const title = count === 1 ? 'Stage one price' : `Stage ${count} prices`
  return (
    <div className="sheet" role="group" aria-label={title}>
      <div className="sheet-head"><b>{title}</b><span className="muted">Each is read from the page beside it. Nothing changes until you approve.</span></div>
      <div className="price-changes">
        {props.changes.map((change) => (
          <div className="price-change" key={change.agent} data-agent={change.agent}>
            <span>{change.name} <span className="faint mono">{change.model}</span></span>
            <span className="mono">{change.before ? priceText(change.before) : 'no price'} → {priceText(change.after)}</span>
            <span className="mono wrap faint">{change.after.source}</span>
          </div>
        ))}
      </div>
      <div className="inline">
        <button type="button" className="primary" onClick={props.onStage}>{title}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export function ModelsPage(props: { team: TeamState; data: RosterDataShape; research: ResearchState; add(fill: ResearchFill): void }): React.JSX.Element {
  const { research, data, team } = props
  const researcherId = useId()
  const [applying, setApplying] = useState(false)
  // Said while the staged prices wait for approval; gone once they are approved or discarded.
  const [staged, setStaged] = useState<string | null>(null)
  const ensure = research.ensure
  useEffect(() => ensure(), [ensure])
  const snapshot = research.snapshot
  if (research.loadError) return <><PageHead title="Models" /><p className="preferences-error" role="alert">{research.loadError}</p></>
  if (snapshot === null) return <><PageHead title="Models" /><p className="page-note">Reading what research found…</p></>
  const able = snapshot.researchers.filter((entry) => entry.ok)
  const unable = snapshot.researchers.filter((entry) => !entry.ok)
  const chosen = able.find((entry) => entry.id === snapshot.researcher)
  const groups = researchGroups(snapshot.models, data)
  const changes = priceChanges(snapshot.models, data)
  const running = snapshot.running !== null
  const lastDay = snapshot.last ? dayWords(snapshot.last.at) : null
  // The provider is the team's own, by the name the team gives it; the researcher's wording of it is not shown.
  const providerName = (model: ResearchModelView): string => data.providers.find((provider) => provider.id === model.providerId)?.name ?? model.provider
  return (
    <>
      <PageHead title="Models" status={researchStatus(snapshot, shortDate)}>
        {running
          ? <button type="button" disabled={research.busy} onClick={() => void research.stop()}>Stop</button>
          : <button type="button" disabled={research.busy || chosen === undefined} title={chosen === undefined ? 'No agent on your team can research' : undefined} onClick={() => void research.start()}>Research now</button>}
      </PageHead>
      {staged !== null && team.hasStaged ? <p className="preferences-success" role="status">{staged}</p>
        : research.notice ? <p className={research.notice.ok ? 'preferences-success' : 'preferences-error'} role={research.notice.ok ? 'status' : 'alert'}>{research.notice.text}</p> : null}
      {!running && research.notice === null && snapshot.last?.note ? <p className="page-note" role="status">The last research did not finish: {snapshot.last.note}</p> : null}
      <Row label="Researcher" id={researcherId}
        hint={able.length === 0
          ? 'Research needs an active agent on Claude Code or Codex whose provider may see private work. A price can still be written in the team file.'
          : `${researcherHint(chosen?.harness)}${notOffered(unable)}`}>
        {able.length === 0
          ? <span className="muted">No agent on your team can research.</span>
          : <Segmented labelledBy={researcherId} fit options={able.map((entry) => entry.id)} value={chosen?.id ?? able[0]!.id} disabled={running || research.busy}
              optionLabel={(id) => able.find((entry) => entry.id === id)?.name ?? id} onChange={(id) => research.choose(id)} />}
      </Row>
      <Row label="Sources" hint="Prices come from provider pages first; other sites are cited and never override. BMN reads each cited page itself and marks what it cannot confirm.">
        <ol className="sources"><li>Provider pages</li><li>Other sites</li></ol>
      </Row>
      {applying && changes.length > 0 ? (
        <ApplyPrices changes={changes} onCancel={() => setApplying(false)} onStage={() => {
          team.stage(applyPrices(data, changes))
          setApplying(false)
          setStaged(changes.length === 1 ? 'One price staged. Approve it below.' : `${changes.length} prices staged. Approve them below.`)
        }} />
      ) : changes.length > 0 ? (
        <div className="page-note with-action" role="status">
          <Dot label="Needs you" /><span className="note-text">{changes.length === 1 ? "One price differs from your team's." : `${changes.length} prices differ from your team's.`}</span>
          <button type="button" className="small" onClick={() => setApplying(true)}>Apply prices…</button>
        </div>
      ) : null}
      {groups.fresh.length > 0 ? (
        <>
          <h4 className="group-head">{snapshot.previousAt ? `New since ${dayWords(snapshot.previousAt)}` : 'Not on your team'}<span className="caption">first seen by the research on {lastDay}</span></h4>
          <div className="model-lines">{groups.fresh.map((model) => <FoundLine key={`${model.providerId}|${model.id}`} model={model} provider={providerName(model)} add={() => props.add(fillFrom(model, data))} />)}</div>
        </>
      ) : null}
      <h4 className="group-head">Your team<span className="caption">as the research found them</span></h4>
      <div className="model-lines">{groups.team.map((row) => <TeamLine key={`${row.providerId}|${row.model}`} row={row} researched={snapshot.last !== null} />)}</div>
      {groups.earlier.length > 0 ? (
        <details className="advanced">
          <summary>Found earlier · {groups.earlier.length} model{groups.earlier.length === 1 ? '' : 's'}</summary>
          <div className="model-lines">{groups.earlier.map((model) => <FoundLine key={`${model.providerId}|${model.id}`} model={model} provider={providerName(model)} add={() => props.add(fillFrom(model, data))} />)}</div>
        </details>
      ) : null}
      <p className="preferences-help">Research changes nothing by itself. Apply prices and Add to team stage changes you approve. BMN does not check that an app takes a name found here. {ROSTER_APP_NAMES.opencode} and {ROSTER_APP_NAMES.cursor} agents cannot research.</p>
    </>
  )
}
