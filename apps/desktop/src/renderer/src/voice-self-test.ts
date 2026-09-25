// MODULE: voice-self-test.ts - Electron self-test of voice vocabulary: suggest, approve, add, remove, snapshot, restart, no Enter
import type { Terminal } from '@xterm/xterm'
import type { SessionRecord } from '@bmn/protocol'
import type { VoiceFlowProbe } from './voice-probe'

const FIXTURE_LINE = 'VOCAB SessionManager pty_host sk-abcdefghijklmnopqrstuvwxyz 3f2a9c1e7b0d https://example.com/x/y 2026-09-19'
const EXCLUDED = ['sk-abcdefghijklmnopqrstuvwxyz', '3f2a9c1e7b0d', 'https', 'example.com', '2026-09-19', 'VOCAB']

/** Every notice or announcement seen while waiting, so a timeout names what the app said instead. */
const seenMessages: string[] = []

async function waitFor<Value>(label: string, probe: () => Value | undefined | null | false | Promise<Value | undefined | null | false>): Promise<Value> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined && value !== null && value !== false) return value
    for (const text of [document.querySelector('.feedback-notice')?.textContent, document.querySelector('.live-announcer')?.textContent]) {
      if (text && seenMessages.at(-1) !== text) seenMessages.push(text)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`voice integration timed out: ${label} (seen: ${JSON.stringify(seenMessages.slice(-6))})`)
}

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function preferencesDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('dialog.preferences-dialog[open]')
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`voice integration: the ${label} button was not rendered`)
  return found
}

function approvedWords(dialog: ParentNode): string[] {
  return [...dialog.querySelectorAll<HTMLElement>('.voice-vocabulary-list code')].map((item) => item.textContent ?? '')
}

/** True when every approved word sits on the first chip's line, with its remove control inside the chip. */
function chipsShareLine(dialog: ParentNode): boolean {
  const chips = [...dialog.querySelectorAll<HTMLElement>('.voice-vocabulary-list > li')]
  if (chips.length < 2) return false
  const top = chips[0]!.getBoundingClientRect().top
  return chips.every((chip) => {
    const box = chip.getBoundingClientRect()
    const remove = chip.querySelector('button')?.getBoundingClientRect()
    return Math.abs(box.top - top) < 1 && !!remove && remove.left >= box.left && remove.right <= box.right
  })
}

function candidateInputs(dialog: ParentNode): HTMLInputElement[] {
  return [...dialog.querySelectorAll<HTMLInputElement>('ul[aria-label="Suggested words"] input')]
}

async function openPreferences(): Promise<HTMLDialogElement> {
  const open = document.querySelector<HTMLButtonElement>('button[aria-label="Preferences"]')
  if (!open) throw new Error('voice integration: the Preferences button was not rendered')
  open.click()
  return waitFor('preferences dialog', preferencesDialog)
}

async function closePreferences(dialog: HTMLDialogElement): Promise<void> {
  dialog.querySelector<HTMLButtonElement>('button[aria-label="Close Preferences"]')?.click()
  await waitFor('preferences closed', () => (preferencesDialog() ? undefined : true))
}

async function approveWordVia(dialog: HTMLDialogElement, word: string): Promise<void> {
  const input = dialog.querySelector<HTMLInputElement>('#preferences-voice-add-word')
  if (!input) throw new Error('voice integration: the Add word field was not rendered')
  setInputValue(input, word)
  input.closest('form')?.requestSubmit()
  await waitFor(`${word} approved`, () => approvedWords(dialog).includes(word))
}

