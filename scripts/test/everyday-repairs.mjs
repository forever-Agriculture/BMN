/* global window, document, innerWidth, innerHeight, getComputedStyle */
// MODULE: everyday-repairs.mjs - visible handoff/image/action/attention regressions on an isolated Electron stack.
// Run after build. --baseline records original visibility failures without accepting them.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/everyday-repairs')
const binary = createRequire(join(repo, 'apps/desktop/package.json'))('electron')
const baseline = process.argv.includes('--baseline')
const wayland = process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY)
  ? join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
mkdirSync(evidence, { recursive: true })

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const app = await _electron.launch({ executablePath: binary, cwd: repo, timeout: 20000,
    args: [join(repo, 'apps/desktop'), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: root, ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}) }
  })
  const result = { baseline, windows: [], os: 'UNVERIFIED: actual native chooser/external windows need separate desktop exercise' }
  try {
    const page = await app.firstWindow({ timeout: 20000 })
    page.setDefaultTimeout(15000)
    await page.waitForSelector('.shell-window')
    const resize = async (width, height) => app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(0, 0); win.setContentSize(...size); win.show()
    }, [width, height])
    // Delay only the real handler's response on this disposable stack; no OS/native success is stubbed.
    const delayResponse = async (channel, artifactId) => app.evaluate(({ ipcMain }, p) => {
      const handler = ipcMain._invokeHandlers.get(p.channel)
      let release, started
      const held = new Promise(resolve => { release = resolve })
      const reached = new Promise(resolve => { started = resolve })
      globalThis.bmnRepairDelay = { channel: p.channel, handler, release, reached }
      ipcMain.removeHandler(p.channel)
      let first = true
      ipcMain.handle(p.channel, async (event, params) => {
        const result = await handler(event, params)
        if (first && params.artifactId === p.artifactId) { first = false; started(); await held }
        return result
      })
    }, { channel, artifactId })
    const releaseResponse = async () => app.evaluate(({ ipcMain }) => {
      const state = globalThis.bmnRepairDelay
      state.release(); ipcMain.removeHandler(state.channel); ipcMain.handle(state.channel, state.handler)
    })
    const tabTo = async (target, limit = 100) => {
      for (let step = 0; step < limit; step++) {
        if (await target.evaluate(el => el === document.activeElement)) return
        await page.keyboard.press('Tab')
      }
      assert.fail('Next action not reachable by the natural keyboard order')
    }
    const focusedVisible = async target => target.evaluate(el => {
      const r = el.getBoundingClientRect(), p = el.closest('.files-panel, .needs-you-popover').getBoundingClientRect()
      const occluded = [...document.querySelectorAll('.feedback-notice')].some(note => {
        const n = note.getBoundingClientRect(), style = getComputedStyle(note)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
          r.left < n.right && r.right > n.left && r.top < n.bottom && r.bottom > n.top
      })
      return !occluded && el === document.activeElement && r.top >= p.top - 1 && r.bottom <= p.bottom + 1
    })
    await resize(1000, 700)
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const receiver = join(root, 'receiver.mjs')
    const input = join(root, 'input.txt')
    const sourceInput = join(root, 'source-input.txt')
    writeFileSync(receiver, `import { appendFileSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(input)}, ''); process.stdin.setRawMode(true);
      process.stdout.write('\\x1b[?2004h');
      process.stdin.on('data', chunk => appendFileSync(${JSON.stringify(input)}, chunk)); setInterval(() => {}, 1000);`)
    const params = { workspaceId: workspace.workspaceId, cwd: root, executable: process.execPath, cols: 80, rows: 24 }
    const destination = await page.evaluate(p => window.aiTerminal.createSession(p), { ...params, name: 'Claude (saved synthetic name)', argv: [receiver] })
    const producer = join(root, 'producer.mjs')
    const preparedFile = join(root, 'prepared.json')
    const jpeg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1536; c.height = 1024; const x = c.getContext('2d'); x.fillStyle = '#c9a45c'; x.fillRect(0, 0, c.width, c.height); return c.toDataURL('image/jpeg').split(',')[1] })
    writeFileSync(producer, `import { appendFileSync, writeFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
      writeFileSync(${JSON.stringify(sourceInput)}, ''); process.stdin.setRawMode(true); process.stdin.on('data', chunk => appendFileSync(${JSON.stringify(sourceInput)}, chunk));
      const cli = args => { const r = spawnSync(${JSON.stringify(join(repo, 'apps/desktop/bin/bmn'))}, args, { encoding: 'utf8' });
        if (r.status !== 0) { writeFileSync(${JSON.stringify(join(evidence, 'fixture-error.txt'))}, r.stderr); throw new Error('Fixture CLI failed: ' + args[0]); } return JSON.parse(r.stdout); };
      const file = ${JSON.stringify(join(root, 'file.txt'))}; writeFileSync(file, 'Synthetic gallery fixture\\n');
      for (let i = 0; i < 60; i++) cli(['publish', file, '--name', 'Fixture ' + String(i).padStart(2, '0') + '.txt', '--key', 'gallery-' + i, '--json']);
      const jpegFile = ${JSON.stringify(join(root, 'large.jpg'))}; writeFileSync(jpegFile, Buffer.from(${JSON.stringify(jpeg)}, 'base64')); cli(['publish', jpegFile, '--name', 'Large fixture.jpg', '--key', 'large-jpeg', '--json']);
      const bad = ${JSON.stringify(join(root, 'bad.png'))}; writeFileSync(bad, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
      const broken = cli(['publish', bad, '--name', 'Bad fixture.png', '--key', 'bad-png', '--json']);
      const binaryFile = ${JSON.stringify(join(root, 'unsupported.bin'))}; writeFileSync(binaryFile, Buffer.from([0, 1, 2])); cli(['publish', binaryFile, '--name', 'Unsupported fixture.bin', '--key', 'unsupported', '--json']);
      const png = ${JSON.stringify(join(root, 'fixture.png'))};
      writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
      const valid = cli(['publish', png, '--name', 'Valid fixture.png', '--key', 'valid-png', '--json']);
      cli(['progress', 'running', 'Synthetic media evidence', '--source', 'fixture', '--evidence-id', valid.artifactId, '--evidence-id', broken.artifactId, '--json']);
      const prepared = cli(['handoff', ${JSON.stringify(destination.session.sessionId)}, '--text', 'Synthetic handoff: inspect, paste, then submit.', '--key', 'large-gallery-handoff', '--json']);
      const long = 'Long synthetic attention ' + 'folder-name/'.repeat(9);
      cli(['ask', 'long-question', long, '--body', 'long/path/'.repeat(60), '--json']);
      cli(['ask', 'recent-long', long, '--json']); cli(['resolve', 'recent-long', 'Synthetic answered fixture', '--json']);
      writeFileSync(${JSON.stringify(preparedFile)}, JSON.stringify(prepared)); setInterval(() => {}, 1000);`)
    const source = await page.evaluate(p => window.aiTerminal.createSession(p), { ...params, name: 'Fixture source', argv: [producer] })
    await page.waitForFunction(() => true)
    for (let i = 0; i < 150 && !existsSync(preparedFile); i++) await page.waitForTimeout(100)
    assert.ok(existsSync(preparedFile), 'Fixture producer did not prepare handoff')
    const prepared = JSON.parse(readFileSync(preparedFile, 'utf8'))
    await page.reload(); await page.waitForSelector('.shell-window')
    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await resize(width, height)
      await page.locator('.needs-you-button').click()
      const overflow = await page.locator('.needs-you-popover').evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      await page.screenshot({ path: join(evidence, `attention-${width}.png`) })
      if (!baseline) assert.ok(overflow.scrollWidth <= overflow.clientWidth, JSON.stringify(overflow))
      if (baseline || width === 800) {
        const request = page.locator('.attention-item').filter({ hasText: 'Synthetic handoff: inspect, paste, then submit.' })
        const openReview = request.getByRole('button', { name: 'Open handoff', exact: true })
        if (!baseline) { await tabTo(openReview); assert.ok(await focusedVisible(openReview), 'Attention keyboard action clipped') }
        await openReview.click()
      } else {
        await page.locator('.needs-you-button').click()
        await page.locator(`#handoff-${prepared.draftId}`).getByRole('button', { name: 'Edit', exact: true }).click()
      }
      await page.waitForSelector('.handoff-form textarea')
      await page.waitForTimeout(200)
      const state = await page.evaluate(() => {
        const panel = document.querySelector('.files-panel'), form = panel.querySelector('.handoff-form'), image = panel.querySelector('img')
        const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
        return { viewport: [innerWidth, innerHeight], panel: rect(panel), form: rect(form), focus: document.activeElement === form.querySelector('textarea'),
          count: panel.querySelectorAll('.files-earlier-list li').length + 1,
          image: image ? { complete: image.complete, width: image.naturalWidth, visibility: getComputedStyle(image).visibility } : null }
      })
      result.windows.push({ ...state, overflow })
      assert.ok(state.count >= 60)
      assert.equal(readFileSync(input, 'utf8'), '', 'Viewing wrote terminal input')
      if (!baseline) {
        assert.ok(state.panel.top >= 0 && state.panel.bottom <= height + 1, 'Files viewport escaped the window: ' + JSON.stringify(state))
        assert.ok(state.form.top >= state.panel.top - 1 && state.form.top < state.panel.bottom, JSON.stringify(state))
        assert.ok(state.focus, 'Exact editor did not get keyboard focus')
      }
      await page.screenshot({ path: join(evidence, `handoff-${width}.png`) })
      if (!baseline) {
        const next = page.locator('.handoff-form').getByRole('button', { name: 'Save handoff', exact: true })
        await tabTo(next); assert.ok(await focusedVisible(next), 'Review next action clipped at ' + width)
        result.windows.at(-1).keyboardNextAction = true
        await page.screenshot({ path: join(evidence, `handoff-next-action-${width}.png`) })
      }
      await page.locator('.handoff-form').getByRole('button', { name: 'Cancel', exact: true }).click()
      if (!baseline) {
        await page.locator(`#handoff-${prepared.draftId}`).getByRole('button', { name: 'Edit', exact: true }).click()
        await page.waitForTimeout(100)
        assert.ok(await page.locator('.handoff-form textarea').evaluate(el => el === document.activeElement))
        await page.locator('.handoff-form').getByRole('button', { name: 'Cancel', exact: true }).click()
      }
      await page.locator('.files-panel').evaluate(el => { el.scrollTop = 0 })
    }
    if (baseline) {
      assert.ok(result.windows.some(state => state.form.top > state.panel.bottom), 'Did not reproduce offscreen baseline')
      assert.ok(result.windows.some(state => state.image?.width > 0 && state.image.visibility === 'hidden'), 'Did not reproduce decoded hidden baseline')
      writeFileSync(join(evidence, 'baseline.json'), JSON.stringify(result, null, 2))
      console.log('REPRODUCED original handoff and decoded-image failures')
      return
    }
    await page.waitForFunction(() => {
      const img = document.querySelector('.files-panel img')
      return img?.naturalWidth > 0 && getComputedStyle(img).visibility === 'visible'
    })
    await page.getByRole('button', { name: 'Original size', exact: true }).click()
    assert.equal(await page.locator('.files-image-zoom-pct').innerText(), '100%')
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    assert.equal(await page.locator('.files-image-zoom-pct').innerText(), '125%')
    await page.getByRole('button', { name: 'Expand image', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.image-preview-dialog img')?.naturalWidth > 0 && getComputedStyle(document.querySelector('.image-preview-dialog img')).visibility === 'visible')
    await page.keyboard.press('Escape')
    await page.locator('.files-earlier-row').filter({ hasText: 'Large fixture.jpg' }).click()
    await page.waitForFunction(() => document.querySelector('.files-panel img')?.naturalWidth === 1536)
    await page.locator('.files-panel').evaluate(el => { el.scrollTop = 0 })
    assert.ok(parseInt(await page.locator('.files-image-zoom-pct').innerText()) < 100, 'Large image not fitted')
    await page.screenshot({ path: join(evidence, 'large-jpeg-visible.png') })
    await page.getByRole('button', { name: 'Original size', exact: true }).click()
    assert.equal(await page.locator('.files-image-zoom-pct').innerText(), '100%')
    await page.locator('.files-earlier-row').filter({ hasText: 'Bad fixture.png' }).click()
    await page.locator('.files-panel').evaluate(el => { el.scrollTop = 0 })
    await page.waitForSelector('.files-preview-error')
    assert.match(await page.locator('.files-preview-error').innerText(), /decoded/)
    await page.locator('.files-earlier-row').filter({ hasText: 'Valid fixture.png' }).click()
    await page.waitForFunction(() => document.querySelector('.files-panel img')?.naturalWidth > 0 && getComputedStyle(document.querySelector('.files-panel img')).visibility === 'visible')
    const artifacts = await page.evaluate(sid => window.aiTerminal.listArtifacts(sid), source.session.sessionId)
    const badArtifact = artifacts.find(a => a.originalName === 'Bad fixture.png')
    const jpegArtifact = artifacts.find(a => a.originalName === 'Large fixture.jpg')
    await page.locator('.files-earlier-row').filter({ hasText: 'Unsupported fixture.bin' }).click()
    await page.locator('.files-preview-message').filter({ hasText: 'No inline preview for this type' }).waitFor()
    result.unsupportedPreview = 'visible explanation'
    await app.evaluate(({ ipcMain }) => {
      const channel = 'aiterm:artifact:preview', handler = ipcMain._invokeHandlers.get(channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        ipcMain.removeHandler(channel); ipcMain.handle(channel, handler)
        throw new Error('Synthetic preview bridge failure')
      })
    })
    await page.locator('.files-earlier-row').filter({ hasText: 'Fixture 03.txt' }).click()
    await page.locator('.files-preview-error').waitFor()
    assert.match(await page.locator('.files-preview-error').innerText(), /Synthetic preview bridge failure/)
    result.bridgeFailurePreview = await page.locator('.files-preview-error').innerText()
    await delayResponse('aiterm:artifact:preview', badArtifact.artifactId)
    await page.locator('.files-earlier-row').filter({ hasText: 'Bad fixture.png' }).click()
    await app.evaluate(() => globalThis.bmnRepairDelay.reached)
    assert.match(await page.locator('.files-preview-message').innerText(), /Loading preview/ )
    await page.locator('.files-earlier-row').filter({ hasText: 'Large fixture.jpg' }).click()
    await page.waitForFunction(() => document.querySelector('.files-panel img')?.naturalWidth === 1536)
    await releaseResponse(); await page.waitForTimeout(100)
    assert.equal(await page.locator('.files-panel img').evaluate(el => el.naturalWidth), 1536, 'Late preview replaced current image')
    result.rapidPreview = { delayed: badArtifact.artifactId, selected: jpegArtifact.artifactId, decodedWidthAfterLateResult: 1536 }
    await page.locator('.session-terminal.selected .progress-open').click()
    const progressDialog = page.locator('.progress-evidence-dialog')
    await progressDialog.locator('li').filter({ hasText: 'Valid fixture.png' }).getByRole('button', { name: 'Preview', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.progress-evidence-dialog img')?.naturalWidth > 0 && getComputedStyle(document.querySelector('.progress-evidence-dialog img')).visibility === 'visible')
    await page.screenshot({ path: join(evidence, 'progress-image-visible.png') })
    await progressDialog.locator('li').filter({ hasText: 'Bad fixture.png' }).getByRole('button', { name: 'Preview', exact: true }).click()
    await progressDialog.locator('.files-preview-error').waitFor()
    assert.match(await progressDialog.locator('.files-preview-error').innerText(), /decoded/)
    result.sharedProgressPreview = { validVisible: true, decodeFailureVisible: true, sourceInput: readFileSync(sourceInput, 'utf8') }
    assert.equal(result.sharedProgressPreview.sourceInput, '')
    await page.keyboard.press('Escape')
    await page.locator('.files-earlier-row').filter({ hasText: 'Valid fixture.png' }).click()
    // Saving and reopening an existing draft must replace the in-flight outcome.
    const savedCard = page.locator(`#handoff-${prepared.draftId}`)
    await savedCard.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Save handoff', exact: true }).click()
    await page.waitForSelector('.handoff-form', { state: 'detached' })
    await page.waitForFunction(() => document.querySelector('.files-action-announcer')?.textContent.includes('Saved. Not sent.'))
    assert.match(await savedCard.locator('.files-action-outcome').innerText(), /Saved\. Not sent\./)
    await savedCard.getByRole('button', { name: 'Edit', exact: true }).click()
    assert.ok(!(await page.locator('.handoff-form').innerText()).includes('Working…'), 'Save left a stale pending receipt')
    assert.match(await page.locator('.handoff-form .files-action-outcome').innerText(), /Saved\. Not sent\./)
    await page.locator('.handoff-form').getByRole('button', { name: 'Cancel', exact: true }).click()
    // Workspace Review must reveal the same draft too, without any terminal input.
    await page.getByRole('button', { name: `Actions for ${workspace.name}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Review results…', exact: true }).click()
    await page.getByRole('button', { name: 'Review handoff', exact: true }).click()
    await page.waitForSelector('.handoff-form textarea')
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.handoff-form textarea').inputValue(), 'Synthetic handoff: inspect, paste, then submit.')
    assert.ok(await page.locator('.handoff-form textarea').evaluate(el => el === document.activeElement))
    assert.equal(readFileSync(input, 'utf8'), '')
    await page.locator('.handoff-form').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.locator('.files-panel').evaluate(el => { el.scrollTop = 0 })
    await page.getByRole('button', { name: 'Prepare handoff', exact: true }).click()
    await page.locator('.handoff-form textarea').fill('Synthetic new owner draft')
    await page.getByRole('button', { name: 'Save handoff', exact: true }).click()
    await page.waitForSelector('.handoff-form', { state: 'detached' })
    const newCard = page.locator('.handoff-card').filter({ hasText: 'Synthetic new owner draft' })
    await newCard.locator('.files-action-outcome').waitFor()
    assert.match(await newCard.locator('.files-action-outcome').innerText(), /Saved\. Not sent\./)
    await page.waitForFunction(() => document.querySelector('.files-action-announcer')?.textContent.includes('Saved. Not sent.'))
    result.newSavedDraftFeedback = { cardVisible: true, announcementUpdated: true }
    await page.locator('.files-panel').evaluate(el => { el.scrollTop = 0 })
    assert.equal(readFileSync(sourceInput, 'utf8'), '', 'Review/OS actions wrote source input')
    const original = await page.evaluate(async sid => (await window.aiTerminal.listArtifacts(sid)).find(a => a.originalName === 'Valid fixture.png'), source.session.sessionId)
    await delayResponse('aiterm:artifact:deliver', original.artifactId)
    await page.getByRole('button', { name: 'Deliver to session', exact: true }).evaluate(el => { el.click(); el.click() })
    await app.evaluate(() => globalThis.bmnRepairDelay.reached)
    await page.getByRole('button', { name: 'Close files', exact: true }).click()
    await page.locator('.session-terminal.selected').getByRole('button', { name: 'Files', exact: true }).click()
    await page.getByRole('button', { name: 'Deliver to session', exact: true }).click()
    await releaseResponse()
    await page.waitForFunction(() => [...document.querySelectorAll('.files-action-outcome')].some(el => el.textContent.includes('Not submitted; press Enter separately.')))
    const adjacent = await page.locator('.files-action-outcome').filter({ hasText: 'Recorded paste' }).innerText()
    assert.ok(adjacent.includes(original.artifactId) && adjacent.includes('Fixture source') && adjacent.includes('Not submitted'))
    await page.waitForFunction(() => document.querySelector('.files-action-announcer')?.textContent.includes('Recorded paste'))
    assert.equal(await page.locator('.files-action-announcer').innerText(), adjacent)
    assert.equal(await page.locator('.feedback-notice.brief').count(), 0, 'Files receipt leaked into an occluding toast')
    result.adjacentDeliveryFeedback = { text: adjacent, liveRegionUpdated: true, duplicateToast: false }
    const delivered = readFileSync(sourceInput, 'utf8')
    assert.equal(delivered.split(original.artifactId).length - 1, 1)
    assert.ok(!delivered.includes('\r'), 'File delivery pressed Enter')
    result.fileDelivery = { once: true, pendingRemountOnce: true, noEnter: true, originalSha256: createHash('sha256').update(readFileSync(original.storedPath)).digest('hex'), expectedSha256: original.sha256, receiverInput: delivered }
    assert.equal(result.fileDelivery.originalSha256, original.sha256)
    // Integrity/missing failures use disposable originals; restoration preserves exact original bytes.
    for (const [name, kind] of [['Fixture 01.txt', 'missing'], ['Fixture 02.txt', 'corrupt']]) {
      const artifact = await page.evaluate(async p => (await window.aiTerminal.listArtifacts(p.sid)).find(a => a.originalName === p.name), { sid: source.session.sessionId, name })
      const bytes = readFileSync(artifact.storedPath)
      renameSync(artifact.storedPath, artifact.storedPath + '.held')
      if (kind === 'corrupt') writeFileSync(artifact.storedPath, 'synthetic integrity failure')
      try {
        await page.locator('.files-earlier-row').filter({ hasText: name }).click()
        await page.locator('.files-panel').evaluate(el => { el.scrollTop = 0 })
        await page.waitForSelector('.files-preview-error')
        assert.match(await page.locator('.files-preview-error').innerText(), kind === 'missing' ? /missing/ : /hash/)
      } finally {
        if (kind === 'corrupt') unlinkSync(artifact.storedPath)
        renameSync(artifact.storedPath + '.held', artifact.storedPath)
        assert.deepEqual(readFileSync(artifact.storedPath), bytes)
      }
    }
    const card = page.locator(`#handoff-${prepared.draftId}`)
    result.destinationWindows = []
    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await resize(width, height)
      if (width !== 800) {
        await page.getByRole('button', { name: 'Close files', exact: true }).click()
        await page.locator('.session-row').filter({ hasText: 'Fixture source' }).click()
        await page.locator('.session-terminal.selected').getByRole('button', { name: 'Files', exact: true }).click()
        await card.getByRole('button', { name: 'Edit', exact: true }).click()
        await page.waitForSelector('.handoff-form textarea')
        await page.locator('.handoff-form').getByRole('button', { name: 'Cancel', exact: true }).click()
      }
      await card.getByRole('button', { name: 'Open destination', exact: true }).click()
      await page.waitForSelector('.handoff-card .primary')
      await page.waitForTimeout(100)
      assert.ok(await page.locator(`#handoff-${prepared.draftId}`).evaluate(el => { const r = el.getBoundingClientRect(), p = el.closest('.files-panel').getBoundingClientRect(); return r.top >= p.top - 1 && r.top < p.bottom && document.activeElement === el }))
      const pasteAction = page.getByRole('button', { name: 'Paste handoff', exact: true })
      await tabTo(pasteAction); assert.ok(await focusedVisible(pasteAction), 'Destination paste not keyboard-visible at ' + width)
      assert.equal(readFileSync(input, 'utf8'), '', 'Opening destination wrote input')
      result.destinationWindows.push({ width, height, exactCardFocused: true, pasteKeyboardVisible: true, visuallyUnobscured: true, input: '' })
      await page.screenshot({ path: join(evidence, `destination-${width}.png`) })
    }
    await page.locator('.session-terminal.selected .xterm-helper-textarea').pressSequentially('existing input ')
    await page.getByRole('button', { name: 'Paste handoff', exact: true }).evaluate(el => { el.click(); el.click() })
    await page.waitForFunction(() => document.querySelector('.handoff-card')?.textContent.includes('Pasted to terminal'))
    const pasted = readFileSync(input, 'utf8')
    assert.ok(pasted.startsWith('existing input '), 'Existing input lost')
    assert.equal(pasted.split('Synthetic handoff: inspect, paste, then submit.').length - 1, 1)
    assert.ok(!pasted.includes('\r'), 'Implicit Enter')
    await page.locator('.session-terminal.selected .xterm-helper-textarea').press('Enter')
    await page.waitForTimeout(150)
    assert.equal(readFileSync(input, 'utf8'), pasted + '\r')
    const persisted = await page.evaluate(async id => (await window.aiTerminal.listDrafts()).find(draft => draft.draftId === id), prepared.draftId)
    assert.equal(persisted.sourceSessionId, source.session.sessionId)
    assert.equal(persisted.detail, 'Pasted to terminal — not submitted')
    result.handoff = { source: persisted.sourceSessionId, destination: persisted.sessionId, once: true, inputPreserved: true, manualEnter: true, receipt: persisted.detail, inputBeforePaste: 'existing input ', pastedInput: pasted, submittedInput: readFileSync(input, 'utf8') }
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    console.log('PASS visible exact handoff/focus; attention width; cached/decode/expanded images; paste once, preserve input, separate Enter')
  } finally {
    const page = await app.firstWindow().catch(() => null)
    if (page) await page.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces()) for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) {
        await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
      }
    }).catch(() => {})
    await app.close()
  }
})
