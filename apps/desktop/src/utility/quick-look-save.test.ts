// MODULE: quick-look-save.test.ts - Quick look's one writer on made-up files: each condition of R68-NFR1 failing alone, bytes changed or the file replaced between read and Save, the mode kept, no file left beside it, the read back, and no value in any answer (Story 68.1)
import { execFileSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { quickLookDigest, quickLookEditState, saveQuickLookFile } from './quick-look-save'

const CANARY = 'madeupCANARYvalue0123456789'
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    chmodSync(folder, 0o700)
    rmSync(folder, { recursive: true, force: true })
  }
})

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bmn-quick-look-save-'))
  folders.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text, { mode: 0o600 })
  }
  return root
}

const digestOf = (path: string): string => quickLookDigest(readFileSync(path))
const save = (root: string, path: string, text: string, seams: Parameters<typeof saveQuickLookFile>[1] = {}, digest = digestOf(path)) =>
  saveQuickLookFile({ root, path, digest, text }, seams)
/** What stands in a folder besides the given names: a staged file left behind would show here. */
const extra = (folder: string, ...names: string[]): string[] => readdirSync(folder).filter((name) => !names.includes(name))

describe('may a file be edited', () => {
  it('names each reason a listed file is read-only, and nothing for a name never edited', async () => {
    const root = project({ '.env': 'A=1\n', 'notes.md': 'x\n', 'big.json': `"${'a'.repeat(256 * 1024)}"`, 'ro.yaml': 'a: 1\n' })
    const outside = project({ 'c.toml': 'a = 1\n' })
    chmodSync(join(root, 'ro.yaml'), 0o400)
    symlinkSync(join(root, '.env'), join(root, 'link.env'))
    writeFileSync(join(root, 'two.json'), '{}')
    linkSync(join(root, 'two.json'), join(root, 'second.json'))
    mkdirSync(join(root, 'folder.json'))
    const state = (path: string, uid?: number) => quickLookEditState(path, root, uid === undefined ? {} : { uid })
    expect(await state(join(root, '.env'))).toEqual({ status: 'editable', mode: 0o600 })
    expect(await state(join(root, 'notes.md'))).toBeNull()
    expect(await state(join(outside, 'c.toml'))).toEqual({ status: 'read-only', message: 'Read-only · outside the root' })
    expect(await state(join(root, 'big.json'))).toEqual({ status: 'read-only', message: 'Read-only · over 256 KB' })
    expect(await state(join(root, 'link.env'))).toEqual({ status: 'read-only', message: 'Read-only · a link' })
    expect(await state(join(root, 'two.json'))).toEqual({ status: 'read-only', message: 'Read-only · a second hard link' })
    expect(await state(join(root, 'folder.json'))).toEqual({ status: 'read-only', message: 'Read-only · not a regular file' })
    expect(await state(join(root, '.env'), (process.getuid?.() ?? 0) + 1)).toEqual({ status: 'read-only', message: "Read-only · another user's file" })
    expect(await state(join(root, 'ro.yaml'))).toEqual({ status: 'read-only', message: 'Read-only · not writable' })
    expect(await quickLookEditState(join(root, '.env'), null)).toBeNull()
  })

  it('takes a file inside the root when a folder on its way is a link into the root, and not one leading out', async () => {
    const root = project({ 'real/config.json': '{}' })
    const outside = project({ 'config.json': '{}' })
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    symlinkSync(outside, join(root, 'away'))
    expect(await quickLookEditState(join(root, 'alias', 'config.json'), root)).toMatchObject({ status: 'editable' })
    expect(await quickLookEditState(join(root, 'away', 'config.json'), root)).toEqual({ status: 'read-only', message: 'Read-only · outside the root' })
  })
})

