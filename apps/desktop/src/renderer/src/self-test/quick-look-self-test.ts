// MODULE: quick-look-self-test.ts - Electron self-test of Quick look: opened by key, the tree walked, a file coloured, closed with no refit (Story 67.1)
import type { QuickLookFlowProbe } from '../quick-look-probe'

async function waitFor<Value>(label: string, probe: () => Value | undefined | null): Promise<Value> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined && value !== null) return value
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Quick look integration timed out: ${label}`)
}

const sheet = (): HTMLDialogElement | null => document.querySelector<HTMLDialogElement>('dialog.quick-look[open]')

function row(name: string): HTMLElement | undefined {
  return [...(sheet()?.querySelectorAll<HTMLElement>('.ql-tr') ?? [])].find((item) => item.querySelector('.ql-nm')?.textContent === name)
}

/** Opens Quick look the way the owner does, walks to `refs/src/quick-look.ts`, reads what it draws, and closes it. */
export async function runQuickLookIntegration(options: { refitCount(): number }): Promise<QuickLookFlowProbe> {
  const refitsBefore = options.refitCount()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, bubbles: true }))
  const dialog = await waitFor('the sheet', sheet)
  await waitFor('the first row', () => dialog.querySelector('.ql-tr'))
  const focusInTree = document.activeElement?.classList.contains('ql-tree') === true
  const rows = [...dialog.querySelectorAll('.ql-tr .ql-nm')].map((item) => item.textContent ?? '')
  const rootShown = dialog.querySelector('.ql-head')?.textContent ?? ''
  // `refs` holds only `src`, so the tree shows the two joined as one row.
  const folder = await waitFor('the refs/src folder', () => row('refs/src'))
  if (folder.getAttribute('aria-expanded') !== 'true') folder.click()
  await waitFor('refs/src open', () => (row('refs/src')?.getAttribute('aria-expanded') === 'true' ? true : undefined))
  ;(await waitFor('quick-look.ts', () => row('quick-look.ts'))).click()
  await waitFor('the coloured file', () => dialog.querySelector('.ql-code .ql-syn-keyword'))
  const highlighted = {
    keyword: dialog.querySelectorAll('.ql-syn-keyword').length,
    comment: dialog.querySelectorAll('.ql-syn-comment').length,
    def: dialog.querySelectorAll('.ql-syn-def').length,
    lineNumbers: dialog.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length
  }
  const pathRow = dialog.querySelector('.ql-path')?.textContent ?? ''
  const focusInFile = !!document.activeElement?.closest('.ql-code')
  // Escape reaches a modal dialog as its cancel event; a synthetic key press would not.
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
  await waitFor('the sheet to close', () => (sheet() ? undefined : true))
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  return { opened: true, focusInTree, rootShown, rows, pathRow, highlighted, focusInFile, closed: true, refitsBefore, refitsAfter: options.refitCount() }
}
