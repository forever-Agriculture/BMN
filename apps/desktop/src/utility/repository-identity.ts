import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { RepositoryIdentity } from '@bmn/protocol'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 2_000
const GIT_OUTPUT_LIMIT = 8 * 1024
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

interface InspectionOptions {
  gitExecutable?: string
  timeoutMs?: number
  now?: () => Date
}

function nonemptyLine(value: string): string | undefined {
  const line = value.trim()
  return line && !/[\r\n\0]/u.test(line) ? line : undefined
}

function unavailable(directory: string, observedAt: string, reason: string): RepositoryIdentity {
  return { state: 'unavailable', directory, observedAt, reason }
}

type GitReadError = Error & {
  code?: string | number
  killed?: boolean
  signal?: string
  stdout?: string
  stderr?: string
}

function expectedMissingRef(error: unknown): boolean {
  const failure = error as GitReadError
  return failure.code === 1 && !failure.killed && !failure.signal &&
    !failure.stdout?.trim() && !failure.stderr?.trim()
}

function readFailureReason(error: unknown, fallback: string): string {
  const failure = error as GitReadError
  if (failure.code === 'ENOENT') return 'Git is not installed'
  if (failure.killed || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT') {
    return 'Git inspection timed out'
  }
  return fallback
}

/** Read the Git identity of a selected launch directory; never changes the repository or a PTY. */
export async function inspectRepositoryIdentity(
  directory: string,
  options: InspectionOptions = {}
): Promise<RepositoryIdentity> {
  const observedAt = (): string => (options.now ?? (() => new Date()))().toISOString()
  if (!isAbsolute(directory) || directory.includes('\0')) {
    return unavailable(directory, observedAt(), 'The selected directory is not an absolute path')
  }
  try {
    if (!(await stat(directory)).isDirectory()) {
      return unavailable(directory, observedAt(), 'The selected directory is not accessible')
    }
  } catch {
    return unavailable(directory, observedAt(), 'The selected directory is not accessible')
  }

  const executable = options.gitExecutable ?? 'git'
  const run = async (arguments_: string[]): Promise<string> => {
    const result = await execFileAsync(executable, ['-C', directory, ...arguments_], {
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true,
      encoding: 'utf8',
      // An inherited GIT_DIR or worktree override would report another repository. Keep only
      // ordinary executable/config discovery, force stable diagnostics and prevent optional locks.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        LC_ALL: 'C',
        GIT_OPTIONAL_LOCKS: '0'
      }
    })
    return result.stdout
  }

  let location: string
  try {
    location = await run([
      'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--path-format=absolute',
      '--git-dir', '--git-common-dir'
    ])
  } catch (error) {
    const failure = error as GitReadError
    if (failure.code === 'ENOENT') {
      return unavailable(directory, observedAt(), 'Git is not installed')
    }
    if (readFailureReason(error, '') === 'Git inspection timed out')
      return unavailable(directory, observedAt(), 'Git inspection timed out')
    if (typeof failure.stderr === 'string' && /not a git repository/u.test(failure.stderr)) {
      return { state: 'not-repository', directory, observedAt: observedAt() }
    }
    return unavailable(directory, observedAt(), 'Git inspection failed')
  }
  const lines = location.trimEnd().split('\n')
  if (lines.length !== 4 || lines[0] !== 'true') {
    return unavailable(directory, observedAt(), 'Git returned an invalid repository identity')
  }
  const [root, gitDir, commonDir] = lines.slice(1).map(nonemptyLine)
  if (!root || !gitDir || !commonDir || !isAbsolute(root) || !isAbsolute(gitDir) || !isAbsolute(commonDir)) {
    return unavailable(directory, observedAt(), 'Git returned an invalid repository identity')
  }

  let head: Extract<RepositoryIdentity, { state: 'repository' }>['head']
  let branch: string | undefined
  try {
    branch = nonemptyLine(await run(['symbolic-ref', '-q', '--short', 'HEAD']))
    if (!branch) return unavailable(directory, observedAt(), 'Git returned an invalid branch name')
  } catch (error) {
    if (!expectedMissingRef(error)) {
      return unavailable(directory, observedAt(), readFailureReason(error, 'Git could not read HEAD'))
    }
  }
  if (branch) {
    try {
      const validatedBranch = nonemptyLine(await run(['check-ref-format', '--branch', branch]))
      if (validatedBranch !== branch) {
        return unavailable(directory, observedAt(), 'Git returned an invalid branch name')
      }
    } catch (error) {
      return unavailable(directory, observedAt(), readFailureReason(error, 'Git returned an invalid branch name'))
    }
    try {
      const commit = nonemptyLine(await run(['rev-parse', '-q', '--verify', 'HEAD']))
      if (!commit || !GIT_OID.test(commit)) {
        return unavailable(directory, observedAt(), 'Git returned an invalid HEAD')
      }
      head = { state: 'branch', name: branch }
    } catch (error) {
      if (!expectedMissingRef(error)) {
        return unavailable(directory, observedAt(), readFailureReason(error, 'Git could not read HEAD'))
      }
      head = { state: 'unborn', name: branch }
    }
  } else {
    try {
      const commit = nonemptyLine(await run(['rev-parse', '-q', '--verify', 'HEAD']))
      if (!commit || !GIT_OID.test(commit)) {
        return unavailable(directory, observedAt(), 'Git returned an invalid HEAD')
      }
      head = { state: 'detached' }
    } catch (error) {
      return unavailable(directory, observedAt(), readFailureReason(error, 'Git could not read HEAD'))
    }
  }
  return {
    state: 'repository', directory, observedAt: observedAt(), root: resolve(root), head,
    linkedWorktree: resolve(gitDir) !== resolve(commonDir)
  }
}
