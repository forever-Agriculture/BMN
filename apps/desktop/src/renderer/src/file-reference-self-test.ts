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

  // macOS turns Ctrl+click into a press and a context menu, and the release may follow too. The link opens once.
  hover(column + 2, true)
  mouse('mousedown', { x: column + 2, y: viewportRow }, true)
  screen.dispatchEvent(new MouseEvent('contextmenu', {
    clientX: rect.left + (column + 2.5) * cellWidth,
    clientY: rect.top + (viewportRow + 0.5) * cellHeight,
    ctrlKey: true,
    button: 0,
    bubbles: true,
    cancelable: true,
    view: window
  }))
  mouse('mouseup', { x: column + 2, y: viewportRow }, true)
  // xterm focuses the clicked terminal on a context menu, as a real click would; the dialog returns focus there.
  const clickedTerminalFocused = document.activeElement === textarea
  const contextMenuDialog = await waitFor('context-menu link dialog', openDialog)
  await waitFor('context-menu marked line', () => contextMenuDialog.querySelector('.file-reference-line')?.textContent ?? undefined)
  const contextMenuClick = {
    reference: contextMenuDialog.querySelector<HTMLInputElement>('input[aria-label="File reference"]')?.value ?? '',
    focusReturned: false
  }
  await closeWithEscape(contextMenuDialog)
  contextMenuClick.focusReturned = clickedTerminalFocused &&
    await waitFor('context-menu focus return', () => (document.activeElement === textarea ? true : undefined))

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
  const reportsToProgram = ptyInput - ptyInputEvents
  await window.aiTerminal.writeClipboardText('OLD-CLIPBOARD-CONTENT')
  const reportsBeforeDrag = ptyInput
  mouse('mousedown', { x: column, y: viewportRow }, false)
  document.dispatchEvent(new MouseEvent('mousemove', {
    clientX: rect.left + (column + 8.5) * cellWidth,
    clientY: rect.top + (viewportRow + 0.5) * cellHeight,
    buttons: 1,
    bubbles: true,
    view: window
  }))
  mouse('mouseup', { x: column + 8, y: viewportRow }, false)
  await pause(100)
  const expectedMouseModeSelection = buffer.getLine(row)!.translateToString(true).slice(column, column + 8)
  const mouseMode = {
    underlined: mouseModeUnderlined,
    opened: openDialog() !== null,
    reportsToProgram,
    dragReportsToProgram: ptyInput - reportsBeforeDrag,
    copiedSelection: expectedMouseModeSelection.length > 0 &&
      (await window.aiTerminal.readClipboardText()).text === expectedMouseModeSelection,
    rightClickPasted: false
  }
  terminal.clearSelection()
  await window.aiTerminal.writeClipboardText(clipboardBeforeDrag.text)
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
  const attentionUnchanged = (await openRequestTitles()) === attentionBefore
  // This is intentional input, so run it after the passive file-reference and attention checks.
  await new Promise<void>((resolve) => terminal.write('\x1b[?1000h\x1b[?1006h', resolve))
  const rightClickPayload = 'MOUSE-MODE-RIGHT-CLICK-PASTE'
  await window.aiTerminal.writeClipboardText(rightClickPayload)
  let rightClickInput = ''
  const rightClickCounter = terminal.onData((data) => { rightClickInput += data })
  const rightClick = new MouseEvent('contextmenu', {
    clientX: rect.left + (column + 0.5) * cellWidth,
    clientY: rect.top + (viewportRow + 0.5) * cellHeight,
    button: 2,
    bubbles: true,
    cancelable: true,
    view: window
  })
  screen.dispatchEvent(rightClick)
  await pause(300)
  mouseMode.rightClickPasted = rightClick.defaultPrevented && rightClickInput.includes(rightClickPayload)
  rightClickCounter.dispose()
  await window.aiTerminal.writeClipboardText(clipboardBeforeDrag.text)
  await new Promise<void>((resolve) => terminal.write('\x1b[?1006l\x1b[?1000l', resolve))
  terminal.input('\x15', false)
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
    contextMenuClick,
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
    attentionUnchanged,
    epic27: null
  }
}

