// MODULE: preferences-dialog.tsx - owner-facing preferences: a left navigation over pages for the team, the rules, appearance, terminal, notifications, voice, Telegram, local control, history and backup
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AppearanceSettings,
  AppSettings,
  BackupExportResult,
  BackupVerifyResult,
  ControlInfo,
  NotificationSettings,
  TerminalSettings,
  TelegramStatus,
  VoiceSettings
} from '@bmn/protocol'
import { COLOR_MODE_NAMES, DEFAULT_APP_SETTINGS, DEFAULT_TELEGRAM_HEALTH_ALERTS, DEFAULT_TELEGRAM_QUIET_HOURS, DEFAULT_TELEGRAM_MORNING_DIGEST, HEALTH_LIMITS, IDENTITY_NAMES, TERMINAL_FONT_SIZE_RANGE, type AttentionKind } from '@bmn/protocol'
import { Icon } from './icons'
import { COLOR_MODE_PRESENTATION, IDENTITY_PRESENTATION } from './theme'
import { VoicePreferences } from './voice-preferences'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import { HistoryPreferences } from './history-preferences'
import { useResearchState } from './models-preferences'
import { TeamLedger, TeamPreferences, TeamToast, type TeamPage } from './team-preferences'
import { useTeamState } from './team-state'
import { SELF_REFRESH_MS, useSelfRefresh } from './self-refresh'
import { RulesPreferences, useRulesState, type RecognisedSessions } from './rules-preferences'
import type { RunInSession } from './session-command'
import type { ReportedModel } from './model-suggestions'
import { Dot, RulesIcon, TeamIcon } from './roster-marks'
import { parseTelegramForm, type TelegramFormFields } from './telegram-form'
import './preferences-dialog.css'

const DEFAULT_FONT_SIZE = DEFAULT_APP_SETTINGS.appearance.terminalFontSize

function clampFontSize(value: number): number {
  const rounded = Math.round(value)
  return Math.min(TERMINAL_FONT_SIZE_RANGE.max, Math.max(TERMINAL_FONT_SIZE_RANGE.min, rounded))
}

