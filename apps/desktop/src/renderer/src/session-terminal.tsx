// MODULE: session-terminal.tsx - one live terminal pane: heading, progress strip, search, xterm surface and input footer
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type {
  ColorModeName,
  SessionRecord,
  TerminalExitMessage,
  TerminalOutputMessage,
  TerminalViewDisconnectReason,
  VoiceSettings
} from '@bmn/protocol'
import { failureDetail, isBridgeError } from './bridge-error'
import { Icon } from './icons'
import { SHORTCUT_LABELS } from './keymap'
import type { ProgressPresentation } from './session-presentation'
import { agentTag } from './session-presentation'
import { installTerminalTestHook } from './test-hook'
import { liveTerminalOptions, startSavedOutputCapture } from './terminal-history'
import { copyableText, createMouseClipboard } from './terminal-clipboard'
import { TerminalOutputFlow } from './terminal-output-flow'
import { applyTerminalExit } from './terminal-exit'
import { createFocusReports } from './terminal-focus-reports'
import { trackTerminalView } from './terminal-view-tracking'
import { searchStatusText } from './terminal-view'
import { TERMINAL_THEMES } from './theme'
import type { SessionView, SessionViewUpdate } from './workspace-layout'

type ApplicationRendererStartup = Parameters<Parameters<Window['aiTerminal']['onStartup']>[0]>[0]
export type SuccessfulStartup = Extract<ApplicationRendererStartup, { ok: true }>
export type LiveStartup = SuccessfulStartup['liveSessions'][number]

/** One dictation in flight; the model and language are fixed when recording starts. */
export interface VoiceCapture extends Pick<VoiceSettings, 'model' | 'language'> {
  sessionId: string
  phase: 'starting' | 'recording' | 'transcribing'
  startedAt: number
  /** `hold` records while Space is held and stops on release; `toggle` stops on the next Speak press. */
  trigger: 'hold' | 'toggle'
}

export interface TerminalController {
  output(message: TerminalOutputMessage): void
  exit(message: TerminalExitMessage): void
  disconnect(reason: TerminalViewDisconnectReason): void
  capture(): Promise<void>
  scrollToBottom(): void
  selection(): string
  /** xterm applies bracketed paste when the program asked for it; nothing appends Enter. */
  paste(text: string): void
  /** Sends text as if typed on the keyboard, for a key the app held back. */
  type(text: string): void
  selectAll(): void
  openSearch(): void
  focus(): void
}

