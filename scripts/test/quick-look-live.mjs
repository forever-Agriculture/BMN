/* global window, document, location, getComputedStyle, HTMLDialogElement, DataTransfer, ClipboardEvent, DragEvent */
// MODULE: quick-look-live.mjs - Epic 67's isolated Electron run of Quick look on a made-up project: the three ways in, a highlighted file under the unchanged page policy with no worker, the file states, the tree, find, go to line, changed on disk, the trail, the peek, the remembered place, go to file and contents search with the terminals' output timed, and no terminal resized or typed into
// The app runs in test mode with temporary HOME and XDG folders (removed at the end); the project, its files and the
// terminal program are made up here. Nothing leaves the machine and no file of the owner's is read. Prints PASS or
// FAIL per check and writes result.json and screenshots to the evidence folder.
// Usage: node scripts/test/quick-look-live.mjs [--binary <packaged bmn>]   (needs `pnpm run build` first without --binary)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
// Story 68.1: a made-up value pasted into an edited .env file, and one another program writes meanwhile.
const PASTED = 'madeupQL68pastedValue0123456789'
const PASTED_TWO = 'madeupQL68secondPaste9876543210'
// Story 68.2: made-up config files edited in place; the JSONC one has Windows line endings, which Save keeps.
const PASTED_JSONC = 'madeupQL68jsoncPasted012'
const PASTED_YAML = 'madeupQL68yamlPasted0123'
const PASTED_TOML = 'madeupQL68tomlPasted0123'
const SETTINGS_JSONC = ['{', '  // made-up settings', '  "model": "made-up/model",', '  "apiKey": "madeupQL68jsoncOld000",', '  "retries": 2', '}', ''].join('\r\n')
// A made-up planning board in BMN's form; line 4 is the story a TODO is added to.
const BOARD = [
  '# made-up board', 'development_status:', '  epic-1: in-progress # a made-up note',
  '  1-2-browse-waiting-requests-with-arrow-keys: review',
  '  1-1-hide-secret-shaped-text-sent-to-telegram: done # keys and tokens named in a note',
  '  1-3-a-made-up-story-with-a-very-long-name-for-the-board: backlog', ''
].join('\n')
// A long made-up board, so a place far down the file can be kept across edit mode.
const LONG_BOARD = ['# made-up long board', ...Array.from({ length: 199 }, (_, index) => `  ${index + 2}-made-up-long-row: done`), ''].join('\n')
const EDITED_ENV = '# made-up config\nexport MADEUP_HOST=made-up.example\nMADEUP_SECRET="madeupQL68oldValue"\n\nMADEUP_MODE=dev\n'
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
  // Read-only, so it opens as masked text (Story 67.3); config/app.env is the one Quick look may edit (Story 68.1).
  chmodSync(join(project, '.env'), 0o444)
  file('config/app.env', EDITED_ENV)
  chmodSync(join(project, 'config/app.env'), 0o640)
  file('config/multi.env', 'MADEUP_OK=1\nMADEUP_BLOCK="made-up\nsecond line"\n')
  file('config/settings.jsonc', SETTINGS_JSONC)
  file('config/app.yaml', 'name: made-up\ntoken: madeupQL68yamlOld0000\n')
  file('config/app.toml', 'title = "made-up"\napi_key = \'madeupQL68tomlOld0000\'\n')
  file('config/locked.json', '{"a": 1}\n')
  // A planning board as BMN keeps one (plan/status.yaml): long story names, some with secret-sounding words, all readable.
  file('docs/plan/status.yaml', BOARD)
  file('docs/plan/long.yaml', LONG_BOARD)
  chmodSync(join(project, 'config/locked.json'), 0o444)
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
    ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index}, made-up.\n`), '## Later section', '', ...Array.from({ length: 40 }, (_, index) => `After the heading ${index}.\n`), 'The end.', '',
    `![drawn ${PAGE_KEY}](images/d.png) and [keyed](https://example.invalid/?k=${PAGE_KEY})`, ''
  ].join('\n'))
  file('docs/big.md', `# Big\n\n${'A made-up line of a big Markdown file.\n'.repeat(14000)}`)
  // Files at the caps, dense with made-up values: a source file just under 2 MiB and a Markdown page just under 512 KiB.
  const denseLine = (index) => `const k${index} = "sk-madeupDENSE${String(index).padStart(6, '0')}abcdefghij" // token=madeupDENSEvalue${index} eyJaa.bb.cc${index}\n`
  let dense = ''
  for (let index = 0; dense.length + 120 < 2 * 1024 * 1024; index += 1) dense += denseLine(index)
  file('dense.ts', dense)
  let densePage = '# Dense made-up page\n\n'
  for (let index = 0; densePage.length + 400 < 512 * 1024; index += 1) {
    densePage += index % 20 === 0
      ? `\`\`\`ts\nconst t${index} = "sk-madeupDENSE${index}abcdefghijklmnop" // password: madeupDENSEpw${index}\n\`\`\`\n\n`
      : `Paragraph ${index} with sk-madeupDENSE${index}abcdefghijklmnop and token=madeupDENSEvalue${index} and [a link](https://example.invalid/?k=sk-madeupDENSE${index}abcdefghijklmnop).\n\n`
  }
  file('docs/dense.md', densePage)
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
  // A made-up folder "Choose folder…" picks for a printed path that is missing from the launch folder.
  const altFolder = join(root, 'alt')
  mkdirSync(join(altFolder, 'docs'), { recursive: true })
  writeFileSync(join(altFolder, 'docs', 'missing.md'), 'Alt line one.\nAlt line two.\nAlt line three, found.\n')
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
    /** Each terminal on screen, by session. */
    const visibleSnapshots = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)')]
      .map((pane) => pane.getAttribute('data-session-id')).filter(Boolean).map((id) => [id, window.__aitermTest.snapshot(id)])))
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
    check('folders first, then files by name, hidden and generated names listed', names.slice(0, 5).join('|') === 'apps/desktop|config|dist|docs|node_modules' && names.includes('empty.txt'), { names })
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
    // The Reload button by mouse: same length and lines, so the checks below see the same file.
    writeFileSync(parser, readFileSync(parser, 'utf8').replace('export const added = 1\n', 'export const added = 2\n'))
    await sheet.locator('.ql-changed').waitFor({ timeout: 6000 })
    await sheet.locator('.ql-changed button', { hasText: 'Reload' }).click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-changed') === null)
    await page.waitForTimeout(200)
    const reloaded = { text: await page.evaluate(() => window.__aitermQuickLook?.snapshot().text?.includes('export const added = 2') === true), keys: await page.evaluate(() => !!document.activeElement?.closest('dialog.quick-look .ql-code')) }
    check('the Reload button reloads the file, and the keys stay in it', reloaded.text && reloaded.keys, reloaded)

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
    check('a .env file Quick look may not write says why where Edit would be (Story 68.1 AC9)', (await sheet.locator('.ql-read-only').textContent()) === 'Read-only · not writable')
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
    const dragged = await sheet.locator('.ql-code .cm-content').evaluate((content) => {
      const data = new DataTransfer()
      content.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    })
    check('dragging that selection out carries "[secret hidden]" too', dragged.includes('MADEUP_API_KEY=[secret hidden]') && !dragged.includes(CANARY), { dragged })
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

    // ---- Story 68.1: paste a made-up key into a .env file and save it ----
    const envPath = join(project, 'config/app.env')
    const envBar = () => sheet.locator('.ql-save').first().innerText().catch(() => '')
    const pasteInto = (text) => page.evaluate((value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)
    const active = () => page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent, type: document.activeElement?.getAttribute('type') }))
    const lastFacts = () => sheet.locator('.ql-path .ql-facts').last().textContent()
    await sheet.locator('.ql-tr', { hasText: 'config' }).first().click()
    await sheet.locator('.ql-tr', { hasText: 'multi.env' }).waitFor()
    await openRow('multi.env')
    check('a .env file with a multi-line value opens masked, with the reason where Edit would be', await sheet.locator('.ql-env-row').count() === 0 &&
      (await sheet.locator('.ql-read-only').textContent()) === 'Read-only · this file has a multi-line value')
    await openRow('app.env')
    await sheet.locator('.ql-env-row').first().waitFor()
    const rowsState = { text: await pageText(), rows: await sheet.locator('.ql-env-row').count(), comments: await sheet.locator('.ql-env-comment').count(),
      facts: await lastFacts(), hook: await hook() }
    check('an editable .env file opens as rows: names, masked values with their length, the comment kept, and "3 keys · owner and group"',
      rowsState.rows === 3 && rowsState.comments === 1 && rowsState.facts === '3 keys · owner and group' && rowsState.text.includes('MADEUP_SECRET') &&
      rowsState.text.includes(`${'madeupQL68oldValue'.length} chars`) && !rowsState.text.includes('madeupQL68oldValue') && !rowsState.text.includes('made-up.example'), rowsState.facts ? { facts: rowsState.facts } : {})
    check('the test hook holds names, dots and lengths only', JSON.stringify(rowsState.hook?.edit?.rows) === JSON.stringify(['MADEUP_HOST=•••• 15', 'MADEUP_SECRET=•••• 18', 'MADEUP_MODE=•••• 3']),
      { rows: rowsState.hook?.edit?.rows })
    await sheet.locator('.ql-env-rows').focus()
    // A paste with a row chosen but no value field in focus does nothing (R68-NFR5).
    await pasteInto('madeupQL68noField0001')
    await page.waitForTimeout(100)
    check('a paste with no value field in focus changes nothing', await sheet.locator('.ql-save').count() === 0 && await sheet.locator('.ql-env-field').count() === 0 &&
      !JSON.stringify(await hook()).includes('madeupQL68noField0001') && !(await pageText()).includes('madeupQL68noField0001'))
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const inField = await active()
    await pasteInto(PASTED)
    await page.waitForTimeout(100)
    const pastedState = { text: await pageText(), bar: await envBar(), input: await sheet.locator('.ql-env-field').inputValue().then((value) => value.length), dot: await sheet.locator('.ql-tr .ql-dirty').count(),
      footer: await footerText(), hook: JSON.stringify(await hook()) }
    check('Enter puts the focus in the value\'s field, hidden; a paste replaces the whole value and stays masked', inField.label === 'New value, hidden' && inField.type === 'password' &&
      pastedState.input === PASTED.length && !pastedState.text.includes(PASTED) && !pastedState.hook.includes(PASTED), { inField })
    check('the Save bar reads "Save writes to", the full path and "1 of 3 values changed"; the tree marks the file with a dot', pastedState.bar.includes('Save writes to') &&
      pastedState.bar.includes('1 of 3 values changed') && pastedState.bar.includes(envPath) && pastedState.dot === 1, { bar: pastedState.bar })
    await pasteInto('made-up\nTWO_LINES')
    await page.waitForTimeout(100)
    check('a paste that holds a line break is refused and changes nothing', (await sheet.locator('.ql-feedback').textContent()) === 'A value is one line; nothing was pasted' &&
      await sheet.locator('.ql-env-field').inputValue().then((value) => value.length) === PASTED.length)
    check('in a field the footer says Paste, Reveal, Done, Save and that Esc leaves the field', /Leave the field/u.test(pastedState.footer) && /Save/u.test(pastedState.footer), { footer: pastedState.footer })
    await page.keyboard.press('Escape')
    const leftField = { field: await sheet.locator('.ql-env-field').count(), open: await sheet.count(), row: await sheet.locator('.ql-env-row.sel').innerText() }
    check('Esc leaves the field and keeps the draft: the row reads "Unsaved" with its length', leftField.field === 0 && leftField.open === 1 &&
      leftField.row.includes(`Unsaved · ${PASTED.length} chars`) && !leftField.row.includes(PASTED), leftField)
    await page.keyboard.press('Control+r')
    await sheet.locator('.ql-env-shown').waitFor()
    const shownRow = await sheet.locator('.ql-env-row.sel').innerText()
    const shownHook = JSON.stringify(await hook())
    check('Ctrl+R shows the new value for ten seconds', shownRow.includes(PASTED) && /Shown · hides in (?:10|9) s/u.test(shownRow) && !shownHook.includes(PASTED),
      { row: shownRow.replace(PASTED, '<pasted>'), hookHasValue: shownHook.includes(PASTED) })
    await page.keyboard.press('Escape')
    check('Esc hides it again, and the sheet stays', await sheet.locator('.ql-env-shown').count() === 0 && await sheet.count() === 1)

    // Every way out asks first, with Keep editing in focus; Esc means Keep editing.
    const asks = async (name, act) => {
      await act()
      await sheet.locator('.ql-save-ask').waitFor({ timeout: 3000 })
      const asked = { name, text: await sheet.locator('.ql-save-ask').innerText(), focus: (await active()).text }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(100)
      return { ...asked, kept: await sheet.locator('.ql-save-ask').count() === 0 && await sheet.count() === 1 && (await envBar()).includes('1 of 3 values changed') }
    }
    const ways = [
      await asks('Esc', () => page.keyboard.press('Escape')),
      await asks('Ctrl+Shift+E', () => page.keyboard.press('Control+Shift+E')),
      await asks('another file', () => sheet.locator('.ql-tr', { hasText: 'README.md' }).first().click()),
      await asks('the root', () => sheet.locator('.ql-head .ql-plate').click())
    ]
    check('Esc, Ctrl+Shift+E, another file and changing the root each ask "Unsaved edits": Save, Discard, Keep editing, Keep editing in focus; Esc keeps editing',
      ways.every((way) => way.text.includes('Unsaved edits') && /Save/u.test(way.text) && /Discard/u.test(way.text) && way.focus === 'Keep editing' && way.kept), { ways })
    // The file being edited, chosen again in the tree, keeps its draft; Send to session… closes the sheet, so it asks.
    await sheet.locator('.ql-tr', { hasText: 'app.env' }).first().click()
    await page.waitForTimeout(300)
    const sameRow = { asked: await sheet.locator('.ql-save-ask').count(), bar: await envBar(), rows: await sheet.locator('.ql-env-row').count() }
    check('choosing the file being edited again in the tree keeps its draft, unasked', sameRow.asked === 0 && sameRow.rows === 3 && sameRow.bar.includes('1 of 3 values changed'), sameRow)
    await sheet.getByRole('button', { name: 'More actions', exact: true }).click()
    await sheet.getByRole('menuitem', { name: 'Send to session…', exact: true }).click()
    await sheet.locator('.ql-save-ask').waitFor({ timeout: 3000 })
    const sendAsked = await sheet.locator('.ql-save-ask').innerText()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Send to session… asks "Unsaved edits" first, and Esc keeps the sheet and the draft', sendAsked.includes('Unsaved edits') && await sheet.count() === 1 &&
      (await envBar()).includes('1 of 3 values changed') && await page.locator('dialog.file-reference-dialog[open]').count() === 0, { sendAsked })
    // The window's close asks through the close prompt; Keep editing keeps the window.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    await sheet.locator('.ql-save-ask').waitFor({ timeout: 5000 })
    const closeAsked = (await active()).text
    await sheet.getByRole('button', { name: 'Keep editing', exact: true }).click()
    await page.waitForTimeout(300)
    check('closing the window asks the same row first, and Keep editing keeps the window and the draft', closeAsked === 'Keep editing' &&
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1 && (await envBar()).includes('1 of 3 values changed'))
    // A close whose question another way out replaces is answered Keep editing, so a later close asks again.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    await sheet.locator('.ql-save-ask').waitFor({ timeout: 5000 })
    await page.keyboard.press('Control+Shift+E')
    await page.waitForTimeout(150)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    const askedAgain = await sheet.locator('.ql-save-ask').waitFor({ timeout: 5000 }).then(() => true, () => false)
    await sheet.getByRole('button', { name: 'Keep editing', exact: true }).click().catch(() => undefined)
    await page.waitForTimeout(300)
    check('a close whose question Ctrl+Shift+E replaced is not left waiting: closing again asks again, and Keep editing keeps the window', askedAgain &&
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1 && (await envBar()).includes('1 of 3 values changed'))

    // The host's answer is held back 1.5 s for this one Save: meanwhile the draft takes no edits and no way out leaves it.
    const delayed = await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      const original = handlers?.get('aiterm:quick-look:save')
      if (!original) return false
      globalThis.__qlSaveOriginal = original
      handlers.set('aiterm:quick-look:save', async (...args) => { await new Promise((resolve) => setTimeout(resolve, 1500)); return original(...args) })
      return true
    })
    await page.keyboard.press('Control+s')
    await sheet.locator('.ql-save-what', { hasText: 'Saving…' }).waitFor()
    await sheet.locator('.ql-env-rows').focus()
    await page.keyboard.press('Enter')
    await pasteInto('madeupQL68duringSave1')
    const duringSave = JSON.stringify(await hook())
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+E')
    await page.waitForFunction(() => /Saved \d/u.test([...document.querySelectorAll('dialog.quick-look .ql-path .ql-facts')].at(-1)?.textContent ?? ''))
    await app.evaluate(({ ipcMain }) => { if (globalThis.__qlSaveOriginal) ipcMain._invokeHandlers.set('aiterm:quick-look:save', globalThis.__qlSaveOriginal) })
    check('while a Save is under way the draft takes no edits and the sheet stays; the Save then leaves no draft behind', delayed && !duringSave.includes('madeupQL68duringSave1') &&
      await sheet.count() === 1 && await sheet.locator('.ql-save-ask').count() === 0 && !readFileSync(envPath, 'utf8').includes('madeupQL68duringSave1'), { delayed })
    const savedBytes = readFileSync(envPath, 'utf8')
    check('Ctrl+S writes only the changed value, in its old quoting; comment, order, blank line and final newline are the same',
      savedBytes === EDITED_ENV.replace('"madeupQL68oldValue"', `"${PASTED}"`), { same: savedBytes === EDITED_ENV.replace('"madeupQL68oldValue"', `"${PASTED}"`) })
    const configFiles = JSON.stringify(['app.env', 'app.toml', 'app.yaml', 'locked.json', 'multi.env', 'settings.jsonc'])
    check('the file keeps its mode and no second file is left beside it', (statSync(envPath).mode & 0o7777) === 0o640 &&
      JSON.stringify(readdirSync(join(project, 'config')).sort()) === configFiles, { mode: (statSync(envPath).mode & 0o7777).toString(8) })
    check('after the save the row reads "Saved" with the time, the bar and the dot are gone', await sheet.locator('.ql-save').count() === 0 && await sheet.locator('.ql-tr .ql-dirty').count() === 0 &&
      /Saved \d/u.test(await lastFacts()))

    // Another program writes the file meanwhile: Save is blocked, the draft kept, and Review latest carries it onto the new file.
    await sheet.locator('.ql-env-rows').focus()
    await page.keyboard.press('Enter')
    await pasteInto(PASTED_TWO)
    await page.keyboard.press('Escape')
    const agentBytes = readFileSync(envPath, 'utf8').replace('MADEUP_MODE=dev', 'MADEUP_MODE=agent')
    writeFileSync(envPath, agentBytes)
    await page.keyboard.press('Control+s')
    await sheet.locator('.ql-save-ask').waitFor()
    const blocked = { text: await sheet.locator('.ql-save-ask').innerText(), focus: (await active()).text, disk: readFileSync(envPath, 'utf8') === agentBytes }
    check('a file another program changed gives "Changed on disk · Save blocked" with Review latest and Keep editing; nothing is written',
      blocked.text.includes('Changed on disk · Save blocked') && blocked.text.includes('Review latest') && blocked.focus === 'Keep editing' && blocked.disk, { text: blocked.text })
    await sheet.getByRole('button', { name: 'Review latest', exact: true }).click()
    await page.waitForFunction(() => /edits are kept/u.test(document.querySelector('dialog.quick-look .ql-feedback')?.textContent ?? ''))
    check('Review latest reads the file as it is now, masked, and keeps the draft on it', (await envBar()).includes('1 of 3 values changed') &&
      !(await pageText()).includes('agent') && !(await pageText()).includes(PASTED_TWO))
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-save') === null)
    check('Save then writes his value over the other program\'s file, keeping its change', readFileSync(envPath, 'utf8') === agentBytes.replace(`"${PASTED}"`, `"${PASTED_TWO}"`))

    // A file that another program changed and made read-only meanwhile: Review latest says so and keeps the draft, unsaved.
    await sheet.locator('.ql-env-rows').focus()
    await page.keyboard.press('Enter')
    await pasteInto('madeupQL68readOnly01')
    await page.keyboard.press('Escape')
    const lockedBytes = readFileSync(envPath, 'utf8').replace('MADEUP_MODE=agent', 'MADEUP_MODE=locked')
    writeFileSync(envPath, lockedBytes)
    await page.keyboard.press('Control+s')
    await sheet.getByRole('button', { name: 'Review latest', exact: true }).waitFor()
    chmodSync(envPath, 0o440)
    await sheet.getByRole('button', { name: 'Review latest', exact: true }).click()
    await page.waitForFunction(() => /now read-only/u.test(document.querySelector('dialog.quick-look .ql-save-what')?.textContent ?? ''))
    const lockedState = { what: await sheet.locator('.ql-save-what').textContent(), rows: await sheet.locator('.ql-env-row').count(), row: await sheet.locator('.ql-env-row.sel').innerText(),
      disk: readFileSync(envPath, 'utf8') === lockedBytes }
    check('Review latest on a file that is now read-only says so and keeps the draft, unsaved; nothing is written', lockedState.what === 'Could not save · now read-only · not writable' &&
      lockedState.rows === 3 && lockedState.row.includes('Unsaved') && lockedState.disk, { what: lockedState.what, rows: lockedState.rows })
    chmodSync(envPath, 0o640)

    // Discard drops the draft and goes the way he asked.
    await sheet.locator('.ql-env-rows').focus()
    await page.keyboard.press('Enter')
    await pasteInto('madeupQL68discarded')
    await page.keyboard.press('Escape')
    const beforeDiscard = readFileSync(envPath, 'utf8')
    await page.keyboard.press('Control+Shift+E')
    await sheet.getByRole('button', { name: 'Discard', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    check('Discard on the way out drops the draft, writes nothing and closes the sheet', readFileSync(envPath, 'utf8') === beforeDiscard)
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await sheet.locator('.ql-env-row, .ql-tr').first().waitFor()
    check('the sheet opens again with no draft', await sheet.locator('.ql-save').count() === 0)
    await page.screenshot({ path: join(evidence, 'env-edit.png') })
    // ---- Story 68.2: fix a line in a config file ----
    const pasteInEditor = (text) => sheet.locator('.ql-code .cm-content').evaluate((content, value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)
    const toLine = async (line) => {
      await page.keyboard.press('Control+Home')
      for (let index = 1; index < line; index += 1) await page.keyboard.press('ArrowDown')
      await page.keyboard.press('End')
    }
    const syntaxLine = () => sheet.locator('.ql-syntax').textContent().catch(() => '')
    const settingsPath = join(project, 'config/settings.jsonc')
    if (await sheet.locator('.ql-tr', { hasText: 'settings.jsonc' }).count() === 0) await sheet.locator('.ql-tr', { hasText: 'config' }).first().click()
    await openRow('.gitignore')
    await sheet.locator('.ql-code .cm-content').click()
    await page.keyboard.press('e')
    check('E on an ordinary file says "Read-only · source file" where the hint would be', /Read-only · source file/u.test(await footerText()) && await sheet.locator('.ql-editing-plate').count() === 0)
    await openRow('locked.json')
    check('a config file that may not be edited says why there, and carries no Edit hint', /Read-only · not writable/u.test(await footerText()) && !/EEdit/u.test(await footerText()), { footer: await footerText() })
    check('its header says Read-only with the reason, and shows no Edit plate', await sheet.locator('.ql-path .ql-readonly-word').count() === 1 &&
      await sheet.locator('.ql-edit-plate').count() === 0, { title: await sheet.locator('.ql-path .ql-readonly-word').getAttribute('title').catch(() => null) })
    await openRow('settings.jsonc')
    await sheet.locator('.ql-code .cm-content').click()
    check('an editable config file\'s footer shows "E Edit"', /EEdit/u.test(await footerText()), { footer: await footerText() })
    // The header's plate (Fable, 2026-10-18): Edit E enters edit mode, pressed as Editing; pressed again with no edits it leaves.
    const editPlate = sheet.locator('.ql-path button.ql-edit-plate')
    const plateBefore = (await editPlate.textContent())?.trim()
    await editPlate.click()
    await sheet.locator('.ql-editing-plate').waitFor()
    const pressed = await editPlate.getAttribute('aria-pressed')
    const plateEditing = (await editPlate.textContent())?.trim()
    await editPlate.click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
    check('the header\'s Edit plate enters edit mode, reads Editing while pressed, and leaves it again with no edits', plateBefore === 'EditE' &&
      pressed === 'true' && plateEditing === 'Editing' && await sheet.locator('.ql-code.ql-editing').count() === 0, { plateBefore, pressed, plateEditing })
    await sheet.locator('.ql-code .cm-content').click()
    await page.keyboard.press('e')
    await sheet.locator('.ql-editing-plate').waitFor()
    check('E enters edit mode: an EDITING plate and the focus ring around the file', await sheet.locator('.ql-code.ql-editing').count() === 1 &&
      !(await pageText()).includes('madeupQL68jsoncOld000') && /Undo/u.test(await footerText()))
    // The hidden value on line 4: from the line's end, Left steps over the comma and the quote, then over the value as one piece.
    await toLine(4)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    await pasteInEditor(PASTED_JSONC)
    await page.waitForTimeout(150)
    const afterPaste = { text: await pageText(), footer: await footerText(), hook: await hook(), notes: await sheet.locator('.ql-secret-note').allTextContents() }
    check('a paste on a selected hidden value replaces it whole and stays masked; the footer reads "Paste, masked" and the note "Pasted"',
      !afterPaste.text.includes(PASTED_JSONC) && /Paste, masked/u.test(afterPaste.footer) && afterPaste.notes.includes(`Pasted · ${PASTED_JSONC.length} chars`) &&
      afterPaste.hook?.edit?.draft?.includes('"apiKey": "[secret hidden]"') && !JSON.stringify(afterPaste.hook).includes(PASTED_JSONC), { notes: afterPaste.notes, footer: afterPaste.footer })
    await page.keyboard.press('Control+a')
    const draftCopy = await sheet.locator('.ql-code .cm-content').evaluate((content) => {
      const data = new DataTransfer()
      content.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    })
    check('copying the draft carries "[secret hidden]" in place of the pasted value', draftCopy.includes('"apiKey": "[secret hidden]"') && !draftCopy.includes(PASTED_JSONC))
    const draftDrag = await sheet.locator('.ql-code .cm-content').evaluate((content) => {
      const data = new DataTransfer()
      const started = content.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }))
      return { started, carried: data.getData('text/plain') }
    })
    check('a selection that holds a hidden value is not dragged in edit mode', !draftDrag.started && draftDrag.carried === "", draftDrag)
    // With no selection Ctrl+C and Ctrl+X take the caret's line: masked, the shown value too.
    const lineClip = (kind) => sheet.locator('.ql-code .cm-content').evaluate((content, type) => {
      const data = new DataTransfer()
      content.dispatchEvent(new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    }, kind)
    await toLine(4)
    const lineCopy = await lineClip('copy')
    await page.keyboard.press('Control+r')
    await page.waitForTimeout(100)
    const shownCopy = await lineClip('copy')
    await page.keyboard.press('Control+r')
    const lineCut = await lineClip('cut')
    const afterCut = (await hook())?.edit?.draft ?? ''
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(100)
    const afterUndo = (await hook())?.edit?.draft ?? ''
    check('Ctrl+C and Ctrl+X with no selection carry the caret\'s line with "[secret hidden]", shown or not; Ctrl+Z brings the line back masked',
      [lineCopy, shownCopy, lineCut].every((clip) => clip === '  "apiKey": "[secret hidden]",') && !afterCut.includes('apiKey') &&
      afterUndo.includes('"apiKey": "[secret hidden]"') && !JSON.stringify(await hook()).includes(PASTED_JSONC), { lineCopy, shownCopy, lineCut })
    await toLine(5)
    await page.keyboard.press('Backspace')
    await page.keyboard.type('3')
    await toLine(2)
    await page.keyboard.press('Enter')
    // Enter may indent the new line; Shift+Home takes the indent so the line is exactly what is typed.
    await page.keyboard.press('Shift+Home')
    await page.keyboard.type('  // made-up note')
    await page.waitForTimeout(450)
    const marks = { changed: await sheet.locator('.ql-change-mark.changed').count(), added: await sheet.locator('.ql-change-mark.added').count(), bar: await envBar(), syntax: await syntaxLine() }
    check('a changed line carries a bar, an added line a plus, and the bar counts them; the syntax line reads "Syntax valid"',
      marks.changed === 2 && marks.added === 1 && marks.bar.includes('2 lines changed · 1 added') && marks.syntax === 'Syntax valid', marks)
    await toLine(6)
    await page.keyboard.type(',')
    await page.waitForTimeout(450)
    const broken = await syntaxLine()
    check('300 ms after typing stops a broken draft reads "Invalid JSONC · line 6: unexpected comma", and its masks stay', broken === 'Invalid JSONC · line 6: unexpected comma' &&
      await sheet.locator('.ql-code .ql-secret').count() === 1, { broken })
    await page.keyboard.press('Control+s')
    await sheet.locator('.ql-save-ask').waitFor()
    const invalidRow = { text: await sheet.locator('.ql-save-ask').innerText(), focus: (await active()).text, disk: readFileSync(settingsPath, 'utf8') === SETTINGS_JSONC }
    check('Ctrl+S on a draft that does not parse writes nothing and offers Keep editing, in focus, and Save invalid file', invalidRow.disk && invalidRow.focus === 'Keep editing' &&
      invalidRow.text.includes('Save invalid file') && invalidRow.text.includes('Invalid JSONC · line 6'), { text: invalidRow.text })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(450)
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
    // The saved file is read again before E is pressed on it.
    await page.waitForTimeout(400)
    const savedJsonc = readFileSync(settingsPath, 'utf8')
    const expectedJsonc = ['{', '  // made-up settings', '  // made-up note', '  "model": "made-up/model",', `  "apiKey": "${PASTED_JSONC}",`, '  "retries": 3', '}', ''].join('\r\n')
    check('Save writes the text he sees with the file\'s Windows line endings kept, and leaves edit mode with "Saved" and the time', savedJsonc === expectedJsonc &&
      /Saved \d/u.test(await lastFacts()), { same: savedJsonc === expectedJsonc, ...(savedJsonc === expectedJsonc ? {} : { saved: savedJsonc.replace(PASTED_JSONC, '…') }) })
    await page.keyboard.press('e')
    await sheet.locator('.ql-editing-plate').waitFor()
    await toLine(7)
    await page.keyboard.type('}')
    await page.keyboard.press('Control+s')
    await sheet.getByRole('button', { name: 'Save invalid file', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
    // The saved file is read again before E is pressed on it.
    await page.waitForTimeout(400)
    check('"Save invalid file" writes it as it is', readFileSync(settingsPath, 'utf8') === expectedJsonc.replace('\r\n}\r\n', '\r\n}}\r\n'))

    const require = createRequire(join(repo, 'apps/desktop/package.json'))
    const pnpmStore = join(repo, 'node_modules/.pnpm')
    const jsYaml = createRequire(join(pnpmStore, readdirSync(pnpmStore).find((name) => name.startsWith('js-yaml@')), 'node_modules/js-yaml/package.json'))('js-yaml')
    const replaceValue = async (name, line, value) => {
      await openRow(name)
      await sheet.locator('.ql-code .cm-content').click()
      await page.keyboard.press('e')
      await sheet.locator('.ql-editing-plate').waitFor()
      await toLine(line)
      // A TOML value ends with its quote; a YAML value is bare to the line's end.
      if (name.endsWith('.toml')) await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('Shift+ArrowLeft')
      await pasteInEditor(value)
      await page.waitForTimeout(450)
      await page.keyboard.press('Control+s')
      await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
      // The saved file is read again before E is pressed on it.
      await page.waitForTimeout(400)
    }
    await replaceValue('app.yaml', 2, PASTED_YAML)
    await replaceValue('app.toml', 2, PASTED_TOML)
    const yamlBack = jsYaml.load(readFileSync(join(project, 'config/app.yaml'), 'utf8'))
    const tomlBack = require('smol-toml').parse(readFileSync(join(project, 'config/app.toml'), 'utf8'))
    check('a YAML and a TOML file with a replaced value read back by a parser as that value', yamlBack.token === PASTED_YAML && yamlBack.name === 'made-up' &&
      tomlBack.api_key === PASTED_TOML && tomlBack.title === 'made-up', { yaml: readFileSync(join(project, 'config/app.yaml'), 'utf8').replace(PASTED_YAML, '…'), toml: readFileSync(join(project, 'config/app.toml'), 'utf8').replace(PASTED_TOML, '…') })
    check('no second file is left beside the saved configs', JSON.stringify(readdirSync(join(project, 'config')).sort()) === configFiles)
    // His board (owner 2026-10-18): story names stay readable, and a TODO comment goes in through the Edit plate and Save.
    if (await sheet.locator('.ql-tr', { hasText: 'status.yaml' }).count() === 0) {
      if (await sheet.locator('.ql-tr.fold', { hasText: /^plan$/u }).count() === 0) await sheet.locator('.ql-tr', { hasText: 'docs' }).first().click()
      await sheet.locator('.ql-tr.fold', { hasText: /^plan$/u }).click()
    }
    await openRow('status.yaml')
    const boardText = await pageText()
    check('a planning board hides no story name, even one with "secret" or "keys" in it', await sheet.locator('.ql-secret').count() === 0 &&
      boardText.includes('1-1-hide-secret-shaped-text-sent-to-telegram') && boardText.includes('1-3-a-made-up-story-with-a-very-long-name-for-the-board'))
    // As his screenshot had it (owner 2026-10-18, "I think this button doesn't work"): the top field empty and in focus,
    // the printed paths listed on the left, and the plate clicked from there. The file takes the keys at once.
    await page.keyboard.press('Control+p')
    await sheet.locator('[aria-label="Printed paths"] .ql-rf').first().waitFor()
    await sheet.locator('.ql-path button.ql-edit-plate').click()
    await sheet.locator('.ql-editing-plate').waitFor()
    await page.waitForTimeout(150)
    const fromField = await page.evaluate(() => ({ inEditor: !!document.activeElement?.closest('dialog.quick-look .ql-code.ql-editing .cm-content'),
      printed: document.querySelectorAll('dialog.quick-look [aria-label="Printed paths"]').length, ring: document.querySelectorAll('dialog.quick-look .ql-code.ql-editing').length }))
    check('with the field in focus and the printed paths listed, the Edit plate puts the keys in the file: the list closes and the caret is in the editor',
      fromField.inEditor && fromField.printed === 0 && fromField.ring === 1, fromField)
    await toLine(4)
    await page.keyboard.type(' # TODO made-up follow-up')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(evidence, 'board-edit.png') })
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
    const boardBack = readFileSync(join(project, 'docs/plan/status.yaml'), 'utf8')
    check('a TODO comment typed after a story\'s status saves into the board, the rest byte for byte', boardBack === BOARD.replace('review\n', 'review # TODO made-up follow-up\n'),
      { line: boardBack.split('\n')[3] })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(evidence, 'board.png') })
    // From the tree, too: the plate takes the keys to the file, and pressed again with no edits it leaves them there.
    await sheet.locator('.ql-tree').focus()
    await sheet.locator('.ql-path button.ql-edit-plate').click()
    await sheet.locator('.ql-editing-plate').waitFor()
    await page.waitForTimeout(150)
    const fromTree = await page.evaluate(() => !!document.activeElement?.closest('dialog.quick-look .ql-code.ql-editing .cm-content'))
    await sheet.locator('.ql-path button.ql-edit-plate').click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
    await page.waitForTimeout(150)
    const leftTo = await page.evaluate(() => !!document.activeElement?.closest('dialog.quick-look .ql-code .cm-content'))
    check('with the tree in focus, the Edit plate puts the caret in the file; pressed again it leaves edit mode with the keys still in the file', fromTree && leftTo, { fromTree, leftTo })
    // The Save button by mouse, as Ctrl+S does.
    await sheet.locator('.ql-path button.ql-edit-plate').click()
    await sheet.locator('.ql-editing-plate').waitFor()
    await toLine(6)
    await page.keyboard.type(' # saved by click')
    await sheet.locator('[role="region"][aria-label="Save"] button', { hasText: /^Save/u }).click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
    const clickSaved = readFileSync(join(project, 'docs/plan/status.yaml'), 'utf8').split('\n')[5]
    check('the Save button writes the draft as Ctrl+S does and leaves edit mode', clickSaved.endsWith(' # saved by click'), { clickSaved })
    await page.waitForTimeout(400)
    await sheet.locator('.ql-code .cm-content').click()
    await page.keyboard.press('e')
    await sheet.locator('.ql-editing-plate').waitFor()
    await toLine(1)
    await page.keyboard.type('# made-up')
    await page.keyboard.press('Escape')
    await sheet.locator('.ql-save-ask').waitFor()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    check('a config draft asks on the way out too, and Esc keeps editing', await sheet.locator('.ql-save-ask').count() === 0 && await sheet.locator('.ql-editing-plate').count() === 1)
    await page.screenshot({ path: join(evidence, 'config-edit.png') })
    await page.keyboard.press('Control+Shift+E')
    await sheet.getByRole('button', { name: 'Discard', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await sheet.locator('.ql-tr').first().waitFor()

    // Edit mode keeps the reader's place (owner 2026-10-19, "when you press <edit> or <e> the page jumps to top"):
    // E and the plate open the draft at the line the reader had at its top, with the caret where it was or, scrolled
    // out of view, on that top line; leaving with no edits shows the reader where the draft was.
    if (await sheet.locator('.ql-tr', { hasText: 'long.yaml' }).count() === 0) {
      if (await sheet.locator('.ql-tr.fold', { hasText: /^plan$/u }).count() === 0) await sheet.locator('.ql-tr', { hasText: 'docs' }).first().click()
      await sheet.locator('.ql-tr.fold', { hasText: /^plan$/u }).click()
    }
    await openRow('long.yaml')
    const caretLine = () => sheet.evaluate((element) => Number(element.querySelector('.cm-lineNumbers .cm-activeLineGutter')?.textContent ?? 0))
    const place = async () => ({ top: await topLine(), caret: await caretLine() })
    const leftEdit = async () => {
      await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-editing-plate') === null)
      await page.waitForTimeout(200)
    }
    const inEdit = async () => {
      await sheet.locator('.ql-editing-plate').waitFor()
      await page.waitForTimeout(200)
    }
    await sheet.locator('.ql-code .cm-content').click()
    await page.keyboard.press('Control+g')
    await sheet.locator('input[aria-label="Go to line"]').waitFor()
    await page.keyboard.type('150')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const reading = await place()
    await page.keyboard.press('e')
    await inEdit()
    const byKey = await place()
    check('E opens the draft at the reader\'s place: the same line at the top and the caret on line 150', reading.top > 100 && reading.caret === 150 &&
      byKey.top === reading.top && byKey.caret === 150, { reading, byKey })
    // Two pages up in the draft, away from both ends, where no scroll limit can hold the line at the top.
    await page.keyboard.press('PageUp')
    await page.keyboard.press('PageUp')
    await page.waitForTimeout(200)
    const moved = await place()
    await editPlate.click()
    await leftEdit()
    const reader = await place()
    check('leaving edit mode with no edits shows the reader at the line the draft had at its top', moved.top > 1 && moved.top < reading.top && reader.top === moved.top, { moved, reader })
    await sheet.locator('.ql-code .cm-scroller').evaluate((element) => { element.scrollTop += 900 })
    await page.waitForTimeout(200)
    const wheeled = await place()
    await editPlate.click()
    await inEdit()
    const byPlate = await place()
    check('the Edit plate keeps the place too, and a caret scrolled out of view starts on the top line', wheeled.top > reader.top + 20 &&
      byPlate.top === wheeled.top && byPlate.caret === wheeled.top, { wheeled, byPlate })
    await editPlate.click()
    await leftEdit()

    // Markdown's checks below open docs/plan.md from the tree.
    if (await sheet.locator('.ql-tr', { hasText: 'plan.md' }).count() === 0) await sheet.locator('.ql-tr', { hasText: 'docs' }).first().click()
    await sheet.locator('.ql-tr', { hasText: 'plan.md' }).first().waitFor()

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
    check('an image is one line: "Image", its words and its path; no image is loaded', pageState.images.length === 3 && pageState.images[0].includes('Image') &&
      pageState.images[0].includes('A made-up diagram') && pageState.images[1].includes('https://example.invalid/remote.png') &&
      pageState.images[2].includes('images/d.png') && !pageState.images[2].includes(PAGE_KEY), { images: pageState.images })
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
    // The Source and Rendered buttons by mouse; the keys follow into the view shown.
    await sheet.locator('.ql-mode button', { hasText: 'Source' }).click()
    await sheet.locator('.ql-code .cm-content').waitFor()
    await page.waitForTimeout(150)
    const sourceKeys = await page.evaluate(() => !!document.activeElement?.closest('dialog.quick-look .ql-code'))
    await sheet.locator('.ql-mode button', { hasText: 'Rendered' }).click()
    await sheet.locator('.ql-page .ql-md h1').waitFor()
    await page.waitForTimeout(150)
    const pageKeys = await page.evaluate(() => !!document.activeElement?.closest('dialog.quick-look .ql-page'))
    check('the Source and Rendered buttons switch the view as M does, and the keys follow into it', sourceKeys && pageKeys, { sourceKeys, pageKeys })

    // Masking and find work on the page as in source.
    const renderedText = await sheet.locator('.ql-page').innerText()
    const renderedMarkup = await sheet.locator('.ql-page').innerHTML()
    check('a secret-shaped value is masked on the page, in text, a code block and an image\'s words, and in none of its markup', !renderedText.includes(PAGE_KEY) && !renderedMarkup.includes(PAGE_KEY) &&
      await sheet.locator('.ql-page .ql-secret').count() === 3, { plates: await sheet.locator('.ql-page .ql-secret').count() })
    const keyed = sheet.locator('.ql-md-a[data-target="outside"]').filter({ hasText: 'keyed' })
    await keyed.focus()
    const keyedStatus = await sheet.locator('.ql-page-status').textContent()
    await page.keyboard.press('Enter')
    await sheet.locator('.ql-feedback', { hasText: 'Address copied' }).waitFor()
    const keyedCopy = (await app.evaluate(() => globalThis.__qlClipboard)).at(-1)
    check('a link whose address holds a hidden value shows and copies it masked', !keyedStatus.includes(PAGE_KEY) && keyedStatus.includes('[secret hidden]') &&
      keyedCopy === 'https://example.invalid/?k=[secret hidden]', { keyedStatus, keyedCopy })
    // Tab from the top field, with real keys: the tree, the page, its links, then the path row's … button.
    await page.keyboard.press('Control+p')
    const where = () => page.evaluate(() => {
      const active = document.activeElement
      return active?.classList.contains('ql-tree') ? 'tree' : active?.classList.contains('ql-page') ? 'page' : active?.classList.contains('ql-md-a') ? 'link'
        : active?.getAttribute('aria-label') === 'More actions' ? 'menu' : active?.getAttribute('aria-label') === 'Go to file' ? 'field' : active?.tagName ?? 'none'
    })
    const walked = [await where()]
    for (let step = 0; step < 80 && walked.at(-1) !== 'menu'; step += 1) {
      await page.keyboard.press('Tab')
      walked.push(await where())
    }
    await page.keyboard.press('Enter')
    const menuShown = await sheet.getByRole('menuitem', { name: 'Copy reference', exact: true }).count()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Tab')
    const tabBack = await where()
    check('Tab walks from the top field to the tree, the page, each link and the … button, which Enter opens; Esc returns to it and Shift+Tab goes one stop back',
      walked.slice(0, 3).join(' ') === 'field tree page' && walked[3] === 'link' && walked.at(-1) === 'menu' && menuShown === 1 && tabBack === walked.at(-2),
      { walked: walked.join(' '), menuShown, tabBack })
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
    // At the caps, dense with values: the source file and the page open, hide every value, find and switch.
    await sheet.locator('.ql-tr', { hasText: 'dense.ts' }).first().click()
    const denseAt = Date.now()
    await sheet.locator('.ql-path').filter({ hasText: 'dense.ts' }).waitFor()
    await sheet.locator('.ql-code .cm-content').waitFor()
    const denseMs = Date.now() - denseAt
    const denseShown = await page.evaluate(() => window.__aitermQuickLook?.snapshot())
    const denseDom = await sheet.locator('.ql-main').textContent()
    check('a source file just under 2 MiB, dense with values, opens with every value hidden', !denseDom.includes('madeupDENSE') && denseShown.hidden > 20_000 &&
      !JSON.stringify(denseShown).includes('madeupDENSE') && denseMs < 4_000, { denseMs, hidden: denseShown.hidden })
    await sheet.locator('.ql-code .cm-content').click()
    await page.keyboard.press('Control+f')
    await page.keyboard.type('const k1')
    await page.waitForTimeout(400)
    const denseFind = await sheet.locator('.ql-find').textContent()
    check('find works in it', /of [\d,]+/u.test(denseFind), { denseFind: denseFind.slice(0, 120) })
    await page.keyboard.press('Escape')
    await sheet.locator('.ql-tr', { hasText: 'dense.md' }).first().click()
    const pageAt = Date.now()
    await sheet.locator('.ql-path').filter({ hasText: 'dense.md' }).waitFor()
    await sheet.locator('.ql-page .ql-md h1').waitFor()
    const pageMs = Date.now() - pageAt
    const pageDom = await sheet.locator('.ql-main').innerHTML()
    check('a Markdown page just under 512 KiB, dense with values, links and highlighted code, draws with every value hidden', !pageDom.includes('madeupDENSE') && pageMs < 6_000, { pageMs })
    await sheet.locator('.ql-page').focus()
    await page.keyboard.press('m')
    await sheet.locator('.ql-code .cm-content').waitFor()
    const pageSource = await sheet.locator('.ql-main').textContent()
    await page.keyboard.press('m')
    await sheet.locator('.ql-page .ql-md h1').waitFor()
    check('it switches to source and back with every value still hidden', !pageSource.includes('madeupDENSE') && !(await sheet.locator('.ql-main').innerHTML()).includes('madeupDENSE'))
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
    await sheet.locator('button[aria-label="Previous match"]').click()
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.opened === 'Match 2 of 11')
    await sheet.locator('button[aria-label="Next match"]').click()
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.opened === 'Match 3 of 11')
    check('previous goes back a match, and next forward again', true)
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

    // Crafted files of a megabyte each, full of hidden values, that hold a thread 100 ms or more while they are masked:
    // the search masks them in its own thread, so the terminal's counter keeps arriving; a newer query replaces the
    // search under way and Esc stops it, and nothing of the older search is shown afterwards.
    const crafted = join(bulk, 'crafted')
    mkdirSync(crafted, { recursive: true })
    const megabyte = (head, unit) => head + unit.repeat(Math.floor((1_048_000 - head.length) / unit.length))
    writeFileSync(join(crafted, 'a.json'), megabyte('madeupneedle\n', 'API_KEY=x\n'))
    writeFileSync(join(crafted, 'b.json'), megabyte('"madeupneedle":1,', '"password":"x",'))
    writeFileSync(join(crafted, 'c.md'), megabyte('madeupneedle ', 'eyJaa.aa.bb '))
    writeFileSync(join(crafted, 'd.env'), megabyte('madeupneedle=1\n', 'NAME=madeup\n'))
    writeFileSync(join(crafted, 'e.md'), megabyte('madeupneedle ', `sk-${'a'.repeat(24)} api `))
    writeFileSync(join(crafted, 'f.json'), megabyte('{"madeupneedle":1}\n', '{"token":"abcdefabcdefabcdefabcdefabcdefabcd"},\n'))
    await page.keyboard.press('Control+a')
    await watchTicks()
    const craftedAt = Date.now()
    await page.keyboard.type('madeupneedle')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'madeupneedle' && state.fresh && !state.searching && !!state.header }, undefined, 60_000)
    const craftedTicks = await stopTicks()
    const craftedResult = await quick()
    check('with crafted megabyte files of hidden values among 20,000 files the counter shows no gap over 100 ms, and their lines come back masked',
      craftedTicks.changes > 20 && craftedTicks.longest <= 100 && /in 6 files/u.test(craftedResult.search.header.count) && !JSON.stringify(craftedResult).includes('abcdefabcdefabcdefabcdefabcdefabcd'),
      { craftedTicks, searchMs: Date.now() - craftedAt, header: craftedResult.search.header })
    await page.keyboard.press('Control+a')
    await page.keyboard.type('madeupneedle')
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.searching === true)
    await page.waitForTimeout(40)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('zebra-replaced')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'zebra-replaced' && state.fresh && !state.searching && !!state.header }, undefined, 60_000)
    await page.waitForTimeout(1500)
    const replaced = await quick()
    check('a newer query replaces a search of the crafted files under way, and no result of the older one shows afterwards',
      replaced.search.query === 'zebra-replaced' && replaced.search.fresh && replaced.search.header.count === 'No matches' && replaced.search.rows.length === 0, { search: replaced.search })
    await page.keyboard.press('Control+a')
    await page.keyboard.type('madeupneedle')
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.searching === true)
    await page.waitForTimeout(40)
    const stopAt = Date.now()
    await page.keyboard.press('Escape')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'madeupneedle' && state.fresh && !state.searching && !!state.header })
    const craftedStopped = await quick()
    check('Esc stops a search inside the crafted files at once and says it is partial', craftedStopped.search.header.notes.includes('Partial results · search stopped') && Date.now() - stopAt < 1_000,
      { stopMs: Date.now() - stopAt, header: craftedStopped.search.header })
    // Closing the sheet during a search of the crafted files stops it (leaving the workspace closes the sheet the same
    // way, main.tsx's dialog effect): a search asked right after reopening reads as fast as one with nothing running.
    const secondsOf = (read) => Number(/· ([\d.]+) s/u.exec(read)?.[1] ?? 'NaN')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('madeupneedle')
    await waitSearch(() => window.__aitermQuickLook?.snapshot().search?.searching === true)
    await page.waitForTimeout(40)
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor({ state: 'detached' })
    await terminal.focus()
    await page.keyboard.press('Control+Shift+G')
    await sheet.waitFor()
    // The counter is watched while the next search runs, as 67.5 AC6 asks; the sheet's own closing and opening is the window's work.
    await watchTicks()
    await page.keyboard.type('zebra-after-close')
    await waitSearch(() => { const state = window.__aitermQuickLook?.snapshot().search; return state?.query === 'zebra-after-close' && state.fresh && !state.searching && !!state.header }, undefined, 60_000)
    const afterCloseTicks = await stopTicks()
    const afterClose = await quick()
    const baseSeconds = secondsOf(replaced.search.header.read)
    const afterSeconds = secondsOf(afterClose.search.header.read)
    check('closing the sheet stops a search of the crafted files: the next search reads as fast as one with nothing running, and the counter keeps arriving',
      afterSeconds <= baseSeconds + 0.6 && afterCloseTicks.longest <= 100 && afterClose.search.header.count === 'No matches',
      { baseSeconds, afterSeconds, afterCloseTicks, header: afterClose.search.header })
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
    // GNOME's file-metadata journal (gvfs-metadata/) is GIO's, not BMN's: on this desktop it lands in the made-up data
    // folder in some runs (2026-10-18). It is still read for the searched word above, and the paths it names are shown.
    const added = dataAfter.filter((path) => !dataBefore.includes(path))
    const appAdded = added.filter((path) => !relative(roots.data, path).startsWith(`gvfs-metadata${sep}`))
    const gvfsNames = added.filter((path) => !appAdded.includes(path))
      .map((path) => [...new Set(readFileSync(path, 'latin1').match(/\/[\x21-\x7e]{3,}/gu) ?? [])].slice(0, 6))
    check('nothing is written under the data folder by a search, and the searched word is in no app file', appAdded.length === 0 && traces.length === 0,
      { added, traces, gvfsNames })

    // The header's buttons by mouse (owner 2026-10-18: "test everything properly"): the Git root plate shows the
    // repository's folder, then the session folder again; Files and Contents put the keys in the field in that mode.
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    const gitPlate = sheet.locator('.ql-head button.ql-plate')
    const plateWords = [(await gitPlate.textContent())?.trim()]
    await gitPlate.click()
    await page.waitForFunction((name) => document.querySelector('dialog.quick-look .ql-head .ql-root-name')?.textContent === name, basename(root))
    plateWords.push((await gitPlate.textContent())?.trim())
    await sheet.locator('.ql-tr', { hasText: /^project$/u }).first().waitFor()
    const gitRows = await sheet.locator('.ql-tr', { hasText: /^project$/u }).count()
    await gitPlate.click()
    await page.waitForFunction(() => document.querySelector('dialog.quick-look .ql-head .ql-root-name')?.textContent === 'project')
    plateWords.push((await gitPlate.textContent())?.trim())
    check('the Git root plate shows the repository\'s folder with the session folder in it, and Session folder goes back',
      JSON.stringify(plateWords) === JSON.stringify(['Git root', 'Session folder', 'Git root']) && gitRows === 1, { plateWords, gitRows })
    // With the field in focus and empty, the printed paths take the left column, so these come last.
    await sheet.getByRole('button', { name: 'Contents', exact: true }).click()
    const toContents = await activeLabel()
    await sheet.getByRole('button', { name: 'Files', exact: true }).click()
    const toFiles = await activeLabel()
    check('the Files and Contents buttons switch the top field and put the keys in it', toContents === 'Search contents' && toFiles === 'Go to file', { toContents, toFiles })
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })

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
    // With the tree folded, Tab reaches Choose folder… and Enter opens the path from the folder picked (a stand-in picker).
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, altFolder)
    await page.keyboard.press('Control+b')
    await sheet.locator('.ql-left').waitFor({ state: 'detached' })
    const reachedChoose = []
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press('Tab')
      const label = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
      reachedChoose.push(label.slice(0, 20))
      if (label === 'Choose folder…') break
    }
    await page.keyboard.press('Enter')
    // A Markdown file opens as a page, its line marked in the block that holds it.
    await sheet.locator('.ql-page .ql-target').waitFor()
    const chosenTarget = await sheet.locator('.ql-page .ql-target').textContent()
    check('with the tree folded, Tab reaches Choose folder… and Enter opens the missing path from the folder picked, at its line',
      reachedChoose.at(-1) === 'Choose folder…' && chosenTarget.includes('Alt line three, found.'), { reachedChoose, chosenTarget })
    await page.keyboard.press('Control+b')
    for (let step = 0; step < 8 && await sheet.count(); step += 1) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
    }
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

    // ---- results of an earlier text never open: Enter before the new answer comes does nothing. The terminal still
    // holds the selected reference, so the sheet opens at it; read after he went to the top field, it takes none of its keys.
    const shown = (name) => page.waitForFunction((end) => document.querySelector('dialog.quick-look .ql-path .ql-pth')?.title.endsWith(end), name)
    await terminal.focus()
    await page.keyboard.press('Control+Shift+E')
    await sheet.waitFor()
    await page.keyboard.press('Control+p')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('plan.md')
    await page.waitForFunction(() => { const state = window.__aitermQuickLook.snapshot().search; return state?.fresh && state.rows.some((row) => row.includes('plan.md')) })
    const shownBefore = await sheet.locator('.ql-path .ql-pth').getAttribute('title').catch(() => null)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('guide.md')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(80)
    const shownStale = await sheet.locator('.ql-path .ql-pth').getAttribute('title').catch(() => null)
    const staleDimmed = await sheet.locator('.ql-results.ql-stale').count()
    const typed = await page.evaluate(() => window.__aitermQuickLook.snapshot().search?.query)
    await page.waitForFunction(() => window.__aitermQuickLook.snapshot().search?.fresh)
    await page.keyboard.press('Enter')
    await shown('guide.md')
    check('Enter while the results still answer the earlier text opens nothing; once the new answer comes it opens its file; the file the opening asked for took none of the field\'s keys',
      typed === 'guide.md' && shownStale === shownBefore && !shownStale?.endsWith('plan.md') && staleDimmed === 1, { typed, shownBefore, shownStale, staleDimmed })
    for (let step = 0; step < 8 && await sheet.count(); step += 1) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
    }
    await sheet.waitFor({ state: 'detached' })

    // ---- the sheet's states in the four colour modes: screenshots for the eye, and the contrast of 67.1 AC7 ----
    const appearance = await page.evaluate(async () => (await window.aiTerminal.getSettings()).appearance)
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
    const contrasts = {}
    for (const colorMode of ['steel', 'brown', 'dark', 'black']) {
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
      // 67.1 AC7: comments at least 4.5:1 and line numbers at least 4:1 on the code ground, measured as drawn.
      contrasts[colorMode] = await sheet.evaluate((element) => {
        const probe = document.createElement('canvas').getContext('2d')
        const rgba = (css) => {
          probe.clearRect(0, 0, 1, 1)
          probe.fillStyle = '#000'
          probe.fillStyle = css
          probe.fillRect(0, 0, 1, 1)
          return [...probe.getImageData(0, 0, 1, 1).data]
        }
        const ground = (node) => {
          for (let at = node; at; at = at.parentElement) {
            const colour = rgba(getComputedStyle(at).backgroundColor)
            if (colour[3] === 255) return colour
          }
          return [0, 0, 0, 255]
        }
        const over = (front, back) => front.slice(0, 3).map((value, index) => (value * front[3] + back[index] * (255 - front[3])) / 255)
        const luminance = (rgb) => {
          const [r, g, b] = rgb.map((value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const ratio = (node) => {
          const back = ground(node)
          const front = over(rgba(getComputedStyle(node).color), back)
          const [light, dark] = [luminance(front), luminance(back.slice(0, 3))].sort((a, b) => b - a)
          return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
        }
        return { comment: ratio(element.querySelector('.ql-code .ql-syn-comment')), lineNumber: ratio(element.querySelector('.ql-code .cm-lineNumbers .cm-gutterElement:not(:first-child)')) }
      })
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
    check('the sheet\'s states were drawn in Steel, Brown, Dark and Black', themeShots.length === 28, { themeShots: themeShots.length })
    check('comments keep at least 4.5:1 and line numbers at least 4:1 on the code ground in each colour mode',
      Object.values(contrasts).length === 4 && Object.values(contrasts).every((each) => each.comment >= 4.5 && each.lineNumber >= 4), contrasts)

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
        const othersBefore = await visibleSnapshots()
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
        const othersDuring = await visibleSnapshots()
        await page.keyboard.press('Escape')
        await sheet.waitFor({ state: 'detached' })
        await page.waitForTimeout(250)
        const after = await snapshot()
        const othersAfter = await visibleSnapshots()
        // Every terminal on screen, not only the one that had focus: none is resized or typed into.
        const sameGrid = (a, b) => !!a && !!b && a.cols === b.cols && a.rows === b.rows && a.refits === b.refits && a.ptyCols === b.ptyCols && a.ptyRows === b.ptyRows && a.inputEvents === b.inputEvents
        const shownIds = Object.keys(othersBefore)
        check(`${layout} ${width}×${height}: every terminal on screen (${shownIds.length}) keeps its grid, refits, PTY size and input count`,
          shownIds.length === (layout === 'split' ? 2 : 1) && shownIds.every((id) => sameGrid(othersBefore[id], othersDuring[id]) && sameGrid(othersBefore[id], othersAfter[id])), { shown: shownIds.length })
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
          if ([CANARY, CANARY_TWO, CANARY_JSON, PASTED, PASTED_TWO, PASTED_JSONC, PASTED_YAML, PASTED_TOML].some((value) => bytes.includes(value))) leaks.push(path)
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
    const chooser = referenceDialog.locator('.select-opener[data-label="Send to session"]')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-label') === 'Send to session')
    check('Send to session… opens today\'s dialog on that reference with the session chooser in focus', await sheet.count() === 0 &&
      await referenceDialog.locator('input[aria-label="File reference"]').inputValue() === `${project}/apps/desktop/src/parser.ts`)
    await chooser.click()
    await referenceDialog.locator(`.select-list [role="menuitemradio"][data-value="${secondId}"]`).click()
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
