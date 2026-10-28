// @vitest-environment jsdom
// MODULE: voice-approval.dom.test.tsx - the real vocabulary self-test must await persisted approvals
import { DEFAULT_APP_SETTINGS, type AppSettings, type VoiceSettings, type VoiceStatus } from '@bmn/protocol'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoicePreferences } from '../voice-preferences'
import { createVoiceSettingsWriter } from '../voice-settings-writer'
import { approveSuggestedVoiceWords, approveWordVia, removeWordVia } from './voice-self-test'

let root: Root | undefined
let container: HTMLDivElement | undefined
let bridge: PropertyDescriptor | undefined

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(0)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  bridge = Object.getOwnPropertyDescriptor(window, 'aiTerminal')
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  container = undefined
  if (bridge) Object.defineProperty(window, 'aiTerminal', bridge)
  else Reflect.deleteProperty(window, 'aiTerminal')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

type SaveMode = 'resolve' | 'reject' | 'unresolved'

async function approvalFixture(
  mode: SaveMode | SaveMode[] = 'resolve',
  sequence: (dialog: HTMLDialogElement) => Promise<string[]> = approveSuggestedVoiceWords
) {
  let current: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    voice: { ...DEFAULT_APP_SETTINGS.voice, vocabulary: [] }
  }
  let persisted: VoiceSettings = current.voice
  let publish: (voice: VoiceSettings) => void = () => undefined
  const writes: VoiceSettings[] = []
  const clicks: Array<{ word: string; disabled: boolean; connected: boolean; at: number }> = []
  const writer = createVoiceSettingsWriter({
    current: () => current,
    put: (voice) => {
      writes.push(voice)
      const saveMode = Array.isArray(mode) ? mode[writes.length - 1] ?? 'resolve' : mode
      return new Promise<AppSettings>((resolve, reject) => {
        if (saveMode === 'unresolved') return
        setTimeout(() => {
          if (saveMode === 'reject') reject(new Error('Synthetic save refused'))
          else {
            persisted = voice
            resolve({ ...current, voice })
          }
        }, 100)
      })
    },
    saved: (settings) => {
      current = settings
      publish(settings.voice)
    }
  })
  const status: VoiceStatus = {
    engineAvailable: true,
    modelFolder: { path: '/synthetic/models', custom: false, available: true },
    models: [{ id: 'base', label: 'Base', bytes: 1, installed: false }]
  }
  Object.defineProperty(window, 'aiTerminal', {
    configurable: true,
    value: {
      getVoiceStatus: async () => status,
      getSettings: async () => structuredClone(current)
    }
  })
  function Harness() {
    const [voice, setVoice] = useState(current.voice)
    publish = setVoice
    return createElement('dialog', { open: true }, createElement(VoicePreferences, {
      settings: voice,
      save: writer.update,
      suggest: () => ({ ok: true as const, words: ['SessionManager', 'pty_host'] })
    }))
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(Harness)))
  const dialog = container.querySelector('dialog')!
  const nativeClick = HTMLButtonElement.prototype.click
  vi.spyOn(HTMLButtonElement.prototype, 'click').mockImplementation(function (this: HTMLButtonElement) {
    if (this.textContent?.trim() === 'Approve') {
      clicks.push({
        word: this.parentElement?.querySelector<HTMLInputElement>('input')?.value ?? '',
        disabled: this.disabled,
        connected: this.isConnected,
        at: Date.now()
      })
    }
    return Reflect.apply(nativeClick, this, [])
  })
  let outcome: { value: string[] } | { error: string } | null = null
  await act(async () => {
    void sequence(dialog).then(
      (value) => { outcome = { value } },
      (error: unknown) => { outcome = { error: String(error) } }
    )
  })
  // Each polling turn renders before the next one; both revisions use the same save schedule.
  for (let elapsed = 0; elapsed <= 9_000 && outcome === null; elapsed += 25) {
    await act(async () => { await vi.advanceTimersByTimeAsync(25) })
  }
  return {
    outcome,
    clicks,
    writes: writes.map((voice) => voice.vocabulary),
    persisted: persisted.vocabulary,
    rendered: [...dialog.querySelectorAll('.voice-vocabulary-list code')].map((word) => word.textContent),
    error: dialog.querySelector('.preferences-error')?.textContent
  }
}

