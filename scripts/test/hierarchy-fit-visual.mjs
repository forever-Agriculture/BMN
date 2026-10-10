/* global window, document, HTMLElement, getComputedStyle */
// MODULE: hierarchy-fit-visual.mjs - Epic 40: the sidebar row, the Needs you card and every select fit the plate standard
// The app runs in test mode with scratch XDG folders. Synthetic agent stand-ins are shells named claude, codex, opencode
// and cursor-agent, so each row carries its agent chip; the Claude one reports a z.ai origin and a permission request
// through `bmn hook claude`. No agent runs and nothing leaves the machine. Each colour mode asserts the layout facts
// below; screenshots land in .dev-auto/evidence/epic-40/shots/ (ignored).
import { sessionRequestControl } from './session-request-helpers.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-40/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const execFileAsync = promisify(execFile)
const phase = (label) => console.error(`[BMN hierarchy fit visual] ${label}`)
const COLOR_MODES = ['black', 'steel']

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
    await sleep(200)
  }
}

async function runControlCli(roots, sessionId, command, ...args) {
  await execFileAsync(process.execPath, [join(appDirectory, 'bin/bmn'), command, ...args, '--session', sessionId, '--owner',
    '--socket', join(roots.runtime, 'bmn/control/control.sock')])
}

async function setColorMode(page, colorMode) {
  await page.evaluate(async (colorMode) => {
    await window.aiTerminal.putSettings('appearance', { identity: 'knight', colorMode, terminalFontSize: 14 })
  }, colorMode)
  await page.waitForFunction((colorMode) => document.documentElement.dataset.colorMode === colorMode, colorMode)
  await sleep(300)
}

function writeAgents(directory) {
  mkdirSync(directory, { recursive: true })
  const claude = [
    '#!/bin/bash',
    `printf '%s' '{"hook_event_name":"SessionStart","source":"startup","model":"claude-sonnet-4-5"}' | ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic bmn hook claude`,
    'sleep 0.5',
    `printf '%s' '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"pnpm run package","description":"Package the desktop build"},"tool_use_id":"toolu_fixture_1"}' | bmn hook claude`,
    'exec bash --noprofile --norc'
  ].join('\n')
  const plain = '#!/bin/bash\nexec bash --noprofile --norc'
  for (const [name, text] of Object.entries({ claude, codex: plain, opencode: plain, 'cursor-agent': plain })) {
    writeFileSync(join(directory, name), `${text}\n`)
    chmodSync(join(directory, name), 0o755)
  }
}

/** Every sidebar row: the state word whole on the visible line, the chip whole beside it or clipped away entirely. */
const readRows = (page) => page.evaluate(() => [...document.querySelectorAll('.session-row')].map((row) => {
  const rect = (element) => {
    if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return null
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, text: element.textContent }
  }
  const generic = row.querySelector('.chip')?.getAttribute('data-generic') === 'true'
  return { name: rect(row.querySelector('.session-name')), flag: rect(row.querySelector('.origin-flag')),
    detail: rect(row.querySelector('.session-detail')), state: rect(row.querySelector('.session-state')),
    chip: generic ? null : rect(row.querySelector('.chip')), unread: rect(row.querySelector('.unread-mark')),
    path: rect(row.querySelector('.session-directory')) }
}))

