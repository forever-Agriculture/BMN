// MODULE: main.tsx - Chancel application shell: header, workspace tree, session panes, side panels, dialogs and keyboard map
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  COLOR_MODE_NAMES,
  DEFAULT_APP_SETTINGS,
  IDENTITY_NAMES,
  TERMINAL_FONT_SIZE_RANGE,
  type AppearanceSettings,
  type AppSettings,
  type ArtifactRecord,
  type AttentionRecord,
  type ConversationBindingState,
  type ExplicitConversationBinding,
  type InputDraftRecord,
  type LaunchTemplateRecord,
  type ProgressRecord,
  type SessionRecord,
  type WorkspaceLayoutState,
  type WorkspaceRecord
} from '@bmn/protocol'
import './styles.css'
import { failureDetail } from './bridge-error'
import { CommandPalette, type PaletteCommand } from './command-palette'
import { conversationBindingPresentation } from './conversation-resume'
import { FilesPanel } from './files-panel'
import { Icon } from './icons'
import { isModifierOnly, resolveShortcut, SHORTCUT_LABELS, type AppCommand } from './keymap'
import { createLayoutWriter } from './layout-writer'
import {
  BACKGROUND_CHOICE_OPTIONS,
  INITIAL_SESSION_FORM,
  applyLaunchTemplate,
  sessionCreateParams,
  sessionLaunchForm,
  sessionUpdateParams,
  type SessionLaunchForm
} from './launch-template'
import { NeedsYouPopover, type UnreadEntry } from './needs-you-popover'
import { PopupMenu, type MenuAnchor, type MenuEntry } from './popup-menu'
import { PreferencesDialog } from './preferences-dialog'
import {
  agentTag,
  attentionActionWhenOpened,
  displayPath,
  inferHome,
  neighbor,
  nextRequest,
  openRequests,
  progressPresentation,
  requestsAnsweredByTyping,
  sessionAttention,
  sessionStatus,
  splitCandidates,
  windowTitle,
  type ProgressPresentation
} from './session-presentation'
import { sessionProcessLabel } from './session-status'
import {
  SessionTerminal,
  type LiveStartup,
  type SuccessfulStartup,
  type TerminalController,
  type VoiceCapture
} from './session-terminal'
import { ConfirmDialog, ConversationReferenceDialog, WorkspaceDialog } from './shell-dialogs'
import { loadSavedOutputPresentation, type SavedOutputCatalogPresentation } from './terminal-history'
import { createSpaceHold } from './space-hold'
import { applyChromeTheme, COLOR_MODE_PRESENTATION, IDENTITY_PRESENTATION } from './theme'
import { startVoiceRecording, VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE, type VoiceRecording } from './voice-recorder'
import { modelName, voiceReadiness } from './voice-readiness'
import {
  applySessionView,
  closeLayoutPane,
  resizeLayoutSplit,
  selectLayoutSession,
  sessionLayoutView,
  setLayoutOrientation,
  splitLayoutSession
} from './workspace-layout'
import {
  adjacentPositionUpdates,
  initialWorkspaceTree,
  orderedWorkspaceSessions,
  visibleWorkspaceSessions,
  selectTreeSession,
  selectTreeWorkspace,
  splitTreeSession,
  toggleShowArchived,
  toggleWorkspaceExpanded,
  visibleWorkspaces,
  type TreeSessionAction,
  type WorkspaceTreeState
} from './workspace-tree'

type ShellDialog =
  | { kind: 'palette' }
  /** Chooses the session for a second pane beside `sessionId`. */
  | { kind: 'split-picker'; sessionId: string | null }
  | { kind: 'preferences' }
  | { kind: 'new-workspace' }
  | { kind: 'rename-workspace'; workspace: WorkspaceRecord }
  | { kind: 'locate'; session: SessionRecord; binding: ConversationBindingState }
  | { kind: 'stop'; session: SessionRecord }

type SidePanel = 'files' | 'details' | null

const APP_EVENT_REFRESH_MS = 15_000

function ProgressSummary({ progress }: { progress: ProgressPresentation | null }): React.JSX.Element | null {
  if (!progress) return null
  return (
    <div className="progress-strip" role="group" aria-label="Progress" title={progress.detail ?? undefined}>
      <span className="label">{progress.label}</span>
      <span className={`state ${progress.state}`}>{progress.word}</span>
      {progress.stale ? <span className="stale">stale</span> : null}
      <span className="source">{progress.source} · {progress.age}</span>
    </div>
  )
}

