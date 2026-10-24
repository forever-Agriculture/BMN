// MODULE: terminal-rows-css.test.mjs - Story 91.2: each terminal row is a paint layer that makes no stacking context
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../apps/desktop/src/renderer/src/styles/session-panes.css', import.meta.url), 'utf8')

/** The declarations of the one rule written for `selector`, comments removed. */
function declarations(selector) {
  const bodies = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^}]*)\}/gu)]
    .filter(([, selectors]) => selectors.split(',').some((one) => one.trim() === selector))
    .map(([, , body]) => body)
  expect(bodies).toHaveLength(1)
  return Object.fromEntries(bodies[0].split(';').map((one) => one.split(':').map((part) => part.trim())).filter(([name]) => name))
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
