// MODULE: doctor-versions.test.ts - Measured version output through the actual isolated qualification route
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

// The baseline override loads a saved adapter alongside the same unchanged dependencies.
const { doctorVersions } = await import(process.env.BMN_DOCTOR_ADAPTERS_SOURCE ?? '../../bin/doctor-adapters.mjs') as typeof import('../../bin/doctor-adapters.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each<[string, string, string | null]>([
  ['opencode', 'opencode v2.0.29', '2.0.29'],
  ['opencode', 'opencode v2.0.32', '2.0.32'],
  ['opencode', 'opencode 2.0.29', '2.0.29'],
  ['opencode', '2.0.32', '2.0.32'],
  ['claude', '2.1.308 (Claude Code)', '2.1.308'],
  ['claude', 'Claude Code 2.1.308', '2.1.308'],
  ['codex', 'codex-cli 0.163.0', '0.163.0'],
  ['opencode', 'opencode v2.0.32junk', null],
  ['opencode', 'opencode vtwo', null],
  ['opencode', 'untrusted 2.0.32', null],
  ['claude', 'claude v2.1.308', null],
  ['codex', 'codex v0.163.0', null]
])('reads %s version output %s as %s', async (app, output, version) => {
  const home = mkdtempSync(join(tmpdir(), 'bmn-doctor-versions-')); roots.push(home)
  const bin = join(home, 'bin'); mkdirSync(bin)
  // Fixed synthetic output only; no owner program or model service is executed.
  expect(output).not.toContain("'")
  writeFileSync(join(bin, app), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 })
  const result = await doctorVersions({ HOME: home, PATH: bin })
  expect(result.apps[app as keyof typeof result.apps].executable).not.toBeNull()
  expect(result.apps[app as keyof typeof result.apps].version).toBe(version)
})
