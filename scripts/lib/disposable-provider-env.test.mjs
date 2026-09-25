import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disposableProviderEnvironment } from './disposable-provider-env.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profiles() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-cross-harness-profiles-'))
  roots.push(root)
  mkdirSync(join(root, 'claude'), { mode: 0o700 })
  mkdirSync(join(root, 'codex'), { mode: 0o700 })
  return root
}

describe('disposable provider trial environment', () => {
  it('refuses to launch without explicitly provisioned disposable profiles', () => {
    expect(() => disposableProviderEnvironment('/tmp/runtime', undefined)).toThrow(/UNVERIFIED/)
    expect(() => disposableProviderEnvironment('/tmp/runtime', '/tmp/bmn-cross-harness-profiles-missing'))
      .toThrow(/does not exist/)
    expect(() => disposableProviderEnvironment('/tmp/runtime', process.env.HOME)).toThrow(/disposable \/tmp/)
  })

  it('uses private disposable profiles and drops inherited credentials and owner roots', () => {
    const root = profiles()
    const env = disposableProviderEnvironment('/tmp/trial-runtime', root, {
      PATH: '/usr/bin', HOME: '/home/owner', CLAUDE_CONFIG_DIR: '/home/owner/.claude',
      CODEX_HOME: '/home/owner/.codex', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret'
    })
    expect(env).toMatchObject({
      HOME: '/tmp/trial-runtime/home', CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'), PATH: '/usr/bin'
    })
    expect(JSON.stringify(env)).not.toContain('/home/owner')
    expect(JSON.stringify(env)).not.toContain('secret')
  })

  it('refuses symlinked or shared profile directories', () => {
    const root = profiles()
    const alias = `${root}-alias`
    symlinkSync(root, alias)
    roots.push(alias)
    expect(() => disposableProviderEnvironment('/tmp/runtime', alias)).toThrow(/symlink/)
    rmSync(join(root, 'codex'), { recursive: true })
    symlinkSync(join(root, 'claude'), join(root, 'codex'))
    expect(() => disposableProviderEnvironment('/tmp/runtime', root)).toThrow(/symlink/)
    rmSync(join(root, 'codex'))
    mkdirSync(join(root, 'codex'), { mode: 0o700 })
    chmodSync(root, 0o755)
    expect(() => disposableProviderEnvironment('/tmp/runtime', root)).toThrow(/private/)
  })
})
