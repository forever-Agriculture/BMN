// MODULE: doctor-packaging.test.mjs - The actual doctor worker executes bmn.mjs in the packaged CLI layout
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { cliModules } from '../lib/cli-modules.mjs'

it('runs BMN checks with the JavaScript entry in a packaged resources/bin layout', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const evidence = join(root, '.dev-auto/evidence/81-3')
  mkdirSync(evidence, { recursive: true })
  const fixture = mkdtempSync(join(evidence, 'packaging-probe-'))
  try {
    const source = join(root, 'apps/desktop/bin')
    const packaged = join(fixture, 'resources/bin')
    const home = join(fixture, 'home')
    mkdirSync(packaged, { recursive: true })
    mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
    writeFileSync(join(home, '.config/bmn/agents/global-rules.md'), '# Global rules\n\nA synthetic rule.\n\n## Team\nThe team: <!-- bmn:team -->.\n')
    for (const name of cliModules(source)) copyFileSync(join(source, name), join(packaged, name))
    copyFileSync(join(source, 'bmn'), join(packaged, 'bmn.mjs'))
    writeFileSync(join(packaged, 'bmn'), '#!/bin/sh\nexit 91\n', { mode: 0o755 })
    const adapter = await import(pathToFileURL(join(packaged, 'doctor-adapters.mjs')).href)
    const result = await adapter.runBmnDoctor('rules', home, { PATH: '/usr/bin:/bin' })
    expect(result.state).toBe('problems')
    expect(result.problems).toHaveLength(3)
    expect(result.problems.every((row) => row.code === 'rules-check')).toBe(true)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
