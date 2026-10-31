// MODULE: qa-request-gate.mjs - reviewed site requests cross the durable broker before any network send
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const rules = Object.freeze([
  ['GET', '/', 'read'], ['GET', '/app', 'read'], ['GET', '/favicon.ico', 'read'],
  ['GET', '/state', 'read'], ['POST', '/read', 'read'],
  ['POST', '/paid/report', 'report.generate'], ['POST', '/paid/brainstorm', 'brainstorm.start']
].map(rule => Object.freeze(rule)))
const id = 'synthetic-paid@1'
const sha256 = createHash('sha256').update(JSON.stringify({ id, rules })).digest('hex')

/** A test service contract, registered by the host; a brief never registers a site. */
export function syntheticPaidContract(origin) {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin) throw new Error('QA_SYNTHETIC_ORIGIN_INVALID')
  return Object.freeze({ id, sha256, origin })
}
/** The counted activities a registered contract defines; the Piche read contract has none (D4), so no grant or card can name it. */
export function qaContractActivities(contract) {
  return contract?.id === id && contract.sha256 === sha256 ? [...new Set(rules.map(rule => rule[2]).filter(kind => kind !== 'read'))] : []
}

/*
 * Epic 101: Piche TEST read contract. Its rules (reviewed query templates, the sign-in renewal, the body limit) are fixed
 * here and hashed; only its three origins vary, and only to a loopback twin a test-mode host registers (D2).
 * Templates: plan/references/101/reads-2026-10-31.md (each one query operation with one root field, traced to a read).
 */
const PICHE_ID = 'piche-test-read@1'
export const PICHE_TEST_ORIGINS = Object.freeze({ page: 'https://epic5web.gpark.lv', api: 'https://epic5.gpark.lv', signIn: 'https://identity-epic5.gpark.lv' })
const PICHE_READS = Object.freeze(Object.fromEntries([
  ['AutomationOperation', 'automationOperationStatus'], ['AutomationsPilot', 'automationPilotStatus'], ['AutomationsList', 'automations'],
  ['AutomationWorkspace', 'automationWorkspace'], ['AutomationWebhookAddresses', 'automationWorkspace'], ['AutomationSession', 'automationSession'],
  ['AutomationSetup', 'automationSetup'], ['AutomationSuggestedConnections', 'automationSetup'], ['AutomationRun', 'automationRun'],
  ['AutomationRunAttempts', 'automationRunAttempts'], ['AutomationRunEffects', 'automationRunEffects'], ['AutomationRunLogs', 'automationRunLogs'],
  ['AutomationRuns', 'automationRuns'], ['AutomationWebhookCalls', 'automationWebhookCalls'], ['AutomationPersonalConnections', 'automationPersonalConnections'],
  ['AutomationSteps', 'automationSteps'], ['AutomationVersionSource', 'automationVersionSource'], ['AutomationExamples', 'automationExamples'],
  ['UserInfo', 'userInfo'], ['MyFeatureFlags', 'myFeatureFlags']
]))
const PICHE_GRAPHQL_PATH = '/graphql'
const PICHE_RENEWAL = Object.freeze({ path: '/realms/piche/protocol/openid-connect/token', client: 'piche' })
const PICHE_BODY_LIMIT = 16 * 1024
const picheSha256 = createHash('sha256').update(JSON.stringify({ id: PICHE_ID, reads: PICHE_READS, graphql: PICHE_GRAPHQL_PATH, renewal: PICHE_RENEWAL, limit: PICHE_BODY_LIMIT })).digest('hex')
const loopback = value => { try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.origin === value } catch { return false } }

/** The Piche TEST read contract for its three TEST origins, or a test-only twin on three distinct loopback origins (101.2 verification). */
export function picheReadContract(origins = PICHE_TEST_ORIGINS) {
  const keys = ['page', 'api', 'signIn'], values = keys.map(key => origins?.[key])
  const real = keys.every(key => origins?.[key] === PICHE_TEST_ORIGINS[key])
  if (!real && !(values.every(loopback) && new Set(values).size === 3)) throw new Error('QA_PICHE_ORIGINS_INVALID')
  return Object.freeze({ id: PICHE_ID, sha256: picheSha256, origin: origins.page, origins: Object.freeze({ page: origins.page, api: origins.api, signIn: origins.signIn }) })
}
const isPiche = contract => contract?.id === PICHE_ID && contract.sha256 === picheSha256 && Boolean(contract.origins)
/** The contract applies only to an account whose saved sites include its page origin; then all its origins are that account's (D2). */
const picheBound = (contract, ownOrigins) => isPiche(contract) && ownOrigins.includes(contract.origins.page)
/** Whether `origin` is one of the account's sites, counting a bound reviewed contract's API and sign-in origins. */
export function qaOwnOrigin(contract, ownOrigins, origin) {
  return ownOrigins.includes(origin) || picheBound(contract, ownOrigins) && Object.values(contract.origins).includes(origin)
}
/** A routed request's body as the gate reads it, in memory only and only on a bound reviewed origin; it is never recorded. */
export const qaRequestPayload = request => () => ({ contentType: request.headers()['content-type'] ?? null, data: request.postDataBuffer() })
const readPayload = payload => typeof payload === 'function' ? payload() : payload

