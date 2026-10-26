// MODULE: quick-look-self-test.test.ts - Recall must finish before the canonical focus/path observation
import { afterEach, expect, it, vi } from 'vitest'
import { runQuickLookIntegration } from './quick-look-self-test'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

/** The same tree-before-read completion order exercised through real IPC in quick162. */
function recallFixture(remembered: boolean): { visits(): number } {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  let open = false, loaded = false, expanded = false, inFile = false, visits = 0
  let path = '/fixture/project/remembered.ts'
  const load = (): void => { setTimeout(() => { loaded = true; inFile = true }, 100) }
  const leaf = {
    querySelector: () => ({ textContent: 'quick-look.ts' }),
    click: () => {
      visits++
      queueMicrotask(() => { loaded = false; inFile = false; path = '/fixture/project/refs/src/quick-look.ts'; load() })
    }
  }
  const folder = {
    querySelector: () => ({ textContent: 'refs/src' }),
    getAttribute: () => expanded ? 'true' : 'false',
    click: () => { expanded = true }
  }
  const dialog = {
    querySelector(selector: string) {
      if (selector === '.ql-tr') return folder
      if (selector === '.ql-code .cm-content' || selector === '.ql-code .ql-syn-keyword') return loaded ? {} : null
      if (selector === '.ql-path .ql-pth') return loaded ? { title: path } : null
      if (selector === '.ql-head') return { textContent: 'fixture/project' }
      if (selector === '.ql-path') return { textContent: loaded ? 'refs/src/quick-look.tsTypeScript · 5 lines · 107 B' : 'Reading…' }
      throw Error('Unexpected fixture selector: ' + selector)
    },
    querySelectorAll(selector: string) {
      if (selector === '.ql-tr') return expanded ? [folder, leaf] : [folder]
      if (selector === '.ql-tr .ql-nm') return [{ textContent: 'refs/src' }]
      if (selector === '.cm-lineNumbers .cm-gutterElement') return Array(6).fill({})
      if (selector.startsWith('.ql-syn-')) return loaded ? [{}] : []
      throw Error('Unexpected fixture selector list: ' + selector)
    },
    dispatchEvent: () => { open = false }
  }
  vi.stubGlobal('KeyboardEvent', Event)
  vi.stubGlobal('window', { dispatchEvent: () => { open = true; if (remembered) load() } })
  vi.stubGlobal('document', {
    querySelector: () => open ? dialog : null,
    activeElement: {
      classList: { contains: (name: string) => !inFile && name === 'ql-tree' },
      closest: (selector: string) => inFile && selector === '.ql-code' ? {} : null
    }
  })
  return { visits: () => visits }
}

it('observes the remembered path and file focus after a delayed read, before visiting another file', async () => {
  const f = recallFixture(true)
  const result = runQuickLookIntegration({ refitCount: () => 7 })
  await vi.runAllTimersAsync()
  expect(await result).toMatchObject({ recalledAtOpen: '/fixture/project/remembered.ts', focusAtOpen: 'file', closed: true, refitsBefore: 7, refitsAfter: 7, highlighted: { keyword: 1, comment: 1, def: 1, lineNumbers: 6 }, focusInFile: true })
  expect(f.visits()).toBe(1)
})

it('fails when the required recall never appears instead of accepting a fresh tree', async () => {
  const f = recallFixture(false)
  const result = runQuickLookIntegration({ refitCount: () => 7 }).then(() => undefined, (error: unknown) => error)
  await vi.runAllTimersAsync()
  expect(await result).toBeInstanceOf(Error)
  expect(String(await result)).toContain('recalled file')
  expect(f.visits()).toBe(0)
})
