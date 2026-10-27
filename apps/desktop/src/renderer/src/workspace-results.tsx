// MODULE: workspace-results.tsx - read-only workspace reports
import { useEffect, useRef, useState } from 'react'
import type { ArtifactRecord, ProgressRecord, SessionRecord, WorkspaceRecord } from '@bmn/protocol'
import { Dialog } from './dialog'
import { evidenceRows } from './progress-evidence-dialog'
import { progressPresentation, type ProgressPresentation } from './session-presentation'
import { failureDetail } from './bridge-error'
import { boundedRead } from './bounded-read'
import { useSelfRefresh } from './self-refresh'
import { shortDate } from './team-preferences'
import './workspace-results.css'

interface WorkspaceReportRow {
  record: ProgressRecord
  presentation: ProgressPresentation
  run: 'Current run' | 'Previous run' | 'Run unknown'
  evidence: ReturnType<typeof evidenceRows>
}

/** Distinguishes a replaced source row even when two writes share a clock tick. */
export function sameProgressRecord(a: ProgressRecord, b: ProgressRecord): boolean {
  return a.sessionId === b.sessionId && a.source === b.source &&
    a.incarnationId === b.incarnationId && a.state === b.state &&
    a.label === b.label && a.detail === b.detail &&
    a.observedAt === b.observedAt && a.receivedAt === b.receivedAt &&
    JSON.stringify(a.evidence) === JSON.stringify(b.evidence)
}

/**
 * Current reports only, grouped by the workspace's open sessions. A handoff delivers itself (Story 75.5), so
 * nothing here waits for the owner; a delivered one shows in Messages.
 */
export function workspaceResults(
  workspaceId: string,
  sessions: readonly SessionRecord[],
  reports: readonly ProgressRecord[],
  artifacts: readonly ArtifactRecord[],
  now: number
): { sessions: Array<{ session: SessionRecord; reports: WorkspaceReportRow[] }> } {
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
  return { sessions: grouped }
}

interface ResultSnapshot {
  sessions: SessionRecord[]
  reports: ProgressRecord[]
  artifacts: ArtifactRecord[]
  checkedAt: string
}

export function WorkspaceResultsDialog(props: {
  workspace: WorkspaceRecord
  now: number
  onOpenRuns(): void
  onClose(): void
  onOpenReport(session: SessionRecord, report: ProgressRecord): void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ResultSnapshot | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const mounted = useRef(true)

  /** Story 75.7: what was shown stays on screen while BMN reads again; a failed read keeps it and says so. */
  async function load(preserveError = false): Promise<void> {
    const request = ++sequence.current
    if (!preserveError) setError(null)
    try {
      const [sessions, reports, artifacts] = await boundedRead(Promise.all([
        window.aiTerminal.listSessions(props.workspace.workspaceId),
        window.aiTerminal.listProgress(),
        window.aiTerminal.listArtifacts(null)
      ]))
      if (!mounted.current || request !== sequence.current) return
      setSnapshot({ sessions, reports, artifacts, checkedAt: new Date().toISOString() })
      setState('ready')
    } catch (cause) {
      if (!mounted.current || request !== sequence.current) return
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
    }
  }, [props.workspace.workspaceId])
  // Story 75.7: a report, a published file or a session that changes is read again at once, and so is everything when the owner comes back.
  useSelfRefresh(() => load(), { topics: ['progress', 'artifacts', 'catalogue'] })

  const results = snapshot ? workspaceResults(
    props.workspace.workspaceId, snapshot.sessions, snapshot.reports, snapshot.artifacts, props.now
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
        setError('This report changed or its session is unavailable. BMN read it again; review it again.')
        await load(true)
        return
      }
      props.onOpenReport(currentSession, currentReport)
    } catch (cause) {
      if (mounted.current) setError(failureDetail(cause, 'Could not recheck the report'))
    }
  }

  return (
    <Dialog label={`Workspace results — ${props.workspace.name}`} onClose={props.onClose} className="workspace-results-dialog">
      <p className="dialog-note">Reported by the agent, not verified by BMN.</p>
      <div className="workspace-results-toolbar">
        <button type="button" onClick={props.onOpenRuns}>dev-auto runs…</button>
        {snapshot ? <span>Read {shortDate(snapshot.checkedAt)}</span> : null}
      </div>
      {state === 'loading' && snapshot === null ? <p role="status">Loading workspace results…</p> : null}
      {state === 'unavailable' && snapshot === null ? <p role="status">Workspace results unavailable. BMN reads them again when they change and when you come back.</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {results ? (
        <>
          <h3>Agent reports</h3>
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
        </>
      ) : null}
    </Dialog>
  )
}
