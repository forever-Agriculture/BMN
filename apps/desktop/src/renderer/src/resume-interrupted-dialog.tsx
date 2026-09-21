// MODULE: resume-interrupted-dialog.tsx - one offer to resume the sessions an update or quit stopped
import { useState } from 'react'
import type { InterruptedSessionCohort } from '@bmn/protocol'
import type { RendererCohortResumeResult } from '../../preload/bridge'
import { Dialog } from './dialog'
import {
  applyResumeOutcomes,
  resumeInterruptedButtonLabel,
  resumeInterruptedHeading,
  resumeInterruptedRows,
  resumeInterruptedSummary,
  resumeRowOutcomeWords,
  startableRows,
  type ResumeInterruptedRow
} from './resume-interrupted-presentation'

/**
 * The offer BMN makes after it stopped everything itself. Every row shows the exact command, so
 * pressing the button is the confirmation: no second per-session dialog follows. Nothing starts
 * until the button, and a row that started stays running whatever the rows after it do.
 */
export function ResumeInterruptedDialog(props: {
  cohort: InterruptedSessionCohort
  onClose(): void
  onResume(
    idempotencyKey: string,
    entries: ReadonlyArray<{ sessionId: string; action: 'resume' | 'relaunch'; command: string }>
  ): Promise<RendererCohortResumeResult>
}): React.JSX.Element {
  const [rows, setRows] = useState<ResumeInterruptedRow[]>(() => resumeInterruptedRows(props.cohort))
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string>()
  /**
   * One key per press. A press that came back keeps its outcomes and the next press is a new
   * action; a press whose reply never arrived keeps its key, so trying again returns what the
   * utility already recorded instead of starting anything a second time.
   */
  const [actionKey, setActionKey] = useState(() => crypto.randomUUID())
  const startable = startableRows(rows)
  const toggle = (sessionId: string): void => {
    setRows((current) => current.map((row) =>
      row.sessionId === sessionId && row.outcome.kind !== 'started' && row.outcome.kind !== 'failed'
        ? { ...row, checked: !row.checked }
        : row))
  }
  const resume = (): void => {
    if (starting || startable.length === 0) return
    setStarting(true)
    setFailure(undefined)
    void props
      .onResume(
        actionKey,
        startable.map(({ sessionId, action, command }) => ({ sessionId, action, command }))
      )
      .then((result) => {
        setRows((current) => applyResumeOutcomes(current, result.entries))
        setActionKey(crypto.randomUUID())
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : 'Resume failed'))
      .finally(() => setStarting(false))
  }

  return (
    <Dialog
      label={resumeInterruptedHeading(props.cohort.cause)}
      onClose={props.onClose}
      className="resume-interrupted"
    >
      <p className="resume-interrupted-summary">{resumeInterruptedSummary(props.cohort)}</p>
      <ul className="resume-interrupted-list">
        {rows.map((row) => (
          <li key={row.sessionId} data-outcome={row.outcome.kind}>
            <label className="who">
              <input
                type="checkbox"
                checked={row.checked}
                disabled={starting || row.outcome.kind === 'started' || row.outcome.kind === 'failed'}
                onChange={() => toggle(row.sessionId)}
              />
              <span className="name">{row.name}</span>
              <span className="workspace"> · {row.workspace}</span>
            </label>
            <p className="command">
              <span className="action">{row.action === 'resume' ? 'Resume' : 'Start again'}:</span>{' '}
              <code>{row.command}</code>
            </p>
            {row.notCarried ? <p className="note">{row.notCarried}</p> : null}
            {row.relaunchReason ? <p className="note">{row.relaunchReason}</p> : null}
            {row.outcome.kind !== 'pending'
              ? <p className="outcome">{resumeRowOutcomeWords(row.outcome)}</p>
              : null}
          </li>
        ))}
      </ul>
      {failure ? <p className="resume-interrupted-failure">{failure}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={props.onClose}>
          {rows.some((row) => row.outcome.kind !== 'pending') ? 'Close' : 'Cancel'}
        </button>
        <button
          type="button"
          className="primary"
          disabled={starting || startable.length === 0}
          onClick={resume}
        >{resumeInterruptedButtonLabel(rows)}</button>
      </div>
    </Dialog>
  )
}
