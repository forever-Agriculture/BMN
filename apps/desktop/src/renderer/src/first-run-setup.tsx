// MODULE: first-run-setup.tsx - Approved Setup app rows, exact-command sheets and durable completion
import { useCallback, useEffect, useRef, useState } from 'react'
import { SETUP_APP_NAMES, SETUP_INSTALL_COMMANDS, SETUP_LOGIN_ARGUMENTS,
  type FirstRunSetupRecord, type SetupAppReadiness, type SetupAppsSnapshot, type SessionRecord, type SetupDefaultsReport } from '@bmn/protocol'
import type { CreatedSession } from '../../preload/bridge'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import { quoteArgv } from './launch-template'
import { setupStatus, type SetupTeamStatus } from './setup-status'
import { setupAppNeedsAction, setupAppView } from './setup-app-view'
import './first-run-setup.css'

type SetupSheet = { row: SetupAppReadiness; kind: 'install' | 'login' | 'check' | 'confirm' | 'root' | 'path' }
export interface SetupNavigation {
  onCreated?: ((created: CreatedSession) => void | Promise<void>) | undefined
  onOpenSession?: ((sessionId: string) => void) | undefined
}

export function SetupReadiness(props: { row: SetupAppReadiness; session?: SessionRecord | undefined }): React.JSX.Element {
  const view = setupAppView(props.row, props.session)
  return <><span>{view.head}</span>{view.lines.map(line => <span className="faint" key={line}>{line}</span>)}</>
}

export function useSetupApps(navigation: SetupNavigation) {
  const [snapshot, setSnapshot] = useState<SetupAppsSnapshot>()
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [sheet, setSheet] = useState<SetupSheet>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [usedPaths, setUsedPaths] = useState<string[]>([])
  const sequence = useRef(0)
  const reload = useCallback(async (): Promise<void> => {
    const next = ++sequence.current
    try {
      const [apps, progress] = await Promise.all([window.aiTerminal.getSetupApps(), window.aiTerminal.getSetupProgress()])
      const records = progress?.workspaceId ? await window.aiTerminal.listSessions(progress.workspaceId) : []
      if (next !== sequence.current) return
      setSnapshot(apps)
      setSessions(records.filter(row => row.setup))
      setError(undefined)
    } catch (error) {
      if (next === sequence.current) setError(failureDetail(error, 'App readiness could not be read'))
    }
  }, [])
  useEffect(() => { void reload(); return () => { sequence.current++ } }, [reload])
  useEffect(() => window.aiTerminal.onAppEvent(event => { if (event.topic === 'hooks') void reload() }), [reload])
  const working = snapshot?.apps.some(row => row.qualification === 'checking') || sessions.some(row => row.lastProcess?.state === 'live')
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => void reload(), 1500)
    return () => clearInterval(timer)
  }, [working, reload])
  const latest = (row: SetupAppReadiness): SessionRecord | undefined =>
    sessions.filter(session => session.setup?.app === row.app && session.archivedAt === null).at(-1)
  const afterSession = (row: SetupAppReadiness): SessionRecord | undefined =>
    sessions.findLast(session => session.setup?.app === row.app && session.setup.action !== 'install' && session.lastProcess && session.lastProcess.state !== 'live')
  const begin = (row: SetupAppReadiness): void => {
    const session = latest(row)
    if (session?.lastProcess?.state === 'live') { navigation.onOpenSession?.(session.sessionId); return }
    const kind = row.signIn === 'missing' ? snapshot?.curlAvailable === false ? 'root' : 'install'
      : !row.onPath && !usedPaths.includes(row.program ?? '') ? 'path'
        : row.signIn === 'signed-out' ? 'login' : row.signIn === 'unknown' && afterSession(row) ? 'confirm' : 'check'
    setSheet({ row, kind })
    setError(undefined)
  }
  const actionWords = (row: SetupAppReadiness): string => {
    if (latest(row)?.lastProcess?.state === 'live') return 'Open session'
    if (row.signIn === 'missing') return snapshot?.curlAvailable === false ? 'Show command…' : 'Install…'
    if (!row.onPath && !usedPaths.includes(row.program ?? '')) return 'Use this path'
    if (row.signIn === 'signed-out') return 'Sign in…'
    return row.signIn === 'unknown' && afterSession(row) ? 'Confirm…' : 'Open session'
  }
  const act = async (): Promise<void> => {
    if (!sheet || busy) return
    const { row, kind } = sheet
    if (kind === 'path') { setUsedPaths(paths => [...paths, row.program!]); setSheet(undefined); return }
    if (kind === 'root') { await window.aiTerminal.writeClipboardText('sudo apt install curl').catch(() => setError('The command could not be copied')); return }
    setBusy(true)
    try {
      if (kind === 'confirm') {
        const session = afterSession(row)
        if (!session || !row.version) throw new Error('Run an app session before confirming sign-in')
        setSnapshot(await window.aiTerminal.confirmSetupSignIn(row.app, session.sessionId, row.version))
        setSheet(undefined)
      } else {
        const created = await window.aiTerminal.startSetupSession(row.app, kind, row.program)
        setSheet(undefined)
        await navigation.onCreated?.(created)
      }
      await reload()
    } catch (error) { setError(failureDetail(error, 'The setup action could not start')) }
    finally { setBusy(false) }
  }
  const command = sheet?.kind === 'root' ? 'sudo apt install curl' : sheet?.kind === 'install'
    ? quoteArgv([SETUP_INSTALL_COMMANDS[sheet.row.app].executable, ...SETUP_INSTALL_COMMANDS[sheet.row.app].argv])
    : sheet?.row.program ? quoteArgv([sheet.row.program, ...(sheet.kind === 'login' ? SETUP_LOGIN_ARGUMENTS[sheet.row.app] : [])]) : ''
  const modal = sheet ? <Dialog label={sheet.kind === 'root' ? 'One command as root' : sheet.kind === 'confirm' ? 'Confirm sign-in'
    : sheet.kind === 'path' ? 'Use the installed path' : `${sheet.kind === 'install' ? 'Install' : sheet.kind === 'login' ? 'Sign in to' : 'Open'} ${SETUP_APP_NAMES[sheet.row.app]}`}
    onClose={() => !busy && setSheet(undefined)} className="setup-command-sheet">
    {sheet.kind === 'confirm' ? <p>Confirm only if you completed sign-in in the app session. This is recorded as your confirmation.</p>
      : sheet.kind === 'path' ? <><pre>{sheet.row.program}</pre><p>Setup can use this executable. Other terminals may require logging out and in.</p></>
        : <><pre>{command}</pre><p>{sheet.kind === 'root' ? 'Run this yourself, then check again. BMN never runs sudo.' : 'The command runs in a visible Setup session. Saved output is off from creation.'}</p></>}
    {error ? <p role="alert" className="preferences-error">{error}</p> : null}
    <div className="dialog-actions"><button type="button" className="primary" disabled={busy} onClick={() => void act()}>
      {busy ? 'Starting…' : sheet.kind === 'root' ? 'Copy' : sheet.kind === 'path' ? 'Use this path' : sheet.kind === 'confirm' ? 'I signed in' : 'Start session'}</button>
      <button type="button" disabled={busy} onClick={() => setSheet(undefined)}>Cancel</button>
      {sheet.kind === 'root' ? <button type="button" disabled={busy} onClick={() => { setSheet(undefined); void reload() }}>Check again</button> : null}</div>
  </Dialog> : null
  return { snapshot, sessions, busy, error, reload, latest, begin, actionWords, modal }
}

