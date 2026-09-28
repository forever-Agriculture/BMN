/* global window, document */
// MODULE: plan-use-visual.mjs - screenshots Epic 37: the Plan use row, the Plan use dialog and the 90% notice
// The app runs in test mode with scratch XDG folders and a scratch CODEX_HOME. A synthetic `claude` pipes fake
// status-line JSON through the line `bmn statusline install` put in front of a fake owner command, run as Claude
// runs it (`/bin/sh -c`); a synthetic `codex` reports its conversation through `bmn hook codex`, and its session
// file holds one synthetic `token_count` line. No agent runs and nothing leaves the machine. Screenshots land in
// .dev-auto/evidence/epic-37/shots/ (ignored).
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const cli = join(appDirectory, 'bin/bmn')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-37/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const phase = (label) => console.error(`[BMN plan use visual] ${label}`)
const COLOR_MODES = ['black', 'steel']
const CLAUDE_CONVERSATION = '01a0b657-21a8-7f00-addd-b73646828f5c'
const CODEX_CONVERSATION = '01a0e82f-81fe-7f70-b2d6-df18576f6cb9'
const OWNER_LINE = 'input=$(cat); printf "owner line %s bytes" "$(printf %s "$input" | wc -c)"'

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

async function session(page, name, cwd, executable) {
  return page.evaluate(async ({ name, cwd, executable }) => {
    const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
    return (await window.aiTerminal.createSession({
      workspaceId: primary.workspaceId, name, cwd, executable, argv: [], cols: 80, rows: 24, backgroundChoice: 'stop'
    })).session
  }, { name, cwd, executable })
}

/** The Plan use section of the selected session, once its reading matches. */
async function planUse(page, sessionId, expected) {
  await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
  const section = page.locator('section.plan-use')
  if (!await section.isVisible()) {
    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Session details')
    await page.keyboard.press('Enter')
  }
  await section.waitFor()
  // Read without any refresh button: the window's own periodic re-read (15 s) must bring it.
  return until(async () => {
    const label = await section.locator('.plan-use-windows').getAttribute('aria-label', { timeout: 500 }).catch(() => null)
    return label !== null && expected.test(label) ? label : null
  }, `a Plan use line matching ${expected}`, 40_000)
}

