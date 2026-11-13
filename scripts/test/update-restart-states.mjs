/* global window, document */
// MODULE: update-restart-states.mjs - Epic 125 (125.4 AC7): the restart dialog drawn in each of its four states at 680 px, with fixed rows and no agent
//
// Usage: node scripts/test/native-test-home.mjs -- node scripts/test/update-restart-states.mjs
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUpdateRestartFixture } from './update-restart-fixture.mjs'
import { installRestartStates } from './update-restart-qa-fixture.mjs'

const f = createUpdateRestartFixture()
let current
try {
  current = await f.launch(['--', '/bin/bash', '--noprofile', '--norc'])
  const { app, page } = current
  await page.waitForSelector('.session-row', { timeout: 30_000 })
  await installRestartStates(app, { runId: 'states' })
  await page.waitForFunction(async () => (await window.aiTerminal.updateRestart('status')).sessions.length === 4, null, { timeout: 15_000 })
  const offer = () => app.evaluate(() => { globalThis.bmnRestartQa.open = true })
  const read = async (name, title) => {
    const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(f.out, `${name}-680.png`) })
    const rows = await Promise.all((await dialog.locator('li').all()).map(async li => `${await li.locator('.name').innerText()}: ${await li.locator('.detail').innerText()}`))
    const look = await dialog.evaluate(node => {
      const style = window.getComputedStyle(node), parts = [node, ...node.querySelectorAll('*')]
      // The identity gold, as the page itself resolves it; nothing in this dialog may wear it (no row waits behind a colour).
      const probe = document.createElement('i'); probe.style.color = 'var(--identity)'; node.append(probe)
      const identity = window.getComputedStyle(probe).color; probe.remove()
      const gold = parts.filter(part => { const look = window.getComputedStyle(part); return [look.color, look.backgroundColor, look.borderTopColor, look.outlineColor].includes(identity) && (look.outlineStyle !== 'none' || look.color === identity || look.backgroundColor === identity) })
        .map(part => `${part.tagName.toLowerCase()}.${part.className}: ${part.textContent?.trim().slice(0, 30)}`)
      const outlined = [...node.querySelectorAll('li, ul, p')].filter(part => parseFloat(window.getComputedStyle(part).borderTopWidth) > 0 && parseFloat(window.getComputedStyle(part).borderLeftWidth) > 0).length
      return { width: Math.round(node.getBoundingClientRect().width), overflow: node.scrollWidth > node.clientWidth, font: style.fontFamily.split(',')[0], gold, outlined }
    })
    const text = await dialog.innerText()
    assert(!/\b\d+ ?(?:s|sec|seconds|min|minutes) (?:left|remaining)\b|\bin \d+ (?:seconds|minutes)\b/iu.test(text), `${name}: a countdown is shown`)
    assert.equal(look.overflow, false, `${name}: the dialog overflows at 680 px`); assert.deepEqual(look.gold, [], `${name}: gold is used`); assert.equal(look.outlined, 0, `${name}: an outlined box is drawn`)
    for (const row of [title, ...rows.map(line => line.split(': ')[1])]) assert(row.length <= 40, `${name}: "${row}" is over 40 characters`)
    return { name, title, rows, look }
  }
  const states = []
  await offer()
  states.push(await read('offer', 'Restart for the update?'))
  const press = async label => { await page.locator('dialog[open]').getByRole('button', { name: label, exact: true }).click() }
  await press('Restart'); states.push(await read('waiting', 'Restarting · closes by 14:37'))
  await press('Cancel'); states.push(await read('cancelled', 'Cancelled · 2 not told to carry on'))
  await press('Close'); await page.locator('dialog[open]').first().waitFor({ state: 'hidden' })
  await offer(); await page.getByRole('dialog', { name: 'Restart for the update?', exact: true }).waitFor()
  await press('Restart'); await page.getByRole('dialog', { name: 'Restarting · closes by 14:37', exact: true }).waitFor()
  await press('Restart now'); states.push(await read('after', 'Restarted on 1234567'))
  assert.deepEqual(states[0].rows, ['Epic 114: claude · working', 'Epic 118: codex · state not known', 'Epic 119: codex · working', 'Pet-128: claude · idle'])
  assert.deepEqual(states[1].rows, ['Epic 114: Reaching a safe point', 'Epic 118: Not told yet', 'Epic 119: Ready', 'Pet-128: Ready'])
  assert.deepEqual(states[2].rows, ['Epic 118: Not told to carry on', 'Epic 119: Stopped for the restart · type continue'])
  assert.deepEqual(states[3].rows, ['Epic 114: Resumed · told to check its work', 'Epic 118: Resumed · not told, not ready at close', 'Epic 119: Resumed · not told, type continue', 'Pet-128: Resumed'])
  const result = { result: 'PASS', out: f.out, states }
  writeFileSync(join(f.out, 'states.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.log(JSON.stringify({ result: 'FAIL', problem: error.message, out: f.out })); process.exitCode = 1
  if (current) await current.page.screenshot({ path: join(f.out, 'failure.png') }).catch(() => {})
} finally {
  if (current) { await current.app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await current.app.close().catch(() => {}) }
  f.cleanup()
}
