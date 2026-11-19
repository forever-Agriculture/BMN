// MODULE: grant-facts.test.ts - night facts identify exhausted ceilings and required-check states
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classifyRequiredChecks, grantFactConflicts, grantFacts } from '../../bin/grant-facts.mjs'

describe('night facts', () => {
  it('identifies approval-required facts and excludes pending checks under a permissive rule', () => {
    const conflicts = grantFactConflicts({
      plan: { limits: [
        { name: 'rechecks', ceiling: 4, value: 4, left: 0, boundaries: [
          { boundary: '7.2', used: 4, left: 0 }, { boundary: '7.3', used: 0, left: 4 }
        ] },
        { name: 'consults', ceiling: 6, value: 4, used: 4, left: 0 },
        { name: 'full_reviews', ceiling: 4, value: 4, used: null, left: null },
        { name: 'money_usd', ceiling: null, value: 0, used: 0, left: 0 }
      ] },
      pullRequests: { items: [
        { repository: 'example/app', number: 1, policy: 'merge-when-green', mayMerge: false },
        { repository: 'example/app', number: 2, policy: 'merge-and-push-main', mayMerge: true },
        { repository: 'example/target', number: 3, policy: 'asks-owner', mayMerge: false }
      ] }
    })
    expect(conflicts).toEqual([
      { id: 'limit:rechecks:7.2', words: 'rechecks at 7.2: 4 of 4 used' },
      { id: 'pr:example/target:3', words: 'PR #3 in example/target needs merge approval' }
    ])
  })

  it('does not treat no checks, skipped checks or a pending check as green', () => {
    expect(classifyRequiredChecks([])).toBe('unknown')
    expect(classifyRequiredChecks([{ state: 'SKIPPED', bucket: 'skipping' }])).toBe('unconfirmed')
    expect(classifyRequiredChecks([{ state: 'IN_PROGRESS', bucket: 'pending' }])).toBe('pending')
    expect(classifyRequiredChecks([{ state: 'FAILURE', bucket: 'fail' }])).toBe('failed')
    expect(classifyRequiredChecks([{ state: 'SUCCESS', bucket: 'pass' }])).toBe('green')
  })
})

it('reads the run’s fork PR and checks through a second account without mistaking a pending long-term policy for an approval need', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-night-fork-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const head = 'a'.repeat(40)
  const gh = `#!/bin/sh
case "$1:$2:$3" in
  repo:view:example/fork) printf '%s\n' '{"owner":{"login":"example"},"defaultBranchRef":{"name":"main"},"name":"fork","isFork":true,"parent":{"nameWithOwner":"upstream/app"}}';;
  repo:view:upstream/app) [ "$GH_TOKEN" = 'test-alternate' ] || exit 1
    printf '%s\n' '{"owner":{"login":"upstream"},"defaultBranchRef":{"name":"main"},"name":"app","isFork":false,"parent":null}';;
  auth:status:*) printf '%s\n' 'Logged in to github.com account alternate';;
  auth:token:*) printf '%s\n' 'test-alternate';;
  pr:list:*) case "$4" in
    example/fork) printf '[]\n';;
    upstream/app) [ "$GH_TOKEN" = 'test-alternate' ] || exit 1
      printf '%s\n' '[{"number":42,"headRefName":"feature","headRefOid":"${head}","baseRefName":"main","isCrossRepository":true,"headRepository":{"name":"fork"},"headRepositoryOwner":{"login":"example"}}]';;
    *) exit 1;;
  esac;;
  pr:checks:42) [ "$GH_TOKEN" = 'test-alternate' ] || exit 1
    printf '%s\n' '[{"state":"IN_PROGRESS","bucket":"pending"}]'; exit 8;;
  *) exit 1;;
esac
`
  try {
    writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    vi.stubEnv('GH_TOKEN', '')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-b', 'feature')
    git('remote', 'add', 'origin', 'https://github.com/example/fork.git')
    const check = (level: 'prs-only' | 'merge-when-green') => grantFacts({
      cwd: root, project: root, runId: 'run', epic: undefined,
      policy: { state: 'read', revision: 1, standing: { authorizes: true, why: null },
        allowed: ['example', 'upstream'], denied: [], stillAsks: [], levels: [{ repository: 'upstream/app', level }], deploys: [] }
    })
    const permissive = await check('merge-when-green')
    expect(permissive.pullRequests).toMatchObject({ state: 'read', items: [{ repository: 'upstream/app', number: 42, headSha: head, checks: 'pending', mayMerge: false }] })
    expect(permissive.conflicts).toEqual([])
    expect((await check('prs-only')).conflicts).toEqual([{ id: 'pr:upstream/app:42', words: 'PR #42 in upstream/app needs merge approval' }])
  } finally {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
