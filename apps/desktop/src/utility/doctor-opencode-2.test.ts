// MODULE: doctor-opencode-2.test.ts - OpenCode 2 plugin keys, managed origins and state-only doctor facts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { doctorVersions, runLeftoversDoctor, sandboxProcess } from '../../bin/doctor-adapters.mjs'
import { validateLeftovers } from '../../bin/doctor-leftover-results.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'
import { CHECKS } from '../../bin/doctor-results.mjs'
import { doctorView, emptyDoctorState } from '../../bin/doctor-state.mjs'

const roots: string[] = []
const fixture = (): string => { const root = mkdtempSync(join(tmpdir(), 'bmn-opencode-2-doctor-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('Epic 85: includes both managed OpenCode files alongside selected profile files', () => {
  const profile = selectedProfile({ HOME: fixture() })
  expect(profile.opencodeFiles).toEqual(expect.arrayContaining(['/etc/opencode/opencode.json', '/etc/opencode/opencode.jsonc']))
})

it('Epic 85: inventories V1/V2 plugin entries once through the real isolated collector', async () => {
  const home = fixture(), config = join(home, '.config/opencode')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({ plugin: ['synthetic-legacy'],
    plugins: ['synthetic-legacy', 'synthetic-modern', { package: 'synthetic-package', options: { setting: 'synthetic' } }] }))
  const result = await runLeftoversDoctor(home, { HOME: home, PATH: '/usr/bin:/bin' }, { opencode: '2.0.29' })
  expect(result.leftovers?.filter(row => row.app === 'opencode' && row.kind === 'plugins')).toEqual([
    expect.objectContaining({ reason: 'app-managed' }), expect.objectContaining({ reason: 'app-managed' }), expect.objectContaining({ reason: 'app-managed' })
  ])
  expect(JSON.stringify(result)).not.toContain('synthetic-legacy')
})

it('Epic 85: preserves only the fixed managed origin through validation and Health text', () => {
  const rows = validateLeftovers([{ kind: 'plugins', app: 'opencode', reason: 'app-managed', item: 1, source: 'managed' }])!
  expect(rows[0]).toMatchObject({ source: 'managed' })
  expect(validateLeftovers([{ kind: 'plugins', app: 'opencode', reason: 'app-managed', item: 1, source: 'private-path' }])).toBeNull()
  const state = emptyDoctorState(); state.versions = 'a'.repeat(64)
  for (const check of CHECKS) state.results[check] = { state: 'passed', problems: [], checkedAt: 1000, version: state.versions }
  state.results.leftovers!.leftovers = rows
  const view = doctorView(state, { now: 1100 })
  expect(view.rows.find(row => row.check === 'leftovers')?.leftovers[0]?.reasonText).toContain('managed configuration')
})

it('Epic 85: qualifies an OpenCode version on a fresh home with only its disposable log writable', async () => {
  const home = fixture(), bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nset -e\nmkdir -p "$HOME/.local/share/opencode/log" "$HOME/.local/state/opencode" "$HOME/.config/opencode" "$HOME/.cache/opencode/bin"\nprintf synthetic > "$HOME/.local/share/opencode/log/synthetic.log"\nif (printf unsafe > "$HOME/qualification-write") 2>/dev/null; then exit 66; fi\nprintf "opencode v2.0.32\\n"\n', { mode: 0o755 })
  const result = await doctorVersions({ HOME: home, PATH: bin })
  expect(result.apps.opencode.version).toBe('2.0.32')
  expect(existsSync(join(home, '.local'))).toBe(false)
  expect(existsSync(join(home, 'qualification-write'))).toBe(false)
})

it('Epic 85: ordinary sandbox initializes a fresh selected profile without host writes', async () => {
  const home = fixture(), bin = join(home, 'bin')
  mkdirSync(bin)
  const program = join(bin, 'opencode')
  writeFileSync(program, '#!/bin/sh\nset -e\nmkdir -p "$HOME/.local/share/opencode/log" "$HOME/.local/share/opencode/repos" "$HOME/.local/state/opencode" "$HOME/.config/opencode" "$HOME/.cache/opencode/bin"\nprintf synthetic > "$HOME/.local/share/opencode/log/synthetic.log"\nif (printf unsafe > "$HOME/qualification-write") 2>/dev/null; then exit 66; fi\nprintf "opencode v2.0.32\\n"\n', { mode: 0o755 })
  const run = await sandboxProcess(home, program, ['--version'], { HOME: home, PATH: '/usr/bin:/bin' })
  expect(run).toMatchObject({ code: 0, failure: null, stdout: 'opencode v2.0.32\n' })
  expect(existsSync(join(home, '.local'))).toBe(false)
  expect(existsSync(join(home, 'qualification-write'))).toBe(false)
})

