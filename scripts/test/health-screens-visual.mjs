/* global window, document, getComputedStyle */
// MODULE: health-screens-visual.mjs - Story 96.6: Integrations › Health on the audit fixture, in the real renderer, at 889×768 and 640×720, with keyboard, focus, overflow and redaction checks
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end), as the other Preferences screens
// do: the unit-test roster, a synthetic rules master and stand-ins for claude and codex. Once Health has read that home,
// the main process's rules snapshot answer is replaced by the audit fixture built from it: OpenCode with three tool
// connections and an earlier plugin BMN could not replace, a Codex limit not applied whose test failed with a
// 4,000-character detail, long paths, and Doctor's view of the same, built by BMN's own doctor-state projection from a
// synthetic state with 335 leftovers (and names planted where the trust boundary must drop them). Every reload of Health
// then reads the fixture through the real IPC path. Nothing leaves the machine and no file of the owner's is read.
// Usage: node scripts/test/health-screens-visual.mjs OUT_DIR [--binary PACKAGED_BMN]
// Writes OUT_DIR/health.json (each check PASS or FAIL) and one PNG per size and state; exit 1 when a check failed.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { doctorView, validateDoctorState } from '../../apps/desktop/bin/doctor-state.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const argv = process.argv.slice(2)
const outDirectory = resolve(argv.find((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--binary') ?? join(repoRoot, '.dev-auto/evidence/96.6/screens'))
const packagedBinary = argv.includes('--binary') ? resolve(argv[argv.indexOf('--binary') + 1]) : undefined
const electronBinary = packagedBinary ?? createRequire(join(appDirectory, 'package.json'))('electron')
const SIZES = [[889, 768], [640, 720]]
const SECRET = 'SECRET-SENTINEL-NAME'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const phase = (label) => console.error(`[BMN health screens] ${label}`)
const git = (...args) => { try { return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim() } catch { return null } }

const runtime = process.env.XDG_RUNTIME_DIR
const wayland = runtime && process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY) ? join(runtime, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
const callerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND' && !name.startsWith('BMN_') && !name.startsWith('AITERM_')))
const MASTER = '# Global rules\n\nPlain rule for everyone.\n\n<!-- bmn:public -->\n## How to talk\nAnswer first, plainly.\n<!-- /bmn:public -->\n'

/** Doctor's view of the audit, through BMN's own state validation and projection (names planted in it are dropped there). */
function auditDoctor(now, { passed = false } = {}) {
  const digest = 'a'.repeat(64)
  const at = now - 5 * 60_000
  const kinds = (index) => index < 250 ? ['plugins', 'claude', 'plugin-missing'] : index < 288 ? ['plugins', 'claude', 'app-managed'] : index < 320 ? ['mcp', 'codex', 'missing-program'] : ['skills', null, 'duplicate']
  const leftovers = Array.from({ length: 335 }, (_, index) => {
    const [kind, app, reason] = kinds(index)
    return { kind, app, reason, item: index + 1, name: SECRET, identity: SECRET, path: `/home/owner/${SECRET}`,
      locator: index % 3 === 0 ? { status: 'unresolved' }
        : { status: 'located', acquisition: 4, root: 'home', parent: { device: '2049', inode: String(140000 + index) }, object: { device: '2049', inode: String(150000 + index) },
          entry: (index % 40) + 1, route: [{ device: '2049', inode: '2', entry: 2 }, { device: '2049', inode: '14', entry: 14 }], line: 8, column: 3 } }
  })
  const result = (state, problems, extra = {}) => ({ state, problems, checkedAt: at, version: digest, ...extra })
  const state = validateDoctorState({
    schemaVersion: 1, profileKey: null, profileIdentity: null, availabilityFailure: null, cycleStartedAt: at, versions: digest, cycleStartupId: null,
    appVersions: { claude: null, codex: null, opencode: null }, retryUsed: false, attempt: null, qualifications: {}, continuity: null,
    results: passed ? Object.fromEntries(['hooks', 'skills', 'tools', 'rules', 'claude', 'codex', 'leftovers'].map((check) => [check, result('passed', [])])) : {
      hooks: result('problems', [{ code: 'hook-check', item: 1, app: 'opencode' }]),
      skills: result('passed', []),
      tools: result('problems', [1, 2, 3].map((item) => ({ code: 'tool-check', item, app: 'opencode' }))),
      rules: result('passed', []),
      claude: result('problems', [{ code: 'auth-check', item: 1, app: 'claude' }]),
      codex: result('passed', []),
      leftovers: result('partial', [{ code: 'leftover-source-changed', item: 1, count: 3 }], { leftovers })
    }
  })
  if (state === null) throw new Error('the synthetic doctor state did not validate')
  return doctorView(state, { now })
}

/** The audit, laid over what Health read from the temporary home: the parts 96.6 is about, everything else as read. */
function auditSnapshot(real, now, { dropGroup = null, codexHooksLeft = false, doctorRunning = false } = {}) {
  const long = `/synthetic/${'a-rather-long-folder-name-for-the-wrapping-check/'.repeat(6)}opencode.jsonc`
  const doctor = { ...auditDoctor(now), running: doctorRunning }
  if (dropGroup !== null) doctor.rows = doctor.rows.map((row) => ({ ...row, leftovers: row.leftovers.filter((item) => `${item.app ?? 'shared'}:${item.kind}:${item.reason}` !== dropGroup) }))
  const detail = `The synthetic context test failed: ${'the setting the owner keeps outranks the agent limit, '.repeat(80)}`.slice(0, 4000)
  return {
    ...real,
    // The temporary home has no rules files: as written, so only what the audit is about needs the owner (96 review).
    health: real.health.state === 'checked' ? { ...real.health, targets: real.health.targets.map((target) => ({ ...target, state: 'current' })) } : real.health,
    probes: [{ harness: 'claude', outcome: 'fail', at: new Date(now - 3_600_000).toISOString(), version: '2.1.296' }],
    hooks: { state: 'checked', checkedAt: new Date(now - 60_000).toISOString(), apps: [
      { harness: 'claude', file: join(real.home ?? '/home/synthetic', '.claude/settings.json'), state: 'checked', placed: ['Notification', 'PreToolUse', 'Stop'], older: [], installed: [], left: [] },
      { harness: 'codex', file: join(real.home ?? '/home/synthetic', '.codex/hooks.json'), state: 'checked', placed: ['PreToolUse', 'Stop'], older: [], installed: [],
        left: codexHooksLeft ? [{ event: 'SessionEnd', why: 'changed' }] : [] },
      codexHooksLeft ? { harness: 'opencode', file: long.replace('opencode.jsonc', 'bmn/tui.ts'), state: 'checked', placed: ['plugin', 'cli.json'], older: [], installed: [], left: [] }
        : { harness: 'opencode', file: long.replace('opencode.jsonc', 'bmn/tui.ts'), state: 'failed', placed: [], older: [], installed: [], left: [], why: 'failed', earlier: ['plugin'] }
    ] },
    tools: { ...real.tools, exposed: 3, apps: real.tools.apps.map((app) => app.harness === 'opencode'
      ? { ...app, version: app.version ?? '2.0.29', supported: true, readable: true, kind: 'public', state: 'Exposed', path: long,
        unlisted: ['search', 'browser', 'notes'].map((id) => ({ id, state: 'exposed', managed: false })) }
      : { ...app, unlisted: [] }) },
    context: real.context.map((row) => row.harness === 'codex'
      ? { ...row, version: row.version ?? '0.162.1', test: { at: new Date(now - 7_200_000).toISOString(), version: row.version ?? '0.162.1', outcome: 'fail', detail, asked: 123000, observed: null, by: 'bmn' },
        limits: [{ agent: 'Sol', limit: 272000, state: 'not-applied', reason: 'the context test failed on this version' }] }
      : row),
    doctor
  }
}

const checks = []
const check = (name, ok, detail = {}) => { checks.push({ name, result: ok ? 'PASS' : 'FAIL', ...detail }); phase(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail).slice(0, 600)}`}`) }

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  mkdirSync(outDirectory, { recursive: true })
  const home = join(root, 'home')
  const work = join(root, 'work')
  const stubs = join(root, 'stubs')
  const agents = join(home, '.config/bmn/agents')
  for (const folder of [agents, join(agents, 'state'), work, stubs, join(home, '.claude'), join(home, '.codex')]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(join(agents, 'roster.md'), readFileSync(join(appDirectory, 'src/utility/test-fixtures/agents/roster-example.md'), 'utf8'))
  writeFileSync(join(agents, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  for (const [name, body] of [['claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; *) echo synthetic;; esac'], ['codex', 'case "$1" in --version) echo "codex-cli 0.162.1";; *) echo synthetic;; esac']]) {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  const application = await electron.launch({
    executablePath: electronBinary,
    args: [...(packagedBinary ? [] : [appDirectory]), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: { ...callerEnvironment, HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: work, ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}) }
  })
  const report = { generatedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '', binary: packagedBinary ?? 'development', sizes: SIZES, checks, shots: [] }
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    const resize = async ([width, height]) => {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
      await sleep(500)
    }
    const shot = async (file) => {
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(outDirectory, file), Buffer.from(png, 'base64'))
      report.shots.push(file)
    }
    await resize(SIZES[0])
    const dialog = page.locator('.preferences-dialog')
    const main = dialog.locator('.preferences-page:not([hidden])')
    const go = async (view) => {
      if (!await dialog.count()) { await page.locator('.preferences-button').click(); await dialog.waitFor() }
      await dialog.locator('.preferences-nav .nav-item', { hasText: /^Integrations/ }).first().click()
      await main.locator('.page-views [role="radio"]', { hasText: new RegExp(`^${view}$`) }).click()
      await sleep(900)
    }
    await go('Health')
    await main.locator('.page-head [role="status"]').waitFor()
    const real = await page.evaluate(() => window.aiTerminal.rulesSnapshot(false))
    // From here every read of Health answers with the audit fixture, through the real IPC path; `delay` holds a read open.
    const serve = async (snapshot, delay = 0) => application.evaluate(({ ipcMain }, [value, wait]) => {
      globalThis.bmnHealthFixture = value
      ipcMain.removeHandler('aiterm:rules:snapshot')
      // In the envelope BMN's bridge registrar gives every answer (src/main/bridge-ipc.ts).
      // Each read is a fresh check, as BMN's own is: its time is the answer's, so a long run never ages the fixture into stale.
      ipcMain.handle('aiterm:rules:snapshot', async () => {
        globalThis.bmnHealthReads = (globalThis.bmnHealthReads ?? 0) + 1
        await new Promise((done) => setTimeout(done, wait))
        const fixture = globalThis.bmnHealthFixture
        return { ok: true, result: fixture.health?.checkedAt ? { ...fixture, health: { ...fixture.health, checkedAt: new Date().toISOString() } } : fixture }
      })
    }, [snapshot, delay])
    const reload = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForFunction(() => document.querySelector('.preferences-page:not([hidden]) [data-doctor-leftovers]') !== null &&
        !document.querySelector('.preferences-page:not([hidden]) .page-head [role="status"]')?.textContent?.startsWith('Refreshing'))
      await sleep(400)
    }
    await serve(auditSnapshot(real, Date.now()))
    await reload()
    const text = async () => main.evaluate((element) => element.innerText)

    for (const size of SIZES) {
      await resize(size)
      const name = `${size[0]}x${size[1]}`
      await main.evaluate((element) => { element.closest('.preferences-main')?.scrollTo(0, 0) })
      await shot(`health-${name}-top.png`)
      const layout = await main.evaluate((element) => {
        const scroller = element.closest('.preferences-main') ?? element
        const box = scroller.getBoundingClientRect()
        const rows = [...element.querySelectorAll('.health-row, .leftovers, .leftover-group, .limit-note')]
        // What shows past the page's own box; a disclosure's summary keeps its 4 px hover pad (launcher-form.css .advanced > summary) inside it.
        const wideRows = rows.filter((row) => row.getBoundingClientRect().right > box.right + 1 || [...row.querySelectorAll('*')].some((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().right > box.right + 1))
        const wide = wideRows.length
        const wideSample = wideRows.slice(0, 6).map((row) => ({ className: row.className, text: row.innerText.slice(0, 60), right: Math.round(row.getBoundingClientRect().right), box: Math.round(box.right), scrollWidth: row.scrollWidth, clientWidth: row.clientWidth }))
        const head = element.querySelector('.page-head [role="status"]')
        const firstNeed = element.querySelector('.health-row .needs-dot')?.getBoundingClientRect().top ?? null
        const leftovers = element.querySelector('.leftovers')
        return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, documentWide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          wide, wideSample, statuses: element.querySelectorAll('[role="status"]').length, statusTexts: [...element.querySelectorAll('[role="status"]')].map((node) => `${node.className}: ${node.textContent.slice(0, 80)}`), head: head?.textContent ?? null, headLines: head ? Math.round(head.getBoundingClientRect().height / parseFloat(getComputedStyle(head).lineHeight || '16')) : null,
          firstNeed, leftoversTop: leftovers?.getBoundingClientRect().top ?? null, leftoversOpen: leftovers?.open ?? null }
      })
      check(`${name}: nothing scrolls sideways with the audit's long paths and 4,000-character detail`, layout.scrollWidth <= layout.clientWidth + 1 && !layout.documentWide && layout.wide === 0, layout)
      check(`${name}: one live status, the head, naming the issues and their sections`, layout.statuses === 1 && /^Read .+ · \d+ need(s)? you: .*Tools.*Context limits.*Hooks.*Doctor/u.test(layout.head ?? ''), { head: layout.head, statuses: layout.statusTexts })
      check(`${name}: the head stays under 120 characters`, (layout.head ?? '').length < 120, { length: (layout.head ?? '').length })
      check(`${name}: the first failure comes before the inventory, which starts closed`, layout.firstNeed !== null && layout.leftoversTop !== null && layout.firstNeed < layout.leftoversTop && layout.leftoversOpen === false, layout)
      // The keyboard: Leftovers, then a group, toggled with Enter and Space, the focus left on the summary.
      const summary = main.locator('.leftovers > summary')
      await summary.scrollIntoViewIfNeeded()
      await summary.focus()
      await page.keyboard.press('Enter')
      await sleep(200)
      const opened = await main.evaluate((element) => ({ open: element.querySelector('.leftovers').open, focused: document.activeElement === element.querySelector('.leftovers > summary') }))
      await page.keyboard.press('Tab')
      const group = await page.evaluate(() => document.activeElement?.closest('.leftover-group')?.dataset.doctorLeftoverGroup ?? null)
      await page.keyboard.press('Space')
      await sleep(200)
      const groupOpen = await page.evaluate(() => ({ open: document.activeElement?.closest('.leftover-group')?.open ?? false, summary: document.activeElement?.tagName === 'SUMMARY' }))
      check(`${name}: Enter opens Leftovers and Space a group, the focus staying on each summary`, opened.open && opened.focused && group !== null && groupOpen.open && groupOpen.summary, { opened, group, groupOpen })
      await shot(`health-${name}-leftovers.png`)
      // Every group open: all 335 locations are there to read, and still nothing scrolls sideways.
      await main.evaluate((element) => { for (const details of element.querySelectorAll('.leftover-group')) details.open = true })
      await sleep(300)
      const all = await main.evaluate((element) => {
        const scroller = element.closest('.preferences-main') ?? element
        return { items: element.querySelectorAll('[data-doctor-leftover]').length, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
          wide: [...element.querySelectorAll('.leftover-items > li')].filter((item) => item.getBoundingClientRect().right > scroller.getBoundingClientRect().right + 1).length }
      })
      check(`${name}: all 335 leftover locations are retrievable and wrap`, all.items === 335 && all.scrollWidth <= all.clientWidth + 1 && all.wide === 0, all)
      await shot(`health-${name}-all-open.png`)
      // Every button and summary on the page is reached by Tab, in order, from the head.
      // A radio group is one Tab stop, its checked radio; the others are reached with the arrow keys.
      const reachable = await main.evaluate((element) => [...element.querySelectorAll('button:not([disabled]), summary')]
        .filter((node) => node.getClientRects().length > 0 && !(node.getAttribute('role') === 'radio' && node.getAttribute('aria-checked') !== 'true')).length)
      await main.locator('.page-head').evaluate((head) => { head.setAttribute('tabindex', '-1'); head.focus() })
      const seen = new Set()
      for (let step = 0; step < 600 && seen.size < reachable; step += 1) {
        await page.keyboard.press('Tab')
        const id = await page.evaluate(() => {
          const node = document.activeElement
          if (!node || !node.closest('.preferences-page:not([hidden])')) return null
          if (!node.dataset.healthTab) node.dataset.healthTab = String(Math.random())
          return node.dataset.healthTab
        })
        if (id !== null) seen.add(id)
      }
      check(`${name}: every action and disclosure is reached by the keyboard`, seen.size >= reachable, { reachable, reached: seen.size })
      await main.evaluate((element) => { for (const details of element.querySelectorAll('.leftovers, .leftover-group')) details.open = false })
    }

    // A refresh in the background keeps the known failures and leaves Test again… usable; the head says Refreshing… and keeps the count.
    await resize(SIZES[0])
    await serve(auditSnapshot(real, Date.now()), 2500)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await sleep(600)
    const during = await main.evaluate((element) => ({ head: element.querySelector('.page-head [role="status"]')?.textContent ?? null,
      needs: element.querySelectorAll('.health-row .needs-dot').length,
      again: [...element.querySelectorAll('button')].filter((button) => /again/u.test(button.getAttribute('aria-label') ?? '')).map((button) => button.disabled) }))
    await page.waitForFunction(() => !document.querySelector('.preferences-page:not([hidden]) .page-head [role="status"]')?.textContent?.startsWith('Refreshing'))
    check('a background read says Refreshing… with the known count, keeps every known failure and leaves Test again… usable', /^Refreshing… · \d+ needs? you: /u.test(during.head ?? '') && during.needs > 0 && during.again.length > 0 && during.again.every((disabled) => !disabled), during)

    // Disclosures keep their state across a refresh; a focused group the refresh removed hands the focus to Leftovers.
    await serve(auditSnapshot(real, Date.now()))
    const leftovers = main.locator('.leftovers > summary')
    await leftovers.scrollIntoViewIfNeeded()
    await leftovers.focus()
    await page.keyboard.press('Enter')
    const keep = 'codex:mcp:missing-program'
    const drop = 'claude:plugins:app-managed'
    await main.locator(`[data-doctor-leftover-group="${keep}"] > summary`).focus()
    await page.keyboard.press('Enter')
    await main.locator(`[data-doctor-leftover-group="${drop}"] > summary`).focus()
    await serve(auditSnapshot(real, Date.now(), { dropGroup: drop }))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction((group) => !document.querySelector(`[data-doctor-leftover-group="${group}"]`), drop)
    await sleep(400)
    const after = await main.evaluate((element, group) => ({ focusedLeftovers: document.activeElement === element.querySelector('.leftovers > summary'),
      leftoversOpen: element.querySelector('.leftovers').open, keptOpen: element.querySelector(`[data-doctor-leftover-group="${group}"]`)?.open ?? null }), keep)
    check('a refresh keeps open disclosures open and moves the focus from a removed group to Leftovers', after.focusedLeftovers && after.leftoversOpen && after.keptOpen === true, after)
    await shot('health-889x768-after-refresh.png')

    // Under the pointer a refresh moves no row; once the pointer has left, the rows that need the owner come first again.
    const hookOrder = () => main.evaluate((element) => [...element.querySelectorAll('[data-hooks]')].map((row) => row.querySelector('span')?.textContent))
    await main.evaluate((element) => { element.closest('.preferences-main')?.scrollTo(0, 0) })
    const hooksRow = main.locator('[data-hooks]').first()
    await hooksRow.scrollIntoViewIfNeeded()
    const box = await hooksRow.boundingBox()
    await page.mouse.move(box.x + 40, box.y + box.height / 2)
    const before = await hookOrder()
    await serve(auditSnapshot(real, Date.now(), { codexHooksLeft: true }))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => document.querySelector('[data-hooks="left"] span')?.textContent === 'Codex')
    await sleep(300)
    const under = await hookOrder()
    await page.mouse.move(60, 300)
    await sleep(200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await sleep(1500)
    const away = await hookOrder()
    check('a refresh moves no row under the pointer, and orders needs first once it has left', JSON.stringify(under) === JSON.stringify(before) && away[0] === 'Codex' && before[0] === 'OpenCode', { before, under, away })
    await serve(auditSnapshot(real, Date.now()))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => document.querySelector('.preferences-page:not([hidden])')?.innerText.includes('Older plugin · stopped turns cannot be distinguished'))

    // While Doctor runs, Health reads every 5 s: those reads never flip the head, the page's only live status (96 review).
    await serve(auditSnapshot(real, Date.now(), { doctorRunning: true }), 1200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    // The focus read is a refresh of the owner's and may say so; the reads Doctor's run starts after it are sampled.
    await page.waitForFunction(() => document.querySelector('.preferences-page:not([hidden])')?.innerText.includes('Doctor running') &&
      !document.querySelector('.preferences-page:not([hidden]) .page-head [role="status"]')?.textContent?.startsWith('Refreshing'))
    const reads = () => application.evaluate(() => globalThis.bmnHealthReads ?? 0)
    const readsBefore = await reads()
    const heads = new Set()
    for (let sample = 0; sample < 24; sample += 1) {
      heads.add(await main.evaluate((element) => element.querySelector('.page-head [role="status"]')?.textContent ?? null))
      await sleep(300)
    }
    const polled = (await reads()) - readsBefore
    check('while Doctor runs, its 5-second reads leave the head as it is', polled >= 1 && [...heads].every((head) => head !== null && head.startsWith('Read ')), { heads: [...heads], polled })
    await serve(auditSnapshot(real, Date.now()))
    await reload()

    // A refresh while a sheet is open leaves the sheet, and the focus in it (96 review).
    const update = main.locator('button', { hasText: /^Update…$/u }).first()
    if (await update.count()) {
      await update.scrollIntoViewIfNeeded()
      await update.click()
      await sleep(400)
      const sheetBefore = await main.evaluate((element) => ({ open: element.querySelector('.sheet') !== null, focusIn: element.querySelector('.sheet')?.contains(document.activeElement) ?? false }))
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await sleep(1500)
      const sheetAfter = await main.evaluate((element) => ({ open: element.querySelector('.sheet') !== null, focusIn: element.querySelector('.sheet')?.contains(document.activeElement) ?? false,
        text: element.querySelector('.sheet')?.innerText.slice(0, 60) ?? null }))
      check('a refresh with the Update sheet open keeps it open and the focus in it', sheetBefore.open && sheetAfter.open && sheetAfter.focusIn === sheetBefore.focusIn, { sheetBefore, sheetAfter })
      await page.keyboard.press('Escape')
      await sleep(300)
    } else check('a refresh with the Update sheet open keeps it open and the focus in it', false, { reason: 'no Update… button on the page' })

    // A failed context limit alone: Doctor passed everything, and still no All well while Health counts an issue (96 review).
    const contextOnly = { ...auditSnapshot(real, Date.now(), { codexHooksLeft: true }), probes: [], doctor: auditDoctor(Date.now(), { passed: true }) }
    contextOnly.hooks = { ...contextOnly.hooks, apps: contextOnly.hooks.apps.map((app) => ({ ...app, left: [] })) }
    contextOnly.tools = { ...contextOnly.tools, exposed: 0, apps: real.tools.apps.map((app) => ({ ...app, unlisted: [] })) }
    await serve(contextOnly)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('.preferences-page:not([hidden])')?.innerText.includes('Older plugin'))
    await sleep(600)
    const only = await main.evaluate((element) => ({ head: element.querySelector('.page-head [role="status"]')?.textContent ?? null, allWell: element.innerText.includes('All well') }))
    check('a failed context limit with Doctor all passed: the head counts it and Doctor says no All well', /Context limits/u.test(only.head ?? '') && !only.allWell, only)
    await shot('health-889x768-context-only.png')
    await serve(auditSnapshot(real, Date.now()))
    await reload()
    await page.waitForFunction(() => document.querySelector('.preferences-page:not([hidden])')?.innerText.includes('Older plugin · stopped turns cannot be distinguished'))

    // Redaction: the names planted in the synthetic doctor state reach neither the text nor any title.
    const leaked = await main.evaluate((element, secret) => element.innerText.includes(secret) || [...element.querySelectorAll('[title]')].some((node) => node.getAttribute('title').includes(secret)), SECRET)
    check('no planted leftover name reaches the page, its titles included', !leaked)
    check('tools say what is available, never a transfer', /3 tool connections available · no approved destination recorded/u.test(await text()))
    check('the earlier OpenCode plugin is said as a missing capability that needs the owner', /Older plugin · stopped turns cannot be distinguished/u.test(await text()))

    // The neighbouring views still open and come back.
    const views = []
    for (const view of ['Rules', 'Skills', 'Tools', 'Health']) {
      await go(view)
      views.push([view, await main.locator('.page-views [role="radio"][aria-checked="true"]').innerText()])
    }
    check('Rules, Skills, Tools and back to Health open as before', views.every(([view, title]) => title === view), { views })
  } catch (error) {
    report.error = String(error?.stack ?? error).slice(0, 4000)
    check('the run finished', false, { error: report.error.split('\n')[0] })
  } finally {
    // A window that will not close is stopped: this run started it, and nothing else of it may outlive the run.
    const closed = await Promise.race([application.close().then(() => true, () => false), sleep(15_000).then(() => false)])
    if (!closed) application.process().kill('SIGKILL')
    report.result = checks.every((entry) => entry.result === 'PASS') ? 'PASS' : 'FAIL'
    writeFileSync(join(outDirectory, 'health.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
})
process.exitCode = checks.every((entry) => entry.result === 'PASS') ? 0 : 1
