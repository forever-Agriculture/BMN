// MODULE: control-auth.test.ts - owner and session control credentials verify only when genuine and well-formed
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlAuth, writeOwnerToken } from './control-auth'

const createdRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiterm-control-auth-'))
  createdRoots.add(root)
  return root
}

describe('control auth', () => {
  it('issues a 32-byte hex owner token that verifies as owner scope', () => {
    const auth = new ControlAuth()
    expect(auth.ownerToken).toMatch(/^[0-9a-f]{64}$/)
    expect(auth.verify(auth.ownerToken)).toEqual({ kind: 'owner' })
    expect(new ControlAuth().ownerToken).not.toBe(auth.ownerToken)
  })

  it('signs session tokens with HMAC-SHA256 over the session and incarnation', () => {
    const secret = randomBytes(32)
    const auth = new ControlAuth(secret)
    const token = auth.sessionToken('session-1', 'incarnation-1')
    const expectedMac = createHmac('sha256', secret).update('session:session-1:incarnation-1').digest('hex')

    expect(token).toBe(`s1.session-1.incarnation-1.${expectedMac}`)
    expect(auth.verify(token)).toEqual({ kind: 'session', sessionId: 'session-1', incarnationId: 'incarnation-1' })
    expect(new ControlAuth(secret).verify(token)).toEqual({
      kind: 'session',
      sessionId: 'session-1',
      incarnationId: 'incarnation-1'
    })
  })

  it('rejects forged session tokens', () => {
    const auth = new ControlAuth()
    const token = auth.sessionToken('session-1', 'incarnation-1')
    const mac = token.split('.')[3] as string
    const flipped = `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`

    expect(auth.verify(`s1.session-1.incarnation-1.${flipped}`)).toBeNull()
    expect(auth.verify(`s1.session-2.incarnation-1.${mac}`)).toBeNull()
    expect(auth.verify(`s1.session-1.incarnation-2.${mac}`)).toBeNull()
    expect(new ControlAuth().verify(token)).toBeNull()
    expect(auth.verify(new ControlAuth().ownerToken)).toBeNull()
  })

  it('rejects malformed credentials without throwing', () => {
    const auth = new ControlAuth()
    const mac = (auth.sessionToken('a', 'b').split('.')[3] as string)
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      {},
      ['s1', 'a', 'b', mac],
      '',
      's1.a.b',
      `s2.a.b.${mac}`,
      `s1.a.b.${mac}.extra`,
      `s1..b.${mac}`,
      `s1.a.b.${mac.toUpperCase()}`,
      `s1.a.b.${mac.slice(0, 63)}`,
      auth.ownerToken.toUpperCase(),
      `${auth.ownerToken} `,
      'x'.repeat(10_000)
    ]
    for (const token of malformed) expect(auth.verify(token)).toBeNull()
  })

  it('refuses identifiers that cannot round-trip through the dotted token format', () => {
    const auth = new ControlAuth()
    expect(() => auth.sessionToken('session.1', 'incarnation-1')).toThrow(RangeError)
    expect(() => auth.sessionToken('session-1', '')).toThrow(RangeError)
    expect(() => new ControlAuth(randomBytes(16))).toThrow(RangeError)
  })

  it('writes the owner token atomically with private file and directory modes', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'control')
    const auth = new ControlAuth()

    const path = await writeOwnerToken(directory, auth.ownerToken)
    await writeOwnerToken(directory, auth.ownerToken)

    expect(path).toBe(join(directory, 'owner.token'))
    expect((await readFile(path, 'utf8')).trim()).toBe(auth.ownerToken)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(await readdir(directory)).toEqual(['owner.token'])
  })
})
