/* global window, document, getComputedStyle, NodeFilter, innerWidth, innerHeight */
// MODULE: cursor-screens-visual.mjs - Epic 71.1: every BMN screen that names Cursor, captured in each colour mode on synthetic data
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end). The temporary home holds a
// synthetic team with all four apps (the unit-test roster plus a Cursor and an OpenCode agent), a synthetic rules
// master, two synthetic skills, BMN's Cursor hook file, and one Cursor chat folder. Stand-ins for claude, codex and
// cursor-agent sit on the PATH the home's shell settings add; nothing named opencode is installed. The cursor-agent
// stand-in reports through `bmn hook cursor` exactly as cursor-agent's hooks do (src/utility/test-fixtures/cursor), so
// BMN binds its chat, shows its notice and its prompt warning. No agent runs, nothing leaves the machine and no file
// of the owner's is read. The script asserts nothing about Cursor: it opens each screen, saves what the window shows in
// steel, brown, dark and black, and writes shots.json naming the Cursor words each capture held, so the same run after
// Cursor's removal makes the "after" set. Preferences pages are taken at 540x700, 1000x700 and 1280x900, the rest at the
// window's default 1000x700; a page taller than the window is taken in parts, top to bottom.
// Usage: node scripts/test/cursor-screens-visual.mjs [output folder]
//   default folder: <main checkout>/_bmad-output/planning-artifacts/reference-71-retire-cursor/before (or BMN_CURSOR_SHOTS)
//   BMN_CURSOR_SCREENS=guard-card,preferences-health  only screens whose name starts with one of these;
//   BMN_CURSOR_MODES=black  fewer modes. A narrowed run writes its own shots.json, so give it a folder of its own.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const git = (...args) => { try { return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
// The planning folder is ignored by git and lives in the main checkout only, not in a worktree.
const mainCheckout = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir') ?? join(repoRoot, '.git'))
const outDirectory = resolve(process.argv[2] ?? process.env.BMN_CURSOR_SHOTS ??
  join(mainCheckout, '_bmad-output/planning-artifacts/reference-71-retire-cursor/before'))
