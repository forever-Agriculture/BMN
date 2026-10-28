// MODULE: browser-accounts.test.mjs - Encrypted-profile contracts and credential boundaries with synthetic values only.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { keyringCall } from '../../apps/desktop/bin/browser-keyring.mjs'
import { browserLaunchHelper, processIdentity } from '../../apps/desktop/bin/browser-process.mjs'
vi.mock('node:child_process', async importOriginal => { const actual = await importOriginal(); return { ...actual, spawn: vi.fn(actual.spawn) } })
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { BrowserAccountsStore, profileArchive, restoreArchive } from '../../apps/desktop/bin/browser-accounts-store.mjs'
import { pageAddress, signedInVerdict } from '../../apps/desktop/bin/browser-accounts-engine.mjs'
import { AccountBrowserRelay, authenticatorCode, safeHeaders } from '../../apps/desktop/bin/browser-account-relay.mjs'
import { accountBrowserDefinition, isAccountBrowser } from '../../apps/desktop/bin/agents-tools.mjs'
const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-account-unit-')); roots.push(root)
  const runtime = mkdtempSync('/dev/shm/bmn-account-unit-'); roots.push(runtime)
  const secrets = new Map(); let locked = false
  const keyring = async (op, id, kind, value) => {
    if (locked) throw new Error('locked')
    const key = id + ':' + kind
    if (op === 'set') { secrets.set(key, value); return true }
    if (op === 'delete') { secrets.delete(key); return null }
    return secrets.get(key) ?? null
  }
  const store = new BrowserAccountsStore({ environment: { HOME: root, BMN_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: runtime }, keyring })
  return { store, secrets, root, runtime, lock: () => { locked = true }, unlock: () => { locked = false } }
}
function seed(lease, value = 'synthetic-session') { mkdirSync(join(lease.profile, 'Default'), { recursive: true }); writeFileSync(join(lease.profile, 'Default', 'Cookies'), value) }
describe('keyring process timeout', () => {
  it('stops a stalled keyring helper through verified pidfd without ChildProcess.kill', async () => {
    const { spawn: realSpawn, spawnSync: realSpawnSync } = await vi.importActual('node:child_process')
    const call = process.env.BMN_ACCOUNTS_KEYRING_SOURCE ? (await import(process.env.BMN_ACCOUNTS_KEYRING_SOURCE)).keyringCall : keyringCall
    const { store } = fixture()
    let child, entry, closed, numericStop = false
    spawn.mockImplementationOnce((command, args, options) => {
      child = realSpawn('/usr/bin/python3', ['-c', 'import time; time.sleep(60)'], options)
      entry = processIdentity(child.pid)
      closed = new Promise(ok => child.once('close', ok))
      child.kill = () => { numericStop = true; return false }
      return child
    })
    try {
      await expect(call('get', 'synthetic', 'credentials', undefined, { environment: store.environment })).rejects.toMatchObject({ code: 'KEYRING_LOCKED' })
      expect(numericStop).toBe(false)
      let alive = false
      try { const stat = readFileSync(`/proc/${entry.pid}/stat`, 'utf8').split(') ').at(-1).split(' '); alive = stat[0] !== 'Z' && stat[19] === entry.ticks } catch { /* gone */ }
      expect(alive).toBe(false)
      await closed
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = realSpawnSync('/usr/bin/python3', [browserLaunchHelper(), '--terminate'], { env: store.environment,
          input: JSON.stringify({ owner: processIdentity(), child: entry }), stdio: ['pipe', 'ignore', 'ignore'] })
        expect(stopped.status).toBe(0); await closed
      }
    }
  }, 25_000)
})
describe('encrypted account profile versions', () => {
  it('claims and wipes an anonymous RAM profile without touching a locked keyring or creating an account', () => {
    const { store, lock } = fixture(); lock()
    let keyringCalls = 0
    store.keyring = () => { keyringCalls++; throw new Error('locked') }
    const lease = store.anonymous()
    expect(keyringCalls).toBe(0)
    expect(store.list()).toEqual([])
    expect(store.claims()).toEqual([lease])
    expect(statSync(lease.profile).mode & 0o777).toBe(0o700)
    store.discard(lease)
    expect(store.claims()).toEqual([])
    expect(readdirSync(store.runtime()).filter(name => name.startsWith('anonymous-'))).toEqual([])
  })
  it('erases an anonymous folder if its claim cannot be published', () => {
    const { store } = fixture()
    store.claim = () => { throw new Error('synthetic claim failure') }
    expect(() => store.anonymous()).toThrow('synthetic claim failure')
    expect(store.claims()).toEqual([])
    expect(readdirSync(store.runtime()).filter(name => name.startsWith('anonymous-'))).toEqual([])
  })
  it('rechecks the keyring before publishing an authenticated lease', async () => {
    const f = fixture(), meta = await f.store.create('Example', 'https://example.test'), lease = await f.store.checkout(meta.id)
    seed(lease); await f.store.publish(lease, { state: 'Signed in' })
    const before = f.store.current(meta.id)
    f.lock()
    await expect(f.store.publish(lease, { state: 'Signed in' })).rejects.toMatchObject({ code: 'KEYRING_LOCKED' })
    expect(f.store.current(meta.id)).toBe(before)
    expect(f.store.metadata(meta.id).state).toBe('Keyring locked')
    f.unlock(); f.store.discard(lease)
  })
  it('keeps cookies and IndexedDB bytes in an authenticated archive, with owner-only modes and no cleartext in data', async () => {
    const { store } = fixture(), token = randomBytes(32).toString('hex')
    const meta = await store.create('Example', 'https://example.test/start'), lease = await store.checkout(meta.id)
    seed(lease, token)
    mkdirSync(join(lease.profile, 'Default', 'IndexedDB')); writeFileSync(join(lease.profile, 'Default', 'IndexedDB', 'record'), token)
    expect(await store.publish(lease, { state: 'Signed in' })).toBe(true)
    store.discard(lease)
    for (const name of readdirSync(store.folder(meta.id))) {
      const file = join(store.folder(meta.id), name)
      if (name === 'current') continue
      expect(readFileSync(file).includes(Buffer.from(token))).toBe(false)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    expect(statSync(store.root).mode & 0o777).toBe(0o700)
    const copy = await store.checkout(meta.id)
    expect(readFileSync(join(copy.profile, 'Default', 'Cookies'), 'utf8')).toBe(token)
    expect(readFileSync(join(copy.profile, 'Default', 'IndexedDB', 'record'), 'utf8')).toBe(token)
    store.discard(copy)
  })
  it('rejects tampering before any decrypted profile is returned', async () => {
    const { store } = fixture(), meta = await store.create('Example', 'https://example.test'), lease = await store.checkout(meta.id)
    seed(lease); await store.publish(lease, { state: 'Signed in' }); store.discard(lease)
    const path = join(store.folder(meta.id), store.current(meta.id)), data = readFileSync(path); data[25] ^= 1; writeFileSync(path, data)
    await expect(store.checkout(meta.id)).rejects.toThrow()
  })
  it('never overwrites a newer version from a stale parallel lease', async () => {
    const { store } = fixture(), meta = await store.create('Example', 'https://example.test'), first = await store.checkout(meta.id)
    seed(first, 'one'); await store.publish(first, { state: 'Signed in' }); store.discard(first)
    const a = await store.checkout(meta.id), b = await store.checkout(meta.id)
    seed(a, 'two'); seed(b, 'three')
    expect(await store.publish(a, { state: 'Signed in' })).toBe(true)
    expect(await store.publish(b, { state: 'Signed in' })).toBe(false)
    store.discard(a); store.discard(b)
    const current = await store.checkout(meta.id); expect(readFileSync(join(current.profile, 'Default/Cookies'), 'utf8')).toBe('two'); store.discard(current)
  })
  it('separates two accounts for the same site, and Cancel/removal can erase all versions and keyring material', async () => {
    const { store, secrets } = fixture(), a = await store.create('A', 'https://example.test'), b = await store.create('B', 'https://example.test')
    expect(a.id).not.toBe(b.id)
    await expect(store.create('A', 'https://example.test')).rejects.toThrow('already')
    await store.remove(a.id); expect(store.list().map(row => row.name)).toEqual(['B'])
    expect([...secrets.keys()].some(key => key.startsWith(a.id))).toBe(false)
    await store.remove(b.id); expect(store.list()).toEqual([])
  })
  it('fails closed on missing/locked keyring and restores the prior state after unlock', async () => {
    const f = fixture(), meta = await f.store.create('Example', 'https://example.test')
    f.lock(); await expect(f.store.checkout(meta.id)).rejects.toMatchObject({ code: 'KEYRING_LOCKED' })
    expect(f.store.metadata(meta.id).state).toBe('Keyring locked')
    f.unlock(); const lease = await f.store.checkout(meta.id); expect(f.store.metadata(meta.id).state).toBe('Not confirmed'); f.store.discard(lease)
    f.lock(); await expect(f.store.create('Other', 'https://example.test')).rejects.toMatchObject({ code: 'KEYRING_LOCKED' }); expect(f.store.list()).toHaveLength(1)
  })
  it('revokes loaded credentials on unmark, removal and keyring lock', async () => {
    const f = fixture(), meta = await f.store.create('Example', 'https://example.test')
    f.store.writeMeta({ ...meta, signInOrigins: ['https://login.test'] })
    await f.store.mark(meta.id, { username: 'synthetic', password: 'synthetic-password' })
    expect((await f.store.credentials(meta.id)).password).toBe('synthetic-password')
    f.lock(); await expect(f.store.credentials(meta.id)).rejects.toMatchObject({ code: 'KEYRING_LOCKED' }); f.unlock()
    await f.store.unmark(meta.id); await expect(f.store.credentials(meta.id)).rejects.toMatchObject({ code: 'NOT_MARKED' })
    expect(JSON.stringify(f.store.list())).not.toContain('synthetic-password')
  })
  it.each(['unmark', 'remove'])('revokes an in-flight credential lookup after completed %s', async action => {
    const { store } = fixture(), meta = await store.create('Race', 'https://example.test')
    store.writeMeta({ ...meta, signInOrigins: ['https://example.test'] })
    await store.mark(meta.id, { username: 'synthetic', password: 'private' })
    const original = store.keyring
    let release, reached
    const waiting = new Promise(ok => { reached = ok })
    const gate = new Promise(ok => { release = ok })
    store.keyring = async (...args) => {
      const value = await original(...args)
      if (args[0] === 'get' && args[2] === 'credentials') { reached(); await gate }
      return value
    }
    const pending = store.credentials(meta.id)
    await waiting; await store[action](meta.id); release()
    await expect(pending).rejects.toMatchObject({ code: action === 'unmark' ? 'NOT_MARKED' : 'ACCOUNT_REMOVED' })
  })
  it('queues at most one failed-sign-in notice per occurrence and permits a new one after recovery', async () => {
    const { store } = fixture(), meta = await store.create('Notice', 'https://example.test')
    store.writeMeta({ ...meta, marked: true })
    await store.setState(meta.id, 'Sign in again', { notify: true })
    const first = store.metadata(meta.id)
    store.writeMeta({ ...first, noticePending: false, noticeDelivered: first.occurrence })
    await store.setState(meta.id, 'Sign in again', { notify: true })
    expect(store.metadata(meta.id).noticePending).toBe(false)
    await store.setState(meta.id, 'Signed in')
    await store.setState(meta.id, 'Sign in again', { notify: true })
    expect(store.metadata(meta.id).noticePending).toBe(true)
    expect(store.metadata(meta.id).occurrence).not.toBe(first.occurrence)
  })
  it('withdraws a queued keyring-lock notice when unlock restores the prior state', async () => {
    const f = fixture(), meta = await f.store.create('Example', 'https://example.test')
    f.lock(); await expect(f.store.checkout(meta.id)).rejects.toMatchObject({ code: 'KEYRING_LOCKED' })
    expect(f.store.metadata(meta.id).noticePending).toBe(true)
    f.unlock(); const lease = await f.store.checkout(meta.id); f.store.discard(lease)
    expect(f.store.metadata(meta.id).state).toBe('Not confirmed')
    expect(f.store.metadata(meta.id).noticePending).toBe(false)
  })
  it('leaves old/new whole versions at publication interruptions and cleans orphan versions', async () => {
    const { store } = fixture(), meta = await store.create('Example', 'https://example.test'), first = await store.checkout(meta.id)
    seed(first); await store.publish(first, { state: 'Signed in' }); store.discard(first)
    for (const step of ['encrypted', 'version', 'link', 'current']) {
      const lease = await store.checkout(meta.id); seed(lease, 'new-' + step)
      await expect(store.publish(lease, { state: 'Signed in' }, { checkpoint: at => { if (at === step) throw new Error('interrupt') } })).rejects.toThrow('interrupt')
      store.discard(lease); await store.cleanup()
      const next = await store.checkout(meta.id); expect(readFileSync(join(next.profile, 'Default/Cookies'), 'utf8')).toMatch(/synthetic-session|new-/); store.discard(next)
      expect(readdirSync(store.folder(meta.id)).filter(name => name.startsWith('v-'))).toHaveLength(1)
    }
  })
  it('rejects non-private runtime directories and invalid start pages', async () => {
    const f = fixture(); chmodSync(f.root, 0o755); f.store.environment.XDG_RUNTIME_DIR = f.root
    expect(() => f.store.runtime()).toThrow('RAM')
    await expect(f.store.create('A', 'file:///etc/passwd')).rejects.toThrow('http')
    await expect(f.store.create('A', 'https://name:password@example.test')).rejects.toThrow('credentials')
  })
  it('refuses insufficient real tmpfs space before decrypting or creating a lease', async () => {
    const { store, runtime } = fixture(), meta = await store.create('Example', 'https://example.test'), lease = await store.checkout(meta.id)
    seed(lease); await store.publish(lease, { state: 'Signed in' }); store.discard(lease)
    const space = statfsSync(runtime)
    // A sparse encrypted file exercises the capacity guard without consuming shared RAM.
    truncateSync(join(store.folder(meta.id), store.current(meta.id)), Math.floor(space.bavail * space.bsize / 12) + 1)
    await expect(store.checkout(meta.id)).rejects.toMatchObject({ code: 'RUNTIME_FULL' })
    expect(readdirSync(store.runtime()).filter(name => name.startsWith('s-'))).toEqual([])
    expect(store.claims()).toEqual([])
  })
  it('excludes only caches/singleton artifacts from the profile archive', () => {
    const f = fixture(), input = join(f.root, 'profile'), output = join(f.root, 'copy')
    mkdirSync(join(input, 'Default', 'Cache'), { recursive: true }); writeFileSync(join(input, 'Default', 'Cache', 'discard'), 'cache'); writeFileSync(join(input, 'Default', 'Cookies'), 'cookie')
    mkdirSync(output); restoreArchive(profileArchive(input), output)
    expect(readdirSync(join(output, 'Default'))).toEqual(['Cookies'])
  })
})
describe('signed-in heuristic', () => {
  it('never uses a restored blank tab as an HTTP landing page', () => {
    expect(pageAddress('about:blank')).toBe('')
    expect(pageAddress('https://example.test/app?token=synthetic#page')).toBe('https://example.test/app')
  })
  const signed = { address: 'https://app.test/app', fields: false }
  it.each([
    [{ address: 'https://app.test/login', fields: true }, true],
    [{ address: 'https://app.test/app', fields: true }, true],
    [{ address: 'https://login.test/', fields: false }, true],
    [{ address: 'https://app.test/app', fields: false }, false]
  ])('compares actual signed-in and anonymous pages', (fresh, expected) => expect(signedInVerdict(signed, fresh, signed.address)).toBe(expected))
  it('keeps the consultant’s noncanonical-start mismatch as Not confirmed', () => expect(signedInVerdict({ address: 'https://app.test/', fields: false }, { address: 'https://app.test/login', fields: true }, signed.address)).toBe(false))
  it('never confirms a page with password/code fields', () => expect(signedInVerdict({ ...signed, fields: true }, { address: 'https://app.test/login', fields: true }, signed.address)).toBe(false))
})
describe('agent privacy boundaries', () => {
  it('returns only name, sites and state to an agent, excluding tokenized start URLs', async () => {
    const { AccountBrowserRelay: Relay } = process.env.BMN_ACCOUNTS_RELAY_SOURCE
      ? await import(process.env.BMN_ACCOUNTS_RELAY_SOURCE) : { AccountBrowserRelay }
    const relay = new Relay({ allowed: true, store: { list: () => [{ name: 'Example', sites: ['https://example.test'], state: 'Signed in', start: 'https://example.test/?token=synthetic-private', signInOrigins: ['https://login.test'] }] } })
    const answer = await relay.tool('browser_accounts')
    expect(JSON.parse(answer.content[0].text)).toEqual([{ name: 'Example', sites: ['https://example.test'], state: 'Signed in' }])
    expect(JSON.stringify(answer)).not.toContain('synthetic-private')
  })
  it('emits a relay only for proven private app settings, keeping public apps and run-owned tools anonymous', () => {
    expect(accountBrowserDefinition('codex', true).args).toEqual(['browser', 'server', 'codex'])
    expect(accountBrowserDefinition('unknown', true).args).toContain('--isolated')
    expect(accountBrowserDefinition('claude', false).args).toContain('--isolated')
    expect(isAccountBrowser({ id: 'playwright', command: 'bmn', args: ['browser', 'server'] })).toBe(true)
    expect(isAccountBrowser({ id: 'other', command: 'bmn', args: ['browser', 'server'] })).toBe(false)
  })
  it('strips all credential headers case-insensitively', () => expect(safeHeaders({ Cookie: 'private', 'Set-Cookie': 'private', Authorization: 'private', 'Proxy-Authorization': 'private', 'content-type': 'application/json' })).toEqual({ 'content-type': 'application/json' }))
  it('computes the RFC 6238 SHA-1 vector inside BMN', () => expect(authenticatorCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082'))
  it.each([['https://evil.test', 'https://login.test'], ['https://login.test', 'https://evil.test']])('types nothing when the top or frame origin is hostile (%s %s)', async (top, target) => {
    let fills = 0
    const relay = new AccountBrowserRelay({ allowed: true, store: { credentials: async () => ({ password: 'private' }), metadata: () => ({ signInOrigins: ['https://login.test'] }) } })
    relay.id = 'synthetic'; relay.policy = { ensurePage: async () => ({ url: () => top, locator: () => ({ elementHandle: async () => ({ ownerFrame: async () => ({ url: () => target }), evaluate: () => { fills++ }, dispose: async () => {} }) }) }) }
    await expect(relay.secret('input', 'BMN_PASSWORD')).rejects.toThrow(/origins/)
    expect(fills).toBe(0)
  })
  it('refuses tools on marked sign-in origins and keeps secret-bearing history private after unmark', () => {
    const relay = new AccountBrowserRelay({ allowed: true, store: { metadata: () => ({ marked: true, signInOrigins: ['https://login.test'] }) } })
    relay.id = 'synthetic'; relay.protectedOrigins = new Set()
    for (const name of ['browser_run_code_unsafe', 'browser_evaluate', 'browser_network_request', 'browser_console_messages']) expect(() => relay.authorize(name, { url: () => 'https://login.test' })).toThrow(/sign-in origins/)
    relay.secretTyped = true; relay.protectedOrigins = new Set(['https://login.test'])
    relay.store.metadata = () => ({ marked: false })
    expect(() => relay.authorize('browser_evaluate', { url: () => 'https://login.test' })).toThrow(/sign-in origins/)
    expect(() => relay.authorize('browser_evaluate', { url: () => 'https://outside.test' })).not.toThrow()
    for (const name of ['browser_console_messages', 'browser_network_request']) expect(() => relay.authorize(name, { url: () => 'https://outside.test' })).toThrow(/history/)

  })
})
