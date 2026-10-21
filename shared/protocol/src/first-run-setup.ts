// MODULE: first-run-setup.ts - Durable first-run progress and its owner-window commands
import { hasExactKeys } from './closed-shape'
import { isRecord } from './shared-helpers'

export const SETUP_APPS = ['claude', 'codex', 'opencode'] as const
export type SetupApp = typeof SETUP_APPS[number]
export const SETUP_APP_NAMES: Readonly<Record<SetupApp, string>> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode'
}

export interface SetupAppReadiness {
  app: SetupApp
  program: string | null
  onPath: boolean
  version: string | null
  signIn: 'missing' | 'unknown' | 'signed-out' | 'ready' | 'confirmed'
  method: 'chatgpt' | 'api-key' | 'oauth' | 'other' | null
  qualification: 'measured' | 'checking' | 'passed' | 'failed' | 'unavailable'
  /** Present for setup-installed Codex hooks; observation is evidence, not a claim all hooks work. */
  hookTrust?: 'pending' | 'observed' | 'unavailable'
}

export interface SetupAppsSnapshot {
  apps: SetupAppReadiness[]
  curlAvailable: boolean
  checkedAt: string
  platform: string
}

/** Measured79.1 installers run as the session's own command; never as text typed into a shell. */
export const SETUP_INSTALL_COMMANDS: Readonly<Record<SetupApp, { executable: string; argv: readonly string[] }>> = {
  claude: { executable: '/bin/bash', argv: ['-o', 'pipefail', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
  codex: { executable: '/bin/bash', argv: ['-o', 'pipefail', '-c', 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'] },
  opencode: { executable: '/bin/bash', argv: ['-o', 'pipefail', '-c', 'curl -fsSL https://opencode.ai/v2/install | bash'] }
}

export const SETUP_LOGIN_ARGUMENTS: Readonly<Record<SetupApp, readonly string[]>> = {
  claude: ['auth', 'login'], codex: ['login'], opencode: ['auth', 'login']
}

export function isSetupApp(value: unknown): value is SetupApp {
  return SETUP_APPS.includes(value as SetupApp)
}

export interface FirstRunSetupRecord {
  state: 'active' | 'skipped' | 'finished' | 'existing'
  workspaceId: string | null
  revision: number
  updatedAt: string
}

export interface FirstRunSetupUpdate {
  expectedRevision: number
  state: 'skipped' | 'finished'
}

/** Only the first durable claim may initialize ownership; later reads must require its journal. */
export interface SetupDefaultsClaim {
  setupId: string
  initialize: boolean
}

export interface SetupDefaultsRow {
  kind: 'master' | 'own-skills' | 'rules' | 'skills' | 'hooks' | 'tools'
  app: SetupApp | null
  code: string
  state: string
  transaction: string | null
  paths: string[]
  recoveryPaths: string[]
}

export interface SetupDefaultsReport {
  code: string
  source: string | null
  names: string[]
  rows: SetupDefaultsRow[]
}

export function isFirstRunSetupRecord(value: unknown): value is FirstRunSetupRecord {
  return isRecord(value) && hasExactKeys(value, ['state', 'workspaceId', 'revision', 'updatedAt']) &&
    ['active', 'skipped', 'finished', 'existing'].includes(value.state as string) &&
    (value.workspaceId === null || (typeof value.workspaceId === 'string' && value.workspaceId.length > 0)) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) > 0 &&
    typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
}

export function isFirstRunSetupUpdate(value: unknown): value is FirstRunSetupUpdate {
  return isRecord(value) && hasExactKeys(value, ['expectedRevision', 'state']) &&
    Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) > 0 &&
    (value.state === 'skipped' || value.state === 'finished')
}

/** Read-only suggestions; unresolved settings never enter the persisted roster or approval preview. */
export interface SetupTeamProposal {
  id: string
  app: SetupApp
  version: string
  name: string
  class: 'queen'
  roles: string[]
  reasons: Array<{ role: string; reason: string }>
  needs: string | null
}
export interface SetupTeamProposals {
  revision: string
  blocked: string | null
  source: string | null
  skills: string[]
  availableApps: SetupApp[]
  tools: NonNullable<import('./agents-roster').RosterDataShape['tools']>
  proposals: SetupTeamProposal[]
}
