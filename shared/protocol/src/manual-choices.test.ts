import { describe, expect, it } from 'vitest'
import { parseManualChoices, readStoredManualChoices } from './manual-choices'
import { parseAttentionProducer, readStoredProducer } from './attention-producer'

describe('bounded manual data and live producer identity', () => {
  const valid = { options: [{ label: 'Proceed', description: null }, { label: 'Wait', description: '' }] }
  it('adds Other only as a host normalization; old/malformed records remain null', () => {
    expect(parseManualChoices(valid)).toEqual({ ...valid, allowOther: true })
    expect(parseManualChoices({ ...valid, allowOther: true })).toBeNull()
    expect(readStoredManualChoices(JSON.stringify({ ...valid, allowOther: true }))).toEqual({ ...valid, allowOther: true })
    expect(readStoredManualChoices(null)).toBeNull(); expect(readStoredManualChoices('{')).toBeNull()
  })
  it.each([
    { options: [] }, { options: [valid.options[0]] },
    { options: Array.from({ length: 9 }, (_, index) => ({ label: String(index), description: null })) },
    { options: [valid.options[0], valid.options[0]] },
    { options: [{ label: '\u202eProceed', description: null }, valid.options[1]] },
    { options: [{ label: 'P'.repeat(201), description: null }, valid.options[1]] },
    { options: [{ label: 'Proceed', description: 'D'.repeat(501) }, valid.options[1]] },
    { options: [{ label: 'Proceed', description: null, extra: true }, valid.options[1]] }
  ])('refuses malformed options %j', value => expect(parseManualChoices(value)).toBeNull())
  it('validates identities and host-only generations with closed shapes', () => {
    const value = { agentCli: 'codex', conversationReference: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }
    expect(parseAttentionProducer(value)?.conversationReference).toBe(value.conversationReference.toLowerCase())
    expect(parseAttentionProducer({ ...value, generation: 'forged' })).toBeNull()
    expect(parseAttentionProducer({ ...value, agentCli: 'shell' })).toBeNull()
    expect(readStoredProducer(JSON.stringify({ ...value, generation: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }))).not.toBeNull()
    expect(readStoredProducer(JSON.stringify({ ...value, generation: 'bad' }))).toBeNull()
  })
})


it.each(['\u00ad', '\u061c', '\u2060'])('full review refuses format-bearing manual labels before creating a card %s', character => {
  expect(parseManualChoices({ options: [{ label: `Pro${character}ceed`, description: null }, { label: 'Wait', description: null }] })).toBeNull()
})
