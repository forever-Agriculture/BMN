/* global window, document, innerHeight */
// MODULE: attention-actions.mjs - owner choices/reminder/handoff regressions with isolated data and clipboard
// Run under an isolated X display (e.g. xvfb-run), after build. --binary selects a packaged baseline/candidate.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const binaryFlag = process.argv.indexOf('--binary')
const packagedBinary = binaryFlag < 0 ? null : resolve(process.argv[binaryFlag + 1])
const binary = packagedBinary ?? createRequire(join(repo, 'apps/desktop/package.json'))('electron')
const evidence = process.env.BMN_ACTION_EVIDENCE ?? join(repo, '.dev-auto/evidence/owner-actions/runtime')
mkdirSync(evidence, { recursive: true })
const writeAtomic = (path, text) => { writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path) }
// An X display isolated from the owner's desktop is mandatory: copying must not touch their clipboard.
assert.ok(process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'Use a private X display with WAYLAND_DISPLAY unset')

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const launchOptions = { executablePath: binary, cwd: repo, timeout: 20000,
    args: [...(packagedBinary ? [] : [join(repo, 'apps/desktop')]), '--ozone-platform=x11', '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root }
  }
  let app = await _electron.launch(launchOptions)
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const changed = [...execFileSync('git', ['diff', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim().split('\n'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' }).trim().split('\n')]
    .filter(name => /^(apps|shared|scripts|docs)\//.test(name))
  const buildHashes = {}
  const visitBuild = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) visitBuild(full)
      else if (entry.isFile()) buildHashes[full.slice(repo.length + 1)] = hash(full)
    }
  }
  if (!packagedBinary) visitBuild(join(repo, 'apps/desktop/out'))
  const result = { binary: packagedBinary ?? 'development', windows: [], status: 'running',
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceHashes: packagedBinary ? {} : Object.fromEntries(changed.map(name => [name, hash(join(repo, name))])), buildHashes,
    ...(packagedBinary ? { packagedAsarHash: hash(join(dirname(packagedBinary), 'resources/app.asar')) } : {}) }
  writeAtomic(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.waitForSelector('.shell-window')
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const input = join(root, 'destination-input.txt'), sourceInput = join(root, 'source-input.txt')
    const receiver = join(root, 'receiver.mjs')
    writeFileSync(receiver, `import {writeFileSync,appendFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);process.stdout.write('\\x1b[?2004h');
      process.stdin.on('data',c=>appendFileSync(${JSON.stringify(input)},c));setInterval(()=>{},1000);`)
    const params = { workspaceId: workspace.workspaceId, cwd: root, executable: process.execPath, cols: 80, rows: 24 }
    const target = await page.evaluate(p => window.aiTerminal.createSession(p), { ...params, name: 'Destination', argv: [receiver] })
    const producer = join(root, 'producer.mjs'), ready = join(root, 'ready.json'), command = join(root, 'command.json')
    const cli = packagedBinary ? join(dirname(packagedBinary), 'resources/bin/bmn.mjs') : join(repo, 'apps/desktop/bin/bmn')
    writeFileSync(producer, `import {writeFileSync,appendFileSync,readFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';import {spawnSync} from 'node:child_process';
      const atomic=(path,value)=>{writeFileSync(path+'.tmp',value);renameSync(path+'.tmp',path)};
      writeFileSync(${JSON.stringify(sourceInput)},'');process.stdin.setRawMode(true);process.stdin.on('data',c=>appendFileSync(${JSON.stringify(sourceInput)},c));
      const call=(args,input)=>{const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...args],{encoding:'utf8',input});if(r.status!==0)throw new Error(r.stderr);return r.stdout};
      const file=${JSON.stringify(join(root, 'fixture.txt'))};writeFileSync(file,'Synthetic original');
      for(let i=0;i<64;i++)call(['publish',file,'--name','Fixture '+i+'.txt','--key','file-'+i,'--json']);
      writeFileSync(${JSON.stringify(ready)},JSON.stringify({ready:true}));
      setInterval(()=>{if(!existsSync(${JSON.stringify(command)}))return;const c=JSON.parse(readFileSync(${JSON.stringify(command)},'utf8'));unlinkSync(${JSON.stringify(command)});
        const response=c.kind==='handoff'?call(['handoff',${JSON.stringify(target.session.sessionId)},'--text','Please review this short synthetic handoff.','--key',c.key,'--json']):
          c.kind==='manual'?call(['ask',c.key,c.title??'Manual question','--json']):
          c.kind==='restricted'?call(['hook','opencode'],JSON.stringify({hook_event_name:'question.asked',id:c.key,questions:c.questions})):
          call(['hook','codex'],JSON.stringify({hook_event_name:'PreToolUse',tool_name:'functions.request_user_input_async',tool_use_id:c.key,tool_input:{questions:c.questions}}));
        atomic(${JSON.stringify(join(root, 'response.json'))},JSON.stringify({key:c.key,response}));},25);`)
    const source = await page.evaluate(p => window.aiTerminal.createSession(p), { ...params, name: 'Source', argv: [producer] })
    await page.waitForFunction(() => true)
    for (let i = 0; i < 900 && !existsSync(ready); i++) await page.waitForTimeout(50)
    assert.ok(existsSync(ready), 'Fixture did not initialize')
    // Fixture bridge calls create rows outside the UI creation path; reload its session registry once.
    await page.reload()
    await page.waitForSelector('.session-row', { timeout: 20000 })
    const emit = async (payload) => {
      writeAtomic(command, JSON.stringify(payload))
      for (let i = 0; i < 200; i++) {
        if (existsSync(join(root, 'response.json')) && JSON.parse(readFileSync(join(root, 'response.json'), 'utf8')).key === payload.key) return
        await page.waitForTimeout(25)
      }
      throw new Error('Synthetic source did not publish '+payload.key)
    }
    const question = (key) => ({ kind: 'question', key, questions: [
      { title: 'Which color?', options: ['Gold', 'Black'] }, { title: 'Which shape?', options: ['Circle', 'Square'] }
    ] })
    const resize = async (width, height) => app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(0, 0); win.setContentSize(...size)
    }, [width, height])
    const openNeeds = async () => {
      if (!await page.locator('.needs-you-popover').count()) await page.locator('.needs-you-button').click()
    }
    const questionCard = () => page.locator('.needs-you-popover .attention-item').filter({ hasText: 'Which color?' })
    const currentQuestion = () => page.evaluate(async sid => (await window.aiTerminal.listAttention()).find(r => r.sessionId === sid && r.kind === 'question' && r.state === 'open'), source.session.sessionId)
    if (process.argv.includes('--baseline')) {
      await emit(question('baseline-question')); await openNeeds()
      const selectable = await questionCard().locator('input[type="radio"]').count() > 0
      const copyOffered = await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).count() === 1
      await emit({ kind: 'handoff', key: 'baseline-handoff' })
      const handoff = page.locator('.attention-item').filter({ hasText: 'Please review this short synthetic handoff.' })
      await handoff.getByRole('button', { name: 'Open handoff', exact: true }).click()
      await page.waitForSelector('.handoff-form textarea')
      const draft = await page.evaluate(async sid => (await window.aiTerminal.listDrafts()).find(d => d.sourceSessionId === sid && d.state === 'draft'), source.session.sessionId)
      const duplicateCard = await page.locator('#handoff-'+draft.draftId).count()
      const pendingReminder = await page.evaluate(async sid => (await window.aiTerminal.listAttention()).some(r => r.sessionId === sid && r.kind === 'handoff' && r.state === 'open'), source.session.sessionId)
      result.baseline = { selectable, copyOffered, duplicateCard, pendingReminder }
      writeAtomic(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
      await page.screenshot({ path: join(evidence, 'baseline-editor.png') })
      assert.ok(selectable && copyOffered && duplicateCard === 0 && !pendingReminder, JSON.stringify(result.baseline))
      return
    }
    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await resize(width, height)
      await emit(question('copy-'+width)); await openNeeds()
      const card = questionCard(); await card.waitFor()
      await card.locator('fieldset').nth(0).getByLabel('Gold', { exact: true }).check()
      await card.locator('fieldset').nth(1).getByLabel('Other', { exact: true }).check()
      await card.getByLabel('Your answer', { exact: true }).fill('Triangle')
      const copy = card.getByRole('button', { name: 'Copy answer', exact: true })
      await copy.focus()
      assert.ok(await copy.evaluate(el => { const r=el.getBoundingClientRect();return document.activeElement===el&&r.top>=0&&r.bottom<=innerHeight }))
      await page.screenshot({ path: join(evidence, 'choices-'+width+'.png') })
      await copy.evaluate(el => { el.click(); el.click() })
      await page.waitForFunction(() => !document.querySelector('.attention-item .attention-question-choices'))
      assert.ok(await page.locator('.needs-you-button').evaluate(el => el === document.activeElement),
        'Successful copy removed keyboard focus instead of returning to Needs you')
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Which color?: Gold\nWhich shape?: Triangle')
      assert.equal(await currentQuestion(), undefined)
      assert.equal(readFileSync(sourceInput, 'utf8'), '')
      assert.equal(readFileSync(input, 'utf8'), '')
      await page.locator('.needs-you-button').click()
      // Respect the real producer's ten-second handoff throttle; reopen the same saved draft at later sizes.
      if (width === 800) {
      await emit({ kind: 'handoff', key: 'handoff-'+width }); await openNeeds()
      const handoff = page.locator('.needs-you-popover .attention-item').filter({ hasText: 'Handoff to' })
      await handoff.waitFor()
      assert.ok((await handoff.innerText()).includes('Personal › Destination'))
      assert.ok((await handoff.innerText()).includes(root))
      await handoff.getByRole('button', { name: 'Open handoff', exact: true }).click()
      } else {
        await page.locator('.handoff-card').getByRole('button', { name: 'Edit', exact: true }).click()
      }
      await page.waitForSelector('.handoff-form textarea')
      await page.waitForFunction(() => document.querySelector('.needs-you-button .count')?.textContent === '0')
      const editing = await page.evaluate(async sid => (await window.aiTerminal.listDrafts()).filter(d => d.sourceSessionId === sid && d.state === 'draft').at(-1), source.session.sessionId)
      assert.ok(editing)
      assert.equal(await page.locator('#handoff-'+editing.draftId).count(), 0, 'Same draft shown twice while editing')
      await page.screenshot({ path: join(evidence, 'editor-'+width+'.png') })
      await page.getByRole('button', { name: 'Save handoff', exact: true }).click()
      await page.waitForSelector('.handoff-form', { state: 'detached' })
      assert.equal(await page.locator('#handoff-'+editing.draftId).count(), 1)
      assert.match(await page.locator('#handoff-'+editing.draftId+' .files-action-outcome').innerText(), /Saved\. Not sent\./)
      assert.equal(readFileSync(input, 'utf8'), '')
      result.windows.push({ width, height, copiedOther: true, noInput: true, reminderCleared: true, draftPreserved: true, uniqueEditor: true })
    }
    // A clipboard failure must retain the question and expose a recoverable error.
    await resize(800, 500)
    await emit(question('copy-failure')); await openNeeds()
    await app.evaluate(({ clipboard }) => { globalThis.bmnOriginalClipboardWrite = clipboard.writeText; clipboard.writeText = () => { throw new Error('Synthetic clipboard failure') } })
    const card = questionCard()
    await card.locator('fieldset').nth(0).getByLabel('Black', { exact: true }).check()
    await card.locator('fieldset').nth(1).getByLabel('Other', { exact: true }).check()
    await card.getByLabel('Your answer', { exact: true }).fill('Triangle')
    await card.getByRole('button', { name: 'Copy answer', exact: true }).click()
    await page.getByText('Could not copy. Try again.', { exact: true }).waitFor()
    assert.ok(await card.getByRole('button', { name: 'Copy answer', exact: true }).evaluate(el => {
      const rect = el.getBoundingClientRect(), panel = el.closest('.needs-you-popover').getBoundingClientRect()
      return document.activeElement === el && rect.top >= panel.top && rect.bottom <= panel.bottom
    }), 'Copy retry lost visible focus after failure')
    assert.ok(await currentQuestion())
    await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.bmnOriginalClipboardWrite })
    await card.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.attention-item .attention-question-choices'))
    result.clipboardFailureRetainedReminder = true
    await emit({ kind: 'question', key: 'multi-copy', questions: [{ title: 'Which color?', multiSelect: true, options: ['Gold', 'Black'] }] })
    await questionCard().getByLabel('Gold', { exact: true }).check()
    await questionCard().getByLabel('Black', { exact: true }).check()
    await questionCard().getByLabel('Other', { exact: true }).check()
    await questionCard().getByLabel('Your answer', { exact: true }).fill('Amber')
    await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.attention-question-choices'))
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Gold, Black, Amber')
    await emit({ kind: 'question', key: 'typed-copy', questions: [{ title: 'Which color?' }] })
    assert.ok(await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).isDisabled())
    assert.equal(await questionCard().locator('input').count(), 0)
    await questionCard().getByLabel('Your answer', { exact: true }).fill('Sapphire')
    await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.attention-question-choices'))
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Sapphire')
    await emit({ kind: 'restricted', key: 'restricted-copy', questions: [{ question: 'Which color?', custom: false, options: [{ label: 'Gold', description: 'Synthetic choice' }] }] })
    assert.equal(await questionCard().getByLabel('Other', { exact: true }).count(), 0)
    assert.equal(await questionCard().locator('textarea').count(), 0)
    await questionCard().getByRole('radio', { name: 'Gold Synthetic choice', exact: true }).check()
    await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.attention-question-choices'))
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Gold')
    await emit({ kind: 'question', key: 'declared-other', questions: [{ title: 'Which color?', options: ['Gold', 'Other'] }] })
    assert.equal(await questionCard().getByLabel('Other', { exact: true }).count(), 1)
    await questionCard().getByLabel('Write answer', { exact: true }).check()
    await questionCard().getByLabel('Your answer', { exact: true }).fill('Azure')
    await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.attention-question-choices'))
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Azure')
    // Hold the actual list IPC, revise the prompt, then let Copy revalidate. The old answer must not reach the clipboard.
    await emit(question('stale-copy'))
    await questionCard().locator('fieldset').nth(0).getByLabel('Gold', { exact: true }).check()
    await questionCard().locator('fieldset').nth(1).getByLabel('Circle', { exact: true }).check()
    const beforeStaleClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    await app.evaluate(({ ipcMain }) => {
      const channel = 'aiterm:attention:list', handler = ipcMain._invokeHandlers.get(channel)
      let release, reached
      const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { reached = resolve })
      globalThis.bmnHeldAttention = { channel, handler, release, started }
      ipcMain.removeHandler(channel)
      let first = true
      ipcMain.handle(channel, async (event, params) => { if (first) { first = false; reached(); await gate } return handler(event, params) })
    })
    await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).click()
    await app.evaluate(() => globalThis.bmnHeldAttention.started)
    await emit(question('newer-question'))
    await app.evaluate(({ ipcMain }) => {
      const held = globalThis.bmnHeldAttention; held.release(); ipcMain.removeHandler(held.channel); ipcMain.handle(held.channel, held.handler)
    })
    await page.getByText('This question changed. Open the current card before copying.', { exact: true }).waitFor()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), beforeStaleClipboard)
    assert.ok(await currentQuestion())
    assert.ok(await questionCard().getByRole('button', { name: 'Copy answer', exact: true }).isDisabled())
    await questionCard().getByRole('button', { name: 'Dismiss', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.attention-question-choices'))
    await emit({ kind: 'manual', key: 'manual-question' })
    const manual = page.locator('.attention-item').filter({ hasText: 'Manual question' })
    await manual.waitFor()
    assert.equal(await manual.getByRole('button', { name: 'Copy answer', exact: true }).count(), 0)
    await manual.getByRole('button', { name: 'Open session', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.needs-you-button .count')?.textContent === '0')
    assert.equal(readFileSync(sourceInput, 'utf8'), '')
    assert.equal(readFileSync(input, 'utf8'), '')
    result.multiSelectTypedOnlyRestrictionsStaleAndManual = true
    const visibleFocus = async target => target.evaluate(el => {
      const rect = el.getBoundingClientRect(), panel = el.closest('.needs-you-popover')?.getBoundingClientRect()
      return document.activeElement === el && rect.top >= (panel?.top ?? 0) && rect.bottom <= (panel?.bottom ?? innerHeight)
    })
    // Keyboard-only Copy/Dismiss must rehome focus after one or several cards disappear.
    result.keyboardRemoval = []
    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await resize(width, height); await openNeeds()
      for (const multiple of [false, true]) {
        if (multiple) await emit({ kind: 'manual', key: 'neighbor-'+width, title: 'Keyboard neighbor' })
        await emit({ kind: 'question', key: 'keyboard-copy-'+width+'-'+multiple, questions: [{ title: 'Which color?', options: ['Gold', 'Black'] }] })
        const choice = questionCard().getByLabel('Gold', { exact: true })
        await choice.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Tab')
        const copy = questionCard().getByRole('button', { name: 'Copy answer', exact: true })
        assert.ok(await visibleFocus(copy))
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => !document.querySelector('.attention-question-choices'))
        const next = multiple ? page.locator('.attention-item').filter({ hasText: 'Keyboard neighbor' }).getByRole('button', { name: 'Open session', exact: true }) : page.locator('.needs-you-button')
        assert.ok(await visibleFocus(next), 'Copy did not focus the next action')
        if (multiple) {
          await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
          await page.waitForFunction(() => document.querySelector('.needs-you-button .count')?.textContent === '0')
          assert.ok(await visibleFocus(page.locator('.needs-you-button')))
        }
      }
      await emit({ kind: 'manual', key: 'dismiss-a-'+width, title: 'Dismiss first' })
      await emit({ kind: 'manual', key: 'dismiss-b-'+width, title: 'Dismiss second' })
      await page.locator('.attention-item').filter({ hasText: 'Dismiss first' }).getByRole('button', { name: 'Dismiss', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.locator('.attention-item').filter({ hasText: 'Dismiss first' }).waitFor({ state: 'detached' })
      const second = page.locator('.attention-item').filter({ hasText: 'Dismiss second' }).getByRole('button', { name: 'Open session', exact: true })
      assert.ok(await visibleFocus(second))
      await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('.needs-you-button .count')?.textContent === '0')
      assert.ok(await visibleFocus(page.locator('.needs-you-button')))
      result.keyboardRemoval.push({ width, height, singleAndMultipleCopy: true, singleAndMultipleDismiss: true })
    }
    // Restart the real app with the same isolated database. Stop only our synthetic children first.
    await page.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces()) for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId)
    })
    await app.close()
    app = await _electron.launch(launchOptions)
    const restarted = await app.firstWindow()
    await restarted.waitForSelector('.needs-you-button')
    assert.equal(await restarted.locator('.needs-you-button .count').innerText(), '0')
    const persisted = await restarted.evaluate(async () => ({ attention: await window.aiTerminal.listAttention(), drafts: await window.aiTerminal.listDrafts() }))
    assert.ok(persisted.attention.length > 0 && persisted.attention.every(row => row.state !== 'open'))
    assert.equal(persisted.drafts.length, 1)
    assert.equal(persisted.drafts[0].state, 'draft')
    result.restartPreservedDismissalAndDraft = true
    result.status = 'passed'
    writeAtomic(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    console.log('PASS options/Other/multi/typed/custom:false/stale/manual, exact clipboard, rapid copy, zero PTY input, cleared reminders and unique editor at all3sizes; failure retains card; dismissal/draft persist across restart')
  } catch (error) {
    result.status = 'failed'
    writeAtomic(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    const page = await app.firstWindow().catch(() => null)
    if (page) {
      await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
      const state = await page.evaluate(async () => ({ attention: await window.aiTerminal.listAttention(),
        drafts: await window.aiTerminal.listDrafts(), body: document.body.innerText })).catch(() => null)
      writeFileSync(join(evidence, 'failure.json'), JSON.stringify(state, null, 2))
    }
    throw error
  } finally {
    const page = await app.firstWindow().catch(() => null)
    if (page) await page.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces()) for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
    }).catch(() => {})
    await app.close()
  }
})
