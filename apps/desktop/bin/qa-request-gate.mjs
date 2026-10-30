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
    if (status >= 300 && status < 400) { await route.abort('blockedbyclient'); return }
    await route.fulfill({ response })
  } catch {
    if (use && sent) await broker.settle(use, 'uncertain', null).catch(() => {})
    // A lost reserve/send reply never authorizes a send; it stays spent in the host ledger.
    await route.abort('blockedbyclient').catch(() => {})
    await broker.gap('broker-unreachable').catch(() => {})
    await closeContext()
  }
}
