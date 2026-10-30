// MODULE: browser-accounts.ts - Value-free browser account views and owner actions.
export interface BrowserAccountRow {
  id: string
  name: string
  start: string
  landing: string
  sites: string[]
  signInOrigins: string[]
  state: 'Signed in' | 'Not confirmed' | 'Sign in again' | 'Keyring locked'
  checked: string | null
  marked: boolean
  /** Missing on legacy snapshots; the account store reads those as ordinary, revision 1. */
  test?: boolean
  qaRevision?: number
}
export interface BrowserAccountsView { accounts: BrowserAccountRow[]; signingIn: string[] }
export type BrowserAccountAction =
  | { action: 'add'; name: string; url: string }
  | { action: 'sign-in' | 'done' | 'cancel' | 'remove' | 'unmark'; id: string }
  | { action: 'mark'; id: string; username: string; password: string; authenticator?: string }
export interface BrowserAccountOutcome { ok: boolean; message?: string; view: BrowserAccountsView }
