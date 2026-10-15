// MODULE: ask-browser-space.mjs - Story 74.3: what runs inside a browser ask's two network spaces, and the teammate's one way to its browser: the app and its services with the bridge that offers the app's port as a Unix socket; the browser's origin bridge and Playwright MCP behind BMN's filter of its tools; the app's MCP connection to that filter
//
// node ask-browser-space.mjs app <spec-json>        the app's space: each service and the app from the project, and /bridge/app.sock
// node ask-browser-space.mjs browser <spec-json>    the browser's space: 127.0.0.1:<port> relayed to /bridge/app.sock, and /mcp/mcp.sock
// node ask-browser-space.mjs connect <socket>       the teammate's MCP server: its standard input and output are one connection to <socket>
//
// BMN copies this file into each browser ask's inputs, judged with them, and runs it only with Node's own modules.
// A Unix socket crosses network namespaces because it is a file: the one folder bound into both spaces joins them for
// exactly the sockets in it (74.1), and nothing else of either space is reachable from the other.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'

/** The tools a look ask may use, and those --interact adds; every other tool of the browser is refused (74.3 AC3, AC4). */
export const LOOK_TOOLS = Object.freeze(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_console_messages',
  'browser_network_requests', 'browser_network_request', 'browser_tabs', 'browser_close', 'browser_resize'])
export const INTERACT_TOOLS = Object.freeze(['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_drag', 'browser_handle_dialog'])
/** Refused in every browser ask, by name, so the record says why: the teammate's own scripts, uploads and dropped files (74.3 AC3). */
export const NEVER_TOOLS = Object.freeze({
  browser_evaluate: 'a browser ask runs none of the teammate\'s own scripts',
  browser_run_code_unsafe: 'a browser ask runs none of the teammate\'s own scripts',
  browser_file_upload: 'a browser ask uploads nothing',
  browser_drop: 'a browser ask drops no files or data onto a page'
})
/** The part of a result kept in the record: enough to say what happened, never a whole page. */
const RESULT_TEXT = 600

const pipeBoth = (left, right) => {
  left.pipe(right)
  right.pipe(left)
  const end = () => {
    left.destroy()
    right.destroy()
  }
  for (const side of [left, right]) {
    side.on('error', end)
    side.on('close', end)
  }
}

/** Reads newline-delimited JSON-RPC from a stream, one message at a time; a line that is not JSON is dropped. */
function lines(stream, onMessage) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim() === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message !== null && typeof message === 'object') onMessage(message)
    }
  })
}

/** Why a URL the teammate names is not the app's origin, or null: http only, at 127.0.0.1 and the app's port. */
export function offOrigin(address, origin) {
  let url
  try {
    url = new URL(String(address))
  } catch {
    return `${String(address).slice(0, 80)} is not an address`
  }
  const allowed = new URL(origin)
  if (url.protocol !== 'http:' || url.host !== allowed.host) return `only ${allowed.origin} is reachable in this ask, not ${url.protocol}//${url.host}`
  return null
}

/**
 * BMN's judgement of one tool call: `{ ok, reason }` and, allowed, the arguments it forwards. The
 * browser writes its files where BMN says, so a call's own file name is dropped; an address must be
 * the app's origin.
 */
export function judgeCall(name, args, { tools, origin }) {
  if (typeof name !== 'string') return { ok: false, reason: 'a tool call names no tool' }
  if (Object.hasOwn(NEVER_TOOLS, name)) return { ok: false, reason: NEVER_TOOLS[name] }
  if (!tools.includes(name)) {
    return { ok: false, reason: INTERACT_TOOLS.includes(name) ? 'a look ask does not click, type or submit; the asker gives --interact for that' : `${name.slice(0, 64)} is not a tool a browser ask uses` }
  }
  const given = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const forwarded = Object.fromEntries(Object.entries(given).filter(([key]) => key !== 'filename'))
  const address = name === 'browser_navigate' ? given.url : name === 'browser_tabs' ? given.url : undefined
  if (name === 'browser_navigate' || address !== undefined) {
    const why = offOrigin(address, origin)
    if (why !== null) return { ok: false, reason: why }
  }
  return { ok: true, args: forwarded }
}

