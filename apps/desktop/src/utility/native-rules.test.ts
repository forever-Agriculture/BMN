// MODULE: native-rules.test.ts - Story 102.3: BMN's rows in the apps' own rules: beside his, idempotent, removed exactly, keys listed at each install
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_RULES, NEVER_COMMANDS, claudeDenyRows, missingClaudeRows, privateKeyNames, secretPaths, withClaudeRows, withoutClaudeRows } from '../../bin/native-rules.mjs'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function homeWith(...files: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'bmn-native-rules-'))
  homes.push(home)
  mkdirSync(join(home, '.ssh'))
  for (const file of files) writeFileSync(join(home, '.ssh', file), 'synthetic\n')
  return home
}

describe('Claude\'s deny rows (Story 102.3)', () => {
  it('holds each D5 command, also after sudo, and only them', () => {
    expect(NEVER_COMMANDS).toContain('docker system prune')
    expect(NEVER_COMMANDS).toContain('sudo podman buildx prune')
    expect(NEVER_COMMANDS).toContain('prime-select nvidia')
    expect(NEVER_COMMANDS).toContain('sudo prime-select nvidia')
    expect(NEVER_COMMANDS.filter((command: string) => !/ prune$|prime-select nvidia$/.test(command))).toEqual([])
    expect(NEVER_COMMANDS).toHaveLength(30)
  })

  it('names private keys from the folder at each install, and leaves public keys, config and known_hosts readable', () => {
    const home = homeWith('id_ed25519', 'id_ed25519.pub', 'work_key', 'work_key.pub', 'config', 'known_hosts')
    expect(privateKeyNames(home)).toEqual(['id_ed25519', 'work_key'])
    const rows = claudeDenyRows(home)
    expect(rows).toContain('Read(~/.ssh/id_ed25519)')
    expect(rows).toContain('Read(~/.ssh/work_key)')
    expect(rows.filter((row: string) => /\.pub|config\)|known_hosts/.test(row))).toEqual([])
    writeFileSync(join(home, '.ssh/id_new'), 'synthetic\n')
    expect(claudeDenyRows(home)).toContain('Read(~/.ssh/id_new)')
  })

  it('reads the rest of the secret list, a folder of the list as all it holds', () => {
    const rows = claudeDenyRows(homeWith())
    for (const row of ['Read(~/.codex/auth.json)', 'Read(~/.claude/.credentials.json)', 'Read(~/.config/keepassxc/master.keyx)', 'Read(~/Documents/KeePass/**)',
      'Read(~/.config/gh/hosts.yml)', 'Read(~/.aws/credentials)', 'Read(~/.netrc)', 'Read(~/.git-credentials)', 'Read(~/.claude-glm/secret.env)']) expect(rows).toContain(row)
    expect(secretPaths(homeWith())).not.toContain('.ssh/id_*')
  })

  it('adds beside his rows, leaves his order and keys, is idempotent and removes exactly its own', () => {
    const home = homeWith('id_rsa', 'id_rsa.pub')
    const his = { model: 'x', permissions: { allow: ['Bash(git status:*)'], deny: ['Read(./secrets/**)'], defaultMode: 'auto' }, hooks: {} }
    const missing = missingClaudeRows(his, home)!
    const next = withClaudeRows(his, missing)
    expect(next.permissions.deny.slice(0, 1)).toEqual(['Read(./secrets/**)'])
    expect(Object.keys(next)).toEqual(Object.keys(his))
    expect(Object.keys(next.permissions)).toEqual(Object.keys(his.permissions))
    expect(next.permissions.allow).toEqual(his.permissions.allow)
    expect(missingClaudeRows(next, home)).toEqual([])
    expect(withClaudeRows(next, [])).toBe(next)
    expect(JSON.stringify(withoutClaudeRows(next, home))).toBe(JSON.stringify(his))
  })

  it('gives back a file that had no permissions at all', () => {
    const home = homeWith()
    const his = { model: 'x' }
    expect(withoutClaudeRows(withClaudeRows(his, missingClaudeRows(his, home)!), home)).toEqual(his)
  })

  it.each([[{ permissions: [] }], [{ permissions: 'x' }], [{ permissions: { deny: 'x' } }], [{ permissions: null }]])('leaves %j alone: BMN cannot add to it', (data) => {
    expect(missingClaudeRows(data, homeWith())).toBeNull()
  })
})

describe('Codex\'s rules (Story 102.3)', () => {
  const check = (rules: string, ...command: string[]): string => {
    const run = spawnSync('codex', ['execpolicy', 'check', '--rules', rules, '--', ...command], { encoding: 'utf8' })
    return run.error ? 'no codex' : (JSON.parse(run.stdout) as { decision?: string }).decision ?? 'nothing'
  }

  it('reads forbidden for each command and matches nothing on its neighbours, where Codex is installed', () => {
    const home = homeWith()
    const rules = join(home, 'bmn-guard.rules')
    writeFileSync(rules, CODEX_RULES)
    if (check(rules, 'true') === 'no codex') return
    for (const command of NEVER_COMMANDS) expect(check(rules, ...command.split(' '), '-af'), command).toBe('forbidden')
    for (const command of ['docker ps', 'docker volume ls', 'prime-select query', 'sudo prime-select on-demand']) expect(check(rules, ...command.split(' ')), command).toBe('nothing')
  }, 60_000)
})
