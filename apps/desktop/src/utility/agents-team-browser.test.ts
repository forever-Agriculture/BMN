// MODULE: agents-team-browser.test.ts - Story 74.3: a browser ask: its request and refusals, BMN's filter of the browser's tools, and whole asks in BMN's real network spaces and container, stand-in Codex and Claude Code driving the real browser against a synthetic app and service that try to reach a forbidden server on load, on a click and from the server side; no provider is reached
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { networkInterfaces, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { containerStarts } from '../../bin/agents-container.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { BROWSER_FILES, BROWSER_LIMITS, appSpaceArgv, browserContainment, browserIdentity, browserProgramChange, browserReady, browserSetup, browserSpaceArgv, readBrowserRequest, removeOverlay } from '../../bin/agents-team-browser.mjs'
import { folderBytes } from '../../bin/agents-team-supervisor.mjs'
import { INTERACT_TOOLS, LOOK_TOOLS, NEVER_TOOLS, filterMcp, judgeCall, offOrigin } from '../../bin/ask-browser-space.mjs'
import { askJson } from '../../bin/agents-team-cli.mjs'
import { appAskDetail } from '../../bin/agents-team-app.mjs'
import { exportAsk, startAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { evaluateAsk, teamRunsDirectory } from '../../bin/agents-check.mjs'
import { AskRefusal } from '../../bin/agents-team-resolve.mjs'
import { leftovers as harnessLeftovers, settle, teamAskHome } from './test-fixtures/team-ask-harness'

// The browser's programs are read where the owner's computer keeps them (npm's cache, Playwright's browsers), never written.
const REAL_HOME = userInfo().homedir
const PROGRAMS = { npm_config_cache: join(REAL_HOME, '.npm'), PLAYWRIGHT_BROWSERS_PATH: join(REAL_HOME, '.cache/ms-playwright') }
const NODE_FOLDER = dirname(process.execPath)
const found = browserSetup({ HOME: REAL_HOME, PATH: `${NODE_FOLDER}:/usr/bin:/bin`, ...PROGRAMS })
const canBrowse = containerStarts().ok && browserContainment().ok && found.unavailable === undefined
const ORIGIN = 'http://127.0.0.1:4173'
const QUESTION = 'Does the synthetic shop page show its heading?'

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

/**
 * The stand-in teammate's client, run with the Node the container binds: it talks to the browser through BMN's filter as the
 * app's MCP client would, follows the steps its question names, and answers in its app's own events with what each step did.
 */
const CLIENT = [
  'const net = require("node:net"); const crypto = require("node:crypto");',
  'const q = process.env.QUESTION; const id = crypto.createHash("md5").update(q).digest("hex").slice(0, 8);',
  'const steps = JSON.parse(Buffer.from(q.match(/STEPS:([A-Za-z0-9+/=]+)/)[1], "base64").toString());',
  'const s = net.createConnection("/ask/browser/mcp.sock"); let buf = ""; let n = 0; const waiting = new Map();',
  's.on("data", (c) => { buf += c; for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (waiting.has(m.id)) waiting.get(m.id)(m); } });',
  'const call = (method, params) => new Promise((r) => { const k = ++n; waiting.set(k, r); s.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\\n"); });',
  's.on("error", (e) => { process.stderr.write("client: " + e.message + "\\n"); process.exit(4); });',
  's.on("connect", async () => {',
  '  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stand-in", version: "1" } });',
  '  s.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");',
  '  const out = { tools: (await call("tools/list", {})).result.tools.map((t) => t.name), resources: (await call("resources/list", {})).result, steps: [] };',
  '  let last = "";',
  '  for (const [name, args] of steps) { if (args.target === "REF") args.target = (last.match(/button "Act[^\\n]*\\[ref=(e[0-9]+)\\]/) ?? [])[1]; const r = await call("tools/call", { name, arguments: args }); const text = (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" "); out.steps.push({ name, error: r.result?.isError === true, images: (r.result?.content ?? []).filter((c) => c.type === "image").length, text: text.slice(0, 300) }); last = text; }',
  '  s.end(); const answer = "BROWSER-RESULT " + JSON.stringify(out); const p = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  '  if (process.env.APP === "codex") { const t = id + "-0000-7000-8000-000000000000"; p({ type: "thread.started", thread_id: t }); p({ type: "turn.started" });',
  '    process.stderr.write("INFO turn{otel.name=\\"session_task.turn\\" thread.id=" + t + " turn.id=t-1 model=" + process.env.MODEL + " codex.turn.reasoning_effort=" + process.env.EFFORT + "}: started\\n");',
  '    p({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: answer } }); p({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 } });',
  '  } else { const sid = id + "-0000-4000-8000-000000000000"; p({ type: "system", subtype: "init", session_id: sid, model: process.env.MODEL, apiKeySource: "none", tools: [] });',
  '    p({ type: "assistant", session_id: sid, message: { model: process.env.MODEL, usage: { input_tokens: 3, output_tokens: 4 } } });',
  '    p({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sid, total_cost_usd: 0.0123, usage: { input_tokens: 3, cache_creation_input_tokens: 7, cache_read_input_tokens: 11, output_tokens: 4 } }); }',
  '  process.exit(0);',
  '});'
].join('\n')

function stubApps(): void {
  writeFileSync(join(stubs, 'codex'), `#!/bin/sh
[ "$1" = --version ] && echo "codex-cli 0.162.1" && exit 0
model=; effort=; node=; prev=
for a in "$@"; do
  [ "$prev" = -m ] && model=$a
  case $a in model_reasoning_effort=*) effort=$(printf %s "$a" | sed 's/.*="\\(.*\\)"/\\1/');; mcp_servers=*) node=$(printf %s "$a" | sed -n 's/^mcp_servers={browser={command="\\([^"]*\\)".*/\\1/p');; esac
  prev=$a
done
question=$(cat)
APP=codex MODEL=$model EFFORT=$effort QUESTION=$question exec "$node" -e '${CLIENT}'
`, { mode: 0o755 })
  writeFileSync(join(stubs, 'claude'), `#!/bin/sh
[ "$1" = --version ] && echo "2.1.300 (Claude Code)" && exit 0
model=; prev=; node=
for a in "$@"; do
  [ "$prev" = --model ] && model=$a
  [ "$prev" = --mcp-config ] && node=$(printf %s "$a" | sed -n 's/.*"command":"\\([^"]*\\)".*/\\1/p')
  prev=$a
done
question=$(cat)
APP=claude MODEL=$model QUESTION=$question exec "$node" -e '${CLIENT}'
`, { mode: 0o755 })
}

/** The steps a stand-in takes, carried in its question so the prompt BMN wrote is all it reads. */
const stepsWords = (steps: Array<[string, Record<string, unknown>]>): string => `${QUESTION} STEPS:${Buffer.from(JSON.stringify(steps)).toString('base64')}`

/** A host-side server the app must never reach: it counts every connection, on loopback and on this computer's own network address. */
async function forbiddenServer(): Promise<{ hits: () => number; port: number; lan: string | null; close: () => void }> {
  let hits = 0
  const lan = Object.values(networkInterfaces()).flat().find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address ?? null
  const servers: Server[] = []
  const listen = (host: string, port: number) => new Promise<number>((resolve) => {
    const server = createServer((socket) => {
      hits += 1
      socket.destroy()
    })
    servers.push(server)
    server.listen(port, host, () => resolve((server.address() as { port: number }).port))
  })
  const port = await listen('127.0.0.1', 0)
  if (lan !== null) await listen(lan, port)
  return { hits: () => hits, port, lan, close: () => servers.forEach((server) => server.close()) }
}

/**
 * The synthetic app and its service: on load and on a click its page tries the forbidden server directly and through every
 * way a page reaches out; the app's server tries it directly and through the service, which BMN started; a destructive GET
 * handler is reachable by navigation. Nothing here is real: every address is made up or the test's own.
 */
function writeApp(project: string, forbidden: { port: number; lan: string | null }): void {
  mkdirSync(project, { recursive: true })
  const targets = [`http://127.0.0.1:${forbidden.port}`, ...(forbidden.lan === null ? [] : [`http://${forbidden.lan}:${forbidden.port}`]), 'http://192.0.2.1']
  writeFileSync(join(project, 'app.mjs'), `import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
const targets = ${JSON.stringify(targets)}
const tries = (where) => { for (const target of targets) { const url = new URL(target); const socket = connect(Number(url.port || 80), url.hostname); socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy()) } }
tries('app')
// Through the service BMN started beside it: the service tries too.
setTimeout(() => request('http://127.0.0.1:4174/relay').on('error', () => {}).end(), 300)
writeFileSync('written-by-the-app.txt', 'the overlay keeps nothing')
const page = (title, body) => '<!doctype html><title>' + title + '</title><h1>' + title + '</h1>' + body
createServer((req, res) => {
  if (req.url === '/escapes.js' || req.url === '/worker.js') {
    res.setHeader('content-type', 'text/javascript')
    return res.end(readFileSync(req.url.slice(1)))
  }
  // A redirect off the origin: the browser follows it into nothing.
  if (req.url === '/redirect') return res.writeHead(302, { location: targets[0] + '/redirected' }).end()
  res.setHeader('content-type', 'text/html')
  if (req.url === '/delete-everything') return res.end(page('Deleted (synthetic)', '<p>A destructive GET a link offers.</p>'))
  res.end(page('Synthetic shop', '<p id="state">ready</p><button onclick="tryAll(false); document.getElementById(\\'state\\').textContent = \\'clicked\\'">Act</button><a href="/delete-everything">delete everything</a><script src="/escapes.js"></script><script>tryAll(true)</script>'))
}).listen(Number(process.env.PORT), '127.0.0.1')
`)
  // Every way of 74.1 AC1 a page leaves its origin, toward each forbidden target, on load and on a click (a pop-up on load only:
  // one opened by a click would become the browser's current page).
  writeFileSync(join(project, 'escapes.js'), `const T = ${JSON.stringify(targets)}
function tryAll(loading) {
  for (const t of T) {
    fetch(t + '/page').catch(() => {}); fetch(t + '/no-cors', { mode: 'no-cors' }).catch(() => {}); new Image().src = t + '/img'
    const x = new XMLHttpRequest(); x.open('GET', t + '/xhr'); x.onerror = () => {}; x.send()
    for (const [tag, attr] of [['script', 'src'], ['link', 'href'], ['iframe', 'src']]) { const e = document.createElement(tag); if (tag === 'link') e.rel = 'stylesheet'; e[attr] = t + '/' + tag; e.onerror = () => {}; document.body.appendChild(e) }
    try { new WebSocket(t.replace('http', 'ws') + '/ws').onerror = () => {} } catch {}
    try { const e = new EventSource(t + '/events'); setTimeout(() => e.close(), 3000) } catch {}
    try { navigator.sendBeacon(t + '/beacon', 'x') } catch {}
    try { new Worker('/worker.js').postMessage(t + '/worker') } catch {}
  }
  fetch('/redirect').catch(() => {})
  const r = document.createElement('iframe'); r.src = '/redirect'; document.body.appendChild(r)
  try { const u = new URL(T[0]); const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:' + u.hostname + ':' + u.port }, { urls: 'turn:' + u.hostname + ':' + u.port + '?transport=tcp', username: 'u', credential: 'p' }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {}) } catch {}
  if (loading) try { window.open(T[0] + '/popup', '_blank') } catch {}
}
`)
  writeFileSync(join(project, 'worker.js'), 'onmessage = (m) => { fetch(m.data).catch(() => {}); try { new WebSocket(String(m.data).replace("http", "ws")).onerror = () => {} } catch {} }\n')
  writeFileSync(join(project, 'service.mjs'), `import { createServer } from 'node:http'
import { connect } from 'node:net'
const targets = ${JSON.stringify(targets)}
createServer((req, res) => {
  for (const target of targets) { const url = new URL(target); const socket = connect(Number(url.port || 80), url.hostname); socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy()) }
  res.end('tried')
}).listen(4174, '127.0.0.1')
`)
}

const browserRequest = (fields: Record<string, unknown> = {}) => ({ serve: 'node app.mjs', origin: ORIGIN, services: ['node service.mjs'], interact: false, disposable: true, ...fields })
const ask = (request: Partial<Parameters<typeof prepareAsk>[0]>) =>
  prepareAsk({ role: 'browser', question: QUESTION, browser: browserRequest(), project: join(home, 'code/shop'), ...request }, { environment: env, cwd: home, home })
const refusal = (run: () => unknown): { code: string; message: string } => {
  try {
    run()
  } catch (error) {
    if (error instanceof AskRefusal) return error
    if (error instanceof Error) return { code: (error as { code?: string }).code ?? error.constructor.name, message: error.message }
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-browser-'))
  env = { ...env, PATH: `${stubs}:${NODE_FOLDER}:/usr/bin:/bin`, ...PROGRAMS }
  stubApps()
  mkdirSync(join(home, 'code/shop'), { recursive: true })
})

afterEach(async () => {
  await settle(() => harnessLeftovers(home).length === 0, 8000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe('a browser ask\'s request (74.3 AC1, AC2)', () => {
  it('needs the app\'s command, an origin at 127.0.0.1 with a port from 1024, bounded commands, and the asker\'s statement', () => {
    expect(readBrowserRequest({ origin: ORIGIN, disposable: true })).toMatchObject({ usage: expect.stringContaining('--serve') })
    for (const origin of ['http://localhost:4173', 'https://127.0.0.1:4173', 'http://127.0.0.1:80', 'http://127.0.0.1:4173/', 'http://192.0.2.1:4173']) {
      expect(readBrowserRequest({ serve: 'node app.mjs', origin, disposable: true })).toMatchObject({ usage: expect.stringContaining('--origin') })
    }
    expect(readBrowserRequest({ serve: 'node app.mjs', origin: ORIGIN, services: Array(BROWSER_LIMITS.services + 1).fill('x'), disposable: true })).toMatchObject({ usage: expect.stringContaining('--service') })
    expect(readBrowserRequest({ serve: 'x'.repeat(BROWSER_LIMITS.command + 1), origin: ORIGIN, disposable: true })).toMatchObject({ usage: expect.stringContaining('bytes') })
    expect(readBrowserRequest({ serve: 'node app.mjs', origin: ORIGIN })).toMatchObject({ code: 'BROWSER_STATEMENT_REQUIRED', message: expect.stringContaining('navigation and the page\'s own code may change the app\'s state') })
    expect(readBrowserRequest({ serve: 'node app.mjs', origin: ORIGIN, services: ['node db.mjs'], interact: true, disposable: true })).toEqual({ request: { serve: 'node app.mjs', origin: ORIGIN, port: 4173, services: ['node db.mjs'], interact: true } })
  })

  it('is refused without the statement, as public, with files or another access, without a project, and on OpenCode; nothing is copied', () => {
    expect(refusal(() => ask({ browser: browserRequest({ disposable: false }) }))).toMatchObject({ code: 'BROWSER_STATEMENT_REQUIRED' })
    expect(refusal(() => ask({ data: 'public' })).message).toContain('browser asks are private')
    expect(refusal(() => ask({ access: 'project' })).message).toContain('a browser ask gives the teammate the app')
    expect(refusal(() => ask({ project: undefined })).message).toContain('a browser ask starts the app from its project')
    expect(existsSync(teamRunsDirectory()) ? readdirSync(teamRunsDirectory()) : []).toEqual([])
  })

  it('is refused when a command holds a credential BMN recognises: the commands are kept in the record and its export (pre-review)', () => {
    // A made-up key, spelled in parts so no scanner of this repository takes it for one.
    const key = `sk-${'proj'}-${createHash('sha256').update('made-up browser key').digest('hex').slice(0, 48)}`
    for (const browser of [browserRequest({ serve: `OPENAI_API_KEY=${key} node app.mjs` }), browserRequest({ services: [`node service.mjs --token ${key}`] })]) {
      const refused = refusal(() => ask({ browser }))
      expect(refused).toMatchObject({ code: 'CREDENTIAL_FOUND', message: expect.stringContaining("the app's commands hold an OpenAI key") })
      expect(refused.message).not.toContain(key.slice(8))
    }
    expect(existsSync(teamRunsDirectory()) ? readdirSync(teamRunsDirectory()) : []).toEqual([])
  })
})

describe('the browser\'s programs are held to what the check judged (owner\'s consult)', () => {
  it('a change anywhere in the tool\'s packages or Chromium\'s folder, not only the files they start from, stops the launch', () => {
    const made = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const setup = {
      node: { path: join(home, 'node/bin/node'), root: join(home, 'node') },
      mcp: { modules: join(home, 'npx/node_modules'), cli: join(home, 'npx/node_modules/@playwright/mcp/cli.js'), version: '0.0.75' },
      chromium: { folder: join(home, 'chromium-1234'), path: join(home, 'chromium-1234/chrome-linux64/chrome') }
    }
    made(setup.node.path, 'synthetic node')
    made(setup.mcp.cli, 'synthetic cli')
    made(join(setup.mcp.modules, '@playwright/mcp/package.json'), '{"version":"0.0.75"}')
    made(join(setup.mcp.modules, 'playwright-core/lib/coreBundle.js'), 'synthetic bundle')
    made(setup.chromium.path, 'synthetic chrome')
    made(join(setup.chromium.folder, 'chrome-linux64/libsynthetic.so'), 'synthetic library')
    const identity = browserIdentity(setup)
    expect(browserProgramChange(identity)).toBeNull()
    writeFileSync(join(setup.mcp.modules, 'playwright-core/lib/coreBundle.js'), 'changed bundle')
    expect(browserProgramChange(identity)).toBe('the browser tool\'s files changed after the check')
    const again = browserIdentity(setup)
    made(join(setup.mcp.modules, 'playwright-core/lib/added.js'), 'a file added')
    expect(browserProgramChange(again)).toBe('the browser tool\'s files changed after the check')
    const third = browserIdentity(setup)
    writeFileSync(join(setup.chromium.folder, 'chrome-linux64/libsynthetic.so'), 'changed library')
    expect(browserProgramChange(third)).toBe('Chromium changed after the check')
  })
})

describe('a browser ask\'s storage is bounded from its start (owner\'s consult)', () => {
  it('each space\'s memory-backed folders have a size, and the app\'s writes to its project go to the run\'s folder, never the project', () => {
    const folder = join(home, 'run')
    const nodeRoot = join(home, 'node')
    mkdirSync(join(nodeRoot, 'etc'), { recursive: true })
    const spec = { node: join(nodeRoot, 'bin/node'), node_root: nodeRoot, project: join(home, 'code/shop'), port: 4173, origin: ORIGIN, serve: 'node app.mjs', services: [], tools: [...LOOK_TOOLS], mcp: { modules: join(home, 'mcp'), cli: join(home, 'mcp/cli.js') }, chromium: { folder: join(home, 'chromium'), path: join(home, 'chromium/chrome') } }
    const app = appSpaceArgv(folder, spec)
    const browser = browserSpaceArgv(folder, spec)
    for (const argv of [app, browser]) {
      const mounts = argv.flatMap((value: string, index: number) => (value === '--tmpfs' ? [[argv[index - 2], argv[index - 1], argv[index + 1]]] : []))
      expect(mounts.length).toBeGreaterThan(0)
      for (const [option, size] of mounts) expect([option, Number(size) > 0]).toEqual(['--size', true])
    }
    expect(app.slice(app.indexOf('--tmpfs', app.indexOf('/tmp') - 1) - 2, app.indexOf('/tmp') + 1)).toEqual(['--size', String(BROWSER_LIMITS.tmpBytes), '--tmpfs', '/tmp'])
    expect(browser[browser.indexOf('/dev/shm') - 2]).toBe(String(BROWSER_LIMITS.shmBytes))
    expect(app).not.toContain('--tmp-overlay')
    const overlay = app.indexOf('--overlay')
    expect(app.slice(overlay - 2, overlay + 4)).toEqual(['--overlay-src', spec.project, '--overlay', join(folder, BROWSER_FILES.upper), join(folder, BROWSER_FILES.work), spec.project])
  })

  it('the app\'s writes are counted with the run, overlayfs\'s own work folder is not entered, and all of it is removed even when unreadable', () => {
    const folder = join(home, 'run')
    mkdirSync(join(folder, BROWSER_FILES.work, 'work'), { recursive: true })
    mkdirSync(join(folder, BROWSER_FILES.upper, 'cache'), { recursive: true })
    writeFileSync(join(folder, BROWSER_FILES.upper, 'cache/build.bin'), Buffer.alloc(4096))
    writeFileSync(join(folder, 'answer.md'), 'x'.repeat(10))
    chmodSync(join(folder, BROWSER_FILES.work, 'work'), 0o000)
    chmodSync(join(folder, BROWSER_FILES.upper, 'cache'), 0o000)
    // A folder the app made unreadable cannot be measured: the run's storage says so, never counts it as nothing.
    expect(() => folderBytes(folder, new Set([join(folder, BROWSER_FILES.work)]))).toThrow(/EACCES/u)
    chmodSync(join(folder, BROWSER_FILES.upper, 'cache'), 0o700)
    expect(() => folderBytes(folder)).toThrow(/EACCES/u)
    expect(folderBytes(folder, new Set([join(folder, BROWSER_FILES.work)]))).toBe(4096 + 10)
    chmodSync(join(folder, BROWSER_FILES.upper, 'cache'), 0o000)
    removeOverlay(folder)
    expect(existsSync(join(folder, BROWSER_FILES.overlay))).toBe(false)
    expect(readFileSync(join(folder, 'answer.md'), 'utf8')).toBe('x'.repeat(10))
    removeOverlay(folder)
  })

  it('the wait for the app ends on the run\'s storage, measured about once a second, before it ends on the time it had', async () => {
    const running = { exitCode: null, signalCode: null }
    const spaces = { app: running, browser: running } as unknown as Parameters<typeof browserReady>[2]
    let measured = 0
    const why = await browserReady(join(home, 'run'), { origin: ORIGIN, port: 4173 }, spaces, { until: Date.now() + 10_000, storage: () => (++measured < 3 ? null : 'the run\'s storage reached 9 bytes, over 8') })
    expect(why).toBe('the run\'s storage reached 9 bytes, over 8')
    expect(measured).toBe(3)
  })
})

describe('BMN\'s filter of the browser\'s tools (74.3 AC3, AC4, AC5)', () => {
  const look = { tools: [...LOOK_TOOLS], origin: ORIGIN }
  const interact = { tools: [...LOOK_TOOLS, ...INTERACT_TOOLS], origin: ORIGIN }

  it('refuses the teammate\'s own scripts, uploads and drops always, clicking and typing in a look ask, and every address off the origin', () => {
    for (const name of Object.keys(NEVER_TOOLS)) {
      expect(judgeCall(name, {}, interact)).toEqual({ ok: false, reason: NEVER_TOOLS[name as keyof typeof NEVER_TOOLS] })
    }
    for (const name of INTERACT_TOOLS) expect(judgeCall(name, {}, look)).toMatchObject({ ok: false, reason: expect.stringContaining('--interact') })
    for (const name of INTERACT_TOOLS) expect(judgeCall(name, {}, interact).ok).toBe(true)
    expect(judgeCall('browser_install', {}, interact)).toMatchObject({ ok: false, reason: 'browser_install is not a tool a browser ask uses' })
    for (const url of ['https://127.0.0.1:4173/', 'http://127.0.0.1:4174/', 'http://localhost:4173/', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://version', 'data:text/html,x', 'http://192.0.2.1/', 'not an address']) {
      expect(judgeCall('browser_navigate', { url }, look).ok).toBe(false)
      expect(offOrigin(url, ORIGIN)).not.toBeNull()
    }
    expect(judgeCall('browser_tabs', { action: 'new', url: 'https://example.org/' }, look).ok).toBe(false)
    expect(judgeCall('browser_navigate', { url: `${ORIGIN}/cart?x=1` }, look)).toEqual({ ok: true, args: { url: `${ORIGIN}/cart?x=1` } })
    // The browser writes where BMN says: a file name of the teammate's is dropped.
    expect(judgeCall('browser_take_screenshot', { filename: '../../escape.png', type: 'png' }, look)).toEqual({ ok: true, args: { type: 'png' } })
  })

  it('offers only the ask\'s tools, nothing to read, asks the teammate for nothing, and logs each call with its verdict', async () => {
    const client = new PassThrough()
    const toClient = new PassThrough()
    const toServer = new PassThrough()
    const fromServer = new PassThrough()
    const logged: Array<Record<string, unknown>> = []
    const socket = Object.assign(client, { write: toClient.write.bind(toClient) })
    filterMcp(socket as never, toServer as never, fromServer as never, { ...look, log: (entry: Record<string, unknown>) => logged.push(entry) })
    const sent: unknown[] = []
    const received: unknown[] = []
    toServer.on('data', (chunk) => String(chunk).trim().split('\n').forEach((line) => sent.push(JSON.parse(line))))
    toClient.on('data', (chunk) => String(chunk).trim().split('\n').forEach((line) => received.push(JSON.parse(line))))
    const ask = (message: object) => client.emit('data', `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    ask({ id: 1, method: 'tools/list', params: {} })
    ask({ id: 2, method: 'resources/list', params: {} })
    ask({ id: 3, method: 'prompts/list', params: {} })
    ask({ id: 4, method: 'resources/read', params: { uri: 'file:///etc/passwd' } })
    ask({ id: 5, method: 'tools/call', params: { name: 'browser_evaluate', arguments: { function: '() => 1' } } })
    ask({ id: 6, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: `${ORIGIN}/` } } })
    fromServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: ['browser_navigate', 'browser_evaluate', 'browser_click', 'browser_install'].map((name) => ({ name })) } })}\n`)
    fromServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'roots/list' })}\n`)
    fromServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'r2', method: 'sampling/createMessage', params: {} })}\n`)
    fromServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: '### Page\n- Page URL: http://127.0.0.1:4173/\n- Page Title: Synthetic shop' }] } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    type Answer = { result: { tools: Array<{ name: string }>; content: Array<{ text: string }> } & Record<string, unknown>; error: { code: number } }
    const answer = (id: number) => received.find((message) => (message as { id?: unknown }).id === id) as Answer
    expect(answer(1).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['browser_navigate'])
    expect(answer(2).result).toEqual({ resources: [] })
    expect(answer(3).result).toEqual({ prompts: [] })
    expect(answer(4).error.code).toBe(-32601)
    expect(answer(5).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('runs none of the teammate\'s own scripts') }] })
    expect(answer(6).result.content[0]?.text).toContain('Synthetic shop')
    // Only the list and the allowed call reached the browser; its own requests were answered by BMN, never passed on.
    expect(sent.map((message) => (message as { id?: unknown }).id).filter((id) => typeof id === 'number')).toEqual([1, 6])
    expect(sent).toEqual(expect.arrayContaining([{ jsonrpc: '2.0', id: 'r1', result: { roots: [] } }, expect.objectContaining({ id: 'r2', error: expect.anything() })]))
    expect(received.some((message) => (message as { method?: unknown }).method !== undefined)).toBe(false)
    expect(logged.map((entry) => [entry.tool ?? entry.method, entry.verdict])).toEqual([['resources/read', 'refused'], ['browser_evaluate', 'refused'], ['browser_navigate', 'allowed']])
    expect(logged[2]).toMatchObject({ page: 'http://127.0.0.1:4173/', title: 'Synthetic shop' })
  })
})

