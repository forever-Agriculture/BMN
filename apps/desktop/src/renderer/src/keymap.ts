// MODULE: keymap.ts - app keyboard shortcuts resolved from key events, leaving every other key to the terminal

export type AppCommand =
  | 'workspace-previous'
  | 'workspace-next'
  | 'session-previous'
  | 'session-next'
  | 'attention-next'
  | 'palette'
  | 'copy'
  | 'paste'
  | 'search'
  | 'split-toggle'
  | 'focus-toggle'
  | 'font-increase'
  | 'font-decrease'
  | 'font-reset'
  | 'send-next-key'
  | 'voice-toggle'

export interface ShortcutEvent {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Shortcut labels shown in the palette and menus. */
export const SHORTCUT_LABELS: Readonly<Record<AppCommand, string>> = Object.freeze({
  'workspace-previous': 'Ctrl Shift ←',
  'workspace-next': 'Ctrl Shift →',
  'session-previous': 'Ctrl Shift ↑',
  'session-next': 'Ctrl Shift ↓',
  'attention-next': 'Ctrl Shift U',
  palette: 'Ctrl Shift P',
  copy: 'Ctrl Shift C',
  paste: 'Ctrl Shift V',
  search: 'Ctrl Shift F',
  'split-toggle': 'Ctrl Shift Enter',
  'focus-toggle': 'Ctrl Shift Z',
  'font-increase': 'Ctrl +',
  'font-decrease': 'Ctrl −',
  'font-reset': 'Ctrl 0',
  'send-next-key': 'Ctrl Shift \\',
  'voice-toggle': 'Ctrl Shift Space'
})

const CTRL_SHIFT_CODES: Readonly<Record<string, AppCommand>> = Object.freeze({
  ArrowLeft: 'workspace-previous',
  ArrowRight: 'workspace-next',
  ArrowUp: 'session-previous',
  ArrowDown: 'session-next',
  KeyU: 'attention-next',
  KeyP: 'palette',
  KeyC: 'copy',
  KeyV: 'paste',
  KeyF: 'search',
  Enter: 'split-toggle',
  NumpadEnter: 'split-toggle',
  KeyZ: 'focus-toggle',
  Backslash: 'send-next-key',
  Space: 'voice-toggle'
})

/**
 * Resolves an app command. Only Ctrl+Shift chords and Ctrl +/−/0 belong to the app; plain Ctrl keys,
 * Alt sequences, Tab and Escape stay with the terminal process.
 */
export function resolveShortcut(event: ShortcutEvent): AppCommand | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null
  if (event.shiftKey) {
    const command = CTRL_SHIFT_CODES[event.code]
    if (command) return command
    // Ctrl+Shift+= types "+" on most layouts: treat it as the increase chord too.
    return event.key === '+' ? 'font-increase' : null
  }
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return 'font-increase'
  if (event.key === '-' || event.code === 'NumpadSubtract') return 'font-decrease'
  if (event.key === '0' || event.code === 'Numpad0') return 'font-reset'
  return null
}

/** Modifier-only presses never consume an armed send-next-key. */
export function isModifierOnly(event: Pick<ShortcutEvent, 'key'>): boolean {
  return event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta' ||
    event.key === 'AltGraph' || event.key === 'CapsLock'
}
