// MODULE: doctor-private-ancestor.test.ts - real worker continuity ignores only proven namespace scaffolding
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { acquireLeftoversDoctor, revalidateLeftoversDoctor, sandboxProcess } from '../../bin/doctor-adapters.mjs'
import { matchContinuity } from '../../bin/doctor-continuity.mjs'
import { observeRoute } from '../../bin/doctor-locations.mjs'
// @ts-expect-error private scanner session has no published declarations
import * as inspection from '../../bin/doctor-inspection.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'

const keys = { item: 'a'.repeat(64), context: 'b'.repeat(64) }
const roots: string[] = []
function fixture() {
  const base = mkdtempSync('/var/tmp/bmn-doctor-ancestor-'); roots.push(base)
  const home = join(base, 'home'), config = join(home, '.codex/config.toml')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(config, '[mcp_servers.synthetic]\ncommand="bmn-missing-program"\n', { mode: 0o600 })
  return { base, home, config, environment: { HOME: home, PATH: '/usr/bin:/bin' } }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('keeps one unchanged item continuous across overlapping private temporary ancestors', async () => {
  const { home, environment } = fixture()
  const holder = fileURLToPath(new URL('./test-fixtures/doctor-private-ancestor-holder.mjs', import.meta.url))
  const worker = fileURLToPath(new URL('../../bin/doctor-inspection-worker.mjs', import.meta.url))
  const now = Date.now(), context = { keys, start: now + 800, release: now + 2400, deadline: now + 5000 }
  const runs = await Promise.all([0, 1].map(() => sandboxProcess(home, process.execPath, ['--no-warnings', holder, worker], environment,
    { inspection: true, runtime: false, privateInput: JSON.stringify(context), timeoutMs: 6000, outputBytes: 65536 })))
  const acquisitions = runs.map(run => {
    expect(run.failure).toBeNull(); expect(run.code).toBe(0)
    const result = JSON.parse(run.stdout), privateResult = JSON.parse(run.privateOutput!)
    expect(result.state).toBe('passed'); expect(result.problems.length).toBe(0)
    expect(result.leftovers.length).toBe(1); expect(result.leftovers[0].locator.status).toBe('located')
    expect(privateResult.rows.length).toBe(1)
    expect(matchContinuity(privateResult.rows, privateResult.rows)).toEqual([{ item: 1, current: 1 }])
    return privateResult
  })
  const [a, b] = acquisitions
  if (!(a.readyAt <= b.scanStart && b.readyAt <= a.scanStart && a.heldUntil >= b.scanEnd && b.heldUntil >= a.scanEnd)) throw new Error('OVERLAP_NOT_PROVEN')
  expect(matchContinuity(a.rows, b.rows)).toEqual([{ item: 1, current: 1 }])
}, 10_000)

it('refuses a replacement HOME even when its child directory, file and bytes survive', async () => {
  const { base, home, config, environment } = fixture()
  const first = await acquireLeftoversDoctor(home, environment, {}, keys)
  expect(first.rows.length).toBe(1)
  expect((await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows))?.matches).toEqual([{ item: 1, current: 1 }])
  const homeInode = lstatSync(home).ino, fileInode = lstatSync(config).ino
  renameSync(home, join(base, 'old')); mkdirSync(home)
  renameSync(join(base, 'old/.codex'), join(home, '.codex'))
  expect(lstatSync(home).ino).not.toBe(homeInode); expect(lstatSync(config).ino).toBe(fileInode)
  expect((await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows))?.matches).toEqual([{ item: 1, current: null }])
})

it('refuses rename-over with identical bytes and ambiguous hard-linked entries', async () => {
  const { home, config, environment } = fixture()
  const first = await acquireLeftoversDoctor(home, environment, {}, keys)
  expect(first.rows.length).toBe(1)
  writeFileSync(config + '.new', readFileSync(config)); renameSync(config + '.new', config)
  expect((await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows))?.matches).toEqual([{ item: 1, current: null }])
  linkSync(config, join(home, 'alias'))
  const ambiguous = await acquireLeftoversDoctor(home, environment, {}, keys)
  expect(ambiguous.rows.length).toBe(0); expect(ambiguous.result.leftovers?.[0]?.locator?.status).toBe('unresolved')
})

it('keeps real ancestor identities in default in-process inspections', () => {
  const { base, config, environment } = fixture()
  const view = Reflect.get(inspection, 'privateTmpfsView')
  expect(typeof view === 'function' ? view() : null).toBeNull()
  const session = inspection.createInspectionSession(selectedProfile(environment), keys, Date.now() + 60_000)
  const tuple = session.tuple(session.file(config)), index = observeRoute(config).nodes.findIndex(node => node.path === base)
  expect(index).toBeGreaterThanOrEqual(0)
  expect(tuple[0][0][index][1]).toMatchObject({ device: String(lstatSync(base).dev), inode: String(lstatSync(base).ino) })
})
