// MODULE: setup-process.ts - Bounded in-memory probe output with owned process-group cleanup
import { spawn } from 'node:child_process'

export interface SetupProcessResult {
  code: number | null
  output: string
  failure: 'timeout' | 'overflow' | 'unavailable' | null
}

/** No output or error object is logged. Only the canonical parser's result may leave setup. */
export function runSetupProcess(command: string, argv: readonly string[], options: {
  env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number
}): Promise<SetupProcessResult> {
  return new Promise(resolve => {
    const child = spawn(command, [...argv], { env: options.env, cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let chunks: Buffer[] = [], bytes = 0, settled = false
    let failure: SetupProcessResult['failure'] = null
    const kill = (): void => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* Already ended. */ } }
    const timer = setTimeout(() => { failure = 'timeout'; chunks = []; kill() }, options.timeoutMs ?? 10_000)
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > 64 * 1024) { failure = 'overflow'; chunks = []; kill() }
      else if (failure === null) chunks.push(chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      kill()
      resolve({ code, failure, output: failure === null ? Buffer.concat(chunks).toString('utf8') : '' })
      chunks = []
    }
    child.on('error', () => { failure = 'unavailable'; finish(null) })
    child.on('close', finish)
  })
}
