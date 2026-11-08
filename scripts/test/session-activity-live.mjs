#!/usr/bin/env node
// MODULE: session-activity-live.mjs - declared synthetic host/CLI checks and fixed Now presentation fixtures
/* global window, document, getComputedStyle, innerWidth, matchMedia, requestAnimationFrame */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { atomicJson, disposableEnvironment, processIdentity } from '../qa/bench-lib.mjs'

const { values } = parseArgs({ options: { checkout: { type: 'string' }, output: { type: 'string' }, stage: { type: 'string' } } })
assert.ok(values.checkout && values.output, 'Expected --checkout BUILT_BENCH --output NEW_DIRECTORY')
assert.ok(['presentation', 'prepare', 'host'].includes(values.stage), 'Expected fixed --stage presentation|prepare|host')
const checkout = realpathSync(values.checkout), output = resolve(values.output)
assert.ok(!existsSync(output), 'Preserve prior evidence: output directory must be new')
mkdirSync(output, { recursive: true })
const state = JSON.parse(readFileSync(join(checkout, '.dev-auto/evidence/qa-bench/current.json')))
assert.equal(state.status, 'running')
assert.ok(state.root.startsWith('/tmp/bmn-qa-') && realpathSync(state.root) === state.root)
assert.equal(readFileSync(join(state.root, '.bmn-qa-run'), 'utf8').trim(), state.runId)
const socket = join(state.root, 'runtime/bmn/control/control.sock')
assert.ok(realpathSync(socket).startsWith(state.root + '/'))
const environment = disposableEnvironment(state.root), actors = [processIdentity(process.pid)], commands = [], captures = [], observations = {}, findings = []
const driverSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
const seed = JSON.parse(readFileSync(join(state.run, 'bench/seed.json')))
assert.equal(seed.driverSha256, driverSha256, 'Driver differs from the seed reserved before launch')
assert.deepEqual(seed.presets, ['success', 'pending', 'reject', 'partial', 'many', 'empty', 'reset'])
assert.deepEqual(seed.phases, ['presentation', 'prepare', 'host'])
assert.equal(processIdentity(state.pid)?.start_ticks, state.start_ticks, 'Bench process identity changed')
const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n')
const binding = { runId: state.runId, candidateSha256: state.candidateSha256, driverSha256 }
save('binding.json', { ...binding, phase: values.stage, actors })
const phaseDeadline = values.stage === 'prepare' ? Date.now() + 30000 : Infinity
const checkDeadline = () => assert.ok(Date.now() < phaseDeadline, 'Preparation exceeded its thirty-second deadline')
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
const wait = async (predicate, label, timeout = 5000) => {
  const deadline = Date.now() + timeout
  do { checkDeadline(); const result = await predicate(); if (result) return result; await pause(40) } while (Date.now() < deadline)
  throw new Error(`Missing executed acknowledgment: ${label}`)
}
async function cli(args) {
  checkDeadline()
  const record = { args, startedAt: Date.now(), scope: 'disposable owner controller', stdout: '', stderr: '' }
  commands.push(record)
  try {
    return await new Promise((resolveCli, reject) => {
      const child = spawn(process.execPath, [join(checkout, 'apps/desktop/bin/bmn'), ...args, '--owner', '--socket', socket, '--json'],
        { cwd: join(state.root, 'synthetic-project'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      actors.push(processIdentity(child.pid)); save('actors.json', actors)
      // The CLI owns its socket deadline. A probe deadline stops the method without signaling a reused numeric PID.
      const timer = setTimeout(() => { record.timedOut = true; reject(new Error('Disposable CLI exceeded its deadline')) }, Math.min(10000, phaseDeadline - Date.now()))
      child.stdout.on('data', data => { record.stdout += data }); child.stderr.on('data', data => { record.stderr += data })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        clearTimeout(timer); Object.assign(record, { code, signal, finishedAt: Date.now() }); save('commands.json', commands)
        if (code !== 0 || record.timedOut) reject(new Error(`Disposable CLI failed: ${JSON.stringify(record)}`))
        else { try { resolveCli(JSON.parse(record.stdout)) } catch (error) { reject(error) } }
      })
    })
  } finally { save('commands.json', commands) }
}
const quote = text => `'${text.replaceAll("'", "'\\''")}'`
async function send(id, command) { return cli(['send', command, '--session', id, '--submit', '--key', `qa1139-${randomUUID()}`]) }
async function executed(id, command, name) {
  const marker = join(state.root, 'synthetic-project', `${name}-${randomUUID()}.done`)
  await send(id, `{ ${command}; } > ${quote(marker + '.stdout')} 2> ${quote(marker + '.stderr')}; qa_exit=$?; printf '%s' "$qa_exit" > ${quote(marker + '.exit')}; printf done > ${quote(marker)}`)
  await wait(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'done', name)
  const evidence = { command, sessionId: id, completedAt: Date.now(), stdout: readFileSync(marker + '.stdout', 'utf8'), stderr: readFileSync(marker + '.stderr', 'utf8'), exit: readFileSync(marker + '.exit', 'utf8') }
  save(`executed-${name}.json`, evidence); assert.equal(evidence.exit, '0', evidence.stderr)
}
const browser = await chromium.connectOverCDP(state.cdp)
const page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('/renderer/'))
assert.ok(page); page.setDefaultTimeout(5000)
async function action(args) {
  checkDeadline()
  const response = await fetch(state.control + '/action', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
  const result = await response.json(); assert.ok(response.ok, result.error); return result
}
async function shot(name) { assert.ok(captures.length < 20); captures.push((await action(['screenshot', `${values.stage}-${name}`])).screenshot); save('captures.json', captures) }
const row = (report, id) => report.sections.flatMap(section => section.rows).find(item => item.sessionId === id)
const select = async id => {
  await action(['click', `.session-row > button[data-session-id="${id}"]`])
  await page.locator(`.session-terminal.selected[data-session-id="${id}"] .xterm-helper-textarea`).focus()
}
const snapshot = () => page.evaluate(async () => ({ sessions: (await Promise.all((await window.aiTerminal.listWorkspaces()).map(workspace => window.aiTerminal.listSessions(workspace.workspaceId)))).flat(), attention: await window.aiTerminal.listAttention() }))
const showNow = async () => { if (!await page.locator('dialog.now-dialog[open]').count()) await action(['click', 'button[aria-label="Now"]']); await page.locator('.n-main').first().waitFor() }
const hideNow = async () => { if (await page.locator('dialog.now-dialog[open]').count()) await action(['press', 'Escape']) }
const sidebarDot = id => page.locator(`.session-row > button[data-session-id="${id}"] .status-dot`).getAttribute('class')
const nowDot = id => page.locator(`.n-main[data-key="s:${id}"] .status-dot`).getAttribute('class')
const preparationTimer = values.stage === 'prepare' ? setTimeout(() => { void browser.close() }, phaseDeadline - Date.now()) : null
try {
  // All test records come through the normal UI/CLI; no host observations or native hooks are invented.
  const baseline = (await snapshot()).sessions
  const receiver = baseline.find(session => session.name === 'Review shell')
  assert.ok(receiver?.activity?.incarnationId)
  const journalPath = join(state.run, 'session-activity-prepared.json')
  if (values.stage === 'prepare') {
  assert.ok(!existsSync(journalPath), 'Preparation already has a receipt')
  const baselineIds = new Set(baseline.map(session => session.sessionId))
  const workspaceToggle = '.workspace-group[aria-label="QA review"] .workspace-row > button:first-child'
  if (await page.locator(workspaceToggle).getAttribute('aria-expanded') !== 'true') await action(['click', workspaceToggle])
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true', workspaceToggle)
  await action(['click', 'button[aria-label="Command palette"]'])
  await action(['click', '#palette-new-session'])
  await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Observer shell')
  const form = page.getByRole('complementary', { name: 'New session', exact: true })
  await form.getByText('Advanced', { exact: true }).click()
  await form.getByRole('textbox', { name: 'Arguments', exact: true }).fill('--noprofile --norc')
  await page.getByRole('button', { name: 'Create session', exact: true }).click()
  await page.getByRole('button', { name: 'Actions for Observer shell', exact: true }).waitFor()
  const observer = await wait(async () => {
    const matches = (await snapshot()).sessions.filter(session => session.name === 'Observer shell' && !baselineIds.has(session.sessionId))
    assert.ok(matches.length <= 1, 'Ambiguous created Observer')
    const session = matches[0]
    return session?.lastProcess?.state === 'live' && session.activity?.incarnationId === session.lastProcess.incarnationId && session
  }, 'new Observer live record')
  assert.equal(observer.workspaceId, receiver.workspaceId)
  await page.locator(`.session-row > button[data-session-id="${observer.sessionId}"]`).waitFor()
  for (const session of [receiver, observer]) {
    await select(session.sessionId)
    await executed(session.sessionId, `printf '__QA_PREFLIGHT_${session.sessionId}__\\n'`, 'preflight')
  }
  const confirmed = (await snapshot()).sessions
  for (const session of [receiver, observer]) assert.equal(confirmed.find(item => item.sessionId === session.sessionId)?.activity?.incarnationId, session.activity.incarnationId)
  checkDeadline()
  const journal = { ...binding, preparedAt: Date.now(), receiver, observer, actors }
  atomicJson(journalPath, journal); assert.deepEqual(JSON.parse(readFileSync(journalPath)), journal)
  observations.preflight = { receiver, observer, completedAt: Date.now() }; save('observations.json', observations)
  await shot('prepared-shells')
  }
  if (values.stage === 'host') {
  const journal = JSON.parse(readFileSync(journalPath))
  for (const [key, value] of Object.entries(binding)) assert.equal(journal[key], value)
  assert.ok(Date.now() - journal.preparedAt < 120000, 'Preparation receipt is stale')
  const observer = baseline.find(session => session.sessionId === journal.observer.sessionId)
  for (const session of [receiver, observer]) {
    const expected = session.sessionId === receiver.sessionId ? journal.receiver : journal.observer
    assert.equal(session.lastProcess.state, 'live'); assert.equal(session.activity.incarnationId, expected.activity.incarnationId)
    await page.locator(`.session-row > button[data-session-id="${session.sessionId}"]`).waitFor()
  }
  const agentNow = async label => {
    const path = join(state.root, 'synthetic-project', `${label}-${randomUUID()}.json`), code = path + '.exit'
    await executed(observer.sessionId, `bmn now --json > ${quote(path)} 2> ${quote(path + '.stderr')}; printf '%s' "$?" > ${quote(code)}`, label)
    assert.equal(readFileSync(code, 'utf8'), '0', readFileSync(path + '.stderr', 'utf8'))
    const report = JSON.parse(readFileSync(path)); save(`${label}-agent.json`, report)
    return row(report, receiver.sessionId)
  }
  await select(observer.sessionId)
  await cli(['ask', 'qa1139-notice', 'Synthetic finished turn', '--kind', 'notice', '--body', 'Synthetic local reminder', '--session', receiver.sessionId])
  await pause(2200)
  const notice = (await snapshot()).attention.find(item => item.requestKey === 'qa1139-notice')
  assert.equal(notice?.state, 'open'); assert.equal(notice.incarnationId, receiver.activity.incarnationId)
  const idleOwner = row(await cli(['now']), receiver.sessionId), idleAgent = await agentNow('resting')
  assert.equal(idleOwner.dot, 'running-idle'); assert.equal(idleAgent.dot, 'running-idle')
  assert.match(await sidebarDot(receiver.sessionId), /running-idle/); await shot('notice-sidebar')
  await showNow(); assert.match(await nowDot(receiver.sessionId), /running-idle/); await shot('notice-now'); await hideNow()
  observations.notice = { notice, idleOwner, idleAgent }
  const pulseStartedAt = Date.now()
  await send(receiver.sessionId, "qa_tick=0; while [ \"$qa_tick\" -lt 120 ]; do printf '__QA_PULSE_%s__\\n' \"$qa_tick\"; qa_tick=$((qa_tick+1)); sleep 0.25; done")
  await page.waitForFunction(id => [...document.querySelectorAll(`.session-terminal[data-session-id="${id}"] .xterm-rows`)].some(node => node.textContent.includes('__QA_PULSE_2__')), receiver.sessionId)
  const workingOwner = row(await cli(['now']), receiver.sessionId), workingAgent = await agentNow('working')
  assert.equal(workingOwner.dot, 'running'); assert.equal(workingAgent.dot, 'running')
  await showNow(); assert.equal(await nowDot(receiver.sessionId), 'status-dot running'); assert.equal(await sidebarDot(receiver.sessionId), 'status-dot running'); await shot('working-three-views'); await hideNow()
  await select(receiver.sessionId); assert.ok(Date.now() - pulseStartedAt < 29000); await action(['press', 'Control+c'])
  await page.waitForFunction(id => document.querySelector(`.session-terminal[data-session-id="${id}"] .xterm-rows`)?.textContent.includes('^C'), receiver.sessionId)
  const idle = await wait(async () => {
    const current = (await snapshot()).sessions.find(item => item.sessionId === receiver.sessionId)
    const word = await page.evaluate(id => window.__bmnActivity.words()[id], receiver.sessionId)
    return word === 'Idle' && { observedAt: Date.now(), lastOutputAt: current.activity.lastOutputAt }
  }, 'resting after actual Control-C')
  assert.ok(idle.observedAt - idle.lastOutputAt <= 2000, JSON.stringify(idle))
  const stoppedAgent = await agentNow('interrupted'), stoppedOwner = row(await cli(['now']), receiver.sessionId)
  assert.equal(stoppedAgent.dot, 'running-idle'); assert.equal(stoppedOwner.dot, 'running-idle')
  observations.activity = { workingOwner, workingAgent, idle, elapsedMs: idle.observedAt - idle.lastOutputAt, stoppedAgent, stoppedOwner,
    nativeAgentCondition: 'UNVERIFIED: actual shell output/interrupt, no native-agent tool hook.' }
  observations.noticeAfterExplicitOpen = (await snapshot()).attention.find(item => item.requestKey === 'qa1139-notice')
  assert.equal(observations.noticeAfterExplicitOpen.state, 'withdrawn')
  await cli(['ask', 'qa1139-question', 'Choose synthetic layout', '--kind', 'question', '--body', 'Disposable preference', '--session', receiver.sessionId])
  const question = (await snapshot()).attention.find(item => item.requestKey === 'qa1139-question')
  assert.equal(question.state, 'open'); assert.equal(question.incarnationId, receiver.activity.incarnationId)
  assert.equal(row(await cli(['now']), receiver.sessionId).dot, 'needs-you')
  await showNow(); await page.locator(`.n-main[data-key="s:${receiver.sessionId}"]`).focus()
  await page.waitForFunction(id => document.querySelector(`.n-main[data-key="s:${id}"] .status-dot`)?.classList.contains('needs-you'), receiver.sessionId)
  assert.equal(await page.locator('.n-scroll button[tabindex="0"]').count(), 1); await shot('waiting-list')
  await action(['press', 'Enter'])
  await page.waitForFunction(id => document.activeElement?.closest('[data-request-id]')?.getAttribute('data-request-id') === id, question.requestId)
  observations.focus = await page.evaluate(() => ({ active: document.activeElement.outerHTML, card: document.activeElement.closest('[data-request-id]')?.getAttribute('data-request-id') }))
  await shot('opened-card'); await action(['press', 'Escape'])
  await cli(['withdraw', 'qa1139-question', '--session', receiver.sessionId])
  save('observations.json', observations)
  }

  if (values.stage === 'presentation') {
  // Presentation evidence is explicitly synthetic, using fixed local props and the real bounded read path.
  const preset = async name => {
    if (name === 'reset') { await page.evaluate(() => window.__bmnNowFixture.select('reset')); return }
    const read = await page.evaluate(value => new Promise((resolveRead, rejectRead) => {
      const original = window.setTimeout
      const guard = original(() => { window.setTimeout = original; rejectRead(new Error('No bounded read started for preset')) }, 2000)
      window.setTimeout = function (handler, delay, ...args) {
        const timer = original.call(window, handler, delay, ...args)
        if (delay === 5000 && String(handler).includes('The read timed out')) {
          window.setTimeout = original; clearTimeout(guard); resolveRead({ preset: value, startedAt: Date.now() })
        }
        return timer
      }
      window.__bmnNowFixture.select(value)
    }), name)
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
    if (name === 'pending') assert.ok(Date.now() - read.startedAt < 2000, 'Pending capture must remain inside its real five-second deadline')
    observations.reads ??= []; observations.reads.push(read)
  }
  const readState = () => page.evaluate(() => ({ heading: document.querySelector('.n-words')?.textContent,
    copyDisabled: document.querySelector('.n-head button.plate')?.disabled, rows: document.querySelectorAll('.n-main').length,
    alert: document.querySelector('.n-alert')?.textContent ?? null }))
  await showNow(); await preset('reset'); await preset('pending'); observations.coldPending = await readState(); await shot('cold-loading')
  assert.match(observations.coldPending.heading, /Reading runs/); assert.equal(observations.coldPending.copyDisabled, true)
  await preset('reject'); await page.locator('.n-alert').waitFor(); observations.coldReject = await readState(); await shot('first-read-failed')
  await preset('success'); await wait(async () => (await readState()).heading?.startsWith('Read '), 'successful fixture read')
  await preset('pending'); observations.warmPending = await readState(); await shot('remembered-loading')
  if (!observations.warmPending.copyDisabled || !observations.warmPending.heading.includes('Reading')) findings.push('LOADING-READ: remembered refresh does not show Reading runs and disable Copy')
  await preset('reject'); await page.locator('.n-alert').waitFor(); observations.stale = await readState(); await shot('stale-read')
  if (!observations.stale.copyDisabled) findings.push('STALE-COPY: failed refresh leaves Copy enabled')
  await preset('success'); await wait(async () => !(await readState()).alert, 'fixture recovery')
  await preset('partial'); await page.getByText('Handoff unreadable', { exact: false }).first().waitFor(); await shot('partial-run')
  observations.partial = await readState()
  await preset('empty'); await page.getByText('No sessions yet.', { exact: true }).waitFor(); await shot('empty')
  await preset('many'); await page.waitForFunction(() => document.querySelectorAll('.n-main').length === 100)
  await page.locator('.n-main').first().focus(); await action(['press', 'End']); await action(['press', 'ArrowRight']); await action(['press', 'ArrowDown'])
  observations.many = await page.evaluate(() => ({ rows: document.querySelectorAll('.n-main').length,
    tabStops: [...document.querySelectorAll('.n-scroll button[tabindex="0"]')].filter(node => !node.closest('[hidden]')).length,
    focused: document.activeElement?.getAttribute('data-now-key'), scrollTop: document.querySelector('.n-scroll')?.scrollTop,
    longName: document.querySelector('.n-main')?.getAttribute('aria-label'), tooltip: document.querySelector('.n-main')?.getAttribute('title') }))
  assert.equal(observations.many.rows, 100); assert.equal(observations.many.tabStops, 1)
  assert.equal(observations.many.longName, observations.many.tooltip); await shot('hundred-rows')
  const focused = observations.many.focused; await preset('many')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-now-key')), focused)
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 320, height: 740 })
  observations.narrow = await page.evaluate(() => ({ width: innerWidth,
    dialog: document.querySelector('dialog.now-dialog').getBoundingClientRect().toJSON(),
    copy: document.querySelector('.n-head button.plate').getBoundingClientRect().toJSON(),
    columns: getComputedStyle(document.querySelector('.n-cols')).display,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }))
  await shot('narrow-reduced-motion')
  if (observations.narrow.dialog.right > 320 || observations.narrow.dialog.left < 0 || observations.narrow.copy.right > 320) findings.push('NARROW: required dialog or Copy action outside 320px viewport')
  await preset('reset'); await page.setViewportSize({ width: 1000, height: 700 })
  await wait(async () => await page.locator(`.n-main[data-key="s:${receiver.sessionId}"]`).count(), 'live inputs after fixture reset')
  observations.reset = { liveInputsRestored: true }
  }
  save('observations.json', observations); save('findings.json', findings)
  console.log(JSON.stringify({ runId: state.runId, phase: values.stage, output, phaseCompleted: true, nativeAgentCondition: 'UNVERIFIED', findings }))
} catch (error) {
  save('failure.json', { message: error.message, stack: error.stack }); save('observations.json', observations); save('findings.json', findings)
  throw error
} finally { if (preparationTimer !== null) clearTimeout(preparationTimer); save('actors.json', actors); await browser.close() }