describe.skipIf(!canBrowse)('whole browser asks in BMN\'s spaces and container (74.3 AC1, AC3-AC6)', { timeout: 120_000 }, () => {
  it('a look ask on Codex: the app and its service start in their space, the page and the servers reach nothing else, a look cannot click, and all ends with the ask', async () => {
    const forbidden = await forbiddenServer()
    try {
      const project = join(home, 'code/shop')
      writeApp(project, forbidden)
      const steps: Array<[string, Record<string, unknown>]> = [
        ['browser_navigate', { url: `${ORIGIN}/` }], ['browser_wait_for', { time: 2 }], ['browser_take_screenshot', { filename: '../../../escape.png' }],
        ['browser_click', { element: 'Act', target: 'e4' }], ['browser_evaluate', { function: '() => fetch("http://192.0.2.1/")' }], ['browser_file_upload', { paths: ['/etc/passwd'] }],
        ['browser_navigate', { url: 'https://example.org/' }], ['browser_navigate', { url: 'file:///etc/passwd' }], ['browser_tabs', { action: 'new', url: 'http://192.0.2.1/' }],
        ['browser_navigate', { url: `${ORIGIN}/delete-everything` }]
      ]
      const prepared = ask({ question: stepsWords(steps), agent: 'luna' })
      expect(prepared.verdict).toMatchObject({ verdict: 'PASS', receipt: { form: 'codex-browser', browser: { origin: ORIGIN, interact: false, services: 1, tools: [...LOOK_TOOLS], mcp: '0.0.75', chromium: '1234' } } })
      expect(prepared.argv).not.toContain('code_mode_host')
      expect(prepared.argv.find((value: string) => value.startsWith('mcp_servers='))).toContain(`enabled_tools=${JSON.stringify(LOOK_TOOLS).replace(/"/g, '"')}`)
      startAsk(prepared, { timeLimitMinutes: 2 })
      const outcome = await waitAsk(prepared.folder, { timeoutMs: 100_000 })
      expect(outcome).toMatchObject({ state: 'answered', exit: 0 })
      const result = JSON.parse(readFileSync(join(prepared.folder, 'answer.md'), 'utf8').replace(/^BROWSER-RESULT /u, ''))
      expect(new Set(result.tools)).toEqual(new Set(LOOK_TOOLS))
      expect(result.resources).toEqual({ resources: [] })
      const step = (index: number) => result.steps[index]
      expect(step(0)).toMatchObject({ error: false, text: expect.stringContaining('Page Title: Synthetic shop') })
      expect(step(2)).toMatchObject({ error: false, images: 1 })
      for (const index of [3, 4, 5, 6, 7, 8]) expect(step(index)).toMatchObject({ error: true, text: expect.stringContaining('BMN refused') })
      expect(step(9)).toMatchObject({ error: false, text: expect.stringContaining('Deleted (synthetic)') })
      // Nothing reached the forbidden server: not the page on load, not the app's server, not the service.
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(forbidden.hits()).toBe(0)
      // The record: the pages visited and the screenshot, kept under the run; the teammate's file name went nowhere.
      const record = JSON.parse(readFileSync(join(prepared.folder, BROWSER_FILES.record), 'utf8'))
      expect(record.pages.map((page: { url: string; title: string }) => [page.url, page.title])).toEqual([[`${ORIGIN}/`, 'Synthetic shop'], [`${ORIGIN}/delete-everything`, 'Deleted (synthetic)']])
      expect(record.screenshots).toHaveLength(1)
      expect(record.refused.map((entry: { tool: string }) => entry.tool)).toEqual(['browser_click', 'browser_evaluate', 'browser_file_upload', 'browser_navigate', 'browser_navigate', 'browser_tabs'])
      expect(existsSync(join(prepared.folder, 'escape.png')) || existsSync(join(home, 'escape.png')) || existsSync(join(prepared.folder, 'browser/escape.png'))).toBe(false)
      // Everything BMN started ended with the ask, the app's writes went with its overlay, and the sockets are gone.
      expect(JSON.parse(readFileSync(join(prepared.folder, BROWSER_FILES.spaces), 'utf8')).left).toEqual([])
      expect(existsSync(join(project, 'written-by-the-app.txt'))).toBe(false)
      expect(existsSync(join(prepared.folder, BROWSER_FILES.overlay))).toBe(false)
      expect(existsSync(join(prepared.folder, BROWSER_FILES.mcp))).toBe(false)
      await settle(() => harnessLeftovers(home).length === 0, 8000)
      expect(harnessLeftovers(home)).toEqual([])
      // `team asks show`, Team › Asks and an export list the pages and the screenshot.
      expect(askJson(prepared.folder).browser).toMatchObject({ origin: ORIGIN, interact: false, pages: record.pages, screenshots: record.screenshots })
      const detail = appAskDetail(prepared.id, { runs: teamRunsDirectory() })
      expect(detail.line.reads).toMatchObject({ access: 'question', browser: { origin: ORIGIN, interact: false } })
      expect(detail.browser).toMatchObject({ origin: ORIGIN, pages: [{ url: `${ORIGIN}/`, title: 'Synthetic shop' }, { url: `${ORIGIN}/delete-everything`, title: 'Deleted (synthetic)' }], screenshots: [{ name: record.screenshots[0].name }], refused: 6 })
      const exported = exportAsk(prepared.folder, join(home, 'export'))
      expect(exported).toEqual(expect.arrayContaining([BROWSER_FILES.record, BROWSER_FILES.calls, BROWSER_FILES.spaces, `${BROWSER_FILES.files}/${record.screenshots[0].name}`]))
      expect(exported.some((path: string) => path.endsWith('.log'))).toBe(false)
    } finally {
      forbidden.close()
    }
  })

  it('an interact ask on Claude Code clicks inside the origin; the click\'s own requests reach nothing else, and its scripts stay refused', async () => {
    const forbidden = await forbiddenServer()
    try {
      const project = join(home, 'code/shop')
      writeApp(project, forbidden)
      const steps: Array<[string, Record<string, unknown>]> = [
        ['browser_navigate', { url: `${ORIGIN}/` }], ['browser_snapshot', {}], ['browser_click', { element: 'Act button', target: 'REF' }],
        ['browser_wait_for', { text: 'clicked', time: 5 }], ['browser_run_code_unsafe', { code: 'await page.goto("http://192.0.2.1/")' }], ['browser_drop', {}]
      ]
      // The click needs the button's reference from the page's snapshot: the stand-in takes it from there. Only Luna holds the
      // browser role in the example team, so the Claude Code teammate is Fable asked as the designer: any role may ask with a browser.
      const prepared = ask({ role: 'designer', question: stepsWords(steps), agent: 'fable', browser: browserRequest({ interact: true }) })
      expect(prepared.verdict).toMatchObject({ verdict: 'PASS', receipt: { form: 'claude-browser', browser: { interact: true, tools: [...LOOK_TOOLS, ...INTERACT_TOOLS] } } })
      const allowed = prepared.argv[prepared.argv.indexOf('--allowedTools') + 1]
      expect((allowed ?? '').split(',')).toEqual([...LOOK_TOOLS, ...INTERACT_TOOLS].map((tool) => `mcp__browser__${tool}`))
      startAsk(prepared, { timeLimitMinutes: 2 })
      const outcome = await waitAsk(prepared.folder, { timeoutMs: 100_000 })
      expect(outcome).toMatchObject({ state: 'answered', exit: 0 })
      const result = JSON.parse(readFileSync(join(prepared.folder, 'answer.md'), 'utf8').replace(/^BROWSER-RESULT /u, ''))
      expect(new Set(result.tools)).toEqual(new Set([...LOOK_TOOLS, ...INTERACT_TOOLS]))
      expect(result.steps[2], JSON.stringify(result.steps.slice(1, 3))).toMatchObject({ error: false })
      expect(result.steps[3]).toMatchObject({ error: false })
      for (const index of [4, 5]) expect(result.steps[index]).toMatchObject({ error: true, text: expect.stringContaining('BMN refused') })
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(forbidden.hits()).toBe(0)
      expect(JSON.parse(readFileSync(join(prepared.folder, BROWSER_FILES.spaces), 'utf8')).left).toEqual([])
    } finally {
      forbidden.close()
    }
  })

  it('an app that never answers at its origin fails the ask before the teammate starts, and nothing is left', async () => {
    writeFileSync(join(home, 'code/shop/app.mjs'), 'setTimeout(() => {}, 600000)\n')
    const prepared = ask({ question: stepsWords([]), browser: browserRequest({ services: [] }) })
    const spec = JSON.parse(readFileSync(join(prepared.folder, BROWSER_FILES.spec), 'utf8'))
    expect(spec.ready_ms).toBe(BROWSER_LIMITS.readyMs)
    startAsk(prepared, { timeLimitMinutes: 0.1 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 30_000 })
    expect(outcome).toMatchObject({ state: 'out-of-time', reason: expect.stringContaining('time limit') })
    expect(existsSync(join(prepared.folder, 'events.jsonl'))).toBe(false)
    await settle(() => harnessLeftovers(home).length === 0, 8000)
    expect(harnessLeftovers(home)).toEqual([])
  })

  it('an app that fills the run\'s storage while it starts fails the ask before the teammate starts; its writes are not kept', async () => {
    // A sparse file the size of two GiB: the run's storage counts its size, and nothing that large is written to the disk.
    writeFileSync(join(home, 'code/shop/app.mjs'), `import { createServer } from 'node:http'
import { closeSync, ftruncateSync, openSync } from 'node:fs'
const file = openSync('build-cache.bin', 'w'); ftruncateSync(file, 2 * 1024 ** 3); closeSync(file)
setTimeout(() => createServer((req, res) => res.end('late')).listen(Number(process.env.PORT), '127.0.0.1'), 20_000)
`)
    const prepared = ask({ question: stepsWords([]), browser: browserRequest({ services: [] }) })
    startAsk(prepared, { timeLimitMinutes: 1 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 30_000 })
    expect(outcome).toMatchObject({ state: 'failed', reason: expect.stringContaining('storage') })
    expect(JSON.parse(readFileSync(join(prepared.folder, 'exit.json'), 'utf8'))).toMatchObject({ ended: 'storage', started: false, reason: expect.stringMatching(/storage reached \d+ bytes/u) })
    expect(existsSync(join(prepared.folder, 'events.jsonl'))).toBe(false)
    expect(existsSync(join(prepared.folder, BROWSER_FILES.overlay))).toBe(false)
    expect(existsSync(join(home, 'code/shop/build-cache.bin'))).toBe(false)
    await settle(() => harnessLeftovers(home).length === 0, 8000)
    expect(harnessLeftovers(home)).toEqual([])
  })

  it('a changed specification is refused by the check: the spaces start only as judged', () => {
    writeApp(join(home, 'code/shop'), { port: 9, lan: null })
    const prepared = ask({})
    expect(prepared.verdict.verdict).toBe('PASS')
    const path = join(prepared.folder, BROWSER_FILES.spec)
    writeFileSync(path, readFileSync(path, 'utf8').replace('node app.mjs', 'node app.mjs; curl http://192.0.2.1'))
    const again = evaluateAsk({ agent: 'luna', role: 'browser', effort: prepared.verdict.receipt?.effort ?? '', access: 'question', data: 'private', wide: false, run: prepared.folder, argv: prepared.argv }, { environment: env })
    expect(again).toMatchObject({ verdict: 'REFUSED', code: 'WORKSPACE_MISMATCH', message: expect.stringContaining('spaces') })
    execFileSync('true')
  })
})
