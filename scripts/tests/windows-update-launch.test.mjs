import { expect, it } from 'vitest'
import { classifyWindowsFailedUpdate, runWindowsDesktopStart, windowsQueuedStartMode, windowsUpdateTexts } from '../lib/windows-update-launch.mjs'

it.each(['queued', 'waiting'])('forwards a start to a live GUI while the update is %s', phase => {
  expect(windowsQueuedStartMode({ phase }, [123])).toBe('forward')
  expect(windowsQueuedStartMode({ phase }, [])).toBe('resume')
})
it.each(['building', 'validating', 'activating', 'complete', 'failed'])('does not bypass the queue or source checks while %s', phase => {
  expect(windowsQueuedStartMode({ phase }, [123])).toBe('resume')
})
it('rejects incomplete GUI observations and allows an ordinary unqueued start', () => {
  expect(() => windowsQueuedStartMode({ phase: 'waiting' }, null)).toThrow('incomplete')
  expect(() => windowsQueuedStartMode({ phase: 'queued' }, ['123'])).toThrow('incomplete')
  expect(windowsQueuedStartMode(null, [])).toBe('resume')
})

// Platform-independent decisions of the Windows desktop start. Native windows,
// toast and selection are exercised by windows-desktop-launcher.test.mjs.
const previous = { commit: 'a'.repeat(40), payloadSha256: 'b'.repeat(64), schemaVersion: 23 }
const candidate = { commit: 'c'.repeat(40), payloadSha256: 'd'.repeat(64), schemaVersion: 23 }
function start({ phase = 'building', after = { current: previous }, finalPhase = 'complete', progressReady = true, suppressed = false,
  answer = 'open', gui = [], withCandidate = finalPhase === 'complete' } = {}) {
  let request = phase === null ? null : { phase, commit: candidate.commit, attemptId: '00000000-0000-4000-8000-000000000000' }
  let selection = { current: previous }
  const calls = []
  const ui = {
    startProgress: async value => { calls.push(['progress', value.phase]); return { ready: progressReady, finish: async () => { calls.push(['finish']); return { suppressed } } } },
    ask: async options => { calls.push(['ask', options.title, options.text, options.buttons]); return answer },
    showLog: async text => { calls.push(['log', text]); return 'shown' },
    notify: async (title, text) => { calls.push(['notify', title, text]); return 'submitted' }
  }
  const run = () => runWindowsDesktopStart({ ui,
    readRequest: () => request, readSelection: () => { if (selection instanceof Error) throw selection; return selection },
    observeSelectedApps: () => gui,
    launch: async () => { calls.push(['launch']); return 7 },
    resume: async () => { calls.push(['resume']); request = { ...request, phase: finalPhase, ...(withCandidate ? { candidate } : {}) }; selection = after },
    readLog: value => `synthetic log ${value?.commit}` })
  return { run, calls, setSelection: value => { selection = value } }
}
const kinds = calls => calls.map(([kind]) => kind)

