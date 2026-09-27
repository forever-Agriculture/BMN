/* global window, document */
// MODULE: history-visual.mjs - screenshots Preferences → History, pending and settled, in every identity and colour mode (Epic 31)
// The app runs with a scratch HOME, CODEX_HOME and XDG folders and stand-in `codex`/`opencode`/`cursor-agent` binaries, so no owner
// file is read or shown. Screenshots land in .dev-auto/evidence/epic-31/history/ (ignored).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-31/history')
const requireFromApp = createRequire(join(appDirectory, 'package.json'))
const electronBinary = requireFromApp('electron')
const sqlitePath = requireFromApp.resolve('better-sqlite3')
const BetterSqlite3 = requireFromApp('better-sqlite3')
const phase = (label) => console.error(`[BMN history visual] ${label}`)
const DAY = 86_400_000
const IDENTITIES = ['knight', 'cross', 'boss']
const COLOR_MODES = ['steel', 'brown', 'dark', 'black']

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay

/** A stand-in agent that deletes the row its real counterpart would, so the settled counts move. */
function standIn(bin, name, store, table) {
  const path = join(bin, name)
  writeFileSync(path, `#!${process.execPath}
const Database = require(${JSON.stringify(sqlitePath)})
const id = process.argv.at(${name === 'codex' ? -1 : -2})
// One old OpenCode session is open elsewhere, so the settled row shows its failure line.
if (id.endsWith('000XIFvU67lmdh')) { console.error('session is open elsewhere'); process.exit(1) }
const db = new Database(${JSON.stringify(store)})
db.prepare('DELETE FROM ${table} WHERE id = ?').run(id)
db.close()
console.log('Deleted session ' + id)
`)
  chmodSync(path, 0o755)
}

function fixture(root, roots) {
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const codexHome = join(home, '.codex')
  for (const folder of [join(home, '.claude'), join(home, '.claude-glm'), bin, codexHome, join(roots.data, 'opencode')]) {
    mkdirSync(folder, { recursive: true })
  }
  writeFileSync(join(home, '.claude', 'settings.json'), '{\n  "model": "opus"\n}\n')
  writeFileSync(join(home, '.claude-glm', 'settings.json'), '{\n  "cleanupPeriodDays": 30\n}\n')
  const now = Date.now()
  const codex = new BetterSqlite3(join(codexHome, 'state_5.sqlite'))
  codex.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, archived INTEGER)')
  const thread = codex.prepare('INSERT INTO threads VALUES (?, ?, ?, 0)')
  // The Design section's counts: 863 sessions, 412 untouched for longer than 30 days.
  for (let index = 0; index < 863; index += 1) {
    const age = index < 412 ? 31 + (index % 20) : index % 29
    const id = `01a0e466-${String(index).padStart(4, '0')}-7372-89eb-960c2fe7e28a`
    thread.run(id, Math.floor((now - (age + 1) * DAY) / 1000), Math.floor((now - age * DAY - 3_600_000) / 1000))
  }
  codex.close()
  const opencode = new BetterSqlite3(join(roots.data, 'opencode', 'opencode.db'))
  opencode.exec('CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER)')
  const session = opencode.prepare('INSERT INTO session VALUES (?, ?, ?)')
  for (let index = 0; index < 8; index += 1) {
    const age = index < 3 ? 40 + index : 3 + index
    session.run(`ses_f1b971253ffe${String(index).padStart(3, '0')}XIFvU67lmdh`, now - (age + 1) * DAY, now - age * DAY)
  }
  opencode.close()
  standIn(bin, 'codex', join(codexHome, 'state_5.sqlite'), 'threads')
  standIn(bin, 'opencode', join(roots.data, 'opencode', 'opencode.db'), 'session')
  // Cursor has no delete command, so its row only says it keeps its own history; the stand-in is never run.
  writeFileSync(join(bin, 'cursor-agent'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'cursor-agent'), 0o755)
  return { home, bin, codexHome }
}

/** Polls a History status predicate; `waitForFunction` would treat an async predicate's promise as true at once. */
async function untilStatus(page, predicate, label, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const status = await page.evaluate(() => window.aiTerminal.getHistoryStatus())
    if (predicate(status)) return status
    if (Date.now() > end) throw new Error(`history status never showed ${label}: ${JSON.stringify(status)}`)
    await page.waitForTimeout(250)
  }
}

