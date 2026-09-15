// MODULE: space-hold.ts - hold Space in a terminal to dictate; a short press still types a space
import type { ShortcutEvent } from './keymap'

/** A press held this long starts dictation; a quicker tap types a space. */
export const SPACE_HOLD_MS = 300

export interface SpaceHoldKey extends ShortcutEvent {
  repeat: boolean
  isComposing: boolean
}

export interface SpaceHoldHost {
  /** Types the withheld space into the session's terminal as if the key had gone straight through. */
  typeSpace(sessionId: string): void
  /** Whether dictation can start in this session now; asked when the hold threshold passes. */
  canTalk(sessionId: string): boolean
  startTalking(sessionId: string): void
  stopTalking(): void
}

export interface SpaceHold {
  /**
   * `sessionId` is the live session whose terminal has focus and allows hold to talk, or null to leave Space alone.
   * Returns true when the event must not reach the terminal.
   */
  keyDown(event: SpaceHoldKey, sessionId: string | null): boolean
  /** Returns true when the event must not reach the terminal. */
  keyUp(event: Pick<SpaceHoldKey, 'code'>): boolean
  /** The window lost focus and no release will arrive: a withheld space is typed and dictation stops. */
  blur(): void
}

type State =
  | { kind: 'idle' }
  | { kind: 'pending'; sessionId: string; timer: ReturnType<typeof setTimeout> }
  | { kind: 'talking' }
  /** The space was typed; the rest of this press, repeats included, belongs to the terminal. */
  | { kind: 'passthrough' }

const plainSpace = (event: SpaceHoldKey): boolean =>
  event.code === 'Space' && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey &&
  !event.isComposing && event.key !== 'Process'

export function createSpaceHold(host: SpaceHoldHost): SpaceHold {
  let state: State = { kind: 'idle' }

  const flush = (pending: Extract<State, { kind: 'pending' }>): void => {
    clearTimeout(pending.timer)
    state = { kind: 'passthrough' }
    host.typeSpace(pending.sessionId)
  }

  return {
    keyDown(event, sessionId) {
      if (!plainSpace(event)) {
        // Fast typing presses the next key before Space is released: the space must land first.
        if (state.kind === 'pending') flush(state)
        return false
      }
      if (state.kind === 'pending' || state.kind === 'talking') return true
      if (state.kind === 'passthrough' || event.repeat || !sessionId) return false
      const timer = setTimeout(() => {
        if (state.kind !== 'pending') return
        if (host.canTalk(sessionId)) {
          state = { kind: 'talking' }
          host.startTalking(sessionId)
        } else {
          flush(state)
        }
      }, SPACE_HOLD_MS)
      state = { kind: 'pending', sessionId, timer }
      return true
    },
    keyUp(event) {
      if (event.code !== 'Space') return false
      const previous = state
      state = { kind: 'idle' }
      if (previous.kind === 'pending') {
        clearTimeout(previous.timer)
        host.typeSpace(previous.sessionId)
        return true
      }
      if (previous.kind === 'talking') {
        host.stopTalking()
        return true
      }
      return false
    },
    blur() {
      const previous = state
      state = { kind: 'idle' }
      if (previous.kind === 'pending') {
        clearTimeout(previous.timer)
        host.typeSpace(previous.sessionId)
      } else if (previous.kind === 'talking') {
        host.stopTalking()
      }
    }
  }
}