for (const conflict of [false, true]) {
  it(`Epic 85 full review: ${conflict ? 'refuses conflicting' : 'deduplicates equivalent'} MCP definitions across layouts`, async () => {
    const home = fixture(), config = join(home, '.config/opencode')
    mkdirSync(config, { recursive: true })
    const value = { type: 'local', command: ['synthetic-missing-mcp-program'] }
    writeFileSync(join(config, 'opencode.json'), JSON.stringify({ mcp: { shared: value } }))
    writeFileSync(join(config, 'opencode.jsonc'), JSON.stringify({ mcp: { servers: { shared: conflict ? { ...value, command: ['synthetic-different-missing-program'] } : value } } }))
    const result = await runLeftoversDoctor(home, { HOME: home, PATH: '/usr/bin:/bin' }, { opencode: '2.0.32' })
    const mcp = result.leftovers?.filter(row => row.app === 'opencode' && row.kind === 'mcp')
    expect(mcp).toHaveLength(1)
    expect(mcp?.[0]?.reason).toBe(conflict ? 'unreadable' : 'missing-program')
    if (conflict) expect(result.state).toBe('partial')
    expect(JSON.stringify(result)).not.toContain('synthetic-missing-mcp-program')
  })
}

for (const kind of ['unreadable-first', 'disabled-conflict', 'environment-conflict', 'reordered-equivalent']) {
  it(`Epic 85 full review: keeps MCP equivalence and unreadability for ${kind}`, async () => {
    const home = fixture(), config = join(home, '.config/opencode')
    mkdirSync(config, { recursive: true })
    const base = { type: 'local', command: ['synthetic-missing-program'], environment: { FIRST: 'plain', SECOND: 'values' } }
    const first = kind === 'unreadable-first' ? { type: 'local', command: 42 } : base
    const second = kind === 'disabled-conflict' ? { ...base, disabled: true }
      : kind === 'environment-conflict' ? { ...base, environment: { FIRST: 'different', SECOND: 'values' } }
        : { environment: { SECOND: 'values', FIRST: 'plain' }, command: base.command, type: base.type }
    writeFileSync(join(config, 'opencode.json'), JSON.stringify({ mcp: { shared: first } }))
    writeFileSync(join(config, 'opencode.jsonc'), JSON.stringify({ mcp: { servers: { shared: second } } }))
    const result = await runLeftoversDoctor(home, { HOME: home, PATH: '/usr/bin:/bin' }, { opencode: '2.0.32' })
    const mcp = result.leftovers?.filter(row => row.app === 'opencode' && row.kind === 'mcp')
    expect(mcp).toHaveLength(1)
    if (kind !== 'reordered-equivalent') { expect(mcp?.[0]?.reason).toBe('unreadable'); expect(result.state).toBe('partial') }
    expect(JSON.stringify(result)).not.toContain('synthetic-missing-program')
  })
}

it('Epic 85 full review: rechecks a suppressed equivalent MCP source', () => {
  const home = fixture(), managed = join(home, 'empty-managed'); mkdirSync(managed)
  const code = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {join} from 'node:path';
    const [moduleUrl,home]=process.argv.slice(1), config=join(home,'.config/opencode');fs.mkdirSync(config,{recursive:true});
    const value={type:'local',command:['synthetic-missing-program']};
    fs.writeFileSync(join(config,'opencode.json'),JSON.stringify({mcp:{shared:value}}));
    const suppressed=join(config,'opencode.jsonc');fs.writeFileSync(suppressed,JSON.stringify({mcp:{servers:{shared:value}}}));
    const original=fs.lstatSync;let fired=false;
    fs.lstatSync=function(path,...args){if(!fired&&String(path)===suppressed&&new Error().stack.includes('unchangedSince')){fired=true;fs.appendFileSync(suppressed,'\\n// synthetic outside edit');}return original.call(this,path,...args)};
    syncBuiltinESMExports();
    const {inspectLeftovers}=await import(moduleUrl);const result=await inspectLeftovers({opencode:'2.0.32'});
    console.log(JSON.stringify({fired,state:result.state}));
  `
  const result = JSON.parse(execFileSync('/usr/bin/bwrap', [
    '--unshare-all', '--cap-drop', 'ALL', '--new-session', '--die-with-parent', '--ro-bind', '/', '/',
    '--tmpfs', '/etc', '--dir', '/etc/opencode', '--ro-bind', managed, '/etc/opencode', '--bind', home, home,
    '--proc', '/proc', '--dev', '/dev', '--', process.execPath, '--input-type=module', '-e', code,
    new URL('../../bin/doctor-leftovers.mjs', import.meta.url).href, home
  ], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 }))
  expect(result).toEqual({ fired: true, state: 'partial' })
})
