// MODULE: source-update-restart.test.ts - Story 134.2: the restart is offered only for a passed build and names the build he got
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openedSourceBuild, waitingSourceBuild } from './source-update-restart'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); delete process.env.BMN_UPDATE_RESTART_RESULT })

function status(value: Record<string, unknown>): string {
  const folder = mkdtempSync(join(tmpdir(), 'bmn-source-update-')); folders.push(folder)
  const path = join(folder, 'latest.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

const A = 'a'.repeat(40), B = 'b'.repeat(40)

describe('source update restart', () => {
  it('offers the restart only for a build that passed, never while a newer one is being tested', () => {
    expect(waitingSourceBuild(status({ phase: 'waiting-for-exit', commit: A, staged: A }))).toBe(A)
    expect(waitingSourceBuild(status({ phase: 'preparing', commit: B, staged: A }))).toBeNull()
    expect(waitingSourceBuild(status({ phase: 'queued', commit: A }))).toBeNull()
  })

  it('names the build he got even when the worker already builds a newer push', () => {
    process.env.BMN_UPDATE_RESTART_RESULT = 'complete'
    expect(openedSourceBuild(status({ phase: 'complete', commit: A, installed: A }))).toBe(A)
    expect(openedSourceBuild(status({ phase: 'preparing', commit: B, staged: null, installed: A }))).toBe(A)
    expect(openedSourceBuild(status({ phase: 'preparing', commit: B, staged: null, installed: null }))).toBe('unknown build')
  })
})
