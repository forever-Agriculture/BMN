// MODULE: self-test-receipt.mjs - what a passing `--self-test` receipt holds, for every entrypoint and platform

/**
 * Receipt phases a passing run must print. Each phase checks its own facts where it produces them and
 * throws there (Story 39.3); a key missing here means a phase was skipped, which still fails the run.
 */
export const requiredSelfTestPhases = [
  'sixelPty', 'sixelRender', 'sixelAnimation', 'sixelTwoPaneAnimation', 'sixelAlternateScreen',
  'sixelPlacement', 'sixelResize', 'sixelCapPressure', 'sixelColdView', 'shellRegression', 'sixelViewSwap',
  'modelOrigin', 'remoteAnswers', 'telegramCards', 'fullerAnswers', 'telegramCue', 'resetModes', 'cspProbe',
  'graphicsTerminfo', 'workspaceResults', 'crossWorkspaceResults', 'hookIntegration', 'harnessObservations',
  'launchSetRepository', 'checkoutPeers', 'graceful', 'quietSidebarAcceptance', 'interruptedSidebarAcceptance',
  'subagentAcceptance', 'repeatAcceptance', 'agentHandoff', 'openCodeAcceptance', 'cursorAcceptance',
  'hiddenPaneSize', 'inactiveFollowingOutputLayoutPuts', 'inactiveFollowingOutputCaptured',
  'stoppedStaleProgress', 'attentionTriage', 'handoffFlow', 'fileReferenceFlow', 'fileReferenceWire',
  'voiceFlow', 'launchBackgroundChoiceRecorded', 'registeredInvokeChannels', 'templateCreatedSession',
  'treeSelectionLayoutPut', 'rendererLaunchUnavailable', 'rendererUnavailableTemplate',
  'rendererStoppedPanelLabel', 'rendererLiveExitLabel', 'rendererLiveExitSidebarWord', 'closePrompt',
  'rendererInverseTextContrast', 'sessionActivity', 'progressEvidence', 'progressEvidenceSurface',
  'requestProvenance', 'terminalNotice', 'conversationFromHook', 'resumeConfirmationShownToOwner',
  'survivalTable', 'resumeOffer', 'terminalModes', 'applicationQuitStoppedSession'
]

/** The required phases a receipt lacks; any one fails the run. */
export const missingSelfTestPhases = (receipt) => requiredSelfTestPhases.filter((phase) => receipt?.[phase] === undefined)

/**
 * The facts a packaged or installed build is accepted on, beyond its phases. Windows has no ncurses
 * database: its self-test checks the bundled Sixel entry with the product's own reading and reports
 * the standard entry as null, never as a resolved success.
 */
export function packagedReceiptComplete(receipt, platform = process.platform) {
  return !(
    receipt.electronVersion !== '44.3.0' ||
    receipt.nativeModules?.nodePty !== true ||
    receipt.nativeModules?.betterSqlite3 !== true ||
    receipt.sixelPty?.beforeMB !== 0 || !(receipt.sixelPty?.afterMB > 0) ||
    receipt.sixelPty?.layer !== true ||
    !(receipt.sixelRender?.ownStorageMB > 0 && receipt.sixelRender?.ownLayer === true &&
      receipt.sixelRender?.otherStorageMB === 0 && receipt.sixelRender?.otherImageUnchanged === true) ||
    receipt.cspProbe?.evalRefused !== true || receipt.cspProbe?.wasmAllowed !== true ||
    receipt.graphicsTerminfo?.sixelResolved !== true ||
    receipt.graphicsTerminfo?.standardResolved !== (platform === 'win32' ? null : true) ||
    receipt.graphicsTerminfo?.initialTerm !== 'xterm-sixel-256color' ||
    receipt.graphicsTerminfo?.fallbackTerm !== 'xterm-256color' ||
    receipt.graceful !== true
  )
}