describe('Save', () => {
  it('writes the new text, keeps the mode, leaves no file beside it and reads it back', async () => {
    const root = project({ '.env': `# made-up\nA=old\n` })
    const path = join(root, '.env')
    chmodSync(path, 0o640)
    const result = await save(root, path, `# made-up\nA=${CANARY}\n`)
    expect(result).toMatchObject({ status: 'saved', digest: quickLookDigest(Buffer.from(`# made-up\nA=${CANARY}\n`)) })
    expect(readFileSync(path, 'utf8')).toBe(`# made-up\nA=${CANARY}\n`)
    expect(statSync(path).mode & 0o7777).toBe(0o640)
    expect(extra(root, '.env')).toEqual([])
  })

  it('keeps a byte order mark the file began with', async () => {
    const root = project()
    const path = join(root, 'a.json')
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a": 1}\n')]))
    expect(await save(root, path, '{"a": 2}\n')).toMatchObject({ status: 'saved' })
    expect(readFileSync(path).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(readFileSync(path).subarray(3).toString()).toBe('{"a": 2}\n')
  })

  it('refuses, writing nothing, when the bytes are no longer the ones read', async () => {
    const root = project({ '.env': 'A=1\n' })
    const path = join(root, '.env')
    const read = digestOf(path)
    writeFileSync(path, 'A=2\n')
    expect(await save(root, path, `A=${CANARY}\n`, {}, read)).toEqual({ status: 'changed' })
    expect(readFileSync(path, 'utf8')).toBe('A=2\n')
    expect(extra(root, '.env')).toEqual([])
  })

  it('refuses when another process rewrites the file between the read and the rename, and keeps that process\'s bytes', async () => {
    const root = project({ 'config.yaml': 'a: 1\n' })
    const path = join(root, 'config.yaml')
    const result = await save(root, path, `a: ${CANARY}\n`, {
      beforeRename: () => { execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, 'a: agent\\n')`]) }
    })
    expect(result).toEqual({ status: 'changed' })
    expect(readFileSync(path, 'utf8')).toBe('a: agent\n')
    expect(extra(root, 'config.yaml')).toEqual([])
  })

  it('refuses when the file is replaced by a link, a folder or another file between the read and the rename', async () => {
    for (const replace of ['link', 'folder', 'file'] as const) {
      const root = project({ 'c.json': '{}', 'other.json': '{}' })
      const path = join(root, 'c.json')
      const result = await save(root, path, `{"k": "${CANARY}"}`, {
        beforeRename: () => {
          rmSync(path)
          if (replace === 'link') symlinkSync(join(root, 'other.json'), path)
          else if (replace === 'folder') mkdirSync(path)
          else { writeFileSync(join(root, 'swap.json'), '{}'); renameSync(join(root, 'swap.json'), path) }
        }
      })
      expect(result.status, replace).not.toBe('saved')
      expect(JSON.stringify(result)).not.toContain(CANARY)
      expect(readFileSync(join(root, 'other.json'), 'utf8')).toBe('{}')
      expect(extra(root, 'c.json', 'other.json'), replace).toEqual([])
    }
  })

  it('names each refusal in words, keeps no file beside it and never holds the text', async () => {
    const root = project({ '.env': 'A=1\n', 'notes.md': 'x\n' })
    const path = join(root, '.env')
    const results = [
      await save(root, join(root, 'notes.md'), CANARY),
      await save(root, path, `A=${CANARY}${'x'.repeat(256 * 1024)}\n`),
      await save(root, path, `A=${CANARY}\uD800\n`),
      await save(root, path, `A=${CANARY}\n`, { uid: (process.getuid?.() ?? 0) + 1 })
    ]
    expect(results).toEqual([
      { status: 'failed', message: 'Could not save · Quick look does not edit this kind of file' },
      { status: 'failed', message: 'Could not save · the new text is over 256 KB' },
      { status: 'failed', message: 'Could not save · the text is not valid UTF-8' },
      { status: 'failed', message: "Could not save · another user's file" }
    ])
    chmodSync(root, 0o500)
    const locked = await save(root, path, `A=${CANARY}\n`)
    chmodSync(root, 0o700)
    expect(locked).toEqual({ status: 'failed', message: 'Could not save · not writable' })
    expect(JSON.stringify(results.concat(locked))).not.toContain(CANARY)
    expect(readFileSync(path, 'utf8')).toBe('A=1\n')
    expect(extra(root, '.env', 'notes.md')).toEqual([])
  })
})
