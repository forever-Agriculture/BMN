// MODULE: shared-helpers.mjs - the small helpers several bin modules use, each defined once (Story 80.15); it imports only Node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'

/** A plain object: not null and not an array. */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Whether every key of `value` is one of `keys`. */
export const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key))

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** JSON with keys sorted at every level: shared hash bytes, without importing owner state. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The JSON in a file; it throws when the file cannot be read or parsed. */
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** The JSON in a file, or null when it cannot be read or parsed. */
export const readJsonOrNull = (path) => {
  try {
    return readJson(path)
  } catch {
    return null
  }
}

/** Waits `ms` milliseconds. */
export const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** A list of names in a sentence: "a, b and c". */
export function listed(names) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** A whole number with its thousands set apart by a space ("400 000"). The renderer keeps a mirror in roster-staging.ts: it cannot load bin modules. */
export function thousands(value) {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ' ')
}

/** A routing decision as one comparable word: provider/basis/kind, or "none". */
export function canonicalRoute(decision) {
  return decision.route === null ? 'none' : `${decision.route.provider}/${decision.route.basis}/${decision.kind}`
}

/** The home folder `environment` names, else this user's. */
export function home(environment) {
  return environment.HOME || homedir()
}

/** The real path of `path`, or null when it does not resolve. */
export function realOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** A folder as it is written and, when a link leads elsewhere, as it really is: an app may read its settings under either. */
export function spellings(folder) {
  try {
    const real = realpathSync(folder)
    return real === folder ? [folder] : [folder, real]
  } catch {
    return [folder]
  }
}

/** Makes a folder, with its parents, and holds it to its owner (0700) even where it already was. */
export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

/** Whether `path` is `root` or lies inside it. */
export function insideDirectory(root, path) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

/**
 * What a native Bash result says about its exit: `ok`, `failed`, or `unknown` when it names no exit code (Claude Code's
 * result has none; Codex gives an object or a JSON string with the code in it). Unknown is never called a pass.
 */
export function bashExit(response) {
  let result = response
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return 'unknown' }
  }
  if (!isObject(result)) return 'unknown'
  const code = [result.exit_code, result.exitCode, result.metadata?.exit_code, result.metadata?.exitCode].find(value => typeof value === 'number')
  return code === undefined ? 'unknown' : code === 0 ? 'ok' : 'failed'
}

const LISTENER_IS_ANCESTOR = `import os, socket, struct, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(0.5)
s.connect(sys.argv[1])
pid, uid, _ = struct.unpack('3i', s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
s.close()
if uid != os.getuid() or pid <= 1:
    sys.exit(1)
at = os.getppid()
for _ in range(32):
    if at == pid:
        sys.exit(0)
    if at <= 1:
        break
    with open(f'/proc/{at}/stat') as status:
        at = int(status.read().rsplit(')', 1)[1].split()[1])
sys.exit(1)
`

/**
 * Whether the process listening on the control socket is an ancestor of this hook, as the kernel reports both: BMN starts
 * every session's terminal, so its own socket always is, and a socket some other process opened never is. The path comes
 * from the environment; this is what keeps a substituted one from lifting a hold. Linux only; anything unconfirmed is false.
 */
export function launchedByListener(socketPath) {
  if (process.platform !== 'linux') return false
  try {
    return spawnSync('/usr/bin/python3', ['-I', '-S', '-c', LISTENER_IS_ANCESTOR, socketPath], { stdio: 'ignore', timeout: 1500 }).status === 0
  } catch {
    return false
  }
}
