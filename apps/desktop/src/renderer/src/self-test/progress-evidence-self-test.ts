// MODULE: progress-evidence-self-test.ts - Electron self-test of the progress detail: honest words, no PTY input, no resize
import type { Terminal } from '@xterm/xterm'
import type { ProgressEvidenceProbe } from '../progress-evidence-probe'

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

function channels(colour: string): [number, number, number] {
  const parts = colour.match(/[\d.]+/g)?.map(Number) ?? []
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** WCAG relative luminance and contrast, so the four states can be shown to stay legible. */
function contrast(foreground: string, background: string): number {
  const luminance = (colour: string): number => {
    const [red, green, blue] = channels(colour).map((value) => {
      const channel = value / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const first = luminance(foreground)
  const second = luminance(background)
  const [lighter, darker] = first > second ? [first, second] : [second, first]
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
}

/** A CSS variable as the browser resolves it, in the same `rgb(...)` form as a computed colour. */
function token(name: string, probe: HTMLElement): string {
  const previous = probe.style.color
  probe.style.color = `var(${name})`
  const resolved = getComputedStyle(probe).color
  probe.style.color = previous
  return resolved
}

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

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Runs Progress details from the palette by keyboard for the selected `pane`, with focus on `opener`
 * first. It changes no selection: selecting a session marks its notices seen, which the attention
 * checks after this one count.
 */
async function openFromPalette(pane: HTMLElement, opener: HTMLElement): Promise<HTMLDialogElement> {
  if (!pane.classList.contains('selected')) throw new Error('progress evidence integration: the probing pane was not the selected one')
  opener.focus()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }))
  const input = await waitFor('the palette opened', () => document.querySelector<HTMLInputElement>('.command-palette input'))
  setInputValue(input, 'Progress details')
  await waitFor('the palette offered Progress details', () => document.querySelector('#palette-progress-details[aria-selected="true"]'))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return waitFor('the progress detail opened from the palette', () => openDialog())
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

  const verifiedWord = stateButton(reportingPane)
  const bareWord = stateButton(ownPane)
  const stripBackground = getComputedStyle(
    reportingPane.querySelector<HTMLElement>('.progress-strip')!
  ).backgroundColor
  const evidenceWord = verifiedWord.querySelector<HTMLElement>('.evidence')!
  const colours = {
    verifiedInk: getComputedStyle(verifiedWord).color,
    verifiedToken: token('--verified', verifiedWord),
    failedInk: getComputedStyle(bareWord).color,
    errorToken: token('--error', bareWord),
    evidenceInk: getComputedStyle(evidenceWord).color,
    mutedToken: token('--muted', evidenceWord),
    verifiedContrast: contrast(getComputedStyle(verifiedWord).color, stripBackground),
    evidenceContrast: contrast(getComputedStyle(evidenceWord).color, stripBackground)
  }

  const quiet = {
    inputEventsBefore,
    inputEventsAfter: options.inputEvents(),
    surfaceHeightBefore,
    surfaceHeightWhileOpen,
    surfaceHeightAfter: surface(ownPane),
    gridBefore,
    gridAfter: { cols: terminal.cols, rows: terminal.rows }
  }

  // The keyboard route: xterm consumes Tab inside the terminal, so the palette is the way in for the
  // selected session (Story 75.10 moved Progress details there from the pane's More menu). This pane's
  // report has nothing behind it, and the surface never implies otherwise. Closing must hand focus back
  // to what had it before the palette opened, or a keyboard owner is left nowhere.
  const ownMore = ownPane.querySelector<HTMLButtonElement>('.pane-actions [data-action="more"]')
  if (!ownMore) throw new Error('progress evidence integration: this pane had no More button')
  const bare = await openFromPalette(ownPane, ownMore)
  const bareDialog = {
    title: bare.getAttribute('aria-label') ?? '',
    body: [...bare.querySelectorAll('.dialog-note')].map((note) => text(note)).join(' | ')
  }
  bare.dispatchEvent(new Event('cancel', { cancelable: true }))
  await waitFor('the evidence-free detail closed', () => openDialog() === null)
  const focusReturnedToOpener = document.activeElement === ownMore

  return {
    reportedStrip,
    bareStrip,
    dialog: detail,
    colours,
    quiet,
    focusReturnedToStrip,
    focusReturnedToOpener,
    openedFromPalette: true,
    bareDialog
  }
}
