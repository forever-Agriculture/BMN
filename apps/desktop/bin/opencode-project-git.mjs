// MODULE: opencode-project-git.mjs - Project-scoped history in a private read-only Git namespace
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const refused = () => { throw new Error('BMN read-only project boundary refused this operation') }
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const descriptor = fd => `/proc/${process.pid}/fd/${fd}`
const guard = fileURLToPath(new URL('./ask-git.sh', import.meta.url))
const text = path => {
  const fd = openSync(path, flags)
  try {
    if (!fstatSync(fd).isFile()) refused()
    const bytes = Buffer.alloc(4097), length = readSync(fd, bytes, 0, bytes.length, 0)
    if (length > 4096 || bytes.subarray(0, length).includes(0)) refused()
    return bytes.subarray(0, length).toString('utf8').trim()
  } finally { closeSync(fd) }
}
const inside = path => {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0')) refused()
  const normalized = relative('/project', resolve('/project', path))
  if (normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized)) refused()
  return normalized || '.'
}

/** Only the chosen worktree and its explicit Git metadata are mounted; local configuration is masked. */
export function projectGit(root, rootFd, argv) {
  const opened = []
  try {
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || argv.some(a => typeof a !== 'string' || a.length > 4096 || /[<>|;$`\n\r\0]/u.test(a))) refused()
    execFileSync('/bin/sh', [guard, ...argv], { env: { PATH: '/usr/bin:/bin', BMN_ASK_GIT_VALIDATE_ONLY: '1' }, timeout: 1000, stdio: 'ignore' })
    const [command, ...args] = argv
    if (!['log', 'show', 'diff', 'blame'].includes(command)) refused()
    let repository = root
    while (!existsSync(join(repository, '.git'))) {
      const parent = dirname(repository)
      if (parent === repository) refused()
      repository = parent
    }
    const marker = join(repository, '.git'), stat = lstatSync(marker)
    if (stat.isSymbolicLink()) refused()
    let metadata = marker, worktree = ''
    if (stat.isFile()) {
      const value = /^gitdir: (.+)$/u.exec(text(marker))
      if (!value) refused()
      const target = realpathSync(resolve(repository, value[1]))
      metadata = realpathSync(resolve(target, text(join(target, 'commondir'))))
      worktree = relative(metadata, target)
      if (!/^worktrees\/[^/]+$/u.test(worktree) || resolve(target, text(join(target, 'gitdir'))) !== marker) refused()
    } else if (!stat.isDirectory()) refused()
    const metadataFd = openSync(metadata, flags | constants.O_DIRECTORY); opened.push(metadataFd)
    if (readlinkSync(descriptor(metadataFd)) !== metadata) refused()
    const prefix = relative(repository, root), destination = join('/bmn/worktree', prefix), gitdir = join('/bmn/repo', worktree)
    if (prefix.startsWith('..') || isAbsolute(prefix)) refused()
    const mounts = ['--unshare-all', '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
    for (const path of ['/usr', '/bin', '/lib', '/lib64']) if (existsSync(path)) mounts.push('--ro-bind', path, path)
    mounts.push('--dir', '/bmn/worktree', '--ro-bind-fd', '3', destination, '--ro-bind-fd', '4', '/bmn/repo')
    const emptyFd = openSync('/dev/null', constants.O_RDONLY); opened.push(emptyFd)
    // A regular empty config disables includes, filters, alternate worktrees and worktree config.
    // These masks are unconditional: a concurrent creation cannot expose local configuration.
    mounts.push('--perms', '0444', '--ro-bind-data', '5', '/bmn/repo/config',
      '--tmpfs', '/bmn/repo/objects/info', '--remount-ro', '/bmn/repo/objects/info')
    mounts.push('--chdir', destination, '--')
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent', GIT_DIR: gitdir, GIT_WORK_TREE: '/bmn/worktree',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
    const run = (program, values, input) => execFileSync('/usr/bin/bwrap', [...mounts, program, ...values], {
      env, input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', rootFd, metadataFd, emptyFd]
    })
    const revisions = [], before = [], paths = []
    let after = false, value = false
    for (const [index, argument] of args.entries()) {
      if (after) { paths.push(command === 'blame' ? inside(argument) : `:(literal)${inside(argument)}`); continue }
      if (argument === '--') { after = true; continue }
      if (value) { before.push(argument); value = false; continue }
      if (argument.startsWith('-')) {
        // -L can name a repository-relative file independently of the final pathspec.
        if (argument.startsWith('-L') || ['--all', '--follow', '--merge-base', '--submodule=log'].includes(argument)) refused()
        value = ['-n', '-U', '-G', '-S'].includes(argument)
        before.push(argument); continue
      }
      if (command === 'blame' && index === args.length - 1) { paths.push(inside(argument)); continue }
      const colon = argument.indexOf(':')
      if (colon >= 0) {
        if (command !== 'show') refused()
        const revision = argument.slice(0, colon), path = inside(argument.slice(colon + 1))
        revisions.push(revision); before.push({ refs: [revision], path: join(prefix, path).replaceAll(sep, '/') })
      } else {
        const range = argument.split(/\.\.\.?/u).map(part => part || 'HEAD')
        revisions.push(...range); before.push({ refs: range, separator: argument.match(/\.\.\.?/u)?.[0] ?? '' })
      }
    }
    if (value) refused()
    if (revisions.length === 0 && (['log', 'show', 'blame'].includes(command) || args.some(arg => ['--cached', '--staged'].includes(arg)))) {
      revisions.push('HEAD'); before.push({ refs: ['HEAD'], separator: '' })
    }
    if (revisions.some(revision => !/^[a-zA-Z0-9_@/+.~^{}-]+$/u.test(revision) || revision.startsWith('-'))) refused()
    const commits = new Map()
    if (revisions.length) {
      const result = run('/usr/bin/git', ['cat-file', '--batch-check'], revisions.map(revision => `${revision}^{commit}`).join('\n') + '\n').trim().split('\n')
      if (result.length !== revisions.length || result.some(line => !/^[a-f0-9]{40,64} commit [0-9]+$/u.test(line))) refused()
      for (const [index, revision] of revisions.entries()) commits.set(revision, result[index].split(' ')[0] + '^{commit}')
    }
    const selected = before.map(argument => typeof argument === 'string' ? argument : argument.path !== undefined
      ? `${commits.get(argument.refs[0])}:${argument.path}` : argument.refs.map(ref => commits.get(ref)).join(argument.separator))
    const result = run('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'log.showSignature=false', '-c', 'gpg.program=/bin/false',
      '--no-pager', command, '--no-ext-diff', '--no-textconv', ...selected, '--', ...(paths.length ? paths : ['.'])])
    if (readlinkSync(descriptor(rootFd)) !== root || readlinkSync(descriptor(metadataFd)) !== metadata) refused()
    return result
  } catch { return refused() } finally { for (const fd of opened.reverse()) closeSync(fd) }
}
