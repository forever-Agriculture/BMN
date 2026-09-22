import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const appDirectory = resolve('apps/desktop')
const requireFromApp = createRequire(join(appDirectory, 'package.json'))
const electronBinary = requireFromApp('electron')

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay =
  originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
    ? join(originalRuntime, originalWaylandDisplay)
    : originalWaylandDisplay

/** Receipt fields the self-test must prove; a receipt missing any of them fails the run. */
const receiptContract = [
  ['graceful', (receipt) => receipt.graceful === true],
  ['agentHandoff', (receipt) => {
    const row = receipt.agentHandoff
    return row?.preparedWithoutDelivery === true && row.destinationMatches === true && row.text === 'Synthetic agent handoff result' &&
      row.byline.includes('Prepared by the agent in Petition source') &&
      row.provenance === 'from bmn handoff' && row.resolvedBy === 'owner' &&
      row.state !== 'open' && row.resolution === 'pasted, not submitted' &&
      row.payloadOccurrences === 1 && row.agentOwnerStamp === true && row.publishedFile === true && row.bracketedPaste === true &&
      row.noSubmit === true && row.status.includes('pasted (not submitted)') && row.bounded === true
  }],
  ['openCodeAcceptance', (receipt) => {
    const row = receipt.openCodeAcceptance
    const reference = 'ses_0123456789abSyntheticTest0'
    return row?.provenance === 'from OpenCode permission.asked' &&
      row.openedBy === 'hook:opencode:permission.asked' &&
      row.resolvedBy === 'hook:opencode:permission.replied' && row.permissionState === 'answered' &&
      row.notice === true && row.binding.status === 'bound' && row.binding.agentCli === 'opencode' &&
      row.binding.captureRoute === 'hook-session-start' && row.binding.conversationReference === reference &&
      row.preview.includes('--session ' + reference) &&
      JSON.stringify(row.resumedArguments) === JSON.stringify(['--session', reference, '--model', 'fixture/model']) &&
      JSON.stringify(row.events.map(event => event.event)) ===
        JSON.stringify(['session.created', 'permission.asked', 'permission.replied', 'session.idle']) &&
      row.events.every(event => event.agent === 'opencode') &&
      row.events[1].effects.includes('opened') && row.events[2].effects.includes('answered')
  }],
  [
    'hiddenPaneSize',
    (receipt) =>
      receipt.hiddenPaneSize?.shown?.cols >= 20 &&
      receipt.hiddenPaneSize.hidden?.cols === receipt.hiddenPaneSize.shown.cols &&
      receipt.hiddenPaneSize.hidden?.rows === receipt.hiddenPaneSize.shown.rows
  ],
  ['inactiveFollowingOutputLayoutPuts', (receipt) => receipt.inactiveFollowingOutputLayoutPuts === 0],
  ['inactiveFollowingOutputCaptured', (receipt) => receipt.inactiveFollowingOutputCaptured === true],
  [
    'stoppedStaleProgress',
    (receipt) =>
      receipt.stoppedStaleProgress?.includes('Observed self-test failure') &&
      receipt.stoppedStaleProgress?.includes('Last observed failed') &&
      receipt.stoppedStaleProgress?.includes('stale') &&
      receipt.stoppedStaleProgress?.includes('self-test')
  ],
  [
    'attentionTriage',
    (receipt) =>
      receipt.attentionTriage?.totalCount === 4 &&
      receipt.attentionTriage.responseTitles?.length === 3 &&
      JSON.stringify(receipt.attentionTriage.responseTitlesAfterUpdate) ===
        JSON.stringify(receipt.attentionTriage.responseTitles) &&
      JSON.stringify(receipt.attentionTriage.remainingResponseTitles) ===
        JSON.stringify(receipt.attentionTriage.responseTitles.toSorted()) &&
      JSON.stringify(receipt.attentionTriage.updateTitles) === JSON.stringify(['Self-test turn finished']) &&
      JSON.stringify(receipt.attentionTriage.updatedUpdateTitles) === JSON.stringify(['Self-test turn revised']) &&
      receipt.attentionTriage.progressText?.includes('Observed self-test failure') &&
      receipt.attentionTriage.progressText?.includes('Last observed failed') &&
      receipt.attentionTriage.progressText?.includes('stale') &&
      receipt.attentionTriage.detailsProgressText?.includes('Observed self-test failure') &&
      receipt.attentionTriage.detailsProgressText?.includes('Last observed failed') &&
      receipt.attentionTriage.detailsProgressText?.includes('stale') &&
      typeof receipt.attentionTriage.keyboardTargetSessionId === 'string' &&
      receipt.attentionTriage.noticeResolved === true &&
      receipt.attentionTriage.focusReturned === true &&
      receipt.attentionTriage.focusStableAfterIncomingUpdate === true &&
      receipt.attentionTriage.staleNoticeRejected === true &&
      receipt.attentionTriage.revisedPromptPreserved === true &&
      receipt.attentionTriage.unavailableTargetIgnored === true
  ],
  [
    'handoffFlow',
    (receipt) =>
      typeof receipt.handoffFlow?.draftId === 'string' &&
      typeof receipt.handoffFlow.targetSessionId === 'string' &&
      receipt.handoffFlow.editedText === 'Edited handoff line one\nQuestion line two' &&
      receipt.handoffFlow.fileName === 'handoff-self-test.txt' &&
      receipt.handoffFlow.acceptedState === 'accepted' &&
      receipt.handoffFlow.existingInputPreserved === true &&
      receipt.handoffFlow.payloadOccurrences === 1 &&
      receipt.handoffFlow.attentionResponsesPreserved === true &&
      receipt.handoffFlow.discardedDraftHidden === true &&
      receipt.handoffFlow.persistedAfterRestart === true
  ],
  [
    'fileReferenceFlow',
    (receipt) =>
      receipt.fileReferenceFlow?.palette?.focusedInput === true &&
      receipt.fileReferenceFlow.palette.marked === 'FILE-REFERENCE-TARGET line 42' &&
      receipt.fileReferenceFlow.palette.copied?.endsWith('/refs/src/parser.ts:42:7') &&
      receipt.fileReferenceFlow.palette.focusReturned === true &&
      receipt.fileReferenceFlow.shownPaths?.length === 1 &&
      receipt.fileReferenceFlow.shellDirectoryIgnored?.message === 'No file exists at this path.' &&
      receipt.fileReferenceFlow.chosenFolder?.kind === 'chosen-directory' &&
      receipt.fileReferenceFlow.rejected?.inputPreserved === true &&
      receipt.fileReferenceFlow.link?.reference === 'refs/src/parser.ts:42:7' &&
      receipt.fileReferenceFlow.link.selectedElsewhere === true &&
      receipt.fileReferenceFlow.link.focusReturned === true &&
      receipt.fileReferenceFlow.plainClick?.opened === false &&
      receipt.fileReferenceFlow.ctrlDrag?.copiedSelection === true &&
      receipt.fileReferenceFlow.ctrlDrag.opened === false &&
      receipt.fileReferenceFlow.missingSessionCode === 'NOT_FOUND' &&
      receipt.fileReferenceFlow.mouseMode?.opened === false &&
      receipt.fileReferenceFlow.mouseMode.underlined === false &&
      receipt.fileReferenceFlow.mouseMode.reportsToProgram >= 1 &&
      receipt.fileReferenceFlow.redraw?.staleOpened === false &&
      receipt.fileReferenceFlow.redraw.reference === 'refs/src/parser.ts:7' &&
      receipt.fileReferenceFlow.reads?.length === 9 &&
      receipt.fileReferenceFlow.contextMenuClick?.reference === 'refs/src/parser.ts:42:7' &&
      receipt.fileReferenceFlow.crossWorkspace?.session === 'Archived running chat · Self-test archived workspace' &&
      receipt.fileReferenceFlow.ptyInputEvents === 0 &&
      receipt.fileReferenceFlow.terminalUnchanged === true &&
      receipt.fileReferenceFlow.attentionUnchanged === true
  ],
  [
    'voiceFlow',
    (receipt) =>
      receipt.voiceFlow?.suggested?.includes('SessionManager') &&
      receipt.voiceFlow.editedApproved === 'pty-host' &&
      receipt.voiceFlow.chipsShareLine === true &&
      receipt.voiceFlow.addWordRejected?.inputPreserved === true &&
      receipt.voiceFlow.addWordRejected.listUnchanged === true &&
      receipt.voiceFlow.duplicateRejected?.candidateKept === true &&
      JSON.stringify(receipt.voiceFlow.approvedAfterRemove) === JSON.stringify(['SessionManager', 'BMN']) &&
      receipt.voiceFlow.promptShown === 'SessionManager, BMN' &&
      receipt.voiceFlow.persistedInSettings === true &&
      receipt.voiceFlow.recording?.pastedOnce === true &&
      receipt.voiceFlow.recording.commandNotRun === true &&
      receipt.voiceFlow.editDuringRecording?.savedWhileRecording === true &&
      receipt.voiceFlow.restarted?.pastedIntoNewIncarnation === false &&
      receipt.voiceFlow.restarted.notice.includes('nothing was pasted') &&
      receipt.voiceFlow.transcriptions?.length === 3 &&
      JSON.stringify(receipt.voiceFlow.transcriptions[0].vocabulary) === JSON.stringify(['SessionManager', 'BMN']) &&
      receipt.voiceFlow.transcriptions[0].args.at(-2) === '--prompt' &&
      receipt.voiceFlow.transcriptions[0].args.at(-1) === 'SessionManager, BMN' &&
      JSON.stringify(receipt.voiceFlow.transcriptions[1].vocabulary) === JSON.stringify(['SessionManager', 'BMN', 'Changed']) &&
      receipt.voiceFlow.persistedAfterRestart === true
  ],
  ['launchBackgroundChoiceRecorded', (receipt) => receipt.launchBackgroundChoiceRecorded === 'hide'],
  [
    'registeredInvokeChannels',
    (receipt) =>
      Array.isArray(receipt.registeredInvokeChannels) &&
      receipt.registeredInvokeChannels.length > 0 &&
      new Set(receipt.registeredInvokeChannels).size === receipt.registeredInvokeChannels.length &&
      receipt.registeredInvokeChannels.every((channel) =>
        typeof channel === 'string' && channel.startsWith('aiterm:')
      ) &&
      JSON.stringify(receipt.registeredInvokeChannels) ===
        JSON.stringify(receipt.envelopedInvokeChannels)
  ],
  [
    'templateCreatedSession',
    (receipt) =>
      receipt.templateCreatedSession?.name === 'Template-picked shell' &&
      receipt.templateCreatedSession?.executable === '/bin/bash' &&
      JSON.stringify(receipt.templateCreatedSession?.argv) ===
        JSON.stringify(['--noprofile', '--norc']) &&
      typeof receipt.templateCreatedSession?.cwd === 'string' &&
      receipt.templateCreatedSession.cwd.length > 0 &&
      receipt.templateCreatedSession?.backgroundChoice === 'stop'
  ],
  [
    'treeSelectionLayoutPut',
    (receipt) =>
      typeof receipt.treeSelectionLayoutPut?.sessionId === 'string' &&
      receipt.treeSelectionLayoutPut.sessionId.length > 0 &&
      receipt.treeSelectionLayoutPut.layoutSelectedSessionId ===
        receipt.treeSelectionLayoutPut.sessionId
  ],
  [
    'rendererLaunchUnavailable',
    (receipt) =>
      typeof receipt.rendererLaunchUnavailable?.sessionId === 'string' &&
      receipt.rendererLaunchUnavailable.sessionId.length > 0 &&
      receipt.rendererLaunchUnavailable?.notice ===
        'Launch unavailable: Stored arguments are unavailable in the renderer boundary probe.' &&
      receipt.rendererLaunchUnavailable?.resumeDisabled === true &&
      receipt.rendererLaunchUnavailable?.resumeTitle ===
        'Stored arguments are unavailable in the renderer boundary probe.'
  ],
  [
    'rendererUnavailableTemplate',
    (receipt) =>
      receipt.rendererUnavailableTemplate?.name === 'Unavailable launch template — unavailable' &&
      receipt.rendererUnavailableTemplate?.disabled === true &&
      receipt.rendererUnavailableTemplate?.title ===
        'Stored arguments are unavailable in the renderer boundary probe.'
  ],
  [
    'rendererStoppedPanelLabel',
    (receipt) =>
      typeof receipt.rendererStoppedPanelLabel === 'string' &&
      receipt.rendererStoppedPanelLabel.startsWith('Interrupted · application quit · signal ') &&
      receipt.rendererStoppedPanelLabel.includes(' · /')
  ],
  [
    'rendererLiveExitLabel',
    (receipt) =>
      typeof receipt.rendererLiveExitLabel === 'string' &&
      receipt.rendererLiveExitLabel.startsWith('Process exited · code 23 · /')
  ],
  ['rendererLiveExitSidebarWord', (receipt) => receipt.rendererLiveExitSidebarWord === 'Process exited'],
  [
    'closePrompt',
    (receipt) =>
      receipt.closePrompt?.heading === 'Close BMN?' &&
      receipt.closePrompt?.decision === 'cancel' &&
      receipt.closePrompt?.rows?.length === 1
  ],
  ['rendererRecoveredAfterShellExit', (receipt) => receipt.rendererRecoveredAfterShellExit === true],
  [
    'rendererInverseTextContrast',
    (receipt) => typeof receipt.rendererInverseTextContrast === 'number' && receipt.rendererInverseTextContrast >= 4.5
  ],
  [
    'sessionActivity',
    (receipt) =>
      receipt.sessionActivity?.burstAfterOneSecond === 'Working' &&
      receipt.sessionActivity?.burstAfterTwoAndAHalf === 'Idle' &&
      receipt.sessionActivity?.silentEarly === 'Running' &&
      receipt.sessionActivity?.silentLate === 'Idle' &&
      receipt.sessionActivity?.silentEverWorking === false &&
      receipt.sessionActivity?.silentRunningAfterIdle === false &&
      Array.isArray(receipt.sessionActivity?.lateBeforeFirstByte) &&
      !receipt.sessionActivity.lateBeforeFirstByte.includes('Idle') &&
      receipt.sessionActivity?.lateRunningAfterOutput === false &&
      receipt.sessionActivity?.lateAfterFourSeconds === 'Idle' &&
      receipt.sessionActivity?.titledResting === 'Idle' &&
      receipt.sessionActivity?.titledRestingTitle === '\u2733 x' &&
      receipt.sessionActivity?.titledActionRequired === 'Action required' &&
      receipt.sessionActivity?.titledWhilePrinting === 'Working' &&
      Object.values(receipt.sessionActivity?.updates ?? { missing: Number.POSITIVE_INFINITY })
        .every((count) => count <= receipt.sessionActivity.updateCap) &&
      Object.values(receipt.sessionActivity?.inputEvents ?? { missing: 1 }).every((count) => count === 0) &&
      receipt.sessionActivity?.geometryUnchanged === true &&
      receipt.sessionActivity?.attentionUnchanged === true
  ],
  [
    'progressEvidence',
    (receipt) =>
      receipt.progressEvidence?.sameIdOnRetry === true &&
      receipt.progressEvidence?.state === 'verified' &&
      receipt.progressEvidence?.links?.length === 1 &&
      receipt.progressEvidence.links[0]?.name === 'checks.log' &&
      receipt.progressEvidence?.persistedAfterRestart === true &&
      JSON.stringify(receipt.progressEvidence?.outcome) === JSON.stringify([
        'accepted', 'refused-other-session', 'refused-input', 'refused-unknown', 'refused-duplicate', 'done'
      ])
  ],
  [
    'progressEvidenceSurface',
    (receipt) =>
      receipt.progressEvidenceSurface?.reportedStrip?.includes('Reported verified') === true &&
      receipt.progressEvidenceSurface.reportedStrip.includes('Evidence attached (1)') &&
      receipt.progressEvidenceSurface?.bareStrip?.includes('No evidence attached') === true &&
      receipt.progressEvidenceSurface?.dialog?.previewText?.includes('self-test: 3 checks passed') === true &&
      receipt.progressEvidenceSurface?.dialog?.rowName === 'checks.log' &&
      // Epic 5's four states stay legible, and only the muted evidence word is added beside them.
      receipt.progressEvidenceSurface?.colours?.verifiedInk ===
        receipt.progressEvidenceSurface?.colours?.verifiedToken &&
      receipt.progressEvidenceSurface?.colours?.failedInk ===
        receipt.progressEvidenceSurface?.colours?.errorToken &&
      receipt.progressEvidenceSurface?.colours?.evidenceInk ===
        receipt.progressEvidenceSurface?.colours?.mutedToken &&
      receipt.progressEvidenceSurface?.colours?.verifiedContrast >= 4.5 &&
      receipt.progressEvidenceSurface?.colours?.evidenceContrast >= 4.5 &&
      receipt.progressEvidenceSurface?.focusReturnedToStrip === true &&
      receipt.progressEvidenceSurface?.focusReturnedToMenuButton === true &&
      receipt.progressEvidenceSurface?.openedFromPaneMenu === true &&
      receipt.progressEvidenceSurface?.bareDialog?.body?.includes('No evidence attached to this report.') === true &&
      // The whole reason the detail is a dialog: no PTY write and no terminal resize.
      receipt.progressEvidenceSurface?.quiet?.inputEventsAfter ===
        receipt.progressEvidenceSurface?.quiet?.inputEventsBefore &&
      receipt.progressEvidenceSurface?.quiet?.surfaceHeightWhileOpen ===
        receipt.progressEvidenceSurface?.quiet?.surfaceHeightBefore &&
      receipt.progressEvidenceSurface?.quiet?.gridAfter?.cols ===
        receipt.progressEvidenceSurface?.quiet?.gridBefore?.cols &&
      receipt.progressEvidenceSurface?.quiet?.gridAfter?.rows ===
        receipt.progressEvidenceSurface?.quiet?.gridBefore?.rows
  ],
  [
    'requestProvenance',
    (receipt) =>
      receipt.requestProvenance?.openedBy === 'hook:claude:Notification' &&
      receipt.requestProvenance?.openedResolvedBy === null &&
      receipt.requestProvenance?.resolvedState === 'answered' &&
      receipt.requestProvenance?.resolvedBy === 'hook:claude:PostToolUse' &&
      receipt.requestProvenance?.typedResolvedBy === 'input' &&
      receipt.requestProvenance?.typedState !== 'open' &&
      JSON.stringify(receipt.requestProvenance?.hookEvents?.map((event) => event.event)) ===
        JSON.stringify(['Notification', 'PostToolUse', 'Notification']) &&
      receipt.requestProvenance?.hookEvents?.[1]?.toolName === 'Bash' &&
      Array.isArray(receipt.requestProvenance?.listedRows) &&
      receipt.requestProvenance.listedRows.some((row) => row.includes('PostToolUse · Bash')) &&
      JSON.stringify(receipt.requestProvenance?.otherSessionEvents) ===
        JSON.stringify([{ event: 'Isolation-Probe', effects: [] }]) &&
      receipt.requestProvenance?.listWroteToPty === false &&
      receipt.requestProvenance?.openRequestsUnchanged === true &&
      receipt.requestProvenance?.dialogClosed === true
  ],
  [
    'terminalNotice',
    (receipt) =>
      receipt.terminalNotice?.kind === 'notice' &&
      receipt.terminalNotice?.openedBy === 'osc:9' &&
      receipt.terminalNotice?.title === 'BMN self-test notice' &&
      receipt.terminalNotice?.provenance === 'from the terminal (OSC 9)' &&
      receipt.terminalNotice?.ptyInputEvents === 0 &&
      receipt.terminalNotice?.hookedSessionRows === 1 &&
      JSON.stringify(receipt.terminalNotice?.hookedSessionEvents?.filter((event) => event.agent === 'terminal')) ===
        JSON.stringify([{ agent: 'terminal', event: 'osc:9', effects: [] }]) &&
      receipt.terminalNotice?.resolvedBy === 'input' &&
      receipt.terminalNotice?.resolvedState !== 'open' &&
      // A second notice into a live pane: a row opened, and the terminal itself was left alone.
      receipt.terminalNotice?.aroundSecondNotice?.title === 'BMN self-test second notice' &&
      receipt.terminalNotice?.aroundSecondNotice?.openedBy === 'osc:9' &&
      receipt.terminalNotice?.aroundSecondNotice?.sameSize === true &&
      receipt.terminalNotice?.aroundSecondNotice?.sameElement === true &&
      receipt.terminalNotice?.aroundSecondNotice?.refits === 0 &&
      receipt.terminalNotice?.aroundSecondNotice?.inputEvents === 0
  ],
  [
    'conversationFromHook',
    (receipt) =>
      receipt.conversationFromHook?.startedRoute === 'unsupported' &&
      receipt.conversationFromHook?.reportedRoute === 'hook-session-start' &&
      receipt.conversationFromHook?.reportedReference === '01a0b657-21a8-7f00-addd-b73646828f5b' &&
      receipt.conversationFromHook?.reportedDetail?.startsWith('Reported by Codex at session start') &&
      receipt.conversationFromHook?.reportedDetail?.includes('not carried: --full-auto') &&
      receipt.conversationFromHook?.rivalRoute === 'unsupported' &&
      // The session's own `bmn list --json` shows its route, and only its own session.
      receipt.conversationFromHook?.listed?.sessions === 1 &&
      receipt.conversationFromHook?.listed?.conversation?.status === 'bound' &&
      receipt.conversationFromHook?.listed?.conversation?.captureRoute === 'hook-session-start' &&
      // The refused rival report left a reason the owner can read while the app is still running.
      receipt.conversationFromHook?.refusalReason?.endsWith(
        'already resumed in "Hook-reported Codex"'
      ) &&
      JSON.stringify(receipt.conversationFromHook?.launchArguments) ===
        JSON.stringify(['--model', 'gpt-6', '--full-auto']) &&
      JSON.stringify(receipt.conversationFromHook?.resumedArguments) ===
        JSON.stringify(['resume', '01a0b657-21a8-7f00-addd-b73646828f5b', '--model', 'gpt-6'])
  ],
  [
    'resumeConfirmationShownToOwner',
    (receipt) =>
      // AC4: the command the owner reads is the one that runs, and Cancel starts nothing.
      receipt.resumeConfirmationShownToOwner?.matchesSpawnedArguments === true &&
      receipt.resumeConfirmationShownToOwner?.startedNothing === true &&
      receipt.resumeConfirmationShownToOwner?.command?.includes(
        'resume 01a0b657-21a8-7f00-addd-b73646828f5b --model gpt-6'
      ) &&
      receipt.resumeConfirmationShownToOwner?.note ===
        'Not carried over from the original launch: --full-auto. codex resume does not accept them.'
  ],
  [
    'survivalTable',
    (receipt) =>
      receipt.survivalTable?.rendererCrash?.liveProcesses === 3 &&
      receipt.survivalTable.rendererCrash.incarnationRecords === 13 &&
      receipt.survivalTable.rendererCrash.openRequestsBefore > 0 &&
      receipt.survivalTable.rendererCrash.openRequestsAfter ===
        receipt.survivalTable.rendererCrash.openRequestsBefore &&
      receipt.survivalTable.quit?.recorded?.startsWith('application quit · signal ') &&
      receipt.survivalTable.quit.afterApplicationRestart === receipt.survivalTable.quit.recorded &&
      receipt.survivalTable.quit.openRequestsAfter ===
        receipt.survivalTable.rendererCrash.openRequestsAfter &&
      JSON.stringify(receipt.survivalTable.documented) ===
        JSON.stringify(['close-window-keep-sessions', 'app-crash-or-reboot', 'desktop-update'])
  ],
  [
    // Epic 17.1: one dialog after an update stop, starting nothing until the owner presses it.
    'resumeOffer',
    (receipt) =>
      receipt.resumeOffer?.heading === 'Resume what the update stopped?' &&
      receipt.resumeOffer.summary ===
        'a desktop update stopped 2 sessions. Nothing has started since.' &&
      receipt.resumeOffer.button === 'Resume 0 sessions' &&
      receipt.resumeOffer.startsUnchecked === true &&
      receipt.resumeOffer.dismissedStartedNothing === true &&
      receipt.resumeOffer.reopenedFromPalette === 2 &&
      JSON.stringify(receipt.resumeOffer.outcomes) === JSON.stringify(['Started', 'Started']) &&
      JSON.stringify(receipt.resumeOffer.argv) ===
        JSON.stringify([['--keep-going'], ['--keep-going']]) &&
      receipt.resumeOffer.askedAgain === false
  ],
  [
    // Epic 17.2: a rebuilt view keeps the program's modes, so paste stays bracketed and focus reports arrive.
    'terminalModes',
    (receipt) =>
      receipt.terminalModes?.before?.bracketedPasteMode === true &&
      receipt.terminalModes.after?.bracketedPasteMode === true &&
      receipt.terminalModes.after.sendFocusMode === true &&
      receipt.terminalModes.after.mouseTrackingMode ===
        receipt.terminalModes.before.mouseTrackingMode &&
      receipt.terminalModes.before.wraparoundMode === false &&
      receipt.terminalModes.after.wraparoundMode === false &&
      receipt.terminalModes.pasteBracketed === true &&
      receipt.terminalModes.pasteArrivedBare === false &&
      receipt.terminalModes.focusReported === true
  ],
  [
    'sessionProcessStatus',
    (receipt) =>
      receipt.sessionProcessStatus?.beforeRestart === 'live' &&
      receipt.sessionProcessStatus?.afterApplicationRestart === 'interrupted'
  ],
  [
    'applicationQuitStoppedSession',
    (receipt) =>
      receipt.applicationQuitStoppedSession?.beforeRestart?.state === 'interrupted' &&
      receipt.applicationQuitStoppedSession?.afterRestart?.state === 'interrupted' &&
      typeof receipt.applicationQuitStoppedSession?.beforeRestart?.detail === 'string' &&
      receipt.applicationQuitStoppedSession.beforeRestart.detail.startsWith(
        'application quit · signal '
      ) &&
      receipt.applicationQuitStoppedSession.afterRestart.detail ===
        receipt.applicationQuitStoppedSession.beforeRestart.detail
  ]
]

