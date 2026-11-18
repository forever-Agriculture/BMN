// @vitest-environment jsdom
// MODULE: grant-focus.dom.test.tsx - a newly opened permission list and its arrows cannot answer while the owner types
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BeforeYouGoDialog } from './before-you-go-dialog'
import { EMPTY_GRANT_RECORD, askGrant, newDepartureCollection, ownerGrantView, startDeparture, type GrantRecord } from '@bmn/protocol'
import { Dialog } from './dialog'
import { Segmented } from './history-preferences'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Before you go keyboard safety', () => {
  it('starts on a passive list and saves only when an option is explicitly activated', async () => {
    const save = vi.fn()
    await act(async () => root.render(createElement(Dialog, {
      label: 'Before you go', onClose: vi.fn(), initialFocus: '.grant-list',
      children: createElement('div', { className: 'grant-list', tabIndex: -1 },
        createElement('span', { id: 'grant-choice' }, 'Extra rounds'),
        createElement(Segmented, { labelledBy: 'grant-choice', options: [0, 2, 3, 4], value: 0,
          manualActivation: true, optionLabel: String, onChange: save }))
    })))
    expect(document.activeElement).toBe(container.querySelector('.grant-list'))
    for (const key of ['Enter', ' ', 'ArrowRight']) {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    }
    expect(save).not.toHaveBeenCalled()
    const buttons = container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons[0]!.focus()
    for (let index = 1; index <= 2; index++) {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
      expect(document.activeElement).toBe(buttons[index])
      expect(save).not.toHaveBeenCalled()
    }
    await act(async () => buttons[2]!.click())
    expect(save).toHaveBeenCalledExactlyOnceWith(3)
  })

  it('keeps focus on a temporarily unavailable choice and blocks its keys and click', async () => {
    const change = vi.fn()
    const render = async (unavailable: boolean) => act(async () => root.render(createElement(Segmented, {
      labelledBy: 'grant-choice', options: [0, 2], value: 0, manualActivation: true, optionLabel: String, onChange: change, unavailable
    })))
    await render(false)
    const choice = container.querySelector<HTMLButtonElement>('[role="radio"]')!
    choice.focus()
    await render(true)
    expect(document.activeElement).toBe(choice)
    expect(choice.getAttribute('aria-disabled')).toBe('true')
    await act(async () => {
      choice.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click()
    })
    expect(document.activeElement).toBe(choice)
    expect(change).not.toHaveBeenCalled()
    await render(false)
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click())
    expect(change).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('keeps immediate arrow selection for existing preferences', async () => {
    const save = vi.fn()
    await act(async () => root.render(createElement(Segmented, {
      labelledBy: 'existing', options: [0, 2], value: 0, optionLabel: String, onChange: save
    })))
    const first = container.querySelector<HTMLButtonElement>('[role="radio"]')!
    first.focus()
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(save).toHaveBeenCalledExactlyOnceWith(2)
  })
})


