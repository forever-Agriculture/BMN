// MODULE: route-baselines.test.ts - Epic 60.3 AC3: acceptance of an untested harness version is offered only for an unchanged route
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertStillAcceptable, baselinesPath, judgeInspection, type RouteResolution } from './route-baselines'

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
  const OVERRIDES: [string, Partial<RouteResolution>][] = [
    ['another host', { host: 'proxy.example.com', basis: 'explicit', sources: ['OPENAI_BASE_URL'] }],
    ['the default host named by a source', { sources: ['config.toml model_provider'] }],
    ['an unknown route', { host: null, basis: 'unknown' }],
    ['an unknown provider', { provider: null, host: null }],
    ["another provider's default", { host: 'default:anthropic' }]
  ]

  it("with no record, offers a version only on the provider's own destination with nothing overriding it", () => {
    const verdict = judgeInspection(route({ version: '0.170.0' }), [], false, now, () => 'OpenAI')
    expect(verdict).toEqual({ acceptable: true, comparison: "BMN has no earlier Codex version to compare with. 0.170.0 sends data to OpenAI's own servers (nothing overrides it)." })
    expect(() => assertStillAcceptable('0.170.0', route({ version: '0.170.0' }))).not.toThrow()
    // Judging an untested version writes no record: only a tested or accepted one does.
    expect(() => statSync(baselinesPath())).toThrow()
  })

  it.each(OVERRIDES)('with no record, withholds a version on %s', (_name, change) => {
    const verdict = judgeInspection(route({ version: '0.170.0', ...change }), [], false, now)
    expect(verdict.acceptable).toBe(false)
    expect(verdict.comparison).toContain("Without a record it accepts only the provider's own servers with nothing overriding them.")
    expect(() => assertStillAcceptable('0.170.0', route({ version: '0.170.0', ...change }))).toThrow(/no earlier codex version to compare with/)
  })

  it('with no record, offers Claude Code the same way and never calls an unknown destination unchanged', () => {
    const claude = route({ harness: 'claude', version: '2.1.296', provider: 'anthropic', host: 'default:anthropic' })
    expect(judgeInspection(claude, [], false, now, () => 'Anthropic')).toEqual({
      acceptable: true, comparison: "BMN has no earlier Claude Code version to compare with. 2.1.296 sends data to Anthropic's own servers (nothing overrides it)."
    })
    const unknown = judgeInspection({ ...claude, provider: null, host: null, basis: 'unknown' }, [], false, now)
    expect(unknown.acceptable).toBe(false)
    expect(unknown.comparison).toContain('2.1.296 sends data to a destination BMN cannot establish.')
    expect(unknown.comparison).not.toContain('nothing overrides it')
  })

  it('a record that was lost or cannot be read counts as none: only the plain default is offered again', () => {
    const proxy = { host: 'proxy.example.com', basis: 'explicit', sources: ['OPENAI_BASE_URL'] }
    judgeInspection(route(proxy), [], true, now)
    expect(judgeInspection(route({ version: '0.170.0' }), [], false, now).acceptable).toBe(false)
    writeFileSync(baselinesPath(), '{ not json')
    expect(judgeInspection(route({ version: '0.170.0', ...proxy }), [], false, now).acceptable).toBe(false)
    expect(() => assertStillAcceptable('0.170.0', route({ version: '0.170.0', ...proxy }))).toThrow(/no earlier codex version to compare with/)
    expect(judgeInspection(route({ version: '0.170.0' }), [], false, now).acceptable).toBe(true)
  })

  it('with no record, still refuses a version that is not the installed one', () => {
    expect(() => assertStillAcceptable('0.170.0', route({ version: '0.171.0' }))).toThrow(/is not the installed version/)
  })

  it('a version accepted without a record becomes the record: a later override is then withheld', () => {
    expect(judgeInspection(route({ version: '0.170.0' }), [], false, now).acceptable).toBe(true)
    judgeInspection(route({ version: '0.170.0' }), ['0.170.0'], true, now)
    expect(judgeInspection(route({ version: '0.171.0' }), ['0.170.0'], false, now).comparison).toContain('Sends data to the same place as 0.170.0')
    const moved = route({ version: '0.171.0', host: 'proxy.example.com', basis: 'explicit', sources: ['OPENAI_BASE_URL'] })
    expect(judgeInspection(moved, ['0.170.0'], false, now).acceptable).toBe(false)
    expect(() => assertStillAcceptable('0.171.0', moved)).toThrow(/does not send data where a tested or accepted version did/)
  })

  it('offers the untested version when it resolves the same route and sources as the tested one', () => {
    expect(judgeInspection(route(), [], true, now).acceptable).toBe(false)
    expect(statSync(baselinesPath()).mode & 0o777).toBe(0o600)
    const verdict = judgeInspection(route({ version: '0.170.0' }), [], false, now)
    expect(verdict).toEqual({ acceptable: true, comparison: "Sends data to the same place as 0.161.0: openai's own servers (nothing overrides it)." })
    // The page passes the team's provider names, so the owner never reads an id.
    expect(judgeInspection(route({ version: '0.170.0' }), [], false, now, () => 'OpenAI').comparison).toBe("Sends data to the same place as 0.161.0: OpenAI's own servers (nothing overrides it).")
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
