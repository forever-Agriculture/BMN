import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { trackAllowedSender } from './allowed-senders'

/** Like a BrowserWindow's contents: once the window is destroyed, reading through it throws. */
function windowContents(id: number): EventEmitter & { id: number; destroyWindow(): void } {
  let windowDestroyed = false
  const contents = new EventEmitter() as EventEmitter & { id: number; destroyWindow(): void }
  Object.defineProperty(contents, 'id', {
    get: () => {
      if (windowDestroyed) throw new TypeError('Object has been destroyed')
      return id
    }
  })
  contents.destroyWindow = () => {
    windowDestroyed = true
  }
  return contents
}

describe('trackAllowedSender', () => {
  it('allows the contents until they are destroyed', () => {
    const senders = new Set<number>()
    const contents = windowContents(7)
    trackAllowedSender(senders, contents)
    expect([...senders]).toEqual([7])
    contents.emit('destroyed')
    expect(senders.size).toBe(0)
  })

  it('forgets the sender without reading through a window that is already destroyed', () => {
    // An exception here reaches Electron's uncaught-exception dialog, which blocks quit.
    const senders = new Set<number>([3])
    const contents = windowContents(9)
    trackAllowedSender(senders, contents)
    contents.destroyWindow()
    expect(() => contents.emit('destroyed')).not.toThrow()
    expect([...senders]).toEqual([3])
  })
})
