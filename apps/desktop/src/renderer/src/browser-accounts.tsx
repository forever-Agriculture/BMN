// MODULE: browser-accounts.tsx - Solid account rows in Integrations > Tools; credential input exists only until Mark is submitted.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { BrowserAccountAction, BrowserAccountRow, BrowserAccountsView, RulesSnapshot, ToolsView } from '@bmn/protocol'
import type { TeamState } from './team-state'
import { Dot } from './roster-marks'
import { toolForApp } from './tools-view'

export function browserAccountNeeds(row: BrowserAccountRow): boolean { return row.state === 'Keyring locked' || row.state === 'Sign in again' && !row.marked }
export function browserAccountAttention(accounts: BrowserAccountRow[] | undefined): Array<[string, number]> {
  const count = (accounts || []).filter(browserAccountNeeds).length
  return count ? [['Browser accounts', count]] : []
}
export function accountWords(row: BrowserAccountRow): string {
  if (row.state === 'Keyring locked' || row.state === 'Sign in again' || row.state === 'Not confirmed') return row.state
  if (row.marked) return 'Agents sign in'
  return `Signed in${row.checked ? ` · checked ${new Date(row.checked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
}
export function useBrowserAccountHealth(visible: boolean, setSnapshot: Dispatch<SetStateAction<RulesSnapshot | null>>): void {
  useEffect(() => {
    if (!visible) return
    let live = true, checking = false
    const read = async (): Promise<void> => {
      if (checking) return
      checking = true
      try {
        const { accounts } = await window.aiTerminal.browserAccounts()
        if (live) setSnapshot(current => current === null || JSON.stringify(current.browserAccounts) === JSON.stringify(accounts)
          ? current : { ...current, browserAccounts: accounts })
      } catch { /* Retry without replacing the rules draft or its reading time. */ }
      finally { checking = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [visible, setSnapshot])
}
export function BrowserAccountsHealth({ accounts }: { accounts: BrowserAccountRow[] | undefined }): React.JSX.Element | null {
  return accounts?.length ? <>
    <h4 className="group-head">Browser accounts</h4>
    {accounts.map(account => <div className="health-row" key={account.id}>
      <span>{account.name}</span>
      <span className="path">{account.sites.map(site => { try { return new URL(site).host } catch { return site } }).join(', ')}</span>
      <span className="browser-account-state">{browserAccountNeeds(account) ? <Dot label="Needs you" /> : null}{accountWords(account)}</span>
      <span />
    </div>)}
  </> : null
}
export function BrowserAccounts(props: { team: TeamState; tools: ToolsView; applying?: boolean; onApplyBrowser?(): void }): React.JSX.Element {
  const [view, setView] = useState<BrowserAccountsView>({ accounts: [], signingIn: [] })
  const [adding, setAdding] = useState(false), [name, setName] = useState(''), [url, setUrl] = useState('')
  const [marking, setMarking] = useState<string | null>(null), [removing, setRemoving] = useState<string | null>(null)
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [authenticator, setAuthenticator] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let live = true
    const read = (): void => { void window.aiTerminal.browserAccounts().then(next => { if (live) setView(next) }).catch(() => { if (live) setError('Browser accounts could not be read.') }) }
    read(); const timer = setInterval(read, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  const act = async (params: BrowserAccountAction): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await window.aiTerminal.browserAccountAction(params)
      setView(result.view)
      if (!result.ok) setError(result.message || 'Account action failed.')
      else { setAdding(false); setRemoving(null); setMarking(null); setName(''); setUrl('') }
    } catch { setError('Account action failed.') }
    finally { setBusy(false); setUsername(''); setPassword(''); setAuthenticator('') }
  }
  const clearMark = (): void => { setMarking(null); setUsername(''); setPassword(''); setAuthenticator('') }
  const browser = props.team.approved?.tools?.find(tool => tool.id === 'playwright' && tool.command === 'bmn' && tool.args?.join(' ') === 'browser server')
  const browserStates = props.tools.tools.find(tool => tool.id === 'playwright')?.states
  const browserPending = browser !== undefined && props.tools.apps.some(app => app.supported && toolForApp(browser, app.harness) && ['missing', 'stale', 'unmanaged', 'edited-outside'].includes(browserStates?.[app.harness] ?? ''))
  const playwright = props.team.data?.tools?.find(tool => tool.id === 'playwright')
  const switched = playwright?.command === 'bmn' && playwright.args?.join(' ') === 'browser server'
  const switchBrowser = (): void => {
    const data = props.team.data
    if (!data) return
    const tool = { id: 'playwright', name: 'Playwright', command: 'bmn', args: ['browser', 'server'], public: true as const,
      ...(playwright?.apps ? { apps: playwright.apps } : {}) }
    props.team.stage({ ...data, tools: [...(data.tools || []).filter(t => t.id !== 'playwright'), tool] })
  }
  return <section className="browser-accounts" aria-label="Browser accounts">
    <h4 className="group-head">Browser accounts</h4>
    {error ? <div className="preferences-error" role="alert">{error}</div> : null}
    <div className="browser-account-rows">
      {view.accounts.map(row => <div className="browser-account" key={row.id} data-account-state={row.state}>
        <div className="browser-account-line">
          <div className="browser-account-name"><b>{row.name}</b><span className="line-detail">{row.sites.map(site => { try { return new URL(site).host } catch { return site } }).join(', ')}</span></div>
          {!view.signingIn.includes(row.id) ? <span className="browser-account-state">{browserAccountNeeds(row) ? <Dot label="Needs you" /> : null}{accountWords(row)}</span> : null}
          {view.signingIn.includes(row.id) ? <div className="inline">
            <span>Finish signing in the window, then press Done</span>
            <button type="button" className="primary small" disabled={busy} onClick={() => void act({ action: 'done', id: row.id })}>Done</button>
            <button type="button" className="small" disabled={busy} onClick={() => void act({ action: 'cancel', id: row.id })}>Cancel</button>
          </div> : <div className="inline browser-account-actions">
            <button type="button" className="small" disabled={busy} onClick={() => void act({ action: 'sign-in', id: row.id })}>Sign in again</button>
            <button type="button" className="small" aria-pressed={row.marked} disabled={busy} onClick={() => { if (row.marked) void act({ action: 'unmark', id: row.id }); else { clearMark(); setMarking(row.id) } }}>Agents may sign in</button>
            <button type="button" className="small" disabled={busy} onClick={() => setRemoving(row.id)}>Remove</button>
          </div>}
        </div>
        {marking === row.id ? <form className="browser-account-editor" onSubmit={event => { event.preventDefault(); void act({ action: 'mark', id: row.id, username, password, ...(authenticator ? { authenticator } : {}) }) }}>
          <span className="line-detail">{row.signInOrigins.join(', ') || 'Sign in again to record the sign-in origins.'}</span>
          <label>User name<input autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} /></label>
          <label>Password<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
          <label>Authenticator key <span className="muted">optional</span><input type="password" autoComplete="off" value={authenticator} onChange={e => setAuthenticator(e.target.value)} /></label>
          <div className="inline"><button className="primary small" type="submit" disabled={busy || !password || row.signInOrigins.length === 0}>Allow agents to sign in</button><button type="button" className="small" disabled={busy} onClick={clearMark}>Cancel</button></div>
        </form> : null}
        {removing === row.id ? <div className="inline browser-account-confirm"><span>Remove {row.name} and its saved sign-in?</span><button type="button" className="small" disabled={busy} onClick={() => void act({ action: 'remove', id: row.id })}>Remove account</button><button type="button" className="small" disabled={busy} onClick={() => setRemoving(null)}>Keep</button></div> : null}
      </div>)}
    </div>
    {view.accounts.length === 0 && !adding ? <div className="browser-account-empty">No browser accounts yet.</div> : null}
    {adding ? <form className="browser-account-editor" onSubmit={event => { event.preventDefault(); void act({ action: 'add', name, url }) }}>
      <label>Name<input value={name} maxLength={100} onChange={e => setName(e.target.value)} autoFocus /></label>
      <label>Start page<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" /></label>
      <div className="inline"><button className="primary small" type="submit" disabled={busy || !name.trim() || !url}>Sign in…</button><button className="small" type="button" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
    </form> : <div className="inline tool-actions"><button type="button" disabled={busy} onClick={() => setAdding(true)}>Add account</button>
      {!switched ? <button type="button" disabled={busy || !props.team.data} onClick={switchBrowser}>Use BMN browser…</button> : null}</div>}
    {!adding && browserPending && props.onApplyBrowser ? <div className="inline tool-actions"><button type="button" disabled={busy || props.applying} onClick={props.onApplyBrowser}>Apply browser switch…</button></div> : null}
  </section>
}