describe('Voice self-test approval synchronization', () => {
  it('persists both suggested approvals when the first save outlives optimistic rendering', async () => {
    const result = await approvalFixture()
    const proof = JSON.stringify(result)
    expect(result.persisted, proof).toEqual(['pty-host', 'SessionManager'])
    expect(result.outcome, proof).toEqual({ value: ['SessionManager', 'pty_host'] })
    expect(result.writes, proof).toEqual([['pty-host'], ['pty-host', 'SessionManager']])
    expect(result.clicks.every((click) => click.connected && !click.disabled), proof).toBe(true)
    expect(result.rendered, proof).toEqual(result.persisted)
  })

  it('waits for draft approvals before the next edit and settings read', async () => {
    const result = await approvalFixture('resolve', async (dialog) => {
      await approveWordVia(dialog, 'BMN')
      await approveWordVia(dialog, 'Changed')
      return (await window.aiTerminal.getSettings()).voice.vocabulary
    })
    const proof = JSON.stringify(result)
    expect(result.persisted, proof).toEqual(['BMN', 'Changed'])
    expect(result.outcome, proof).toEqual({ value: ['BMN', 'Changed'] })
    expect(result.writes, proof).toEqual([['BMN'], ['BMN', 'Changed']])
    expect(result.rendered, proof).toEqual(result.persisted)
  })

  it('waits for removal persistence before reading settings or choosing a model', async () => {
    const result = await approvalFixture('resolve', async (dialog) => {
      await approveSuggestedVoiceWords(dialog)
      await removeWordVia(dialog, 'pty-host')
      return (await window.aiTerminal.getSettings()).voice.vocabulary
    })
    const proof = JSON.stringify(result)
    expect(result.persisted, proof).toEqual(['SessionManager'])
    expect(result.outcome, proof).toEqual({ value: ['SessionManager'] })
    expect(result.writes, proof).toEqual([['pty-host'], ['pty-host', 'SessionManager'], ['SessionManager']])
    expect(result.rendered, proof).toEqual(result.persisted)
  })

  it.each(['reject', 'unresolved'] as const)('does not report a %s suggested-word save as approved', async (mode) => {
    const result = await approvalFixture(mode)
    const proof = JSON.stringify(result)
    expect(result.outcome, proof).toHaveProperty('error')
    expect(result.persisted, proof).toEqual([])
    expect(result.writes, proof).toHaveLength(1)
    expect(result.clicks, proof).toHaveLength(1)
  })

  it.each(['reject', 'unresolved'] as const)('does not report a %s draft save as approved', async (mode) => {
    const result = await approvalFixture(mode, async (dialog) => {
      await approveWordVia(dialog, 'BMN')
      return (await window.aiTerminal.getSettings()).voice.vocabulary
    })
    const proof = JSON.stringify(result)
    expect(result.outcome, proof).toHaveProperty('error')
    expect(result.persisted, proof).toEqual([])
    expect(result.writes, proof).toHaveLength(1)
  })

  it.each(['reject', 'unresolved'] as const)('does not report a %s removal as persisted', async (mode) => {
    const result = await approvalFixture(['resolve', 'resolve', mode], async (dialog) => {
      await approveSuggestedVoiceWords(dialog)
      await removeWordVia(dialog, 'pty-host')
      return (await window.aiTerminal.getSettings()).voice.vocabulary
    })
    const proof = JSON.stringify(result)
    expect(result.outcome, proof).toHaveProperty('error')
    expect(result.persisted, proof).toEqual(['pty-host', 'SessionManager'])
    expect(result.writes, proof).toHaveLength(3)
  })
})
