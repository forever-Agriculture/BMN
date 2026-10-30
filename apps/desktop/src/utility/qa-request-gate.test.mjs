// MODULE: qa-request-gate.test.mjs - no network request can outrun its durable activity commitment
import { expect, it, vi } from 'vitest'
import { classifyQaRequest, gateQaRequest, syntheticPaidContract } from '../../bin/qa-request-gate.mjs'

const origin = 'http://127.0.0.1:4173', contract = syntheticPaidContract(origin)
function fixture({ path = '/paid/report', method = 'POST', status = 200 } = {}) {
  const events = [], route = {
    request: () => ({ url: () => origin + path, method: () => method }),
    abort: vi.fn(async () => { events.push('abort') }),
    fetch: vi.fn(async options => { events.push('network'); expect(options).toEqual({ maxRedirects: 0, maxRetries: 0 }); return { status: () => status } }),
    fulfill: vi.fn(async () => { events.push('fulfill') })
  }
  const broker = {
    policy: vi.fn(async () => ({ active: true, contract })),
    reserve: vi.fn(async () => { events.push('reserve'); return { allowed: true, use: { id: 'use-a' } } }),
    send: vi.fn(async () => { events.push('commit'); return { allowed: true } }),
    settle: vi.fn(async () => { events.push('settle') }),
    observe: vi.fn(async () => { events.push('observe') }), hold: vi.fn(async () => {}), gap: vi.fn(async () => {})
  }
  const close = vi.fn(async () => { events.push('close') })
  return { events, route, broker, close }
}

it('an activity is reserved and committed before its single network send', async () => {
  const f = fixture(); await gateQaRequest(f.route, f.broker, f.close)
  expect(f.events).toEqual(['reserve', 'commit', 'network', 'settle', 'fulfill'])
  expect(f.broker.reserve.mock.calls[0][0]).toMatchObject({ activity: 'report.generate', request: { method: 'POST', origin, path: '/paid/report', queryKeys: [] } })
  expect(f.broker.settle).toHaveBeenCalledWith('use-a', 'succeeded', 200)
})

it.each(['not-approved', 'exhausted', 'account-outcome-pending'])('a %s activity never reaches the service', async reason => {
  const f = fixture(); f.broker.reserve.mockResolvedValue({ allowed: false, reason })
  await gateQaRequest(f.route, f.broker, f.close)
  expect(f.route.fetch).not.toHaveBeenCalled(); expect(f.broker.send).not.toHaveBeenCalled()
  expect(f.broker.hold).toHaveBeenCalledWith(expect.any(Object), reason)
})

it.each(['reserve', 'send'])('a lost %s reply closes the context without sending', async method => {
  const f = fixture(); f.broker[method].mockRejectedValue(new Error('lost reply'))
  await gateQaRequest(f.route, f.broker, f.close)
  expect(f.route.fetch).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
  expect(f.broker.gap).toHaveBeenCalledWith('broker-unreachable')
})

it('a redirect is recorded as uncertain and never followed or fulfilled', async () => {
  const f = fixture({ status: 307 }); await gateQaRequest(f.route, f.broker, f.close)
  expect(f.broker.settle).toHaveBeenCalledWith('use-a', 'uncertain', 307)
  expect(f.route.fetch).toHaveBeenCalledOnce(); expect(f.route.fulfill).not.toHaveBeenCalled()
})

it('a failed network call remains uncertain and closes the context', async () => {
  const f = fixture(); f.route.fetch.mockRejectedValue(new Error('connection lost'))
  await gateQaRequest(f.route, f.broker, f.close)
  expect(f.broker.settle).toHaveBeenCalledWith('use-a', 'uncertain', null)
  expect(f.close).toHaveBeenCalledOnce()
})

it('a reviewed read POST is audited before sending without spending an activity', async () => {
  const f = fixture({ path: '/read' }); await gateQaRequest(f.route, f.broker, f.close)
  expect(f.events).toEqual(['observe', 'network', 'fulfill']); expect(f.broker.reserve).not.toHaveBeenCalled()
})

it.each(['/paid/report?token=secret', '/unknown/private-path', '/paid/other'])('holds unsupported request %s and redacts its path and query values', async path => {
  const f = fixture({ path }); await gateQaRequest(f.route, f.broker, f.close)
  expect(f.route.fetch).not.toHaveBeenCalled()
  const metadata = f.broker.hold.mock.calls[0][0]
  expect(metadata.path).toBe('/[unclassified]'); expect(JSON.stringify(metadata)).not.toContain('secret')
})

it('does not assume a GET to a paid endpoint is a read', async () => {
  const f = fixture({ method: 'GET' }); await gateQaRequest(f.route, f.broker, f.close)
  expect(f.route.fetch).not.toHaveBeenCalled(); expect(f.broker.hold).toHaveBeenCalledOnce()
})

it('rejects an expired or revoked policy before sending and closes the context', async () => {
  const f = fixture(); f.broker.policy.mockResolvedValue({ active: false })
  await gateQaRequest(f.route, f.broker, f.close)
  expect(f.route.fetch).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
})

it('a forged contract or another origin never classifies a permitted activity', () => {
  for (const c of [null, { ...contract, sha256: 'forged' }, { ...contract, origin: 'http://127.0.0.1:4174' }]) {
    expect(classifyQaRequest(c, 'POST', origin + '/paid/report').classification).toBe('unknown')
  }
  expect(() => syntheticPaidContract('https://example.com')).toThrow('QA_SYNTHETIC_ORIGIN_INVALID')
})
