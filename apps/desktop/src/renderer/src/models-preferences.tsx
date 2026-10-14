// MODULE: models-preferences.tsx - Stories 60.10, 63.3: Preferences › Team › Models: what research found for the team's models, who researches, Codex behind its fence, and Apply prices
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { type ResearchLookup, type ResearchModelView, type ResearchSnapshot, type ResearcherView, type RosterDataShape, type RosterPriceShape } from '@bmn/protocol'
import { Segmented } from './history-preferences'
import {
  applyPrices, codexToolsLine, dayWords, fillFrom, priceChanges, priceText, researchGroups, researchStatus, siteOf, unverifiedWords, type PriceChange, type ResearchFill, type TeamModelRow
} from './research-view'
import { Dot, Piece } from './roster-marks'
import { listedAgents, nameResearchers, namedResearchers, thousands } from './roster-staging'
import { PageHead, Row, shortDate } from './team-preferences'
import type { TeamState } from './team-state'
import { WebQuestions, useWebQuestionsState } from './web-questions'
import { failureDetail } from './bridge-error'

export interface ResearchState {
  snapshot: ResearchSnapshot | null
  loadError: string | null
  busy: boolean
  notice: { ok: boolean; text: string } | null
  setNotice(notice: { ok: boolean; text: string } | null): void
  /** Reads what research found and asks each agent's app whether it could research: once, and again when the approved team is another version than the one last read for. */
  ensure(version?: number | null): void
  /** Reads what research found without asking any app; once, for the pages that only offer its names. */
  peek(): void
  /** Owner-run: starts the fence test of the installed Codex. It runs in the background and calls no provider. */
  testFence(): Promise<void>
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
  // The approved team the researchers were last read for: who can research is read from it.
  const readFor = useRef<number | null>(null)

