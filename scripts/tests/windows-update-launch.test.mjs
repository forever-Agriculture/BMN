import { expect, it } from 'vitest'
import { windowsQueuedStartMode } from '../lib/windows-update-launch.mjs'

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