/** JSON.parse keeps the last of repeated keys; a server may keep the first, so any repeat is ambiguous (D8). */
function repeatsKeys(text) {
  const stack = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      let end = i + 1
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      const top = stack[stack.length - 1]
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1))
        if (top.keys.has(key)) return true
        top.keys.add(key); top.expectKey = false
      }
      i = end
    } else if (char === '{') stack.push({ keys: new Set(), expectKey: true })
    else if (char === '[') stack.push({ keys: null, expectKey: false })
    else if (char === '}' || char === ']') stack.pop()
    else if (char === ',' && stack[stack.length - 1]?.keys) stack[stack.length - 1].expectKey = true
  }
  return false
}
let graphqlLibrary = null
const graphqlParser = () => {
  if (graphqlLibrary) return graphqlLibrary
  // Packaged, modules resolve beside the app's own dependencies, as the browser engine resolves Playwright.
  const packaged = join(dirname(process.execPath), 'resources/app.asar/package.json')
  graphqlLibrary = createRequire(existsSync(packaged) ? packaged : import.meta.url)('graphql')
  return graphqlLibrary
}
/** One query whose operation name and root fields match a reviewed template, with no fragments, other directives or introspection (D3). */
function picheTemplate(document) {
  const { Kind, visit, BREAK } = graphqlParser()
  if (document.definitions.length !== 1 || document.definitions[0].kind !== Kind.OPERATION_DEFINITION) return { operation: null, reviewed: false }
  const operation = document.definitions[0], name = operation.name?.value ?? null, root = name !== null && Object.hasOwn(PICHE_READS, name) ? PICHE_READS[name] : null
  let clean = operation.operation === 'query' && root !== null && operation.selectionSet.selections.length === 1 &&
    operation.selectionSet.selections.every(selection => selection.kind === Kind.FIELD && selection.name.value === root)
  if (clean) visit(document, {
    enter(node) {
      if (node.kind === Kind.FRAGMENT_SPREAD || node.kind === Kind.INLINE_FRAGMENT || node.kind === Kind.FRAGMENT_DEFINITION ||
        node.kind === Kind.DIRECTIVE && !['include', 'skip'].includes(node.name.value) ||
        node.kind === Kind.FIELD && node.name.value.startsWith('__') && node.name.value !== '__typename') { clean = false; return BREAK }
      return undefined
    }
  })
  return { operation: operation.operation, reviewed: clean, name: clean ? name : null }
}
/** The closed envelope: POST /graphql, JSON, one object with only query, variables and a matching operationName (D8). */
function picheGraphql(method, url, payload) {
  const held = (body = null) => ({ reviewed: false, body })
  if (method !== 'POST' || url.pathname !== PICHE_GRAPHQL_PATH || url.search || url.hash) return held()
  payload = readPayload(payload)
  const data = payload?.data
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(payload?.contentType ?? '') || !Buffer.isBuffer(data) || data.length === 0 || data.length > PICHE_BODY_LIMIT) return held()
  let text, envelope
  // A byte-order mark stays in the text, so JSON.parse refuses it rather than reading what a server might not.
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); envelope = JSON.parse(text) } catch { return held() }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.query !== 'string') return held()
  const body = { kind: 'graphql', operation: null, name: null, sha256: createHash('sha256').update(envelope.query).digest('hex') }
  if (repeatsKeys(text) || Object.keys(envelope).some(key => !['query', 'variables', 'operationName'].includes(key)) ||
    envelope.variables !== undefined && (envelope.variables === null || typeof envelope.variables !== 'object' || Array.isArray(envelope.variables))) return held(body)
  let template
  try { template = picheTemplate(graphqlParser().parse(envelope.query, { noLocation: true, maxTokens: 4000 })) } catch { return held(body) }
  body.operation = template.operation
  if (!template.reviewed || envelope.operationName !== undefined && envelope.operationName !== template.name) return held(body)
  return { reviewed: true, body: { ...body, name: template.name } }
}
/** One renewal field as the sign-in client writes it: a literal key and a value of URL-safe token characters, never an escape or a plus. */
const RENEWAL_FIELD = /^(grant_type|refresh_token|client_id)=([A-Za-z0-9._~-]+)$/
/** The sign-in renewal, exactly: the refresh grant with its token and client, each once, as a plain form (D6); no byte-order mark, empty pair, encoded key or malformed escape. */
function picheRenewal(method, url, payload) {
  if (method !== 'POST' || url.pathname !== PICHE_RENEWAL.path || url.search || url.hash) return false
  payload = readPayload(payload)
  const data = payload?.data
  if (!/^application\/x-www-form-urlencoded(\s*;\s*charset=utf-8)?$/i.test(payload?.contentType ?? '') || !Buffer.isBuffer(data) || data.length === 0 || data.length > PICHE_BODY_LIMIT) return false
  const fields = new Map()
  for (const pair of data.toString('latin1').split('&')) {
    const field = RENEWAL_FIELD.exec(pair)
    if (!field || fields.has(field[1])) return false
    fields.set(field[1], field[2])
  }
  return fields.size === 3 && fields.get('grant_type') === 'refresh_token' && fields.get('client_id') === PICHE_RENEWAL.client
}
const queryKeys = url => [...new Set([...url.searchParams.keys()].filter(key => /^[A-Za-z0-9_-]{1,80}$/.test(key)))].sort().slice(0, 40)
/** On a bound Piche origin the contract alone decides (D4): page GETs, reviewed queries on the API, the renewal on sign-in; all else held. */
function classifyPiche(contract, method, url, payload) {
  const { page, api, signIn } = contract.origins, base = { method, origin: url.origin, queryKeys: queryKeys(url) }
  const result = (path, classification, reviewed, body) => ({ request: body ? { ...base, path, body } : { ...base, path }, classification, activity: null, reviewed })
  if (url.username || url.password) return result('/[unclassified]', 'unknown', false)
  if (url.origin === page) return method === 'GET' ? result('/[unreviewed]', 'read', false) : result('/[unclassified]', 'unknown', false)
  if (url.origin === api) {
    const graphql = picheGraphql(method, url, payload)
    return result(url.pathname === PICHE_GRAPHQL_PATH ? PICHE_GRAPHQL_PATH : '/[unclassified]', graphql.reviewed ? 'read' : 'unknown', graphql.reviewed, graphql.body ?? undefined)
  }
  if (url.origin === signIn && picheRenewal(method, url, payload)) return result(PICHE_RENEWAL.path, 'read', true, { kind: 'form', grant: 'refresh_token' })
  return result(url.pathname === PICHE_RENEWAL.path ? PICHE_RENEWAL.path : '/[unclassified]', 'unknown', false)
}
/**
 * The host re-check from recorded metadata alone (D9): it never sees a body, so a Piche read passes only with the
 * relay's closed body detail naming a reviewed template or the renewal, on the contract's literal paths.
 */