it('starts BMN at once when no update is queued, and never reports an older failed update', async () => {
  for (const phase of [null, 'complete', 'failed']) {
    const f = start({ phase })
    expect(await f.run()).toBe(7); expect(kinds(f.calls)).toEqual(['launch'])
  }
})
it('forwards a start to the running BMN while the update waits for it to exit', async () => {
  const f = start({ phase: 'waiting', gui: [4242] })
  expect(await f.run()).toBe(7); expect(kinds(f.calls)).toEqual(['launch'])
})
it.each(['queued', 'waiting', 'building', 'activating'])('holds a %s start in the progress window until the update completes', async phase => {
  const f = start({ phase, after: { current: candidate } })
  expect(await f.run()).toBe(7); expect(kinds(f.calls)).toEqual(['progress', 'resume', 'finish', 'launch'])
})
it('does not start a half-replaced build when the owner dismisses the window, and reports nothing', async () => {
  for (const finalPhase of ['complete', 'failed']) {
    const f = start({ suppressed: true, finalPhase })
    expect(await f.run()).toBe(0); expect(kinds(f.calls)).toEqual(['progress', 'resume', 'finish'])
  }
})
it('falls back to a notification where the progress window cannot be shown, then opens the finished build', async () => {
  const f = start({ progressReady: false, after: { current: candidate } })
  expect(await f.run()).toBe(7)
  expect(f.calls).toEqual([['progress', 'building'], ['notify', 'BMN is updating', 'BMN opens when the update finishes.'], ['resume'], ['finish'], ['launch']])
})
it.each([
  ['the previous build stayed selected', { current: previous }, false, windowsUpdateTexts.previous],
  ['a legacy failure recorded no candidate', { current: previous }, false, windowsUpdateTexts.previous],
  ['the new build is selected', { current: candidate }, true, windowsUpdateTexts.new]
])('after a failed update where %s, says so and opens BMN, or opens the log instead when asked', async (_name, after, withCandidate, text) => {
  const accepted = start({ finalPhase: 'failed', after, withCandidate })
  expect(await accepted.run()).toBe(7)
  expect(accepted.calls.at(-2)).toEqual(['ask', 'BMN update failed', text, 'open-log']); expect(accepted.calls.at(-1)).toEqual(['launch'])
  const declined = start({ finalPhase: 'failed', after, withCandidate, answer: 'show-log' })
  expect(await declined.run()).toBe(0)
  expect(declined.calls.at(-1)).toEqual(['log', `synthetic log ${candidate.commit}`]); expect(kinds(declined.calls)).not.toContain('launch')
  const closed = start({ finalPhase: 'failed', after, withCandidate, answer: 'closed' })
  expect(await closed.run()).toBe(0); expect(kinds(closed.calls)).not.toContain('launch')
})
it('opens nothing when the failed update left no build selected, and says so', async () => {
  const f = start({ finalPhase: 'failed', after: null, answer: 'show-log' })
  expect(await f.run()).toBe(1)
  expect(f.calls.at(-2)).toEqual(['ask', 'BMN update failed', windowsUpdateTexts.none, 'log-close']); expect(kinds(f.calls)).not.toContain('launch')
  expect(f.calls.at(-1)[0]).toBe('log')
})
it('never calls an unknown or foreign selection unchanged and opens nothing', async () => {
  for (const after of [new Error('synthetic unreadable selection'), { current: { ...previous, commit: 'e'.repeat(40) } }]) {
    const f = start({ finalPhase: 'failed', after, answer: 'closed' })
    expect(await f.run()).toBe(1)
    expect(f.calls.at(-1)).toEqual(['ask', 'BMN update failed', windowsUpdateTexts.unverified, 'log-close'])
    expect(kinds(f.calls)).not.toContain('launch')
  }
})
it('says the same in the notification when no window can ask, then opens the verified selection', async () => {
  const f = start({ finalPhase: 'failed', after: { current: previous }, withCandidate: false, answer: 'unavailable' })
  expect(await f.run()).toBe(7)
  expect(f.calls.slice(-2)).toEqual([['notify', 'BMN update failed', windowsUpdateTexts.previous], ['launch']])
})
it('opens nothing and says so when no build is selected, without inspecting retained versions', async () => {
  const missing = start({ phase: null }); missing.setSelection(null)
  expect(await missing.run()).toBe(1)
  expect(missing.calls).toEqual([['ask', 'BMN cannot start', windowsUpdateTexts.missing, 'close']])
  const unreadable = start({ phase: 'failed', answer: 'unavailable' }); unreadable.setSelection(new Error('synthetic invalid selection'))
  expect(await unreadable.run()).toBe(1)
  expect(unreadable.calls).toEqual([['ask', 'BMN cannot start', windowsUpdateTexts.unreadable, 'close'], ['notify', 'BMN cannot start', windowsUpdateTexts.unreadable]])
})
it('classifies a failed update only from authoritative selection', () => {
  const before = { current: previous }
  expect(classifyWindowsFailedUpdate({ before, after: { current: previous }, candidate })).toBe('previous')
  expect(classifyWindowsFailedUpdate({ before, after: { current: candidate }, candidate })).toBe('new')
  expect(classifyWindowsFailedUpdate({ before, after: null, candidate })).toBe('none')
  expect(classifyWindowsFailedUpdate({ before, after: undefined, candidate })).toBe('unverified')
  expect(classifyWindowsFailedUpdate({ before: undefined, after: { current: previous }, candidate: undefined })).toBe('unverified')
})