/** Drives the new chooser and palette through the real bridge in the isolated Electron self-test. */
export async function runEpic27FileReferenceIntegration(options: {
  sourcePane: HTMLElement
  sourceSessionId: string
  workspaceId: string
  targetPane: HTMLElement
  targetSessionId: string
  targetName: string
  targetTerminal: Terminal
}): Promise<NonNullable<FileReferenceFlowProbe['epic27']>> {
  const openFromSource = async (): Promise<HTMLDialogElement> => {
    options.sourcePane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await waitFor('source selected', async () =>
      (await window.aiTerminal.getLayout(options.workspaceId)).layout.selectedSessionId === options.sourceSessionId || undefined)
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
    }))
    const paletteInput = await waitFor('source palette', () => document.querySelector<HTMLInputElement>('.command-palette input'))
    setInputValue(paletteInput, 'Open file reference')
    await waitFor('open reference command', () => document.querySelector('#palette-file-reference[aria-selected="true"]'))
    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const dialog = await waitFor('source file dialog', openDialog)
    const referenceInput = await waitFor('source reference input', () =>
      dialog.querySelector<HTMLInputElement>('input[aria-label="File reference"]'))
    setInputValue(referenceInput, LINK_TEXT)
    referenceInput.closest('form')?.requestSubmit()
    await waitFor('source reference ready', () => dialog.querySelector('.file-reference-line'))
    return dialog
  }
  const chooseTarget = async (dialog: HTMLDialogElement): Promise<HTMLSelectElement> => {
    const chooser = await waitFor('send chooser', () => dialog.querySelector<HTMLSelectElement>('select[aria-label="Send to session"]'))
    chooser.value = options.targetSessionId
    chooser.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor('review send enabled', () => {
      const review = button(dialog, 'Review send…')
      return review.disabled ? undefined : review
    })
    return chooser
  }

  const dialog = await openFromSource()
  const chooser = await waitFor('empty send chooser', () => dialog.querySelector<HTMLSelectElement>('select[aria-label="Send to session"]'))
  const chooserDefaultEmpty = chooser.value === ''
  const chooserCrossWorkspace = [...chooser.options].some((option) => option.textContent?.includes('Self-test archived workspace')) &&
    [...chooser.options].some((option) => option.value === options.targetSessionId)
  await chooseTarget(dialog)
  button(dialog, 'Review send…').click()
  const sendPreview = await waitFor('send preview', () => dialog.querySelector<HTMLElement>('.file-reference-send-preview'))
  const previewPayload = sendPreview.querySelector('pre')?.textContent ?? ''
  const previewTarget = sendPreview.textContent ?? ''
  const previewIncarnation = sendPreview.querySelector('.mono')?.textContent ?? ''
  button(dialog, 'Paste reference').click()
  const pastedFeedback = await waitFor('paste receipt', () => {
    const error = dialog.querySelector('[role="alert"]')?.textContent?.trim()
    if (error) throw new Error(`file-reference paste rejected: ${error}`)
    const value = dialog.querySelector('.file-reference-feedback')?.textContent?.trim()
    return value?.includes('not submitted') ? value : undefined
  })
  const pastedIntoTarget = await waitFor('target input contains reference', () => {
    const buffer = options.targetTerminal.buffer.active
    const visible = Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index)?.translateToString(true) ?? '').join('')
    return visible.includes(previewPayload) ? true : undefined
  }).catch((error: unknown) => {
    const buffer = options.targetTerminal.buffer.active
    const lines = Array.from({ length: Math.min(buffer.length, 12) }, (_, offset) =>
      buffer.getLine(buffer.length - Math.min(buffer.length, 12) + offset)?.translateToString(true) ?? '')
    throw new Error(`target input assertion: ${String(error)}; payload=${JSON.stringify(previewPayload)}; tail=${JSON.stringify(lines)}`)
  })
  // Readline owns the unsubmitted input. Clear this synthetic target before later self-test commands.
  options.targetTerminal.input('\x15', false)
  await closeWithEscape(dialog)

  const focusDialog = await openFromSource()
  const focusChooser = await chooseTarget(focusDialog)
  button(focusDialog, 'Review send…').click()
  await waitFor('focus-loss preview', () => focusDialog.querySelector('.file-reference-send-preview'))
  window.dispatchEvent(new Event('blur'))
  const focusLossClearedTarget = await waitFor('focus-loss reset', () =>
    focusChooser.value === '' && !focusDialog.querySelector('.file-reference-send-preview') || undefined)
  await closeWithEscape(focusDialog)

  options.sourcePane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await waitFor('foreign search session selected', async () =>
    (await window.aiTerminal.getLayout(options.workspaceId)).layout.selectedSessionId === options.sourceSessionId || undefined)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
  }))
  const foreignPalette = await waitFor('foreign file palette', () => document.querySelector<HTMLInputElement>('.command-palette input'))
  setInputValue(foreignPalette, 'parser.ts')
  await waitFor('foreign file row', () => document.querySelector('.palette-results [data-group="Files"][aria-selected="true"]'))
  foreignPalette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const foreignDialog = await waitFor('foreign file preview', openDialog)
  await waitFor('foreign file loaded', () => foreignDialog.querySelector('.file-reference-line') ??
    foreignDialog.querySelector('.file-reference-preview'))
  const foreignSearchSession = detail(foreignDialog, 'Session')
  const foreignSearchFile = detail(foreignDialog, 'File')
  await closeWithEscape(foreignDialog)

  options.targetPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await waitFor('search session selected', async () =>
    (await window.aiTerminal.getLayout(options.workspaceId)).layout.selectedSessionId === options.targetSessionId || undefined)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
  }))
  const paletteInput = await waitFor('file search palette', () => document.querySelector<HTMLInputElement>('.command-palette input'))
  const searchStatus = (): string => document.querySelector('.palette-file-status')?.textContent?.trim() ?? ''
  const fileRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.palette-results [data-group="Files"]')]
  setInputValue(paletteInput, 'search-cap')
  const searchCapLabel = await waitFor('file search cap', () =>
    searchStatus().includes('Showing first 50') ? searchStatus() : undefined)
  const searchRows = fileRows().length
  setInputValue(paletteInput, 'bmn-excluded')
  await waitFor('skipped search trees', () => searchStatus().includes('0 found') ? true : undefined)
  const skippedRowsAbsent = fileRows().length === 0
  setInputValue(paletteInput, 'search-cap')
  await waitFor('second capped search started', () => searchStatus().includes('Searching') ? true : undefined)
  setInputValue(paletteInput, 'parser.ts')
  await waitFor('superseding file row', () => fileRows().some((row) => row.textContent?.includes('parser.ts')) ? true : undefined)
  const supersededRowsAbsent = fileRows().every((row) => !row.textContent?.includes('search-cap'))
  await waitFor('file row selected', () => document.querySelector('.palette-results [data-group="Files"][aria-selected="true"]'))
  paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const foundDialog = await waitFor('palette file preview', openDialog)
  await waitFor('palette file loaded', () => foundDialog.querySelector('.file-reference-line') ??
    foundDialog.querySelector('.file-reference-preview'))
  const openedFromSession = detail(foundDialog, 'Session')
  const openedFile = detail(foundDialog, 'File')
  await closeWithEscape(foundDialog)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
  }))
  const colonPalette = await waitFor('colon file palette', () => document.querySelector<HTMLInputElement>('.command-palette input'))
  setInputValue(colonPalette, 'a:b.ts')
  await waitFor('colon file row', () => [...document.querySelectorAll<HTMLElement>('.palette-results [data-group="Files"]')]
    .find((row) => row.textContent?.includes('a:b.ts')))
  await waitFor('colon file selected', () => document.querySelector('.palette-results [data-group="Files"][aria-selected="true"]'))
  colonPalette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const colonDialog = await waitFor('colon file preview', openDialog)
  await waitFor('colon file loaded', () => colonDialog.querySelector('.file-reference-preview'))
  const colonFile = detail(colonDialog, 'File')
  await closeWithEscape(colonDialog)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
  }))
  const numericPalette = await waitFor('numeric suffix palette', () => document.querySelector<HTMLInputElement>('.command-palette input'))
  setInputValue(numericPalette, 'report:42')
  await waitFor('numeric suffix row', () => [...document.querySelectorAll<HTMLElement>('.palette-results [data-group="Files"]')]
    .find((row) => row.textContent?.includes('report:42')))
  await waitFor('numeric suffix selected', () => document.querySelector('.palette-results [data-group="Files"][aria-selected="true"]'))
  numericPalette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const numericSuffixRejected = await waitFor('numeric suffix rejection', () =>
    !openDialog() && [...document.querySelectorAll<HTMLElement>('.feedback-notice.brief')]
      .some((notice) => notice.textContent?.includes('cannot be represented')) || undefined)
  return {
    chooserDefaultEmpty, chooserCrossWorkspace, previewPayload, previewTarget, previewIncarnation,
    pastedFeedback, pastedIntoTarget, focusLossClearedTarget, searchCapLabel, searchRows,
    skippedRowsAbsent, supersededRowsAbsent, openedFromSession, openedFile, colonFile,
    foreignSearchSession, foreignSearchFile, numericSuffixRejected
  }
}
