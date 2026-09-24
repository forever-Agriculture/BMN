// MODULE: workspace-results.tsx - read-only workspace reports and pending handoff review
import { useEffect, useRef, useState } from 'react'
import type {
  ArtifactRecord, AttentionRecord, InputDraftRecord, ProgressRecord, SessionRecord, WorkspaceRecord
} from '@bmn/protocol'
import { Dialog } from './dialog'
import { evidenceRows } from './progress-evidence-dialog'
import { handoffPreparedBy, progressPresentation, type ProgressPresentation } from './session-presentation'
import { failureDetail } from './bridge-error'
import { boundedRead } from './bounded-read'
import './workspace-results.css'

export interface WorkspaceReportRow {
  record: ProgressRecord
  presentation: ProgressPresentation
  run: 'Current run' | 'Previous run' | 'Run unknown'
  evidence: ReturnType<typeof evidenceRows>
}

export interface WorkspaceHandoffRow {
  draft: InputDraftRecord
  source: string
  destination: string
  preparation: string
  destinationAvailable: boolean
}

/** Distinguishes a replaced source row even when two writes share a clock tick. */
export function sameProgressRecord(a: ProgressRecord, b: ProgressRecord): boolean {
  return a.sessionId === b.sessionId && a.source === b.source &&
    a.incarnationId === b.incarnationId && a.state === b.state &&
    a.label === b.label && a.detail === b.detail &&
    a.observedAt === b.observedAt && a.receivedAt === b.receivedAt &&
    JSON.stringify(a.evidence) === JSON.stringify(b.evidence)
}

/** Current records only; source and destination membership are resolved from addressed IDs. */
export function workspaceResults(
  workspaceId: string,
  sessions: readonly SessionRecord[],
  workspaces: readonly WorkspaceRecord[],
  reports: readonly ProgressRecord[],
  drafts: readonly InputDraftRecord[],
  artifacts: readonly ArtifactRecord[],
  attention: readonly AttentionRecord[],
  now: number
): { sessions: Array<{ session: SessionRecord; reports: WorkspaceReportRow[] }>; handoffs: WorkspaceHandoffRow[] } {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  const visible = sessions.filter((session) => session.workspaceId === workspaceId && session.archivedAt === null)
  const grouped = visible.map((session) => ({
    session,
    reports: reports.filter((record) => record.sessionId === session.sessionId)
      .map((record): WorkspaceReportRow => ({
        record,
        presentation: progressPresentation([record], session.sessionId, now)!,
        run: record.incarnationId === null || !session.lastProcess ? 'Run unknown'
          : record.incarnationId === session.lastProcess.incarnationId ? 'Current run' : 'Previous run',
        evidence: evidenceRows(record.evidence ?? [], artifacts)
      }))
      .toSorted((a, b) => b.record.observedAt.localeCompare(a.record.observedAt) ||
        a.record.source.localeCompare(b.record.source))
  }))
  const describe = (sessionId: string | null): string => {
    const session = sessionId ? byId.get(sessionId) : undefined
    if (!session) return 'Removed session'
    const workspace = workspaceById.get(session.workspaceId)
    return `${workspace?.name ?? 'Removed workspace'} › ${session.name}`
  }
  const handoffs = drafts.filter((draft) => {
    if (draft.origin !== 'handoff' || (draft.state !== 'draft' && draft.state !== 'uncertain')) return false
    const source = draft.sourceSessionId ? byId.get(draft.sourceSessionId) : undefined
    const destination = byId.get(draft.sessionId)
    return source?.workspaceId === workspaceId || destination?.workspaceId === workspaceId
  }).map((draft): WorkspaceHandoffRow => {
    const source = draft.sourceSessionId ? byId.get(draft.sourceSessionId) : undefined
    const destination = byId.get(draft.sessionId)
    const destinationWorkspace = destination ? workspaceById.get(destination.workspaceId) : undefined
    const preparation = handoffPreparedBy(draft, source, attention)
    return {
      draft,
      source: describe(draft.sourceSessionId),
      destination: describe(draft.sessionId),
      preparation: preparation?.byline ?? 'Prepared by owner',
      destinationAvailable: !!destination && destination.archivedAt === null && destinationWorkspace?.archivedAt === null
    }
  }).toSorted((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt))
  return { sessions: grouped, handoffs }
}

interface ResultSnapshot {
  sessions: SessionRecord[]
  workspaces: WorkspaceRecord[]
  reports: ProgressRecord[]
  drafts: InputDraftRecord[]
  artifacts: ArtifactRecord[]
  attention: AttentionRecord[]
  checkedAt: string
}