function App(): React.JSX.Element {
  const controllers = useRef(new Map<string, TerminalController>())
  const liveRef = useRef(new Map<string, LiveStartup>())
  const sessionsRef = useRef<SessionRecord[]>([])
  const armedRef = useRef(false)
  const commandRef = useRef<(command: AppCommand) => void>(() => undefined)
  const needsYouButton = useRef<HTMLButtonElement>(null)
  const sessionArea = useRef<HTMLElement>(null)
  const [startup, setStartup] = useState<SuccessfulStartup>()
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [announcement, setAnnouncement] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [templates, setTemplates] = useState<LaunchTemplateRecord[]>([])
  const [layouts, setLayouts] = useState<Record<string, WorkspaceLayoutState>>({})
  const [live, setLive] = useState<Record<string, LiveStartup>>({})
  const [tree, setTree] = useState<WorkspaceTreeState>(() => initialWorkspaceTree([], null))
  const [binding, setBinding] = useState<ConversationBindingState>()
  const [savedOutput, setSavedOutput] = useState<SavedOutputCatalogPresentation>()
  const [sessionForm, setSessionForm] = useState<SessionLaunchForm>(INITIAL_SESSION_FORM)
  const [pickedTemplateId, setPickedTemplateId] = useState('')
  const [editingSessionId, setEditingSessionId] = useState<string>()
  /** The new-session form was opened from Split: the created session opens beside the current pane. */
  const [newSessionSplit, setNewSessionSplit] = useState(false)
  const [formError, setFormError] = useState<string>()
  const [unread, setUnread] = useState<Record<string, string>>({})
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [attention, setAttention] = useState<AttentionRecord[]>([])
  const [progress, setProgress] = useState<ProgressRecord[]>([])
  const [drafts, setDrafts] = useState<InputDraftRecord[]>([])
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [panel, setPanel] = useState<SidePanel>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [dialog, setDialog] = useState<ShellDialog | null>(null)
  const [needsYouOpen, setNeedsYouOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [voice, setVoice] = useState<VoiceCapture | null>(null)
  const voiceRef = useRef<VoiceCapture | null>(null)
  const voiceRecording = useRef<VoiceRecording | null>(null)
  const voiceTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** Space was released while the microphone was still starting: stop as soon as it records. */
  const voiceStopRequested = useRef(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [writer] = useState(() => createLayoutWriter({
    put: (params) => window.aiTerminal.putLayout(params),
    get: (workspaceId) => window.aiTerminal.getLayout(workspaceId),
    publish: (state) => setLayouts((current) => ({ ...current, [state.workspaceId]: state })),
    notice: (message) => setFailure(message),
    failure: (message) => setFailure(message)
  }))

  liveRef.current = new Map(Object.entries(live))
  sessionsRef.current = sessions
  const activeWorkspaceId = tree.selectedWorkspaceId
  const activeWorkspace = workspaces.find((item) => item.workspaceId === activeWorkspaceId)
  const layout = activeWorkspaceId ? layouts[activeWorkspaceId] : undefined
  const selectedSessionId = layout?.selectedSessionId ?? null
  const activeSessions = useMemo(
    () => activeWorkspaceId ? orderedWorkspaceSessions(sessions, activeWorkspaceId) : [],
    [sessions, activeWorkspaceId]
  )
  const allSessionIds = sessions.map((session) => session.sessionId)
  const navigableSessionIds = activeSessions
    .filter((session) => session.archivedAt === null)
    .map((session) => session.sessionId)
  const splittableSessionIds = useMemo(() =>
    visibleWorkspaces(workspaces, false).flatMap((workspace) =>
      orderedWorkspaceSessions(sessions, workspace.workspaceId)
        .filter((session) => session.archivedAt === null)
        .map((session) => session.sessionId)
    ), [sessions, workspaces])
  const home = useMemo(() => inferHome(sessions.map((session) => session.cwd)), [sessions])
  const unresolved = useMemo(() => openRequests(attention), [attention])
  const answering = useRef(new Set<string>())

  const fail = (fallback: string) => (error: unknown): void => setFailure(failureDetail(error, fallback))
  const announce = (message: string): void => {
    setAnnouncement('')
    requestAnimationFrame(() => setAnnouncement(message))
  }
  const brief = (message: string): void => {
    setNotice(message)
    announce(message)
  }

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 6_000)
    return () => clearTimeout(timer)
  }, [notice])

  const applyStartup = (next: SuccessfulStartup): void => {
    setStartup(next)
    setWorkspaces(next.workspaces)
    setSessions(next.sessions)
    setTemplates(next.templates)
    writer.reset(next.layouts)
    setLayouts(writer.layouts())
    setLive(Object.fromEntries(next.liveSessions.map((item) => [item.sessionId, item])))
    setTree(initialWorkspaceTree(next.workspaces, next.activeWorkspaceId))
    setFailure(next.layoutNotices.length > 0 ? next.layoutNotices.join(' ') : undefined)
  }

  const refresh = {
    artifacts: () => window.aiTerminal.listArtifacts(null).then(setArtifacts),
    attention: () => window.aiTerminal.listAttention().then(setAttention),
    progress: () => window.aiTerminal.listProgress().then(setProgress),
    drafts: () => window.aiTerminal.listDrafts().then(setDrafts),
    settings: () => window.aiTerminal.getSettings().then(setSettings)
  }

  useEffect(() => {
    if (!window.aiTerminal.security.sandboxed || !window.aiTerminal.security.contextIsolated) {
      setFailure('Renderer isolation is unavailable. Restore the sandboxed launch configuration.')
      return
    }
    const sessionFor = (attachmentId: string): string | undefined =>
      [...liveRef.current.values()].find((item) => item.attachmentId === attachmentId)?.sessionId
    const stopStartup = window.aiTerminal.onStartup((next) => {
      if (!next.ok) {
        setFailure(next.message)
        return
      }
      applyStartup(next)
      void Promise.all(Object.values(refresh).map((load) => load()))
        .catch(fail('Companion data is unavailable'))
    })
    const stopOutput = window.aiTerminal.onTerminalOutput((message) => {
      const sessionId = sessionFor(message.attachmentId)
      if (!sessionId) return
      controllers.current.get(sessionId)?.output(message)
      if (!sessionLayoutView(writer.layouts(), sessionsRef.current, sessionId).followTail) {
        setUnread((current) => current[sessionId] ? current : { ...current, [sessionId]: new Date().toISOString() })
      }
    })
    const stopExit = window.aiTerminal.onTerminalExit((message) => {
      const sessionId = sessionFor(message.attachmentId)
      if (sessionId) controllers.current.get(sessionId)?.exit(message)
    })
    const stopDisconnected = window.aiTerminal.onTerminalViewDisconnected((message) => {
      const sessionId = sessionFor(message.attachmentId)
      if (sessionId) controllers.current.get(sessionId)?.disconnect(message.reason)
    })
    const stopCapture = window.aiTerminal.onSavedOutputCaptureRequest(async (sessionId) => {
      const controller = controllers.current.get(sessionId)
      if (!controller) throw new Error(`Session ${sessionId} has no live terminal view`)
      await controller.capture()
    })
    const stopAppEvent = window.aiTerminal.onAppEvent((message) => {
      if (message.topic === 'telegram') return
      void refresh[message.topic]().catch(fail('Companion data refresh failed'))
    })
    const stopOpenSession = window.aiTerminal.onOpenSession((sessionId) => openSessionRef.current(sessionId))
    const ticker = setInterval(() => setNow(Date.now()), APP_EVENT_REFRESH_MS)
    const spaceHold = createSpaceHold({
      typeSpace: (sessionId) => controllers.current.get(sessionId)?.type(' '),
      canTalk: (sessionId) => !voiceRef.current && liveRef.current.has(sessionId),
      startTalking: (sessionId) => void beginVoiceRef.current(sessionId, 'hold'),
      stopTalking: () => {
        const phase = voiceRef.current?.trigger === 'hold' ? voiceRef.current.phase : undefined
        if (phase === 'recording') void finishVoiceRef.current()
        else if (phase === 'starting') voiceStopRequested.current = true
      }
    })
    /** The live session whose terminal has keyboard focus, when holding Space there may dictate. */
    const holdSpaceSession = (event: KeyboardEvent): string | null => {
      if (event.code !== 'Space' || !settingsRef.current.voice.holdSpaceToTalk || document.querySelector('dialog[open]')) return null
      const target = event.target instanceof HTMLElement ? event.target : null
      const sessionId = target?.closest('.terminal-surface')?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId
      return sessionId && liveRef.current.has(sessionId) ? sessionId : null
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (armedRef.current) {
        if (isModifierOnly(event)) return
        armedRef.current = false
        setArmed(false)
        return
      }
      if (spaceHold.keyDown(event, holdSpaceSession(event))) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const command = resolveShortcut(event)
      if (!command || document.querySelector('dialog[open]')) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const inTerminal = !!target?.closest('.terminal-surface')
      // Clipboard and select-all keys keep their text-field meaning outside the terminal.
      const textKey = command === 'copy' || command === 'paste' || command === 'select-all'
      if (textKey && !inTerminal && target?.matches('input, textarea, select')) return
      event.preventDefault()
      event.stopPropagation()
      commandRef.current(command)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!spaceHold.keyUp(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onBlur = (): void => spaceHold.blur()
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      stopStartup()
      stopOutput()
      stopExit()
      stopDisconnected()
      stopCapture()
      stopAppEvent()
      stopOpenSession()
      clearInterval(ticker)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      spaceHold.blur()
    }
  }, [])

  useEffect(
    () => applyChromeTheme(settings.appearance),
    [settings.appearance.identity, settings.appearance.colorMode]
  )

  useEffect(() => {
    if (!layout || layout.selectedSessionId || navigableSessionIds.length === 0) return
    const action = selectTreeSession(sessions, navigableSessionIds[0]!)
    if (action) {
      writer.apply(action.workspaceId, (state) => state.selectedSessionId ? state : action.change(state))
    }
  }, [activeWorkspaceId, sessions.length])

  useEffect(() => {
    if (panel !== 'details') setNewSessionSplit(false)
  }, [panel])

  const selectedSessionName = sessions.find((session) => session.sessionId === selectedSessionId)?.name ?? null
  useEffect(() => window.aiTerminal.reportSelectedSession(selectedSessionId), [selectedSessionId])
  useEffect(() => {
    document.title = windowTitle(activeWorkspace?.name ?? null, selectedSessionName)
  }, [activeWorkspace?.name, selectedSessionName])

  useEffect(() => {
    setBinding(undefined)
    setSavedOutput(undefined)
    if (!selectedSessionId) return
    void window.aiTerminal.getConversationBinding(selectedSessionId)
      .then(setBinding)
      .catch(fail('Binding unavailable'))
  }, [selectedSessionId])

  const applyTreeSessionAction = (action: TreeSessionAction | null): void => {
    if (!action) return
    setTree(action.tree)
    writer.apply(action.workspaceId, action.change)
  }

  const clearUnread = (sessionId: string): void => {
    setUnread((current) => {
      if (!current[sessionId]) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }

  const openSession = (sessionId: string): boolean => {
    const record = sessionsRef.current.find((session) => session.sessionId === sessionId)
    const workspace = record ? workspaces.find((item) => item.workspaceId === record.workspaceId) : undefined
    if (!record || record.archivedAt !== null || !workspace || workspace.archivedAt !== null) {
      brief('That session is unavailable. Refreshing attention items.')
      return false
    }
    setTree((current) => current.expandedWorkspaceIds.has(record.workspaceId)
      ? current
      : toggleWorkspaceExpanded(current, record.workspaceId))
    applyTreeSessionAction(selectTreeSession(sessionsRef.current, sessionId))
    setNeedsYouOpen(false)
    requestAnimationFrame(() => controllers.current.get(sessionId)?.focus())
    return true
  }
  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession

  const workspaceName = (workspaceId: string): string =>
    workspaces.find((item) => item.workspaceId === workspaceId)?.name ?? 'Unknown workspace'
  const place = (sessionId: string): { workspace: string; session: string } => {
    const record = sessions.find((session) => session.sessionId === sessionId)
    return { workspace: record ? workspaceName(record.workspaceId) : 'Unknown workspace', session: record?.name ?? 'Removed session' }
  }

  const updateWorkspace = async (
    workspace: WorkspaceRecord,
    change: Omit<Parameters<Window['aiTerminal']['updateWorkspace']>[0], 'workspaceId' | 'expectedRevision'>
  ): Promise<void> => {
    const updated = await window.aiTerminal.updateWorkspace({
      workspaceId: workspace.workspaceId,
      expectedRevision: workspace.revision,
      ...change
    })
    setWorkspaces((current) => current.map((item) => item.workspaceId === updated.workspaceId ? updated : item))
    if (change.archived === true) {
      const archivedSessionIds = new Set(
        sessionsRef.current
          .filter((session) => session.workspaceId === workspace.workspaceId)
          .map((session) => session.sessionId)
      )
      const knownSessionIds = sessionsRef.current.map((session) => session.sessionId)
      for (const workspaceId of Object.keys(writer.layouts())) {
        if (workspaceId === workspace.workspaceId) continue
        writer.apply(workspaceId, (state) => {
          let next = state
          for (const sessionId of archivedSessionIds) {
            next = closeLayoutPane(next, sessionId, knownSessionIds)
          }
          return next
        })
      }
    }
  }

  const moveWorkspace = (ordered: readonly WorkspaceRecord[], index: number, direction: -1 | 1): void => {
    const changes = adjacentPositionUpdates(ordered, index, direction)
    void Promise.all(changes.map(({ record, position }) => updateWorkspace(record, { position })))
      .catch(fail('Workspace move failed'))
  }

  const moveSession = async (records: readonly SessionRecord[], index: number, direction: -1 | 1): Promise<void> => {
    const changes = adjacentPositionUpdates(records, index, direction)
    const updated = await Promise.all(changes.map(({ record, position }) =>
      window.aiTerminal.updateSession({ sessionId: record.sessionId, expectedRevision: record.revision, position })
    ))
    const byId = new Map(updated.map((record) => [record.sessionId, record]))
    setSessions((current) => current.map((record) => byId.get(record.sessionId) ?? record))
  }

  /** Archive hides a stopped session and closes its pane; every record it owns is kept for Restore. */
  const archiveSession = async (record: SessionRecord, archived: boolean): Promise<void> => {
    const updated = await window.aiTerminal.updateSession({ sessionId: record.sessionId, expectedRevision: record.revision, archived })
    setSessions((current) => current.map((item) => item.sessionId === updated.sessionId ? updated : item))
    if (archived) {
      for (const workspaceId of Object.keys(writer.layouts())) {
        writer.apply(workspaceId, (state) =>
          closeLayoutPane(state, updated.sessionId, sessionsRef.current.map((session) => session.sessionId)))
      }
    }
    brief(archived ? `Archived ${updated.name}. Turn on Show archived to restore it.` : `Restored ${updated.name}.`)
  }

  const createWorkspace = async (name: string, directory: string): Promise<void> => {
    const created = await window.aiTerminal.createWorkspace({ name, defaultCwd: directory || null })
    const { layout: createdLayout } = await window.aiTerminal.getLayout(created.workspaceId)
    writer.adopt(createdLayout)
    setWorkspaces((current) => [...current, created])
    setLayouts((current) => ({ ...current, [created.workspaceId]: createdLayout }))
    setTree((current) => selectTreeWorkspace(current, created.workspaceId))
    beginNewSession(created)
  }

  const beginNewSession = (workspace: WorkspaceRecord | undefined, split = false): void => {
    if (workspace && workspace.workspaceId !== activeWorkspaceId) {
      setTree((current) => selectTreeWorkspace(current, workspace.workspaceId))
    }
    setEditingSessionId(undefined)
    setNewSessionSplit(split)
    setPickedTemplateId('')
    const recentCwd = sessions.findLast((session) => session.workspaceId === workspace?.workspaceId)?.cwd
    setSessionForm({ ...INITIAL_SESSION_FORM, cwd: workspace?.defaultCwd ?? recentCwd ?? home ?? INITIAL_SESSION_FORM.cwd })
    setFormError(undefined)
    setPanel('details')
  }

  const beginSessionEdit = (session: SessionRecord): void => {
    applyTreeSessionAction(selectTreeSession(sessions, session.sessionId))
    setEditingSessionId(session.sessionId)
    setNewSessionSplit(false)
    setPickedTemplateId('')
    setSessionForm(sessionLaunchForm(session))
    setFormError(undefined)
    setPanel('details')
  }

  const stopSession = (record: SessionRecord): void => {
    void window.aiTerminal.stopSession(record.sessionId).then(async () => {
      setLive((current) => {
        const next = { ...current }
        delete next[record.sessionId]
        return next
      })
      const refreshed = await window.aiTerminal.listSessions(record.workspaceId)
      const byId = new Map(refreshed.map((item) => [item.sessionId, item]))
      setSessions((current) => current.map((item) => byId.get(item.sessionId) ?? item))
      brief(`Stopped ${record.name}.`)
    }).catch(fail('Stop failed'))
  }

  const deliver = async (records: readonly ArtifactRecord[], sessionId: string): Promise<void> => {
    const paths: string[] = []
    for (const record of records) {
      const { path } = await window.aiTerminal.deliverArtifact(record.artifactId, sessionId)
      paths.push(path)
    }
    if (paths.length > 0) {
      brief(`Inserted ${paths.length === 1 ? records[0]!.originalName : `${paths.length} files`} into the terminal. Nothing was sent — press Enter when ready.`)
    }
    controllers.current.get(sessionId)?.focus()
  }

  const requireLive = (sessionId: string | null): string | null => {
    if (sessionId && live[sessionId]) return sessionId
    brief('Start the session before sending it files or pasted content.')
    return null
  }

  const attachFiles = (sessionId: string | null): void => {
    const target = requireLive(sessionId)
    if (!target) return
    void window.aiTerminal.attachFiles(target).then((records) => deliver(records, target)).catch(fail('Attach failed'))
  }

  const pasteImage = (sessionId: string | null): void => {
    const target = requireLive(sessionId)
    if (!target) return
    void window.aiTerminal.pasteImage(target).then((record) => {
      if (!record) {
        brief('The clipboard has no image.')
        return
      }
      return deliver([record], target)
    }).catch(fail('Paste image failed'))
  }

  const pasteClipboard = (sessionId: string | null): void => {
    const target = requireLive(sessionId)
    if (!target) return
    void window.aiTerminal.readClipboardText().then(async ({ text }) => {
      if (text) {
        controllers.current.get(target)?.paste(text)
        return
      }
      const record = await window.aiTerminal.pasteImage(target)
      if (record) await deliver([record], target)
      else brief('The clipboard is empty.')
    }).catch(fail('Paste failed'))
  }

  const updateVoice = (next: VoiceCapture | null): void => {
    voiceRef.current = next
    setVoice(next)
  }

  /** Stops the microphone, transcribes locally and pastes the text into the session it was recorded for. */
  const finishVoice = async (): Promise<void> => {
    const current = voiceRef.current
    const recording = voiceRecording.current
    if (current?.phase !== 'recording' || !recording) return
    clearTimeout(voiceTimer.current)
    voiceRecording.current = null
    updateVoice({ ...current, phase: 'transcribing' })
    try {
      const wav = await recording.stop()
      if (wav.byteLength < 44 + VOICE_SAMPLE_RATE * 2 * 0.3) {
        brief('The recording was too short.')
        return
      }
      const { text } = await window.aiTerminal.transcribeVoice({ wav, model: current.model, language: current.language })
      const controller = controllers.current.get(current.sessionId)
      if (!text) brief('No speech was recognized.')
      else if (!controller || !liveRef.current.has(current.sessionId)) brief('The session stopped before the transcript was ready.')
      else {
        controller.paste(text)
        controller.focus()
        announce('Transcript pasted. Press Enter to send it.')
      }
    } catch (error) {
      fail('Voice input failed')(error)
    } finally {
      updateVoice(null)
    }
  }
  const finishVoiceRef = useRef(finishVoice)
  finishVoiceRef.current = finishVoice

  const beginVoice = async (sessionId: string, trigger: VoiceCapture['trigger']): Promise<void> => {
    const { language } = settings.voice
    voiceStopRequested.current = false
    updateVoice({ sessionId, phase: 'starting', startedAt: Date.now(), model: settings.voice.model, language, trigger })
    try {
      const readiness = voiceReadiness(await window.aiTerminal.getVoiceStatus(), settings.voice.model)
      if (readiness.kind === 'engine-missing') {
        updateVoice(null)
        brief('The voice engine is not built. Run pnpm run voice:build, then rebuild the app.')
        return
      }
      if (readiness.kind === 'folder-unavailable') {
        updateVoice(null)
        setDialog({ kind: 'preferences' })
        brief(`The voice model folder ${readiness.path} is not available. Is its disk mounted?`)
        return
      }
      if (readiness.kind === 'downloading' || readiness.kind === 'no-model') {
        updateVoice(null)
        setDialog({ kind: 'preferences' })
        brief(readiness.kind === 'downloading'
          ? `${modelName(readiness.model)} is still downloading. Speak works when it finishes.`
          : 'Download a voice model in Preferences → Voice first.')
        return
      }
      const model = readiness.model.id
      if (readiness.replacesChoice) {
        void window.aiTerminal.putSettings('voice', { ...settings.voice, model }).then(setSettings).catch(fail('Voice model was not saved'))
      }
      voiceRecording.current = await startVoiceRecording()
      updateVoice({ sessionId, phase: 'recording', startedAt: Date.now(), model, language, trigger })
      const howToStop = trigger === 'hold' ? 'Release Space to stop.' : 'Press Speak again to stop.'
      announce(model === settings.voice.model
        ? `Listening. ${howToStop}`
        : `Listening with ${modelName(readiness.model)}, the downloaded model. ${howToStop}`)
      voiceTimer.current = setTimeout(() => void finishVoiceRef.current(), VOICE_MAX_SECONDS * 1000)
      if (voiceStopRequested.current) void finishVoiceRef.current()
    } catch (error) {
      updateVoice(null)
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'NotAllowedError') brief('Microphone access was refused.')
      else if (name === 'NotFoundError') brief('No microphone was found.')
      else fail('Could not start the microphone')(error)
    }
  }

  const toggleVoice = (sessionId: string | null): void => {
    const current = voiceRef.current
    if (current?.phase === 'recording') {
      void finishVoice()
      return
    }
    if (current) {
      brief(current.phase === 'transcribing' ? 'Still transcribing the last recording.' : 'The microphone is starting.')
      return
    }
    const target = sessionId && live[sessionId] ? sessionId : null
    if (!target) {
      brief('Start the session before dictating into it.')
      return
    }
    void beginVoice(target, 'toggle')
  }
  const beginVoiceRef = useRef(beginVoice)
  beginVoiceRef.current = beginVoice

  useEffect(() => () => {
    clearTimeout(voiceTimer.current)
    voiceRecording.current?.cancel()
  }, [])

  const copySelection = (sessionId: string | null): void => {
    const text = sessionId ? controllers.current.get(sessionId)?.selection() : ''
    if (!text) {
      brief('Select terminal text to copy.')
      return
    }
    void window.aiTerminal.writeClipboardText(text).then(() => announce('Copied selection.')).catch(fail('Copy failed'))
  }

  /** Split closes the other pane of a split, or asks which session opens beside this one. */
  const toggleSplit = (sessionId: string | null = selectedSessionId): void => {
    if (!layout || !activeWorkspaceId) return
    const panes = layout.split.panes
    if (panes.length >= 2) {
      const other = panes.find((pane) => pane.sessionId !== sessionId) ?? panes[1]
      if (other) writer.apply(activeWorkspaceId, (state) => closeLayoutPane(state, other.sessionId, allSessionIds))
      return
    }
    setDialog({ kind: 'split-picker', sessionId })
  }

  /** Opens the chosen session in the second pane and moves the keyboard there. */
  const splitWith = (sessionId: string): void => {
    const record = sessionsRef.current.find((session) => session.sessionId === sessionId)
    const workspace = record
      ? workspaces.find((candidate) => candidate.workspaceId === record.workspaceId)
      : undefined
    if (!record || record.archivedAt !== null || workspace?.archivedAt !== null || !activeWorkspaceId) {
      brief('That session no longer exists.')
      return
    }
    const target = writer.layouts()[activeWorkspaceId]
    if (!target) {
      brief('The current workspace layout is unavailable.')
      return
    }
    if (target.split.panes.length >= 2 && !target.split.panes.some((pane) => pane.sessionId === sessionId)) {
      brief('This workspace is already split. Close the split first.')
      return
    }
    writer.apply(activeWorkspaceId, (state) => splitLayoutSession(state, sessionId, allSessionIds))
    clearUnread(sessionId)
    requestAnimationFrame(() => controllers.current.get(sessionId)?.focus())
  }

  const splitPickerCommands = (sessionId: string | null): PaletteCommand[] => {
    const shown = new Set((layout?.split.panes ?? []).map((pane) => pane.sessionId))
    return [
      ...splitCandidates(splittableSessionIds, shown, sessionId).flatMap((id): PaletteCommand[] => {
        const record = sessions.find((session) => session.sessionId === id)
        return record ? [{
          id: `split-${id}`,
          group: 'Sessions',
          label: record.name,
          context: `${workspaceName(record.workspaceId)} · ${agentTag(record.executable)} · ${displayPath(record.cwd, home)} · ${live[id] ? 'running' : 'stopped'}`,
          run: () => splitWith(id)
        }] : []
      }),
      {
        id: 'split-new-session',
        group: 'Commands',
        label: 'New session beside…',
        context: activeWorkspace?.name,
        disabled: !activeWorkspace,
        run: () => beginNewSession(activeWorkspace, true)
      }
    ]
  }

  /** Selects a pane in the active composition without navigating to that session's own workspace. */
  const focusLayoutSession = (sessionId: string): void => {
    if (!activeWorkspaceId || !layout?.split.panes.some((pane) => pane.sessionId === sessionId)) return
    writer.apply(activeWorkspaceId, (state) => selectLayoutSession(state, sessionId, allSessionIds))
    clearUnread(sessionId)
    requestAnimationFrame(() => controllers.current.get(sessionId)?.focus())
  }

  /** Moves selection and the keyboard to the other pane of a split. */
  const focusOtherPane = (): void => {
    const other = layout?.split.panes.find((pane) => pane.sessionId !== selectedSessionId)
    if (!layout || layout.split.panes.length < 2 || !other) {
      brief('Split the view to switch panes.')
      return
    }
    focusLayoutSession(other.sessionId)
  }

  const splitBeside = (session: SessionRecord): void => {
    if (!activeWorkspaceId) return
    const sourceWorkspace = workspaces.find((workspace) => workspace.workspaceId === session.workspaceId)
    if (session.archivedAt !== null || sourceWorkspace?.archivedAt !== null) {
      brief('That session is archived.')
      return
    }
    writer.apply(activeWorkspaceId, (state) => {
      let next = state
      if (next.split.panes.length >= 2 && !next.split.panes.some((pane) => pane.sessionId === session.sessionId)) {
        const other = state.split.panes.find((pane) => pane.sessionId !== state.selectedSessionId)
        if (other) next = closeLayoutPane(next, other.sessionId, allSessionIds)
      }
      return splitLayoutSession(next, session.sessionId, allSessionIds)
    })
    clearUnread(session.sessionId)
    requestAnimationFrame(() => controllers.current.get(session.sessionId)?.focus())
  }

  const changeFontSize = (delta: number | null): void => {
    const current = settings.appearance.terminalFontSize
    const size = delta === null
      ? DEFAULT_APP_SETTINGS.appearance.terminalFontSize
      : Math.min(TERMINAL_FONT_SIZE_RANGE.max, Math.max(TERMINAL_FONT_SIZE_RANGE.min, current + delta))
    if (size === current) return
    changeAppearance({ terminalFontSize: size }, 'Font size was not saved')
    announce(`Terminal font ${size}`)
  }

  const changeAppearance = (change: Partial<AppearanceSettings>, failure: string): void => {
    const appearance = { ...settings.appearance, ...change }
    setSettings((value) => ({ ...value, appearance }))
    void window.aiTerminal.putSettings('appearance', appearance).then(setSettings).catch(fail(failure))
  }

  const answerByTyping = (sessionId: string): void => {
    for (const request of requestsAnsweredByTyping(attention, sessionId)) {
      if (answering.current.has(request.requestId)) continue
      answering.current.add(request.requestId)
      // The agent's own hook may close the request first, which leaves nothing to do.
      void window.aiTerminal.resolveAttention(request.requestId, 'Answered in the terminal')
        .catch(() => undefined)
        .then(() => refresh.attention())
        .catch(() => undefined)
        .finally(() => answering.current.delete(request.requestId))
    }
  }

  const recordAttentionOpened = (request: AttentionRecord): void => {
    const opening = attentionActionWhenOpened(request)
    if (!opening) return
    const action = opening === 'resolve-notice'
      ? window.aiTerminal.resolveAttention(request.requestId, 'Opened in BMN', {
          kind: request.kind,
          revision: request.revision
        })
      : window.aiTerminal.markAttentionSeen(request.requestId)
    void action
      .catch((error: unknown) => {
        // A notice can be resolved by its producing hook between render and activation.
        if (opening !== 'resolve-notice') fail('Request update failed')(error)
      })
      .then(() => refresh.attention())
      .catch(fail('Attention refresh failed'))
  }

  const nextNeedingYou = (): void => {
    const request = nextRequest(attention, selectedSessionId)
    if (!request) {
      brief('None waiting.')
      return
    }
    if (!openSession(request.sessionId)) {
      void refresh.attention().catch(fail('Attention refresh failed'))
      return
    }
    recordAttentionOpened(request)
    const where = place(request.sessionId)
    announce(`${where.workspace}, ${where.session}: ${request.title}`)
  }

  const runCommand = (command: AppCommand): void => {
    const controller = selectedSessionId ? controllers.current.get(selectedSessionId) : undefined
    switch (command) {
      case 'workspace-previous':
      case 'workspace-next': {
        const ids = visibleWorkspaces(workspaces, false).map((item) => item.workspaceId)
        const next = neighbor(ids, activeWorkspaceId, command === 'workspace-next' ? 1 : -1)
        if (next) {
          setTree((current) => selectTreeWorkspace(current, next))
          announce(workspaceName(next))
        }
        return
      }
      case 'session-previous':
      case 'session-next': {
        const next = neighbor(navigableSessionIds, selectedSessionId, command === 'session-next' ? 1 : -1)
        if (next) openSession(next)
        return
      }
      case 'attention-next': return nextNeedingYou()
      case 'palette': return setDialog({ kind: 'palette' })
      case 'copy': return copySelection(selectedSessionId)
      case 'paste': return pasteClipboard(selectedSessionId)
      case 'select-all':
        if (controller) controller.selectAll()
        else brief('Select all needs a running terminal.')
        return
      case 'search':
        if (controller) controller.openSearch()
        else brief('Search needs a running terminal.')
        return
      case 'split-toggle': return toggleSplit()
      case 'pane-other': return focusOtherPane()
      case 'focus-toggle': return setFocusMode((value) => !value)
      case 'font-increase': return changeFontSize(1)
      case 'font-decrease': return changeFontSize(-1)
      case 'font-reset': return changeFontSize(null)
      case 'send-next-key':
        armedRef.current = true
        setArmed(true)
        announce('Next key goes to the terminal.')
        controller?.focus()
        return
      case 'voice-toggle': return toggleVoice(selectedSessionId)
    }
  }
  commandRef.current = runCommand

  const openMenu = (element: HTMLElement, label: string, entries: MenuEntry[]): void => {
    setMenu((current) => current?.element === element ? null : { element, label, entries })
  }

  const sessionMenuEntries = (session: SessionRecord, index: number, siblings: readonly SessionRecord[]): MenuEntry[] => session.archivedAt ? [
    { label: 'Session details', onSelect: () => { applyTreeSessionAction(selectTreeSession(sessions, session.sessionId)); setPanel('details') } },
    'separator',
    { label: 'Restore session', onSelect: () => void archiveSession(session, false).catch(fail('Session restore failed')) }
  ] : [
    { label: 'Split beside', onSelect: () => splitBeside(session), shortcut: SHORTCUT_LABELS['split-toggle'] },
    { label: 'Session details', onSelect: () => { applyTreeSessionAction(selectTreeSession(sessions, session.sessionId)); setPanel('details') } },
    { label: 'Edit launch settings', onSelect: () => beginSessionEdit(session) },
    { label: 'Move up', disabled: index === 0, onSelect: () => void moveSession(siblings, index, -1).catch(fail('Session move failed')) },
    { label: 'Move down', disabled: index === siblings.length - 1, onSelect: () => void moveSession(siblings, index, 1).catch(fail('Session move failed')) },
    'separator',
    live[session.sessionId]
      ? { label: 'Stop session…', danger: true, onSelect: () => setDialog({ kind: 'stop', session }) }
      : { label: 'Start again', disabled: !!session.launchDisabledReason, title: session.launchDisabledReason ?? undefined, onSelect: () => relaunchSession(session) },
    live[session.sessionId]
      ? { label: 'Archive session', disabled: true, title: 'Stop the session before archiving it', onSelect: () => undefined }
      : { label: 'Archive session', onSelect: () => void archiveSession(session, true).catch(fail('Session archive failed')) }
  ]

  const paneMenuEntries = (session: SessionRecord): MenuEntry[] => [
    { label: 'Session details', onSelect: () => setPanel('details') },
    { label: 'Search output', shortcut: SHORTCUT_LABELS.search, onSelect: () => controllers.current.get(session.sessionId)?.openSearch() },
    { label: 'Copy selection', shortcut: SHORTCUT_LABELS.copy, onSelect: () => copySelection(session.sessionId) },
    { label: 'Paste', shortcut: SHORTCUT_LABELS.paste, onSelect: () => pasteClipboard(session.sessionId) },
    { label: 'Select all', shortcut: SHORTCUT_LABELS['select-all'], onSelect: () => controllers.current.get(session.sessionId)?.selectAll() },
    { label: 'Send next key to terminal', shortcut: SHORTCUT_LABELS['send-next-key'], onSelect: () => runCommand('send-next-key') },
    {
      label: layout?.split.orientation === 'stacked' ? 'Arrange side by side' : 'Arrange stacked',
      disabled: (layout?.split.panes.length ?? 0) < 2,
      onSelect: () => {
        if (!activeWorkspaceId) return
        writer.apply(activeWorkspaceId, (state) =>
          setLayoutOrientation(state, state.split.orientation === 'stacked' ? 'side-by-side' : 'stacked', allSessionIds))
      }
    },
    { label: 'New session in this workspace', onSelect: () => beginNewSession(activeWorkspace) },
    { label: 'Edit launch settings', onSelect: () => beginSessionEdit(session) },
    'separator',
    { label: 'Stop session…', danger: true, onSelect: () => setDialog({ kind: 'stop', session }) }
  ]

  const workspaceMenuEntries = (workspace: WorkspaceRecord, index: number, ordered: readonly WorkspaceRecord[]): MenuEntry[] => [
    { label: 'New session here', onSelect: () => beginNewSession(workspace) },
    { label: 'Rename…', onSelect: () => setDialog({ kind: 'rename-workspace', workspace }) },
    { label: 'Move up', disabled: index === 0, onSelect: () => moveWorkspace(ordered, index, -1) },
    { label: 'Move down', disabled: index === ordered.length - 1, onSelect: () => moveWorkspace(ordered, index, 1) },
    'separator',
    {
      label: workspace.archivedAt ? 'Restore workspace' : 'Archive workspace',
      onSelect: () => void updateWorkspace(workspace, { archived: workspace.archivedAt === null }).catch(fail('Workspace update failed'))
    }
  ]

  const paletteCommands = (): PaletteCommand[] => {
    const shown = visibleWorkspaces(workspaces, false)
    const selectedRecord = sessions.find((session) => session.sessionId === selectedSessionId)
    const command = (id: string, label: string, run: () => void, extra: Partial<PaletteCommand> = {}): PaletteCommand =>
      ({ id, group: 'Commands', label, run, ...extra })
    return [
      ...shown.flatMap((workspace) => visibleWorkspaceSessions(sessions, workspace.workspaceId, false).map((session): PaletteCommand => ({
        id: `session-${session.sessionId}`,
        group: 'Sessions',
        label: session.name,
        context: `${workspace.name} · ${agentTag(session.executable)} · ${displayPath(session.cwd, home)}`,
        run: () => openSession(session.sessionId)
      }))),
      ...shown.map((workspace): PaletteCommand => ({
        id: `workspace-${workspace.workspaceId}`,
        group: 'Workspaces',
        label: workspace.name,
        context: ((count) => `${count} ${count === 1 ? 'session' : 'sessions'}`)(visibleWorkspaceSessions(sessions, workspace.workspaceId, false).length),
        run: () => setTree((current) => selectTreeWorkspace(current, workspace.workspaceId))
      })),
      command('next-attention', 'Go to next request needing you', nextNeedingYou, { shortcut: SHORTCUT_LABELS['attention-next'], context: `${unresolved.length} waiting` }),
      command('new-workspace', 'New workspace…', () => setDialog({ kind: 'new-workspace' })),
      command('new-session', 'New session…', () => beginNewSession(activeWorkspace), { disabled: !activeWorkspace, context: activeWorkspace?.name }),
      command('split', (layout?.split.panes.length ?? 0) >= 2 ? 'Close split' : 'Split view…', () => toggleSplit(), { shortcut: SHORTCUT_LABELS['split-toggle'] }),
      command('pane-other', 'Switch to other pane', focusOtherPane, { shortcut: SHORTCUT_LABELS['pane-other'], disabled: (layout?.split.panes.length ?? 0) < 2 }),
      command('focus', focusMode ? 'Leave focus mode' : 'Focus mode', () => setFocusMode((value) => !value), { shortcut: SHORTCUT_LABELS['focus-toggle'] }),
      command('search', 'Search terminal output', () => runCommand('search'), { shortcut: SHORTCUT_LABELS.search, disabled: !selectedSessionId || !live[selectedSessionId] }),
      command('files', panel === 'files' ? 'Close files' : 'Show files', () => setPanel(panel === 'files' ? null : 'files')),
      command('details', 'Session details', () => setPanel('details'), { disabled: !selectedRecord }),
      command('attach', 'Attach files to terminal…', () => attachFiles(selectedSessionId), { context: selectedRecord?.name, disabled: !selectedSessionId || !live[selectedSessionId] }),
      command('paste-image', 'Paste image into terminal', () => pasteImage(selectedSessionId), { context: selectedRecord?.name, disabled: !selectedSessionId || !live[selectedSessionId] }),
      command('voice', voice?.phase === 'recording' ? 'Stop dictation and paste' : 'Dictate into terminal', () => toggleVoice(selectedSessionId), {
        shortcut: SHORTCUT_LABELS['voice-toggle'],
        context: selectedRecord?.name,
        disabled: voice?.phase !== 'recording' && (!selectedSessionId || !live[selectedSessionId])
      }),
      command('send-next-key', 'Send next key to terminal', () => runCommand('send-next-key'), { shortcut: SHORTCUT_LABELS['send-next-key'] }),
      command('font-increase', 'Increase terminal font', () => changeFontSize(1), { shortcut: SHORTCUT_LABELS['font-increase'] }),
      command('font-decrease', 'Decrease terminal font', () => changeFontSize(-1), { shortcut: SHORTCUT_LABELS['font-decrease'] }),
      command('font-reset', 'Reset terminal font', () => changeFontSize(null), { shortcut: SHORTCUT_LABELS['font-reset'] }),
      ...IDENTITY_NAMES.filter((identity) => identity !== settings.appearance.identity).map((identity) =>
        command(`identity-${identity}`, `Switch to ${IDENTITY_PRESENTATION[identity].label} identity`, () =>
          changeAppearance({ identity }, 'Identity was not saved'))),
      ...COLOR_MODE_NAMES.filter((colorMode) => colorMode !== settings.appearance.colorMode).map((colorMode) =>
        command(`color-mode-${colorMode}`, `Switch to ${COLOR_MODE_PRESENTATION[colorMode].label} color mode`, () =>
          changeAppearance({ colorMode }, 'Color mode was not saved'))),
      command('preferences', 'Preferences…', () => setDialog({ kind: 'preferences' })),
      command('stop', 'Stop session…', () => selectedRecord && setDialog({ kind: 'stop', session: selectedRecord }), {
        context: selectedRecord?.name,
        disabled: !selectedRecord || !live[selectedRecord.sessionId]
      }),
      command('quit', 'Quit BMN…', () => void window.aiTerminal.quitApplication())
    ]
  }

  const bindingPresentation = conversationBindingPresentation(binding)
  const identity = IDENTITY_PRESENTATION[settings.appearance.identity]
  const selectedRecord = sessions.find((session) => session.sessionId === selectedSessionId)
  const observedProgressFor = (session: SessionRecord): ProgressPresentation | null => progressPresentation(
    progress,
    session.sessionId,
    now,
    live[session.sessionId]?.incarnationId ?? session.lastProcess?.incarnationId
  )
  const selectedProgress = selectedRecord ? observedProgressFor(selectedRecord) : null
  const panes = layout?.split.panes ?? []
  const orientation = layout?.split.orientation ?? 'side-by-side'
  const unreadEntries: UnreadEntry[] = Object.entries(unread)
    .filter(([sessionId]) => sessionId !== selectedSessionId)
    .map(([sessionId, at]) => ({ sessionId, reason: 'New output', at }))
  const firstRatio = dragRatio ?? panes[0]?.ratio ?? 1
  /** Stopped sessions keep their pane's place and share of a split. */
  const paneStyle = (sessionId: string): React.CSSProperties => {
    const index = panes.findIndex((pane) => pane.sessionId === sessionId)
    if (panes.length < 2 || index === -1) return { order: 0 }
    return { order: index * 2, flexGrow: index === 0 ? firstRatio : 1 - firstRatio }
  }

  const commitRatio = (ratio: number): void => {
    if (!activeWorkspaceId) return
    writer.apply(activeWorkspaceId, (state) => resizeLayoutSplit(state, ratio, allSessionIds))
  }

  const pointerRatio = (event: React.PointerEvent): number | null => {
    const rect = sessionArea.current?.getBoundingClientRect()
    if (!rect) return null
    return orientation === 'stacked'
      ? (event.clientY - rect.top) / rect.height
      : (event.clientX - rect.left) / rect.width
  }

  return (
    <main className="shell-window workspace-shell">
      <header className="app-header">
        <div className="identity">
          <Icon name={identity.icon} size={18} />
          <span className="motto">{identity.motto}</span>
        </div>
        <nav className="breadcrumb" aria-label="Current location">
          {activeWorkspace ? (
            <>
              <span>{activeWorkspace.name}</span>
              <span className="separator" aria-hidden="true">›</span>
              <strong>{selectedRecord?.name ?? 'No session selected'}</strong>
            </>
          ) : <span>Create a workspace.</span>}
        </nav>
        <div className="header-actions">
          <button
            ref={needsYouButton}
            type="button"
            className="needs-you-button"
            data-has-items={unresolved.length > 0}
            aria-haspopup="dialog"
            aria-expanded={needsYouOpen}
            title={`Needs you (${SHORTCUT_LABELS['attention-next']} jumps to the next)`}
            onClick={() => setNeedsYouOpen((value) => !value)}
          >
            <Icon name="bell" /><span>Needs you</span><span className="count">{unresolved.length}</span>
          </button>
          <button type="button" className="icon-button" aria-label="Command palette" title={`Command palette (${SHORTCUT_LABELS.palette})`} onClick={() => setDialog({ kind: 'palette' })}>
            <Icon name="search" />
          </button>
          <button type="button" className="icon-button" aria-label="Preferences" title="Preferences" onClick={() => setDialog({ kind: 'preferences' })}>
            <Icon name="gear" />
          </button>
        </div>
        {needsYouOpen ? (
          <NeedsYouPopover
            requests={attention}
            unread={unreadEntries}
            place={place}
            now={now}
            anchor={needsYouButton.current}
            onOpenSession={(sessionId, request) => {
              if (!openSession(sessionId)) {
                void refresh.attention().catch(fail('Attention refresh failed'))
                return
              }
              if (request) recordAttentionOpened(request)
            }}
            onAcknowledge={(request) => {
              const action = request.kind === 'notice'
                ? window.aiTerminal.resolveAttention(request.requestId, 'Dismissed in BMN', {
                    kind: request.kind,
                    revision: request.revision
                  })
                : window.aiTerminal.markAttentionSeen(request.requestId)
              void action.then(() => refresh.attention()).catch(fail('Request update failed'))
            }}
            onMarkAnswered={(request) => {
              void window.aiTerminal.resolveAttention(request.requestId, 'Answered in the terminal')
                .then(() => refresh.attention())
                .catch(fail('Request update failed'))
            }}
            onClose={() => {
              setNeedsYouOpen(false)
              needsYouButton.current?.focus()
            }}
          />
        ) : null}
      </header>
      {failure ? (
        <div className="feedback-notice" role="status">
          <span>{failure}</span>
          <button type="button" className="icon-button" aria-label="Dismiss notice" onClick={() => setFailure(undefined)}><Icon name="close" /></button>
        </div>
      ) : null}
      {notice ? <div className="feedback-notice brief"><span>{notice}</span></div> : null}
      <div className={`workspace-body${panel ? ' with-panel' : ''}${focusMode ? ' focus-mode' : ''}`}>
        {focusMode ? null : (
          <aside className="workspace-sidebar" aria-label="Workspaces and sessions">
            <nav className="workspace-tree">
              {visibleWorkspaces(workspaces, tree.showArchived).map((workspace, workspaceIndex, ordered) => {
                const workspaceSessions = visibleWorkspaceSessions(sessions, workspace.workspaceId, tree.showArchived)
                const isExpanded = tree.expandedWorkspaceIds.has(workspace.workspaceId)
                return (
                  <section key={workspace.workspaceId} className="workspace-group" aria-label={workspace.name}>
                    <div className={`workspace-row${workspace.archivedAt ? ' archived' : ''}`}>
                      <button type="button" aria-expanded={isExpanded} onClick={() => {
                        setTree((current) => toggleWorkspaceExpanded(current, workspace.workspaceId))
                      }}>
                        <span className="eyebrow">{workspace.name}</span>
                        <span className="count">{workspaceSessions.length}</span>
                      </button>
                      <button
                        type="button"
                        className="row-menu-button"
                        aria-haspopup="menu"
                        aria-expanded={menu?.label === `${workspace.name} actions`}
                        aria-label={`Actions for ${workspace.name}`}
                        onClick={(event) => openMenu(event.currentTarget, `${workspace.name} actions`, workspaceMenuEntries(workspace, workspaceIndex, ordered))}
                      >⋯</button>
                    </div>
                    {isExpanded ? workspaceSessions.map((session, sessionIndex) => {
                      const observedProgress = observedProgressFor(session)
                      const status = sessionStatus(session, !!live[session.sessionId], unresolved, observedProgress)
                      const selected = session.sessionId === selectedSessionId
                      return (
                        <div className={`session-row${selected ? ' selected' : ''}${session.archivedAt ? ' archived' : ''}`} key={session.sessionId}>
                          <button
                            type="button"
                            data-session-id={session.sessionId}
                            aria-current={selected ? 'true' : undefined}
                            title={`${session.name} · ${status.word} · ${session.cwd}`}
                            onClick={() => {
                              applyTreeSessionAction(selectTreeSession(sessions, session.sessionId))
                              clearUnread(session.sessionId)
                            }}
                          >
                            <span className={`status-dot ${status.dot}`} role="img" aria-label={status.word} />
                            <span className="session-name">{session.name}</span>
                            <span className="chip">{agentTag(session.executable)}</span>
                            <span className="session-directory">{displayPath(session.cwd, home)}</span>
                          </button>
                          {unread[session.sessionId] && !selected ? <span className="unread-mark" title="New output">new</span> : null}
                          <button
                            type="button"
                            className="row-menu-button"
                            aria-haspopup="menu"
                            aria-label={`Actions for ${session.name}`}
                            onClick={(event) => openMenu(event.currentTarget, `${session.name} actions`, sessionMenuEntries(session, sessionIndex, workspaceSessions))}
                          >⋯</button>
                        </div>
                      )
                    }) : null}
                  </section>
                )
              })}
            </nav>
            <div className="sidebar-footer">
              <label className="show-archived">
                <input type="checkbox" checked={tree.showArchived} onChange={() => setTree(toggleShowArchived)} /> Show archived
              </label>
              <button type="button" className="new-workspace" onClick={() => setDialog({ kind: 'new-workspace' })}>+ New workspace</button>
            </div>
          </aside>
        )}
        <section ref={sessionArea} className={`session-area ${orientation}${panes.length > 1 ? ' split' : ''}`} aria-label="Sessions">
          {Object.values(live).map((terminalStartup) => {
            const paneIndex = panes.findIndex((pane) => pane.sessionId === terminalStartup.sessionId)
            const record = sessions.find((session) => session.sessionId === terminalStartup.sessionId)
            const ratio = panes.length > 1 ? (paneIndex === 0 ? firstRatio : 1 - firstRatio) : 1
            return (
              <SessionTerminal
                key={terminalStartup.attachmentId}
                startup={terminalStartup}
                record={record}
                visible={paneIndex !== -1}
                selected={selectedSessionId === terminalStartup.sessionId}
                order={Math.max(0, paneIndex) * 2}
                ratio={ratio}
                split={panes.length > 1}
                focusMode={focusMode}
                filesOpen={panel === 'files'}
                attention={sessionAttention(unresolved, terminalStartup.sessionId)}
                onAnswer={() => answerByTyping(terminalStartup.sessionId)}
                armed={armed}
                progress={progressPresentation(progress, terminalStartup.sessionId, now, terminalStartup.incarnationId)}
                colorMode={settings.appearance.colorMode}
                fontSize={settings.appearance.terminalFontSize}
                view={() => sessionLayoutView(writer.layouts(), sessionsRef.current, terminalStartup.sessionId)}
                testMode={startup?.testMode === true}
                register={(sessionId, controller) => {
                  if (controller) controllers.current.set(sessionId, controller)
                  else controllers.current.delete(sessionId)
                }}
                onView={(update) => applySessionView(writer, sessionsRef.current, terminalStartup.sessionId, update)}
                onFailure={setFailure}
                onSelect={() => focusLayoutSession(terminalStartup.sessionId)}
                onSplit={() => toggleSplit(terminalStartup.sessionId)}
                onFocusMode={() => setFocusMode((value) => !value)}
                onFiles={() => setPanel((value) => value === 'files' ? null : 'files')}
                onMore={(anchor) => record && openMenu(anchor, `${record.name} actions`, paneMenuEntries(record))}
                onAttach={() => attachFiles(terminalStartup.sessionId)}
                onPasteImage={() => pasteImage(terminalStartup.sessionId)}
                onPaste={() => pasteClipboard(terminalStartup.sessionId)}
                voice={voice?.sessionId === terminalStartup.sessionId ? voice : null}
                voiceBusy={!!voice && voice.sessionId !== terminalStartup.sessionId}
                onSpeak={() => toggleVoice(terminalStartup.sessionId)}
                onDropFiles={(files) => {
                  void window.aiTerminal.attachDroppedFiles(terminalStartup.sessionId, files)
                    .then((records) => deliver(records, terminalStartup.sessionId))
                    .catch(fail('Drop failed'))
                }}
              />
            )
          })}
          {panes.length > 1 ? (
            <div
              className="split-handle"
              role="separator"
              tabIndex={0}
              aria-label="Resize panes"
              aria-orientation={orientation === 'stacked' ? 'horizontal' : 'vertical'}
              aria-valuemin={15}
              aria-valuemax={85}
              aria-valuenow={Math.round(firstRatio * 100)}
              style={{ order: 1 }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                setDragRatio(pointerRatio(event))
              }}
              onPointerMove={(event) => {
                if (dragRatio === null) return
                const ratio = pointerRatio(event)
                if (ratio !== null) setDragRatio(Math.min(0.85, Math.max(0.15, ratio)))
              }}
              onPointerUp={(event) => {
                const ratio = pointerRatio(event) ?? dragRatio
                setDragRatio(null)
                if (ratio !== null) commitRatio(ratio)
              }}
              onKeyDown={(event) => {
                const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05
                  : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 0.05 : 0
                if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  commitRatio(event.key === 'Home' ? 0.15 : 0.85)
                } else if (step !== 0) {
                  event.preventDefault()
                  commitRatio(firstRatio + step)
                }
              }}
            />
          ) : null}
          {selectedRecord && !live[selectedRecord.sessionId] ? (
            <section className="stopped-session" style={paneStyle(selectedRecord.sessionId)}>
              <span className="eyebrow">{workspaceName(selectedRecord.workspaceId)} · {agentTag(selectedRecord.executable)}</span>
              <h2>{selectedRecord.name}</h2>
              <p>{sessionProcessLabel(selectedRecord.lastProcess)} · {selectedRecord.cwd}</p>
              <ProgressSummary progress={selectedProgress} />
              <div className="actions">
                {bindingPresentation.canResume ? (
                  <button type="button" className="primary" disabled={!!selectedRecord.launchDisabledReason} title={selectedRecord.launchDisabledReason}
                    onClick={() => resumeSession(selectedRecord)}>Resume</button>
                ) : null}
                <button type="button" className={bindingPresentation.canResume ? undefined : 'primary'}
                  disabled={!!selectedRecord.launchDisabledReason} title={selectedRecord.launchDisabledReason ?? 'Run the saved command again in a new process'}
                  onClick={() => relaunchSession(selectedRecord)}>Start again</button>
                <button type="button" onClick={() => {
                  void loadSavedOutputPresentation(() => window.aiTerminal.getSavedOutput(selectedRecord.sessionId))
                    .then(setSavedOutput)
                    .catch(fail('Saved output unavailable'))
                }}>Saved output</button>
                <button type="button" className="ghost" onClick={() => setPanel('details')}>Session details</button>
              </div>
              {savedOutput ? <pre className="saved-output-summary">{savedOutput.current?.content ?? savedOutput.history[0]?.content ?? 'No saved output has been captured for this session.'}</pre> : null}
            </section>
          ) : null}
          {panes.length > 1 ? panes
            .filter((pane) => pane.sessionId !== selectedSessionId && !live[pane.sessionId])
            .map((pane) => {
              const record = sessions.find((session) => session.sessionId === pane.sessionId)
              if (!record) return null
              return (
                <section key={pane.sessionId} className="stopped-pane" style={paneStyle(pane.sessionId)}>
                  <strong>{record.name}</strong>
                  <p>{sessionProcessLabel(record.lastProcess)}</p>
                  <ProgressSummary progress={observedProgressFor(record)} />
                  <button type="button" onClick={() => focusLayoutSession(record.sessionId)}>Show session</button>
                </section>
              )
            }) : null}
          {!selectedRecord ? (
            <div className="empty-state">
              {activeWorkspace ? (
                <>
                  <h1>Add a session.</h1>
                  <p>Start an agent or shell in {activeWorkspace.name} with an installed command and a working directory.</p>
                  <div className="actions"><button type="button" className="primary" onClick={() => beginNewSession(activeWorkspace)}>New session</button></div>
                </>
              ) : (
                <>
                  <h1>Create a workspace.</h1>
                  <p>Name a workspace, then add an installed command and working directory.</p>
                  <div className="actions"><button type="button" className="primary" onClick={() => setDialog({ kind: 'new-workspace' })}>+ New workspace</button></div>
                </>
              )}
            </div>
          ) : null}
          {selectedSessionId && unread[selectedSessionId] && live[selectedSessionId] ? (
            <button type="button" className="new-output" onClick={() => {
              const controller = controllers.current.get(selectedSessionId)
              if (!controller) return
              applySessionView(writer, sessions, selectedSessionId, { kind: 'follow-tail' })
              controller.scrollToBottom()
              clearUnread(selectedSessionId)
            }}>New output ↓</button>
          ) : null}
        </section>
        {panel === 'files' ? (
          <div className="side-panel">
            <FilesPanel
              session={selectedRecord ?? null}
              sessionLabel={selectedRecord ? `${workspaceName(selectedRecord.workspaceId)} › ${selectedRecord.name}` : 'No session selected'}
              sessionLive={!!selectedSessionId && !!live[selectedSessionId]}
              sessionIncarnationId={selectedSessionId ? live[selectedSessionId]?.incarnationId ?? null : null}
              artifacts={artifacts}
              drafts={drafts}
              sessions={sessions}
              workspaces={workspaces}
              onOpenSession={openSession}
              onRefreshDrafts={refresh.drafts}
              onClose={() => setPanel(null)}
              onFailure={setFailure}
              onNotice={brief}
            />
          </div>
        ) : null}
        {panel === 'details' ? (
          <aside className="session-inspector side-panel" aria-label="Selected session actions">
            <div className="panel-heading">
              <span className="eyebrow">Session details</span>
              <button type="button" className="icon-button" aria-label="Close session details" onClick={() => setPanel(null)}><Icon name="close" /></button>
            </div>
            {selectedRecord ? (
              <>
                <h2>{selectedRecord.name}</h2>
                <div className="binding">
                  <p>{bindingPresentation.label}</p>
                  <small>{bindingPresentation.detail}</small>
                </div>
                <ProgressSummary progress={selectedProgress} />
                {selectedRecord.launchDisabledReason ? (
                  <p className="inline-error" role="status">
                    Launch unavailable: {selectedRecord.launchDisabledReason}
                  </p>
                ) : null}
                <div className="actions">
                  {bindingPresentation.canResume ? <button type="button" onClick={() => resumeSession(selectedRecord)} disabled={!!selectedRecord.launchDisabledReason}
                    title={selectedRecord.launchDisabledReason}>Resume</button> : null}
                  {bindingPresentation.canLocate && binding && binding.agentCli !== 'other' ? (
                    <button type="button" onClick={() => setDialog({ kind: 'locate', session: selectedRecord, binding })}>Locate chat</button>
                  ) : null}
                  {!live[selectedRecord.sessionId] ? (
                    <button type="button" disabled={!!selectedRecord.launchDisabledReason}
                      title={selectedRecord.launchDisabledReason ?? 'Run the saved command again in a new process'}
                      onClick={() => relaunchSession(selectedRecord)}>Start again</button>
                  ) : null}
                  {bindingPresentation.canStartNew && binding?.agentCli !== 'other' ? <button type="button"
                    title="Forget the stored conversation so this session no longer resumes it" onClick={() => {
                    void window.aiTerminal.startNewConversation(selectedRecord.sessionId)
                      .then(() => window.aiTerminal.getConversationBinding(selectedRecord.sessionId))
                      .then(setBinding)
                      .catch(fail('Request failed'))
                  }}>Start new</button> : null}
                  {live[selectedRecord.sessionId] ? (
                    <button type="button" className="ghost" onClick={() => setDialog({ kind: 'stop', session: selectedRecord })}>Stop…</button>
                  ) : null}
                </div>
              </>
            ) : null}
            {activeWorkspaceId ? (
              <form className="create-form" onSubmit={(event) => {
                event.preventDefault()
                setFormError(undefined)
                void (async () => {
                  try {
                    if (editingSessionId) {
                      const current = sessions.find((session) => session.sessionId === editingSessionId)
                      if (!current) throw new Error('The session being edited no longer exists')
                      const updated = await window.aiTerminal.updateSession(sessionUpdateParams(current, sessionForm))
                      setSessions((records) => records.map((record) =>
                        record.sessionId === updated.sessionId ? updated : record
                      ))
                      setEditingSessionId(undefined)
                      brief(`Saved ${updated.name}.`)
                      return
                    }
                    const created = await window.aiTerminal.createSession(
                      sessionCreateParams(activeWorkspaceId, sessionForm, { cols: 80, rows: 24 })
                    )
                    setSessions((current) => [...current, created.session])
                    setLive((current) => ({ ...current, [created.session.sessionId]: created.startup }))
                    const withCreated = [...sessions, created.session]
                    const beside = newSessionSplit && (writer.layouts()[activeWorkspaceId]?.split.panes.length ?? 0) < 2
                    applyTreeSessionAction(beside
                      ? splitTreeSession(withCreated, created.session.sessionId)
                      : selectTreeSession(withCreated, created.session.sessionId))
                    setNewSessionSplit(false)
                    setPanel(null)
                    brief(`Started ${created.session.name}.`)
                  } catch (error) {
                    const message = failureDetail(error, 'Session request failed')
                    if (/directory|cwd/i.test(message)) setFormError(message)
                    else setFailure(message)
                  }
                })()
              }}>
                <strong>{editingSessionId
                  ? 'Edit session'
                  : `New ${newSessionSplit ? 'split ' : ''}session in ${activeWorkspace?.name ?? 'workspace'}`}</strong>
                <label>Template
                  <select aria-label="Launch template" value={pickedTemplateId} onChange={(event) => {
                    const id = event.target.value
                    const template = templates.find((item) => item.templateId === id)
                    if (template?.launchDisabledReason) {
                      event.currentTarget.value = ''
                      setPickedTemplateId('')
                      return
                    }
                    setPickedTemplateId(id)
                    setSessionForm((current) => applyLaunchTemplate(current, template))
                  }}><option value="">No template</option>{templates.map((template) => (
                    <option
                      key={template.templateId}
                      value={template.templateId}
                      disabled={!!template.launchDisabledReason}
                      title={template.launchDisabledReason}
                    >
                      {template.name}{template.launchDisabledReason ? ' — unavailable' : ''}
                    </option>
                  ))}</select>
                </label>
                <label>Name
                  <input aria-label="Session name" value={sessionForm.name} onChange={(event) => {
                    const name = event.target.value
                    setSessionForm((current) => ({ ...current, name }))
                  }} />
                </label>
                <label>Command
                  <input aria-label="Executable" className="mono" value={sessionForm.executable} onChange={(event) => {
                    const executable = event.target.value
                    setSessionForm((current) => ({ ...current, executable }))
                  }} />
                </label>
                <label>Arguments
                  <input aria-label="Arguments" className="mono" value={sessionForm.argv} onChange={(event) => {
                    const argv = event.target.value
                    setSessionForm((current) => ({ ...current, argv }))
                  }} />
                </label>
                <label>Working directory
                  <input aria-label="Working directory" className="mono" value={sessionForm.cwd} onChange={(event) => {
                    const cwd = event.target.value
                    setSessionForm((current) => ({ ...current, cwd }))
                  }} />
                </label>
                <label>When windows close
                  <select aria-label="When windows close" value={sessionForm.backgroundChoice ?? ''} onChange={(event) => {
                    const value = event.target.value
                    const backgroundChoice = value === 'hide' || value === 'stop' ? value : null
                    setSessionForm((current) => ({ ...current, backgroundChoice }))
                  }}>{BACKGROUND_CHOICE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                </label>
                {formError ? <span className="inline-error" role="alert">{formError}</span> : null}
                <div className="actions">
                  <button type="submit" className="primary">{editingSessionId ? 'Save session' : 'Create session'}</button>
                  {editingSessionId ? <button type="button" className="ghost" onClick={() => {
                    setEditingSessionId(undefined)
                    setFormError(undefined)
                  }}>Cancel edit</button> : null}
                </div>
              </form>
            ) : null}
          </aside>
        ) : null}
      </div>
      <div className="live-announcer" aria-live="polite">{announcement}</div>
      {menu ? <PopupMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {dialog?.kind === 'palette' ? <CommandPalette commands={paletteCommands()} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'split-picker' ? (
        <CommandPalette
          label="Split with"
          searchLabel="Choose the session for the second pane"
          placeholder="Open beside this pane…"
          commands={splitPickerCommands(dialog.sessionId)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'preferences' ? (
        <PreferencesDialog settings={settings} onSettings={setSettings} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'new-workspace' ? (
        <WorkspaceDialog mode="create" initialName="" onClose={() => setDialog(null)}
          onSubmit={({ name, directory }) => createWorkspace(name, directory).catch((error: unknown) => {
            throw new Error(failureDetail(error, 'Workspace request failed'), { cause: error })
          })} />
      ) : null}
      {dialog?.kind === 'rename-workspace' ? (
        <WorkspaceDialog mode="rename" initialName={dialog.workspace.name} onClose={() => setDialog(null)}
          onSubmit={({ name }) => updateWorkspace(dialog.workspace, { name }).catch((error: unknown) => {
            throw new Error(failureDetail(error, 'Rename failed'), { cause: error })
          })} />
      ) : null}
      {dialog?.kind === 'locate' ? (
        <ConversationReferenceDialog sessionName={dialog.session.name} onClose={() => setDialog(null)} onSubmit={async (reference) => {
          const current = dialog.binding
          if (current.agentCli === 'other') throw new Error('This session is not an agent with resumable conversations')
          const replacement: ExplicitConversationBinding = {
            sessionId: dialog.session.sessionId,
            agentCli: current.agentCli,
            status: 'bound',
            conversationReference: reference,
            captureRoute: 'explicit-resume-reference',
            launchContext: current.launchContext,
            detail: 'Conversation reference selected explicitly',
            capturedAt: new Date().toISOString()
          }
          try {
            setBinding(await window.aiTerminal.locateConversation(replacement))
          } catch (error) {
            throw new Error(failureDetail(error, 'Locate failed'), { cause: error })
          }
        }} />
      ) : null}
      {dialog?.kind === 'stop' ? (
        <ConfirmDialog
          label="Stop session"
          message={`Stop ${dialog.session.name} in ${workspaceName(dialog.session.workspaceId)}? The process ends; saved output and the session stay.`}
          confirmLabel="Stop session"
          onConfirm={() => stopSession(dialog.session)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </main>
  )

  function resumeSession(record: SessionRecord): void {
    void window.aiTerminal.resumeConversation(record.sessionId).then((next) => {
      setLive((current) => ({ ...current, [next.sessionId]: next }))
      setFailure(undefined)
    }).catch(fail('Resume failed'))
  }

  function relaunchSession(record: SessionRecord): void {
    void window.aiTerminal.relaunchSession(record.sessionId).then((next) => {
      setLive((current) => ({ ...current, [next.sessionId]: next }))
      setSavedOutput(undefined)
      setFailure(undefined)
      brief(`Started ${record.name} again.`)
    }).catch(fail('Start again failed'))
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('renderer root is missing')
createRoot(root).render(<App />)
