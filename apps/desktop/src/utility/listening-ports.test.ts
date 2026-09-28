// MODULE: listening-ports.test.ts - /proc port attribution over fixture trees (Story 41.1)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROCESSES_PER_SLICE,
  createScanMemory,
  parseListeningSockets,
  portsByPreference,
  scanSessionPorts,
  sessionIdFromEnviron,
  type ProcReader
} from './listening-ports'

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const row4 = (address: string, port: number, state: string, inode: number, uid = 1000): string =>
  `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0`
const row6 = (address: string, port: number, state: string, inode: number): string =>
  `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000000000000000000000000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`

const LOOPBACK4 = '0100007F'
const WILDCARD4 = '00000000'
const LAN4 = '0A01A8C0' // 192.168.1.10
const LOOPBACK6 = '00000000000000000000000001000000'
const WILDCARD6 = '00000000000000000000000000000000'
const MAPPED6 = '0000000000000000FFFF00000100007F'

interface FixtureProcess {
  uid?: number
  environ?: string | null
  fds?: Record<string, string>
  comm?: string
}

/** An in-memory /proc: missing paths throw like the kernel's ENOENT, `environ: null` like EACCES. */
function fixture(tcp: string[], tcp6: string[] | null, processes: Record<string, FixtureProcess>): ProcReader & { reads: string[] } {
  const reads: string[] = []
  const fail = (path: string): never => { throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' }) }
  const pid = (path: string): FixtureProcess => processes[path.split('/')[2]!] ?? fail(path)
  return {
    reads,
    readdir(path) {
      reads.push(path)
      if (path === '/proc') return [...Object.keys(processes), 'self', 'net', 'sys']
      const fds = pid(path).fds
      return fds ? Object.keys(fds) : fail(path)
    },
    readFile(path) {
      reads.push(path)
      if (path === '/proc/net/tcp') return Buffer.from([HEADER, ...tcp].join('\n'))
      if (path === '/proc/net/tcp6') return tcp6 ? Buffer.from([HEADER, ...tcp6].join('\n')) : fail(path)
      const entry = pid(path)
      if (path.endsWith('/environ')) {
        if (entry.environ === null) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return Buffer.from(entry.environ ?? '')
      }
      if (path.endsWith('/comm')) return entry.comm ? Buffer.from(`${entry.comm}\n`) : fail(path)
      return fail(path)
    },
    readlink(path) {
      reads.push(path)
      const fd = path.split('/')[4]!
      return pid(path).fds?.[fd] ?? fail(path)
    },
    ownerUid(path) {
      return pid(path).uid ?? 1000
    }
  }
}

const env = (sessionId: string): string => `PATH=/usr/bin\0BMN_SESSION_ID=${sessionId}\0HOME=/home/owner\0`

describe('parsing /proc/net/tcp (Story 41.1)', () => {
  it('keeps only LISTEN rows and decodes IPv4 and IPv6 addresses', () => {
    expect(parseListeningSockets([HEADER, row4(LOOPBACK4, 5173, '0A', 11), row4(WILDCARD4, 3000, '01', 12),
      row4(LAN4, 8080, '0A', 13, 0)].join('\n'), 4)).toEqual([
      { inode: '11', address: '127.0.0.1', port: 5173, uid: 1000 },
      { inode: '13', address: '192.168.1.10', port: 8080, uid: 0 }
    ])
    expect(parseListeningSockets([HEADER, row6(LOOPBACK6, 5173, '0A', 21), row6(WILDCARD6, 4000, '0A', 22),
      row6(MAPPED6, 9000, '0A', 23), row6(WILDCARD6, 4001, '06', 24)].join('\n'), 6)).toEqual([
      { inode: '21', address: '::1', port: 5173, uid: 1000 },
      { inode: '22', address: '::', port: 4000, uid: 1000 },
      { inode: '23', address: '::ffff:127.0.0.1', port: 9000, uid: 1000 }
    ])
  })

  it('skips malformed rows and inode 0 instead of guessing', () => {
    expect(parseListeningSockets([HEADER, 'garbage', row4('0100', 80, '0A', 5), row4(LOOPBACK4, 5173, '0A', 0)].join('\n'), 4))
      .toEqual([])
  })
})

describe('choosing one address per port', () => {
  const port = (portNumber: number, address: string) => ({ port: portNumber, address, pid: 7, command: 'node' })
  it('prefers 127.0.0.1, then 0.0.0.0, then ::1, then ::, and drops 22, 80 and 443', () => {
    expect(portsByPreference([port(5173, '::'), port(5173, '::1'), port(5173, '0.0.0.0'), port(5173, '127.0.0.1'),
      port(4000, '::'), port(4000, '::1'), port(22, '127.0.0.1'), port(80, '0.0.0.0'), port(443, '::')]))
      .toEqual([port(4000, '::1'), port(5173, '127.0.0.1')])
  })

  it('shows a port bound to another interface with that address', () => {
    expect(portsByPreference([port(8080, '192.168.1.10')])).toEqual([port(8080, '192.168.1.10')])
  })
})

describe('attributing ports to sessions', () => {
  const tables = [row4(LOOPBACK4, 5173, '0A', 101), row6(LOOPBACK6, 5173, '0A', 102), row4(WILDCARD4, 8000, '0A', 201),
    row4(LOOPBACK4, 9229, '0A', 301), row4(LOOPBACK4, 7000, '0A', 401), row4(LOOPBACK4, 6000, '0A', 501)]

  it('attributes by the environment, dedupes IPv4/IPv6, and names the program', async () => {
    const proc = fixture(tables.filter((line) => line.includes(':')), [], {
      '10': { environ: env('session-a'), fds: { '0': '/dev/pts/3', '19': 'socket:[101]', '20': 'socket:[102]' }, comm: 'node' },
      // A server its shell left behind: re-parented, but it still carries the session in its environment.
      '11': { environ: env('session-b'), fds: { '3': 'socket:[201]' }, comm: 'python3' }
    })
    const ports = await scanSessionPorts(proc, new Set(['session-a', 'session-b']), 1000)
    expect(Object.fromEntries(ports)).toEqual({
      'session-a': [{ port: 5173, address: '127.0.0.1', pid: 10, command: 'node' }],
      'session-b': [{ port: 8000, address: '0.0.0.0', pid: 11, command: 'python3' }]
    })
  })

  it('fails closed: another user, an unreadable environment, no variable, an unknown session', async () => {
    const proc = fixture(tables, null, {
      '20': { uid: 0, environ: env('session-a'), fds: { '3': 'socket:[301]' } },
      '21': { environ: null, fds: { '3': 'socket:[401]' } },
      '22': { environ: 'PATH=/usr/bin\0', fds: { '3': 'socket:[501]' } },
      '23': { environ: env('deleted-session'), fds: { '3': 'socket:[201]' } }
    })
    expect(await scanSessionPorts(proc, new Set(['session-a']), 1000)).toEqual(new Map())
    // Descriptors are read only for a process already attributed to a known session.
    expect(proc.reads.filter((path) => path.includes('/fd'))).toEqual([])
  })

  it('reads the environment afresh on every scan, so a reused pid moves with its new owner', async () => {
    const processes: Record<string, FixtureProcess> = {
      '30': { environ: env('session-a'), fds: { '3': 'socket:[101]' }, comm: 'vite' }
    }
    const proc = fixture(tables, [], processes)
    const known = new Set(['session-a', 'session-b'])
    // The memory keeps where the socket was, never whose it is: the environment decides on every scan.
    const memory = createScanMemory()
    expect([...(await scanSessionPorts(proc, known, 1000, memory)).keys()]).toEqual(['session-a'])
    processes['30'] = { environ: env('session-b'), fds: { '3': 'socket:[101]' }, comm: 'vite' }
    expect([...(await scanSessionPorts(proc, known, 1000, memory)).keys()]).toEqual(['session-b'])
    processes['30'] = { environ: 'PATH=/usr/bin\0', fds: { '3': 'socket:[101]' }, comm: 'vite' }
    expect(await scanSessionPorts(proc, known, 1000, memory)).toEqual(new Map())
  })

  it('reads the process table in slices, so terminal output is not held up for a whole scan', async () => {
    const processes = Object.fromEntries(Array.from({ length: 2 * PROCESSES_PER_SLICE + 50 }, (_, index) =>
      [String(1_000 + index), { environ: env('another-session') }]))
    const proc = fixture(tables, [], processes)
    const scanning = scanSessionPorts(proc, new Set(['session-a']), 1000)
    let readsWhenOtherWorkRan = -1
    setImmediate(() => { readsWhenOtherWorkRan = proc.reads.length })
    await scanning
    expect(readsWhenOtherWorkRan).toBeGreaterThan(0)
    expect(readsWhenOtherWorkRan).toBeLessThan(proc.reads.length)
  })

  it('also ends a slice after a few milliseconds, since one process can hold many descriptors', async () => {
    let clock = 0
    const fds = Object.fromEntries(Array.from({ length: 10 }, (_, fd) => [String(fd), '/dev/null']))
    const base = fixture(tables, [], Object.fromEntries(['40', '41', '42'].map((pid) => [pid, { environ: env('session-a'), fds }])))
    // Each descriptor read costs a millisecond on this clock, so one process fills a whole slice.
    const proc: ProcReader = { ...base, readlink: (path) => { clock += 1; return base.readlink(path) } }
    const scanning = scanSessionPorts(proc, new Set(['session-a']), 1000, createScanMemory(), () => clock)
    let readsWhenOtherWorkRan = -1
    setImmediate(() => { readsWhenOtherWorkRan = base.reads.length })
    await scanning
    expect(readsWhenOtherWorkRan).toBeGreaterThan(0)
    expect(readsWhenOtherWorkRan).toBeLessThan(base.reads.length)
  })

  it('reads one link per placed socket on later scans, and searches again only when that link no longer holds it', async () => {
    const processes: Record<string, FixtureProcess> = {
      '50': { environ: env('session-a'), fds: { '0': '/dev/pts/1', '1': '/dev/pts/1', '7': 'socket:[101]' }, comm: 'vite' },
      '51': { environ: env('session-a'), fds: { '0': '/dev/pts/1', '4': '/dev/null' }, comm: 'node' }
    }
    const proc = fixture([row4(LOOPBACK4, 5173, '0A', 101)], [], processes)
    const memory = createScanMemory()
    const known = new Set(['session-a'])
    const vite = { port: 5173, address: '127.0.0.1', pid: 50, command: 'vite' }
    expect(Object.fromEntries(await scanSessionPorts(proc, known, 1000, memory))).toEqual({ 'session-a': [vite] })
    proc.reads.length = 0
    expect(Object.fromEntries(await scanSessionPorts(proc, known, 1000, memory))).toEqual({ 'session-a': [vite] })
    expect(proc.reads.filter((path) => path.includes('/fd'))).toEqual(['/proc/50/fd/7'])
    // The server hands its socket to a worker and exits: the one link read fails, so the search finds the worker.
    delete processes['50']
    processes['51'] = { ...processes['51']!, fds: { '0': '/dev/pts/1', '9': 'socket:[101]' } }
    expect(Object.fromEntries(await scanSessionPorts(proc, known, 1000, memory))).toEqual({ 'session-a': [{ ...vite, pid: 51, command: 'node' }] })
  })

  it('searches for a socket no session holds only in processes it has not searched yet', async () => {
    const processes: Record<string, FixtureProcess> = {
      '60': { environ: env('session-a'), fds: { '3': 'socket:[999]' }, comm: 'bash' }
    }
    const proc = fixture([row4(LOOPBACK4, 5432, '0A', 201)], [], processes)
    const memory = createScanMemory()
    const scan = () => scanSessionPorts(proc, new Set(['session-a']), 1000, memory)
    const descriptorReads = (): string[] => proc.reads.filter((path) => path.includes('/fd'))
    expect(await scan()).toEqual(new Map())
    expect(descriptorReads()).toEqual(['/proc/60/fd', '/proc/60/fd/3'])
    proc.reads.length = 0
    expect(await scan()).toEqual(new Map())
    expect(descriptorReads()).toEqual([])
    // A daemon's child now holds it: a new process, so it alone is searched.
    processes['61'] = { environ: env('session-a'), fds: { '4': 'socket:[201]' }, comm: 'postgres' }
    expect(Object.fromEntries(await scan())).toEqual({ 'session-a': [{ port: 5432, address: '127.0.0.1', pid: 61, command: 'postgres' }] })
    expect(descriptorReads()).toEqual(['/proc/61/fd', '/proc/61/fd/4'])
    // A pid that went away and came back is another process, searched again.
    proc.reads.length = 0
    const leftover = fixture([row4(LOOPBACK4, 6000, '0A', 301)], [], { '62': { environ: env('session-a'), fds: {} } })
    const again = createScanMemory()
    await scanSessionPorts(leftover, new Set(['session-a']), 1000, again)
    const reused = fixture([row4(LOOPBACK4, 6000, '0A', 301)], [], {})
    await scanSessionPorts(reused, new Set(['session-a']), 1000, again)
    expect(again.foreign.get('301')).toEqual(new Set())
  })

  it('never considers a socket another user created, even when a session process holds it', async () => {
    const proc = fixture([row4(LOOPBACK4, 5173, '0A', 101, 0)], [], {
      '70': { environ: env('session-a'), fds: { '3': 'socket:[101]' }, comm: 'node' }
    })
    expect(await scanSessionPorts(proc, new Set(['session-a']), 1000)).toEqual(new Map())
    expect(proc.reads.filter((path) => path.includes('/fd'))).toEqual([])
  })

  it('reads nothing when no session is known, and throws only when the IPv4 table is unreadable', async () => {
    const proc = fixture(tables, [], {})
    expect(await scanSessionPorts(proc, new Set(), 1000)).toEqual(new Map())
    expect(proc.reads).toEqual([])
    const broken: ProcReader = { ...fixture(tables, [], {}), readFile: () => { throw new Error('EIO') } }
    await expect(scanSessionPorts(broken, new Set(['session-a']), 1000)).rejects.toThrow('EIO')
  })

  it('finds BMN_SESSION_ID in a NUL-separated block and ignores a lookalike', () => {
    expect(sessionIdFromEnviron(Buffer.from(env('abc')))).toBe('abc')
    expect(sessionIdFromEnviron(Buffer.from('XBMN_SESSION_ID=abc\0BMN_SESSION_ID_OLD=def\0'))).toBeNull()
    expect(sessionIdFromEnviron(Buffer.from('BMN_SESSION_ID=\0'))).toBeNull()
  })
})

describe('the scan starts nothing', () => {
  it('reads /proc through the file system only: neither module can start a process', () => {
    for (const file of ['listening-ports.ts', 'port-watch.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      // A bare spawn, exec or fork call; a regular expression's own `.exec(` is not one.
      expect(source, file).not.toMatch(/child_process|worker_threads|process\.kill|(?<![.\w])(spawn|exec|execFile|execSync|execFileSync|fork)\(/)
    }
  })
})

