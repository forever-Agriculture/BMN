// MODULE: repeat-watch.ts - pure, bounded repeat counting for one session incarnation
const REPEAT_WINDOW = 20
/** Tune against the local repeat-watch.log calibration segments. */
export const REPEAT_NOTICE_AT = 8

export type RepeatAgent = 'claude' | 'codex' | 'opencode'

export interface RepeatSegment {
  agent: RepeatAgent
  toolName: string | null
  maxRepeat: number
  toolEvents: number
  notified: boolean
}
export interface RepeatState extends RepeatSegment {
  incarnationId: string | null
  fingerprints: string[]
  fired: boolean
}
export interface RepeatEvent {
  incarnationId: string | null
  agent: RepeatAgent
  event: string
  source: string | null
  toolName: string | null
  fingerprint?: string | undefined
}

/** The owner's next message: Claude's and Codex's prompt hook, or an OpenCode root run starting (OpenCode has no prompt hook). */
export function ownerTurn(event: Pick<RepeatEvent, 'agent' | 'event' | 'source'>): boolean {
  return event.event === 'UserPromptSubmit' || (event.agent === 'opencode' && event.event === 'session.status' && event.source !== 'subagent')
}

export function observeRepeat(previous: RepeatState | undefined, event: RepeatEvent): {
  state: RepeatState
  repeat: number | null
  fire: boolean
  closed: RepeatSegment | null
} {
  const reset = previous?.incarnationId !== event.incarnationId ||
    ownerTurn(event) || ['SessionEnd', 'Interrupt'].includes(event.event) ||
    (event.event === 'SessionStart' && event.source !== 'compact')
  const closed = reset && previous && previous.maxRepeat >= 3
    ? { agent: previous.agent, toolName: previous.toolName, maxRepeat: previous.maxRepeat,
        toolEvents: previous.toolEvents, notified: previous.notified }
    : null
  const state: RepeatState = reset || !previous
    ? { incarnationId: event.incarnationId, agent: event.agent, fingerprints: [], fired: false,
        toolName: null, maxRepeat: 0, toolEvents: 0, notified: false }
    : { ...previous, fingerprints: [...previous.fingerprints] }
  let repeat: number | null = null
  let fire = false
  if (event.fingerprint !== undefined) {
    state.fingerprints.push(event.fingerprint)
    if (state.fingerprints.length > REPEAT_WINDOW) state.fingerprints.shift()
    state.toolEvents += 1
    repeat = state.fingerprints.filter((value) => value === event.fingerprint).length
    if (repeat > state.maxRepeat) {
      state.maxRepeat = repeat
      state.toolName = event.toolName
      state.agent = event.agent
    }
    if (repeat === REPEAT_NOTICE_AT && !state.fired) {
      state.fired = true
      fire = true
    }
  }
  return { state, repeat, fire, closed }
}
