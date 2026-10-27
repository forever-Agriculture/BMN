// MODULE: qa-slop.mjs - visual regression for an empty Find bar on the isolated qa:bench
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const state = JSON.parse(readFileSync(join(repo, '.dev-auto/evidence/qa-bench/current.json'), 'utf8'))
assert.equal(state.status, 'running', 'Start qa:bench first')
assert.match(state.cdp, /^http:\/\/127\.0\.0\.1:\d+$/u)
const output = join(state.run, 'find-regression')
mkdirSync(output, { recursive: true })
const browser = await chromium.connectOverCDP(state.cdp)
try {
  const page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('/renderer/'))
  assert.ok(page, 'BMN renderer')
  await page.getByRole('button', { name: 'Command palette', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search commands, workspaces, sessions and files' }).fill('Search terminal output')
  await page.getByRole('option', { name: /^Search terminal output/u }).click()
  const input = page.getByRole('textbox', { name: /^Search .+ output$/u })
  await input.waitFor()
  await page.screenshot({ path: join(output, 'empty-find.png') })
  writeFileSync(join(output, 'snapshot.txt'), await page.locator('body').ariaSnapshot())
  assert.equal(await page.locator('.session-terminal .search-result').filter({ visible: true }).count(), 0,
    'An empty Find bar must not display a squeezed help sentence as a result')
  assert.match(await input.getAttribute('title') ?? '', /^Search covers retained history \([\d,]+ lines\)$/u)
  console.log('PASS: empty Find shows no fake result; retained-history coverage remains on its input')
} finally {
  await browser.close()
}
