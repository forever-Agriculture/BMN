/* global window, document */
// MODULE: reported-resume-visual.mjs - Epic 43: a program in a session reports how to resume it, Session details
// shows it, Resume runs it exactly as shown, the quit offer lists it unchecked, and a program gone from PATH is refused
// The app runs in test mode with scratch XDG folders and a synthetic fake agent on its PATH; every file it writes stays
// in the temporary root. Screenshots land in .dev-auto/evidence/epic-43/shots/ (ignored).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-43/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const phase = (label) => console.error(`[BMN reported resume visual] ${label}`)
const execFileAsync = promisify(execFile)

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

const readText = (file) => { try { return readFileSync(file, 'utf8') } catch { return '' } }

mkdirSync(evidenceDirectory, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const bin = join(root, 'agent-bin')
  const work = join(root, 'work')
  const program = join(bin, 'fake-agent')
  const reports = join(root, 'reports.txt')
  const runs = join(root, 'runs.txt')
  mkdirSync(bin, { recursive: true })
  mkdirSync(work, { recursive: true })
  // The fake agent does what an agent would: tells BMN how to resume it, then keeps running.
  const writeProgram = () => {
    writeFileSync(program, [
      '#!/bin/sh',
      // The first run waits, so the window is showing the session before the report arrives.
      '[ -z "$1" ] && sleep 3',
      `bmn resume-command -- fake-agent --resume abc >> '${reports}' 2>&1`,
      `printf 'started:%s cwd:%s\\n' "$*" "$(pwd)" >> '${runs}'`,
      'exec cat',
      ''
    ].join('\n'))
    chmodSync(program, 0o700)
  }
  writeProgram()

  const launch = () => electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
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
  const open = async (application) => {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
    // A background test window may never paint without being shown (observed 2026-09-28).
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    return page
  }
  const shooter = (application, page) => async (name, selector) => {
    // A dialog fades in; a capture taken before it settles is dark or shows the window through it.
    await sleep(700)
    const clip = await page.evaluate((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect()
      return box ? { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) } : null
    }, selector)
    const png = await application.evaluate(async ({ BrowserWindow }, clip) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage(clip ?? undefined)).toPNG().toString('base64'), clip)
    writeFileSync(join(evidenceDirectory, name), Buffer.from(png, 'base64'))
  }
  const record = (page, sessionId) => page.evaluate(async (sessionId) => {
    for (const workspace of await window.aiTerminal.listWorkspaces()) {
      const found = (await window.aiTerminal.listSessions(workspace.workspaceId)).find((item) => item.sessionId === sessionId)
      if (found) return found
    }
    return null
  }, sessionId)
  const runLines = () => readText(runs).split('\n').filter(Boolean)
  const result = {}
  const name = 'Wrapper agent'

  let application = await launch()
  try {
    let page = await open(application)
    let shot = shooter(application, page)

    phase('a fake agent in a session reports how to resume it')
    const sessionId = await page.evaluate(async ({ cwd, executable, name }) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      return (await window.aiTerminal.createSession({ workspaceId: primary.workspaceId, name, cwd,
        executable, argv: [], cols: 100, rows: 24, backgroundChoice: 'stop' })).session.sessionId
    }, { cwd: work, executable: program, name })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await until(() => page.evaluate(() => document.querySelectorAll('.session-row').length >= 2), 'two rows')
    await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Session details')
    await page.keyboard.press('Enter')
    await page.locator('.session-inspector').waitFor()
    const line = page.locator('.session-inspector .reported-resume')
    result.lineBeforeReport = await line.count()
    const reported = await until(async () => (await record(page, sessionId))?.reportedResume,
      'the reported command').catch((error) => {
      throw new Error(`${error.message}; the agent said: ${JSON.stringify(readText(reports))}; runs: ${JSON.stringify(readText(runs))}`)
    })
    assert.deepEqual(reported.argv, ['fake-agent', '--resume', 'abc'])
    result.cliSaid = readText(reports).trim()
    assert.equal(result.cliSaid, 'Resume command recorded for this session: fake-agent --resume abc')

    phase('Session details shows it, with the time, without a reload')
    result.detailsLine = await until(async () => (await line.textContent({ timeout: 500 }).catch(() => null)), 'the details line')
    assert.match(result.detailsLine, /^Resume command reported by the program: fake-agent --resume abc at \d{2}:\d{2}$/)
    await shot('details-reported-black.png', '.session-inspector')

    phase('stopped, Resume shows the exact command, folder and who said so, and runs it')
    await page.evaluate((sessionId) => window.aiTerminal.stopSession(sessionId), sessionId)
    // The pane keeps the ended process's output, so Resume is offered in Session details.
    const resumeButton = page.locator('.session-inspector .actions button', { hasText: /^Resume$/ })
    await resumeButton.click()
    const dialog = page.locator('dialog.app-dialog[aria-label="Resume with the reported command"]')
    await dialog.waitFor()
    result.resumeDialog = await dialog.locator('.app-dialog-body').innerText()
    assert.match(result.resumeDialog, /fake-agent --resume abc/)
    assert.ok(result.resumeDialog.includes(`Program\n${program}`) || result.resumeDialog.includes(program), 'the dialog names the program')
    assert.ok(result.resumeDialog.includes(work), 'the dialog names the folder')
    assert.match(result.resumeDialog, /Reported by the program in this session at \d{2}:\d{2}/)
    await shot('resume-dialog-black.png', 'dialog.app-dialog')
    assert.equal(runLines().length, 1)
    await dialog.locator('button.primary', { hasText: 'Resume' }).click()
    await until(() => runLines().length === 2, 'the resumed run')
    result.resumedRun = runLines()[1]
    assert.equal(result.resumedRun, `started:--resume abc cwd:${work}`)

    phase('the owner stops it and starts it again: the line goes, and comes back when the new process reports')
    await until(async () => (await record(page, sessionId))?.lastProcess?.state === 'live', 'the resumed process')
    await page.locator('.session-inspector .actions button', { hasText: 'Stop…' }).click()
    await page.locator('dialog.app-dialog button', { hasText: /^Stop session$/ }).click()
    await page.locator('.session-inspector .actions button', { hasText: /^Start again$/ }).click()
    // The fake agent's first run waits 3 s before it reports, so the line must be gone well before that.
    await until(async () => (await line.count()) === 0, 'the cleared line', 2_500)
    result.clearedAfterStartAgain = true
    await until(() => runLines().length === 3, 'the run Start again started')
    assert.equal(runLines()[2], `started: cwd:${work}`)
    result.lineAfterNewReport = await until(async () => (await line.textContent({ timeout: 500 }).catch(() => null)), 'the new report')

    phase('quit, start again: the offer lists it with its exact command, not ticked')
    await page.evaluate(() => { void window.aiTerminal.quitApplication() })
    const quitDialog = page.locator('dialog.app-dialog button', { hasText: 'Quit BMN' })
    const exited = new Promise((resolveExit) => application.process().once('exit', resolveExit))
    await quitDialog.click()
    await Promise.race([exited, sleep(20_000)])
    application = await launch()
    page = await open(application)
    shot = shooter(application, page)
    const offer = page.locator('dialog.resume-interrupted')
    await offer.waitFor()
    const row = offer.locator('.resume-interrupted-list li', { hasText: name })
    result.offerRow = await row.innerText()
    assert.equal(await row.locator('input[type="checkbox"]').isChecked(), false)
    assert.ok(result.offerRow.includes(`Resume: ${program} --resume abc`), 'the row shows the exact command')
    assert.match(result.offerRow, /Reported by the program in this session at \d{2}:\d{2}/)
    await shot('interrupted-offer-black.png', 'dialog.resume-interrupted')
    await row.locator('input[type="checkbox"]').check()
    for (const other of await offer.locator('.resume-interrupted-list li').all()) {
      if (!(await other.innerText()).includes(name) && await other.locator('input[type="checkbox"]').isChecked()) {
        await other.locator('input[type="checkbox"]').uncheck()
      }
    }
    await offer.locator('.dialog-actions button.primary').click()
    await until(() => runLines().length === 4, 'the run the offer started')
    result.offerRun = runLines()[3]
    assert.equal(result.offerRun, `started:--resume abc cwd:${work}`)
    await offer.locator('.dialog-actions button.ghost').click()

    phase('a program gone from PATH is refused with the reason, and Start again is offered')
    await page.evaluate((sessionId) => window.aiTerminal.stopSession(sessionId), sessionId)
    rmSync(program)
    await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Session details')
    await page.keyboard.press('Enter')
    await page.locator('.session-inspector .actions button', { hasText: /^Resume$/ }).click()
    const refused = page.locator('dialog.app-dialog[aria-label="Resume with the reported command"]')
    await refused.waitFor()
    result.refusedDialog = await refused.locator('.app-dialog-body').innerText()
    assert.ok(result.refusedDialog.includes('"fake-agent" is no longer on this session\'s PATH'), 'the refusal names why')
    assert.equal(await refused.locator('button.primary').innerText(), 'Start again')
    await shot('resume-refused-black.png', 'dialog.app-dialog')
    await refused.locator('button.ghost', { hasText: 'Cancel' }).click()
    assert.equal(runLines().length, 4)

    phase('an agent typed into a shell session reports the same way, and Resume offers its command')
    writeProgram()
    const shellId = await page.evaluate(async ({ cwd }) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      return (await window.aiTerminal.createSession({ workspaceId: primary.workspaceId, name: 'Shell with an agent', cwd,
        executable: '/bin/bash', argv: ['--noprofile', '--norc'], cols: 100, rows: 24, backgroundChoice: 'stop' })).session.sessionId
    }, { cwd: work })
    await execFileAsync(process.execPath, [join(appDirectory, 'bin/bmn'), 'send', 'fake-agent --typed', '--submit',
      '--session', shellId, '--owner', '--socket', join(roots.runtime, 'bmn/control/control.sock')])
    const typed = await until(async () => (await record(page, shellId))?.reportedResume, 'the typed agent\'s report')
    assert.deepEqual(typed.argv, ['fake-agent', '--resume', 'abc'])
    await until(() => runLines().some((entry) => entry === `started:--typed cwd:${work}`), 'the typed run')
    await page.evaluate((id) => window.aiTerminal.stopSession(id), shellId)
    result.shellPreview = await page.evaluate((id) => window.aiTerminal.previewConversationResume(id), shellId)
    assert.equal(result.shellPreview.source, 'reported')
    assert.equal(result.shellPreview.command, `${program} --resume abc`)
    console.log(JSON.stringify({ reportedResumeVisual: 'PASS', directory: evidenceDirectory, ...result }))
  } finally {
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
