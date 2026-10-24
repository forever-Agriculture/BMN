#!/usr/bin/env node
// MODULE: terminal-states.mjs - Story 91.2 AC3: the terminal states a drawing fix must keep, as settled captures of one built app, and two sets compared to the pixel
/* global window, document, requestAnimationFrame */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const USAGE = `Usage: node scripts/test/terminal-states.mjs --out DIR [--app DIR] [--electron PATH]
       node scripts/test/terminal-states.mjs --compare A B
Starts the built app in --app (default this checkout's apps/desktop; pnpm run build there first) in test mode with temporary
folders, on Chromium's headless platform at a device scale of 1 as test:visual does, opens one session whose program
prints each state when asked, and saves each settled terminal as DIR/<state>.png with its buffer text in DIR/states.json.
The states are Story 91.2 AC3's: plain, 256-colour and true-colour text; bold, italic and underline; wide characters and
emoji; a selection; the cursor; rows rewritten inside a synchronized update; a Sixel image; scrollback after a
resize. --compare prints PASS when every capture of A is
identical to B's to the pixel, else each state's count of differing pixels, and exits 1.`

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const option = (argv, name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)

const sgr = (codes, text) => `\u001b[${codes}m${text}\u001b[0m`
/** A 48 × 36 px Sixel in two colours, red over blue. */
const SIXEL = `\u001bP9;1;0q"1;1;48;36#1;2;100;0;0#2;2;0;0;100#1${Array(3).fill('!48~').join('-')}-#2${Array(3).fill('!48~').join('-')}\u001b\\`

/** Each state's bytes, ending on a line that names it; the player clears the screen and its scrollback first. */
export function stateBytes() {
  const colours = Array.from({ length: 256 }, (_, index) => `\u001b[48;5;${index}m ${index % 16 === 15 ? '\u001b[0m\r\n' : ''}`).join('')
  const ramp = Array.from({ length: 64 }, (_, index) => `\u001b[38;2;${index * 4};${255 - index * 4};128m█`).join('')
  const text = [
    'Plain text: The quick brown fox jumps over the lazy dog 0123456789 ~!@#$%^&*()_+{}|:"<>?',
    `${sgr('31', 'red')} ${sgr('32', 'green')} ${sgr('33', 'yellow')} ${sgr('34', 'blue')} ${sgr('35', 'magenta')} ${sgr('36', 'cyan')} ${sgr('91', 'bright red')} ${sgr('38;5;208', '256-colour 208')} ${sgr('38;2;255;105;180', 'true colour')}`,
    `${colours}\u001b[0m`,
    `${ramp}\u001b[0m`
  ].join('\r\n')
  return {
    text: `${text}\r\nSTATE text`,
    styles: `${[sgr('1', 'bold'), sgr('3', 'italic'), sgr('4', 'underline'), sgr('1;3;4', 'bold italic underline'), sgr('2', 'dim'),
      sgr('7', 'inverse'), sgr('9', 'strikethrough'), sgr('4:2', 'double underline'), sgr('4:3', 'curly underline'), sgr('53', 'overline')].join('  ')}\r\nSTATE styles`,
    wide: `漢字かなカナ 한국어 中文字符 | 😀🚀👍🏽❤️🎉 | ┌─┬─┐ │a│b│ └─┴─┘ | → ← ↑ ↓ ✓ ✗ … —\r\nSTATE wide`,
    selection: `${text}\r\nSTATE selection`,
    cursor: `${text}\r\nSTATE cursor\u001b[12;30H`,
    // Story 91.2's fix: rows rewritten inside a synchronized update, the rest of the screen left as it was drawn.
    synced: `${text}\r\nSTATE synced\u001b[?2026h\u001b[2;1H\u001b[2K${sgr('1;35', 'rewritten inside a synchronized update')}\u001b[8;5H${sgr('7', 'also here')}\u001b[?2026l`,
    sixel: `Image below:\r\n${SIXEL}\r\nSTATE sixel`,
    scrollback: `${Array.from({ length: 300 }, (_, index) => `line ${String(index + 1).padStart(3, '0')} ${'·'.repeat(index % 40)}`).join('\r\n')}\r\nSTATE scrollback`
  }
}

const PLAYER = `
const { readFileSync } = require('node:fs')
const states = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const keys = Object.keys(states)
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (bytes) => {
  const state = states[keys[bytes[0] - 97]]
  if (state !== undefined) process.stdout.write('\\u001b[H\\u001b[2J\\u001b[3J' + state)
})
`

