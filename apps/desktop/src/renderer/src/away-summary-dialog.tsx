// MODULE: away-summary-dialog.tsx - "While you were away": one period's summary, read-only; every row only navigates (Story 76.6; Fable's redesign 2026-10-18: Needs you, Stuck, Finished, then the record)
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildAwaySummary,
  withCompletedAsks,
  type AttentionRecord,
  type AwayDecisionRow,
  type AwaySummaryPayload,
  type AwaySummaryView,
  type DevAutoRunsResult,
  type OwnerAwayView,
  type TeamAsksSnapshot,
  type WorkspaceRecord
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Dialog } from './dialog'
import './session-messages.css'
import './away-summary.css'

/** What the dialog read once at opening; requests stay live, so Waiting on you is always now. */
export interface AwaySummarySources {
  payload: AwaySummaryPayload
  asks: TeamAsksSnapshot | null
  devAuto: DevAutoRunsResult | null
}

/** The view from what was read and the requests as the app holds them now (Story 76.6 AC1, AC3). */
export function awaySummaryView(sources: AwaySummarySources, attention: readonly AttentionRecord[] | null, workspaces: readonly WorkspaceRecord[], now: Date): AwaySummaryView {
  const { payload } = sources
  const since = payload.away.since ?? now.toISOString()
  const activity = payload.activity === null ? null : withCompletedAsks(payload.activity, sources.asks?.asks ?? null, since,
    payload.away.state === 'away' ? null : payload.away.endedAt, sources.asks === null ? undefined : { keptDays: sources.asks.keptDays, now })
  return buildAwaySummary({
    ...payload, activity, now, attention,
    devAuto: sources.devAuto === null ? null : { result: sources.devAuto, workspaceNames: Object.fromEntries(workspaces.map((workspace) => [workspace.workspaceId, workspace.name])) }
  })
}

/** What the dialog reads again on: a new period, or back closing the one it shows (Astra's review, 76.6 AC1/AC3). */
export function awaySummaryReadKey(away: Pick<OwnerAwayView, 'periodId' | 'revision'>): string {
  return `${away.periodId ?? ''}:${away.revision}`
}

/** The closed period a successful read showed, which only then counts as presented; a period still open is never. */
export function presentedClosedPeriod(payload: Pick<AwaySummaryPayload, 'away'>): string | null {
  return payload.away.state === 'back' ? payload.away.periodId : null
}

/** "Personal › Builder (archived …) · Claude Code" shown as its session's own name and app; the whole path is the tooltip. */
export function sessionWords(where: string): string {
  return where.split(' › ').slice(1).join(' › ').replace(/ \(archived [^)]*\)/u, '') || where
}

type Links = (link: NonNullable<AwayDecisionRow['links']>[number]) => void

