// MODULE: qa-browser-relay.mjs - a pane-bound QA browser with retained native evidence
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { AccountBrowserRelay, agentAccountRows } from './browser-account-relay.mjs'
import { BrowserAccountsStore } from './browser-accounts-store.mjs'
import { classifyQaRequest, gateQaRequest, passQaRequest, syntheticPaidContract } from './qa-request-gate.mjs'
import { readBrowserPng } from './browser-accounts-engine.mjs'
import { processIdentity } from './browser-process.mjs'
import { BROWSER_LIMITS, LOOK_TOOLS, browserTools } from './agents-team-browser.mjs'
import { call, readCredentials } from './bmn-commands.mjs'
import { writeWhole } from './agents-team-supervisor.mjs'

/** Admit only the image returned by this native call, never a model-named local file. */
export async function captureQaScreenshot(folder, record, args, native) {
  if (args.filename !== undefined && (typeof args.filename !== 'string' || !/^(?:browser\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.png$/.test(args.filename))) throw new Error('QA_SCREENSHOT_FILENAME')
  if (args.type !== undefined && args.type !== 'png') throw new Error('QA_SCREENSHOT_FORMAT')
  const name = args.filename?.replace(/^browser\//, '') ?? `shot-${randomUUID()}.png`
  const options = { ...args }
  delete options.filename; delete options.type
  const directory = join(folder, 'browser'), directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const owned = fstatSync(directoryFd)
  const checkDirectory = () => {
    const current = lstatSync(directory)
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('QA_SCREENSHOT_DIRECTORY_CHANGED')
  }
  try {
    checkDirectory()
    const result = await native({ ...options, type: 'png' })
    if (result.isError) return result
    checkDirectory()
    const images = result.content?.filter(item => item.type === 'image')
    if (images?.length !== 1 || images[0].mimeType !== 'image/png' || typeof images[0].data !== 'string' || images[0].data.length > Math.ceil(BROWSER_LIMITS.screenshot / 3) * 4) throw new Error('QA_SCREENSHOT_IMAGE_INVALID')
    const bytes = Buffer.from(images[0].data, 'base64')
    if (bytes.length < 33 || bytes.length > BROWSER_LIMITS.screenshot || bytes.toString('base64') !== images[0].data || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('QA_SCREENSHOT_IMAGE_INVALID')
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('QA_SCREENSHOT_DIMENSIONS')
    const decoded = readBrowserPng(bytes)
    if (decoded.width !== width || decoded.height !== height) throw new Error('QA_SCREENSHOT_IMAGE_INVALID')
    const shot = { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const previous = record.screenshots.find(item => item.name === name)
    if (previous && (previous.sha256 !== shot.sha256 || previous.bytes !== shot.bytes)) throw new Error('QA_SCREENSHOT_CONFLICT')
    if (!previous && record.screenshots.length >= BROWSER_LIMITS.screenshots) throw new Error('QA_SCREENSHOT_LIMIT')
    const path = `/proc/self/fd/${directoryFd}/${name}`
    if (!previous) {
      const temporary = `/proc/self/fd/${directoryFd}/.shot-${randomUUID()}`
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(fd, bytes); fsyncSync(fd)
        linkSync(temporary, path)
      } finally { closeSync(fd); unlinkSync(temporary) }
      fsyncSync(directoryFd)
    }
    const readFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { if (!fstatSync(readFd).isFile() || !readFileSync(readFd).equals(bytes)) throw new Error('QA_SCREENSHOT_READBACK') }
    finally { closeSync(readFd) }
    checkDirectory()
    if (!previous) record.screenshots.push(shot)
    return { ...result, content: [...result.content, { type: 'text', text: `Retained native screenshot: browser/${name}` }] }
  } finally { closeSync(directoryFd) }
}

/** Per account mode: test accounts get full interaction; ordinary accounts never evaluate or read network data, and look-only ones only look (100.6). */
const ORDINARY_HIDDEN = new Set(['browser_evaluate', 'browser_run_code_unsafe', 'browser_network_requests', 'browser_network_request'])
export function qaToolAllowed(mode, name) {
  if (mode === null || mode === 'test-full') return name !== 'browser_run_code_unsafe'
  if (ORDINARY_HIDDEN.has(name)) return false
  return mode === 'ordinary-granted' || LOOK_TOOLS.includes(name)
}
export const QA_SEAL_TOOL = { name: 'browser_qa_seal', description: 'Finish account use for this QA: ends account access, seals BMN\'s host receipt and returns {receiptId, sha256} for a version 2 report\'s host_summary. Call once, after your last browser action.', inputSchema: { type: 'object', properties: {} } }
/** Pages opened before the QA routes are replaced, never all closed first: closing the last tab ends Chrome's session and its session cookies. */
export async function replaceStartupPages(context) {
  const fresh = await context.newPage()
  for (const page of context.pages()) if (page !== fresh) await page.close()
}
const QA_ACCOUNT_TOOLS = new Set(['browser_accounts', 'browser_account_pick', QA_SEAL_TOOL.name])
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const refused = message => ({ ...text(message), isError: true })

export async function runQaBrowser(folder) {
  const { socketPath, token } = readCredentials({})
  const identity = processIdentity()
  const rpc = (method, params) => call(socketPath, token, method, params)
  const policy = await rpc('qa.connect', { pid: identity.pid, ticks: identity.ticks })
  if (!policy?.qaId) throw new Error('QA_SESSION_UNBOUND')
  const launch = JSON.parse(readFileSync(join(folder, 'launch.json'), 'utf8'))
  // Only the Claude Code form, whose closure each run proves, lists account tools; the host still decides every pick.
  const accountForm = launch.form === 'claude-qa'
  const aliases = accountForm && Array.isArray(policy.accounts) ? policy.accounts : []
  const allowed = new Set([...browserTools(true, true), ...(accountForm ? QA_ACCOUNT_TOOLS : [])])
  const record = { version: 1, origin: policy.target, qaId: policy.qaId, connection: identity, calls: 0, screenshots: [], pages: [], accounts: [], refused: 0, complete: true }
  const save = () => writeWhole(join(folder, 'browser.json'), JSON.stringify(record, null, 2) + '\n')
  const store = new BrowserAccountsStore()
  let current = null, sealed = false, audited = false
  const contractFor = origin => { try { return syntheticPaidContract(origin) } catch { return null } }
  const brokerFor = (account, origin) => ({
    policy: async () => ({ active: !sealed && relay.id === account.accountId, contract: contractFor(origin), origins: account.origins }),
    reserve: async operation => account.mode === 'ordinary-granted' ? rpc('qa.reserve', { ...operation, grantId: null, accountId: account.accountId }) : { allowed: false, reason: 'look-only' },
    send: id => rpc('qa.send', { id }),
    settle: (id, state, status) => rpc('qa.settle', { id, state, status }),
    observe: request => rpc('qa.audit', { accountId: account.accountId, request, held: false }),
    // A look-only pick never reserves, so its held requests are audited without opening a card it could not use.
    hold: (request, reason) => account.mode === 'look-only' ? rpc('qa.audit', { accountId: account.accountId, request, held: true }) : rpc('qa.hold', { accountId: account.accountId, request, reason }),
    gap: gap => rpc('qa.audit.close', { gap })
  })
  // A test account's own sites are observed and pass; anything else is held. Ordinary accounts cross the broker gate.
  const testRoute = async (route, account) => {
    const classified = classifyQaRequest(contractFor(new URL(route.request().url()).origin), route.request().method(), route.request().url())
    try {
      if (sealed || relay.id !== account.accountId) { await route.abort('blockedbyclient'); return }
      if (!account.origins.includes(classified.request.origin)) { await rpc('qa.hold', { accountId: account.accountId, request: classified.request, reason: 'outside-account-sites' }); await route.abort('blockedbyclient'); return }
      await rpc('qa.audit', { accountId: account.accountId, request: classified.request, held: false })
      await passQaRequest(route)
    } catch {
      record.complete = false
      await route.abort('blockedbyclient').catch(() => {})
      await rpc('qa.audit.close', { gap: 'broker-unreachable' }).catch(() => {})
    }
  }
  const relay = new AccountBrowserRelay({ store, qa: true, allowed: aliases.length > 0, beforeReady: async context => {
    const account = relay.id ? current : null
    if (relay.id && account?.accountId !== relay.id) throw new Error('QA_ACCOUNT_CHANGED')
    if (!account) {
      await context.route('**/*', async route => {
        try { if (new URL(route.request().url()).origin === new URL(policy.target).origin) await passQaRequest(route); else await route.abort('blockedbyclient') }
        catch { await route.abort('blockedbyclient').catch(() => {}) }
      })
    } else if (account.mode === 'test-full') await context.route('**/*', route => testRoute(route, account))
    else await context.route('**/*', route => gateQaRequest(route, brokerFor(account, new URL(route.request().url()).origin), async () => { await context.close() }))
    await context.routeWebSocket(/.*/, socket => socket.close())
    await replaceStartupPages(context)
  } })
  mkdirSync(join(folder, 'browser'), { recursive: true, mode: 0o700 })
  const pick = async name => {
    if (typeof name !== 'string' || !aliases.some(alias => alias.alias === name)) return refused('Use only an account alias the QA brief names.')
    if (sealed) return refused('Account use for this QA is sealed.')
    let chosen
    try { chosen = await rpc('qa.account', { name }) } catch (error) { return refused(`BMN refused this account: ${String(error.code ?? error.message).slice(0, 120)}`) }
    current = chosen; audited = true
    const result = await relay.tool('browser_account_pick', { name })
    if (result.isError || relay.id !== chosen.accountId) { current = null; await relay.end(false); return result.isError ? result : refused('The account changed while it was opened.') }
    record.accounts.push({ alias: chosen.alias, mode: chosen.mode, at: new Date().toISOString() })
    const { name: picked, state } = JSON.parse(result.content[0].text)
    return text({ name: picked, state, mode: chosen.mode, tools: chosen.mode === 'test-full' ? 'full interaction except unsafe browser code' : chosen.mode === 'ordinary-granted' ? 'look and interact; no evaluation or network data; activities need the owner\'s grant' : 'look only; interaction is refused and recorded' })
  }
  const seal = async () => {
    if (sealed) return refused('Already sealed.')
    sealed = true; current = null
    await relay.end(false)
    try { return text(await rpc('qa.summary', {})) } catch (error) { return refused(`BMN could not seal this QA: ${String(error.code ?? error.message).slice(0, 120)}`) }
  }
  let queue = Promise.resolve(), closing = false
  const finish = async () => {
    if (closing) return
    closing = true
    await queue.catch(() => { record.complete = false })
    save(); await relay.end(false)
    if (audited && !sealed) await rpc('qa.audit.close', { gap: record.complete ? null : 'relay-incomplete' }).catch(() => {})
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void finish().finally(() => { process.exit(0) }) })
  const input = createInterface({ input: process.stdin })
  input.on('line', line => { queue = queue.then(async () => {
    let message
    try {
      message = JSON.parse(line)
      if (message.id === undefined) return
      let result
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'bmn-qa-playwright', version: '1' } }
      else if (message.method === 'tools/list') {
        const upstream = await relay.tools()
        result = { tools: [...upstream.tools.filter(tool => allowed.has(tool.name) && tool.name !== 'browser_account_code' && tool.name !== 'browser_account_signed_out'), ...(accountForm ? [QA_SEAL_TOOL] : [])] }
      } else if (message.method === 'tools/call') {
        record.calls++
        const name = message.params.name, args = message.params.arguments ?? {}
        const mode = relay.id && current ? current.mode : null
        if (!allowed.has(name)) result = refused('QA tool unavailable; account access requires the permission broker.')
        else if (name === 'browser_accounts') result = text(agentAccountRows(store.list().filter(row => aliases.some(alias => alias.alias === row.name))).map(row => ({ ...row, intent: aliases.find(alias => alias.alias === row.name).intent })))
        else if (name === 'browser_account_pick') result = await pick(args.name)
        else if (name === QA_SEAL_TOOL.name) result = await seal()
        else if (!qaToolAllowed(mode, name)) {
          record.refused++
          await rpc('qa.refuse', { accountId: current.accountId, tool: name })
          result = refused(mode === 'look-only' ? 'This account is look-only in this QA: interaction is refused and recorded.' : 'Evaluation, unsafe code and network data are unavailable on an ordinary account; the attempt is recorded.')
        } else if (name === 'browser_take_screenshot') result = await captureQaScreenshot(folder, record, args, values => relay.tool('browser_take_screenshot', values))
        else if (name === 'browser_type' && /^BMN_[A-Z_]+$/.test(String(args.text ?? ''))) result = refused('Saved sign-in secrets are never typed in a QA session; use an account that is already signed in.')
        else if (Object.hasOwn(args, 'filename')) result = refused('QA files are retained by the browser relay; explicit output filenames are unavailable for this tool.')
        else result = await relay.tool(name, args)
        record.pages = relay.context ? relay.context.pages().filter(page => !page.isClosed()).map(page => ({ url: page.url() })) : []
        save()
      } else if (message.method === 'ping') result = {}
      else throw new Error('Unsupported MCP method')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    } catch {
      record.complete = false; save()
      if (message?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'QA browser operation failed' } }) + '\n')
    }
  }) })
  input.on('close', () => { void finish() })
  save()
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runQaBrowser(process.argv[2]).catch(() => { process.stderr.write('QA browser unavailable; no account access granted.\n'); process.exitCode = 1 })
}
