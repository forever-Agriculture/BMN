// MODULE: probes.ts - DOM probes the main-process self-test runs in the application window
import type {
  BrowserWindow
} from 'electron'
import type { FileReferenceFlowProbe } from '../../renderer/src/file-reference-probe'
import type { VoiceFlowProbe } from '../../renderer/src/voice-probe'
import { terminalModeProgramInput } from './harnesses'

export interface RendererIntegrationProbe {
  workspaceCount: number
  sessionMethodSessionId: string
  bridgeErrorCodes: { staleLayoutPut: string; unknownSessionSavedOutput: string }
  launchUnavailable: {
    sessionId: string
    notice: string
    resumeDisabled: boolean
    resumeTitle: string
  }
  unavailableTemplate: { name: string; disabled: boolean; title: string }
  templateCreatedSession: {
    sessionId: string
    name: string
    executable: string
    argv: string[]
    cwd: string
    backgroundChoice: 'hide' | 'stop' | null
  }
  treeSelection: { sessionId: string; layoutSelectedSessionId: string | null }
  crossWorkspaceSplit: {
    layoutWorkspaceId: string
    sourceWorkspaceId: string
    paneSessionIds: string[]
    selectedAfterFocus: string | null
    sourceWorkspaceArchived: boolean
    foreignPaneRemovedAfterArchive: boolean
  }
  /** Epic 11: each pane's marker comes from its own workspace, and choosing one moves no geometry. */
  workspaceMarkers: {
    before: {
      localPane: string | null
      foreignPane: string | null
      grid: { cols: number; rows: number }
      localHeading: number
      foreignHeading: number
    }
    foreignPaneAfterLocalChoice: string | null
    localPane: string | null
    foreignPane: string | null
    localSidebar: string | null
    foreignSidebar: string | null
    foreignPaneLabel: string | null
    storedRevisions: { local: number; foreign: number }
    grid: { cols: number; rows: number }
    localHeading: number
    foreignHeading: number
  }
  /** Epic 12.2: the detail's words, that it wrote nothing and resized nothing, and both ways in. */
  progressEvidenceSurface: {
    reportedStrip: string
    bareStrip: string
    dialog: {
      title: string
      note: string
      provenance: string
      rowName: string
      rowAvailability: string
      previewText: string
    }
    quiet: {
      inputEventsBefore: number
      inputEventsAfter: number
      surfaceHeightBefore: number
      surfaceHeightWhileOpen: number
      surfaceHeightAfter: number
      gridBefore: { cols: number; rows: number }
      gridAfter: { cols: number; rows: number }
    }
    colours: {
      verifiedInk: string
      verifiedToken: string
      failedInk: string
      errorToken: string
      evidenceInk: string
      mutedToken: string
      verifiedContrast: number
      evidenceContrast: number
    }
    focusReturnedToStrip: boolean
    focusReturnedToMenuButton: boolean
    openedFromPaneMenu: boolean
    bareDialog: { title: string; body: string }
  }
  hiddenPaneSize: { shown: { cols: number; rows: number }; hidden: { cols: number; rows: number } }
  attentionTriage: {
    responseTitles: string[]
    responseTitlesAfterUpdate: string[]
    remainingResponseTitles: string[]
    updateTitles: string[]
    updatedUpdateTitles: string[]
    totalCount: number
    progressText: string
    detailsProgressText: string
    keyboardTargetSessionId: string
    noticeResolved: boolean
    focusReturned: boolean
    focusStableAfterIncomingUpdate: boolean
    firstResponseRow: { age: string; label: string }
    staleNoticeRejected?: boolean
    revisedPromptPreserved?: boolean
    unavailableTargetIgnored?: boolean
  }
  handoffFlow: {
    draftId: string
    targetSessionId: string
    editedText: string
    /** Story 35.2: Insert outline offered on an empty box, off once it holds text, and the outline pasted whole. */
    outline: Record<'outlineOfferedEmpty' | 'outlineFilled' | 'outlineFocused' | 'outlineOfferedAgain' | 'outlineOffAfterTyping' |
      'outlineOffForWhitespace' | 'outlineOffForSavedText' | 'pastedWhole', boolean>
    fileName: string
    acceptedState: string
    existingInputPreserved: boolean
    payloadOccurrences: number
    attentionResponsesPreserved: boolean
    discardedDraftHidden: boolean
  }
  fileReferenceFlow: FileReferenceFlowProbe
  voiceFlow: VoiceFlowProbe
}

