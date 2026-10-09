// MODULE: agents-rules-preferences.test.ts - Epic 60.5/60.6 markup: shapes and words carry meaning, every control is named
import type { RosterAgentShape, RulesSnapshot } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentSummary, DiffGroups } from './agents-preferences'
import { RulesHealth, diffCounts, probeLine } from './rules-preferences'

const noop = (): void => {}
const agent = (extra: Partial<RosterAgentShape> = {}): RosterAgentShape => ({
  id: 'luna', name: 'Luna', title: 'squire', harness: 'codex', model: 'gpt-6-luna', provider: 'openai', host: 'default',
  security: 'high', trust: 2, authority: 'read', enabled: true, status: 'active', efforts: ['max'], roles: ['helper'], ...extra
})
const summary = (extra: Partial<RosterAgentShape> = {}): string => renderToStaticMarkup(createElement(AgentSummary, {
  agent: agent(extra), open: false, onToggleOpen: noop, onEnabled: noop, onActivate: noop
}))

describe('an agent row (60.5 AC1)', () => {
  it('says title, security and trust by shape with names, and puts the switch beside them', () => {
    const markup = summary()
    expect(markup).toContain('aria-label="Squire"')
    expect(markup).toContain('aria-label="Security high"')
    expect(markup).toContain('aria-label="Trust 2 of 3"')
    expect(markup).toContain('<span class="agent-authority">read</span>')
    expect(markup).toContain('role="switch" class="switch" aria-checked="true" aria-label="Luna enabled"')
    expect(markup).toContain('aria-expanded="false" aria-controls="agent-luna-editor"')
    expect(markup).not.toMatch(/<select|<option/)
  })

  it('a Low agent shows the open seal; a proposed one offers Activate; a disabled one shows its note', () => {
    expect(summary({ security: 'low' })).toContain('aria-label="Security low"')
    expect(summary({ status: 'proposed' })).toContain('>Activate</button>')
    expect(summary({ status: 'proposed' })).not.toContain('role="switch"')
    expect(summary({ enabled: false, enabled_note: 'Quota spent' })).toContain('<span class="agent-note">Quota spent</span>')
  })
})

describe('the grouped diff (60.5 AC2)', () => {
  it('strikes the old value, inserts the new one and states each consequence as a sentence', () => {
    const markup = renderToStaticMarkup(createElement(DiffGroups, {
      groups: [{ key: 'roles', subject: 'Roles', lines: [{ field: 'epic-reviewer candidates', before: 'astra@medium', after: 'fable@medium' }],
        consequences: ['epic-reviewer would start with Fable instead of Astra'] }]
    }))
    expect(markup).toContain('<dt>epic-reviewer candidates</dt><dd><del>astra@medium</del>')
    expect(markup).toContain('<ins>fable@medium</ins>')
    expect(markup).toContain('<p class="diff-consequence">Epic-reviewer would start with Fable instead of Astra.</p>')
  })
})

describe('rules health (60.6 AC3, AC5)', () => {
  const snapshot = (stale: boolean): RulesSnapshot => ({
    masterPath: '/home/owner/.config/bmn/agents/global-rules.md',
    master: { exists: true, text: '# rules\n', hash: 'h', bytes: 8, errors: [] },
    renderings: [],
    health: { state: 'checked', checkedAt: '2026-10-09T10:00:00.000Z', ok: false, targets: [
      { harness: 'claude', path: '/h/.claude/CLAUDE.md', state: 'stale', restricted: false, reason: 'the approved team changed' },
      { harness: 'opencode', path: '/h/.config/opencode/AGENTS.md', state: 'current', restricted: true, reason: '' }
    ] },
    probes: [{ harness: 'claude', outcome: 'pass', at: '2026-10-08T10:00:00.000Z', stale }],
    transactions: [],
    history: []
  })

  it('shows state, restriction and the last probe with its date and staleness; Probe only on High routes', () => {
    const markup = renderToStaticMarkup(createElement(RulesHealth, { snapshot: snapshot(true), renderings: [], disabled: false, onProbe: noop }))
    expect(markup).toContain('Stale: install to update')
    expect(markup).toMatch(/Passed: the agent read these rules · [^<]+ · stale/)
    expect(markup).toContain('aria-label="Probe claude">Probe…')
    expect(markup).toMatch(/disabled="" title="Probes run only for High routes" aria-label="Probe opencode"/)
    expect(markup).toContain('<span>restricted</span>')
  })

  it('words every probe outcome', () => {
    expect(probeLine(undefined)).toBe('Never probed')
    for (const [outcome, word] of [['fail', 'Failed'], ['inconclusive', 'Inconclusive'], ['unavailable', 'Unavailable']] as const) {
      expect(probeLine({ harness: 'claude', outcome, at: '2026-10-08T10:00:00.000Z' })).toMatch(new RegExp(`^${word}`))
    }
  })

  it('counts a diff\'s added and removed lines without its headers', () => {
    expect(diffCounts('--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+more\n same')).toEqual({ added: 2, removed: 1 })
  })
})
