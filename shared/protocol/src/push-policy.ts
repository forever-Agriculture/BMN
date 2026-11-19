// MODULE: push-policy.ts - the owner's push and merge policy: one versioned record, its one change rule, and what it authorizes (Epic 83)
import { isIso } from './shared-helpers'

/** The raw setting that holds the record: one `app_setting` row, no new table (Epic 83, Decisions "Store"). */
export const PUSH_POLICY_KEY = 'push-policy-v1'

/** A repository's level, lowest first. Every repository starts at, and an unlisted or unreadable one counts as, the first. */
export type PushLevel = 'prs-only' | 'merge-when-green' | 'merge-and-push-main'
export const PUSH_LEVELS: readonly PushLevel[] = Object.freeze(['prs-only', 'merge-when-green', 'merge-and-push-main'])
export const PUSH_LEVEL_WORDS: Readonly<Record<PushLevel, string>> = Object.freeze({
  'prs-only': 'PRs only', 'merge-when-green': 'Merge when green', 'merge-and-push-main': 'Merge and push main'
})

/**
 * What still asks the owner whatever the policy says (R83-NFR1). The guard holds its own list (docs/agent-control.md,
 * "The command guard") and GitHub's rules theirs; the rest is the agents' rule.
 */
export const PUSH_POLICY_STILL_ASKS: readonly string[] = Object.freeze([
  'deploys, releases and tags',
  'closing, killing or restarting packaged BMN (queuing update:desktop does not ask)',
  'CI and workflow changes, including scripts and actions CI runs and such changes arriving through a merged PR',
  'a push to a branch that triggers a deployment',
  'a pull-request label or comment that triggers a deployment or a bot (a slash command, a deploy or merge label)',
  'a push to the default branch, or a merge, above the repository\'s level',
  'repository settings, protection, collaborators, secrets, visibility, transfer, archive and deletion',
  'deleting branches or tags, force pushes and history rewrites',
  'publishing packages',
  'a push that might carry a secret',
  'a merge without green required checks (any check skipped, neutral, pending, missing or unreadable), an admin bypass, auto-merge, a merge queue or --delete-branch',
  'a merge or a push of the default branch before the work passed its acceptance (its tests and reviews): the policy removes the ask, it never makes work ready',
  'credentials, private-data transfers, production or database changes, spending and destructive actions',
  'anything in a repository of a denied or unknown owner'
])

/** The text his rules master carries while the policy is in force (Story 83.5); without it nothing is authorized. */
export const PUSH_POLICY_POINTER = 'bmn policy --repo'

/** A GitHub login or organisation name, and an `owner/name` repository, compared lower-cased. */
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
const REPOSITORY = /^([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9._-]{1,100})$/

export function pushPolicyLogin(value: unknown): string | null {
  return typeof value === 'string' && LOGIN.test(value.toLowerCase()) ? value.toLowerCase() : null
}

export function pushPolicyRepository(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase().replace(/\.git$/, '')
  return REPOSITORY.test(lower) && lower.split('/')[1] !== '.' && lower.split('/')[1] !== '..' ? lower : null
}

/**
 * What deploys in a repository, as the owner said in Health (Epic 132, D3). BMN cannot see a repository's workflows or what
 * another service does on a push, so it lifts a held action only where his rule says the action's events deploy nothing.
 * A repository without a rule stays held; an empty list is "nothing deploys".
 */
export type DeployEvent = 'default-branch' | 'branches' | 'tags' | 'releases' | 'pull-requests'
export const DEPLOY_EVENTS: readonly DeployEvent[] = Object.freeze(['default-branch', 'branches', 'tags', 'releases', 'pull-requests'])
export const DEPLOY_EVENT_WORDS: Readonly<Record<DeployEvent, string>> = Object.freeze({
  'default-branch': 'Default branch', branches: 'Other branches', tags: 'Tags', releases: 'Releases', 'pull-requests': 'Pull requests'
})
const DEPLOY_EVENT_PHRASES: Readonly<Record<DeployEvent, string>> = Object.freeze({
  'default-branch': 'a push to the default branch', branches: 'a push to another branch', tags: 'a tag', releases: 'a release',
  'pull-requests': 'a pull-request event'
})

interface PushPolicyRecord {
  version: 1
  /** Grows by one with every change; Health names the one it saw. */
  revision: number
  /** Owners he decided on; one absent here is denied. */
  owners: Array<{ login: string; allowed: boolean; changedAt: string }>
  /** Repositories he raised; one absent here is at PRs only. */
  levels: Array<{ repository: string; level: PushLevel; changedAt: string }>
  /** Repositories he gave a deploy rule; one absent here has none, and its held actions stay held. */
  deploys: Array<{ repository: string; events: DeployEvent[]; changedAt: string }>
}

