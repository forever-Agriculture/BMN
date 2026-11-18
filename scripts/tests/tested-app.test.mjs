// MODULE: tested-app.test.mjs - a live script starts this checkout's build, or the packaged one --binary names, and keeps its own arguments
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { testedApp } from '../lib/tested-app.mjs'

describe('the BMN a live script starts (Epic 75 acceptance)', () => {
  it('starts Electron with the app folder by default, and the packaged binary alone with --binary, keeping the other arguments in order', () => {
    const app = join(process.cwd(), 'apps/desktop')
    const development = testedApp(app, ['report.json', 'shots'])
    assert.deepEqual([development.appArgs, development.build, development.rest], [[app], 'development', ['report.json', 'shots']])
    assert.equal(development.cliPath, join(app, 'bin/bmn'))
    const folder = mkdtempSync(join(tmpdir(), 'bmn-tested-app-'))
    try {
      const binary = join(folder, 'bmn')
      writeFileSync(binary, '')
      assert.throws(() => testedApp(app, ['--binary', binary]), /no bundled BMN CLI/)
      mkdirSync(join(folder, 'resources/bin'), { recursive: true })
      writeFileSync(join(folder, 'resources/bin/bmn.mjs'), '// bundled CLI')
      const packaged = testedApp(app, ['report.json', '--binary', binary, 'shots'])
      assert.deepEqual([packaged.executablePath, packaged.appArgs, packaged.build, packaged.rest], [binary, [], binary, ['report.json', 'shots']])
      assert.equal(packaged.cliPath, join(folder, 'resources/bin/bmn.mjs'))
      assert.throws(() => testedApp(app, ['--binary', join(folder, 'missing')]), /--binary names no file/)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
