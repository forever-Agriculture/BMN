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

/**
 * Receipt phases a passing run must print. Each phase checks its own facts where it produces them and
 * throws there (Story 39.3); a key missing here means a phase was skipped, which still fails the run.
 */
const requiredPhases = [
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
      // Hook checks in this isolated Electron run must see synthetic config paths, never the
      // owner's real Claude, Codex or OpenCode files.
      CLAUDE_CONFIG_DIR: join(roots.config, 'claude'),
      CODEX_HOME: join(roots.config, 'codex'),
      OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'),
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
      finish(undefined, new Error('Electron self-test timed out after 150 seconds'))
      // A passing run measured 88.7 s on 2026-09-27 (Epic 29 added about 1 s), too close to the old 90 s;
      // Epic 31's agent history phases add a few seconds more.
    }, 150_000)
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
      const missing = requiredPhases.filter((phase) => receipt[phase] === undefined)
      if (missing.length > 0) {
        receiptError = new Error(`Electron self-test receipt is missing phases: ${missing.join(', ')}`)
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
