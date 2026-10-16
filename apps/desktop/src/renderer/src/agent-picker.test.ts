import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentPicker } from './agent-picker'

describe('the four launch choices', () => {
  it('shows each hint as card text, none disabled, the picked one in the tab order', () => {
    const html = renderToStaticMarkup(createElement(AgentPicker, {
      options: [
        { id: 'terminal', label: 'Terminal', hint: 'bash' },
        { id: 'codex', label: 'Codex', hint: 'codex' }
      ],
      selectedId: 'codex',
      onPick: () => {}
    }))
    expect(html).toContain('class="agent-hint">codex</span>')
    expect(html).not.toContain('disabled=""')
    expect(html).toMatch(/data-option="codex" aria-checked="true"[^>]*tabindex="0"/u)
    expect(html).toMatch(/data-option="terminal" aria-checked="false"[^>]*tabindex="-1"/u)
  })
})
