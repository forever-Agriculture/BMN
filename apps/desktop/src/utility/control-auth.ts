// MODULE: control-auth.ts - in-memory owner and HMAC session credentials for the local control socket
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type ControlScope =
  | { kind: 'owner' }
  | { kind: 'session'; sessionId: string; incarnationId: string }

const SECRET_BYTES = 32
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const MAC_PATTERN = /^[0-9a-f]{64}$/
const SESSION_TOKEN_PREFIX = 's1'
const OWNER_TOKEN_FILE = 'owner.token'
const MAX_TOKEN_LENGTH = 512

/** Token segments are dot-separated, so identifiers may never contain '.' (or anything outside this set). */
const TOKEN_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/

function isTokenIdentifier(value: string): boolean {
  return TOKEN_IDENTIFIER_PATTERN.test(value)
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

export class ControlAuth {
  readonly ownerToken: string
  private readonly secret: Buffer

  /** secret: 32 random bytes kept only in memory for this host lifetime. */
  constructor(secret: Buffer = randomBytes(SECRET_BYTES)) {
    if (secret.byteLength < SECRET_BYTES) {
      throw new RangeError(`Control secret must be at least ${SECRET_BYTES} bytes`)
    }
    this.secret = Buffer.from(secret)
    this.ownerToken = randomBytes(SECRET_BYTES).toString('hex')
  }

  sessionToken(sessionId: string, incarnationId: string): string {
    if (!isTokenIdentifier(sessionId) || !isTokenIdentifier(incarnationId)) {
      throw new RangeError('Session and incarnation identifiers must match [A-Za-z0-9_:-]{1,128}')
    }
    return `${SESSION_TOKEN_PREFIX}.${sessionId}.${incarnationId}.${this.mac(sessionId, incarnationId)}`
  }

  verify(token: unknown): ControlScope | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null
    if (OWNER_TOKEN_PATTERN.test(token)) {
      return sameText(token, this.ownerToken) ? { kind: 'owner' } : null
    }
    const parts = token.split('.')
    if (parts.length !== 4) return null
    const [prefix, sessionId, incarnationId, mac] = parts as [string, string, string, string]
    if (
      prefix !== SESSION_TOKEN_PREFIX ||
      !isTokenIdentifier(sessionId) ||
      !isTokenIdentifier(incarnationId) ||
      !MAC_PATTERN.test(mac)
    ) {
      return null
    }
    if (!sameText(mac, this.mac(sessionId, incarnationId))) return null
    return { kind: 'session', sessionId, incarnationId }
  }

  private mac(sessionId: string, incarnationId: string): string {
    return createHmac('sha256', this.secret)
      .update(`session:${sessionId}:${incarnationId}`)
      .digest('hex')
  }
}

export async function writeOwnerToken(directory: string, token: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const destination = join(directory, OWNER_TOKEN_FILE)
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${token}\n`, 'utf8')
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return destination
}