  const adopt = useCallback((next: ResearchSnapshot): void => {
    setSnapshot((current) => {
      // A run that ended with nothing kept leaves no trace on the page, so it says how it ended; one that kept something shows in the head and the line under it.
      if (current?.running && next.running === null && next.ended !== null && !next.ended.kept) setNotice(next.ended)
      // The fence test ran in the background: how it ended is said once, when the page first hears of it.
      if (current?.fenceTest.running && !next.fenceTest.running && next.fenceTest.ended !== null) setNotice(next.fenceTest.ended)
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

  const running = snapshot?.running != null || snapshot?.fenceTest.running === true
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

  const ensure = useCallback((version: number | null = readFor.current): void => {
    if (asked.current === 'full' && version === readFor.current) return
    asked.current = 'full'
    readFor.current = version
    void load(true)
  }, [load])
  const peek = useCallback((): void => {
    if (asked.current !== 'none') return
    asked.current = 'peek'
    void load(false)
  }, [load])

  return {
    snapshot, loadError, busy, notice, setNotice, ensure, peek,
    testFence: () => {
      setNotice(null)
      return act(() => window.aiTerminal.testCodexFence(), 'The fence test could not start')
    },
    choose: (researcher) => void act(() => window.aiTerminal.chooseResearcher(researcher), 'Could not keep that choice'),
    start: () => {
      const researcher = snapshot?.researcher
      if (!researcher) return Promise.resolve()
      setNotice(null)
      return act(async () => {
        const next = await window.aiTerminal.startResearch(researcher)
        // Nothing started (a web question holds the research lock): the page says why now, since no run will end to say it.
        if (next.running === null && next.ended !== null && !next.ended.ok) setNotice(next.ended)
        return next
      }, 'The research could not start')
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

/**
 * What the researcher gets and where it runs. A Codex researcher has the same words as one on
 * Claude Code, as far as they hold for it, and one line more (63.3 AC4): Codex cannot be kept to
 * web tools alone, so the tools it keeps offering are named, with what showed that none of them
 * reads or writes the owner's files.
 */
export function researcherHint(researcher: Pick<ResearcherView, 'harness' | 'fence'> | undefined): string {
  const gets = 'Gets only your model names and the source list, never your files.'
  if (researcher?.harness !== 'codex') return `${gets} Runs in an empty folder with web tools only.`
  const first = researcher.fence?.compared === false ? ' Its first research starts by asking its provider for the model list and repeating the fence test under that list; a different tool list stops it before any answer is used.' : ''
  return `${gets} Runs in an empty folder, with a Codex folder of its own and web search. ${codexToolsLine(researcher.fence?.tools ?? [])}${first}`
}

/** What research needs, said where no agent on the team can research: `named` is who the team names, null for a team that has not chosen yet. */
export function noResearcherWords(named: readonly string[] | null): string {
  const where = 'on Claude Code, or on Codex or OpenCode where its fence test passed, whose provider may see private work'
  if (named === null) return `Research needs an active agent ${where}.`
  if (named.length === 0) return `Your team names no researcher, so nobody researches. Switch Researcher on on an agent's page: an active agent ${where}.`
  return `Research needs one of the researchers your team names: an active agent ${where}.`
}

/** The fence test's line on Models: how the installed Codex (or OpenCode, 70.3) stands for the team's researchers on it. */
export function fenceWords(codex: readonly ResearcherView[], app = 'Codex'): string {
  const waiting = codex.filter((entry) => !entry.ok && /fence test|other tools than/.test(entry.why ?? ''))
  const names = (entries: readonly ResearcherView[]): string => {
    const all = entries.map((entry) => entry.name)
    return all.length <= 1 ? all.join('') : `${all.slice(0, -1).join(', ')} and ${all.at(-1) as string}`
  }
  const about = `It runs ${app} against a stand-in on this computer with made-up files: no provider is called and none of your files is read. About a minute.`
  if (waiting.length === 0) return `Passed for the installed ${app}. ${about}`
  return `${names(waiting)} research${waiting.length === 1 ? 'es' : ''} only where this test passed for exactly the installed ${app}: ${waiting[0]!.why ?? 'it has not passed'}. ${about}`
}

type Read = { source: string; as_of: string; verified: boolean; why?: string }

/** The mark on a value BMN could not confirm on its page: it stands right after the value, since it says the value does not count. */
function Unverified(props: { value: Read }): React.JSX.Element | null {
  return props.value.verified ? null : <span title={unverifiedWords(props.value.why)}>unverified</span>
}

/** Where and when a value was read. */
function Sourced(props: { value: Read; of: string; what: string }): React.JSX.Element {
  return (
    <>
      <span className="mono source" title={props.value.source} aria-label={`${siteOf(props.value.source)}, ${props.what} source for ${props.of}`}>{siteOf(props.value.source)}</span>
      <span className="faint">{dayWords(props.value.as_of)}</span>
    </>
  )
}

/** A model's price and capacity, one line each; `teamHas` adds what the team records when a verified price differs from it. */
function Facts(props: { model: ResearchModelView; teamHas?: string | undefined }): React.JSX.Element {
  const { model } = props
  return (
    <>
      <div className="model-facts">
        {model.price
          ? (
            <>
              <span className="mono value">{priceText(model.price)}</span><Unverified value={model.price} /><span className="faint">per M tokens, in / out</span>
              <Sourced value={model.price} of={model.id} what="price" />
              {props.teamHas ? <span className="faint">· your team has {props.teamHas}</span> : null}
            </>
          )
          : <span className="faint">No price found</span>}
      </div>
      {model.contextWindow ? (
        <div className="model-facts">
          <span className="mono value">{thousands(model.contextWindow.tokens)} tokens</span><Unverified value={model.contextWindow} /><span className="faint">capacity</span>
          <Sourced value={model.contextWindow} of={model.id} what="capacity" />
        </div>
      ) : null}
    </>
  )
}

/** The agents that cannot research now, each with why in a few plain words; the check's own message stays in `bmn roster check`. */
export function notOffered(unable: readonly ResearcherView[]): string {
  return unable.map((entry) => ` ${entry.name} cannot research${entry.why ? `: ${entry.why}` : ''}.`).join('')
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

/** The price the team records for a model BMN itself calls, laid out as a researched one is: the numbers, the site and the day. */
function Recorded(props: { price: RosterPriceShape; of: string }): React.JSX.Element {
  const { price } = props
  return (
    <div className="model-facts">
      <span className="mono value">{priceText(price)}</span><span className="faint">per M tokens, in / out</span>
      {price.source ? <span className="mono source" title={price.source} aria-label={`${siteOf(price.source)}, price source for ${props.of}`}>{siteOf(price.source)}</span> : null}
      {price.as_of ? <span className="faint">{dayWords(price.as_of)}</span> : null}
      <span className="faint">· your team's own record</span>
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
          ? row.recorded ? <Recorded price={row.recorded} of={row.model} /> : (props.researched ? <div className="faint">Not found yet</div> : null)
          : (
            <>
              <Facts model={row.found} teamHas={row.differs ? (row.teamHas ? priceText(row.teamHas) : 'no price') : undefined} />
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
  const title = count === 1 ? 'Apply one price' : `Apply ${count} prices`
  return (
    <div className="sheet" role="group" aria-label={title}>
      <div className="sheet-head"><b>{title}</b><span className="muted">Each was read on the page under it. Nothing changes until you approve.</span></div>
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

export function ModelsPage(props: {
  team: TeamState; data: RosterDataShape; research: ResearchState; add(fill: ResearchFill): void
  /** The name a BMN session has now, for who asked a web question; absent for one that is closed. */
  sessionName?(id: string): string | undefined
}): React.JSX.Element {
  const { research, data, team } = props
  const researcherId = useId()
  const questions = useWebQuestionsState()
  const [applying, setApplying] = useState(false)
  // Said while the staged prices wait for approval; gone once they are approved or discarded.
  const [staged, setStaged] = useState<string | null>(null)
  const ensure = research.ensure
  // Who researches is read from the approved team: once an approval changed the team, on this page or another, the list is read again.
  const approvedVersion = team.snapshot?.approved?.generation ?? null
  useEffect(() => ensure(approvedVersion), [ensure, approvedVersion])
  const snapshot = research.snapshot
  if (research.loadError) return <><PageHead title="Models" /><p className="preferences-error" role="alert">{research.loadError}</p></>
  if (snapshot === null) return <><PageHead title="Models" /><p className="page-note">Reading what research found…</p></>
  const able = snapshot.researchers.filter((entry) => entry.ok)
  const unable = snapshot.researchers.filter((entry) => !entry.ok)
  const chosen = able.find((entry) => entry.id === snapshot.researcher)
  const codex = snapshot.researchers.filter((entry) => entry.harness === 'codex')
  const openCode = snapshot.researchers.filter((entry) => entry.harness === 'opencode')
  // The choice waits for the owner while neither the approved team nor what he has staged names anyone (63.3 AC7).
  const proposed = snapshot.choice.named === null && namedResearchers(data) === null ? snapshot.choice.proposed.filter((id) => data.agents.some((agent) => agent.id === id)) : []
  const testing = snapshot.fenceTest.running
  const groups = researchGroups(snapshot.models, data)
  const changes = priceChanges(snapshot.models, data)
  const running = snapshot.running !== null
  // A web question holds the one research lock, whoever asked it: research waits for it (64.3 AC2).
  const asking = !running && questions.snapshot?.holder?.kind === 'question'
  const lastDay = snapshot.last ? dayWords(snapshot.last.at) : null
  // Two agents may share a name (Opus the knight, Opus the queen): the class's piece tells them apart, as on the Team pages.
  const researcherLabel = (id: string): React.ReactNode => {
    const agent = data.agents.find((entry) => entry.id === id)
    const name = able.find((entry) => entry.id === id)?.name ?? id
    return agent ? <><Piece agentClass={agent.class} named />{name}</> : name
  }
  // The provider is the team's own, by the name the team gives it; the researcher's wording of it is not shown.
  const providerName = (model: ResearchModelView): string => data.providers.find((provider) => provider.id === model.providerId)?.name ?? model.provider
  return (
    <>
      <PageHead title="Models" status={asking ? 'Research waits for the web question below' : researchStatus(snapshot, shortDate)}>
        {running
          ? <button type="button" disabled={research.busy} onClick={() => void research.stop()}>Stop</button>
          : <button type="button" disabled={research.busy || chosen === undefined || testing || asking} title={able.length === 0 ? 'No agent on your team can research' : chosen === undefined ? 'Pick a researcher first' : testing ? 'The Codex fence test is running' : asking ? 'A web question is under way; research can start when it ends or you stop it' : undefined} onClick={() => void research.start()}>Research now</button>}
      </PageHead>
      {staged !== null && team.hasStaged ? <p className="preferences-success" role="status">{staged}</p>
        : research.notice ? <p className={research.notice.ok ? 'preferences-success' : 'preferences-error'} role={research.notice.ok ? 'status' : 'alert'}>{research.notice.text}</p> : null}
      {!running && research.notice === null && snapshot.last?.note ? <p className="page-note" role="status">The last research did not finish: {snapshot.last.note}</p> : null}
      {snapshot.dropped !== null ? (
        <p className="page-note" role="status">{`${snapshot.dropped} is no longer one of your team's researchers, so no researcher is picked${able.length > 0 ? '. Pick one below' : ''}.`}</p>
      ) : null}
      {proposed.length > 0 ? (
        <div className="page-note with-action" role="status">
          <Dot label="Needs you" /><span className="note-text">{`Who researches is your choice and you have not made it yet, so every agent that can research is offered. BMN proposes ${listedAgents(data, proposed)}: one agent per model.`}</span>
          <button type="button" className="small" onClick={() => {
            team.stage(nameResearchers(data, proposed))
            setStaged(`${listedAgents(data, proposed)} named as researchers. Approve below to keep it.`)
          }}>Use proposal</button>
        </div>
      ) : null}
      <Row label="Researcher" id={researcherId}
        hint={able.length === 0
          ? `${noResearcherWords(snapshot.choice.named)} A price can still be written in the team file.${notOffered(unable)}`
          : `${chosen === undefined ? 'Pick who researches.' : researcherHint(chosen)}${notOffered(unable)}`}>
        {able.length === 0
          ? <span className="muted">No agent on your team can research.</span>
          : <Segmented labelledBy={researcherId} fit options={able.map((entry) => entry.id)} value={chosen?.id ?? ''} disabled={running || research.busy}
              optionLabel={researcherLabel} onChange={(id) => research.choose(id)} />}
      </Row>
      {codex.length > 0 ? (
        <Row label="Codex fence test" hint={fenceWords(codex)}>
          <button type="button" className="small" disabled={testing || running || research.busy} onClick={() => void research.testFence()}>{testing ? 'Testing…' : codex.every((entry) => entry.ok) ? 'Run again' : 'Run test'}</button>
        </Row>
      ) : null}
      {openCode.length > 0 ? (
        <Row label="OpenCode fence test" hint={fenceWords(openCode, 'OpenCode')}>
          <button type="button" className="small" disabled={testing || running || research.busy} onClick={() => void research.testFence()}>{testing ? 'Testing…' : openCode.every((entry) => entry.ok) ? 'Run again' : 'Run test'}</button>
        </Row>
      ) : null}
      <Row label="Sources" hint="Prices come from provider pages first; other sites are cited and never override. BMN reads each cited page itself and marks what it cannot confirm.">
        <ol className="sources"><li>Provider pages</li><li>Other sites</li></ol>
      </Row>
      {applying && changes.length > 0 ? (
        <ApplyPrices changes={changes} onCancel={() => setApplying(false)} onStage={() => {
          team.stage(applyPrices(data, changes))
          setApplying(false)
          setStaged(changes.length === 1 ? 'One price changed. Approve below to keep it.' : `${changes.length} prices changed. Approve below to keep them.`)
        }} />
      ) : changes.length > 0 ? (
        <div className="page-note with-action" role="status">
          <Dot label="Needs you" /><span className="note-text">{changes.length === 1 ? "One price differs from your team's." : `${changes.length} prices differ from your team's.`}</span>
          <button type="button" className="small" onClick={() => setApplying(true)}>Apply prices…</button>
        </div>
      ) : null}
      {groups.fresh.length > 0 ? (
        <>
          {/* Two researches on one day would read "New since Oct 11 · first seen on Oct 11": that case says it once. */}
          {snapshot.previousAt && dayWords(snapshot.previousAt) === lastDay
            ? <h4 className="group-head">New in this research</h4>
            : <h4 className="group-head">{snapshot.previousAt ? `New since ${dayWords(snapshot.previousAt)}` : 'Not on your team'}<span className="caption">first seen by the research on {lastDay}</span></h4>}
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
      <p className="preferences-help">Research changes nothing by itself. Apply prices and Add to team wait for your Approve.</p>
      {questions.loadError ? <p className="preferences-error" role="alert">{questions.loadError}</p> : null}
      {questions.snapshot ? (
        <WebQuestions snapshot={questions.snapshot} researcher={chosen?.name ?? null} busy={questions.busy} sessionName={props.sessionName ?? (() => undefined)}
          ask={questions.ask} stop={questions.stop} allow={questions.allow} remove={questions.remove} openPage={questions.openPage} />
      ) : null}
    </>
  )
}
