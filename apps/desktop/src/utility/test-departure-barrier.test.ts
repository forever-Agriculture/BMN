// MODULE: test-departure-barrier.test.ts - the native-race barrier is absent outside an explicit test host and releases only its own claim
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { testDepartureBarrier } from './test-departure-barrier'

it('requires both the test-host flag and explicit switch with an absolute isolated root', () => {
  expect(testDepartureBarrier([], { BMN_TEST_DEPARTURE_BARRIER: '1' }, '/tmp/synthetic')).toBeUndefined()
  expect(testDepartureBarrier(['--bmn-test-host'], {}, '/tmp/synthetic')).toBeUndefined()
  expect(testDepartureBarrier(['--bmn-test-host'], { BMN_TEST_DEPARTURE_BARRIER: '1' }, 'relative')).toBeUndefined()
})

it('holds one real asynchronous proof, refuses a foreign release, then becomes inert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bmn-departure-barrier-'))
  try {
    const barrier = testDepartureBarrier(['--bmn-test-host'], { BMN_TEST_DEPARTURE_BARRIER: '1' }, root)!
    let released = false
    const waiting = barrier('synthetic-session', 'synthetic-run').then(() => { released = true })
    const directory = join(root, 'departure-proof-test')
    let held: { token: string; sessionId: string; incarnationId: string } | undefined
    for (let count = 0; count < 100 && held === undefined; count++) {
      try { held = JSON.parse(await readFile(join(directory, 'held.json'), 'utf8')) } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
    }
    expect(held).toMatchObject({ sessionId: 'synthetic-session', incarnationId: 'synthetic-run' })
    expect(released).toBe(false)
    await writeFile(join(directory, 'release'), 'foreign-token')
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(released).toBe(false)
    await writeFile(join(directory, 'release'), held!.token)
    await waiting
    expect(JSON.parse(await readFile(join(directory, 'released.json'), 'utf8')).token).toBe(held!.token)
    await barrier('another-session', 'another-run')
    expect(JSON.parse(await readFile(join(directory, 'held.json'), 'utf8')).token).toBe(held!.token)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses a symlink instead of writing outside its private test directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bmn-departure-barrier-'))
  const target = await mkdtemp(join(tmpdir(), 'bmn-departure-outside-'))
  try {
    await symlink(target, join(root, 'departure-proof-test'))
    const barrier = testDepartureBarrier(['--bmn-test-host'], { BMN_TEST_DEPARTURE_BARRIER: '1' }, root)!
    await expect(barrier('synthetic', 'run')).rejects.toThrow()
    await expect(readFile(join(target, 'held.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }) }
})
