/* global getComputedStyle, window */
// MODULE: browser-accounts-ui.mjs - Real isolated Electron account states/actions at two viewport sizes; no renderer mocks.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { BrowserAccountsStore, atomicJson } from '../../apps/desktop/bin/browser-accounts-store.mjs'
import { AccountBrowserRelay, authenticatorCode } from '../../apps/desktop/bin/browser-account-relay.mjs'
import { assertNoValues, isolatedMain, privateKeyring, recordProcess, result, stopProcess, syntheticSite } from './browser-accounts-fixture.mjs'

const out = resolve(process.argv[2] || '.dev-auto/evidence/accounts-ui')
isolatedMain(out)
recordProcess(process.pid, '97 isolated Electron UI driver')
const ring = await privateKeyring(), store = new BrowserAccountsStore(), site = await syntheticSite()
const config = join(process.env.HOME, 'config/bmn/agents')
mkdirSync(config, { recursive: true, mode: 0o700 })
writeFileSync(join(config, 'roster.md'), readFileSync('apps/desktop/src/utility/test-fixtures/agents/roster-example.md'))
const require = createRequire(resolve('apps/desktop/package.json'))
const binaryAt = process.argv.indexOf('--electron')
const executablePath = binaryAt < 0 ? require('electron') : resolve(process.argv[binaryAt + 1])
let application, relay, applicationIdentity
const checks = [], shots = []
async function bounded(promise, milliseconds) {
  let timer
  try { return await Promise.race([promise.then(() => true, () => false), new Promise(ok => { timer = setTimeout(() => ok(false), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
try {
  application = await electron.launch({ executablePath, chromiumSandbox: true,
    args: ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--force-device-scale-factor=1',
      resolve('apps/desktop'), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: process.env.HOME,
    env: { ...process.env, BMN_CONFIG_HOME: join(process.env.HOME, 'config/bmn'),
      BMN_STATE_HOME: join(process.env.HOME, 'state/bmn'), BMN_RUNTIME_HOME: join(process.env.XDG_RUNTIME_DIR, 'bmn'),
      BMN_LAUNCH_CWD: process.env.HOME, CLAUDE_CONFIG_DIR: join(process.env.HOME, 'config/claude'),
      CODEX_HOME: join(process.env.HOME, 'config/codex'), OPENCODE_CONFIG_DIR: join(process.env.HOME, 'config/opencode'),
      BMN_BROWSER_ACCOUNTS_TEST_ROOT: out, BMN_BROWSER_ACCOUNTS_TEST_ORIGIN: site.origin,
      SHELL: '/bin/bash', LANG: 'C.UTF-8', TZ: 'UTC' }
  })
  applicationIdentity = recordProcess(application.process().pid, '97 disposable candidate Electron')
  const page = await application.firstWindow()
  const listenerCount = await application.evaluate(({ app }) => app.listenerCount('bmn-test:browser-account-hands'))
  assert.equal(listenerCount, 1, 'exact-page test hands were not attached before the first window')
  const hands = async accountId => {
    const code = authenticatorCode(site.authenticator); site.values.push(code)
    return await application.evaluate(({ app }, input) => new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: false, code: 'DRIVER_TIMEOUT' }), 30_000)
      const done = result => { clearTimeout(timer); resolve(result) }
      if (!app.emit('bmn-test:browser-account-hands', input, done)) done({ ok: false, code: 'NO_LISTENER' })
    }), { id: accountId, username: 'synthetic', password: site.password, code })
  }
  const initialPosts = site.attempts.length
  const missing = await hands('missing-synthetic-account')
  assert.deepEqual(missing, { ok: false, code: 'NO_SESSION' }, 'missing-session preflight timed out or touched another session')
  assert.equal(site.attempts.length, initialPosts)
  atomicJson(join(out, 'adapter-preflight.json'), { listenerCount, missingSessionRejected: true, unchangedPosts: true })
  checks.push('one exact-page test listener attached before first window; nonexistent session explicitly refused without a sign-in POST')
  await page.locator('.preferences-button').click()
  const dialog = page.locator('.preferences-dialog'), main = dialog.locator('.preferences-page:not([hidden])')
  await dialog.locator('.preferences-nav .nav-item', { hasText: /^Integrations/ }).click()
  const tools = async () => { await main.locator('.page-views [role=radio]', { hasText: /^Tools$/ }).click(); await page.getByRole('region', { name: 'Browser accounts' }).waitFor() }
  await tools()
  const section = page.locator('section.browser-accounts')
  const resize = async width => {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height: 1000 })
    await page.waitForFunction(size => window.innerWidth === size.width && window.innerHeight === size.height, { width, height: 1000 })
  }
  const capture = async (state, width, target = section) => {
    await target.scrollIntoViewIfNeeded()
    const name = `${width}-${state}.png`
    await target.screenshot({ path: join(out, name) })
    const overflow = await section.evaluate(el => el.scrollWidth > el.clientWidth + 1)
    assert(!overflow, `${state} account section overflows horizontally`)
    const bounds = await section.locator('button:visible').evaluateAll(elements => elements.map(el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el)
      return { visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden', right: r.right, left: r.left }
    }))
    assert(bounds.every(r => r.visible && r.left >= 0 && r.right <= width), `${state} action outside viewport`)
    assert.equal(await section.locator('select').count(), 0)
    shots.push({ state, width, path: join(out, name) })
  }
  for (const width of [1440, 900]) {
    await resize(width)
    await capture('empty', width)
    await section.getByRole('button', { name: 'Add account', exact: true }).click()
    await capture('adding', width)
    await section.getByLabel('Name', { exact: true }).fill('UI sign-in')
    await section.getByLabel('Start page').fill(site.url('same'))
    await section.getByRole('button', { name: 'Sign in…', exact: true }).click()
    await section.getByText('Finish signing in the window, then press Done').waitFor()
    await capture('signing-in', width)
    await section.getByRole('button', { name: 'Cancel', exact: true }).click()
    await section.getByText('No browser accounts yet.').waitFor()
  }
  checks.push('actual UI Add opens a separate browser; Cancel removes it, at narrow and wide sizes')
  for (const [name, state, marked] of [['Synthetic owner', 'Signed in', false], ['Unconfirmed synthetic', 'Not confirmed', false],
    ['Expired synthetic', 'Sign in again', false], ['Locked synthetic', 'Keyring locked', false], ['Marked synthetic', 'Signed in', true]]) {
    const row = await store.create(name, site.url('same'))
    store.writeMeta({ ...row, state, marked, checked: '2026-01-01T10:42:00Z', signInOrigins: [site.origin] })
  }
  await section.getByText('Synthetic owner', { exact: true }).waitFor()
  for (const width of [1440, 900]) {
    await resize(width)
    await capture('account-states', width)
    for (const [name, state] of [['Synthetic owner', 'signed-in'], ['Unconfirmed synthetic', 'not-confirmed'], ['Expired synthetic', 'sign-in-again'], ['Locked synthetic', 'keyring-locked'], ['Marked synthetic', 'marked']]) {
      await capture(state, width, section.locator('.browser-account', { hasText: name }))
    }
    const row = section.locator('.browser-account', { hasText: 'Synthetic owner' })
    await row.getByRole('button', { name: 'Agents may sign in' }).click()
    await capture('marking', width, row)
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    await row.getByRole('button', { name: 'Remove', exact: true }).click()
    await capture('removing', width, row)
    await row.getByRole('button', { name: 'Keep', exact: true }).click()
  }
  for (const text of ['Not confirmed', 'Sign in again', 'Keyring locked', 'Agents sign in']) assert(await section.getByText(text, { exact: true }).count())
  checks.push('all nine written states and marking editor captured at 1440 and 900, usable actions and no horizontal overflow')
  await main.locator('.page-views [role=radio]', { hasText: /^Health$/ }).click()
  const expired = main.locator('.health-row', { hasText: 'Expired synthetic' })
  const expiredAccount = store.list().find(row => row.name === 'Expired synthetic')
  for (const width of [1440, 900]) {
    await resize(width)
    store.writeMeta({ ...store.metadata(expiredAccount.id), state: 'Sign in again' })
    await expired.locator('[aria-label="Needs you"]').waitFor()
    await expired.screenshot({ path: join(out, `${width}-health-needs.png`) })
    store.writeMeta({ ...store.metadata(expiredAccount.id), state: 'Signed in' })
    await expired.locator('[aria-label="Needs you"]').waitFor({ state: 'detached' })
    await expired.screenshot({ path: join(out, `${width}-health-cleared.png`) })
  }
  checks.push('real Health shows expired-account Needs-you dot and clears it after recovery without reopening Preferences')
  await tools()
  const until = async condition => {
    const deadline = Date.now() + 30_000
    while (!await condition()) { assert(Date.now() < deadline, 'driven action did not complete'); await new Promise(ok => setTimeout(ok, 100)) }
  }
  await section.getByRole('button', { name: 'Add account', exact: true }).click()
  await section.getByLabel('Name', { exact: true }).fill('Driven account')
  await section.getByLabel('Start page').fill(site.url('same'))
  await section.getByRole('button', { name: 'Sign in…', exact: true }).click()
  const driven = section.locator('.browser-account', { hasText: 'Driven account' })
  await driven.getByText('Finish signing in the window, then press Done').waitFor()
  const id = store.find('Driven account')
  const fillSignIn = async () => {
    const before = site.attempts.length
    const proof = await hands(id)
    assert.equal(proof.ok, true, 'exact-page synthetic hands failed')
    assert.deepEqual({ beforeFields: proof.beforeFields, afterFields: proof.afterFields, path: proof.path }, { beforeFields: 1, afterFields: 0, path: '/same/app' })
    assert.equal(site.attempts.length, before + 1, 'sign-in submitted more than once')
    assert.equal(site.attempts.at(-1).passed, true)
  }
  await fillSignIn()
  await driven.getByRole('button', { name: 'Done', exact: true }).click()
  await driven.getByText(/^Signed in/).waitFor()
  await driven.getByRole('button', { name: 'Agents may sign in' }).click()
  await driven.getByLabel('User name', { exact: true }).fill('synthetic')
  await driven.getByLabel('Password', { exact: true }).fill(site.password)
  await driven.getByLabel('Authenticator key').fill(site.authenticator)
  await driven.getByRole('button', { name: 'Allow agents to sign in' }).click()
  await driven.getByText('Agents sign in', { exact: true }).waitFor()
  assert.equal((await store.credentials(id)).password, site.password)
  await driven.getByRole('button', { name: 'Agents may sign in' }).click()
  await until(() => !store.metadata(id).marked)
  await assert.rejects(store.credentials(id), error => error.code === 'NOT_MARKED')
  assert.equal(await store.keyring('get', id, 'credentials'), null)
  site.expire('same')
  await driven.getByRole('button', { name: 'Sign in again', exact: true }).click()
  await driven.getByText('Finish signing in the window, then press Done').waitFor()
  await fillSignIn()
  await driven.getByRole('button', { name: 'Done', exact: true }).click()
  await driven.getByText(/^Signed in/).waitFor()
  checks.push('actual UI Add/Done, Mark/keyring, Unmark/keyring deletion and Sign in again/Done pass')
  const notices = async () => application.evaluate(({ app }) => {
    let rows = []
    app.emit('bmn-test:app-notices', value => { rows = value })
    return rows
  })
  site.expire('same')
  relay = new AccountBrowserRelay({ store, allowed: true })
  assert(!(await relay.tool('browser_account_pick', { name: id })).isError)
  await relay.end(false); relay = undefined
  await until(async () => (await notices()).some(notice => notice.body === 'Driven account'))
  const noticeIndex = (await notices()).findIndex(notice => notice.body === 'Driven account')
  await new Promise(ok => setTimeout(ok, 1200))
  assert.equal((await notices()).filter(notice => notice.body === 'Driven account').length, 1)
  await main.locator('.page-views [role=radio]', { hasText: /^Health$/ }).click()
  const drivenHealth = main.locator('.health-row', { hasText: 'Driven account' })
  await drivenHealth.locator('[aria-label="Needs you"]').waitFor()
  await application.evaluate(({ app }, index) => { app.emit('bmn-test:app-notice-click', index) }, noticeIndex)
  await tools()
  await driven.getByText('Finish signing in the window, then press Done').waitFor()
  await fillSignIn()
  await driven.getByRole('button', { name: 'Done', exact: true }).click()
  await driven.getByText(/^Signed in/).waitFor()
  await main.locator('.page-views [role=radio]', { hasText: /^Health$/ }).click()
  await drivenHealth.locator('[aria-label="Needs you"]').waitFor({ state: 'detached' })
  checks.push('production showAppNotice and SelfTestRecorder click reopen the actual browser; UI Done saves and Health dot clears')
  await tools()
  await driven.getByRole('button', { name: 'Remove', exact: true }).click()
  await driven.getByRole('button', { name: 'Remove account', exact: true }).click()
  await driven.waitFor({ state: 'detached' })
  assert(!store.list().some(row => row.id === id))
  assert.equal(await store.keyring('get', id, 'profile-key'), null)
  checks.push('actual UI Remove confirmation deletes the account and keyring key')
  atomicJson(join(out, 'screenshots.json'), shots)
  assertNoValues(store.root, site.values)
  result(out, 'ui', checks, ['screenshots use synthetic metadata; real site/account checks and Tools Save are owner-only'])
} catch (error) {
  atomicJson(join(out, 'result.json'), { phase: 'ui', result: 'FAIL', checks, error: { name: error.name, code: error.code || null } })
  // Playwright errors can include fill values. Keep synthetic credentials out of evidence too.
  // eslint-disable-next-line preserve-caught-error -- Raw Playwright causes include typed credentials; safe diagnostics were saved above.
  throw new Error('Isolated browser-account UI action failed; see sanitized result.json')
} finally {
  await relay?.end(false).catch(() => {})
  if (application) {
    const child = application.process(), exited = child.exitCode === null && child.signalCode === null
      ? new Promise(ok => child.once('exit', ok)) : Promise.resolve()
    await bounded(application.evaluate(({ app }) => app.exit(0)), 5000)
    if (!await bounded(exited, 5000)) {
      assert(applicationIdentity, 'test Electron has no recorded identity')
      stopProcess(applicationIdentity)
      if (!await bounded(exited, 5000)) {
        stopProcess(applicationIdentity, 'SIGKILL')
        assert(await bounded(exited, 5000), 'owned test Electron did not exit after verified cleanup')
      }
    }
  }
  await store.cleanup()
  await site.close()
  await ring.stop()
}
