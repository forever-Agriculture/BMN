// MODULE: doctor-pre-review-regression.test.ts - Real CLI count wording and the full documented per-tree byte budget
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { locationRoots, observeTree } from '../../bin/doctor-locations.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'
import { runDoctorCommand } from '../../bin/doctor.mjs'
import { doctorView, emptyDoctorState } from '../../bin/doctor-state.mjs'

const folders: string[] = []
const fixture = (): string => { const home = mkdtempSync(join(tmpdir(), 'bmn-doctor-pre-review-')); folders.push(home); return home }
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('reads one full 16 MiB tree file and rejects the next byte as the tree bound', () => {
  const home = fixture(), tree = join(home, 'memory'), file = join(tree, 'MEMORY.md')
  mkdirSync(tree); writeFileSync(file, ''); truncateSync(file, 16 * 1024 * 1024)
  const roots = locationRoots(selectedProfile({ HOME: home }))
  expect(observeTree(tree, roots).files.get('MEMORY.md')?.length).toBe(16 * 1024 * 1024)
  writeFileSync(join(tree, 'next'), 'x')
  expect(() => observeTree(tree, roots)).toThrow(expect.objectContaining({ code: 'BOUND_EXCEEDED' }))
})

it('prints the approved concrete count wording through the real doctor CLI flow', async () => {
  const home = fixture(), tree = join(home, '.claude/projects/-tmp-synthetic/memory')
  mkdirSync(tree, { recursive: true })
  for (let i = 0; i < 1024; i++) writeFileSync(join(tree, `entry-${i}`), 'synthetic')
  const lines: string[] = []
  expect(await runDoctorCommand([], { environment: { HOME: home, PATH: '/usr/bin:/bin' }, out: value => lines.push(value) })).toBe(3)
  expect(lines.join('\n')).toContain('1 folder too large to check')
  expect(lines.join('\n')).not.toMatch(/\{count\}|\{noun\}/)
}, 30000)


it('final review file: oversized shared config has one concrete file gap through the real CLI', async () => {
  const home = fixture(), path = join(home, '.codex/config.toml')
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, ''); truncateSync(path, 1024 * 1024 + 1)
  const lines: string[] = [], environment = { HOME: home, PATH: '/usr/bin:/bin' }
  expect(await runDoctorCommand(['--json'], { environment, out: value => lines.push(value) })).toBe(3)
  const view = JSON.parse(lines[0]!), row = view.rows.find((row: { check: string }) => row.check === 'leftovers')
  expect(row.state).toBe('partial')
  expect(row.problems).toEqual([{ code: 'leftover-file-bound', item: 1, count: 1,
    reason: '1 file too large to check', fix: 'Items that depend on these files were not fully checked. The read limit for these files is 1 MiB each.' }])
  const text: string[] = []
  expect(await runDoctorCommand([], { environment, out: value => text.push(value) })).toBe(3)
  expect(text.join('\n')).toContain('1 file too large to check')
  for (const privateValue of [home, 'config.toml', '"bound"', 'itemTag', 'contextTag']) expect(lines.join('\n') + text.join('\n')).not.toContain(privateValue)
}, 30000)

it('final review control: route bounds remain steps and fixed nouns preserve other limits', async () => {
  const home = fixture(), deep = join(home, ...Array.from({ length: 70 }, () => 'd'), 'input')
  mkdirSync(join(deep, '..'), { recursive: true }); writeFileSync(deep, 'small')
  const inspection = await import(fileURLToPath(new URL('../../bin/doctor-inspection.mjs', import.meta.url)))
  const session = inspection.createInspectionSession(selectedProfile({ HOME: home }), undefined, Date.now() + 5000)
  session.file(deep)
  expect(inspection.inspectionResult([], session.finish().gaps)).toMatchObject({ state: 'partial', problems: [{ code: 'leftover-step', count: 1 }] })
  const saved = emptyDoctorState()
  saved.results.leftovers = { state: 'partial', checkedAt: Date.now(), version: 'a'.repeat(64), problems: [
    { code: 'leftover-folder-bound', item: 1, count: 1 }, { code: 'leftover-database-bound', item: 2, count: 2 }
  ] }
  expect(doctorView(saved).rows.find(row => row.check === 'leftovers')?.problems.map(problem => problem.reason))
    .toEqual(['1 folder too large to check', '2 databases too large to check'])
})
