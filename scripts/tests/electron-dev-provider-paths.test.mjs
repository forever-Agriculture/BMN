// MODULE: electron-dev-provider-paths.test.mjs - A CLI update in development survives BMN's temporary-root cleanup
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const launches = vi.hoisted(() => [])
vi.mock('node:child_process', async (original) => {
  const { EventEmitter } = await import('node:events')
  return {
    ...await original(),
    spawn: (_command, _args, options) => {
      const child = new EventEmitter()
      launches.push({ child, environment: options.env })
      return child
    }
  }
})

const roots = []
afterEach(() => {
  for (const launch of launches.splice(0)) launch.child.emit('exit', 0)
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each(['default', 'custom'])('a CLI updated with %s XDG paths still runs after development exits', async (profile) => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-dev-provider-paths-'))
  roots.push(root)
  const home = join(root, 'home')
  vi.stubEnv('HOME', home)
  for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
    vi.stubEnv(`XDG_${name}_HOME`, profile === 'custom' ? join(root, name.toLowerCase()) : undefined)
  }

  // Load the actual launcher, intercepting only the Electron child so no owner profile or app is started.
  await import('../test/electron-dev.mjs')
  const { child, environment } = launches.at(-1)
  const bmnData = environment.BMN_DATA_HOME
  expect(existsSync(dirname(bmnData))).toBe(true)
  for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
    expect(environment[`XDG_${name}_HOME`]).toBe(profile === 'custom' ? join(root, name.toLowerCase()) : undefined)
  }
  const launcher = join(home, '.local/bin/claude')
  const update = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
    import { dirname, join } from 'node:path'
    const binary = join(process.env.XDG_DATA_HOME || join(process.env.HOME, '.local/share'), 'claude/versions/synthetic')
    const launcher = join(process.env.HOME, '.local/bin/claude')
    mkdirSync(dirname(binary), { recursive: true })
    mkdirSync(dirname(launcher), { recursive: true })
    writeFileSync(binary, '#!/bin/sh\\nprintf "synthetic Claude Code\\\\n"\\n', { mode: 0o700 })
    symlinkSync(binary, launcher)
  `], { env: environment, encoding: 'utf8', timeout: 5000 })
  expect(update.status, update.stderr).toBe(0)

  child.emit('exit', 0)
  expect(existsSync(dirname(bmnData))).toBe(false)
  const version = spawnSync(launcher, ['--version'], { encoding: 'utf8', timeout: 5000 })
  expect(version.status, version.error?.message ?? version.stderr).toBe(0)
  expect(version.stdout.trim()).toBe('synthetic Claude Code')
})
