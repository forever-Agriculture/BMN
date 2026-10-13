// MODULE: turn-changes-git.ts - the only Git processes turn changes may start: one fixed program, a cleared environment and a fixed list of read-only commands (R69-NFR2)
//
// Git is asked three things in the owner's repository and nothing else: whether it accepts the
// repository and which work tree it names, which commit HEAD names, and which paths belong. No command
// here reads a file's contents or writes, so no filter, fsmonitor, hook, external diff or textconv
// program can be reached. `turn-changes-git.test.ts` holds this list and fails when it changes;
// `docs/turn-changes.md` shows it to the owner.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** The first of these that exists; never looked up on PATH. */
export const TURN_GIT_CANDIDATES: readonly string[] = Object.freeze(['/usr/bin/git', '/usr/local/bin/git', '/bin/git'])

export function turnGitExecutable(): string | null {
  for (const path of TURN_GIT_CANDIDATES) if (existsSync(path)) return path
  return null
}

/**
 * Everything a Git process of this feature is given. HOME stays, so that the owner's own ignore file
 * and his own `safe.directory` list count as they do in his terminal; whatever a settings file names
 * that could start a program or write is switched off on the command line below, which outranks
 * every settings file, an included one too.
 */
export function turnGitEnvironment(home: string): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE2: '0',
    GIT_TRACE2_EVENT: '0',
    GIT_TRACE2_PERF: '0'
  }
}

/** Options before the command, the same for every command. */
export const TURN_GIT_OPTIONS: readonly string[] = Object.freeze([
  '--no-pager', '--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false',
  '-c', 'core.pager=cat', '-c', 'core.sshCommand=false', '-c', 'credential.helper='
])

/**
 * The whole list. `identity` runs once in the root before anything is read and also names HEAD at
 * the scan's start (a repository with no commit yet answers the five facts and then fails on HEAD);
 * `list` says what belongs; `head` names HEAD again at the scan's end; `nested` runs in a submodule or
 * nested repository, which may not look above its own folder.
 */
export const TURN_GIT_COMMANDS = Object.freeze({
  identity: Object.freeze(['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir', '--show-object-format', 'HEAD^{commit}']),
  list: Object.freeze(['ls-files', '-z', '-t', '--stage', '--cached', '--others', '--exclude-standard']),
  head: Object.freeze(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
  nested: Object.freeze(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
} satisfies Record<string, readonly string[]>)

export type TurnGitCommand = keyof typeof TURN_GIT_COMMANDS

/** One Git process as it was started, for the test that pins the list. */
export interface TurnGitCall {
  executable: string
  command: TurnGitCommand
  folder: string
  argv: string[]
  env: Record<string, string>
}

export interface TurnGitContext {
  git: string
  home: string
  signal?: AbortSignal | undefined
  observe?: ((call: TurnGitCall) => void) | undefined
}

export interface TurnGitResult {
  code: number | null
  stdout: string
  stderr: string
  /** The process was killed: cancelled, out of time, or its reader asked for no more. */
  stopped: boolean
}

/** Answers of the commands that are not streamed are a few lines; more than this is not an answer. */
const ANSWER_BYTES = 64 * 1024

/**
 * Starts one command of the list in `folder`. `onData` receives the output as it arrives and ends the
 * process by returning false; without it the output is collected.
 */
export function runTurnGit(
  context: TurnGitContext,
  folder: string,
  command: TurnGitCommand,
  onData?: (chunk: Buffer) => boolean
): Promise<TurnGitResult> {
  return new Promise((resolve) => {
    const argv = [...TURN_GIT_OPTIONS, '-C', folder, ...TURN_GIT_COMMANDS[command]]
    const env = turnGitEnvironment(context.home)
    if (command === 'nested') env.GIT_CEILING_DIRECTORIES = dirname(folder)
    context.observe?.({ executable: context.git, command, folder, argv, env })
    const child = spawn(context.git, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let collected = 0
    let err = ''
    let stopped = false
    const stop = (): void => {
      stopped = true
      child.kill('SIGKILL')
    }
    const signal = context.signal
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      if (onData) {
        if (!onData(chunk)) stop()
        return
      }
      collected += chunk.length
      if (collected > ANSWER_BYTES) stop()
      else out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString('utf8')
    })
    child.on('error', () => {
      signal?.removeEventListener('abort', stop)
      resolve({ code: null, stdout: '', stderr: '', stopped })
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err, stopped })
    })
  })
}
