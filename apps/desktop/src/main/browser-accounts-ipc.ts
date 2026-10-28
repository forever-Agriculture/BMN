// MODULE: browser-accounts-ipc.ts - Owner-only account actions and once-per-occurrence clickable BMN notices.
import type { IpcMainInvokeEvent } from 'electron'
import { ERROR_CODES, type BrowserAccountAction, type BrowserAccountOutcome, type BrowserAccountsView } from '@bmn/protocol'
import { BrowserAccountsStore } from '../../bin/browser-accounts-store.mjs'
import { AccountSignIn } from '../../bin/browser-accounts-engine.mjs'
import { MainIpcError } from './workspace-ipc'

export function registerBrowserAccounts(options: {
  handle(channel: `aiterm:${string}`, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown): void
  allowed(event: IpcMainInvokeEvent): boolean
  environment: NodeJS.ProcessEnv
  notify(notice: { title: string; body: string }, clicked: () => void): void
  testController?(controller: AccountSignIn): void
}): { view(): BrowserAccountsView; dispose(): Promise<void> } {
  const store = new BrowserAccountsStore({ environment: options.environment })
  const signIn = new AccountSignIn(store)
  options.testController?.(signIn)
  const view = (): BrowserAccountsView => ({ accounts: store.list(), signingIn: [...signIn.sessions.keys()] })
  const begin = async (id: string): Promise<void> => { if (!signIn.sessions.has(id)) await signIn.begin({ id }) }
  options.handle('aiterm:browser:accounts', event => {
    if (!options.allowed(event)) throw new MainIpcError(ERROR_CODES.unauthorized, 'Account actions are only available in BMN.')
    return view()
  })
  options.handle('aiterm:browser:account-action', async (event, raw): Promise<BrowserAccountOutcome> => {
    if (!options.allowed(event)) throw new MainIpcError(ERROR_CODES.unauthorized, 'Account actions are only available in BMN.')
    const params = raw as BrowserAccountAction
    try {
      if (!params || typeof params.action !== 'string') throw new Error('Choose an account action.')
      if (params.action === 'add') {
        if (typeof params.name !== 'string' || typeof params.url !== 'string') throw new Error('Enter a name and start page.')
        await signIn.begin({ name: params.name, url: params.url })
      } else {
        const id = store.find(params.id)
        if (params.action === 'sign-in') await begin(id)
        else if (params.action === 'done' || params.action === 'cancel') await signIn.finish(id, params.action === 'cancel')
        else if (params.action === 'remove') { if (signIn.sessions.has(id)) await signIn.finish(id, true); if (store.list().some(row => row.id === id)) await store.remove(id) }
        else if (params.action === 'mark') {
          if (typeof params.username !== 'string' || typeof params.password !== 'string' || params.username.length > 10_000 || params.password.length > 10_000 || params.authenticator && params.authenticator.length > 1000) throw new Error('Enter a user name and password.')
          await store.mark(id, { username: params.username, password: params.password, ...(params.authenticator ? { authenticator: params.authenticator } : {}) })
        } else if (params.action === 'unmark') await store.unmark(id)
        else throw new Error('Unknown account action.')
      }
      return { ok: true, view: view() }
    } catch (error) {
      // Never serialize input, a browser exception or a keyring exception into the renderer/logs.
      const code = (error as { code?: string }).code
      return { ok: false, message: code === 'KEYRING_LOCKED' ? 'Keyring locked. Unlock your system keyring and try again.' : 'Account action failed. Check the name, start page and system keyring.', view: view() }
    }
  })
  let looking = false
  const scan = async (): Promise<void> => {
    if (looking) return
    looking = true
    try {
      for (const row of store.list()) await store.lock(row.id, () => {
        const meta = store.metadata(row.id)
        if (!meta.noticePending) return
        store.writeMeta({ ...meta, noticePending: false, ...(meta.occurrence ? { noticeDelivered: meta.occurrence } : {}) })
        if (meta.occurrence && meta.noticeDelivered === meta.occurrence) return
        options.notify({ title: meta.state === 'Keyring locked' ? 'Unlock your keyring' : 'Sign in again', body: meta.state === 'Keyring locked' ? `${meta.name}: unlock your system keyring, then open the account again.` : meta.name }, () => { void begin(row.id).catch(() => {}) })
      })
    } catch { /* An account can be removed between listing and locking. */ }
    finally { looking = false }
  }
  const timer = setInterval(() => { void scan() }, 1000); timer.unref()
  return { view, dispose: async () => { clearInterval(timer); await signIn.close() } }
}
