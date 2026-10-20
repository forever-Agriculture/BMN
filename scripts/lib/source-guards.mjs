// MODULE: source-guards.mjs - Cheap guards against new native selects and oversized source files (Story 80.10)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const SIZE_EXCEPTIONS = Object.freeze({
  'apps/desktop/src/utility/session-manager.ts': 'kept whole to preserve session admission and the claim invariant (80.1 owner card)',
  'apps/desktop/src/utility/companion-service.ts': 'kept whole to preserve delivery and the claim invariant (80.1 owner card)',
  'apps/desktop/src/renderer/src/main.tsx': 'state closes over App; extraction would refactor behavior rather than move it (80.19)',
  'apps/desktop/src/main/self-test/runner.ts': 'bundled acceptance harness; test-file splitting is outside Epic 80 (80.1 decision)'
})

export const SELECT_EXCEPTIONS = Object.freeze({})

function shippedSource(file) {
  return /^(?:apps\/desktop\/(?:src|bin)\/|shared\/protocol\/src\/|scripts\/)/.test(file) &&
    !/(?:\.test\.|\.spec\.|\/test-fixtures\/|^scripts\/(?:test|tests)\/)/.test(file) &&
    (/\.(?:[cm]?[jt]sx?|css)$/.test(file) || file === 'apps/desktop/bin/bmn')
}

/** Git's ignored paths keep dependencies, builds, local run evidence and private planning outside the scan. */
export function sourceFindings(root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(shippedSource))].sort()
  const oversized = []
  const nativeSelects = []
  for (const file of files) {
    let text
    try { text = readFileSync(resolve(root, file), 'utf8') }
    catch (error) {
      // A tracked deletion has no source left to inspect; other read failures must keep the gate red.
      if (error.code === 'ENOENT') continue
      throw error
    }
    const lines = text.split('\n')
    const count = lines.length - Number(text.endsWith('\n'))
    if (count > 2000 && !Object.hasOwn(SIZE_EXCEPTIONS, file)) oversized.push({ file, lines: count })
    if (/\.[jt]sx$/.test(file) && !Object.hasOwn(SELECT_EXCEPTIONS, file)) {
      lines.forEach((line, index) => {
        if (/<select\b/.test(line)) nativeSelects.push({ file, line: index + 1 })
      })
    }
  }
  return { oversized, nativeSelects }
}
