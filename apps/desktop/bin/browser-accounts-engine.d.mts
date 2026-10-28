// MODULE: browser-accounts-engine.d.mts - Owner sign-in controller interface.
import type { BrowserAccountsStore } from './browser-accounts-store.mjs'
import type { Page } from 'playwright'
export declare class AccountSignIn {
  constructor(store: BrowserAccountsStore)
  sessions: Map<string, { page: Page }>
  pending: Map<string | symbol, Promise<{ id: string; name: string }>>
  begin(params: { name?: string; url?: string; id?: string; headless?: boolean }): Promise<{ id: string; name: string }>
  finish(id: string, cancel?: boolean): Promise<unknown>
  close(): Promise<void>
}
