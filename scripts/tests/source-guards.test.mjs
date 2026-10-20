// MODULE: source-guards.test.mjs - New native selects and oversized source files fail outside explicit exceptions
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SIZE_EXCEPTIONS, sourceFindings } from '../lib/source-guards.mjs'
import { compareWithAllowed, findReferences } from '../lib/retired-references.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('the source cleanup stays done (80.10 AC3)', () => {
  it('has no native select and no oversized source outside the stated exceptions', () => {
    expect(sourceFindings(root)).toEqual({ oversized: [], nativeSelects: [] })
    for (const reason of Object.values(SIZE_EXCEPTIONS)) expect(reason.length).toBeGreaterThan(0)
  })

  it('finds added native selects, retired names and 2,001-line source files, and clears when each is removed', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'bmn-source-guards-'))
    const write = (file, text) => {
      const path = join(fixture, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    try {
      execFileSync('git', ['init', '-q'], { cwd: fixture })
      const native = 'apps/desktop/src/renderer/src/new-choice.tsx'
      const nativeJsx = 'apps/desktop/src/renderer/src/new-choice.jsx'
      const large = 'apps/desktop/src/utility/new-module.ts'
      write(native, '<select><option>Choice</option></select>\n')
      write(nativeJsx, '<select><option>Choice</option></select>\n')
      write(large, '\n'.repeat(2001))
      expect(sourceFindings(fixture)).toEqual({ oversized: [{ file: large, lines: 2001 }], nativeSelects: [{ file: nativeJsx, line: 1 }, { file: native, line: 1 }] })
      // Tests and non-shipped harnesses are not product source; the bundled self-test has its own explicit exception.
      write('scripts/test/large-harness.mjs', '\n'.repeat(2001))
      write('apps/desktop/src/utility/example.test.ts', '\n'.repeat(2001))
      for (const file of Object.keys(SIZE_EXCEPTIONS)) write(file, '\n'.repeat(2001))
      expect(sourceFindings(fixture).oversized).toEqual([{ file: large, lines: 2001 }])
      write(native, '<button>Choice</button>\n')
      write(nativeJsx, '<button>Choice</button>\n')
      write(large, '\n'.repeat(2000))
      expect(sourceFindings(fixture)).toEqual({ oversized: [], nativeSelects: [] })
      const retired = ['Cur', 'sor'].join('')
      write('apps/desktop/src/new-reference.ts', `// ${retired}\n`)
      execFileSync('git', ['add', 'apps/desktop/src/new-reference.ts'], { cwd: fixture })
      expect(compareWithAllowed(findReferences(fixture), {}).unexpected).toEqual(['apps/desktop/src/new-reference.ts'])
      write('apps/desktop/src/new-reference.ts', '// No retired reference\n')
      expect(compareWithAllowed(findReferences(fixture), {})).toEqual({ unexpected: [], stale: [] })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