export function WorkspaceResultsDialog(props: {
  workspace: WorkspaceRecord
  now: number
  onClose(): void
  onOpenReport(session: SessionRecord, report: ProgressRecord): void
  onReviewHandoff(draft: InputDraftRecord, signal: AbortSignal): Promise<void>
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ResultSnapshot | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const reviewControllers = useRef(new Set<AbortController>())

  async function load(preserveError = false): Promise<void> {
    const request = ++sequence.current
    setState('loading')
    if (!preserveError) setError(null)
    try {
      const { workspaces, allSessions, reports, drafts, artifacts, attention } = await boundedRead((async () => {
        const workspaces = await window.aiTerminal.listWorkspaces(true)
        const allSessions = (await Promise.all(workspaces.map((workspace) =>
          window.aiTerminal.listSessions(workspace.workspaceId)))).flat()
        const [reports, drafts, artifacts, attention] = await Promise.all([
          window.aiTerminal.listProgress(),
          window.aiTerminal.listDrafts(),
          window.aiTerminal.listArtifacts(null),
          window.aiTerminal.listAttention()
        ])
        return { workspaces, allSessions, reports, drafts, artifacts, attention }
      })())
      if (!mounted.current || request !== sequence.current) return
      setSnapshot({ sessions: allSessions, workspaces, reports, drafts, artifacts, attention, checkedAt: new Date().toISOString() })
      setState('ready')
    } catch (cause) {
      if (!mounted.current || request !== sequence.current) return
      setSnapshot(null)
      setState('unavailable')
      setError(failureDetail(cause, 'Workspace results unavailable'))
    }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      sequence.current += 1
      for (const controller of reviewControllers.current) controller.abort()
      reviewControllers.current.clear()
    }
  }, [props.workspace.workspaceId])

  const results = snapshot && state === 'ready' ? workspaceResults(
    props.workspace.workspaceId, snapshot.sessions, snapshot.workspaces, snapshot.reports,
    snapshot.drafts, snapshot.artifacts, snapshot.attention, props.now
  ) : null

  async function openReport(session: SessionRecord, report: ProgressRecord): Promise<void> {
    try {
      const [sessions, reports] = await boundedRead(Promise.all([
        window.aiTerminal.listSessions(props.workspace.workspaceId), window.aiTerminal.listProgress()
      ]))
      if (!mounted.current) return
      const currentSession = sessions.find((item) => item.sessionId === session.sessionId && item.archivedAt === null)
      const currentReport = reports.find((item) => item.sessionId === report.sessionId && item.source === report.source)
      if (!currentSession || !currentReport || !sameProgressRecord(currentReport, report)) {
        setError('This report changed or its session is unavailable. Refresh and review it again.')
        await load(true)
        return
      }
      props.onOpenReport(currentSession, currentReport)
    } catch (cause) {
      if (mounted.current) setError(failureDetail(cause, 'Could not recheck the report'))
    }
  }

  async function reviewHandoff(draft: InputDraftRecord): Promise<void> {
    for (const pending of reviewControllers.current) pending.abort()
    reviewControllers.current.clear()
    const controller = new AbortController()
    reviewControllers.current.add(controller)
    try {
      await boundedRead(props.onReviewHandoff(draft, controller.signal))
    } catch (cause) {
      const superseded = controller.signal.aborted
      controller.abort()
      if (!mounted.current || superseded) return
      setError(failureDetail(cause, 'Handoff changed or is unavailable. Refresh and review it again.'))
      await load(true)
    } finally {
      controller.abort()
      reviewControllers.current.delete(controller)
    }
  }

  return (
    <Dialog label={`Workspace results — ${props.workspace.name}`} onClose={props.onClose} className="workspace-results-dialog">
      <p className="dialog-note">Latest reports by session and source; handoffs from BMN's bounded current draft list. Agent claims and attached files are not BMN verification. This is not history.</p>
      <div className="workspace-results-toolbar">
        <button type="button" onClick={() => void load()}>Refresh results</button>
        {snapshot && state === 'ready' ? <span>Read {new Date(snapshot.checkedAt).toLocaleString()}</span> : null}
      </div>
      {state === 'loading' ? <p role="status">Loading workspace results…</p> : null}
      {state === 'unavailable' ? <p role="status">Workspace results unavailable. Try Refresh.</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {results ? (
        <>
          <h3>Reports</h3>
          {results.sessions.length === 0 ? <p>No sessions in this workspace.</p> : (
            <ul className="workspace-results-sessions">
              {results.sessions.map(({ session, reports }) => (
                <li key={session.sessionId}>
                  <h4>{session.name}</h4>
                  {reports.length === 0 ? <p>No progress reported</p> : (
                    <ul>
                      {reports.map(({ record, presentation, run, evidence }) => (
                        <li key={record.source}>
                          <p><strong>{presentation.word}</strong> · {record.label}</p>
                          <p>{record.source} · {run} · {presentation.stale ? 'Stale' : 'Observed within 10 min'} · observed {new Date(record.observedAt).toLocaleString()}</p>
                          {evidence.length === 0 ? <p>No evidence attached</p> : (
                            <ul aria-label="Evidence">
                              {evidence.map((file) => <li key={file.artifactId}>{file.name} · {file.ready ? 'Ready' : file.availability}</li>)}
                            </ul>
                          )}
                          <button type="button" onClick={() => void openReport(session, record)}>Progress details</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>Handoffs awaiting you</h3>
          {results.handoffs.length === 0 ? <p>No pending or uncertain handoffs in the current draft list for this workspace.</p> : (
            <ul className="workspace-results-handoffs">
              {results.handoffs.map((row) => <li key={row.draft.draftId}>
                <p><strong>{row.draft.state === 'uncertain' ? 'Paste outcome uncertain' : 'Saved draft'}</strong> · updated {new Date(row.draft.updatedAt).toLocaleString()}</p>
                <p>From {row.source}</p>
                <p>To {row.destination}</p>
                <p>{row.preparation}</p>
                {!row.destinationAvailable ? <p>Destination unavailable. Fresh review required.</p> : null}
                <button type="button" onClick={() => void reviewHandoff(row.draft)}>Review handoff</button>
              </li>)}
            </ul>
          )}
        </>
      ) : null}
    </Dialog>
  )
}
