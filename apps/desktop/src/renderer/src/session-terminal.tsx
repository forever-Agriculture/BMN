// MODULE: session-terminal.tsx - one live terminal pane: heading, progress strip, search, xterm surface and input footer
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  decsetRestoreSequence,
  TERMINAL_NOTICE_CODES,
  type ColorModeName,
  type HookOriginRecord,
  type ListeningPort,
  type SessionPorts,
  type SessionRecord,
  type TerminalExitMessage,
  type TerminalOutputMessage,
  type TerminalViewDisconnectReason,
  type VoiceSettings,
  type WorkspaceMarker
} from '@bmn/protocol'
import { failureDetail, sessionFailureDetail } from './bridge-error'
import { createFileReferenceLinkProvider } from './file-reference-links'
import { Icon } from './icons'
import { SHORTCUT_LABELS } from './keymap'
import { WorkspaceIdentityMark } from './workspace-marker'
import { ProgressStrip } from './progress-strip'
import { capTitle, type SessionActivity } from './session-activity'
import type { ProgressPresentation, SessionAttention } from './session-presentation'
import { agentTag, modelOriginFlag, modelOriginLabel, observedAgentName } from './session-presentation'
import { PanePorts } from './session-ports'
import { parseTerminalNotice } from './terminal-notice'
import { installTerminalTestHook, type TerminalTestHandle } from './test-hook'
import { liveTerminalOptions, startSavedOutputCapture } from './terminal-history'
import { copyableText, createMouseClipboard } from './terminal-clipboard'
import { TerminalOutputFlow } from './terminal-output-flow'
import { applyTerminalExit } from './terminal-exit'
import { createFocusReports } from './terminal-focus-reports'
import { trackTerminalView } from './terminal-view-tracking'
import { SIXEL_SMOKE_FRAME, checkSixelRenderer, createTerminalImageAddon, registerTerminalImages } from './terminal-images'
import { searchStatusText } from './terminal-view'
import { TERMINAL_THEMES } from './theme'
import { readRecentLines } from './voice-suggestions'
import type { SessionView, SessionViewUpdate } from './workspace-layout'

type ApplicationRendererStartup = Parameters<Parameters<Window['aiTerminal']['onStartup']>[0]>[0]
export type SuccessfulStartup = Extract<ApplicationRendererStartup, { ok: true }>
export type LiveStartup = SuccessfulStartup['liveSessions'][number]

/** One dictation in flight; the model, language, vocabulary and target incarnation are fixed when recording starts. */
export interface VoiceCapture extends Pick<VoiceSettings, 'model' | 'language' | 'vocabulary'> {
  sessionId: string
  /** The live process the transcript may be pasted into; a restarted session gets nothing. */
  incarnationId: string
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
  /**
   * The newest logical lines of the active buffer, oldest first, reading at most `maxRows` rows and `maxBytes` of their
   * text; rows xterm wrapped are joined. Reads only.
   */
  recentText(maxRows: number, maxBytes: number): string[]
}

