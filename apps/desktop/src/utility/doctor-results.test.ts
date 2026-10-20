// MODULE: doctor-results.test.ts - Synthetic credential and incomplete-report tests for the doctor publication boundary
import { describe, expect, it } from 'vitest'
import { parseBmnDoctor, parseClaudeDoctor, parseCodexDoctor, projectedResult } from '../../bin/doctor-results.mjs'

const SECRET = 'sk-SYNTHETIC-SECRET-abcdef123456'
const codex = (checks: Record<string, unknown>, overallStatus = 'warning'): string => JSON.stringify({ schemaVersion: 1, overallStatus, checks })
const row = (id: string, status: string, details = {}): object => ({ id, status, details, summary: SECRET, remediation: SECRET })

describe('doctor result projection', () => {
  it('keeps separate missing-program and endpoint findings without forwarding any child text', () => {
    const parsed = parseCodexDoctor(codex({ 'mcp.config': row('mcp.config', 'warning', {
      [SECRET]: `stdio command "${SECRET}" is not resolvable (not found on PATH)`,
      'optional reachability failed': `${SECRET}: https://${SECRET} (HEAD connect failed; GET connect failed)`
    }) }), 0)
    expect(parsed.problems.slice(0, 2)).toEqual([{ code: 'missing-program', item: 1 }, { code: 'endpoint-unreachable', item: 2 }])
    expect(JSON.stringify(parsed)).not.toMatch(/SYNTHETIC|abcdef|https|stdio/)
    expect(parsed.state).toBe('partial') // the remainder of the schema is absent
  })

  it.each([SECRET, 'sk-SYN', '***123456', 'SECRET-abcd', `error: ${SECRET}`])('withholds arbitrary fragments in unknown diagnostics: %s', (secret) => {
    for (const text of [codex({ [secret]: row(secret, 'warning') }), codex({ 'mcp.config': row('mcp.config', 'warning', { [secret]: secret }) })]) {
      const parsed = parseCodexDoctor(text, 0)
      expect(parsed.state).toBe('partial')
      expect(JSON.stringify(parsed)).not.toContain(secret)
    }
    expect(JSON.stringify(parseClaudeDoctor(`Claude Code doctor\nRunning: native (2.1.303)\n1 warning found\n- ${secret}`, 0))).not.toContain(secret)
  })

  it('recognizes a failed configuration and never treats malformed or unexplained output as success', () => {
    const parsed = parseCodexDoctor(codex({ 'config.load': row('config.load', 'fail') }, 'fail'), 1)
    expect(parsed).toEqual({ state: 'problems', problems: [{ code: 'config-invalid', item: 1 }] })
    for (const input of ['', '{}', '{', codex({}, 'ok')]) expect(parseCodexDoctor(input, 0).state).toBe('partial')
    expect(parseCodexDoctor(codex({ 'config.load': row('config.load', 'ok') }, 'ok'), 7).state).toBe('partial')
  })

  it('projects Claude installation and auth warnings, checks the declared count and withholds paths and fixes', () => {
    const text = `Claude Code doctor\nRunning: native (2.1.303)\nPath: ${SECRET}\nOrganization policy: Couldn't load · ${SECRET}\n2 warnings found\n- Native installation exists but ~/.local/bin is not in your PATH\n  Fix: ${SECRET}\n- claude command at ${SECRET} missing or broken\n`
    const parsed = parseClaudeDoctor(text, 0)
    expect(parsed.state).toBe('problems')
    expect(parsed.problems.map((entry) => entry.code)).toEqual(['auth-check', 'installation-check', 'installation-check'])
    expect(JSON.stringify(parsed)).not.toContain(SECRET)
    expect(parseClaudeDoctor(text.replace('2 warnings', '3 warnings'), 0).state).toBe('partial')
    expect(parseClaudeDoctor('Claude Code doctor\nRunning: native (2.1.303)\nNo issues found', 0)).toEqual({ state: 'passed', problems: [] })
  })

  it('projects BMN checks, including names and failures, before the same sinks', () => {
    expect(parseBmnDoctor('rules', JSON.stringify({ ok: false, targets: [{ harness: 'claude', state: 'missing', path: SECRET, detail: SECRET }, { harness: 'codex', state: 'current' }, { harness: 'opencode', state: 'current' }] }), 1)).toEqual({ state: 'problems', problems: [{ code: 'rules-check', item: 1, app: 'claude' }] })
    const hooks = parseBmnDoctor('hooks', JSON.stringify({ agents: [{ events: [{ state: SECRET, name: SECRET }] }] }), 1)
    expect(hooks.problems.some((row) => row.code === 'hook-check')).toBe(true)
    expect(JSON.stringify(hooks)).not.toContain(SECRET)
    expect(parseBmnDoctor('tools', JSON.stringify({ apps: [] }), 0).state).toBe('partial')
    expect(parseBmnDoctor('skills', SECRET, 1).state).toBe('partial')
  })

  it('recognizes the current Claude signed-out diagnostic without forwarding its prose', () => {
    const parsed = parseClaudeDoctor('Claude Code doctor\nRunning: native (2.1.304)\nRemote Control\n- Not signed in to claude.ai\nNo issues found', 0)
    expect(parsed).toEqual({ state: 'problems', problems: [{ code: 'auth-check', item: 1 }] })
  })

  it('validates saved facts and drops unknown state fields before display', () => {
    expect(projectedResult({ state: 'passed', problems: [], secret: SECRET })).toEqual({ state: 'passed', problems: [] })
    expect(projectedResult({ state: 'problems', problems: [{ code: SECRET, item: 1 }] })).toBeNull()
    expect(projectedResult({ state: 'passed', problems: [{ code: 'missing-program', item: 1 }] })).toBeNull()
  })

  it('does not report All well from a truncated BMN app list', () => {
    expect(parseBmnDoctor('rules', JSON.stringify({ ok: true, targets: [{ harness: 'claude', state: 'current' }] }), 0).state).toBe('partial')
    expect(parseBmnDoctor('hooks', JSON.stringify({ ok: true, agents: [{ agent: 'claude', events: [{ state: 'wired' }] }] }), 0).state).toBe('partial')
  })
})
