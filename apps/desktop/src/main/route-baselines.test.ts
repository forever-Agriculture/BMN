// MODULE: route-baselines.test.ts - Epic 60.3 AC3: acceptance of an untested harness version is offered only for an unchanged route
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baselinesPath, judgeInspection, type RouteResolution } from './route-baselines'

let home: string
const savedHome = process.env.HOME
const now = new Date('2026-10-09T12:00:00.000Z')
const route = (extra: Partial<RouteResolution> = {}): RouteResolution => ({
  harness: 'codex', version: '0.161.0', provider: 'openai', host: 'default:openai', basis: 'default', sources: [], ...extra
})

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-baselines-')))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('accepting an untested harness version (60.3 AC3, 60.5 AC2)', () => {
  it('offers nothing before a tested or accepted version recorded its route', () => {
    expect(judgeInspection(route({ version: '0.170.0' }), [], false, now)).toMatchObject({ acceptable: false })
  })

  it('offers the untested version when it resolves the same route and sources as the tested one', () => {
    expect(judgeInspection(route(), [], true, now).acceptable).toBe(false)
    expect(statSync(baselinesPath()).mode & 0o777).toBe(0o600)
    const verdict = judgeInspection(route({ version: '0.170.0' }), [], false, now)
    expect(verdict).toEqual({ acceptable: true, comparison: 'Same route and sources as 0.161.0: default:openai (default, no overrides).' })
  })

  it.each([
    ['another host', { host: 'proxy.example.com', basis: 'explicit', sources: ['OPENAI_BASE_URL'] }],
    ['the same host from another source', { sources: ['config.toml model_provider'] }],
    ['an unknown route', { host: null, basis: 'unknown' }]
  ])('withholds it when the route changed: %s', (_name, change) => {
    judgeInspection(route(), [], true, now)
    expect(judgeInspection(route({ version: '0.170.0', ...change }), [], false, now).acceptable).toBe(false)
  })

  it('an accepted version becomes the record later versions are compared with', () => {
    judgeInspection(route(), [], true, now)
    judgeInspection(route({ version: '0.170.0', host: 'proxy.example.com', basis: 'explicit', sources: ['OPENAI_BASE_URL'] }), ['0.170.0'], true, now)
    expect(judgeInspection(route({ version: '0.171.0' }), ['0.170.0'], false, now).acceptable).toBe(false)
    expect(judgeInspection(route({ version: '0.171.0', host: 'proxy.example.com', basis: 'explicit', sources: ['OPENAI_BASE_URL'] }), ['0.170.0'], false, now).acceptable).toBe(true)
  })
})
