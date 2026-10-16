// MODULE: away-summary-dialog.tsx - "While you were away": one period's summary, read-only; every row only navigates (Story 76.6, Fable's notes 76.1 §4)
import { useEffect, useMemo, useState } from 'react'
import {
  buildAwaySummary,
  withCompletedAsks,
  type AttentionRecord,
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
  const activity = payload.activity === null ? null : withCompletedAsks(payload.activity, sources.asks?.asks ?? null, since, payload.away.state === 'away' ? null : payload.away.endedAt)
  return buildAwaySummary({
    ...payload, activity, now, attention,
    devAuto: sources.devAuto === null ? null : { result: sources.devAuto, workspaceNames: Object.fromEntries(workspaces.map((workspace) => [workspace.workspaceId, workspace.name])) }
  })
}

function Incomplete(props: { on: boolean }): React.JSX.Element | null {
  return props.on ? <span className="faint"> · incomplete</span> : null
}

export function AwaySummaryDialog(props: {
  /** The period the dialog was opened for; a newer away closes it. */
  away: OwnerAwayView
  attention: readonly AttentionRecord[]
  workspaces: readonly WorkspaceRecord[]
  now: number
  onOpenRequest(request: AttentionRecord): void
  onOpenSession(sessionId: string): void
  onClose(): void
}): React.JSX.Element {
  const [sources, setSources] = useState<AwaySummarySources | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.aiTerminal.awaySummary(),
      window.aiTerminal.teamAsks().catch(() => null),
      window.aiTerminal.readDevAutoRuns().catch(() => null)
    ]).then(([payload, asks, devAuto]) => {
      if (!cancelled) setSources({ payload, asks, devAuto })
    }).catch((error: unknown) => { if (!cancelled) setUnavailable(failureDetail(error, 'The summary could not be read')) })
    return () => { cancelled = true }
  }, [props.away.periodId])

  const view = useMemo(
    () => sources === null ? null : awaySummaryView(sources, props.attention, props.workspaces, new Date(props.now)),
    [sources, props.attention, props.workspaces, props.now]
  )
  const label = props.away.state === 'away' ? 'While you are away' : 'While you were away'
  const requests = new Map(props.attention.map((record) => [record.requestId, record]))

  return (
    <Dialog label={view?.label ?? label} onClose={props.onClose} className="session-messages-dialog away-summary-dialog">
      {view === null ? (
        unavailable !== null ? <p className="inline-error" role="alert">{unavailable}</p> : <p className="dialog-note" role="status">Reading…</p>
      ) : (
        <>
          <section className="inspector-section away-summary-head">
            <p className="away-head-line">{view.head}</p>
            {view.note !== null ? <p className="away-note">Note: {view.note}</p> : null}
            {view.couldNotRead !== null ? <small className="away-gaps">{view.couldNotRead}</small> : null}
          </section>

          <section className="inspector-section" aria-label="Waiting on you">
            <h3><span>Waiting on you</span><span className="away-count">{view.waiting.open} open</span></h3>
            {view.waiting.empty !== null ? <p className="dialog-note">{view.waiting.empty}</p> : null}
            {view.waiting.groups.map((group) => (
              <div key={group.sessionId} className="away-group">
                <p className="away-where">{group.where}</p>
                <ul className="message-list">
                  {group.rows.map((row) => (
                    <li key={row.requestId}>
                      <button type="button" className="message-row" onClick={() => {
                        const request = requests.get(row.requestId)
                        if (request) props.onOpenRequest(request)
                      }}>
                        <span className="age">{row.age}</span>
                        <span className="route">{row.kind}</span>
                        <span className="state">{row.before ? 'opened before you left' : ''}</span>
                        <span className={row.command ? 'first-line away-command' : 'first-line'} title={row.title}>{row.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {view.waiting.more !== null ? <small className="away-more">{view.waiting.more}</small> : null}
          </section>

          <section className="inspector-section" aria-label="Decided for you, recorded by agents">
            <h3><span>Decided for you — recorded by agents<Incomplete on={view.decided.incomplete} /></span></h3>
            {view.decided.empty !== null ? <p className="dialog-note">{view.decided.empty}</p> : null}
            {view.decided.groups.map((group) => (
              <div key={group.sessionId} className="away-group">
                <p className="away-where">{group.where}</p>
                <ul className="message-list">
                  {group.records.map((record) => {
                    const id = `${record.sessionId} ${record.key}`
                    const open = openKey === id
                    return (
                      <li key={id}>
                        <button type="button" className="message-row" aria-expanded={open} onClick={() => setOpenKey(open ? null : id)}>
                          <span className="age">{record.time}</span>
                          <span className="route">{record.key}</span>
                          <span className="state" />
                          <span className="first-line" title={record.choice}>{record.choice}</span>
                        </button>
                        {open ? (
                          <dl className="kv away-decision">
                            {record.rows.map((row) => (
                              <div key={row.label} className="away-kv-row">
                                <dt>{row.label}</dt>
                                <dd className={row.muted ? 'faint' : undefined}>
                                  {row.text}
                                  {row.links?.map((link) => (
                                    <button key={link.sessionId} type="button" className="link away-link" onClick={() => props.onOpenSession(link.sessionId)}>{link.text}</button>
                                  ))}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
            {view.decided.more !== null ? <small className="away-more">{view.decided.more}</small> : null}
            <small className="away-more">{view.decided.tail}</small>
          </section>

          <section className="inspector-section" aria-label="What happened">
            <h3><span>What happened<Incomplete on={view.happened.incomplete} /></span></h3>
            {view.happened.empty !== null ? <p className="dialog-note">{view.happened.empty}</p> : null}
            {view.happened.blocks.map((block) => (
              <div key={block.sessionId} className="away-group">
                <p className="away-where">{block.head}</p>
                <ul className="away-lines">{block.lines.map((line) => <li key={line}>{line}</li>)}</ul>
              </div>
            ))}
            {view.happened.more !== null ? <small className="away-more">{view.happened.more}</small> : null}
          </section>

          {view.now.lines.length > 0 || view.now.incomplete ? (
            <section className="inspector-section" aria-label="Now">
              <h3><span>Now<Incomplete on={view.now.incomplete} /></span></h3>
              <ul className="away-lines">{view.now.lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>
              {view.now.legacy !== null ? <small className="away-more">{view.now.legacy}</small> : null}
              {view.now.more !== null ? <small className="away-more">{view.now.more}</small> : null}
            </section>
          ) : null}
        </>
      )}
    </Dialog>
  )
}
