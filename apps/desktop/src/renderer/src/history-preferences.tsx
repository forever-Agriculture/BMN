// MODULE: history-preferences.tsx - Preferences → History: one agent-history limit, its per-agent rows, Start cleanup, and BMN's archive limit
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  AGENT_HISTORY_KEEP_DAYS,
  ARCHIVE_DELETE_AFTER_DAYS,
  type AgentHistoryKeepDays,
  type AgentHistoryStatus,
  type AppSettings,
  type ArchiveDeleteAfterDays
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import {
  AGENT_NAMES,
  agentFailure,
  agentValue,
  confirmSentence,
  folderValue,
  keepHelp,
  keepLabel,
  sessionsLabel,
  type HistoryValue
} from './history-rows'

/** While a run deletes, the rows refresh this often. */
const RUNNING_POLL_MS = 1_500

/** Archive choices shortest to longest, Never last, like the agent limit. */
const ARCHIVE_ORDER: readonly ArchiveDeleteAfterDays[] = [...ARCHIVE_DELETE_AFTER_DAYS]
  .sort((a, b) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY))

/** Four equal segments; arrow keys move the choice, like a native radio group. */
export function Segmented<Value extends number | null>(props: {
  labelledBy: string
  options: readonly Value[]
  value: Value
  disabled?: boolean
  optionLabel(value: Value): string
  onChange(value: Value): void
}): React.JSX.Element {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0 || props.disabled) return
    event.preventDefault()
    const index = props.options.indexOf(props.value)
    const next = (index + step + props.options.length) % props.options.length
    props.onChange(props.options[next] as Value)
    buttons.current[next]?.focus()
  }
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={props.labelledBy} onKeyDown={move}>
      {props.options.map((option, index) => {
        const checked = option === props.value
        return (
          <button
            key={String(option)}
            ref={(element) => { buttons.current[index] = element }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={props.disabled}
            onClick={() => { if (!checked) props.onChange(option) }}
          >
            {props.optionLabel(option)}
          </button>
        )
      })}
    </div>
  )
}

function Value(props: { value: HistoryValue }): React.JSX.Element {
  if (props.value.kind === 'pending') {
    return <dd className="value">{props.value.now} → <span className="next">{props.value.next}</span></dd>
  }
  return <dd className="value" title={props.value.title}>{props.value.text}</dd>
}

export function HistoryPreferences(props: {
  settings: AppSettings
  onSettings(next: AppSettings): void
}): React.JSX.Element {
  const onSettings = useRef(props.onSettings)
  onSettings.current = props.onSettings
  const [status, setStatus] = useState<AgentHistoryStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.aiTerminal.getHistoryStatus())
    } catch (cause) {
      setError(failureDetail(cause, 'Could not read agent history'))
    }
  }, [])

  // The app's settings change after every History write, a learned folder and a finished run.
  useEffect(() => { void load() }, [load, props.settings])

  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(() => void load(), RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [status?.running, load])

  async function saveKeep(next: AgentHistoryKeepDays): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      onSettings.current(await window.aiTerminal.putSettings('agentHistory', { ...props.settings.agentHistory, keepDays: next }))
      await load()
    } catch (cause) {
      setError(failureDetail(cause, 'Could not save the history limit'))
    } finally {
      setBusy(false)
    }
  }

  async function startCleanup(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setStatus(await window.aiTerminal.confirmHistory())
    } catch (cause) {
      setError(failureDetail(cause, 'Could not start cleanup'))
    } finally {
      setBusy(false)
    }
  }

  const [archiveBusy, setArchiveBusy] = useState(false)
  async function saveArchive(next: ArchiveDeleteAfterDays): Promise<void> {
    setArchiveBusy(true)
    setError(null)
    try {
      onSettings.current(await window.aiTerminal.putSettings('archive', { deleteAfterDays: next }))
    } catch (cause) {
      setError(failureDetail(cause, 'Could not save archive settings'))
    } finally {
      setArchiveBusy(false)
    }
  }

  const keepDays = status?.keepDays ?? props.settings.agentHistory.keepDays
  return (
    <section className="preferences-section history-section" aria-labelledby="preferences-history-title">
      <h3 id="preferences-history-title">History</h3>
      <div className="preferences-row">
        <div className="preferences-row-label">
          <span id="preferences-history-keep">Keep agent history</span>
        </div>
        <div className="preferences-row-control history-control">
          <Segmented
            labelledBy="preferences-history-keep"
            options={AGENT_HISTORY_KEEP_DAYS}
            value={keepDays}
            disabled={busy || status?.running === true}
            optionLabel={keepLabel}
            onChange={(next) => void saveKeep(next)}
          />
          <p className="preferences-help">{status ? keepHelp(status) : 'Each agent deletes sessions untouched longer.'}</p>
        </div>
      </div>
      {status && (
        <dl className="kv history-rows">
          {status.claude.map((folder) => (
            <div className="history-row" key={folder.path}>
              <dt>{folder.name}</dt>
              <dd className="path" title={folder.path}><bdi>{folder.displayPath}</bdi></dd>
              <Value value={folderValue(folder)} />
              {folder.failure && <dd className="failure" title={folder.failure}>failed: {folder.failure}</dd>}
            </div>
          ))}
          {status.agents.map((row) => {
            const failure = agentFailure(row)
            return (
              <div className="history-row" key={row.agent}>
                <dt>{AGENT_NAMES[row.agent]}</dt>
                <dd>{row.sessions === undefined ? '' : sessionsLabel(row.sessions)}</dd>
                <Value value={agentValue(row, status)} />
                {failure && <dd className="failure" title={failure.title}>{failure.text}</dd>}
              </div>
            )
          })}
        </dl>
      )}
      {status?.needsConfirmation && (
        <div className="history-confirm">
          <span className="status-dot needs-you" aria-hidden="true" />
          <p>{confirmSentence(status)}</p>
          <button type="button" className="primary" disabled={busy || status.running} onClick={() => void startCleanup()}>
            {status.running ? 'Cleaning up…' : 'Start cleanup'}
          </button>
        </div>
      )}
      {error && <p className="preferences-help" role="alert">{error}</p>}
      <div className="preferences-row history-archive">
        <div className="preferences-row-label">
          <span id="preferences-archive-delete-after">Delete archived sessions and workspaces</span>
        </div>
        <div className="preferences-row-control history-control">
          <Segmented
            labelledBy="preferences-archive-delete-after"
            options={ARCHIVE_ORDER}
            value={props.settings.archive.deleteAfterDays}
            disabled={archiveBusy}
            optionLabel={(days) => days === null ? 'Never' : `${days} days`}
            onChange={(next) => void saveArchive(next)}
          />
          <p className="preferences-help">BMN&apos;s own archive, checked at start.</p>
        </div>
      </div>
    </section>
  )
}