async function setAppearance(page, identity, colorMode) {
  await page.evaluate(async ({ identity, colorMode }) => {
    await window.aiTerminal.putSettings('appearance', { identity, colorMode, terminalFontSize: 14 })
  }, { identity, colorMode })
  await page.waitForFunction(({ identity, colorMode }) =>
    document.documentElement.dataset.identity === identity && document.documentElement.dataset.colorMode === colorMode,
  { identity, colorMode })
}

async function openHistory(page) {
  if (!(await page.locator('.preferences-dialog').count())) await page.locator('.preferences-button').click()
  await page.locator('.history-rows').waitFor()
  await page.evaluate(() => document.querySelector('#preferences-history-title')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(150)
}

async function shoot(page, state) {
  const shots = []
  for (const identity of IDENTITIES) {
    for (const colorMode of COLOR_MODES) {
      await setAppearance(page, identity, colorMode)
      await openHistory(page)
      const path = join(evidenceDirectory, `${state}-${colorMode}-${identity}.png`)
      await page.locator('.history-section').screenshot({ path })
      shots.push(path)
    }
  }
  return shots
}

mkdirSync(evidenceDirectory, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const paths = fixture(root, roots)
  const application = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: paths.home,
      PATH: `${paths.bin}:${process.env.PATH}`,
      CODEX_HOME: paths.codexHome,
      CLAUDE_CONFIG_DIR: '',
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
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    phase('teaching BMN the GLM folder through a real `bmn hook claude` call')
    // `bmn hook` answers only for an agent process above it, never a bare shell, so a node stand-in makes the call.
    const standInAgent = join(root, 'glm-agent.cjs')
    writeFileSync(standInAgent, `require('node:child_process').spawnSync('bmn', ['hook', 'claude'], {
  input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'true' } }),
  env: { ...process.env, CLAUDE_CONFIG_DIR: ${JSON.stringify(join(paths.home, '.claude-glm'))} }
})
setTimeout(() => {}, 600_000)
`)
    await page.evaluate(async ({ cwd, node, agent }) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      await window.aiTerminal.createSession({
        workspaceId: primary.workspaceId, name: 'claude glm', cwd, executable: node, argv: [agent],
        cols: 80, rows: 24, backgroundChoice: 'stop'
      })
    }, { cwd: root, node: process.execPath, agent: standInAgent })
    await untilStatus(page, (status) => status.claude.length === 2, 'the learned GLM folder', 20_000)
    await page.locator('.preferences-button .status-dot.needs-you').waitFor()
    await page.screenshot({ path: join(evidenceDirectory, 'window-pending-dot.png') })

    phase('pending, 12 identity × colour screenshots')
    const pending = await shoot(page, 'pending')
    phase('narrow window')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(540, 900))
    await page.waitForTimeout(300)
    await page.locator('.history-section').screenshot({ path: join(evidenceDirectory, 'pending-narrow.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await page.waitForTimeout(300)

    phase('Start cleanup')
    await page.locator('.history-confirm button.primary').click()
    const settledStatus = await untilStatus(page, (status) => !status.running && status.agents.every((row) => row.state === 'own' || row.lastRun),
      'a finished first run', 120_000)
    phase(`settled ${JSON.stringify(settledStatus.agents)}`)
    await page.locator('.preferences-dialog [aria-label="Close Preferences"]').click()
    const settled = await shoot(page, 'settled')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(540, 900))
    await page.waitForTimeout(300)
    await page.locator('.history-section').screenshot({ path: join(evidenceDirectory, 'settled-narrow.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await page.waitForTimeout(300)

    phase('a shorter limit waits for confirmation')
    await page.locator('.history-section [role="radio"]', { hasText: '7 days' }).first().click()
    await page.locator('.history-confirm').waitFor()
    await page.locator('.history-section').screenshot({ path: join(evidenceDirectory, 'shorter-pending-black-knight.png') })
    console.log(JSON.stringify({ pending: pending.length, settled: settled.length, directory: evidenceDirectory, agents: settledStatus.agents }))
  } finally {
    await application.close()
  }
})