/** The record as stored, or `unknown` when a row exists that cannot be read: unknown counts as denied and is never re-initialised by itself. */
export type PushPolicyRead = { state: 'read'; record: PushPolicyRecord } | { state: 'unknown'; reason: string }

const EMPTY_PUSH_POLICY: PushPolicyRecord = Object.freeze({ version: 1, revision: 0, owners: [], levels: [], deploys: [] }) as PushPolicyRecord

/** A missing row is the empty start (no owner allowed); a row that is not a valid record is `unknown`. */
export function readPushPolicy(raw: string | undefined): PushPolicyRead {
  if (raw === undefined) return { state: 'read', record: { ...EMPTY_PUSH_POLICY, owners: [], levels: [], deploys: [] } }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { state: 'unknown', reason: 'the stored policy is not valid JSON' } }
  if (typeof value !== 'object' || value === null) return { state: 'unknown', reason: 'the stored policy is not a record' }
  const row = value as Record<string, unknown>
  if (row.version !== 1) return { state: 'unknown', reason: 'the stored policy has an unknown version' }
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) return { state: 'unknown', reason: 'the stored policy has no valid revision' }
  if (!Array.isArray(row.owners) || !Array.isArray(row.levels)) return { state: 'unknown', reason: 'the stored policy has no owners or levels list' }
  const owners: PushPolicyRecord['owners'] = []
  for (const item of row.owners) {
    const owner = item as Record<string, unknown>
    const login = pushPolicyLogin(owner?.login)
    if (login === null || login !== owner.login || typeof owner.allowed !== 'boolean' || !isIso(owner.changedAt) || owners.some((o) => o.login === login)) {
      return { state: 'unknown', reason: 'the stored policy has an owner it cannot read' }
    }
    owners.push({ login, allowed: owner.allowed, changedAt: owner.changedAt })
  }
  const levels: PushPolicyRecord['levels'] = []
  for (const item of row.levels) {
    const entry = item as Record<string, unknown>
    const repository = pushPolicyRepository(entry?.repository)
    if (repository === null || repository !== entry.repository || !PUSH_LEVELS.includes(entry.level as PushLevel) || !isIso(entry.changedAt) ||
      levels.some((l) => l.repository === repository)) {
      return { state: 'unknown', reason: 'the stored policy has a repository level it cannot read' }
    }
    levels.push({ repository, level: entry.level as PushLevel, changedAt: entry.changedAt })
  }
  // A record written before Epic 132 has no list: no repository has a rule yet.
  if (row.deploys !== undefined && !Array.isArray(row.deploys)) return { state: 'unknown', reason: 'the stored policy has no readable deploy rules' }
  const deploys: PushPolicyRecord['deploys'] = []
  for (const item of (row.deploys ?? []) as unknown[]) {
    const entry = item as Record<string, unknown>
    const repository = pushPolicyRepository(entry?.repository)
    const events = deployEvents(entry?.events)
    if (repository === null || repository !== entry.repository || events === null || !isIso(entry.changedAt) ||
      deploys.some((d) => d.repository === repository)) {
      return { state: 'unknown', reason: 'the stored policy has a deploy rule it cannot read' }
    }
    deploys.push({ repository, events, changedAt: entry.changedAt })
  }
  return { state: 'read', record: { version: 1, revision: row.revision as number, owners, levels, deploys } }
}

/** A rule's events in their one order, or null when the value is not a list of distinct known events. */
function deployEvents(value: unknown): DeployEvent[] | null {
  if (!Array.isArray(value) || value.some((event) => !DEPLOY_EVENTS.includes(event as DeployEvent)) || new Set(value).size !== value.length) return null
  return DEPLOY_EVENTS.filter((event) => value.includes(event))
}

/** The repository's rule: its events (none = nothing deploys), `null` when he set none, `unknown` when the policy cannot be read. */
export function deployRule(read: PushPolicyRead, repository: string): DeployEvent[] | null | 'unknown' {
  if (read.state === 'unknown') return 'unknown'
  return read.record.deploys.find((entry) => entry.repository === repository.toLowerCase())?.events ?? null
}

