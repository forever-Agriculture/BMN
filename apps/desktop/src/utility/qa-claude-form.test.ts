// MODULE: qa-claude-form.test.ts - the Claude Code QA form, its per-run fence binding and the relay's per-account tools (100.6, d68)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { askCommand, executableIdentity } from '../../bin/agents-team-forms.mjs'
import { checkQaInit, fenceBinding, qualifiedQaRun } from '../../bin/qa-claude-fence.mjs'
import { qaToolAllowed } from '../../bin/qa-browser-relay.mjs'
import { INTERACT_TOOLS, LOOK_TOOLS } from '../../bin/agents-team-browser.mjs'

const relay = { type: 'stdio' as const, command: 'node', args: ['/synthetic/bin/qa-browser-relay.mjs', '/synthetic/qa'], env: {} }
const tools = ['browser_snapshot', 'browser_click', 'browser_accounts', 'browser_account_pick', 'browser_qa_seal']
const environment = { HOME: '/synthetic/home', PATH: '/synthetic/app/resources/bin:/usr/bin', CLAUDE_CONFIG_DIR: '/synthetic/claude', BMN_TOKEN: 'synthetic-token' }
let folder: string, program: { launcher: string; payload: string }
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'qa-claude-form-'))
  writeFileSync(join(folder, 'claude'), '#!/bin/sh\n'); program = { launcher: join(folder, 'claude'), payload: join(folder, 'claude') }
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))
const built = () => askCommand('claude', program, { form: 'claude-qa', model: 'claude-opus-5-5', effort: 'high', cwd: '/synthetic/qa', folder: '/synthetic/qa', environment, qaRelay: relay, qaTools: tools })
function launch() {
  const command = built()
  const value = { qaId: 'run-a', form: 'claude-qa', model: 'claude-opus-5-5', effort: 'high', version: '2.1.314', program, identity: executableIdentity(program), built: command, tools }
  writeFileSync(join(folder, 'launch.json'), JSON.stringify(value))
  return value
}
const initTools = tools.map(name => `mcp__playwright__${name}`)
it('the QA form names no built-in tool, no settings, only the relay and its exact tools, and denies instead of asking', () => {
  const { command, environment: env } = built()
  expect(command.slice(command.indexOf('--tools'), command.indexOf('--tools') + 2)).toEqual(['--tools', ''])
  for (const flag of ['--restricted', '--disable-slash-commands', '--strict-mcp-config']) expect(command).toContain(flag)
  expect(JSON.parse(command[command.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { playwright: relay } })
  expect(command[command.indexOf('--allowedTools') + 1]).toBe(initTools.join(','))
  expect(command.slice(command.indexOf('--permission-mode'), command.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk'])
  expect(env).toEqual({ HOME: '/synthetic/home', PATH: '/usr/bin', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: '/synthetic/claude' })
})
it('ordinary Claude Code asks keep their read-tools form', () => {
  const command = askCommand('claude', program, { form: 'claude-read-tools', model: 'm', effort: 'high', cwd: '/synthetic', folder: '/synthetic', environment }).command
  expect(command).toContain('Read,Grep,Glob,Bash,WebSearch,Agent')
  expect(command).not.toContain('--disable-slash-commands')
})
it('a run qualifies only with its own passing fence, a matching init event from its registered agent, and an unchanged program', () => {
  const value = launch(), agent = { pid: 4242, ticks: '777' }
  writeFileSync(join(folder, 'fence.json'), JSON.stringify({ binding: fenceBinding(value), pass: true, initToolsSha256: '' }))
  expect(qualifiedQaRun(folder, agent)).toBe(false)
  // The fence's own init digest is the reference the production event must equal.
  const passing = { binding: fenceBinding(value), pass: true, initToolsSha256: '' }
  writeFileSync(join(folder, 'fence.json'), JSON.stringify(passing))
  const probe = checkQaInit(folder, { type: 'system', subtype: 'init', tools: initTools, mcp_servers: [{ name: 'playwright', status: 'connected' }] }, agent)
  passing.initToolsSha256 = probe.toolsSha256!
  writeFileSync(join(folder, 'fence.json'), JSON.stringify(passing))
  expect(checkQaInit(folder, { tools: [...initTools].reverse(), mcp_servers: [{ name: 'playwright', status: 'connected' }] }, agent).ok).toBe(true)
  expect(qualifiedQaRun(folder, agent)).toBe(true)
  expect(qualifiedQaRun(folder, { pid: 4242, ticks: '778' })).toBe(false)
  expect(checkQaInit(folder, { tools: [...initTools, 'Bash'], mcp_servers: [{ name: 'playwright', status: 'connected' }] }, agent).ok).toBe(false)
  expect(qualifiedQaRun(folder, agent)).toBe(false)
  expect(checkQaInit(folder, { tools: initTools, mcp_servers: [{ name: 'playwright', status: 'connected' }, { name: 'canary', status: 'connected' }] }, agent).ok).toBe(false)
  checkQaInit(folder, { tools: initTools, mcp_servers: [{ name: 'playwright', status: 'connected' }] }, agent)
  expect(qualifiedQaRun(folder, agent)).toBe(true)
  writeFileSync(join(folder, 'launch.json'), JSON.stringify({ ...value, effort: 'medium' }))
  expect(qualifiedQaRun(folder, agent)).toBe(false)
  writeFileSync(join(folder, 'launch.json'), JSON.stringify(value)); writeFileSync(join(folder, 'fence.json'), JSON.stringify({ ...passing, pass: false }))
  expect(qualifiedQaRun(folder, agent)).toBe(false)
  writeFileSync(join(folder, 'fence.json'), JSON.stringify(passing)); writeFileSync(program.payload, '#!/bin/sh\n# replaced\n')
  expect(qualifiedQaRun(folder, agent)).toBe(false)
})
it('the fence binding changes with the command, model or effort but not with the relay path', () => {
  const value = launch()
  const moved = { ...value, built: { ...value.built, command: value.built.command.map(arg => arg.startsWith('{"mcpServers"') ? arg.replace('/synthetic/qa', '/elsewhere') : arg) } }
  expect(fenceBinding(moved)).toEqual(fenceBinding(value))
  expect(fenceBinding({ ...value, model: 'other' })).not.toEqual(fenceBinding(value))
  expect(fenceBinding({ ...value, built: { ...value.built, command: [...value.built.command, '--extra'] } })).not.toEqual(fenceBinding(value))
})
it('test accounts interact fully except unsafe code; ordinary accounts never evaluate or read network data; look-only only looks', () => {
  for (const tool of [...LOOK_TOOLS, ...INTERACT_TOOLS]) {
    expect(qaToolAllowed('test-full', tool)).toBe(tool !== 'browser_run_code_unsafe')
    expect(qaToolAllowed('look-only', tool)).toBe(LOOK_TOOLS.includes(tool) && tool !== 'browser_network_requests')
    expect(qaToolAllowed('ordinary-granted', tool)).toBe(!['browser_evaluate', 'browser_run_code_unsafe', 'browser_network_requests'].includes(tool))
  }
  expect(qaToolAllowed(null, 'browser_click')).toBe(true)
})
