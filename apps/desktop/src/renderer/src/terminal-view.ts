import { TERMINAL_SCROLLBACK_LINES } from '@bmn/protocol'
import type { SavedOutputPresentation } from './terminal-history'

const NEVER_CAPTURED_MESSAGE = 'No saved output has been captured for this session.'
const SELECT_CAPTURE_MESSAGE = 'Select a prior saved-output capture.'

export function searchStatusText(
  searchResult: string,
  lineLimit = TERMINAL_SCROLLBACK_LINES
): string {
  return searchResult || `Search covers retained history (${lineLimit.toLocaleString('en-US')} lines)`
}

export function terminalSurfaceClass(savedOutputOpen: boolean): string {
  return savedOutputOpen
    ? 'terminal-surface terminal-surface-hidden'
    : 'terminal-surface'
}

export type SavedOutputContent =
  | { kind: 'captured'; presentation: SavedOutputPresentation }
  | { kind: 'never-captured'; message: typeof NEVER_CAPTURED_MESSAGE | typeof SELECT_CAPTURE_MESSAGE }

export function savedOutputContent(
  presentation: SavedOutputPresentation | undefined,
  hasCaptures = false
): SavedOutputContent {
  return presentation
    ? { kind: 'captured', presentation }
    : {
        kind: 'never-captured',
        message: hasCaptures ? SELECT_CAPTURE_MESSAGE : NEVER_CAPTURED_MESSAGE
      }
}
