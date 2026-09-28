/* global window, document */
// MODULE: quick-wins-visual.mjs - screenshots Epic 32: Needs you order and deadline, the Telegram cue, Reset terminal modes
// The app runs in test mode with scratch XDG folders. Requests come from `bmn ask` in synthetic sessions; the Telegram
// cue comes from a token lock held by this script, so no request leaves the machine. Screenshots land in
// .dev-auto/evidence/epic-32/shots/ (ignored).
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-32/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const phase = (label) => console.error(`[BMN quick wins visual] ${label}`)
const TOKEN = '123456789:VISUAL_fake_bot_token_not_real'
const COLOR_MODES = ['black', 'steel']

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay

async function setColorMode(page, colorMode) {
  await page.evaluate(async (colorMode) => {
    await window.aiTerminal.putSettings('appearance', { identity: 'knight', colorMode, terminalFontSize: 14 })
  }, colorMode)
  await page.waitForFunction((colorMode) => document.documentElement.dataset.colorMode === colorMode, colorMode)
}

async function session(page, name, cwd, executable, argv) {
  return page.evaluate(async ({ name, cwd, executable, argv }) => {
    const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
    return (await window.aiTerminal.createSession({
      workspaceId: primary.workspaceId, name, cwd, executable, argv, cols: 80, rows: 24, backgroundChoice: 'stop'
    })).session
  }, { name, cwd, executable, argv })
}

