// MODULE: file-reference-self-test.ts - Electron self-test of file references: keyboard palette, Ctrl+click, mouse mode, no PTY input
import type { Terminal } from '@xterm/xterm'
import type { FileReferenceFlowProbe } from './file-reference-probe'


const MARKER = 'FILEREF refs/src/parser.ts:42:7'
const LINK_TEXT = 'refs/src/parser.ts:42:7'

async function waitFor<Value>(label: string, probe: () => Value | undefined | null | Promise<Value | undefined | null>): Promise<Value> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined && value !== null) return value
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`file-reference integration timed out: ${label}`)
}

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function openDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('dialog.file-reference-dialog[open]')
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`file-reference integration: the ${label} button was not rendered`)
  return found
}

/** The text shown beside a label in the dialog's details list. */
function detail(dialog: HTMLElement, label: string): string {
  const term = [...dialog.querySelectorAll('dt')].find((item) => item.textContent?.trim() === label)
  const value = term?.nextElementSibling
  return value?.querySelector('.mono')?.textContent?.trim() ?? value?.textContent?.trim() ?? ''
}

async function closeWithEscape(dialog: HTMLDialogElement): Promise<void> {
  // Escape reaches a modal dialog as its cancel event; a synthetic key press would not.
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
  await waitFor('dialog close', () => (openDialog() ? undefined : true))
}

async function openRequestTitles(): Promise<string> {
  return JSON.stringify((await window.aiTerminal.listAttention())
    .filter((request) => request.state === 'open' && request.kind !== 'notice')
    .map((request) => request.title)
    .toSorted())
}

/** Selects `pane`, opens its reference from the palette by keyboard, and reads back what the dialog shows. */
export async function openReferenceFromPane(options: {
  pane: HTMLElement
  workspaceId: string
  sessionId: string
  reference: string
}): Promise<NonNullable<FileReferenceFlowProbe['crossWorkspace']>> {
  options.pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await waitFor('pane selected', async () => {
    const layout = (await window.aiTerminal.getLayout(options.workspaceId)).layout
    return layout.selectedSessionId === options.sessionId ? true : undefined
  })
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }))
  const paletteInput = await waitFor('palette', () => document.querySelector<HTMLInputElement>('.command-palette input'))
  setInputValue(paletteInput, 'Open file reference')
  await waitFor('palette result', () => document.querySelector('#palette-file-reference[aria-selected="true"]'))
  paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const dialog = await waitFor('file-reference dialog', openDialog)
  const input = await waitFor('reference input', () => dialog.querySelector<HTMLInputElement>('input[aria-label="File reference"]'))
  setInputValue(input, options.reference)
  input.closest('form')?.requestSubmit()
  const marked = await waitFor('marked line', () => dialog.querySelector('.file-reference-line')?.textContent ?? undefined)
  const shown = {
    session: detail(dialog, 'Session'),
    base: detail(dialog, 'Launch directory'),
    file: detail(dialog, 'File'),
    marked
  }
  await closeWithEscape(dialog)
  return shown
}

