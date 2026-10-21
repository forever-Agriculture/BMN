// MODULE: setup-app-view.test.ts - Shared user-visible readiness states and actionable Codex trust guidance
import { expect, it } from 'vitest'
import type { SessionRecord, SetupAppReadiness } from '@bmn/protocol'
import { setupAppNeedsAction, setupAppView } from './setup-app-view'
const row: SetupAppReadiness = { app: 'codex', program: '/synthetic/codex', version: '0.163.0', onPath: true,
  signIn: 'ready', method: 'chatgpt', qualification: 'measured' }

it('separates installed/ready state from the sign-in detail without guessing readiness', () => {
  expect(setupAppView(row)).toEqual({ head: 'Ready', lines: ['Signed in'] })
  expect(setupAppView({ ...row, signIn: 'confirmed' })).toEqual({ head: 'Ready', lines: ['Confirmed by you'] })
  expect(setupAppView({ ...row, signIn: 'signed-out' })).toEqual({ head: 'Installed', lines: ['Not signed in'] })
  expect(setupAppView({ ...row, signIn: 'unknown', qualification: 'checking' })).toEqual({ head: 'Installed', lines: ['Sign-in unknown', 'Checking this version…'] })
  expect(setupAppView({ ...row, signIn: 'missing' })).toEqual({ head: 'Not installed', lines: [] })
})

it('keeps Codex ready and opens its own session for trust until BMN actually observes a hook', () => {
  for (const hookTrust of ['pending', 'unavailable'] as const) {
    const waiting = { ...row, hookTrust }
    expect(setupAppView(waiting).head).toBe('Ready')
    expect(setupAppView(waiting).lines.join('\n')).toContain('/hooks')
    expect(setupAppNeedsAction(waiting)).toBe(true)
  }
  const observed = { ...row, hookTrust: 'observed' as const }
  expect(setupAppView(observed).lines.join('\n')).not.toContain('/hooks')
  expect(setupAppView(observed).lines).toContain('BMN hook observed')
  expect(setupAppNeedsAction(observed)).toBe(false)
  expect(setupAppView({ ...observed, app: 'claude' }).lines).not.toContain('BMN hook observed')
})

it('explains that trust stays pending until a normal Codex session delivers a hook', () => {
  const pending = { ...row, hookTrust: 'pending' as const }
  const expected = 'Approve BMN’s hooks with /hooks, then start a normal Codex session in BMN. This stays pending until BMN observes a hook.'
  expect(setupAppView(pending).lines).toContain(expected)
  for (const action of ['install', 'login', 'check'] as const) {
    const session = { setup: { app: 'codex', action }, lastProcess: { state: 'live' } } as SessionRecord
    expect(setupAppView(pending, session).lines).toContain(expected)
  }
})

it.each(['install', 'login', 'check'] as const)('keeps Codex trust guidance visible during a live %s session', action => {
  const session = { setup: { app: 'codex', action }, lastProcess: { state: 'live' } } as SessionRecord
  const head = action === 'install' ? 'Installing…' : action === 'login' ? 'Signing in…' : 'Finish in the session'
  for (const hookTrust of ['pending', 'unavailable'] as const) {
    const waiting = { ...row, hookTrust }
    expect(setupAppView(waiting, session).head).toBe(head)
    expect(setupAppView(waiting, session).lines.join('\n')).toContain('/hooks')
    expect(setupAppNeedsAction(waiting, session)).toBe(true)
  }
  expect(setupAppView({ ...row, hookTrust: 'observed' }, session).lines).toEqual(['BMN hook observed'])
  expect(setupAppView({ ...row, app: 'claude' }, session)).toEqual({ head, lines: [] })
})
