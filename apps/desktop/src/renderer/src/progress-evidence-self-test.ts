// MODULE: progress-evidence-self-test.ts - Electron self-test of the progress detail: honest words, no PTY input, no resize
import type { Terminal } from '@xterm/xterm'
import type { ProgressEvidenceProbe } from './progress-evidence-probe'

/** The first two waits sit behind a shell that publishes and reports, so they wait a real while. */
async function waitFor<Value>(
  label: string,
  probe: () => Value | undefined | null | false,
  timeoutMs = 5_000
): Promise<Value> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined && value !== null && value !== false) return value
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`progress evidence integration timed out: ${label}`)
}

const text = (node: Element | null | undefined): string => node?.textContent?.trim() ?? ''

function openDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('dialog.progress-evidence-dialog[open]')
}

function stripOf(pane: HTMLElement): HTMLElement | null {
  return pane.querySelector<HTMLElement>('.progress-strip')
}

function stateButton(pane: HTMLElement): HTMLButtonElement {
  const button = pane.querySelector<HTMLButtonElement>('.progress-strip .progress-open')
  if (!button) throw new Error('progress evidence integration: the strip had no state button')
  return button
}

function menuEntry(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.popup-menu [role="menuitem"]')]
    .find((item) => item.textContent?.trim().startsWith(label))
}

/**
 * Drives the progress detail the way the owner does: read the strip, click the word, read what it
 * says, preview the file it names, and close it. The point of the run is as much what does *not*
 * happen — the terminal is never written to and never resized, which is why the detail is a modal
 * dialog and not a region that grows under the strip.
 */
export async function runProgressEvidenceIntegration(options: {
  /** The probing pane; its own session reported nothing with evidence. */
  ownPane: HTMLElement
  /** The other visible pane, whose session published a file and reported `verified` with it. */
  reportingPane: HTMLElement
  terminal: Terminal
  /** Everything this pane's terminal has sent to the PTY so far. */
  inputEvents: () => number
}): Promise<ProgressEvidenceProbe> {
  const { ownPane, reportingPane, terminal } = options
  const surface = (pane: HTMLElement): number =>
    pane.querySelector<HTMLElement>('.terminal-surface')?.getBoundingClientRect().height ?? -1

  const reportedStrip = await waitFor('the reporting pane showed its verified report', () => {
    const line = text(stripOf(reportingPane))
    return line.includes('Reported verified') && line.includes('Evidence attached (1)') ? line : false
  }, 30_000)
  const bareStrip = await waitFor('this pane said it has no evidence', () => {
    const line = text(stripOf(ownPane))
    return line.includes('No evidence attached') ? line : false
  }, 30_000)

  const inputEventsBefore = options.inputEvents()
  const surfaceHeightBefore = surface(ownPane)
  const gridBefore = { cols: terminal.cols, rows: terminal.rows }

  const opener = stateButton(reportingPane)
  // The keyboard route: focus the word, then activate it. A real mouse click focuses the button the
  // same way; a synthetic `click()` alone would not, and focus restore is what is being tested.
  opener.focus()
  if (document.activeElement !== opener) {
    throw new Error('progress evidence integration: the strip state word could not take focus')
  }
  opener.click()
  const dialog = await waitFor('the progress detail opened', () => openDialog())
  const surfaceHeightWhileOpen = surface(ownPane)

  const row = await waitFor('the evidence row was listed', () => dialog.querySelector('.progress-evidence li'))
  const preview = [...row.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Preview')
  if (!preview) throw new Error('progress evidence integration: a ready file offered no preview')
  preview.click()
  const previewText = await waitFor('the evidence file was previewed', () => {
    const body = text(dialog.querySelector('.files-preview-text pre'))
    return body.length > 0 ? body : false
  })

  const detail = {
    title: dialog.getAttribute('aria-label') ?? '',
    note: text(dialog.querySelector('.dialog-note')),
    provenance: text(dialog.querySelector('.provenance')),
    rowName: text(row.querySelector('.name')),
    rowAvailability: text(row.querySelector('.availability')),
    previewText
  }

  // Escape reaches a modal dialog as its cancel event; a synthetic key press would not.
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
  await waitFor('the progress detail closed', () => openDialog() === null)
  const focusReturnedToStrip = document.activeElement === opener

  const quiet = {
    inputEventsBefore,
    inputEventsAfter: options.inputEvents(),
    surfaceHeightBefore,
    surfaceHeightWhileOpen,
    surfaceHeightAfter: surface(ownPane),
    gridBefore,
    gridAfter: { cols: terminal.cols, rows: terminal.rows }
  }

  // The keyboard route: xterm consumes Tab inside the terminal, so the pane's More menu is the way in.
  const more = reportingPane.querySelector<HTMLButtonElement>('.pane-actions [data-action="more"]')
  if (!more) throw new Error('progress evidence integration: the reporting pane had no More button')
  more.click()
  const entry = await waitFor('the pane menu offered Progress details', () => menuEntry('Progress details'))
  entry.click()
  const fromMenu = await waitFor('the progress detail opened from the menu', () => openDialog())
  fromMenu.dispatchEvent(new Event('cancel', { cancelable: true }))
  await waitFor('the menu-opened detail closed', () => openDialog() === null)

  // The same detail for a report with nothing behind it: the surface never implies otherwise.
  const ownMore = ownPane.querySelector<HTMLButtonElement>('.pane-actions [data-action="more"]')
  if (!ownMore) throw new Error('progress evidence integration: this pane had no More button')
  ownMore.click()
  const ownEntry = await waitFor('this pane menu offered Progress details', () => menuEntry('Progress details'))
  ownEntry.click()
  const bare = await waitFor('the evidence-free detail opened', () => openDialog())
  const bareDialog = {
    title: bare.getAttribute('aria-label') ?? '',
    body: [...bare.querySelectorAll('.dialog-note')].map((note) => text(note)).join(' | ')
  }
  bare.dispatchEvent(new Event('cancel', { cancelable: true }))
  await waitFor('the evidence-free detail closed', () => openDialog() === null)

  return {
    reportedStrip,
    bareStrip,
    dialog: detail,
    quiet,
    focusReturnedToStrip,
    openedFromPaneMenu: true,
    bareDialog
  }
}
