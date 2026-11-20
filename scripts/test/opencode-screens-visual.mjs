/* global window, document, getComputedStyle, NodeFilter, innerWidth, innerHeight */
// MODULE: opencode-screens-visual.mjs - Epic 123 (123.2 AC1): every BMN screen that named OpenCode, captured in each colour mode on synthetic data
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end). The temporary home holds a
// synthetic team file written while OpenCode was supported: the unit-test roster as it stood at the git tag
// opencode-support-final, plus Luna (Go), a helper on OpenCode, and the judge Jev. Stand-ins for claude, codex and
// opencode sit on the PATH the home's shell settings add; the opencode stand-in answers `--version`, exports no
// sign-in, and inside a BMN session opens one notice through `bmn ask`. While BMN is closed, what an OpenCode session
// left is written into its saved state (seedOldRecords: the conversation its plugin bound, the notice marked as
// opened by its hook), and BMN is started again on it. No agent runs, nothing leaves the machine and no file of the
// owner's is read. The script asserts nothing: it opens each screen, saves what the window shows in steel, brown, dark
// and black at the narrowest and the widest window, and writes shots.json naming the OpenCode words each capture held.
// The same script makes both sets: BMN_OPENCODE_APP=<a checkout of the tag>/apps/desktop (built) makes "before", the
// default (this checkout, built) makes "after". A screen a build no longer has is listed with the reason.
// Usage: node scripts/test/opencode-screens-visual.mjs <output folder>
//   BMN_OPENCODE_APP=<apps/desktop of another built checkout>  the screens of that build ("before")
//   BMN_OPENCODE_SCREENS=team,health  only screens whose name starts with one of these
//   BMN_OPENCODE_MODES=black  fewer modes. A narrowed run writes its own shots.json, so give it a folder of its own.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { judgeProposal, parseRoster, rewriteRoster } from '../../apps/desktop/bin/agents-roster.mjs'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = process.env.BMN_OPENCODE_APP ? resolve(process.env.BMN_OPENCODE_APP) : join(repoRoot, 'apps/desktop')
const cli = join(appDirectory, 'bin/bmn')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const git = (cwd, ...args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
if (!process.argv[2]) throw new Error('usage: node scripts/test/opencode-screens-visual.mjs <output folder>')
const outDirectory = resolve(process.argv[2])
const COLOR_MODES = (process.env.BMN_OPENCODE_MODES?.split(',') ?? ['steel', 'brown', 'dark', 'black']).filter(Boolean)
const ONLY = process.env.BMN_OPENCODE_SCREENS?.split(',').filter(Boolean) ?? null
// The narrowest and the widest window the story asks for (123.2 AC1).
const SIZES = [[540, 700], [1280, 900]]
const PART_LIMIT = 10
const CHAT = 'ses_0123456789abSyntheticOnly1'
const WORDS = /open ?code|luna \(go\)|luna-go/i
const phase = (label) => console.error(`[BMN opencode screens] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const wanted = (screen) => ONLY === null || ONLY.some((prefix) => screen.startsWith(prefix))

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay

// As his master held one before the retirement: a section only OpenCode read (123.3 deletes his after the update).
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

<!-- bmn:apps opencode -->
A rule only OpenCode read.
<!-- /bmn:apps -->
`

/** The team file as it stood before the retirement: the tag's unit-test roster, Luna (Go) on OpenCode, and the judge. */
function roster() {
  const example = execFileSync('git', ['-C', repoRoot, 'show', 'opencode-support-final:apps/desktop/src/utility/test-fixtures/agents/roster-example.md'], { encoding: 'utf8' })
  const luna = `## luna-go

\`\`\`yaml
name: Luna (Go)
class: pawn
harness: opencode
model: kimi-k2
provider: opencode-go
host: default
enabled: true
status: active
efforts: [max]
roles: [helper]
\`\`\`

## sonnet
`
  const text = example.replace('## sonnet\n', luna)
    .replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}')
    .replace('helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna@max], then: lead}', 'helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna-go@max, luna@max], then: lead}')
  const parsed = parseRoster(text)
  if (parsed.errors.length > 0) throw new Error(`the synthetic team file does not load: ${JSON.stringify(parsed.errors)}`)
  return rewriteRoster(text, judgeProposal(parsed.data))
}

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  mkdirSync(outDirectory, { recursive: true })
  const home = join(root, 'home')
  const work = join(root, 'work')
  const stubs = join(root, 'stubs')
  const quit = join(root, 'quit-stand-ins')
  const agentsDir = join(home, '.config/bmn/agents')
  for (const folder of [agentsDir, join(agentsDir, 'state'), work, stubs, join(roots.config, 'opencode')]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(join(agentsDir, 'roster.md'), roster())
  writeFileSync(join(agentsDir, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  // Claude's rules file is a link to a file kept elsewhere; Codex's is hand-written; OpenCode has none.
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
  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  stub('claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; *) echo "synthetic claude"; cat > /dev/null;; esac')
  stub('codex', 'case "$1" in --version) echo "codex-cli 0.162.1";; *) echo "synthetic codex";; esac')
  const ask = `bmn ask stop 'OpenCode finished its turn' --kind notice >/dev/null 2>&1`
  stub('opencode', `case "$1" in --version|-v) echo "2.0.29"; exit 0;; auth) echo "[]"; exit 0;; esac
[ -n "$BMN_CONTROL_SOCKET" ] || { echo "synthetic stand-in: nothing to do outside a BMN session"; exit 0; }
echo "synthetic agent stand-in: nothing is sent anywhere"
echo "> synthetic prompt"
sleep 1
echo "synthetic reply: done"
if command -v bmn >/dev/null; then ${ask}; else '${process.execPath}' '${cli}' ${ask.slice('bmn '.length)}; fi
while :; do [ -e '${quit}' ] && exit 0; sleep 0.2; done`)

  const launchApplication = () => electron.launch({
    executablePath: electronBinary,
    // Under xvfb-run (no Wayland display) the window goes to X11, as electron-self-test.mjs does.
    args: [appDirectory, ...(!waylandDisplay && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: dirname(dirname(appDirectory)),
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
      OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'),
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: work,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  let application = await launchApplication()
  const closeApplication = async () => {
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
  /** BMN's own database in this run's folders: the file that holds the conversation bindings. */
  const databaseFile = () => {
    const files = execFileSync('find', [roots.data, roots.state, roots.config, '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    const found = files.find((file) => {
      try { return execFileSync('sqlite3', [file, "SELECT name FROM sqlite_master WHERE name = 'conversation_binding'"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '' } catch { return false }
    })
    if (found === undefined) throw new Error('BMN\'s database was not found in this run\'s folders')
    return found
  }
  const quoted = (value) => (value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`)
  /**
   * What an OpenCode session left in BMN before the retirement, written while BMN is closed, the same for both builds:
   * the conversation its plugin bound and the notice marked as opened by its hook. Returns what was written.
   */
  const seedOldRecords = (sessionId) => {
    const database = databaseFile()
    const keys = [...readFileSync(join(appDirectory, 'src/utility/conversation-binding.ts'), 'utf8')
      .match(/RELEVANT_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1])
    const environment = Object.fromEntries(keys.map((key) => [key, key === 'TERM' ? 'xterm-256color' : null]))
    const values = [sessionId, 'opencode', 'bound', CHAT, 'hook-session-start', work, join(stubs, 'opencode'),
      JSON.stringify([]), JSON.stringify(environment), 'Reported by OpenCode at session start', '2026-11-10T10:00:00.000Z']
    const sql = (statement) => execFileSync('sqlite3', [database, statement], { encoding: 'utf8' }).trim()
    sql(`INSERT OR REPLACE INTO conversation_binding(session_id, agent_cli, status, conversation_reference, capture_route, launch_cwd,
      launch_executable, launch_argv_json, launch_environment_json, detail, captured_at) VALUES (${values.map(quoted).join(', ')})`)
    const marked = sql(`UPDATE attention_request SET opened_by = 'hook:opencode:session.idle' WHERE session_id = ${quoted(sessionId)} AND title = 'OpenCode finished its turn'; SELECT changes();`)
    return [`database ${database}: OpenCode conversation ${CHAT} bound to the session (hook-session-start)`, `notices marked as opened by OpenCode's hook: ${marked}`]
  }
  const manifest = {
    generatedAt: new Date().toISOString(), app: appDirectory, commit: git(appDirectory, 'rev-parse', 'HEAD'), colorModes: COLOR_MODES,
    sizes: SIZES, setup: [], scan: [], screens: []
  }
  const note = (line) => { manifest.setup.push(line); phase(line) }
  let page
  const written = []
  try {
    const resize = async ([width, height]) => {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
      await sleep(350)
    }
    const showWindow = async () => {
      page = await application.firstWindow()
      page.setDefaultTimeout(15_000)
      await page.waitForSelector('.session-row')
      // A background test window may never paint without being shown.
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
      await resize(SIZES[1])
    }
    await showWindow()

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
    /** Every visible text, field value and accessible name in the window that names OpenCode or Luna (Go), as shown. */
    const openCodeWords = (region) => page.evaluate(({ region, source }) => {
      const pattern = new RegExp(source, 'i')
      const found = new Set()
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
    }, { region, source: WORDS.source })
    /** Marks the element that scrolls `selector`'s content and says how many window-high parts it has. */
    const partsOf = (selector) => page.evaluate(({ selector, limit }) => {
      for (const element of document.querySelectorAll('[data-opencode-shots-scroll]')) element.removeAttribute('data-opencode-shots-scroll')
      const root = selector === null ? null : document.querySelector(selector)
      if (root === null) return { count: 1, step: 0 }
      const scrolls = (element) => element.scrollHeight > element.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(element).overflowY)
      let box = scrolls(root) ? root : [...root.querySelectorAll('*')].find(scrolls) ?? null
      for (let parent = root.parentElement; box === null && parent; parent = parent.parentElement) if (scrolls(parent)) box = parent
      if (box === null) return { count: 1, step: 0 }
      box.setAttribute('data-opencode-shots-scroll', '')
      box.scrollTop = 0
      const step = Math.max(120, box.clientHeight - 48)
      return { count: Math.min(limit, Math.ceil((box.scrollHeight - box.clientHeight) / step) + 1), step }
    }, { selector, limit: PART_LIMIT })
    const scrollPart = (index, step) => page.evaluate(([index, step]) => {
      const box = document.querySelector('[data-opencode-shots-scroll]')
      if (box) box.scrollTop = index * step
    }, [index, step])

    /** Opens one screen and saves it in every colour mode, in parts when `scroll` names a region taller than the window. */
    const screen = async (name, how, open, { scroll = null, close = null, size, region = null } = {}) => {
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
          const part = { files: [], openCodeWords: await openCodeWords(region) }
          for (const colorMode of COLOR_MODES) {
            await setColorMode(colorMode)
            const file = `${name}${count > 1 ? `-part${index + 1}` : ''}-${colorMode}.png`
            await capture(file)
            part.files.push(file)
          }
          entry.parts.push(part)
        }
        phase(`${name}: ${entry.parts.length} part(s), ${entry.parts.reduce((sum, part) => sum + part.openCodeWords.length, 0)} OpenCode words`)
      } catch (error) {
        entry.error = String(error?.message ?? error).split('\n')[0]
        phase(`${name}: NOT CAPTURED: ${entry.error}`)
        try { await capture(`${name}-failure.png`); entry.failureShot = `${name}-failure.png` } catch { /* the window is gone */ }
      }
      if (close) await close().catch(() => undefined)
    }

    phase('workspace data: an OpenCode session')
    const workspace = await page.evaluate(async () => (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt))
    const created = await page.evaluate(async ({ workspaceId, cwd, executable }) => {
      try {
        return { session: (await window.aiTerminal.createSession({ workspaceId, name: 'Refactor', cwd, executable, argv: [], cols: 100, rows: 24, backgroundChoice: 'stop' })).session }
      } catch (error) {
        return { failed: JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})) }
      }
    }, { workspaceId: workspace.workspaceId, cwd: work, executable: join(stubs, 'opencode') })
    if (created.failed) throw new Error(`the OpenCode session was not started: ${created.failed}`)
    const openCodeSession = created.session
    note(`OpenCode session "Refactor" started: ${join(stubs, 'opencode')} in ${work}`)
    await sleep(4_000)
    await closeApplication()
    for (const line of seedOldRecords(openCodeSession.sessionId)) note(line)
    application = await launchApplication()
    await showWindow()
    await page.locator('button[aria-label="Dismiss notice"]').click({ timeout: 5_000 }).catch(() => undefined)
    const row = page.locator(`.session-row > button[data-session-id="${openCodeSession.sessionId}"]`)
    await row.waitFor()
    await row.click()
    const binding = await page.evaluate((id) => window.aiTerminal.getConversationBinding(id), openCodeSession.sessionId).catch((error) => ({ status: String(error?.message ?? error) }))
    note(`the stored OpenCode binding as BMN reads it: ${binding?.status ?? 'unknown'}${binding?.status === 'bound' ? ` (${binding.agentCli} ${binding.conversationReference})` : ''}`)
    await sleep(2_500)

    // ---- Preferences helpers (as agents-rules-visual.mjs) --------------------------------------------------------------
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
    /** A page and, for Agents and Integrations, one of its views. */
    const go = async (label, view = null) => {
      await openPreferences()
      await nav.locator('.nav-item', { hasText: new RegExp(`^${label}`) }).first().click()
      if (view !== null) await main.locator('.page-views [role="radio"]', { hasText: new RegExp(`^${view}$`) }).click()
      await sleep(300)
    }
    const card = (name) => main.locator('.agent-card', { has: page.locator('.agent-open', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) })
    const pickIfOffered = async (locator) => { if (await locator.count()) await locator.first().click() }

    phase('the first approval of the synthetic team, so Health, the judge and the agent pages read an approved team')
    try {
      await go('Agents', 'Team')
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
    const launcher = page.locator('.session-launcher')
    const openLauncher = async () => {
      if (!await launcher.isVisible()) {
        await palette('New session')
        await page.keyboard.press('Enter')
      }
      await launcher.waitFor()
    }
    const mainScreens = [
      ['session-window', 'Main window with the OpenCode session selected: the sidebar row and the pane header', async () => { await row.click() }, {}],
      ['request-card', 'The OpenCode session\'s requests card: the notice its hook opened', async () => {
        const control = page.locator(`[data-session-requests="${openCodeSession.sessionId}"]`)
        await control.waitFor({ timeout: 5_000 })
        await control.click()
        await page.locator('.session-request-card').first().waitFor()
      }, { region: '.session-request-card', close: async () => { await page.keyboard.press('Escape') } }],
      ['session-details', 'Session details of the OpenCode session: app, plan use and conversation', openDetails,
        { scroll: '.session-inspector', region: '.session-inspector', close: async () => { await page.locator('button[aria-label="Close session details"]').click() } }],
      ['palette-sessions', 'Command palette, typed "OpenCode"', async () => { await palette('OpenCode') }, { region: 'dialog[open]', close: async () => { await page.keyboard.press('Escape') } }],
      ['plan-use-dialog', 'Palette › Plan use…: the line naming the apps that report no plan use', async () => {
        await palette('Plan use')
        await page.keyboard.press('Enter')
        await page.locator('dialog.plan-use-dialog').waitFor()
      }, { region: 'dialog.plan-use-dialog', close: async () => { await page.keyboard.press('Escape') } }],
      ['new-session', 'Palette › New session…: the agent picker lists every app', openLauncher, { region: '.session-launcher', close: async () => { await page.locator('button[aria-label="Close new session"]').click() } }],
      ['new-session-opencode-picked', 'New session with OpenCode picked, where offered: the name and the command (Advanced open)', async () => {
        await openLauncher()
        const choice = launcher.getByRole('radio', { name: /^OpenCode\b/ })
        if (await choice.count() === 0) throw new Error('no OpenCode choice in the agent picker')
        await choice.first().click()
        await launcher.locator('details.advanced > summary').click()
      }, { scroll: '.session-launcher', region: '.session-launcher', close: async () => { await page.locator('button[aria-label="Close new session"]').click() } }],
      ['workspace-messages', 'Palette › Messages…: who gets a waiting message by its own hook', async () => {
        await palette('Messages')
        await page.keyboard.press('Enter')
        await page.locator('dialog.session-messages-dialog').waitFor()
      }, { region: 'dialog.session-messages-dialog', close: async () => { await page.keyboard.press('Escape') } }],
      ['turn-changes', 'Palette › Turn changes… with the OpenCode session selected', async () => {
        await row.click()
        await palette('Turn changes')
        await page.keyboard.press('Enter')
        await page.locator('dialog[aria-label^="Turn changes"], dialog.turn-changes-dialog').first().waitFor({ timeout: 5_000 })
      }, { region: 'dialog[open]', close: async () => { await page.keyboard.press('Escape') } }]
    ]
    const preferenceScreens = [
      ['team', 'Agents › Team: the agent cards, and the proposal for Luna (Go) where BMN makes one', () => go('Agents', 'Team')],
      ['agent-luna-go', 'Agents › Team › Luna (Go): the page of the OpenCode teammate', async () => {
        await go('Agents', 'Team')
        await card('Luna (Go)').locator('.agent-open').click()
        await main.locator('.page-head').waitFor()
      }],
      ['new-agent', 'Agents › Team › New agent: the agent apps offered (OpenCode picked where offered)', async () => {
        await go('Agents', 'Team')
        await main.getByRole('button', { name: 'New agent' }).click()
        await pickIfOffered(main.getByRole('radio', { name: 'OpenCode', exact: true }))
      }, async () => { await page.keyboard.press('Escape') }],
      ['roles', 'Agents › Roles: the helper chain with Luna (Go)', () => go('Agents', 'Roles')],
      ['models', 'Agents › Models: the team\'s models, each with its agent and app', async () => { await go('Agents', 'Models'); await sleep(1_000) }],
      ['asks', 'Agents › Asks: the team asks', () => go('Agents', 'Asks')],
      ['judge', 'Agents › Team › Jev: the judge\'s page, its gateway and its sign-in', async () => {
        await go('Agents', 'Team')
        await card('Jev').locator('.agent-open').click()
        await main.locator('.judge-page').waitFor()
      }],
      ['health', 'Integrations › Health: rules files, hooks, agent apps, skills, tools and context per app', async () => { await go('Integrations', 'Health'); await sleep(1_500) }],
      ['health-opencode-destination', 'Integrations › Health › Set destination… on the OpenCode row, where offered (cancelled)', async () => {
        await go('Integrations', 'Health')
        await main.getByRole('button', { name: 'Set the destination of OpenCode' }).click({ timeout: 4_000 })
        await main.locator('.sheet').first().waitFor()
        await main.locator('.sheet').first().scrollIntoViewIfNeeded()
      }, async () => { await pickIfOffered(main.locator('.sheet').getByRole('button', { name: 'Cancel' })) }, true],
      ['rules', 'Integrations › Rules: the editor and "What each app reads" (OpenCode picked where offered)', async () => {
        await go('Integrations', 'Rules')
        await pickIfOffered(main.getByRole('radio', { name: 'OpenCode', exact: true }))
      }],
      ['rules-save', 'Integrations › Rules › Save…: the sheet listing each app the rules go to (cancelled, nothing written)', async () => {
        await go('Integrations', 'Rules')
        await main.getByRole('button', { name: 'Save…' }).click()
        await main.locator('.target').first().waitFor()
      }, async () => { await pickIfOffered(main.locator('.sheet').getByRole('button', { name: 'Cancel', exact: true })) }],
      ['skills', 'Integrations › Skills: each skill with a state per app', async () => {
        await go('Integrations', 'Skills')
        await main.evaluate(() => { window.dispatchEvent(new Event('focus')) })
        await sleep(1_500)
      }],
      ['tools', 'Integrations › Tools, with Add tool open and Some apps picked (the apps a tool reaches)', async () => {
        await go('Integrations', 'Tools')
        await main.evaluate(() => { window.dispatchEvent(new Event('focus')) })
        await sleep(1_500)
        if (await main.locator('.tool-editor').count() === 0) await pickIfOffered(main.getByRole('button', { name: 'Add tool', exact: true }))
        await pickIfOffered(main.getByRole('radio', { name: 'Some apps', exact: true }))
      }],
      ['history', 'Data: the row for each agent\'s own history', async () => { await go('Data'); await sleep(1_000) }]
    ]

    for (const size of SIZES) {
      await resize(size)
      for (const [name, how, open, options] of mainScreens) await screen(`${name}-${size[0]}`, how, open, { ...options, size })
      for (const [name, how, open, close, single = false] of preferenceScreens) {
        await screen(`preferences-${name}-${size[0]}`, how, open, { scroll: single ? null : '.preferences-dialog .preferences-main', region: '.preferences-dialog', size, close })
      }
      await closePreferences()
    }

    phase('scan: which Preferences pages and views name OpenCode or Luna (Go), at the widest size')
    try {
      for (const [label, views] of [['General', [null]], ['Agents', ['Team', 'Roles', 'Models', 'Changes', 'Asks']], ['Integrations', ['Health', 'Rules', 'Skills', 'Tools']],
        ['Notifications', [null]], ['Voice', [null]], ['Data', [null]]]) {
        for (const view of views) {
          await go(label, view)
          await sleep(700)
          const lines = await page.evaluate((source) => [...new Set((document.querySelector('.preferences-page:not([hidden])')?.innerText ?? '')
            .split('\n').filter((line) => new RegExp(source, 'i').test(line)).map((line) => line.trim().slice(0, 220)))], WORDS.source)
          manifest.scan.push({ page: view === null ? label : `${label} › ${view}`, lines })
        }
      }
    } catch (error) { note(`scan stopped: ${String(error?.message ?? error).split('\n')[0]}`) }
    await closePreferences()
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
    manifest.files = [...new Set(written)].sort()
    manifest.notWrittenByThisRun = readdirSync(outDirectory).filter((file) => file.endsWith('.png') && !written.includes(file)).sort()
    writeFileSync(join(outDirectory, 'shots.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const taken = manifest.screens.filter((entry) => !entry.error)
    console.log(JSON.stringify({ openCodeScreens: manifest.error ? 'STOPPED' : 'DONE', directory: outDirectory,
      screens: taken.length, notCaptured: manifest.screens.filter((entry) => entry.error).map((entry) => `${entry.screen}: ${entry.error}`),
      pngs: taken.reduce((sum, entry) => sum + entry.parts.reduce((count, part) => count + part.files.length, 0), 0) }))
  }
})
