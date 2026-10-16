// MODULE: launch-set-references.test.mjs - Story 75.3: no executable path for launch sets or custom templates remains
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Built from parts, so this file names nothing the check looks for.
const SET = ['launch', 'Set'].join('')
const PATTERN = [
  `${SET}|L${SET.slice(1)}|launch-sets?-|launch_set|launch_template|LaunchTemplate|createTemplate|listTemplates`,
  `template\\.(list|create)|aiterm:template|aiterm:launch-set|Launch template|Save a launch set|Launch set…`
].join('|')

/** Where a name may stay, and why: the tables and the migrations that made them, tests of those, and comments. */
const ALLOWED = {
  'apps/desktop/src/utility/store-schema.ts': 'the two tables and the historical migrations that made and changed them',
  'apps/desktop/src/utility/store-schema.test.ts': 'tests of those migrations',
  'apps/desktop/src/utility/database-workspace-store.test.ts': 'the graphics migration over old rows',
  'apps/desktop/src/utility/database-archive-purge.test.ts': 'the cascade of an old set row when its workspace is purged',
  'apps/desktop/src/main/application-startup.test.ts': 'startup beside old rows, reading neither'
}

describe('launch sets and custom templates are gone (Story 75.3)', () => {
  it('leaves no executable path, only the tables, their migrations and the tests of those', () => {
    let out = ''
    try {
      out = execFileSync('git', ['grep', '-n', '-I', '-E', PATTERN, '--', '.', ':(exclude)docs', ':(exclude)*.md',
        ':(exclude)scripts/tests/launch-set-references.test.mjs'], { cwd: repoRoot, encoding: 'utf8' })
    } catch (error) {
      if (error.status !== 1) throw error
    }
    const files = new Set(out.split('\n').filter(Boolean).map((line) => line.slice(0, line.indexOf(':'))))
    assert.deepEqual([...files].filter((file) => !Object.hasOwn(ALLOWED, file)).sort(), [])
    assert.deepEqual(Object.keys(ALLOWED).filter((file) => !files.has(file)).sort(), [])
  })
})
