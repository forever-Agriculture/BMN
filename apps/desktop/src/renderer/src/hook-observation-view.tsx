// MODULE: hook-observation-view.tsx - one session/run's actual harness event receipt, never a health verdict
import { useEffect, useState } from 'react'
import type { HookObservation, HookOriginRecord } from '@bmn/protocol'
import { boundedRead } from './bounded-read'
import { failureDetail } from './bridge-error'
import { compactionWords, modelOriginFlag, modelOriginLabel } from './session-presentation'
import './hook-observation-view.css'

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' } as const

export function HookObservationView(props: {
  sessionId: string
  sessionName: string
  incarnationId: string | null
  /** This run's model-origin facts when its own hooks reported them; a plain shell has none. */
  origin: HookOriginRecord | null
  refreshTick: number
  onOpenEvents(): void
  onOpenConfiguration(): void
}): React.JSX.Element {
  const [observation, setObservation] = useState<HookObservation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let current = true
    setReading(true)
    void boundedRead(window.aiTerminal.getHookObservation(
      props.sessionId, props.incarnationId ?? undefined
    )).then((value) => {
      if (!current) return
      setObservation(value.sessionId === props.sessionId &&
        value.incarnationId === props.incarnationId ? value : { state: 'none',
          sessionId: props.sessionId, incarnationId: props.incarnationId })
      setError(null)
    }).catch((cause: unknown) => {
      if (!current) return
      setObservation(null)
      setError(failureDetail(cause, 'Hook observation unavailable'))
    }).finally(() => { if (current) setReading(false) })
    return () => { current = false }
    // A new origin means this run's hook just reported, so the Model row follows the flag at once
    // instead of waiting for the next refresh tick.
  }, [props.sessionId, props.incarnationId, props.refreshTick, refresh, props.origin?.observedAt])

  return (
    <section className="hook-observation inspector-section" aria-label="Harness integration">
      <h3>Harness
        <button type="button" className="ghost small" onClick={() => setRefresh((value) => value + 1)}
          disabled={reading}>Refresh observation</button>
      </h3>
      {reading && observation === null ? <p className="meta">Reading hook observations…</p> : null}
      {error ? <p className="inline-error" role="status">Observation unavailable: {error}</p> : null}
      {observation?.state === 'none' ? (
        <>
          <p><strong>Not observed in this run.</strong> <span className="meta">A relevant hook may simply not have
            happened yet.{props.incarnationId ? null : ' No process run is recorded.'}</span></p>
          <p className="hook-compaction">{compactionWords(null)}</p>
        </>
      ) : null}
      {observation?.state === 'observed' ? (
        <>
          <p><strong>Observed by BMN</strong></p>
          <dl className="kv">
            <dt>Event</dt>
            <dd title={`${AGENT_NAMES[observation.agent]} ${observation.event}`}>
              {AGENT_NAMES[observation.agent]} {observation.event}</dd>
            <dt>Received</dt>
            <dd>{new Date(observation.observedAt).toLocaleString()}</dd>
            <dt>Session</dt>
            <dd title={props.sessionName}>{props.sessionName}</dd>
            <dt>Run</dt>
            <dd className="path" title={observation.incarnationId}><bdi>run {observation.incarnationId}</bdi></dd>
            {props.origin !== null ? (
              <dt>Model</dt>
            ) : null}
            {props.origin !== null ? (
              <dd title={modelOriginLabel(props.origin) ?? 'Model origin unclassified'}>
                {modelOriginFlag(props.origin) === null ? null : (
                  <span aria-hidden="true">{modelOriginFlag(props.origin)} </span>
                )}
                {props.origin.model ?? 'Unknown model'}{props.origin.apiHost === null ? null : ` via ${props.origin.apiHost}`}
              </dd>
            ) : null}
          </dl>
          <p className="hook-compaction">{compactionWords(observation.compaction)}</p>
          {observation.detailAvailable ? null
            : <p className="meta">Earlier event detail is no longer in the recent Hook events list.</p>}
        </>
      ) : null}
      <div className="actions hook-observation-actions">
        {observation?.state === 'observed' && observation.detailAvailable
          ? <button type="button" className="small" onClick={props.onOpenEvents}>Open Hook events</button> : null}
        <button type="button" className="small" onClick={props.onOpenConfiguration}>Check configured hooks in Preferences</button>
      </div>
      <small>One observed event proves it reached BMN. It does not prove every hook or permission path works.</small>
    </section>
  )
}
