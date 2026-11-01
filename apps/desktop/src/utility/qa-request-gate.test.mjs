// MODULE: qa-request-gate.test.mjs - no network request can outrun its durable activity commitment
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { QA_WORKER_POLICY, classifyQaRequest, gateQaRequest, passQaRequest, qaNoWorkers, syntheticPaidContract } from '../../bin/qa-request-gate.mjs'

const origin = 'http://127.0.0.1:4173', contract = syntheticPaidContract(origin)
function fixture({ path = '/paid/report', method = 'POST', status = 200, navigation = false, headers = [], site = origin } = {}) {
  const events = [], responses = [], route = {
    request: () => ({ url: () => site + path, method: () => method, isNavigationRequest: () => navigation }),
    abort: vi.fn(async () => { events.push('abort') }),
    continue: vi.fn(async () => { events.push('continue') }),
    fetch: vi.fn(async options => { events.push('network'); expect(options).toEqual({ maxRedirects: 0, maxRetries: 0 })
      const response = { status: () => status, headersArray: () => headers, headers: () => Object.fromEntries(headers.map(header => [header.name.toLowerCase(), header.value])), dispose: vi.fn(async () => {}) }
      responses.push(response); return response }),
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
  return { events, responses, route, broker, close }
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
it('a recorded read that fails on the network fails in the page only; the account stays open and its audit has no gap', async () => {
  const f = fixture({ path: '/read', method: 'GET' }); f.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [origin] })
  f.route.fetch.mockRejectedValue(new Error('connection reset'))
  await gateQaRequest(f.route, f.broker, f.close)
  expect(f.events).toEqual(['observe', 'abort']); expect(f.route.fetch).toHaveBeenCalledOnce(); expect(f.route.abort).toHaveBeenCalledWith('failed')
  expect(f.broker.gap).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled()
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

const redirect = (location, cookies = []) => [{ name: 'Location', value: location }, ...cookies.map(value => ({ name: 'Set-Cookie', value }))]
it('a read page redirect returns as a page that navigates again through the route, keeping its cookies', async () => {
  const f = fixture({ path: '/', method: 'GET', status: 302, navigation: true, headers: redirect('/app?x="1"', ['a=1; Path=/', 'b=2; HttpOnly']) })
  await gateQaRequest(f.route, f.broker, f.close)
  expect(f.events).toEqual(['observe', 'network', 'fulfill'])
  const reply = f.route.fulfill.mock.calls[0][0]
  expect(reply).toMatchObject({ status: 200, headers: { 'set-cookie': 'a=1; Path=/\nb=2; HttpOnly', 'cache-control': 'no-store' } })
  expect(reply.body).toBe(`<!doctype html><meta http-equiv="refresh" content="0;url=${origin}/app?x=%221%22">`)
})
it.each([
  ['a subresource', { navigation: false, headers: redirect('/app') }],
  ['a script URL', { navigation: true, headers: redirect('javascript:alert(1)') }],
  ['a missing location', { navigation: true, headers: [] }]
])('a read redirect from %s is blocked, not followed', async (_, options) => {
  const f = fixture({ path: '/', method: 'GET', status: 302, ...options }); await gateQaRequest(f.route, f.broker, f.close)
  expect(f.route.fulfill).not.toHaveBeenCalled(); expect(f.route.abort).toHaveBeenCalledWith('blockedbyclient')
})
it('test-account and signed-out routes fetch every request themselves so no redirect hop leaves their route unseen', async () => {
  const sub = fixture({ path: '/state', method: 'GET' }); await passQaRequest(sub.route)
  expect(sub.events).toEqual(['network', 'fulfill']); expect(sub.route.continue).not.toHaveBeenCalled()
  for (const options of [{ path: '/asset', method: 'GET' }, { path: '/read', method: 'POST', navigation: true }]) {
    const away = fixture({ ...options, status: 302, headers: redirect('http://127.0.0.1:9/outside') }); await passQaRequest(away.route)
    expect(away.route.fulfill).not.toHaveBeenCalled(); expect(away.route.abort).toHaveBeenCalledWith('blockedbyclient')
  }
  const page = fixture({ path: '/app', method: 'GET', navigation: true }); await passQaRequest(page.route)
  expect(page.events).toEqual(['network', 'fulfill'])
  const hop = fixture({ path: '/', method: 'GET', status: 301, navigation: true, headers: redirect('https://elsewhere.test/') }); await passQaRequest(hop.route)
  expect(hop.route.fulfill.mock.calls[0][0].body).toContain('url=https://elsewhere.test/')
  const down = fixture({ path: '/app', method: 'GET', navigation: true }); down.route.fetch.mockRejectedValue(new Error('refused'))
  await passQaRequest(down.route); expect(down.route.abort).toHaveBeenCalledWith('failed')
})

const shop = 'https://shop.example'
it('an unreviewed account site is read with audited GETs only; its writes and other sites stay held (d71)', async () => {
  const read = fixture({ site: shop, path: '/orders/7731?page=2&token=secret', method: 'GET', navigation: true })
  read.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [shop] })
  await gateQaRequest(read.route, read.broker, read.close)
  expect(read.events).toEqual(['observe', 'network', 'fulfill'])
  expect(read.broker.observe.mock.calls[0][0]).toEqual({ method: 'GET', origin: shop, path: '/[unreviewed]', queryKeys: ['page', 'token'] })
  expect(JSON.stringify(read.broker.observe.mock.calls)).not.toMatch(/7731|secret/)
  for (const [method, site] of [['POST', shop], ['PUT', shop], ['DELETE', shop], ['PATCH', shop], ['GET', 'https://tracker.example']]) {
    const f = fixture({ site, path: '/cart', method }); f.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [shop] })
    await gateQaRequest(f.route, f.broker, f.close)
    expect(f.route.fetch).not.toHaveBeenCalled(); expect(f.broker.hold.mock.calls[0][0].path).toBe('/[unclassified]')
  }
  // A reviewed site keeps its literal contract: an unlisted GET is still held there.
  expect(classifyQaRequest(contract, 'GET', origin + '/unlisted', [origin]).classification).toBe('unknown')
  expect(classifyQaRequest(null, 'GET', 'https://user:pw@shop.example/', [shop]).classification).toBe('unknown')
  const hop = fixture({ site: shop, path: '/', method: 'GET', status: 302, navigation: true, headers: redirect('/signin') })
  hop.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [shop] })
  await gateQaRequest(hop.route, hop.broker, hop.close)
  expect(hop.route.fulfill.mock.calls[0][0].body).toContain(`url=${shop}/signin`)
})

