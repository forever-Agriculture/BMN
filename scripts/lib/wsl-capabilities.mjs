// MODULE: wsl-capabilities.mjs - a WSL session's scoped authority: minted natively, never widened, revocable
// Preparatory (Story 53.5): a pure model, not wired to BMN. The bridge channel that would carry these requests stays
// reserved until it is designed and reviewed. Native BMN mints a fresh credential per session incarnation and keeps only
// its digest; every request is judged by the transport it arrived on, never by identity the guest claims.
import { createHash, randomBytes } from 'node:crypto'
import { confineGuestPath, qualifiedGuestPath } from './wsl-discovery.mjs'
import { ProtocolError } from './wsl-session-protocol.mjs'

const IDENTIFIER = /^[A-Za-z0-9_:-]{1,128}$/u
const SECRET = /^[0-9a-f]{64}$/u
const REQUEST_KEYS = ['operation', 'path', 'secret', 'sequence']
const digest = (secret) => createHash('sha256').update(secret, 'utf8').digest('hex')
const refused = (code, reason) => ({ ok: false, code, reason })

export class WslCapabilities {
  /** @type {Map<string, { sessionId: string, incarnationId: string, distributionId: string, roots: object[], operations: Set<string>, sequence: number }>} */
  #records = new Map()
  #ceiling
  #random

  /**
   * @param {{ ceiling: string[], random?: (bytes: number) => Buffer }} options `ceiling` is the most any WSL session may
   *   do (at most what a native session's own credential may do); a grant can only narrow it.
   */
  constructor({ ceiling, random = randomBytes }) {
    this.#ceiling = new Set(ceiling)
    this.#random = random
  }

  /**
   * A credential for one session incarnation in one distribution, limited to `operations` and to paths below `roots`
   * (Linux paths in that distribution). It replaces any credential the session held. The secret is returned once,
   * for the session's private bootstrap frame; it never goes into argv, environment listings or logs.
   */
  mint({ sessionId, incarnationId, distributionId, roots, operations }) {
    if (typeof sessionId !== 'string' || !IDENTIFIER.test(sessionId) ||
      typeof incarnationId !== 'string' || !IDENTIFIER.test(incarnationId)) throw new ProtocolError('PROTOCOL', 'session identity is not valid')
    const scoped = (Array.isArray(roots) ? roots : []).map((root) => qualifiedGuestPath(distributionId, root))
    if (scoped.length === 0) throw new ProtocolError('PROTOCOL', 'a credential needs at least one authorized root')
    if (!Array.isArray(operations)) throw new ProtocolError('PROTOCOL', 'operations are a list')
    for (const operation of operations) {
      if (!this.#ceiling.has(operation)) throw new ProtocolError('AUTH', `"${String(operation).slice(0, 64)}" is beyond what a WSL session may do`)
    }
    this.revoke(sessionId)
    const secret = this.#random(32).toString('hex')
    this.#records.set(digest(secret), { sessionId, incarnationId, distributionId, roots: scoped, operations: new Set(operations), sequence: 0 })
    return { secret }
  }

  /**
   * One request. `channel` is what native BMN knows about the transport it arrived on (`{ sessionId, incarnationId }`);
   * `request` is exactly `{ secret, sequence, operation, path? }` from the guest. Sequences must strictly increase, and
   * an authenticated request uses up its sequence even when it is then denied. A path is always a path in the
   * credential's own distribution and must lie below one of its roots.
   */
  authorize(channel, request) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) return refused('PROTOCOL', 'a request is an object')
    const extra = Object.keys(request).filter((key) => !REQUEST_KEYS.includes(key))
    if (extra.length > 0) return refused('PROTOCOL', `unexpected request field "${extra[0].slice(0, 32)}"`)
    if (typeof request.secret !== 'string' || !SECRET.test(request.secret)) return refused('AUTH', 'the credential is not valid')
    const record = this.#records.get(digest(request.secret))
    if (!record) return refused('AUTH', 'the credential is not valid or was revoked')
    if (channel?.sessionId !== record.sessionId || channel?.incarnationId !== record.incarnationId) {
      return refused('AUTH', 'the credential belongs to another session')
    }
    if (!Number.isSafeInteger(request.sequence) || request.sequence <= record.sequence) return refused('AUTH', 'the request is replayed or out of order')
    record.sequence = request.sequence
    if (!record.operations.has(request.operation)) return refused('DENIED', 'the operation is not granted to this session')
    if (request.path === undefined) return { ok: true, operation: request.operation }
    let target
    try {
      target = qualifiedGuestPath(record.distributionId, request.path)
    } catch (error) {
      return refused('PROTOCOL', error instanceof ProtocolError ? error.reason : 'the path is not valid')
    }
    for (const root of record.roots) {
      try {
        return { ok: true, operation: request.operation, distributionId: record.distributionId, root: root.path, segments: confineGuestPath(root, target) }
      } catch {
        // Not below this root; try the next.
      }
    }
    return refused('DENIED', 'the path is outside the roots granted to this session')
  }

  /** Stop and disconnect: the session's credential stops working at once. Returns how many were revoked. */
  revoke(sessionId) {
    let revoked = 0
    for (const [key, record] of this.#records) {
      if (record.sessionId === sessionId) {
        this.#records.delete(key)
        revoked += 1
      }
    }
    return revoked
  }
}
