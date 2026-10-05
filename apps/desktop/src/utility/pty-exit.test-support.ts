// A real fixture must confirm process exit/output drain before removing its cwd.
import type { IPty } from 'node-pty'

export function armFixturePtyExit(pty: IPty) {
  const began = performance.now()
  const stages: { stage: string; elapsedMs: number }[] = []
  const mark = (stage: string) => stages.push({ stage, elapsedMs: Math.round(performance.now() - began) })
  let exit: { exitCode: number; signal: number | null } | null = null
  let lifecycleErrors = 0, killErrors = 0
  let resolveExit!: () => void
  const exited = new Promise<void>(resolve => { resolveExit = resolve })
  // Register before readiness, service replacement or any other awaited setup.
  const exitSubscription = pty.onExit(event => {
    exit = { exitCode: event.exitCode, signal: event.signal ?? null }
    mark('exit-observed'); resolveExit()
  })
  const lifecycleSubscription = pty.onLifecycleError?.(() => { lifecycleErrors++; mark('lifecycle-error') })
  mark('armed')
  return {
    hasExited: () => exit !== null,
    snapshot: () => ({ pid: pty.pid, startIdentity: pty.processStartIdentity ?? null, exit, lifecycleErrors, killErrors, stages: [...stages] }),
    stop: async (deadlineMs = 8000) => {
      mark('stop:begin')
      if (exit === null) {
        try { pty.kill(); mark('kill-requested') } catch { killErrors++; mark('kill-error') }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { mark('exit-timeout'); reject(new Error('Owned fixture PTY exit was not confirmed')) }, deadlineMs)
        })])
      } finally { if (timer !== undefined) clearTimeout(timer) }
      if (lifecycleErrors > 0 || killErrors > 0) throw new Error('Owned fixture PTY cleanup reported lifecycle errors')
      mark('stop:confirmed')
    },
    dispose: () => { exitSubscription.dispose(); lifecycleSubscription?.dispose() }
  }
}
