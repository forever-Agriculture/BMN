// MODULE: setup-readiness.test.ts - Secret projection, fixed paths and real disposable probe qualification
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SETUP_APPS, SETUP_INSTALL_COMMANDS, SETUP_LOGIN_ARGUMENTS } from '@bmn/protocol'
import { findSetupProgram, projectSetupSignIn, SetupReadinessReader } from './setup-readiness'

const roots = new Set<string>()
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), 'bmn-setup-reader-')); roots.add(dir); return dir }
afterEach(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); roots.clear() })

it('projects only state, dropping Claude identity, Codex key fragments and OpenCode connection data', () => {
  const secret = 'sk-SYNTHETIC-private-value-0123456789'
  const samples = [
    projectSetupSignIn('claude', { code: 0, failure: null, output: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: secret, orgId: secret }) }),
    projectSetupSignIn('codex', { code: 0, failure: null, output: `Logged in using an API key - ${secret}` }),
    projectSetupSignIn('opencode', { code: 0, failure: null, output: JSON.stringify([{ id: secret, connections: [{ type: 'credential', id: secret, method: 'key', key: secret }] }]) })
  ]
  expect(samples).toEqual([{ signIn: 'ready', method: 'oauth' }, { signIn: 'ready', method: 'api-key' }, { signIn: 'ready', method: 'other' }])
  expect(JSON.stringify(samples)).not.toContain(secret)
  expect(Object.keys(samples[0]!)).toEqual(['signIn', 'method'])
  for (const app of SETUP_APPS) {
    expect(projectSetupSignIn(app, { code: 0, failure: 'timeout', output: secret })).toEqual({ signIn: 'unknown', method: null })
    expect(projectSetupSignIn(app, { code: 0, failure: null, output: `unrecognized ${secret}` })).toEqual({ signIn: 'unknown', method: null })
  }
})

it('keeps the measured command table non-root and uses only the three approved fixed paths', () => {
  const home = root()
  for (const app of SETUP_APPS) {
    const folder = join(home, app === 'opencode' ? '.opencode/bin' : '.local/bin')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, app), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    expect(findSetupProgram(app, { HOME: home, PATH: '/nonexistent' }, null)).toEqual({ path: join(folder, app), onPath: false })
    expect(findSetupProgram(app, { HOME: home, PATH: folder }, null)?.onPath).toBe(true)
    expect(SETUP_INSTALL_COMMANDS[app].executable).toBe('/bin/bash')
    expect(SETUP_INSTALL_COMMANDS[app].argv.slice(0, 3)).toEqual(['-o', 'pipefail', '-c'])
    expect(SETUP_INSTALL_COMMANDS[app].argv.join(' ')).not.toMatch(/\bsudo\b/)
    expect(SETUP_LOGIN_ARGUMENTS[app]).not.toContain('--with-api-key')
  }
})

function installedFixture(leak: boolean): { reader: SetupReadinessReader; home: string; state: string; count: () => number } {
  const home = root(), bin = join(home, 'bin'), state = join(home, 'bmn-state')
  mkdirSync(bin)
  const app = join(bin, 'claude')
  writeFileSync(app, `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const home=process.env.HOME, args=process.argv.slice(2);
if(args[0]==='--version'){console.log('9.0.0 (Claude Code)');process.exit(0)}
if(args[0]==='mcp'){
 const config=JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8'));
 const server=config.mcpServers.bmn_setup_probe;
 try{cp.execFileSync(server.command,server.args,{timeout:250,stdio:'ignore'})}catch{}
 process.exit(0);
}
const credential=path.join(home,'.claude/.credentials.json');
const ready=fs.existsSync(credential)||!!process.env.ANTHROPIC_API_KEY;
${leak ? "if(ready){console.log(process.env.ANTHROPIC_API_KEY||JSON.parse(fs.readFileSync(credential,'utf8')).claudeAiOauth.accessToken)}" : ''}
console.log(JSON.stringify({loggedIn:ready,authMethod:ready?'claude.ai':'none'}));process.exit(ready?0:1);
`, { mode: 0o755 })
  let count = 0
  const reader = new SetupReadinessReader({ environment: () => ({ HOME: home, PATH: bin }), skipDirectory: null,
    stateDirectory: state, qualify: async (...args) => {
      count++
      const { qualifySetupProbe } = await import('./setup-probe-qualification')
      return qualifySetupProbe(...args)
    } })
  return { reader, home, state, count: () => count }
}

it('qualifies a later version on real disposable empty and decoy profiles before any real-profile status read', async () => {
  const { reader, state, count } = installedFixture(false)
  expect((await reader.read()).apps[0]).toMatchObject({ version: '9.0.0', signIn: 'unknown', qualification: 'checking' })
  await reader.idle()
  expect((await reader.read()).apps[0]).toMatchObject({ signIn: 'signed-out', qualification: 'passed' })
  expect(count()).toBe(1)
  expect(readdirSync(state)).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(state, readdirSync(state)[0]!), 'utf8'))).toEqual({ schemaVersion: 1, app: 'claude', version: '9.0.0', result: 'passed' })
})

it('rejects a later version that prints a synthetic token and never retries that version after restart', async () => {
  const { reader, home, state, count } = installedFixture(true)
  await reader.read()
  await reader.idle()
  expect((await reader.read()).apps[0]).toMatchObject({ signIn: 'unknown', qualification: 'failed' })
  expect(count()).toBe(1)
  const restored = new SetupReadinessReader({ environment: () => ({ HOME: home, PATH: join(home, 'bin') }), skipDirectory: null,
    stateDirectory: state, qualify: async () => { throw new Error('must not retry') } })
  expect((await restored.read()).apps[0]).toMatchObject({ signIn: 'unknown', qualification: 'failed' })
  restored.confirm('claude', '9.0.0')
  expect((await restored.read()).apps[0]).toMatchObject({ signIn: 'confirmed', method: null })
  for (const file of readdirSync(state)) expect(readFileSync(join(state, file), 'utf8')).not.toContain('sk-')
})
