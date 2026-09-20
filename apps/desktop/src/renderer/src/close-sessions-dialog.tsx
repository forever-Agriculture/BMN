// MODULE: close-sessions-dialog.tsx - asks what to do with running sessions, in BMN's own words
import { useState } from 'react'
import type { BackgroundChoice, ClosePromptDecision, ClosePromptRequest } from '@bmn/protocol'
import { Dialog } from './dialog'
import {
  closePromptHeading,
  closePromptRows,
  closePromptSummary,
  type ClosePromptRow
} from './close-prompt-presentation'
import type { ActivityWord } from './session-activity'

/**
 * The close and quit questions the main process used to ask through a native message box full of
 * identifiers. Closing keeps sessions by default and never stops one the owner did not mark;
 * quitting stops everything, so it states that instead of offering a choice it cannot honour.
 */
export function CloseSessionsDialog(props: {
  request: ClosePromptRequest
  describe(sessionId: string): { workspace: string; activity: ActivityWord | undefined }
  onDecide(decision: ClosePromptDecision): void
}): React.JSX.Element {
  const mode = props.request.mode
  const [rows, setRows] = useState<ClosePromptRow[]>(() =>
    closePromptRows(props.request.sessions, props.describe)
  )
  const [remember, setRemember] = useState(true)
  const label = closePromptHeading(mode)
  const setChoice = (sessionId: string, choice: BackgroundChoice): void => {
    setRows((current) =>
      current.map((row) => (row.sessionId === sessionId ? { ...row, choice } : row))
    )
  }
  const setEveryChoice = (choice: BackgroundChoice): void => {
    setRows((current) => current.map((row) => ({ ...row, choice })))
  }
  const cancel = (): void => props.onDecide({ kind: 'cancel' })
  const proceed = (): void => {
    props.onDecide({
      kind: 'proceed',
      choices: Object.fromEntries(
        rows.map((row) => [row.sessionId, mode === 'quit' ? 'stop' : row.choice])
      ),
      remember: mode === 'close' && remember
    })
  }

  return (
    <Dialog label={label} onClose={cancel} className="close-sessions">
      <p className="close-sessions-summary">{closePromptSummary(mode, rows.length)}</p>
      {mode === 'close' && rows.length > 2 ? (
        <div className="close-sessions-bulk">
          <button type="button" className="link" onClick={() => setEveryChoice('hide')}>Keep all running</button>
          <button type="button" className="link" onClick={() => setEveryChoice('stop')}>Stop all</button>
        </div>
      ) : null}
      <ul className="close-sessions-list">
        {rows.map((row) => (
          <li key={row.sessionId}>
            <span className="who">
              <span className="name">{row.name}</span>
              <span className="workspace"> · {row.workspace}</span>
              <span className="detail">{row.detail}</span>
            </span>
            {mode === 'close' ? (
              <span className="choice" role="group" aria-label={`What happens to ${row.name}`}>
                <button
                  type="button"
                  className={row.choice === 'hide' ? 'segment chosen' : 'segment'}
                  aria-pressed={row.choice === 'hide'}
                  onClick={() => setChoice(row.sessionId, 'hide')}
                >Keep running</button>
                <button
                  type="button"
                  className={row.choice === 'stop' ? 'segment chosen stop' : 'segment'}
                  aria-pressed={row.choice === 'stop'}
                  onClick={() => setChoice(row.sessionId, 'stop')}
                >Stop</button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {mode === 'close' ? (
        <label className="close-sessions-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          Remember these choices for these sessions
        </label>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={cancel}>Cancel</button>
        {/* Enter takes the safe answer: closing keeps the agents running, and only Quit ends them. */}
        <button type="button" className={mode === 'quit' ? 'danger' : 'primary'} autoFocus onClick={proceed}>
          {mode === 'quit' ? 'Quit BMN' : 'Close BMN'}
        </button>
      </div>
    </Dialog>
  )
}