const COLOR_MODES = (process.env.BMN_CURSOR_MODES?.split(',') ?? ['steel', 'brown', 'dark', 'black']).filter(Boolean)
const ONLY = process.env.BMN_CURSOR_SCREENS?.split(',').filter(Boolean) ?? null
const DEFAULT_SIZE = [1000, 700]
const PREFERENCE_SIZES = [[540, 700], [1000, 700], [1280, 900]]
const PART_LIMIT = 10
const CHAT = 'c741bb07-352f-457b-8e7c-ee00517cd9ff'
const phase = (label) => console.error(`[BMN cursor screens] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const wanted = (screen) => ONLY === null || ONLY.some((prefix) => screen.startsWith(prefix))

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

/** The unit-test roster with one agent on each app it lacks; OpenCode's destination is the owner's word, as nothing here configures it. */
function roster() {
  const agent = (id, name, harness, model, provider) => `## ${id}

\`\`\`yaml
name: ${name}
class: pawn
harness: ${harness}
model: ${model}
provider: ${provider}
host: default
enabled: true
status: active
efforts: [medium]
roles: []
\`\`\`

`
  return readFileSync(join(fixtures, 'agents/roster-example.md'), 'utf8')
    .replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}')
    .replace('## roles\n', `${agent('composer', 'Composer', 'cursor', 'composer-2', 'cursor')}${agent('kimi', 'Kimi', 'opencode', 'opencode-go/kimi-k3', 'opencode-go')}## roles\n`)
}

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  mkdirSync(outDirectory, { recursive: true })
  const home = join(root, 'home')
  const work = join(root, 'work')
  const stubs = join(root, 'stubs')
  const events = join(root, 'cursor-events')
  const quit = join(root, 'quit-stand-ins')
  const agentsDir = join(home, '.config/bmn/agents')
  for (const folder of [agentsDir, join(agentsDir, 'state'), work, stubs, events]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  // BMN's own context testing stays off, so nothing starts a test behind a screen.
  writeFileSync(join(agentsDir, 'state/context-auto.json'), '{"version":1,"enabled":false,"told":{}}\n')
  writeFileSync(join(agentsDir, 'roster.md'), roster())
  writeFileSync(join(agentsDir, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  // Claude's rules file is a link to a file kept elsewhere; Codex's is hand-written; OpenCode and Cursor have none.
  mkdirSync(join(home, 'dotfiles'))
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, 'dotfiles/CLAUDE.md'), '# hand-kept rules\n')
  symlinkSync(join(home, 'dotfiles/CLAUDE.md'), join(home, '.claude/CLAUDE.md'))
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/AGENTS.md'), '# written by hand\n')
  for (const [name, description] of [['evidence-first', 'Check a claim against the files before saying it.'], ['small-steps', 'Change one thing, then check it.']]) {
    mkdirSync(join(home, '.claude/skills', name), { recursive: true })
    writeFileSync(join(home, '.claude/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSynthetic skill text.\n`)
  }
  // Cursor keeps a chat at ~/.cursor/chats/<md5 of its workspace>/<chat id>/; Resume and History look there.
  mkdirSync(join(home, '.cursor/chats', createHash('md5').update(work).digest('hex'), CHAT), { recursive: true })
  const hookFile = join(home, '.cursor/hooks.json')
  try {
    execFileSync(process.execPath, [cli, 'hooks', 'install', 'cursor', '--file', hookFile, '--yes'],
      { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: 'ignore' })
  } catch { phase('bmn hooks install cursor refused; Local control shows the file as it is') }
  // One tool in Cursor's own tools file, as Health and Tools read it; no value is held.
  writeFileSync(join(home, '.cursor/mcp.json'), `${JSON.stringify({ mcpServers: { 'docs-search': { command: 'docs-search', args: ['--stdio'] } } }, null, 2)}\n`)

  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  stub('claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; *) echo "synthetic claude"; cat > /dev/null;; esac')
  stub('codex', 'case "$1" in --version) echo "codex-cli 0.162.1";; *) echo "synthetic codex";; esac')
  // cursor-agent's own hook events, from the measured fixtures, naming this chat and the work folder.
  for (const event of ['sessionStart', 'beforeSubmitPrompt', 'stop']) {
    const payload = JSON.parse(readFileSync(join(fixtures, `cursor/${event}.json`), 'utf8'))
    writeFileSync(join(events, `${event}.json`), JSON.stringify({ ...payload, conversation_id: CHAT, session_id: CHAT,
      workspace_roots: [work], user_email: 'owner@example.test', transcript_path: null,
      ...(event === 'beforeSubmitPrompt' ? { prompt: 'synthetic prompt' } : {}) }))
  }
  // The hook line BMN installs for Cursor, falling back to this checkout's CLI when the session's PATH has no bmn.
  const hook = (event) => `if command -v bmn >/dev/null; then bmn hook cursor < '${join(events, `${event}.json`)}' >/dev/null 2>&1; ` +
    `else '${process.execPath}' '${cli}' hook cursor < '${join(events, `${event}.json`)}' >/dev/null 2>&1; fi`
  // Outside a BMN session (a version read, a test BMN might start) it does nothing and says so.
  stub('cursor-agent', `case "$1" in --version|-v) echo "2026.09.26-dd393fe"; exit 0;; esac
[ -n "$BMN_CONTROL_SOCKET" ] || { echo "synthetic stand-in: nothing to do outside a BMN session"; exit 0; }
echo "synthetic agent stand-in: nothing is sent anywhere"
${hook('sessionStart')}
sleep 1
echo "> synthetic prompt"
${hook('beforeSubmitPrompt')}
sleep 1
echo "synthetic reply: done"
${hook('stop')}
while :; do [ -e '${quit}' ] && exit 0; sleep 0.2; done`)

  const application = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...process.env,
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
    generatedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), worktree: repoRoot, colorModes: COLOR_MODES,
    defaultSize: DEFAULT_SIZE, preferenceSizes: PREFERENCE_SIZES, setup: [], scan: [], screens: []
  }
  const note = (line) => { manifest.setup.push(line); phase(line) }
  let page
  const written = []
  try {
    page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.waitForSelector('.session-row')
    // A background test window may never paint without being shown.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    const resize = async ([width, height]) => {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
      await sleep(350)
    }
    await resize(DEFAULT_SIZE)

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
    /** Every visible text, field value and accessible name in the window that names Cursor, as shown. */
    const cursorWords = (region) => page.evaluate((region) => {
      const pattern = /cursor/i
      const found = new Set()
      // A long text is kept around its first mention, so the words that name Cursor are the ones listed.
      const around = (text) => {
        const flat = text.replace(/\s+/g, ' ').trim()
        if (flat.length <= 200) return flat
        const at = Math.max(0, flat.search(pattern) - 90)
        return `${at > 0 ? '…' : ''}${flat.slice(at, at + 200)}…`
      }
      const roots = region === null ? [document.body] : [...document.querySelectorAll(region)]
      const visible = (element) => {
        const box = element.getBoundingClientRect()
        if (box.width === 0 || box.height === 0 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return false
        if (getComputedStyle(element).visibility === 'hidden') return false
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue
          const clip = parent.getBoundingClientRect()
          if (box.bottom <= clip.top || box.top >= clip.bottom || box.right <= clip.left || box.left >= clip.right) return false
        }
        return true
      }
      // A text is listed with the element that holds it, so "Cursor" on a card reads as the card's line.
      for (const scope of roots) {
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const element = node.parentElement
          if (element === null || !pattern.test(node.textContent) || element.closest('script, style')) continue
          if (visible(element)) found.add(around(element.textContent))
        }
      }
      for (const element of roots.flatMap((scope) => [scope, ...scope.querySelectorAll('input, textarea, [aria-label], [title]')])) {
        if (!element.matches('input, textarea, [aria-label], [title]')) continue
        if (!visible(element)) continue
        if ('value' in element && typeof element.value === 'string' && pattern.test(element.value)) found.add(`[value] ${around(element.value)}`)
        for (const name of ['aria-label', 'title']) {
          const value = element.getAttribute(name)
          if (value && pattern.test(value)) found.add(`[${name}] ${around(value)}`)
        }
      }
      return [...found].slice(0, 60)
    }, region)
    /** Marks the element that scrolls `selector`'s content and says how many window-high parts it has. */
    const partsOf = (selector) => page.evaluate(({ selector, limit }) => {
      for (const element of document.querySelectorAll('[data-cursor-shots-scroll]')) element.removeAttribute('data-cursor-shots-scroll')
      const root = selector === null ? null : document.querySelector(selector)
      if (root === null) return { count: 1, step: 0 }
      const scrolls = (element) => element.scrollHeight > element.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(element).overflowY)
      let box = scrolls(root) ? root : [...root.querySelectorAll('*')].find(scrolls) ?? null
      for (let parent = root.parentElement; box === null && parent; parent = parent.parentElement) if (scrolls(parent)) box = parent
      if (box === null) return { count: 1, step: 0 }
      box.setAttribute('data-cursor-shots-scroll', '')
      box.scrollTop = 0
      const step = Math.max(120, box.clientHeight - 48)
      return { count: Math.min(limit, Math.ceil((box.scrollHeight - box.clientHeight) / step) + 1), step }
    }, { selector, limit: PART_LIMIT })
    const scrollPart = (index, step) => page.evaluate(([index, step]) => {
      const box = document.querySelector('[data-cursor-shots-scroll]')
      if (box) box.scrollTop = index * step
    }, [index, step])

    /**
     * Opens one screen and saves it in every colour mode, in parts when `scroll` names a region taller than the
     * window. A screen that cannot be opened is recorded with the reason, and the run goes on.
     */
    const screen = async (name, how, open, { scroll = null, close = null, size = DEFAULT_SIZE, region = null } = {}) => {
      if (!wanted(name)) return
      const entry = { screen: name, how, size: `${size[0]}x${size[1]}`, wordsFrom: region ?? 'the whole window', parts: [] }
      manifest.screens.push(entry)
      try {
        await open()
        await sleep(400)
        const { count, step } = await partsOf(scroll)
        for (let index = 0; index < count; index += 1) {
          await scrollPart(index, step)
          await sleep(150)
          const part = { files: [], cursorWords: await cursorWords(region) }
          for (const colorMode of COLOR_MODES) {
            await setColorMode(colorMode)
            const file = `${name}${count > 1 ? `-part${index + 1}` : ''}-${colorMode}.png`
            await capture(file)
            part.files.push(file)
          }
          entry.parts.push(part)
        }
        phase(`${name}: ${entry.parts.length} part(s), ${entry.parts.reduce((sum, part) => sum + part.cursorWords.length, 0)} Cursor words`)
      } catch (error) {
        entry.error = String(error?.message ?? error).split('\n')[0]
        phase(`${name}: NOT CAPTURED: ${entry.error}`)
        try { await capture(`${name}-failure.png`); entry.failureShot = `${name}-failure.png` } catch { /* the window is gone */ }
        // A part taken before the failure stays listed with the screen.
      }
      if (close) await close().catch(() => undefined)
    }

    // ---- Preferences helpers (the same locators as agents-rules-visual.mjs) -------------------------------------
    const dialog = page.locator('.preferences-dialog')
    const nav = dialog.locator('.preferences-nav')
    const main = dialog.locator('.preferences-page:not([hidden])')
    const ledger = dialog.locator('.ledger')
    const openPreferences = async () => {
      if (await dialog.count()) return
      await page.locator('.preferences-button').click()
      await dialog.waitFor()
    }
    const closePreferences = async () => {
      if (await dialog.count() === 0) return
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
    }
    const go = async (parent, sub) => {
      await openPreferences()
      await nav.locator(parent === null ? '.nav-group .nav-item' : '.nav-parent > .nav-item', { hasText: new RegExp(`^${parent ?? sub}`) }).first().click()
      if (parent !== null && sub) await nav.locator('.nav-sub .nav-item', { hasText: new RegExp(`^${sub}$`) }).click()
      await sleep(250)
    }
    const card = (name) => main.locator('.agent-card', { has: page.locator('.agent-open', { hasText: new RegExp(`^${name}$`) }) })
    const pickIfOffered = async (locator) => { if (await locator.count()) await locator.first().click() }

    phase('the first approval of the synthetic team, so Health, the guard and the agent pages read an approved team')
    try {
      await go('Team')
      await card('Sonnet').getByRole('button', { name: 'Activate' }).click()
      const approve = ledger.getByRole('button', { name: 'Approve', exact: true })
      await approve.waitFor()
      await approve.click()
      await ledger.locator('.ledger-sheet[role="group"]').getByRole('button', { name: 'Approve', exact: true }).click()
      await dialog.locator('.toast, .preferences-main [role="status"]').filter({ hasText: /^Approved · version 1/ }).first().waitFor()
      note('team approved as version 1 (Sonnet activated to make the first change)')
    } catch (error) {
      note(`team not approved: ${String(error?.message ?? error).split('\n')[0]}`)
    }
    await closePreferences()

    phase('workspace data: a launch set and a template that name Cursor, turn changes on, then a Cursor session')
    const workspace = await page.evaluate(async () => (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt))
    const inShell = (command) => ['-ic', `${command}; exec bash -i`]
    try {
      await page.evaluate(async ({ workspaceId, entries }) => window.aiTerminal.createLaunchSet({ workspaceId, name: 'Review trio', entries }), {
        workspaceId: workspace.workspaceId,
        entries: [['Claude', 'claude'], ['Codex', 'codex'], ['Cursor', 'cursor-agent']].map(([name, command]) => ({
          entryId: randomUUID(), name, executable: '/bin/bash', argv: inShell(command), backgroundChoice: null, terminalGraphics: null
        }))
      })
      note('launch set "Review trio" saved with Claude, Codex and Cursor entries')
    } catch (error) { note(`launch set not saved: ${String(error?.message ?? error).split('\n')[0]}`) }
    try {
      await page.evaluate(async ({ cwd, argv }) => window.aiTerminal.createTemplate({ name: 'Cursor review', executable: '/bin/bash', argv, cwd }),
        { cwd: work, argv: inShell('cursor-agent --model gpt-5') })
      note('template "Cursor review" saved')
    } catch (error) { note(`template not saved: ${String(error?.message ?? error).split('\n')[0]}`) }
    try {
      await page.evaluate(async (workspace) => window.aiTerminal.updateWorkspace({ workspaceId: workspace.workspaceId, expectedRevision: workspace.revision, turnChanges: true }), workspace)
      note('turn changes switched on for the workspace')
    } catch (error) { note(`turn changes not switched on: ${String(error?.message ?? error).split('\n')[0]}`) }
    const cursorSession = await page.evaluate(async ({ workspaceId, cwd, executable }) => (await window.aiTerminal.createSession({
      workspaceId, name: 'Refactor', cwd, executable, argv: ['--model', 'gpt-5', '--sandbox', 'enabled'], cols: 100, rows: 24, backgroundChoice: 'stop'
    })).session, { workspaceId: workspace.workspaceId, cwd: work, executable: join(stubs, 'cursor-agent') })
    note(`Cursor session "Refactor" started: ${join(stubs, 'cursor-agent')} --model gpt-5 --sandbox enabled in ${work}`)
    await page.reload()
    // The reload rebuilds the live pane's view, and BMN says so once; that notice is the reload's, not a screen's.
    await page.locator('button[aria-label="Dismiss notice"]').click({ timeout: 5_000 }).catch(() => undefined)
    const row = page.locator(`.session-row > button[data-session-id="${cursorSession.sessionId}"]`)
    await row.waitFor()
    await row.click()
    const binding = await (async () => {
      const end = Date.now() + 20_000
      for (;;) {
        const value = await page.evaluate((id) => window.aiTerminal.getConversationBinding(id), cursorSession.sessionId).catch(() => null)
        if (value?.status === 'bound' || Date.now() > end) return value
        await sleep(250)
      }
    })()
    note(`Cursor binding: ${binding?.status ?? 'unknown'}${binding?.status === 'bound' ? ` (${binding.agentCli} ${binding.conversationReference})` : ''}`)
    await sleep(2_500)

    // ---- main window screens, at the default size ------------------------------------------------------------
    await resize(DEFAULT_SIZE)
    const guardCard = page.locator('.session-guard-card')
    await screen('guard-card', 'The Cursor session\'s prompt warning: the card BMN opens when cursor-agent\'s beforeSubmitPrompt hook reports a prompt bound for a public-only provider (opens by itself; else from the session\'s guard mark)', async () => {
      if (!await guardCard.isVisible()) {
        const mark = page.locator('[data-session-guard]').first()
        await mark.waitFor({ timeout: 5_000 })
        await mark.click()
      }
      await guardCard.waitFor()
    }, { region: '.session-guard-card', close: async () => {
      await guardCard.focus().catch(() => undefined)
      await page.keyboard.press('Escape')
      await guardCard.waitFor({ state: 'detached', timeout: 3_000 }).catch(() => undefined)
    } })
    if (await guardCard.isVisible()) await page.locator('button[aria-label="Close guard"], .session-guard-card header button').first().click().catch(() => undefined)

    await screen('session-window', 'Main window with the Cursor session selected: the sidebar row and the pane header carry the app\'s chip', async () => {
      await row.click()
    })
    await screen('needs-you-notice', 'The Cursor session\'s requests card (the session\'s request control): the notice cursor-agent\'s stop hook opened', async () => {
      const control = page.locator(`[data-session-requests="${cursorSession.sessionId}"]`)
      await control.waitFor({ timeout: 5_000 })
      await control.click()
      await page.locator('.session-request-card').first().waitFor()
    }, { region: '.session-request-card', close: async () => { await page.keyboard.press('Escape') } })
    const palette = async (text) => {
      await page.locator('button[aria-label="Command palette"]').click()
      await page.keyboard.type(text)
    }
    const openDetails = async () => {
      await row.click()
      if (!await page.locator('.session-inspector').isVisible()) {
        await palette('Session details')
        await page.keyboard.press('Enter')
      }
      await page.locator('.session-inspector').waitFor()
      await sleep(1_500)
    }
    await screen('session-details', 'Session details of the running Cursor session (palette › Session details): Harness, Plan use and Conversation', openDetails,
      { scroll: '.session-inspector', region: '.session-inspector', close: async () => { await page.locator('button[aria-label="Close session details"]').click() } })
    await screen('palette-sessions', 'Command palette, typed "Cursor": the session entries carry "workspace · Cursor · folder"', async () => {
      await palette('Cursor')
    }, { region: 'dialog[open]', close: async () => { await page.keyboard.press('Escape') } })
    await screen('plan-use-dialog', 'Palette › Plan use…: the line naming the apps that report no plan use', async () => {
      await palette('Plan use')
      await page.keyboard.press('Enter')
      await page.locator('dialog.plan-use-dialog').waitFor()
    }, { region: 'dialog.plan-use-dialog', close: async () => { await page.keyboard.press('Escape') } })
    const launcher = page.locator('.session-launcher')
    const openLauncher = async () => {
      if (!await launcher.isVisible()) {
        await palette('New session')
        await page.keyboard.press('Enter')
      }
      await launcher.waitFor()
    }
    await screen('new-session', 'Palette › New session…: the agent picker lists every app and the saved template', openLauncher, { region: '.session-launcher' })
    await screen('new-session-cursor-picked', 'New session with Cursor picked: the name and the command it fills in (Advanced shows the command)', async () => {
      await openLauncher()
      await pickIfOffered(launcher.getByRole('radio', { name: /^Cursor\b/ }))
      await launcher.locator('details.advanced > summary').click()
    }, { scroll: '.session-launcher', region: '.session-launcher', close: async () => { await page.locator('button[aria-label="Close new session"]').click() } })
    const launchSets = page.locator('dialog.launch-sets-dialog')
    await screen('launch-set-saved', 'Palette › Save a launch set…: the saved set with its Cursor entry', async () => {
      await palette('Save a launch set')
      await page.keyboard.press('Enter')
      await launchSets.locator('ol li').first().waitFor()
    }, { region: 'dialog.launch-sets-dialog' })
    await screen('launch-set-launch', 'The same set, Launch set…: the preview before starting its entries', async () => {
      if (!await launchSets.isVisible()) {
        await palette('Save a launch set')
        await page.keyboard.press('Enter')
      }
      await launchSets.getByRole('button', { name: 'Launch set…' }).click()
      await launchSets.locator('h3').waitFor()
    }, { region: 'dialog.launch-sets-dialog', close: async () => { await page.keyboard.press('Escape') } })
    await screen('workspace-messages', 'Workspace menu › Messages…: who gets a waiting message by its own hook and who only by Paste', async () => {
      await page.locator(`button[aria-label="Actions for ${workspace.name}"]`).click()
      await page.getByRole('menuitem', { name: /^Messages/ }).click()
      await page.locator('dialog.session-messages-dialog').waitFor()
    }, { region: 'dialog.session-messages-dialog', close: async () => { await page.keyboard.press('Escape') } })
    await screen('turn-changes', 'Session menu › Turn changes… of the Cursor session, with turn changes on for the workspace', async () => {
      await page.locator('button[aria-label="Actions for Refactor"]').click()
      const entry = page.getByRole('menuitem', { name: /^Turn changes/ })
      if (await entry.isDisabled()) {
        await page.keyboard.press('Escape')
        throw new Error('Turn changes… is disabled: BMN recorded nothing for the Cursor session')
      }
      await entry.click()
      await page.locator('dialog[aria-label^="Turn changes"], dialog.turn-changes-dialog').first().waitFor()
    }, { region: 'dialog[open]', close: async () => { await page.keyboard.press('Escape') } })
    await screen('split-picker', 'Palette › Split view… with the plain shell selected: the picker lists the Cursor session with its app', async () => {
      await page.locator('.session-row > button[data-session-id]').filter({ hasNotText: 'Refactor' }).first().click()
      await palette('Split view')
      await page.keyboard.press('Enter')
      await page.locator('dialog[open]').filter({ hasText: 'Refactor' }).waitFor()
    }, { region: 'dialog[open]', close: async () => { await page.keyboard.press('Escape'); await row.click() } })

    // ---- Preferences, at the narrowest, the default and the widest size ---------------------------------------
    phase('scan: which Preferences pages name Cursor at the default size')
    try {
      await go('Team')
      const pages = await nav.locator('.nav-parent > .nav-item, .nav-group .nav-item, .nav-sub .nav-item').allTextContents()
      for (const label of pages.map((item) => item.trim())) {
        const parent = ['Team', 'Rules'].includes(label) ? label : null
        const sub = await nav.locator('.nav-sub .nav-item', { hasText: new RegExp(`^${label}$`) }).count() ? label : null
        if (sub !== null) await nav.locator('.nav-sub .nav-item', { hasText: new RegExp(`^${label}$`) }).click()
        else await go(parent, parent === null ? label : undefined)
        await sleep(600)
        const words = await page.evaluate(() => [...new Set((document.querySelector('.preferences-page:not([hidden])')?.innerText ?? '')
          .split('\n').filter((line) => /cursor/i.test(line)).map((line) => line.trim().slice(0, 200)))])
        manifest.scan.push({ page: label, cursorLines: words })
        if (parent !== null) await go(parent)
      }
    } catch (error) { note(`scan stopped: ${String(error?.message ?? error).split('\n')[0]}`) }
    await closePreferences()

    let skillsChecked = false
    let toolsChecked = false
    const preferencePages = [
      ['preferences-team', 'Preferences › Team: the agent cards, each with its app', () => go('Team')],
      ['preferences-agent-cursor', 'Preferences › Team › Composer (the Cursor agent): Agent app and the rows it decides', async () => {
        await go('Team')
        await card('Composer').locator('.agent-open').click()
        await main.locator('.page-head').waitFor()
      }],
      ['preferences-new-agent', 'Preferences › Team › New agent, with Cursor picked as the agent app', async () => {
        await go('Team')
        await main.getByRole('button', { name: 'New agent' }).click()
        await pickIfOffered(main.getByRole('radio', { name: 'Cursor', exact: true }))
      }],
      ['preferences-new-agent-model-names', 'Preferences › Team › New agent with Cursor picked, the Model field\'s list of the team\'s names open (one view, scrolled to the field)', async () => {
        await go('Team')
        await main.getByRole('button', { name: 'New agent' }).click()
        await pickIfOffered(main.getByRole('radio', { name: 'Cursor', exact: true }))
        await main.getByRole('combobox', { name: 'Model', exact: true }).click()
        await main.getByRole('listbox', { name: 'Model suggestions' }).waitFor()
        await main.getByRole('listbox', { name: 'Model suggestions' }).scrollIntoViewIfNeeded()
      }, async () => { await page.keyboard.press('Escape') }, true],
      ['preferences-models', 'Preferences › Team › Models: the team\'s models, each with its agent and app', async () => {
        await go('Team', 'Models')
        await sleep(1_000)
      }],
      ['preferences-rules', 'Preferences › Rules › Editor, "What each app reads" with Cursor picked', async () => {
        await go('Rules')
        await pickIfOffered(main.getByRole('radio', { name: 'Cursor', exact: true }))
      }],
      ['preferences-rules-install', 'Preferences › Rules › Install…: the sheet listing each app the rules go to (cancelled, nothing installed)', async () => {
        await go('Rules')
        await main.getByRole('button', { name: 'Install…' }).click()
        await main.locator('.target').first().waitFor()
      }, async () => { await pickIfOffered(main.getByRole('button', { name: 'Cancel', exact: true })) }],
      ['preferences-skills', 'Preferences › Rules › Skills after Check now: each skill with a state per app', async () => {
        await go('Rules', 'Skills')
        if (!skillsChecked) {
          skillsChecked = true
          await pickIfOffered(main.getByRole('button', { name: 'Check now' }))
          await sleep(2_000)
        }
      }],
      ['preferences-tools', 'Preferences › Rules › Tools after Check now, with Add tool open (the apps a tool reaches)', async () => {
        await go('Rules', 'Tools')
        if (!toolsChecked) {
          toolsChecked = true
          await pickIfOffered(main.getByRole('button', { name: 'Check now' }))
          await sleep(2_000)
        }
        if (await main.locator('.tool-editor').count() === 0) await pickIfOffered(main.getByRole('button', { name: 'Add tool', exact: true }))
        // "Some apps" shows the app each tool may reach.
        await pickIfOffered(main.getByRole('radio', { name: 'Some apps', exact: true }))
      }],
      ['preferences-health', 'Preferences › Rules › Health: rules files, agent apps, skills, tools and context limits per app', async () => {
        await go('Rules', 'Health')
        await sleep(1_500)
      }],
      ['preferences-health-cursor-destination', 'Preferences › Rules › Health › Set destination… on the Cursor row (one view, scrolled to the sheet; cancelled)', async () => {
        await go('Rules', 'Health')
        await main.getByRole('button', { name: 'Set the destination of Cursor' }).click()
        await main.locator('.sheet').first().waitFor()
        await main.locator('.sheet').first().scrollIntoViewIfNeeded()
      }, async () => { await pickIfOffered(main.locator('.sheet').getByRole('button', { name: 'Cancel' })) }, true],
      ['preferences-health-cursor-update', 'Preferences › Rules › Health › Update… on the Cursor row: the program and the app\'s own update command (one view; closed, nothing run)', async () => {
        await go('Rules', 'Health')
        await main.getByRole('button', { name: 'Update Cursor' }).click()
        await main.getByRole('group', { name: 'Update Cursor' }).waitFor()
        await main.getByRole('group', { name: 'Update Cursor' }).scrollIntoViewIfNeeded()
      }, async () => { await pickIfOffered(main.getByRole('group', { name: 'Update Cursor' }).getByRole('button', { name: 'Close' })) }, true],
      ['preferences-local-control', 'Preferences › Local control › Check configured hooks: the report per app', async () => {
        await go(null, 'Local control')
        // The report lives as long as the page; each visit asks for it again.
        if (await main.locator('.hook-check-report').count() === 0) await main.getByRole('button', { name: /Check configured hooks/ }).click()
        await main.locator('.hook-check-report').waitFor()
      }],
      ['preferences-history', 'Preferences › History: the row for each agent\'s own history', async () => {
        await go(null, 'History')
        await sleep(1_500)
      }]
    ]
    for (const size of PREFERENCE_SIZES) {
      await resize(size)
      for (const [name, how, open, close, single = false] of preferencePages) {
        await screen(`${name}-${size[0]}`, how, open, { scroll: single ? null : '.preferences-dialog .preferences-main', region: '.preferences-dialog', size, close })
      }
      await closePreferences()
    }

    // ---- Resume, once the Cursor session has stopped -----------------------------------------------------------
    await resize(DEFAULT_SIZE)
    writeFileSync(quit, '')
    await page.evaluate((id) => window.aiTerminal.stopSession(id), cursorSession.sessionId).catch(() => undefined)
    await sleep(1_500)
    const resumeDialog = page.locator('dialog.app-dialog')
    await screen('session-details-stopped', 'Session details of the stopped Cursor session: Resume offered from the bound chat', openDetails, { scroll: '.session-inspector', region: '.session-inspector' })
    await screen('resume-dialog', 'Session details › Resume on the stopped Cursor session: the confirmation with the command and what it leaves out', async () => {
      await openDetails()
      await page.locator('.session-inspector .actions button', { hasText: /^Resume$/ }).click()
      await resumeDialog.waitFor()
    }, { region: 'dialog.app-dialog', close: async () => { await resumeDialog.getByRole('button', { name: 'Cancel' }).click() } })
    await screen('session-window-stopped', 'Main window with the Cursor session stopped: the pane keeps its output, and its row and header keep the app chip', async () => {
      if (await page.locator('.session-inspector').isVisible()) await page.locator('button[aria-label="Close session details"]').click()
      await row.click()
    })
  } catch (error) {
    manifest.error = String(error?.stack ?? error)
    phase(`stopped: ${manifest.error}`)
    try {
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(outDirectory, 'failure.png'), Buffer.from(png, 'base64'))
    } catch { /* the window is gone */ }
  } finally {
    writeFileSync(quit, '')
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
    // Only what this run wrote is listed; a file of an earlier run in the same folder is named apart, never removed.
    manifest.files = [...new Set(written)].sort()
    manifest.notWrittenByThisRun = readdirSync(outDirectory).filter((file) => file.endsWith('.png') && !written.includes(file)).sort()
    writeFileSync(join(outDirectory, 'shots.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const taken = manifest.screens.filter((entry) => !entry.error)
    console.log(JSON.stringify({ cursorScreens: manifest.error ? 'STOPPED' : 'DONE', directory: outDirectory,
      screens: taken.length, notCaptured: manifest.screens.filter((entry) => entry.error).map((entry) => `${entry.screen}: ${entry.error}`),
      pngs: taken.reduce((sum, entry) => sum + entry.parts.reduce((count, part) => count + part.files.length, 0), 0) }))
  }
})
