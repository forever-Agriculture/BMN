import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { windowsExitObserver } from '../lib/windows-exit-observer.mjs'

// Each subject is created here and keeps stdin open until this test releases it.
async function subject() {
  const script = `$ErrorActionPreference='Stop';
Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));
$process=[Diagnostics.Process]::GetCurrentProcess();
$created=($process.StartTime.ToUniversalTime()-[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalMilliseconds;
[Console]::Out.WriteLine((@{pid=$PID;creationTime=$created}|ConvertTo-Json -Compress));
$null=[Console]::In.ReadLine();`
  const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let errors = '', text = ''
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-2048) })
  child.stdin.on('error', () => {})
  const closed = new Promise(resolve => child.once('close', resolve))
  const identity = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic process readiness timeout')), 20000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', () => { clearTimeout(timer); reject(new Error(`Synthetic process ended before identity: ${errors}`)) })
    child.stdout.on('data', bytes => {
      text += bytes
      if (!text.includes('\n')) return
      clearTimeout(timer)
      try { resolve(JSON.parse(text.split(/\r?\n/u)[0])) } catch (error) { reject(error) }
    })
  })
  let releasePromise
  const release = () => releasePromise ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end('exit\n')
    const killTimer = setTimeout(() => child.kill(), 5000)
    let closeTimer
    const bounded = new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Synthetic process close is unconfirmed')), 10000) })
    try { await Promise.race([closed, bounded]) } finally { clearTimeout(killTimer); clearTimeout(closeTimer) }
  })()
  try {
    const entry = await identity
    expect(entry.pid).toBe(child.pid)
    expect(Number.isFinite(entry.creationTime)).toBe(true)
    return { entry, release }
  } catch (error) { await release(); throw error }
}

describe.runIf(process.platform === 'win32')('native retained observer identity', () => {
  it('retains the owned identity with diagnostics and observes its actual exit', async () => {
    const fixture = await subject()
    let observer
    try {
      observer = await windowsExitObserver([fixture.entry], -1, [], { overallWaitMs: 15000, diagnostic: true })
      expect(observer.diagnostic.stages.filter(stage => stage.stage === 'start-time')).toHaveLength(1)
      expect(observer.diagnostic.stages.filter(stage => stage.stage === 'identity')).toHaveLength(1)
      const receipt = observer.finish()
      await fixture.release()
      expect(await receipt).toEqual({ passed: true, retainedHandles: 1 })
    } finally { await fixture.release(); if (observer) await observer.abort() }
  }, 60000)

  it('refuses a deliberately mismatched creation identity before READY', async () => {
    const fixture = await subject()
    let observer
    try {
      const waiting = windowsExitObserver([{ ...fixture.entry, creationTime: fixture.entry.creationTime + 10000 }],
        -1, [], { overallWaitMs: 15000, diagnostic: true }).then(value => { observer = value; return value })
      await expect(waiting).rejects.toMatchObject({ observerDiagnostic: { class: 'closed-before-ready', stage: 'identity' } })
    } finally { await fixture.release(); if (observer) await observer.abort() }
  }, 60000)
})
