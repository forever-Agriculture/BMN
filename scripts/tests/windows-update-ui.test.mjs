// MODULE: windows-update-ui.test.mjs - drives the actual WinForms update windows and toast helper on native Windows
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { askWindowsUpdateQuestion, notifyWindowsUpdate, showWindowsUpdateLog, startWindowsUpdateProgress } from '../lib/windows-update-ui.mjs'
import { WINDOWS_UPDATE_LOG, WindowsUpdateObserver } from '../lib/windows-update-progress.mjs'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { automateWindow } from '../test/fixtures/windows-ui-automation.mjs'

const native = process.platform === 'win32'
const roots = [], started = []
const start = (...args) => { const child = spawn(...args); started.push(child); return child }
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
const names = view => view.elements.map(element => element.name)

describe.runIf(native)('native Windows update windows', () => {
  it('renders the actual update stage, then closes on the completion request and allows opening BMN', async () => {
    const f = fixture(), observer = new WindowsUpdateObserver(f.requests, f.attemptId)
    const progress = await startWindowsUpdateProgress({ parent: f.parent, attemptId: f.attemptId, progressPath: join(f.requests, WINDOWS_UPDATE_LOG), text: 'Getting the update ready…', start })
    expect(progress.ready).toBe(true)
    const pid = started[0].pid
    const first = await automateWindow({ processId: pid, title: 'BMN is updating', until: 'Getting the update ready…' })
    expect(first.found).toBe(true)
    expect(first.elements).toContainEqual(expect.objectContaining({ type: 'ControlType.Button', name: "Don't wait", enabled: true }))
    expect(first.elements.some(element => element.type === 'ControlType.ProgressBar')).toBe(true)
    observer.enter('package')
    expect((await automateWindow({ processId: pid, title: 'BMN is updating', until: 'Packaging the new build. This can take several minutes.' })).found).toBe(true)
    observer.enter('smoke')
    expect((await automateWindow({ processId: pid, title: 'BMN is updating', until: 'Checking the new build…' })).found).toBe(true)
    const state = await progress.finish()
    expect(state).toMatchObject({ ready: true, acknowledged: true, suppressed: false, autoOpenAfterSuccessfulUpdate: true })
    expect(started[0].exitCode).toBe(0)
  }, 120000)

  it.each([['invoke', "Don't wait"], ['close', undefined]])('suppresses opening when the owner dismisses the window (%s)', async (action, name) => {
    const f = fixture()
    const progress = await startWindowsUpdateProgress({ parent: f.parent, attemptId: f.attemptId, progressPath: join(f.requests, WINDOWS_UPDATE_LOG), text: 'Getting the update ready…', start })
    expect((await automateWindow({ processId: started[0].pid, title: 'BMN is updating', action, name })).acted).toBe(true)
    await exited(started[0])
    expect(await progress.finish()).toMatchObject({ ready: true, suppressed: true, acknowledged: false, autoOpenAfterSuccessfulUpdate: false })
  }, 120000)

  it('treats an unexpected exit after readiness as dismissal, never as permission to open', async () => {
    const f = fixture()
    const progress = await startWindowsUpdateProgress({ parent: f.parent, attemptId: f.attemptId, progressPath: join(f.requests, WINDOWS_UPDATE_LOG), text: 'Getting the update ready…', start })
    started[0].kill(); await exited(started[0])
    expect(await progress.finish()).toMatchObject({ ready: true, suppressed: true, autoOpenAfterSuccessfulUpdate: false })
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
    const view = await automateWindow({ processId: child.pid, title: 'BMN update failed', until: labels[0] })
    expect(view.found).toBe(true)
    expect(names(view)).toContain(text)
    expect(view.elements.filter(element => element.type === 'ControlType.Button').map(element => element.name).sort()).toEqual([...labels].sort())
    expect(view.elements.find(element => element.name === labels[0]).focused).toBe(true)
    const acted = await automateWindow({ processId: child.pid, title: 'BMN update failed', action: press ? 'invoke' : 'close', name: press ?? undefined })
    expect(acted.acted).toBe(true)
    expect(await answer).toBe(decision)
  }, 120000)

  it('shows the update log read-only in its own viewer and reports that it was shown', async () => {
    const f = fixture(), text = 'BMN update cccccccccccc\r\n2026-10-05T10:00:00.000Z FAIL  Packaging the new build (12 s; build command failed; exit 1)'
    const shown = showWindowsUpdateLog({ parent: f.parent, text, start })
    const child = await startedChild(0)
    const view = await automateWindow({ processId: child.pid, title: 'BMN update log', until: 'Close' })
    const box = view.elements.find(element => element.type === 'ControlType.Edit')
    expect(box.value).toBe(text)
    expect((await automateWindow({ processId: child.pid, title: 'BMN update log', action: 'invoke', name: 'Close' })).acted).toBe(true)
    expect(await shown).toBe('shown')
  }, 120000)

  it('submits an informational notification only through the registered app identity, or reports it unavailable', async () => {
    // Submission is not proof of display; an unregistered runner identity is unavailable.
    expect(['submitted', 'unavailable']).toContain(await notifyWindowsUpdate({ title: 'BMN is updating', text: 'BMN opens when the update finishes.', start }))
    expect(started[0].spawnargs.join(' ')).not.toContain('BMN opens')
  }, 60000)
})
