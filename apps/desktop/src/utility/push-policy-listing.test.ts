// MODULE: push-policy-listing.test.ts - Story 83.3: what Health lists, over made-up session folders, remotes and GitHub answers
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPushPolicy, type PushPolicyRead } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { REPOSITORY_LIMIT, pushPolicyView, systemPolicyReader, type PolicyReader, type RepositoryFacts } from './push-policy-listing'

const REMOTES: Record<string, string | null> = {
  '/work/widgets': 'octo/widgets', '/work/widgets-2': 'octo/widgets', '/work/api': 'acme/api', '/work/gone': 'octo/gone', '/work/plain': null
}
const FACTS: Record<string, RepositoryFacts> = {
  'octo/widgets': { repository: 'octo/widgets', owner: 'octo', organisation: false, defaultBranch: 'main' },
  'acme/api': { repository: 'acme/api', owner: 'acme', organisation: true, defaultBranch: 'trunk' },
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

  it('shows the stored decisions and levels, and a repository GitHub could not confirm at its stored level with why', async () => {
    const view = await pushPolicyView(stored({
      owners: [{ login: 'acme', allowed: true, changedAt: '2026-10-18T19:00:00.000Z' }],
      levels: [{ repository: 'acme/api', level: 'merge-and-push-main', changedAt: '2026-10-18T19:00:00.000Z' }, { repository: 'octo/gone', level: 'merge-when-green', changedAt: '2026-10-18T19:00:00.000Z' }]
    }), Object.keys(REMOTES), reader())
    expect(view.standing.authorizes).toBe(true)
    const acme = view.owners.find((owner) => owner.login === 'acme')!
    expect(acme).toMatchObject({ allowed: true, repositories: [{ repository: 'acme/api', level: 'merge-and-push-main', defaultBranch: 'trunk', unread: null }] })
    const gone = view.owners.find((owner) => owner.login === 'octo')!.repositories.find((r) => r.name === 'gone')!
    expect(gone).toEqual({ repository: 'octo/gone', name: 'gone', level: 'merge-when-green', defaultBranch: null, unread: 'GitHub did not answer for this repository' })
  })

  it('looks up at most the limit on GitHub and still lists every repository past it, unread, under its remote\'s owner', async () => {
    const asked: string[] = []
    const many = Array.from({ length: REPOSITORY_LIMIT + 2 }, (_, index) => `/work/r${String(index).padStart(3, '0')}`)
    const view = await pushPolicyView(readPushPolicy(undefined), [...many, '/work/zz'], {
      ...reader(),
      remote: async (directory) => directory === '/work/zz' ? 'zeta-org/last' : `octo/${directory.split('/').pop()}`,
      repository: async (repository) => {
        asked.push(repository)
        return { repository, owner: repository.split('/')[0]!, organisation: false, defaultBranch: 'main' }
      }
    })
    expect(asked).toHaveLength(REPOSITORY_LIMIT)
    expect(view.owners.find((owner) => owner.login === 'octo')!.repositories).toHaveLength(REPOSITORY_LIMIT + 2)
    expect(view.owners.find((owner) => owner.login === 'zeta-org')!.repositories).toEqual([
      { repository: 'zeta-org/last', name: 'last', level: 'prs-only', defaultBranch: null, unread: `not looked up: Health reads at most ${REPOSITORY_LIMIT} repositories from GitHub` }
    ])
  })

  it('keeps an allowed owner and a raised repository listed after the last session in them went away, so both can be revoked', async () => {
    const view = await pushPolicyView(stored({
      owners: [{ login: 'octo', allowed: false, changedAt: '2026-10-18T19:00:00.000Z' }, { login: 'far-org', allowed: true, changedAt: '2026-10-18T19:00:00.000Z' }],
      levels: [{ repository: 'far-org/tool', level: 'merge-and-push-main', changedAt: '2026-10-18T19:00:00.000Z' }]
    }), [], { ...reader(), signedIn: async () => ['octo'] })
    expect(view.standing.authorizes).toBe(true)
    expect(view.owners.map((owner) => [owner.login, owner.allowed])).toEqual([['octo', false], ['far-org', true]])
    expect(view.owners[1]!.repositories).toEqual([
      { repository: 'far-org/tool', name: 'tool', level: 'merge-and-push-main', defaultBranch: null, unread: null, note: 'no session works in it now' }
    ])
    // When discovery fails outright, the same holds.
    const failing = await pushPolicyView(stored({ owners: [{ login: 'far-org', allowed: true, changedAt: '2026-10-18T19:00:00.000Z' }] }),
      ['/work/widgets'], { ...reader(), remote: async () => null, signedIn: async () => [] })
    expect(failing.owners.map((owner) => [owner.login, owner.allowed])).toEqual([['far-org', true]])
  })

  it('names a repository by GitHub\'s own name when a checkout\'s remote still has its old name, once for two checkouts', async () => {
    const renamed: RepositoryFacts = { repository: 'octo/gadgets', owner: 'octo', organisation: false, defaultBranch: 'main' }
    const view = await pushPolicyView(stored({
      owners: [{ login: 'octo', allowed: true, changedAt: '2026-10-18T19:00:00.000Z' }],
      levels: [{ repository: 'octo/gadgets', level: 'merge-and-push-main', changedAt: '2026-10-18T19:00:00.000Z' }]
    }), ['/old', '/new'], {
      ...reader(),
      remote: async (directory) => directory === '/old' ? 'octo/widgets-old' : 'octo/gadgets',
      repository: async () => renamed
    })
    expect(view.owners.find((owner) => owner.login === 'octo')!.repositories).toEqual([
      { repository: 'octo/gadgets', name: 'gadgets', level: 'merge-and-push-main', defaultBranch: 'main', unread: null }
    ])
  })

  it('is not in force without the master\'s pointer, and an unreadable store shows every owner denied', async () => {
    const allowed = stored({ owners: [{ login: 'octo', allowed: true, changedAt: '2026-10-18T19:00:00.000Z' }] })
    expect((await pushPolicyView(allowed, [], reader(false))).standing).toEqual({ authorizes: false, why: 'the rules master does not carry the policy pointer' })
    const unknown = await pushPolicyView(readPushPolicy('{"version":1}'), Object.keys(REMOTES), reader())
    expect(unknown.state).toBe('unknown')
    expect(unknown.owners.every((owner) => !owner.allowed)).toBe(true)
  })

  it('reads a repository only another signed-in account sees, asking gh for that account\'s token by gh\'s own spelling', async () => {
    // Like the real gh: `auth token --user` matches the name exactly, and `auth status` exits 1 when one account is broken.
    const folder = await mkdtemp(join(tmpdir(), 'bmn-policy-gh-'))
    await writeFile(join(folder, 'gh'), `#!/bin/sh
case "$1 $2" in
  "auth status") echo "  ✓ Logged in to github.com account Active-One (keyring)" >&2; echo "  ✓ Logged in to github.com account Forever-Probe (keyring)" >&2; exit 1;;
  "auth token") if [ "$4" = "Forever-Probe" ]; then echo made-up-token; else echo "no oauth token found for github.com account $4" >&2; exit 1; fi;;
  "repo view") if [ "$GH_TOKEN" = "made-up-token" ]; then echo '{"owner":{"login":"Forever-Probe"},"name":"Tool","isInOrganization":false,"defaultBranchRef":{"name":"main"}}'; else echo "HTTP 404" >&2; exit 1; fi;;
  *) exit 1;;
esac
`)
    await chmod(join(folder, 'gh'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${folder}:${path}`
    try {
      const reader = systemPolicyReader(async () => true)
      expect(await reader.signedIn()).toEqual(['Active-One', 'Forever-Probe'])
      expect(await reader.repository('forever-probe/tool')).toEqual({ repository: 'forever-probe/tool', owner: 'forever-probe', organisation: false, defaultBranch: 'main' })
      const view = await pushPolicyView(readPushPolicy(undefined), [], reader)
      expect(view.owners.map((owner) => owner.login)).toEqual(['active-one', 'forever-probe'])
    } finally {
      process.env.PATH = path
      await rm(folder, { recursive: true, force: true })
    }
  })
})
