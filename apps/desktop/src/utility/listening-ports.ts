// MODULE: listening-ports.ts - the local TCP ports each session's own programs listen on, read from /proc (Story 41.1)
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import type { ListeningPort } from '@bmn/protocol'

/**
 * The few /proc reads a scan needs, so tests can hand it a fixture tree. Each is one quick system call on a kernel
 * file, made directly: queued as promises, a scan of ~700 processes became thousands of thread-pool jobs and took about
 * three times as long under load (Story 41.1 AC4, measured 2026-09-29).
 */
export interface ProcReader {
  readdir(path: string): string[]
  readFile(path: string): Buffer
  readlink(path: string): string
  ownerUid(path: string): number
}

export const procReader: ProcReader = {
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path),
  readlink: (path) => readlinkSync(path),
  ownerUid: (path) => statSync(path).uid
}

/**
 * A slice of the process table ends after this many processes or this long, whichever comes first, and the event loop
 * turns before the next: an agent's processes hold many descriptors, so counting processes alone does not bound it.
 */
export const PROCESSES_PER_SLICE = 50
export const SLICE_MS = 4
/** Descriptors of one process read between checks of the slice's time. */
const DESCRIPTORS_PER_CHECK = 64
/**
 * How long a scan after the first searches descriptors for sockets not placed yet. The search goes on in the next scan
 * from where this one stopped, so a scan's cost stays bounded while a test suite opens and closes listeners faster than
 * a scan can find them, or an old process opens a new one (Epic 41 recheck, measured 2026-09-29). The first scan
 * searches to the end, once, so the first list is complete.
 */
export const SEARCH_MS = 15

/** ssh, http and https: a session's own program almost never holds them, and showing them would mislead. */
const DROPPED_PORTS: ReadonlySet<number> = new Set([22, 80, 443])
const LISTEN_STATE = '0A'
/** Loopback first, then wildcard: the address a browser on this machine reaches most directly. */
const ADDRESS_PREFERENCE = ['127.0.0.1', '0.0.0.0', '::1', '::']

interface ListeningSocket {
  inode: string
  address: string
  port: number
  /** Who created the socket; only the owner's own sockets can be a session's. */
  uid: number
}

/**
 * What one scan leaves the next, so descriptors are read only where something may have changed. Each session's socket
 * remembers the process and descriptor it was found at, checked again every scan with one link read. A socket not found
 * in a session's process yet remembers which processes were searched for it, and only a process not among them, such as
 * a daemon's child or one the last scan had no time for, is searched again. (A process already searched that is later
 * handed the socket over a Unix socket is not found until the socket is reopened: rare enough to accept for a list of
 * dev servers.)
 */
export interface ScanMemory {
  holders: Map<string, { pid: string; fd: string }>
  /** Socket inode → the session processes already searched without finding it; the socket seen first comes first. */
  pending: Map<string, Set<string>>
  /** Whether a scan has searched once already, so later searches keep to SEARCH_MS. */
  searched: boolean
}

export function createScanMemory(): ScanMemory {
  return { holders: new Map(), pending: new Map(), searched: false }
}

/** A /proc/net word is the address in host byte order, 32 bits at a time. */
function ipv4(hex: string): string {
  return [6, 4, 2, 0].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join('.')
}

function ipv6(hex: string): string {
  const bytes: number[] = []
  for (let word = 0; word < 4; word++) {
    const chunk = hex.slice(word * 8, word * 8 + 8)
    for (const offset of [6, 4, 2, 0]) bytes.push(Number.parseInt(chunk.slice(offset, offset + 2), 16))
  }
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`
  }
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16))
  // The longest run of two or more zero groups collapses to "::", as every tool prints it.
  let bestStart = -1
  let bestLength = 0
  for (let start = 0; start < 8;) {
    if (groups[start] !== '0') { start++; continue }
    let end = start
    while (end < 8 && groups[end] === '0') end++
    if (end - start > bestLength && end - start >= 2) { bestStart = start; bestLength = end - start }
    start = end
  }
  if (bestStart < 0) return groups.join(':')
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`
}

