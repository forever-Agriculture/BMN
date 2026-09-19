// MODULE: terminal-clipboard.test.ts - copy on mouse selection and right-click paste, as agterm does
import { beforeEach, describe, expect, it } from 'vitest'
import { copyableText, createMouseClipboard, type MouseClipboardButton } from './terminal-clipboard'

const left: MouseClipboardButton = { button: 0, shiftKey: false, ctrlKey: false }
const right: MouseClipboardButton = { button: 2, shiftKey: false, ctrlKey: false }

let calls: string[]
let selection: string
let tracking: boolean

function clipboard() {
  return createMouseClipboard({
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    mouseTracking: () => tracking,
    copy: (text) => calls.push(`copy:${text}`),
    paste: () => calls.push('paste')
  })
}

beforeEach(() => {
  calls = []
  selection = ''
  tracking = false
})

describe('mouse clipboard', () => {
  it('copies a selection when the drag that made it ends', () => {
    const mouse = clipboard()
    mouse.mouseDown(left)
    selection = 'npm run build'
    mouse.mouseUp(left)
    expect(calls).toEqual(['copy:npm run build'])
  })

  it('leaves the clipboard alone for a plain click', () => {
    const mouse = clipboard()
    mouse.mouseDown(left)
    mouse.mouseUp(left)
    expect(calls).toEqual([])
  })

  it('copies only for a press that started in the terminal', () => {
    const mouse = clipboard()
    selection = 'kept from before'
    mouse.mouseUp(left)
    mouse.mouseDown(left)
    mouse.mouseUp(left)
    mouse.mouseUp(left)
    expect(calls).toEqual(['copy:kept from before'])
  })

  it('ignores other buttons for copying', () => {
    const mouse = clipboard()
    selection = 'text'
    mouse.mouseDown(right)
    mouse.mouseUp(right)
    mouse.mouseDown({ button: 1, shiftKey: false, ctrlKey: false })
    mouse.mouseUp({ button: 1, shiftKey: false, ctrlKey: false })
    expect(calls).toEqual([])
  })

  it('copies a selection without the blank rows and trailing spaces the screen pads it with', () => {
    const mouse = clipboard()
    mouse.mouseDown(left)
    selection = 'MARK  \n  indented\t\n\n\n\n'
    mouse.mouseUp(left)
    selection = '\n\n'
    mouse.mouseDown(left)
    mouse.mouseUp(left)
    expect(calls).toEqual(['copy:MARK\n  indented'])
  })

  it('pastes on right-click', () => {
    expect(clipboard().contextMenu(right)).toBe(true)
    expect(calls).toEqual(['paste'])
  })

  it('leaves right-click to a program reading the mouse unless Shift is held', () => {
    tracking = true
    const mouse = clipboard()
    expect(mouse.contextMenu(right)).toBe(false)
    expect(calls).toEqual([])
    expect(mouse.contextMenu({ button: 2, shiftKey: true, ctrlKey: false })).toBe(true)
    expect(calls).toEqual(['paste'])
  })

  it('never pastes for a Ctrl+primary click that macOS reports as a context menu, leaving it to file links', () => {
    const mouse = clipboard()
    expect(mouse.contextMenu({ button: 0, shiftKey: false, ctrlKey: true })).toBe(false)
    expect(calls).toEqual([])
    expect(mouse.contextMenu({ ...right, ctrlKey: true })).toBe(true)
    expect(calls).toEqual(['paste'])
  })
})

describe('copyable text', () => {
  it('keeps inner blank lines and leading indentation', () => {
    expect(copyableText('a\n\n  b  \n \n')).toBe('a\n\n  b')
    expect(copyableText(' \n\n')).toBe('')
  })
})
