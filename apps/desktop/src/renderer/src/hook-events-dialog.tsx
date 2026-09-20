// MODULE: hook-events-dialog.tsx - read-only list of one session's recent hook events
import { useEffect, useState } from 'react'
import type { HookEventRecord } from '@bmn/protocol'
import { Dialog } from './dialog'
import { relativeAge } from './session-presentation'

/** "opened and withdrew", "changed nothing" — what one event did to Needs you, in plain words. */
export function hookEffectWords(effects: readonly HookEventRecord['effects'][number][]): string {
  if (effects.length === 0) return 'changed nothing'
  const words = effects.map((effect) => effect === 'answered' ? 'answered a request' : `${effect} a request`)
  if (words.length === 1) return words[0]!
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/** The event's own words: `PostToolUse · Bash`, `SessionStart · resume`. */
export function hookEventWords(event: Pick<HookEventRecord, 'event' | 'source' | 'toolName'>): string {
  return [event.event, event.toolName, event.source].filter((part) => !!part).join(' · ')
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
  const [events, setEvents] = useState<HookEventRecord[] | null>(null)

  useEffect(() => {
    let live = true
    window.aiTerminal.listHookEvents(props.sessionId)
      .then((found) => { if (live) setEvents(found) })
      .catch(() => { if (live) { setEvents([]); props.onFailure('Hook events are unavailable.') } })
    return () => { live = false }
  }, [props.sessionId])

  return (
    <Dialog label={`Hook events — ${props.sessionName}`} onClose={props.onClose} className="hook-events-dialog">
      <p className="dialog-note">
        What {props.sessionName}&rsquo;s harness reported to BMN, newest last. Kept in memory only, so the
        list starts empty after a restart.
      </p>
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
