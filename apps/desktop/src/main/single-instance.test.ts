import { describe, expect, it, vi } from 'vitest'
import { acquireRootScopedSingleInstance, focusExistingWindow } from './single-instance'

describe('root-scoped single-instance behavior', () => {
  it('sets userData to the isolated data root before requesting the lock', () => {
    const calls: string[] = []
    const app = {
      setPath: vi.fn((_name: string, path: string) => calls.push(`path:${path}`)),
      requestSingleInstanceLock: vi.fn((data: Record<string, unknown>) => {
        calls.push(`lock:${data.dataRoot}`)
        return true
      }),
      on: vi.fn(),
      quit: vi.fn()
    }

    expect(acquireRootScopedSingleInstance(app, '/isolated/data', () => undefined)).toBe(true)
    expect(calls).toEqual(['path:/isolated/data', 'lock:/isolated/data'])
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quits a second launch and focuses an existing window on notification', () => {
    let secondInstance: (() => void) | undefined
    const onSecondInstance = vi.fn()
    const primaryApp = {
      setPath: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((_event: string, listener: () => void) => (secondInstance = listener)),
      quit: vi.fn()
    }
    acquireRootScopedSingleInstance(primaryApp, '/isolated/a', onSecondInstance)
    secondInstance?.()
    expect(onSecondInstance).toHaveBeenCalledOnce()

    const secondaryApp = {
      ...primaryApp,
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn()
    }
    expect(acquireRootScopedSingleInstance(secondaryApp, '/isolated/b', () => undefined)).toBe(false)
    expect(secondaryApp.quit).toHaveBeenCalledOnce()

    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }
    focusExistingWindow(window)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
})
