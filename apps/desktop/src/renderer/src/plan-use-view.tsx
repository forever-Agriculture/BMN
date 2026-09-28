// MODULE: plan-use-view.tsx - Session details' Plan use section and the palette's read-only Plan use dialog (Story 37.2)
import { useEffect, useState } from 'react'
import { usagePercent, type SessionUsage, type UsageAgent, type UsageReading } from '@bmn/protocol'
import { boundedRead } from './bounded-read'
import { Dialog } from './dialog'
import { contextUseWords, planSourceWords, planUseMissingWords, planUseWords, planWindowViews } from './session-presentation'
import './plan-use.css'

/** One reading's windows as meters; the list's label is the whole reading in one line. */
export function PlanWindows(props: { reading: UsageReading; now: number }): React.JSX.Element {
  return (
    <ul className="plan-use-windows" aria-label={planUseWords(props.reading, props.now) ?? undefined}>
      {planWindowViews(props.reading, props.now).map((window) => (
        <li key={window.name} className={window.stale ? 'stale' : window.high ? 'high' : undefined}>
          <span className="name">{window.name}</span>
          <span className="meter" aria-hidden="true"><span style={{ width: `${Math.min(100, window.percent)}%` }} /></span>
          <span className="value">{window.percent}%</span>
          <span className="when" title={window.when}>{window.when}</span>
        </li>
      ))}
    </ul>
  )
}

/** Words with the command to type, set in backticks, shown as code. */
function withCommands(words: string): React.JSX.Element {
  return <>{words.split('`').map((part, index) => index % 2 === 1 ? <code key={index}>{part}</code> : part)}</>
}

/**
 * How much of its plan the session's agent has used, as the agent itself last reported it. Read-only and
 * in memory only: a restart of BMN shows no reading until the agent reports again.
 */
export function PlanUseView(props: { sessionId: string; incarnationId: string | null; refreshTick: number }): React.JSX.Element {
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    void boundedRead(window.aiTerminal.getUsage(props.sessionId)).then((value) => {
      if (!current) return
      setUsage(value.sessionId === props.sessionId && value.incarnationId === props.incarnationId ? value : null)
      setFailed(false)
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [props.sessionId, props.incarnationId, props.refreshTick])

  const reading = usage?.reading ?? null
  const context = contextUseWords(reading)
  return (
    <section className="plan-use inspector-section" aria-label="Plan use">
      <h3>Plan use</h3>
      {failed ? <p className="inline-error" role="status">Plan use unavailable</p> : null}
      {reading !== null && reading.windows.length > 0 ? <PlanWindows reading={reading} now={props.refreshTick} />
        : <p className="plan-use-note">{withCommands(planUseMissingWords(usage ?? { agent: null, reading: null }))}</p>}
      {context === null || reading?.contextUsedPercent == null ? null : (
        <p className="plan-use-context" title={context} aria-label={context}>
          <span className="name">Context window</span>
          <span className="value">{usagePercent(reading.contextUsedPercent)}%</span>
        </p>
      )}
      {reading === null ? null : <small>{planSourceWords(reading, props.refreshTick)}</small>}
    </section>
  )
}

const DIALOG_AGENTS: readonly { agent: UsageAgent; name: string }[] = [
  { agent: 'claude', name: 'Claude Code' },
  { agent: 'codex', name: 'Codex' }
]

/** Harnesses with no local source of plan use (docs/usage-sources.md), named so their absence is explained. */
const NOT_REPORTED = ['claude glm', 'OpenCode', 'Cursor'] as const

/** The latest reading per agent across all sessions, since a plan belongs to the account. */
export function PlanUseDialog(props: { now: number; onClose(): void }): React.JSX.Element {
  const [readings, setReadings] = useState<UsageReading[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    void boundedRead(window.aiTerminal.listUsage())
      .then((found) => { if (live) setReadings(found) })
      .catch(() => { if (live) { setReadings([]); setFailed(true) } })
    return () => { live = false }
  }, [props.now])

  return (
    <Dialog label="Plan use" onClose={props.onClose} className="plan-use-dialog">
      <p className="dialog-note">Latest reading per agent, from what the agents write locally. In memory only; no network calls.</p>
      {failed ? <p className="inline-error" role="status">Plan use unavailable</p> : null}
      {readings === null ? <p className="dialog-note">Reading…</p> : (
        <ul className="plan-use-agents" aria-label="Plan use by agent">
          {DIALOG_AGENTS.map(({ agent, name }) => {
            const reading = readings.find((item) => item.agent === agent) ?? null
            return (
              <li key={agent} data-agent={agent}>
                <h3>{name}</h3>
                {reading === null ? <small>No reading yet</small> : (
                  <>
                    <PlanWindows reading={reading} now={props.now} />
                    <small>{planSourceWords(reading, props.now)}</small>
                  </>
                )}
              </li>
            )
          })}
          <li className="not-reported" data-agent="none">
            <small>Not reported by {NOT_REPORTED.slice(0, -1).join(', ')} or {NOT_REPORTED.at(-1)}</small>
          </li>
        </ul>
      )}
    </Dialog>
  )
}
