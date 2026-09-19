import { DEFAULT_APP_SETTINGS, type AppSettings, type VoiceSettings } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { createVoiceSettingsWriter } from './voice-settings-writer'

/** A settings store whose saves resolve only when the test releases them, in order. */
function harness(initial: VoiceSettings) {
  let settings: AppSettings = { ...DEFAULT_APP_SETTINGS, voice: initial }
  let stored: VoiceSettings = initial
  const sent: VoiceSettings[] = []
  const pending: Array<{ resolve(): void; reject(error: Error): void }> = []
  const writer = createVoiceSettingsWriter({
    current: () => settings,
    put: (voice) => {
      sent.push(voice)
      return new Promise<AppSettings>((resolve, reject) => {
        pending.push({
          resolve: () => {
            stored = voice
            resolve({ ...settings, voice })
          },
          reject
        })
      })
    },
    saved: (next) => {
      settings = next
    }
  })
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  }
  return { writer, sent, pending, settle, stored: () => stored, current: () => settings.voice }
}

const base: VoiceSettings = { model: 'small', language: 'uk', modelFolder: null, holdSpaceToTalk: true, vocabulary: [] }

describe('voice settings writer', () => {
  it('builds a vocabulary save after a pending model fallback from the fallback result, so both persist', async () => {
    const store = harness(base)
    const fallback = store.writer.update((current) => ({ ...current, model: 'base' }))
    const approval = store.writer.update((current) => ({ ...current, vocabulary: [...current.vocabulary, 'BMN'] }))
    await store.settle()
    // Only the fallback is on the wire until it settles.
    expect(store.sent).toHaveLength(1)
    store.pending[0]!.resolve()
    await fallback
    await store.settle()
    expect(store.sent[1]).toEqual({ ...base, model: 'base', vocabulary: ['BMN'] })
    store.pending[1]!.resolve()
    await approval
    expect(store.stored()).toEqual({ ...base, model: 'base', vocabulary: ['BMN'] })
    expect(store.current()).toEqual(store.stored())
  })

  it('keeps a pending vocabulary save when a fallback is queued behind it', async () => {
    const store = harness({ ...base, vocabulary: ['BMN'] })
    const approval = store.writer.update((current) => ({ ...current, vocabulary: [...current.vocabulary, 'dev-auto'] }))
    const fallback = store.writer.update((current) => ({ ...current, model: 'base' }))
    await store.settle()
    store.pending[0]!.resolve()
    await approval
    await store.settle()
    store.pending[1]!.resolve()
    await fallback
    expect(store.stored()).toEqual({ ...base, model: 'base', vocabulary: ['BMN', 'dev-auto'] })
  })

  it('lets a later save run after a refused one, built from the settings the refusal left unchanged', async () => {
    const store = harness(base)
    const refused = store.writer.update((current) => ({ ...current, language: 'en' }))
    const next = store.writer.update((current) => ({ ...current, vocabulary: ['BMN'] }))
    await store.settle()
    store.pending[0]!.reject(new Error('The database is busy'))
    await expect(refused).rejects.toThrow('The database is busy')
    await store.settle()
    expect(store.sent[1]).toEqual({ ...base, vocabulary: ['BMN'] })
    store.pending[1]!.resolve()
    await next
    expect(store.stored()).toEqual({ ...base, vocabulary: ['BMN'] })
  })

  it('refuses without sending when the change throws, and keeps the queue moving', async () => {
    const store = harness(base)
    const refused = store.writer.update(() => {
      throw new Error('That word is already in the list.')
    })
    await expect(refused).rejects.toThrow('already in the list')
    const next = store.writer.update((current) => ({ ...current, holdSpaceToTalk: false }))
    await store.settle()
    expect(store.sent).toEqual([{ ...base, holdSpaceToTalk: false }])
    store.pending[0]!.resolve()
    await expect(next).resolves.toMatchObject({ voice: { holdSpaceToTalk: false } })
  })
})
