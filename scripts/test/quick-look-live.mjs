/* global window, document, location, getComputedStyle, HTMLDialogElement, DataTransfer, ClipboardEvent */
// MODULE: quick-look-live.mjs - Epic 67's isolated Electron run of Quick look on a made-up project: the three ways in, a highlighted file under the unchanged page policy with no worker, the file states, the tree, find, go to line, changed on disk, the trail, the peek, the remembered place, go to file and contents search with the terminals' output timed, and no terminal resized or typed into
// The app runs in test mode with temporary HOME and XDG folders (removed at the end); the project, its files and the
// terminal program are made up here. Nothing leaves the machine and no file of the owner's is read. Prints PASS or
// FAIL per check and writes result.json and screenshots to the evidence folder.
// Usage: node scripts/test/quick-look-live.mjs [--binary <packaged bmn>]   (needs `pnpm run build` first without --binary)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
// Made-up secret values: none may appear in the page's text before Ctrl+R, in the test hook, or in any log.
const CANARY = 'canary-QL67-7f3kZq9-made-up'
const CANARY_TWO = 'canary-QL67-second-made-up'
const CANARY_JSON = 'canary-QL67-json-made-up'
const PAGE_KEY = 'sk-madeupQL67pagekey0123456789abcdef'
// A word only one made-up file holds, so a search's traces can be looked for in the app's folders afterwards.
const PROBE = 'QL67searchprobe'

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
  file('.gitignore', '.env\n')
  file('notes/probe.txt', `A made-up note holding ${PROBE} once.\n`)
  file('.env', `# made-up values\nMADEUP_API_KEY=${CANARY}\nMADEUP_PORT=made-up-port\nMADEUP_TOKEN=${CANARY_TWO}\n`)
  file('docs/plan.md', [
    '---', 'title: Made-up plan', '---', '# Made-up plan', '',
    'Text with *emphasis*, **strong**, ~~struck~~ and `inline code`. See [the site](https://example.invalid/page),',
    '[the parser](../apps/desktop/src/parser.ts:42) and [later](#later-section).', '',
    '> A made-up quote.', '', '- one', '- [x] done', '- [ ] open', '', '1. first', '2. second', '',
    `| Name | Note |`, '|:--|--:|', `| wide | ${'a very long made-up cell '.repeat(12)}|`, '', '---', '',
    '```ts', 'const answer: number = 42', '```', '',
    '<script>alert(1)</script>', '', '<img src="https://example.invalid/tracker.png">', '',
    '![A made-up diagram](images/diagram.png) and ![remote](https://example.invalid/remote.png)', '',
    `Key: ${PAGE_KEY} and made-up words.`, '', '```sh', `export TOKEN=${PAGE_KEY}`, '```', '',
    ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index}, made-up.\n`), '## Later section', '', ...Array.from({ length: 40 }, (_, index) => `After the heading ${index}.\n`), 'The end.', ''
  ].join('\n'))
  file('docs/big.md', `# Big\n\n${'A made-up line of a big Markdown file.\n'.repeat(14000)}`)
  file('docs/opencode.jsonc', `{\n  // made-up config\n  "model": "made-up/model",\n  "provider": { "options": { "apiKey": "${CANARY_JSON}" } }\n}\n`)
  file('empty.txt', '')
  writeFileSync(join(project, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x14, 0x00]))
  writeFileSync(join(project, 'big.log'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
}

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const project = join(root, 'project')
  const fixture = join(root, 'terminal.mjs')
  const input = join(root, 'input.txt')
  const outsideFile = join(root, 'outside.txt')
  writeFileSync(outsideFile, 'A made-up file outside the project.\nIts second line.\n')
  writeProject(project)
  // The project lies inside a made-up Git work tree whose root is the temporary folder, so the tree shows no `.git`
  // row and the contents search reads what Git tracks plus untracked files it does not ignore.
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
  // The terminal program counts what reaches it: nothing Quick look does may arrive here.
  writeFileSync(fixture, `import {appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);
process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));
process.stdout.write('PATHS apps/desktop/src/parser.ts:42:7 docs/missing.md:3 '+${JSON.stringify(outsideFile)}+':2\\r\\n');
let n=0;setInterval(()=>{n+=1;process.stdout.write('\\rQUICK LOOK FIXTURE tick '+n+'   ')},10);`)
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
  const navigations = []
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on('framenavigated', (frame) => navigations.push({ at: Date.now(), url: frame.url().slice(-60) }))
    page.on('load', () => navigations.push({ at: Date.now(), load: true }))
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
    // Every close of the sheet is recorded: one the browser makes by itself (a refused close request it made final)
    // would leave the app thinking the sheet is open.
    await page.evaluate(() => {
      window.__qlEvents = []
      window.addEventListener('keydown', (event) => window.__qlEvents.push({ at: Date.now(), kind: `key ${event.ctrlKey ? 'Ctrl+' : ''}${event.key}` }), true)
      window.addEventListener('mousedown', (event) => window.__qlEvents.push({ at: Date.now(), kind: `mousedown ${event.ctrlKey ? 'Ctrl ' : ''}${event.target?.className ?? ''}`.slice(0, 80) }), true)
      const show = HTMLDialogElement.prototype.showModal
      HTMLDialogElement.prototype.showModal = function showModal(...args) {
        if (this.classList.contains('quick-look')) window.__qlEvents.push({ at: Date.now(), kind: 'showModal()' })
        return show.apply(this, args)
      }
      const original = HTMLDialogElement.prototype.close
      HTMLDialogElement.prototype.close = function close(...args) {
        if (this.classList.contains('quick-look')) window.__qlEvents.push({ at: Date.now(), kind: 'close()', stack: new Error().stack.split('\n').slice(1, 6).join(' | ') })
        return original.apply(this, args)
      }
      for (const kind of ['cancel', 'close']) {
        document.addEventListener(kind, (event) => {
          if (event.target?.classList?.contains('quick-look')) window.__qlEvents.push({ at: Date.now(), kind, cancelable: event.cancelable, activation: navigator.userActivation?.isActive })
        }, true)
      }
    })
    await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await page.waitForFunction((id) => window.__aitermTest?.snapshot(id)?.bufferLines.some((line) => line.includes('QUICK LOOK FIXTURE')), sessionId)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(0, 0); w.setContentSize(1408, 880); w.show() })
    const sheet = page.locator('dialog.quick-look[open]')
    const snapshot = () => page.evaluate((id) => window.__aitermTest.snapshot(id), sessionId)
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
    await sheet.locator('.ql-head .ql-root-name').waitFor()
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

    // ---- Story 67.2: find, go to line, changed on disk, the trail, the peek and the remembered place ----
    const topLine = () => sheet.evaluate((element) => {
      const top = element.querySelector('.cm-scroller').getBoundingClientRect().top
      const shown = [...element.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter((each) => each.offsetHeight > 0 && each.textContent)
      // The first line with any part in view, as the sheet counts the top line it keeps.
      return Number(shown.find((each) => each.getBoundingClientRect().bottom > top + 0.5)?.textContent ?? 0)
    })
    const lineVisible = (text) => sheet.evaluate((element, wanted) => {
      const box = element.querySelector('.cm-scroller').getBoundingClientRect()
      const line = [...element.querySelectorAll('.cm-line')].find((each) => each.textContent.startsWith(wanted))
      if (!line) return false
      const rect = line.getBoundingClientRect()
      return rect.top >= box.top && rect.bottom <= box.bottom
    }, text)
    const footerText = () => sheet.locator('.ql-hints').textContent()
    await openRow('parser.ts')
    await sheet.locator('.ql-code .cm-content').click()
    await page.keyboard.press('Control+f')
    await sheet.locator('.ql-find input[aria-label="Find in file"]').waitFor()
    check('Ctrl+F opens a find row with focus in it', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Find in file'))
    await page.keyboard.type('value1')
    const count = () => sheet.locator('.ql-find .ql-count').textContent()
    // Find starts at the first match from the caret, so the count reads "N of 11".
    const ofEleven = () => page.waitForFunction(() => / of 11$/u.test(document.querySelector('dialog.quick-look .ql-find .ql-count')?.textContent ?? ''))
    await ofEleven()
    const first = await count()
    check('find counts "N of 11" for literal text', /^\d+ of 11$/u.test(first), { count: first })
    const at = (text) => Number(text.split(' ')[0])
    await page.keyboard.press('Enter')
    const second = await count()
    await page.keyboard.press('Shift+Enter')
    const back = await count()
    check('Enter goes to the next match and Shift+Enter to the previous, wrapping', at(second) === at(first) % 11 + 1 && back === first, { first, second, back })
    const plates = await sheet.evaluate((element) => {
      const mark = element.querySelector('.ql-match:not(.ql-match-current)')
      const current = element.querySelector('.ql-match-current')
      return { marks: element.querySelectorAll('.ql-match').length, plate: mark ? getComputedStyle(mark).backgroundColor : null,
        current: current ? getComputedStyle(current).backgroundColor : null, text: current ? getComputedStyle(current).color : null,
        plain: getComputedStyle(element.querySelector('.cm-line')).color }
    })
    check('matches are marked by plates, the text keeps its grey', plates.marks > 1 && plates.plate && plates.plate !== 'rgba(0, 0, 0, 0)' && plates.current !== plates.plate, plates)
    await sheet.locator('.ql-find input').fill('VALUE1')
    await ofEleven()
    await page.keyboard.press('Alt+c')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-find .ql-count')?.textContent === 'No matches')
    const caseOn = await sheet.locator('.ql-toggle').getAttribute('aria-pressed')
    await page.keyboard.press('Alt+c')
    await ofEleven()
    check('"Aa" matches case only when it is on', caseOn === 'true', { caseOn })
    await page.keyboard.press('Enter')
    const currentText = await sheet.evaluate((element) => element.querySelector('.ql-match-current')?.closest('.cm-line')?.textContent ?? '')
    const footerFind = await footerText()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    const afterFind = { row: await sheet.locator('.ql-find').count(), open: await sheet.count(), inFile: await page.evaluate(() => !!document.activeElement?.closest('.ql-code')),
      current: currentText !== '' && await lineVisible(currentText), footer: await footerText() }
    check('Esc closes the find row first, leaves the file at the current match, and the footer says what Esc does', afterFind.row === 0 && afterFind.open === 1 && afterFind.inFile &&
      afterFind.current && /Close find/u.test(footerFind) && /EscClose/u.test(afterFind.footer.replace(/\s/gu, '')), { ...afterFind, footerFind })

    await page.keyboard.press('Control+g')
    await sheet.locator('input[aria-label="Go to line"]').waitFor()
    await page.keyboard.type('44:7')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    check('Ctrl+G goes to a line and a column (44:7)', await sheet.locator('input[aria-label="Go to line"]').count() === 0 && await lineVisible('export const value35 '))

    // Changed on disk: the file is rewritten while shown; the row offers a reload that keeps the top line.
    await page.keyboard.press('Control+g')
    await page.keyboard.type('60')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const topBefore = await topLine()
    const parser = join(project, 'apps/desktop/src/parser.ts')
    writeFileSync(parser, `${readFileSync(parser, 'utf8')}export const added = 1\n`)
    await page.bringToFront()
    await sheet.locator('.ql-changed').waitFor({ timeout: 6000 })
    const changedRow = (await sheet.locator('.ql-changed').textContent()).replace(/\s+/gu, ' ')
    check('a file rewritten while shown gives "Changed on disk · Reload" (F5) and nothing reloads by itself', /Changed on disk · Reload/u.test(changedRow) && /7\d lines/u.test(await sheet.locator('.ql-path').textContent()), { changedRow })
    const linesBefore = await sheet.locator('.ql-path').textContent()
    await page.keyboard.press('F5')
    await page.waitForFunction((before) => document.querySelector('dialog.quick-look .ql-path')?.textContent !== before, linesBefore)
    await page.waitForTimeout(200)
    const topAfter = await topLine()
    check('F5 reloads the file and keeps the top visible line', await sheet.locator('.ql-changed').count() === 0 && topAfter === topBefore && topBefore > 1, { topBefore, topAfter })

    // The trail: open another file, Alt+← returns to the previous file and line, Alt+→ goes forward again.
    const parserTop = await topLine()
    await openRow('README.md')
    const withBack = /Back/u.test(await footerText())
    await page.keyboard.press('Alt+ArrowLeft')
    await sheet.locator('.ql-path').filter({ hasText: 'parser.ts' }).waitFor()
    await page.waitForTimeout(200)
    const returnedTo = await topLine()
    await page.keyboard.press('Alt+ArrowRight')
    await sheet.locator('.ql-path').filter({ hasText: 'README.md' }).waitFor()
    check('Alt+← returns to the previous file at the line he left, Alt+→ goes forward', withBack && returnedTo === parserTop && returnedTo > 1, { parserTop, returnedTo, withBack })
    await page.keyboard.press('Alt+ArrowLeft')
    await sheet.locator('.ql-path').filter({ hasText: 'parser.ts' }).waitFor()
    await page.waitForTimeout(200)

    // The peek: holding F8 shows the terminals behind; no key reaches the sheet or a terminal; release restores.
    // A query whose one match is low in the file, so the peek starts scrolled down.
    await sheet.locator('.ql-code .cm-content').focus()
    await page.keyboard.press('Control+f')
    await sheet.locator('.ql-find input').fill('Splits')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-find .ql-count')?.textContent === '1 of 1')
    await page.waitForTimeout(150)
    const queryBefore = await sheet.locator('.ql-find input').inputValue()
    const peekBefore = { top: await topLine(), snap: await snapshot(), scroll: await sheet.locator('.cm-scroller').evaluate((element) => element.scrollTop) }
    await page.keyboard.down('F8')
    await page.waitForTimeout(100)
    const peekState = await sheet.evaluate((element) => ({
      peeking: element.classList.contains('peeking'), label: element.querySelector('.ql-peek')?.textContent ?? '',
      backdrop: getComputedStyle(element, '::backdrop').backgroundColor, shadow: getComputedStyle(element).boxShadow,
      content: getComputedStyle(element.querySelector('.ql-body')).opacity, outline: getComputedStyle(element).outlineStyle
    }))
    await page.keyboard.press('a')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+E')
    await page.waitForTimeout(700)
    const peekDuring = await snapshot()
    await page.keyboard.up('F8')
    await page.waitForTimeout(200)
    const tick = (snap) => Number(/tick (\d+)/u.exec(snap.bufferLines.join(' '))?.[1] ?? 0)
    const peekAfter = { open: await sheet.count(), peeking: await sheet.evaluate((element) => element.classList.contains('peeking')), top: await topLine(),
      scroll: await sheet.locator('.cm-scroller').evaluate((element) => element.scrollTop), query: await sheet.locator('.ql-find input').inputValue(),
      inFind: await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Find in file') }
    check('holding F8 hides the content, its shadow and the backdrop and leaves a hairline outline with "Peeking · release F8 to return"',
      peekState.peeking && peekState.label === 'Peeking · release F8 to return' && peekState.backdrop === 'rgba(0, 0, 0, 0)' && peekState.shadow === 'none' && peekState.content === '0' && peekState.outline === 'solid', peekState)
    check('the terminal keeps painting during a peek and no key pressed reaches it or the sheet', tick(peekDuring) > tick(peekBefore.snap) && peekDuring.inputEvents === peekBefore.snap.inputEvents && peekAfter.open === 1,
      { before: tick(peekBefore.snap), during: tick(peekDuring), input: [peekBefore.snap.inputEvents, peekDuring.inputEvents] })
    check('releasing F8 restores the same file, scroll position, query and focus', !peekAfter.peeking && peekAfter.scroll === peekBefore.scroll && peekBefore.scroll > 0 && peekAfter.query === queryBefore && peekAfter.inFind,
      { before: peekBefore.scroll, queryBefore, ...peekAfter })
    await page.keyboard.down('F8')
    await page.waitForTimeout(100)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(100)
    const blurred = await sheet.evaluate((element) => element.classList.contains('peeking'))
    await page.keyboard.up('F8')
    check('the window losing focus ends a peek', !blurred)
    await page.keyboard.press('Escape')

    // The remembered place: closing and opening again returns to the file, its top line, the open folders and the search.
    // Typing a query walks through its matches, so the place is taken after the search, just before closing.
    await page.keyboard.press('Control+f')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('needle')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+g')
    await page.keyboard.type('60')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const placeTop = await topLine()
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    await page.keyboard.press('Control+Shift+E')
    await sheet.locator('.ql-path').filter({ hasText: 'parser.ts' }).waitFor()
    await sheet.locator('.ql-code .cm-content').waitFor()
    await page.waitForTimeout(250)
    const recalledTop = await topLine()
    check('the footer shows Back only when there is somewhere to go', !/Back/u.test(await footerText()), { footer: await footerText() })
    const treeNames = await sheet.locator('.ql-tr .ql-nm').allTextContents()
    await page.keyboard.press('Control+f')
    const recalledQuery = await sheet.locator('.ql-find input').inputValue()
    await page.keyboard.press('Escape')
    check('opening Quick look on the root returns to the last file, its top line, the open folders and the last search',
      recalledTop === placeTop && placeTop > 1 && treeNames.includes('parser.ts') && recalledQuery === 'needle', { placeTop, recalledTop, recalledQuery, folders: treeNames.includes('parser.ts') })
    // Each opening lists the root afresh, so a file made now is in the tree when the sheet opens again.
    writeFileSync(join(project, 'gone.txt'), 'soon gone\n')
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor({ state: 'detached' })
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await openRow('gone.txt')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    rmSync(join(project, 'gone.txt'))
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await sheet.locator('.ql-empty').filter({ hasText: 'no longer there' }).waitFor()
    check('a remembered file that no longer exists opens the tree with one line saying so', (await sheet.locator('.ql-empty').textContent()) === 'The last file, gone.txt, is no longer there.' &&
      await page.evaluate(() => document.activeElement?.classList.contains('ql-tree') === true), { line: await sheet.locator('.ql-empty').textContent() })
    await page.screenshot({ path: join(evidence, 'place.png') })

    // ---- Story 67.3: a secret stays masked until he asks (made-up canary values only) ----
    const pageText = () => sheet.evaluate((element) => element.innerText)
    const hook = () => page.evaluate(() => window.__aitermQuickLook?.snapshot() ?? null)
    const caretTo = async (line) => {
      await page.keyboard.press('Control+g')
      await page.keyboard.type(String(line))
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
    }
    const shownCount = () => sheet.locator('.ql-secret-note.shown').count()
    await openRow('.env')
    await sheet.locator('.ql-code .ql-secret').first().waitFor()
    const envState = { text: await pageText(), plates: await sheet.locator('.ql-code .ql-secret').count(), hook: await hook(),
      labels: await sheet.locator('.ql-code .ql-secret').evaluateAll((all) => all.map((each) => each.getAttribute('aria-label'))),
      notes: await sheet.locator('.ql-secret-note').allTextContents() }
    check('a .env file opens with every value masked: no value in the page\'s text, one plate per value',
      !envState.text.includes(CANARY) && !envState.text.includes(CANARY_TWO) && !envState.text.includes('made-up-port') && envState.plates === 3 && envState.text.includes('MADEUP_API_KEY'),
      { plates: envState.plates })
    check('a plate\'s accessible name is "hidden value" with its length, and its length shows at the edge of its line',
      envState.labels[0] === `hidden value, ${CANARY.length} characters` && envState.notes.includes(`${CANARY.length} chars`), { labels: envState.labels, notes: envState.notes })
    check('the test hook returns the masked text', envState.hook?.text?.includes('[secret hidden]') && !envState.hook.text.includes(CANARY) && !JSON.stringify(envState.hook).includes(CANARY),
      { hidden: envState.hook?.hidden })
    await sheet.locator('.ql-code .cm-content').focus()
    await page.keyboard.press('Control+a')
    const copied = await sheet.locator('.ql-code .cm-content').evaluate((content) => {
      const data = new DataTransfer()
      content.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    })
    check('copying a selection that holds a masked value copies "[secret hidden]" in its place', copied.includes('MADEUP_API_KEY=[secret hidden]') && !copied.includes(CANARY), { copied })
    await page.keyboard.press('Control+f')
    await sheet.locator('.ql-find input').fill('CANARY')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-find .ql-count')?.textContent === 'No matches')
    await sheet.locator('.ql-find input').fill('MADEUP')
    await page.waitForFunction(() => / of 3$/u.test(document.querySelector('dialog.quick-look .ql-find .ql-count')?.textContent ?? ''))
    check('find in the file neither matches inside a masked value nor counts it', true)
    await page.keyboard.press('Escape')

    await caretTo(2)
    await page.keyboard.press('Control+r')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-secret-note.shown') !== null)
    const revealedState = { text: await pageText(), note: await sheet.locator('.ql-secret-note.shown').textContent(), footer: await footerText() }
    await page.waitForTimeout(2100)
    const later = await sheet.locator('.ql-secret-note.shown').textContent()
    check('Ctrl+R on the caret\'s line shows its value for ten seconds with a countdown', revealedState.text.includes(CANARY) && revealedState.note === 'Shown · hides in 10 s' && /hides in [78] s/u.test(later),
      { note: revealedState.note, later })
    await caretTo(4)
    await page.keyboard.press('Control+r')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-secret-note.shown') !== null)
    const secondShown = await pageText()
    check('one value is shown at a time', secondShown.includes(CANARY_TWO) && !secondShown.includes(CANARY) && await shownCount() === 1)
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-secret-note.shown') === null, null, { timeout: 12_000 })
    check('it hides by itself after ten seconds', !(await pageText()).includes(CANARY_TWO))

    const hidesOn = async (name, act) => {
      await caretTo(2)
      await page.keyboard.press('Control+r')
      await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-secret-note.shown') !== null)
      const label = /Hide value/u.test(await footerText())
      await act()
      await page.waitForTimeout(150)
      return { name, hidden: !(await pageText()).includes(CANARY) && await shownCount() === 0, label }
    }
    const onEsc = await hidesOn('Esc', () => page.keyboard.press('Escape'))
    const sheetStays = await sheet.count()
    const onBlur = await hidesOn('blur', () => page.evaluate(() => window.dispatchEvent(new Event('blur'))))
    const onPeek = await hidesOn('peek', async () => { await page.keyboard.down('F8'); await page.waitForTimeout(100); await page.keyboard.up('F8') })
    const onLeave = await hidesOn('leaving the file', async () => {
      await openRow('README.md')
      await page.keyboard.press('Alt+ArrowLeft')
      await sheet.locator('.ql-path').filter({ hasText: '.env' }).waitFor()
      await sheet.locator('.ql-code .ql-secret').first().waitFor()
    })
    check('a shown value hides on Esc (which says so first), on window blur, on a peek and on leaving the file',
      onEsc.hidden && onEsc.label && sheetStays === 1 && onBlur.hidden && onPeek.hidden && onLeave.hidden, { onEsc, onBlur, onPeek, onLeave })
    await sheet.locator('.ql-secret-note .ql-eye').first().click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-secret-note.shown') !== null)
    check('the eye at the edge of the line shows the value too', (await pageText()).includes(CANARY))
    await page.keyboard.press('Escape')

    await sheet.locator('.ql-tr', { hasText: 'docs' }).first().click()
    await sheet.locator('.ql-tr', { hasText: 'opencode.jsonc' }).waitFor()
    await openRow('opencode.jsonc')
    await sheet.locator('.ql-code .ql-secret').first().waitFor()
    const jsonc = await pageText()
    check('a JSONC file masks a value whose name says so and shows the rest', !jsonc.includes(CANARY_JSON) && jsonc.includes('"apiKey"') && jsonc.includes('made-up/model') &&
      await sheet.locator('.ql-code .ql-secret').count() === 1, { plates: await sheet.locator('.ql-code .ql-secret').count() })
    await page.screenshot({ path: join(evidence, 'masked.png') })

    // ---- Story 67.4: Markdown reads as a page ----
    // The app's clipboard writes go to a recorder for this run, so the owner's clipboard is never touched.
    await app.evaluate(({ clipboard }) => {
      globalThis.__qlClipboard = []
      clipboard.writeText = (text) => { globalThis.__qlClipboard.push(text) }
    })
    const requests = []
    page.on('request', (request) => { if (!/^(?:file|devtools|data|blob|chrome-extension):/u.test(request.url())) requests.push(request.url()) })
    await sheet.locator('.ql-tr', { hasText: 'plan.md' }).first().click()
    await sheet.locator('.ql-page .ql-md h1').waitFor()
    const pageState = await sheet.evaluate((element) => {
      const md = element.querySelector('.ql-md')
      return {
        h1: md.querySelector('h1')?.textContent, h2: md.querySelectorAll('h2').length, strong: md.querySelectorAll('strong').length, em: md.querySelectorAll('em').length,
        strike: md.querySelectorAll('s').length, inline: md.querySelectorAll('.ql-md-code').length, pre: [...md.querySelectorAll('.ql-md-pre')].map((pre) => pre.querySelector('.ql-md-label')?.textContent ?? ''),
        coloured: md.querySelectorAll('.ql-md-pre .ql-syn-keyword').length, quote: md.querySelectorAll('blockquote').length, ol: md.querySelectorAll('ol').length,
        ul: md.querySelectorAll('ul').length, boxes: [...md.querySelectorAll('.ql-md-box')].map((box) => box.getAttribute('aria-label')), table: md.querySelectorAll('.ql-md-table table').length,
        rule: md.querySelectorAll('hr').length, links: md.querySelectorAll('.ql-md-a').length, hrefs: md.querySelectorAll('[href], img, iframe, script').length,
        images: [...md.querySelectorAll('.ql-md-img')].map((image) => image.textContent), raw: [...md.querySelectorAll('.ql-md-raw')].map((raw) => raw.textContent),
        width: Math.round(md.getBoundingClientRect().width), front: md.querySelector('.ql-md-pre')?.textContent ?? ''
      }
    })
    check('a Markdown file opens as a page: headings, emphasis, strong, strike-through, inline code, coloured code blocks, a quote, lists, task boxes, a table, a rule and links',
      pageState.h1 === 'Made-up plan' && pageState.h2 >= 1 && pageState.strong >= 1 && pageState.em >= 1 && pageState.strike === 1 && pageState.inline >= 1 &&
      pageState.pre.includes('ts') && pageState.coloured > 0 && pageState.quote === 1 && pageState.ol === 1 && pageState.ul >= 1 &&
      pageState.boxes.join('|') === 'done|not done' && pageState.table === 1 && pageState.rule === 1 && pageState.links >= 3, pageState)
    check('the page is a column of about 80 characters', pageState.width <= 660 && pageState.width >= 480, { width: pageState.width })
    check('a front-matter block shows as code', pageState.pre[0] === 'front matter' && pageState.front.includes('title: Made-up plan'), { front: pageState.front.slice(0, 60) })
    check('raw HTML and a script tag show as text; nothing on the page has an address, an image, a frame or a script', pageState.hrefs === 0 &&
      pageState.raw.some((raw) => raw.includes('<script>')) && pageState.raw.some((raw) => raw.includes('<img')), { raw: pageState.raw, hrefs: pageState.hrefs })
    check('an image is one line: "Image", its words and its path; no image is loaded', pageState.images.length === 2 && pageState.images[0].includes('Image') &&
      pageState.images[0].includes('A made-up diagram') && pageState.images[1].includes('https://example.invalid/remote.png'), { images: pageState.images })
    const tableWrap = await sheet.locator('.ql-md-table').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth, overflow: getComputedStyle(element).overflowX }))
    check('a wide table scrolls sideways inside its own box', tableWrap.scroll > tableWrap.client && tableWrap.overflow === 'auto', tableWrap)
    await page.screenshot({ path: join(evidence, 'markdown.png') })

    // An outside link shows its address; Enter copies it. Nothing opens a browser.
    const outside = sheet.locator('.ql-md-a[data-target="outside"]').first()
    await outside.focus()
    const status = await sheet.locator('.ql-page-status').textContent()
    await page.keyboard.press('Enter')
    await sheet.locator('.ql-feedback', { hasText: 'Address copied' }).waitFor()
    const clipboard = await app.evaluate(() => globalThis.__qlClipboard)
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    check('an outside link shows its address and Enter copies it with "Address copied"; no window or browser opens',
      status.includes('https://example.invalid/page') && clipboard.at(-1) === 'https://example.invalid/page' && windows === 1 && await page.evaluate(() => location.protocol) === 'file:',
      { status, clipboard, windows })
    // A link to a heading of the same file scrolls there.
    await sheet.locator('.ql-md-a[data-target="heading"]').first().click()
    await page.waitForTimeout(200)
    const headingTop = await sheet.evaluate((element) => {
      const box = element.querySelector('.ql-page').getBoundingClientRect()
      return Math.round(element.querySelector('[data-slug="later-section"]').getBoundingClientRect().top - box.top)
    })
    check('a link to a heading of the same file scrolls there', Math.abs(headingTop) <= 4, { headingTop })

    // M switches to source and back; the choice stays with the file.
    await sheet.locator('.ql-page').focus()
    await page.keyboard.press('m')
    await sheet.locator('.ql-code .cm-content').waitFor()
    const sourceFooter = await footerText()
    await openRow('README.md')
    await openRow('plan.md')
    await sheet.locator('.ql-code .cm-content').waitFor()
    const keptSource = await sheet.locator('.ql-page').count() === 0
    await sheet.locator('.ql-code .cm-content').focus()
    await page.keyboard.press('m')
    await sheet.locator('.ql-page .ql-md h1').waitFor()
    check('M switches between Rendered and Source, the footer says so, and the choice is kept for the file', keptSource && /Rendered \/ source/u.test(sourceFooter) &&
      await sheet.locator('.ql-mode button.on').textContent() === 'Rendered', { keptSource })

    // Masking and find work on the page as in source.
    const renderedText = await sheet.locator('.ql-page').innerText()
    check('a secret-shaped value is masked on the page, in text and in a code block', !renderedText.includes(PAGE_KEY) && await sheet.locator('.ql-page .ql-secret').count() === 2,
      { plates: await sheet.locator('.ql-page .ql-secret').count() })
    await page.keyboard.press('Control+f')
    await sheet.locator('.ql-find input').fill('made-up')
    await page.waitForFunction(() => / of \d+$/u.test(document.querySelector('dialog.quick-look .ql-find .ql-count')?.textContent ?? ''))
    const pageFind = { count: await sheet.locator('.ql-find .ql-count').textContent(), marks: await sheet.locator('.ql-page mark.ql-match').count(), current: await sheet.locator('.ql-page mark.ql-match-current').count() }
    await page.keyboard.press('Escape')
    check('find in the file works on the page: a count, marks and a current match', /^1 of \d+$/u.test(pageFind.count) && pageFind.marks >= 2 && pageFind.current === 1, pageFind)

    // A relative link opens its file in Quick look at its line, marked.
    await sheet.locator('.ql-md-a[data-target="file"]').first().click()
    await sheet.locator('.ql-path').filter({ hasText: 'parser.ts' }).waitFor()
    await sheet.locator('.ql-code .cm-line.ql-target').waitFor()
    const target = await sheet.locator('.ql-code .cm-line.ql-target').textContent()
    check('a relative link with a line opens that file in Quick look at the line, marked', target.startsWith('export const value33 '), { target })
    await page.keyboard.press('Alt+ArrowLeft')
    await sheet.locator('.ql-page .ql-md h1').waitFor()
    // A Markdown file over 512 KiB opens as source with one line saying why.
    await openRow('big.md')
    await sheet.locator('.ql-code .cm-content').waitFor()
    check('a Markdown file over 512 KB opens as source with one line saying why', (await sheet.locator('.ql-note').allTextContents()).includes('Over 512 KB, so shown as source.') &&
      await sheet.locator('.ql-mode').count() === 0)
    const pagePolicyViolations = await page.evaluate(() => window.__qlViolations ?? [])
    check('no network request and no policy violation while a document with remote images and links is open', requests.length === 0 && violations.length === 0 && pagePolicyViolations.length === 0,
      { requests, violations, pagePolicyViolations })
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })

    // ---- go to file and search contents (Story 67.5) ----
    const quick = () => page.evaluate(() => window.__aitermQuickLook?.snapshot())
    /** Waits for the search state to satisfy `test`; on a timeout the error carries the state it saw. */
    const waitSearch = async (test, arg, timeout = 15_000) => {
      try {
        await page.waitForFunction(test, arg, { timeout })
      } catch (error) {
        const state = await quick().catch(() => null)
        throw new Error(`${error.message}; search state ${JSON.stringify(state?.search ?? null).slice(0, 1500)}`, { cause: error })
      }
    }
    const searchDone = () => page.waitForFunction(() => { const state = window.__aitermQuickLook?.snapshot().search; return !!state && state.fresh && !state.searching && !!state.header })
    const activeLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className ?? null)
    const dataBefore = []
    const listFiles = (folder, into) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) listFiles(path, into)
        else if (entry.isFile()) into.push(path)
      }
      return into
    }
    listFiles(roots.data, dataBefore)
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await page.keyboard.press('Control+p')
    check('Ctrl+P puts focus in "Go to file"', await activeLabel() === 'Go to file')
    await page.keyboard.type('parser')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'parser' && state.fresh && !state.searching && !!state.header })
    const named = await quick()
    check('Go to file lists files by name in the left column', named.search.mode === 'files' && named.search.header.count === '1 file' &&
      await sheet.locator('.ql-left.ql-searching .ql-rf-name').first().textContent() === 'parser.ts', { header: named.search.header, rows: named.search.rows })
    await page.keyboard.press('Enter')
    await sheet.locator('.ql-code .cm-content').waitFor()
    check('Enter opens the file found by name, with the keys in it', (await quick()).path?.endsWith('/parser.ts') && await page.evaluate(() => !!document.activeElement?.closest('.ql-code')))
    await page.keyboard.press('Escape')
    check('Esc from a file opened from results goes back to them', await activeLabel() === 'Go to file' && await sheet.locator('.ql-searching').count() === 1)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.activeElement?.classList.contains('ql-tree'))
    check('Esc again clears the search and goes back to the tree', await sheet.locator('.ql-searching').count() === 0)

    await page.keyboard.press('Control+Shift+G')
    check('Ctrl+Shift+G in the sheet switches the top field to Contents, with Aa and W off', await activeLabel() === 'Search contents' &&
      await sheet.locator('.ql-in .ql-toggle[aria-pressed="true"]').count() === 0 && await sheet.locator('.ql-in .ql-toggle').count() === 2)
    await page.keyboard.type('v')
    await sheet.locator('.ql-results-status').filter({ hasText: 'Type at least 2 characters' }).waitFor()
    check('one character asks for two', true)
    await page.keyboard.type('alue1')
    await searchDone()
    const contents = await quick()
    check('a search counts matches, files and files read, and says ignored files were skipped', contents.search.header.count === '11 matches in 1 file' &&
      /^\d+ files read · \d+\.\d s$/u.test(contents.search.header.read) && contents.search.header.notes.includes('Files Git ignores were skipped.'), { header: contents.search.header })
    check('the footer shows the search keys', /Match.*Open at line.*Case.*Whole word.*Back to tree/u.test(await footerText()), { footer: await footerText() })
    await page.keyboard.press('Alt+w')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.wholeWord && state.fresh && !state.searching && state.header?.count === '1 match in 1 file' })
    check('W (Alt+W) matches whole words only', true)
    await page.keyboard.press('Alt+w')
    await page.keyboard.press('Alt+c')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('VALUE1')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.matchCase && state.query === 'VALUE1' && state.fresh && !state.searching && state.header?.count === 'No matches' })
    check('Aa (Alt+C) matches case', true)
    await page.keyboard.press('Alt+c')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('value1')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return !state?.matchCase && state?.query === 'value1' && state.fresh && !state.searching && state.header?.count === '11 matches in 1 file' })
    await page.keyboard.press('ArrowDown')
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.opened === 'Match 2 of 11')
    await sheet.locator('.ql-code .cm-content').waitFor()
    check('↓ shows the next match in the file and the keys stay in the field', await activeLabel() === 'Search contents' &&
      (await sheet.locator('.ql-path').textContent()).includes('Match 2 of 11'))
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !!document.activeElement?.closest('.ql-code'))
    await page.waitForFunction(() => document.querySelectorAll('dialog.quick-look .ql-code .ql-match-current').length === 1)
    const opened = await quick()
    check('Enter opens the file at that line with the match marked and "Match 2 of 11"', opened.search.opened === 'Match 2 of 11' &&
      (await sheet.locator('.ql-code .ql-match-current').textContent()) === 'value1' && /parser\.ts:\d+/u.test(await sheet.locator('.ql-path').textContent()), { opened: opened.search.opened, mark: opened.search.mark })
    await sheet.locator('button[aria-label="Next match"]').click()
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.opened === 'Match 3 of 11')
    check('next goes to the following match', true)
    await page.screenshot({ path: join(evidence, 'search.png') })
    await sheet.locator('.ql-code .cm-content').focus()
    await page.keyboard.press('Escape')
    check('Esc goes back to the results', await activeLabel() === 'Search contents')

    await page.keyboard.press('Control+a')
    await page.keyboard.type('canary')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'canary' && state.fresh && !state.searching && !!state.header })
    const ignored = await quick()
    check('a word only an ignored .env holds is not found, and the header says why', ignored.search.header.count === 'No matches' &&
      ignored.search.header.notes.includes('Files Git ignores were skipped.'), { header: ignored.search.header })
    await page.keyboard.press('Control+a')
    await page.keyboard.type('made-up words')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'made-up words' && state.fresh && !state.searching && !!state.header })
    const masked = await quick()
    const maskedRows = await sheet.locator('.ql-results-list').textContent()
    check('a matching line is masked before it is shown', masked.search.rows.some((row) => row.includes('[secret hidden]')) && !JSON.stringify(masked).includes(PAGE_KEY) && !maskedRows.includes(PAGE_KEY),
      { rows: masked.search.rows })
    await page.keyboard.press('Control+a')
    await page.keyboard.type(PROBE)
    await waitSearch((probe) => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === probe && state.fresh && !state.searching && state.header?.count === '1 match in 1 file' }, PROBE)
    check('a word in an untracked file Git does not ignore is found', true)

    // 20,000 made-up files: the terminal's counter, printed every 10 ms, keeps arriving while they are searched.
    const bulk = join(project, 'zz-bulk')
    for (let group = 0; group < 100; group += 1) {
      mkdirSync(join(bulk, `g${group}`), { recursive: true })
      for (let index = 0; index < 200; index += 1) writeFileSync(join(bulk, `g${group}`, `f${index}.ts`), `export const value${index} = ${index}\n`)
    }
    const watchTicks = () => page.evaluate((id) => {
      window.__qlTicks = { last: null, at: performance.now(), gaps: [], stop: false }
      const read = () => {
        const state = window.__qlTicks
        if (state.stop) return
        const tick = /tick (\d+)/u.exec(window.__aitermTest.snapshot(id).bufferLines.join(' '))?.[1] ?? null
        const now = performance.now()
        if (tick !== state.last) {
          if (state.last !== null) state.gaps.push(now - state.at)
          state.last = tick
          state.at = now
        }
        setTimeout(read, 2)
      }
      read()
    }, sessionId)
    const stopTicks = () => page.evaluate(() => {
      window.__qlTicks.stop = true
      const gaps = window.__qlTicks.gaps
      return { changes: gaps.length, longest: Math.round(Math.max(0, ...gaps)), median: Math.round([...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0) }
    })
    await watchTicks()
    await page.waitForTimeout(1500)
    const quiet = await stopTicks()
    await page.keyboard.press('Control+a')
    await watchTicks()
    const startedAt = Date.now()
    await page.keyboard.type('zebra-made-up')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'zebra-made-up' && state.fresh && !state.searching && !!state.header }, undefined, 60_000)
    const during = await stopTicks()
    const timed = await quick()
    check('the terminal\'s counter shows no gap over 100 ms while 20,000 made-up files are searched', during.changes > 50 && during.longest <= 100,
      { quiet, during, searchMs: Date.now() - startedAt, read: timed.search.header.read })
    check('past 20,000 files the results say they are partial and name the limit', timed.search.header.count === 'No matches' &&
      timed.search.header.notes.includes('Partial results · limit reached: 20,000 files searched') && !/\ball\b|complete/iu.test(JSON.stringify(timed.search.header)), { header: timed.search.header })
    await page.keyboard.press('Control+a')
    await page.keyboard.type('zebra-stopped')
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.searching === true)
    await page.waitForTimeout(150)
    await page.keyboard.press('Escape')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'zebra-stopped' && state.fresh && !state.searching && !!state.header })
    const stopped = await quick()
    check('Esc stops a running search and the results say they are partial', stopped.search.header.notes.includes('Partial results · search stopped'), { header: stopped.search.header })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    rmSync(bulk, { recursive: true, force: true })
    await terminal.focus()
    await page.keyboard.press('Control+Shift+G')
    await sheet.waitFor()
    check('Ctrl+Shift+G from a terminal opens Quick look in Contents mode', await activeLabel() === 'Search contents')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    const dataAfter = listFiles(roots.data, [])
    const traces = []
    for (const folder of [...Object.values(roots), join(root, 'home')]) {
      for (const path of listFiles(folder, [])) if (statSync(path).size < 64 * 1024 * 1024 && readFileSync(path).includes(PROBE)) traces.push(path)
    }
    check('nothing is written under the data folder by a search, and the searched word is in no app file', dataAfter.filter((path) => !dataBefore.includes(path)).length === 0 && traces.length === 0,
      { added: dataAfter.filter((path) => !dataBefore.includes(path)), traces })

    // ---- a printed path opens in Quick look (Story 67.6) ----
    /** Where a printed text sits on the terminal's screen, in pixels, from its buffer row and column. */
    const cellOf = async (text, offset = 2) => page.evaluate(({ id, text, offset }) => {
      const state = window.__aitermTest.snapshot(id)
      const row = state.bufferLines.findIndex((line) => line.includes(text))
      if (row === -1) throw new Error(`not on screen: ${text}; cols ${state.cols}; lines ${JSON.stringify(state.bufferLines.filter(Boolean).slice(0, 6))}`)
      const column = state.bufferLines[row].indexOf(text) + offset
      const rect = document.querySelector(`.session-terminal[data-session-id="${id}"] .xterm-screen`).getBoundingClientRect()
      const width = rect.width / state.cols
      const height = rect.height / state.rows
      return { x: rect.left + (column + 0.5) * width, y: rect.top + (row + 0.5) * height, width, height }
    }, { id: sessionId, text, offset })
    const ctrlClick = async (text) => {
      const at = await cellOf(text)
      // From the row below, inside the terminal: xterm looks for links when the pointer reaches a new cell, so a
      // second click on the cell it last saw needs the pointer to arrive from another cell, as a hand's does.
      await page.mouse.move(at.x, at.y + at.height)
      await page.keyboard.down('Control')
      await page.mouse.move(at.x, at.y)
      await page.waitForTimeout(150)
      await page.mouse.click(at.x, at.y)
      await page.keyboard.up('Control')
    }
    const targetLine = () => sheet.locator('.ql-code .ql-target').textContent()
    await ctrlClick('apps/desktop/src/parser.ts:42:7')
    await sheet.locator('.ql-code .ql-target').waitFor()
    check('Ctrl+click on a printed relative path opens it in Quick look at line 42 with the line marked', (await targetLine()).includes('// line 42') &&
      (await sheet.locator('.ql-path .ql-pth').textContent()).trim() === 'apps/desktop/src/parser.ts:42', { target: await targetLine() })
    await sheet.getByRole('button', { name: 'More actions', exact: true }).click()
    const menuItems = await sheet.getByRole('menuitem').allTextContents()
    check('the path row\'s … menu holds Copy reference, Show in Folder and Send to session…', JSON.stringify(menuItems) === JSON.stringify(['Copy reference', 'Show in Folder', 'Send to session…']), { menuItems })
    await sheet.getByRole('menuitem', { name: 'Copy reference', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-feedback')?.textContent === 'Reference copied.')
    const copiedRef = (await app.evaluate(() => globalThis.__qlClipboard)).at(-1)
    check('Copy reference copies the absolute path, line and column, as the dialog does', copiedRef === `${project}/apps/desktop/src/parser.ts:42:7`, { copiedRef })
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    await ctrlClick(`${outsideFile}:2`)
    await sheet.locator('.ql-code .ql-target').waitFor()
    const outsideRow = await sheet.locator('.ql-path').textContent()
    check('a file outside the root opens too: no row is selected and the path row says Outside and the root', outsideRow.includes(`Outside ${project}`) &&
      await sheet.locator('.ql-tr.open').count() === 0 && (await targetLine()).includes('Its second line.'), { outsideRow })
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await page.keyboard.press('Control+p')
    await sheet.locator('[aria-label="Printed paths"] .ql-rf').first().waitFor()
    const printed = await sheet.locator('[aria-label="Printed paths"] .ql-rf .ql-rf-name').allTextContents()
    check('with the top field empty and in focus, the left column lists the paths the terminal printed, newest first', JSON.stringify(printed) === JSON.stringify(['outside.txt:2', 'missing.md:3', 'parser.ts:42']), { printed })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await sheet.locator('.ql-missing-title').waitFor()
    const missing = { title: await sheet.locator('.ql-missing-title').textContent(), from: await sheet.locator('.ql-missing-from').textContent(),
      choose: await sheet.getByRole('button', { name: 'Choose folder…', exact: true }).count() }
    check('a printed path that is gone opens as missing: "No file at this path", the folder it resolved from, and Choose folder…', missing.title === 'No file at this path' &&
      missing.from === `Resolved from ${project}, the session's launch folder.` && missing.choose === 1, missing)
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    // A selection that reads as one reference: Ctrl+Shift+E opens that file at its line.
    const start = await cellOf('apps/desktop/src/parser.ts:42:7', 0)
    const end = await cellOf('apps/desktop/src/parser.ts:42:7', 'apps/desktop/src/parser.ts:42:7'.length - 1)
    await page.mouse.move(start.x - start.width / 2 + 1, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x + end.width / 2 - 1, end.y, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.press('Control+Shift+E')
    await sheet.locator('.ql-code .ql-target').waitFor()
    check('Ctrl+Shift+E on a selected reference opens that file at its line', (await targetLine()).includes('// line 42'))
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    await page.evaluate((id) => window.__aitermTest.snapshot(id), sessionId)

    // ---- the sheet's states in Steel, Brown and Dark, for the eye (evidence only) ----
    const appearance = await page.evaluate(async () => (await window.aiTerminal.getSettings()).appearance)
    const shown = (name) => page.waitForFunction((end) => document.querySelector('dialog.quick-look .ql-path .ql-pth')?.title.endsWith(end), name)
    const goTo = async (query, name) => {
      await page.keyboard.press('Control+p')
      await page.keyboard.press('Control+a')
      await page.keyboard.type(query)
      await sheet.locator('.ql-rf').filter({ hasText: name }).first().waitFor()
      await page.keyboard.press('Enter')
      await shown(name)
      await page.waitForTimeout(300)
    }
    const themeShots = []
    const shoot = async (name) => { const path = join(evidence, name); await page.screenshot({ path }); themeShots.push(name) }
    for (const colorMode of ['steel', 'brown', 'dark']) {
      await page.evaluate(async (next) => window.aiTerminal.putSettings('appearance', next), { ...appearance, colorMode })
      await page.waitForFunction((mode) => document.documentElement.dataset.colorMode === mode, colorMode)
      // The terminal redraws in the new colours; its links are found again once the pointer moves over it.
      await terminal.focus()
      await page.waitForTimeout(400)
      await ctrlClick('apps/desktop/src/parser.ts:42:7')
      await sheet.locator('.ql-code .ql-target').waitFor()
      await sheet.getByRole('button', { name: 'More actions', exact: true }).click()
      await shoot(`theme-${colorMode}-code-menu.png`)
      await page.keyboard.press('Escape')
      await goTo('.env', '.env')
      await shoot(`theme-${colorMode}-masked.png`)
      await goTo('plan.md', 'plan.md')
      await shoot(`theme-${colorMode}-markdown.png`)
      if (colorMode === 'steel') {
        const ring = await sheet.locator('.ql-page').evaluate((element) => ({ focused: document.activeElement === element, outline: getComputedStyle(element).outlineStyle }))
        check('the Markdown page, focused, draws no ring around the whole column, as the source view draws none', ring.focused && ring.outline === 'none', ring)
      }
      await goTo('archive.zip', 'archive.zip')
      await shoot(`theme-${colorMode}-binary.png`)
      await page.keyboard.press('Control+Shift+G')
      await page.keyboard.press('Control+a')
      await page.keyboard.type('made-up')
      await sheet.locator('.ql-rl').first().waitFor()
      await page.waitForTimeout(300)
      await shoot(`theme-${colorMode}-contents.png`)
      await page.keyboard.press('Control+p')
      await page.keyboard.press('Control+a')
      await page.keyboard.press('Backspace')
      await sheet.locator('[aria-label="Printed paths"] .ql-rf').first().waitFor()
      await shoot(`theme-${colorMode}-recent.png`)
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await sheet.locator('.ql-missing-title').waitFor()
      await shoot(`theme-${colorMode}-missing.png`)
      // Esc steps back (missing view, results, tree) and then closes the sheet.
      for (let step = 0; step < 8 && await sheet.count(); step += 1) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      }
      await sheet.waitFor({ state: 'detached' })
    }
    await page.evaluate(async (next) => window.aiTerminal.putSettings('appearance', next), appearance)
    await page.waitForFunction((mode) => document.documentElement.dataset.colorMode === mode, appearance.colorMode)
    check('the sheet\'s states were drawn in Steel, Brown and Dark', themeShots.length === 21, { themeShots: themeShots.length })

    // ---- the terminal is untouched: normal, focus and split views at five sizes, through a peek ----
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
          // The root's remembered file opens again, so focus is in it once it is read, else in the top field.
          await page.waitForTimeout(400)
          const focus = await page.evaluate(() => ({
            file: !!document.querySelector('dialog.quick-look .ql-code'), inFile: !!document.activeElement?.closest('.ql-code'),
            inField: document.activeElement?.getAttribute('aria-label') === 'Go to file'
          }))
          check(`${layout} ${width}×${height}: the tree starts folded; focus is in the open file, else the top field`, await sheet.locator('.ql-left').count() === 0 &&
            (focus.file ? focus.inFile : focus.inField), focus)
        }
        await page.keyboard.down('F8')
        await page.waitForTimeout(250)
        await page.keyboard.up('F8')
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

    const dialogEvents = await page.evaluate(() => window.__qlEvents)
    const browserCloses = dialogEvents.filter((event, index) => event.kind === 'close' && dialogEvents[index - 1]?.kind !== 'close()')
    check('the browser never closed the sheet by itself; every Esc stayed with the sheet', browserCloses.length === 0 &&
      dialogEvents.every((event) => event.kind !== 'cancel' || event.cancelable), { browserCloses: browserCloses.length, cancels: dialogEvents.filter((event) => event.kind === 'cancel').length })
    // The made-up values reached no log or state file of the app's own folders.
    const leaks = []
    const walk = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && statSync(path).size < 64 * 1024 * 1024) {
          const bytes = readFileSync(path)
          if ([CANARY, CANARY_TWO, CANARY_JSON].some((value) => bytes.includes(value))) leaks.push(path)
        }
      }
    }
    for (const folder of [...Object.values(roots), join(root, 'home')]) walk(folder)
    check('no made-up secret value reached a log or a state file', leaks.length === 0, { leaks })
    // Send to session… from Quick look's menu ends in today's dialog and its "pasted, not submitted" receipt, into a
    // second made-up session (Story 67.6 AC2).
    const secondInput = join(root, 'second-input.txt')
    const secondFixture = join(root, 'second.mjs')
    writeFileSync(secondFixture, `import {appendFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(secondInput)},'');process.stdin.setRawMode(true);process.stdin.on('data',b=>appendFileSync(${JSON.stringify(secondInput)},b));process.stdout.write('SECOND FIXTURE ready\\r\\n');setInterval(()=>{},1000);`)
    const secondId = await page.evaluate(async (params) => {
      const workspace = (await window.aiTerminal.listWorkspaces())[0]
      return (await window.aiTerminal.createSession({ ...params, workspaceId: workspace.workspaceId })).session.sessionId
    }, { name: 'Second fixture', cwd: project, executable: process.execPath, argv: [secondFixture], cols: 80, rows: 24, backgroundChoice: 'stop' })
    // As at the start: the page is loaded again to show the new session, which starts when it is shown once.
    await page.reload()
    await page.locator(`.session-row > button[data-session-id="${secondId}"]`).click()
    await page.waitForFunction((id) => {
      try { return window.__aitermTest.snapshot(id).bufferLines.some((line) => line.includes('SECOND FIXTURE ready')) } catch { return false }
    }, secondId)
    // The reload replays the first terminal's screen, not every line it printed, so the file is opened by name.
    await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await page.waitForTimeout(300)
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await page.keyboard.press('Control+p')
    await page.keyboard.type('parser')
    await sheet.locator('.ql-rf').filter({ hasText: 'parser.ts' }).waitFor()
    await page.keyboard.press('Enter')
    await sheet.locator('.ql-code .cm-content').waitFor()
    await sheet.getByRole('button', { name: 'More actions', exact: true }).click()
    await sheet.getByRole('menuitem', { name: 'Send to session…', exact: true }).click()
    const referenceDialog = page.locator('dialog.file-reference-dialog[open]')
    const chooser = referenceDialog.getByRole('combobox', { name: 'Send to session' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Send to session')
    check('Send to session… opens today\'s dialog on that reference with the session chooser in focus', await sheet.count() === 0 &&
      await referenceDialog.locator('input[aria-label="File reference"]').inputValue() === `${project}/apps/desktop/src/parser.ts`)
    await chooser.selectOption(secondId)
    await referenceDialog.getByRole('button', { name: 'Review send…', exact: true }).click()
    await referenceDialog.getByRole('button', { name: 'Paste reference', exact: true }).click()
    await referenceDialog.locator('.file-reference-feedback').filter({ hasText: 'not submitted' }).waitFor()
    await page.waitForFunction(() => true)
    const pasted = readFileSync(secondInput, 'utf8')
    check('it ends in "pasted, not submitted", the reference in the other session\'s input and no Enter', pasted.includes(`${project}/apps/desktop/src/parser.ts`) && !/[\r\n]/u.test(pasted) &&
      readFileSync(input, 'utf8') === '', { pasted: JSON.stringify(pasted) })
    await page.keyboard.press('Escape')
    await referenceDialog.waitFor({ state: 'detached' })
    // A workspace pin opens in Quick look for its workspace, whose menu offers no Send to session… (Story 67.6 AC1).
    const pinned = `${project}/apps/desktop/src/parser.ts`
    const workspaceName = await page.evaluate(async () => (await window.aiTerminal.listWorkspaces())[0].name)
    // At this window's width the sidebar is a rail; a wider window shows the workspace row and its ⋯ on hover.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800))
    await page.locator('.workspace-row').filter({ hasText: workspaceName }).first().hover()
    await page.getByRole('button', { name: `Actions for ${workspaceName}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Pinned files…', exact: true }).click()
    const pins = page.getByRole('dialog', { name: `Pinned files — ${workspaceName}`, exact: true })
    await pins.getByRole('textbox', { name: 'Pinned file path' }).fill(pinned)
    await pins.getByRole('button', { name: 'Add path', exact: true }).click()
    await pins.getByRole('button', { name: `Open ${pinned}`, exact: true }).click()
    await sheet.locator('.ql-code .cm-content').waitFor()
    await sheet.getByRole('button', { name: 'More actions', exact: true }).click()
    const pinMenu = await sheet.getByRole('menuitem').allTextContents()
    check('a pin opens in Quick look for its workspace, with Copy reference and Show in Folder and no Send to session…',
      await sheet.locator('.ql-path .ql-pth').getAttribute('title') === pinned && JSON.stringify(pinMenu.map((item) => item.trim())) === JSON.stringify(['Copy reference', 'Show in Folder']), { pinMenu })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    assert.ok(checks.every((each) => each.result === 'PASS'), 'a Quick look check failed')
    console.log('PASS: Quick look live run')
  } catch (error) {
    const events = await app.windows()[0]?.evaluate(() => window.__qlEvents ?? []).catch(() => [])
    await app.windows()[0]?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
    console.log('Quick look dialog events', JSON.stringify(events?.slice(-40).map(({ at, kind, cancelable }) => ({ at, kind, cancelable }))), 'navigations', JSON.stringify(navigations))
    console.log('last close stacks', JSON.stringify(events?.filter((event) => event.stack).slice(-2).map(({ at, stack }) => ({ at, stack }))))
    appendFileSync(join(evidence, 'error.txt'), `${new Date().toISOString()} ${error?.stack ?? error}\n`)
    throw error
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
    await app.close().catch(() => undefined)
  }
})
