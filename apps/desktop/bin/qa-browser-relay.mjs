// MODULE: qa-browser-relay.mjs - a pane-bound QA browser with retained native evidence
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { AccountBrowserRelay } from './browser-account-relay.mjs'
import { readBrowserPng } from './browser-accounts-engine.mjs'
import { processIdentity } from './browser-process.mjs'
import { BROWSER_LIMITS, browserTools } from './agents-team-browser.mjs'
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

export async function runQaBrowser(folder) {
  const { socketPath, token } = readCredentials({})
  const identity = processIdentity()
  const policy = await call(socketPath, token, 'qa.connect', { pid: identity.pid, ticks: identity.ticks })
  if (!policy?.qaId) throw new Error('QA_SESSION_UNBOUND')
  const allowed = new Set(browserTools(true, true))
  const record = { version: 1, origin: policy.target, qaId: policy.qaId, connection: identity, calls: 0, screenshots: [], pages: [], complete: true }
  const save = () => writeWhole(join(folder, 'browser.json'), JSON.stringify(record, null, 2) + '\n')
  const relay = new AccountBrowserRelay({ qa: true, allowed: false, beforeReady: async context => {
    await context.route('**/*', route => {
      try { return new URL(route.request().url()).origin === new URL(policy.target).origin ? route.continue() : route.abort('blockedbyclient') }
      catch { return route.abort('blockedbyclient') }
    })
    await context.routeWebSocket(/.*/, socket => socket.close())
    for (const page of context.pages()) await page.close()
  } })
  mkdirSync(join(folder, 'browser'), { recursive: true, mode: 0o700 })
  let queue = Promise.resolve(), closing = false
  const finish = async () => {
    if (closing) return
    closing = true
    await queue.catch(() => { record.complete = false })
    save(); await relay.end(false)
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
        result = { tools: upstream.tools.filter(tool => allowed.has(tool.name)) }
      } else if (message.method === 'tools/call') {
        record.calls++
        if (!allowed.has(message.params.name)) result = { isError: true, content: [{ type: 'text', text: 'QA tool unavailable; account access requires the permission broker.' }] }
        else if (message.params.name === 'browser_take_screenshot') result = await captureQaScreenshot(folder, record, message.params.arguments ?? {}, args => relay.tool('browser_take_screenshot', args))
        else if (Object.hasOwn(message.params.arguments ?? {}, 'filename')) result = { isError: true, content: [{ type: 'text', text: 'QA files are retained by the browser relay; explicit output filenames are unavailable for this tool.' }] }
        else result = await relay.tool(message.params.name, message.params.arguments)
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
