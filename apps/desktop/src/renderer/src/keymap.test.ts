// MODULE: keymap.test.ts - app shortcut resolution and terminal key passthrough
import { describe, expect, it } from 'vitest'
import { isModifierOnly, resolveShortcut, type ShortcutEvent } from './keymap'

const key = (partial: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: '',
  code: '',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...partial
})

describe('app keymap', () => {
  it('maps the Ctrl+Shift chords by physical key', () => {
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'ArrowRight', key: 'ArrowRight' }))).toBe('workspace-next')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'ArrowUp', key: 'ArrowUp' }))).toBe('session-previous')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyU', key: 'U' }))).toBe('attention-next')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyP', key: 'P' }))).toBe('palette')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyC', key: 'C' }))).toBe('copy')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyV', key: 'V' }))).toBe('paste')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyF', key: 'F' }))).toBe('search')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'Enter', key: 'Enter' }))).toBe('split-toggle')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyZ', key: 'Z' }))).toBe('focus-toggle')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'Backslash', key: '|' }))).toBe('send-next-key')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'Space', key: ' ' }))).toBe('voice-toggle')
  })

  it('works on a Cyrillic layout because chords use the physical key', () => {
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyC', key: 'С' }))).toBe('copy')
  })

  it('maps font size chords', () => {
    expect(resolveShortcut(key({ ctrlKey: true, key: '=', code: 'Equal' }))).toBe('font-increase')
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, key: '+', code: 'Equal' }))).toBe('font-increase')
    expect(resolveShortcut(key({ ctrlKey: true, key: '-', code: 'Minus' }))).toBe('font-decrease')
    expect(resolveShortcut(key({ ctrlKey: true, key: '0', code: 'Digit0' }))).toBe('font-reset')
  })

  it('leaves terminal keys to the process', () => {
    for (const code of ['KeyC', 'KeyD', 'KeyL', 'KeyR', 'KeyZ', 'KeyO', 'KeyV']) {
      expect(resolveShortcut(key({ ctrlKey: true, code, key: code.slice(3).toLowerCase() }))).toBeNull()
    }
    expect(resolveShortcut(key({ altKey: true, ctrlKey: true, shiftKey: true, code: 'KeyC', key: 'C' }))).toBeNull()
    expect(resolveShortcut(key({ key: 'Escape', code: 'Escape' }))).toBeNull()
    expect(resolveShortcut(key({ shiftKey: true, key: 'Tab', code: 'Tab' }))).toBeNull()
    expect(resolveShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyA', key: 'A' }))).toBeNull()
  })

  it('recognizes modifier-only presses', () => {
    expect(isModifierOnly({ key: 'Shift' })).toBe(true)
    expect(isModifierOnly({ key: 'a' })).toBe(false)
  })
})
