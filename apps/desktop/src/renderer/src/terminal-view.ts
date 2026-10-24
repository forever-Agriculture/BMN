import { TERMINAL_SCROLLBACK_LINES } from '@bmn/protocol'

export function searchStatusText(
  searchResult: string,
  lineLimit = TERMINAL_SCROLLBACK_LINES
): string {
  return searchResult || `Search covers retained history (${lineLimit.toLocaleString('en-US')} lines)`
}