it('holds a revised card disabled under focus until Show, and saves only the new revision', async () => {
  const at = '2026-11-17T19:00:00.000Z'
  let record: GrantRecord = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'one', collection: newDepartureCollection([], at) }, 'back', at).record
  const ask = (title: string, proposed: 2 | 3) => {
    record = askGrant(record, { runId: 'run', sessionId: 's', agentCli: 'claude', card: { title, scope: 'Synthetic work', nothing: false, terms: [{ id: 'rounds', kind: 'rounds', proposed, reason: 'Synthetic check' }] } }, at).record
  }
  record.offers = [{ runId: 'run', title: 'Earlier', endedAt: '2026-11-17T18:30:00.000Z', answer: { cardRevision: 1, terms: [{ id: 'rounds', kind: 'rounds', proposed: 3, reason: 'Earlier synthetic check' }], choices: { rounds: 2 }, at: '2026-11-17T18:00:00.000Z', via: 'app', operationKey: 'prior' } }]
  const sameAgain = vi.fn()
  const save = vi.fn(async () => ({ outcome: 'granted' as const }))
  const listAction = vi.fn()
  const render = () => root.render(createElement(BeforeYouGoDialog, { grant: ownerGrantView({ state: 'read', record }), now: new Date(at), place: () => ({ workspace: 'Synthetic', session: 'Synthetic' }), sessionName: () => 'Synthetic', onAnswer: save, onAwayNow: vi.fn(), onNotLeaving: vi.fn(), onClose: vi.fn(), onListAction: listAction, onSameAgain: sameAgain }))
  ask('First', 2)
  await act(async () => render())
  expect(document.activeElement).toBe(container.querySelector('.grant-list'))
  ask('Revised', 3)
  await act(async () => render())
  expect(container.querySelector('h3')?.textContent).toBe('First')
  const old = container.querySelector<HTMLButtonElement>('[role="radio"]')!
  expect(old.disabled).toBe(true)
  const same = [...container.querySelectorAll('button')].find(button => button.textContent === 'Grant the same 1')!
  expect(same.disabled).toBe(true)
  await act(async () => same.click())
  expect(sameAgain).not.toHaveBeenCalled()
  await act(async () => old.click())
  expect(save).not.toHaveBeenCalled()
  const show = [...container.querySelectorAll('button')].find(button => button.textContent === 'Show')!
  await act(async () => show.click())
  expect(listAction).toHaveBeenCalledOnce()
  expect(container.querySelector('h3')?.textContent).toBe('Revised')
  expect(same.disabled).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('[role="radio"]')!.disabled).toBe(false)
  const yes = container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[2]!
  await act(async () => yes.click())
  expect(save).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ cardRevision: 2 }))
})

it('restores the answered control after the saving commit without waiting for a paint', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  const at = '2026-11-17T19:00:00.000Z'
  const started = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'focus', collection: newDepartureCollection([], at) }, 'back', at).record
  const record = askGrant(started, { runId: 'focus', sessionId: 's', agentCli: 'claude', card: { title: 'Focus', scope: 'Synthetic focus check', nothing: false, terms: [{ id: 'rounds', kind: 'rounds', proposed: 3, reason: 'Synthetic check' }] } }, at).record
  let finish!: () => void
  const answer = new Promise<{ outcome: 'granted' }>(resolve => { finish = () => resolve({ outcome: 'granted' }) })
  await act(async () => root.render(createElement(BeforeYouGoDialog, { grant: ownerGrantView({ state: 'read', record }), now: new Date(at), place: () => ({ workspace: 'Synthetic', session: 'Synthetic' }), sessionName: () => 'Synthetic', onAnswer: () => answer, onAwayNow: vi.fn(), onNotLeaving: vi.fn(), onClose: vi.fn() })))
  const button = container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[2]!
  button.focus()
  await act(async () => button.click())
  expect(button.disabled).toBe(true)
  button.blur()
  expect(document.activeElement).toBe(document.body)
  await act(async () => finish())
  expect(button.disabled).toBe(false)
  expect(document.activeElement).toBe(button)
})

it('reports presentation only after the passive dialog is open and never as owner activity', async () => {
  const at = '2026-11-17T19:00:00.000Z'
  let record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'presented', collection: newDepartureCollection([], at) }, 'back', at).record
  const activity = vi.fn()
  const presented = vi.fn(() => {
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(document.activeElement).toBe(container.querySelector('.grant-list'))
  })
  const render = () => root.render(createElement(BeforeYouGoDialog, { grant: ownerGrantView({ state: 'read', record }), now: new Date(at), place: () => ({ workspace: 'Synthetic', session: 'Synthetic' }), sessionName: () => 'Synthetic', onAnswer: vi.fn(), onAwayNow: vi.fn(), onNotLeaving: vi.fn(), onClose: vi.fn(), onListAction: activity, onPresented: presented }))
  await act(async () => render())
  await act(async () => render())
  expect(presented).toHaveBeenCalledOnce()
  record = { ...record, revision: record.revision + 1 }
  await act(async () => render())
  expect(presented).toHaveBeenCalledOnce()
  record = { ...record, revision: record.revision + 1, periods: record.periods.map(period => ({ ...period, collection: { ...period.collection!, openedAt: at, presentedAt: at } })) }
  await act(async () => render())
  expect(presented).toHaveBeenCalledOnce()
  expect(activity).not.toHaveBeenCalled()
})
