// MODULE: agents-container.mjs - Epic 72: the bubblewrap container one teammate's ask runs in: only the run's inputs, its own app home and the app itself are inside, in a PID namespace of its own
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A teammate's ask runs its app inside a container BMN builds for that one run (R72-NFR3). The
 * container is a new mount namespace whose root is empty: the system's programs and libraries
 * (`/usr`) and a few named files of `/etc` read-only, the app's own executable read-only at its own
 * path, the run's inputs read-only, and the run's own app home as the one place the app may write.
 * The owner's home folder, other projects, other runs, BMN's commands, its state and its sockets are
 * not there. It has a PID namespace of its own: when its first process ends, every process in it
 * ends with it, also one that left the process group, and `--die-with-parent` ends it when the
 * supervisor that started it ends. The network is the computer's own: the app talks to its provider,
 * and which of its tools may reach the network is the app's own form, measured per app in 72.1.
 */

export const BWRAP = '/usr/bin/bwrap'
/** Where things are inside the container. */
export const INSIDE = Object.freeze({ root: '/ask', home: '/ask/home', inputs: '/ask/inputs', project: '/ask/project', work: '/ask/work' })

/** The files of /etc a run reads: name lookup, certificates, time zone. Each is bound only where it exists. */
const ETC_FILES = ['/etc/hosts', '/etc/host.conf', '/etc/nsswitch.conf', '/etc/gai.conf', '/etc/localtime', '/etc/mime.types']
const ETC_FOLDERS = ['/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/alternatives']
const SYSTEM_LINKS = [['usr/bin', '/bin'], ['usr/sbin', '/sbin'], ['usr/lib', '/lib'], ['usr/lib64', '/lib64'], ['usr/lib32', '/lib32']]

/**
 * The bwrap command for one run. `spec`:
 * - `app`: the folders or files of the app's executable, launcher and native payload, bound read-only at their own paths;
 * - `home`: the run's own app home on this computer, bound writable at `INSIDE.home`;
 * - `inputs`: the run's read-only inputs folder (prompt, snapshots, pictures), at `INSIDE.inputs`;
 * - `project`: the frozen project copy, read-only at `INSIDE.project`, or null;
 * - `binds`: more `{ from, to, writable }` (a file or folder), each named by the form that needs it;
 * - `environment`: the whole environment of the app, nothing inherited;
 * - `cwd`: the folder the app starts in inside the container;
 * - `passwd`: a file with the one account the run sees, bound at /etc/passwd (and `group` at /etc/group);
 * - `hosts`: a file bound at /etc/hosts instead of the computer's own, or null;
 * - `command`: the app's argv inside the container.
 */
export function containerArgv(spec) {
  const argv = [BWRAP, '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--new-session',
    '--hostname', 'ask', '--ro-bind', '/usr', '/usr']
  for (const [target, link] of SYSTEM_LINKS) if (existsSync(link)) argv.push('--symlink', target, link)
  for (const folder of ETC_FOLDERS) if (existsSync(folder)) argv.push('--ro-bind', folder, folder)
  for (const file of ETC_FILES) if (existsSync(file) && !(file === '/etc/hosts' && spec.hosts)) argv.push('--ro-bind', file, file)
  if (spec.hosts) argv.push('--ro-bind', spec.hosts, '/etc/hosts')
  const resolver = realOrNull('/etc/resolv.conf')
  if (resolver !== null) argv.push('--ro-bind', resolver, '/etc/resolv.conf')
  if (spec.passwd) argv.push('--ro-bind', spec.passwd, '/etc/passwd')
  if (spec.group) argv.push('--ro-bind', spec.group, '/etc/group')
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', INSIDE.root)
  for (const path of spec.app ?? []) argv.push('--ro-bind', path, path)
  argv.push('--bind', spec.home, INSIDE.home)
  if (spec.inputs) argv.push('--ro-bind', spec.inputs, INSIDE.inputs)
  if (spec.project) argv.push('--ro-bind', spec.project, INSIDE.project)
  argv.push('--dir', INSIDE.work)
  for (const bind of spec.binds ?? []) argv.push(bind.writable ? '--bind' : '--ro-bind', bind.from, bind.to)
  argv.push('--clearenv')
  for (const [name, value] of Object.entries(spec.environment ?? {})) argv.push('--setenv', name, value)
  argv.push('--chdir', spec.cwd ?? INSIDE.work, '--', ...spec.command)
  return argv
}

function realOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The folders an app's executable needs inside the container, from the program the owner's PATH
 * names: the launcher, what it links to, and for Codex's npm launcher its whole package (the native
 * payload and its bundled ripgrep). Returns `{ launcher, payload, paths }` or null when the program
 * is not found.
 */
export function appPaths(harness, environment = process.env) {
  const name = harness === 'claude' ? 'claude' : harness === 'opencode' ? 'opencode' : 'codex'
  const launcher = onPath(name, environment.PATH ?? '')
  if (launcher === null) return null
  const real = realOrNull(launcher)
  if (real === null) return null
  if (harness === 'codex' && real.endsWith('/bin/codex.js')) {
    const root = dirname(dirname(real))
    const payload = `${root}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
    if (!existsSync(payload)) return null
    return { launcher, payload, root, paths: [root] }
  }
  return { launcher, payload: real, root: dirname(real), paths: [real] }
}

function onPath(name, path) {
  for (const folder of path.split(':')) {
    if (folder === '') continue
    const candidate = `${folder}/${name}`
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Whether a container starts from this process, as it is restricted now: a sandboxed caller (a Codex
 * lead in its workspace sandbox, a desktop sandbox) may not create one. Returns `{ ok }` or
 * `{ ok: false, reason }` with bwrap's own words.
 */
export function containerStarts({ bwrap = BWRAP, timeoutMs = 10_000 } = {}) {
  if (!existsSync(bwrap)) return { ok: false, reason: `${bwrap} is not installed` }
  const result = spawnSync(bwrap, ['--unshare-user', '--unshare-pid', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'], { encoding: 'utf8', timeout: timeoutMs, env: {} })
  if (result.status === 0) return { ok: true }
  const said = `${result.stderr ?? ''}`.trim().split('\n').pop() || (result.error ? result.error.message : `bwrap ended with code ${result.status}`)
  return { ok: false, reason: said }
}
