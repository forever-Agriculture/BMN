// MODULE: trace.ts - runs a command under strace and reads from the trace which programs started, which connections were tried and which files were opened for writing or changed
//
// A missing marker file does not show that nothing ran; the trace of every process does. Linux only;
// needs `strace` and the right to trace one's own children.
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

export const STRACE = '/usr/bin/strace'

/** Whether this process may trace a child at all: strace is there and a trial run of it works. */
export function canTrace(): boolean {
  if (process.platform !== 'linux' || !existsSync(STRACE)) return false
  return spawnSync(STRACE, ['-f', '-qq', '-o', '/dev/null', '/usr/bin/true'], { stdio: 'ignore', timeout: 10_000 }).status === 0
}

const OPENS = new Set(['open', 'openat', 'openat2', 'creat'])
/** Calls that change a file or a folder by name or by an open file. */
const CHANGES = new Set([
  'rename', 'renameat', 'renameat2', 'unlink', 'unlinkat', 'mkdir', 'mkdirat', 'rmdir', 'link', 'linkat', 'symlink', 'symlinkat',
  'truncate', 'ftruncate', 'chmod', 'fchmod', 'fchmodat', 'fchmodat2', 'chown', 'fchown', 'lchown', 'fchownat',
  'utime', 'utimes', 'utimensat', 'futimesat', 'setxattr', 'lsetxattr', 'fsetxattr', 'removexattr', 'lremovexattr', 'fremovexattr', 'mknod', 'mknodat'
])
const PROCESS = ['execve', 'execveat', 'clone', 'clone3', 'fork', 'vfork', 'chdir', 'fchdir']
const NETWORK = ['socket', 'connect', 'bind', 'sendto', 'sendmsg']
const TRACED_CALLS = [...OPENS, ...CHANGES, ...PROCESS, ...NETWORK]

export interface TracedProgram { pid: number; path: string; argv: string[]; env: string[]; failed: boolean }
export interface TracedWrite { pid: number; call: string; paths: string[]; failed: boolean; line: string }
export interface Trace { programs: TracedProgram[]; connections: string[]; sockets: string[]; writes: TracedWrite[]; unparsed: string[] }

/** Starts `command` under strace, every child followed. `done` resolves with the exit code. */
export function traced(
  command: string,
  args: string[],
  options: { traceFile: string; cwd: string; env: Record<string, string>; stdio?: StdioOptions }
): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(STRACE, ['-f', '-qq', '-v', '-y', '-s', '16384', '-e', `trace=${TRACED_CALLS.join(',')}`, '-o', options.traceFile, command, ...args], {
    cwd: options.cwd, env: options.env, stdio: options.stdio ?? ['pipe', 'pipe', 'inherit']
  })
  const done = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
  return { child, done }
}

/** The strings of one call's arguments, C escapes undone, each with where it ends. */
function quoted(text: string): Array<{ value: string; end: number }> {
  const found: Array<{ value: string; end: number }> = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1
      continue
    }
    let value = ''
    index += 1
    while (index < text.length && text[index] !== '"') {
      if (text[index] === '\\') {
        const next = text[index + 1] ?? ''
        if (/[0-7]/.test(next)) {
          let digits = ''
          while (digits.length < 3 && /[0-7]/.test(text[index + 1 + digits.length] ?? '')) digits += text[index + 1 + digits.length]
          value += String.fromCharCode(parseInt(digits, 8))
          index += 1 + digits.length
        } else {
          value += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' } as Record<string, string>)[next] ?? next
          index += 2
        }
      } else {
        value += text[index]
        index += 1
      }
    }
    found.push({ value, end: index })
    index += 1
  }
  return found
}

/**
 * Reads a trace written by `traced`. `writes` holds every open for writing and every changing call,
 * with each path made absolute as the process saw it.
 */
export function readTrace(traceFile: string, startFolder: string): Trace {
  const pending = new Map<number, string>()
  const cwd = new Map<number, string>()
  const out: Trace = { programs: [], connections: [], sockets: [], writes: [], unparsed: [] }
  const folderOf = (pid: number): string => cwd.get(pid) ?? startFolder
  const absolute = (pid: number, base: string | null, path: string): string => normalize(isAbsolute(path) ? path : join(base ?? folderOf(pid), path))

  for (const raw of readFileSync(traceFile, 'utf8').split('\n')) {
    if (raw === '') continue
    const head = /^(\d+)\s+(.*)$/.exec(raw)
    if (!head) {
      out.unparsed.push(raw)
      continue
    }
    const pid = Number(head[1])
    let line = head[2] as string
    if (/^(\+\+\+|---) /.test(line)) continue
    const unfinished = /^(.*) <unfinished \.\.\.>$/.exec(line)
    if (unfinished) {
      pending.set(pid, unfinished[1] as string)
      continue
    }
    const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(line)
    if (resumed) {
      line = `${pending.get(pid) ?? `${resumed[1]}(`}${resumed[2]}`
      pending.delete(pid)
    }
    const call = /^(\w+)\((.*)\)\s+=\s+(-?\d+|\?)(.*)$/.exec(line)
    if (!call) {
      out.unparsed.push(raw)
      continue
    }
    const [, name = '', args = '', result = '', tail = ''] = call
    const failed = result.startsWith('-') || result === '?'

    if (name === 'clone' || name === 'clone3' || name === 'fork' || name === 'vfork') {
      if (!failed) cwd.set(Number(result), folderOf(pid))
      continue
    }
    if (name === 'chdir') {
      if (!failed) cwd.set(pid, absolute(pid, null, quoted(args)[0]?.value ?? '.'))
      continue
    }
    if (name === 'fchdir') {
      const to = /<([^>]*)>/.exec(args)
      if (!failed && to) cwd.set(pid, to[1] as string)
      continue
    }
    if (name === 'execve' || name === 'execveat') {
      const strings = quoted(args)
      const lists = [...args.matchAll(/\[((?:"(?:[^"\\]|\\.)*"(?:, )?)*)\]/g)].map((match) => quoted(match[1] as string).map((item) => item.value))
      out.programs.push({ pid, path: strings[0]?.value ?? '', argv: lists[0] ?? [], env: lists[1] ?? [], failed })
      continue
    }
    if (name === 'connect') {
      out.connections.push(line)
      continue
    }
    if (NETWORK.includes(name)) {
      out.sockets.push(line)
      continue
    }

    const write = CHANGES.has(name) || name === 'creat' || (OPENS.has(name) && /\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND)\b|O_TMPFILE/.test(args))
    if (!write) continue
    // Every path the call names: each string resolved against the folder given before it, and every open file it names.
    const paths: string[] = []
    let cursor = 0
    for (const item of quoted(args)) {
      const before = args.slice(cursor, item.end)
      const folder = [...before.matchAll(/(?:AT_FDCWD|\d+)<([^>]*)>/g)].pop()
      paths.push(absolute(pid, folder ? (folder[1] as string) : null, item.value))
      cursor = item.end + 1
    }
    for (const match of args.matchAll(/\d+<([^>]*)>/g)) if (isAbsolute(match[1] as string)) paths.push(normalize(match[1] as string))
    const opened = /<([^>]*)>/.exec(tail)
    if (opened && isAbsolute(opened[1] as string)) paths.push(normalize(opened[1] as string))
    out.writes.push({ pid, call: name, paths: [...new Set(paths)], failed, line })
  }
  return out
}
