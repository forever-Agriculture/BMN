// MODULE: listening-ports.ts - the local TCP ports each session's own programs listen on, read from /proc (Story 41.1)
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
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

/** Processes read between two event-loop turns: a slice takes a few milliseconds, so terminal output keeps flowing. */
export const PROCESSES_PER_SLICE = 50

/** ssh, http and https: a session's own program almost never holds them, and showing them would mislead. */
const DROPPED_PORTS: ReadonlySet<number> = new Set([22, 80, 443])
const LISTEN_STATE = '0A'
/** Loopback first, then wildcard: the address a browser on this machine reaches most directly. */
const ADDRESS_PREFERENCE = ['127.0.0.1', '0.0.0.0', '::1', '::']

interface ListeningSocket {
  inode: string
  address: string
  port: number
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
    if (!Number.isInteger(port) || port <= 0) continue
    sockets.push({ inode, address: family === 4 ? ipv4(addressHex) : ipv6(addressHex), port })
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

/** The listening sockets one process holds, under its session, or none when anything about it does not check out. */
function processPorts(
  proc: ProcReader,
  pid: string,
  sockets: ReadonlyMap<string, ListeningSocket[]>,
  sessionIds: ReadonlySet<string>,
  uid: number
): Array<[string, ListeningPort]> {
  if (readOrNull(() => proc.ownerUid(`/proc/${pid}`)) !== uid) return []
  const environ = readOrNull(() => proc.readFile(`/proc/${pid}/environ`))
  const sessionId = environ ? sessionIdFromEnviron(environ) : null
  if (sessionId === null || !sessionIds.has(sessionId)) return []
  const held = (readOrNull(() => proc.readdir(`/proc/${pid}/fd`)) ?? []).flatMap((fd) => {
    const inode = /^socket:\[(\d+)\]$/.exec(readOrNull(() => proc.readlink(`/proc/${pid}/fd/${fd}`)) ?? '')?.[1]
    return inode ? sockets.get(inode) ?? [] : []
  })
  if (held.length === 0) return []
  const comm = readOrNull(() => proc.readFile(`/proc/${pid}/comm`))
  const command = comm ? comm.toString('utf8').trim() || null : null
  return held.map((socket) => [sessionId, { port: socket.port, address: socket.address, pid: Number(pid), command }])
}

/**
 * One pass over the process table for every session at once. A process counts only when it is the owner's, its
 * environment names a session BMN knows (read now, never remembered by pid: a reused pid may be anyone), and one of
 * its descriptors is a listening socket. Anything unreadable is skipped: an unattributed port is better than a wrong
 * one. Throws only when the socket tables themselves cannot be read, so the caller can keep its previous result.
 */
export async function scanSessionPorts(
  proc: ProcReader,
  sessionIds: ReadonlySet<string>,
  uid: number
): Promise<Map<string, ListeningPort[]>> {
  const result = new Map<string, ListeningPort[]>()
  if (sessionIds.size === 0) return result
  const tcp = parseListeningSockets(proc.readFile('/proc/net/tcp').toString('utf8'), 4)
  const tcp6 = readOrNull(() => proc.readFile('/proc/net/tcp6'))
  const sockets = new Map<string, ListeningSocket[]>()
  for (const socket of [...tcp, ...(tcp6 ? parseListeningSockets(tcp6.toString('utf8'), 6) : [])]) {
    sockets.set(socket.inode, [...(sockets.get(socket.inode) ?? []), socket])
  }
  if (sockets.size === 0) return result

  const pids = proc.readdir('/proc').filter((name) => /^\d+$/.test(name))
  const found: Array<[string, ListeningPort]> = []
  for (const [index, pid] of pids.entries()) {
    if (index > 0 && index % PROCESSES_PER_SLICE === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    found.push(...processPorts(proc, pid, sockets, sessionIds, uid))
  }
  const bySession = new Map<string, ListeningPort[]>()
  for (const [sessionId, port] of found) bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), port])
  for (const [sessionId, ports] of bySession) {
    const kept = portsByPreference(ports)
    if (kept.length > 0) result.set(sessionId, kept)
  }
  return result
}