function assertRows(rows, where) {
  const detail = (row) => `${where}: ${JSON.stringify(row)}`
  let chipsShown = 0
  let chipsClipped = 0
  for (const row of rows) {
    assert.ok(row.detail && row.state, detail(row))
    // The state word is never cut and sits on the one visible line of the detail.
    assert.ok(row.state.scrollWidth <= row.state.clientWidth, `state word cut: ${detail(row)}`)
    assert.ok(row.state.right <= row.detail.right + 0.5, `state word spills: ${detail(row)}`)
    assert.ok(row.state.top >= row.detail.top - 0.5 && row.state.bottom <= row.detail.bottom + 0.5, `state word clipped: ${detail(row)}`)
    if (row.chip) {
      const inside = row.chip.top >= row.detail.top - 0.5 && row.chip.bottom <= row.detail.bottom + 0.5
      const clipped = row.chip.bottom <= row.detail.top + 0.5
      assert.ok(inside || clipped, `chip half shown: ${detail(row)}`)
      if (inside) {
        assert.ok(row.chip.scrollWidth <= row.chip.clientWidth, `chip text cut: ${detail(row)}`)
        assert.ok(row.chip.right <= row.state.left + 0.5, `chip overlaps the state word: ${detail(row)}`)
        chipsShown++
      } else chipsClipped++
    }
    // The origin flag follows the name on the first line, on the same 18 px line box as a row without one.
    if (row.flag) {
      assert.ok(row.flag.left >= row.name.right - 0.5 && row.flag.bottom <= row.detail.top + 0.5, `flag misplaced: ${detail(row)}`)
      assert.ok(row.flag.bottom - row.flag.top <= 18.5, `flag taller than the line: ${detail(row)}`)
    }
    // Without a flag or an unread mark the name runs to the detail's right edge: no empty column is paid for.
    if (!row.flag && !row.unread) assert.ok(Math.abs(row.name.right - row.detail.right) <= 1, `name short of the edge: ${detail(row)}`)
    // A path too narrow to read is hidden rather than shown as a few letters.
    if (row.path) assert.ok(row.path.right - row.path.left >= 60, `path shown too narrow: ${detail(row)}`)
  }
  // Both outcomes occur in this fixture, so neither branch above is vacuous.
  assert.ok(chipsShown > 0 && chipsClipped > 0, `${where}: expected whole and hidden chips, saw ${chipsShown}/${chipsClipped}`)
  assert.equal(rows.filter((row) => row.unread).length, 1, `${where}: one unread row`)
}

/** Every visible help line in scope takes one line. */
const readHelp = (page, selector) => page.evaluate((selector) => [...document.querySelectorAll(selector)]
  .filter((help) => help instanceof HTMLElement && help.getClientRects().length > 0)
  .map((help) => {
    const style = getComputedStyle(help)
    const line = style.lineHeight === 'normal' ? parseFloat(style.fontSize) * 1.4 : parseFloat(style.lineHeight)
    return { text: help.textContent, height: help.getBoundingClientRect().height, line }
  }), selector)

function assertOneLine(helps, where, minimum) {
  assert.ok(helps.length >= minimum, `${where}: expected at least ${minimum} help lines, saw ${helps.length}`)
  for (const help of helps) assert.ok(help.height < help.line * 1.5, `${where}: help wraps: ${JSON.stringify(help)}`)
}

/** Selects are drawn by BMN, never by the platform. */
const readSelects = (page, scope) => page.evaluate((scope) => [...document.querySelectorAll(`${scope} select`)].map((select) => ({
  label: select.getAttribute('aria-label') ?? select.id ?? select.name, appearance: getComputedStyle(select).appearance
})), scope)

function assertSelects(selects, where, minimum) {
  assert.ok(selects.length >= minimum, `${where}: expected at least ${minimum} selects, saw ${selects.length}`)
  for (const select of selects) assert.equal(select.appearance, 'none', `${where}: ${JSON.stringify(select)}`)
}

