// MODULE: doctor-results.test.ts - Synthetic credential and incomplete-report tests for the doctor publication boundary
import { describe, expect, it } from 'vitest'
import { parseBmnDoctor, parseClaudeDoctor, parseCodexDoctor, projectedResult } from '../../bin/doctor-results.mjs'

const SECRET = 'sk-SYNTHETIC-SECRET-abcdef123456'
const codex = (checks: Record<string, unknown>, overallStatus = 'warning'): string => JSON.stringify({ schemaVersion: 1, overallStatus, checks })
const row = (id: string, status: string, details = {}): object => ({ id, status, details, summary: SECRET, remediation: SECRET })

describe('doctor result projection', () => {
  it('keeps SQLite access failures inconclusive in the read-only sandbox while preserving real corruption and terminal warnings', () => {
    const access = 'error returned from database: (code: 14) unable to open database file'
    const text = codex({
      'state.paths': row('state.paths', 'fail', { 'state DB integrity': access, 'thread history DB integrity': 'ok' }),
      'state.rollout_db_parity': row('state.rollout_db_parity', 'warning', { 'rollout DB read error': access })
    }, 'fail')
    expect(parseCodexDoctor(text, 1, { readOnlySandbox: true }).problems.some(p => p.code === 'state-check')).toBe(false)
    expect(parseCodexDoctor(text, 1).problems.some(p => p.code === 'state-check')).toBe(true)
    const corrupt = codex({ 'state.paths': row('state.paths', 'fail', { 'state DB integrity': 'database disk image is malformed (code: 11)' }),
      'terminal.env': row('terminal.env', 'warning') }, 'fail')
    const projected = parseCodexDoctor(corrupt, 1, { readOnlySandbox: true })
    expect(projected.problems.map(p => p.code)).toEqual(expect.arrayContaining(['state-check', 'terminal-check']))
    expect(JSON.stringify(projected)).not.toContain('database disk image')
  })

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
    expect(parseBmnDoctor('rules', JSON.stringify({ ok: false, targets: [{ harness: 'claude', state: 'missing', path: SECRET, detail: SECRET }, { harness: 'codex', state: 'current' }, { harness: 'opencode', state: 'current' }] }), 1)).toEqual({ state: 'problems', problems: [{ code: 'rules-check', item: 1, app: 'claude', cause: 'missing' }] })
    const hooks = parseBmnDoctor('hooks', JSON.stringify({ agents: [{ events: [{ state: SECRET, name: SECRET }] }] }), 1)
    expect(hooks.state).toBe('partial')
    expect(hooks.problems.some((row) => row.code === 'hook-check')).toBe(false)
    expect(JSON.stringify(hooks)).not.toContain(SECRET)
    expect(parseBmnDoctor('tools', JSON.stringify({ apps: [] }), 0).state).toBe('partial')
    expect(parseBmnDoctor('skills', SECRET, 1).state).toBe('partial')
  })

  it('names the cause of each area finding as its state word only, and the trust boundary keeps nothing else (96 Astra review)', () => {
    const tools = parseBmnDoctor('tools', JSON.stringify({ apps: ['claude', 'codex', 'opencode'].map((harness) => ({ harness, supported: true, readable: true,
      tools: harness === 'opencode' ? [{ id: SECRET, state: 'missing' }, { id: SECRET, state: 'current' }] : [],
      unlisted: harness === 'opencode' ? [{ id: SECRET, state: 'exposed', managed: false }, { id: SECRET, state: 'unmanaged', managed: true }] : [] })) }), 1)
    expect(tools).toEqual({ state: 'problems', problems: [{ code: 'tool-check', item: 1, app: 'opencode', cause: 'missing' },
      { code: 'tool-check', item: 2, app: 'opencode', cause: 'unlisted-exposed' }, { code: 'tool-check', item: 3, app: 'opencode', cause: 'unlisted-managed' }] })
    expect(projectedResult(tools)).toEqual(tools)
    for (const cause of [SECRET, '/home/owner/x', 'Missing tool', 'a'.repeat(40), 7]) {
      expect(projectedResult({ state: 'problems', problems: [{ code: 'tool-check', item: 1, app: 'codex', cause }] }), String(cause)).toBeNull()
    }
    expect(projectedResult({ state: 'problems', problems: [{ code: 'auth-check', item: 1, app: 'codex', cause: 'missing' }] })).toBeNull()
    // An older stored result without a cause stays valid; Health counts it by itself.
    expect(projectedResult({ state: 'problems', problems: [{ code: 'tool-check', item: 1, app: 'codex' }] })).toEqual({ state: 'problems', problems: [{ code: 'tool-check', item: 1, app: 'codex' }] })
  })

  it('recognizes the current Claude signed-out diagnostic without forwarding its prose', () => {
    const parsed = parseClaudeDoctor('Claude Code doctor\nRunning: native (2.1.304)\nRemote Control\n- Not signed in to claude.ai\nNo issues found', 0)
    expect(parsed).toEqual({ state: 'problems', problems: [{ code: 'auth-check', item: 1 }] })
  })

  it('reads Claude 2.1.308 reporting no installation issues as passed', () => {
    const text = ['Claude Code doctor', 'Running: native (2.1.308)', 'Commit: 320f66eb8f83', 'Platform: linux-x64', `Path: ${SECRET}`,
      'Config install method: native', 'Search: OK (bundled)', 'Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)', 'Remote Control',
      'Remote Control requires feature-flag evaluation, which is disabled because CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set. Unset it (or run in a shell without it) to use Remote Control.',
      '- Feature-flag evaluation disabled (disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)',
      '- Remote Control availability could not be verified (no server response this session)', '', 'No installation issues found.', '',
      'For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.'].join('\n')
    expect(parseClaudeDoctor(text, 0)).toEqual({ state: 'passed', problems: [] })
    expect(parseClaudeDoctor(text.replace('No installation issues found.', 'No installation issues found'), 0).state).toBe('partial')
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
