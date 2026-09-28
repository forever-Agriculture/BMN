/* global window, document, getComputedStyle */
// MODULE: session-ports-visual.mjs - Epic 41: a session's listening ports found from /proc, shown on its pane, in
// Session details and in the palette, and opened in the browser
// The app runs in test mode with scratch XDG folders. Two shell sessions each start `python3 -m http.server 0` bound to
// 127.0.0.1; the first then leaves its shell, so its server keeps running after its session stopped. The browser is
// stubbed in the main process, so a click records the address instead of opening it, and every server this script
// started is killed at the end. Screenshots land in .dev-auto/evidence/epic-41/shots/ (ignored).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-41/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const execFileAsync = promisify(execFile)
const phase = (label) => console.error(`[BMN session ports visual] ${label}`)

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function until(read, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`never saw ${label}`)
    await sleep(100)
  }
}

async function runControlCli(roots, sessionId, command, ...args) {
  await execFileAsync(process.execPath, [join(appDirectory, 'bin/bmn'), command, ...args, '--session', sessionId, '--owner',
    '--socket', join(roots.runtime, 'bmn/control/control.sock')])
}

const listPorts = (page) => page.evaluate(() => window.aiTerminal.listPorts())
const portsOf = (listed, sessionId) => listed.find((entry) => entry.sessionId === sessionId) ?? null

