#!/usr/bin/env node
/* global document, location, InputEvent, HTMLInputElement, HTMLTextAreaElement */
// MODULE: browser-account-relay.mjs - Playwright MCP plus private account tools, origin-bound secret entry and inline sanitized network data.
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { BrowserAccountsStore } from './browser-accounts-store.mjs'
import { BrowserAccountError } from './browser-keyring.mjs'
import { browserLibraries, checkProfile, hasSignInField, openProfile, pageOrigin, validateSaved } from './browser-accounts-engine.mjs'
import { approvedIfAny } from './agents-state.mjs'
import { harnessPrivateWork } from './agents-roster.mjs'

export const ACCOUNT_TOOLS = [
  { name: 'browser_accounts', description: 'List your saved browser accounts (names, sites and state only).', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_account_pick', description: 'Use a saved account in a fresh browser. Use browser_accounts for names.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'browser_account_code', description: 'Type the current authenticator code on a marked account’s trusted sign-in page.', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'browser_account_signed_out', description: 'Report that this account reached a sign-in page. A marked account may sign in using BMN_USERNAME, BMN_PASSWORD and browser_account_code.', inputSchema: { type: 'object', properties: {} } }
]
export const agentAccountRows = rows => rows.map(({ name, sites, state }) => ({ name, sites, state }))
const LIMITED = new Set(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_take_screenshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_wait_for', 'browser_account_code', 'browser_account_signed_out', 'browser_accounts', 'browser_account_pick'])
const HIDDEN_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization'])
export function safeHeaders(headers) { return Object.fromEntries(Object.entries(headers).filter(([name]) => !HIDDEN_HEADERS.has(name.toLowerCase()))) }
export function authenticatorCode(secret, now = Date.now()) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''
  for (const ch of secret.toUpperCase().replace(/[\s=-]/gu, '')) { const n = chars.indexOf(ch); if (n < 0) throw new Error('Invalid authenticator key'); bits += n.toString(2).padStart(5, '0') }
  const key = Buffer.from((bits.match(/.{8}/gu) || []).map(b => parseInt(b, 2)))
  if (key.length < 10) throw new Error('Invalid authenticator key')
  const count = Buffer.alloc(8); count.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)))
  const hash = createHmac('sha1', key).update(count).digest(), offset = hash.at(-1) & 15
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
const textResult = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const refusal = message => ({ ...textResult(message), isError: true })
export class PlaywrightBridge {
  async start(config, context) {
    this.server = await browserLibraries().createConnection(config, async () => context)
    this.pending = new Map(); this.next = 0
    this.transport = { start: async () => {}, close: async () => {}, send: async message => {
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { ok, no } = this.pending.get(message.id); this.pending.delete(message.id)
        if (message.error) no(new Error(message.error.message)); else ok(message.result)
      }
    } }
    await this.server.connect(this.transport)
    await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bmn-browser', version: '1' } })
    this.transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return this
  }
  call(method, params) {
    const id = ++this.next
    return new Promise((ok, no) => { this.pending.set(id, { ok, no }); this.transport.onmessage({ jsonrpc: '2.0', id, method, params }) })
  }
  async close() { await this.server?.close(); for (const { no } of this.pending?.values() || []) no(new Error('Browser closed')); this.pending?.clear() }
}
export class AccountBrowserRelay {
  constructor({ store = new BrowserAccountsStore(), allowed = false, qa = false, beforeReady = null } = {}) { this.store = store; this.allowed = allowed; this.qa = qa; this.beforeReady = beforeReady; this.requests = []; this.redactions = new Set(); this.revoked = false }
  async start(id = null) {
    await this.store.cleanup()
    if (id) this.lease = await this.store.checkout(id)
    else this.lease = this.store.anonymous()
    mkdirSync(this.lease.profile, { recursive: true, mode: 0o700 })
    this.id = id; this.requests = []; this.secretTyped = false; this.secretPage = null
    this.protectedOrigins = new Set()
    this.context = await openProfile(this.lease.profile, { environment: this.store.environment, qa: this.qa })
    if (this.beforeReady) await this.beforeReady(this.context)
    if (id) {
      this.policy = {
        persistConsole: false, downloads: false,
        evaluateOrigins: () => this.signInOrigins(),
        beforeTabTool: (name, page) => this.authorize(name, page)
      }
      this.context[Symbol.for('bmn.mcpPolicy')] = this.policy
    } else this.policy = null
    this.context.on('request', request => { if (this.requests.length < 10_000) this.requests.push(request) })
    const output = join(this.lease.folder, 'output'); mkdirSync(output, { mode: 0o700 })
    // No credentials are loaded into Playwright. Secret typing below uses the checked element handle directly.
    this.bridge = await new PlaywrightBridge().start({ browser: { isolated: false }, outputDir: output, saveSession: false, outputMode: 'stdout' }, this.context)
    if (id) {
      // Initialize the pinned backend before using its authoritative page accessor.
      const ready = await this.bridge.call('tools/call', { name: 'browser_snapshot', arguments: {} })
      if (ready.isError || !this.policy.ensurePage) throw new Error('Account execution policy unavailable.')
      this.watch = setInterval(() => { if (!this.store.list().some(row => row.id === id)) { this.revoked = true; void this.end(false) } }, 250)
      this.watch.unref()
    }
    return this
  }
  page() { return this.policy?.currentPage?.() }
  signInOrigins() {
    const meta = this.store.metadata(this.id)
    return [...new Set([...this.protectedOrigins, ...(meta.marked ? meta.signInOrigins : [])])]
  }
  authorize(name, page) {
    if (this.secretTyped && (name === 'browser_console_messages' || name.startsWith('browser_network_request')))
      throw new Error('Sign-in history is private until the browser restarts.')
    if (this.signInOrigins().includes(pageOrigin(page.url())) && !LIMITED.has(name))
      throw new Error('On sign-in origins only navigation, snapshots, screenshots, clicking, typing, key presses and waiting are available.')
  }
  async pick(name) {
    if (!this.allowed) throw new Error('This browser has no account access.')
    if (this.revoked) throw new Error('This session’s account was removed. Start a new browser session.')
    await this.end()
    const id = this.store.find(name)
    await validateSaved(this.store, id)
    await this.start(id)
    const meta = this.store.metadata(id), page = await this.policy.ensurePage()
    await page.goto(meta.start, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    if (meta.state !== 'Not confirmed' && await hasSignInField(page)) await this.store.setState(id, 'Sign in again')
    return textResult({ name: meta.name, state: this.store.metadata(id).state, ...(meta.marked ? { signIn: 'Use BMN_USERNAME and BMN_PASSWORD with browser_type; use browser_account_code for an authenticator code.' } : {}) })
  }
  async secret(target, name) {
    const id = this.id, initial = this.store.metadata(id)
    const credentials = await this.store.credentials(id), page = await this.policy.ensurePage()
    if (!page || !initial.signInOrigins.includes(pageOrigin(page.url()))) throw new Error('Secrets may only be typed on this account’s sign-in origins.')
    const locator = page.locator(/^(f\d+)?e\d+$/u.test(target) ? `aria-ref=${target}` : target)
    const element = await locator.elementHandle({ timeout: 5000 })
    if (!element) throw new Error('Sign-in field not found.')
    try {
      const frame = await element.ownerFrame()
      if (!frame || !initial.signInOrigins.includes(pageOrigin(frame.url()))) throw new Error('The target frame is not on this account’s sign-in origins.')
      const value = name === 'BMN_CODE' ? authenticatorCode(credentials.authenticator || '') : name === 'BMN_USERNAME' ? credentials.username : credentials.password
      this.redactions.add(value)
      // The key never leaves the relay; this session-only password file lives in RAM.
      writeFileSync(join(this.lease.folder, 'secrets.json'), JSON.stringify({ BMN_USERNAME: credentials.username, BMN_PASSWORD: credentials.password }), { mode: 0o600 })
      await this.store.credentials(id)
      for (const origin of initial.signInOrigins) this.protectedOrigins.add(origin)
      await this.store.lock(id, async () => {
        const current = this.store.metadata(id)
        if (!current.marked || current.credentialRevision !== initial.credentialRevision) throw new BrowserAccountError('NOT_MARKED', 'Agents may no longer sign in to this account.')
        // Unmark/Remove take the exclusive lock. Once typing starts they wait until
        // it finishes, or this context is closed on an uncertain result.
        this.secretTyped = true; this.secretPage = page
        let timeout
        try {
          await Promise.race([element.evaluate((input, { value, origins }) => {
            const here = location.origin, top = location.ancestorOrigins.length ? location.ancestorOrigins[location.ancestorOrigins.length - 1] : here
            let frameOK = false, topOK = false
            for (const origin of origins) { if (here === origin) frameOK = true; if (top === origin) topOK = true }
            if (!frameOK || !topOK || !input.isConnected) throw new Error('Sign-in page changed; nothing was typed.')
            input.focus(); input.select()
            if (!document.execCommand('insertText', false, value)) {
              const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
            }
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }, { value, origins: initial.signInOrigins }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Secret entry timed out')), 5000) })])
        } catch (error) { await this.context.close(); throw error }
        finally { clearTimeout(timeout) }
      }, true)
      return textResult(`${name} typed.`)
    } finally { await element.dispose() }
  }
  async network(name, args) {
    // All network tools in an account session are handled here, before Playwright can write any file.
    if (args.filename) return refusal('Account network data is returned inline only; filenames are refused.')
    if (name === 'browser_network_requests') return textResult(this.requests.map((r, i) => `${i + 1}. [${r.method()}] ${r.url()}`).join('\n'))
    const request = this.requests[Number(args.index) - 1]
    if (!request) return refusal('Network request not found.')
    const signin = this.store.metadata(this.id).signInOrigins.includes(pageOrigin(request.url()))
    if (signin && ['request-body', 'response-body'].includes(args.part)) return refusal('Bodies from sign-in origins are private.')
    const response = await request.response()
    if (args.part === 'request-body') return textResult(request.postData() || '')
    if (args.part === 'response-body') {
      if (!response || !/json|text|javascript|xml/u.test(response.headers()['content-type'] || '')) return refusal('Only inline text response bodies are available in account sessions.')
      return textResult((await response.text()).slice(0, 100_000))
    }
    const req = safeHeaders(await request.allHeaders()), res = safeHeaders(response ? await response.allHeaders() : {})
    return textResult(args.part === 'request-headers' ? req : args.part === 'response-headers' ? res : { url: request.url(), method: request.method(), status: response?.status(), requestHeaders: req, responseHeaders: res })
  }
  redact(value) {
    // Defense in depth. Origin gating, tool refusal and the fresh-browser restart are the credential boundaries.
    let data = JSON.stringify(value)
    for (const secret of this.redactions) if (secret) data = data.split(secret).join('[private]')
    return JSON.parse(data)
  }
  async tool(name, args = {}) {
    try {
      if (name === 'browser_accounts') return this.allowed ? textResult(agentAccountRows(this.store.list())) : refusal('This browser has no account access.')
      if (name === 'browser_account_pick') return await this.pick(args.name)
      if (this.revoked) return refusal('This account was removed. Its browser is closed.')
      if (!this.bridge) await this.start()
      if (this.id) {
        this.store.metadata(this.id)
        if (name === 'browser_run_code_unsafe') return refusal('Unsafe browser code can read private cookies and is refused in account sessions.')
        if (await this.signInCompleted()) await this.restartAfterSignIn()
        const meta = this.store.metadata(this.id)
        if (name === 'browser_account_signed_out') {
          await this.store.setState(this.id, 'Sign in again')
          return textResult(meta.marked ? 'Sign in with BMN_USERNAME, BMN_PASSWORD and browser_account_code on the saved sign-in origins.' : 'The owner has been asked to sign in again.')
        }
        if (name === 'browser_account_code') return await this.secret(args.target, 'BMN_CODE')
        if (name === 'browser_type' && ['BMN_USERNAME', 'BMN_PASSWORD'].includes(args.text)) return await this.secret(args.target, args.text)
        if (name.startsWith('browser_network_request')) {
          this.authorize(name, await this.policy.ensurePage())
          return this.redact(await this.network(name, args))
        }
      } else if (name.startsWith('browser_account_')) return refusal('Pick a marked account first.')
      const result = await this.bridge.call('tools/call', { name, arguments: args })
      if (this.id && await this.signInCompleted()) {
        await this.restartAfterSignIn()
        return textResult('Sign-in completed. Browser restarted on its refreshed profile; take a new snapshot.')
      }
      return this.redact(result)
    } catch (error) {
      // Browser errors can embed typed values, headers or page bodies. Never return those raw.
      const safe = error instanceof BrowserAccountError || /^(?:Secrets may|The target frame|Sign-in page changed|Sign-in field not found|This session|This browser|No sign-in|Invalid authenticator)/u.test(error.message)
      return refusal(safe ? error.message : 'Browser operation failed. Take a fresh snapshot or sign in again.')
    }
  }
  async signInCompleted() {
    return this.secretTyped && this.secretPage && (this.secretPage.isClosed() || !await hasSignInField(this.secretPage))
  }
  async restartAfterSignIn() {
    const id = this.id, landing = this.secretPage?.isClosed() ? this.store.metadata(this.id).landing : this.secretPage?.url()
    await this.end()
    await this.start(id)
    const page = await this.policy.ensurePage()
    await page.goto(landing || this.store.metadata(id).landing, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  }
  async end(writeBack = true) {
    clearInterval(this.watch)
    const lease = this.lease, id = this.id
    if (!lease) return
    this.lease = null
    try {
      await this.bridge?.close(); await this.context?.close()
      if (id && writeBack && !this.revoked) {
        const meta = this.store.metadata(id)
        if (meta.state !== 'Not confirmed') {
          const passed = await checkProfile(this.store, lease, meta)
          if (!(passed && await this.store.publish(lease, { state: 'Signed in' }))) {
            const valid = await validateSaved(this.store, id)
            if (!valid && meta.marked && this.secretTyped) await this.store.setState(id, 'Sign in again', { notify: true })
          }
        }
      }
    } catch (error) { if (id && error.code !== 'ACCOUNT_REMOVED') await validateSaved(this.store, id) }
    finally { this.bridge = null; this.context = null; this.id = null; this.store.discard(lease); this.redactions.clear() }
  }
  async tools() {
    if (!this.bridge) await this.start()
    const result = await this.bridge.call('tools/list', {})
    return { tools: [...result.tools, ...(this.allowed ? ACCOUNT_TOOLS : [])] }
  }
}
export async function runAccountBrowser(app) {
  const allowed = ['claude', 'codex', 'opencode'].includes(app) && harnessPrivateWork(approvedIfAny()?.data, app).allowed
  const relay = new AccountBrowserRelay({ allowed })
  let queue = Promise.resolve()
  const finish = async () => { await queue.catch(() => {}); await relay.end(); process.exit(0) }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void finish() })
  const input = createInterface({ input: process.stdin })
  input.on('line', line => { queue = queue.then(async () => {
    let message
    try {
      message = JSON.parse(line)
      if (message.id === undefined) return
      let result
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'bmn-playwright', version: '1' } }
      else if (message.method === 'tools/list') result = await relay.tools()
      else if (message.method === 'tools/call') result = await relay.tool(message.params.name, message.params.arguments)
      else if (message.method === 'ping') result = {}
      else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    } catch { if (message?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Browser unavailable' } }) + '\n') }
  }) })
  input.on('close', () => { void finish() })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAccountBrowser(process.argv[2]).catch(() => { process.stderr.write('BMN browser unavailable.\n'); process.exit(1) })