export function classifyQaMeta(contract, meta, ownOrigins = []) {
  const covered = picheBound(contract, ownOrigins) && Object.values(contract.origins).includes(meta.origin)
  if (!covered) {
    const classified = classifyQaRequest(contract, meta.method, meta.origin + meta.path, ownOrigins)
    return meta.body === undefined ? classified : { ...classified, request: { ...classified.request, body: meta.body }, classification: 'unknown', activity: null, reviewed: false }
  }
  const { page, api, signIn } = contract.origins, body = meta.body
  const result = (path, classification, reviewed) => ({ request: { ...meta, path }, classification, activity: null, reviewed })
  if (meta.origin === page) return meta.method === 'GET' && body === undefined ? result('/[unreviewed]', 'read', false) : result('/[unclassified]', 'unknown', false)
  const graphql = meta.origin === api && meta.method === 'POST' && meta.path === PICHE_GRAPHQL_PATH && !meta.queryKeys.length && body?.kind === 'graphql' &&
    body.operation === 'query' && typeof body.name === 'string' && Object.hasOwn(PICHE_READS, body.name)
  const renewal = meta.origin === signIn && meta.method === 'POST' && meta.path === PICHE_RENEWAL.path && !meta.queryKeys.length && body?.kind === 'form' && body.grant === 'refresh_token'
  return graphql || renewal ? result(meta.path, 'read', true) : result([PICHE_GRAPHQL_PATH, PICHE_RENEWAL.path].includes(meta.path) ? meta.path : '/[unclassified]', 'unknown', false)
}

