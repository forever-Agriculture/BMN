// MODULE: setup-status.test.ts - Finish requires real approval, current app coverage and settled defaults
import { expect, it } from 'vitest'
import type { SetupAppsSnapshot, SetupDefaultsReport } from '@bmn/protocol'
import { setupStatus } from './setup-status'

const apps: SetupAppsSnapshot = { apps: [{ app: 'codex', program: '/synthetic/codex', onPath: true, version: '0.163.0',
  signIn: 'ready', method: 'chatgpt', qualification: 'measured' }], platform: 'linux', curlAvailable: true, checkedAt: '2026-10-21T00:00:00Z' }
const team = { members: ['codex'], pending: false }
const good: SetupDefaultsReport = { code: 'OK', source: '/synthetic/skills', names: [], rows:
  (['master', 'rules', 'skills', 'hooks', 'tools'] as const).map(kind => ({ kind, app: kind === 'master' ? null : 'codex', code: 'OK', state: 'installed',
    transaction: 'synthetic-install', paths: [], recoveryPaths: [] })) }

it('distinguishes ready apps needing approval from apps not yet ready', () => {
  expect(setupStatus(apps, { members: null, pending: false }, null)).toMatchObject({ team: 'Ready apps need a team', canFinish: false })
  expect(setupStatus({ ...apps, apps: [] }, { members: null, pending: false }, null).team).toBe('Waiting for a ready app')
})

it('enables Finish after approval and all four app defaults have completed', () => {
  expect(setupStatus(apps, team, good)).toMatchObject({ team: 'Approved · 1 member', defaults: 'Ready for 1 app', canFinish: true })
})

it('refuses completion for unapproved changes, missing members or newly ready apps', () => {
  expect(setupStatus(apps, { ...team, pending: true }, good).canFinish).toBe(false)
  expect(setupStatus(apps, { ...team, members: [] }, good).canFinish).toBe(false)
  expect(setupStatus(apps, { ...team, members: ['claude'] }, good)).toMatchObject({ team: 'A ready app needs a team member', canFinish: false })
})

it('does not mistake preparation, missing app kinds, a stopped run or recovery history for settled defaults', () => {
  for (const report of [{ ...good, rows: [] }, { ...good, rows: good.rows.filter(row => row.kind !== 'hooks') },
    { ...good, code: 'DEFAULTS_PARTIAL', rows: good.rows.filter(row => row.kind !== 'tools') }, { ...good, code: 'DEFAULTS_STATE_UNAVAILABLE' },
    { ...good, code: 'NOT_APPROVED' }, { ...good, rows: good.rows.map(row => ({ ...row, state: 'recovery' })) }]) {
    expect(setupStatus(apps, team, report).canFinish).toBe(false)
  }
})

it('lets a settled partial result finish while it still says which default needs attention', () => {
  const report: SetupDefaultsReport = { ...good, code: 'DEFAULTS_PARTIAL', rows: good.rows.map(row => row.kind === 'tools'
    ? { ...row, code: 'TOOLS_UNSUPPORTED', state: 'waiting', transaction: null } : row) }
  expect(setupStatus(apps, team, report)).toMatchObject({ defaults: 'Some defaults need attention', canFinish: true })
  expect(setupStatus(apps, { ...team, pending: true }, report).canFinish).toBe(false)
})

it('honours deliberate removals and retains every recovery location for the owner', () => {
  const report = structuredClone(good)
  report.rows[1]!.state = 'opted-out'
  report.rows[1]!.recoveryPaths = ['/synthetic/held-one', '/synthetic/held-two']
  report.rows[2]!.recoveryPaths = ['/synthetic/held-one']
  expect(setupStatus(apps, team, report)).toMatchObject({ canFinish: true, recoveryPaths: ['/synthetic/held-one', '/synthetic/held-two'] })
})
