// MODULE: push-policy-listing.ts - what Health lists for the push policy: the GitHub owners and repositories BMN's sessions work in (Story 83.3)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  githubRepositoryFromRemote,
  pushPolicyLogin,
  pushPolicyStanding,
  type PushPolicyOwnerView,
  type PushPolicyRead,
  type PushPolicyView
} from '@bmn/protocol'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 5_000
/** GitHub answers are kept this long, so opening Health does not ask GitHub again each time. */
const CACHE_MS = 10 * 60_000
/** At most this many repositories are looked up on GitHub, which bounds what one Health read can cost; the rest are still listed. */
export const REPOSITORY_LIMIT = 64

export type RepositoryFacts = { owner: string; organisation: boolean; defaultBranch: string } | { unread: string }

/** The reads the listing needs; tests give their own. */
export interface PolicyReader {
  /** The `owner/name` of the checkout's GitHub remote, or null when it has none. */
  remote(directory: string): Promise<string | null>
  /** The repository's owner, whether it is an organisation, and its default branch, as GitHub says. */
  repository(repository: string): Promise<RepositoryFacts>
  /** The accounts signed in with `gh` on this computer; they only name rows. */
  signedIn(): Promise<string[]>
  /** Whether the rules master carries the policy pointer; null when it cannot be read. */
  masterHasPointer(): Promise<boolean | null>
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0'
})

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync(command, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8', env })
  return result.stdout
}

/** Reads through `git` and `gh` on this computer, each signed-in account tried in turn for a repository the active one cannot see. */
export function systemPolicyReader(masterHasPointer: () => Promise<boolean | null>): PolicyReader {
  const cache = new Map<string, { at: number; facts: RepositoryFacts }>()
  const ghEnvironment = (token?: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LC_ALL: 'C', GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1', ...(token === undefined ? {} : { GH_TOKEN: token })
  })
  const reader: PolicyReader = {
    async remote(directory) {
      try {
        return githubRepositoryFromRemote((await run('git', ['-C', directory, 'remote', 'get-url', 'origin'], gitEnvironment())).trim())
      } catch {
        return null
      }
    },
    async repository(repository) {
      const kept = cache.get(repository)
      if (kept !== undefined && Date.now() - kept.at < CACHE_MS) return kept.facts
      const view = async (token?: string): Promise<RepositoryFacts> => {
        const text = await run('gh', ['repo', 'view', repository, '--json', 'owner,isInOrganization,defaultBranchRef'], ghEnvironment(token))
        const value = JSON.parse(text) as { owner?: { login?: unknown }; isInOrganization?: unknown; defaultBranchRef?: { name?: unknown } }
        const owner = pushPolicyLogin(value.owner?.login)
        const branch = typeof value.defaultBranchRef?.name === 'string' && value.defaultBranchRef.name !== '' ? value.defaultBranchRef.name : null
        if (owner === null) return { unread: 'GitHub named no owner' }
        if (branch === null) return { unread: 'GitHub named no default branch' }
        return { owner, organisation: value.isInOrganization === true, defaultBranch: branch }
      }
      let facts: RepositoryFacts
      try {
        facts = await view()
      } catch {
        facts = { unread: 'GitHub did not answer for this repository' }
        for (const account of await reader.signedIn()) {
          try {
            const token = (await run('gh', ['auth', 'token', '--user', account], ghEnvironment())).trim()
            facts = await view(token)
            break
          } catch { /* the next account */ }
        }
      }
      cache.set(repository, { at: Date.now(), facts })
      return facts
    },
    async signedIn() {
      try {
        const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: TIMEOUT_MS, encoding: 'utf8', env: ghEnvironment() })
        return [...`${stdout}\n${stderr}`.matchAll(/Logged in to github\.com account ([A-Za-z0-9-]+)/g)].flatMap((match) => pushPolicyLogin(match[1]) ?? [])
      } catch {
        return []
      }
    },
    // Only the app's entry point reads the rules master (R60-NFR3); this process asks it.
    masterHasPointer
  }
  return reader
}

/**
 * Health's view: every owner of a repository a session works in, and every signed-in account, each with the stored decision
 * (denied unless he allowed it); under each, its repositories at their stored level, an unreadable one at PRs only with why.
 */
export async function pushPolicyView(read: PushPolicyRead, directories: readonly string[], reader: PolicyReader): Promise<PushPolicyView> {
  const [masterHasPointer, signedIn] = await Promise.all([reader.masterHasPointer(), reader.signedIn()])
  const remotes = [...new Set((await Promise.all([...new Set(directories)].map((directory) => reader.remote(directory)))).flatMap((remote) => remote ?? []))]
    .sort()
  // Past the limit a repository is listed unread under the owner its remote names, so no owner drops out of the list.
  const facts = await Promise.all(remotes.map(async (repository, index) => ({
    repository,
    facts: index < REPOSITORY_LIMIT ? await reader.repository(repository) : { unread: `not looked up: Health reads at most ${REPOSITORY_LIMIT} repositories from GitHub` }
  })))
  const record = read.state === 'read' ? read.record : null
  const owners = new Map<string, PushPolicyOwnerView>()
  const ownerRow = (login: string): PushPolicyOwnerView => {
    let row = owners.get(login)
    if (row === undefined) {
      row = {
        login, kind: 'unknown', signedIn: signedIn.includes(login),
        allowed: record?.owners.find((owner) => owner.login === login)?.allowed === true, repositories: []
      }
      owners.set(login, row)
    }
    return row
  }
  for (const login of signedIn) ownerRow(login).kind = 'account'
  for (const { repository, facts: found } of facts) {
    // A repository GitHub could not confirm is listed under the owner its remote names, at PRs only, with the reason.
    const owner = 'unread' in found ? repository.split('/')[0]! : found.owner
    const row = ownerRow(owner)
    if (!('unread' in found)) row.kind = found.organisation ? 'organisation' : 'account'
    const confirmed = 'unread' in found ? repository : `${found.owner}/${repository.split('/')[1]}`
    row.repositories.push({
      repository: confirmed, name: confirmed.split('/')[1]!,
      level: 'unread' in found ? 'prs-only' : record?.levels.find((entry) => entry.repository === confirmed)?.level ?? 'prs-only',
      defaultBranch: 'unread' in found ? null : found.defaultBranch,
      unread: 'unread' in found ? found.unread : null
    })
  }
  const list = [...owners.values()].sort((a, b) => Number(b.signedIn) - Number(a.signedIn) || a.login.localeCompare(b.login))
  for (const row of list) row.repositories.sort((a, b) => a.name.localeCompare(b.name))
  const standing = pushPolicyStanding(read, masterHasPointer)
  return read.state === 'read'
    ? { state: 'read', revision: read.record.revision, standing, owners: list }
    : { state: 'unknown', reason: read.reason, standing, owners: list.map((row) => ({ ...row, allowed: false })) }
}