mkdirSync(evidenceDirectory, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const application = await electron.launch({ chromiumSandbox: true,
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
    const shot = async (name, selector) => {
      const clip = await page.evaluate((selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect()
        return box ? { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) } : null
      }, selector)
      const png = await application.evaluate(async ({ BrowserWindow }, clip) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage(clip ?? undefined)).toPNG().toString('base64'), clip)
      writeFileSync(join(evidenceDirectory, name), Buffer.from(png, 'base64'))
    }

    phase('five agent and shell rows, one scrolled away from its tail')
    const agents = join(root, 'agents')
    writeAgents(agents)
    const cwd = join(root, 'projects', 'bmn-workspace', 'apps', 'desktop')
    mkdirSync(cwd, { recursive: true })
    const fixture = await page.evaluate(async ({ specs, cwd }) => {
      const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
      const sessions = []
      for (const [name, executable] of specs) {
        sessions.push((await window.aiTerminal.createSession({ workspaceId: primary.workspaceId, name, cwd, executable,
          argv: executable === '/bin/bash' ? ['--noprofile', '--norc'] : [], cols: 80, rows: 24, backgroundChoice: 'stop' })).session)
      }
      // Output in a session whose view is not following its tail marks its row unread.
      const current = await window.aiTerminal.getLayout(primary.workspaceId)
      await window.aiTerminal.putLayout({ workspaceId: primary.workspaceId, expectedRevision: current.layout.revision,
        state: { ...current.layout, sessionView: { ...current.layout.sessionView,
          [sessions[3].sessionId]: { scrollLine: 0, followTail: false } } } })
      return sessions.map((session) => session.sessionId)
    }, { specs: [
      ['Claude — renderer hierarchy review', join(agents, 'claude')],
      ['Codex — cross-epic architecture alignment', join(agents, 'codex')],
      ['OpenCode — a deliberately long session name for truncation', join(agents, 'opencode')],
      ['Cursor — sidebar layout', join(agents, 'cursor-agent')],
      ['Build watcher', '/bin/bash']
    ], cwd })
    const [, codex, , cursor, watcher] = fixture
    await page.reload({ waitUntil: 'domcontentloaded' })
    await until(() => page.evaluate(() => document.querySelectorAll('.session-row').length >= 6), 'six rows')
    // Typing into a session answers its own requests, so each session gets one thing only.
    await runControlCli(roots, watcher, 'send', "printf '\\033]9;Nightly build finished on the watcher\\007'", '--submit')
    await runControlCli(roots, codex, 'ask', 'e40-question', 'Which migration order should I use?', '--kind', 'question')
    await runControlCli(roots, cursor, 'send', "(sleep 4; printf 'CURSOR-LATE-OUTPUT\\n') &", '--submit')
    await until(() => page.evaluate(() => document.querySelector('.origin-flag') !== null), 'the origin flag', 30_000)
    await until(() => page.evaluate(async () => (await window.aiTerminal.listAttention())
      .filter((row) => row.state === 'open').length >= 3), 'three open requests', 30_000)
    await until(() => page.evaluate(() => document.querySelector('.session-row .unread-mark') !== null), 'the unread mark')
    await sleep(800)

    for (const colorMode of COLOR_MODES) {
      await setColorMode(page, colorMode)
      phase(`${colorMode}: sidebar rows`)
      await shot(`${colorMode}-sidebar.png`, '.workspace-sidebar')
      const rows = await readRows(page)
      assertRows(rows, `${colorMode} sidebar`)
      result[`${colorMode}Rows`] = rows.length

      await runControlCli(roots, watcher, 'send', "printf '\\033]9;Nightly build finished on the watcher\\007'", '--submit')
      phase(`${colorMode}: Needs you cards`)
      // Opened from the keyboard: Tab then walks the cards' buttons in the order they read, none skipped.
      const allCards = []
      for (const requestSession of [fixture[0], codex, watcher]) {
        await (await sessionRequestControl(page, requestSession)).focus()
        await page.keyboard.press('Enter')
        await page.waitForSelector('.session-request-card .attention-item')
        await page.waitForFunction(() => document.activeElement?.closest('.session-request-card'))
        const tabOrder = []
        const controls = await page.locator('.session-request-card button:not(:disabled)').count()
        for (let step = 0; step < controls; step++) {
          tabOrder.push(await page.evaluate(() => [...document.querySelectorAll('.session-request-card button:not(:disabled)')]
            .indexOf(document.activeElement)))
          if (step + 1 < controls) await page.keyboard.press('Tab')
        }
        assert.ok(tabOrder[0] >= 0 && tabOrder.every((index, step) => index === tabOrder[0] + step), `${colorMode} tab order: ${tabOrder}`)
        await sleep(300)
        await shot(`${colorMode}-requests-${requestSession}.png`, '.session-request-card')
        const popover = await page.evaluate(() => ({
          header: document.querySelector('.session-request-card header span')?.textContent ?? null,
          cards: [...document.querySelectorAll('.session-request-card .attention-item')].map((card) => {
            const provenance = card.querySelector('.provenance')
            const buttons = [...card.querySelectorAll('.actions button')]
            return {
              cleared: card.dataset.cleared === 'true',
              title: card.querySelector('h3')?.textContent ?? null,
              primaries: buttons.filter((button) => button.classList.contains('primary')).length,
              ghosts: buttons.filter((button) => button.classList.contains('ghost')).length,
              // A plate has a fill of its own; a bare word on the card's background is the pattern Epic 40 retires.
              unfilled: buttons.filter((button) => /rgba\(.+, 0\)$|transparent/.test(getComputedStyle(button).backgroundColor))
                .map((button) => button.textContent),
              provenanceOnSeenLine: provenance?.parentElement?.classList.contains('seen') ?? false,
              provenanceCut: provenance instanceof HTMLElement ? provenance.scrollWidth > provenance.clientWidth : null,
              provenance: provenance?.textContent ?? null,
              whereHeight: card.querySelector('.where')?.getBoundingClientRect().height ?? null,
              kindBorder: (() => {
                const kind = card.querySelector('.attention-kind')
                return kind ? getComputedStyle(kind).borderTopWidth : null
              })()
            }
          })
        }))
        assert.equal(popover.cards.length, 1, JSON.stringify(popover))
        assert.equal(popover.header, popover.cards[0].cleared ? '0 open' : '1 open', JSON.stringify(popover))
        for (const card of popover.cards) {
          const detail = `${colorMode} card: ${JSON.stringify(card)}`
          assert.equal(card.primaries, card.cleared ? 0 : 1, detail)
          assert.equal(card.ghosts, 0, detail)
          assert.deepEqual(card.unfilled, [], detail)
          assert.equal(card.provenanceOnSeenLine, true, detail)
          assert.equal(card.provenanceCut, false, detail)
          assert.match(card.provenance ?? '', /^from /, detail)
          // The place, kind and age share one line however long the session name, and the kind tag is filled.
          assert.ok((card.whereHeight ?? 99) <= 24, detail)
          assert.equal(card.kindBorder, '0px', detail)
        }
        allCards.push(...popover.cards.map(card => card.provenance))
        await page.keyboard.press('Escape')
        await sleep(200)

      }
      assert.equal(allCards.length, 3)
      result[`${colorMode}Cards`] = allCards

      phase(`${colorMode}: Preferences`)
      await page.locator('.preferences-button').click()
      await page.waitForSelector('.preferences-dialog')
      await sleep(400)
      // Each earlier section is its own page now: open them one by one from the navigation.
      const pages = await page.locator('.preferences-dialog .nav-group .nav-item').allTextContents()
      assert.deepEqual(pages, ['Appearance', 'Terminal', 'Notifications', 'Voice', 'Telegram', 'Local control', 'History', 'Backup'])
      const helps = []
      for (const [index, heading] of pages.entries()) {
        await page.locator('.preferences-dialog .nav-group .nav-item', { hasText: new RegExp(`^${heading}$`) }).click()
        await page.locator('.preferences-dialog .preferences-page:not([hidden]) h3', { hasText: new RegExp(`^${heading}$`) }).waitFor()
        await sleep(200)
        await shot(`${colorMode}-preferences-${index}-${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, '.preferences-dialog')
        helps.push(...await readHelp(page, '.preferences-dialog .preferences-help'))
      }
      assertSelects(await readSelects(page, '.preferences-dialog'), `${colorMode} Preferences`, 2)
      assertOneLine(helps, `${colorMode} Preferences`, 10)
      const telegram = await page.evaluate(() => {
        const status = document.querySelector('.preferences-dialog dl.telegram-status')
        const section = [...document.querySelectorAll('.preferences-dialog .preferences-section')]
          .find((candidate) => candidate.querySelector('h3')?.textContent === 'Telegram')
        return { terms: [...(status?.querySelectorAll('dt') ?? [])].map((term) => term.textContent),
          helpInLabelColumn: [...document.querySelectorAll('.preferences-dialog .preferences-row-label .preferences-help')].length,
          refreshInHead: section?.querySelector('.preferences-section-head button')?.textContent ?? null,
          firstRow: section?.querySelector('.preferences-row .preferences-row-label')?.textContent?.trim() ?? null }
      })
      assert.deepEqual(telegram, { terms: ['State', 'Token', 'Last poll', 'Last error', 'Rejected updates'], helpInLabelColumn: 0,
        refreshInHead: 'Refresh', firstRow: 'Enabled' },
        `${colorMode} Telegram: ${JSON.stringify(telegram)}`)
      await page.keyboard.press('Escape')
      await sleep(200)

      phase(`${colorMode}: launch sets`)
      await page.locator('.workspace-row .row-menu-button').first().click()
      await page.getByRole('menuitem', { name: 'Save a launch set…' }).click()
      await page.waitForSelector('.launch-sets-dialog')
      await page.locator('.launch-sets-dialog button', { hasText: 'New set' }).click()
      await sleep(400)
      await shot(`${colorMode}-launch-sets.png`, '.launch-sets-dialog')
      assertSelects(await readSelects(page, '.launch-sets-dialog'), `${colorMode} launch sets`, 1)
      assertOneLine(await readHelp(page, '.launch-sets-dialog small'), `${colorMode} launch sets`, 1)
      const fieldsets = await page.evaluate(() => [...document.querySelectorAll('.launch-sets-dialog fieldset')]
        .map((fieldset) => getComputedStyle(fieldset).borderLeftWidth))
      assert.ok(fieldsets.length > 0 && fieldsets.every((width) => width === '0px'), `${colorMode} fieldsets outlined: ${fieldsets}`)
      await page.keyboard.press('Escape')
      await sleep(200)

      phase(`${colorMode}: session launcher`)
      await page.locator('.workspace-row .row-menu-button').first().click()
      await page.getByRole('menuitem', { name: 'New session here' }).click()
      await page.waitForSelector('.create-form')
      await page.locator('.create-form details.advanced summary').first().click().catch(() => undefined)
      await sleep(300)
      await shot(`${colorMode}-launcher.png`, '.session-launcher')
      assertSelects(await readSelects(page, '.create-form'), `${colorMode} launcher`, 1)
      await page.keyboard.press('Escape')
      await sleep(200)

      // Hover is judged by eye: the row's plate under the pointer.
      await page.locator('.session-row > button').nth(2).hover()
      await sleep(200)
      await shot(`${colorMode}-sidebar-hover.png`, '.workspace-sidebar')
      await page.mouse.move(900, 500)
    }
    phase('black: a stopped row and keyboard focus on a row')
    await setColorMode(page, 'black')
    await page.evaluate((sessionId) => window.aiTerminal.stopSession(sessionId), watcher)
    await until(() => page.evaluate((sessionId) => document.querySelector(`.session-row button[data-session-id="${sessionId}"]`)
      ?.closest('.session-row')?.getAttribute('data-live') === 'false', watcher), 'the stopped row')
    const rowButtons = page.locator('.session-row > button:first-child')
    await rowButtons.nth(1).focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await sleep(200)
    await shot('black-sidebar-focus-stopped.png', '.workspace-sidebar')
    assertRows(await readRows(page), 'black sidebar with a stopped row')
    console.log(JSON.stringify({ hierarchyFitVisual: 'PASS', directory: evidenceDirectory, ...result }))
  } finally {
    // BMN asks before closing with live sessions, so a graceful close can wait; the scratch app is stopped either way.
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
