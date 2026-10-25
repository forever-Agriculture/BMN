// MODULE: terminal-integration.ts - the renderer's behavioural self-test, run from the selected pane of a test-mode window
import { Terminal } from '@xterm/xterm'
import { isBridgeError } from '../bridge-error'
import { splitArgv } from '../launch-template'
import type { TerminalIntegrationProbe, TerminalTestHandle } from '../test-hook'
import { openReferenceFromPane, runEpic27FileReferenceIntegration, runFileReferenceIntegration } from './file-reference-self-test'
import { runQuickLookIntegration } from './quick-look-self-test'
import { runProgressEvidenceIntegration } from './progress-evidence-self-test'
import { runVoiceIntegration } from './voice-self-test'
import { redrawOnlyWrittenRows } from '../terminal-sync-update'
import { runSynchronizedRenderingProbe } from './terminal-sync-update'

/** Loaded by dynamic import only when the self-test asks the selected pane for its integration probe. */
export async function runTerminalIntegration(handle: TerminalTestHandle<Terminal>): Promise<TerminalIntegrationProbe> {
  console.warn('[BMN] renderer behavioural integration: started')
  const synchronizedRendering = await runSynchronizedRenderingProbe(
    () => new Terminal({ cols: 40, rows: 10, allowProposedApi: true }),
    redrawOnlyWrittenRows
  )
  console.warn('[BMN] synchronized DOM rendering: ' + synchronizedRendering.join(', '))
  const workspaces = await window.aiTerminal.listWorkspaces(true)
  const sessionsBeforeForm = await window.aiTerminal.listSessions(handle.startup.workspaceId)
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
  const needsButton = await waitFor(() => handle.section.current?.querySelector<HTMLButtonElement>('[data-session-requests]'))
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

  // Count and name the other pane's requests from its actual rendered card, not the store.
  const otherControl = await waitFor(() => reportingPane.querySelector<HTMLButtonElement>('[data-session-requests]'))
  for (const id of [handle.startup.sessionId, reportingPane.dataset.sessionId!]) {
    await waitFor(() => document.querySelector(`.session-row button[data-session-id="${id}"] .status-dot.needs-you`))
  }
  otherControl.click()
  const otherCard = await waitFor(() => document.querySelector<HTMLElement>('.session-request-card'))
  const otherResponseTitles = [...otherCard.querySelectorAll<HTMLElement>('.attention-item.request h3')]
    .map(item => item.textContent?.trim() ?? '')
  let totalCount = otherCard.querySelectorAll('.attention-item:not([data-cleared])').length
  otherCard.querySelector<HTMLButtonElement>('[aria-label="Close session requests"]')!.click()
  await waitFor(() => !document.querySelector('.session-request-card') ? true : undefined)
  needsButton.click()
  const attentionPopover = await waitFor(() => document.querySelector<HTMLElement>('.session-request-card'))
  const groupTitles = (label: string): string[] => [...attentionPopover.querySelectorAll<HTMLElement>(
    label === 'Updates' ? '.attention-item.update h3' : '.attention-item.request h3'
  )].map(item => item.textContent?.trim() ?? '')
  totalCount += attentionPopover.querySelectorAll('.attention-item:not([data-cleared])').length
  const responseTitles = [...groupTitles('Needs your response'), ...otherResponseTitles].sort()
  const updateTitles = groupTitles('Updates')
  const firstResponse = attentionPopover.querySelector<HTMLElement>('.attention-item.request')
  const firstResponseRow = {
    age: firstResponse?.querySelector('.where .age')?.textContent ?? '',
    label: firstResponse?.getAttribute('aria-label') ?? ''
  }
  const focusedResponseAction = attentionPopover.querySelector<HTMLButtonElement>(
    '.attention-item.request button.primary'
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
    !document.querySelector('.session-request-card') && document.activeElement === needsButton ? true : undefined)
  // Re-read the other session's rendered card after the update; cached titles cannot prove it survived.
  otherControl.click()
  const otherCardAfterUpdate = await waitFor(() => document.querySelector<HTMLElement>('.session-request-card'))
  updatedGroups.responses.push(...[...otherCardAfterUpdate.querySelectorAll<HTMLElement>('.attention-item.request h3')]
    .map(item => item.textContent?.trim() ?? ''))
  updatedGroups.responses.sort()
  otherCardAfterUpdate.querySelector<HTMLButtonElement>('[aria-label="Close session requests"]')!.click()
  await waitFor(() => !document.querySelector('.session-request-card') ? true : undefined)
  needsButton.focus()
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true, bubbles: true
  }))
  const keyboardTargetSessionId = await waitFor(async () => {
    const selected = (await window.aiTerminal.getLayout(handle.startup.workspaceId)).layout.selectedSessionId
    return selected && selected !== handle.startup.sessionId ? selected : undefined
  })
  // Explicitly select the notice's session; navigation now clears only notices (59.1).
  const noticeSessionButton = await waitFor(() => document.querySelector<HTMLButtonElement>(
    `.session-row button[data-session-id="${handle.startup.sessionId}"]`))
  noticeSessionButton.click()
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
  const destination = sessionsBeforeForm.find((session) =>
    session.sessionId !== handle.startup.sessionId && session.archivedAt === null)
  if (!destination) throw new Error('the second session fixture was not available')
  const filesButton = [...(handle.section.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((button) => button.textContent?.trim() === 'Files')
  if (!filesButton) throw new Error('the Files button was not rendered')
  filesButton.click()
  const filesPanel = await waitFor(() => document.querySelector<HTMLElement>('.files-panel'))
  // A handoff delivers itself (Story 75.5): the panel ends after the artifact cards, with no handoff section or form.
  const filesWithoutHandoffs = ![...filesPanel.querySelectorAll<HTMLElement>('h3, h4, button, form')]
    .some((element) => /handoff/i.test(element.textContent ?? '') || element.matches('.handoff-form'))
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
  console.warn('[BMN] renderer behavioural integration: Quick look started')
  const quickLookFlow = await runQuickLookIntegration({ refitCount: () => handle.refitCount() })
  console.warn('[BMN] renderer behavioural integration: Quick look complete')
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
  // An ordinary session typed into the form (Story 75.3: templates are gone); it later drives the quit, restart
  // and resume checks the template-made session carried.
  const sessionForm = await waitFor(() => document.querySelector<HTMLFormElement>('form.create-form'))
  const input = (label: string): HTMLInputElement => {
    const element = sessionForm.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (!element) throw new Error(`the session form field ${label} was not rendered`)
    return element
  }
  const type = (label: string, value: string): void => {
    const element = input(label)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const sourceCwd = sessionsBeforeForm.find((session) => session.sessionId === handle.startup.sessionId)?.cwd
  if (!sourceCwd) throw new Error('the selected session had no directory to start the form-made session in')
  type('Session name', 'Form-made shell')
  type('Executable', '/bin/bash')
  type('Arguments', '--noprofile --norc')
  type('Working directory', sourceCwd)
  const closeChoice = sessionForm.querySelector<HTMLButtonElement>('.select-opener[data-label="When windows close"]')
  if (!closeChoice) throw new Error('the session form field When windows close was not rendered')
  closeChoice.click()
  const stopChoice = await waitFor(() => document.querySelector<HTMLButtonElement>('.select-list [data-value="stop"]'))
  stopChoice.click()
  await waitFor(() => input('Session name').value === 'Form-made shell' && closeChoice.dataset.value === 'stop' ? true : undefined)
  console.warn('[BMN] renderer behavioural integration: session form filled')
  const expectedFormSession = {
    name: input('Session name').value,
    executable: input('Executable').value,
    argv: splitArgv(input('Arguments').value),
    cwd: input('Working directory').value,
    backgroundChoice: 'stop' as const
  }
  const shownSize = { cols: handle.terminal.cols, rows: handle.terminal.rows }
  // requestSubmit is a no-op while Create waits for the repository identity read.
  await waitFor(() => sessionForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === false
    ? true : undefined)
  sessionForm.requestSubmit()
  console.warn('[BMN] renderer behavioural integration: session form submitted')
  const knownSessionIds = new Set(sessionsBeforeForm.map((session) => session.sessionId))
  const formCreatedSession = await waitFor(async () => {
    const records = await window.aiTerminal.listSessions(handle.startup.workspaceId)
    return records.find((record) =>
      !knownSessionIds.has(record.sessionId) &&
      record.name === expectedFormSession.name &&
      record.executable === expectedFormSession.executable &&
      JSON.stringify(record.argv) === JSON.stringify(expectedFormSession.argv) &&
      record.cwd === expectedFormSession.cwd &&
      record.backgroundChoice === expectedFormSession.backgroundChoice
    )
  })
  console.warn('[BMN] renderer behavioural integration: form session created')
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
  if (!archiveWorkspace.disabled) throw new Error('live workspace archive was not disabled')
  let sourceWorkspaceArchiveRefused = false
  try {
    await window.aiTerminal.updateWorkspace({ workspaceId: sourceWorkspace.workspaceId,
      expectedRevision: (await window.aiTerminal.listWorkspaces(true)).find(row => row.workspaceId === sourceWorkspace.workspaceId)!.revision,
      archived: true })
  } catch (error) {
    sourceWorkspaceArchiveRefused = isBridgeError(error) && error.message.includes(sourceSession.name)
  }
  if (!sourceWorkspaceArchiveRefused) throw new Error('host did not refuse live workspace archive with the saved session name')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  // Closing the foreign pane still changes only the layout; its process remains reachable.
  const splitToggle = [...handle.section.current!.querySelectorAll<HTMLButtonElement>('.pane-actions button')]
    .find(button => button.textContent?.trim() === 'Unsplit')
  if (!splitToggle) throw new Error('the selected pane has no Split toggle')
  splitToggle.click()
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
    formCreatedSession: {
      sessionId: formCreatedSession.sessionId,
      name: formCreatedSession.name,
      executable: formCreatedSession.executable,
      argv: formCreatedSession.argv,
      cwd: formCreatedSession.cwd,
      backgroundChoice: formCreatedSession.backgroundChoice
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
      sourceWorkspaceArchiveRefused,
      foreignPaneClosed:
        cleanedLayout.split.panes.some((pane) => pane.sessionId === sourceSession.sessionId) === false &&
        cleanedLayout.split.panes.some((pane) => pane.sessionId === handle.startup.sessionId)
    },
    workspaceMarkers,
    progressEvidenceSurface,
    hiddenPaneSize: { shown: shownSize, hidden: hiddenSize },
    filesWithoutHandoffs,
    fileReferenceFlow,
    quickLookFlow,
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