/** One short stable text for a rule: what a card shows, and what an answer is compared with later. */
export function deployRuleWords(rule: readonly DeployEvent[] | null | 'unknown'): string {
  if (rule === 'unknown') return 'the deploy rule could not be read'
  if (rule === null) return 'no deploy rule set in Health'
  if (rule.length === 0) return 'nothing deploys'
  return `deploys on: ${rule.map((event) => DEPLOY_EVENT_WORDS[event].toLowerCase()).join(', ')}`
}

/**
 * The one evaluator (Epic 132 D3) for the policy lines, the guard, both cards and typed night actions: why an action whose
 * events are these stays held in this repository, or null when his rule says none of them deploys. `events` null is an
 * action BMN cannot place; only "nothing deploys" covers it.
 */
export function deployHold(read: PushPolicyRead, repository: string, events: readonly DeployEvent[] | null): string | null {
  const rule = deployRule(read, repository)
  if (rule === 'unknown') return `The deploy rule for ${repository} could not be read, so this stays held`
  if (rule === null) return `Health has no deploy rule for ${repository}, so this stays held; only he sets it (Health › Pushes and merges)`
  if (rule.length === 0) return null
  if (events === null) return `BMN cannot tell what this action triggers in ${repository}, and his rule says something deploys there; a deploy is never approved here`
  const hit = events.find((event) => rule.includes(event))
  return hit === undefined ? null : `His deploy rule for ${repository} says ${DEPLOY_EVENT_PHRASES[hit]} deploys; a deploy is never approved here`
}

export type PushPolicyChange =
  | { kind: 'owner'; login: string; allowed: boolean; expectedRevision: number }
  | { kind: 'level'; repository: string; level: PushLevel; expectedRevision: number }
  /** `events` null removes the rule; an empty list says nothing deploys. */
  | { kind: 'deploys'; repository: string; events: DeployEvent[] | null; expectedRevision: number }

export type PushPolicyChangeResult =
  | { outcome: 'changed' | 'unchanged'; record: PushPolicyRecord }
  | { outcome: 'stale'; record: PushPolicyRecord }
  | { outcome: 'unknown'; reason: string }
  | { outcome: 'invalid'; reason: string }

/** The one change rule: against the revision Health saw; an unknown record is never written over by a change. */
export function applyPushPolicyChange(current: PushPolicyRead, change: PushPolicyChange, now: string): PushPolicyChangeResult {
  if (current.state === 'unknown') return { outcome: 'unknown', reason: current.reason }
  const record = current.record
  if (!Number.isSafeInteger(change.expectedRevision)) return { outcome: 'invalid', reason: 'expectedRevision must be a whole number' }
  if (change.expectedRevision !== record.revision) return { outcome: 'stale', record }
  if (change.kind === 'owner') {
    const login = pushPolicyLogin(change.login)
    if (login === null || typeof change.allowed !== 'boolean') return { outcome: 'invalid', reason: 'an owner change names a GitHub login and allowed true or false' }
    const before = record.owners.find((owner) => owner.login === login)
    if ((before?.allowed ?? false) === change.allowed && before !== undefined) return { outcome: 'unchanged', record }
    const owners = [...record.owners.filter((owner) => owner.login !== login), { login, allowed: change.allowed, changedAt: now }]
      .sort((a, b) => a.login.localeCompare(b.login))
    return { outcome: 'changed', record: { ...record, revision: record.revision + 1, owners } }
  }
  if (change.kind === 'deploys') {
    const repository = pushPolicyRepository(change.repository)
    const events = change.events === null ? null : deployEvents(change.events)
    if (repository === null || change.events !== null && events === null) return { outcome: 'invalid', reason: 'a deploy rule names owner/name and a list of known events, or null for no rule' }
    const before = record.deploys.find((entry) => entry.repository === repository)?.events ?? null
    if (JSON.stringify(before) === JSON.stringify(events)) return { outcome: 'unchanged', record }
    const rest = record.deploys.filter((entry) => entry.repository !== repository)
    const deploys = (events === null ? rest : [...rest, { repository, events, changedAt: now }]).sort((a, b) => a.repository.localeCompare(b.repository))
    return { outcome: 'changed', record: { ...record, revision: record.revision + 1, deploys } }
  }
  const repository = pushPolicyRepository(change.repository)
  if (repository === null || !PUSH_LEVELS.includes(change.level)) return { outcome: 'invalid', reason: 'a level change names owner/name and one of the three levels' }
  const before = record.levels.find((entry) => entry.repository === repository)
  if ((before?.level ?? 'prs-only') === change.level) return { outcome: 'unchanged', record }
  const rest = record.levels.filter((entry) => entry.repository !== repository)
  // PRs only is the default, so it is stored as the absence of a raise.
  const levels = (change.level === 'prs-only' ? rest : [...rest, { repository, level: change.level, changedAt: now }])
    .sort((a, b) => a.repository.localeCompare(b.repository))
  return { outcome: 'changed', record: { ...record, revision: record.revision + 1, levels } }
}

