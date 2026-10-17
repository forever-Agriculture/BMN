import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The board lock's reclaim, at the one interleaving that matters (Sol review F2): this writer reads a dead
// holder's lock, and before it acts another writer has already reclaimed it and holds it.
const race = vi.hoisted(() => ({ lock: '', swapTo: null as string | null }))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  const readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    const text = real.readFileSync(path, options as BufferEncoding)
    if (path === race.lock && race.swapTo !== null) { real.writeFileSync(race.lock, race.swapTo); race.swapTo = null }
    return text
  }) as typeof real.readFileSync
  return { ...real, default: { ...real, readFileSync }, readFileSync }
})
const { lockBoard } = await import('../../bin/plan-cli.mjs')

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('the board lock\'s reclaim (Story 77.2, Sol review F2)', () => {
  it('never removes a lock another writer took after the dead holder\'s was read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-plan-lock-')); roots.push(root)
    mkdirSync(join(root, 'plan'))
    const board = join(root, 'plan/status.yaml')
    writeFileSync(board, 'format: bmn-plan\n')
    race.lock = join(root, 'plan/.status.yaml.lock')
    const live = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: 'the-other-writer' })}\n`
    writeFileSync(race.lock, JSON.stringify({ pid: 2 ** 22 + 4242 }))
    race.swapTo = live
    await expect(lockBoard(board, { waitMs: 300 })).rejects.toMatchObject({ code: 'LOCKED' })
    expect(fs.readFileSync(race.lock, 'utf8')).toBe(live)
  })
})
