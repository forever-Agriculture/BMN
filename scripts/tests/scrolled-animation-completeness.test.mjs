import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { observeDiagnosticFailure } from '../../apps/desktop/src/main/self-test/diagnostic-observation.ts'
import { scrolledExperimentPartial } from '../lib/scrolled-diagnostic-result.mjs'
const appRequire = createRequire(resolve('apps/desktop/package.json'))
const esbuild = createRequire(appRequire.resolve('vite/package.json'))('esbuild')
const source = readFileSync('apps/desktop/src/main/self-test/runner.ts', 'utf8')
const start = '    const sixelAnimation: Record<string, unknown> = observedAnimation?.observationError'
const end = '    if (!animationPassed && !diagnosticArm) {'
expect(source.split(start)).toHaveLength(2); expect(source.split(end)).toHaveLength(2)
const block = source.slice(source.indexOf(start), source.indexOf(end))
const mapping = esbuild.transformSync(block, { loader: 'ts', target: 'node24' }).code + '\n({ sixelAnimation, animationPassed })'
afterEach(() => vi.useRealTimers())
it.each([true, false].flatMap(verdict => ['reject', 'null', 'stall'].map(fault => ({ verdict, fault }))))('requires partial evidence after actual runner animation mapping receives $fault (SCROLLED=$verdict)', async ({ verdict, fault }) => {
    vi.useFakeTimers()
    const result = observeDiagnosticFailure('original SCROLLED failure', 'animation after scroll', () =>
      fault === 'reject' ? Promise.reject(new Error('synthetic')) : fault === 'null' ? null : new Promise(() => {}), 2000)
    await vi.advanceTimersByTimeAsync(2000)
    const observedAnimation = await result
    const animation = runInNewContext(mapping, { observedAnimation })
    expect(animation.animationPassed).toBe(false)
    const passive = { failure: 'original SCROLLED failure', failureAtMs: 11000, scrollTypedAtMs: 0,
      controllerPokes: [], samples: [{ outputBytes: 42 }], observationErrors: [] }
    const arms = Array.from({ length: 6 }, (_, index) => {
      const arm = ['control', 'split', 'static'][index % 3]
      return { arm, receiptCount: 1, observationCount: 1, custody: 'confirmed', profileRemoved: true,
        outcome: { code: 0, signal: null }, observation: { selfTest: 'scrolled-diagnostic-observation', diagnosticOnly: true,
          arm, initialScrolledWithinBudget: verdict, lateMembers: 0, ...(verdict ? {} : { passiveObservation: passive }) },
        receipt: { selfTest: 'scrolled-diagnostic', diagnosticOnly: true, arm, graceful: true, initialScrolledWithinBudget: verdict,
          lateMembers: 0, anchors: { appStartedAtMs: 1, prefixStartedAtMs: 2 }, finalState: { outputBytes: 42 },
          ...animation, ...(verdict ? {} : { passiveObservation: passive }) } }
    })
    expect(scrolledExperimentPartial({ partial: false, arms })).toBe(true)
  })

it.each([true, false])('permits an actually observed negative animation result (SCROLLED=%s)', verdict => {
  const animation = runInNewContext(mapping, { observedAnimation: {},
    host: { runtimes: new Map([['synthetic', { attachment: { attachmentId: 17 } }]]) },
    secondSession: { sessionId: 'synthetic' }, animatedAttachment: 17,
    animation: { storageMB: 1, imageLines: Array(9).fill(1), quiet: { lines: ['quiet'], storageMB: 0, layer: false, selection: 'kept' } },
    quietBefore: { lines: ['quiet'], storageMB: 0, layer: false, selection: 'kept' } })
  expect(animation.animationPassed).toBe(false)
  const passive = { failure: 'original SCROLLED failure', failureAtMs: 11000, scrollTypedAtMs: 0,
    controllerPokes: [], samples: [{ outputBytes: 42 }], observationErrors: [] }
  const arms = Array.from({ length: 6 }, (_, index) => {
    const arm = ['control', 'split', 'static'][index % 3]
    return { arm, receiptCount: 1, observationCount: 1, custody: 'confirmed', profileRemoved: true,
      outcome: { code: 0, signal: null }, observation: { selfTest: 'scrolled-diagnostic-observation', diagnosticOnly: true,
        arm, initialScrolledWithinBudget: verdict, lateMembers: 0, ...(verdict ? {} : { passiveObservation: passive }) },
      receipt: { selfTest: 'scrolled-diagnostic', diagnosticOnly: true, arm, graceful: true, initialScrolledWithinBudget: verdict,
        lateMembers: 0, anchors: { appStartedAtMs: 1, prefixStartedAtMs: 2 }, finalState: { outputBytes: 42 },
        ...animation, ...(verdict ? {} : { passiveObservation: passive }) } }
  })
  expect(scrolledExperimentPartial({ partial: false, arms })).toBe(false)
})
