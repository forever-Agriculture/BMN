// MODULE: bench-proc-reader.test.ts - scoped port discovery never opens an unrelated environment or follows a reused PID
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { benchProcReader, benchScopeRequest } from './bench-proc-reader'

vi.mock('node:fs', async original => ({ ...await original<typeof fs>(), statfsSync: () => ({ type: 0x63677270 }) }))
const roots: string[] = []
const runId = '1794086400000-0123456789abcdef', group = `/user.slice/bmn-qa-${runId}.scope`
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'bmn-proc-')); roots.push(root)
  const procRoot = join(root, 'proc'), cgroupRoot = join(root, 'groups'), groupPath = cgroupRoot + group
  fs.mkdirSync(groupPath, { recursive: true }); fs.mkdirSync(join(procRoot, 'self'), { recursive: true })
  fs.writeFileSync(join(procRoot, 'self/cgroup'), `0::${group}\n`)
  fs.writeFileSync(join(groupPath, 'cgroup.procs'), '71\n')
  for (const [pid, scope, value] of [['71', group, 'BMN_SESSION_ID=synthetic\0'], ['72', '/outside.scope', 'PRIVATE_SENTINEL=never-read\0']]) {
    fs.mkdirSync(join(procRoot, pid!), { recursive: true })
    fs.writeFileSync(join(procRoot, pid!, 'cgroup'), `0::${scope}\n`)
    fs.writeFileSync(join(procRoot, pid!, 'environ'), value!)
  }
  const stat = fs.statSync(groupPath), manifest = { version: 1, runId, group: { path: groupPath, device: stat.dev, inode: stat.ino } }
  const scopeFile = join(root, 'process-scope.json'); fs.writeFileSync(scopeFile, JSON.stringify(manifest))
  const fault = vi.fn(), reader = () => benchProcReader(scopeFile, runId, { procRoot, cgroupRoot, fault })
  return { root, procRoot, groupPath, scopeFile, manifest, fault, reader }
}
afterEach(() => { for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true }) })

it('keeps ordinary hosts unchanged and requires complete explicit bench activation', () => {
  expect(benchScopeRequest(['--bmn-test-host'], {})).toBeNull()
  expect(benchScopeRequest(['--bmn-test-host', '--bmn-qa-host'], { BMN_QA_RUN_ID: runId, BMN_QA_SCOPE_FILE: '/synthetic/scope.json' }))
    .toEqual({ runId, scopeFile: '/synthetic/scope.json' })
  for (const argv of [[], ['--bmn-test-host'], ['--bmn-qa-host']]) {
    expect(() => benchScopeRequest(argv, { BMN_QA_RUN_ID: runId, BMN_QA_SCOPE_FILE: '/synthetic/scope.json' })).toThrow('QA_SCOPE_REQUIRED')
  }
  expect(() => benchScopeRequest(['--bmn-test-host', '--bmn-qa-host'], {})).toThrow('QA_SCOPE_REQUIRED')
})
it('signals a forged group at construction without leaking its descriptor', () => {
  const f = fixture(), before = fs.readdirSync('/proc/self/fd').length
  fs.writeFileSync(f.scopeFile, JSON.stringify({ ...f.manifest, group: { ...f.manifest.group, inode: 0 } }))
  expect(() => f.reader()).toThrow('QA_SCOPE_INVALID'); expect(f.fault).toHaveBeenCalledOnce()
  expect(fs.readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before)
})

it('enumerates exact kernel group members and refuses an unrelated environment', () => {
  const f = fixture(), reader = f.reader()
  try {
    reader.beginScan!()
    expect(reader.readdir('/proc')).toEqual(['71'])
    expect(reader.readFile('/proc/71/environ').toString()).toContain('synthetic')
    expect(() => reader.readFile('/proc/72/environ')).toThrow('QA_SCOPE_INVALID')
    expect(f.fault).toHaveBeenCalledOnce()
  } finally { reader.close!() }
})
it('does not read the replacement when a numeric PID is reused between scans', () => {
  const f = fixture(), reader = f.reader()
  try {
    reader.beginScan!(); expect(reader.readFile('/proc/71/environ').toString()).toContain('synthetic'); reader.endScan!()
    fs.renameSync(join(f.procRoot, '71'), join(f.procRoot, 'old-71'))
    fs.renameSync(join(f.procRoot, '72'), join(f.procRoot, '71'))
    reader.beginScan!()
    expect(() => reader.readFile('/proc/71/environ')).toThrow('QA_SCOPE_INVALID')
  } finally { reader.close!() }
})
it('pins one process across UID, membership, environment and descriptor operations', () => {
  const f = fixture(), reader = f.reader()
  try {
    reader.beginScan!(); reader.ownerUid('/proc/71')
    fs.renameSync(join(f.procRoot, '71'), join(f.procRoot, 'old-71'))
    fs.renameSync(join(f.procRoot, '72'), join(f.procRoot, '71'))
    expect(reader.readFile('/proc/71/environ').toString()).toContain('synthetic')
    reader.endScan!()
  } finally { reader.close!() }
})
it.each(['identity', 'membership', 'missing'])('fails closed on %s scope changes, independent of scan error suppression', kind => {
  const f = fixture(), reader = f.reader()
  try {
    if (kind === 'identity') { fs.renameSync(f.groupPath, f.groupPath + '-old'); fs.mkdirSync(f.groupPath) }
    if (kind === 'membership') fs.writeFileSync(join(f.procRoot, 'self/cgroup'), '0::/outside.scope\n')
    if (kind === 'missing') fs.unlinkSync(join(f.groupPath, 'cgroup.procs'))
    expect(() => reader.beginScan!()).toThrow('QA_SCOPE_INVALID'); expect(f.fault).toHaveBeenCalledOnce()
  } finally { reader.close!() }
})
it('closes process descriptors on scan end and shutdown', () => {
  const f = fixture(), before = fs.readdirSync('/proc/self/fd').length, reader = f.reader()
  for (let i = 0; i < 10; i++) { reader.beginScan!(); reader.ownerUid('/proc/71'); reader.endScan!() }
  reader.close!()
  expect(fs.readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before)
})
it('makes migration fatal before a pinned process environment read', () => {
  const f = fixture(), reader = f.reader()
  try {
    reader.beginScan!(); reader.ownerUid('/proc/71')
    fs.writeFileSync(join(f.procRoot, '71/cgroup'), '0::/outside.scope\n')
    expect(() => reader.readFile('/proc/71/environ')).toThrow('QA_SCOPE_INVALID'); expect(f.fault).toHaveBeenCalledOnce()
  } finally { reader.close!() }
})
it('skips a process which exits without converting it into a scope fault', () => {
  const f = fixture(), reader = f.reader()
  try {
    reader.beginScan!(); fs.rmSync(join(f.procRoot, '71'), { recursive: true })
    expect(() => reader.readFile('/proc/71/environ')).toThrow(); expect(f.fault).not.toHaveBeenCalled()
  } finally { reader.close!() }
})