async function until(read, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`never saw ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

mkdirSync(evidenceDirectory, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const runtimeHome = join(roots.runtime, 'bmn')
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
      BMN_RUNTIME_HOME: runtimeHome,
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

    phase('Story 32.1: two reviews, then a permission that expires in 10 minutes')
    const expires = new Date(Date.now() + 10 * 60_000).toISOString()
    const ask = (key, title, kind, extra = '') => `bmn ask ${key} "${title}" --kind ${kind}${extra}; exec sleep 600`
    await session(page, 'Parser review', root, '/bin/sh', ['-c', ask('parser', 'Review the parser change', 'review')])
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await session(page, 'Docs review', root, '/bin/sh', ['-c', ask('docs', 'Review the docs update', 'review')])
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const deploy = await session(page, 'Deploy', root, '/bin/sh',
      ['-c', ask('push', 'Allow git push to origin', 'permission', ` --expires ${expires}`)])
    await until(async () => (await page.evaluate(() => window.aiTerminal.listAttention()))
      .filter((request) => request.state === 'open').length === 3, 'three open requests')
    // Sessions made through the bridge reach the tree when the window reloads.
    await page.reload()
    await page.waitForSelector(`.session-row > button[data-session-id="${deploy.sessionId}"]`)
    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      await page.locator('.needs-you-button').click()
      await page.locator('.needs-you-popover .attention-item').first().waitFor()
      await page.locator('.needs-you-popover').screenshot({ path: join(evidenceDirectory, `needs-you-${colorMode}.png`) })
      await page.keyboard.press('Escape')
    }
    await page.locator('.needs-you-button').click()
    await page.locator('.needs-you-popover .attention-item').first().waitFor()
    result.needsYou = await page.evaluate(() => [...document.querySelectorAll('.needs-you-popover .attention-item')]
      .map((row) => ({ title: row.querySelector('h3')?.textContent, age: row.querySelector('.where .age')?.textContent,
        label: row.getAttribute('aria-label') })))
    await page.keyboard.press('Escape')
    await page.locator('.xterm-helper-textarea').first().focus()
    await page.keyboard.press('Control+Shift+U')
    result.nextRequestSession = await until(async () => {
      const selected = await page.evaluate(async () => {
        const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
        return (await window.aiTerminal.getLayout(primary.workspaceId)).layout.selectedSessionId
      })
      return selected === deploy.sessionId ? 'Deploy' : null
    }, 'Ctrl+Shift+U landing on the permission')

    phase('Story 32.2: another process holds this token, so Telegram is not delivering')
    const lock = join(runtimeHome, `telegram-${createHash('sha256').update(TOKEN).digest('hex').slice(0, 16)}.lock`)
    mkdirSync(runtimeHome, { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { mode: 0o600 })
    await page.evaluate(async (token) => {
      const settings = await window.aiTerminal.getSettings()
      await window.aiTerminal.putSettings('telegram', { ...settings.telegram, enabled: true, allowedChatId: 424242 })
      await window.aiTerminal.configureTelegram(token)
    }, TOKEN)
    await page.locator('.preferences-button .status-dot.needs-you').waitFor()
    result.gear = await page.evaluate(() => {
      const gear = document.querySelector('.preferences-button')
      return { title: gear.title, description: gear.getAttribute('aria-description') }
    })
    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      await page.locator('.app-header').screenshot({ path: join(evidenceDirectory, `gear-cue-${colorMode}.png`) })
      await page.locator('.preferences-button').click()
      const telegram = page.locator('.preferences-section', { has: page.locator('h3', { hasText: 'Telegram' }) })
      await telegram.locator('.telegram-cue').waitFor()
      await telegram.evaluate((element) => element.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(150)
      await telegram.screenshot({ path: join(evidenceDirectory, `preferences-telegram-${colorMode}.png`) })
      result.preferencesSentence = await telegram.locator('.telegram-cue').textContent()
      await page.locator('.preferences-dialog [aria-label="Close Preferences"]').click()
    }

    phase('Story 32.3: a program armed mouse, paste and focus modes and exited back to its shell')
    const inputLog = join(root, 'reset-input.log')
    const shell = join(root, 'armed-shell.sh')
    writeFileSync(shell, `#!/bin/sh\nstty raw -echo\nprintf '\\033[?1000h\\033[?1006h\\033[?2004h\\033[?1004hA TUI died here; its shell lives on.\\r\\n'\nexec cat > ${JSON.stringify(inputLog)}\n`)
    chmodSync(shell, 0o755)
    const armed = await session(page, 'Armed shell', root, shell, [])
    await page.reload()
    await page.waitForSelector(`.session-row > button[data-session-id="${armed.sessionId}"]`)
    await page.locator(`.session-row > button[data-session-id="${armed.sessionId}"]`).click()
    const pane = page.locator(`.session-terminal[data-session-id="${armed.sessionId}"]:not(.session-terminal-hidden)`)
    await pane.locator('.xterm-screen').waitFor()
    await until(() => existsSync(inputLog), 'the armed shell')
    await setColorMode(page, 'black')
    const box = await pane.locator('.xterm-screen').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -240)
    await until(() => readFileSync(inputLog).byteLength || null, 'wheel input while armed')
    await page.waitForTimeout(300)
    const input = () => JSON.stringify(readFileSync(inputLog, 'latin1'))
    result.inputBeforePalette = input()
    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Reset terminal modes')
    await page.waitForTimeout(200)
    await page.locator('dialog.command-palette').screenshot({ path: join(evidenceDirectory, 'palette-reset.png') })
    result.inputWithPaletteOpen = input()
    await page.keyboard.press('Enter')
    await page.getByText('Terminal modes reset for Armed shell').first().waitFor()
    await page.waitForTimeout(300)
    result.inputAfterReset = input()
    await page.screenshot({ path: join(evidenceDirectory, 'reset-toast.png') })
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(500)
    result.inputAfterWheel = input()
    await pane.locator('button[data-action="more"]').click()
    await page.locator('.popup-menu').waitFor()
    await page.locator('.popup-menu').screenshot({ path: join(evidenceDirectory, 'pane-menu-reset.png') })
    await page.keyboard.press('Escape')
    console.log(JSON.stringify({ directory: evidenceDirectory, ...result }))
  } finally {
    // Playwright's close has hung after screenshots before (Epic 31); the scratch app is stopped either way.
    await Promise.race([application.close(), new Promise((resolve) => setTimeout(resolve, 10_000))])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