/** Whether the policy is in force: read, at least one owner allowed, and the master carrying the pointer. */
interface PushPolicyStanding {
  authorizes: boolean
  /** Why nothing is authorized, in a few words; null while it authorizes. */
  why: string | null
}

export function pushPolicyStanding(read: PushPolicyRead, masterHasPointer: boolean | null): PushPolicyStanding {
  if (read.state === 'unknown') return { authorizes: false, why: `the policy could not be read (${read.reason}); everything counts as denied` }
  if (!read.record.owners.some((owner) => owner.allowed)) return { authorizes: false, why: 'no owner is allowed in Health' }
  if (masterHasPointer === null) return { authorizes: false, why: 'the installed rules could not be read' }
  if (!masterHasPointer) return { authorizes: false, why: 'the installed rules do not carry the policy pointer' }
  return { authorizes: true, why: null }
}

/** One repository a BMN session works in, as Health lists it. */
export interface PushPolicyRepositoryView {
  repository: string
  name: string
  level: PushLevel
  /** His deploy rule: the events that deploy (none = nothing deploys), or null while he set none. */
  deploys: DeployEvent[] | null
  /** The default branch GitHub reports; null with `unread` when it could not be read. */
  defaultBranch: string | null
  /** Why the owner or default branch could not be read; Health shows it, and `bmn policy` reads the repository itself. */
  unread: string | null
  /** Why a raised repository is listed that no session works in: it stays in sight until he lowers it. */
  note?: string
}

export interface PushPolicyOwnerView {
  login: string
  kind: 'account' | 'organisation' | 'unknown'
  /** Signed in with `gh` on this computer; it only names the row, it never allows it. */
  signedIn: boolean
  allowed: boolean
  repositories: PushPolicyRepositoryView[]
}

/** What Health shows: the stored state (or unknown), its standing, and the owners and repositories BMN's sessions work in. */
export type PushPolicyView =
  | { state: 'read'; revision: number; standing: PushPolicyStanding; owners: PushPolicyOwnerView[] }
  | { state: 'unknown'; reason: string; standing: PushPolicyStanding; owners: PushPolicyOwnerView[] }

/** What `bmn policy` reads through the control socket: the record's facts, never any repository listing. */
export type PushPolicyStatus =
  | { state: 'read'; revision: number; standing: PushPolicyStanding; allowed: string[]; denied: string[]; levels: Array<{ repository: string; level: PushLevel }>; deploys: Array<{ repository: string; events: DeployEvent[] }>; stillAsks: readonly string[] }
  | { state: 'unknown'; reason: string; standing: PushPolicyStanding; allowed: []; denied: []; levels: []; deploys: []; stillAsks: readonly string[] }

export function pushPolicyStatus(read: PushPolicyRead, masterHasPointer: boolean | null): PushPolicyStatus {
  const standing = pushPolicyStanding(read, masterHasPointer)
  if (read.state === 'unknown') return { state: 'unknown', reason: read.reason, standing, allowed: [], denied: [], levels: [], deploys: [], stillAsks: PUSH_POLICY_STILL_ASKS }
  return {
    state: 'read', revision: read.record.revision, standing,
    allowed: read.record.owners.filter((owner) => owner.allowed).map((owner) => owner.login),
    denied: read.record.owners.filter((owner) => !owner.allowed).map((owner) => owner.login),
    levels: read.record.levels.map(({ repository, level }) => ({ repository, level })),
    deploys: read.record.deploys.map(({ repository, events }) => ({ repository, events })),
    stillAsks: PUSH_POLICY_STILL_ASKS
  }
}

/**
 * A GitHub remote's `owner/name`, from the URL forms `git remote get-url` prints; null for anything else. An SSH host alias
 * counts only when it names GitHub (`git@github-work:owner/name`), so a GitLab or other host never reads as GitHub.
 */
export function githubRepositoryFromRemote(url: string): string | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|git@[A-Za-z0-9._-]*github[A-Za-z0-9._-]*:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? pushPolicyRepository(`${match[1]}/${match[2]}`) : null
}
