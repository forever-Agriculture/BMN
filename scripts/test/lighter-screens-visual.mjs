/* global window, document, getComputedStyle */
// MODULE: lighter-screens-visual.mjs - Epic 75.1/75.10/76.1: the window head (focus mode, 540 px), the project plate, every Preferences page, the three ⋯ menus, the Files panel, Review results and the palette, captured on synthetic data
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end). The temporary home holds the
// unit-test roster, a synthetic rules master and two synthetic skills; stand-ins for claude and codex sit on the PATH
// the home's shell settings add. One workspace carries what the owner-facing controls act on (the before set of
// 4e2c44f also held a launch set and a custom template, gone with Story 75.3, and the confirmations of the two
// workspace switches, gone with Story 75.4, which left messages and turn changes always on), and a session whose
// shell publishes a file, reports progress with it as evidence, asks for a review and tries to leave a second session
// a message, all with BMN's own `bmn` commands; since Story 75.4 the message is refused, because the second session
// runs a plain shell and no agent. The before set's seed prepared a handoff for the owner to paste instead of the review
// request; Story 75.5 made handoffs deliver themselves, so nothing of one waits on these screens.
// Since Story 75.10 Review results and Messages open from the palette, and Preferences has six pages, Agents and
// Integrations with a control over their views; the after set (reference-75-lighter/after) is taken with this script.
// No agent runs, nothing leaves the machine and no file of the owner's is read. The script asserts nothing: it opens
// each screen, saves what the window shows in each colour mode and writes shots.json naming the screens, the parts
// and the buttons each capture showed. A screen that cannot be opened is listed with the reason, and the run goes on.
// Main-window screens and Preferences are taken at the window's default 1000x700; a region taller than the window is
// taken in parts, top to bottom.
// Usage: node scripts/test/lighter-screens-visual.mjs [output folder]
//   default folder: <main checkout>/plan/references/reference-75-lighter/before (or BMN_LIGHTER_SHOTS)
//   BMN_LIGHTER_SCREENS=preferences-team,palette  only screens whose name starts with one of these;
//   BMN_LIGHTER_MODES=black  fewer modes (default black,steel). A narrowed run writes its own shots.json, so give it a folder of its own.
//   BMN_LIGHTER_BINARY=<packaged bmn>  the screens of a packaged build, as electron-normal-start --binary.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const cli = join(appDirectory, 'bin/bmn')
const fixtures = join(appDirectory, 'src/utility/test-fixtures')
const packagedBinary = process.env.BMN_LIGHTER_BINARY ? resolve(process.env.BMN_LIGHTER_BINARY) : undefined
const electronBinary = packagedBinary ?? createRequire(join(appDirectory, 'package.json'))('electron')
const git = (...args) => { try { return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
// The planning folder is ignored by git and lives in the main checkout only, not in a worktree.
const mainCheckout = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir') ?? join(repoRoot, '.git'))
const outDirectory = resolve(process.argv[2] ?? process.env.BMN_LIGHTER_SHOTS ??
  join(mainCheckout, 'plan/references/reference-75-lighter/before'))
const COLOR_MODES = (process.env.BMN_LIGHTER_MODES?.split(',') ?? ['black', 'steel']).filter(Boolean)
const ONLY = process.env.BMN_LIGHTER_SCREENS?.split(',').filter(Boolean) ?? null
const SIZE = [1000, 700]
const PART_LIMIT = 12
const phase = (label) => console.error(`[BMN lighter screens] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const wanted = (screen) => ONLY === null || ONLY.some((prefix) => screen.startsWith(prefix))
const firstLine = (error) => String(error?.message ?? error).split('\n')[0]

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay

const MASTER = `# Global rules

Plain rule for everyone.

<!-- bmn:public -->
## How to talk
Answer first, plainly.
<!-- /bmn:public -->

## Team
The team: <!-- bmn:team -->.

<!-- bmn:apps claude codex -->
A rule only apps that may see private work get.
<!-- /bmn:apps -->
`

// The caller's prompt hook (PROMPT_COMMAND) names programs the temporary home does not have.
const callerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND'))

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  mkdirSync(outDirectory, { recursive: true })
  const home = join(root, 'home')
  const work = join(root, 'work')
  const stubs = join(root, 'stubs')
  const agentsDir = join(home, '.config/bmn/agents')
  for (const folder of [agentsDir, join(agentsDir, 'state'), work, stubs]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(join(agentsDir, 'roster.md'), readFileSync(join(fixtures, 'agents/roster-example.md'), 'utf8'))
  writeFileSync(join(agentsDir, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# hand-kept rules\n')
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/AGENTS.md'), '# written by hand\n')
  for (const [name, description] of [['evidence-first', 'Check a claim against the files before saying it.'], ['small-steps', 'Change one thing, then check it.']]) {
    mkdirSync(join(home, '.claude/skills', name), { recursive: true })
    writeFileSync(join(home, '.claude/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSynthetic skill text.\n`)
  }
  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  stub('claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; *) echo "synthetic claude"; cat > /dev/null;; esac')
  stub('codex', 'case "$1" in --version) echo "codex-cli 0.162.1";; *) echo "synthetic codex";; esac')
  writeFileSync(join(work, 'report.md'), '# Search filters\n\nSynthetic report: the filters were added and the unit tests pass.\n')

  const application = await electron.launch({
    executablePath: electronBinary,
    args: [...(packagedBinary ? [] : [appDirectory]), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...callerEnvironment,
      HOME: home,
      SHELL: '/bin/bash',
      PATH: '/usr/bin:/bin',
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: work,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  const manifest = {
    generatedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), worktree: repoRoot, binary: packagedBinary ?? 'development',
    colorModes: COLOR_MODES, size: SIZE, setup: [], screens: []
  }
  const note = (line) => { manifest.setup.push(line); phase(line) }
  const written = []
  let page
  try {
    const resize = async ([width, height]) => {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
      await sleep(350)
    }
    page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.waitForSelector('.session-row')
    // A background test window may never paint without being shown.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    await resize(SIZE)

    const setColorMode = async (colorMode) => {
      await page.evaluate(async (colorMode) => {
        await window.aiTerminal.putSettings('appearance', { identity: 'knight', colorMode, terminalFontSize: 14 })
      }, colorMode)
      await page.waitForFunction((colorMode) => document.documentElement.dataset.colorMode === colorMode, colorMode)
      await sleep(150)
    }
    const capture = async (file) => {
      written.push(file)
      const png = await application.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(outDirectory, file), Buffer.from(png, 'base64'))
    }
    /** The buttons, menu entries, switches and links visible inside `region`, as shown: what the owner can press there. */
    const controls = (region) => page.evaluate((region) => {
      const roots = region === null ? [document.body] : [...document.querySelectorAll(region)]
      const found = []
      for (const scope of roots) {
        for (const element of scope.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"], [role="option"], input[type="checkbox"], a[href], summary')) {
          const box = element.getBoundingClientRect()
          if (box.width === 0 || box.height === 0 || box.bottom <= 0 || box.top >= window.innerHeight) continue
          if (getComputedStyle(element).visibility === 'hidden') continue
          let clipped = false
          for (let parent = element.parentElement; parent && !clipped; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue
            const clip = parent.getBoundingClientRect()
            clipped = box.bottom <= clip.top || box.top >= clip.bottom
          }
          if (clipped) continue
          const words = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
          const checked = element.getAttribute('aria-checked') ?? (element.type === 'checkbox' ? String(element.checked) : null)
          if (words) found.push(`${element.getAttribute('role') ?? element.tagName.toLowerCase()}: ${words}${checked === null ? '' : ` [${checked}]`}${element.disabled || element.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : ''}`)
        }
      }
      return [...new Set(found)].slice(0, 120)
    }, region)
    /** Marks the element that scrolls `selector`'s content and says how many window-high parts it has. */
    const partsOf = (selector) => page.evaluate(({ selector, limit }) => {
      for (const element of document.querySelectorAll('[data-lighter-shots-scroll]')) element.removeAttribute('data-lighter-shots-scroll')
      const root = selector === null ? null : document.querySelector(selector)
      if (root === null) return { count: 1, step: 0 }
      const scrolls = (element) => element.scrollHeight > element.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(element).overflowY)
      let box = scrolls(root) ? root : [...root.querySelectorAll('*')].find(scrolls) ?? null
      for (let parent = root.parentElement; box === null && parent; parent = parent.parentElement) if (scrolls(parent)) box = parent
      if (box === null) return { count: 1, step: 0 }
      box.setAttribute('data-lighter-shots-scroll', '')
      box.scrollTop = 0
      const step = Math.max(120, box.clientHeight - 48)
      return { count: Math.min(limit, Math.ceil((box.scrollHeight - box.clientHeight) / step) + 1), step }
    }, { selector, limit: PART_LIMIT })
    const scrollPart = (index, step) => page.evaluate(([index, step]) => {
      const box = document.querySelector('[data-lighter-shots-scroll]')
      if (box) box.scrollTop = index * step
    }, [index, step])

    /**
     * Opens one screen and saves it in every colour mode, in parts when `scroll` names a region taller than the
     * window. A screen that cannot be opened is recorded with the reason, and the run goes on.
     */
    const screen = async (name, how, open, { scroll = null, close = null, region = null } = {}) => {
      if (!wanted(name)) return
      const entry = { screen: name, how, controlsFrom: region ?? 'the whole window', parts: [] }
      manifest.screens.push(entry)
      try {
        await open()
        await sleep(500)
        const { count, step } = await partsOf(scroll)
        for (let index = 0; index < count; index += 1) {
          await scrollPart(index, step)
          await sleep(150)
          const part = { files: [], controls: await controls(region) }
          for (const colorMode of COLOR_MODES) {
            await setColorMode(colorMode)
            const file = `${name}${count > 1 ? `-part${index + 1}` : ''}-${colorMode}.png`
            await capture(file)
            part.files.push(file)
          }
          entry.parts.push(part)
        }
        phase(`${name}: ${entry.parts.length} part(s)`)
      } catch (error) {
        entry.error = firstLine(error)
        phase(`${name}: NOT CAPTURED: ${entry.error}`)
        try { await capture(`${name}-failure.png`); entry.failureShot = `${name}-failure.png` } catch { /* the window is gone */ }
      }
      if (close) await close().catch(() => undefined)
      await page.keyboard.press('Escape').catch(() => undefined)
      await sleep(200)
    }
    const escape = async () => { await page.keyboard.press('Escape') }

    // ---- synthetic workspace data -----------------------------------------------------------------------------
    const workspaceNow = () => page.evaluate(async () => (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt))
    const workspace = await workspaceNow()
    const startSession = (name, argv) => page.evaluate(async ({ workspaceId, cwd, name, argv }) => {
      try {
        return { session: (await window.aiTerminal.createSession({ workspaceId, name, cwd, executable: '/bin/bash', argv, cols: 100, rows: 24, backgroundChoice: 'stop' })).session }
      } catch (error) {
        return { failed: JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})) }
      }
    }, { workspaceId: workspace.workspaceId, cwd: work, name, argv })
    // Story 76.6: an away period with nothing in it, taken before any session works: back opens the summary by itself, once.
    const setAway = (to, note) => page.evaluate(([to, note]) => window.aiTerminal.setAway(to, note ?? undefined), [to, note])
    const summaryDialog = page.locator('dialog.away-summary-dialog')
    if (wanted('away-summary-empty')) {
      await setAway('away')
      await sleep(400)
      await setAway('back')
    }
    await screen('away-summary-empty', 'Back after an away with nothing in it: the summary opened by itself, once', async () => {
      await summaryDialog.waitFor()
    }, { region: 'dialog.away-summary-dialog', scroll: 'dialog.away-summary-dialog', close: escape })
    const reviewer = await startSession('Reviewer', ['--noprofile', '--norc', '-i'])
    if (reviewer.failed) throw new Error(`the Reviewer session was not started: ${reviewer.failed}`)
    note(`session "Reviewer" started: a plain shell in ${work}`)
    const workspaceRow = page.locator(`button[aria-label="Actions for ${workspace.name}"]`)
    const openWorkspaceMenu = async () => {
      await workspaceRow.click()
      await page.locator('[role="menu"]').first().waitFor()
    }

    // The Builder's shell does what an agent does with BMN: publish, report progress with evidence, hand off, tell.
    const reviewerId = reviewer.session.sessionId
    const seed = join(root, 'seed.sh')
    writeFileSync(seed, `B() { if command -v bmn >/dev/null; then bmn "$@"; else '${process.execPath}' '${cli}' "$@"; fi; }
cd '${work}'
published=$(B publish report.md --key seed-publish)
echo "$published"
id=$(printf '%s\\n' "$published" | sed -n 's/.* as \\([^ ]*\\).*/\\1/p')
B progress claimed-done 'Story 1.2 search filters' --detail 'Filters added; unit tests pass.' --evidence-id "$id" --source synthetic
B ask seed-review 'Review the search filter change in src/search.ts' --kind review --body 'The tests are in search.test.ts.'
B tell '${reviewerId}' --text 'The search filter change is ready for your review.' --key seed-tell
echo seeded
`)
    const builder = await startSession('Builder', ['-ic', `bash '${seed}'; exec bash -i`])
    if (builder.failed) throw new Error(`the Builder session was not started: ${builder.failed}`)
    const builderId = builder.session.sessionId
    note('session "Builder" started: its shell publishes report.md, reports progress with it, asks for a review and leaves Reviewer a message')
    await sleep(6_000)
    // Sessions started through the bridge reach the window's view of running processes on its next load.
    await page.reload()
    await page.waitForSelector('.session-row')
    // The reload rebuilds the live panes' views, and BMN says so once; that notice is the reload's, not a screen's.
    await page.locator('button[aria-label="Dismiss notice"]').click({ timeout: 5_000 }).catch(() => undefined)
    const builderRow = page.locator(`.session-row > button[data-session-id="${builderId}"]`)
    const reviewerRow = page.locator(`.session-row > button[data-session-id="${reviewerId}"]`)
    await builderRow.click()
    await sleep(1_500)
    const seeded = await page.evaluate((id) => window.__aitermTest?.snapshot(id)?.bufferLines ?? [], builderId).catch(() => [])
    note(`Builder's shell said: ${seeded.map((line) => line.trimEnd()).filter(Boolean).slice(-8).join(' | ')}`)

    // ---- main window -----------------------------------------------------------------------------------------
    await screen('main-window', 'Main window, Builder selected: sidebar, pane header and the session\'s output', async () => { await builderRow.click() })
    // Story 76.1: the window head where the Away check goes, which must survive focus mode and a narrow window.
    await screen('head-focus', 'Focus mode (Ctrl Shift Z), Builder selected: the window head without the sidebar', async () => {
      await builderRow.click()
      await page.keyboard.press('Control+Shift+Z')
      await page.locator('.workspace-body.focus-mode').waitFor()
    }, { region: '.app-header', close: async () => { await page.keyboard.press('Control+Shift+Z'); await page.locator('.workspace-body.focus-mode').waitFor({ state: 'detached' }) } })
    await screen('head-narrow', 'Main window at 540 px wide, Builder selected: the window head and what it keeps', async () => {
      await builderRow.click()
      await resize([540, 700])
    }, { region: '.app-header', close: async () => { await resize(SIZE) } })
    // The project plate (Fable, 2026-10-18): the pane's one filled button, named by its folder, opens Quick look.
    const builderHeading = `.session-terminal[data-session-id="${builderId}"] .pane-heading`
    await screen('pane-plate', 'Pane header of Builder: the project plate named by its folder, then the borderless toggles', async () => { await builderRow.click() },
      { region: builderHeading })
    await screen('pane-plate-narrow', 'Pane header at 540 px wide: the plate keeps its fill without its word', async () => {
      await builderRow.click()
      await resize([540, 700])
    }, { region: builderHeading, close: async () => { await resize(SIZE) } })
    await screen('pane-plate-split', 'Split (Ctrl Shift Enter): each pane names its own folder', async () => {
      await builderRow.click()
      await page.keyboard.press('Control+Shift+Enter')
      await page.locator('dialog[open] input').waitFor()
      await page.keyboard.type('Reviewer')
      await page.keyboard.press('Enter')
      await page.locator('.session-terminal').nth(1).waitFor()
    }, { close: async () => { await builderRow.click(); await page.keyboard.press('Control+Shift+Enter'); await sleep(400) } })
    await screen('pane-plate-open', 'The plate pressed: Quick look open for Builder\'s folder', async () => {
      await builderRow.click()
      await page.locator(`${builderHeading} button.project-plate`).click()
      await page.locator('dialog.quick-look[open]').waitFor()
    }, { close: escape })
    await screen('workspace-menu', 'Workspace ⋯ (sidebar): every entry, the Marker group', openWorkspaceMenu,
      { region: '[role="menu"]', scroll: '[role="menu"]' })
    await screen('session-menu', 'Session ⋯ (sidebar row of Builder): every entry', async () => {
      await page.locator('button[aria-label="Actions for Builder"]').click()
      await page.locator('[role="menu"]').first().waitFor()
    }, { region: '[role="menu"]', scroll: '[role="menu"]' })
    await screen('pane-more-menu', 'Pane header › More (Builder): every entry', async () => {
      await builderRow.click()
      await page.locator('button[aria-label="More actions for Builder"]').click()
      await page.locator('[role="menu"]').first().waitFor()
    }, { region: '[role="menu"]', scroll: '[role="menu"]' })
    await screen('files-panel-builder', 'Pane header › Files of Builder: the published report', async () => {
      await builderRow.click()
      await page.locator(`.session-terminal[data-session-id="${builderId}"] button[aria-label="Files"]`).click()
      await page.locator('aside.files-panel').waitFor()
    }, { region: 'aside.files-panel', scroll: 'aside.files-panel', close: async () => { await page.locator('button[aria-label="Close files"]').click() } })
    await screen('files-panel-reviewer', 'Pane header › Files of Reviewer: nothing waits here for the owner (Story 75.5)', async () => {
      await reviewerRow.click()
      await page.locator(`.session-terminal[data-session-id="${reviewerId}"] button[aria-label="Files"]`).click()
      await page.locator('aside.files-panel').waitFor()
    }, { region: 'aside.files-panel', scroll: 'aside.files-panel', close: async () => { await page.locator('button[aria-label="Close files"]').click() } })
    await screen('request-card', 'Builder\'s request control: the request card its review request opened', async () => {
      await builderRow.click()
      const control = page.locator(`[data-session-requests="${builderId}"]`)
      await control.waitFor({ timeout: 5_000 })
      await control.click()
      await page.locator('.session-request-card').first().waitFor()
    }, { region: '.session-request-card', close: escape })
    const palette = async (text = '') => {
      await page.locator('button[aria-label="Command palette"]').click()
      await page.locator('#palette-results').waitFor()
      if (text) await page.keyboard.type(text)
    }
    // Story 75.10: the read-only views open from the palette, for the active workspace.
    await screen('review-results', 'Palette › Review results…: agent reports with evidence', async () => {
      await palette('Review results')
      await page.locator('#palette-review-results').click()
      await page.locator('dialog.workspace-results-dialog').waitFor()
    }, { region: 'dialog.workspace-results-dialog', scroll: 'dialog.workspace-results-dialog', close: escape })
    await screen('messages', 'Palette › Messages…: what Builder\'s shell tried to leave Reviewer', async () => {
      await palette('Messages')
      await page.locator('#palette-messages').click()
      await page.locator('dialog.session-messages-dialog').waitFor()
    }, { region: 'dialog.session-messages-dialog', scroll: 'dialog.session-messages-dialog', close: escape })
    await screen('palette', 'Command palette, nothing typed: every command and session entry, top to bottom', async () => { await palette() },
      { region: 'dialog[open]', scroll: '#palette-results', close: escape })
    await screen('new-session', 'Palette › New session…: the agent buttons, with Advanced', async () => {
      await palette('New session')
      await page.keyboard.press('Enter')
      const launcher = page.locator('.session-launcher')
      await launcher.waitFor()
      await launcher.locator('details.advanced > summary').click().catch(() => undefined)
    }, { region: '.session-launcher', scroll: '.session-launcher', close: async () => { await page.locator('button[aria-label="Close new session"]').click() } })

    // ---- Story 76.1/76.3/76.6: the Away check, the note, the palette rows and the summary ------------------------
    if (['away-note', 'head-away', 'palette-away', 'away-summary'].some(wanted)) {
      await screen('away-note', 'Palette › I\'m away…: the note mode with a note typed; Enter sets away', async () => {
        await palette('away')
        await page.locator('#palette-away').click()
        await page.locator('dialog[open] input').waitFor()
        await page.keyboard.type('back by 8, don\'t merge 76')
      }, { region: 'dialog[open]', close: async () => { await page.keyboard.press('Enter') } })
      const awayNow = await page.evaluate(() => window.aiTerminal.getAway())
      if (awayNow.state !== 'away') await setAway('away', 'back by 8, don\'t merge 76')
      // Three synthetic dev-auto runs in worktrees of the work folder: one blocked, one finished during this period, one
      // finished days before it (its handoff dated back), so the summary shows Stuck and Finished and leaves the old one out.
      const runGit = (...args) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-C', work, ...args], { stdio: 'ignore' })
      if (!existsSync(join(work, '.git'))) { runGit('init', '-q', '-b', 'main'); runGit('commit', '-q', '--allow-empty', '-m', 'synthetic') }
      for (const [folder, branch, project, status, decided, old] of [
        ['wt-blocked', 'feat/epic-9-recognise-and-hold', 'made-up-repo / Epic 9 (group companies). This run builds deploy group 1 only, shipped behind a switch that stays off.', 'BLOCKED — draft PR #110 open, CI red only on the scorecard check; waits on the owner\'s live check and merge', '[d1] park half of 9.5 until the owner reads it', false],
        ['wt-done', 'dev-auto/epic-76', 'Epic 76 Away mode and the summary (76.1–76.7). Synthetic brief text that the summary must not print as a title.', 'COMPLETE', '[d1] keep the summary read-only\n[d2] one row per run', false],
        ['wt-old', 'feat/epic-13-authoring-safety', 'Epic 13 (authoring safety). An old run that finished before he left.', 'COMPLETE', '', true]
      ]) {
        const checkout = join(work, folder)
        if (!existsSync(checkout)) runGit('worktree', 'add', '-q', '-b', branch, checkout)
        mkdirSync(join(checkout, '.dev-auto'), { recursive: true })
        writeFileSync(join(checkout, '.dev-auto/handoff.md'), `# Dev Auto handoff\n\n- Project / selected epics: ${project}\n- Owning checkout and branch: ${checkout} / ${branch}\n- Run id: synthetic-${folder}\n- Explicit user stop: none\n\n## Decisions and findings\n\n- Decided for you:${decided ? `\n${decided.split('\n').map((line) => `  - ${line}`).join('\n')}` : ''}\n\n## Resume\n\n- Next safe action: ${status.startsWith('BLOCKED') ? 'merge PR #110 after the owner\'s check' : 'none'}\n- Status: ${status}\n`)
        if (old) { const then = new Date(Date.now() - 3 * 86_400_000); utimesSync(join(checkout, '.dev-auto/handoff.md'), then, then) }
      }
      // A session that does what an agent does while he is away, under a node parent as an agent's own commands run
      // (BMN binds a hook's conversation only to a foreground process that is not a shell): its hook names its conversation, it publishes a file,
      // records two decisions (one with references BMN checks, one depending on it and on one not in the list),
      // reports an outcome and leaves a question as a card.
      const night = join(root, 'night.sh')
      writeFileSync(join(work, 'plan.md'), '# Synthetic plan\n')
      const nightLog = join(root, 'night.log')
      writeFileSync(night, `B() { if command -v bmn >/dev/null; then bmn "$@"; else '${process.execPath}' '${cli}' "$@"; fi; }
exec > >(tee '${nightLog}') 2>&1
cd '${work}'
printf '%s' '{"hook_event_name":"SessionStart","source":"startup","session_id":"6f1c2a4e-0b7d-4c3a-9e21-5a8b7c6d4e3f","transcript_path":"/tmp/synthetic.jsonl"}' | B hook claude > /dev/null
rev=$(B away --status --json | sed -n 's/.*"revision": *\\([0-9]*\\).*/\\1/p')
published=$(B publish plan.md --key night-publish)
id=$(printf '%s\\n' "$published" | sed -n 's/.* as \\([^ ]*\\).*/\\1/p')
B decision record --key filter-state --revision "$rev" --choice 'Keep the filter state in the URL, not in local storage' --reason 'The acceptance text names shareable links; storage would break them' --affects 'src/search.ts, search.test.ts' --reverse 'Revert the commit on dev-auto/epic-76; nothing else reads the URL yet' --ref "session:${reviewerId}" --ref "artifact:$id" --ref 'workflow:dev-auto/epic-76#d3'
B decision record --key cache-key --revision "$rev" --choice 'Key the result cache by the normalised query string' --reason 'Two spellings of one query should share a cache entry' --affects 'src/cache.ts' --reverse 'Return to the raw query as the key' --depends filter-state --depends router-shape
B decision outcome --key filter-state --op build --result done
B ask night-colour 'Which colour should the made-up badge be?' --kind question --body 'Gold or grey'
echo night-seeded
`)
      const nightSession = await startSession('Night', ['-ic', `'${process.execPath}' -e "require('node:child_process').execFileSync('bash', ['${night}'], { stdio: 'inherit' })"; exec bash -i`])
      if (nightSession.failed) note(`the Night session was not started: ${nightSession.failed}`)
      await sleep(6_000)
      try { note(`Night's shell said: ${readFileSync(nightLog, 'utf8').split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-10).join(' | ')}`) } catch { note('the Night shell left no output') }
      await screen('head-away', 'The window head while away: the checked box and "Away since …", its words a button', async () => {}, { region: '.app-header' })
      await screen('palette-away', 'Palette, "away" typed while away: I\'m back with since and source', async () => { await palette('away') }, { region: 'dialog[open]', close: escape })
      await screen('away-summary-so-far', 'The head\'s words pressed while away: While you are away, the summary so far', async () => {
        await page.locator('.away-check button.away-words').click()
        await summaryDialog.waitFor()
      }, { region: 'dialog.away-summary-dialog', scroll: 'dialog.away-summary-dialog', close: escape })
      await screen('away-summary', 'Palette › I\'m back: the summary opened by itself, the stuck run opened in place', async () => {
        await palette('back')
        await page.locator('#palette-away').click()
        await summaryDialog.waitFor()
        await summaryDialog.locator('section[aria-label="Stuck"] .message-row').first().click()
      }, { region: 'dialog.away-summary-dialog', scroll: 'dialog.away-summary-dialog', close: escape })
      const runsRead = await page.evaluate(() => window.aiTerminal.readDevAutoRuns()).catch((error) => ({ failed: String(error) }))
      note(`dev-auto runs read: ${runsRead.failed ?? `${runsRead.runs.length} runs (${runsRead.runs.map((run) => `${run.branch}: ${run.finished ? 'finished' : run.status}`).join(', ')}), ${runsRead.skipped} skipped: ${runsRead.issues.join(' | ')}`}`)
      await screen('palette-while-away', 'Palette, "while" typed after back: While you were away… with the period', async () => { await palette('while') }, { region: 'dialog[open]', close: escape })
      // A long night: more decisions and requests than the summary lists, so each list says what it cut.
      const long = join(root, 'long.sh')
      writeFileSync(long, `B() { if command -v bmn >/dev/null; then bmn "$@"; else '${process.execPath}' '${cli}' "$@"; fi; }
cd '${work}'
printf '%s' '{"hook_event_name":"SessionStart","source":"startup","session_id":"7a2d3b5f-1c8e-4d4b-8f32-6b9c8d7e5f40","transcript_path":"/tmp/synthetic-long.jsonl"}' | B hook claude > /dev/null
rev=$(B away --status --json | sed -n 's/.*"revision": *\\([0-9]*\\).*/\\1/p')
for n in $(seq 1 34); do B decision record --key "long-$n" --revision "$rev" --choice "Synthetic choice number $n for the long night" --reason 'A made-up reason' --affects 'src/long.ts' --reverse 'Revert it' > /dev/null; done
for n in $(seq 1 42); do B ask "long-ask-$n" "Synthetic question number $n" --kind question > /dev/null; done
echo long-seeded
`)
      if (wanted('away-summary-long')) {
        await setAway('away')
        const longSession = await startSession('Long night', ['-ic', `'${process.execPath}' -e "require('node:child_process').execFileSync('bash', ['${long}'], { stdio: 'inherit' })"; exec bash -i`])
        if (longSession.failed) note(`the Long night session was not started: ${longSession.failed}`)
        await sleep(20_000)
        await setAway('back')
      }
      await screen('away-summary-long', 'Back after a long night: each list cut with its count', async () => { await summaryDialog.waitFor() },
        { region: 'dialog.away-summary-dialog', scroll: 'dialog.away-summary-dialog', close: escape })
    }

    // ---- Preferences ------------------------------------------------------------------------------------------
    const dialog = page.locator('.preferences-dialog')
    const nav = dialog.locator('.preferences-nav')
    const main = dialog.locator('.preferences-page:not([hidden])')
    const openPreferences = async () => {
      if (await dialog.count()) return
      await page.locator('.preferences-button').click()
      await dialog.waitFor()
    }
    // Story 75.10: six pages in one list; Agents and Integrations show their views in the control under the page head.
    const go = async (label, view = null) => {
      await openPreferences()
      await nav.locator('.nav-item', { hasText: new RegExp(`^${label}`) }).first().click()
      if (view !== null) await main.locator('.page-views [role="radio"]', { hasText: new RegExp(`^${view}$`) }).click()
      await sleep(900)
    }
    const navigation = [
      ['general', 'General'],
      ['agents-team', 'Agents', 'Team'], ['agents-roles', 'Agents', 'Roles'], ['agents-models', 'Agents', 'Models'], ['agents-changes', 'Agents', 'Changes'], ['agents-asks', 'Agents', 'Asks'],
      ['integrations-health', 'Integrations', 'Health'], ['integrations-rules', 'Integrations', 'Rules'], ['integrations-skills', 'Integrations', 'Skills'], ['integrations-tools', 'Integrations', 'Tools'],
      ['notifications', 'Notifications'], ['voice', 'Voice'], ['data', 'Data']
    ]
    for (const [name, label, view = null] of navigation) {
      await screen(`preferences-${name}`, `Preferences › ${label}${view === null ? '' : ` › ${view}`}`, () => go(label, view),
        { region: '.preferences-dialog', scroll: '.preferences-dialog .preferences-main' })
    }
    await screen('preferences-agent', 'Preferences › Agents › Team › Opus: the agent page, Team still lit', async () => {
      await go('Agents', 'Team')
      await main.locator('.agent-card', { has: page.locator('.agent-open', { hasText: /^Opus$/ }) }).locator('.agent-open').click()
      await main.locator('.page-head').waitFor()
    }, { region: '.preferences-dialog', scroll: '.preferences-dialog .preferences-main' })
    await screen('preferences-new-agent', 'Preferences › Agents › Team › New agent', async () => {
      await go('Agents', 'Team')
      await main.getByRole('button', { name: 'New agent' }).click()
    }, { region: '.preferences-dialog', scroll: '.preferences-dialog .preferences-main' })
    // The narrow layout keeps the six pages in one row (Fable's notes ask for one look at 540).
    await screen('preferences-narrow', 'Preferences at 540 px wide: the six pages in one row, Agents › Team', async () => {
      await escape()
      await resize([540, 700])
      await sleep(400)
      await go('Agents', 'Team')
    }, { region: '.preferences-dialog', close: async () => { await escape(); await resize(SIZE); await sleep(400) } })
    await escape()
    // Last, since it adds a workspace: a workspace with no session shows the same plate beside New session.
    if (wanted('empty-plate')) await page.evaluate((cwd) => window.aiTerminal.createWorkspace({ name: 'Empty project', defaultCwd: cwd }), work)
    await screen('empty-plate', 'A workspace with no session: New session and the project plate', async () => {
      await page.locator('section.workspace-group[aria-label="Empty project"] .workspace-row button').first().click()
      await page.locator('.empty-state button.project-plate').waitFor()
    }, { region: '.empty-state' })
  } catch (error) {
    manifest.error = String(error?.stack ?? error)
    phase(`stopped: ${manifest.error}`)
    try {
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(outDirectory, 'failure.png'), Buffer.from(png, 'base64'))
    } catch { /* the window is gone */ }
  } finally {
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
    // Only what this run wrote is listed; a file of an earlier run in the same folder is named apart, never removed.
    manifest.files = [...new Set(written)].sort()
    manifest.notWrittenByThisRun = readdirSync(outDirectory).filter((file) => file.endsWith('.png') && !written.includes(file)).sort()
    writeFileSync(join(outDirectory, 'shots.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const taken = manifest.screens.filter((entry) => !entry.error)
    console.log(JSON.stringify({ lighterScreens: manifest.error ? 'STOPPED' : 'DONE', directory: outDirectory,
      screens: taken.length, notCaptured: manifest.screens.filter((entry) => entry.error).map((entry) => `${entry.screen}: ${entry.error}`),
      pngs: taken.reduce((sum, entry) => sum + entry.parts.reduce((count, part) => count + part.files.length, 0), 0) }))
  }
})
