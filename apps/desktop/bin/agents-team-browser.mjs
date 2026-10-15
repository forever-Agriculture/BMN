// MODULE: agents-team-browser.mjs - Story 74.3: a teammate checks the asker's local web app with Playwright's MCP server added to its own app, limited to that loopback origin: the tools a look or an --interact ask offers, the server's command, and the record of the pages it visited and its screenshots, read from the server's own session log
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maskCredentials } from './agents-team-inputs.mjs'

/**
 * A browser ask adds one MCP server to the teammate's own app (R74-FR2): Playwright's, the version
 * dev-auto's luna-browse.sh runs and 74.1 measured, headless, with a profile kept in memory, Chrome's
 * own sandbox on, and requests limited to the asker's loopback origin. The app's own permissions
 * offer only the browser tools below; no other MCP server is added. The server saves its files in
 * the run's `browser/` folder, and its session log there is what BMN reads for the record: every
 * completed call with the page it left, written by the server, never by the model. The server writes a
 * file the model names (a screenshot, a snapshot, a log) in the client's workspace, which may be the
 * asker's project: BMN's relay (ask-browser-relay.mjs) starts it in `browser/` and keeps the app's
 * workspace roots from it, so every file it writes lands there.
 * Playwright's origin list does not stop redirects or requests a page makes itself (its own words:
 * "does not serve as a security boundary"), so every browser ask states that the app is a disposable
 * test instance with synthetic data.
 */

/** The browser tool and the name the apps know it by. */
export const BROWSER_MCP_PACKAGE = '@playwright/mcp@0.0.75'
export const BROWSER_SERVER = 'playwright'
/** The role a browser ask goes to unless the asker names another. */
export const BROWSER_ROLE = 'browser'
/** What `--disposable` states, recorded with every browser ask (74.3 AC4). */
export const BROWSER_STATEMENT = 'the app and its services are disposable test instances with synthetic data and no production backend or credentials'

/** A look ask's tools (74.3 AC1): navigate, back, snapshot, wait, screenshot, console, network requests, tabs, resize, close. */
export const LOOK_TOOLS = Object.freeze(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_wait_for', 'browser_take_screenshot',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs', 'browser_resize', 'browser_close'])
/** What `--interact` adds: click, type, fill, select, press, hover. Script evaluation, file upload, drag and dialogs are never offered. */
export const INTERACT_TOOLS = Object.freeze(['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover'])

/** What the record keeps of a browser ask: its pages and screenshots, bounded. */
export const BROWSER_LIMITS = Object.freeze({ pages: 200, url: 2000, pageTitle: 300, screenshots: 20, screenshot: 5 * 1024 * 1024 })
/** A browser ask's parts of its run folder: the server's own folder, and the record BMN writes from it. */
export const BROWSER_FILES = Object.freeze({ folder: 'browser', record: 'browser.json' })
const SCREENSHOT = /^[A-Za-z0-9._-]{1,200}\.(png|jpe?g)$/u

/** BMN's relay between the app and the server: it starts the server in the run's browser folder, without the app's workspace roots. */
export const BROWSER_RELAY = fileURLToPath(new URL('./ask-browser-relay.mjs', import.meta.url))

const ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})\/?$/u

/** The asker's origin, as BMN passes it on, or why it is refused: only a loopback `http` address with a port (74.3 AC4). */
export function browserOrigin(value) {
  const match = ORIGIN.exec(value ?? '')
  if (match === null || Number(match[2]) > 65535) return { reason: `${value} is not a loopback address of an app you started: give http://127.0.0.1:PORT (or localhost, [::1])` }
  return { origin: `http://${match[1]}:${match[2]}` }
}

/**
 * Whether the browser's server is where `npx --offline` finds it (npx's cache). `environment`: the
 * app's PATH (BMN's own folders left out) and HOME. Returns `{}` or `{ reason }`.
 */
