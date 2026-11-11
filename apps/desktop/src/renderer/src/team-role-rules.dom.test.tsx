// @vitest-environment jsdom
// MODULE: team-role-rules.dom.test.tsx - Epic 120: live staged role rules and the approved-version path
import type { AgentsSnapshot, RosterDataShape } from '@bmn/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TeamPreferences, type TeamPage } from './team-preferences'
import { toggleAgentRole } from './roster-staging'
import type { TeamState } from './team-state'

const data: RosterDataShape = {
  schema_version: 2,
  agents: [{ id: 'astra', name: 'Astra', class: 'bishop', harness: 'codex', model: 'synthetic', provider: 'openai', host: 'default', enabled: true, status: 'active', efforts: ['low', 'high'], roles: ['epic-reviewer'] }],
  roles: [{ id: 'epic-reviewer', candidates: ['astra@high'], then: 'blocked', small_work: 'astra@low', recheck: { same_reviewer: true, astra: 'low' } }],
  providers: [{ id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' }],
  exceptions: [], harness_routes: []
}
const snapshot: AgentsSnapshot = {
  rosterPath: '/synthetic/roster.md', home: '/synthetic',
  file: { exists: true, hash: 'f'.repeat(64), link: null, directory: '/synthetic', errors: [], warnings: [], data, prose: {} },
  approved: { generation: 1, createdAt: '2026-11-11T00:00:00.000Z', data }, approvalProblem: null, differences: [], consequences: [],
  history: [{ number: 1, valid: true, created_at: '2026-11-11T00:00:00.000Z' }]
}

it('redraws after a staged removal, and opens the original rules from the approved version (120.1)', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const generation = vi.fn(async () => ({ data }))
  vi.stubGlobal('aiTerminal', { agentsGeneration: generation })
  const noop = (): void => {}
  const later = async (): Promise<void> => {}
  const state: TeamState = {
    snapshot, loadError: null, base: data, data, approved: data, hasStaged: false, preview: null, outside: { groups: [], general: [] },
    changed: new Set(), busy: false, notice: null, confirmation: null, needsOwner: false, stage: noop, discard: noop, reload: later, setNotice: noop,
    requestApproval: later, approveProposals: later, commit: later, cancelConfirmation: noop, revert: later, saveNotes: later, pendingNotes: {}, setPendingNote: noop,
    undoRulesUpdate: later, rulesUndo: null, confirmRulesUndo: later, cancelRulesUndo: noop
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = (page: TeamPage): void => root.render(createElement(TeamPreferences, { team: state, page, go: noop }))
  try {
    await act(async () => render({ name: 'roles' }))
    expect(container.textContent).toContain('Small workAstralowRecheckthe same reviewer · Astra low')
    state.data = toggleAgentRole(data, 'astra', 'epic-reviewer')
    await act(async () => render({ name: 'roles' }))
    expect(container.textContent).not.toContain('Small work')
    expect(container.textContent).toContain('Recheckthe same reviewer')
    expect(container.textContent).not.toContain('Astra low')
    await act(async () => render({ name: 'changes' }))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View version 1"]')?.click())
    expect(generation).toHaveBeenCalledWith(1)
    expect(container.querySelector('.version-role')?.textContent).toContain('Small workAstralowRecheckthe same reviewer · Astra low')
    expect(container.querySelectorAll('.version-role .chain')).toHaveLength(3)
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals()
  }
})
