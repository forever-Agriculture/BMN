// MODULE: qa-piche-contract.test.mjs - Epic 101.2: the Piche TEST read contract passes only reviewed query templates and the exact sign-in renewal
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PICHE_TEST_ORIGINS, classifyQaMeta, classifyQaRequest, gateQaRequest, picheReadContract, qaOwnOrigin } from '../../bin/qa-request-gate.mjs'

const contract = picheReadContract(), { page, api, signIn } = PICHE_TEST_ORIGINS
const bound = [page, signIn], unbound = [signIn]
// Synthetic canaries: none may appear in any classified record.
const CANARY = 'synthetic-canary-7f3a', TOKEN = 'synthetic-refresh-token-91c2'
const json = value => ({ contentType: 'application/json', data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) })
const form = text => ({ contentType: 'application/x-www-form-urlencoded', data: Buffer.from(text) })
const sha = text => createHash('sha256').update(text).digest('hex')
const RUN = 'query AutomationRun($tenantId: String!, $runId: String!) { automationRun(tenantId: $tenantId, runId: $runId) { id status } }'
const graphql = (payload, { method = 'POST', path = '/graphql', origins = bound } = {}) => classifyQaRequest(contract, method, api + path, origins, payload)
const renewal = (text, { path = '/realms/piche/protocol/openid-connect/token', type = 'application/x-www-form-urlencoded', method = 'POST' } = {}) =>
  classifyQaRequest(contract, method, signIn + path, bound, { contentType: type, data: Buffer.from(text) })
const goodRenewal = `grant_type=refresh_token&refresh_token=${TOKEN}&client_id=piche`
const secretFree = result => expect(JSON.stringify(result)).not.toMatch(new RegExp(`${CANARY}|${TOKEN}`))

describe('reviewed reads (101.2 AC1)', () => {
  it.each([
    ['AutomationsList', 'automations'], ['AutomationRun', 'automationRun'], ['AutomationRunLogs', 'automationRunLogs'], ['AutomationSteps', 'automationSteps'],
    ['AutomationWebhookAddresses', 'automationWorkspace'], ['UserInfo', 'userInfo'], ['MyFeatureFlags', 'myFeatureFlags']
  ])('%s passes as a read with its type, name and document hash only', (name, root) => {
    const query = `query ${name}($tenantId: String!) { ${root}(tenantId: $tenantId) { id __typename } }`
    const result = graphql(json({ query, variables: { tenantId: 'piche', search: CANARY } }))
    expect(result).toEqual({ classification: 'read', reviewed: true, activity: null,
      request: { method: 'POST', origin: api, path: '/graphql', queryKeys: [], body: { kind: 'graphql', operation: 'query', name, sha256: sha(query) } } })
    secretFree(result)
  })
  it('accepts aliases on the root field, @include and @skip, a charset and a matching operationName', () => {
    const query = 'query AutomationRun($id: String!, $more: Boolean!) { run: automationRun(runId: $id) { id status @include(if: $more) logs @skip(if: $more) } }'
    expect(classifyQaRequest(contract, 'POST', api + '/graphql', bound, { contentType: 'application/json; charset=utf-8', data: Buffer.from(JSON.stringify({ query, operationName: 'AutomationRun', variables: { id: CANARY, more: true } })) }).classification).toBe('read')
  })
  it('reads the body only for a bound reviewed origin, lazily', () => {
    const payload = vi.fn(() => json({ query: RUN }))
    expect(classifyQaRequest(contract, 'GET', page + '/automations', bound, payload).classification).toBe('read')
    expect(payload).not.toHaveBeenCalled()
    expect(classifyQaRequest(contract, 'POST', api + '/graphql', bound, payload).classification).toBe('read')
    expect(payload).toHaveBeenCalledOnce()
  })
})

