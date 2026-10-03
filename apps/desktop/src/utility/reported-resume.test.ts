// MODULE: reported-resume.test.ts - where a reported command's name resolves on PATH (Epic 43)
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProgramOnPath, missingProgramReason } from './reported-resume'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-reported-resume-'))
  roots.push(root)
  return root
}

async function program(directory: string, name: string, mode = 0o755): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name + (process.platform === 'win32' ? mode === 0o644 ? '.txt' : '.exe' : ''))
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, mode)
  return path
}

describe('finding a reported program on PATH', () => {
  it('takes the first absolute directory holding an executable file by that name', async () => {
    const root = await folder()
    const first = await program(join(root, 'first'), 'my-agent')
    await program(join(root, 'second'), 'my-agent')
    expect(findProgramOnPath('my-agent', [join(root, 'missing'), join(root, 'first'), join(root, 'second')].join(delimiter))).toBe(first)
  })

  it('never searches a relative entry, a directory by that name or a file that cannot run', async () => {
    const root = await folder()
    await mkdir(join(root, 'dir-entry', process.platform === 'win32' ? 'my-agent.exe' : 'my-agent'), { recursive: true })
    await program(join(root, 'not-executable'), 'my-agent', 0o644)
    const runnable = await program(join(root, 'runnable'), 'my-agent')
    expect(findProgramOnPath('my-agent', ['', '.', 'relative', join(root, 'dir-entry'), join(root, 'not-executable')].join(delimiter))).toBeNull()
    expect(findProgramOnPath('my-agent', [join(root, 'dir-entry'), join(root, 'not-executable'), join(root, 'runnable')].join(delimiter)))
      .toBe(runnable)
  })

  it('names the program that is gone and what Resume offers instead', () => {
    expect(missingProgramReason('my-agent')).toBe(
      '"my-agent" is no longer on this session\'s PATH, so the command it reported cannot run. Start again runs the ' +
      'session\'s saved command instead.')
  })
})
