/* global window, document, MutationObserver */
// MODULE: program-copy-visual.mjs - Epic 42: a program in a pane copies to the clipboard with OSC 52; reads are never
// answered, a rebuilt view never copies again, and Preferences turns it off
// The app runs in test mode with scratch XDG folders. The clipboard is stubbed in the main process before anything can
// copy, so every write is recorded instead of reaching the owner's clipboard; the primary selection step runs only when
// its stub is confirmed in place. Screenshots land in .dev-auto/evidence/epic-42/shots/ (ignored).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-42/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const execFileAsync = promisify(execFile)
const phase = (label) => console.error(`[BMN program copy visual] ${label}`)

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

const copyCommand = (selection, text) => `printf '\\e]52;${selection};%s\\a' "$(printf '%s' '${text}' | base64 -w0)"`

mkdirSync(evidenceDirectory, { recursive: true })
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
    // The clipboard is the one thing outside BMN a copy reaches: record each write instead, before any can happen.
    const stub = await application.evaluate(({ clipboard }) => {
      globalThis.__bmnClipboardWrites = []
      clipboard.writeText = async (text) => { globalThis.__bmnClipboardWrites.push(['clipboard', text]) }
      const selection = clipboard.selection
      if (!selection) return { selection: false }
      selection.writeText = async (text) => { globalThis.__bmnClipboardWrites.push(['primary', text]) }
      return { selection: true, stubbed: clipboard.selection === selection && clipboard.selection.writeText === selection.writeText }
    })
    const writes = () => application.evaluate(() => globalThis.__bmnClipboardWrites)
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
    // A background test window may never paint without being shown (observed 2026-09-28).
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    const shot = async (name, selector) => {
      const clip = await page.evaluate((selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect()
        return box ? { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) } : null
      }, selector)
      const png = await application.evaluate(async ({ BrowserWindow }, clip) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage(clip ?? undefined)).toPNG().toString('base64'), clip)
      writeFileSync(join(evidenceDirectory, name), Buffer.from(png, 'base64'))
    }
    const watchAnnouncements = () => page.evaluate(() => {
      window.__bmnAnnouncements = []
      new MutationObserver(() => {
        const text = document.querySelector('.live-announcer')?.textContent ?? ''
        if (text) window.__bmnAnnouncements.push(text)
      }).observe(document.querySelector('.live-announcer'), { childList: true, characterData: true, subtree: true })
    })
    const toast = () => page.evaluate(() => document.querySelector('.feedback-notice.brief span')?.textContent ?? null)

    phase('a shell session shown in a pane')
    const name = 'Editor — yanks text'
    const sessionId = await page.evaluate(async ({ cwd, name }) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      return (await window.aiTerminal.createSession({ workspaceId: primary.workspaceId, name, cwd,
        executable: '/bin/bash', argv: ['--noprofile', '--norc'], cols: 100, rows: 24, backgroundChoice: 'stop' })).session.sessionId
    }, { cwd: root, name })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await until(() => page.evaluate(() => document.querySelectorAll('.session-row').length >= 2), 'two rows')
    await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await page.locator(`.session-terminal[data-session-id="${sessionId}"]`).waitFor()
    await watchAnnouncements()

    phase('printf OSC 52 puts "hello" on the clipboard and says so')
    await runControlCli(roots, sessionId, 'send', copyCommand('c', 'hello'), '--submit')
    await until(async () => (await writes()).length > 0, 'the clipboard write', 10_000)
    assert.deepEqual(await writes(), [['clipboard', 'hello']])
    result.toast = await until(toast, 'the toast', 5_000)
    assert.equal(result.toast, `Copied from ${name} (5 characters)`)
    await shot('toast-black.png', '.feedback-notice.brief')
    await shot('window-with-toast-black.png', '.shell-window')

    phase('a read request is answered with nothing, while the terminal still answers what it should')
    const replyLength = async (query, file) => {
      await runControlCli(roots, sessionId, 'send', `printf '${query}'; IFS= read -r -s -t 1 -n 200 R; printf '%s' "\${#R}" > '${join(root, file)}'`, '--submit')
      return Number(await until(() => { try { return readFileSync(join(root, file), 'utf8') || false } catch { return false } }, file, 10_000))
    }
    // Device attributes are answered by the terminal itself: proof that this reading sees a reply when there is one.
    result.deviceAttributesReply = await replyLength('\\e[c', 'da-reply')
    assert.ok(result.deviceAttributesReply > 0, 'the control query got no reply, so the check below would prove nothing')
    result.clipboardReadReply = await replyLength('\\e]52;c;?\\a', 'osc52-reply')
    assert.equal(result.clipboardReadReply, 0)
    assert.deepEqual(await writes(), [['clipboard', 'hello']])

    phase('invalid data copies nothing')
    await runControlCli(roots, sessionId, 'send', "printf '\\e]52;c;!!not-base64!!\\a'", '--submit')
    await sleep(1_500)
    assert.equal((await writes()).length, 1)

    phase('three copies within a second show one toast')
    await sleep(1_200)
    const announcedBefore = (await page.evaluate(() => window.__bmnAnnouncements)).length
    await runControlCli(roots, sessionId, 'send',
      `for word in one two three; do ${copyCommand('c', '$word').replace("'$word'", '"$word"')}; done`, '--submit')
    await until(async () => (await writes()).length >= 4, 'three more writes', 10_000)
    assert.deepEqual((await writes()).slice(1), [['clipboard', 'one'], ['clipboard', 'two'], ['clipboard', 'three']])
    await sleep(300)
    result.burstToast = await toast()
    assert.equal(result.burstToast, `Copied from ${name} (5 characters)`)
    result.burstAnnouncements = (await page.evaluate(() => window.__bmnAnnouncements)).slice(announcedBefore)
    assert.deepEqual(result.burstAnnouncements, [`Copied from ${name} (3 characters)`])

    if (stub.selection && stub.stubbed) {
      phase('the primary selection')
      await runControlCli(roots, sessionId, 'send', copyCommand('p', 'prim'), '--submit')
      await until(async () => (await writes()).length >= 5, 'the primary write', 10_000)
      assert.deepEqual((await writes()).at(-1), ['primary', 'prim'])
      result.primary = 'written'
    } else {
      result.primary = `skipped: selection ${JSON.stringify(stub)}`
    }
    const beforeRebuild = (await writes()).length

    phase('a rebuilt view replays the screen without copying again')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator(`.session-terminal[data-session-id="${sessionId}"]`).waitFor()
    await sleep(2_500)
    assert.equal((await writes()).length, beforeRebuild, 'the rebuilt view copied again')
    result.writesAfterRebuild = (await writes()).length

    phase('Preferences → Terminal turns it off')
    await page.locator('.preferences-button').click()
    await page.waitForSelector('.preferences-dialog')
    await page.locator('.preferences-dialog .nav-group .nav-item', { hasText: /^Terminal$/ }).click()
    const checkbox = page.locator('#preferences-program-clipboard')
    assert.equal(await checkbox.isChecked(), true)
    await checkbox.click()
    await until(async () => (await page.evaluate(() => window.aiTerminal.getSettings())).terminal.programClipboard === false, 'the saved setting')
    await page.locator('.preferences-dialog .preferences-section', { hasText: 'Let programs copy to the clipboard' }).scrollIntoViewIfNeeded()
    await shot('preferences-terminal-black.png', '.preferences-dialog')
    result.terminalSection = await page.locator('.preferences-dialog .preferences-section', { hasText: 'Let programs copy to the clipboard' })
      .evaluate((section) => section.textContent)
    await page.keyboard.press('Escape')
    await runControlCli(roots, sessionId, 'send', copyCommand('c', 'not now'), '--submit')
    await sleep(2_000)
    assert.equal((await writes()).length, beforeRebuild, 'a copy went through with the setting off')
    console.log(JSON.stringify({ programCopyVisual: 'PASS', directory: evidenceDirectory, stub, writes: await writes(), ...result }))
  } finally {
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
