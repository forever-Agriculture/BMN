// MODULE: select-menu.test.ts - BMN's select (Story 80.4): the closed opener's markup, its disabled state, the keys that open it and type-ahead
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { typeAheadIndex } from './popup-menu'
import { SelectMenu, opensSelect, type SelectOption } from './select-menu'

const OPTIONS: ReadonlyArray<SelectOption> = [
  { value: '', label: 'Choose a session…' },
  { value: 'a', label: 'Personal › bash', description: 'Shell · /tmp/work' },
  { value: 'b', label: 'Personal › codex', description: 'Codex · /tmp/work' }
]
const opener = (props: Partial<Parameters<typeof SelectMenu>[0]> = {}): string => renderToStaticMarkup(createElement(SelectMenu, {
  value: 'a', options: OPTIONS, onChange: () => undefined, 'aria-label': 'Send to session', ...props
}))

describe('the opener (S1, S2)', () => {
  it('is a closed menu button showing the chosen value and a chevron, named by the field and the value', () => {
    const markup = opener()
    expect(markup).toMatch(/^<button type="button" class="select-opener" aria-haspopup="menu" aria-expanded="false" aria-labelledby="(\S+)name \1value" data-label="Send to session" data-value="a">/)
    expect(markup).toContain('<span id="')
    expect(markup).toContain('hidden="">Send to session</span>')
    expect(markup).toContain('class="select-value">Personal › bash</span>')
    expect(markup).toContain('<svg class="select-chevron" aria-hidden="true"')
    expect(markup).not.toContain('<select')
    expect(markup).not.toContain('role="menu"')
  })

  it('marks the empty value so it shows muted', () => {
    expect(opener({ value: '' })).toContain('data-value="" data-empty="true"')
    expect(opener({ value: 'b' })).not.toContain('data-empty')
  })

  it('takes a visible label by id instead of a name of its own', () => {
    const markup = opener({ 'aria-label': undefined, 'aria-labelledby': 'notify-label', id: 'notify' })
    expect(markup).toMatch(/id="notify" class="select-opener" aria-haspopup="menu" aria-expanded="false" aria-labelledby="notify-label \S+value"/)
    expect(markup).not.toContain('hidden=""')
  })

  it('is disabled when its dialog is busy, so it can be neither focused nor opened (AC3)', () => {
    expect(opener({ disabled: true })).toMatch(/^<button [^>]*disabled=""/)
    expect(opener({ disabled: false })).not.toContain('disabled')
  })
})

describe('the keys (S3)', () => {
  it('Enter, Space, ArrowDown and ArrowUp open a closed select; other keys do not', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) expect(opensSelect(key)).toBe(true)
    for (const key of ['Tab', 'Escape', 'a', 'Home', 'End', 'ArrowLeft']) expect(opensSelect(key)).toBe(false)
  })

  it('type-ahead jumps to the next row starting with the typed letters, cycling on a repeated letter', () => {
    const labels = ['Detect automatically', 'English', 'Українська', 'Русский', 'Polski', 'Deutsch', 'Français', 'Español', 'Italiano', 'Português']
    expect(typeAheadIndex(labels, 1, 'p')).toBe(4)
    expect(typeAheadIndex(labels, 4, 'p')).toBe(9)
    expect(typeAheadIndex(labels, 9, 'p')).toBe(4)
    expect(typeAheadIndex(labels, 4, 'pp')).toBe(9)
    expect(typeAheadIndex(labels, 4, 'po')).toBe(4)
    expect(typeAheadIndex(labels, 4, 'por')).toBe(9)
    expect(typeAheadIndex(labels, 0, 'D')).toBe(5)
    expect(typeAheadIndex(labels, -1, 'd')).toBe(0)
    // The only row starting with the letter stays highlighted.
    expect(typeAheadIndex(labels, 2, 'у')).toBe(2)
    expect(typeAheadIndex(labels, 0, 'x')).toBe(-1)
    expect(typeAheadIndex([], -1, 'a')).toBe(-1)
  })
})