/** An opened row's values, whole; a session, file or run named in it is a text link. */
function Detail(props: { rows: readonly AwayDecisionRow[]; links: Links }): React.JSX.Element {
  return (
    <dl className="kv away-decision">
      {props.rows.map((row) => (
        <div key={row.label} className="away-kv-row">
          <dt>{row.label}</dt>
          <dd className={row.muted ? 'faint' : undefined}>
            {row.text}
            {row.links?.map((link, index) => (
              <Fragment key={`${link.kind}:${link.id}`}>
                {row.text !== '' || index > 0 ? ' · ' : null}
                <button type="button" className="away-link" onClick={() => props.links(link)}>{link.text}</button>
              </Fragment>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Stuck or Finished: one row per run, its title, state and one line; the row opens its brief, status and decisions. */
function RunSection(props: { label: string; section: AwaySummaryView['stuck']; openKey: string | null; setOpenKey(key: string | null): void; links: Links }): React.JSX.Element {
  const { section } = props
  return (
    <section className="inspector-section" aria-label={props.label}>
      <h3><span>{props.label}</span><span className="away-count">{section.rows.length}</span></h3>
      {section.empty !== null ? <p className="dialog-note">{section.empty}</p> : (
        <ul className="message-list">
          {section.rows.map((row) => {
            const id = `run ${row.key}`
            const open = props.openKey === id
            return (
              <li key={id}>
                <button type="button" className="message-row away-run-row" aria-expanded={open} onClick={() => props.setOpenKey(open ? null : id)}>
                  <span className="route" title={row.full}>{row.title}</span>
                  <span className="state">{row.state}</span>
                  <span className="first-line" title={row.text}>{row.text}</span>
                </button>
                {open ? <Detail rows={row.rows} links={props.links} /> : null}
              </li>
            )
          })}
        </ul>
      )}
      {section.more !== null ? <small className="away-more">{section.more}</small> : null}
    </section>
  )
}

export function AwaySummaryDialog(props: {
  /** The period the dialog was opened for; a newer away closes it. */
  away: OwnerAwayView
  attention: readonly AttentionRecord[]
  workspaces: readonly WorkspaceRecord[]
  now: number
  onOpenRequest(request: AttentionRecord): void
  onOpenSession(sessionId: string): void
  onOpenDevAutoRuns(): void
  /** The summary of this closed period was read and is in front of him. */
  onPresented(periodId: string): void
  onClose(): void
}): React.JSX.Element {
  const [sources, setSources] = useState<AwaySummarySources | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)

  const onPresented = useRef(props.onPresented)
  onPresented.current = props.onPresented
  const readKey = awaySummaryReadKey(props.away)
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.aiTerminal.awaySummary(),
      window.aiTerminal.teamAsks().catch(() => null),
      window.aiTerminal.readDevAutoRuns().catch(() => null)
    ]).then(([payload, asks, devAuto]) => {
      if (cancelled) return
      setUnavailable(null)
      setSources({ payload, asks, devAuto })
      const closed = presentedClosedPeriod(payload)
      if (closed !== null) onPresented.current(closed)
    }).catch((error: unknown) => {
      // A failed read shows no older snapshot in its place, and the period is not marked presented, so it opens again.
      if (!cancelled) { setSources(null); setUnavailable(failureDetail(error, 'The summary could not be read')) }
    })
    return () => { cancelled = true }
  }, [readKey])

  const view = useMemo(
    () => sources === null ? null : awaySummaryView(sources, props.attention, props.workspaces, new Date(props.now)),
    [sources, props.attention, props.workspaces, props.now]
  )
  const label = props.away.state === 'away' ? 'While you are away' : 'While you were away'
  const requests = new Map(props.attention.map((record) => [record.requestId, record]))
  const links: Links = (link) => {
    if (link.kind === 'session') props.onOpenSession(link.id)
    else if (link.kind === 'workflow') props.onOpenDevAutoRuns()
    else void window.aiTerminal.openArtifact(link.id).catch(() => undefined)
  }

  return (
    <Dialog label={view?.label ?? label} onClose={props.onClose} className="session-messages-dialog away-summary-dialog">
      {view === null ? (
        unavailable !== null ? <p className="inline-error" role="alert">{unavailable}</p> : <p className="dialog-note" role="status">Reading…</p>
      ) : (
        <>
          <section className="inspector-section away-summary-head">
            <p className="away-head-line">{view.head}</p>
            {view.note !== null ? <p className="away-note">Note: {view.note}</p> : null}
            {view.couldNotRead !== null ? <small className="away-gaps" title={view.couldNotReadWhy ?? undefined}>{view.couldNotRead}</small> : null}
          </section>

          <section className="inspector-section" aria-label="Needs you">
            <h3><span>Needs you</span><span className={view.waiting.open > 0 ? 'away-count away-count-on' : 'away-count'}>{view.waiting.open}</span></h3>
            {view.waiting.empty !== null ? <p className="dialog-note">{view.waiting.empty}</p> : null}
            {view.waiting.groups.length > 0 ? (
              <ul className="message-list">
                {view.waiting.groups.flatMap((group) => group.rows.map((row) => (
                  <li key={row.requestId}>
                    <button type="button" className="message-row" onClick={() => {
                      const request = requests.get(row.requestId)
                      if (request) props.onOpenRequest(request)
                    }}>
                      <span className="age" title={row.before ? 'Opened before you left' : undefined}>{row.age}</span>
                      <span className="route">{row.kind}</span>
                      <span className="state" title={group.where}>{sessionWords(group.where)}</span>
                      <span className={row.command ? 'first-line away-command' : 'first-line'} title={row.title}>{row.title}</span>
                    </button>
                  </li>
                )))}
              </ul>
            ) : null}
            {view.waiting.more !== null ? <small className="away-more">{view.waiting.more}</small> : null}
          </section>

          <RunSection label="Stuck" section={view.stuck} openKey={openKey} setOpenKey={setOpenKey} links={links} />
          <RunSection label="Finished" section={view.finished} openKey={openKey} setOpenKey={setOpenKey} links={links} />

          {view.wentOn.count > 0 ? (
            <section className="inspector-section" aria-label="Closed without you">
              <h3><span>Closed without you</span><span className="away-count">{view.wentOn.count}</span></h3>
              <ul className="message-list">
                {view.wentOn.groups.flatMap((group) => group.rows.map((row) => (
                  <li key={row.requestId}>
                    <button type="button" className="message-row" onClick={() => {
                      const request = requests.get(row.requestId)
                      if (request) props.onOpenRequest(request)
                      else props.onOpenSession(row.sessionId)
                    }}>
                      <span className="age">{row.time}</span>
                      <span className="route" title={group.where}>{sessionWords(group.where)}</span>
                      <span className="state" title={row.how}>{row.how}</span>
                      <span className={row.command ? 'first-line away-command' : 'first-line'} title={row.title}>{row.title}</span>
                    </button>
                  </li>
                )))}
              </ul>
              {view.wentOn.more !== null ? <small className="away-more">{view.wentOn.more}</small> : null}
            </section>
          ) : null}

          <section className="inspector-section" aria-label="Decided for you">
            <h3><span>Decided for you</span><span className="away-count">{view.decided.groups.reduce((sum, group) => sum + group.records.length, 0)}</span></h3>
            {view.decided.empty !== null ? <p className="dialog-note">No decisions recorded.</p> : null}
            {view.decided.groups.length > 0 ? (
              <ul className="message-list">
                {view.decided.groups.flatMap((group) => group.records.map((record) => {
                  const id = `${record.sessionId} ${record.key}`
                  const open = openKey === id
                  return (
                    <li key={id}>
                      <button type="button" className="message-row away-decision-row" aria-expanded={open} onClick={() => setOpenKey(open ? null : id)}>
                        <span className="age">{record.time}</span>
                        <span className="route" title={group.where}>{sessionWords(group.where)}</span>
                        <span className="first-line" title={record.choice}>{record.choice}</span>
                      </button>
                      {open ? <Detail rows={[...record.rows, { label: 'Key', text: record.key, muted: true }]} links={links} /> : null}
                    </li>
                  )
                }))}
              </ul>
            ) : null}
            {view.decided.more !== null ? <small className="away-more">{view.decided.more}</small> : null}
          </section>

          <section className="inspector-section" aria-label="Activity">
            <h3><span>Activity</span></h3>
            {view.activity.empty !== null ? <p className="dialog-note">{view.activity.empty}</p> : (
              <ul className="message-list">
                {view.activity.rows.map((row) => (
                  <li key={row.sessionId}>
                    <button type="button" className="message-row away-activity-row" onClick={() => props.onOpenSession(row.sessionId)}>
                      <span className="age" aria-hidden="true" />
                      <span className="route" title={row.where}>{sessionWords(row.where)}</span>
                      <span className="first-line" title={row.lines.join('\n')}>{row.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {view.activity.more !== null ? <small className="away-more">{view.activity.more}</small> : null}
          </section>
        </>
      )}
    </Dialog>
  )
}
