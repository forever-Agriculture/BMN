/* global document, requestAnimationFrame, PointerEvent, MouseEvent */
// MODULE: brain-map-visual.mjs - Epic 128.5: drive the whole-brain map on the isolated build with a synthetic switched brain; screenshots, label, key and timing checks
// Usage: node scripts/test/brain-map-visual.mjs [--dense] [--out DIR]   (after `pnpm run build`)
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { denseNotes, seedSwitchedBrain, shapedNotes } from './brain-page-fixture.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dense = process.argv.includes('--dense')
const outAt = process.argv.indexOf('--out')
const out = outAt > 0 ? resolve(process.argv[outAt + 1]) : join(repo, '.dev-auto/evidence/128/map', (dense ? 'dense-' : '') + new Date().toISOString().replaceAll(':', '-'))
mkdirSync(out, { recursive: true })
const wayland = process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY)
  ? join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
const results = []
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`) }

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const seeded = await seedSwitchedBrain({ dataRoot: join(roots.data, 'bmn'), stateRoot: join(roots.state, 'bmn'), notes: dense ? denseNotes() : shapedNotes(), withdraw: [] })
  console.log(`seeded ${seeded.notes} synthetic notes`)
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const home = join(root, 'home')
  mkdirSync(join(home, 'brain', 'files'), { recursive: true, mode: 0o700 })
  const application = await _electron.launch({
    executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, HOME: home, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'),
      OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'), BMN_LAUNCH_CWD: root,
      ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}) }
  })
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(out, `${name}.png`) }) }
    const labelsTouch = () => page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.brain-dialog svg.b-map .b-node-label')].map(text => { const box = text.getBBox(); return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, text: text.textContent } })
      const dots = [...document.querySelectorAll('.brain-dialog svg.b-map .b-node > circle:not(.b-bloom):not(.b-select)')].map(c => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), r: +c.getAttribute('r') }))
      const pairs = []
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
        const p = boxes[i], q = boxes[j]
        if (p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom) pairs.push([p.text, q.text])
      }
      const overDot = boxes.filter(b => dots.filter(d => d.x + d.r > b.left && d.x - d.r < b.right && d.y + d.r > b.top && d.y - d.r < b.bottom).length > 1).map(b => b.text)
      return { labels: boxes.length, nodes: dots.length, touching: pairs, overDot }
    })
    const counts = () => page.evaluate(() => { const svg = document.querySelector('.brain-dialog svg.b-map'); return { notes: +svg.getAttribute('data-notes'), links: +svg.getAttribute('data-links'), line: document.querySelector('.brain-dialog .b-map-numbers')?.textContent } })
    const open = async () => {
      await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
      await page.keyboard.press('Control+Shift+B')
      await page.waitForSelector('dialog.brain-dialog[open]')
      await page.waitForSelector('.brain-dialog .b-list .b-row, .brain-dialog .b-quiet:text-is("All notes")')
    }
    const openMapTimed = () => page.evaluate(() => new Promise(done => {
      const start = performance.now()
      document.querySelector('.brain-dialog .b-map-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      const poll = () => {
        const svg = document.querySelector('.brain-dialog svg.b-map')
        if (svg && svg.querySelectorAll('.b-node').length > 0) return done({ first: performance.now() - start })
        if (performance.now() - start > 5000) return done({ first: null })
        requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    }))

    const sizes = dense ? [[1280, 800, 'wide']] : [[1280, 800, 'wide'], [720, 800, 'w720'], [320, 720, 'w320']]
    for (const [width, height, tag] of sizes) {
      await page.setViewportSize({ width, height })
      await open()
      const opened = await openMapTimed()
      check(`${tag}: Map opens the whole brain within 1 s`, opened.first !== null && opened.first <= 1000, `first ${opened.first === null ? 'none' : Math.round(opened.first)} ms`)
      const c = await counts()
      const want = dense ? { notes: 1000 } : { notes: 57, links: 17 }
      check(`${tag}: the map counts every visible note${dense ? '' : ' and link'}`, c.notes === want.notes && (dense || c.links === want.links), JSON.stringify(c))
      if (!dense) check(`${tag}: numbers line`, c.line === '57 notes · 17 links · 33 alone · 8 groups, largest 5', c.line)
      const t = await labelsTouch()
      check(`${tag}: rest labels never touch each other or another dot`, t.touching.length === 0 && t.overDot.length === 0, `${t.labels} labels on ${t.nodes} dots${t.overDot.length ? '; over dots: ' + t.overDot.join(',') : ''}`)
      await shot(`${tag}-01-map`)
      // Hover names a note and lifts its links; first answer timed.
      const target = await page.evaluate(() => {
        const svg = document.querySelector('.brain-dialog svg.b-map')
        const box = svg.getBoundingClientRect()
        // A linked note that is not labelled at rest.
        const labelled = new Set([...svg.querySelectorAll('.b-node-label')].map(l => l.getAttribute('data-label')))
        const node = [...svg.querySelectorAll('.b-node')].find(g => !labelled.has(g.getAttribute('data-node')))
        const circle = node.querySelector('circle:not(.b-bloom):not(.b-select)')
        return { id: node.getAttribute('data-node'), x: box.left + +circle.getAttribute('cx'), y: box.top + +circle.getAttribute('cy') }
      })
      const hover = await page.evaluate(({ id, x, y }) => new Promise(done => {
        const start = performance.now()
        document.querySelector('.brain-dialog svg.b-map').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
        const poll = () => {
          const label = document.querySelector(`.brain-dialog svg.b-map .b-node-label[data-label="${id}"]`)
          const named = document.querySelector('.brain-dialog .b-map-hover')?.textContent
          if (named) return done({ first: performance.now() - start, label: !!label, named })
          if (performance.now() - start > 3000) return done({ first: null })
          requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
      }), target)
      check(`${tag}: hover names the note within 100 ms`, hover.first !== null && hover.first <= 100, `first ${hover.first === null ? 'none' : Math.round(hover.first)} ms; on the map ${hover.label ? 'yes' : 'no (bar only)'}`)
      await page.mouse.move(target.x, target.y)
      const lifted = await page.locator('.brain-dialog svg.b-map .b-map-edges.lifted').count()
      const th = await labelsTouch()
      check(`${tag}: hovered labels never touch`, th.touching.length === 0, `${th.labels} labels`)
      await shot(`${tag}-02-hover`)
      // Click shows it beside; double-click opens its graph; M comes back; Esc leaves.
      await page.mouse.click(target.x, target.y)
      await page.waitForSelector(`.brain-dialog svg.b-map .b-node.selected[data-node="${target.id}"]`)
      const side = await page.locator('.brain-dialog .b-side .b-side-title').textContent()
      check(`${tag}: a click shows the note beside the map`, !!side, `${side}; lifted edges ${lifted}`)
      await shot(`${tag}-03-selected`)
      await page.mouse.dblclick(target.x, target.y)
      await page.waitForSelector('.brain-dialog svg.b-graph:not(.b-map)')
      const focus = await page.locator('.brain-dialog svg.b-graph:not(.b-map)').getAttribute('data-focus')
      check(`${tag}: double-click opens its neighbourhood graph`, focus === target.id, focus ?? '')
      await page.locator('.brain-dialog svg.b-graph:not(.b-map)').focus()
      await page.keyboard.press('m')
      await page.waitForSelector(`.brain-dialog svg.b-map .b-node.selected[data-node="${target.id}"]`)
      check(`${tag}: M comes back to the map with that note selected`, true)
      await page.locator('.brain-dialog svg.b-map').focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Shift+Enter')
      await page.waitForSelector('.brain-dialog svg.b-graph:not(.b-map)')
      check(`${tag}: arrows then Shift Enter open a note's graph`, true)
      await page.keyboard.press('m')
      await page.waitForSelector('.brain-dialog svg.b-map')
      await page.keyboard.press('Escape')
      await page.waitForSelector('.brain-dialog svg.b-map', { state: 'detached' })
      check(`${tag}: Esc leaves the map, the page stays`, await page.locator('dialog.brain-dialog[open]').count() === 1)
      if (tag === 'wide' && !dense) {
        await page.locator('.brain-dialog .b-map-toggle').click()
        await page.waitForSelector('.brain-dialog svg.b-map')
        await page.locator('.brain-dialog .b-toggle').click()
        await page.waitForFunction(() => +document.querySelector('.brain-dialog svg.b-map')?.getAttribute('data-notes') === 63)
        const a = await counts()
        check('wide: Archived adds archived notes and their links', a.notes === 63 && a.links === 23, JSON.stringify(a))
        await shot('wide-04-archived')
        await page.locator('.brain-dialog .b-toggle').click()
        await page.waitForFunction(() => +document.querySelector('.brain-dialog svg.b-map')?.getAttribute('data-notes') === 57)
        for (const mode of ['black', 'dark', 'steel', 'brown']) {
          await page.evaluate(value => { document.documentElement.dataset.colorMode = value }, mode)
          await shot(`wide-05-map-${mode}`)
        }
        await page.evaluate(() => { document.documentElement.dataset.colorMode = 'black' })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.keyboard.press('Escape')
        await page.locator('.brain-dialog .b-map-toggle').click()
        await page.waitForSelector('.brain-dialog svg.b-map')
        check('wide: reduced motion draws the map in one frame (no fade)', !(await page.locator('.brain-dialog svg.b-map').getAttribute('class')).includes('fade'))
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.keyboard.press('Escape')
      }
      if (tag === 'w320') {
        await page.locator('.brain-dialog .b-map-toggle').click()
        await page.waitForSelector('.brain-dialog svg.b-map')
        const fit = await page.evaluate(() => { const bar = document.querySelector('.brain-dialog .b-bar'); return { scroll: bar.scrollWidth, client: bar.clientWidth, page: document.documentElement.scrollWidth } })
        check('w320: the top row fits without sideways scroll', fit.scroll <= fit.client + 1 && fit.page <= 320, JSON.stringify(fit))
        await page.locator('.brain-dialog .b-body').evaluate(el => { el.scrollTop = el.scrollHeight })
        await shot('w320-04-map-scrolled')
        await page.keyboard.press('Escape')
      }
      // Close the page.
      await page.locator('.brain-dialog .b-search input').focus()
      for (let i = 0; i < 4 && await page.locator('dialog.brain-dialog[open]').count(); i += 1) await page.keyboard.press('Escape')
      await page.waitForSelector('dialog.brain-dialog[open]', { state: 'detached' })
    }
  } catch (error) {
    check('drive', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
    await (await application.firstWindow()).screenshot({ path: join(out, 'failure.png') }).catch(() => undefined)
  } finally {
    const closing = application.close().catch(() => undefined)
    if (await Promise.race([closing.then(() => true), new Promise(done => setTimeout(() => done(false), 5000))]) === false) application.process().kill('SIGKILL')
  }
})
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter(result => !result.pass)
console.log(`${failed.length ? 'FAIL' : 'PASS'}: brain map visual, ${results.length - failed.length}/${results.length} checks; ${out}`)
process.exit(failed.length ? 1 : 0)
