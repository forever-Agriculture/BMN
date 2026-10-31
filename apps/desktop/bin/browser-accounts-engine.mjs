/* global document, NodeFilter, getComputedStyle, location */
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
let libraries, pngRead
export function browserLibraries() {
  if (libraries) return libraries
  const mcp = require.resolve('@playwright/mcp')
  const fromMcp = createRequire(mcp)
  const core = join(dirname(fromMcp.resolve('playwright-core')), 'lib/coreBundle.js')
  // Fail closed if packaging or a dependency update lost the audited execution hooks.
  if (createHash('sha256').update(readFileSync(core)).digest('hex') !== '4f552ee37917f6550287e75a26c0fa117aceb4db5d78afca9c8bbda5b9b0d95d')
    throw new BrowserAccountError('BROWSER_POLICY_MISSING', 'The browser account safety patch is missing. Reinstall BMN before using accounts.')
  libraries = { ...require('@playwright/mcp'), ...fromMcp('playwright') }
  pngRead = fromMcp(join(dirname(fromMcp.resolve('playwright-core')), 'lib/utilsBundle.js')).PNG.sync.read
  return libraries
}
export function readBrowserPng(bytes) { browserLibraries(); return pngRead(bytes) }
export const pageAddress = url => {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? `${u.origin}${u.pathname}` : '' }
  catch { return '' }
}
export const pageOrigin = url => { try { return new URL(url).origin } catch { return '' } }
export const SIGN_IN_FIELDS = 'input[type=password],input[autocomplete="one-time-code"]'
export async function hasSignInField(page) { return await page.locator(SIGN_IN_FIELDS).count() > 0 }
// Chrome's saved windows and tabs; session cookies live in the cookie store and survive their removal.
export const CHROME_SESSION_FILES = ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']
export async function openProfile(profile, { headless = true, environment = process.env, qa = false } = {}) {
  // Playwright creates userDataDir before invoking the launch helper. Reject a
  // late call here too; the helper revalidates under its lifecycle lock before exec.
  try {
    const folder = dirname(profile), claim = JSON.parse(readFileSync(join(dirname(folder), '.claims', basename(folder) + '.json'), 'utf8'))
    const owner = processIdentity()
    if (claim.sealed || claim.folder !== folder || claim.profile !== profile || claim.pid !== owner.pid || claim.ticks !== owner.ticks) throw new Error('Inactive lease')
  } catch { throw new BrowserAccountError('LEASE_CLOSED', 'Browser lease is closed. Open a fresh account session.') }
  const scratch = join(dirname(profile), 'browser-home')
  // QA keeps restored session cookies but never restored tabs: their requests would start before the QA audit routes exist.
  if (qa) for (const name of CHROME_SESSION_FILES) rmSync(join(profile, 'Default', name), { recursive: true, force: true })
  const context = await browserLibraries().chromium.launchPersistentContext(profile, {
    channel: 'chrome', executablePath: browserLaunchHelper(), headless, chromiumSandbox: true, viewport: { width: 1280, height: 720 },
    acceptDownloads: false, ...(qa ? { serviceWorkers: 'block' } : {}), args: ['--password-store=basic', '--restore-last-session'],
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
async function prepareInspection(context, meta) {
    // Session-only sign-ins are deliberately unsupported: a restart must prove durable storage.
    await context.addInitScript(() => { sessionStorage.clear() })
    for (const restored of context.pages()) await restored.evaluate(() => sessionStorage.clear()).catch(() => {})
    const page = context.pages()[0] || await context.newPage()
    await page.goto(meta.start, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    return { context, page }
}
async function readProfilePage(page, deadline) {
  let timer
  try {
    const observation = await Promise.race([
      page.evaluate(selector => {
        // A client-rendered sign-in can still be an empty shell at DOMContentLoaded.
        // Visible text permits an observation; it is never proof of authentication.
        let ready = false
        if (document.body) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement
            if (!node.textContent.trim() || !parent || parent.closest('script,style,template,noscript')) continue
            const style = getComputedStyle(parent)
            if (style.visibility === 'hidden' || style.visibility === 'collapse') continue
            const range = document.createRange(); range.selectNodeContents(node)
            if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) { ready = true; break }
          }
        }
        return { ready, address: location.href, fields: Boolean(document.querySelector(selector)) }
      }, SIGN_IN_FIELDS),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new BrowserAccountError('PROFILE_NOT_READY', 'Browser sign-in check did not finish.')), Math.max(0, deadline - performance.now())) })
    ])
    return { ...observation, address: pageAddress(observation.address) }
  } finally { clearTimeout(timer) }
}
export async function profileObservation(page, deadline = performance.now() + 1500) {
  do {
    try {
      const observation = await readProfilePage(page, deadline)
      if (observation.ready) return observation
    } catch (error) {
      if (error.code === 'PROFILE_NOT_READY') break
      if (page.isClosed() || !/Execution context was destroyed|Cannot find context with specified id/u.test(error.message)) throw error
    }
    await new Promise(ok => setTimeout(ok, Math.max(0, Math.min(50, deadline - performance.now()))))
  } while (performance.now() < deadline)
  return { ready: false, address: '', fields: false }
}
export function signedInVerdict(saved, fresh, landing) {
  return saved.ready !== false && fresh.ready !== false && !saved.fields && saved.address === pageAddress(landing) && (fresh.fields || fresh.address !== saved.address)
}
export async function checkProfile(store, lease, meta) {
  const contexts = []
  try {
    const savedContext = await openProfile(lease.profile, { environment: store.environment }); contexts.push(savedContext)
    const browser = savedContext.browser()
    if (!browser) throw new BrowserAccountError('PROFILE_CHECK_UNAVAILABLE', 'Browser account verification is unavailable.')
    // A new incognito context shares only the trusted Chrome process, never the
    // saved context's cookies, storage, headers or authentication configuration.
    const freshContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: false }); contexts.push(freshContext)
    const results = await Promise.allSettled(contexts.map(context => prepareInspection(context, meta)))
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const inspections = results.map(result => result.value)
    // Let client-side auth redirects settle in both profiles before any positive
    // verdict. A fresh login may appear before an expired saved shell redirects.
    const deadline = performance.now() + 1500
    let [saved, fresh] = await Promise.all(inspections.map(({ page }) => profileObservation(page, deadline)))
    if (saved.ready && fresh.ready && !saved.fields && saved.address === pageAddress(meta.landing)) {
      await new Promise(ok => setTimeout(ok, Math.max(0, deadline - performance.now() - 100)))
      try { [saved, fresh] = await Promise.all(inspections.map(({ page }) => readProfilePage(page, deadline))) }
      catch (error) {
        if (error.code === 'PROFILE_NOT_READY' || /Execution context was destroyed|Cannot find context with specified id/u.test(error.message)) return false
        throw error
      }
    }
    if (store.onCheck) store.onCheck({ saved, fresh, landing: meta.landing })
    return signedInVerdict(saved, fresh, meta.landing)
  } finally {
    // Anonymous pages close first; closing the persistent context also drains
    // the browser that owns both, inside the saved lease's writer barrier.
    for (const context of contexts.toReversed()) await context.close().catch(() => {})
  }
}
export async function validateSaved(store, id) {
  let lease, meta
  try {
    lease = await store.checkout(id)
    meta = store.metadata(id)
    if (await checkProfile(store, lease, meta)) return await store.publish(lease, { state: 'Signed in' })
    if (meta.state !== 'Not confirmed') await store.setState(id, 'Sign in again')
    return false
  } catch (error) {
    if (meta?.state !== 'Not confirmed' && error.code !== 'KEYRING_LOCKED' && error.code !== 'ACCOUNT_REMOVED') await store.setState(id, 'Sign in again')
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
