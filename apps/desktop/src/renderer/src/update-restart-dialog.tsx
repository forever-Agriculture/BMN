// MODULE: update-restart-dialog.tsx - Epic 125: the restart for an update in the quit dialog's shape: the offer, waiting to close, the Cancel result, and after reopening
import { useState } from 'react'
import { updateRestartCancelListed, updateRestartClock, updateRestartWords, type UpdateRestartOperation, type UpdateRestartRecord, type UpdateRestartSnapshot, type UpdateRestartStage } from '@bmn/protocol'
import { Dialog } from './dialog'
import type { RendererCohortResumeResult } from '../../preload/bridge'

/** The dialog's head: the clock time it closes by, never a countdown; after Cancel, how many sessions wait on his word. */
export function updateRestartTitle(run: UpdateRestartRecord | null, stage: UpdateRestartStage): string {
  if (!run || stage === 'offer') return 'Restart for the update?'
  if (stage === 'waiting') return `Restarting · closes by ${updateRestartClock(run.closesAt)}`
  if (stage === 'cancelled') {
    const listed = run.members.filter(updateRestartCancelListed).length
    return listed === 0 ? 'Restart cancelled' : `Cancelled · ${listed} not told to carry on`
  }
  return run.openedBuild?.startsWith('Update failed') ? run.openedBuild : `Restarted on ${run.openedBuild?.slice(0, 7) ?? 'unknown build'}`
}
export function UpdateRestartDialog(props: {
  snapshot: UpdateRestartSnapshot
  action(op: UpdateRestartOperation): Promise<void>
  close(): void
  resumeReported(cohortId: string, entries: ReadonlyArray<{ sessionId: string; action: 'resume' | 'relaunch'; command: string }>): Promise<RendererCohortResumeResult>
}): React.JSX.Element {
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [manual, setManual] = useState<Record<string, string>>({})
  const run = props.snapshot.run?.dismissed ? null : props.snapshot.run
  const reported = run ? props.snapshot.reportedCohort : null
  const waiting = run?.phase === 'admitting' || run?.phase === 'waiting' || run?.phase === 'closing'
  const after = run?.phase === 'resuming' || run?.phase === 'complete'
  const cancelled = run?.phase === 'cancelled' || run?.phase === 'cancelling'
  const stage: UpdateRestartStage = waiting ? 'waiting' : after ? 'after' : cancelled ? 'cancelled' : 'offer'
  // After Cancel only the sessions BMN could not tell are listed; every other one carries on without a row.
  const rows = waiting || after ? run.members : cancelled ? run.members.filter(updateRestartCancelListed) : props.snapshot.sessions
  const title = updateRestartTitle(run, stage)
  const act = (op: UpdateRestartOperation): void => {
    if (busy) return
    setBusy(true); setFailure(undefined)
    void props.action(op).catch(e => setFailure(e instanceof Error ? e.message : 'Restart failed')).finally(() => setBusy(false))
  }
  return <Dialog label={title} onClose={() => waiting ? act('cancel') : props.close()} className="close-sessions update-restart">
    {!run || !waiting && !after && !cancelled ? <p className="close-sessions-summary">Update {props.snapshot.waitingBuild?.slice(0, 7)} is waiting. {rows.length === 1 ? '1 session is' : `${rows.length} sessions are`} running.</p> : null}
    <ul className="close-sessions-list">
      {rows.map(m => <li key={m.sessionId}>
        <span className="who"><span className="identity">
          {after && reported?.entries.some(e => e.sessionId === m.sessionId) && !manual[m.sessionId] ? <input type="checkbox" aria-label={`Run reported command for ${m.name}`} checked={selected.includes(m.sessionId)} onChange={e => setSelected(ids => e.target.checked ? [...ids, m.sessionId] : ids.filter(id => id !== m.sessionId))} /> : null}
          <span className="name">{m.name}</span><span className="workspace"> · {m.workspace}</span></span>
          <span className="detail">{manual[m.sessionId] ?? updateRestartWords(m, stage)}</span>
        </span>
        {after && reported?.entries.filter(e => e.sessionId === m.sessionId).map(e => <p className="note" key={e.sessionId}><code>{e.command}</code></p>)}
      </li>)}
    </ul>
    {failure || run?.error ? <p role="alert">{failure ?? run?.error}</p> : null}
    <div className="dialog-actions">
      <button type="button" className="ghost" disabled={busy && !waiting} onClick={() => waiting ? void props.action('cancel').catch(e => setFailure(e instanceof Error ? e.message : 'Cancel failed')) : props.close()}>{after || cancelled ? 'Close' : 'Cancel'}</button>
      {after && reported ? <button type="button" className="primary" disabled={busy || selected.length === 0} onClick={() => {
        setBusy(true)
        void props.resumeReported(reported.cohortId, reported.entries.filter(e => selected.includes(e.sessionId)).map(({ sessionId, action, command }) => ({ sessionId, action, command })))
          .then(result => { setManual(current => ({ ...current, ...Object.fromEntries(result.entries.map(e => [e.sessionId, e.outcome === 'started' ? 'Resumed' : `Not resumed · ${e.error ?? e.outcome}`])) })); setSelected([]) })
          .catch(e => setFailure(e instanceof Error ? e.message : 'Resume failed')).finally(() => setBusy(false))
      }}>{`Resume ${selected.length} ${selected.length === 1 ? 'session' : 'sessions'}`}</button> : null}
      {!after && !cancelled ? <button type="button" className="primary" disabled={busy || run?.phase === 'closing'} onClick={() => act(waiting ? 'now' : 'begin')}>{waiting ? 'Restart now' : 'Restart'}</button> : null}
    </div>
  </Dialog>
}
