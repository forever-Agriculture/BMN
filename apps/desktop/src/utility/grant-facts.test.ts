import { describe, expect, it } from 'vitest'
import { classifyRequiredChecks, grantFactConflicts } from '../../bin/grant-facts.mjs'

describe('night facts', () => {
  it('identifies only the exhausted boundary and the pull request that still waits', () => {
    const conflicts = grantFactConflicts({
      plan: { limits: [
        { name: 'rechecks', ceiling: 4, value: 4, left: 0, boundaries: [
          { boundary: '7.2', used: 4, left: 0 }, { boundary: '7.3', used: 0, left: 4 }
        ] },
        { name: 'consults', ceiling: 6, value: 4, used: 4, left: 0 },
        { name: 'full_reviews', ceiling: 4, value: 4, used: null, left: null }
      ] },
      pullRequests: { items: [
        { repository: 'example/app', number: 1, policy: 'merge-when-green', mayMerge: false },
        { repository: 'example/app', number: 2, policy: 'merge-and-push-main', mayMerge: true }
      ] }
    })
    expect(conflicts).toEqual([
      { id: 'limit:rechecks:7.2', words: 'rechecks at 7.2: 4 of 4 used' },
      { id: 'pr:example/app:1', words: 'PR #1 in example/app is waiting for green required checks' }
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