export async function stoppedPanelLabel(window: BrowserWindow, sessionId: string): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      let selected = false;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(sessionId)});
        if (!button) {
          reject(new Error('the stopped session tree button was not rendered'));
          return;
        }
        if (!selected) {
          selected = true;
          button.click();
        }
        const label = document.querySelector('.stopped-session p')?.textContent?.trim();
        if (label) resolve(label);
        else if (Date.now() >= deadline) reject(new Error('the stopped session label was not rendered: ' + JSON.stringify({
          selected,
          panel: document.querySelector('.stopped-session')?.textContent?.trim() ?? null,
          feedback: document.querySelector('.feedback-notice')?.textContent?.trim() ?? null,
          visiblePanes: [...document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)')]
            .map((pane) => pane.getAttribute('data-session-id'))
        })));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

export async function stoppedPanelProgress(window: BrowserWindow, sessionId: string): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      let selected = false;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(sessionId)});
        if (!button) {
          reject(new Error('the stopped progress session tree button was not rendered'));
          return;
        }
        if (!selected) {
          selected = true;
          button.click();
        }
        const text = document.querySelector('.stopped-session .progress-strip')?.textContent?.trim();
        if (text) resolve(text);
        else if (Date.now() >= deadline) reject(new Error('the stopped progress summary was not rendered'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

/**
 * Ends a live pane's shell with `exit 23` and returns that pane's header once it stops reading
 * `Running`, so the caller compares the rendered live-exit wording exactly.
 */
export async function liveExitPaneLabel(
  window: BrowserWindow,
  live: { attachmentId: string; name: string }
): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const selector = ${JSON.stringify(`section.session-terminal[aria-label="${live.name} terminal"] header .pane-status`)};
      let exitRequested = false;
      const probe = () => {
        const label = document.querySelector(selector)?.textContent?.trim();
        if (label && !exitRequested) {
          exitRequested = true;
          // Every live pane activated when it mounted, so the attachment already carries input both ways.
          window.aiTerminal.sendTerminalInput(
            ${JSON.stringify(live.attachmentId)},
            new TextEncoder().encode(${JSON.stringify('exit 23\r')})
          );
        }
        // A live pane now says what it observes (Running, Working, Idle); only the exit ends this wait.
        if (label && (label.startsWith('Process exited') || label.startsWith('Interrupted'))) resolve(label);
        else if (Date.now() >= deadline) reject(new Error('the live pane header did not show the exit: ' + label));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

/**
 * Prints reverse-video text in a live pane and returns the WCAG contrast ratio the renderer painted it with.
 * xterm.js 6.0.0 checks minimum contrast for default-colored inverse cells against the normal foreground, which
 * paints that text almost the color of its own background; bash highlights pasted text this way.
 */
export async function inverseTextContrast(
  window: BrowserWindow,
  live: { sessionId: string; attachmentId: string; name: string }
): Promise<number> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const paneSelector = ${JSON.stringify(`section.session-terminal[aria-label="${live.name} terminal"]`)};
      const luminance = (css) => {
        const channels = css.slice(css.indexOf('(') + 1, css.indexOf(')')).split(',').slice(0, 3).map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      let selected = false;
      let printed = false;
      const probe = () => {
        const pane = document.querySelector(paneSelector);
        if (!selected) {
          const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
            .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(live.sessionId)});
          if (button) {
            selected = true;
            button.click();
          }
        }
        // A pane that is not selected is laid out at one pixel and renders a single row.
        const shown = pane && !pane.classList.contains('session-terminal-hidden') && pane.querySelector('.xterm-rows')?.children.length > 1;
        if (shown && !printed) {
          printed = true;
          // Selecting the session in the tree already made its attachment the active one.
          window.aiTerminal.sendTerminalInput(
            ${JSON.stringify(live.attachmentId)},
            new TextEncoder().encode(${JSON.stringify("printf '\\033[7m%s\\033[0m\\n' INVERSE-PROBE\r")})
          );
        }
        const span = shown && [...pane.querySelectorAll('.xterm-rows span')].find((item) => item.textContent === 'INVERSE-PROBE');
        if (span) {
          const style = getComputedStyle(span);
          const [lighter, darker] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
          resolve((lighter + 0.05) / (darker + 0.05));
        } else if (Date.now() >= deadline) {
          reject(new Error('the live pane did not render reverse-video output: ' + JSON.stringify({ selected, shown: !!shown, rows: pane?.querySelector('.xterm-rows')?.textContent?.slice(-300) })));
        } else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<number>
}

/**
 * Waits for a recovered startup to replace an exited session's pane (a failed recovery leaves the pane
 * mounted), then selects that session in the rendered tree and returns its stopped-panel label.
 */
/**
 * The word the sidebar row shows for a session, once it stops saying `Running`. The pane heading and
 * the row read the same process from different state, and only the row went stale when a process
 * ended on its own.
 */
export async function sidebarSessionWord(
  window: BrowserWindow,
  session: { sessionId: string }
): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(session.sessionId)});
        const word = button?.querySelector('.session-state')?.textContent?.trim();
        if (word && word !== 'Running' && word !== 'Working' && word !== 'Idle') resolve(word);
        else if (Date.now() >= deadline) reject(new Error('the sidebar row still reads ' + word + ' for an ended process'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

/**
 * Reads the in-app close question the way the owner meets it, then cancels it. Returns what the
 * dialog said, so the self-test can prove the window -- not a native box -- asked, and that the
 * answer travelled back.
 */
export async function closePromptDialogText(window: BrowserWindow): Promise<{
  heading: string
  summary: string
  rows: string[]
}> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const dialog = document.querySelector('dialog.close-sessions[open]');
        if (dialog) {
          const read = {
            heading: dialog.querySelector('.app-dialog-heading h2')?.textContent?.trim() ?? '',
            summary: dialog.querySelector('.close-sessions-summary')?.textContent?.trim() ?? '',
            rows: [...dialog.querySelectorAll('.close-sessions-list li')].map((row) => row.textContent.trim())
          };
          const cancel = [...dialog.querySelectorAll('.dialog-actions button')]
            .find((button) => button.textContent.trim() === 'Cancel');
          if (!cancel) { reject(new Error('the close prompt has no Cancel')); return; }
          cancel.click();
          resolve(read);
        } else if (Date.now() >= deadline) reject(new Error('the window never showed the close prompt'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<{ heading: string; summary: string; rows: string[] }>
}

/** What the resume-after-stop offer says, without answering it. */
export interface ResumeOfferReading {
  heading: string
  summary: string
  rows: Array<{ name: string; command: string; checked: boolean; outcome: string }>
  button: string
}

export const RESUME_OFFER_READER = `(dialog) => ({
  heading: dialog.querySelector('.app-dialog-heading h2')?.textContent?.trim() ?? '',
  summary: dialog.querySelector('.resume-interrupted-summary')?.textContent?.trim() ?? '',
  rows: [...dialog.querySelectorAll('.resume-interrupted-list li')].map((row) => ({
    name: row.querySelector('.name')?.textContent?.trim() ?? '',
    command: row.querySelector('.command code')?.textContent?.trim() ?? '',
    checked: row.querySelector('input[type=checkbox]')?.checked === true,
    outcome: row.querySelector('.outcome')?.textContent?.trim() ?? ''
  })),
  button: [...dialog.querySelectorAll('.dialog-actions button')]
    .map((button) => button.textContent.trim())
    .find((label) => label.startsWith('Resume ')) ?? ''
})`

export async function resumeOfferShown(
  window: BrowserWindow,
  timeoutMs = 10_000
): Promise<ResumeOfferReading> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${timeoutMs};
      const read = ${RESUME_OFFER_READER};
      const probe = () => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (dialog) resolve(read(dialog));
        else if (Date.now() >= deadline) reject(new Error('the window never offered to resume the stopped sessions'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<ResumeOfferReading>
}

/** True when the offer stays away for the whole window; used where asking again would be wrong. */
export async function resumeOfferStaysAway(window: BrowserWindow, forMs: number): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + ${forMs};
      const probe = () => {
        if (document.querySelector('dialog.resume-interrupted[open]')) resolve(false);
        else if (Date.now() >= deadline) resolve(true);
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<boolean>
}

/** Presses the offer's one button and reads every row back once the action has settled. */
export async function pressResumeOffer(window: BrowserWindow): Promise<ResumeOfferReading> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const read = ${RESUME_OFFER_READER};
      let pressed = false;
      const probe = () => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (!dialog) {
          if (Date.now() >= deadline) reject(new Error('the resume offer closed before it was answered'));
          else setTimeout(probe, 25);
          return;
        }
        const button = [...dialog.querySelectorAll('.dialog-actions button')]
          .find((candidate) => candidate.textContent.trim().startsWith('Resume '));
        if (!pressed) {
          if (!button) { reject(new Error('the resume offer has no button')); return; }
          pressed = true;
          button.click();
          setTimeout(probe, 25);
          return;
        }
        const current = read(dialog);
        if (current.rows.every((row) => row.outcome !== '')) { resolve(current); return; }
        if (Date.now() >= deadline) reject(new Error('the resume offer never reported its rows: ' + JSON.stringify(current)));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<ResumeOfferReading>
}

/** Closes the offer the way the owner would, and says whether it went. */
export async function closeResumeOffer(window: BrowserWindow): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      let clicked = false;
      const probe = () => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (!dialog) { resolve(clicked); return; }
        if (!clicked) {
          const close = [...dialog.querySelectorAll('.dialog-actions button')]
            .find((candidate) => ['Cancel', 'Close'].includes(candidate.textContent.trim()));
          if (!close) { reject(new Error('the resume offer has no way out')); return; }
          clicked = true;
          close.click();
        }
        if (Date.now() >= deadline) reject(new Error('the resume offer would not close'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<boolean>
}

/**
 * Runs one palette command by its label, the way the owner reaches it. A command the palette does
 * not offer — `filterCommands` drops a disabled one — comes back as `missing`, with the palette
 * closed again, so a test can assert either outcome.
 */
export async function runPaletteCommand(
  window: BrowserWindow,
  label: string
): Promise<'ran' | 'missing'> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const settleMs = 1500;
      let opened = 0;
      const probe = () => {
        const palette = document.querySelector('dialog.command-palette[open]');
        if (!palette) {
          if (opened > 0) { resolve('missing'); return; }
          const paletteButton = document.querySelector('button[aria-label="Command palette"]');
          if (!paletteButton) { reject(new Error('the palette button is not rendered')); return; }
          opened = Date.now();
          paletteButton.click();
          setTimeout(probe, 25);
          return;
        }
        const option = [...palette.querySelectorAll('li[role=option]')]
          .find((candidate) => candidate.textContent.trim().startsWith(${JSON.stringify(label)}));
        if (option) { option.click(); resolve('ran'); return; }
        if (Date.now() - opened >= settleMs) {
          palette.dispatchEvent(new Event('cancel', { cancelable: true }));
          const close = palette.querySelector('.app-dialog-heading .icon-button');
          if (close) close.click();
          setTimeout(() => resolve('missing'), 25);
          return;
        }
        setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<'ran' | 'missing'>
}

/** The text a paste must carry into the program, chosen so it cannot appear in ordinary output. */
export const MODE_PASTE_TEXT = 'MODE-PASTE-PAYLOAD'

/** What one pane's view believes the program's modes are, read from the view itself. */
export async function terminalViewModes(
  window: BrowserWindow,
  sessionId: string,
  waitForThem: boolean
): Promise<{
  bracketedPasteMode: boolean
  sendFocusMode: boolean
  mouseTrackingMode: string
  wraparoundMode: boolean
}> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const hook = window.__aitermTest;
        let modes;
        try { modes = hook?.snapshot(${JSON.stringify(sessionId)})?.modes; } catch { modes = undefined; }
        const settled = modes && (!${waitForThem ? 'true' : 'false'} ||
          (modes.bracketedPasteMode && modes.sendFocusMode && modes.mouseTrackingMode !== 'none' &&
            !modes.wraparoundMode));
        if (settled) { resolve(modes); return; }
        if (Date.now() >= deadline) {
          if (modes) resolve(modes);
          else reject(new Error('the mode session has no view to read'));
          return;
        }
        setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<{
    bracketedPasteMode: boolean
    sendFocusMode: boolean
    mouseTrackingMode: string
    wraparoundMode: boolean
  }>
}

/**
 * Drives the two things the modes change: one paste through the app's own clipboard command, and
 * one focus change on the pane. Both go the way the owner's keyboard and mouse would.
 */
export async function driveModeSensitiveInput(
  window: BrowserWindow,
  sessionId: string,
  text: string
): Promise<{ clipboard: string; ptyWrites: number; notice: string }> {
  return window.webContents.executeJavaScript(`
    (async () => {
      const wait = async (probe, what) => {
        const deadline = Date.now() + 8000;
        for (;;) {
          const value = probe();
          if (value) return value;
          if (Date.now() >= deadline) throw new Error('terminal modes: ' + what);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const row = await wait(
        () => [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(sessionId)}),
        'the session row'
      );
      row.click();
      // The paste must land in this program's pane, not whichever pane happens to be first.
      const pane = await wait(
        () => document.querySelector('.session-terminal[data-session-id=' +
          JSON.stringify(${JSON.stringify(sessionId)}) + ']:not(.session-terminal-hidden)'),
        'the mode session pane'
      );
      const textarea = await wait(
        () => pane.querySelector('.terminal-surface .xterm-helper-textarea'),
        'the terminal textarea'
      );
      await window.aiTerminal.writeClipboardText(${JSON.stringify(text)});
      const clipboard = (await window.aiTerminal.readClipboardText()).text;
      const inputsBefore = window.__aitermTest.snapshot(${JSON.stringify(sessionId)}).inputEvents;
      textarea.focus();
      // Ctrl+V is the app's own paste command; xterm brackets it only if the program asked it to.
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true
      }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      // One focus change: out and back, so the program sees a report whichever way it started.
      // The self-test window is never shown, so Chromium gives it no focus of its own and moving the
      // caret raises no focus event; the events are raised here instead, on the same textarea and
      // through the same listeners the owner's click would reach.
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent('blur'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      textarea.focus();
      textarea.dispatchEvent(new FocusEvent('focus'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return {
        clipboard,
        ptyWrites: window.__aitermTest.snapshot(${JSON.stringify(sessionId)}).inputEvents - inputsBefore,
        notice: document.querySelector('.app-notice, .app-failure')?.textContent?.trim() ?? ''
      };
    })()
  `) as Promise<{ clipboard: string; ptyWrites: number; notice: string }>
}

export async function untilModeProgramRead(input: string, before: string): Promise<string> {
  const deadline = Date.now() + 8_000
  let latest = before
  while (Date.now() < deadline) {
    latest = terminalModeProgramInput(input)
    if (latest.length > before.length) return latest.slice(before.length)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return latest.slice(before.length)
}

export async function recoveredStoppedLabel(
  window: BrowserWindow,
  stopped: { sessionId: string; name: string }
): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const pane = ${JSON.stringify(`section.session-terminal[aria-label="${stopped.name} terminal"]`)};
      let selected = false;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(stopped.sessionId)});
        if (!selected && button && !document.querySelector(pane)) {
          selected = true;
          button.click();
        }
        const panel = document.querySelector('.stopped-session');
        if (selected && panel?.querySelector('h2')?.textContent === ${JSON.stringify(stopped.name)}) {
          resolve(panel.querySelector('p')?.textContent?.trim() ?? '');
        } else if (Date.now() >= deadline) {
          const notice = document.querySelector('.feedback-notice')?.textContent ?? '';
          reject(new Error('the recovered workspace did not show the stopped session: ' + notice));
        } else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

export async function waitForRendererIntegration(window: BrowserWindow): Promise<RendererIntegrationProbe> {
  const rendererProbe = window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const probe = () => {
        const integration = window.__aitermTest?.integration;
        if (integration) integration().then(resolve, reject);
        else if (Date.now() >= deadline) reject(new Error('renderer integration hook timed out'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<RendererIntegrationProbe>
  return Promise.race([
    rendererProbe,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('renderer integration main-process timeout')), 60_000))
  ])
}

export function waitForRendererLoad(window: BrowserWindow): Promise<void> {
  return new Promise((resolveLoad, reject) => {
    const timer = setTimeout(
      () => reject(new Error('renderer did-finish-load timed out')),
      5_000
    )
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolveLoad()
    })
  })
}

export async function waitForRendererHook(window: BrowserWindow): Promise<void> {
  try {
    await Promise.race([
      window.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const probe = () => {
            if (window.__aitermTest?.snapshot) resolve(true);
            else if (Date.now() >= deadline) reject(new Error('recovered renderer hook timed out'));
            else setTimeout(probe, 25);
          };
          probe();
        })
      `),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('recovered renderer hook main-process timeout')), 11_000))
    ])
  } catch (error) {
    const diagnostics = await window.webContents.executeJavaScript(`({
      hasBridge: !!window.aiTerminal,
      hasHook: !!window.__aitermTest,
      body: document.body.innerText.slice(0, 500)
    })`)
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${detail}; diagnostics ${JSON.stringify(diagnostics)}`, { cause: error })
  }
}

