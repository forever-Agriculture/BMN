// MODULE: terminal-clipboard.ts - agterm's mouse clipboard: finishing a mouse selection copies it, right-click pastes

export interface MouseClipboardButton {
  button: number
  shiftKey: boolean
}

export interface MouseClipboardHost {
  hasSelection(): boolean
  getSelection(): string
  /** The program asked for mouse reports, so an unforced click belongs to it. */
  mouseTracking(): boolean
  copy(text: string): void
  paste(): void
}

export interface MouseClipboard {
  /** A press inside the terminal surface. */
  mouseDown(event: MouseClipboardButton): void
  /** A release anywhere in the window, after the terminal has finished its selection. */
  mouseUp(event: MouseClipboardButton): void
  /** A right-click inside the terminal surface. Returns true when it pasted and the event must be cancelled. */
  contextMenu(event: MouseClipboardButton): boolean
}

const PRIMARY = 0

/** Text as copied: without the trailing spaces and blank rows the screen pads a selection with, as Ghostty trims it. */
export function copyableText(selection: string): string {
  return selection.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
}

export function createMouseClipboard(host: MouseClipboardHost): MouseClipboard {
  let selecting = false
  return {
    mouseDown: (event) => {
      if (event.button === PRIMARY) selecting = true
    },
    mouseUp: (event) => {
      if (event.button !== PRIMARY || !selecting) return
      selecting = false
      // A plain click clears the selection; it never overwrites the clipboard.
      if (!host.hasSelection()) return
      const text = copyableText(host.getSelection())
      if (text) host.copy(text)
    },
    contextMenu: (event) => {
      // Pasting into a program reading the mouse (vim, htop) could run keys it never asked for; Shift forces it.
      if (host.mouseTracking() && !event.shiftKey) return false
      host.paste()
      return true
    }
  }
}
