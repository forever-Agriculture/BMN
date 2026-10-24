// MODULE: session-panes.test.ts - Story 91.2: each terminal row is a paint layer that makes no stacking context
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./session-panes.css', import.meta.url), 'utf8')

/** The declarations of the one rule written for `selector`, comments removed. */
function declarations(selector: string): Record<string, string> {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^}]*)\}/gu)]
    .filter(([, selectors]) => selectors.split(',').some((one) => one.trim() === selector))
  expect(rules).toHaveLength(1)
  return Object.fromEntries(rules[0]![2]!.split(';').map((one) => one.split(':').map((part) => part.trim())).filter(([name]) => name))
}

describe('terminal rows (Story 91.2)', () => {
  it('positions each row, so a frame repaints only the rows it changed', () => {
    expect(declarations('.terminal-surface .xterm-rows > div')).toEqual({ position: 'relative' })
  })

  it('gives a row nothing that makes a stacking context, which would hide selected text under the selection layer', () => {
    const row = declarations('.terminal-surface .xterm-rows > div')
    for (const name of ['z-index', 'contain', 'transform', 'will-change', 'opacity', 'isolation', 'filter']) expect(row).not.toHaveProperty(name)
  })
})
