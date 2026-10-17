/* global window, document, getComputedStyle */
// MODULE: quick-look-live.mjs - Epic 67's isolated Electron run of Quick look on a made-up project: the three ways in, a highlighted file under the unchanged page policy with no worker, the file states, the tree, and no terminal resized or typed into
// The app runs in test mode with temporary HOME and XDG folders (removed at the end); the project, its files and the
// terminal program are made up here. Nothing leaves the machine and no file of the owner's is read. Prints PASS or
// FAIL per check and writes result.json and screenshots to the evidence folder.
// Usage: node scripts/test/quick-look-live.mjs [--binary <packaged bmn>]   (needs `pnpm run build` first without --binary)
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { testedApp } from '../lib/tested-app.mjs'

const repo = resolve(import.meta.dirname, '../..')
const tested = testedApp(join(repo, 'apps/desktop'))
const evidence = process.env.BMN_QUICK_LOOK_EVIDENCE ?? join(repo, '.dev-auto/evidence/quick-look/runtime')
mkdirSync(evidence, { recursive: true })
const checks = []
const check = (name, ok, detail = {}) => {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`)
  writeFileSync(join(evidence, 'result.json'), `${JSON.stringify({ build: tested.build, checks }, null, 2)}\n`)
}
const SIZES = [[1653, 1300], [1380, 1300], [1280, 900], [1000, 700], [800, 500]]

/** A small made-up project: a joined folder chain, generated folders, and each kind of file the sheet tells apart. */
function writeProject(project) {
  const file = (path, text) => {
    mkdirSync(join(project, path, '..'), { recursive: true })
    writeFileSync(join(project, path), text)
  }
  file('apps/desktop/src/parser.ts', [
    '// A made-up parser for the Quick look run.',
    "import { readFileSync } from 'node:fs'",
    `export const wide = '${'x'.repeat(400)}'`,
    'export interface Token {',
    '  kind: string',
    '  text: string',
    '}',
    '',
    ...Array.from({ length: 60 }, (_, index) => `export const value${index} = ${index} // line ${index + 9}`),
    '',
    '/** Splits a text into tokens. */',
    'export function parse(text: string): Token[] {',
    "  return text.split(/\\s+/).map((word) => ({ kind: 'word', text: word }))",
    '}',
    ''
  ].join('\n'))
  file('apps/desktop/package.json', '{\n  "name": "made-up",\n  "private": true\n}\n')
  file('docs/guide.md', '# Guide\n\nA made-up guide with **strong** text.\n')
  file('node_modules/left-pad/index.js', 'module.exports = 1\n')
  file('dist/bundle.js', 'console.log(1)\n')
  file('README.md', '# Made-up project\n')
  file('empty.txt', '')
  writeFileSync(join(project, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x14, 0x00]))
  writeFileSync(join(project, 'big.log'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
}

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const project = join(root, 'project')
  const fixture = join(root, 'terminal.mjs')
  const input = join(root, 'input.txt')
  writeProject(project)
  // The terminal program counts what reaches it: nothing Quick look does may arrive here.
  writeFileSync(fixture, `import {appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);
process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));
let n=0;setInterval(()=>{n+=1;process.stdout.write('\\rQUICK LOOK FIXTURE tick '+n+'   ')},200);`)
  const env = { ...process.env }
  if (env.WAYLAND_DISPLAY && !isAbsolute(env.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY)
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID', 'PROMPT_COMMAND']) delete env[key]
  const app = await _electron.launch({
    executablePath: tested.executablePath, cwd: repo, timeout: 30_000,
    args: [...tested.appArgs, ...(!env.WAYLAND_DISPLAY && env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: {
      ...env, ...Object.fromEntries(Object.entries(roots).map(([key, value]) => [`XDG_${key.toUpperCase()}_HOME`, value])),
      HOME: join(root, 'home'), XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: project
    }
  })
  mkdirSync(join(root, 'home'), { recursive: true })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    const violations = []
    page.on('console', (message) => { if (/Content Security Policy|Refused to/u.test(message.text())) violations.push(message.text()) })
    await page.waitForSelector('.session-row')
    await page.evaluate(() => {
      window.__qlViolations = []
      document.addEventListener('securitypolicyviolation', (event) => window.__qlViolations.push(`${event.violatedDirective} ${event.blockedURI}`))
    })
    const sessionId = await page.evaluate(async (params) => {
      const workspace = (await window.aiTerminal.listWorkspaces())[0]
      return (await window.aiTerminal.createSession({ ...params, workspaceId: workspace.workspaceId })).session.sessionId
    }, { name: 'Quick look fixture', cwd: project, executable: process.execPath, argv: [fixture], cols: 100, rows: 30, backgroundChoice: 'stop' })
    await page.reload()
    await page.evaluate(() => document.addEventListener('securitypolicyviolation', (event) => {
      window.__qlViolations = window.__qlViolations ?? []
      window.__qlViolations.push(`${event.violatedDirective} ${event.blockedURI}`)
    }))
    await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await page.waitForFunction((id) => window.__aitermTest?.snapshot(id)?.bufferLines.some((line) => line.includes('QUICK LOOK FIXTURE')), sessionId)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(0, 0); w.setContentSize(1408, 880); w.show() })
    const sheet = page.locator('dialog.quick-look[open]')
    const terminal = page.locator(`.session-terminal[data-session-id="${sessionId}"] .xterm-helper-textarea`)

    // ---- three ways in: the key, the pane's Project plate, the palette ----
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    check('Ctrl+Shift+E opens Quick look', true)
    const size = await sheet.evaluate((element) => { const r = element.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) } })
    check('the sheet is min(1160px, 100vw − 32px) by min(772px, 100dvh − 32px)', size.width === 1160 && size.height === 772, size)
    check('focus goes to the tree when no file is open', await page.evaluate(() => document.activeElement?.classList.contains('ql-tree') === true))
    const backdrop = await sheet.evaluate((element) => getComputedStyle(element, '::backdrop').backgroundColor)
    check('the window dims behind the sheet', backdrop !== 'rgba(0, 0, 0, 0)' && backdrop !== 'transparent', { backdrop })
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor({ state: 'detached' })
    await page.waitForTimeout(200)
    const returned = await page.evaluate((id) => {
      const active = document.activeElement
      return { terminal: active?.classList.contains('xterm-helper-textarea') === true && active.closest('[data-session-id]')?.getAttribute('data-session-id') === id,
        active: `${active?.tagName}.${active?.className}` }
    }, sessionId)
    check('Ctrl+Shift+E closes it and focus returns to the terminal', returned.terminal, returned)
    await page.locator(`.session-terminal[data-session-id="${sessionId}"] .pane-actions button[aria-label="Project"]`).click()
    await sheet.waitFor()
    check('the pane header\'s Project plate opens it', true)
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    check('Esc closes it', true)
    await page.locator('button[aria-label="Command palette"]').click()
    await page.locator('#palette-results').waitFor()
    await page.keyboard.type('Project files')
    await page.keyboard.press('Enter')
    await sheet.waitFor()
    check('"Project files…" in the palette opens it', true)

    // ---- the tree: root, joined chain, dimmed names, links, keys ----
    const rootRow = await sheet.locator('.ql-head').textContent()
    check('the root row names the session folder', rootRow.includes('project'), { rootRow })
    await sheet.locator('.ql-tr').first().waitFor()
    const names = await sheet.locator('.ql-tr .ql-nm').allTextContents()
    check('folders first, then files by name, hidden and generated names listed', names.slice(0, 4).join('|') === 'apps/desktop|dist|docs|node_modules' && names.includes('empty.txt'), { names })
    check('a folder holding only a folder is joined (apps/desktop)', names[0] === 'apps/desktop')
    const dimmed = await sheet.locator('.ql-tr.dim .ql-nm').allTextContents()
    check('node_modules and generated names are dimmed, not hidden', dimmed.includes('node_modules') && dimmed.includes('dist'), { dimmed })
    // apps/desktop is first and selected: → opens it, ↓ to src, → opens it, ↓ to parser.ts, Enter opens it.
    const rowCount = () => sheet.locator('.ql-tr').count()
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowRight', 'ArrowDown']) {
      const count = await rowCount()
      await page.keyboard.press(key)
      if (key === 'ArrowRight') await page.waitForFunction((before) => document.querySelectorAll('dialog.quick-look .ql-tr').length > before, count)
    }
    const chosen = await sheet.locator('.ql-tr.sel .ql-nm').textContent()
    check('↓ → walk into folders by keyboard', chosen === 'parser.ts', { chosen })
    await page.keyboard.press('Enter')
    await sheet.locator('.ql-code .cm-content').waitFor()

    // ---- a highlighted file under the unchanged policy, no worker ----
    const highlighted = await sheet.evaluate((element) => ({
      keyword: element.querySelectorAll('.ql-syn-keyword').length,
      comment: element.querySelectorAll('.ql-syn-comment').length,
      def: element.querySelectorAll('.ql-syn-def').length,
      gutter: element.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length
    }))
    check('the file shows with line numbers and colour', highlighted.keyword > 0 && highlighted.comment > 0 && highlighted.def > 0 && highlighted.gutter > 0, highlighted)
    const pathRow = await sheet.locator('.ql-path').textContent()
    check('the path row shows the path, the type, the line count and the size', /apps\/desktop\/src\/parser\.ts/u.test(pathRow) && /TypeScript · 7\d lines · \d/u.test(pathRow), { pathRow })
    const policy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'))
    check('the page policy is unchanged', policy === "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:", { policy })
    check('no worker was started', page.workers().length === 0, { workers: page.workers().length })
    const pageViolations = await page.evaluate(() => window.__qlViolations ?? [])
    check('no policy violation reached the console or the page', violations.length === 0 && pageViolations.length === 0, { violations, pageViolations })
    check('focus goes to the open file', await page.evaluate(() => !!document.activeElement?.closest('.ql-code')))
    const sideways = await sheet.locator('.ql-code .cm-scroller').evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, wrap: getComputedStyle(element.querySelector('.cm-content')).whiteSpace }))
    check('long lines scroll sideways, nothing wraps', sideways.scrollWidth > sideways.clientWidth && sideways.wrap === 'pre', sideways)
    await page.screenshot({ path: join(evidence, 'source.png') })

    // ---- file states ----
    const openRow = async (name) => {
      await sheet.locator('.ql-tr', { hasText: name }).first().click()
      await sheet.locator('.ql-path').filter({ hasText: name }).waitFor()
      await page.waitForTimeout(150)
    }
    await sheet.locator('.ql-tree').focus()
    await openRow('empty.txt')
    check('an empty file says so', (await sheet.locator('.ql-main').textContent()).includes('Empty file. Nothing to show.'))
    await openRow('archive.zip')
    const binary = await sheet.locator('.ql-main').textContent()
    check('a binary file shows type, size, modified time and path with Show in Folder and Copy path', /Binary/u.test(binary) && /Zip archive/u.test(binary) && /8 bytes/u.test(binary) && /Show in Folder/u.test(binary) && /Copy path/u.test(binary), { binary: binary.slice(0, 240) })
    await openRow('big.log')
    const large = await sheet.locator('.ql-main').textContent()
    check('a file over 2 MB shows its facts and no content', /Large/u.test(large) && /over 2 MB, not shown/u.test(large) && /2,097,153 bytes/u.test(large), { large: large.slice(0, 240) })
    await page.screenshot({ path: join(evidence, 'edge.png') })
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })

    // ---- the terminal is untouched: normal, focus and split views at five sizes ----
    const snapshot = () => page.evaluate((id) => window.__aitermTest.snapshot(id), sessionId)
    for (const layout of ['normal', 'focus', 'split']) {
      const action = page.locator('.session-terminal.selected .pane-actions button').filter({ hasText: layout === 'focus' ? 'Focus' : 'Split' })
      if (layout !== 'normal') await action.click()
      if (layout === 'split') {
        await page.locator('dialog[open]').getByRole('textbox').press('Enter')
        await page.waitForFunction(() => document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)').length === 2)
        await page.locator(`.session-terminal[data-session-id="${sessionId}"] .pane-heading strong`).click()
      }
      for (const [width, height] of SIZES) {
        await app.evaluate(({ BrowserWindow }, next) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(...next); w.show() }, [width, height])
        await page.waitForTimeout(400)
        await terminal.focus()
        const before = await snapshot()
        await page.keyboard.press('Control+Shift+E')
        await sheet.waitFor()
        // Below 940 px of sheet width the tree starts folded and the top field has focus.
        if (width - 32 >= 940) {
          await sheet.locator('.ql-tr').first().waitFor()
          await page.keyboard.press('ArrowDown')
          await page.keyboard.press('ArrowUp')
        } else {
          check(`${layout} ${width}×${height}: the tree starts folded and the top field has focus`, await sheet.locator('.ql-left').count() === 0 &&
            await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Go to file'))
        }
        await page.waitForTimeout(250)
        const during = await snapshot()
        await page.keyboard.press('Escape')
        await sheet.waitFor({ state: 'detached' })
        await page.waitForTimeout(250)
        const after = await snapshot()
        const same = (a) => a.cols === before.cols && a.rows === before.rows && a.refits === before.refits && a.ptyCols === before.ptyCols && a.ptyRows === before.ptyRows && a.inputEvents === before.inputEvents
        const ticking = Number(/tick (\d+)/u.exec(after.bufferLines.join(' '))?.[1] ?? 0) > Number(/tick (\d+)/u.exec(before.bufferLines.join(' '))?.[1] ?? 0)
        check(`${layout} ${width}×${height}: grid, refits, PTY size and input count unchanged; output kept flowing`, same(during) && same(after) && ticking, {
          before: { cols: before.cols, rows: before.rows, refits: before.refits, input: before.inputEvents },
          after: { cols: after.cols, rows: after.rows, refits: after.refits, input: after.inputEvents }
        })
      }
      if (layout !== 'normal') await action.click()
    }
    check('no byte reached the terminal program', readFileSync(input, 'utf8') === '')
    assert.ok(checks.every((each) => each.result === 'PASS'), 'a Quick look check failed')
    console.log('PASS: Quick look live run')
  } catch (error) {
    appendFileSync(join(evidence, 'error.txt'), `${error?.stack ?? error}\n`)
    throw error
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
    await app.close().catch(() => undefined)
  }
})
