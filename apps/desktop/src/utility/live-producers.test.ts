import { describe, expect, it } from 'vitest'
import { LiveProducers } from './live-producers'
import type { AttentionRecord } from '@bmn/protocol'

describe('live foreground producer ownership', () => {
  it('does not replace B with a destructive old A event; returning A has a fresh generation', () => {
    const live = new Map([['s', 'run']])
    const owners = new LiveProducers(id => live.get(id))
    const a = { agentCli: 'codex' as const, conversationReference: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
    const b = { ...a, conversationReference: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
    const oldA = owners.observe('s', 'run', a)!
    const currentB = owners.observe('s', 'run', b)!
    const record = { sessionId: 's', incarnationId: 'run', producer: currentB } as AttentionRecord
    expect(owners.canClose(record, a)).toBe(false)
    expect(owners.current(record)).toBe(true)
    expect(owners.stamp('s', 'run')).toEqual(currentB)
    expect(owners.observe('s', 'run', a)!.generation).not.toBe(oldA.generation)
    expect(owners.current(record)).toBe(false)
    live.delete('s')
    expect(owners.stamp('s', 'run')).toBeNull()
  })

  it('retains legacy native compatibility until evidence of a switch or ambiguous destruction', () => {
    const owners = new LiveProducers(() => 'run')
    const record = { sessionId: 's', incarnationId: 'run' } as AttentionRecord
    expect(owners.current(record)).toBe(true)
    expect(owners.current(record, false)).toBe(false)
    const producer = { agentCli: 'claude' as const, conversationReference: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
    const binding = owners.observe('s', 'run', producer)!
    expect(owners.current(record)).toBe(false)
    const bound = { ...record, producer: binding }
    expect(owners.canClose(bound, undefined)).toBe(false)
    expect(owners.current(bound)).toBe(false)
    expect(owners.observe('s', 'run', producer)!.generation).not.toBe(binding.generation)
  })
})


it('retains a reused-ID request after ambiguous destruction without revival, while first activation cleanup is allowed', () => {
  const owners = new LiveProducers(() => 'run')
  const a = { agentCli: 'codex' as const, conversationReference: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
  const b = { ...a, conversationReference: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
  const first = { sessionId: 's', incarnationId: 'run', producer: owners.observe('s', 'run', a) } as AttentionRecord
  expect(owners.canClose(first, a)).toBe(true)
  owners.observe('s', 'run', b)
  const returned = { ...first, producer: owners.observe('s', 'run', a) }
  expect(owners.canClose(returned, a)).toBe(false)
  expect(owners.current(returned)).toBe(false)
  owners.observe('s', 'run', a)
  expect(owners.current(returned)).toBe(false)
  // A new, exactly correlated native tool can be retired without attributing a lifecycle event.
  expect(owners.canClose(returned, a, true)).toBe(true)
})

it('keeps bounded sticky ambiguity after identity history overflows and resets only at PTY replacement', () => {
  let incarnation = 'run'
  const owners = new LiveProducers(() => incarnation)
  for (let index = 0; index < 66; index++) owners.observe('s', 'run', {
    agentCli: 'codex', conversationReference: `${index.toString(16).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
  })
  const producer = { agentCli: 'codex' as const, conversationReference: 'ffffffff-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
  const record = { sessionId: 's', incarnationId: 'run', producer: owners.observe('s', 'run', producer) } as AttentionRecord
  expect(owners.canClose(record, producer)).toBe(false)
  incarnation = 'new-run'
  const next = { ...record, incarnationId: incarnation, producer: owners.observe('s', incarnation, producer) }
  expect(owners.canClose(next, producer)).toBe(true)
  owners.ended('s', producer)
  expect(owners.current(next)).toBe(false)
})


it('does not forget a known destructive identity that arrived before its first foreground observation', () => {
  const owners = new LiveProducers(() => 'run')
  const a = { agentCli: 'codex' as const, conversationReference: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
  const unknown = { sessionId: 's', incarnationId: 'run', producer: null } as AttentionRecord
  expect(owners.canClose(unknown, a, false, true)).toBe(false)
  const later = { ...unknown, producer: owners.observe('s', 'run', a) }
  expect(owners.canClose(later, a, false, true)).toBe(false)
})

it('remembers an old unobserved end without disabling B or restoring its authority when A returns', () => {
  const owners = new LiveProducers(() => 'run')
  const a = { agentCli: 'codex' as const, conversationReference: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
  const b = { ...a, conversationReference: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
  const current = { sessionId: 's', incarnationId: 'run', producer: owners.observe('s', 'run', b) } as AttentionRecord
  expect(owners.canClose(current, a, false, true)).toBe(false)
  expect(owners.current(current)).toBe(true)
  const returned = { ...current, producer: owners.observe('s', 'run', a) }
  expect(owners.canClose(returned, a, false, true)).toBe(false)
})
