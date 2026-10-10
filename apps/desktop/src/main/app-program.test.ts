// MODULE: app-program.test.ts - Epic 60.6: Health names the program PATH really selects for an app, never BMN's own command and never a stand-in from the current folder
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAppProgram } from './app-program'

let root: string
const program = (folder: string, name: string, mode = 0o755): string => {
  mkdirSync(join(root, folder), { recursive: true })
  const path = join(root, folder, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, mode)
  return path
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bmn-app-program-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the program PATH selects for an app (60.6)', () => {
  it('takes the first executable file of that name, in PATH order', () => {
    program('a', 'other')
    const second = program('b', 'synthetic-app')
    program('c', 'synthetic-app')
    expect(findAppProgram('synthetic-app', [join(root, 'missing'), join(root, 'a'), join(root, 'b'), join(root, 'c')].join(':'), null)).toEqual({ path: second })
  })

  it('passes over a folder of that name and a file that may not be run', () => {
    mkdirSync(join(root, 'a/synthetic-app'), { recursive: true })
    program('b', 'synthetic-app', 0o644)
    const real = program('c', 'synthetic-app')
    expect(findAppProgram('synthetic-app', ['a', 'b', 'c'].map((folder) => join(root, folder)).join(':'), null)).toEqual({ path: real })
  })

  it('passes over BMN\'s own commands in every spelling of their folder, since its codex only hands over to the next one', () => {
    program('bmn-bin', 'codex')
    symlinkSync(join(root, 'bmn-bin'), join(root, 'linked-bin'))
    const real = program('npm/bin', 'codex')
    const path = [join(root, 'linked-bin'), `${join(root, 'bmn-bin')}/`, join(root, 'npm/bin')].join(':')
    expect(findAppProgram('codex', path, join(root, 'bmn-bin'))).toEqual({ path: real })
    // Without that folder named, the first one on PATH is what a shell would run.
    expect(findAppProgram('codex', path, null)?.path).toBe(join(root, 'linked-bin/codex'))
    // Only BMN's own commands on PATH: no program to show or to update.
    expect(findAppProgram('codex', join(root, 'bmn-bin'), join(root, 'bmn-bin'))).toBeNull()
  })

  it('says where a link leads, so the owner sees which installation an update would touch', () => {
    const real = program('versions/2.0.0', 'synthetic-app')
    mkdirSync(join(root, 'bin'))
    symlinkSync(real, join(root, 'bin/synthetic-app'))
    expect(findAppProgram('synthetic-app', join(root, 'bin'), null)).toEqual({ path: join(root, 'bin/synthetic-app'), target: real })
    // A link that leads nowhere is not a program.
    symlinkSync(join(root, 'gone'), join(root, 'bin/broken-app'))
    expect(findAppProgram('broken-app', join(root, 'bin'), null)).toBeNull()
  })

  it('never answers from the folder BMN happens to run in, and finds nothing on an empty PATH', () => {
    program('here', 'synthetic-app')
    expect(findAppProgram('synthetic-app', ['', '.', 'here', 'relative/bin'].join(':'), null)).toBeNull()
    expect(findAppProgram('synthetic-app', undefined, null)).toBeNull()
    expect(findAppProgram('synthetic-app', '', null)).toBeNull()
  })
})
