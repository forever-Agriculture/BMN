// MODULE: source-update-restart.ts - queued source update identity and an acknowledged, bounded launcher wait
import { spawn } from 'node:child_process'
import { readFileSync, accessSync, constants, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
export interface SourceRestartAuthorization { path: string; id: string; commit(): void; revoke(): void }
export function sourceRestartAuthorization(): SourceRestartAuthorization {
  const id = randomUUID(), path = join(dirname(sourceUpdatePath()), `restart-${id}.authorization`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const save = (state: string): void => {
    const temporary = `${path}.tmp`, value = `${id} ${state}\n`
    const fd = openSync(temporary, 'w', 0o600)
    try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
    if (readFileSync(path, 'utf8') !== value) throw new Error('Restart launcher authorization readback failed')
  }
  save('pending')
  let revoked = false
  return { path, id, commit: () => { if (revoked) throw new Error('Restart cancelled'); save('launch') }, revoke: () => { revoked = true; save('revoked') } }
}
export const monotonicMilliseconds = (): number => Number(process.hrtime.bigint() / 1_000_000n)
export function sourceUpdatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'bmn', 'source-update', 'latest.json')
}
export function waitingSourceBuild(path = sourceUpdatePath()): string | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value.phase === 'waiting-for-exit' && typeof value.commit === 'string' && /^[a-f0-9]{7,64}$/u.test(value.commit) ? value.commit : null
  } catch { return null }
}
export function openedSourceBuild(path = sourceUpdatePath()): string {
  try {
    const status = JSON.parse(readFileSync(path, 'utf8'))
    const result = process.env.BMN_UPDATE_RESTART_RESULT ?? (status.phase === 'failed' ? status.liveBuild ?? 'previous' : 'complete')
    if (result === 'previous') return 'Update failed · previous build opened'
    if (result === 'new') return 'Update failed · new build opened'
    if (status.phase === 'complete' && typeof status.commit === 'string') return status.commit
    return 'unknown build'
  } catch { return 'unknown build' }
}
export function sourceUpdateLauncher(testMode: boolean): { path: string; ticks: string } {
  const path = testMode ? process.env.BMN_TEST_RESTART_LAUNCHER : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'bmn', 'launch-bmn')
  if (!path) throw new Error('This test instance has no isolated restart launcher')
  accessSync(path, constants.X_OK)
  if (!readFileSync(path, 'utf8').includes('# BMN update restart v1')) throw new Error('The desktop launcher needs the first installation of the restart update')
  const ticks = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1)!.trim().split(/\s+/u)[19]!
  if (!/^\d+$/u.test(ticks)) throw new Error('BMN could not read its process identity')
  return { path, ticks }
}
export function armSourceUpdateLauncher(testMode: boolean, authorization: SourceRestartAuthorization): Promise<void> {
  return new Promise((resolve, reject) => {
    const { path, ticks } = sourceUpdateLauncher(testMode)
    const child = spawn(path, [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: {
      ...process.env, BMN_RESTART_WAIT_PID: String(process.pid), BMN_RESTART_WAIT_TICKS: ticks, BMN_RESTART_ACK: '1',
      BMN_RESTART_AUTH_PATH: authorization.path, BMN_RESTART_AUTH_ID: authorization.id
    } })
    const pipe = child.stdio[3]!
    let answer = '', settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer); pipe.destroy(); child.unref()
      if (error) reject(error); else resolve()
    }
    const timer = setTimeout(() => finish(new Error('The restart launcher did not acknowledge its wait; no sessions were stopped')), 1000)
    pipe.on('data', (data: Buffer) => { answer += data.toString(); if (answer.includes('READY\n')) finish() })
    child.once('error', finish)
    child.once('exit', () => finish(new Error('The restart launcher exited before acknowledging its wait')))
  })
}
