// MODULE: wsl-capabilities.test.mjs - a WSL session's scoped authority: grant, channel binding, replay, roots and revocation
import { describe, expect, it } from 'vitest'
import { WslCapabilities } from '../lib/wsl-capabilities.mjs'

const UBUNTU = '{0b1e2f3a-4c5d-4e6f-8a9b-0c1d2e3f4a5b}'
const DEBIAN = '{11111111-2222-4333-8444-555555555555}'
const CEILING = ['progress.report', 'attention.ask', 'artifact.publish']
let counter = 0
// Distinct, synthetic secrets in place of random bytes.
const random = (bytes) => Buffer.alloc(bytes, 0xa0 + ++counter)
const grant = (overrides = {}) => ({ sessionId: 'session-a', incarnationId: 'run-1', distributionId: UBUNTU,
  roots: ['/home/project'], operations: ['progress.report', 'artifact.publish'], ...overrides })
const channelA = { sessionId: 'session-a', incarnationId: 'run-1' }

describe('WSL session capabilities', () => {
  it('grants only listed operations below the granted roots, in the credential\'s own distribution', () => {
    const capabilities = new WslCapabilities({ ceiling: CEILING, random })
    const { secret } = capabilities.mint(grant())
    expect(secret).toMatch(/^[0-9a-f]{64}$/u)
    expect(capabilities.authorize(channelA, { secret, sequence: 1, operation: 'progress.report' })).toEqual({ ok: true, operation: 'progress.report' })
    expect(capabilities.authorize(channelA, { secret, sequence: 2, operation: 'artifact.publish', path: '/home/project/out/a.png' }))
      .toEqual({ ok: true, operation: 'artifact.publish', distributionId: UBUNTU, root: '/home/project', segments: ['out', 'a.png'] })
    expect(capabilities.authorize(channelA, { secret, sequence: 3, operation: 'attention.ask' }))
      .toEqual({ ok: false, code: 'DENIED', reason: 'the operation is not granted to this session' })
    expect(capabilities.authorize(channelA, { secret, sequence: 4, operation: 'artifact.publish', path: '/home/project-other/a.png' }).code).toBe('DENIED')
    expect(capabilities.authorize(channelA, { secret, sequence: 5, operation: 'artifact.publish', path: '/etc/shadow' }).code).toBe('DENIED')
    expect(capabilities.authorize(channelA, { secret, sequence: 6, operation: 'artifact.publish', path: '/home/project/../x' }))
      .toEqual({ ok: false, code: 'PROTOCOL', reason: 'path is not a normalized path' })
  })

  it('never widens: a grant beyond the ceiling, an empty root list or a malformed distribution identity fails', () => {
    const capabilities = new WslCapabilities({ ceiling: CEILING, random })
    expect(() => capabilities.mint(grant({ operations: ['settings.put'] }))).toThrow('beyond what a WSL session may do')
    expect(() => capabilities.mint(grant({ operations: 'progress.report' }))).toThrow('operations are a list')
    expect(() => capabilities.mint(grant({ roots: [] }))).toThrow('at least one authorized root')
    expect(() => capabilities.mint(grant({ distributionId: UBUNTU.toUpperCase() }))).toThrow('lowercase registration GUID')
    expect(() => capabilities.mint(grant({ sessionId: 'a.b' }))).toThrow('session identity is not valid')
  })

  it('judges the transport a request arrived on and ignores nothing the guest adds', () => {
    const capabilities = new WslCapabilities({ ceiling: CEILING, random })
    const { secret } = capabilities.mint(grant())
    expect(capabilities.authorize({ sessionId: 'session-b', incarnationId: 'run-1' }, { secret, sequence: 1, operation: 'progress.report' }))
      .toEqual({ ok: false, code: 'AUTH', reason: 'the credential belongs to another session' })
    expect(capabilities.authorize({ sessionId: 'session-a', incarnationId: 'run-0' }, { secret, sequence: 1, operation: 'progress.report' }).code).toBe('AUTH')
    // A claimed session or distribution is refused outright rather than ignored.
    expect(capabilities.authorize(channelA, { secret, sequence: 1, operation: 'progress.report', sessionId: 'session-b' }))
      .toEqual({ ok: false, code: 'PROTOCOL', reason: 'unexpected request field "sessionId"' })
    expect(capabilities.authorize(channelA, { secret, sequence: 1, operation: 'artifact.publish', path: '/home/project/a', distributionId: DEBIAN }).code).toBe('PROTOCOL')
    for (const bad of [null, [], 'x', { secret: secret.toUpperCase(), sequence: 1, operation: 'progress.report' }, { secret: 'a'.repeat(64), sequence: 1, operation: 'progress.report' }]) {
      expect(capabilities.authorize(channelA, bad).ok).toBe(false)
    }
  })

  it('refuses a replayed or out-of-order request, and a denied request uses up its sequence', () => {
    const capabilities = new WslCapabilities({ ceiling: CEILING, random })
    const { secret } = capabilities.mint(grant())
    const ask = (sequence, operation = 'progress.report') => capabilities.authorize(channelA, { secret, sequence, operation }).code ?? 'OK'
    expect([ask(1), ask(1), ask(3), ask(2), ask(4, 'attention.ask'), ask(4), ask(5), ask(1.5), ask(Number.MAX_SAFE_INTEGER + 2)])
      .toEqual(['OK', 'AUTH', 'OK', 'AUTH', 'DENIED', 'AUTH', 'OK', 'AUTH', 'AUTH'])
  })

  it('stops a session\'s credential at Stop, and at a new incarnation, without touching other sessions', () => {
    const capabilities = new WslCapabilities({ ceiling: CEILING, random })
    const first = capabilities.mint(grant()).secret
    const other = capabilities.mint(grant({ sessionId: 'session-b' })).secret
    const channelB = { sessionId: 'session-b', incarnationId: 'run-1' }
    // Relaunch: the new incarnation's credential replaces the old one.
    const second = capabilities.mint(grant({ incarnationId: 'run-2' })).secret
    expect(capabilities.authorize(channelA, { secret: first, sequence: 1, operation: 'progress.report' }).reason).toBe('the credential is not valid or was revoked')
    const channelA2 = { sessionId: 'session-a', incarnationId: 'run-2' }
    expect(capabilities.authorize(channelA2, { secret: second, sequence: 1, operation: 'progress.report' }).ok).toBe(true)
    expect(capabilities.revoke('session-a')).toBe(1)
    expect(capabilities.authorize(channelA2, { secret: second, sequence: 2, operation: 'progress.report' }).code).toBe('AUTH')
    expect(capabilities.revoke('session-a')).toBe(0)
    expect(capabilities.authorize(channelB, { secret: other, sequence: 1, operation: 'progress.report' }).ok).toBe(true)
  })
})