describe('everything else on the API is held before send, without a name (101.2 AC2)', () => {
  const big = 'x'.repeat(17 * 1024)
  it.each([
    ['a mutation', json({ query: 'mutation CancelAutomationRun($id: String!) { cancelAutomationRun(runId: $id) { id } }', variables: { id: CANARY } }), 'mutation'],
    ['a subscription', json({ query: 'subscription AutomationRun { automationRun { id } }' }), 'subscription'],
    ['two operations', json({ query: `${RUN} query AutomationRuns { automationRuns { id } }` }), null],
    ['an unnamed operation', json({ query: '{ automationRun(runId: "a") { id } }' }), 'query'],
    ['an unreviewed name', json({ query: 'query ChatList { conversations { id } }' }), 'query'],
    ['an extra root field', json({ query: 'query AutomationRun { automationRun { id } automations { id } }' }), 'query'],
    ['a reviewed name over another root field', json({ query: 'query AutomationRun { conversations { id } }' }), 'query'],
    ['two aliased root selections', json({ query: 'query AutomationRun { a: automationRun { id } b: automationRun { id } }' }), 'query'],
    ['an introspection field', json({ query: 'query AutomationRun { automationRun { id __schema { types { name } } } }' }), 'query'],
    ['another directive', json({ query: 'query AutomationRun { automationRun { id ... @defer { status } } }' }), 'query'],
    ['an unlisted directive', json({ query: 'query AutomationRun { automationRun { id @export(as: "x") } }' }), 'query'],
    ['a fragment', json({ query: 'query AutomationRun { automationRun { ...Run } } fragment Run on AutomationRun { id }' }), null],
    ['an inline fragment', json({ query: 'query AutomationRun { automationRun { ... on AutomationRun { id } } }' }), 'query'],
    ['malformed GraphQL', json({ query: 'query AutomationRun { automationRun { id ' }), null],
    ['a mismatched operationName', json({ query: RUN, operationName: 'AutomationRuns' }), 'query'],
    ['extensions (persisted queries)', json({ query: RUN, extensions: { persistedQuery: { sha256Hash: CANARY } } }), null],
    ['repeated keys', json(`{"query":${JSON.stringify(RUN)},"query":"mutation DeleteAutomation { deleteAutomation { id } }"}`), null],
    ['repeated keys in variables', json(`{"query":${JSON.stringify(RUN)},"variables":{"runId":"a","runId":"${CANARY}"}}`), null],
    ['variables that are not an object', json({ query: RUN, variables: [CANARY] }), null]
  ])('%s', (label, payload, operation) => {
    const result = graphql(payload)
    expect(result.classification).toBe('unknown'); expect(result.reviewed).toBe(false)
    expect(result.request.path).toBe('/graphql')
    expect(result.request.body?.name ?? null).toBeNull()
    if (result.request.body) expect(result.request.body.operation).toBe(operation)
    secretFree(result)
  })
  it.each([
    ['malformed JSON', json('{"query": "query AutomationRun { automationRun { id } }"'), '/graphql'],
    ['a batch', json([{ query: RUN }, { query: RUN }]), '/graphql'],
    ['another content type', { contentType: 'text/plain', data: Buffer.from(JSON.stringify({ query: RUN })) }, '/graphql'],
    ['an empty body', { contentType: 'application/json', data: Buffer.alloc(0) }, '/graphql'],
    ['no body', { contentType: 'application/json', data: null }, '/graphql'],
    ['an oversized body', json({ query: RUN, variables: { padding: big } }), '/graphql'],
    ['invalid UTF-8', { contentType: 'application/json', data: Buffer.from([0x7b, 0xff, 0x7d]) }, '/graphql']
  ])('%s carries no body detail', (label, payload, path) => {
    const result = graphql(payload)
    expect(result).toMatchObject({ classification: 'unknown', reviewed: false, request: { path } })
    expect(result.request.body).toBeUndefined()
    secretFree(result)
  })
  it.each([
    ['GET /graphql?query=', 'GET', `/graphql?query=${encodeURIComponent(RUN)}`, '/graphql'],
    ['a URL query on POST', 'POST', `/graphql?token=${CANARY}`, '/graphql'],
    ['the public endpoint', 'POST', '/graphql/public', '/[unclassified]'],
    ['another path', 'POST', '/api/automations', '/[unclassified]'],
    ['PUT', 'PUT', '/graphql', '/graphql'],
    ['OPTIONS', 'OPTIONS', '/graphql', '/graphql']
  ])('%s is held', (label, method, path, recorded) => {
    const result = graphql(json({ query: RUN }), { method, path })
    expect(result).toMatchObject({ classification: 'unknown', request: { path: recorded } })
    secretFree(result)
  })
  it('credentials in the address are held', () => {
    expect(classifyQaRequest(contract, 'POST', `https://user:${CANARY}@epic5.gpark.lv/graphql`, bound, json({ query: RUN })).classification).toBe('unknown')
  })
})

