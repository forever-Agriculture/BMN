// MODULE: session-environment.ts - Epic 60.6/60.7: the environment a BMN session's shell ends up with, so the app looks for agent apps and reads their destinations where the sessions do
import { spawn } from 'node:child_process'
import { basename } from 'node:path'

/**
 * The environment the app inspects agent apps with. `shell`: what an interactive shell, started
 * the way a session starts one, reports. `app`: BMN's own, because the shell could not be asked;
 * `reason` then says why, in words the owner can read.
 */
export interface SessionEnvironment { env: NodeJS.ProcessEnv; source: 'shell' | 'app'; reason?: string }

interface SessionEnvironmentReader {
  /** The last reading; BMN's own environment before the first one. */
  current(): SessionEnvironment
  /** Reads again when the last reading is older than the reader allows; calls made meanwhile share one reading. */
  refresh(): Promise<void>
}

const MARK = '__BMN_SESSION_ENVIRONMENT__'
/** Shells that take `-ic` and read the owner's settings for an interactive start. */
const SHELLS = new Set(['bash', 'zsh'])
/** What the shell sets for itself; it says nothing about a session. */
const SHELL_OWN = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD'])
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_TTL_MS = 15_000
const OUTPUT_LIMIT = 1024 * 1024

/** The shell a session starts when the owner names none, as the launcher picks it. */
export function sessionShell(base: NodeJS.ProcessEnv): string {
  return base.BMN_SHELL ?? base.AITERM_SHELL ?? base.SHELL ?? '/bin/bash'
}

/** The variables between the two marks of the shell's output; null when the marks are not both there. */
export function parseShellEnvironment(output: string): Record<string, string> | null {
  const mark = `${MARK}\0`
  const first = output.indexOf(mark)
  const last = output.lastIndexOf(mark)
  if (first < 0 || last <= first) return null
  const found: Record<string, string> = {}
  for (const entry of output.slice(first + mark.length, last).split('\0')) {
    const at = entry.indexOf('=')
    if (at > 0) found[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return found
}

/**
 * Asks the owner's shell for its environment: started interactively, as a session starts it, so
 * the same settings files run (the ones that put a version manager's folder on PATH, or name a
 * proxy). The shell gets no terminal and no input, its own process group, and a time limit; what
 * it prints around the marks is ignored. Nothing is written anywhere.
 */
export function readSessionEnvironment(base: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<SessionEnvironment> {
  const shell = sessionShell(base)
  const name = basename(shell)
  if (!SHELLS.has(name)) return Promise.resolve({ env: base, source: 'app', reason: `BMN does not know how to ask ${name} for its settings` })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: SessionEnvironment): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const fallback = (reason: string): void => finish({ env: base, source: 'app', reason })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-ic', `printf '%s\\0' ${MARK}; command env -0; printf '%s\\0' ${MARK}`], { env: base, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    } catch {
      fallback(`${name} could not be started`)
      return
    }
    const timer = setTimeout(() => {
      // The whole group: a settings file may have started something that still runs.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      fallback(`${name} did not answer in ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds`)
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const chunks: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= OUTPUT_LIMIT) chunks.push(chunk)
    })
    child.on('error', () => fallback(`${name} could not be started`))
    child.on('close', () => {
      const found = size > OUTPUT_LIMIT ? null : parseShellEnvironment(Buffer.concat(chunks).toString('utf8'))
      if (found === null || found.PATH === undefined) {
        fallback(`${name} did not report its settings`)
        return
      }
      const env: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(found)) if (!SHELL_OWN.has(key)) env[key] = value
      finish({ env, source: 'shell' })
    })
  })
}

/**
 * Keeps the last reading and reads again when it is older than `ttlMs`, so a burst of calls asks
 * the shell once. `base` is read anew each time: it is BMN's own environment at that moment.
 */
export function createSessionEnvironmentReader(base: () => NodeJS.ProcessEnv, options: {
  ttlMs?: number
  now?: () => number
  read?: (base: NodeJS.ProcessEnv) => Promise<SessionEnvironment>
} = {}): SessionEnvironmentReader {
  const now = options.now ?? Date.now
  const read = options.read ?? ((environment: NodeJS.ProcessEnv) => readSessionEnvironment(environment))
  let last: { at: number; value: SessionEnvironment } | null = null
  let reading: Promise<void> | null = null
  return {
    current: () => last?.value ?? { env: base(), source: 'app', reason: 'the shell was not asked yet' },
    refresh: () => {
      if (last !== null && now() - last.at < (options.ttlMs ?? DEFAULT_TTL_MS)) return Promise.resolve()
      reading ??= read(base()).then((value) => {
        last = { at: now(), value }
      }).finally(() => {
        reading = null
      })
      return reading
    }
  }
}
