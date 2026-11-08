// MODULE: qa-bench-candidate.test.mjs - bind actual loaded code, not just an Electron executable
import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { benchCandidate } from '../qa/bench-candidate.mjs'
it('detects changes to loaded app code and runtime independently', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-candidate-')), out = join(root, 'apps/desktop/out'), binary = join(root, 'electron')
  try {
    mkdirSync(out, { recursive: true }); writeFileSync(binary, 'runtime'); writeFileSync(join(out, 'main.js'), 'before')
    const first = benchCandidate(binary, root, false)
    writeFileSync(join(out, 'main.js'), 'after'); const second = benchCandidate(binary, root, false)
    expect(second).not.toBe(first)
    writeFileSync(binary, 'new runtime'); expect(benchCandidate(binary, root, false)).not.toBe(second)
    symlinkSync(binary, join(out, 'outside.js')); expect(() => benchCandidate(binary, root, false)).toThrow('symlink')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it('hashes packaged resources, so an unchanged launcher cannot relabel changed app code', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-package-')), binary = join(root, 'bmn')
  try {
    mkdirSync(join(root, 'resources')); writeFileSync(binary, 'runtime'); writeFileSync(join(root, 'resources/app.asar'), 'before')
    const before = benchCandidate(binary, root, true)
    writeFileSync(join(root, 'resources/app.asar'), 'after'); expect(benchCandidate(binary, root, true)).not.toBe(before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