describe('the page origin and binding (D2, D4, D7)', () => {
  it('page GETs are reads with key names only; other methods are held', () => {
    expect(classifyQaRequest(contract, 'GET', `${page}/automations/run?id=${CANARY}`, bound)).toMatchObject({ classification: 'read', request: { path: '/[unreviewed]', queryKeys: ['id'] } })
    expect(classifyQaRequest(contract, 'POST', `${page}/automations`, bound).classification).toBe('unknown')
  })
  it('an account whose sites lack the page origin keeps today\'s rules: no reviewed reads, its own GETs only', () => {
    const result = graphql(json({ query: RUN }), { origins: unbound })
    expect(result).toEqual({ classification: 'unknown', reviewed: false, activity: null, request: { method: 'POST', origin: api, path: '/[unclassified]', queryKeys: [] } })
    expect(classifyQaRequest(contract, 'GET', signIn + '/realms/piche/account', unbound).classification).toBe('read')
    expect(qaOwnOrigin(contract, unbound, api)).toBe(false)
  })
  it('a bound account owns all three origins; other origins stay outside', () => {
    expect([page, api, signIn].map(origin => qaOwnOrigin(contract, [page], origin))).toEqual([true, true, true])
    expect(qaOwnOrigin(contract, [page], 'https://attachments-epic5.gpark.lv')).toBe(false)
    expect(qaOwnOrigin(null, [page], api)).toBe(false)
  })
  it('the contract binds only its TEST origins or three distinct loopback origins', () => {
    expect(picheReadContract({ page: 'http://127.0.0.1:5001', api: 'http://127.0.0.1:5002', signIn: 'http://127.0.0.1:5003' }).sha256).toBe(contract.sha256)
    for (const origins of [{ ...PICHE_TEST_ORIGINS, api: 'https://epic5.piche.it' }, { page: 'http://127.0.0.1:5001', api: 'http://127.0.0.1:5001', signIn: 'http://127.0.0.1:5003' },
      { page: 'http://localhost:5001', api: 'http://127.0.0.1:5002', signIn: 'http://127.0.0.1:5003' }, { page }])
      expect(() => picheReadContract(origins)).toThrow('QA_PICHE_ORIGINS_INVALID')
    // A forged contract with the right id but other rules never applies.
    expect(classifyQaRequest({ ...contract, sha256: 'b'.repeat(64) }, 'POST', api + '/graphql', bound, json({ query: RUN })).classification).toBe('unknown')
  })
})

describe('the sign-in renewal, exactly (101.2 AC4, D6)', () => {
  it('passes with the grant name only', () => {
    const result = renewal(goodRenewal)
    expect(result).toEqual({ classification: 'read', reviewed: true, activity: null,
      request: { method: 'POST', origin: signIn, path: '/realms/piche/protocol/openid-connect/token', queryKeys: [], body: { kind: 'form', grant: 'refresh_token' } } })
    secretFree(result)
    expect(renewal(goodRenewal, { type: 'application/x-www-form-urlencoded;charset=UTF-8' }).classification).toBe('read')
  })
  it.each([
    ['a password grant', `grant_type=password&username=synthetic&password=${CANARY}&client_id=piche`],
    ['a code grant', `grant_type=authorization_code&code=${CANARY}&client_id=piche`],
    ['another client', `grant_type=refresh_token&refresh_token=${TOKEN}&client_id=admin-cli`],
    ['an extra field', `grant_type=refresh_token&refresh_token=${TOKEN}&client_id=piche&scope=offline_access`],
    ['a repeated field', `grant_type=refresh_token&grant_type=password&refresh_token=${TOKEN}&client_id=piche`],
    ['a missing client', `grant_type=refresh_token&refresh_token=${TOKEN}`],
    ['an empty token', 'grant_type=refresh_token&refresh_token=&client_id=piche']
  ])('%s is held', (label, text) => {
    const result = renewal(text)
    expect(result.classification).toBe('unknown'); expect(result.request.body).toBeUndefined()
    secretFree(result)
  })
  it.each([
    ['another realm', { path: '/realms/master/protocol/openid-connect/token' }, '/[unclassified]'],
    ['the logout path', { path: '/realms/piche/protocol/openid-connect/logout' }, '/[unclassified]'],
    ['a URL query', { path: `/realms/piche/protocol/openid-connect/token?code=${CANARY}` }, '/realms/piche/protocol/openid-connect/token'],
    ['a JSON body', { type: 'application/json' }, '/realms/piche/protocol/openid-connect/token'],
    ['a GET', { method: 'GET' }, '/realms/piche/protocol/openid-connect/token']
  ])('%s is held', (label, options, path) => {
    const result = renewal(goodRenewal, options)
    expect(result).toMatchObject({ classification: 'unknown', request: { path } })
    secretFree(result)
  })
  it('a GET on the sign-in origin is held for a bound account, the logout GET included', () => {
    expect(classifyQaRequest(contract, 'GET', `${signIn}/realms/piche/protocol/openid-connect/logout?id_token_hint=${CANARY}`, bound).classification).toBe('unknown')
  })
})

