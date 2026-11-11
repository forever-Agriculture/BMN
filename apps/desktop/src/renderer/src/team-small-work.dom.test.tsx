// @vitest-environment jsdom
// MODULE: team-small-work.dom.test.tsx - Epic120.2: both editors change one shared small-review setting
import type { AgentsSnapshot, RosterDataShape } from '@bmn/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TeamPreferences } from './team-preferences'
import type { TeamState } from './team-state'

it.each(['Small epic reviewer', 'Epic reviewer'])('editing %s updates the shared Small work agent and effort', async (start) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const data: RosterDataShape = {
    schema_version: 3,
    agents: ['astra', 'sol'].map(id => ({ id, name: id === 'astra' ? 'Astra' : 'Sol', class: 'bishop', harness: 'codex', model: 'synthetic', provider: 'openai', host: 'default', enabled: true, status: 'active', efforts: ['low', 'high'], roles: id === 'astra' ? ['epic-reviewer', 'small-epic-reviewer'] : ['epic-reviewer'] })),
    roles: [
      { id: 'epic-reviewer', candidates: ['astra@high'], then: 'blocked', small_work: 'astra@low' },
      { id: 'small-epic-reviewer', candidates: ['astra@low'], then: 'blocked', read_only: true }
    ],
    providers: [{ id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' }], exceptions: [], harness_routes: []
  }
  const snapshot: AgentsSnapshot = {
    rosterPath: '/synthetic/roster.md', home: '/synthetic', file: { exists: true, hash: 'f'.repeat(64), link: null, directory: '/synthetic', errors: [], warnings: [], data, prose: {} },
    approved: { generation: 1, createdAt: '2026-11-12T00:00:00Z', data }, approvalProblem: null, differences: [], consequences: [], history: []
  }
  const noop = (): void => {}; const later = async (): Promise<void> => {}
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const state: TeamState = {
    snapshot, loadError: null, base: data, data, approved: data, hasStaged: false, preview: null, outside: { groups: [], general: [] }, changed: new Set(), busy: false, notice: null, confirmation: null, needsOwner: false,
    stage: next => { state.data = next; render() }, discard: noop, reload: later, setNotice: noop, requestApproval: later, approveProposals: later, commit: later, cancelConfirmation: noop, revert: later, saveNotes: later, pendingNotes: {}, setPendingNote: noop, undoRulesUpdate: later, rulesUndo: null, confirmRulesUndo: later, cancelRulesUndo: noop
  }
  const render = (): void => root.render(createElement(TeamPreferences, { team: state, page: { name: 'roles' }, go: noop }))
  const role = (name: string): Element => {
    const row = [...container.querySelectorAll('.role')].find(el => el.querySelector('b')?.textContent === name)
    expect(row, `role ${name}`).toBeTruthy(); return row as Element
  }
  const button = (label: string, within: Element = container): HTMLButtonElement => {
    const found = within.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    expect(found, label).toBeTruthy(); return found as HTMLButtonElement
  }
  try {
    await act(async () => render())
    await act(async () => button('Edit Epic reviewer').click())
    const link = [...role('Epic reviewer').querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === 'Use Small epic reviewer for Small work')
    expect(link, 'existing duplicate settings must be linked explicitly').toBeTruthy()
    await act(async () => link!.click())
    if (start === 'Small epic reviewer') await act(async () => button('Edit Small epic reviewer').click())
    const edit = start === 'Epic reviewer' ? role(start).querySelector('[aria-label="Small work"]')! : role(start)
    expect(edit, `selected editor ${start}`).toBeTruthy()
    await act(async () => button('Remove Astra from Small epic reviewer', edit).click())
    await act(async () => button('Add Sol to Small epic reviewer', edit).click())
    const choices = edit.querySelector('[aria-label="Sol efforts for Small epic reviewer"]')
    expect(choices).toBeTruthy()
    const low = [...choices!.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === 'low')
    expect(low).toBeTruthy(); low!.focus(); await act(async () => low!.click())
    expect(document.activeElement).toBe(low)
    const small = role('Small epic reviewer').querySelector('.list-line')?.textContent ?? ''
    const epic = role('Epic reviewer').querySelector('.list-line')?.textContent ?? ''
    expect(small).toContain('Sol'); expect(small).toContain('high')
    expect(epic.replace(/\s+/g, ' ')).toContain('Small workSollow or high')
    // The ordinary full-review order stays unchanged while the shared small-work setting changes.
    expect(state.data?.roles.find(entry => entry.id === 'epic-reviewer')?.candidates).toEqual(['astra@high'])
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
