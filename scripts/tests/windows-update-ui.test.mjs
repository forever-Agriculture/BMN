// MODULE: windows-update-ui.test.mjs - drives the actual WinForms update windows and toast helper on native Windows
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { askWindowsUpdateQuestion, notifyWindowsUpdate, showWindowsUpdateLog, startWindowsUpdateProgress, systemPowerShell, windowArguments, windowEnvironment } from '../lib/windows-update-ui.mjs'
import { WINDOWS_UPDATE_LOG, WindowsUpdateObserver } from '../lib/windows-update-progress.mjs'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { automateWindow } from '../test/fixtures/windows-ui-automation.mjs'

const native = process.platform === 'win32'
const roots = [], started = []
const windowDirectories = new WeakMap()
const start = (...args) => {
  const child = spawn(...args); started.push(child)
  const directory = args[2]?.env?.BMN_UPDATE_UI_DIRECTORY
  if (directory) windowDirectories.set(child, directory)
  return child
}
function readyAt(child) {
  try { return statSync(join(windowDirectories.get(child), '1-ready.event')).mtimeMs }
  catch { return undefined }
}
function recordFocus(observation) {
  mkdirSync('test-results', { recursive: true })
  const path = join('test-results', `windows-update-focus-${randomUUID()}.json`)
  const temporary = path + '.tmp'
  writeFileSync(temporary, JSON.stringify(observation, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}
const running = child => child.exitCode === null && child.signalCode === null
const exited = child => running(child) ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()
afterEach(async () => {
  for (const child of started.splice(0)) if (running(child)) { child.kill(); await exited(child) }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-update-ui-')); roots.push(root)
  const requests = join(root, 'requests'); ensurePrivateDirectories([requests])
  return { requests, parent: join(requests, 'windows'), attemptId: randomUUID() }
}
async function startedChild(index) {
  for (let tries = 0; started.length <= index; tries++) { if (tries > 600) throw new Error('Window process did not start'); await delay(50) }
  return started[index]
}
// These tests drive the window itself. Under the parallel CI inventory a window took 28-46 s to
// show (run 37299667758), so they allow 90 s and report each start against the product's 20 s
// default; the default budget's timeout and fallback have their own test below.
async function startProgress(f, text = 'Getting the update ready…') {
  const begun = Date.now()
  const progress = await startWindowsUpdateProgress({ parent: f.parent, attemptId: f.attemptId, progressPath: join(f.requests, WINDOWS_UPDATE_LOG), text, start, readyTimeout: 90000 })
  const elapsedMs = Date.now() - begun
  console.log(JSON.stringify({ nativeDiagnostic: 'update-progress-readiness', observationOnly: true, productBudgetMs: 20000, exceededProductBudget: elapsedMs > 20000, ready: progress.ready, elapsedMs }))
  return progress
}
const texts = view => view.elements.map(element => element.text)
// The whole automation result on failure: what the window showed, not just the mismatch.
const shown = view => JSON.stringify(view).slice(0, 4000)
const expectWindow = (view, expected) => { expect(view, shown(view)).toMatchObject(expected); return view }

describe.runIf(native)('native Windows update windows', () => {
  it('renders the actual update stage, then closes on the completion request and allows opening BMN', async () => {
    const f = fixture(), observer = new WindowsUpdateObserver(f.requests, f.attemptId)
    const progress = await startProgress(f)
    expect(progress.ready).toBe(true)
    const pid = started[0].pid
    const first = await automateWindow({ processId: pid, title: 'BMN is updating', until: 'Getting the update ready…' })
    expectWindow(first, { found: true })
    expect(first.elements).toContainEqual(expect.objectContaining({ role: 'button', name: "Don't wait", enabled: true }))
    expect(first.elements.some(element => element.role === 'progress bar')).toBe(true)
    observer.enter('package')
    expectWindow(await automateWindow({ processId: pid, title: 'BMN is updating', until: 'Packaging the new build. This can take several minutes.' }), { found: true })
    observer.enter('smoke')
    expectWindow(await automateWindow({ processId: pid, title: 'BMN is updating', until: 'Checking the new build…' }), { found: true })
    const state = await progress.finish()
    expect(state).toMatchObject({ ready: true, acknowledged: true, suppressed: false, autoOpenAfterSuccessfulUpdate: true })
    expect(started[0].exitCode).toBe(0)
  }, 120000)

  it.each([['invoke', "Don't wait"], ['close', undefined]])('suppresses opening when the owner dismisses the window (%s)', async (action, name) => {
    const f = fixture()
    const progress = await startProgress(f)
    expectWindow(await automateWindow({ processId: started[0].pid, title: 'BMN is updating', action, name }), { acted: true })
    await exited(started[0])
    expect(await progress.finish()).toMatchObject({ ready: true, suppressed: true, acknowledged: false, autoOpenAfterSuccessfulUpdate: false })
  }, 120000)

  it('treats an unexpected exit after readiness as dismissal, never as permission to open', async () => {
    const f = fixture()
    const progress = await startProgress(f)
    started[0].kill(); await exited(started[0])
    expect(await progress.finish()).toMatchObject({ ready: true, suppressed: true, autoOpenAfterSuccessfulUpdate: false })
  }, 120000)

  it('stops a window that is not ready within its budget and asks for the notification instead', async () => {
    const f = fixture()
    // A budget shorter than any PowerShell start exercises the product's timeout path with a real window process.
    const progress = await startWindowsUpdateProgress({ parent: f.parent, attemptId: f.attemptId, progressPath: join(f.requests, WINDOWS_UPDATE_LOG), text: 'Getting the update ready…', start, readyTimeout: 100 })
    expect(progress.ready).toBe(false)
    expect(running(started[0])).toBe(false)
    expect(await progress.finish()).toMatchObject({ ready: false, suppressed: false, unavailable: true, autoOpenAfterSuccessfulUpdate: false, notificationFallbackNeeded: true })
  }, 120000)

  it('reports an unavailable window instead of waiting or claiming a decision', async () => {
    const f = fixture(), executable = join(f.requests, 'missing-powershell.exe')
    const progress = await startWindowsUpdateProgress({ parent: f.parent, attemptId: f.attemptId, progressPath: join(f.requests, WINDOWS_UPDATE_LOG), text: 'x', start, executable })
    expect(progress.ready).toBe(false)
    expect(await progress.finish()).toMatchObject({ suppressed: false, unavailable: true, notificationFallbackNeeded: true })
    expect(await askWindowsUpdateQuestion({ parent: f.parent, title: 'BMN update failed', text: 'x', buttons: 'open-log', start, executable })).toBe('unavailable')
    expect(await showWindowsUpdateLog({ parent: f.parent, text: 'x', start, executable })).toBe('unavailable')
    expect(await notifyWindowsUpdate({ title: 'BMN', text: 'x', start, executable })).toBe('unavailable')
  }, 120000)

  it.each([
    ['open-log', ['Open BMN', 'Show log'], 'Open BMN', 'open'],
    ['open-log', ['Open BMN', 'Show log'], 'Show log', 'show-log'],
    ['open-log', ['Open BMN', 'Show log'], null, 'closed'],
    ['log-close', ['Show log', 'Close'], 'Show log', 'show-log'],
    ['log-close', ['Show log', 'Close'], 'Close', 'closed'],
    ['close', ['Close'], 'Close', 'closed']
  ])('asks with %s buttons, shows literal text and returns the explicit choice', async (buttons, labels, press, decision) => {
    const f = fixture(), text = 'Literal $env:USERNAME %PATH% "quoted" ^ & `tick 数据 — nothing is evaluated.'
    const answer = askWindowsUpdateQuestion({ parent: f.parent, title: 'BMN update failed', text, buttons, start })
    const child = await startedChild(0)
    const request = { processId: child.pid, title: 'BMN update failed', until: labels[0], focusName: labels[0], readyAtMs: readyAt(child) }
    const view = await automateWindow(request)
    const snapshots = view.focusSamples ?? [view]
    const ready = readyAt(child)
    for (const snapshot of snapshots) {
      if (ready !== undefined && snapshot.capturedAtMs >= ready) snapshot.readyAgeMs = snapshot.capturedAtMs - ready
    }
    recordFocus({ observationOnly: true, buttons, press, firstFocusRemainsAssertion: true, readyAtMs: ready, snapshots })
    expectWindow(view, { found: true })
    // Window text is what the label displays; accessible names drop '&' as a mnemonic marker.
    expect(texts(view), shown(view)).toContain(text)
    expect(view.elements.filter(element => element.role === 'button').map(element => element.name).sort()).toEqual([...labels].sort())
    expect(view.elements.find(element => element.name === labels[0]).focused).toBe(true)
    const acted = await automateWindow({ processId: child.pid, title: 'BMN update failed', action: press ? 'invoke' : 'close', name: press ?? undefined })
    expectWindow(acted, { acted: true })
    expect(await answer).toBe(decision)
  }, 120000)

  it('shows the update log read-only in its own viewer and reports that it was shown', async () => {
    const f = fixture(), text = 'BMN update cccccccccccc\r\n2026-10-05T10:00:00.000Z FAIL  Packaging the new build (12 s; build command failed; exit 1)'
    const shown = showWindowsUpdateLog({ parent: f.parent, text, start })
    const child = await startedChild(0)
    const view = await automateWindow({ processId: child.pid, title: 'BMN update log', until: 'Close' })
    const box = view.elements.find(element => element.role === 'editable text')
    expect(box.value).toBe(text)
    expectWindow(await automateWindow({ processId: child.pid, title: 'BMN update log', action: 'invoke', name: 'Close' }), { acted: true })
    expect(await shown).toBe('shown')
  }, 120000)

  it('submits an informational notification only through the registered app identity, or reports it unavailable', async () => {
    // Submission is not proof of display; an unregistered runner identity is unavailable.
    expect(['submitted', 'unavailable']).toContain(await notifyWindowsUpdate({ title: 'BMN is updating', text: 'BMN opens when the update finishes.', start }))
    expect(started[0].spawnargs.join(' ')).not.toContain('BMN opens')
  }, 60000)

  // Observation only: one sample of where a window's start time goes, with the product's flags and
  // environment, plus a full-environment control. It locates a cost; it does not assert a budget.
  it('records where an update window spends its start time', async () => {
    const product = windowEnvironment({}, process.env), full = { ...process.env }
    const winforms = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing'
    // The product prelude's order, timed inside the process: module import, then Add-Type with discovery off.
    const explicitImport = ["$watch=[Diagnostics.Stopwatch]::StartNew()",
      "Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))",
      '$imported=$watch.ElapsedMilliseconds', "$PSModuleAutoLoadingPreference='None'", winforms,
      "[Console]::Out.Write([string]::Format('{0},{1}',$imported,$watch.ElapsedMilliseconds))", 'exit 0'].join('\n')
    const stages = [
      ['bare', 'product', 'exit 0', product],
      ['bare', 'full', 'exit 0', full],
      ['winforms-load', 'product', `${winforms}; exit 0`, product],
      ['winforms-load', 'full', `${winforms}; exit 0`, full],
      ['winforms-load', 'product-explicit-import', explicitImport, product],
      ['form-shown', 'product', `${winforms}; $form=New-Object Windows.Forms.Form; $form.Add_Shown({ [Environment]::Exit(0) }); [void]$form.ShowDialog()`, product]
    ]
    const results = []
    for (const [stage, environment, script, env] of stages) {
      const begun = Date.now(), child = start(systemPowerShell(), windowArguments(`$ErrorActionPreference='Stop'\n${script}`), { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false })
      let output = ''
      child.stdout.on('data', data => { output += data })
      const outcome = await Promise.race([
        new Promise(resolve => { child.once('error', error => resolve({ error: error.code ?? 'unknown' })); child.once('exit', code => resolve({ code })) }),
        delay(50000).then(() => ({ timedOut: true }))])
      if (outcome.timedOut) { child.kill(); await exited(child) }
      const inner = /^(\d+),(\d+)$/u.exec(output.trim())
      results.push({ stage, environment, elapsedMs: Date.now() - begun, ...outcome,
        ...(inner ? { importMs: Number(inner[1]), importAndAddTypeMs: Number(inner[2]) } : {}) })
    }
    console.log(JSON.stringify({ nativeDiagnostic: 'update-window-start-cost', observationOnly: true, results }))
    expect(results).toHaveLength(stages.length)
  }, 330000)
})
