// MODULE: hook-events-dialog.tsx - read-only list of one session's recent hook events
import { useEffect, useState } from 'react'
import { isCompactionEvent, type HookEventRecord, type HookEventsView } from '@bmn/protocol'
import { Dialog } from './dialog'
import { relativeAge } from './session-presentation'

/** "opened and withdrew", "changed nothing" — what one event did to Needs you, in plain words. */
export function hookEffectWords(effects: readonly HookEventRecord['effects'][number][]): string {
  if (effects.length === 0) return 'changed nothing'
  const words = effects.map((effect) => effect === 'answered' ? 'answered a request' : `${effect} a request`)
  if (words.length === 1) return words[0]!
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/**
 * The event's own words: `PostToolUse · Bash · same call ×3`, `SessionStart · resume`. A compaction
 * reads as what it did, in the same words for every agent that reports one.
 */
export function hookEventWords(event: Pick<HookEventRecord, 'agent' | 'event' | 'source' | 'toolName'> &
  Partial<Pick<HookEventRecord, 'repeat'>>): string {
  if (isCompactionEvent(event)) return 'Conversation compacted'
  return [event.event, event.toolName, event.repeat !== undefined && event.repeat !== null && event.repeat >= 2
    ? `same call ×${event.repeat}` : null, event.source].filter((part) => !!part).join(' · ')
}

/**
 * Shows what the harness reported for one session, newest last, so a request that never arrived can be
 * explained by the events that did. Reads only: it sends nothing to the terminal and resolves nothing.
 */
export function HookEventsDialog(props: {
  sessionId: string
  sessionName: string
  now: number
  onClose(): void
  onFailure(message: string): void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ sessionId: string; view: HookEventsView } | null>(null)
  const view = loaded?.sessionId === props.sessionId ? loaded.view : null
  const events = view?.events ?? null

  useEffect(() => {
    let live = true
    window.aiTerminal.listHookEvents(props.sessionId, true)
      .then((found) => { if (live) setLoaded({ sessionId: props.sessionId, view: found }) })
      .catch(() => { if (live) { setLoaded({ sessionId: props.sessionId, view: { events: [], earlier: [], historyUnavailable: true } }); props.onFailure('Hook events are unavailable.') } })
    return () => { live = false }
  }, [props.sessionId])

  return (
    <Dialog label={`Hook events — ${props.sessionName}`} onClose={props.onClose} className="hook-events-dialog">
      <p className="dialog-note">
        What {props.sessionName}&rsquo;s harness reported to BMN, newest last. Earlier-run history keeps
        approved metadata only: up to 30 entries per session, 1,024 globally and 1 MiB. Oldest entries
        leave first; there is no age expiry. Recent events can be lost before a completed save,
        including on crash. History never changes this run&apos;s state and is excluded from backups.
      </p>
      {view?.historyUnavailable ? <p className="dialog-note" role="status">Recent history was unavailable. Live events continue; coalesced events can be lost before a completed save.</p> : null}
      {view && view.earlier.length > 0 ? <>
        <h3>Earlier host run · history</h3>
        <ul className="hook-events" aria-label="Earlier host run history">
          {view.earlier.map((event, index) => <li key={`${event.observedAt}-${index}`}>
            <span className="hook-event-name">{hookEventWords(event)}</span>
            <span className="hook-event-effects">Earlier run · {hookEffectWords(event.effects)}</span>
            <span className="age">{relativeAge(event.observedAt, props.now)}</span>
          </li>)}
        </ul>
      </> : null}
      {view ? <h3>This host run</h3> : null}
      {events === null ? <p className="dialog-note">Reading…</p> : null}
      {events !== null && events.length === 0 ? (
        <p className="dialog-note">No hook events yet for this session.</p>
      ) : null}
      {events !== null && events.length > 0 ? (
        <ul className="hook-events" aria-label="Hook events">
          {events.map((event, index) => (
            <li key={`${event.observedAt}-${index}`}>
              <span className="hook-event-name">{hookEventWords(event)}</span>
              <span className="hook-event-effects">{hookEffectWords(event.effects)}</span>
              <span className="age">{relativeAge(event.observedAt, props.now)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  )
}
