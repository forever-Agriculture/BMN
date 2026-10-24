// MODULE: doctor-continuity.test.ts - Typed private commitments and immutable profile/attempt/result-bound receipts
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { deriveContinuityKeys, matchContinuity, privateTag, sealContinuity, validateContinuity } from '../../bin/doctor-continuity.mjs'
import type { ProjectedDoctorResult } from '../../bin/doctor-results.mjs'
const profileKey = 'a'.repeat(64), binding = { profileBinding: 'b'.repeat(64), attemptId: randomUUID() }
const keys = deriveContinuityKeys(profileKey, binding)
const result: ProjectedDoctorResult = { state: 'passed', problems: [], leftovers: [{ kind: 'memory', app: 'codex', reason: 'unused-memory', item: 1, identity: 'withheld', locator: { status: 'unresolved' } }] }
const receipt = { item: 1, itemTag: privateTag(keys.item, 'item', ['ordinary', 'sk-SYNTHETIC-private', 1n]), contextTag: privateTag(keys.context, 'reason', { absent: true }) }

it('encodes typed values deterministically without collapsing text, blobs, null, floats or SQLite integers', () => {
  const tag = (value: unknown): string => privateTag(keys.item, 'item', value)
  expect(tag({ z: [null, 1n], a: 'ordinary' })).toBe(tag({ a: 'ordinary', z: [null, 1n] }))
  expect(tag(1n)).not.toBe(tag(1))
  expect(new Set([null, '', 0, -0, 1, '1', Buffer.from('1'), true, 1.5, 9007199254740993n].map(tag)).size).toBe(10)
  const cycle: unknown[] = []; cycle.push(cycle)
  expect(() => tag(cycle)).toThrow('continuity unavailable')
  expect(() => tag(undefined)).toThrow()
  expect(() => tag(Number.NaN)).toThrow()
})

it('binds receipts to profile, attempt, scanner, public result and every private row field', () => {
  const sealed = sealContinuity([receipt], result, binding, keys.envelope)
  expect(validateContinuity(JSON.parse(JSON.stringify(sealed)), result, binding, keys.envelope)).toEqual(sealed)
  for (const mutation of [
    { ...sealed, attemptId: randomUUID() }, { ...sealed, profileBinding: 'c'.repeat(64) }, { ...sealed, scannerId: 'old-scanner' },
    { ...sealed, rows: [{ ...receipt, contextTag: 'd'.repeat(64) }] }, { ...sealed, rows: [receipt, receipt] },
    { ...sealed, rawSource: 'sk-SYNTHETIC-private' }
  ]) expect(validateContinuity(mutation, result, binding, keys.envelope)).toBeNull()
  expect(validateContinuity(sealed, { ...result, state: 'partial' }, binding, keys.envelope)).toBeNull()
  expect(validateContinuity(sealed, result, binding, 'f'.repeat(64))).toBeNull()
  expect(JSON.stringify(sealed)).not.toMatch(/ordinary|SYNTHETIC|private/)
})

it('matches exactly one fresh item/context without replacing original identity evidence', () => {
  const original = structuredClone([receipt]), before = JSON.stringify(original)
  expect(matchContinuity(original, [{ ...receipt, item: 7 }])).toEqual([{ item: 1, current: 7 }])
  expect(matchContinuity(original, [{ ...receipt, item: 2 }, { ...receipt, item: 3 }])).toEqual([{ item: 1, current: null }])
  expect(matchContinuity(original, [{ ...receipt, contextTag: 'd'.repeat(64) }])).toEqual([{ item: 1, current: null }])
  expect(matchContinuity(original, [])).toEqual([{ item: 1, current: null }])
  expect(JSON.stringify(original)).toBe(before)
  expect(deriveContinuityKeys(profileKey, { ...binding, attemptId: randomUUID() })).not.toEqual(keys)
})
