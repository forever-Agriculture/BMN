// Diagnostic only; ordinary acceptance follows only after confirmed custody and profile cleanup.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsInstallerSmokeEnvironment } from '../lib/windows-installed-worker.mjs'
import { windowsExitObserver } from '../lib/windows-exit-observer.mjs'
import { diagnosticCustodyEntries, scrolledExperimentPartial } from '../lib/scrolled-diagnostic-result.mjs'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

export async function recordScrolledPrefixes(binary, budgetMs = 600_000) {
  const began = Date.now()
  let budgetExhausted = false
  const record = { diagnosticOnly: true, experiment: 'scrolled-cmdlet-discovery', startedAtMs: began, budgetMs, arms: [], partial: false }
  mkdirSync('test-results', { recursive: true })
  const save = () => {
    const path = 'test-results/windows-scrolled-prefix.json', temporary = path + '.tmp'
    const text = JSON.stringify(record, null, 2)
    writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, path)
    if (readFileSync(path, 'utf8') !== text) throw new Error('Diagnostic receipt readback failed')
  }
  const custodyFailure = () => {
    record.partial = true
    try { save() } catch { record.receiptWriteError = 'secondary' }
    throw Object.assign(new Error('Diagnostic custody is unconfirmed; profile retained; further arms and acceptance stopped'),
      { code: 'DIAGNOSTIC_CUSTODY_UNCONFIRMED' })
  }
  save()
  for (const [index, arm] of ['control', 'split', 'static', 'control', 'split', 'static'].entries()) {
    const left = budgetMs - (Date.now() - began)
    if (left <= 5_000) { budgetExhausted = true; break }
    const temporary = mkdtempSync(join(tmpdir(), 'bmn-scrolled-prefix-'))
    const profile = join(temporary, 'profile'), startedAtMs = Date.now()
    const row = { index, arm, startedAtMs, jobRelativeStartMs: startedAtMs - began,
      receiptCount: 0, observationCount: 0, custody: 'unconfirmed', exitObserved: false, closeObserved: false }
    record.arms.push(row); save()
    let child, observerPromise, observer, readyCount = 0, preserveProfile = false, receiptWriteFailure
    try {
      ensurePrivateDirectories([profile])
      child = spawn(binary, ['--self-test', `--scrolled-diagnostic=${arm}`],
        { env: windowsInstallerSmokeEnvironment(profile), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = '', stderr = '', lines = ''
      child.stdin.on('error', () => {})
      child.on('exit', () => { row.exitObserved = true; row.appExitedAtMs = Date.now() })
      child.on('close', () => { row.closeObserved = true; row.appClosedAtMs = Date.now() })
      child.stdout.on('data', bytes => {
        try {
        const text = bytes.toString('utf8')
        if (stdout.length < 2 * 1024 * 1024) stdout += text
        lines += text
        while (lines.includes('\n')) {
          const end = lines.indexOf('\n'), line = lines.slice(0, end); lines = lines.slice(end + 1)
          if (line.length > 128 * 1024) { row.guardError = 'INCONCLUSIVE: oversized custody line'; child.kill(); continue }
          let ready
          try { ready = JSON.parse(line) } catch { continue }
          if (!ready || typeof ready !== 'object' || Array.isArray(ready) || ready.selfTest !== 'scrolled-diagnostic-custody') continue
          readyCount++
          const entries = diagnosticCustodyEntries(ready, child.pid, arm)
          if (readyCount !== 1 || !entries) { row.guardError = 'INCONCLUSIVE: invalid custody receipt'; child.kill(); continue }
          row.custodyReceipt = ready
          row.custodyReceivedAtMs = Date.now()
          row.acknowledgementBudgetMs = 20_000
          observerPromise = windowsExitObserver(entries, -1, [], { overallWaitMs: 15_000, diagnostic: true }).then(held => {
            observer = held
            row.observerDiagnostic = held.diagnostic
            if (child.exitCode !== null || !child.stdin.writable) throw Object.assign(new Error('Application ended before custody acknowledgement'),
              { observerDiagnostic: { ...held.diagnostic, class: 'app-ended-before-ack' } })
            child.stdin.end('SCROLLED-CUSTODY-READY\n')
            row.acknowledgementWrittenAtMs = Date.now()
            row.custodyArmed = true
            return held
          }).catch(error => {
            row.observerFailure = { ...error.observerDiagnostic, message: error.message.slice(0, 200) }
            row.guardError = 'INCONCLUSIVE: retained observer did not arm'; child.kill(); return undefined
          })
        }
        if (lines.length > 128 * 1024) { row.guardError = 'INCONCLUSIVE: oversized custody line'; child.kill(); lines = '' }
        } catch { row.guardError = 'INCONCLUSIVE: custody listener failed'; child.kill() }
      })
      child.stderr.on('data', bytes => { if (stderr.length < 2 * 1024 * 1024) stderr += bytes.toString('utf8') })
      const outcome = await new Promise(resolve => {
        let fallback
        const finish = value => { clearTimeout(timer); clearTimeout(fallback); resolve(value) }
        const timer = setTimeout(() => {
          row.timedOut = true
          child.kill()
          fallback = setTimeout(() => {
            child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
            finish({ termination: 'UNVERIFIED: no close event after kill' })
          }, 5_000)
        }, Math.max(1, Math.min(left - 5_000, 110_000)))
        child.once('error', error => finish({ launchError: error.code ?? 'unknown' }))
        child.once('close', (code, signal) => finish({ code, signal }))
      })
      Object.assign(row, { outcome, durationMs: Date.now() - startedAtMs, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) })
      for (const line of stdout.split(/\r?\n/u)) {
        try {
          const receipt = JSON.parse(line)
          if (receipt?.selfTest === 'scrolled-diagnostic') { row.receiptCount++; if (receipt.arm === arm) row.receipt = receipt }
          if (receipt?.selfTest === 'scrolled-diagnostic-observation') { row.observationCount++; if (receipt.arm === arm) row.observation = receipt }
        } catch { /* Non-receipt output is never acceptance. */ }
      }
      if (!row.receipt) row.failure = stderr.slice(-4_000)
      if (outcome.code === 99 || outcome.code === 77 || row.guardError) row.exitOrigin = 'custody guard'
      if (observerPromise) await observerPromise
      const noProcessLaunched = !child.pid && outcome.launchError
      if (noProcessLaunched) row.custody = 'confirmed'
      else if (observer && row.exitObserved && row.closeObserved && row.receiptCount === 1 && row.observationCount === 1 &&
          row.observation?.lateMembers === 0 && row.observation.diagnosticOnly === true &&
          row.receipt?.lateMembers === 0 && row.receipt.diagnosticOnly === true && !row.guardError) {
        try { row.retainedExit = await observer.finish(); if (row.retainedExit.passed === true) row.custody = 'confirmed' }
        catch { row.guardError = 'REFUTED: retained process did not signal exit within the bound' }
      }
      if (row.custody !== 'confirmed') preserveProfile = true
    } catch (error) {
      row.unavailable = error?.code ?? 'diagnostic-error'
      preserveProfile = !!child?.pid
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 5_000)
          child.once('close', () => { clearTimeout(timer); resolve() })
        })
      }
      if (observer && row.custody !== 'confirmed') await observer.abort().catch(() => { row.guardError = 'INCONCLUSIVE: observer abort unconfirmed' })
      if (!preserveProfile && row.custody === 'confirmed') {
        try { rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); row.profileRemoved = true }
        catch (error) { row.cleanupError = error?.code ?? 'cleanup-error'; row.custody = 'unconfirmed'; preserveProfile = true }
      } else if (!child?.pid) {
        try { rmSync(temporary, { recursive: true, force: true }); row.profileRemoved = true; row.custody = 'confirmed' }
        catch { row.cleanupError = 'cleanup-error'; preserveProfile = true }
      }
      if (preserveProfile) { row.profileRetained = profile; row.custody = 'unconfirmed' }
      record.partial = scrolledExperimentPartial({ ...record, partial: budgetExhausted })
      try { save() } catch (error) { receiptWriteFailure = error }
    }
    if (preserveProfile || row.custody !== 'confirmed') custodyFailure()
    if (receiptWriteFailure) throw receiptWriteFailure
  }
  record.durationMs = Date.now() - began
  record.partial = scrolledExperimentPartial({ ...record, partial: budgetExhausted })
  save()
  return record
}
