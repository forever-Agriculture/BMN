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
  ['rendererRecoveredAfterShellExit', (receipt) => receipt.rendererRecoveredAfterShellExit === true],
  [
    'rendererInverseTextContrast',
    (receipt) => typeof receipt.rendererInverseTextContrast === 'number' && receipt.rendererInverseTextContrast >= 4.5
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