/** The LISTEN rows of `/proc/net/tcp` or `/proc/net/tcp6`; malformed rows are skipped, never guessed. */
export function parseListeningSockets(table: string, family: 4 | 6): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue
    const [addressHex, portHex] = fields[1]!.split(':')
    const inode = fields[9]!
    if (!addressHex || !portHex || addressHex.length !== (family === 4 ? 8 : 32) || !/^\d+$/.test(inode) || inode === '0') continue
    const port = Number.parseInt(portHex, 16)
    const uid = Number(fields[7])
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(uid)) continue
    sockets.push({ inode, address: family === 4 ? ipv4(addressHex) : ipv6(addressHex), port, uid })
  }
  return sockets
}

/** One entry per port: the most reachable address wins, and ports 22, 80 and 443 are dropped. */
export function portsByPreference(entries: readonly ListeningPort[]): ListeningPort[] {
  const rank = (address: string): number => {
    const index = ADDRESS_PREFERENCE.indexOf(address)
    return index < 0 ? ADDRESS_PREFERENCE.length : index
  }
  const chosen = new Map<number, ListeningPort>()
  for (const entry of entries) {
    if (DROPPED_PORTS.has(entry.port)) continue
    const current = chosen.get(entry.port)
    if (!current || rank(entry.address) < rank(current.address) ||
      (rank(entry.address) === rank(current.address) && entry.address < current.address)) {
      chosen.set(entry.port, entry)
    }
  }
  return [...chosen.values()].sort((left, right) => left.port - right.port)
}

/** `BMN_SESSION_ID` from a NUL-separated environment block, or null when absent. */
export function sessionIdFromEnviron(environ: Buffer): string | null {
  for (const entry of environ.toString('utf8').split('\0')) {
    if (entry.startsWith('BMN_SESSION_ID=')) return entry.slice('BMN_SESSION_ID='.length) || null
  }
  return null
}

function readOrNull<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

/** The session a process belongs to, from its environment read now, or null when it is not the owner's or names none. */
function processSession(proc: ProcReader, pid: string, sessionIds: ReadonlySet<string>, uid: number): string | null {
  if (readOrNull(() => proc.ownerUid(`/proc/${pid}`)) !== uid) return null
  const environ = readOrNull(() => proc.readFile(`/proc/${pid}/environ`))
  const sessionId = environ ? sessionIdFromEnviron(environ) : null
  return sessionId !== null && sessionIds.has(sessionId) ? sessionId : null
}

function socketInode(link: string | null): string | null {
  return link?.startsWith('socket:[') && link.endsWith(']') ? link.slice(8, -1) : null
}

interface Slicer {
  /** Before each process: the slice ends after PROCESSES_PER_SLICE of them or SLICE_MS. */
  process(): Promise<void>
  /** Among one process's descriptors: the slice ends after SLICE_MS, since one process can hold thousands. */
  descriptors(): Promise<void>
}

/** Lets the event loop turn once the current slice has run long enough. */
function slicer(now: () => number): Slicer {
  let start = now()
  let processes = 0
  const turn = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    start = now()
    processes = 0
  }
  return {
    async process() {
      if (processes + 1 > PROCESSES_PER_SLICE || now() - start >= SLICE_MS) await turn()
      processes += 1
    },
    async descriptors() {
      if (now() - start >= SLICE_MS) await turn()
    }
  }
}

/**
 * One pass over the process table for every session at once. A process counts only when it is the owner's and its
 * environment names a session BMN knows, read now and never remembered by pid: a reused pid may be anyone. A socket
 * counts only when the owner created it and one of those processes holds it. Anything unreadable is skipped: an
 * unattributed port is better than a wrong one. Throws only when the IPv4 socket table cannot be read, so the caller
 * can keep its previous result.
 */