export function browserInstalled(environment, { timeoutMs = 60_000 } = {}) {
  const result = spawnSync('npx', ['--offline', BROWSER_MCP_PACKAGE, '--version'], { env: { PATH: environment.PATH ?? '', HOME: environment.HOME ?? '' }, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error?.code === 'ENOENT') return { reason: 'npx is not on your PATH, so BMN cannot start the browser\'s server (Playwright\'s MCP server)' }
  if (result.status !== 0) return { reason: `the browser's server, ${BROWSER_MCP_PACKAGE}, is not in npx's cache here: run \`npx ${BROWSER_MCP_PACKAGE} --version\` once, then ask again` }
  return {}
}

/** The tools a browser ask offers: a look ask's, and with --interact those that click and type too. */
export function browserTools(interact) {
  return interact ? [...LOOK_TOOLS, ...INTERACT_TOOLS] : [...LOOK_TOOLS]
}

/**
 * The MCP server's command for one ask: BMN's relay on `node`, then `npx` from the owner's PATH, offline,
 * so only the cached version runs, both found where npx needs node anyway.
 */
export function browserServer(browser, folder) {
  const own = join(folder, BROWSER_FILES.folder)
  return {
    command: 'node',
    args: [BROWSER_RELAY, own, 'npx', '--offline', BROWSER_MCP_PACKAGE, '--headless', '--isolated', '--sandbox', '--allowed-origins', browser.origin, '--output-dir', own, '--save-session']
  }
}

/** The prompt's part that tells the teammate the app's address and what it may do there. */
export function browserPrompt(prompt, browser) {
  const may = browser.interact ? 'look at it and use it: navigate, read, take screenshots, click, type, fill in, select, press keys and hover' : 'look at it: navigate, read, take screenshots, and read its console and network requests; you cannot click or type'
  return `${prompt.replace(/\n?$/u, '\n')}\nThe asker started a web app at ${browser.origin} and gave you a browser (Playwright's tools) for it. You may ${may}. Only that address loads; the app is a disposable test instance with synthetic data. Say which pages you visited and what you saw.\n`
}

/** The calls in the server's session log: each completed call's tool, its arguments, the page it left and the screenshots it saved (by file name). */
export function sessionCalls(text) {
  const calls = []
  for (const part of text.split(/^### Tool call: /mu).slice(1)) {
    const tool = /^([A-Za-z0-9_]+)/u.exec(part)?.[1] ?? null
    const blocks = [...part.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => {
      try {
        return JSON.parse(match[1])
      } catch {
        return null
      }
    })
    const result = blocks[1] ?? null
    const page = typeof result?.page === 'string' ? result.page : ''
    const url = /- Page URL: ([^\n]*)/u.exec(page)?.[1] ?? null
    const title = /- Page Title: ([^\n]*)/u.exec(page)?.[1] ?? null
    const shots = tool === 'browser_take_screenshot' && typeof result?.result === 'string' ? [...result.result.matchAll(/\]\(([^)\n]+)\)/gu)].map((match) => match[1].split('/').at(-1)) : []
    calls.push({ tool, args: blocks[0] ?? null, page: url === null ? null : { url, title }, shots })
  }
  return calls
}

const bounded = (value, limit) => (typeof value === 'string' ? maskCredentials(value.slice(0, limit)).text : null)

/**
 * A browser ask's record, once its app has ended or its run was recorded interrupted (74.3 AC3): the
 * pages from the server's session log in the order visited, its screenshots (bounded in count and
 * size, kept in `browser/`), and nothing else: page snapshots, downloads and the log itself go.
 * Writes nothing; returns `{ record, removed }` for the caller to write.
 */
export function browserRecord(folder, browser) {
  const own = join(folder, BROWSER_FILES.folder)
  let entries
  try {
    entries = readdirSync(own)
  } catch {
    entries = []
  }
  const pages = []
  // Only a file the server's log names as a screenshot is one: a download of the same type is not.
  const shots = new Set()
  let calls = 0
  for (const entry of entries.filter((name) => /^session-[0-9]+$/u.test(name)).sort()) {
    let text = ''
    try {
      if (lstatSync(join(own, entry, 'session.md')).isFile()) text = readFileSync(join(own, entry, 'session.md'), 'utf8')
    } catch {
      text = ''
    }
    for (const call of sessionCalls(text)) {
      calls += 1
      for (const shot of call.shots) shots.add(shot)
      if (call.page === null || pages.length >= BROWSER_LIMITS.pages) continue
      const last = pages.at(-1)
      const title = bounded(call.page.title, BROWSER_LIMITS.pageTitle)
      const page = { url: bounded(call.page.url, BROWSER_LIMITS.url), title }
      if (last === undefined || last.url !== page.url || last.title !== page.title) pages.push(page)
    }
  }
  const screenshots = []
  const removed = []
  for (const name of entries.sort()) {
    const path = join(own, name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      stat = null
    }
    const keep = stat !== null && stat.isFile() && SCREENSHOT.test(name) && shots.has(name) && stat.size <= BROWSER_LIMITS.screenshot && screenshots.length < BROWSER_LIMITS.screenshots
    if (keep) {
      screenshots.push({ name, bytes: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
      continue
    }
    removed.push(name)
    rmSync(path, { recursive: true, force: true })
  }
  return {
    record: { version: 1, origin: browser.origin, interact: browser.interact === true, tools: browserTools(browser.interact === true), statement: BROWSER_STATEMENT, calls, pages, screenshots, removed: removed.length },
    removed
  }
}
