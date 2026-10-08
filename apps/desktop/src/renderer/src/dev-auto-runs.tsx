import { useEffect, useRef, useState } from 'react'
import type { DevAutoRun, DevAutoRunsResult, WorkspaceRecord } from '@bmn/protocol'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import { boundedRead } from './bounded-read'
import './dev-auto.css'

export function DevAutoRunsDialog({ workspaceId, workspaces, onClose, onOpenSession }: {
  workspaceId?: string | undefined
  workspaces: readonly WorkspaceRecord[]
  onClose(): void
  onOpenSession(sessionId: string): void
}): React.JSX.Element {
  const [result, setResult] = useState<DevAutoRunsResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const mounted = useRef(false)
  const load = async (): Promise<void> => {
    const request = ++generation.current
    setLoading(true)
    setError('')
    try {
      const snapshot = await boundedRead(window.aiTerminal.readDevAutoRuns(workspaceId))
      if (mounted.current && generation.current === request) setResult(snapshot)
    } catch (failure) {
      if (mounted.current && generation.current === request) setError(failureDetail(failure, 'dev-auto runs unavailable'))
    } finally { if (mounted.current && generation.current === request) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; generation.current++ }
  }, [workspaceId]) // reads only on open and explicit Refresh
  const show = (run: DevAutoRun): React.JSX.Element => <li key={run.checkout}>
    <h4>{run.branch ?? 'Detached checkout'}</h4>
    <p>{run.workspaceIds.map((id) => workspaces.find((workspace) => workspace.workspaceId === id)?.name ?? 'Workspace unavailable').join(', ')} · {run.checkout}</p>
    <p>{run.project ?? 'Not recorded'}</p>
    {run.unavailable ? <p role="status">Handoff unavailable: {run.unavailable}</p> : null}
    {run.ownership === 'copy' ? <p>Copy of {run.ownerCheckout} / {run.ownerBranch}</p> : <>
      <p><strong>{run.finished ? 'Finished' : run.status ?? 'Not recorded'}</strong> · {run.ownership === 'unknown' ? 'Ownership unknown' : 'Owning checkout'}</p>
      <p>Next safe action: {run.nextAction ?? 'Not recorded'}</p>
      <h5>Decided for you</h5>
      {run.decisions.length ? <ul>{run.decisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul> : <p>Not recorded</p>}
      {run.omittedDecisions ? <p>{run.omittedDecisions} additional decisions exceed the display bound.</p> : null}
      <h5>Waiting on you</h5>
      {run.ownerItems.length ? <ul>{run.ownerItems.map((item) => <li key={item.requestId}>
        <button type="button" onClick={() => onOpenSession(item.sessionId)}>{item.title}</button>
      </li>)}</ul> : <p>No open requests in live sessions.</p>}
    </>}
    <h5>Sprint board</h5>
    {run.board.unavailable ? <p>{run.board.unavailable}</p> : <>
      <p>Read from {run.board.checkout}</p>
      {run.board.rows.length ? <ul>{run.board.rows.map((row) => <li key={row.key}><strong>{row.key}: {row.status}</strong>{row.comment ? ` · ${row.comment}` : ''}</li>)}</ul> : <p>No selected rows recorded.</p>}
    </>}
  </li>
  return <Dialog label="dev-auto runs" onClose={onClose} className="workspace-results-dialog dev-auto-dialog">
    <div className="workspace-results-toolbar"><button type="button" onClick={() => void load()}>Refresh</button>
      {result ? <span>Read {new Date(result.observedAt).toLocaleString()}</span> : null}</div>
    {loading ? <p role="status">Reading dev-auto runs…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <>
      {result.skipped ? <p role="status">Incomplete: {result.skipped} sources or items skipped.</p> : null}
      {result.issues.length ? <ul>{result.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
      <h3>Runs</h3><ul className="workspace-results-sessions">{result.runs.filter((run) => run.ownership !== 'copy').map(show)}</ul>
      {!result.runs.length ? <p>No dev-auto handoffs found.</p> : null}
      {result.runs.some((run) => run.ownership === 'copy') ? <><h3>Copies</h3><ul className="workspace-results-sessions">{result.runs.filter((run) => run.ownership === 'copy').map(show)}</ul></> : null}
    </> : null}
  </Dialog>
}