/** Rows joined without separators: a shell input line wraps, and the marker must still be found whole. */
function bufferText(sessionId: string): string {
  return window.__aitermTest?.snapshot(sessionId).bufferLines.join('') ?? ''
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

async function selectSessionInTree(sessionId: string, workspaceId: string): Promise<void> {
  const row = document.querySelector<HTMLButtonElement>(`.session-row button[data-session-id="${sessionId}"]`)
  if (!row) throw new Error('voice integration: the session was not in the tree')
  row.click()
  await waitFor('tree selection', async () =>
    (await window.aiTerminal.getLayout(workspaceId)).layout.selectedSessionId === sessionId)
}

function visiblePane(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.session-terminal[data-session-id="${sessionId}"]:not(.session-terminal-hidden)`)
}

async function speakButton(sessionId: string): Promise<HTMLButtonElement> {
  return waitFor('speak button', () => visiblePane(sessionId)?.querySelector<HTMLButtonElement>('.speak-button:not([disabled])'))
}

/** Presses Speak, waits until the microphone records, keeps recording for a while, and returns a stop function. */
async function startRecording(sessionId: string): Promise<() => Promise<void>> {
  ;(await speakButton(sessionId)).click()
  await waitFor('recording', () => visiblePane(sessionId)?.querySelector('.speak-button[aria-pressed="true"]'))
  const startedAt = Date.now()
  return async () => {
    // The recorder refuses anything shorter than 0.3 s; the fake device needs a moment to deliver its first chunks.
    const remaining = 1_500 - (Date.now() - startedAt)
    if (remaining > 0) await pause(remaining)
    const stop = await waitFor('stop button', () => visiblePane(sessionId)?.querySelector<HTMLButtonElement>('.speak-button[aria-pressed="true"]'))
    stop.click()
  }
}

async function announced(text: string): Promise<string> {
  return waitFor(`announcement ${text}`, () => {
    const live = document.querySelector('.live-announcer')?.textContent ?? ''
    return live.includes(text) ? live : undefined
  })
}

export async function runVoiceIntegration(options: {
  sessionId: string
  workspaceId: string
  terminal: Terminal
  section: HTMLElement
  destination: SessionRecord
}): Promise<VoiceFlowProbe> {
  const { sessionId, workspaceId, destination } = options
  // The fixture goes into this pane's own buffer, where Suggest reads; the shell never sees it.
  await new Promise<void>((resolve) => options.terminal.write(`\r\n${FIXTURE_LINE}\r\n`, resolve))
  options.section.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await waitFor('probe pane selected', async () =>
    (await window.aiTerminal.getLayout(workspaceId)).layout.selectedSessionId === sessionId)

  let dialog = await openPreferences()
  buttonIn(dialog, 'Suggest from current session').click()
  const suggested = (await waitFor('suggestions', () => {
    const inputs = candidateInputs(dialog)
    return inputs.length > 0 ? inputs : undefined
  })).map((input) => input.value)
  if (EXCLUDED.some((token) => suggested.includes(token))) throw new Error(`voice integration: an excluded token was suggested: ${JSON.stringify(suggested)}`)

  const edited = candidateInputs(dialog).find((input) => input.value === 'pty_host')
  if (!edited) throw new Error(`voice integration: pty_host was not suggested: ${JSON.stringify(suggested)}`)
  setInputValue(edited, 'pty-host')
  buttonIn(edited.parentElement!, 'Approve').click()
  await waitFor('edited word approved', () => approvedWords(dialog).includes('pty-host'))
  const manager = candidateInputs(dialog).find((input) => input.value === 'SessionManager')
  if (!manager) throw new Error('voice integration: SessionManager was not suggested')
  buttonIn(manager.parentElement!, 'Approve').click()
  await waitFor('SessionManager approved', () => approvedWords(dialog).includes('SessionManager'))
  await approveWordVia(dialog, 'BMN')
  const chipsOnOneLine = chipsShareLine(dialog)

  const addInput = dialog.querySelector<HTMLInputElement>('#preferences-voice-add-word')!
  const before = approvedWords(dialog)
  setInputValue(addInput, 'a,b')
  addInput.closest('form')?.requestSubmit()
  const addMessage = await waitFor('add word error', () => dialog.querySelector('#preferences-voice-add-word-error')?.textContent)
  const addWordRejected = {
    message: addMessage,
    inputPreserved: addInput.value === 'a,b',
    listUnchanged: JSON.stringify(approvedWords(dialog)) === JSON.stringify(before)
  }

  const duplicate = candidateInputs(dialog)[0]
  if (!duplicate) throw new Error('voice integration: no candidate was left to edit')
  setInputValue(duplicate, 'bmn')
  buttonIn(duplicate.parentElement!, 'Approve').click()
  const duplicateMessage = await waitFor('duplicate error', () =>
    duplicate.parentElement?.parentElement?.querySelector('.preferences-error')?.textContent)
  const duplicateRejected = { message: duplicateMessage, candidateKept: duplicate.isConnected && duplicate.value === 'bmn' }

  dialog.querySelector<HTMLButtonElement>('button[aria-label="Remove pty-host"]')?.click()
  await waitFor('word removed', () => !approvedWords(dialog).includes('pty-host'))
  const approvedAfterRemove = approvedWords(dialog)
  const promptShown = dialog.querySelector('[data-testid="voice-vocabulary-prompt"]')?.textContent ?? ''
  const persistedInSettings = JSON.stringify((await window.aiTerminal.getSettings()).voice.vocabulary) === JSON.stringify(approvedAfterRemove)
  // Choose Small, which is not installed: recording falls back to Base and saves that choice from the latest settings.
  const smallRadio = [...dialog.querySelectorAll<HTMLInputElement>('input[name="preferences-voice-model"]')].at(1)
  if (!smallRadio) throw new Error('voice integration: the Small model radio was not rendered')
  smallRadio.click()
  const modelChosenBefore = await waitFor('small chosen', async () => {
    const chosen = (await window.aiTerminal.getSettings()).voice.model
    return chosen === 'small' ? chosen : undefined
  })
  console.warn('[BMN] renderer behavioural integration: vocabulary approved')

  // Recording 1 into the probe session starts with Preferences still open, so the same panel stays mounted while the
  // fallback saves Base; a word approved there afterwards must keep Base and belongs to the next recording.
  const stopFirst = await startRecording(sessionId)
  const fallbackSettings = await waitFor('fallback saved', async () => {
    const settings = await window.aiTerminal.getSettings()
    return settings.voice.model === 'base' ? settings.voice : undefined
  })
  await approveWordVia(dialog, 'Changed')
  const afterApproval = (await window.aiTerminal.getSettings()).voice
  const fallback = {
    modelChosenBefore,
    modelAfter: fallbackSettings.model,
    vocabularyKept: JSON.stringify(fallbackSettings.vocabulary) === JSON.stringify(approvedAfterRemove),
    modelAfterApproval: afterApproval.model
  }
  const savedWhileRecording = afterApproval.vocabulary.includes('Changed')
  await closePreferences(dialog)
  await stopFirst()
  await waitFor('first transcript pasted', () => bufferText(sessionId).includes('VOICE-PASTE-1'))
  const firstAnnounced = await announced('Transcript pasted')
  await pause(400)
  const recording = {
    pastedOnce: occurrences(bufferText(sessionId), 'VOICE-PASTE-1') >= 1,
    // Enter would run the pasted command and print its argument again on a line of its own.
    commandNotRun: occurrences(bufferText(sessionId), 'VOICE-PASTE-1') === 1,
    announced: firstAnnounced
  }

  console.warn('[BMN] renderer behavioural integration: first dictation pasted')
  const stopSecond = await startRecording(sessionId)
  await stopSecond()
  await waitFor('second transcript pasted', () => bufferText(sessionId).includes('VOICE-PASTE-2'))
  await pause(200)
  const editDuringRecording = { savedWhileRecording, secondPastedOnce: occurrences(bufferText(sessionId), 'VOICE-PASTE-2') === 1 }

  console.warn('[BMN] renderer behavioural integration: second dictation pasted')
  // Recording 3 into the destination session, which is stopped and started again before the transcript is ready.
  await selectSessionInTree(destination.sessionId, workspaceId)
  const stopThird = await startRecording(destination.sessionId)
  const more = await waitFor('destination More', () => visiblePane(destination.sessionId)?.querySelector<HTMLButtonElement>('button[data-action="more"]'))
  more.click()
  const stopItem = await waitFor('Stop session menu item', () => [...document.querySelectorAll<HTMLButtonElement>('.popup-menu [role="menuitem"]')]
    .find((item) => item.textContent?.trim() === 'Stop session…'))
  stopItem.click()
  const confirm = await waitFor('stop confirmation', () => [...document.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
    .find((item) => item.textContent?.trim() === 'Stop session'))
  confirm.click()
  const startAgain = await waitFor('Start again', () => [...document.querySelectorAll<HTMLButtonElement>('main button')]
    .find((item) => item.textContent?.trim() === 'Start again'))
  dialog = await openPreferences()
  buttonIn(dialog, 'Suggest from current session').click()
  const noLiveSessionMessage = await waitFor('no live session note', () => dialog.querySelector('.voice-vocabulary [role="status"]')?.textContent)
  await closePreferences(dialog)
  startAgain.click()
  await waitFor('destination live again', () => visiblePane(destination.sessionId)?.querySelector('.speak-button[aria-pressed="true"]'))
  await stopThird()
  const notice = await waitFor('restart notice', () => {
    const text = document.querySelector('.feedback-notice')?.textContent ?? ''
    return text.includes('restarted before the transcript was ready') ? text : undefined
  })
  await pause(400)
  const restarted = { notice, pastedIntoNewIncarnation: bufferText(destination.sessionId).includes('VOICE-PASTE-3') }
  await selectSessionInTree(sessionId, workspaceId)

  // The download flow end to end: renderer, preload and main with an in-memory transfer. Two rapid requests
  // must run one transfer, cancelling must release the slot, and a failure must stay visible until Dismiss.
  dialog = await openPreferences()
  const smallRow = await waitFor('small model row', () =>
    [...dialog.querySelectorAll('.voice-model')].find((row) => row.textContent?.includes('Small')))
  const smallButton = (label: RegExp): HTMLButtonElement | undefined =>
    [...smallRow.querySelectorAll('button')].find((button) => label.test(button.textContent ?? ''))
  const firstStart = window.aiTerminal.downloadVoiceModel('small')
  const duplicateStart = await window.aiTerminal.downloadVoiceModel('small')
  const firstStarted = (await firstStart).started
  // The refused duplicate needs the panel to refresh for the live transfer to appear; its own click is that refresh.
  ;(await waitFor('small download button', () => smallButton(/Download/))).click()
  await waitFor('small download progress', () => smallRow.querySelector('progress'))
  const progressShown = !!smallRow.querySelector('progress')
  ;(await waitFor('small cancel button', () => smallButton(/Cancel/))).click()
  await waitFor('small download released', () => smallButton(/Download/))
  const cancelledReleased = !!smallButton(/Download/) && !smallRow.querySelector('progress')
  ;(await waitFor('small download button again', () => smallButton(/Download/))).click()
  const failureText = await waitFor('small download failure', () =>
    smallRow.querySelector('.preferences-error')?.textContent ?? undefined)
  // The undismissed error owns the slot: a retry may not claim over it.
  const retryOverError = await window.aiTerminal.downloadVoiceModel('small')
  const retryRefusedWhileErrorVisible = retryOverError.started === false && !!smallRow.querySelector('.preferences-error')
  const dismissVisible = !!smallButton(/Dismiss/)
  ;(await waitFor('small dismiss button', () => smallButton(/Dismiss/))).click()
  await waitFor('small failure dismissed', () => smallButton(/Download/))
  const dismissed = !smallRow.querySelector('.preferences-error')
  // Keep the panel open past further poll beats: the dismissal must hold (this observes persistence,
  // not the response-ordering race; the deferred runner tests fence that race).
  let dismissStayedDismissed = true
  for (let beat = 0; beat < 6; beat += 1) {
    await pause(250)
    if (!smallButton(/Download/) || smallRow.querySelector('.preferences-error') || smallButton(/Dismiss/)) {
      dismissStayedDismissed = false
    }
  }
  // Downloading Small made it the choice; Base goes back for the settings the rest of the receipt reads.
  const baseRadio = [...dialog.querySelectorAll<HTMLInputElement>('input[name="preferences-voice-model"]')].at(0)
  if (!baseRadio) throw new Error('voice integration: the Base model radio was not rendered')
  baseRadio.click()
  const modelRestored = await waitFor('base restored', async () =>
    (await window.aiTerminal.getSettings()).voice.model === 'base' ? true : undefined)
  await closePreferences(dialog)
  const download = {
    firstStarted,
    duplicateRefused: duplicateStart.started === false,
    progressShown,
    cancelledReleased,
    failureText,
    retryRefusedWhileErrorVisible,
    dismissVisible,
    dismissed,
    dismissStayedDismissed,
    modelRestored
  }

  return {
    suggested,
    editedApproved: 'pty-host',
    chipsShareLine: chipsOnOneLine,
    addWordRejected,
    duplicateRejected,
    approvedAfterRemove,
    promptShown,
    persistedInSettings,
    fallback,
    recording,
    editDuringRecording,
    restarted,
    noLiveSessionMessage,
    download
  }
}
