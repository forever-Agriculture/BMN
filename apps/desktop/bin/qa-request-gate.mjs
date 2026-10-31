// MODULE: qa-request-gate.mjs - reviewed site requests cross the durable broker before any network send
import { createHash, randomUUID } from 'node:crypto'

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

export function classifyQaRequest(contract, method, address) {
  const url = new URL(address), matches = contract?.id === id && contract.sha256 === sha256 && contract.origin === url.origin
  const rule = matches && !url.search && !url.username && !url.password && rules.find(item => item[0] === method && item[1] === url.pathname)
  // Unknown path segments may themselves contain secrets. Keep only the reviewed literal paths.
  const meta = { method, origin: url.origin, path: rule ? url.pathname : '/[unclassified]',
    queryKeys: [...new Set([...url.searchParams.keys()].filter(key => /^[A-Za-z0-9_-]{1,80}$/.test(key)))].sort().slice(0, 40) }
  return { request: meta, classification: !rule ? 'unknown' : rule[2] === 'read' ? 'read' : 'activity', activity: rule && rule[2] !== 'read' ? rule[2] : null }
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
/** Route.continue() lets the browser follow redirects unseen; a top-level GET is fetched here so each hop is routed again. */
export async function passQaRequest(route) {
  const request = route.request()
  if (!request.isNavigationRequest() || request.method() !== 'GET') { await route.continue(); return }
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
    const classified = classifyQaRequest(policy.contract, request.method(), request.url())
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
