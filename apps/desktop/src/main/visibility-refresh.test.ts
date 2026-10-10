// MODULE: visibility-refresh.test.ts - Epic 60.3 AC10: a session opening in a workspace refreshes its visibility record at most once a day, and only when a team file exists
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { visibilityPath, workspaceVisibility } from '../../bin/agents-check.mjs'
import { refreshVisibilityOnOpen, resetVisibilityRefresh } from './visibility-refresh'

const COMMIT = 'a'.repeat(40)
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, BMN_STATE_HOME: process.env.BMN_STATE_HOME }

let home: string
let workspace: string
let asked: string[]

/** GitHub's two unauthenticated answers for a public repository, as the refresh reads them. */
const github = (async (url: string | URL | Request) => {
  asked.push(String(url))
  return String(url).includes('/commits/')
    ? new Response(COMMIT, { status: 200 })
    : new Response(JSON.stringify({ id: 4242, private: false, visibility: 'public', default_branch: 'main' }), { status: 200 })
}) as typeof fetch

const at = (iso: string): Date => new Date(iso)
const withTeamFile = (): void => {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), '# synthetic team file\n')
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-visibility-refresh-')))
  workspace = join(home, 'work/example')
  mkdirSync(join(workspace, 'packages/inner'), { recursive: true })
  execFileSync('git', ['init', '-q', workspace])
  execFileSync('git', ['-C', workspace, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-repository.git'])
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
  delete process.env.XDG_STATE_HOME
  delete process.env.BMN_STATE_HOME
  asked = []
  resetVisibilityRefresh()
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

describe('visibility refresh when a session opens', () => {
  it('asks nothing while no team file exists', async () => {
    expect(await refreshVisibilityOnOpen(workspace, { request: github })).toBe('skipped')
    expect(asked).toEqual([])
    expect(existsSync(visibilityPath(workspace))).toBe(false)
  })

  it('writes the record of the workspace a folder inside it belongs to', async () => {
    withTeamFile()
    const now = at('2026-03-01T10:00:00.000Z')
    expect(await refreshVisibilityOnOpen(join(workspace, 'packages/inner'), { request: github, now })).toBe('refreshed')
    expect(asked).toEqual([
      'https://api.github.com/repos/example-owner/example-repository',
      'https://api.github.com/repos/example-owner/example-repository/commits/main'
    ])
    expect(workspaceVisibility(workspace, now)).toMatchObject({ public: true, record: { origin: 'github.com/example-owner/example-repository', repository_id: 4242, commit: COMMIT } })
    expect(JSON.parse(readFileSync(visibilityPath(workspace), 'utf8'))).not.toHaveProperty('url')
  })

  it('asks again only after a day, whichever session opens', async () => {
    withTeamFile()
    expect(await refreshVisibilityOnOpen(workspace, { request: github, now: at('2026-03-01T10:00:00.000Z') })).toBe('refreshed')
    expect(await refreshVisibilityOnOpen(join(workspace, 'packages'), { request: github, now: at('2026-03-02T09:59:59.000Z') })).toBe('fresh')
    expect(asked).toHaveLength(2)
    expect(await refreshVisibilityOnOpen(workspace, { request: github, now: at('2026-03-02T10:00:00.000Z') })).toBe('refreshed')
    expect(asked).toHaveLength(4)
  })

  it('trusts a record another BMN process wrote today', async () => {
    withTeamFile()
    await refreshVisibilityOnOpen(workspace, { request: github, now: at('2026-03-01T10:00:00.000Z') })
    resetVisibilityRefresh()
    expect(await refreshVisibilityOnOpen(workspace, { request: github, now: at('2026-03-01T18:00:00.000Z') })).toBe('fresh')
    expect(asked).toHaveLength(2)
  })

  it('replaces a record dated in the future', async () => {
    withTeamFile()
    await refreshVisibilityOnOpen(workspace, { request: github, now: at('2026-03-05T10:00:00.000Z') })
    resetVisibilityRefresh()
    expect(await refreshVisibilityOnOpen(workspace, { request: github, now: at('2026-03-01T10:00:00.000Z') })).toBe('refreshed')
    expect(JSON.parse(readFileSync(visibilityPath(workspace), 'utf8')).checked_at).toBe('2026-03-01T10:00:00.000Z')
  })

  it('asks once for two sessions opening together', async () => {
    withTeamFile()
    const now = at('2026-03-01T10:00:00.000Z')
    const both = await Promise.all([refreshVisibilityOnOpen(workspace, { request: github, now }), refreshVisibilityOnOpen(workspace, { request: github, now })])
    expect(both).toEqual(['refreshed', 'refreshed'])
    expect(asked).toHaveLength(2)
  })

  it('records private for a day when GitHub cannot be reached, without throwing', async () => {
    withTeamFile()
    const offline = (async () => { asked.push('offline'); throw new Error('synthetic network failure') }) as typeof fetch
    expect(await refreshVisibilityOnOpen(workspace, { request: offline, now: at('2026-03-01T10:00:00.000Z') })).toBe('refreshed')
    expect(workspaceVisibility(workspace, at('2026-03-01T10:00:01.000Z'))).toMatchObject({ public: false, reason: 'check failed' })
    expect(await refreshVisibilityOnOpen(workspace, { request: offline, now: at('2026-03-01T11:00:00.000Z') })).toBe('fresh')
    expect(asked).toEqual(['offline'])
  })

  it('skips a folder that does not exist', async () => {
    withTeamFile()
    expect(await refreshVisibilityOnOpen(join(home, 'gone'), { request: github })).toBe('skipped')
    expect(asked).toEqual([])
  })
})