/** What a tool's result says of the page: its address and title, as Playwright MCP writes them, and its text cut short. */
export function resultSummary(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
  const page = /^- Page URL: (.+)$/mu.exec(text)?.[1]?.trim() ?? null
  const title = /^- Page Title: (.*)$/mu.exec(text)?.[1]?.trim() ?? null
  const images = content.filter((part) => part?.type === 'image').length
  return { page, title, images, error: result?.isError === true, text: text.slice(0, RESULT_TEXT) }
}

/**
 * The filter between the teammate's connection and Playwright MCP: tools/list answers only the
 * tools this ask may use; a call to any other, an address off the origin and every resource, prompt
 * or sampling request is refused here and never reaches the browser; each call and its outcome is
 * one line of `log`. `toServer` is the browser's standard input, `fromServer` its standard output.
 */
export function filterMcp(client, toServer, fromServer, { tools, origin, log }) {
  const pending = new Map()
  const lists = new Set()
  const write = (stream, message) => stream.write(`${JSON.stringify(message)}\n`)
  const record = (entry) => log({ at: new Date().toISOString(), ...entry })
  const answer = (id, result) => write(client, { jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => write(client, { jsonrpc: '2.0', id, error: { code, message } })
  lines(client, (message) => {
    const { id, method } = message
    if (method === 'tools/call') {
      const name = message.params?.name
      const verdict = judgeCall(name, message.params?.arguments, { tools, origin })
      if (!verdict.ok) {
        record({ id, tool: typeof name === 'string' ? name.slice(0, 64) : null, verdict: 'refused', reason: verdict.reason, url: typeof message.params?.arguments?.url === 'string' ? message.params.arguments.url.slice(0, 300) : undefined })
        if (id !== undefined) answer(id, { content: [{ type: 'text', text: `BMN refused ${typeof name === 'string' ? name.slice(0, 64) : 'this call'}: ${verdict.reason}` }], isError: true })
        return
      }
      if (id !== undefined) pending.set(id, { tool: name, url: typeof verdict.args.url === 'string' ? verdict.args.url.slice(0, 300) : undefined })
      write(toServer, { ...message, params: { ...message.params, arguments: verdict.args } })
      return
    }
    if (method === 'tools/list') {
      if (id !== undefined) lists.add(id)
      write(toServer, message)
      return
    }
    // The browser offers nothing else to read, and asks the teammate for nothing.
    if (method === 'resources/list') return id === undefined ? undefined : answer(id, { resources: [] })
    if (method === 'resources/templates/list') return id === undefined ? undefined : answer(id, { resourceTemplates: [] })
    if (method === 'prompts/list') return id === undefined ? undefined : answer(id, { prompts: [] })
    if (typeof method === 'string' && method !== 'initialize' && method !== 'ping' && !method.startsWith('notifications/')) {
      record({ id, method: method.slice(0, 64), verdict: 'refused', reason: 'not a request a browser ask makes' })
      return id === undefined ? undefined : fail(id, -32601, `BMN does not offer ${method.slice(0, 64)} in a browser ask`)
    }
    write(toServer, message)
  })
  lines(fromServer, (message) => {
    // A request of the browser's to the teammate (roots, sampling, elicitation) is answered here, never passed on.
    if (typeof message.method === 'string' && message.id !== undefined) {
      if (message.method === 'roots/list') write(toServer, { jsonrpc: '2.0', id: message.id, result: { roots: [] } })
      else write(toServer, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not offered in a browser ask' } })
      return
    }
    if (message.id !== undefined && lists.has(message.id)) {
      lists.delete(message.id)
      const offered = Array.isArray(message.result?.tools) ? message.result.tools : []
      write(client, { ...message, result: { ...message.result, tools: offered.filter((tool) => tools.includes(tool?.name)) } })
      return
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      record({ id: message.id, tool: call.tool, ...(call.url === undefined ? {} : { url: call.url }), verdict: 'allowed', ...(message.error === undefined ? resultSummary(message.result) : { error: true, text: String(message.error.message ?? '').slice(0, RESULT_TEXT) }) })
    }
    write(client, message)
  })
}

/** Starts a command from the project in a process group of its own, so that its end ends everything it started. */
function startCommand(command, label, children, stop) {
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  children.push(child)
  child.on('exit', (code, signal) => {
    process.stderr.write(`[bmn] ${label} ended (${signal ?? code})\n`)
    stop()
  })
}

function endAll(children) {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    process.exit(0)
  }, 1000).unref()
}

/** The app's space: the services, then the app, each from the project; its port offered as /bridge/app.sock. Everything ends when one ends. */
function appSpace(spec) {
  const children = []
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    endAll(children)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop)
  spec.services.forEach((command, index) => startCommand(command, `service ${index + 1}`, children, stop))
  startCommand(spec.serve, 'the app', children, stop)
  rmSync('/bridge/app.sock', { force: true })
  createServer((socket) => {
    const upstream = createConnection(spec.port, '127.0.0.1')
    pipeBoth(socket, upstream)
  }).listen('/bridge/app.sock')
}