export function FirstRunSetup(props: SetupNavigation & {
  progress: FirstRunSetupRecord
  onProgress(progress: FirstRunSetupRecord): void
  onTeam(): void
  onHealth(): void
  lastLines: Record<string, string>
  preferencesOpen: boolean
  focusApp?: import('@bmn/protocol').SetupApp | undefined
}): React.JSX.Element {
  const apps = useSetupApps(props)
  const surface = useRef<HTMLDivElement>(null)
  const focusRestored = useRef(false)
  useEffect(() => {
    if (focusRestored.current || !props.focusApp || !apps.snapshot) return
    const row = surface.current?.querySelector<HTMLElement>(`[data-setup-app="${props.focusApp}"]`)
    if (!row) return
    ;(row.querySelector<HTMLButtonElement>('button:not([disabled])') ?? row).focus()
    focusRestored.current = true
  }, [props.focusApp, apps.snapshot])
  const [error, setError] = useState<string>()
  const [team, setTeam] = useState<SetupTeamStatus>()
  const [defaults, setDefaults] = useState<SetupDefaultsReport | null>()
  const [reading, setReading] = useState(true)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const summarySequence = useRef(0)
  const reloadSummary = useCallback(async (): Promise<void> => {
    const request = ++summarySequence.current
    setReading(true)
    try {
      const [snapshot, report] = await Promise.all([window.aiTerminal.agentsSnapshot(), window.aiTerminal.getSetupDefaults()])
      if (request !== summarySequence.current) return
      setTeam({ members: snapshot.approved?.data.agents.map(agent => agent.harness) ?? null,
        pending: Boolean(snapshot.approvalProblem || snapshot.file.errors.length || snapshot.differences?.length) })
      setDefaults(report)
      setError(undefined)
    } catch (error) {
      if (request === summarySequence.current) setError(failureDetail(error, 'Setup status could not be read'))
    } finally { if (request === summarySequence.current) setReading(false) }
  }, [])
  useEffect(() => { if (!props.preferencesOpen) void reloadSummary() }, [props.preferencesOpen, apps.snapshot?.checkedAt, reloadSummary])
  useEffect(() => () => { summarySequence.current++ }, [])
  const status = setupStatus(apps.snapshot, team, defaults)
  const finish = async (state: 'skipped' | 'finished'): Promise<void> => {
    try {
      const current = await window.aiTerminal.getSetupProgress()
      if (!current) throw new Error('Setup progress is unavailable')
      props.onProgress(await window.aiTerminal.updateSetupProgress({ state, expectedRevision: current.revision }))
    } catch (error) { setError(failureDetail(error, 'Setup progress could not be saved')) }
  }
  return <div ref={surface} className="first-run-setup" aria-label="Setup">
    <header><h1>{props.progress.state === 'finished' ? 'Setup finished.' : props.progress.state === 'skipped' ? 'Set up when you’re ready.' : 'Set up BMN.'}</h1>
      <p>Install the apps you want, sign in, then review your team.</p></header>
    <section aria-labelledby="setup-apps-title"><h2 id="setup-apps-title">Agent apps</h2><div aria-live="polite">
      {apps.snapshot ? apps.snapshot.apps.map(row => {
        const session = apps.latest(row)
        const failed = session?.setup?.action === 'install' && session.lastProcess?.state === 'exited' && session.lastProcess.exitCode !== 0
        return <div className="setup-app-row" key={row.app} data-setup-app={row.app} tabIndex={-1}>
          <span>{SETUP_APP_NAMES[row.app]}</span><span className="setup-stack"><span>{row.version ?? (row.program ? 'Version not read' : 'No version')}</span>
            {row.program ? <span className="path mono" title={row.program}>{row.program}</span> : null}</span>
          <span className="setup-stack"><SetupReadiness row={row} session={session} />
            {!row.onPath && row.program ? <span className="muted">Not on your PATH</span> : null}
            {failed ? <><span className="preferences-error">Install failed · exit {session.lastProcess?.exitCode}</span>
              {props.lastLines[session.sessionId] ? <pre className="setup-last-lines">{props.lastLines[session.sessionId]}</pre> : null}</> : null}</span>
          <span>{setupAppNeedsAction(row, session) ?
            <button type="button" className="small" disabled={apps.busy || apps.snapshot?.platform !== 'linux'} onClick={() => apps.begin(row)}>{apps.actionWords(row)}</button> : null}</span>
        </div>
      }) : <p>Checking…</p>}
    </div><button type="button" className="small ghost" onClick={() => void apps.reload()}>Check again</button></section>
    <section><h2>Team</h2><div className="setup-group-row"><span>Team</span><span>{status.team}</span><button type="button" className="small" onClick={props.onTeam}>Review team…</button></div></section>
    <section><h2>Defaults</h2><div className="setup-group-row"><span>Defaults</span><span className="setup-stack"><span>{status.defaults}</span><span className="muted">Rules, skills, hooks and Playwright MCP</span></span>
      <button type="button" className="small" onClick={props.onHealth}>Health…</button></div>
      {status.recoveryPaths.length ? <button type="button" className="small ghost" onClick={() => setRecoveryOpen(true)}>{status.recoveryPaths.length} recovery paths…</button> : null}</section>
    {error || apps.error ? <p role="alert" className="preferences-error">{error ?? apps.error}</p> : null}
    <footer className="actions"><span className="muted">You can use ordinary sessions at any time.</span>
      <button type="button" className="primary" disabled={reading || Boolean(error || apps.error) || !status.canFinish} title="Finish after your team and defaults are ready" onClick={() => void finish('finished')}>Finish</button>
      <button type="button" onClick={() => void finish('skipped')}>Skip for now</button></footer>
    {apps.modal}
    {recoveryOpen ? <Dialog label="Recovery paths" onClose={() => setRecoveryOpen(false)} className="setup-command-sheet">
      <p>These are recorded recovery locations. Files may have moved since the record. BMN never removes preserved copies automatically.</p>
      <pre>{status.recoveryPaths.join('\n')}</pre>
      <div className="dialog-actions"><button type="button" onClick={() => void window.aiTerminal.writeClipboardText(status.recoveryPaths.join('\n')).catch(() => setError('The paths could not be copied'))}>Copy paths</button>
        <button type="button" onClick={() => setRecoveryOpen(false)}>Close</button></div>
    </Dialog> : null}
  </div>
}