export async function scanSessionPorts(
  proc: ProcReader,
  sessionIds: ReadonlySet<string>,
  uid: number,
  memory: ScanMemory = createScanMemory(),
  now: () => number = () => performance.now()
): Promise<Map<string, ListeningPort[]>> {
  const result = new Map<string, ListeningPort[]>()
  if (sessionIds.size === 0) return result
  const tcp = parseListeningSockets(proc.readFile('/proc/net/tcp').toString('utf8'), 4)
  const tcp6 = readOrNull(() => proc.readFile('/proc/net/tcp6'))
  const sockets = new Map<string, ListeningSocket[]>()
  for (const socket of [...tcp, ...(tcp6 ? parseListeningSockets(tcp6.toString('utf8'), 6) : [])]) {
    if (socket.uid === uid) sockets.set(socket.inode, [...(sockets.get(socket.inode) ?? []), socket])
  }
  for (const remembered of [memory.holders, memory.pending]) {
    for (const inode of remembered.keys()) if (!sockets.has(inode)) remembered.delete(inode)
  }
  if (sockets.size === 0) return result

  const slice = slicer(now)
  const attributed = new Map<string, string>()
  for (const pid of proc.readdir('/proc').filter((name) => /^\d+$/.test(name))) {
    await slice.process()
    const sessionId = processSession(proc, pid, sessionIds, uid)
    if (sessionId !== null) attributed.set(pid, sessionId)
  }

  // A socket placed before stays placed while the same descriptor of a session's process still holds it.
  const placed = new Map<string, string>()
  for (const inode of sockets.keys()) {
    const holder = memory.holders.get(inode)
    if (holder && attributed.has(holder.pid) &&
      socketInode(readOrNull(() => proc.readlink(`/proc/${holder.pid}/fd/${holder.fd}`))) === inode) {
      placed.set(inode, holder.pid)
      continue
    }
    memory.holders.delete(inode)
    const searched = memory.pending.get(inode)
    if (!searched) memory.pending.set(inode, new Set())
    // A pid that left the session processes and came back is another process: it is searched again.
    else for (const pid of searched) if (!attributed.has(pid)) searched.delete(pid)
  }
  // Search the sessions' processes each pending socket has not been searched in: the processes the socket seen first
  // still needs come first, so a stream of new sockets cannot starve an older one, and among them the newest first,
  // since a new server usually is one. One process read counts for every pending socket. After the first search, a
  // search stops once it has run SEARCH_MS, so it always reads at least one process, and the next scan goes on with
  // what is left.
  const newestFirst = [...attributed.keys()].sort((left, right) => Number(right) - Number(left))
  const order = new Set<string>()
  for (const searched of memory.pending.values()) for (const pid of newestFirst) if (!searched.has(pid)) order.add(pid)
  const unsearched = (pid: string): boolean => [...memory.pending.values()].some((searched) => !searched.has(pid))
  const searchStart = now()
  const budget = memory.searched ? SEARCH_MS : Number.POSITIVE_INFINITY
  memory.searched = true
  for (const pid of order) {
    if (!unsearched(pid)) continue
    if (now() - searchStart >= budget) break
    await slice.process()
    const fds = readOrNull(() => proc.readdir(`/proc/${pid}/fd`)) ?? []
    for (let index = 0; index < fds.length; index++) {
      if (index > 0 && index % DESCRIPTORS_PER_CHECK === 0) await slice.descriptors()
      const fd = fds[index]!
      const inode = socketInode(readOrNull(() => proc.readlink(`/proc/${pid}/fd/${fd}`)))
      if (inode === null || !memory.pending.delete(inode)) continue
      memory.holders.set(inode, { pid, fd })
      placed.set(inode, pid)
    }
    for (const searched of memory.pending.values()) searched.add(pid)
  }

  const commands = new Map<string, string | null>()
  const found: Array<[string, ListeningPort]> = []
  for (const [inode, pid] of placed) {
    if (!commands.has(pid)) {
      const comm = readOrNull(() => proc.readFile(`/proc/${pid}/comm`))
      commands.set(pid, comm ? comm.toString('utf8').trim() || null : null)
    }
    for (const socket of sockets.get(inode)!) {
      found.push([attributed.get(pid)!, { port: socket.port, address: socket.address, pid: Number(pid), command: commands.get(pid)! }])
    }
  }
  const bySession = new Map<string, ListeningPort[]>()
  for (const [sessionId, port] of found) bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), port])
  for (const [sessionId, ports] of bySession) {
    const kept = portsByPreference(ports)
    if (kept.length > 0) result.set(sessionId, kept)
  }
  return result
}