async function capture(argv) {
  const out = resolve(option(argv, '--out'))
  const app = resolve(option(argv, '--app', join(repo, 'apps/desktop')))
  const electronPath = option(argv, '--electron', null) ?? createRequire(join(app, 'package.json'))('electron')
  mkdirSync(out, { recursive: true })
  const states = stateBytes()
  const report = { app, states: {} }
  await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
    const home = join(root, 'home')
    mkdirSync(home)
    writeFileSync(join(root, 'player.cjs'), PLAYER)
    writeFileSync(join(root, 'states.json'), JSON.stringify(states))
    const application = await electron.launch({
      executablePath: electronPath,
      args: ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--force-device-scale-factor=1',
        '--disable-partial-raster', '--num-raster-threads=1', app, '--bmn-test-mode', '--', process.execPath, join(root, 'player.cjs'), join(root, 'states.json')],
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin', HOME: home, SHELL: '/bin/bash', LANG: 'C.UTF-8', TZ: 'UTC',
        ...(process.env.USER ? { USER: process.env.USER } : {}),
        XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
        BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'),
        BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root
      }
    })
    try {
      const page = await application.firstWindow()
      page.setDefaultTimeout(30_000)
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
      // Test mode's first session runs the program after `--`: here the state player.
      await page.waitForSelector('.session-terminal:not(.session-terminal-hidden) .xterm-screen')
      const sessionId = await page.evaluate(() => document.querySelector('.session-terminal:not(.session-terminal-hidden)').getAttribute('data-session-id'))
      const pane = `.session-terminal[data-session-id="${sessionId}"]:not(.session-terminal-hidden)`
      // The player is asked as a user would ask it: a key typed into the shown terminal.
      const input = page.locator(`${pane} .xterm-helper-textarea`)
      const snapshot = () => page.evaluate((id) => window.__aitermTest.snapshot(id), sessionId)
      const settle = () => page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
      for (const [index, name] of Object.keys(states).entries()) {
        await input.focus()
        await page.keyboard.press(String.fromCharCode(97 + index))
        await page.waitForFunction(({ id, marker }) => window.__aitermTest.snapshot(id).bufferLines.some((line) => line === marker), { id: sessionId, marker: `STATE ${name}` })
        if (name === 'selection') await page.evaluate((id) => window.__aitermTest.view(id).select(0, 0, 60), sessionId)
        if (name === 'scrollback') {
          const before = (await snapshot()).cols
          await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 760))
          await page.waitForFunction(({ id, cols }) => window.__aitermTest.snapshot(id).cols !== cols, { id: sessionId, cols: before })
          await sleep(500)
          const box = await page.locator(`${pane} .xterm-screen`).boundingBox()
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.wheel(0, -600)
        }
        await settle()
        await sleep(300)
        const path = join(out, `${name}.png`)
        await page.locator(`${pane} .xterm-screen`).screenshot({ path, animations: 'disabled', caret: 'hide' })
        const shown = await snapshot()
        report.states[name] = { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), cols: shown.cols, rows: shown.rows,
          selection: await page.evaluate((id) => window.__aitermTest.view(id).selection(), sessionId), lines: shown.bufferLines.slice(-shown.rows) }
        if (name === 'selection') await page.evaluate((id) => window.__aitermTest.view(id).clearSelection(), sessionId)
        console.error(`terminal-states: ${name} ${report.states[name].sha256.slice(0, 12)}`)
      }
    } finally {
      await application.evaluate(({ app: running }) => running.exit(0)).catch(() => undefined)
      await sleep(1_000)
    }
  })
  writeFileSync(join(out, 'states.json'), `${JSON.stringify(report, null, 2)}\n`)
  return 0
}

/** An 8-bit RGBA or RGB, non-interlaced PNG's pixels, four bytes each (Chromium's captures are of this kind). */
export function decodePng(bytes) {
  let at = 8
  let width = 0
  let height = 0
  let channels = 4
  const data = []
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('ascii', at + 4, at + 8)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || ![2, 6].includes(body[9]) || body[12] !== 0) throw new Error('only 8-bit RGB or RGBA, non-interlaced PNGs are read')
      channels = body[9] === 6 ? 4 : 3
    }
    if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4, 255)
  const previous = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    for (let index = 0; index < stride; index += 1) {
      const value = raw[row * (stride + 1) + 1 + index]
      const left = index >= channels ? line[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      const paeth = () => {
        const estimate = left + up - upLeft
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
        return a <= b && a <= c ? left : b <= c ? up : upLeft
      }
      const predictor = [0, left, up, (left + up) >> 1, filter === 4 ? paeth() : 0][filter]
      line[index] = (value + predictor) & 255
    }
    for (let column = 0; column < width; column += 1) line.copy(pixels, (row * width + column) * 4, column * channels, column * channels + channels)
    line.copy(previous)
  }
  return { width, height, pixels }
}

/** How many pixels of two captures differ, or null when their sizes do. */
export function differingPixels(first, second) {
  if (first.width !== second.width || first.height !== second.height) return null
  let count = 0
  for (let at = 0; at < first.pixels.length; at += 4) if (first.pixels.compare(second.pixels, at, at + 4, at, at + 4) !== 0) count += 1
  return count
}

function compare(first, second) {
  let same = true
  for (const name of Object.keys(JSON.parse(readFileSync(join(first, 'states.json'), 'utf8')).states).map((state) => `${state}.png`)) {
    const [a, b] = [readFileSync(join(first, name)), readFileSync(join(second, name))]
    const count = a.equals(b) ? 0 : differingPixels(decodePng(a), decodePng(b))
    if (count !== 0) same = false
    console.log(`${count === 0 ? 'PASS' : 'FAIL'} ${name}${count === 0 ? ' identical' : count === null ? ' sizes differ' : ` ${count} pixels differ`}`)
  }
  return same ? 0 : 1
}

async function main(argv) {
  if (argv.includes('--compare')) return compare(resolve(argv[argv.indexOf('--compare') + 1]), resolve(argv[argv.indexOf('--compare') + 2]))
  if (argv.includes('--help') || !option(argv, '--out')) { console.log(USAGE); return argv.includes('--help') ? 0 : 2 }
  return capture(argv)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
