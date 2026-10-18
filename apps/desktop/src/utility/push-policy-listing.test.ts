// MODULE: push-policy-listing.test.ts - Story 83.3: what Health lists, over made-up session folders, remotes and GitHub answers
import { readPushPolicy, type PushPolicyRead } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { pushPolicyView, type PolicyReader, type RepositoryFacts } from './push-policy-listing'

const REMOTES: Record<string, string | null> = {
  '/work/widgets': 'octo/widgets', '/work/widgets-2': 'octo/widgets', '/work/api': 'acme/api', '/work/gone': 'octo/gone', '/work/plain': null
}
const FACTS: Record<string, RepositoryFacts> = {
  'octo/widgets': { owner: 'octo', organisation: false, defaultBranch: 'main' },
  'acme/api': { owner: 'acme', organisation: true, defaultBranch: 'trunk' },
  'octo/gone': { unread: 'GitHub did not answer for this repository' }
}
const reader = (pointer: boolean | null = true): PolicyReader => ({
  remote: async (directory) => REMOTES[directory] ?? null,
  repository: async (repository) => FACTS[repository] ?? { unread: 'unknown' },
  signedIn: async () => ['octo', 'solo'],
  masterHasPointer: async () => pointer
})
const stored = (record: object): PushPolicyRead => readPushPolicy(JSON.stringify({ version: 1, revision: 2, owners: [], levels: [], ...record }))

describe('Health\'s push policy listing (Story 83.3)', () => {
  it('lists every signed-in account and every owner the sessions work in, all denied at first, each repository once at PRs only', async () => {
    const view = await pushPolicyView(readPushPolicy(undefined), Object.keys(REMOTES), reader())
    expect(view.state).toBe('read')
    expect(view.standing).toEqual({ authorizes: false, why: 'no owner is allowed in Health' })
    expect(view.owners.map((owner) => [owner.login, owner.kind, owner.signedIn, owner.allowed, owner.repositories.map((r) => `${r.name}:${r.level}`)])).toEqual([
      ['octo', 'account', true, false, ['gone:prs-only', 'widgets:prs-only']],
      ['solo', 'account', true, false, []],
      ['acme', 'organisation', false, false, ['api:prs-only']]
    ])
  })

  it('shows the stored decisions and levels, and a repository GitHub could not confirm at PRs only with why', async () => {
    const view = await pushPolicyView(stored({
      owners: [{ login: 'acme', allowed: true, changedAt: '2026-10-18T19:00:00.000Z' }],
      levels: [{ repository: 'acme/api', level: 'merge-and-push-main', changedAt: '2026-10-18T19:00:00.000Z' }, { repository: 'octo/gone', level: 'merge-when-green', changedAt: '2026-10-18T19:00:00.000Z' }]
    }), Object.keys(REMOTES), reader())
    expect(view.standing.authorizes).toBe(true)
    const acme = view.owners.find((owner) => owner.login === 'acme')!
    expect(acme).toMatchObject({ allowed: true, repositories: [{ repository: 'acme/api', level: 'merge-and-push-main', defaultBranch: 'trunk', unread: null }] })
    const gone = view.owners.find((owner) => owner.login === 'octo')!.repositories.find((r) => r.name === 'gone')!
    expect(gone).toEqual({ repository: 'octo/gone', name: 'gone', level: 'prs-only', defaultBranch: null, unread: 'GitHub did not answer for this repository' })
  })

  it('is not in force without the master\'s pointer, and an unreadable store shows every owner denied', async () => {
    const allowed = stored({ owners: [{ login: 'octo', allowed: true, changedAt: '2026-10-18T19:00:00.000Z' }] })
    expect((await pushPolicyView(allowed, [], reader(false))).standing).toEqual({ authorizes: false, why: 'the rules master does not carry the policy pointer' })
    const unknown = await pushPolicyView(readPushPolicy('{"version":1}'), Object.keys(REMOTES), reader())
    expect(unknown.state).toBe('unknown')
    expect(unknown.owners.every((owner) => !owner.allowed)).toBe(true)
  })
})
