/* global window, document, getComputedStyle */
// MODULE: quick-look-live.mjs - Epic 67's isolated Electron run of Quick look on a made-up project: the three ways in, a highlighted file under the unchanged page policy with no worker, the file states, the tree, find, go to line, changed on disk, the trail, the peek, the remembered place, and no terminal resized or typed into
// The app runs in test mode with temporary HOME and XDG folders (removed at the end); the project, its files and the
// terminal program are made up here. Nothing leaves the machine and no file of the owner's is read. Prints PASS or
// FAIL per check and writes result.json and screenshots to the evidence folder.
// Usage: node scripts/test/quick-look-live.mjs [--binary <packaged bmn>]   (needs `pnpm run build` first without --binary)
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })

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
          check(`${layout} ${width}×${height}: the tree starts folded and the top field has focus`, await sheet.locator('.ql-left').count() === 0 &&
            await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Go to file'))
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
