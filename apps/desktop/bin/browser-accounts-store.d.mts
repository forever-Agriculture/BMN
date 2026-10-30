// MODULE: browser-accounts-store.d.mts - Typed interface for encrypted account storage.
import type { BrowserAccountRow } from '@bmn/protocol'
export interface AccountMetadata extends Omit<BrowserAccountRow, 'sites'> { origins: string[]; signInPages?: string[]; noticePending?: boolean; occurrence?: string; noticeDelivered?: string; credentialRevision?: string }
export declare class BrowserAccountsStore {
  constructor(options?: { environment?: NodeJS.ProcessEnv; onNotice?: (notice: { id: string; name: string; state: string }) => void })
  list(): BrowserAccountRow[]
  metadata(id: string): AccountMetadata
  writeMeta(meta: AccountMetadata): AccountMetadata
  lock<T>(id: string, fn: () => T | Promise<T>): Promise<T>
  find(name: string): string
  create(name: string, start: string): Promise<AccountMetadata>
  mark(id: string, credentials: { username: string; password: string; authenticator?: string }): Promise<AccountMetadata>
  unmark(id: string): Promise<void>
  setTest(id: string, enabled: boolean): Promise<AccountMetadata>
  remove(id: string): Promise<void>
  setState(id: string, state: string, options?: { notify?: boolean }): Promise<AccountMetadata>
}