describe('the host re-check from metadata alone (D9)', () => {
  const meta = (origin, path, body, method = 'POST') => ({ method, origin, path, queryKeys: [], ...(body ? { body } : {}) })
  const read = { kind: 'graphql', operation: 'query', name: 'AutomationRun', sha256: sha(RUN) }
  it('accepts a reviewed read, the renewal and a page GET', () => {
    expect(classifyQaMeta(contract, meta(api, '/graphql', read), bound)).toMatchObject({ classification: 'read', reviewed: true })
    expect(classifyQaMeta(contract, meta(signIn, '/realms/piche/protocol/openid-connect/token', { kind: 'form', grant: 'refresh_token' }), bound).classification).toBe('read')
    expect(classifyQaMeta(contract, meta(page, '/[unreviewed]', null, 'GET'), bound)).toMatchObject({ classification: 'read', request: { path: '/[unreviewed]' } })
  })
  it.each([
    ['an unreviewed name', meta(api, '/graphql', { ...read, name: 'ChatList' }), bound],
    ['a mutation detail', meta(api, '/graphql', { ...read, operation: 'mutation', name: null }), bound],
    ['a read detail on another path', meta(api, '/[unclassified]', read), bound],
    ['a read detail with a query key', { ...meta(api, '/graphql', read), queryKeys: ['token'] }, bound],
    ['a read detail on the page origin', meta(page, '/[unreviewed]', read, 'GET'), bound],
    ['the renewal detail on another path', meta(signIn, '/[unclassified]', { kind: 'form', grant: 'refresh_token' }), bound],
    ['an unbound account', meta(api, '/graphql', read), unbound],
    ['a body detail on an unrelated origin', meta('https://example.invalid', '/[unreviewed]', read, 'GET'), bound]
  ])('refuses %s', (label, value, origins) => {
    expect(classifyQaMeta(contract, value, origins).classification).toBe('unknown')
  })
})

describe('the gate sends only what it classified (101.2 AC1, AC2, AC4)', () => {
  function fixture(url, method, payload) {
    const events = [], route = {
      request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => false, headers: () => ({ 'content-type': payload.contentType }), postDataBuffer: () => payload.data }),
      abort: vi.fn(async () => { events.push('abort') }),
      fetch: vi.fn(async () => { events.push('network'); return { status: () => 200, headersArray: () => [], headers: () => ({}) } }),
      fulfill: vi.fn(async () => { events.push('fulfill') })
    }
    const broker = {
      policy: vi.fn(async () => ({ active: true, contract, origins: bound })),
      reserve: vi.fn(), send: vi.fn(), settle: vi.fn(),
      observe: vi.fn(async (request, status) => { events.push(status === undefined ? 'observe' : `observe-${status}`) }),
      hold: vi.fn(async () => { events.push('hold') }), gap: vi.fn(async () => {})
    }
    return { events, route, broker, close: vi.fn(async () => {}) }
  }
  it('a reviewed query is audited, then sent once', async () => {
    const f = fixture(api + '/graphql', 'POST', json({ query: RUN, variables: { runId: CANARY } }))
    await gateQaRequest(f.route, f.broker, f.close)
    expect(f.events).toEqual(['observe', 'network', 'fulfill']); secretFree(f.broker.observe.mock.calls)
  })
  it('a mutation is held and never reaches the network', async () => {
    const f = fixture(api + '/graphql', 'POST', json({ query: 'mutation DeleteAutomation($id: String!) { deleteAutomation(automationId: $id) { id } }', variables: { id: CANARY } }))
    await gateQaRequest(f.route, f.broker, f.close)
    expect(f.events).toEqual(['hold', 'abort']); expect(f.route.fetch).not.toHaveBeenCalled(); secretFree(f.broker.hold.mock.calls)
  })
  it('the renewal is audited before the send and its status after', async () => {
    const f = fixture(signIn + '/realms/piche/protocol/openid-connect/token', 'POST', form(goodRenewal))
    await gateQaRequest(f.route, f.broker, f.close)
    expect(f.events).toEqual(['observe', 'network', 'observe-200', 'fulfill']); secretFree(f.broker.observe.mock.calls)
  })
})
