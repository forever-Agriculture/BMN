/* global window, document */
// MODULE: compaction-visual.mjs - screenshots Epic 36: the Session details compaction line and the Hook events wording
// The app runs in test mode with scratch XDG folders. A synthetic `claude` executable pipes fake hook payloads into
// `bmn hook claude`, so no agent runs and nothing leaves the machine. Its first run reports a start, then on a trigger
// two compactions and a tool; it exits on another, and the relaunched run reports only a start, which must read as
// no compaction. Screenshots land in
// .dev-auto/evidence/epic-36/shots/ (ignored).
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-36/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const phase = (label) => console.error(`[BMN compaction visual] ${label}`)
const COLOR_MODES = ['black', 'steel']
const CONVERSATION = '01a0b657-21a8-7f00-addd-b73646828f5b'

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

async function until(read, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`never saw ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * The Harness section's compaction line, once the view has read this run's observation. It is read without
 * pressing Refresh observation, so the line must follow the window's own periodic re-read (15 s).
 */
async function compactionLine(page, expected) {
  const harness = page.locator('section.hook-observation')
  if (!await harness.isVisible()) {
    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Session details')
    await page.keyboard.press('Enter')
  }
  await harness.waitFor()
  return until(async () => {
    const text = await harness.locator('.hook-compaction').textContent({ timeout: 500 }).catch(() => null)
    return text !== null && expected.test(text) ? text : null
  }, `a compaction line matching ${expected}`, 40_000)
}

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
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))

    phase('first run: startup, then two compactions and a tool once the run has settled')
    // The hook only answers for a process holding the terminal that is not a shell, so the file is named `claude`.
    // A new session can be started more than once while the window attaches, so the compactions wait for a
    // trigger the script writes once the run it will read is the live one.
    const trigger = join(root, 'compact-now')
    const reported = join(root, 'compacted')
    const quit = join(root, 'exit-now')
    const hook = (payload) => `printf '%s' '${JSON.stringify({ session_id: CONVERSATION, ...payload })}' | bmn hook claude`
    const agent = join(root, 'claude')
    writeFileSync(agent, `#!/bin/sh
${hook({ hook_event_name: 'SessionStart', source: 'startup' })}
echo "synthetic agent ready"
while :; do
  if [ -e ${JSON.stringify(trigger)} ]; then
    rm -f ${JSON.stringify(trigger)}
    ${hook({ hook_event_name: 'SessionStart', source: 'compact' })}
    sleep 1
    ${hook({ hook_event_name: 'SessionStart', source: 'compact' })}
    ${hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'true' } })}
    : > ${JSON.stringify(reported)}
  fi
  if [ -e ${JSON.stringify(quit)} ]; then rm -f ${JSON.stringify(quit)}; exit 0; fi
  sleep 0.2
done
`)
    chmodSync(agent, 0o755)
    const created = await page.evaluate(async ({ cwd, executable }) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      return (await window.aiTerminal.createSession({
        workspaceId: primary.workspaceId, name: 'Long refactor', cwd, executable, argv: [], cols: 80, rows: 24, backgroundChoice: 'stop'
      })).session
    }, { cwd: root, executable: agent })
    await page.reload()
    await page.locator(`.session-row > button[data-session-id="${created.sessionId}"]`).click()
    await until(async () => (await page.evaluate((id) => window.aiTerminal.getHookObservation(id), created.sessionId)).state === 'observed',
      'the live run to report its start')
    await page.waitForTimeout(3000)
    const settled = await page.evaluate((id) => window.aiTerminal.getHookObservation(id), created.sessionId)
    writeFileSync(trigger, '')
    await until(() => existsSync(reported), 'the run to report its compactions')
    result.sameRun = (await page.evaluate((id) => window.aiTerminal.getHookObservation(id), created.sessionId)).incarnationId === settled.incarnationId
    result.firstRun = await compactionLine(page, /^Compacted: \d\d:\d\d \(2 times this run\)$/)
    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      await page.locator('section.hook-observation').screenshot({ path: join(evidenceDirectory, `harness-compacted-${colorMode}.png`) })
    }

    phase('Hook events list wording')
    await page.locator('section.hook-observation button', { hasText: 'Open Hook events' }).click()
    const list = page.locator('ul.hook-events')
    await list.waitFor()
    result.hookEvents = await list.locator('li .hook-event-name').allTextContents()
    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      await page.locator('dialog.hook-events-dialog').screenshot({ path: join(evidenceDirectory, `hook-events-${colorMode}.png`) })
    }
    await page.keyboard.press('Escape')
    result.needsYouOpen = (await page.evaluate(() => window.aiTerminal.listAttention()))
      .filter((request) => request.state === 'open').length

    phase('relaunched run: a new incarnation starts from none')
    const before = await page.evaluate((id) => window.aiTerminal.getHookObservation(id), created.sessionId)
    // Relaunch starts a stopped session, so the first run exits first.
    writeFileSync(quit, '')
    await until(() => !existsSync(quit), 'the first run to exit')
    await page.waitForTimeout(1000)
    const relaunch = await page.evaluate(async (id) => {
      try { await window.aiTerminal.relaunchSession(id); return 'ok' } catch (error) { return String(error?.message ?? error) }
    }, created.sessionId)
    if (relaunch !== 'ok') throw new Error(`relaunch failed: ${relaunch}`)
    await until(async () => {
      const now = await page.evaluate((id) => window.aiTerminal.getHookObservation(id), created.sessionId)
      return now.state === 'observed' && now.incarnationId !== before.incarnationId ? now : null
    }, 'the relaunched run to report its start')
    // The window keeps the exited run's view until it reads the session list again.
    await page.reload()
    await page.locator(`.session-row > button[data-session-id="${created.sessionId}"]`).click()
    result.secondRun = await compactionLine(page, /^No compaction observed in this run$/)
    result.secondRunApi = await page.evaluate((id) => window.aiTerminal.getHookObservation(id), created.sessionId)
      .then((observation) => ({ fresh: observation.incarnationId !== before.incarnationId, compaction: observation.compaction }))
    await setColorMode(page, 'black')
    await page.locator('section.hook-observation').screenshot({ path: join(evidenceDirectory, 'harness-relaunched-black.png') })

    phase('a session whose harness never reported still says no compaction was observed')
    const shell = await page.evaluate(async (id) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      return (await window.aiTerminal.listSessions(primary.workspaceId)).find((session) => session.sessionId !== id)
    }, created.sessionId)
    await page.locator(`.session-row > button[data-session-id="${shell.sessionId}"]`).click()
    result.plainShell = await compactionLine(page, /^No compaction observed in this run$/)
    result.plainShellState = await page.locator('section.hook-observation strong').first().textContent()
    console.log(JSON.stringify({ directory: evidenceDirectory, ...result }))
  } finally {
    // Playwright's close has hung after screenshots before (Epic 31); the scratch app is stopped either way.
    await Promise.race([application.close(), new Promise((resolve) => setTimeout(resolve, 10_000))])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