function idText(value: number | null): string {
  return value === null ? '' : String(value)
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

const BACKUP_FAILURE_WORDS: Record<BackupVerifyResult['failures'][number]['reason'], string> = {
  'missing': 'missing from the copy',
  'hash-mismatch': 'differs from what was written',
  'unreadable-manifest': 'cannot be read',
  'unreadable-database': 'cannot be read as a database',
  'not-in-manifest': 'is in the database but not in the manifest',
  'database-mismatch': 'does not match the backup database'
}

/** What an export wrote and what the check of the copy found, said at once (Story 75.7). */
export function BackupOutcome(props: { result: BackupExportResult }): React.JSX.Element {
  const { directory, manifest, verification } = props.result
  const excluded = manifest.excluded.length > 0 ? <> Not included: {manifest.excluded.join(', ')}.</> : null
  if (verification.ok) {
    return (
      <p className="preferences-success" role="status">
        Exported to {directory}: database plus {pluralize(manifest.artifacts.length, 'artifact')} · verified, {pluralize(verification.checked, 'file')} checked.{excluded}
      </p>
    )
  }
  return (
    <div className="preferences-error" role="alert">
      <p>Exported to {directory}, but the copy failed its check; keep the earlier backup and export again.</p>
      <ul>
        {verification.failures.map((failure) => <li key={`${failure.file}:${failure.reason}`}>{failure.file}: {BACKUP_FAILURE_WORDS[failure.reason]}</li>)}
      </ul>
    </div>
  )
}

const USAGE_LINES = [
  'bmn progress running "Story 2.2" --source epic-auto',
  'bmn ask pick-db "Which database?" --body "…"',
  'bmn publish ./report.png',
  'bmn send --submit -- "continue"'
]

const TEST_MESSAGE_DISABLED_TITLE = 'Send a test message once Telegram is connected and polling'

/**
 * Request kinds quiet hours can let through, in display order; the stored values stay lowercase. A handoff
 * delivers itself to its agent (Story 75.5), so a stored "handoff" is kept but no longer offered.
 */
const QUIET_ALLOW_KINDS: ReadonlyArray<{ kind: AttentionKind; label: string }> = [
  { kind: 'permission', label: 'Permission' },
  { kind: 'question', label: 'Question' },
  { kind: 'review', label: 'Review' },
  { kind: 'notice', label: 'Notice' }
]

/** Every page of the dialog. Team and Rules head the navigation and open their sub-pages; the rest are grouped. */
export type PreferencesPage = 'team' | 'roles' | 'asks' | 'models' | 'changes' | 'rules' | 'skills' | 'tools' | 'health' | 'appearance' | 'terminal' | 'notifications' | 'voice' | 'telegram' | 'control' | 'history' | 'backup'

/** The page Preferences last showed, kept while BMN runs; a new start opens on Team. */
let lastPage: PreferencesPage = 'team'

export const PREFERENCES_NAVIGATION: ReadonlyArray<
  | { parent: 'team' | 'rules'; label: string; pages: ReadonlyArray<{ page: PreferencesPage; label: string }> }
  | { group: string; pages: ReadonlyArray<{ page: PreferencesPage; label: string }> }
> = [
  { parent: 'team', label: 'Team', pages: [{ page: 'team', label: 'Agents' }, { page: 'roles', label: 'Roles' }, { page: 'asks', label: 'Asks' }, { page: 'models', label: 'Models' }, { page: 'changes', label: 'Changes' }] },
  { parent: 'rules', label: 'Rules', pages: [{ page: 'rules', label: 'Editor' }, { page: 'skills', label: 'Skills' }, { page: 'tools', label: 'Tools' }, { page: 'health', label: 'Health' }] },
  { group: 'Workspace', pages: [{ page: 'appearance', label: 'Appearance' }, { page: 'terminal', label: 'Terminal' }, { page: 'notifications', label: 'Notifications' }, { page: 'voice', label: 'Voice' }] },
  { group: 'Phone', pages: [{ page: 'telegram', label: 'Telegram' }] },
  { group: 'Machine', pages: [{ page: 'control', label: 'Local control' }, { page: 'history', label: 'History' }, { page: 'backup', label: 'Backup' }] }
]

/** The navigation parent a page sits under, or null for a grouped page. */
export function pageParent(page: PreferencesPage): 'team' | 'rules' | null {
  return page === 'team' || page === 'roles' || page === 'asks' || page === 'models' || page === 'changes' ? 'team' : page === 'rules' || page === 'skills' || page === 'tools' || page === 'health' ? 'rules' : null
}

/**
 * Telegram's status as a list. An error is said once: in the cue while it shows, otherwise in full under Last error;
 * State then gives only its word.
 */
export function TelegramStatusList(props: { status: TelegramStatus; cueShown: boolean }): React.JSX.Element {
  const status = props.status
  return (
    <dl className="kv telegram-status" aria-label="Telegram status">
      <dt>State</dt>
      <dd>{status.lastError === null ? `${status.state} · ${status.detail}` : status.state}</dd>
      <dt>Token</dt>
      <dd className={status.tokenMask ? undefined : 'none'}>{status.tokenMask ?? 'not set'}</dd>
      <dt>Last poll</dt>
      <dd className={status.lastPollAt ? undefined : 'none'}>{status.lastPollAt ? new Date(status.lastPollAt).toLocaleString() : 'never'}</dd>
      <dt>Last error</dt>
      {props.cueShown && status.lastError
        ? <dd className="none">shown above</dd>
        : <dd className={status.lastError ? 'error' : 'none'}>{status.lastError ?? 'none'}</dd>}
      <dt>Rejected updates</dt>
      <dd>{status.rejectedUpdates}</dd>
    </dl>
  )
}

export function PreferencesDialog(props: {
  settings: AppSettings
  /** The page to open on; otherwise the last one shown. */
  initialPage?: PreferencesPage | undefined
  onSettings(next: AppSettings): void
  onClose(): void
  /** Saves the voice section through the app's queue, built from the latest settings. */
  saveVoice(change: (current: VoiceSettings) => VoiceSettings): Promise<AppSettings>
  /** Candidate dictation words from the selected live session, or why there are none. */
  suggestVocabulary(): { ok: true; words: string[] } | { ok: false; reason: string }
  /** Why the gear shows a dot for Telegram, or null. */
  telegramCue?: string | null
  /** The model names apps reported in sessions that are running now; the Team pages offer them. */
  reportedModels?: readonly ReportedModel[]
  /** How many running sessions BMN recognises as each app; Rules › Health says it beside an update. */
  recognisedSessions?: RecognisedSessions
  /** The name a session has now; Team › Models says who asked a web question by it. */
  sessionName?(id: string): string | undefined
  /** Opens a new shell session and runs a command there; Rules › Health offers it for an app's update command. */
  onRunInSession?: RunInSession | undefined
}): React.JSX.Element {
  const onSettings = useRef(props.onSettings)
  onSettings.current = props.onSettings

  // --- Pages ---------------------------------------------------------------
  // Preferences opens where the owner left it, unless it was opened for one page.
  const [page, setPage] = useState<PreferencesPage>(props.initialPage ?? lastPage)
  useEffect(() => { lastPage = page }, [page])
  // An agent and New agent open under Team › Agents, never as navigation items.
  const [teamPage, setTeamPage] = useState<TeamPage>({ name: 'agents' })
  const team = useTeamState()
  const rules = useRulesState()
  const research = useResearchState()
  const main = useRef<HTMLElement | null>(null)
  const parent = pageParent(page)
  // What each app may read, and which app versions count as accepted, follow the approved team.
  const approvedVersion = team.snapshot?.approved?.generation ?? null
  const refreshRules = rules.refresh
  useEffect(() => refreshRules(), [approvedVersion, refreshRules])

  function go(next: PreferencesPage): void {
    setPage(next)
    if (next === 'team') setTeamPage({ name: 'agents' })
    main.current?.scrollTo({ top: 0 })
  }

  function goTeam(next: TeamPage): void {
    setTeamPage(next)
    setPage(next.name === 'roles' ? 'roles' : next.name === 'asks' ? 'asks' : next.name === 'models' ? 'models' : next.name === 'changes' ? 'changes' : 'team')
    main.current?.scrollTo({ top: 0 })
  }

  const shownTeamPage: TeamPage = page === 'roles' ? { name: 'roles' } : page === 'asks' ? { name: 'asks' } : page === 'models' ? { name: 'models' } : page === 'changes' ? { name: 'changes' } : teamPage
  // An agent's app or host is recorded as BMN inspected that app, so the pages that stage one read the apps once.
  const stagesDestination = parent === 'team' && (shownTeamPage.name === 'agent' || shownTeamPage.name === 'new')
  const ensureRules = rules.ensure
  useEffect(() => { if (stagesDestination) ensureRules() }, [stagesDestination, ensureRules])
  // The same pages offer the names research found; reading them asks no app anything.
  const peekResearch = research.peek
  const ensureResearch = research.ensure
  const startsAgent = parent === 'team' && shownTeamPage.name === 'new'
  // New agent offers Look up, which needs to know who may research.
  useEffect(() => { if (startsAgent) ensureResearch(approvedVersion); else if (stagesDestination) peekResearch() }, [startsAgent, stagesDestination, ensureResearch, peekResearch, approvedVersion])
  const rulesNeedOwner = (rules.snapshot?.health.state === 'checked' && rules.snapshot.master.exists && rules.snapshot.health.targets.some((target) => target.state !== 'current'))
    || (rules.snapshot?.skills.pending ?? 0) > 0 || (rules.snapshot?.skills.exposed ?? 0) > 0
    || (rules.snapshot?.tools.pending ?? 0) > 0 || (rules.snapshot?.tools.exposed ?? 0) > 0
  // Staged edits are approved from the footer on the pages that stage them; New agent has its own.
  const ledger = (parent === 'team' && shownTeamPage.name !== 'new') || page === 'health' || page === 'skills' || page === 'tools'
  const pageOf = (id: PreferencesPage, children: ReactNode): React.JSX.Element => <div className="preferences-page" hidden={page !== id}>{children}</div>

  // --- Appearance ---------------------------------------------------------
  const [appearance, setAppearance] = useState<AppearanceSettings>(props.settings.appearance)
  const [appearanceBusy, setAppearanceBusy] = useState(false)
  const [appearanceError, setAppearanceError] = useState<string | null>(null)

  async function saveAppearance(next: AppearanceSettings): Promise<void> {
    const previous = appearance
    setAppearance(next)
    setAppearanceBusy(true)
    setAppearanceError(null)
    try {
      const result = await window.aiTerminal.putSettings('appearance', next)
      setAppearance(result.appearance)
      onSettings.current(result)
    } catch (error) {
      setAppearance(previous)
      setAppearanceError(failureDetail(error, 'Could not save appearance settings'))
    } finally {
      setAppearanceBusy(false)
    }
  }

  function onFontSizeInput(raw: string): void {
    if (raw.trim().length === 0) return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    void saveAppearance({ ...appearance, terminalFontSize: clampFontSize(parsed) })
  }

  // --- Notifications -------------------------------------------------------
  const [notifications, setNotifications] = useState<NotificationSettings>(props.settings.notifications)
  const [notificationsBusy, setNotificationsBusy] = useState(false)
  const [notificationsError, setNotificationsError] = useState<string | null>(null)

  async function saveNotifications(next: NotificationSettings): Promise<void> {
    const previous = notifications
    setNotifications(next)
    setNotificationsBusy(true)
    setNotificationsError(null)
    try {
      const result = await window.aiTerminal.putSettings('notifications', next)
      setNotifications(result.notifications)
      onSettings.current(result)
    } catch (error) {
      setNotifications(previous)
      setNotificationsError(failureDetail(error, 'Could not save notification settings'))
    } finally {
      setNotificationsBusy(false)
    }
  }

  // --- Terminal ---------------------------------------------------------
  const [terminal, setTerminal] = useState<TerminalSettings>(props.settings.terminal)
  const [terminalBusy, setTerminalBusy] = useState(false)
  const [terminalError, setTerminalError] = useState<string | null>(null)

  async function saveTerminal(next: TerminalSettings): Promise<void> {
    const previous = terminal
    setTerminal(next)
    setTerminalBusy(true)
    setTerminalError(null)
    try {
      const result = await window.aiTerminal.putSettings('terminal', next)
      setTerminal(result.terminal)
      onSettings.current(result)
    } catch (error) {
      setTerminal(previous)
      setTerminalError(failureDetail(error, 'Could not save terminal settings'))
    } finally {
      setTerminalBusy(false)
    }
  }

  // --- Telegram: status ------------------------------------------------
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null)
  const [telegramStatusBusy, setTelegramStatusBusy] = useState(false)
  const [telegramStatusError, setTelegramStatusError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setTelegramStatusBusy(true)
    window.aiTerminal
      .getTelegramStatus()
      .then((status) => {
        if (!cancelled) setTelegramStatus(status)
      })
      .catch((error: unknown) => {
        if (!cancelled) setTelegramStatusError(failureDetail(error, 'Could not load Telegram status'))
      })
      .finally(() => {
        if (!cancelled) setTelegramStatusBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function refreshTelegramStatus(): Promise<void> {
    setTelegramStatusBusy(true)
    setTelegramStatusError(null)
    try {
      setTelegramStatus(await window.aiTerminal.getTelegramStatus())
    } catch (error) {
      setTelegramStatusError(failureDetail(error, 'Could not load Telegram status'))
    } finally {
      setTelegramStatusBusy(false)
    }
  }
  // Story 75.7: the status reads itself again while the Telegram page is on screen: when BMN says Telegram changed, when
  // the window comes back and every 30 s for the polling line. It is never a press, and it never touches the form.
  useSelfRefresh(refreshTelegramStatus, { topics: ['telegram'], everyMs: SELF_REFRESH_MS, shown: () => page === 'telegram' })

  // --- Telegram: token ---------------------------------------------------
  const [tokenInput, setTokenInput] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [tokenSuccess, setTokenSuccess] = useState<string | null>(null)

  async function configureToken(token: string | null): Promise<void> {
    setTokenBusy(true)
    setTokenError(null)
    setTokenSuccess(null)
    try {
      const status = await window.aiTerminal.configureTelegram(token)
      setTelegramStatus(status)
      setTokenInput('')
      setTokenSuccess(token === null ? 'Token removed.' : 'Token saved.')
    } catch (error) {
      setTokenError(failureDetail(error, 'Could not save the bot token'))
    } finally {
      setTokenBusy(false)
    }
  }

  // --- Telegram: form (chat/user id, notifyOn, autoSubmitReplies, answerPermissions, enabled) ---
  const [chatIdInput, setChatIdInput] = useState(idText(props.settings.telegram.allowedChatId))
  const [userIdInput, setUserIdInput] = useState(idText(props.settings.telegram.allowedUserId))
  const [notifyOn, setNotifyOn] = useState(props.settings.telegram.notifyOn)
  const [autoSubmitReplies, setAutoSubmitReplies] = useState(props.settings.telegram.autoSubmitReplies)
  const [answerPermissions, setAnswerPermissions] = useState(props.settings.telegram.answerPermissions)
  const [telegramEnabled, setTelegramEnabled] = useState(props.settings.telegram.enabled)
  const [quietHours, setQuietHours] = useState(props.settings.telegram.quietHours ?? DEFAULT_TELEGRAM_QUIET_HOURS)
  const [morningDigest, setMorningDigest] = useState(props.settings.telegram.morningDigest ?? DEFAULT_TELEGRAM_MORNING_DIGEST)
  const [healthAlerts, setHealthAlerts] = useState(props.settings.telegram.healthAlerts ?? DEFAULT_TELEGRAM_HEALTH_ALERTS)
  // The watch saves itself as off at its switch-off time; an open dialog follows, so a later Save keeps it off.
  const savedHealthEnabled = props.settings.telegram.healthAlerts?.enabled ?? false
  const savedHealthOffAt = props.settings.telegram.healthAlerts?.offAt ?? null
  useEffect(() => {
    setHealthAlerts({ enabled: savedHealthEnabled, offAt: savedHealthOffAt })
  }, [savedHealthEnabled, savedHealthOffAt])
  const [telegramFormBusy, setTelegramFormBusy] = useState(false)
  const [telegramFormError, setTelegramFormError] = useState<string | null>(null)
  const [telegramFormSuccess, setTelegramFormSuccess] = useState<string | null>(null)

  async function saveTelegramForm(): Promise<void> {
    const fields: TelegramFormFields = {
      enabled: telegramEnabled,
      allowedChatId: chatIdInput,
      allowedUserId: userIdInput,
      notifyOn,
      autoSubmitReplies,
      answerPermissions,
      quietHours,
      morningDigest,
      healthAlerts
    }
    const parsed = parseTelegramForm(fields)
    if (!parsed.ok) {
      setTelegramFormError(parsed.message)
      setTelegramFormSuccess(null)
      return
    }
    setTelegramFormBusy(true)
    setTelegramFormError(null)
    setTelegramFormSuccess(null)
    try {
      const result = await window.aiTerminal.putSettings('telegram', parsed.value)
      setChatIdInput(idText(result.telegram.allowedChatId))
      setUserIdInput(idText(result.telegram.allowedUserId))
      setNotifyOn(result.telegram.notifyOn)
      setAutoSubmitReplies(result.telegram.autoSubmitReplies)
      setAnswerPermissions(result.telegram.answerPermissions)
      setTelegramEnabled(result.telegram.enabled)
      setQuietHours(result.telegram.quietHours ?? DEFAULT_TELEGRAM_QUIET_HOURS)
      setMorningDigest(result.telegram.morningDigest ?? DEFAULT_TELEGRAM_MORNING_DIGEST)
      setHealthAlerts(result.telegram.healthAlerts ?? DEFAULT_TELEGRAM_HEALTH_ALERTS)
      onSettings.current(result)
      setTelegramFormSuccess('Telegram settings saved.')
      void refreshTelegramStatus()
    } catch (error) {
      setTelegramFormError(failureDetail(error, 'Could not save Telegram settings'))
    } finally {
      setTelegramFormBusy(false)
    }
  }

  // --- Telegram: test message ---------------------------------------------
  const [testBusy, setTestBusy] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testSuccess, setTestSuccess] = useState<string | null>(null)
  const canSendTest = telegramStatus?.state === 'polling'

  async function sendTest(): Promise<void> {
    setTestBusy(true)
    setTestError(null)
    setTestSuccess(null)
    try {
      const status = await window.aiTerminal.testTelegram()
      setTelegramStatus(status)
      setTestSuccess('Test message sent.')
    } catch (error) {
      setTestError(failureDetail(error, 'Could not send the test message'))
    } finally {
      setTestBusy(false)
    }
  }

  const [healthTestBusy, setHealthTestBusy] = useState(false)
  const [healthTestError, setHealthTestError] = useState<string | null>(null)
  const [healthTestSuccess, setHealthTestSuccess] = useState<string | null>(null)

  async function sendHealthTest(): Promise<void> {
    setHealthTestBusy(true)
    setHealthTestError(null)
    setHealthTestSuccess(null)
    try {
      setTelegramStatus(await window.aiTerminal.testHealthAlerts())
      setHealthTestSuccess('Test sent with the current readings.')
    } catch (error) {
      setHealthTestError(failureDetail(error, 'Could not send the health test'))
    } finally {
      setHealthTestBusy(false)
    }
  }

  // --- Local agent control -------------------------------------------------
  const [controlInfo, setControlInfo] = useState<ControlInfo | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [copying, setCopying] = useState<'socket' | 'cli' | null>(null)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.aiTerminal
      .getControlInfo()
      .then((info) => {
        if (!cancelled) setControlInfo(info)
      })
      .catch((error: unknown) => {
        if (!cancelled) setControlError(failureDetail(error, 'Could not load agent control info'))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function copyText(kind: 'socket' | 'cli', text: string): Promise<void> {
    setCopying(kind)
    setCopyError(null)
    setCopyMessage(null)
    try {
      await window.aiTerminal.writeClipboardText(text)
      setCopyMessage(kind === 'socket' ? 'Socket path copied.' : 'CLI path copied.')
    } catch (error) {
      setCopyError(failureDetail(error, 'Could not copy to the clipboard'))
    } finally {
      setCopying(null)
    }
  }

  // --- Backup ---------------------------------------------------------------
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportResult, setExportResult] = useState<BackupExportResult | null>(null)

  async function runExportBackup(): Promise<void> {
    setExportBusy(true)
    setExportError(null)
    try {
      const outcome = await window.aiTerminal.exportBackup()
      if (outcome) setExportResult(outcome)
    } catch (error) {
      setExportError(failureDetail(error, 'Could not export the backup'))
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <Dialog label="Preferences" className="preferences-dialog" onClose={props.onClose}>
      <div className="preferences-frame">
      <nav className="preferences-nav" aria-label="Preference pages">
        {PREFERENCES_NAVIGATION.map((entry) => 'parent' in entry ? (
          <div key={entry.parent} className="nav-parent">
            <button type="button" className="nav-item" aria-current={parent === entry.parent ? 'true' : undefined} aria-expanded={parent === entry.parent}
              onClick={() => go(entry.parent)}>
              {entry.parent === 'team' ? <TeamIcon /> : <RulesIcon />}{entry.label}
              {(entry.parent === 'team' ? team.needsOwner : rulesNeedOwner) ? <Dot label="Needs you" /> : null}
            </button>
            {parent === entry.parent ? (
              <div className="nav-sub">
                {entry.pages.map((item) => (
                  <button key={item.page} type="button" className="nav-item" aria-current={page === item.page ? 'page' : undefined} onClick={() => go(item.page)}>{item.label}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div key={entry.group} className="nav-group" role="group" aria-label={entry.group}>
            <span className="nav-head" aria-hidden="true">{entry.group}</span>
            {entry.pages.map((item) => (
              <button key={item.page} type="button" className="nav-item" aria-current={page === item.page ? 'page' : undefined} onClick={() => go(item.page)}>{item.label}</button>
            ))}
          </div>
        ))}
      </nav>
      <main className="preferences-main" ref={main}>
      {parent === 'team' ? <div className="preferences-page team-page"><TeamPreferences team={team} page={shownTeamPage} apps={rules.snapshot?.apps ?? null} context={rules.snapshot?.context ?? null} reported={props.reportedModels ?? []} research={research} {...(props.sessionName ? { sessionName: props.sessionName } : {})} go={goTeam} /></div> : null}
      {parent === 'rules' ? <div className="preferences-page rules-page"><RulesPreferences rules={rules} team={team} page={page === 'health' ? 'health' : page === 'skills' ? 'skills' : page === 'tools' ? 'tools' : 'editor'} recognised={props.recognisedSessions ?? {}} onRunInSession={props.onRunInSession} /></div> : null}
      {pageOf('appearance', <>
      <section className="preferences-section">
        <h3>Appearance</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Identity</span>
          </div>
          <div className="preferences-row-control preferences-identities" role="radiogroup" aria-label="Identity">
            {IDENTITY_NAMES.map((identity) => (
              <label className="preferences-radio" key={identity}>
                <input
                  type="radio"
                  name="preferences-identity"
                  checked={appearance.identity === identity}
                  disabled={appearanceBusy}
                  onChange={() => void saveAppearance({ ...appearance, identity })}
                />
                <Icon name={IDENTITY_PRESENTATION[identity].icon} size={14} />
                {IDENTITY_PRESENTATION[identity].label} ({IDENTITY_PRESENTATION[identity].motto})
              </label>
            ))}
          </div>
        </div>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Color mode</span>
          </div>
          <div className="preferences-row-control" role="radiogroup" aria-label="Color mode">
            {COLOR_MODE_NAMES.map((colorMode) => (
              <label className="preferences-radio" key={colorMode}>
                <input
                  type="radio"
                  name="preferences-color-mode"
                  checked={appearance.colorMode === colorMode}
                  disabled={appearanceBusy}
                  onChange={() => void saveAppearance({ ...appearance, colorMode })}
                />
                {COLOR_MODE_PRESENTATION[colorMode].label} ({COLOR_MODE_PRESENTATION[colorMode].description})
              </label>
            ))}
          </div>
        </div>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Terminal font size</span>
          </div>
          <div className="preferences-row-control">
            <div className="preferences-font-size">
              <button
                type="button"
                className="icon-button"
                aria-label="Decrease terminal font size"
                disabled={appearanceBusy || appearance.terminalFontSize <= TERMINAL_FONT_SIZE_RANGE.min}
                onClick={() => void saveAppearance({ ...appearance, terminalFontSize: clampFontSize(appearance.terminalFontSize - 1) })}
              >
                −
              </button>
              <input
                type="number"
                aria-label="Terminal font size"
                min={TERMINAL_FONT_SIZE_RANGE.min}
                max={TERMINAL_FONT_SIZE_RANGE.max}
                value={appearance.terminalFontSize}
                disabled={appearanceBusy}
                onChange={(event) => onFontSizeInput(event.target.value)}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Increase terminal font size"
                disabled={appearanceBusy || appearance.terminalFontSize >= TERMINAL_FONT_SIZE_RANGE.max}
                onClick={() => void saveAppearance({ ...appearance, terminalFontSize: clampFontSize(appearance.terminalFontSize + 1) })}
              >
                +
              </button>
              <button
                type="button"
                disabled={appearanceBusy || appearance.terminalFontSize === DEFAULT_FONT_SIZE}
                onClick={() => void saveAppearance({ ...appearance, terminalFontSize: DEFAULT_FONT_SIZE })}
              >
                Reset
              </button>
              <span className="preferences-help">{TERMINAL_FONT_SIZE_RANGE.min}–{TERMINAL_FONT_SIZE_RANGE.max}px</span>
            </div>
            <div className="preferences-font-preview" style={{ fontFamily: 'var(--font-mono)', fontSize: `${appearance.terminalFontSize}px` }}>
              Ґґ Єє Іі Її — Hello, terminal ─┼─ ✓
            </div>
          </div>
        </div>
        {appearanceError && (
          <p className="preferences-error" role="alert">
            {appearanceError}
          </p>
        )}
      </section>
      </>)}

      {pageOf('terminal', <>
      <section className="preferences-section">
        <h3>Terminal</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Clipboard</span>
          </div>
          <div className="preferences-row-control">
            <label className="preferences-radio">
              <input
                id="preferences-program-clipboard"
                type="checkbox"
                checked={terminal.programClipboard}
                disabled={terminalBusy}
                onChange={(event) => void saveTerminal({ programClipboard: event.target.checked })}
              />
              Let programs copy to the clipboard
            </label>
            <p className="preferences-help">tmux, Neovim or SSH can copy; no program can read it.</p>
          </div>
        </div>
        {terminalError && (
          <p className="preferences-error" role="alert">
            {terminalError}
          </p>
        )}
      </section>
      </>)}

      {pageOf('notifications', <>
      <section className="preferences-section">
        <h3>Notifications</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-desktop-notifications">Desktop notifications</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-desktop-notifications"
              type="checkbox"
              checked={notifications.desktop}
              disabled={notificationsBusy}
              onChange={(event) => void saveNotifications({ desktop: event.target.checked })}
            />
            <p className="preferences-help">When a session needs you and no BMN window is focused.</p>
          </div>
        </div>
        {notificationsError && (
          <p className="preferences-error" role="alert">
            {notificationsError}
          </p>
        )}
      </section>
      </>)}

      {pageOf('voice', <VoicePreferences settings={props.settings.voice} save={props.saveVoice} suggest={props.suggestVocabulary} />)}

      {pageOf('telegram', <>
      <section className="preferences-section">
        <div className="preferences-section-head">
          <h3>Telegram</h3>
        </div>
        {props.telegramCue ? (
          <div className="history-confirm telegram-cue" role="status">
            <span className="status-dot needs-you" aria-hidden="true" />
            <p>{props.telegramCue}</p>
          </div>
        ) : null}
        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-enabled">Enabled</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-enabled"
              type="checkbox"
              checked={telegramEnabled}
              disabled={telegramFormBusy}
              onChange={(event) => setTelegramEnabled(event.target.checked)}
            />
          </div>
        </div>
        {telegramStatus ? (
          <TelegramStatusList status={telegramStatus} cueShown={!!props.telegramCue} />
        ) : (
          !telegramStatusBusy && <p className="preferences-help">Status unavailable.</p>
        )}
        {telegramStatusError && (
          <p className="preferences-error" role="alert">
            {telegramStatusError}
          </p>
        )}

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-token">Bot token</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-token"
              type="password"
              autoComplete="off"
              value={tokenInput}
              disabled={tokenBusy}
              onChange={(event) => setTokenInput(event.target.value)}
            />
            <div className="preferences-button-row">
              <button type="button" disabled={tokenBusy || tokenInput.trim().length === 0} onClick={() => void configureToken(tokenInput.trim())}>
                {tokenBusy ? 'Saving…' : 'Save token'}
              </button>
              <button type="button" disabled={tokenBusy} onClick={() => void configureToken(null)}>
                Remove token
              </button>
            </div>
          </div>
        </div>
        {tokenError && (
          <p className="preferences-error" role="alert">
            {tokenError}
          </p>
        )}
        {tokenSuccess && (
          <p className="preferences-success" role="status">
            {tokenSuccess}
          </p>
        )}

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-chat-id">Allowed chat ID</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-chat-id"
              type="text"
              inputMode="numeric"
              value={chatIdInput}
              disabled={telegramFormBusy}
              onChange={(event) => setChatIdInput(event.target.value)}
            />
            <p className="preferences-help">Only the allowed chat can reply, and only to a notification.</p>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-user-id">Allowed user ID</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-user-id"
              type="text"
              inputMode="numeric"
              value={userIdInput}
              disabled={telegramFormBusy}
              onChange={(event) => setUserIdInput(event.target.value)}
            />
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-notify-on">Notify on</label>
          </div>
          <div className="preferences-row-control">
            <select
              id="preferences-telegram-notify-on"
              value={notifyOn}
              disabled={telegramFormBusy}
              onChange={(event) => setNotifyOn(event.target.value as 'attention' | 'attention-and-exit')}
            >
              <option value="attention">Needs-you requests</option>
              <option value="attention-and-exit">Needs-you requests and session exits</option>
            </select>
          </div>
        </div>

        {/* Morning digest and Quiet hours keep the dialog's label/control rows; dependent controls stay rendered and keep
            their values while their feature is off, and only Save Telegram settings persists them. */}
        <div className="telegram-group">
          <div className="preferences-row">
            <div className="preferences-row-label">
              <label htmlFor="preferences-telegram-digest">Morning digest</label>
            </div>
            <div className="preferences-row-control">
              <div className="telegram-schedule">
                <input
                  id="preferences-telegram-digest"
                  type="checkbox"
                  checked={morningDigest.enabled}
                  disabled={telegramFormBusy}
                  onChange={(event) => setMorningDigest({ ...morningDigest, enabled: event.target.checked })}
                />
                <span>
                  <label htmlFor="preferences-telegram-digest">Send daily at</label>
                  <input
                    id="preferences-telegram-digest-time"
                    aria-label="Morning digest time"
                    type="time"
                    value={morningDigest.time}
                    disabled={telegramFormBusy || !morningDigest.enabled}
                    onChange={(event) => setMorningDigest({ ...morningDigest, time: event.target.value })}
                  />
                </span>
              </div>
              <p className="preferences-help">Local time. Waits while quiet hours are on; a missed day is skipped.</p>
              {!telegramEnabled && (
                <p className="preferences-help">Telegram is off; no digest will be sent. Enable and connect Telegram to deliver it.</p>
              )}
              <details className="advanced">
                <summary>What the digest includes</summary>
                <div className="advanced-body">
                  <p>Each workspace with its checkout name, epics, Status, Decided-for-you entries and owner-item titles.</p>
                </div>
              </details>
            </div>
          </div>
        </div>

        <div className="telegram-group">
          <div className="preferences-row">
            <div className="preferences-row-label">
              <label htmlFor="preferences-telegram-health">Health alerts</label>
            </div>
            <div className="preferences-row-control">
              <div className="telegram-schedule">
                <input
                  id="preferences-telegram-health"
                  type="checkbox"
                  checked={healthAlerts.enabled}
                  disabled={telegramFormBusy}
                  onChange={(event) => setHealthAlerts({ ...healthAlerts, enabled: event.target.checked })}
                />
                <span>
                  <label htmlFor="preferences-telegram-health">Watch this machine</label>
                </span>
                <span>
                  <label htmlFor="preferences-telegram-health-off">Turn off at</label>
                  <input
                    id="preferences-telegram-health-off"
                    aria-label="Health alerts switch-off time"
                    type="time"
                    value={healthAlerts.offAt ?? ''}
                    disabled={telegramFormBusy || !healthAlerts.enabled}
                    onChange={(event) => setHealthAlerts({ ...healthAlerts, offAt: event.target.value === '' ? null : event.target.value })}
                  />
                </span>
                <button
                  type="button"
                  className="small"
                  disabled={!canSendTest || healthTestBusy}
                  title={canSendTest ? undefined : TEST_MESSAGE_DISABLED_TITLE}
                  onClick={() => void sendHealthTest()}
                >
                  {healthTestBusy ? 'Sending…' : 'Send test'}
                </button>
              </div>
              <p className="preferences-help">
                Checks temperatures, battery and mains every minute while BMN is open, and tells your phone when something is wrong and when it is over.
                Leave the time empty to keep watching; a time already past means that time tomorrow.
              </p>
              {!canSendTest && (
                <p className="preferences-help" role="status">
                  {telegramEnabled ? 'Telegram is not connected; nothing will be sent until it is.' : 'Telegram is off; nothing will be sent. Enable and connect Telegram to be told.'}
                </p>
              )}
              {healthTestError && <p className="preferences-error" role="alert">{healthTestError}</p>}
              {healthTestSuccess && <p className="preferences-help" role="status">{healthTestSuccess}</p>}
              <details className="advanced">
                <summary>What is checked, and what it cannot see</summary>
                <div className="advanced-body">
                  <p>
                    Alerts at: CPU {HEALTH_LIMITS.cpuCritical} °C on one reading or {HEALTH_LIMITS.cpuHot} °C on {HEALTH_LIMITS.cpuHotReadings} in a row;
                    NVIDIA GPU {HEALTH_LIMITS.nvidiaGpu} °C; integrated GPU {HEALTH_LIMITS.integratedGpu} °C; a drive {HEALTH_LIMITS.drive} °C;
                    battery voltage outside {HEALTH_LIMITS.cellVoltsMin.toFixed(1)}–{HEALTH_LIMITS.cellVoltsMax} V per cell; the battery no longer detected; mains power lost;
                    a CPU temperature that cannot be read. The limits are fixed.
                  </p>
                  <p>A message holds the time, this machine&apos;s name, each problem with one line of advice, and all readings. While a problem stays, it repeats every {HEALTH_LIMITS.repeatMinutes} minutes; one &ldquo;Back to normal&rdquo; follows when it ends.</p>
                  <p>It only reads and reports: BMN never stops, slows or suspends anything. A sleeping NVIDIA card is not woken to be asked.</p>
                  <p>It runs only while BMN is open. It cannot see smoke, a swelling battery, or a machine that has died.</p>
                </div>
              </details>
            </div>
          </div>
        </div>

        <div className="telegram-group">
          <div className="preferences-row">
            <div className="preferences-row-label">
              <label htmlFor="preferences-telegram-quiet">Quiet hours</label>
            </div>
            <div className="preferences-row-control">
              <div className="telegram-schedule">
                <input
                  id="preferences-telegram-quiet"
                  type="checkbox"
                  checked={quietHours.enabled}
                  disabled={telegramFormBusy}
                  onChange={(event) => setQuietHours({ ...quietHours, enabled: event.target.checked })}
                />
                <span>
                  <label htmlFor="preferences-telegram-quiet">Hold phone messages from</label>
                  <input
                    id="preferences-telegram-quiet-start"
                    aria-label="Quiet hours start"
                    type="time"
                    value={quietHours.start}
                    disabled={telegramFormBusy || !quietHours.enabled}
                    onChange={(event) => setQuietHours({ ...quietHours, start: event.target.value })}
                  />
                </span>
                <span>
                  <span>to</span>
                  <input
                    id="preferences-telegram-quiet-end"
                    aria-label="Quiet hours end"
                    type="time"
                    value={quietHours.end}
                    disabled={telegramFormBusy || !quietHours.enabled}
                    onChange={(event) => setQuietHours({ ...quietHours, end: event.target.value })}
                  />
                </span>
              </div>
              <p className="preferences-help">Local time. Held messages are sent when quiet hours end. Health alerts are sent anyway.</p>
            </div>
          </div>

          <div className="preferences-row">
            <div className="preferences-row-label">
              <span id="preferences-telegram-quiet-allow">Let through</span>
            </div>
            <div className="preferences-row-control">
              <div className="telegram-kinds" role="group" aria-labelledby="preferences-telegram-quiet-allow">
                {QUIET_ALLOW_KINDS.map(({ kind, label }) => (
                  <label key={kind} className="preferences-radio">
                    <input
                      type="checkbox"
                      checked={quietHours.allowKinds.includes(kind)}
                      disabled={telegramFormBusy || !quietHours.enabled}
                      onChange={(event) => setQuietHours({ ...quietHours, allowKinds: event.target.checked
                        ? [...quietHours.allowKinds, kind] : quietHours.allowKinds.filter(value => value !== kind) })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="preferences-help">Single sessions can also be let through from their session menu (up to 20).</p>
            </div>
          </div>

          {telegramStatus?.quietHours ? (
            <div className="preferences-row">
              <div className="preferences-row-label">
                <span>Now</span>
              </div>
              <div className="preferences-row-control">
                <div className="telegram-quiet-now" role="status">
                  <p className="telegram-quiet-state" data-active={telegramStatus.quietHours.active}>
                    {telegramStatus.quietHours.active ? `Active until ${telegramStatus.quietHours.until}` : 'Not active'}
                    {' · '}{telegramStatus.quietHours.waiting} waiting
                  </p>
                  {telegramStatus.quietHours.capacityBlocked ? (
                    <p className="preferences-error">Delivery history is full; uncertain messages need checking.</p>
                  ) : null}
                </div>
                {telegramStatus.quietHours.problem ? (
                  <p className="preferences-error" role="alert">
                    Phone delivery history is unavailable. Automatic delivery is paused until it can be read.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="preferences-row">
            <div className="preferences-row-label" />
            <div className="preferences-row-control">
              <details className="advanced">
                <summary>How quiet hours work</summary>
                <div className="advanced-body">
                  <p>When quiet hours end, Telegram gets one summary with session names, request kinds and titles, then each request that is still waiting.</p>
                  <p>Session dots stay current throughout.</p>
                  <p>The kinds and sessions you let through still arrive immediately.</p>
                </div>
              </details>
            </div>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-auto-submit">Type replies into the session</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-auto-submit"
              type="checkbox"
              checked={autoSubmitReplies}
              disabled={telegramFormBusy}
              onChange={(event) => setAutoSubmitReplies(event.target.checked)}
            />
            <p className="preferences-help">Presses Enter too. Off: replies are kept as drafts in Files.</p>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-answer-permissions">Answer permissions</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-answer-permissions"
              type="checkbox"
              checked={answerPermissions}
              disabled={telegramFormBusy}
              onChange={(event) => setAnswerPermissions(event.target.checked)}
            />
            <p className="preferences-help">Allow once/Deny for native cards. Also lets phone taps send manual authorization decisions as messages.</p>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label" />
          <div className="preferences-row-control">
            <div className="preferences-button-row">
              <button type="button" className="primary" disabled={telegramFormBusy} onClick={() => void saveTelegramForm()}>
                {telegramFormBusy ? 'Saving…' : 'Save Telegram settings'}
              </button>
              <button
                type="button"
                disabled={!canSendTest || testBusy}
                title={canSendTest ? undefined : TEST_MESSAGE_DISABLED_TITLE}
                onClick={() => void sendTest()}
              >
                {testBusy ? 'Sending…' : 'Send test message'}
              </button>
            </div>
          </div>
        </div>
        {telegramFormError && (
          <p className="preferences-error" role="alert">
            {telegramFormError}
          </p>
        )}
        {telegramFormSuccess && (
          <p className="preferences-success" role="status">
            {telegramFormSuccess}
          </p>
        )}
        {testError && (
          <p className="preferences-error" role="alert">
            {testError}
          </p>
        )}
        {testSuccess && (
          <p className="preferences-success" role="status">
            {testSuccess}
          </p>
        )}
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="advanced-body">
            <p>A reply must answer a notification; it never goes to the focused session.</p>
            <p>A permission tap answers only the exact prompt on screen.</p>
          </div>
        </details>
      </section>
      </>)}

      {pageOf('history', <HistoryPreferences settings={props.settings} onSettings={(next) => onSettings.current(next)} />)}

      {pageOf('control', <>
      <section className="preferences-section" id="agent-control-section">
        <h3>Local control</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Listening</span>
          </div>
          <div className="preferences-row-control">
            {controlInfo ? (
              <p>
                {controlInfo.listening ? 'Yes' : 'No'} · {controlInfo.detail}
              </p>
            ) : (
              <p className="preferences-help">Loading…</p>
            )}
          </div>
        </div>
        {controlInfo && (
          <>
            <div className="preferences-row">
              <div className="preferences-row-label">
                <span>Socket path</span>
              </div>
              <div className="preferences-row-control">
                <code className="preferences-mono preferences-path" title={controlInfo.socketPath}><bdi>{controlInfo.socketPath}</bdi></code>
                <button type="button" disabled={copying === 'socket'} onClick={() => void copyText('socket', controlInfo.socketPath)}>
                  Copy
                </button>
              </div>
            </div>
            <div className="preferences-row">
              <div className="preferences-row-label">
                <span>CLI path</span>
              </div>
              <div className="preferences-row-control">
                <code className="preferences-mono preferences-path" title={controlInfo.cliPath}><bdi>{controlInfo.cliPath}</bdi></code>
                <button type="button" disabled={copying === 'cli'} onClick={() => void copyText('cli', controlInfo.cliPath)}>
                  Copy
                </button>
              </div>
            </div>
          </>
        )}
        {controlError && (
          <p className="preferences-error" role="alert">
            {controlError}
          </p>
        )}
        {copyError && (
          <p className="preferences-error" role="alert">
            {copyError}
          </p>
        )}
        {copyMessage && (
          <p className="preferences-success" role="status">
            {copyMessage}
          </p>
        )}
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="advanced-body">
            <p>For Codex, trust hooks with /hooks in Codex and check a real Hook events entry.</p>
            <pre className="preferences-usage">{USAGE_LINES.join('\n')}</pre>
            <p>Sessions started by BMN get BMN_CONTROL_SOCKET and BMN_TOKEN automatically.</p>
          </div>
        </details>
      </section>
      </>)}

      {pageOf('backup', <>
      <section className="preferences-section">
        <h3>Backup</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Export</span>
          </div>
          <div className="preferences-row-control">
            <div className="preferences-button-row">
              <button type="button" disabled={exportBusy} onClick={() => void runExportBackup()}>
                {exportBusy ? 'Exporting…' : 'Export backup…'}
              </button>
            </div>
            <p className="preferences-help">Saves the database and artifacts to a folder you choose and checks the copy.</p>
          </div>
        </div>
        {exportError && (
          <p className="preferences-error" role="alert">
            {exportError}
          </p>
        )}
        {exportResult && <BackupOutcome result={exportResult} />}
      </section>
      </>)}
      </main>
      {ledger ? <TeamToast team={team} /> : null}
      </div>
      {ledger ? <TeamLedger team={team} /> : null}
    </Dialog>
  )
}
