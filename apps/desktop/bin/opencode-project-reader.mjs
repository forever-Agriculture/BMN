// MODULE: opencode-project-reader.mjs - Descriptor-confined project reads and guarded history for OpenCode asks
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path'
import { projectGit } from './opencode-project-git.mjs'

const refusal = () => { throw Object.assign(new Error('BMN read-only project boundary refused this operation'), { code: 'BMN_READ_ONLY' }) }
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** Every component is opened relative to a retained directory descriptor, never through a checked symlink. */
export function openProjectReader(project) {
  const root = realpathSync(project), rootFd = openSync(root, flags | constants.O_DIRECTORY)
  let closed = false
  const descriptor = fd => `/proc/${process.pid}/fd/${fd}`
  const check = fd => {
    if (closed || readlinkSync(descriptor(rootFd)) !== root) refusal()
    const actual = readlinkSync(descriptor(fd))
    if (actual !== root && !actual.startsWith(root + sep) || actual.endsWith(' (deleted)')) refusal()
  }
  const parts = path => {
    if (typeof path !== 'string' || path.length > 4096 || path.includes('\0')) refusal()
    const child = relative(root, resolve(root, path))
    if (isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) refusal()
    return child ? child.split(sep) : []
  }
  const entry = (path, directory, use) => {
    const opened = []
    let pending = false
    const release = () => { for (const fd of opened.reverse()) closeSync(fd) }
    try {
      let fd = rootFd
      const names = parts(path)
      check(fd)
      for (const [index, name] of names.entries()) {
        fd = openSync(join(descriptor(fd), name), flags | (directory || index < names.length - 1 ? constants.O_DIRECTORY : 0))
        opened.push(fd); check(fd)
      }
      const stat = fstatSync(fd)
      if (directory ? !stat.isDirectory() : !stat.isFile()) refusal()
      const value = use(fd, stat)
      if (value && typeof value.then === 'function') {
        pending = true
        return Promise.resolve(value).then(result => { check(fd); return result }).catch(() => refusal()).finally(release)
      }
      check(fd)
      return value
    } catch { return refusal() } finally { if (!pending) release() }
  }
  const text = (fd, stat) => {
    if (stat.size > 1024 * 1024) refusal()
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    let length = 0, count
    do {
      count = readSync(fd, bytes, length, bytes.length - length, length)
      length += count
      if (length > 1024 * 1024) refusal()
    } while (count > 0)
    const body = bytes.subarray(0, length)
    if (body.includes(0)) refusal()
    return body.toString('utf8')
  }
  const walk = (path, visit, { signal } = {}) => {
    const end = performance.now() + 5000
    const remaining = () => {
      const value = end - performance.now()
      if (signal?.aborted || value <= 0) refusal()
      return Math.max(1, Math.floor(value))
    }
    return entry(path, true, async start => {
      let count = 0
      const scan = async (fd, name, depth) => {
        remaining(); check(fd)
        if (depth > 32) refusal()
        const names = readdirSync(descriptor(fd), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        for (const item of names) {
          remaining()
          if (++count > 10000) refusal()
          if (item.isSymbolicLink() || item.name === '.git' || item.name === 'node_modules') continue
          const child = join(name, item.name)
          let next
          try {
            next = openSync(join(descriptor(fd), item.name), flags | (item.isDirectory() ? constants.O_DIRECTORY : 0))
            check(next)
            const stat = fstatSync(next)
            if (stat.isDirectory()) await scan(next, child, depth + 1)
            else if (stat.isFile()) await visit(child.replaceAll(sep, '/'), next, stat, remaining)
            remaining(); check(next)
          } finally { if (next !== undefined) closeSync(next) }
          await new Promise(resolve => setImmediate(resolve))
        }
        remaining()
      }
      await scan(start, path === '.' ? '' : path, 0)
    })
  }

  return {
    root,
    read(path, { offset = 0, limit = 2000 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) refusal()
      return entry(path, false, (fd, stat) => text(fd, stat).split('\n').slice(offset, offset + limit).join('\n')).slice(0, 128 * 1024)
    },
    async glob(pattern, path = '.', options = {}) {
      if (typeof pattern !== 'string' || pattern.length > 200 || isAbsolute(pattern) || pattern.split('/').includes('..')) refusal()
      const found = []
      await walk(path, name => { if (matchesGlob(name, pattern) && found.length < 200) found.push(name) }, options)
      return found
    },
    async grep(pattern, path = '.', include = '**/*', { signal } = {}) {
      if (typeof pattern !== 'string' || pattern.length > 500 || typeof include !== 'string' || include.length > 200) refusal()
      const found = []
      let bytes = 0
      await walk(path, async (name, fd, stat, remaining) => {
        if (!matchesGlob(name, include) || stat.size > 1024 * 1024 || found.length >= 100) return
        bytes += stat.size
        if (bytes > 8 * 1024 * 1024) refusal()
        const body = text(fd, stat)
        remaining()
        const result = await new Promise((resolve, reject) => {
          let outcome = null
          const child = execFile('/usr/bin/grep', ['-nE', '-m', '20', '--', pattern], {
            encoding: 'utf8', timeout: Math.min(1000, remaining()), killSignal: 'SIGKILL', signal,
            maxBuffer: 128 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }
          }, (error, stdout) => { outcome = { error, stdout } })
          // Abort can report an error before the process exits. Retain descriptors until actual closure.
          child.once('close', () => outcome?.error && outcome.error.code !== 1 ? reject(outcome.error) :
            outcome === null ? reject(new Error('grep did not settle')) : resolve(outcome.error ? null : outcome.stdout))
          child.stdin.on('error', () => {})
          child.stdin.end(body)
        })
        remaining()
        if (result !== null) found.push({ path: name, matches: result.trimEnd() })
      }, { signal })
      return found
    },
    git(argv) {
      check(rootFd)
      const result = projectGit(root, rootFd, argv)
      check(rootFd)
      return result
    },
    close() { if (!closed) { closed = true; closeSync(rootFd) } }
  }
}

/** Admission happens before awaiting child creation, so simultaneous and repeated requests share one slot. */
export function singleReaderChild(directory = null) {
  const admitted = new Set()
  if (directory !== null) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return (rootSession, isChild = false) => {
    if (typeof rootSession !== 'string' || !rootSession || isChild || admitted.has(rootSession)) refusal()
    admitted.add(rootSession)
    if (directory !== null) {
      const name = createHash('sha256').update(rootSession).digest('hex')
      try { closeSync(openSync(join(directory, name), 'wx', 0o600)) } catch { refusal() }
    }
  }
}
