// MODULE: doctor-health.test.ts - Approved doctor states, attention count and show-only leftover markup
import type { DoctorCheck, DoctorRow, DoctorView } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DoctorHealth, doctorAge, doctorNeedsCount, doctorPlace, doctorStateWords, leftoverGroups } from './doctor-health'

const CHECKS: DoctorCheck[] = ['hooks', 'skills', 'tools', 'rules', 'claude', 'codex', 'leftovers']
const AT = 1792400000000
const row = (check: DoctorCheck, extra: Partial<DoctorRow> = {}): DoctorRow => ({ check, state: 'passed', problems: [], leftovers: [], checkedAt: AT, stale: false, ...extra })
const view = (rows: DoctorRow[] = CHECKS.map((check) => row(check))): DoctorView => ({ schemaVersion: 1, locationHelp: 'Names are withheld.', running: false,
  cycleStartedAt: AT, attemptStartedAt: AT, retryUsed: false, retryAtNextStart: false, error: null, rows, problemCount: 0, allWell: true, exitCode: 0 })
const markup = (value: DoctorView | undefined): string => renderToStaticMarkup(createElement(DoctorHealth, { view: value, now: AT + 60000 }))

describe('Health doctor', () => {
  it('shows one quiet All well only after every applicable check passed fresh', () => {
    const html = markup(view())
    expect(html).toContain('All well · 7 checks passed · checked 1 min ago')
    expect(html).not.toContain('class="health-row"')
    expect(markup(view([row('codex', { stale: true })]))).not.toContain('All well')
    expect(markup({ ...view(), error: 'run-unavailable' })).not.toContain('All well')
  })

  it('retains old problems and their timestamps while checking', () => {
    const value = view([row('codex', { state: 'problems', problems: [{ code: 'missing-program', item: 1, reason: 'MCP program is missing', fix: 'Install the program.' }] })])
    const html = markup({ ...value, running: true, allWell: false, retryAtNextStart: true })
    // Story 96.6: Doctor says on its own line that it is running and how old the results below are; it is no live status.
    expect(html).toMatch(/Doctor running · results below are from \d\d:\d\d/)
    expect(html).not.toContain('role="status"')
    expect(html).toContain('MCP program is missing')
    expect(html).toContain('1 min ago')
    expect(html).toContain('Tries once more at the next start.')
    expect(html).not.toContain('All well')
  })

  it('ages an idle open Health view past the 24-hour boundary without retaining All well', () => {
    const value = view()
    const html = renderToStaticMarkup(createElement(DoctorHealth, { view: value, now: AT + 24 * 3600000 + 1 }))
    expect(html).not.toContain('All well')
    expect(html).toContain('Passed · stale')
  })

  it('names failures, timeouts, unsupported, interrupted and stale results', () => {
    expect(doctorStateWords(row('codex', { state: 'timeout' }))).toBe('Did not finish · stopped after 60 s')
    expect(doctorStateWords(row('codex', { state: 'unsupported' }))).toBe('Not supported for this version')
    expect(doctorStateWords(row('codex', { state: 'unqualified' }))).toBe('Not checked for this version')
    expect(doctorStateWords(row('hooks', { state: 'unqualified' }))).toBe('Not checked yet')
    expect(doctorStateWords(row('codex', { state: 'interrupted' }))).toBe('Interrupted')
    expect(doctorStateWords(row('codex', { state: 'failed' }))).toBe('Could not run')
    expect(markup(view([row('codex', { stale: true })]))).toContain('Passed · stale')
    expect(doctorAge(AT - 25 * 3600000, AT)).toBe('1 d ago')
  })

  it('shows each leftover and its reason without a Needs-you dot, count or action', () => {
    const value = view([row('leftovers', { leftovers: [{ kind: 'plugins', app: 'claude', item: 1, reason: 'disabled',
      reasonText: 'The plugin is disabled; it may be deliberately retained.', location: '~/.claude/plugins/' }] })])
    const html = markup(value)
    expect(html).toContain('Leftovers · 1 in 1 group · show-only')
    expect(html).toContain('<span>Claude Code · Plugins · disabled</span><span class="count">1</span>')
    expect(html).toContain('The plugin is disabled; it may be deliberately retained. Review it yourself; BMN leaves it.')
    expect(html).toContain('~/.claude/plugins/')
    expect(html).not.toContain('needs-dot')
    expect(doctorNeedsCount(value)).toBe(0)
    expect(html).not.toMatch(/<(?:button|input|select|a)\b/)
  })

  it('counts only individual problems and whole-run errors as Needs-you', () => {
    const value = view([row('codex', { state: 'problems', problems: [
      { code: 'missing-program', item: 1, reason: 'Missing', fix: 'Fix it' },
      { code: 'endpoint-unreachable', item: 2, reason: 'Unreachable', fix: 'Fix it' }
    ] }), row('claude', { state: 'unsupported' }), row('leftovers')])
    expect(doctorNeedsCount(value)).toBe(2)
    expect(doctorNeedsCount({ ...value, error: 'run-unavailable' })).toBe(3)
  })

  it('keeps stale and unavailable rows visible without dots, counts or a false All well', () => {
    for (const state of ['failed', 'timeout', 'partial', 'interrupted', 'unsupported', 'unqualified'] as const) {
      const value = view([row('codex', { state })])
      expect(doctorNeedsCount(value)).toBe(0)
      expect(markup(value)).toContain(doctorStateWords(value.rows[0]!))
      expect(markup(value)).not.toContain('needs-dot')
      expect(markup(value)).not.toContain('All well')
    }
    const value = view()
    const now = AT + 24 * 3600000 + 1
    const html = renderToStaticMarkup(createElement(DoctorHealth, { view: value, now }))
    expect(doctorNeedsCount(value)).toBe(0)
    expect(html).toContain('Passed · stale')
    expect(html).not.toContain('All well')
    expect(html).not.toContain('needs-dot')
  })

  it('keeps how fully the leftovers were read out of the count, on the Leftovers line, and never All well (Story 96.6)', () => {
    const coverage = { code: 'leftover-source-changed', item: 1, count: 3, reason: '3 sources changed during the check', fix: 'Checked again at the next run.' }
    const unreadable = { code: 'leftover-unreadable', item: 2, count: 1, reason: '1 file could not be read', fix: 'Check read permission. BMN leaves it.' }
    const partial = view([...CHECKS.filter((check) => check !== 'leftovers').map((check) => row(check)), row('leftovers', { state: 'partial', problems: [coverage] })])
    expect(doctorPlace(partial.rows.at(-1)!, coverage, new Set())).toBe('coverage')
    expect(doctorNeedsCount(partial)).toBe(0)
    const html = markup({ ...partial, allWell: true })
    expect(html).toContain('Leftovers · 0 in 0 groups · show-only')
    expect(html).toContain('Partly checked · 3 sources changed during the check')
    expect(html).not.toContain('All well')
    expect(html).not.toContain('needs-dot')
    // An item BMN could not read is the owner's to look at, so it counts.
    expect(doctorNeedsCount(view([row('leftovers', { state: 'partial', problems: [coverage, unreadable] })]))).toBe(1)
  })

  it('counts a finding of the same app and area as a Health row there, and one of another app here (Story 96.6)', () => {
    const hooks = row('hooks', { state: 'problems', problems: [{ code: 'hook-check', item: 1, app: 'opencode', reason: 'Hook is not wired', fix: 'Review Hooks in Health.' },
      { code: 'hook-check', item: 2, app: 'codex', reason: 'Hook is not wired', fix: 'Review Hooks in Health.' }] })
    const sections = new Set(['hooks:opencode'])
    expect(doctorNeedsCount(view([hooks]), sections)).toBe(1)
    const html = renderToStaticMarkup(createElement(DoctorHealth, { view: view([hooks]), now: AT + 60000, sections }))
    expect(html).toContain('data-doctor-counted="hooks"')
    expect(html).toContain('data-doctor-counted="doctor"')
    expect(html.match(/needs-dot/g)).toHaveLength(1)
    // All well only once no Health section needs the owner either.
    expect(renderToStaticMarkup(createElement(DoctorHealth, { view: view(), now: AT + 60000, sections }))).not.toContain('All well')
  })

  it('groups leftovers by app, kind and reason, largest first, each with its own count', () => {
    const item = (app: 'claude' | 'codex', reason: string, index: number) => ({ kind: 'plugins' as const, app, reason, item: index, reasonText: 'r', location: `entry ${index}`, checkedAt: AT })
    const groups = leftoverGroups([item('codex', 'disabled', 1), item('claude', 'disabled', 2), item('claude', 'disabled', 3), item('claude', 'app-managed', 4)])
    expect(groups.map((group) => [group.label, group.items.length])).toEqual([['Claude Code · Plugins · disabled', 2], ['Claude Code · Plugins · app managed', 1], ['Codex · Plugins · disabled', 1]])
  })

  it('adds only one keyboard disclosure and no check switch, cleanup or undo control', () => {
    const html = markup(undefined)
    expect(html.match(/<summary>/g)).toHaveLength(1)
    expect(html).toContain('<summary>What is checked</summary>')
    expect(html).not.toMatch(/<(?:button|input|select)\b/)
    expect(html).toContain('Not checked yet')
  })
})
