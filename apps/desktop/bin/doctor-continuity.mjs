// MODULE: doctor-continuity.mjs - Private typed item/context commitments and authenticated immutable result receipts
import { createHmac, timingSafeEqual } from 'node:crypto'

export const CONTINUITY_SCANNER = 'leftovers-item-continuity-v1'
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const uuid = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 10000
const unavailable = () => { throw new Error('continuity unavailable') }
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const equalTag = (a, b) => hex(a) && hex(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

/** Streaming typed, length-prefixed encoding. Object keys are sorted as UTF-8 bytes. */
export function privateTag(key, domain, value) {
  if (!hex(key) || typeof domain !== 'string' || !/^[a-z0-9/-]{1,100}$/.test(domain)) unavailable()
  const hmac = createHmac('sha256', Buffer.from(key, 'hex'))
  let entries = 0, bytes = 0
  const write = (type, data = '') => {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
    bytes += body.length
    if (bytes > 128 * 1024 * 1024) unavailable()
    hmac.update(`${type}${body.length}:`); hmac.update(body)
  }
  const seen = new Set()
  const encode = (v, depth = 0) => {
    if (++entries > 1000000 || depth > 64) unavailable()
    if (v === null) return write('n')
    if (typeof v === 'boolean') return write('b', v ? '1' : '0')
    if (typeof v === 'bigint') return write('i', v.toString())
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) unavailable()
      const body = Buffer.alloc(8); body.writeDoubleBE(v); return write('f', body)
    }
    if (typeof v === 'string') return write('s', v)
    if (v instanceof Uint8Array) return write('x', Buffer.from(v))
    if (typeof v !== 'object' || seen.has(v)) unavailable()
    seen.add(v)
    if (Array.isArray(v)) {
      write('a', String(v.length))
      for (const item of v) encode(item, depth + 1)
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) unavailable()
      const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      write('o', String(keys.length))
      for (const name of keys) { encode(name, depth + 1); encode(v[name], depth + 1) }
    }
    seen.delete(v)
  }
  write('d', `bmn/${CONTINUITY_SCANNER}/${domain}`)
  encode(value)
  return hmac.digest('hex')
}

/** Only item/context subkeys enter the inspection worker. The profile/envelope keys stay in the parent. */
export function deriveContinuityKeys(profileKey, { profileBinding, attemptId }) {
  if (!hex(profileKey) || !hex(profileBinding) || !uuid(attemptId)) unavailable()
  return Object.fromEntries(['item', 'context', 'envelope'].map((purpose) =>
    [purpose, privateTag(profileKey, `derive/${purpose}`, [profileBinding, attemptId])]))
}
export function validWorkerKeys(value) {
  return exact(value, ['item', 'context']) && hex(value.item) && hex(value.context)
}
export function validRowReceipts(value, maximum = 10000) {
  return Array.isArray(value) && value.length <= maximum && value.every((row) => exact(row, ['item', 'itemTag', 'contextTag']) &&
    integer(row.item) && row.item <= maximum && hex(row.itemTag) && hex(row.contextTag)) && new Set(value.map((row) => row.item)).size === value.length
}

export function sealContinuity(rows, result, binding, key) {
  if (!validRowReceipts(rows, result?.leftovers?.length ?? 0) || !hex(key) || !hex(binding?.profileBinding) || !uuid(binding?.attemptId)) unavailable()
  const envelope = { schema: 1, scannerId: CONTINUITY_SCANNER, profileBinding: binding.profileBinding, attemptId: binding.attemptId,
    resultTag: privateTag(key, 'result', result), rows: rows.map((row) => ({ ...row })) }
  return { ...envelope, tag: privateTag(key, 'envelope', envelope) }
}
export function validateContinuity(value, result, binding, key) {
  try {
    if (!exact(value, ['schema', 'scannerId', 'profileBinding', 'attemptId', 'resultTag', 'rows', 'tag']) ||
      value.schema !== 1 || value.scannerId !== CONTINUITY_SCANNER || value.profileBinding !== binding.profileBinding ||
      value.attemptId !== binding.attemptId || !validRowReceipts(value.rows, result?.leftovers?.length ?? 0) ||
      !equalTag(value.resultTag, privateTag(key, 'result', result))) return null
    const { tag, ...envelope } = value
    if (!equalTag(tag, privateTag(key, 'envelope', envelope))) return null
    return { ...envelope, rows: value.rows.map((row) => ({ ...row })), tag }
  } catch { return null }
}

/** An original receipt is never refreshed. Ambiguous or missing fresh matches refuse continuity. */
export function matchContinuity(original, fresh) {
  if (!validRowReceipts(original) || !validRowReceipts(fresh)) unavailable()
  const matches = new Map()
  for (const row of fresh) {
    const key = `${row.itemTag}:${row.contextTag}`
    matches.set(key, [...(matches.get(key) ?? []), row.item])
  }
  return original.map((row) => {
    const candidates = matches.get(`${row.itemTag}:${row.contextTag}`) ?? []
    return { item: row.item, current: candidates.length === 1 ? candidates[0] : null }
  })
}
