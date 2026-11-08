// MODULE: bench-proc-reader.ts - exact-cgroup port discovery with process directories pinned for one complete scan
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readlinkSync, statfsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProcReader } from './listening-ports'

interface BenchScope {
  version: number
  runId: string
  group: { path: string; device: number; inode: number }
}
interface ReaderOptions {
  procRoot?: string
  cgroupRoot?: string
  /** A bench fault is fatal independently of PortWatch's normal per-process error handling. */
  fault(): void
}
export function benchScopeRequest(argv: readonly string[], environment: NodeJS.ProcessEnv): { scopeFile: string; runId: string } | null {
  const intended = argv.includes('--bmn-qa-host'), scopeFile = environment.BMN_QA_SCOPE_FILE, runId = environment.BMN_QA_RUN_ID
  if (!intended && !scopeFile && !runId) return null
  if (!intended || !argv.includes('--bmn-test-host') || !scopeFile || !runId || !/^\d+-[a-f0-9]{16}$/u.test(runId)) throw new Error('QA_SCOPE_REQUIRED')
  return { scopeFile, runId }
}
interface BenchProcReader extends ProcReader {
  proof: { version: 1; runId: string; scopeSha256: string; group: BenchScope['group'] }
}

export function benchProcReader(scopeFile: string, runId: string, options: ReaderOptions): BenchProcReader {
  const procRoot = options.procRoot ?? '/proc', cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup'
  const processes = new Map<string, number>()
  let groupFd = -1, closed = false, faulted = false, scanning = false
  let members = new Set<string>(), scope: BenchScope, membership: string, scopeSha256: string
  const fail = (): never => {
    if (!closed && !faulted) { faulted = true; options.fault() }
    throw new Error('QA_SCOPE_INVALID')
  }
  const endScan = () => { for (const fd of processes.values()) closeSync(fd); processes.clear(); scanning = false; members.clear() }
  const close = () => { closed = true; endScan(); if (groupFd >= 0) { closeSync(groupFd); groupFd = -1 } }
  const groupPath = () => `/proc/self/fd/${groupFd}`
  const validate = () => {
    if (closed || faulted || groupFd < 0) fail()
    const pinned = fstatSync(groupFd), current = statSync(scope.group.path)
    if (pinned.dev !== scope.group.device || pinned.ino !== scope.group.inode || current.dev !== pinned.dev || current.ino !== pinned.ino ||
      statfsSync(groupPath()).type !== 0x63677270 || readFileSync(join(procRoot, 'self/cgroup'), 'utf8') !== membership) fail()
  }
  try {
    const file = openSync(scopeFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(file)
      if (!stat.isFile() || stat.size > 16384) fail()
      const bytes = readFileSync(file)
      scopeSha256 = createHash('sha256').update(bytes).digest('hex')
      scope = JSON.parse(bytes.toString('utf8')) as BenchScope
    } finally { closeSync(file) }
    if (scope.version !== 1 || scope.runId !== runId || !/^\d+-[a-f0-9]{16}$/u.test(runId) ||
      resolve(scope.group.path) !== scope.group.path || !scope.group.path.startsWith(cgroupRoot + '/') ||
      !scope.group.path.endsWith(`/bmn-qa-${runId}.scope`)) fail()
    membership = `0::${scope.group.path.slice(cgroupRoot.length)}\n`
    groupFd = openSync(scope.group.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    validate()
  } catch {
    try { if (!faulted) { faulted = true; options.fault() } }
    finally { close() }
    throw new Error('QA_SCOPE_INVALID')
  }
  const checked = <T>(operation: () => T): T => {
    try { validate() } catch { return fail() }
    // A known process can exit or become unreadable during an ordinary scan.
    // Those errors retain the scanner's existing per-process skip behavior.
    return operation()
  }
  const pinnedPath = (path: string) => {
    const match = /^\/proc\/([0-9]+)(\/(?:environ|comm|fd(?:\/[0-9]+)?))?$/u.exec(path)
    if (!match) return fail()
    if (!scanning || !members.has(match[1]!)) return fail()
    const pid = match[1]!, tail = match[2] ?? ''
    let fd = processes.get(pid)
    if (fd === undefined) {
      fd = openSync(join(procRoot, pid), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      processes.set(pid, fd)
    }
    const pinned = `/proc/self/fd/${fd}`
    // Membership and every private read refer to this same pinned process, even
    // after an exit/reuse of its numeric PID. Migration invalidates the whole bench.
    if (readFileSync(`${pinned}/cgroup`, 'utf8') !== membership) fail()
    return pinned + tail
  }
  return {
    proof: { version: 1, runId, scopeSha256, group: scope.group },
    beginScan: () => checked(() => {
      if (scanning) fail()
      let bytes: string
      try { bytes = readFileSync(`${groupPath()}/cgroup.procs`, 'utf8') } catch { return fail() }
      const ids = bytes.trim() ? bytes.trim().split(/\s+/u) : []
      if (bytes.length > 65536 || ids.length > 512 || ids.some(id => !/^[1-9][0-9]*$/u.test(id))) fail()
      members = new Set(ids); scanning = true
    }),
    endScan, close,
    readdir: path => checked(() => path === '/proc' ? [...members] : readdirSync(pinnedPath(path))),
    readFile: path => checked(() => /^\/proc\/net\/tcp6?$/u.test(path)
      ? readFileSync(join(procRoot, path.slice('/proc/'.length))) : readFileSync(pinnedPath(path))),
    readlink: path => checked(() => readlinkSync(pinnedPath(path))),
    ownerUid: path => checked(() => statSync(pinnedPath(path)).uid)
  }
}
