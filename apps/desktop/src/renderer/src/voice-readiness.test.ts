// MODULE: voice-readiness.test.ts - Speak records with the chosen model, or with a downloaded one when the chosen model is missing
import { describe, expect, it } from 'vitest'
import type { VoiceModelId, VoiceModelStatus, VoiceStatus } from '@ai-terminal/protocol'
import { voiceReadiness, type VoiceReadiness } from './voice-readiness'

const status = (installed: VoiceModelId[], change: Partial<VoiceStatus> = {}, download: Partial<Record<VoiceModelId, VoiceModelStatus['download']>> = {}): VoiceStatus => ({
  engineAvailable: true,
  modelFolder: { path: '/data/voice/models', custom: false, available: true },
  models: (['base', 'small'] as const).map((id) => ({
    id,
    label: id === 'base' ? 'Base — faster' : 'Small — more accurate, about 3× slower',
    bytes: id === 'base' ? 147_951_465 : 487_601_967,
    installed: installed.includes(id),
    ...(download[id] ? { download: download[id] } : {})
  })),
  ...change
})

const summary = (readiness: VoiceReadiness): string =>
  readiness.kind === 'ready' ? `ready:${readiness.model.id}${readiness.replacesChoice ? ':replaces-choice' : ''}`
    : readiness.kind === 'downloading' ? `downloading:${readiness.model.id}`
      : readiness.kind

describe('voice readiness', () => {
  it('uses the downloaded model and makes it the choice when the chosen one was never downloaded', () => {
    expect(summary(voiceReadiness(status(['small']), 'base'))).toBe('ready:small:replaces-choice')
    expect(summary(voiceReadiness(status(['base']), 'small'))).toBe('ready:base:replaces-choice')
  })

  it('keeps the chosen model when it is installed', () => {
    expect(summary(voiceReadiness(status(['base', 'small']), 'small'))).toBe('ready:small')
    expect(summary(voiceReadiness(status(['base', 'small']), 'base'))).toBe('ready:base')
  })

  it('records with the installed model while the chosen one downloads, without replacing the choice', () => {
    expect(summary(voiceReadiness(status(['base'], {}, { small: { receivedBytes: 1_000 } }), 'small'))).toBe('ready:base')
    expect(summary(voiceReadiness(status(['base'], {}, { small: { receivedBytes: 1_000, error: 'HTTP 500' } }), 'small')))
      .toBe('ready:base:replaces-choice')
  })

  it('reports a download in progress when nothing is installed yet', () => {
    expect(summary(voiceReadiness(status([], {}, { small: { receivedBytes: 1_000 } }), 'small'))).toBe('downloading:small')
    expect(summary(voiceReadiness(status([], {}, { small: { receivedBytes: 1_000 } }), 'base'))).toBe('downloading:small')
    expect(summary(voiceReadiness(status([], {}, { small: { receivedBytes: 1_000, error: 'HTTP 500' } }), 'small'))).toBe('no-model')
  })

  it('reports why Speak cannot start', () => {
    expect(voiceReadiness(status([]), 'base')).toEqual({ kind: 'no-model' })
    expect(voiceReadiness(status(['small'], { engineAvailable: false }), 'small')).toEqual({ kind: 'engine-missing' })
    const unmounted = status(['small'], { modelFolder: { path: '/mnt/models', custom: true, available: false } })
    expect(voiceReadiness(unmounted, 'small')).toEqual({ kind: 'folder-unavailable', path: '/mnt/models' })
  })
})
