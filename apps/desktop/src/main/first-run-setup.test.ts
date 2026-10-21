// MODULE: first-run-setup.test.ts - Existing-profile evidence and conservative failures
import { expect, it, vi } from 'vitest'
import { hasExistingSetupProfile } from './first-run-setup'

it('opens setup only when both master and approved team are absent', () => {
  expect(hasExistingSetupProfile({ masterExists: () => false, teamApproved: () => false })).toBe(false)
  expect(hasExistingSetupProfile({ masterExists: () => false, teamApproved: () => true })).toBe(true)
  const teamApproved = vi.fn(() => false)
  expect(hasExistingSetupProfile({ masterExists: () => true, teamApproved })).toBe(true)
  expect(teamApproved).not.toHaveBeenCalled()
  expect(hasExistingSetupProfile({ masterExists: () => { throw Object.assign(new Error('synthetic'), { code: 'ENOENT' }) },
    teamApproved: () => false })).toBe(false)
})

it('protects uncertain existing configuration', () => {
  expect(hasExistingSetupProfile({ masterExists: () => { throw Object.assign(new Error('synthetic'), { code: 'EACCES' }) },
    teamApproved: () => false })).toBe(true)
  expect(hasExistingSetupProfile({ masterExists: () => false, teamApproved: () => { throw new Error('synthetic') } })).toBe(true)
})
