// MODULE: browser-accounts-engine.mjs - Shared Chrome launch, observed sign-in pages and the two-profile signed-in heuristic.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { BrowserAccountError } from './browser-keyring.mjs'
import { browserLaunchHelper, processIdentity } from './browser-accounts-store.mjs'
const packaged = join(dirname(process.execPath), 'resources/app.asar/package.json')
const require = createRequire(existsSync(packaged) ? packaged : import.meta.url)
// Resolve Playwright beside the pinned MCP dependency, so profiles use the server's actual browser implementation.
let libraries
export function browserLibraries() {
  if (libraries) return libraries
  const mcp = require.resolve('@playwright/mcp')
  const fromMcp = createRequire(mcp)
  const core = join(dirname(fromMcp.resolve('playwright-core')), 'lib/coreBundle.js')
  // Fail closed if packaging or a dependency update lost the audited execution hooks.
  if (createHash('sha256').update(readFileSync(core)).digest('hex') !== '4f552ee37917f6550287e75a26c0fa117aceb4db5d78afca9c8bbda5b9b0d95d')
    throw new BrowserAccountError('BROWSER_POLICY_MISSING', 'The browser account safety patch is missing. Reinstall BMN before using accounts.')
  libraries = { ...require('@playwright/mcp'), ...fromMcp('playwright') }
  return libraries
}
export const pageAddress = url => {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? `${u.origin}${u.pathname}` : '' }
  catch { return '' }
}
export const pageOrigin = url => { try { return new URL(url).origin } catch { return '' } }
export const SIGN_IN_FIELDS = 'input[type=password],input[autocomplete="one-time-code"]'
export async function hasSignInField(page) { return await page.locator(SIGN_IN_FIELDS).count() > 0 }
export async function openProfile(profile, { headless = true, environment = process.env } = {}) {
  // Playwright creates userDataDir before invoking the launch helper. Reject a
  // late call here too; the helper revalidates under its lifecycle lock before exec.
  try {
    const folder = dirname(profile), claim = JSON.parse(readFileSync(join(dirname(folder), '.claims', basename(folder) + '.json'), 'utf8'))
    const owner = processIdentity()
    if (claim.sealed || claim.folder !== folder || claim.profile !== profile || claim.pid !== owner.pid || claim.ticks !== owner.ticks) throw new Error('Inactive lease')
  } catch { throw new BrowserAccountError('LEASE_CLOSED', 'Browser lease is closed. Open a fresh account session.') }
  const scratch = join(dirname(profile), 'browser-home')
  const context = await browserLibraries().chromium.launchPersistentContext(profile, {
    channel: 'chrome', executablePath: browserLaunchHelper(), headless, chromiumSandbox: true, viewport: { width: 1280, height: 720 },
    acceptDownloads: false, args: ['--password-store=basic', '--restore-last-session'],
    // Chrome's scratch files and crash files belong to this decrypted RAM copy too.
    env: { ...environment, HOME: scratch, XDG_CONFIG_HOME: join(scratch, 'config'),
      XDG_CACHE_HOME: join(scratch, 'cache'), XDG_DATA_HOME: join(scratch, 'share'),
      XDG_STATE_HOME: join(scratch, 'state'), TMPDIR: dirname(profile), CHROME_LOG_FILE: join(scratch, 'chrome.log') }
  })
  try {
    // Session restoration retains session cookies; extra restored tabs must not multiply on every check.
    const pages = context.pages().filter(page => !page.isClosed())
    await Promise.all(pages.slice(1).map(page => page.close()))
    return context
  } catch (error) { await context.close().catch(() => {}); throw error }
}
export async function inspectProfile(profile, meta, options) {
  const context = await openProfile(profile, options)
  try {
    // Session-only sign-ins are deliberately unsupported: a restart must prove durable storage.
    await context.addInitScript(() => { sessionStorage.clear() })
    for (const restored of context.pages()) await restored.evaluate(() => sessionStorage.clear()).catch(() => {})
    const page = context.pages()[0] || await context.newPage()
    await page.goto(meta.start, { waitUntil: 'networkidle', timeout: 20_000 })
    return { address: pageAddress(page.url()), fields: await hasSignInField(page) }
  } finally { await context.close() }
}
export function signedInVerdict(saved, fresh, landing) {
  return !saved.fields && saved.address === pageAddress(landing) && (fresh.fields || fresh.address !== saved.address)
}
export async function checkProfile(store, lease, meta) {
  const empty = store.anonymous()
  try {
    const results = await Promise.allSettled([
      inspectProfile(lease.profile, meta, { environment: store.environment }),
      inspectProfile(empty.profile, meta, { environment: store.environment })
    ])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const [saved, fresh] = results.map(result => result.value)
    if (store.onCheck) store.onCheck({ saved, fresh, landing: meta.landing })
    return signedInVerdict(saved, fresh, meta.landing)
  } finally { store.discard(empty) }
}
export async function validateSaved(store, id) {
  let lease
  try {
    lease = await store.checkout(id)
    const meta = store.metadata(id)
    if (meta.state === 'Not confirmed') return false
    if (await checkProfile(store, lease, meta)) return await store.publish(lease, { state: 'Signed in' })
    await store.setState(id, 'Sign in again'); return false
  } catch (error) {
    if (error.code !== 'KEYRING_LOCKED' && error.code !== 'ACCOUNT_REMOVED') await store.setState(id, 'Sign in again')
    return false
  } finally { if (lease) store.discard(lease) }
}
export class AccountSignIn {
  constructor(store) { this.store = store; this.sessions = new Map(); this.pending = new Map() }
  begin(params) {
    const { id } = params
    if (id && this.pending.has(id)) return this.pending.get(id)
    if (id && this.sessions.has(id)) return Promise.resolve({ id, name: this.store.metadata(id).name })
    const opening = this.open(params)
    const key = id || Symbol('new account')
    const pending = opening.finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key) })
    this.pending.set(key, pending)
    return pending
  }
  async open({ name, url, id, headless = false }) {
    const created = !id
    if (created) id = (await this.store.create(name, url)).id
    let lease, context, session
    try {
      lease = await this.store.checkout(id)
      context = await openProfile(lease.profile, { headless, environment: this.store.environment })
      const meta = this.store.metadata(id), signInOrigins = new Set(meta.signInOrigins), signInPages = new Set(meta.signInPages || [])
      const observe = async () => {
        for (const page of context.pages()) for (const frame of page.frames()) {
          try { if (await frame.locator(SIGN_IN_FIELDS).count()) { signInOrigins.add(pageOrigin(frame.url())); signInPages.add(pageAddress(frame.url())) } } catch { /* frame navigated */ }
        }
      }
      const page = context.pages()[0] || await context.newPage()
      session = { id, lease, context, created, page, observe, signInOrigins, signInPages, finishing: false }
      this.sessions.set(id, session)
      const track = current => current.on('framenavigated', frame => {
        const address = pageAddress(frame.url())
        if (frame === current.mainFrame() && address) { session.page = current; session.landing = address }
      })
      track(page)
      context.on('page', track)
      session.timer = setInterval(() => { void observe() }, 300)
      context.on('close', () => { if (!session.finishing && this.sessions.get(id) === session) void this.finish(id, false, session).catch(() => {}) })
      await page.goto(meta.start, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await observe()
      return { id, name: meta.name }
    } catch (error) {
      if (session) { session.finishing = true; clearInterval(session.timer) }
      if (context) await context.close().catch(() => {})
      if (lease) this.store.discard(lease)
      if (this.sessions.get(id) === session) this.sessions.delete(id)
      if (created) await this.store.remove(id).catch(() => {})
      throw error
    }
  }
  async finish(id, cancel = false, expected = this.sessions.get(id)) {
    const s = this.sessions.get(id)
    if (!s || s !== expected) throw new BrowserAccountError('NO_SIGN_IN', 'No sign-in window is open for this account.')
    if (s.finished) return s.finished
    if (s.finishing) throw new BrowserAccountError('NO_SIGN_IN', 'No sign-in window is open for this account.')
    s.finishing = true; clearInterval(s.timer)
    s.finished = this.finishSession(s, cancel)
    return s.finished
  }
  async finishSession(s, cancel) {
    const { id } = s
    try {
      await s.observe()
      if (!s.page.isClosed()) s.landing = pageAddress(s.page.url()) || s.landing
      await s.context.close()
      if (cancel) { if (s.created) await this.store.remove(id); return null }
      const meta = this.store.metadata(id)
      const details = { ...meta, landing: s.landing || meta.landing, signInOrigins: [...s.signInOrigins].filter(o => /^https?:/u.test(o)), signInPages: [...s.signInPages], origins: [...new Set([pageOrigin(meta.start), pageOrigin(s.landing || meta.landing), ...s.signInOrigins])].filter(Boolean) }
      const confirmed = await checkProfile(this.store, s.lease, details)
      await this.store.publish(s.lease, { ...details, state: confirmed ? 'Signed in' : 'Not confirmed' })
      return this.store.list().find(row => row.id === id)
    } finally { this.store.discard(s.lease); if (this.sessions.get(id) === s) this.sessions.delete(id) }
  }
  async close() { await Promise.allSettled(this.pending.values()); for (const id of this.sessions.keys()) await this.finish(id, true) }
}
export function wipeRuntimeOutput(lease) { rmSync(join(lease.folder, 'output'), { recursive: true, force: true }) }