/** The browser's space: the app's origin relayed to the app's space, and Playwright MCP behind BMN's filter on /mcp/mcp.sock, for one connection. */
function browserSpace(spec) {
  createServer((socket) => pipeBoth(socket, createConnection('/bridge/app.sock'))).listen(spec.port, '127.0.0.1')
  mkdirSync('/out/files', { recursive: true })
  // Downloads off and service workers blocked in the browser itself; its profile only in memory (74.3 AC3, AC5). Chromium's own
  // sandbox needs a user namespace inside this space, which this computer's AppArmor refuses (as in 74.1): the space is the boundary
  // (owner, 2026-10-15; scripts/lib/sandbox-flag-audit.mjs names this one line as his exception, so a change to it is found again).
  const config = {
    browser: {
      browserName: 'chromium', isolated: true,
      launchOptions: { headless: true, executablePath: spec.chromium, chromiumSandbox: false },
      contextOptions: { acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } }
    },
    outputDir: '/out/files'
  }
  writeFileSync('/tmp/mcp-config.json', `${JSON.stringify(config)}\n`)
  const log = (entry) => appendFileSync('/out/calls.jsonl', `${JSON.stringify(entry)}\n`)
  let child = null
  const stop = () => {
    if (child !== null) child.kill('SIGTERM')
    setTimeout(() => process.exit(0), 500).unref()
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop)
  rmSync('/mcp/mcp.sock', { force: true })
  const server = createServer((socket) => {
    // One teammate, one connection: the socket is closed to any other.
    server.close()
    child = spawn(process.execPath, [spec.mcp, '--config', '/tmp/mcp-config.json', '--allowed-origins', spec.origin, '--block-service-workers', '--image-responses', 'allow'],
      { stdio: ['pipe', 'pipe', 'inherit'], cwd: '/out/files' })
    child.stdin.on('error', () => undefined)
    filterMcp(socket, child.stdin, child.stdout, { tools: spec.tools, origin: spec.origin, log })
    socket.on('close', () => child.kill('SIGTERM'))
    child.on('exit', () => {
      socket.destroy()
      stop()
    })
  })
  server.listen('/mcp/mcp.sock')
}

/** The teammate's MCP server inside its container: one connection to the filter, as its standard input and output. */
function connect(socketPath) {
  const socket = createConnection(socketPath)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  socket.on('close', () => process.exit(0))
  socket.on('error', (error) => {
    process.stderr.write(`bmn: the browser is not reachable (${error.code ?? error.message})\n`)
    process.exit(1)
  })
}

const [role, argument] = process.argv.slice(2)
if (import.meta.url === `file://${process.argv[1]}`) {
  // What the spaces write (the record, screenshots, the browser's files) is the owner's alone.
  process.umask(0o077)
  if (role === 'app') appSpace(JSON.parse(argument))
  else if (role === 'browser') browserSpace(JSON.parse(argument))
  else if (role === 'connect') connect(argument)
  else {
    process.stderr.write('usage: ask-browser-space.mjs app|browser <spec-json> | connect <socket>\n')
    process.exit(2)
  }
}