const exitCode = await withTemporaryRoot(temporaryRootContracts.electronSelfTest, async ({ roots }) => {
  const child = spawn(electronBinary, [appDirectory, '--self-test'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      // The synthetic Codex harness runs on this Node, so the self-test needs none on PATH.
      BMN_SELF_TEST_NODE: process.execPath,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    stdout += text
    process.stdout.write(text)
  })
  child.stderr.pipe(process.stderr, { end: false })
  return new Promise((resolveExit, reject) => {
    let settled = false
    let receiptSeen = false
    let receiptError
    const finish = (result, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      if (error) reject(error)
      else resolveExit(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(undefined, new Error('Electron self-test timed out after 90 seconds'))
    }, 90_000)
    child.stdout.on('data', () => {
      const receipt = stdout
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .find((value) => value?.selfTest === 'session-roundtrip')
      if (!receipt || receiptSeen || receiptError) return
      const unproven = receiptContract.filter(([, holds]) => !holds(receipt)).map(([field]) => field)
      if (unproven.length > 0) {
        receiptError = new Error(`Electron self-test receipt did not prove: ${unproven.join(', ')}`)
      } else {
        receiptSeen = true
      }
      child.kill('SIGKILL')
    })
    child.once('error', (error) => {
      finish(undefined, error)
    })
    child.once('exit', (code, signal) => {
      if (receiptError) finish(undefined, receiptError)
      else if (receiptSeen) finish(0)
      else if (signal) finish(undefined, new Error(`Electron self-test terminated by ${signal}`))
      else finish(code ?? 1)
    })
  })
})
process.exitCode = exitCode
