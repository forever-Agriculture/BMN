// MODULE: browser-accounts-store.mjs - Encrypted browser profiles, RAM leases and atomic version publication under flock.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { BrowserAccountError, keyringCall, keyringLocked } from './browser-keyring.mjs'
import { browserLaunchHelper, processIdentity } from './browser-process.mjs'
export { browserLaunchHelper, processIdentity } from './browser-process.mjs'

export const ACCOUNT_STATES = ['Signed in', 'Not confirmed', 'Sign in again', 'Keyring locked']
const MAX_PROFILE = 512 * 1024 * 1024
const CACHE = /^(?:Cache|Code Cache|GPUCache|Dawn.*Cache|GrShaderCache|ShaderCache|Crashpad|BrowserMetrics|Singleton.*|DevToolsActivePort)$/u
const ticks = pid => processIdentity(pid).ticks
function live(identity) { return identity && ticks(identity.pid) !== null && ticks(identity.pid) === identity.ticks }
function requireRuntimeSpace(runtime, bytes = 0) {
  const space = statfsSync(runtime)
  if (space.bavail * space.bsize < Math.max(32 * 1024 * 1024, bytes * 12)) throw new BrowserAccountError('RUNTIME_FULL', 'Not enough room in the RAM runtime directory for this browser account.')
}
function privateFolder(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path }
function syncFolder(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
export function atomicJson(path, value) {
  privateFolder(dirname(path))
  const tmp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true }); renameSync(tmp, path); syncFolder(dirname(path)) }
  finally { rmSync(tmp, { force: true }) }
  return JSON.parse(readFileSync(path, 'utf8'))
}
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
export async function withAccountLock(path, action, shared = false) {
  privateFolder(dirname(path))
  const fd = openSync(path, 'a', 0o600); closeSync(fd)
  const lock = spawn('flock', [shared ? '-s' : '-x', path, '/bin/sh', '-c', 'printf L; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] })
  lock.stdin.on('error', () => {})
  await new Promise((ok, no) => { lock.once('error', no); lock.stdout.once('data', ok); lock.once('exit', code => { if (code !== 0) no(new Error('Browser account lock unavailable')) }) })
  try { return await action() } finally { lock.stdin.end(); await new Promise(ok => { if (lock.exitCode !== null) ok(); else lock.once('exit', ok) }) }
}
export function profileArchive(folder) {
  const files = []; let bytes = 0
  function visit(path) {
    for (const name of readdirSync(path)) {
      if (CACHE.test(name)) continue
      const file = join(path, name), stat = lstatSync(file)
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > MAX_PROFILE) throw new BrowserAccountError('PROFILE_TOO_LARGE', 'Browser profile exceeds the 512 MB limit. Clear site caches and try again.')
        files.push([relative(folder, file), readFileSync(file).toString('base64')])
      }
    }
  }
  visit(folder)
  return gzipSync(JSON.stringify(files))
}
export function restoreArchive(archive, folder) {
  const files = JSON.parse(gunzipSync(archive, { maxOutputLength: MAX_PROFILE * 2 }).toString())
  for (const [name, data] of files) {
    const target = resolve(folder, name)
    if (!target.startsWith(`${resolve(folder)}/`)) throw new Error('Invalid profile archive')
    privateFolder(dirname(target)); writeFileSync(target, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 })
  }
}
function encrypt(archive, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  return Buffer.concat([Buffer.from('BMN1'), iv, cipher.update(archive), cipher.final(), cipher.getAuthTag()])
}
function decrypt(blob, key) {
  if (blob.subarray(0, 4).toString() !== 'BMN1') throw new Error('Invalid profile version')
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16)); decipher.setAuthTag(blob.subarray(-16))
  return Buffer.concat([decipher.update(blob.subarray(16, -16)), decipher.final()])
}
export class BrowserAccountsStore {
  constructor({ environment = process.env, keyring = keyringCall, onNotice = () => {} } = {}) {
    this.environment = environment; this.keyring = (op, id, kind, value) => keyring(op, id, kind, value, { environment }); this.onNotice = onNotice
    this.root = join(environment.BMN_DATA_HOME || join(environment.XDG_DATA_HOME || join(environment.HOME, '.local/share'), 'bmn'), 'browser-accounts')
  }
  folder(id) { if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid account id'); return join(this.root, id) }
  lock(id, fn, shared = false) { return withAccountLock(join(this.root, 'locks', `${id}.lock`), fn, shared) }
  metadata(id) { try { return readJson(join(this.folder(id), 'account.json')) } catch { throw new BrowserAccountError('ACCOUNT_REMOVED', 'Browser account no longer exists.') } }
  writeMeta(meta) { return atomicJson(join(this.folder(meta.id), 'account.json'), meta) }
  list() {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter(id => /^[a-f0-9-]{36}$/u.test(id)).flatMap(id => {
      try { return [this.metadata(id)] } catch { return [] }
    }).map(({ id, name, start, landing, origins, state, checked, marked, signInOrigins }) => ({ id, name, start, landing, sites: origins, state, checked, marked, signInOrigins }))
  }
  find(name) { const row = this.list().find(row => row.id === name || row.name === name); if (!row) throw new BrowserAccountError('ACCOUNT_MISSING', 'Browser account was not found.'); return row.id }
  runtime() {
    const root = this.environment.XDG_RUNTIME_DIR
    if (!root || !existsSync(root)) throw new BrowserAccountError('RUNTIME_REQUIRED', 'Browser accounts need XDG_RUNTIME_DIR on a RAM filesystem.')
    const stat = lstatSync(root)
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || Number(statfsSync(root).type) !== 0x01021994) throw new BrowserAccountError('RUNTIME_REQUIRED', 'Browser accounts need an owner-only RAM runtime directory.')
    return privateFolder(join(root, 'b'))
  }
  claim(lease) {
    const runtime = this.runtime()
    if (dirname(lease.folder) !== runtime || lease.profile !== join(lease.folder, 'profile')) throw new Error('Invalid runtime lease')
    atomicJson(join(runtime, '.claims', `${basename(lease.folder)}.json`), lease)
    atomicJson(join(lease.folder, 'lease.json'), lease)
  }
  claims() {
    const folder = join(this.runtime(), '.claims')
    return existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.json')).map(name => readJson(join(folder, name))) : []
  }
  anonymous() {
    const runtime = this.runtime(); requireRuntimeSpace(runtime)
    const folder = mkdtempSync(join(runtime, 'anonymous-'))
    const lease = { ...processIdentity(), folder, profile: join(folder, 'profile'), anonymous: true }
    try { this.claim(lease); privateFolder(lease.profile); return lease }
    catch (error) { this.discard(lease); throw error }
  }
  async key(id, create = false) {
    try {
      let value = await this.keyring('get', id, 'profile-key')
      if (value === null && create) { value = randomBytes(32).toString('base64'); await this.keyring('set', id, 'profile-key', value) }
      if (typeof value !== 'string' || Buffer.from(value, 'base64').length !== 32) throw keyringLocked()
      return Buffer.from(value, 'base64')
    } catch {
      if (existsSync(join(this.folder(id), 'account.json'))) await this.setState(id, 'Keyring locked')
      throw keyringLocked()
    }
  }
  async setState(id, state, { notify = false } = {}) {
    return this.lock(id, () => {
      const meta = this.metadata(id)
      if (state === 'Keyring locked' && meta.state !== state) meta.beforeLock = meta.state
      if (meta.state !== state) {
        meta.state = state
        meta.occurrence = randomUUID()
        if (state === 'Keyring locked' || state === 'Sign in again' && !meta.marked) meta.noticePending = true
      }
      if (notify && meta.noticeDelivered !== meta.occurrence) meta.noticePending = true
      if (meta.noticePending) this.onNotice({ id, name: meta.name, state })
      return this.writeMeta(meta)
    })
  }
  async create(name, start) {
    name = String(name).trim()
    if (!name || name.length > 100 || /[\r\n\0]/u.test(name)) throw new Error('Use an account name of 1–100 characters.')
    const url = new URL(start)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http or https start page without credentials.')
    // No account is made, and no clear-text profile starts, before the keyring has answered.
    const id = randomUUID(); await this.key(id, true)
    try {
      return await withAccountLock(join(this.root, 'names.lock'), () => {
        if (this.list().some(row => row.name === name)) throw new Error('An account already has this name.')
        return this.writeMeta({ id, name, start: url.href, landing: url.href, origins: [url.origin], signInOrigins: [], state: 'Not confirmed', marked: false, checked: null })
      })
    } catch (error) { await this.keyring('delete', id, 'profile-key'); throw error }
  }
  current(id) { try { const v = readlinkSync(join(this.folder(id), 'current')); if (!/^v-[a-f0-9-]+\.enc$/u.test(v)) throw new Error('Invalid version'); return v } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
  async checkout(id, { checkpoint = () => {} } = {}) {
    const key = await this.key(id), runtime = this.runtime()
    return this.lock(id, async () => {
      const meta = this.metadata(id), version = this.current(id)
      const size = version ? lstatSync(join(this.folder(id), version)).size : 0
      requireRuntimeSpace(runtime, size)
      const folder = mkdtempSync(join(runtime, 's-')); chmodSync(folder, 0o700)
      const lease = { ...processIdentity(), id, version, folder, profile: join(folder, 'profile') }
      try {
        // The authoritative claim survives interruption of restoration or of the eventual directory wipe.
        this.claim(lease)
        privateFolder(lease.profile)
        if (version) restoreArchive(decrypt(readFileSync(join(this.folder(id), version)), key), lease.profile)
        await checkpoint('restored', lease)
        if (meta.state === 'Keyring locked') {
          meta.state = meta.beforeLock || 'Not confirmed'
          delete meta.beforeLock
          meta.noticePending = false
          this.writeMeta(meta)
        }
        return lease
      } catch (error) { this.discard(lease); throw error }
    })
  }
  finishLease(lease, mode) {
    if (!lease?.folder || dirname(lease.folder) !== this.runtime()) throw new Error('Invalid runtime lease')
    const answer = spawnSync('/usr/bin/python3', [browserLaunchHelper(), mode], {
      env: this.environment, input: JSON.stringify(lease), encoding: 'utf8', timeout: 25_000, stdio: ['pipe', 'pipe', 'ignore']
    })
    if (answer.status !== 0) throw new BrowserAccountError('BROWSER_BUSY', 'The previous browser could not be closed safely. Try again before opening this account.')
  }
  discard(lease) { this.finishLease(lease, '--discard') }
  async publish(lease, details, { key: heldKey, checkpoint = () => {} } = {}) {
    this.finishLease(lease, '--seal')
    const key = heldKey || await this.key(lease.id)
    const blob = encrypt(profileArchive(lease.profile), key), version = `v-${randomUUID()}.enc`, temp = `.publish-${randomUUID()}`
    // Take the lock before even creating the encrypted temporary, so startup cleanup cannot race it.
    return this.lock(lease.id, async () => {
      const meta = this.metadata(lease.id), folder = this.folder(lease.id)
      if (this.current(lease.id) !== lease.version) return false
      const target = join(folder, temp), link = join(folder, `.current-${randomUUID()}`)
      try {
        writeFileSync(target, blob, { flag: 'wx', mode: 0o600, flush: true }); await checkpoint('encrypted')
        renameSync(target, join(folder, version)); syncFolder(folder); await checkpoint('version')
        symlinkSync(version, link); await checkpoint('link')
        renameSync(link, join(folder, 'current')); syncFolder(folder); await checkpoint('current')
        this.writeMeta({ ...meta, ...details, ...(details.state === 'Signed in' ? { noticePending: false } : {}), checked: details.state === 'Signed in' ? new Date().toISOString() : meta.checked })
        return true
      } finally { rmSync(target, { force: true }); rmSync(link, { force: true }) }
    })
  }
  async mark(id, credentials) {
    const meta = this.metadata(id)
    if (!meta.signInOrigins.length) throw new Error('No sign-in origins were observed. Sign in again before marking this account.')
    await this.key(id)
    if (!credentials || typeof credentials.username !== 'string' || typeof credentials.password !== 'string' || !credentials.password) throw new Error('Enter a user name and password.')
    return this.lock(id, async () => {
      const current = this.metadata(id)
      this.writeMeta({ ...current, marked: false, credentialRevision: randomUUID() })
      await this.keyring('set', id, 'credentials', credentials)
      return this.writeMeta({ ...this.metadata(id), marked: true })
    })
  }
  async unmark(id) {
    // Revoke first, even if deleting keyring material then fails (it may be locked).
    await this.lock(id, async () => {
      const meta = this.metadata(id)
      this.writeMeta({ ...meta, marked: false, credentialRevision: randomUUID() })
      await this.keyring('delete', id, 'credentials')
    })
  }
  async credentials(id) {
    const before = this.metadata(id)
    if (!before.marked) throw new BrowserAccountError('NOT_MARKED', 'Agents may no longer sign in to this account.')
    let value
    try { value = await this.keyring('get', id, 'credentials'); if (!value) throw keyringLocked() }
    catch { await this.setState(id, 'Keyring locked'); throw keyringLocked() }
    const after = this.metadata(id)
    if (!after.marked || after.credentialRevision !== before.credentialRevision) throw new BrowserAccountError('NOT_MARKED', 'Agents may no longer sign in to this account.')
    return value
  }
  async remove(id) {
    await this.lock(id, async () => {
      this.metadata(id)
      await this.keyring('delete', id, 'credentials'); await this.keyring('delete', id, 'profile-key')
      rmSync(this.folder(id), { recursive: true, force: true })
    })
    // Other live relays observe removal, close Chromium first and wipe their own lease.
  }
  async cleanup() {
    for (const lease of this.claims()) if (!live(lease)) this.discard(lease)
    for (const { id } of this.list()) await this.lock(id, () => {
      const current = this.current(id), held = new Set([current])
      for (const lease of this.claims()) if (lease.id === id && live(lease)) held.add(lease.version)
      for (const name of readdirSync(this.folder(id))) if ((name.startsWith('v-') && !held.has(name)) || name.startsWith('.publish-') || name.startsWith('.current-')) rmSync(join(this.folder(id), name), { force: true })
    })
  }
}