// Owner-requested review, 2026-11-01: a SharedWorker's requests never reach the routes, so no QA document may start a worker.
it('every page or frame a QA route fulfills forbids workers beside its own policy; other replies pass unchanged', async () => {
  const csp = [{ name: 'Content-Security-Policy', value: "default-src 'self'" }]
  for (const handle of [f => passQaRequest(f.route), f => gateQaRequest(f.route, f.broker, f.close)]) {
    const own = fixture({ path: '/', method: 'GET', navigation: true, headers: csp }); own.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [origin] })
    await handle(own); expect(own.route.fulfill.mock.calls[0][0].headers['content-security-policy']).toBe(`default-src 'self', ${QA_WORKER_POLICY}`)
    const bare = fixture({ path: '/app', method: 'GET', navigation: true }); bare.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [origin] })
    await handle(bare); expect(bare.route.fulfill.mock.calls[0][0]).toMatchObject({ response: bare.responses[0], headers: { 'content-security-policy': QA_WORKER_POLICY } })
    const asset = fixture({ path: '/app.js', method: 'GET', headers: csp }); asset.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [origin] })
    await handle(asset); expect(asset.route.fulfill.mock.calls[0][0]).toEqual({ response: asset.responses[0] })
  }
  expect(QA_WORKER_POLICY).toBe("worker-src 'none'")
})
it('the init script leaves a QA document no worker constructor, and a page cannot put one back', () => {
  const left = runInNewContext(`(${qaNoWorkers})(); Worker = function Again() {}; [typeof Worker, typeof SharedWorker, typeof fetch]`, { Worker: class {}, SharedWorker: class {}, fetch: () => {} })
  expect(left).toEqual(['undefined', 'undefined', 'function'])
  expect(() => runInNewContext(`(${qaNoWorkers})()`, {})).not.toThrow()
})
it('every fetched reply is released after its use, whether fulfilled, redirected, refused or broken', async () => {
  const cases = [
    ['pass fulfill', fixture({ path: '/state', method: 'GET' }), f => passQaRequest(f.route)],
    ['pass redirect', fixture({ path: '/', method: 'GET', status: 302, navigation: true, headers: redirect('/next') }), f => passQaRequest(f.route)],
    ['pass blocked hop', fixture({ path: '/asset', method: 'GET', status: 302, headers: redirect('/next') }), f => passQaRequest(f.route)],
    ['gate activity', fixture(), f => gateQaRequest(f.route, f.broker, f.close)],
    ['gate read', fixture({ path: '/read', method: 'GET' }), f => { f.broker.policy.mockResolvedValue({ active: true, contract: null, origins: [origin] }); return gateQaRequest(f.route, f.broker, f.close) }],
    ['gate broken settle', fixture(), f => { f.broker.settle.mockRejectedValueOnce(new Error('lost')); return gateQaRequest(f.route, f.broker, f.close) }]
  ]
  for (const [name, f, handle] of cases) {
    await handle(f)
    expect(f.responses, name).toHaveLength(1); expect(f.responses[0].dispose, name).toHaveBeenCalledOnce()
    const used = [...f.route.fulfill.mock.invocationCallOrder, ...f.route.abort.mock.invocationCallOrder]
    expect(Math.max(...used), name).toBeLessThan(f.responses[0].dispose.mock.invocationCallOrder[0])
  }
  // A reply the context already dropped never turns a finished request into a failure.
  const gone = fixture({ path: '/state', method: 'GET' }); gone.route.fetch.mockResolvedValueOnce({ status: () => 200, headers: () => ({}), headersArray: () => [], dispose: async () => { throw new Error('Target closed') } })
  await expect(passQaRequest(gone.route)).resolves.toBeUndefined(); expect(gone.route.fulfill).toHaveBeenCalledOnce()
})
