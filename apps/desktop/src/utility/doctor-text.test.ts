// MODULE: doctor-text.test.ts - Stories 102.12 and 102.14: the doctor's default text from fixed reports, and the allow rows it names
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { doctorText } from '../../bin/doctor-text.mjs'
import { claudeAllowRows, codexAllowRows, riskyAllowLines, riskyRowName } from '../../bin/risky-allow.mjs'

const leftover = (kind: string, reasonText: string, n: number) => ({ kind, reasonText, item: n, identity: 'withheld', location: `Identity withheld · claude-profile · device 1, inode ${n} · route [{"device":"1","inode":"${n}"}]` })
const VIEW = {
  running: false, allWell: false, error: null, locationHelp: 'Names are withheld, even ordinary names.',
  rows: [
    { check: 'hooks', state: 'passed', stale: false, problems: [], leftovers: [] },
    { check: 'tools', state: 'problems', stale: false, leftovers: [], problems: [1, 2].map((item) => ({ code: 'tool-check', item, app: 'opencode', cause: 'unlisted-exposed', reason: 'Tool needs attention', fix: 'Review Tools in Health.' })) },
    { check: 'claude', state: 'partial', stale: false, leftovers: [], problems: [{ code: 'additional-details', item: 1, reason: 'Additional details could not be safely interpreted', fix: 'Inspect the app doctor yourself.' }] },
    { check: 'codex', state: 'timeout', stale: false, leftovers: [], problems: [] },
    { check: 'leftovers', state: 'passed', stale: false, problems: [], leftovers: [...Array.from({ length: 300 }, (_, n) => leftover('plugins', 'The plugin is listed but its installation could not be found.', n)), ...Array.from({ length: 30 }, (_, n) => leftover('memory', 'The memory project could not be resolved safely.', n))] }
  ]
}

describe('bmn doctor by default (102.12)', () => {
  const text = doctorText(VIEW, { load: 30, cores: 12 })

  it('shows a count per kind and what to do, with no identity or route', () => {
    expect(text).toContain('leftovers: 330 shown only; BMN leaves them, and nothing here needs you. `bmn doctor --details` lists each.')
    expect(text).toContain('  300 plugin: The plugin is listed but its installation could not be found.')
    expect(text).toContain('  30 memory: The memory project could not be resolved safely.')
    expect(text).not.toMatch(/inode|route|device|Names are withheld/u)
  })

  it('names the app and the cause in plain words, counted once', () => {
    expect(text).toContain('2 x OpenCode offers a tool BMN does not list. Review Tools in Health.')
    expect(text).not.toContain('Tool needs attention')
  })

  it('says what an app doctor checked, what it could not and whether it needs him; out of time on a busy machine is not judged', () => {
    expect(text).toContain('Claude Code: checked what its doctor reported in terms BMN knows. A part could not be read')
    expect(text).toContain('It needs you only if the app misbehaves; `claude doctor` shows it all.')
    expect(text).not.toContain('Additional details could not be safely interpreted')
    expect(text).toContain('Codex: not judged. Its doctor did not finish within BMN\'s limit, with the machine at load 30; that says nothing about the app. It needs you only if this repeats on a quiet machine.')
    expect(doctorText(VIEW, { load: 1, cores: 12 })).toContain('within BMN\'s limit; that says nothing')
  })

  it('fits one screen', () => {
    expect(text.split('\n').length).toBeLessThanOrEqual(40)
  })

  it('gives the identities and routes only with --details', () => {
    const details = doctorText(VIEW, { details: true })
    expect(details).toContain('Show-only: Identity withheld · claude-profile · device 1, inode 0')
    expect(details).toContain('Names are withheld, even ordinary names.')
    expect(details.split('\n').length).toBeGreaterThan(330)
  })

  it('says a broken guard and missing rules with what to do', () => {
    const view = { ...VIEW, rows: [{ check: 'hooks', state: 'problems', stale: false, leftovers: [], problems: [
      { code: 'hook-check', item: 1, app: 'codex', cause: 'guard:does-not-answer', reason: 'Hook is not wired', fix: 'Review Hooks in Health.' },
      { code: 'hook-check', item: 2, app: 'claude', cause: 'rules:missing', reason: 'Hook is not wired', fix: 'Review Hooks in Health.' }] }] }
    const words = doctorText(view)
    expect(words).toContain('Codex\'s command guard does not answer. Its holds are missed')
    expect(words).toContain('Claude Code\'s own refusal rules are missing. Run `bmn hooks install`.')
  })

  it('says the wider line for a clean run', () => {
    expect(doctorText({ ...VIEW, allWell: true, rows: VIEW.rows.slice(0, 1) })).toBe('All well · 1 checks passed')
  })
})

describe('an allow row that can run any program (102.14 AC4)', () => {
  it.each([
    [['sed', '-n'], 'sed -n'], [['bash'], 'bash'], [['python3', '/tmp/one-off.py'], 'python3 <a script>'], [['node', 'x.js'], 'node <a script>'],
    [['pnpm', 'run'], 'pnpm run'], [['env'], 'env'], [['find'], 'find'], [['perl', '-e'], 'perl -e'], [['xargs'], 'xargs'], [['awk'], 'awk'], [['sh'], 'sh']
  ])('names %j', (words, name) => {
    expect(riskyRowName(words)).toBe(name)
  })

  it.each([
    [['ls', '-l']], [['gh', 'pr', 'view']], [['codex', '--version']], [['python3', '/usr/lib/tool.py']], [['sed', '-n', '1,3p', 'FILE']], [['python3', '-m', 'pytest']], [['pnpm', 'test']]
  ])('passes literal words %j', (words) => {
    expect(riskyRowName(words)).toBeNull()
  })

  it('reads both apps\' rows, today\'s rows included, and says no text of the file beyond the program and its flags', () => {
    expect(codexAllowRows('prefix_rule(pattern=["sed", "-n"], decision="allow")\nprefix_rule(pattern=["gh", "pr", "merge"], decision="prompt")\nprefix_rule(pattern=["ls"], decision="allow")\n')).toEqual([['sed', '-n'], ['ls']])
    expect(claudeAllowRows(['Bash(bash:*)', 'Bash(pnpm run:*)', 'Bash(sed *)', 'Read(~/x)', 7])).toEqual([['bash'], ['pnpm', 'run'], ['sed']])
    const home = mkdtempSync(join(tmpdir(), 'bmn-allow-'))
    try {
      mkdirSync(join(home, '.codex/rules'), { recursive: true })
      mkdirSync(join(home, '.claude'))
      writeFileSync(join(home, '.codex/rules/default.rules'), 'prefix_rule(pattern=["sed", "-n"], decision="allow")\nprefix_rule(pattern=["python3", "/tmp/secret-name.py"], decision="allow")\nprefix_rule(pattern=["codex", "--version"], decision="allow")\n')
      writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(pnpm run:*)', 'Bash(git status:*)'] } }))
      const lines = riskyAllowLines({ home })
      expect(lines).toEqual([
        'Codex allows `sed -n` with no prompt: it can run any program. Remove the row if you did not mean it.',
        'Codex allows `python3 <a script>` with no prompt: it can run any program. Remove the row if you did not mean it.',
        'Claude Code allows `pnpm run` with no prompt: it can run any program. Remove the row if you did not mean it.'
      ])
      expect(lines.join()).not.toContain('secret-name')
      expect(doctorText({ ...VIEW, rows: [] }, { allowLines: lines })).toContain('Codex allows `sed -n`')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
    expect(riskyAllowLines({ home: join(tmpdir(), 'bmn-no-such-home') })).toEqual([])
  })
})