export function SessionTerminal(props: {
  startup: LiveStartup
  record: SessionRecord | undefined
  /** The pane's own workspace, so a cross-workspace split shows each pane's identity, not the active one. */
  workspaceIdentity: { name: string; marker: WorkspaceMarker } | null
  visible: boolean
  selected: boolean
  order: number
  ratio: number
  split: boolean
  focusMode: boolean
  filesOpen: boolean
  attention: SessionAttention
  /** The observed working/idle word for this pane, or null before the first derivation. Display only. */
  activity: SessionActivity | null
  /** The harness set the terminal title; the shell caps it, keeps it in memory and shows it. */
  onTitle(title: string): void
  /** This run's model-origin facts, or null: they name the agent chip and its flag in the heading. */
  modelOrigin: HookOriginRecord | null
  /** The ports this session's programs listen on, from the last scan (Story 41.2). */
  ports: SessionPorts | null
  onOpenPort(port: ListeningPort): void
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
  /** The strip's state word: opens the progress detail for this pane's own observation. */
  onOpenProgress(anchor: HTMLElement): void
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
  /** Ctrl+click on a file reference printed in this pane; it always names this pane's session. */
  onOpenFileReference(reference: string): void
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  const section = useRef<HTMLElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const refit = useRef<() => void>(() => undefined)
  const searchAddon = useRef<SearchAddon>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchBar = useRef<HTMLDivElement>(null)
  /** Tells the program whether the owner is looking at this pane (DECSET 1004); set once the terminal exists. */
  const paneFocus = useRef<(focused: boolean) => void>(() => undefined)
  const startup = useRef(props.startup)
  const record = useRef(props.record)
  const view = useRef(props.view)
  const visible = useRef(props.visible)
  const onView = useRef(props.onView)
  const onFailure = useRef(props.onFailure)
  const onPaste = useRef(props.onPaste)
  const needsYou = useRef(props.attention !== null)
  const onAnswer = useRef(props.onAnswer)
  const onOpenFileReference = useRef(props.onOpenFileReference)
  const onTitle = useRef(props.onTitle)
  const activated = useRef(false)
  /** The presented exit status; undefined while the process is running. */
  const [exitStatus, setExitStatus] = useState<string>()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const [dropTarget, setDropTarget] = useState(false)
  const [imageWarning, setImageWarning] = useState(false)

  startup.current = props.startup
  record.current = props.record
  view.current = props.view
  visible.current = props.visible
  onView.current = props.onView
  onFailure.current = props.onFailure
  onPaste.current = props.onPaste
  needsYou.current = props.attention !== null
  onAnswer.current = props.onAnswer
  onOpenFileReference.current = props.onOpenFileReference
  onTitle.current = props.onTitle

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
    const images = createTerminalImageAddon()
    searchAddon.current = search
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    let unregisterImages = (): void => undefined
    try {
      terminal.loadAddon(images)
      unregisterImages = registerTerminalImages(images)
    } catch {
      setImageWarning(true)
    }
    terminal.open(container)
    let mounted = true
    void checkSixelRenderer().then((ready) => {
      if (mounted && !ready) setImageWarning(true)
    })
    /**
     * Epic 17.2: this view is new, the program is not. It set these modes before the view existed,
     * so the view is brought up to date with them — written into this xterm only, never to the
     * PTY, and before the first fit, so paste, focus reports and the mouse work from the first
     * keystroke. The program is not asked to repeat itself: nothing here reaches it.
     */
    const restoredModes = decsetRestoreSequence(props.startup.modes)
    if (restoredModes) terminal.write(restoredModes)
    const flow = new TerminalOutputFlow()
    flow.attach(startup.current.attachmentId)
    const capture = startSavedOutputCapture(
      terminal,
      (snapshot) => window.aiTerminal.saveTerminalSnapshot(props.startup.sessionId, snapshot),
      (message) => onFailure.current(`${startup.current.name}: ${message}`)
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
          onFailure.current(sessionFailureDetail(startup.current.name, error, 'Terminal resize failed'))
        })
    }
    refit.current = resize
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    // Counted for the self-test: everything this pane puts on the PTY, focus reports included, so a display-only
    // change can prove it wrote nothing.
    let inputEvents = 0
    const send = (data: string): void => {
      inputEvents += 1
      window.aiTerminal.sendTerminalInput(startup.current.attachmentId, new TextEncoder().encode(data))
    }
    const focusReports = createFocusReports({ reportsEnabled: () => terminal.modes.sendFocusMode, send })
    paneFocus.current = (focused) => focusReports.paneFocus(focused)
    const input = terminal.onData((data) => {
      if (!focusReports.isFocusReport(data)) send(data)
    })
    // onKey fires only for the owner's own keys, not for the replies xterm sends to terminal queries.
    const answered = (): void => {
      if (needsYou.current) onAnswer.current()
    }
    const keys = terminal.onKey(answered)
    // A title is read and shown, never obeyed: it cannot make a session working, and it opens nothing.
    const titles = terminal.onTitleChange((title) => onTitle.current(capTitle(title)))
    /**
     * Epic 15.1: a program that knows nothing of `bmn` still speaks the terminal's own notification
     * sequences. They are read here, consumed so they never print, and reported to the utility,
     * which opens a `notice` and nothing else. Nothing here reaches the PTY, changes the activity
     * word or refits the view: the window only repeats what the program said.
     */
    const notices = TERMINAL_NOTICE_CODES.map((code) => terminal.parser.registerOscHandler(code, (data) => {
      const notice = parseTerminalNotice(code, data)
      if (notice !== null) {
        void window.aiTerminal.reportTerminalNotice({
          sessionId: startup.current.sessionId,
          incarnationId: startup.current.incarnationId,
          code,
          title: notice.title,
          ...(notice.body === undefined ? {} : { body: notice.body })
        // A notification the app declined - a process that has already gone, a session it no longer
        // knows - is not a failure the owner needs a banner for. The sequence is still consumed.
        }).catch(() => undefined)
      }
      return true
    }))
    const textareaFocus = (): void => focusReports.paneFocus(true)
    // Story 33.1: focus moving into this pane's own search bar is still the owner looking at this pane, so the
    // program is told nothing when search opens, is used or closes.
    const textareaBlur = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && searchBar.current?.contains(event.relatedTarget)) return
      focusReports.paneFocus(false)
    }
    terminal.textarea?.addEventListener('focus', textareaFocus)
    terminal.textarea?.addEventListener('blur', textareaBlur)
    if (terminal.textarea && document.activeElement === terminal.textarea && document.hasFocus()) {
      focusReports.paneFocus(true)
    }
    const stopPresence = window.aiTerminal.onPresence((presence) => focusReports.presence(presence))
    const mouse = createMouseClipboard({
      hasSelection: () => terminal.hasSelection(),
      getSelection: () => terminal.getSelection(),
      copy: (text) => {
        void window.aiTerminal.writeClipboardText(text)
          .catch((error: unknown) => onFailure.current(failureDetail(error, 'Copy failed')))
      },
      paste: () => onPaste.current()
    })
    const fileLinks = createFileReferenceLinkProvider({
      buffer: () => terminal.buffer.active,
      enabled: () => terminal.modes.mouseTrackingMode === 'none',
      hasSelection: () => terminal.hasSelection(),
      open: (reference) => onOpenFileReference.current(reference)
    })
    const cellAt = (event: MouseEvent): { col: number; row: number } | null => {
      const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
      const bounds = screen?.getBoundingClientRect()
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null
      const col = Math.max(0, Math.min(terminal.cols - 1,
        Math.floor((event.clientX - bounds.left) / (bounds.width / terminal.cols))))
      const viewportRow = Math.max(0, Math.min(terminal.rows - 1,
        Math.floor((event.clientY - bounds.top) / (bounds.height / terminal.rows))))
      return { col, row: terminal.buffer.active.viewportY + viewportRow }
    }
    let trackedDragStart: { col: number; row: number } | null = null
    const mouseDown = (event: MouseEvent): void => {
      const screen = terminal.element?.querySelector('.xterm-screen')
      trackedDragStart = event.button === 0 && terminal.modes.mouseTrackingMode !== 'none' &&
        event.target instanceof Node && !!screen?.contains(event.target)
        ? cellAt(event) : null
      fileLinks.pressStarted(event)
      mouse.mouseDown(event)
    }
    // xterm consumes mouseup and clears its selection while reporting mouse events. Capture the
    // release, derive a drag selection from the visible grid, and copy before xterm handles it.
    const mouseUp = (event: MouseEvent): void => {
      if (event.button === 0 && trackedDragStart) {
        const end = cellAt(event)
        const start = trackedDragStart
        trackedDragStart = null
        if (end) {
          const first = start.row * terminal.cols + start.col
          const last = end.row * terminal.cols + end.col
          if (first !== last) {
            const low = Math.min(first, last)
            terminal.select(low % terminal.cols, Math.floor(low / terminal.cols), Math.abs(last - first))
          }
        }
        mouse.mouseUp(event)
        fileLinks.pressEnded()
        return
      }
      queueMicrotask(() => {
        mouse.mouseUp(event)
        fileLinks.pressEnded()
      })
    }
    const contextMenu = (event: MouseEvent): void => {
      // macOS turns Ctrl+click into this event; the hovered file link opens here, and the release adds nothing.
      if (fileLinks.openHovered() || mouse.contextMenu(event)) event.preventDefault()
    }
    container.addEventListener('mousedown', mouseDown, true)
    container.addEventListener('contextmenu', contextMenu, true)
    window.addEventListener('mouseup', mouseUp, true)
    // xterm's linkifier hears the click on the screen after the capture listeners above and the window hears the
    // A Ctrl+click on a link opens it; with no drag selection the clipboard is left alone.
    const fileLinkRegistration = terminal.registerLinkProvider(fileLinks)
    const trackLinkModifier = (event: MouseEvent | KeyboardEvent): void => fileLinks.modifierChanged(event.ctrlKey)
    const releaseLinkModifier = (): void => fileLinks.modifierChanged(false)
    container.addEventListener('mousemove', trackLinkModifier, true)
    window.addEventListener('keydown', trackLinkModifier, true)
    window.addEventListener('keyup', trackLinkModifier, true)
    window.addEventListener('blur', releaseLinkModifier)
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
        // The program is gone: save any unsaved last screen once, then ask for no more saves.
        capture.finish()
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
      focus: () => terminal.focus(),
      recentText: (maxRows, maxBytes) => readRecentLines(terminal.buffer.active, maxRows, maxBytes)
    }
    props.register(props.startup.sessionId, controller)
    const testHandle: TerminalTestHandle<Terminal> = {
      startup: props.startup,
      terminal,
      section,
      ptyDimensions: () => ptyDimensions,
      refitCount: () => refitCount,
      inputEvents: () => inputEvents,
      imageStorageMB: () => images.storageUsage,
      imageLayerPresent: () => !!container.querySelector('.xterm-image-layer'),
      view: {
        imageCells: () => {
          const buffer = terminal.buffer.active
          const lines: number[] = []
          for (let line = 0; images.storageUsage > 0 && line < buffer.length; line += 1) {
            for (let column = 0; column < terminal.cols; column += 1) {
              if (images.getImageAtBufferCell(column, line)) {
                lines.push(line)
                break
              }
            }
          }
          const cell = (terminal as unknown as { _core: { _renderService: { dimensions: {
            css: { cell: { height: number } }; device: { cell: { height: number } } } } } })._core._renderService.dimensions
          return { lines, cssCellHeight: cell.css.cell.height, deviceCellHeight: cell.device.cell.height,
            devicePixelRatio: window.devicePixelRatio, fontSize: terminal.options.fontSize ?? 0 }
        },
        select: (column, row, length) => {
          terminal.select(column, row, length)
          return terminal.getSelection()
        },
        selection: () => terminal.getSelection(),
        clearSelection: () => terminal.clearSelection()
      },
      sixelFixture: () => new Promise((resolve) => {
        terminal.write(SIXEL_SMOKE_FRAME, () => {
          terminal.refresh(0, terminal.rows - 1)
          const deadline = Date.now() + 1000
          const readLayer = (): void => {
            const layer = !!container.querySelector('.xterm-image-layer')
            if (layer || Date.now() >= deadline) resolve({ storageMB: images.storageUsage, layer })
            else setTimeout(readLayer, 25)
          }
          readLayer()
        })
      })
    }
    const removeTestHook = installTerminalTestHook({
      enabled: props.testMode,
      target: window as never,
      handle: testHandle,
      ...(props.selected ? {
        integration: async () => (await import('./self-test/terminal-integration')).runTerminalIntegration(testHandle)
      } : {})
    })
    requestAnimationFrame(() => {
      resize()
      const restoredLine = view.current().scrollLine
      if (restoredLine !== null) tracking.quietly(() => terminal.scrollToLine(restoredLine))
      if (props.selected) terminal.focus()
    })
    return () => {
      mounted = false
      unregisterImages()
      removeTestHook()
      props.register(props.startup.sessionId, undefined)
      stopPresence()
      terminal.textarea?.removeEventListener('focus', textareaFocus)
      terminal.textarea?.removeEventListener('blur', textareaBlur)
      focusReports.dispose()
      input.dispose()
      keys.dispose()
      titles.dispose()
      for (const notice of notices) notice.dispose()
      container.removeEventListener('mousedown', mouseDown, true)
      container.removeEventListener('contextmenu', contextMenu, true)
      window.removeEventListener('mouseup', mouseUp, true)
      fileLinkRegistration.dispose()
      container.removeEventListener('mousemove', trackLinkModifier, true)
      window.removeEventListener('keydown', trackLinkModifier, true)
      window.removeEventListener('keyup', trackLinkModifier, true)
      window.removeEventListener('blur', releaseLinkModifier)
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

  /** Asks the host to start streaming this session's output; the first caller wins and a failure may retry. */
  const ensureActive = (): void => {
    if (activated.current) return
    activated.current = true
    void window.aiTerminal.activateTerminal(props.startup.sessionId).catch((error: unknown) => {
      activated.current = false
      props.onFailure(sessionFailureDetail(props.startup.name, error, 'Terminal activation failed'))
    })
  }

  // Every live pane activates when it mounts, visible or not: output reaches the window only after
  // activation, so a session the owner never opened would show no unread mark and no observed word.
  useEffect(ensureActive, [])

  useEffect(() => {
    if (!props.visible || !props.selected) return
    const terminal = element.current?.querySelector('.xterm-helper-textarea') as HTMLElement | null
    if (!document.querySelector('dialog[open]')) terminal?.focus()
    ensureActive()
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
  const attentionWord = props.attention === 'response' ? 'Waiting for your response'
    : props.attention === 'update' ? 'Update available' : props.activity?.word ?? 'Running'
  const stateWord = exitStatus ?? attentionWord
  const dot = exitStatus ? 'exited'
    : props.attention ? 'needs-you'
      : props.activity && !props.activity.working ? 'running-idle' : 'running'
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
        {props.workspaceIdentity ? (
          <WorkspaceIdentityMark
            workspaceName={props.workspaceIdentity.name}
            marker={props.workspaceIdentity.marker}
          />
        ) : null}
        <strong title={name}>{name}</strong>
        {props.record ? <span className="chip">{props.modelOrigin === null || exitStatus
          ? agentTag(props.record.executable, props.record.argv)
          : observedAgentName(props.modelOrigin.agent)}</span> : null}
        {props.modelOrigin !== null && !exitStatus && modelOriginFlag(props.modelOrigin) !== null ? (
          <span className="origin-flag" role="img"
            title={modelOriginLabel(props.modelOrigin) ?? undefined}
            aria-label={modelOriginLabel(props.modelOrigin) ?? undefined}>{modelOriginFlag(props.modelOrigin)}</span>
        ) : null}
        <span className={`status-dot ${dot}`} aria-hidden="true" />
        <span className={`pane-status${props.attention && !exitStatus ? ' needs-you' : ''}`}>
          <span className="pane-state">{stateWord}</span>
          <span className="pane-directory">{` · ${props.startup.cwd}`}</span>
        </span>
        <PanePorts entry={props.ports} onOpen={props.onOpenPort} />
        <div className="pane-actions">
          <button type="button" aria-pressed={props.split} title={`Split (${SHORTCUT_LABELS['split-toggle']})`} onClick={props.onSplit}>
            <Icon name="split" /><span className="button-label">{props.split ? 'Unsplit' : 'Split'}</span>
          </button>
          <button type="button" aria-pressed={props.focusMode} title={`Focus (${SHORTCUT_LABELS['focus-toggle']})`} onClick={props.onFocusMode}>
            <Icon name="focus" /><span className="button-label">Focus</span>
          </button>
          <button type="button" aria-label="Files" aria-pressed={props.filesOpen} onClick={props.onFiles}>
            <Icon name="files" /><span className="button-label">Files</span>
          </button>
          <button type="button" className="icon-button" data-action="more" aria-haspopup="menu" aria-label={`More actions for ${name}`}
            onClick={(event) => props.onMore(event.currentTarget)}>
            <Icon name="more" />
          </button>
        </div>
      </header>
      <ProgressStrip progress={progress} onOpen={props.onOpenProgress} />
      {/* Search floats over the surface so opening it never changes the surface's size and never resizes the PTY. */}
      <div className="terminal-frame">
        {searchOpen ? (
          <div ref={searchBar} className="terminal-search" role="search" onBlur={(event) => {
            // Leaving the bar for anywhere but the bar or this terminal is leaving the pane.
            const next = event.relatedTarget
            if (next instanceof Node && (event.currentTarget.contains(next) || next === terminalRef.current?.textarea)) return
            paneFocus.current(false)
          }} onFocus={() => {
            // Coming back into the bar from elsewhere is coming back to the pane; from the terminal it changes nothing.
            paneFocus.current(true)
          }}>
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
      </div>
      {imageWarning ? <div className="terminal-image-warning" role="status">
        Terminal images are unavailable in this pane. Text remains usable.
      </div> : null}
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
