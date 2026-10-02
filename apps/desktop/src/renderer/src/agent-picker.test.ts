import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentPicker } from './agent-picker'

describe('unavailable launch choices', () => {
  it('shows the reason as readable card text without requiring hover or focus', () => {
    const reason = 'Stored arguments are invalid. Recreate this template.'
    const html = renderToStaticMarkup(createElement(AgentPicker, {
      options: [{ id: 'template:broken', label: 'Review', hint: 'codex', disabledReason: reason }],
      selectedId: null,
      onPick: () => {}
    }))
    expect(html).toContain(`class="agent-hint">${reason}</span>`)
    expect(html).toContain('disabled=""')
  })
})