/** `ownOrigins` are the picked account's sites: with no reviewed contract there, a GET is an audited page read and every other method stays held (d71). */
export function classifyQaRequest(contract, method, address, ownOrigins = [], payload = null) {
  const parsed = new URL(address)
  if (isPiche(contract) && Object.values(contract.origins).includes(parsed.origin)) {
    if (picheBound(contract, ownOrigins)) return classifyPiche(contract, method, parsed, payload)
    contract = null
  }
  const url = parsed, matches = contract?.id === id && contract.sha256 === sha256 && contract.origin === url.origin
  const rule = matches && !url.search && !url.username && !url.password && rules.find(item => item[0] === method && item[1] === url.pathname)
  const page = !contract && method === 'GET' && !url.username && !url.password && ownOrigins.includes(url.origin)
  // Unknown path segments may themselves contain secrets. Keep only the reviewed literal paths.
  const meta = { method, origin: url.origin, path: rule ? url.pathname : page ? '/[unreviewed]' : '/[unclassified]',
    queryKeys: [...new Set([...url.searchParams.keys()].filter(key => /^[A-Za-z0-9_-]{1,80}$/.test(key)))].sort().slice(0, 40) }
  return { request: meta, classification: rule ? (rule[2] === 'read' ? 'read' : 'activity') : page ? 'read' : 'unknown', activity: rule && rule[2] !== 'read' ? rule[2] : null, reviewed: Boolean(rule) }
}

const escapeHtml = text => text.replace(/[&"<>']/g, char => `&#${char.charCodeAt(0)};`)
/** A page redirect returns as a tiny page that navigates again, so the next hop crosses the same route and audit with the redirect's cookies kept. */
export async function fulfillRedirect(route, response) {
  const request = route.request(), location = response.headers().location
  if (!request.isNavigationRequest() || request.method() !== 'GET' || !location) return false
  let target
  try { target = new URL(location, request.url()) } catch { return false }
  if (!['http:', 'https:'].includes(target.protocol)) return false
  const cookies = response.headersArray().filter(header => header.name.toLowerCase() === 'set-cookie').map(header => header.value)
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies.join('\n') } : {}) },
    body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escapeHtml(target.href)}">` })
  return true
}
/** Route.continue() lets the browser follow redirects unseen, so every request is fetched here: a page redirect is routed again, any other redirect is blocked. */
export async function passQaRequest(route) {
  let response
  // An unreachable site is the page's own failure, as under continue(); it is not an audit gap.
  try { response = await route.fetch({ maxRedirects: 0, maxRetries: 0 }) } catch { await route.abort('failed'); return }
  const status = response.status()
  if (status >= 300 && status < 400) { if (!await fulfillRedirect(route, response)) await route.abort('blockedbyclient'); return }
  await route.fulfill({ response })
}

/** Broker methods are bound to one registered relay/run/account, never taken from page content. */
export async function gateQaRequest(route, broker, closeContext) {
  let use = null, sent = false
  try {
    const request = route.request(), policy = await broker.policy()
    if (!policy.active) { await route.abort('blockedbyclient'); await closeContext(); return }
    const classified = classifyQaRequest(policy.contract, request.method(), request.url(), policy.origins, qaRequestPayload(request))
    if (classified.classification === 'unknown') {
      await broker.hold(classified.request, 'unsupported-request')
      await route.abort('blockedbyclient'); return
    }
    if (classified.classification === 'activity') {
      const operation = { id: randomUUID(), activity: classified.activity, request: classified.request,
        requestSha256: createHash('sha256').update(JSON.stringify(classified.request)).digest('hex') }
      const reserved = await broker.reserve(operation)
      if (!reserved.allowed) {
        await broker.hold(classified.request, reserved.reason)
        await route.abort('blockedbyclient'); return
      }
      use = reserved.use.id
      const committed = await broker.send(use)
      if (!committed.allowed) { await route.abort('blockedbyclient'); await closeContext(); return }
      sent = true
    } else await broker.observe(classified.request)
    // No automatic retries or redirect hops may duplicate a committed activity.
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 })
    const status = response.status()
    if (use) await broker.settle(use, status >= 300 && status < 400 ? 'uncertain' : status >= 200 && status < 300 ? 'succeeded' : 'failed', status)
    // A sign-in renewal's outcome is part of its audit (D6): its status only, never the reply.
    else if (classified.request.body?.kind === 'form') await broker.observe(classified.request, status)
    // An activity's redirect stays uncertain; a read's page redirect is routed again as a new request.
    if (status >= 300 && status < 400) { if (use || !await fulfillRedirect(route, response)) await route.abort('blockedbyclient'); return }
    await route.fulfill({ response })
  } catch {
    if (use && sent) await broker.settle(use, 'uncertain', null).catch(() => {})
    // A lost reserve/send reply never authorizes a send; it stays spent in the host ledger.
    await route.abort('blockedbyclient').catch(() => {})
    await broker.gap('broker-unreachable').catch(() => {})
    await closeContext()
  }
}
