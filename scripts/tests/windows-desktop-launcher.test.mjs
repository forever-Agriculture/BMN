// MODULE: windows-desktop-launcher.test.mjs - native Windows equivalents of desktop-launcher.test.mjs
// Real WinForms windows driven through UI Automation, the toast helper, private
// storage, durable installation selection and CIM process observation. As in
// the Linux fixture (fake systemctl and BMN), the update work and launch are synthetic.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { runWindowsDesktopStart, windowsUpdateTexts } from '../lib/windows-update-launch.mjs'
import { askWindowsUpdateQuestion, notifyWindowsUpdate, showWindowsUpdateLog, startWindowsUpdateProgress } from '../lib/windows-update-ui.mjs'
import { WINDOWS_UPDATE_LOG, WindowsUpdateObserver, readWindowsUpdateLog, renderWindowsUpdateLog, windowsUpdateFailure } from '../lib/windows-update-progress.mjs'
import { readWindowsInstallation, releaseDirectory } from '../lib/windows-release-transaction.mjs'
import { observeWindowsSelectedApps } from '../lib/windows-installed-worker.mjs'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { automateWindow } from '../test/fixtures/windows-ui-automation.mjs'

const native = process.platform === 'win32'
const previous = { commit: 'a'.repeat(40), payloadSha256: 'b'.repeat(64), schemaVersion: 23 }
const candidate = { commit: 'c'.repeat(40), payloadSha256: 'd'.repeat(64), schemaVersion: 23 }
const roots = [], started = [], apps = []
const start = (...args) => { const child = spawn(...args); started.push(child); return child }
const running = child => child.exitCode === null && child.signalCode === null
const exited = child => running(child) ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()
afterEach(async () => {
  for (const child of [...started.splice(0), ...apps.splice(0)]) if (running(child)) { child.kill(); await exited(child) }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function startedChild(index) {
  for (let tries = 0; started.length <= index; tries++) { if (tries > 1200) throw new Error('Window process did not start'); await delay(50) }
  return started[index]
}
const names = view => view.elements.map(element => element.name)
const buttons = view => view.elements.filter(element => element.role === 'button').map(element => element.name).sort()

function fixture({ phase = null, selected = previous, windowsAvailable = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-desktop-start-')); roots.push(root)
  const requests = join(root, 'requests'), windows = join(requests, 'windows')
  ensurePrivateDirectories([requests])
  const select = value => value ? writeFileSync(join(root, 'installation.json'), JSON.stringify({ format: 1, current: value, previous: null, snapshot: null }))
    : rmSync(join(root, 'installation.json'), { force: true })
  select(selected)
  let request = phase ? { format: 1, attemptId: randomUUID(), phase, commit: candidate.commit } : null
  const launches = [], notifications = [], resumed = []
  // The start swallows resume errors by design; a failed check inside the synthetic
  // update must fail the test instead of leaving a question window nobody answers.
  let failure
  const checked = run => (...args) => failure ? Promise.reject(failure) : run(...args)
  // Unavailable windows use a missing executable; the notification helper stays real.
  const options = { start, ...(windowsAvailable ? {} : { executable: join(root, 'missing-powershell.exe') }) }
  const ui = {
    startProgress: value => startWindowsUpdateProgress({ parent: windows, attemptId: value.attemptId, progressPath: join(requests, WINDOWS_UPDATE_LOG), text: windowsUpdateTexts.progress, ...options }),
    ask: checked(value => askWindowsUpdateQuestion({ parent: windows, ...value, ...options })),
    showLog: checked(text => showWindowsUpdateLog({ parent: windows, text, ...options })),
    notify: async (title, text) => { const status = await notifyWindowsUpdate({ title, text }); notifications.push({ title, text, status }); return status }
  }
  const f = { root, launches, notifications, resumed, select, observer: () => new WindowsUpdateObserver(requests, request.attemptId),
    finishRequest: (finalPhase, extra = {}) => { request = { ...request, phase: finalPhase, ...extra } } }
  f.run = (resume = async () => {}) => runWindowsDesktopStart({ ui,
    readRequest: () => request, readSelection: () => readWindowsInstallation(root),
    observeSelectedApps: () => observeWindowsSelectedApps(root),
    launch: async () => { launches.push(readWindowsInstallation(root)?.current?.commit ?? null); return 0 },
    resume: async () => { resumed.push(true); try { await resume() } catch (error) { failure = error; throw error } },
    readLog: value => renderWindowsUpdateLog(readWindowsUpdateLog(requests, value?.attemptId), value?.commit) })
  return f
}
const complete = f => { f.select(candidate); f.finishRequest('complete', { candidate }) }
function fail(f, after, withCandidate) {
  const observer = f.observer()
  observer.enter('package'); observer.fail(windowsUpdateFailure('synthetic package failure', 'command', 1))
  f.select(after); f.finishRequest('failed', withCandidate ? { candidate } : {})
}

describe.runIf(native)('native Windows desktop launcher', () => {
  it('starts BMN at once when no update is queued', async () => {
    const f = fixture({ phase: 'complete' })
    expect(await f.run()).toBe(0)
    expect(f.launches).toEqual([previous.commit]); expect(started).toEqual([]); expect(f.resumed).toEqual([])
  }, 60000)

  it.each(['waiting-for-exit', 'building'])('holds a start while the update is %s and BMN is closed', async phase => {
    const f = fixture({ phase: phase === 'building' ? 'building' : 'waiting' })
    expect(await f.run(async () => {
      const observer = f.observer(), text = phase === 'building' ? 'Packaging the new build. This can take several minutes.' : 'Getting the update ready…'
      observer.enter(phase === 'building' ? 'package' : 'waiting')
      expect(await automateWindow({ processId: started[0].pid, title: 'BMN is updating', until: text })).toMatchObject({ found: true })
      expect(f.launches).toEqual([])
      observer.finish(); complete(f)
    })).toBe(0)
    expect(f.launches).toEqual([candidate.commit])
  }, 120000)

  it('shows the build step the owner is waiting on, and closes the window when the update ends', async () => {
    const f = fixture({ phase: 'building' })
    expect(await f.run(async () => {
      const observer = f.observer()
      observer.enter('package')
      expect(await automateWindow({ processId: started[0].pid, title: 'BMN is updating', until: 'Packaging the new build. This can take several minutes.' })).toMatchObject({ found: true })
      observer.enter('smoke')
      expect(await automateWindow({ processId: started[0].pid, title: 'BMN is updating', until: 'Checking the new build…' })).toMatchObject({ found: true })
      observer.finish(); complete(f)
    })).toBe(0)
    // Closed by the completion request (exit 0 after its acknowledgement), then BMN opened.
    expect(started[0].exitCode).toBe(0); expect(f.launches).toEqual([candidate.commit])
    expect((await automateWindow({ processId: started[0].pid, title: 'BMN is updating', timeoutMs: 500 })).found).toBe(false)
  }, 120000)

  it('does not start a half-replaced build when the owner dismisses the window', async () => {
    const f = fixture({ phase: 'building' })
    expect(await f.run(async () => {
      expect(await automateWindow({ processId: started[0].pid, title: 'BMN is updating', action: 'invoke', name: "Don't wait" })).toMatchObject({ acted: true })
      await exited(started[0])
      // The owned update continues to its durable end after dismissal.
      complete(f)
    })).toBe(0)
    expect(f.launches).toEqual([]); expect(started).toHaveLength(1)
  }, 120000)

  it.each([
    [undefined, previous, false, windowsUpdateTexts.previous],
    ['previous', previous, true, windowsUpdateTexts.previous],
    ['new', candidate, true, windowsUpdateTexts.new]
  ])('after a failed update with liveBuild %s, says so and opens BMN, or opens the log instead when asked', async (_liveBuild, after, withCandidate, text) => {
    const accept = fixture({ phase: 'building' })
    const accepted = accept.run(async () => fail(accept, after, withCandidate))
    const question = await startedChild(1)
    const view = await automateWindow({ processId: question.pid, title: 'BMN update failed', until: 'Open BMN' })
    expect(names(view)).toContain(text); expect(buttons(view)).toEqual(['Open BMN', 'Show log'])
    expect(await automateWindow({ processId: question.pid, title: 'BMN update failed', action: 'invoke', name: 'Open BMN' })).toMatchObject({ acted: true })
    expect(await accepted).toBe(0); expect(accept.launches).toEqual([after.commit])

    const showLog = fixture({ phase: 'building' }), base = started.length
    const declined = showLog.run(async () => fail(showLog, after, withCandidate))
    const second = await startedChild(base + 1)
    expect(await automateWindow({ processId: second.pid, title: 'BMN update failed', action: 'invoke', name: 'Show log', until: 'Show log' })).toMatchObject({ acted: true })
    const viewer = await startedChild(base + 2)
    const log = (await automateWindow({ processId: viewer.pid, title: 'BMN update log', until: 'Close' })).elements.find(element => element.role === 'editable text')
    expect(log.value).toContain(`BMN update ${candidate.commit.slice(0, 12)}`)
    expect(log.value).toMatch(/FAIL {2}Packaging the new build \(\d+ s; build command failed; exit 1\)/u)
    expect(log.value).not.toContain('synthetic package failure')
    expect(await automateWindow({ processId: viewer.pid, title: 'BMN update log', action: 'invoke', name: 'Close' })).toMatchObject({ acted: true })
    expect(await declined).toBe(0); expect(showLog.launches).toEqual([])
  }, 180000)

  it('opens nothing when the failed update left no build in place, and says so', async () => {
    const f = fixture({ phase: 'building' })
    const result = f.run(async () => fail(f, null, true))
    const question = await startedChild(1)
    const view = await automateWindow({ processId: question.pid, title: 'BMN update failed', until: 'Show log' })
    expect(names(view)).toContain(windowsUpdateTexts.none); expect(buttons(view)).toEqual(['Close', 'Show log'])
    expect(await automateWindow({ processId: question.pid, title: 'BMN update failed', action: 'invoke', name: 'Show log' })).toMatchObject({ acted: true })
    const viewer = await startedChild(2)
    expect(await automateWindow({ processId: viewer.pid, title: 'BMN update log', action: 'invoke', name: 'Close', until: 'Close' })).toMatchObject({ acted: true })
    expect(await result).toBe(1); expect(f.launches).toEqual([])
  }, 120000)

  it('says the same in the notification when the windows cannot be shown', async () => {
    const f = fixture({ phase: 'building', windowsAvailable: false })
    expect(await f.run(async () => fail(f, previous, true))).toBe(0)
    expect(f.notifications.map(({ title, text }) => [title, text])).toEqual([['BMN is updating', windowsUpdateTexts.updating], ['BMN update failed', windowsUpdateTexts.previous]])
    for (const row of f.notifications) expect(['submitted', 'unavailable']).toContain(row.status)
    expect(f.launches).toEqual([previous.commit])
  }, 120000)

  it('opens nothing from a retained previous payload when no build is selected', async () => {
    const f = fixture({ phase: 'failed', selected: null })
    const retained = releaseDirectory(f.root, previous); mkdirSync(retained, { recursive: true })
    writeFileSync(join(retained, 'BMN.exe'), 'retained payload must not run')
    const result = f.run()
    const dialog = await startedChild(0)
    const view = await automateWindow({ processId: dialog.pid, title: 'BMN cannot start', until: 'Close' })
    expect(names(view)).toContain(windowsUpdateTexts.missing); expect(buttons(view)).toEqual(['Close'])
    expect(await automateWindow({ processId: dialog.pid, title: 'BMN cannot start', action: 'invoke', name: 'Close' })).toMatchObject({ acted: true })
    expect(await result).toBe(1); expect(f.launches).toEqual([]); expect(f.resumed).toEqual([])
  }, 120000)

  it('never reports an older failed update to a start that did not wait for one', async () => {
    const f = fixture({ phase: 'failed' })
    expect(await f.run()).toBe(0)
    expect(f.launches).toEqual([previous.commit]); expect(started).toEqual([]); expect(f.notifications).toEqual([])
  }, 60000)

  it('falls back to a notification where the progress window cannot be shown', async () => {
    const f = fixture({ phase: 'building', windowsAvailable: false })
    expect(await f.run(async () => complete(f))).toBe(0)
    expect(f.notifications.map(({ title, text }) => [title, text])).toEqual([['BMN is updating', windowsUpdateTexts.updating]])
    expect(f.launches).toEqual([candidate.commit])
  }, 120000)

  it('forwards a start to the running BMN while the update waits for it to exit', async () => {
    const f = fixture({ phase: 'waiting' })
    // A real process whose image is the selected payload's BMN.exe, observed through CIM.
    const payload = releaseDirectory(f.root, previous); mkdirSync(payload, { recursive: true })
    copyFileSync(process.execPath, join(payload, 'BMN.exe'))
    const app = spawn(join(payload, 'BMN.exe'), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); apps.push(app)
    for (let tries = 0; !observeWindowsSelectedApps(f.root).includes(app.pid); tries++) {
      if (tries > 50) throw new Error('Selected app was not observed'); await delay(200)
    }
    expect(await f.run()).toBe(0)
    expect(f.launches).toEqual([previous.commit]); expect(f.resumed).toEqual([]); expect(started).toEqual([])
  }, 120000)
})