export async function runFileReferenceIntegration(options: {
  sessionId: string
  sessionName: string
  workspaceId: string
  terminal: Terminal
  section: HTMLElement
  refitCount(): number
}): Promise<FileReferenceFlowProbe> {
  const { terminal, section } = options
  const record = (await window.aiTerminal.listSessions(options.workspaceId))
    .find((session) => session.sessionId === options.sessionId)
  if (!record) throw new Error('file-reference integration: the probe session record is missing')
  const launchDirectory = record.cwd
  const attentionBefore = await openRequestTitles()
  // The previous flow just closed the files panel; its resize reaches this pane a frame or two later.
  let refits = -1
  while (refits !== options.refitCount()) {
    refits = options.refitCount()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))
  }
  const sizeBefore = { cols: terminal.cols, rows: terminal.rows, refits: options.refitCount() }
  const elementBefore = terminal.element
  let ptyInput = 0
  const inputCounter = terminal.onData(() => {
    ptyInput += 1
  })
  const textarea = section.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  terminal.focus()

  // 8.1: palette by keyboard, typed reference, copy, show and Escape.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }))
  const paletteInput = await waitFor('palette', () => document.querySelector<HTMLInputElement>('.command-palette input'))
  setInputValue(paletteInput, 'Open file reference')
  await waitFor('palette result', () => document.querySelector('#palette-file-reference[aria-selected="true"]'))
  paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const dialog = await waitFor('file-reference dialog', openDialog)
  const input = await waitFor('reference input', () => dialog.querySelector<HTMLInputElement>('input[aria-label="File reference"]'))
  const focusedInput = document.activeElement === input
  const form = input.closest('form')
  if (!form) throw new Error('file-reference integration: the reference form is missing')
  setInputValue(input, LINK_TEXT)
  form.requestSubmit()
  const marked = await waitFor('marked line', () => dialog.querySelector('.file-reference-line')?.textContent ?? undefined)
  const palette = {
    focusedInput,
    base: detail(dialog, 'Launch directory'),
    file: detail(dialog, 'File'),
    marked,
    position: dialog.querySelector('.file-reference-status')?.textContent?.trim() ?? '',
    copied: '',
    shownFeedback: '',
    focusReturned: false
  }
  const feedback = (): string => dialog.querySelector('.file-reference-feedback')?.textContent?.trim() ?? ''
  const savedClipboard = await window.aiTerminal.readClipboardText()
  button(dialog, 'Copy reference').click()
  await waitFor('copy feedback', () => (feedback() === 'Reference copied.' ? true : undefined))
  palette.copied = (await window.aiTerminal.readClipboardText()).text
  await window.aiTerminal.writeClipboardText(savedClipboard.text)
  button(dialog, 'Show in folder').click()
  palette.shownFeedback = await waitFor('show feedback', () => (feedback() === 'Shown in the file manager.' ? feedback() : undefined))

  const alert = (): string | undefined => dialog.querySelector('[role="alert"]')?.textContent?.trim() || undefined
  setInputValue(input, 'src/parser.ts')
  form.requestSubmit()
  const shellDirectoryIgnored = {
    message: await waitFor('launch-directory miss', alert),
    base: detail(dialog, 'Launch directory'),
    file: detail(dialog, 'File')
  }
  button(dialog, 'Choose folder…').click()
  const pickerMessage = await waitFor('picker message', () => {
    const text = alert()
    return text?.includes('dialogs') ? text : undefined
  })
  const chosen = await window.aiTerminal.readFileReference({
    sessionId: options.sessionId,
    reference: 'src/parser.ts',
    baseDirectory: `${launchDirectory}/refs`
  })
  setInputValue(input, '$HOME/notes.txt')
  form.requestSubmit()
  const rejectedMessage = await waitFor('rejection', () => {
    const text = alert()
    return text?.includes('variables') ? text : undefined
  })
  const rejected = { message: rejectedMessage, inputPreserved: input.value === '$HOME/notes.txt' }
  await closeWithEscape(dialog)
  palette.focusReturned = await waitFor('focus return', () => (document.activeElement === textarea ? true : undefined))

  // 8.2: Ctrl+click the printed reference while the other pane is selected.
  const buffer = terminal.buffer.active
  const row = await waitFor('printed reference', () => {
    for (let y = buffer.length - 1; y >= 0; y -= 1) {
      if (buffer.getLine(y)?.translateToString(true).includes(MARKER)) return y
    }
    return undefined
  })
  const viewportRow = row - buffer.viewportY
  if (viewportRow < 1 || viewportRow >= terminal.rows) {
    throw new Error(`file-reference integration: the printed reference is outside the viewport (${viewportRow})`)
  }
  const column = buffer.getLine(row)!.translateToString(true).indexOf(LINK_TEXT)
  const screen = section.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) throw new Error('file-reference integration: the xterm screen is missing')
  const rect = screen.getBoundingClientRect()
  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  const mouse = (type: string, cell: { x: number; y: number }, ctrlKey: boolean): void => {
    screen.dispatchEvent(new MouseEvent(type, {
      clientX: rect.left + (cell.x + 0.5) * cellWidth,
      clientY: rect.top + (cell.y + 0.5) * cellHeight,
      ctrlKey,
      button: 0,
      buttons: type === 'mousedown' ? 1 : 0,
      // xterm starts a selection only on a press that counts as a first click.
      detail: type === 'mousemove' ? 0 : 1,
      bubbles: true,
      cancelable: true,
      view: window
    }))
  }
  /** Hover another row first so xterm asks the provider again instead of reusing an earlier answer. */
  const hover = (x: number, ctrlKey: boolean): boolean => {
    screen.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    mouse('mousemove', { x: 0, y: viewportRow - 1 }, ctrlKey)
    mouse('mousemove', { x, y: viewportRow }, ctrlKey)
    return screen.classList.contains('xterm-cursor-pointer')
  }
  const click = (x: number, ctrlKey: boolean): void => {
    mouse('mousedown', { x, y: viewportRow }, ctrlKey)
    mouse('mouseup', { x, y: viewportRow }, ctrlKey)
  }

  const otherPane = [...document.querySelectorAll<HTMLElement>('.session-terminal:not(.session-terminal-hidden)')]
    .find((pane) => pane.dataset.sessionId !== options.sessionId)
  if (!otherPane) throw new Error('file-reference integration: the second visible pane is missing')
  otherPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  const otherSessionId = otherPane.dataset.sessionId
  const selectedElsewhere = await waitFor('other pane selected', async () => {
    const layout = (await window.aiTerminal.getLayout(options.workspaceId)).layout
    return layout.selectedSessionId === otherSessionId ? true : undefined
  })
  const opener = await waitFor('other pane focus', () =>
    otherPane.contains(document.activeElement) ? document.activeElement : undefined)
  const underlinedWithCtrl = hover(column + 2, true)
  click(column + 2, true)
  const linkDialog = await waitFor('link dialog', openDialog)
  const linkMarked = await waitFor('link marked line', () => linkDialog.querySelector('.file-reference-line')?.textContent ?? undefined)
  const link = {
    reference: linkDialog.querySelector<HTMLInputElement>('input[aria-label="File reference"]')?.value ?? '',
    session: detail(linkDialog, 'Session'),
    marked: linkMarked,
    selectedElsewhere,
    underlinedWithCtrl,
    focusReturned: false
  }
  await closeWithEscape(linkDialog)
  link.focusReturned = await waitFor('link focus return', () => (document.activeElement === opener ? true : undefined))

  const plainUnderlined = hover(column + 3, false)
  click(column + 3, false)
  await pause(300)
  const plainClick = { underlined: plainUnderlined, opened: openDialog() !== null }

  const clipboardBeforeDrag = await window.aiTerminal.readClipboardText()
  hover(column, true)
  mouse('mousedown', { x: column, y: viewportRow }, true)
  document.dispatchEvent(new MouseEvent('mousemove', {
    clientX: rect.left + (column + 8.5) * cellWidth,
    clientY: rect.top + (viewportRow + 0.5) * cellHeight,
    ctrlKey: true,
    buttons: 1,
    bubbles: true,
    view: window
  }))
  mouse('mouseup', { x: column + 8, y: viewportRow }, true)
  await pause(300)
  const selected = terminal.getSelection()
  const ctrlDrag = {
    selected,
    copiedSelection: selected.length > 0 && (await window.aiTerminal.readClipboardText()).text === selected,
    opened: openDialog() !== null
  }
  terminal.clearSelection()
  await window.aiTerminal.writeClipboardText(clipboardBeforeDrag.text)
  const ptyInputEvents = ptyInput

  // A program that reads the mouse keeps every click, and links stay off. SGR reports (1006), as TUIs request
  // them, reach the PTY through onData like any other input.
  await new Promise<void>((resolve) => terminal.write('\x1b[?1000h\x1b[?1006h', resolve))
  await waitFor('mouse mode on', () => (terminal.modes.mouseTrackingMode === 'none' ? undefined : true))
  const mouseModeUnderlined = hover(column + 4, true)
  click(column + 4, true)
  await pause(300)
  const mouseMode = { underlined: mouseModeUnderlined, opened: openDialog() !== null, reportsToProgram: ptyInput - ptyInputEvents }
  await new Promise<void>((resolve) => terminal.write('\x1b[?1006l\x1b[?1000l', resolve))
  inputCounter.dispose()
  // The mouse reports landed on the shell's input line; clear it the way the owner would.
  terminal.input('\x15', false)

  // Output rewrites the hovered link's row. A click that lands before xterm renders the change must not open the old
  // text; after the render the link is gone, and a reference printed in its place opens as itself.
  const rowNow = buffer.viewportY + viewportRow
  if (!buffer.getLine(rowNow)?.translateToString(true).includes(MARKER)) {
    throw new Error('file-reference integration: the printed reference moved before the redraw check')
  }
  let redrawInput = 0
  const redrawCounter = terminal.onData(() => {
    redrawInput += 1
  })
  const rewriteRow = (text: string): Promise<void> => new Promise((resolve) =>
    terminal.write(`\x1b7\x1b[${viewportRow + 1};1H\x1b[2K${text}\x1b8`, resolve))
  const nextFrames = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const underlinedBefore = hover(column + 2, true)
  await rewriteRow('FILEREF build finished')
  click(column + 2, true)
  await nextFrames()
  await pause(300)
  const staleOpened = openDialog() !== null
  const staleUnderlined = screen.classList.contains('xterm-cursor-pointer')
  await rewriteRow('FILEREF refs/src/parser.ts:7')
  await nextFrames()
  hover(column + 2, true)
  click(column + 2, true)
  const redrawDialog = await waitFor('redrawn link dialog', openDialog)
  const redrawMarked = await waitFor('redrawn marked line', () =>
    redrawDialog.querySelector('.file-reference-line')?.textContent ?? undefined)
  const redraw = {
    underlinedBefore,
    staleOpened,
    staleUnderlined,
    reference: redrawDialog.querySelector<HTMLInputElement>('input[aria-label="File reference"]')?.value ?? '',
    marked: redrawMarked,
    ptyInputEvents: 0
  }
  await closeWithEscape(redrawDialog)
  redrawCounter.dispose()
  redraw.ptyInputEvents = redrawInput

  const missingSessionCode = await window.aiTerminal
    .readFileReference({ sessionId: 'file-reference-missing-session', reference: LINK_TEXT })
    .then(() => 'accepted', (error: unknown) => (error as { code?: string } | null)?.code ?? 'untyped')

  section.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await waitFor('probe reselected', async () => {
    const layout = (await window.aiTerminal.getLayout(options.workspaceId)).layout
    return layout.selectedSessionId === options.sessionId ? true : undefined
  })
  return {
    launchDirectory,
    palette,
    shellDirectoryIgnored,
    chosenFolder: {
      pickerMessage,
      kind: chosen.base?.kind ?? 'none',
      canonicalPath: chosen.status === 'ready' ? chosen.canonicalPath : `unavailable: ${chosen.message}`
    },
    rejected,
    link,
    plainClick,
    ctrlDrag,
    missingSessionCode,
    mouseMode,
    crossWorkspace: null,
    redraw,
    ptyInputEvents,
    terminalUnchanged: terminal.cols === sizeBefore.cols && terminal.rows === sizeBefore.rows &&
      options.refitCount() === sizeBefore.refits && terminal.element === elementBefore && !!elementBefore?.isConnected,
    terminalGeometry: {
      before: `${sizeBefore.cols}x${sizeBefore.rows} refits ${sizeBefore.refits}`,
      after: `${terminal.cols}x${terminal.rows} refits ${options.refitCount()}`,
      sameElement: terminal.element === elementBefore && !!elementBefore?.isConnected
    },
    attentionUnchanged: (await openRequestTitles()) === attentionBefore
  }
}
