// MODULE: hook-observation-view.tsx - one session/run's actual harness event receipt, never a health verdict
import { useEffect, useState } from 'react'
import type { HookObservation } from '@bmn/protocol'
import { boundedRead } from './bounded-read'
import { failureDetail } from './bridge-error'
import './hook-observation-view.css'

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' } as const

export function HookObservationView(props: {
  sessionId: string
  sessionName: string
  incarnationId: string | null
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
  }, [props.sessionId, props.incarnationId, props.refreshTick, refresh])

  return (
    <section className="hook-observation" aria-label="Harness integration">
      <h3>Harness integration</h3>
      {reading && observation === null ? <p>Reading hook observations…</p> : null}
      {error ? <p className="inline-error" role="status">Observation unavailable: {error}</p> : null}
      {observation?.state === 'none' ? (
        <p><strong>Not observed in this run</strong>. A relevant hook may simply not have happened yet.
          {props.incarnationId ? null : ' No process run is recorded.'}</p>
      ) : null}
      {observation?.state === 'observed' ? (
        <>
          <p><strong>Observed by BMN</strong> · {AGENT_NAMES[observation.agent]} {observation.event}</p>
          <p>Received {new Date(observation.observedAt).toLocaleString()} · {props.sessionName} · run {observation.incarnationId}</p>
          {observation.detailAvailable
            ? <button type="button" onClick={props.onOpenEvents}>Open Hook events</button>
            : <p>Earlier event detail is no longer available in the recent Hook events list.</p>}
        </>
      ) : null}
      <div className="hook-observation-actions">
        <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={reading}>Refresh observation</button>
        <button type="button" onClick={props.onOpenConfiguration}>Check configured hooks in Preferences</button>
      </div>
      <p>One observed event proves it reached BMN. It does not prove every hook or permission path works.</p>
    </section>
  )
}
