import type { ArtifactRecord } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { handoffArtifactChoices } from './files-panel'

function artifact(artifactId: string, state: ArtifactRecord['state']): ArtifactRecord {
  return {
    artifactId,
    sessionId: 'source',
    incarnationId: null,
    direction: 'output',
    source: 'agent',
    originalName: `${artifactId}.txt`,
    mediaType: 'text/plain',
    byteLength: 1,
    sha256: 'a'.repeat(64),
    storedPath: `/stored/${artifactId}`,
    sourcePath: null,
    state,
    createdAt: '2026-09-19T00:00:00.000Z'
  }
}

describe('handoff artifact choices', () => {
  it('keeps selected unavailable and absent originals removable', () => {
    const choices = handoffArtifactChoices(
      [artifact('ready', 'ready'), artifact('corrupt', 'corrupt')],
      new Set(['corrupt', 'removed'])
    )

    expect(choices).toEqual([
      expect.objectContaining({ artifactId: 'ready', selected: false, disabled: false }),
      expect.objectContaining({ artifactId: 'corrupt', selected: true, disabled: false }),
      { artifactId: 'removed', artifact: null, selected: true, disabled: false }
    ])
  })

  it('blocks adding unavailable originals or an eleventh file', () => {
    const full = new Set(Array.from({ length: 10 }, (_value, index) => `selected-${index}`))
    expect(handoffArtifactChoices([artifact('missing', 'missing')], new Set())[0]?.disabled).toBe(true)
    expect(handoffArtifactChoices([artifact('ready', 'ready')], full)[0]?.disabled).toBe(true)
  })
})
