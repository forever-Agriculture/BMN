// MODULE: agent-history-claude.test.ts - cleanupPeriodDays writes: keys kept, 0 impossible, unparsable skipped, revision conflict, backups
import { lstatSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_KEEP_FOREVER_DAYS } from '@bmn/protocol'
import { claudeTargetDays, readClaudeFolder, writeClaudeFolder } from './agent-history-claude'

import { ownWindowsFixtureFile } from './windows-fixture-owner.test-support'

const roots: string[] = []

async function folder(settings?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-claude-folder-'))
  roots.push(root)
  if (settings !== undefined) {
    await writeFile(join(root, 'settings.json'), settings)
    ownWindowsFixtureFile(root, join(root, 'settings.json'))
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Claude history folders', () => {
  it('writes cleanupPeriodDays and keeps every other key, its order and the indent, with a backup', async () => {
    const original = '{\n    "model": "opus",\n    "hooks": { "Stop": [] },\n    "cleanupPeriodDays": 90,\n    "env": { "A": "1" }\n}\n'
    const root = await folder(original)

    const result = writeClaudeFolder(root, 30)

    expect(result).toMatchObject({ ok: true })
    const written = await readFile(join(root, 'settings.json'), 'utf8')
    expect(JSON.parse(written)).toEqual({ model: 'opus', hooks: { Stop: [] }, cleanupPeriodDays: 30, env: { A: '1' } })
    expect(Object.keys(JSON.parse(written) as object)).toEqual(['model', 'hooks', 'cleanupPeriodDays', 'env'])
    expect(written).toContain('\n    "model"')
    const backups = (await readdir(root)).filter((name) => name.startsWith('settings.json.bmn-backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, backups[0]!), 'utf8')).toBe(original)
    expect(readClaudeFolder(root)).toMatchObject({ ok: true, currentDays: 30 })
  })

  it('creates a missing settings.json with only the limit and no backup', async () => {
    const root = await folder()

    expect(readClaudeFolder(root)).toMatchObject({ ok: true, currentDays: null })
    expect(writeClaudeFolder(root, 7)).toEqual({ ok: true, backup: null })
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 7 })
  })

  it('writes Never as a century and can never write 0', async () => {
    expect(claudeTargetDays(null)).toBe(CLAUDE_KEEP_FOREVER_DAYS)
    expect(CLAUDE_KEEP_FOREVER_DAYS).toBe(36_500)
    for (const days of [10, 30, 90] as const) expect(claudeTargetDays(days)).toBe(days)
    const root = await folder('{"cleanupPeriodDays": 30}')

    expect(() => writeClaudeFolder(root, 0)).toThrow(RangeError)
    expect(() => writeClaudeFolder(root, -1)).toThrow(RangeError)
    expect(() => writeClaudeFolder(root, 1.5)).toThrow(RangeError)
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 30 })
  })

  it.each([
    ['not JSON', '{ "model": ', 'settings.json is not valid JSON'],
    ['an array', '[1, 2]', 'settings.json is not a JSON object'],
    ['a non-number limit', '{ "cleanupPeriodDays": "30" }', 'cleanupPeriodDays is not a number']
  ])('skips a file that is %s and names why, leaving it untouched', async (_label, text, failure) => {
    const root = await folder(text)

    expect(writeClaudeFolder(root, 30)).toEqual({ ok: false, failure })
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe(text)
    expect((await readdir(root)).filter((name) => name.includes('bmn-backup'))).toEqual([])
  })

  it('leaves a file that holds a number JSON cannot write back unchanged', async () => {
    const text = '{ "big": 18446744073709551615, "cleanupPeriodDays": 30 }'
    const root = await folder(text)

    expect(writeClaudeFolder(root, 7)).toMatchObject({ ok: false })
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe(text)
  })

  it('refuses with a revision conflict when the file changes during the write', async () => {
    const root = await folder('{ "cleanupPeriodDays": 90 }')
    const path = join(root, 'settings.json')

    const result = writeClaudeFolder(root, 30, () => {
      // Another writer, between BMN's read and its rename.
      writeFileSync(path, '{ "cleanupPeriodDays": 14 }')
    })

    expect(result).toEqual({ ok: false, failure: 'settings.json changed while BMN was writing; left untouched' })
    expect(await readFile(path, 'utf8')).toBe('{ "cleanupPeriodDays": 14 }')
    expect((await readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('writes through a symlinked settings file and keeps the link', async () => {
    const root = await folder()
    const dotfiles = join(root, 'dotfiles')
    await mkdir(dotfiles)
    await writeFile(join(dotfiles, 'claude-settings.json'), '{ "model": "opus" }')
    ownWindowsFixtureFile(root, join(dotfiles, 'claude-settings.json'))
    await symlink(join(dotfiles, 'claude-settings.json'), join(root, 'settings.json'))

    expect(writeClaudeFolder(root, 30)).toMatchObject({ ok: true })
    expect(JSON.parse(await readFile(join(dotfiles, 'claude-settings.json'), 'utf8'))).toEqual({ model: 'opus', cleanupPeriodDays: 30 })
    expect(lstatSync(join(root, 'settings.json')).isSymbolicLink()).toBe(true)
  })
})
