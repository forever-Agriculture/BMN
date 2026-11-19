/* global window, document, requestAnimationFrame, KeyboardEvent, PointerEvent */
// MODULE: brain-page-visual.mjs - Epic 128: drive the Brain page on the isolated build with a synthetic switched brain; screenshots, label and timing checks
// Usage: node scripts/test/brain-page-visual.mjs [--dense] [--out DIR]   (after `pnpm run build`)
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { denseNotes, linkedNotes, seedSwitchedBrain } from './brain-page-fixture.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dense = process.argv.includes('--dense')
const outAt = process.argv.indexOf('--out')
const out = outAt > 0 ? resolve(process.argv[outAt + 1]) : join(repo, '.dev-auto/evidence/128/screens', (dense ? 'dense-' : '') + new Date().toISOString().replaceAll(':', '-'))
mkdirSync(out, { recursive: true })
const wayland = process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY)
  ? join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
if (!existsSync(join(repo, 'apps/desktop/out/main/brain-worker.js'))) throw new Error('Run pnpm run build first')
const results = []
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`) }

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const seeded = await seedSwitchedBrain({ dataRoot: join(roots.data, 'bmn'), stateRoot: join(roots.state, 'bmn'), notes: dense ? denseNotes() : linkedNotes(), withdraw: dense ? [] : ['Mistaken note'] })
  console.log(`seeded ${seeded.notes} synthetic notes`)
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const application = await _electron.launch({
    executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
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
    const shot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: join(out, `${name}.png`) }) }
    const open = async () => {
      await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
      await page.keyboard.press('Control+Shift+B')
      await page.waitForSelector('dialog.brain-dialog[open]')
    }
    const labelsTouch = () => page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.brain-dialog .b-node-label')].map(text => { const box = text.getBBox(); return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, text: text.textContent } })
      const pairs = []
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
        const p = boxes[i], q = boxes[j]
        if (p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom) pairs.push([p.text, q.text])
      }
      return { labels: boxes.length, nodes: document.querySelectorAll('.brain-dialog .b-node').length, touching: pairs }
    })
    const atRest = () => page.waitForFunction(() => document.querySelector('.brain-dialog svg.b-graph')?.getAttribute('data-at-rest') === 'yes')

    for (const [width, height, tag] of dense ? [[1280, 800, 'wide']] : [[1280, 800, 'wide'], [720, 800, 'w720'], [320, 720, 'w320']]) {
      await page.setViewportSize({ width, height })
      await open()
      // It opens on the note he last read; the list is one step away.
      await page.waitForSelector('.brain-dialog .b-list .b-row, .brain-dialog .b-quiet:text-is("All notes")')
      if (await page.locator('.brain-dialog .b-quiet:text-is("All notes")').count()) await page.locator('.brain-dialog .b-quiet:text-is("All notes")').click()
      await page.waitForSelector('.brain-dialog .b-list .b-row')
      if (!dense) {
        await shot(`${tag}-01-list`)
        await page.locator('.brain-dialog .b-search input').fill('decision backup')
        await page.waitForSelector('.brain-dialog .b-list-head:has-text("note")')
        const titles = await page.locator('.brain-dialog .b-row-title').allTextContents()
        check(`${tag}: two-word search finds notes with both words apart`, titles.includes('Backup plan') && titles.includes('Backup decision'), titles.join(', '))
        await shot(`${tag}-02-search`)
        await page.locator('.brain-dialog .b-search input').fill('QA backup')
        await page.waitForFunction(() => [...document.querySelectorAll('.brain-dialog .b-row-title')].map(e => e.textContent).join('|') === 'Restore drill')
        check(`${tag}: short word QA is checked`, true)
        await page.locator('.brain-dialog .b-search input').fill('бекап')
        await page.waitForSelector('.brain-dialog .b-empty:has-text("The notes are in English")')
        check(`${tag}: Cyrillic nothing-found line`, true)
        await shot(`${tag}-03-no-result`)
        await page.locator('.brain-dialog .b-search input').fill('Backup plan')
        await page.waitForSelector('.brain-dialog .b-row.current .b-row-title:text-is("Backup plan")')
        await page.keyboard.press('Enter')
        await page.waitForSelector('.brain-dialog .b-title:text-is("Backup plan")')
        await shot(`${tag}-04-note`)
        if (tag === 'wide') {
          const side = await page.locator('.brain-dialog .b-side').innerText()
          check('note side panel names links, back links and missing', /LINKS TO/i.test(side) && /LINKED FROM/i.test(side), side.split('\n').slice(0, 3).join(' / '))
          await page.locator('.brain-dialog .ql-md-a', { hasText: 'Restore drill' }).first().click()
          await page.waitForSelector('.brain-dialog .b-title:text-is("Restore drill")')
          await page.evaluate(() => { window.__brainKeys = []; window.addEventListener('keydown', event => window.__brainKeys.push(`${event.altKey ? 'Alt+' : ''}${event.key}@${event.target?.className ?? ''}`), true) })
          await page.keyboard.press('Alt+ArrowLeft')
          await page.waitForSelector('.brain-dialog .b-title:text-is("Backup plan")', { timeout: 3000 }).catch(async error => {
            console.log('keys seen', await page.evaluate(() => window.__brainKeys), 'back disabled', await page.locator('.brain-dialog button[aria-label="Back"]').isDisabled())
            throw error
          })
          await page.keyboard.press('Alt+ArrowRight')
          await page.waitForSelector('.brain-dialog .b-title:text-is("Restore drill")')
          check('a link opens its note; Alt ← and → go back and forward', true)
          await page.locator('.brain-dialog .b-ref', { hasText: 'Backup decision' }).first().click()
          await page.waitForSelector('.brain-dialog .b-title:text-is("Backup decision")')
          const missing = await page.locator('.brain-dialog .ql-md-a[data-target="none"]').allTextContents()
          check('an unresolved link is muted text', missing.includes('Missing design note'), missing.join(', '))
          await page.locator('.brain-dialog .b-text').click()
          await page.keyboard.press('h')
          await page.waitForSelector('.brain-dialog .b-history .b-versions .b-row')
          await shot(`${tag}-05-history`)
          await page.keyboard.press('Escape')
          await page.waitForSelector('.brain-dialog .b-title:text-is("Backup decision")')
          check('Esc closes History first, the page stays', true)
        }
      } else {
        await page.locator('.brain-dialog .b-row').first().click()
        await page.waitForSelector('.brain-dialog .b-title')
      }
      // The graph.
      await page.locator('.brain-dialog .b-body').click({ position: { x: 4, y: 4 } }).catch(() => undefined)
      const openTiming = await page.evaluate(() => new Promise(done => {
        const start = performance.now()
        document.querySelector('.brain-dialog .b-box').dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))
        let first = null
        const poll = () => {
          const svg = document.querySelector('.brain-dialog svg.b-graph')
          if (svg && first === null) first = performance.now() - start
          if (svg?.getAttribute('data-at-rest') === 'yes') return done({ first, rest: performance.now() - start })
          if (performance.now() - start > 5000) return done({ first, rest: null })
          requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
      }))
      await atRest()
      await shot(`${tag}-06-graph`)
      const touching = await labelsTouch()
      check(`${tag}: graph labels never touch (G3)`, touching.touching.length === 0, `${touching.labels} labels on ${touching.nodes} nodes`)
      if (dense) {
        check('dense: open answers within 100 ms', openTiming.first !== null && openTiming.first <= 100, `first ${Math.round(openTiming.first)} ms`)
        check('dense: open at rest within 1 s', openTiming.rest !== null && openTiming.rest <= 1000, `rest ${Math.round(openTiming.rest)} ms`)
        check('dense: at most 150 nodes', touching.nodes <= 150, `${touching.nodes} nodes`)
        const hover = await page.evaluate(() => new Promise(done => {
          const nodes = [...document.querySelectorAll('.brain-dialog .b-node:not(.focus)')]
          const node = nodes[nodes.length - 1]
          const id = node.getAttribute('data-node')
          const start = performance.now()
          node.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
          node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
          const poll = () => {
            const lifted = document.querySelector('.brain-dialog .b-edge[data-lifted="yes"]') || document.querySelectorAll('.brain-dialog .b-node-label').length
            if (lifted) return done({ id, first: performance.now() - start })
            if (performance.now() - start > 3000) return done({ id, first: null })
            requestAnimationFrame(poll)
          }
          requestAnimationFrame(poll)
        }))
        check('dense: hover answers within 100 ms', hover.first !== null && hover.first <= 100, `first ${hover.first === null ? 'none' : Math.round(hover.first)} ms`)
        await page.locator('.brain-dialog svg.b-graph').focus()
        const refocus = await page.evaluate(() => new Promise(done => {
          const svg = document.querySelector('.brain-dialog svg.b-graph')
          const before = svg.getAttribute('data-focus')
          svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
          requestAnimationFrame(() => {
            const start = performance.now()
            document.querySelector('.brain-dialog svg.b-graph').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
            let first = null
            const poll = () => {
              const now = document.querySelector('.brain-dialog svg.b-graph')
              const changed = now && now.getAttribute('data-focus') !== before
              if (changed && first === null) first = performance.now() - start
              if (changed && now.getAttribute('data-at-rest') === 'yes') return done({ first, rest: performance.now() - start })
              if (performance.now() - start > 5000) return done({ first, rest: null })
              requestAnimationFrame(poll)
            }
            requestAnimationFrame(poll)
          })
        }))
        check('dense: refocus answers within 100 ms', refocus.first !== null && refocus.first <= 100, `first ${refocus.first === null ? 'none' : Math.round(refocus.first)} ms`)
        check('dense: refocus at rest within 1 s', refocus.rest !== null && refocus.rest <= 1000, `rest ${refocus.rest === null ? 'none' : Math.round(refocus.rest)} ms`)
        await shot(`${tag}-07-dense-refocused`)
        // Depth 3 passes the cap: at most 150 nodes, and the change answers and settles in time.
        await page.locator('.brain-dialog svg.b-graph').focus()
        const deep = await page.evaluate(() => new Promise(done => {
          const start = performance.now()
          document.querySelector('.brain-dialog .b-box').dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }))
          let first = null
          const poll = () => {
            const svg = document.querySelector('.brain-dialog svg.b-graph')
            const changed = svg?.getAttribute('data-depth') === '3'
            if (changed && first === null) first = performance.now() - start
            if (changed && svg.getAttribute('data-at-rest') === 'yes') return done({ first, rest: performance.now() - start, nodes: document.querySelectorAll('.brain-dialog .b-node').length, more: document.querySelector('.brain-dialog .b-graph-count')?.textContent })
            if (performance.now() - start > 5000) return done({ first, rest: null })
            requestAnimationFrame(poll)
          }
          requestAnimationFrame(poll)
        }))
        check('dense: depth 3 is capped at 150 nodes with the rest counted', deep.nodes <= 150 && /more not drawn/.test(deep.more ?? ''), `${deep.nodes} nodes; ${deep.more}`)
        check('dense: depth 3 answers within 100 ms and rests within 1 s', deep.first !== null && deep.first <= 100 && deep.rest !== null && deep.rest <= 1000, `first ${Math.round(deep.first)} ms, rest ${Math.round(deep.rest)} ms`)
        const t3 = await labelsTouch()
        check('dense: depth 3 labels never touch', t3.touching.length === 0, `${t3.labels} labels on ${t3.nodes} nodes`)
        await shot(`${tag}-08-dense-depth3`)
        results.push({ name: 'timings', pass: true, detail: JSON.stringify({ openTiming, hover, refocus, deep }) })
      } else {
        for (const depth of ['1', '2', '3']) {
          await page.locator('.brain-dialog svg.b-graph').focus()
          await page.keyboard.press('Tab').catch(() => undefined)
          await page.locator('.brain-dialog .b-box').press(depth)
          await page.waitForFunction(value => document.querySelector('.brain-dialog svg.b-graph')?.getAttribute('data-depth') === value, depth)
          await atRest()
          const t = await labelsTouch()
          check(`${tag}: depth ${depth} labels never touch`, t.touching.length === 0, `${t.labels} labels on ${t.nodes} nodes`)
        }
        await shot(`${tag}-07-graph-depth3`)
        if (tag === 'wide') {
          await page.locator('.brain-dialog .b-toggle').click()
          await atRest()
          await shot(`${tag}-08-graph-archived`)
          await page.locator('.brain-dialog .b-toggle').click()
          for (const mode of ['dark', 'steel', 'brown']) {
            await page.evaluate(value => { document.documentElement.dataset.colorMode = value }, mode)
            await shot(`${tag}-09-graph-${mode}`)
          }
          await page.evaluate(() => { document.documentElement.dataset.colorMode = 'black' })
          await page.locator('.brain-dialog .b-quiet', { hasText: 'All notes' }).click()
          await page.locator('.brain-dialog .b-withdrawn .b-fold').click()
          await page.waitForSelector('.brain-dialog .b-withdrawn .b-row')
          await shot(`${tag}-10-withdrawn`)
          await page.locator('.brain-dialog .b-withdrawn .b-row').first().click()
          await page.waitForSelector('.brain-dialog .b-chip:text-is("withdrawn")')
          const actions = await page.locator('.brain-dialog button').allTextContents()
          check('no edit, new-note, withdraw or restore action', !actions.some(text => /^(Edit|New note|Withdraw|Restore|Delete)/.test(text.trim())), actions.join('|').slice(0, 200))
          await shot(`${tag}-11-withdrawn-note`)
        }
      }
      // Esc steps back to the note, then closes.
      await page.locator('.brain-dialog .b-search input').focus()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.waitForSelector('dialog.brain-dialog[open]', { state: 'detached' })
      check(`${tag}: Esc steps back, then closes`, true)
    }
    // The palette entry and the top bar word.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: 'Brain', exact: true }).click()
    await page.waitForSelector('dialog.brain-dialog[open]')
    await shot('top-bar-open')
    await page.keyboard.press('Control+Shift+B')
    await page.waitForSelector('dialog.brain-dialog[open]', { state: 'detached' })
    check('top-bar Brain opens and Ctrl Shift B closes', true)
  } catch (error) {
    check('drive', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
    await (await application.firstWindow()).screenshot({ path: join(out, 'failure.png') }).catch(() => undefined)
  } finally {
    // A live shell asks before closing; the test root goes either way, so a slow close ends the process.
    const closing = application.close().catch(() => undefined)
    if (await Promise.race([closing.then(() => true), new Promise(done => setTimeout(() => done(false), 5000))]) === false) application.process().kill('SIGKILL')
  }
})
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter(result => !result.pass)
console.log(`${failed.length ? 'FAIL' : 'PASS'}: brain page visual, ${results.length - failed.length}/${results.length} checks; ${out}`)
process.exit(failed.length ? 1 : 0)
