// MODULE: file-replace.test.ts - Replacement leaves the target whole, removes its staged copy and names a locked target.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replaceFile, replaceFileSync, replacementError } from './file-replace'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): { root: string; target: string; temporary: string } {
  const root = mkdtempSync(join(tmpdir(), 'bmn-file-replace-'))
  roots.push(root)
  const target = join(root, 'settings.json')
  const temporary = join(root, 'settings.json.staged.tmp')
  writeFileSync(target, 'previous complete contents')
  writeFileSync(temporary, 'next complete contents')
  return { root, target, temporary }
}

const refused = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: operation refused, rename`), { code })

describe('replacing a file', () => {
  it('moves the staged copy over the target', async () => {
    const { target, temporary } = fixture()
    await replaceFile(temporary, target)
    expect(readFileSync(target, 'utf8')).toBe('next complete contents')
    expect(existsSync(temporary)).toBe(false)
  })

  it('names a target Windows refused as in use, keeps the code and the cause, and removes the staged copy', async () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const { target, temporary } = fixture()
      const original = refused(code)
      const error = await replaceFile(temporary, target, { platform: 'win32', move: () => Promise.reject(original) })
        .then(() => undefined, (failure: unknown) => failure as NodeJS.ErrnoException)
      expect(error?.message).toBe(`${target} is in use or locked by another program; close it there and try again (${code})`)
      expect(error?.code).toBe(code)
      expect(error?.cause).toBe(original)
      expect(existsSync(temporary)).toBe(false)
      expect(readFileSync(target, 'utf8')).toBe('previous complete contents')
    }
  })

  it('leaves other refusals as they were: permissions on Linux, and anything without an errno code', () => {
    const denied = refused('EACCES')
    expect(replacementError(denied, '/x', 'linux')).toBe(denied)
    const plain = new Error('no code')
    expect(replacementError(plain, 'C:\\x', 'win32')).toBe(plain)
    expect((replacementError(refused('EBUSY'), '/x', 'linux') as Error).message).toContain('in use or locked')
  })

  it('does the same synchronously', () => {
    const { target, temporary } = fixture()
    expect(() => replaceFileSync(temporary, target, { platform: 'win32', move: () => { throw refused('EPERM') } }))
      .toThrow(`${target} is in use or locked by another program; close it there and try again (EPERM)`)
    expect(existsSync(temporary)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('previous complete contents')
    const next = fixture()
    replaceFileSync(next.temporary, next.target)
    expect(readFileSync(next.target, 'utf8')).toBe('next complete contents')
  })

  it.runIf(process.platform !== 'win32')('removes the staged copy when the real rename fails', async () => {
    const { root, temporary } = fixture()
    const occupied = join(root, 'occupied')
    mkdirSync(join(occupied, 'inside'), { recursive: true })
    await expect(replaceFile(temporary, occupied)).rejects.toMatchObject({ code: expect.any(String) })
    expect(readdirSync(root).sort()).toEqual(['occupied', 'settings.json'])
  })

  it.runIf(process.platform === 'win32')('reports a target another program holds open without sharing, natively', async () => {
    const { root, target, temporary } = fixture()
    const ready = join(root, 'holder-ready')
    // A separate process opens the target with no sharing until its stdin closes, as an editor or scanner might.
    const holder = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        '$p=[Console]::In.ReadLine();$r=[Console]::In.ReadLine();$f=[IO.File]::Open($p,"Open","Read","None");' +
        '[IO.File]::WriteAllText($r,"x");[void][Console]::In.ReadLine();$f.Dispose()'],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    try {
      holder.stdin.write(`${target}\n${ready}\n`)
      const started = Date.now()
      while (!existsSync(ready) && Date.now() - started < 30_000) await new Promise((resolve) => setTimeout(resolve, 100))
      expect(existsSync(ready)).toBe(true)
      const error = await replaceFile(temporary, target).then(() => undefined, (failure: unknown) => failure as NodeJS.ErrnoException)
      expect(['EPERM', 'EBUSY', 'EACCES']).toContain(error?.code)
      expect(error?.message).toContain('is in use or locked by another program')
      expect(existsSync(temporary)).toBe(false)
    } finally {
      holder.stdin.end('\n')
      await new Promise((resolve) => { holder.once('exit', resolve); setTimeout(resolve, 10_000) })
    }
    expect(readFileSync(target, 'utf8')).toBe('previous complete contents')
  }, 60_000)
})
