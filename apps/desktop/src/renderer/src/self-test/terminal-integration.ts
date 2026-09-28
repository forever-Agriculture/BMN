// MODULE: terminal-integration.ts - the renderer's behavioural self-test, run from the selected pane of a test-mode window
import { HANDOFF_OUTLINE } from '@bmn/protocol'
import type { Terminal } from '@xterm/xterm'
import { isBridgeError } from '../bridge-error'
import { splitArgv } from '../launch-template'
import type { TerminalIntegrationProbe, TerminalTestHandle } from '../test-hook'
import { openReferenceFromPane, runEpic27FileReferenceIntegration, runFileReferenceIntegration } from './file-reference-self-test'
import { runProgressEvidenceIntegration } from './progress-evidence-self-test'
import { runVoiceIntegration } from './voice-self-test'

/** Loaded by dynamic import only when the self-test asks the selected pane for its integration probe. */
export async function runTerminalIntegration(handle: TerminalTestHandle<Terminal>): Promise<TerminalIntegrationProbe> {
  console.warn('[BMN] renderer behavioural integration: started')
  const workspaces = await window.aiTerminal.listWorkspaces(true)
  const sessionsBeforeTemplate = await window.aiTerminal.listSessions(handle.startup.workspaceId)
  await window.aiTerminal.resizeTerminal(
    handle.startup.sessionId,
    handle.terminal.cols,
    handle.terminal.rows
  )
  const typedCode = (error: unknown): string => (isBridgeError(error) ? error.code : 'untyped')
  const { layout } = await window.aiTerminal.getLayout(handle.startup.workspaceId)
  const staleLayoutPut = await window.aiTerminal.putLayout({
    workspaceId: handle.startup.workspaceId,
    expectedRevision: layout.revision + 1_000,
    state: layout
  }).then(() => 'accepted', typedCode)
  const unknownSessionSavedOutput = await window.aiTerminal
    .getSavedOutput('self-test-unknown-session')
    .then(() => 'accepted', typedCode)
  console.warn('[BMN] renderer behavioural integration: bridge checks complete')
  const waitFor = async <Value,>(
    probe: () => Value | undefined | null | Promise<Value | undefined | null>
  ): Promise<Value> => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const value = await probe()
      if (value !== undefined && value !== null) return value
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('renderer behavioural integration step timed out')
  }
  const needsButton = await waitFor(() => document.querySelector<HTMLButtonElement>('.needs-you-button'))
  const totalCount = Number(needsButton.querySelector('.count')?.textContent ?? Number.NaN)
  const progressText = (await waitFor(() => {
    const text = handle.section.current?.querySelector<HTMLElement>('.progress-strip')?.textContent?.trim()
    return text?.includes('Observed self-test failure') && text.includes('Last observed failed') &&
      text.includes('stale') && text.includes('self-test')
      ? text
      : undefined
  }))
  // Epic 12.2: the other pane's session published a file and reported `verified` pointing at it.
  // Run it here, while the split still holds both original sessions and before the
  // cross-workspace split replaces that pane.
  const reportingPane = await waitFor(() => [...document.querySelectorAll<HTMLElement>(
    '.session-terminal[data-session-id]:not(.session-terminal-hidden)'
  )].find((pane) => pane.dataset.sessionId !== handle.startup.sessionId))
  const progressEvidenceSurface = await runProgressEvidenceIntegration({
    ownPane: handle.section.current!,
    reportingPane,
    terminal: handle.terminal,
    inputEvents: () => handle.inputEvents()
  })
  console.warn('[BMN] renderer behavioural integration: progress evidence detail')

  needsButton.click()
  const attentionPopover = await waitFor(() => document.querySelector<HTMLElement>('.needs-you-popover'))
  const groupTitles = (label: string): string[] => {
    const group = attentionPopover.querySelector<HTMLElement>(`.attention-group[aria-label="${label}"]`)
    if (!group) throw new Error(`attention group ${label} was not rendered`)
    return [...group.querySelectorAll<HTMLElement>('.attention-item h3')]
      .map((item) => item.textContent?.trim() ?? '')
  }
  const responseTitles = groupTitles('Needs your response')
  const updateTitles = groupTitles('Updates')
  const firstResponse = attentionPopover.querySelector<HTMLElement>('.attention-group[aria-label="Needs your response"] .attention-item')
  const firstResponseRow = {
    age: firstResponse?.querySelector('.where .age')?.textContent ?? '',
    label: firstResponse?.getAttribute('aria-label') ?? ''
  }
  const focusedResponseAction = attentionPopover.querySelector<HTMLButtonElement>(
    '.attention-group[aria-label="Needs your response"] .attention-item button.primary'
  )
  if (!focusedResponseAction) throw new Error('the response action was not rendered')
  focusedResponseAction.focus()
  console.warn('[BMN] renderer behavioural integration: attention baseline captured')
  const updatedGroups = await waitFor(() => {
    const nextUpdates = groupTitles('Updates')
    return nextUpdates.includes('Self-test turn revised')
      ? { responses: groupTitles('Needs your response'), updates: nextUpdates }
      : undefined
  })
  console.warn('[BMN] renderer behavioural integration: attention update received')
  const focusStableAfterIncomingUpdate = document.activeElement === focusedResponseAction
  attentionPopover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const focusReturned = await waitFor(() =>
    !document.querySelector('.needs-you-popover') && document.activeElement === needsButton ? true : undefined)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true, bubbles: true
  }))
  const keyboardTargetSessionId = await waitFor(async () => {
    const selected = (await window.aiTerminal.getLayout(handle.startup.workspaceId)).layout.selectedSessionId
    return selected && selected !== handle.startup.sessionId ? selected : undefined
  })
  needsButton.click()
  const reopenedPopover = await waitFor(() => document.querySelector<HTMLElement>('.needs-you-popover'))
  const updateArticle = [...reopenedPopover.querySelectorAll<HTMLElement>('.attention-item.update')]
    .find((item) => item.querySelector('h3')?.textContent?.trim() === 'Self-test turn revised')
  const openUpdate = updateArticle?.querySelector<HTMLButtonElement>('button.primary')
  if (!openUpdate) throw new Error('the informational update action was not rendered')
  openUpdate.click()
  const noticeResolved = await waitFor(async () =>
    (await window.aiTerminal.listAttention())
      .some((request) => request.title === 'Self-test turn revised' && request.state === 'open')
      ? undefined
      : true)
  const remainingResponseTitles = (await window.aiTerminal.listAttention())
    .filter((request) => request.state === 'open' && request.kind !== 'notice')
    .map((request) => request.title)
    .toSorted()
  const returnSessionButton = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
    '.session-row > button[data-session-id]'
  )].find((button) => button.dataset.sessionId === handle.startup.sessionId))
  returnSessionButton.click()
  await waitFor(async () => {
    const selected = (await window.aiTerminal.getLayout(handle.startup.workspaceId)).layout.selectedSessionId
    return selected === handle.startup.sessionId ? true : undefined
  })
  console.warn('[BMN] renderer behavioural integration: returned to source session')
  const destination = sessionsBeforeTemplate.find((session) =>
    session.sessionId !== handle.startup.sessionId && session.archivedAt === null)
  if (!destination) throw new Error('the handoff destination fixture was not available')
  const filesButton = [...(handle.section.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((button) => button.textContent?.trim() === 'Files')
  if (!filesButton) throw new Error('the Files button was not rendered')
  filesButton.click()
  const filesPanel = await waitFor(() => document.querySelector<HTMLElement>('.files-panel'))
  const prepareHandoff = await waitFor(() => [...filesPanel.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Prepare handoff'))
  prepareHandoff.click()
  const handoffForm = await waitFor(() => filesPanel.querySelector<HTMLFormElement>('.handoff-form'))
  console.warn('[BMN] renderer behavioural integration: handoff form opened')
  const destinationSelect = handoffForm.querySelector<HTMLSelectElement>('select')
  const handoffTextarea = handoffForm.querySelector<HTMLTextAreaElement>('textarea')
  const artifactChoice = [...handoffForm.querySelectorAll<HTMLLabelElement>('.handoff-files label')]
    .find((label) => label.textContent?.includes('handoff-self-test.txt'))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!destinationSelect || !handoffTextarea || !artifactChoice) {
    throw new Error('the complete handoff preparation form was not rendered')
  }
  const setControlValue = (control: HTMLSelectElement | HTMLTextAreaElement, value: string): void => {
    const prototype = control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (!setter) throw new Error('the handoff form value setter was unavailable')
    setter.call(control, value)
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }
  setControlValue(destinationSelect, destination.sessionId)
  // Story 35.2: Insert outline fills the empty box once, and is off while the box holds anything.
  const insertOutline = [...handoffForm.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Insert outline')
  if (!insertOutline) throw new Error('the Insert outline button was not rendered')
  const outlineOfferedEmpty = handoffTextarea.value === '' && !insertOutline.disabled
  insertOutline.click()
  const outlineFilled = await waitFor(() => handoffTextarea.value === HANDOFF_OUTLINE && insertOutline.disabled ? true : undefined)
  const outlineFocused = document.activeElement === handoffTextarea
  setControlValue(handoffTextarea, '')
  const outlineOfferedAgain = await waitFor(() => insertOutline.disabled ? undefined : true)
  setControlValue(handoffTextarea, 'x')
  const outlineOffAfterTyping = await waitFor(() => insertOutline.disabled ? true : undefined)
  // Spaces and line breaks are text the owner typed: the outline never replaces them.
  setControlValue(handoffTextarea, ' \n\t')
  const outlineOffForWhitespace = await waitFor(() => insertOutline.disabled ? true : undefined)
  setControlValue(handoffTextarea, '')
  await waitFor(() => insertOutline.disabled ? undefined : true)
  insertOutline.click()
  await waitFor(() => handoffTextarea.value === HANDOFF_OUTLINE ? true : undefined)
  const createdText = handoffTextarea.value.replace('Goal:', 'Goal: Synthetic handoff line one\nQuestion line two')
  setControlValue(handoffTextarea, createdText)
  const outlineFlow = {
    outlineOfferedEmpty, outlineFilled, outlineFocused, outlineOfferedAgain, outlineOffAfterTyping, outlineOffForWhitespace
  }
  artifactChoice.click()
  handoffForm.requestSubmit()
  const createdHandoff = await waitFor(async () => (await window.aiTerminal.listDrafts()).find((draft) =>
    draft.origin === 'handoff' &&
    draft.sourceSessionId === handle.startup.sessionId &&
    draft.sessionId === destination.sessionId &&
    draft.text === createdText &&
    draft.artifactIds.length === 1
  ))
  console.warn('[BMN] renderer behavioural integration: handoff saved')
  const sourceCard = await waitFor(() => [...filesPanel.querySelectorAll<HTMLElement>('.handoff-card')]
    .find((card) => card.textContent?.includes('Synthetic handoff line one')))
  const editHandoff = [...sourceCard.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit')
  if (!editHandoff) throw new Error('the saved handoff edit action was not rendered')
  editHandoff.click()
  const editForm = await waitFor(() => filesPanel.querySelector<HTMLFormElement>('.handoff-form'))
  const editTextarea = editForm.querySelector<HTMLTextAreaElement>('textarea')
  if (!editTextarea) throw new Error('the reopened handoff text was not rendered')
  const outlineOffForSavedText = [...editForm.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Insert outline')?.disabled === true
  // A saved outline handoff is edited and pasted as any other.
  const editedText = editTextarea.value.replace('Synthetic handoff line one', 'Edited handoff line one')
  setControlValue(editTextarea, editedText)
  editForm.requestSubmit()
  const editedHandoff = await waitFor(async () => (await window.aiTerminal.listDrafts()).find((draft) =>
    draft.draftId === createdHandoff.draftId &&
    draft.text === editedText &&
    draft.updatedAt !== createdHandoff.updatedAt
  ))
  console.warn('[BMN] renderer behavioural integration: handoff edited')
  const editedCard = await waitFor(() => [...filesPanel.querySelectorAll<HTMLElement>('.handoff-card')]
    .find((card) => card.textContent?.includes('Edited handoff line one')))
  const openDestination = [...editedCard.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Open destination')
  if (!openDestination) throw new Error('the handoff destination action was not rendered')
  openDestination.click()
  await waitFor(async () => {
    const selected = (await window.aiTerminal.getLayout(handle.startup.workspaceId)).layout.selectedSessionId
    return selected === destination.sessionId ? true : undefined
  })
  const destinationCard = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.handoff-card')]
    .find((card) => card.textContent?.includes('Edited handoff line one')))
  const pasteHandoff = [...destinationCard.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Paste handoff')
  if (!pasteHandoff || pasteHandoff.disabled) throw new Error('the destination paste action was unavailable')
  pasteHandoff.click()
  const acceptedHandoff = await waitFor(async () => (await window.aiTerminal.listDrafts()).find((draft) =>
    draft.draftId === editedHandoff.draftId && draft.state === 'accepted'
  ))
  console.warn('[BMN] renderer behavioural integration: handoff pasted')
  const terminalText = await waitFor(() => {
    const snapshot = window.__aitermTest?.snapshot(destination.sessionId)
    const text = snapshot?.bufferLines.join('\n') ?? ''
    return text.includes('EXISTING-HANDOFF-PREFIX') && text.includes('Edited handoff line one') && text.includes('How to check:')
      ? text
      : undefined
  })
  const payloadOccurrences = terminalText.split('Edited handoff line one').length - 1
  const remainingAfterHandoff = (await window.aiTerminal.listAttention())
    .filter((request) => request.state === 'open' && request.kind !== 'notice')
    .map((request) => request.title)
    .toSorted()
  const discardCandidate = await window.aiTerminal.saveHandoffDraft({
    sourceSessionId: handle.startup.sessionId,
    sessionId: destination.sessionId,
    text: 'Discard this handoff',
    artifactIds: []
  })
  const discardCard = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.handoff-card')]
    .find((card) => card.textContent?.includes('Discard this handoff')))
  const discardHandoff = [...discardCard.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Discard')
  if (!discardHandoff) throw new Error('the handoff discard action was not rendered')
  discardHandoff.click()
  const discardedDraftHidden = await waitFor(async () =>
    (await window.aiTerminal.listDrafts()).some((draft) => draft.draftId === discardCandidate.draftId)
      ? undefined
      : true)
  returnSessionButton.click()
  await waitFor(async () => {
    const selected = (await window.aiTerminal.getLayout(handle.startup.workspaceId)).layout.selectedSessionId
    return selected === handle.startup.sessionId ? true : undefined
  })
  const closeFiles = await waitFor(() => document.querySelector<HTMLButtonElement>('.files-close'))
  closeFiles.click()
  console.warn('[BMN] renderer behavioural integration: file references started')
  const fileReferenceFlow = await runFileReferenceIntegration({
    sessionId: handle.startup.sessionId,
    sessionName: handle.startup.name,
    workspaceId: handle.startup.workspaceId,
    terminal: handle.terminal,
    section: handle.section.current!,
    refitCount: () => handle.refitCount()
  })
  console.warn('[BMN] renderer behavioural integration: file references complete')
  const handoffFlow = {
    draftId: acceptedHandoff.draftId,
    targetSessionId: destination.sessionId,
    editedText,
    outline: { ...outlineFlow, outlineOffForSavedText, pastedWhole: terminalText.includes('Where it stands:') },
    fileName: 'handoff-self-test.txt',
    acceptedState: acceptedHandoff.state,
    existingInputPreserved: terminalText.includes('EXISTING-HANDOFF-PREFIX'),
    payloadOccurrences,
    attentionResponsesPreserved:
      JSON.stringify(remainingAfterHandoff) === JSON.stringify(remainingResponseTitles),
    discardedDraftHidden
  }
  // The inspector lives in the details panel, opened the way the owner opens it.
  const moreButton = handle.section.current?.querySelector<HTMLButtonElement>('button[data-action="more"]')
  if (!moreButton) throw new Error('the pane More button was not rendered')
  moreButton.click()
  const detailsItem = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
    '.popup-menu [role="menuitem"]'
  )].find((item) => item.textContent?.trim() === 'Session details'))
  detailsItem.click()
  console.warn('[BMN] renderer behavioural integration: details panel opened')
  const inspector = await waitFor(() => document.querySelector<HTMLElement>(
    '[aria-label="Selected session actions"]'
  ))
  const detailsProgressText = await waitFor(() => {
    const text = inspector.querySelector<HTMLElement>('.progress-strip')?.textContent?.trim()
    return text?.includes('Observed self-test failure') && text.includes('Last observed failed') &&
      text.includes('stale') && text.includes('self-test')
      ? text
      : undefined
  })
  const launchUnavailableNotice = await waitFor(() => {
    const notice = inspector.querySelector<HTMLElement>('[role="status"]')?.textContent?.trim()
    return notice?.startsWith('Launch unavailable: ') ? notice : undefined
  })
  const resumeButton = await waitFor(() => [...inspector.querySelectorAll<HTMLButtonElement>(
    'button'
  )].find((button) => button.textContent?.trim() === 'Resume'))
  const launchUnavailable = {
    sessionId: handle.startup.sessionId,
    notice: launchUnavailableNotice,
    resumeDisabled: resumeButton.disabled,
    resumeTitle: resumeButton.title
  }
  // The session form is its own panel, opened from the same pane menu.
  moreButton.click()
  const newSessionItem = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
    '.popup-menu [role="menuitem"]'
  )].find((item) => item.textContent?.trim() === 'New session in this workspace'))
  newSessionItem.click()
  console.warn('[BMN] renderer behavioural integration: new session panel opened')
  const templatePicker = await waitFor(() => document.querySelector<HTMLSelectElement>(
    'select[aria-label="Launch template"]'
  ))
  const templateOption = [...templatePicker.options]
    .find((option) => option.value.length > 0 && !option.disabled)
  const unavailableTemplateOption = [...templatePicker.options]
    .find((option) => option.value.length > 0 && option.disabled)
  const templateForm = templatePicker.closest('form')
  if (!templateOption || !unavailableTemplateOption || !templateForm) {
    throw new Error('the real available and unavailable template options were not rendered')
  }
  const input = (label: string): HTMLInputElement => {
    const element = templateForm.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (!element) throw new Error(`the template form field ${label} was not rendered`)
    return element
  }
  const unavailableTemplate = {
    name: unavailableTemplateOption.textContent?.trim() ?? '',
    disabled: unavailableTemplateOption.disabled,
    title: unavailableTemplateOption.title
  }
  const templateName = templateOption.textContent?.trim()
  if (!templateName) throw new Error('the real template option had no visible name')
  templatePicker.value = templateOption.value
  templatePicker.dispatchEvent(new Event('change', { bubbles: true }))
  await waitFor(() => input('Session name').value === templateName ? true : undefined)
  console.warn('[BMN] renderer behavioural integration: template selected')
  const expectedTemplateSession = {
    name: input('Session name').value,
    executable: input('Executable').value,
    argv: splitArgv(input('Arguments').value),
    cwd: input('Working directory').value,
    backgroundChoice: (() => {
      const value = templateForm.querySelector<HTMLSelectElement>(
        'select[aria-label="When windows close"]'
      )?.value
      return value === 'hide' || value === 'stop' ? value : null
    })()
  }
  const shownSize = { cols: handle.terminal.cols, rows: handle.terminal.rows }
  // requestSubmit is a no-op while Create waits for the repository identity read.
  await waitFor(() => templateForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === false
    ? true : undefined)
  templateForm.requestSubmit()
  console.warn('[BMN] renderer behavioural integration: template form submitted')
  const knownSessionIds = new Set(sessionsBeforeTemplate.map((session) => session.sessionId))
  const templateCreatedSession = await waitFor(async () => {
    const records = await window.aiTerminal.listSessions(handle.startup.workspaceId)
    return records.find((record) =>
      !knownSessionIds.has(record.sessionId) &&
      record.name === expectedTemplateSession.name &&
      record.executable === expectedTemplateSession.executable &&
      JSON.stringify(record.argv) === JSON.stringify(expectedTemplateSession.argv) &&
      record.cwd === expectedTemplateSession.cwd &&
      record.backgroundChoice === expectedTemplateSession.backgroundChoice
    )
  })
  console.warn('[BMN] renderer behavioural integration: template session created')
  // The new session took this pane. Let its resize observer and the resize request settle while hidden.
  await waitFor(() => handle.section.current?.classList.contains('session-terminal-hidden') ? true : undefined)
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  await new Promise<void>((resolve) => setTimeout(resolve, 250))
  const hiddenSize = { cols: handle.terminal.cols, rows: handle.terminal.rows }
  const sessionButton = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
    '.session-row > button[data-session-id]'
  )].find((button) => button.dataset.sessionId === handle.startup.sessionId))
  sessionButton.click()
  console.warn('[BMN] renderer behavioural integration: tree session selected')
  const selectedLayout = await waitFor(async () => {
    const next = await window.aiTerminal.getLayout(handle.startup.workspaceId)
    return next.layout.selectedSessionId === handle.startup.sessionId ? next.layout : undefined
  })
  const sourceWorkspace = workspaces.find((workspace) =>
    workspace.archivedAt === null && workspace.workspaceId !== handle.startup.workspaceId)
  if (!sourceWorkspace) throw new Error('the cross-workspace split fixture was not available')
  const sourceSession = (await window.aiTerminal.listSessions(sourceWorkspace.workspaceId))
    .find((record) => record.archivedAt === null)
  if (!sourceSession) throw new Error('the cross-workspace split fixture had no visible session')
  const splitButton = await waitFor(() => [...(handle.section.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((button) => button.textContent?.trim() === 'Split' || button.textContent?.trim() === 'Unsplit'))
  if (splitButton.textContent?.trim() === 'Unsplit') {
    splitButton.click()
    await waitFor(() => document.querySelector('.session-area.split') ? undefined : true)
  }
  splitButton.click()
  const crossWorkspaceChoice = await waitFor(() => document.querySelector<HTMLElement>(
    `#palette-split-${sourceSession.sessionId}`
  ))
  if (!crossWorkspaceChoice.textContent?.includes(sourceWorkspace.name)) {
    throw new Error('the split choice did not name its source workspace')
  }
  crossWorkspaceChoice.click()
  const crossWorkspaceLayout = await waitFor(async () => {
    const next = await window.aiTerminal.getLayout(handle.startup.workspaceId)
    return next.layout.split.panes.some((pane) => pane.sessionId === sourceSession.sessionId)
      ? next.layout
      : undefined
  })
  const sourcePane = await waitFor(() => document.querySelector<HTMLElement>(
    `.session-terminal[data-session-id="${sourceSession.sessionId}"]:not(.session-terminal-hidden)`
  ))
  if (!sourcePane) throw new Error('the cross-workspace terminal pane was not visible')

  // Epic 11: choose a marker for each workspace from its own menu, with a cross-workspace split
  // on screen, and watch that each pane takes its own workspace's marker and that the terminal
  // grid and the heading height do not move.
  const localPane = handle.section.current!
  const paneHeadingHeight = (pane: HTMLElement): number =>
    pane.querySelector<HTMLElement>('.pane-heading')?.getBoundingClientRect().height ?? -1
  const paneMarker = (pane: HTMLElement): string | null =>
    pane.querySelector<HTMLElement>('.pane-heading .workspace-marker')?.dataset.marker ?? null
  const sidebarMarker = (workspaceName: string): string | null =>
    document.querySelector<HTMLElement>(
      `.workspace-group[aria-label="${workspaceName}"] .workspace-row .workspace-marker`
    )?.dataset.marker ?? null
  const chooseMarker = async (workspaceName: string, label: string): Promise<void> => {
    const menuButton = await waitFor(() => document.querySelector<HTMLButtonElement>(
      `[aria-label="Actions for ${workspaceName}"]`
    ))
    menuButton.click()
    const choice = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
      '.popup-menu [role="group"][aria-label="Marker"] [role="menuitemradio"]'
    )].find((item) => item.textContent?.trim() === label))
    if (choice.getAttribute('aria-checked') !== 'false') {
      throw new Error(`the ${label} marker was already the chosen one for ${workspaceName}`)
    }
    choice.click()
  }
  const activeWorkspace = workspaces.find(
    (workspace) => workspace.workspaceId === handle.startup.workspaceId
  )
  if (!activeWorkspace) throw new Error('the active workspace was not in the startup list')
  const markersBefore = {
    localPane: paneMarker(localPane),
    foreignPane: paneMarker(sourcePane),
    grid: { cols: handle.terminal.cols, rows: handle.terminal.rows },
    localHeading: paneHeadingHeight(localPane),
    foreignHeading: paneHeadingHeight(sourcePane)
  }

  await chooseMarker(activeWorkspace.name, 'Teal')
  await waitFor(() => paneMarker(localPane) === 'teal' ? true : undefined)
  // The other workspace has chosen nothing, so its pane must still carry no marker at all.
  const foreignPaneAfterLocalChoice = paneMarker(sourcePane)

  await chooseMarker(sourceWorkspace.name, 'Rose')
  await waitFor(() => paneMarker(sourcePane) === 'rose' ? true : undefined)

  const storedMarkers = await waitFor(async () => {
    const records = await window.aiTerminal.listWorkspaces(true)
    const local = records.find((workspace) => workspace.workspaceId === activeWorkspace.workspaceId)
    const foreign = records.find((workspace) => workspace.workspaceId === sourceWorkspace.workspaceId)
    return local?.marker === 'teal' && foreign?.marker === 'rose'
      ? { local: local!, foreign: foreign! }
      : undefined
  })
  const workspaceMarkers = {
    before: markersBefore,
    foreignPaneAfterLocalChoice,
    localPane: paneMarker(localPane),
    foreignPane: paneMarker(sourcePane),
    localSidebar: sidebarMarker(activeWorkspace.name),
    foreignSidebar: sidebarMarker(sourceWorkspace.name),
    // The marker's accessible name carries the workspace, so identity does not need the hue.
    foreignPaneLabel: sourcePane
      .querySelector<HTMLElement>('.pane-heading .workspace-marker')
      ?.getAttribute('aria-label') ?? null,
    storedRevisions: {
      local: storedMarkers.local.revision - activeWorkspace.revision,
      foreign: storedMarkers.foreign.revision - sourceWorkspace.revision
    },
    grid: { cols: handle.terminal.cols, rows: handle.terminal.rows },
    localHeading: paneHeadingHeight(localPane),
    foreignHeading: paneHeadingHeight(sourcePane)
  }
  console.warn('[BMN] renderer behavioural integration: workspace markers chosen')

  fileReferenceFlow.crossWorkspace = await openReferenceFromPane({
    pane: sourcePane,
    workspaceId: handle.startup.workspaceId,
    sessionId: sourceSession.sessionId,
    reference: 'refs/src/parser.ts:42:7'
  })
  fileReferenceFlow.epic27 = await runEpic27FileReferenceIntegration({
    sourcePane,
    sourceSessionId: sourceSession.sessionId,
    workspaceId: handle.startup.workspaceId,
    targetPane: handle.section.current!,
    targetSessionId: handle.startup.sessionId,
    targetName: handle.startup.name,
    targetTerminal: handle.terminal
  })
  handle.section.current?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  const focusedLayout = await waitFor(async () => {
    const next = await window.aiTerminal.getLayout(handle.startup.workspaceId)
    return next.layout.selectedSessionId === handle.startup.sessionId ? next.layout : undefined
  })
  const workspaceMenu = await waitFor(() => document.querySelector<HTMLButtonElement>(
    `[aria-label="Actions for ${sourceWorkspace.name}"]`
  ))
  workspaceMenu.click()
  const archiveWorkspace = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
    '.popup-menu [role="menuitem"]'
  )].find((item) => item.textContent?.trim() === 'Archive workspace'))
  archiveWorkspace.click()
  const archivedWorkspace = await waitFor(async () =>
    (await window.aiTerminal.listWorkspaces(true))
      .find((workspace) => workspace.workspaceId === sourceWorkspace.workspaceId && workspace.archivedAt !== null)
  )
  const cleanedLayout = await waitFor(async () => {
    const next = await window.aiTerminal.getLayout(handle.startup.workspaceId)
    return next.layout.split.panes.some((pane) => pane.sessionId === sourceSession.sessionId)
      ? undefined
      : next.layout
  })
  // Last, because it stops and restarts the destination session and moves the tree selection.
  const voiceFlow = await runVoiceIntegration({
    sessionId: handle.startup.sessionId,
    workspaceId: handle.startup.workspaceId,
    terminal: handle.terminal,
    section: handle.section.current!,
    destination
  })
  console.warn('[BMN] renderer behavioural integration: voice complete')
  console.warn('[BMN] renderer behavioural integration: complete')
  return {
    workspaceCount: workspaces.length,
    sessionMethodSessionId: handle.startup.sessionId,
    bridgeErrorCodes: { staleLayoutPut, unknownSessionSavedOutput },
    launchUnavailable,
    unavailableTemplate,
    templateCreatedSession: {
      sessionId: templateCreatedSession.sessionId,
      name: templateCreatedSession.name,
      executable: templateCreatedSession.executable,
      argv: templateCreatedSession.argv,
      cwd: templateCreatedSession.cwd,
      backgroundChoice: templateCreatedSession.backgroundChoice
    },
    treeSelection: {
      sessionId: handle.startup.sessionId,
      layoutSelectedSessionId: selectedLayout.selectedSessionId
    },
    crossWorkspaceSplit: {
      layoutWorkspaceId: crossWorkspaceLayout.workspaceId,
      sourceWorkspaceId: sourceWorkspace.workspaceId,
      paneSessionIds: crossWorkspaceLayout.split.panes.map((pane) => pane.sessionId),
      selectedAfterFocus: focusedLayout.selectedSessionId,
      sourceWorkspaceArchived: archivedWorkspace.archivedAt !== null,
      foreignPaneRemovedAfterArchive:
        cleanedLayout.split.panes.some((pane) => pane.sessionId === sourceSession.sessionId) === false &&
        cleanedLayout.split.panes.some((pane) => pane.sessionId === handle.startup.sessionId)
    },
    workspaceMarkers,
    progressEvidenceSurface,
    hiddenPaneSize: { shown: shownSize, hidden: hiddenSize },
    handoffFlow,
    fileReferenceFlow,
    voiceFlow,
    attentionTriage: {
      responseTitles,
      responseTitlesAfterUpdate: updatedGroups.responses,
      remainingResponseTitles,
      updateTitles,
      updatedUpdateTitles: updatedGroups.updates,
      totalCount,
      progressText,
      detailsProgressText,
      keyboardTargetSessionId,
      noticeResolved,
      focusReturned,
      focusStableAfterIncomingUpdate,
      firstResponseRow
    }
  }
}