mkdirSync(evidenceDirectory, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const codexHome = join(root, 'codex-home')
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
      CODEX_HOME: codexHome,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  const result = {}
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
    const now = Date.now()
    const epoch = (ms) => Math.floor(ms / 1000)

    phase('the owner\'s status line, wrapped by bmn statusline install')
    const settings = join(root, 'claude-settings.json')
    writeFileSync(settings, `${JSON.stringify({ statusLine: { type: 'command', command: OWNER_LINE } }, null, 2)}\n`)
    execFileSync(process.execPath, [cli, 'statusline', 'install', '--file', settings])
    const wrapped = join(root, 'wrapped-command.txt')
    writeFileSync(wrapped, JSON.parse(readFileSync(settings, 'utf8')).statusLine.command)
    const statusInput = join(root, 'status-input.json')
    writeFileSync(statusInput, JSON.stringify({
      session_id: CLAUDE_CONVERSATION, cwd: root, model: { id: 'synthetic' },
      context_window: { used_percentage: 37 },
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: epoch(now + 2 * 3_600_000) },
        seven_day: { used_percentage: 18, resets_at: epoch(now + 3 * 86_400_000) }
      }
    }))
    const shown = join(root, 'status-line-shown.txt')
    const quit = join(root, 'exit-now')
    const claudeHook = (payload) => `printf '%s' '${JSON.stringify({ session_id: CLAUDE_CONVERSATION, ...payload })}' | bmn hook claude`
    const claude = join(root, 'claude')
    // Claude runs the status line as `/bin/sh -c <command>`; so does this stand-in, once it has settled.
    writeFileSync(claude, `#!/bin/sh
${claudeHook({ hook_event_name: 'SessionStart', source: 'startup' })}
sleep 2
/bin/sh -c "$(cat ${JSON.stringify(wrapped)})" < ${JSON.stringify(statusInput)} > ${JSON.stringify(shown)}
echo "synthetic claude ready"
while :; do [ -e ${JSON.stringify(quit)} ] && exit 0; sleep 0.2; done
`)
    chmodSync(claude, 0o755)

    phase('a Codex conversation whose session file holds one token_count line at 91% of the week')
    const day = new Date(now)
    const folder = join(codexHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'))
    mkdirSync(folder, { recursive: true })
    const rollout = join(folder, `rollout-synthetic-${CODEX_CONVERSATION}.jsonl`)
    const weekResets = now + 4 * 86_400_000
    writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: CODEX_CONVERSATION } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {
        primary: { used_percent: 91.2, window_minutes: 10_080, resets_at: epoch(weekResets) }, secondary: null } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ text: 'synthetic reply' }] } })
    ].join('\n') + '\n')
    const codexHook = (payload) => `printf '%s' '${JSON.stringify({ session_id: CODEX_CONVERSATION, cwd: root, transcript_path: rollout, ...payload })}' | bmn hook codex`
    const codex = join(root, 'codex')
    writeFileSync(codex, `#!/bin/sh
${codexHook({ hook_event_name: 'SessionStart', source: 'startup' })}
sleep 2
${codexHook({ hook_event_name: 'Stop', turn_id: 'turn-1', last_assistant_message: 'done' })}
echo "synthetic codex ready"
while :; do [ -e ${JSON.stringify(quit)} ] && exit 0; sleep 0.2; done
`)
    chmodSync(codex, 0o755)

    const claudeSession = await session(page, 'Claude refactor', root, claude)
    const codexSession = await session(page, 'Codex tests', root, codex)
    await page.reload()
    await page.locator(`.session-row > button[data-session-id="${claudeSession.sessionId}"]`).waitFor()
    await until(() => existsSync(shown), 'the wrapped status line to run')
    result.ownerStatusLine = readFileSync(shown, 'utf8')
    result.ownerStatusLineDirect = execFileSync('/bin/sh', ['-c', OWNER_LINE], { input: readFileSync(statusInput) }).toString()

    phase('Session details: Plan use for each session')
    result.claudeRow = await planUse(page, claudeSession.sessionId, /^5-hour 42% · resets .+ · week 18% · resets .+ · from Claude's status line · read /)
    result.claudeContext = await page.locator('section.plan-use .plan-use-context').getAttribute('aria-label')
    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      await page.locator('section.plan-use').screenshot({ path: join(evidenceDirectory, `plan-use-claude-${colorMode}.png`) })
    }
    await page.locator('.session-inspector').screenshot({ path: join(evidenceDirectory, 'session-details-claude-black.png') }).catch(() => undefined)
    result.codexRow = await planUse(page, codexSession.sessionId, /^week 91% · resets .+ · from Codex's session file · read /)
    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      await page.locator('section.plan-use').screenshot({ path: join(evidenceDirectory, `plan-use-codex-${colorMode}.png`) })
    }
    const shell = await page.evaluate(async (ids) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      return (await window.aiTerminal.listSessions(primary.workspaceId)).find((each) => !ids.includes(each.sessionId))
    }, [claudeSession.sessionId, codexSession.sessionId])
    await page.locator(`.session-row > button[data-session-id="${shell.sessionId}"]`).click()
    result.plainShell = await page.locator('section.plan-use .plan-use-note').textContent()

    phase('the palette dialog: the latest reading per agent')
    await page.locator('button[aria-label="Command palette"]').click()
    await page.keyboard.type('Plan use')
    await page.keyboard.press('Enter')
    const dialog = page.locator('dialog.plan-use-dialog')
    await dialog.locator('li[data-agent="codex"] .plan-use-windows').waitFor()
    await dialog.locator('li[data-agent="claude"] .plan-use-windows').waitFor()
    result.dialog = await dialog.locator('ul.plan-use-agents > li').evaluateAll((rows) => rows.map((row) => ({
      agent: row.querySelector('h3')?.textContent ?? null,
      line: row.querySelector('.plan-use-windows')?.getAttribute('aria-label') ?? row.querySelector('small')?.textContent
    })))
    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      await dialog.screenshot({ path: join(evidenceDirectory, `plan-use-dialog-${colorMode}.png`) })
    }
    await page.keyboard.press('Escape')

    phase('Needs you: one notice for the Codex week at 91%')
    const attention = await page.evaluate(() => window.aiTerminal.listAttention())
    result.notices = attention.filter((row) => row.requestKey.startsWith('usage:'))
      .map((row) => ({ title: row.title, kind: row.kind, state: row.state, openedBy: row.openedBy, expiresAt: row.expiresAt }))
    result.noticeExpiresAtReset = result.notices.length === 1 && Date.parse(result.notices[0].expiresAt) === epoch(weekResets) * 1000
    await setColorMode(page, 'black')
    await page.locator('.needs-you-button').click()
    await page.locator('.needs-you-popover .attention-item').first().waitFor()
    await page.locator('.needs-you-popover').screenshot({ path: join(evidenceDirectory, 'needs-you-plan-notice-black.png') })
    await page.keyboard.press('Escape')
    writeFileSync(quit, '')
    console.log(JSON.stringify({ directory: evidenceDirectory, ...result }))
  } finally {
    // Playwright's close has hung after screenshots before (Epic 31); the scratch app is stopped either way.
    await Promise.race([application.close(), new Promise((resolve) => setTimeout(resolve, 10_000))])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