mkdirSync(evidenceDirectory, { recursive: true })
const started = new Set()
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const application = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: root,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  const result = {}
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
    // A background test window may never paint without being shown (observed 2026-09-28).
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    // The browser is the one thing outside BMN a click reaches: record the address instead.
    await application.evaluate(({ shell }) => {
      globalThis.__bmnOpenedUrls = []
      shell.openExternal = async (url) => { globalThis.__bmnOpenedUrls.push(url) }
    })
    const shot = async (name, selector) => {
      const clip = await page.evaluate((selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect()
        return box ? { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) } : null
      }, selector)
      const png = await application.evaluate(async ({ BrowserWindow }, clip) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage(clip ?? undefined)).toPNG().toString('base64'), clip)
      writeFileSync(join(evidenceDirectory, name), Buffer.from(png, 'base64'))
    }

    phase('two shell sessions, each with its own server')
    const ids = await page.evaluate(async (cwd) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      const create = async (name) => (await window.aiTerminal.createSession({ workspaceId: primary.workspaceId, name, cwd,
        executable: '/bin/bash', argv: ['--noprofile', '--norc'], cols: 100, rows: 24, backgroundChoice: 'stop' })).session.sessionId
      return { left: await create('Docs preview — leaves its shell'), right: await create('Web app — dev server') }
    }, root)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await until(() => page.evaluate(() => document.querySelectorAll('.session-row').length >= 3), 'three rows')
    const serve = "python3 -m http.server 0 --bind 127.0.0.1 &"
    const hintAt = Date.now()
    await runControlCli(roots, ids.left, 'send', serve, '--submit')
    // The server's own "Serving HTTP on" line is the hint: the port shows within a second, not at the 5 s cadence.
    const left = await until(async () => portsOf(await listPorts(page), ids.left), 'the first server\'s port', 10_000)
    result.hintToListedMs = Date.now() - hintAt
    assert.equal(left.ports.length, 1, JSON.stringify(left))
    assert.equal(left.ports[0].address, '127.0.0.1')
    assert.equal(left.ports[0].command, 'python3')
    assert.equal(left.stopped, false)
    started.add(left.ports[0].pid)
    assert.ok(result.hintToListedMs < 4_000, `the hint scan took ${result.hintToListedMs} ms`)

    await runControlCli(roots, ids.right, 'send', serve, '--submit')
    const right = await until(async () => portsOf(await listPorts(page), ids.right), 'the second server\'s port', 10_000)
    started.add(right.ports[0].pid)
    assert.notEqual(right.ports[0].port, left.ports[0].port)

    phase('the first session leaves its shell; its server stays listed under it')
    await runControlCli(roots, ids.left, 'send', 'disown; exit', '--submit')
    await until(async () => portsOf(await listPorts(page), ids.left)?.stopped === true, 'the first session marked stopped', 15_000)
    // One more scan must keep it there: the environment is read again, and the server still carries the session's id.
    await sleep(6_000)
    const afterStop = await listPorts(page)
    assert.deepEqual(portsOf(afterStop, ids.left)?.ports.map((each) => each.port), [left.ports[0].port], JSON.stringify(afterStop))
    assert.deepEqual(portsOf(afterStop, ids.right)?.ports.map((each) => each.port), [right.ports[0].port], JSON.stringify(afterStop))
    result.leftStopped = portsOf(afterStop, ids.left)?.stopped

    phase('pane chip, Session details, sidebar')
    await page.locator(`.session-row > button[data-session-id="${ids.right}"]`).click()
    const rightLabel = `localhost:${right.ports[0].port}`
    const chip = page.locator(`.session-terminal[data-session-id="${ids.right}"] .pane-ports .port-chip`)
    await chip.first().waitFor()
    const chipLook = await chip.first().evaluate((element) => {
      const style = getComputedStyle(element)
      return { text: element.textContent, tag: element.tagName, border: style.borderTopWidth, fill: style.backgroundColor }
    })
    assert.deepEqual({ text: chipLook.text, tag: chipLook.tag, border: chipLook.border }, { text: rightLabel, tag: 'BUTTON', border: '0px' })
    assert.doesNotMatch(chipLook.fill, /rgba\(.+, 0\)$|transparent/, JSON.stringify(chipLook))
    await shot('pane-heading-black.png', `.session-terminal[data-session-id="${ids.right}"] .pane-heading`)
    // Ports are not an attention signal: the sidebar row carries nothing new.
    const sidebar = await page.evaluate(() => [...document.querySelectorAll('.session-row')]
      .map((row) => ({ text: row.textContent ?? '', ports: row.querySelectorAll('.pane-ports, .port-chip').length })))
    assert.ok(sidebar.every((row) => row.ports === 0 && !row.text.includes('localhost')), JSON.stringify(sidebar))

    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Session details')
    await page.keyboard.press('Enter')
    const details = page.locator('.session-inspector section.session-ports')
    await details.waitFor()
    result.details = await details.locator('li').evaluateAll((rows) => rows.map((row) => row.textContent))
    assert.deepEqual(result.details, [`${rightLabel}python3 (pid ${right.ports[0].pid}) on 127.0.0.1`])
    await shot('session-details-black.png', '.session-inspector')
    await page.locator(`.session-row > button[data-session-id="${ids.left}"]`).click()
    await details.waitFor()
    result.stoppedNote = await details.locator('p').textContent()
    assert.equal(result.stoppedNote, 'Its programs are still running after the session stopped.')
    await shot('session-details-stopped-black.png', '.session-inspector')

    phase('palette entries for every listed port')
    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Open localhost')
    await sleep(300)
    result.palette = await page.locator('.palette-results [role="option"]').evaluateAll((rows) => rows.map((row) => row.textContent))
    for (const [entry, name] of [[left, 'Docs preview — leaves its shell'], [right, 'Web app — dev server']]) {
      assert.ok(result.palette.some((text) => text?.includes(`Open localhost:${entry.ports[0].port} — ${name}`)), JSON.stringify(result.palette))
    }
    await shot('palette-black.png', '.command-palette')
    await page.keyboard.press('Escape')

    phase('a click opens the address in the browser and does nothing else')
    const before = await listPorts(page)
    await page.locator(`.session-row > button[data-session-id="${ids.right}"]`).click()
    await chip.first().click()
    result.opened = await until(() => application.evaluate(() => globalThis.__bmnOpenedUrls.length > 0 && globalThis.__bmnOpenedUrls), 'the opened URL', 5_000)
    assert.deepEqual(result.opened, [`http://${rightLabel}/`])
    await sleep(500)
    assert.deepEqual(await listPorts(page), before, 'opening a port changed what BMN lists')
    // A port the last scan does not list for that session is refused; the renderer cannot name an address.
    const refused = await page.evaluate(async ({ sessionId, port }) => window.aiTerminal.openPort(sessionId, port)
      .then(() => 'opened', (error) => String(error?.message ?? error)), { sessionId: ids.left, port: right.ports[0].port })
    assert.match(refused, /no longer listening/)
    console.log(JSON.stringify({ sessionPortsVisual: 'PASS', directory: evidenceDirectory, ...result }))
  } finally {
    for (const pid of started) {
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    }
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