export function SessionTerminal(props: {
  startup: LiveStartup
  record: SessionRecord | undefined
  visible: boolean
  selected: boolean
  order: number
  ratio: number
  split: boolean
  focusMode: boolean
  filesOpen: boolean
  needsYou: boolean
  /** The owner typed, pasted or dictated into the pane while it needs them. */
  onAnswer(): void
  armed: boolean
  progress: ProgressPresentation | null
  colorMode: ColorModeName
  fontSize: number
  /** Reads the session's persisted view from its own workspace's desired layout. */
  view(): SessionView
  testMode: boolean
  register(sessionId: string, controller: TerminalController | undefined): void
  onView(update: SessionViewUpdate): void
  onFailure(message: string): void
  onSelect(): void
  onSplit(): void
  onFocusMode(): void
  onFiles(): void
  onMore(anchor: HTMLElement): void
  onAttach(): void
  onPasteImage(): void
  /** Right-click pastes the clipboard, the way the paste shortcut does. */
  onPaste(): void
  /** Dictation for this pane, or null when it is not recording. */
  voice: VoiceCapture | null
  /** Another pane is recording or transcribing. */
  voiceBusy: boolean
  onSpeak(): void
  onDropFiles(files: File[]): void
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  const section = useRef<HTMLElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const refit = useRef<() => void>(() => undefined)
  const searchAddon = useRef<SearchAddon>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const startup = useRef(props.startup)
  const view = useRef(props.view)
  const visible = useRef(props.visible)
  const onView = useRef(props.onView)
  const onFailure = useRef(props.onFailure)
  const onPaste = useRef(props.onPaste)
  const needsYou = useRef(props.needsYou)
  const onAnswer = useRef(props.onAnswer)
  const activated = useRef(false)
  /** The presented exit status; undefined while the process is running. */
  const [exitStatus, setExitStatus] = useState<string>()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const [dropTarget, setDropTarget] = useState(false)

  startup.current = props.startup
  view.current = props.view
  visible.current = props.visible
  onView.current = props.onView
  onFailure.current = props.onFailure
  onPaste.current = props.onPaste
  needsYou.current = props.needsYou
  onAnswer.current = props.onAnswer

  useEffect(() => {
    const container = element.current
    if (!container) return
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: false,
      cursorStyle: 'bar',
      fontFamily: 'JetBrainsMono Nerd Font, JetBrains Mono, monospace',
      fontSize: props.fontSize,
      // Matches agterm's 11-point JetBrains Mono with adjust-cell-height = 12%.
      lineHeight: 1.12,
      // agterm uses minimum-contrast = 1.1, but xterm.js 6.0.0 checks default-colored reverse-video cells against the
      // normal foreground and repaints them near their own background, hiding text bash highlights (pasted input).
      minimumContrastRatio: 1,
      ...liveTerminalOptions(),
      theme: TERMINAL_THEMES[props.colorMode]
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    const search = new SearchAddon()
    searchAddon.current = search
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.open(container)
    const flow = new TerminalOutputFlow()
    flow.attach(startup.current.attachmentId)
    const capture = startSavedOutputCapture(
      terminal,
      (snapshot) => window.aiTerminal.saveTerminalSnapshot(props.startup.sessionId, snapshot),
      props.onFailure
    )
    const tracking = trackTerminalView({
      terminal,
      capture,
      view: () => view.current(),
      report: (update) => onView.current(update),
      onFailure: props.onFailure
    })
    let ptyDimensions: { cols: number; rows: number } | undefined
    let refitCount = 0
    const resize = (): void => {
      // A hidden pane is parked at 1px, and fitting that would shrink the process's terminal to 2 columns: a TUI
      // redraws into that width and the wrapped lines stay in history. A hidden pane keeps its size until shown.
      if (!visible.current || !container.offsetParent) return
      refitCount += 1
      tracking.quietly(() => fit.fit())
      void window.aiTerminal
        .resizeTerminal(props.startup.sessionId, terminal.cols, terminal.rows)
        .then((dimensions) => (ptyDimensions = dimensions))
        .catch((error: unknown) => {
          props.onFailure(failureDetail(error, 'Terminal resize failed'))
        })
    }
    refit.current = resize
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    const send = (data: string): void => {
      window.aiTerminal.sendTerminalInput(startup.current.attachmentId, new TextEncoder().encode(data))
    }
    const focusReports = createFocusReports({ reportsEnabled: () => terminal.modes.sendFocusMode, send })
    const input = terminal.onData((data) => {
      if (!focusReports.isFocusReport(data)) send(data)
    })
    // onKey fires only for the owner's own keys, not for the replies xterm sends to terminal queries.
    const answered = (): void => {
      if (needsYou.current) onAnswer.current()
    }
    const keys = terminal.onKey(answered)
    const textareaFocus = (): void => focusReports.paneFocus(true)
    const textareaBlur = (): void => focusReports.paneFocus(false)
    terminal.textarea?.addEventListener('focus', textareaFocus)
    terminal.textarea?.addEventListener('blur', textareaBlur)
    if (terminal.textarea && document.activeElement === terminal.textarea && document.hasFocus()) {
      focusReports.paneFocus(true)
    }
    const stopPresence = window.aiTerminal.onPresence((presence) => focusReports.presence(presence))
    const mouse = createMouseClipboard({
      hasSelection: () => terminal.hasSelection(),
      getSelection: () => terminal.getSelection(),
      mouseTracking: () => terminal.modes.mouseTrackingMode !== 'none',
      copy: (text) => {
        void window.aiTerminal.writeClipboardText(text)
          .catch((error: unknown) => onFailure.current(failureDetail(error, 'Copy failed')))
      },
      paste: () => onPaste.current()
    })
    const mouseDown = (event: MouseEvent): void => mouse.mouseDown(event)
    // The window hears the release after xterm's document listener has finished the selection, even outside the pane.
    const mouseUp = (event: MouseEvent): void => mouse.mouseUp(event)
    const contextMenu = (event: MouseEvent): void => {
      if (mouse.contextMenu(event)) event.preventDefault()
    }
    container.addEventListener('mousedown', mouseDown, true)
    container.addEventListener('contextmenu', contextMenu, true)
    window.addEventListener('mouseup', mouseUp)
    const controller: TerminalController = {
      output: (message) => {
        if (message.attachmentId !== startup.current.attachmentId) return
        flow.accept(message, {
          write: tracking.write,
          acknowledge: window.aiTerminal.acknowledgeTerminalOutput,
          recover: (reason) => controller.disconnect(reason)
        })
      },
      exit: (message) => {
        if (message.attachmentId !== startup.current.attachmentId) return
        applyTerminalExit(message, {
          detach: (attachmentId) => flow.detach(attachmentId),
          setStatus: setExitStatus,
          onFailure: (failure) => onFailure.current(failure)
        })
      },
      disconnect: (reason) => {
        void window.aiTerminal.recoverTerminalView(props.startup.sessionId, reason)
      },
      capture: () => capture.captureNow(),
      scrollToBottom: () => tracking.quietly(() => terminal.scrollToBottom()),
      selection: () => copyableText(terminal.getSelection()),
      paste: (text) => {
        terminal.paste(text)
        answered()
        terminal.focus()
      },
      type: (text) => {
        terminal.input(text, true)
        answered()
      },
      selectAll: () => terminal.selectAll(),
      openSearch: () => {
        setSearchOpen(true)
        requestAnimationFrame(() => searchInput.current?.select())
      },
      focus: () => terminal.focus()
    }
    props.register(props.startup.sessionId, controller)
    const removeTestHook = installTerminalTestHook({
      enabled: props.testMode,
      target: window as never,
      sessionId: props.startup.sessionId,
      terminal,
      getPtyDimensions: () => ptyDimensions,
      getRefitCount: () => refitCount,
      ...(props.selected ? { integration: async () => {
        console.warn('[BMN] renderer behavioural integration: started')
        const workspaces = await window.aiTerminal.listWorkspaces(true)
        const sessionsBeforeTemplate = await window.aiTerminal.listSessions(props.startup.workspaceId)
        await window.aiTerminal.resizeTerminal(
          props.startup.sessionId,
          terminal.cols,
          terminal.rows
        )
        const typedCode = (error: unknown): string => (isBridgeError(error) ? error.code : 'untyped')
        const { layout } = await window.aiTerminal.getLayout(props.startup.workspaceId)
        const staleLayoutPut = await window.aiTerminal.putLayout({
          workspaceId: props.startup.workspaceId,
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
        // The inspector and session form live in the details panel, opened the way the owner opens it.
        const moreButton = section.current?.querySelector<HTMLButtonElement>('button[data-action="more"]')
        if (!moreButton) throw new Error('the pane More button was not rendered')
        moreButton.click()
        const detailsItem = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
          '.popup-menu [role="menuitem"]'
        )].find((item) => item.textContent?.trim() === 'Session details'))
        detailsItem.click()
        console.warn('[BMN] renderer behavioural integration: details panel opened')
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
        const inspector = document.querySelector<HTMLElement>(
          '[aria-label="Selected session actions"]'
        )
        if (!inspector) throw new Error('the selected-session inspector was not rendered')
        const launchUnavailableNotice = await waitFor(() => {
          const notice = inspector.querySelector<HTMLElement>('[role="status"]')?.textContent?.trim()
          return notice?.startsWith('Launch unavailable: ') ? notice : undefined
        })
        const resumeButton = await waitFor(() => [...inspector.querySelectorAll<HTMLButtonElement>(
          'button'
        )].find((button) => button.textContent?.trim() === 'Resume'))
        const launchUnavailable = {
          sessionId: props.startup.sessionId,
          notice: launchUnavailableNotice,
          resumeDisabled: resumeButton.disabled,
          resumeTitle: resumeButton.title
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
          argv: input('Arguments').value.trim().split(/\s+/).filter(Boolean),
          cwd: input('Working directory').value,
          backgroundChoice: (() => {
            const value = templateForm.querySelector<HTMLSelectElement>(
              'select[aria-label="When windows close"]'
            )?.value
            return value === 'hide' || value === 'stop' ? value : null
          })()
        }
        const shownSize = { cols: terminal.cols, rows: terminal.rows }
        templateForm.requestSubmit()
        console.warn('[BMN] renderer behavioural integration: template form submitted')
        const knownSessionIds = new Set(sessionsBeforeTemplate.map((session) => session.sessionId))
        const templateCreatedSession = await waitFor(async () => {
          const records = await window.aiTerminal.listSessions(props.startup.workspaceId)
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
        await waitFor(() => section.current?.classList.contains('session-terminal-hidden') ? true : undefined)
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        await new Promise<void>((resolve) => setTimeout(resolve, 250))
        const hiddenSize = { cols: terminal.cols, rows: terminal.rows }
        const sessionButton = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(
          '.session-row > button[data-session-id]'
        )].find((button) => button.dataset.sessionId === props.startup.sessionId))
        sessionButton.click()
        console.warn('[BMN] renderer behavioural integration: tree session selected')
        const selectedLayout = await waitFor(async () => {
          const next = await window.aiTerminal.getLayout(props.startup.workspaceId)
          return next.layout.selectedSessionId === props.startup.sessionId ? next.layout : undefined
        })
        const sourceWorkspace = workspaces.find((workspace) =>
          workspace.archivedAt === null && workspace.workspaceId !== props.startup.workspaceId)
        if (!sourceWorkspace) throw new Error('the cross-workspace split fixture was not available')
        const sourceSession = (await window.aiTerminal.listSessions(sourceWorkspace.workspaceId))
          .find((record) => record.archivedAt === null)
        if (!sourceSession) throw new Error('the cross-workspace split fixture had no visible session')
        const splitButton = await waitFor(() => [...(section.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
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
          const next = await window.aiTerminal.getLayout(props.startup.workspaceId)
          return next.layout.split.panes.some((pane) => pane.sessionId === sourceSession.sessionId)
            ? next.layout
            : undefined
        })
        const sourcePane = await waitFor(() => document.querySelector<HTMLElement>(
          `.session-terminal[data-session-id="${sourceSession.sessionId}"]:not(.session-terminal-hidden)`
        ))
        if (!sourcePane) throw new Error('the cross-workspace terminal pane was not visible')
        section.current?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        const focusedLayout = await waitFor(async () => {
          const next = await window.aiTerminal.getLayout(props.startup.workspaceId)
          return next.layout.selectedSessionId === props.startup.sessionId ? next.layout : undefined
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
          const next = await window.aiTerminal.getLayout(props.startup.workspaceId)
          return next.layout.split.panes.some((pane) => pane.sessionId === sourceSession.sessionId)
            ? undefined
            : next.layout
        })
        console.warn('[BMN] renderer behavioural integration: complete')
        return {
          workspaceCount: workspaces.length,
          sessionMethodSessionId: props.startup.sessionId,
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
            sessionId: props.startup.sessionId,
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
              cleanedLayout.split.panes.some((pane) => pane.sessionId === props.startup.sessionId)
          },
          hiddenPaneSize: { shown: shownSize, hidden: hiddenSize }
        }
      } } : {})
    })
    requestAnimationFrame(() => {
      resize()
      const restoredLine = view.current().scrollLine
      if (restoredLine !== null) tracking.quietly(() => terminal.scrollToLine(restoredLine))
      if (props.selected) terminal.focus()
    })
    return () => {
      removeTestHook()
      props.register(props.startup.sessionId, undefined)
      stopPresence()
      terminal.textarea?.removeEventListener('focus', textareaFocus)
      terminal.textarea?.removeEventListener('blur', textareaBlur)
      focusReports.dispose()
      input.dispose()
      keys.dispose()
      container.removeEventListener('mousedown', mouseDown, true)
      container.removeEventListener('contextmenu', contextMenu, true)
      window.removeEventListener('mouseup', mouseUp)
      tracking.dispose()
      observer.disconnect()
      capture.dispose()
      terminal.dispose()
      terminalRef.current = null
      searchAddon.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = TERMINAL_THEMES[props.colorMode]
    terminal.options.fontSize = props.fontSize
    refit.current()
  }, [props.colorMode, props.fontSize])

  useEffect(() => {
    if (!props.visible || !props.selected) return
    const terminal = element.current?.querySelector('.xterm-helper-textarea') as HTMLElement | null
    if (!document.querySelector('dialog[open]')) terminal?.focus()
    if (activated.current) return
    activated.current = true
    void window.aiTerminal.activateTerminal(props.startup.sessionId).catch((error: unknown) => {
      activated.current = false
      props.onFailure(failureDetail(error, 'Terminal activation failed'))
    })
  }, [props.visible, props.selected])

  const find = (direction: 1 | -1): void => {
    const addon = searchAddon.current
    if (!addon || !searchTerm) {
      setSearchResult('')
      return
    }
    const found = direction === 1 ? addon.findNext(searchTerm) : addon.findPrevious(searchTerm)
    setSearchResult(found ? `Match for “${searchTerm}” highlighted` : `No matches for “${searchTerm}” in retained history`)
  }

  const closeSearch = (): void => {
    searchAddon.current?.clearDecorations()
    setSearchOpen(false)
    setSearchResult('')
    terminalRef.current?.focus()
  }

  const name = props.startup.name
  const statusText = `${exitStatus ?? (props.needsYou ? 'Waiting for your response' : 'Running')} · ${props.startup.cwd}`
  const dot = exitStatus ? 'exited' : props.needsYou ? 'needs-you' : 'running'
  const progress = props.progress

  return (
    <section
      ref={section}
      className={`session-terminal${props.visible ? '' : ' session-terminal-hidden'}${props.selected ? ' selected' : ''}${dropTarget ? ' drop-target' : ''}`}
      aria-label={`${name} terminal`}
      data-session-id={props.startup.sessionId}
      style={{ order: props.order, flexGrow: props.ratio }}
      onPointerDownCapture={() => {
        if (!props.selected) props.onSelect()
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files') || exitStatus) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropTarget(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(false)
      }}
      onDrop={(event) => {
        setDropTarget(false)
        if (exitStatus) return
        event.preventDefault()
        const files = [...event.dataTransfer.files]
        if (files.length > 0) props.onDropFiles(files)
      }}
    >
      <header className="pane-heading">
        <strong title={name}>{name}</strong>
        {props.record ? <span className="chip">{agentTag(props.record.executable)}</span> : null}
        <span className={`status-dot ${dot}`} aria-hidden="true" />
        <span className={`pane-status${props.needsYou && !exitStatus ? ' needs-you' : ''}`}>{statusText}</span>
        <div className="pane-actions">
          <button type="button" aria-pressed={props.split} title={`Split (${SHORTCUT_LABELS['split-toggle']})`} onClick={props.onSplit}>
            <Icon name="split" /><span className="button-label">{props.split ? 'Unsplit' : 'Split'}</span>
          </button>
          <button type="button" aria-pressed={props.focusMode} title={`Focus (${SHORTCUT_LABELS['focus-toggle']})`} onClick={props.onFocusMode}>
            <Icon name="focus" /><span className="button-label">Focus</span>
          </button>
          <button type="button" aria-pressed={props.filesOpen} onClick={props.onFiles}>
            <Icon name="files" /><span className="button-label">Files</span>
          </button>
          <button type="button" className="icon-button" data-action="more" aria-haspopup="menu" aria-label={`More actions for ${name}`}
            onClick={(event) => props.onMore(event.currentTarget)}>
            <Icon name="more" />
          </button>
        </div>
      </header>
      {progress ? (
        <div className="progress-strip" role="group" aria-label="Progress" title={progress.detail ?? undefined}>
          <span className="label">{progress.label}</span>
          <span className={`state ${progress.state}`}>{progress.word}</span>
          {progress.stale ? <span className="stale">stale</span> : null}
          <span className="source">{progress.source} · {progress.age}</span>
        </div>
      ) : null}
      {searchOpen ? (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            aria-label={`Search ${name} output`}
            placeholder="Search output"
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value)
              setSearchResult('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                find(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeSearch()
              }
            }}
          />
          <button type="button" onClick={() => find(-1)}>Previous</button>
          <button type="button" onClick={() => find(1)}>Next</button>
          <span className="search-result" aria-live="polite">{searchStatusText(searchResult)}</span>
          <button type="button" className="icon-button" aria-label="Close search" onClick={closeSearch}><Icon name="close" /></button>
        </div>
      ) : null}
      <div ref={element} className="terminal-surface" />
      <footer className="pane-footer">
        <span className={`input-state${props.armed && props.selected ? ' armed' : ''}${props.voice?.phase === 'recording' ? ' listening' : ''}`}>
          {props.armed && props.selected
            ? 'Next key goes to the terminal'
            : exitStatus ? 'Process ended · input closed'
              : props.voice?.phase === 'recording'
                ? props.voice.trigger === 'hold' ? 'Listening · release Space to paste' : 'Listening · press Speak to paste'
                : props.voice?.phase === 'transcribing' ? 'Transcribing on this computer…' : 'Typing goes to the terminal'}
        </span>
        <SpeakButton voice={props.voice} disabled={!!exitStatus || props.voiceBusy} onSpeak={props.onSpeak} />
        <button type="button" disabled={!!exitStatus} onClick={props.onAttach} aria-label="Attach files">
          <Icon name="clip" /><span className="footer-label">Attach</span>
        </button>
        <button type="button" disabled={!!exitStatus} onClick={props.onPasteImage} aria-label="Paste image from clipboard">
          <Icon name="image" /><span className="footer-label">Paste image</span>
        </button>
      </footer>
    </section>
  )
}

function elapsedText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function SpeakButton(props: { voice: VoiceCapture | null; disabled: boolean; onSpeak(): void }): React.JSX.Element {
  const phase = props.voice?.phase
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [phase])
  const label = phase === 'recording'
    ? `Stop ${elapsedText(now - (props.voice?.startedAt ?? now))}`
    : phase === 'transcribing' ? 'Transcribing…' : phase === 'starting' ? 'Starting…' : 'Speak'
  const shortcut = SHORTCUT_LABELS['voice-toggle']
  return (
    <button
      type="button"
      className={`speak-button${phase ? ` ${phase}` : ''}`}
      disabled={props.disabled || phase === 'starting' || phase === 'transcribing'}
      aria-pressed={phase === 'recording'}
      aria-label={phase === 'recording' ? 'Stop dictation and paste the transcript' : phase ? label : 'Speak: dictate into this terminal'}
      title={phase === 'recording' ? `Stop and paste the transcript (${shortcut})` : `Dictate into this terminal; transcribed on this computer (${shortcut}, or hold Space when enabled in Preferences)`}
      onClick={props.onSpeak}
    >
      <Icon name="mic" /><span className="footer-label">{label}</span>
    </button>
  )
}
