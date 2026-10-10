// MODULE: agents-rules.test.ts - Epic 60.4: the rules master, per-app renderings, link-safe install transactions, the Team phrase after an approval, restore and probes
import { execFile } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRoster, sha256 } from '../../bin/agents-roster.mjs'
import { readValidRoster } from '../../bin/agents-state.mjs'
import {
  TEAM_LIMIT_BYTES, applyTeamUpdate, checkTargets, importedMaster, installRules, lastProbes, masterHistory, parseMaster, planTeamUpdate, probe, probeInspector, readMaster, render,
  restoreTransaction, teamPhrase, writeMaster
} from '../../bin/agents-rules.mjs'
import type { PathState } from '../../bin/safe-config-write.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const MASTER = `# Global rules

Plain rule for everyone.

<!-- bmn:public -->
## How to talk
Answer first, plainly.
<!-- /bmn:public -->

## Team
The team: <!-- bmn:team -->, and the owner.

<!-- bmn:apps opencode -->
## OpenCode
OpenCode-only rule.
<!-- /bmn:apps -->

<!-- bmn:apps claude codex -->
PRIVATE-SENTINEL: a rule only a destination that may see private work receives.
<!-- /bmn:apps -->
`
const TEAM = 'Claude Code (Opus, Fable), Codex (Sol, Astra, Luna) (roles, efforts and limits: `bmn team`)'

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

function stub(name: string, body: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}

function writeMasterFile(text = MASTER): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/global-rules.md'), text)
}

function approve(text = EXAMPLE): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), text)
  let generation: number | null
  try {
    generation = JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation
  } catch {
    generation = null
  }
  approveRoster({ generation, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

function edit(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
  return text.replace(from, to)
}

function dataOf(text: string) {
  const parsed = parseRoster(text)
  if (parsed.data === null) throw new Error(JSON.stringify(parsed.errors))
  return parsed.data
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-rules-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stub('codex', 'echo "codex-cli 0.161.0"')
  stub('claude', 'echo "2.1.295 (Claude Code)"')
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  approve()
  writeMasterFile()
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const target = {
  claude: () => join(home, '.claude/CLAUDE.md'),
  codex: () => join(home, '.codex/AGENTS.md'),
  opencode: () => join(home, '.config/opencode/AGENTS.md'),
  cursor: () => join(home, '.cursor/rules/bmn-global-rules.mdc')
}

function generation() {
  return JSON.parse(readFileSync(join(home, `.config/bmn/agents/state/generations/${String(JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation).padStart(6, '0')}.json`), 'utf8'))
}

describe('the master (60.4 AC1)', () => {
  it.each([
    ['an unknown app', '<!-- bmn:apps claude gemini -->\nx\n<!-- /bmn:apps -->', 1],
    ['an unclosed section', 'a\n<!-- bmn:public -->\nx', 2],
    ['a nested marker', '<!-- bmn:public -->\n<!-- bmn:apps codex -->\nx\n<!-- /bmn:apps -->\n<!-- /bmn:public -->', 2],
    ['a duplicate team placeholder', 'a <!-- bmn:team -->\nb <!-- bmn:team -->', 2],
    ['two team placeholders on one line', 'x\n<!-- bmn:team --> and <!-- bmn:team -->', 2],
    ['a closing marker without an opening one', 'x\n<!-- /bmn:apps -->', 2],
    ['a section marker inside a sentence', 'x\nsome text <!-- bmn:public -->', 2],
    ['an unrecognised marker', '<!-- bmn:secret -->', 1],
    ['a marker from the earlier layout', 'x\n<!-- bmn:shareable -->\ny\n<!-- /bmn:shareable -->', 2]
  ])('refuses %s with its line', (_name, text, line) => {
    const { errors } = parseMaster(text)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.map((error) => error.line)).toContain(line)
    expect(errors.every((error) => error.code === 'MASTER_INVALID')).toBe(true)
  })

  it('says what the earlier markers became', () => {
    expect(parseMaster('<!-- bmn:harness codex -->').errors[0]?.message).toContain('bmn:harness is now bmn:apps')
  })

  it('renders full where private work may go and public elsewhere, with header, frontmatter and the team inside its sentence', () => {
    const master = readMaster()
    const approved = generation()
    const codex = render(master, 'codex', approved)
    expect(codex).toMatchObject({ kind: 'full', reason: 'OpenAI may see private work', team_form: 'names by app' })
    expect(codex.text.split('\n')[0]).toBe(`> Generated by BMN from ${join(home, '.config/bmn/agents/global-rules.md')} (master sha256 ${sha256(MASTER)}); edit the master, not this file.`)
    expect(codex.text).toContain('PRIVATE-SENTINEL')
    expect(codex.text).not.toContain('OpenCode-only rule')
    expect(codex.text).not.toContain('<!--')
    // Proposed (Sonnet) and switched-off (GLM) agents are never named; apps in their fixed order, agents in roster order.
    expect(codex.text).toContain(`The team: ${TEAM}, and the owner.`)
    expect(codex.text).not.toMatch(/roster\.md|NOTE-SENTINEL|PRICE-SENTINEL/)
    const opencode = render(master, 'opencode', approved)
    expect(opencode).toMatchObject({ kind: 'public', reason: 'OpenCode Go gets public work only' })
    expect(opencode.text).toContain('Answer first, plainly.')
    expect(opencode.text).not.toContain('PRIVATE-SENTINEL')
    expect(opencode.text).not.toContain('Plain rule for everyone')
    // Markers cannot nest, so the opencode section reaches OpenCode only once it may receive private work.
    expect(opencode.text).not.toContain('OpenCode-only rule')
    const cursor = render(master, 'cursor', approved)
    expect(cursor.text.startsWith('---\ndescription: ')).toBe(true)
    expect(cursor.text).toContain('alwaysApply: true\n---\n> Generated by BMN')
    expect(cursor).toMatchObject({ kind: 'public', reason: "BMN can't confirm where Cursor sends data" })
    // Nothing public: never an empty file, so OpenCode cannot fall back to ~/.claude/CLAUDE.md.
    const bare = render({ ...master, parts: master.parts.filter((part: { kind: string }) => part.kind !== 'public') }, 'opencode', approved)
    expect(bare.text.split('\n').slice(2).join('\n')).toBe('BMN gives this app only the rules its owner marked public, and none are marked.\n')
  })

  it('gives the public rendering to an owner-declared destination whatever its provider answers, and with nothing approved', () => {
    const declared = dataOf(edit(EXAMPLE, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: owner-declared}'))
    expect(render(readMaster(), 'codex', { data: declared } as never)).toMatchObject({ kind: 'public', reason: "BMN can't confirm where Codex sends data" })
    const missing = dataOf(edit(EXAMPLE, 'codex: {provider: openai, basis: observed-default}\n', ''))
    expect(render(readMaster(), 'codex', { data: missing } as never)).toMatchObject({ kind: 'public', reason: 'BMN has no approved destination for Codex' })
    expect(render(readMaster(), 'claude', null)).toMatchObject({ kind: 'public', reason: 'nothing is approved yet', team_form: 'short phrase (nothing approved)' })
  })

  it('names agents by app within 400 bytes, and points at `bmn team` beyond that or with nobody to name', () => {
    const approved = generation()
    expect(teamPhrase(approved)).toEqual({ form: 'names by app', text: TEAM })
    expect(TEAM_LIMIT_BYTES).toBe(400)
    const many = (count: number, nameLength: number) => ({
      ...approved,
      data: { ...approved.data, agents: Array.from({ length: count }, (_, index) => ({ ...approved.data.agents[0], id: `a${index}`, name: `${'N'.repeat(nameLength)}${index}`, harness: ['cursor', 'codex', 'opencode', 'claude'][index % 4] })) }
    })
    const fits = teamPhrase(many(8, 30))
    expect(fits.form).toBe('names by app')
    expect(Buffer.byteLength(fits.text)).toBeLessThanOrEqual(TEAM_LIMIT_BYTES)
    expect(fits.text.replace(/N+/g, '')).toBe('Claude Code (3, 7), Codex (1, 5), OpenCode (2, 6), Cursor (0, 4) (roles, efforts and limits: `bmn team`)')
    expect(teamPhrase(many(12, 30))).toEqual({ form: 'short phrase (names too long)', text: 'the agents `bmn team` lists' })
    expect(teamPhrase(many(0, 1))).toEqual({ form: 'short phrase (no active agent)', text: 'the agents `bmn team` lists' })
    expect(teamPhrase(null)).toEqual({ form: 'short phrase (nothing approved)', text: 'the agents `bmn team` lists' })
  })
})

describe('check (60.4 AC2)', () => {
  it('reports one state per target by precedence', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(target.claude(), 'owner wrote this')
    mkdirSync(join(home, '.codex'), { recursive: true })
    symlinkSync(target.claude(), target.codex())
    mkdirSync(target.cursor(), { recursive: true })
    const states = Object.fromEntries(checkTargets(env).map((entry: { harness: string; state: string }) => [entry.harness, entry.state]))
    expect(states).toEqual({ claude: 'unmanaged', codex: 'link', opencode: 'missing', cursor: 'unreadable' })
  })

  it('reaches current after install, edited-outside after an edit, stale after a master change', async () => {
    expect((await installRules(['claude', 'codex', 'opencode', 'cursor'], { yes: true, environment: env })).code).toBe('OK')
    expect(checkTargets(env).every((entry: { state: string }) => entry.state === 'current')).toBe(true)
    writeFileSync(target.codex(), `${readFileSync(target.codex(), 'utf8')}an outside line\n`)
    writeMasterFile(MASTER.replace('Plain rule for everyone.', 'Plain rule, changed.'))
    const states = Object.fromEntries(checkTargets(env).map((entry: { harness: string; state: string }) => [entry.harness, entry.state]))
    // Every rendering names the master hash in its header, so a master edit makes each one stale.
    expect(states).toEqual({ claude: 'stale', codex: 'edited-outside', opencode: 'stale', cursor: 'stale' })
  })
})

describe('install transactions and restore (60.4 AC3-AC4)', () => {
  it('writes regular files over a link (referent unchanged), an unmanaged and a missing target, and rolls all back', async () => {
    const dotfiles = join(home, 'dotfiles-rules.md')
    writeFileSync(dotfiles, 'shared rules in a dotfiles repo')
    mkdirSync(join(home, '.claude'))
    symlinkSync(dotfiles, target.claude())
    mkdirSync(join(home, '.codex'))
    writeFileSync(target.codex(), 'hand-written codex rules')
    const result = await installRules(['claude', 'codex', 'opencode'], { yes: true, environment: env })
    expect(result.code, JSON.stringify(result)).toBe('OK')
    expect(lstatSync(target.claude()).isFile()).toBe(true)
    expect(readFileSync(dotfiles, 'utf8')).toBe('shared rules in a dotfiles repo')
    expect(readFileSync(target.opencode(), 'utf8')).not.toContain('PRIVATE-SENTINEL')
    const restored = await restoreTransaction(result.transaction!, { yes: true })
    expect(restored).toEqual({ code: 'OK', restored: ['claude', 'codex', 'opencode'] })
    expect(readlinkSync(target.claude())).toBe(dotfiles)
    expect(readFileSync(target.codex(), 'utf8')).toBe('hand-written codex rules')
    expect(existsSync(target.opencode())).toBe(false)
    expect(Object.keys(JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/rules/last-written.json'), 'utf8')))).toEqual([])
  })

  it('names an edited-outside replacement and offers its lines to fold in, never editing the master', async () => {
    await installRules(['codex'], { yes: true, environment: env })
    writeFileSync(target.codex(), `${readFileSync(target.codex(), 'utf8')}Owner added this rule by hand.\n`)
    const result = await runCli(['rules', 'install', 'codex', '--yes'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain('replaces a file edited outside BMN')
    expect(result.stderr).toContain('    Owner added this rule by hand.')
    expect(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')).toBe(MASTER)
  })

  it('gives OpenCode its full rules once its inspected destination may see private work, and refuses when its configuration gives the provider another address', async () => {
    approve(edit(EXAMPLE, 'opencode-go: {name: OpenCode Go, hosts: [], private_work: public_only}', 'opencode-go: {name: OpenCode Go, hosts: [], private_work: allowed}'))
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    const config = join(home, '.config/opencode/opencode.json')
    writeFileSync(config, '{ "model": "opencode-go/kimi-k3" }')
    // No version is read for OpenCode: BMN never runs it, and its destination is read from its configuration.
    expect(await installRules(['opencode'], { yes: true, environment: env })).toMatchObject({ code: 'OK', written: [{ harness: 'opencode', kind: 'full' }] })
    expect(readFileSync(target.opencode(), 'utf8')).toContain('OpenCode-only rule.')
    expect(readFileSync(target.opencode(), 'utf8')).toContain('Plain rule for everyone.')
    writeMasterFile(`${MASTER}\nOne more rule.\n`)
    writeFileSync(config, '{ "model": "opencode-go/kimi-k3", "provider": { "opencode-go": { "options": { "baseURL": "https://proxy.example.test/v1" } } } }')
    const moved = await installRules(['opencode'], { yes: true, environment: env })
    expect(moved).toMatchObject({ code: 'ROUTE_CHANGED', message: expect.stringContaining('opencode.json gives opencode-go its own address') })
    expect(readFileSync(target.opencode(), 'utf8')).not.toContain('One more rule.')
    writeFileSync(config, '{ "model": "opencode-go/kimi-k3" }')
    expect((await installRules(['opencode'], { yes: true, environment: { ...env, OPENCODE_CONFIG: join(home, 'other.json') } })).code).toBe('ROUTE_CHANGED')
  })

  it('refuses a full rendering when the route changed', async () => {
    const result = await installRules(['codex'], { yes: true, environment: { ...env, OPENAI_BASE_URL: 'https://proxy.example.test/v1' } })
    expect(result.code).toBe('ROUTE_CHANGED')
    expect(existsSync(target.codex())).toBe(false)
  })

  it('writes a full rendering on any installed app version, and refuses it only while the version cannot be read', async () => {
    stub('codex', 'echo "codex-cli"')
    const refused = await installRules(['codex', 'opencode'], { yes: true, environment: env })
    expect(refused).toMatchObject({ code: 'ROUTE_CHANGED', message: expect.stringContaining('Codex is not installed, or its version cannot be read') })
    expect(refused.message).toContain('install the app or put it on PATH, or keep the public sections only')
    expect(existsSync(target.codex())).toBe(false)
    expect(existsSync(target.opencode())).toBe(false)
    // A public rendering carries nothing private, so the app need not be there for it.
    expect(await installRules(['opencode'], { yes: true, environment: env })).toMatchObject({ code: 'OK', written: [{ harness: 'opencode', kind: 'public' }] })
    // A version newer than the ones BMN tested is supported like any other (owner decision 2026-10-10).
    stub('codex', 'echo "codex-cli 0.170.0"')
    expect(await installRules(['codex'], { yes: true, environment: env })).toMatchObject({ code: 'OK', written: [{ harness: 'codex', kind: 'full' }] })
    expect(readFileSync(target.codex(), 'utf8')).toContain('PRIVATE-SENTINEL')
  })

  it('never rests a full rendering on the owner\'s word: a declared destination installs the public rendering, uninspected', async () => {
    approve(edit(EXAMPLE, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: owner-declared}'))
    // The app now resolves to a proxy: nothing private is written for it, so nothing needs inspecting.
    const result = await installRules(['codex'], { yes: true, environment: { ...env, OPENAI_BASE_URL: 'https://proxy.example.test/v1' } })
    expect(result).toMatchObject({ code: 'OK', written: [{ harness: 'codex', kind: 'public' }] })
    expect(readFileSync(target.codex(), 'utf8')).not.toContain('PRIVATE-SENTINEL')
  })

  it('stops after a failure, keeps the manifest and restores what changed', async () => {
    mkdirSync(join(home, '.claude'))
    symlinkSync(join(home, 'elsewhere.md'), target.claude())
    const result = await installRules(['claude', 'codex', 'opencode'], { yes: true, environment: env, beforeTarget: (_harness: string, index: number) => { if (index === 2) throw new Error('disk full') } })
    expect(result).toMatchObject({ code: 'INSTALL_FAILED', written: [{ harness: 'claude' }, { harness: 'codex' }] })
    expect(existsSync(target.opencode())).toBe(false)
    expect((await restoreTransaction(result.transaction!, { yes: true })).code).toBe('OK')
    expect(readlinkSync(target.claude())).toBe(join(home, 'elsewhere.md'))
    expect(existsSync(target.codex())).toBe(false)
  })

  it('plans again after the confirmation and writes nothing when the plan changed meanwhile', async () => {
    const result = await installRules(['codex'], { yes: true, environment: env,
      afterConfirm: () => writeMasterFile(MASTER.replace('Plain rule for everyone.', 'Changed while the owner read the diff.')) })
    expect(result).toMatchObject({ code: 'REVISION_CONFLICT', transaction: null, written: [] })
    expect(existsSync(target.codex())).toBe(false)
    expect(existsSync(join(home, '.config/bmn/agents/state/rules/transactions'))).toBe(false)
  })

  describe('a link on the way to a rules file (R60-NFR2)', () => {
    const stores = () => ({ a: join(home, 'store-a'), b: join(home, 'store-b') })
    /** `~/.codex` is a link to one folder; a second folder holds the same bytes. */
    function linkedCodex(text: string | null): void {
      const { a, b } = stores()
      for (const store of [a, b]) {
        mkdirSync(store)
        if (text !== null) writeFileSync(join(store, 'AGENTS.md'), text)
      }
      symlinkSync(a, join(home, '.codex'))
    }
    function retarget(): void {
      rmSync(join(home, '.codex'))
      symlinkSync(stores().b, join(home, '.codex'))
    }

    it('shows where the write would land and refuses once the link leads elsewhere, though the bytes there are the same', async () => {
      linkedCodex('Written by hand.\n')
      const shown = JSON.parse((await runCli(['rules', 'install', 'codex', '--plan', '--json'])).stdout)
      expect(shown.targets[0]).toMatchObject({ path: target.codex(), resolved_path: join(stores().a, 'AGENTS.md') })
      // Between the diff and the answer.
      expect(await installRules(['codex'], { yes: true, environment: env, afterConfirm: retarget })).toMatchObject({ code: 'REVISION_CONFLICT', written: [] })
      expect(readFileSync(join(stores().b, 'AGENTS.md'), 'utf8')).toBe('Written by hand.\n')
      // Between the last plan and the write itself.
      rmSync(join(home, '.codex'))
      symlinkSync(stores().a, join(home, '.codex'))
      const late = await installRules(['codex'], { yes: true, environment: env, beforeTarget: retarget })
      expect(late).toMatchObject({ code: 'INSTALL_FAILED', written: [] })
      expect(late.message).toContain('REVISION_CONFLICT')
      for (const store of Object.values(stores())) expect(readFileSync(join(store, 'AGENTS.md'), 'utf8')).toBe('Written by hand.\n')
    })

    it('binds a link above folders that do not exist yet', async () => {
      const { a, b } = stores()
      for (const store of [a, b]) mkdirSync(store)
      symlinkSync(a, join(home, '.cursor'))
      const shown = JSON.parse((await runCli(['rules', 'install', 'cursor', '--plan', '--json'])).stdout)
      expect(shown.targets[0]).toMatchObject({ path: target.cursor(), resolved_path: join(a, 'rules/bmn-global-rules.mdc') })
      const moved = await installRules(['cursor'], { yes: true, environment: env, afterConfirm: () => { rmSync(join(home, '.cursor')); symlinkSync(b, join(home, '.cursor')) } })
      expect(moved).toMatchObject({ code: 'REVISION_CONFLICT', written: [] })
      expect(readdirSync(b)).toEqual([])
      // Unmoved, the same install creates the folder and writes where it said it would.
      rmSync(join(home, '.cursor'))
      symlinkSync(a, join(home, '.cursor'))
      expect((await installRules(['cursor'], { yes: true, environment: env })).code).toBe('OK')
      expect(existsSync(join(a, 'rules/bmn-global-rules.mdc'))).toBe(true)
    })

    it('a restore shown for one folder never lands in another', async () => {
      linkedCodex(null)
      const installed = await installRules(['codex'], { yes: true, environment: env })
      expect(installed.code).toBe('OK')
      cpSync(join(stores().a, 'AGENTS.md'), join(stores().b, 'AGENTS.md'))
      const plan = await restoreTransaction(installed.transaction!, { planOnly: true })
      expect(plan.targets?.[0]).toMatchObject({ path: target.codex(), resolved_path: join(stores().a, 'AGENTS.md') })
      retarget()
      expect(await restoreTransaction(installed.transaction!, { yes: true, expectedPlanHash: plan.plan_hash! })).toMatchObject({ code: 'REVISION_CONFLICT' })
      expect(existsSync(join(stores().b, 'AGENTS.md'))).toBe(true)
    })
  })

  it('gives every transaction its own id and manifest, even two in the same second of one process', async () => {
    const now = new Date('2026-10-10T12:00:00.000Z')
    const first = await installRules(['codex'], { yes: true, environment: env, now })
    const firstText = readFileSync(target.codex(), 'utf8')
    writeMasterFile(MASTER.replace('Plain rule for everyone.', 'Plain rule, second version.'))
    const second = await installRules(['codex'], { yes: true, environment: env, now })
    expect([first.code, second.code]).toEqual(['OK', 'OK'])
    expect(second.transaction).not.toBe(first.transaction)
    expect(readdirSync(join(home, '.config/bmn/agents/state/rules/transactions')).sort()).toEqual([first.transaction, second.transaction].sort())
    // Each manifest still holds its own prior state: undoing them in turn walks back both steps.
    expect((await restoreTransaction(second.transaction!, { yes: true })).code).toBe('OK')
    expect(readFileSync(target.codex(), 'utf8')).toBe(firstText)
    expect((await restoreTransaction(first.transaction!, { yes: true })).code).toBe('OK')
    expect(existsSync(target.codex())).toBe(false)
  })

  it('needs a TTY or --yes, and writes nothing otherwise', async () => {
    const result = await runCli(['rules', 'install', 'codex'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CONFIRMATION_REQUIRED')
    expect(existsSync(target.codex())).toBe(false)
  })
})

/** The master as `pathState` reports it while it holds `text`. */
const masterState = (text: string): PathState => ({ kind: 'file', text, mode: 0o644, directory: join(home, '.config/bmn/agents') })

describe('master history (60.4 AC4)', () => {
  it('lists source snapshots and writes one back as a new revision', async () => {
    await installRules(['codex'], { yes: true, environment: env })
    const changed = MASTER.replace('Plain rule for everyone.', 'Plain rule, second version.')
    writeMaster(masterState(MASTER), changed, 'panel save')
    expect(masterHistory().map((entry: { revision: number; reason: string }) => [entry.revision, entry.reason])).toEqual([[1, expect.stringMatching(/^install /)], [2, 'panel save']])
    const reverted = await runCli(['rules', 'revert-master', '1', '--yes'])
    expect(reverted.code, reverted.stderr).toBe(0)
    expect(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')).toBe(MASTER)
    // Reverting to an identical source adds no duplicate snapshot; a rendering is never a snapshot.
    expect(masterHistory().every((entry: { hash: string }) => entry.hash !== sha256(readFileSync(target.codex(), 'utf8')))).toBe(true)
  })

  it('exits 13 and writes nothing when history is absent or corrupt', async () => {
    expect((await runCli(['rules', 'history'])).code).toBe(13)
    await installRules(['codex'], { yes: true, environment: env })
    writeFileSync(join(home, '.config/bmn/agents/state/rules/master-history/index.json'), '{not json')
    const before = readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')
    expect((await runCli(['rules', 'revert-master', '1', '--yes'])).code).toBe(13)
    expect(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')).toBe(before)
  })

  it('keeps a master edited outside BMN as a snapshot before a save replaces it', async () => {
    await installRules(['codex'], { yes: true, environment: env })
    const outside = MASTER.replace('Plain rule for everyone.', 'Edited by hand, never snapshotted.')
    writeMasterFile(outside)
    writeMaster(masterState(outside), MASTER.replace('Plain rule for everyone.', 'Saved from the panel.'), 'panel save')
    const history = masterHistory()
    expect(history.map((entry: { reason: string }) => entry.reason)).toEqual([expect.stringMatching(/^install /), 'before panel save', 'panel save'])
    expect(history[1]?.hash).toBe(sha256(outside))
  })

  it('refuses a save before writing when the history cannot record the text it replaces', async () => {
    await installRules(['codex'], { yes: true, environment: env })
    writeFileSync(join(home, '.config/bmn/agents/state/rules/master-history/index.json'), '{not json')
    expect(() => writeMaster(masterState(MASTER), MASTER.replace('Plain', 'New'), 'panel save')).toThrow(/history/)
    expect(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')).toBe(MASTER)
  })

  it('refuses to write a master that would not render', () => {
    expect(() => writeMaster(masterState(MASTER), '<!-- bmn:public -->\nunclosed', 'bad')).toThrow(/would not render/)
    expect(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')).toBe(MASTER)
  })
})

describe('CLI (60.4)', () => {
  it('render prints the exact file and names its form; a missing or invalid master exits 3 or 4 before any target', async () => {
    const rendered = await runCli(['rules', 'render', 'opencode'])
    expect(rendered.code).toBe(0)
    expect(rendered.stdout).toBe(render(readMaster(), 'opencode', generation()).text)
    expect(rendered.stderr).toContain('public rendering (OpenCode Go gets public work only); team: names by app')
    expect((await runCli(['rules', 'render', 'codex'])).stderr).toContain('full rendering (OpenAI may see private work)')
    expect((await runCli(['rules', 'render', 'gemini'])).code).toBe(4)
    writeMasterFile('<!-- bmn:public -->\nunclosed')
    const invalid = await runCli(['rules', 'check', '--json'])
    expect(invalid.code).toBe(4)
    expect(JSON.parse(invalid.stdout).errors[0].line).toBe(1)
    rmSync(join(home, '.config/bmn/agents/global-rules.md'))
    expect((await runCli(['rules', 'check'])).code).toBe(3)
  })

  it('imports a rules file once, changing only the named sentences', async () => {
    rmSync(join(home, '.config/bmn/agents/global-rules.md'))
    const source = [
      '# Global rules', '',
      'Source: `~/.claude/CLAUDE.md`; `~/.codex/AGENTS.md` is a symlink to it. Load skills only for the matching task.', '',
      '## Team',
      'You are one of the agents. The team: Claude Code (Fable, Opus, Sonnet), Codex (Astra, Sol, Luna), BMN (the terminal) and the vault. Model roster, effort levels, safe dispatch commands and limits: `models.md`. Both apps must behave the same; change rules, skills and hooks for both.', '',
      '## Other', 'A rule that stays (see Source: elsewhere).', ''
    ].join('\n')
    const imported = importedMaster(source, '## OpenCode\n- use the guardrails\n')
    expect(imported.text).toBe([
      '# Global rules', '',
      'Load skills only for the matching task.', '',
      '## Team',
      "You are one of the agents. The team: <!-- bmn:team -->, BMN (the terminal) and the vault. Safe dispatch commands: `models.md`. Both apps must behave the same; change rules in BMN's master, and skills and hooks, for both.", '',
      '## Other', 'A rule that stays (see Source: elsewhere).', '',
      '<!-- bmn:apps opencode -->', '## OpenCode', '- use the guardrails', '<!-- /bmn:apps -->', ''
    ].join('\n'))
    expect(imported.changes).toEqual(['the opening Source: sentence is dropped', "rules are changed in BMN's master", 'the pointer to the agent table narrows to dispatch commands',
      'the agent list in the Team section becomes the team placeholder', 'the OpenCode lines become an opencode section'])
    expect(parseMaster(imported.text).errors).toEqual([])
    // A file with none of the named sentences comes through unchanged, with the placeholder closing its Team section.
    expect(importedMaster('# Rules\n\n## Team\nThe team: A, B and C.\n\n## Other\nrule\n', null)).toEqual({
      text: '# Rules\n\n## Team\nThe team: A, B and C.\n\n<!-- bmn:team -->\n\n## Other\nrule\n', changes: ['the team placeholder is added at the end of the Team section'] })
    expect(importedMaster('# Rules\n\nno team here\n', '  ')).toEqual({ text: '# Rules\n\nno team here\n', changes: [] })

    writeFileSync(join(home, 'claude-rules.md'), source)
    const first = await runCli(['rules', 'import', '--from', join(home, 'claude-rules.md'), '--yes'])
    expect(first.code, first.stderr).toBe(0)
    expect(first.stderr).toContain('  the opening Source: sentence is dropped')
    const master = readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')
    expect(master).toBe(importedMaster(source, null).text)
    const again = await runCli(['rules', 'import', '--from', join(home, 'claude-rules.md'), '--yes'])
    expect(again.code).toBe(10)
    expect(again.stderr).toContain('MASTER_EXISTS')
    expect(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8')).toBe(master)
  })
})

function runCli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr }))
    child.stdin?.end()
  })
}

describe('probes (60.4 AC5)', () => {
  beforeEach(async () => {
    await installRules(['claude', 'codex', 'opencode', 'cursor'], { yes: true, environment: env })
  })

  it('Claude passes when it quotes the rendered hash with tools off, fails on another', async () => {
    stub('claude', `case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; grep -o 'master sha256 [0-9a-f]*' "$HOME/.claude/CLAUDE.md" | cut -d' ' -f3;; esac`)
    const result = await probe('claude', { environment: env })
    expect(result).toMatchObject({ outcome: 'pass', version: '2.1.295' })
    stub('claude', 'case "$1" in --version) echo "2.1.295";; *) cat > /dev/null; echo 0000000000000000000000000000000000000000000000000000000000000000;; esac')
    expect((await probe('claude', { environment: env })).outcome).toBe('fail')
    stub('claude', 'case "$1" in --version) echo "2.1.295";; *) cat > /dev/null; echo "I cannot tell";; esac')
    expect((await probe('claude', { environment: env })).outcome).toBe('inconclusive')
  })

  it('Codex reads the injected instructions from its own probe rollout', async () => {
    stub('codex', `case "$1" in --version) echo "codex-cli 0.161.0";; exec) cwd="$4"; d="$HOME/.codex/sessions/2026/10/09"; mkdir -p "$d"; cat > /dev/null
      printf '{"type":"session_meta","payload":{"cwd":"%s"}}\\n{"type":"instructions","text":"%s"}\\n' "$cwd" "$(head -1 "$HOME/.codex/AGENTS.md" | sed 's/"/ /g')" > "$d/rollout-probe.jsonl";; esac`)
    expect(await probe('codex', { environment: env })).toMatchObject({ outcome: 'pass', version: '0.161.0', host: expect.any(String) })
    expect(lastProbes().find((entry: { harness: string }) => entry.harness === 'codex')).toMatchObject({ outcome: 'pass', stale: false })
    writeMasterFile(MASTER.replace('Plain rule for everyone.', 'Changed.'))
    expect(lastProbes().find((entry: { harness: string }) => entry.harness === 'codex')).toMatchObject({ stale: true })
  })

  it('a hash the rollout shows only after a tool ran is no evidence: the agent may have read the file', async () => {
    stub('codex', `case "$1" in --version) echo "codex-cli 0.161.0";; exec) cwd="$4"; d="$HOME/.codex/sessions/2026/10/09"; mkdir -p "$d"; cat > /dev/null
      printf '{"type":"session_meta","payload":{"cwd":"%s"}}\\n{"type":"response_item","payload":{"type":"function_call","name":"shell"}}\\n{"type":"response_item","payload":{"type":"function_call_output","output":"%s"}}\\n' "$cwd" "$(head -1 "$HOME/.codex/AGENTS.md" | sed 's/"/ /g')" > "$d/rollout-probe.jsonl";; esac`)
    expect(await probe('codex', { environment: env })).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('before any tool ran') })
  })

  it('reinspects the destination before sending and refuses when it moved; nothing runs', async () => {
    stub('codex', `case "$1" in --version) echo "codex-cli 0.161.0";; *) touch "$HOME/codex-ran";; esac`)
    const moved = await probe('codex', { environment: { ...env, OPENAI_BASE_URL: 'https://proxy.example.test/v1' } })
    expect(moved).toMatchObject({ outcome: 'unavailable', detail: expect.stringContaining('refused') })
    expect(existsSync(join(home, 'codex-ran'))).toBe(false)
  })

  it('an earlier probe is stale once the harness version or its destination changes', async () => {
    stub('claude', `case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; grep -o 'master sha256 [0-9a-f]*' "$HOME/.claude/CLAUDE.md" | cut -d' ' -f3;; esac`)
    const passed = await probe('claude', { environment: env })
    const claude = (inspect: (harness: string) => { version: string | null; host: string | null }): unknown =>
      lastProbes({ inspect }).find((entry: { harness: string }) => entry.harness === 'claude')
    const host = passed.host ?? null
    expect(claude(() => ({ version: '2.1.295', host }))).toMatchObject({ stale: false })
    expect(claude(() => ({ version: '2.1.296', host }))).toMatchObject({ stale: true })
    expect(claude(() => ({ version: '2.1.295', host: 'proxy.example.test' }))).toMatchObject({ stale: true })
  })

  it('runs the test on an app version newer than the ones BMN tested', async () => {
    await installRules(['claude'], { yes: true, environment: env })
    stub('claude', `case "$1" in --version) echo "2.1.296 (Claude Code)";; *) touch "$HOME/claude-ran";; esac`)
    const result = await probe('claude', { environment: env })
    expect(result).toMatchObject({ version: '2.1.296' })
    expect(result.outcome).not.toBe('unavailable')
    expect(existsSync(join(home, 'claude-ran'))).toBe(true)
  })

  it('a probe goes stale through the app\'s own version inspector once the harness that runs is replaced', async () => {
    const shadow = join(home, 'shadow')
    mkdirSync(shadow)
    writeFileSync(join(shadow, 'claude'), 'not a program\n', { mode: 0o644 })
    const environment = { ...env, PATH: `${shadow}:${env.PATH}` }
    stub('claude', `case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; grep -o 'master sha256 [0-9a-f]*' "$HOME/.claude/CLAUDE.md" | cut -d' ' -f3;; esac`)
    expect(await probe('claude', { environment })).toMatchObject({ outcome: 'pass' })
    const claude = async (): Promise<unknown> => lastProbes({ inspect: await probeInspector(environment) }).find((entry: { harness: string }) => entry.harness === 'claude')
    expect(await claude()).toMatchObject({ stale: false })
    rmSync(join(stubs, 'claude'))
    stub('claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; esac')
    expect(await claude()).toMatchObject({ stale: true })
  })

  it('is unavailable where the destination gets public work only or the CLI is missing, and leaves no throwaway folder', async () => {
    stub('opencode', 'echo "1.18.32"')
    expect(await probe('opencode', { environment: env })).toMatchObject({ outcome: 'unavailable', detail: 'OpenCode Go gets public work only; a loading test would send the rules to that provider' })
    expect((await probe('cursor', { environment: env })).outcome).toBe('unavailable')
    expect(readFileSync(join(home, '.config/bmn/agents/state/probes.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
    expect(existsSync(join(home, '.bmn-rules-probe-'))).toBe(false)
  })
})

describe('an approval that changes the Team phrase (60.4 AC6)', () => {
  const ALL = ['claude', 'codex', 'opencode', 'cursor'] as const
  /** Luna switched off: the Team phrase loses one name. */
  const WITHOUT_LUNA = edit(EXAMPLE, 'provider: openai\nhost: default\nenabled: true\nstatus: active\nefforts: [max]', 'provider: openai\nhost: default\nenabled: false\nstatus: active\nefforts: [max]')
  const NEW_TEAM = TEAM.replace('Sol, Astra, Luna', 'Sol, Astra')
  const states = () => Object.fromEntries(checkTargets(env).map((entry: { harness: string; state: string }) => [entry.harness, entry.state]))

  beforeEach(async () => {
    // The public section names the team too, so the public renderings move with it.
    writeMasterFile(MASTER.replace('Answer first, plainly.', 'Answer first, plainly. Ask <!-- bmn:team --> for help.').replace('The team: <!-- bmn:team -->, and the owner.', 'The team is in the roster.'))
    expect((await installRules([...ALL], { yes: true, environment: env })).code).toBe('OK')
  })

  it("leaves a full rendering alone while its app's version cannot be read", async () => {
    stub('codex', 'echo "codex-cli"')
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    expect(plan.targets.map((entry: { harness: string }) => entry.harness)).toEqual(['claude', 'opencode', 'cursor'])
  })

  it('skips a shown full rendering whose app changed version before the write', async () => {
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    approve(WITHOUT_LUNA)
    stub('codex', 'echo "codex-cli 0.170.0"')
    const before = readFileSync(target.codex(), 'utf8')
    expect(await applyTeamUpdate(plan.targets, { environment: env })).toMatchObject({ code: 'OK', skipped: ['codex'], written: [{ harness: 'claude' }, { harness: 'opencode' }, { harness: 'cursor' }] })
    expect(readFileSync(target.codex(), 'utf8')).toBe(before)
  })

  it('rewrites exactly the current targets, as one transaction with Undo', async () => {
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    expect(plan.targets.map((entry: { harness: string }) => entry.harness)).toEqual([...ALL])
    expect(plan.targets[1]).toMatchObject({ harness: 'codex', path: target.codex(), kind: 'full' })
    expect(plan.targets[1]?.diff).toContain(`+Answer first, plainly. Ask ${NEW_TEAM} for help.`)
    // Nothing is written by planning, and nothing before the approval.
    expect(states()).toEqual({ claude: 'current', codex: 'current', opencode: 'current', cursor: 'current' })
    approve(WITHOUT_LUNA)
    expect(states()).toEqual({ claude: 'stale', codex: 'stale', opencode: 'stale', cursor: 'stale' })
    const result = await applyTeamUpdate(plan.targets, { environment: env })
    expect(result).toMatchObject({ code: 'OK', skipped: [], written: ALL.map((harness) => ({ harness })) })
    expect(states()).toEqual({ claude: 'current', codex: 'current', opencode: 'current', cursor: 'current' })
    expect(readFileSync(target.opencode(), 'utf8')).toContain(NEW_TEAM)
    expect((await restoreTransaction(result.transaction!, { yes: true })).code).toBe('OK')
    expect(readFileSync(target.opencode(), 'utf8')).toContain(TEAM)
    expect(states()).toEqual({ claude: 'stale', codex: 'stale', opencode: 'stale', cursor: 'stale' })
  })

  it('leaves alone an edited-outside file, a link, a missing file and a file stale for another reason', async () => {
    writeFileSync(target.claude(), `${readFileSync(target.claude(), 'utf8')}an outside line\n`)
    const elsewhere = join(home, 'elsewhere.md')
    writeFileSync(elsewhere, readFileSync(target.codex(), 'utf8'))
    rmSync(target.codex())
    symlinkSync(elsewhere, target.codex())
    rmSync(target.cursor())
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    expect(plan.targets.map((entry: { harness: string }) => entry.harness)).toEqual(['opencode'])
    // A master edit makes every file stale for a reason that is not the Team phrase.
    writeMasterFile(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8').replace('Plain rule for everyone.', 'Plain rule, changed.'))
    expect((await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })).targets).toEqual([])
  })

  it('skips a target whose kind would change, and one whose destination no longer inspects as approved', async () => {
    const publicOnly = edit(WITHOUT_LUNA, 'hosts: [api.openai.com], sites: [openai.com], private_work: allowed', 'hosts: [api.openai.com], sites: [openai.com], private_work: public_only')
    expect((await planTeamUpdate(dataOf(publicOnly), { environment: env })).targets.map((entry: { harness: string }) => entry.harness)).toEqual(['claude', 'opencode', 'cursor'])
    const moved = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: { ...env, OPENAI_BASE_URL: 'https://proxy.example.test/v1' } })
    expect(moved.targets.map((entry: { harness: string }) => entry.harness)).toEqual(['claude', 'opencode', 'cursor'])
  })

  it('rechecks each binding right before writing: a file, the master or a destination changed since Review is skipped', async () => {
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    approve(WITHOUT_LUNA)
    writeFileSync(target.claude(), `${readFileSync(target.claude(), 'utf8')}edited between Review and write\n`)
    const result = await applyTeamUpdate(plan.targets, { environment: { ...env, OPENAI_BASE_URL: 'https://proxy.example.test/v1' } })
    expect(result).toMatchObject({ code: 'OK', skipped: ['claude', 'codex'], written: [{ harness: 'opencode' }, { harness: 'cursor' }] })
    expect(readFileSync(target.claude(), 'utf8')).toContain('edited between Review and write')
    expect(readFileSync(target.codex(), 'utf8')).toContain(TEAM)
    // The master changed: every proposed file differs from the one shown, so nothing is written.
    const later = await planTeamUpdate(dataOf(EXAMPLE), { environment: env })
    approve(EXAMPLE)
    writeMasterFile(readFileSync(join(home, '.config/bmn/agents/global-rules.md'), 'utf8').replace('Plain rule for everyone.', 'Plain rule, changed.'))
    expect(await applyTeamUpdate(later.targets, { environment: env })).toMatchObject({ transaction: null, written: [], skipped: later.targets.map((entry: { harness: string }) => entry.harness) })
  })

  it('skips a shown target once a link on the way to it leads to another folder holding the same bytes', async () => {
    const stores = { a: join(home, 'store-a'), b: join(home, 'store-b') }
    renameSync(join(home, '.codex'), stores.a)
    cpSync(stores.a, stores.b, { recursive: true })
    symlinkSync(stores.a, join(home, '.codex'))
    expect(states().codex).toBe('current')
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    expect(plan.targets.find((entry: { harness: string }) => entry.harness === 'codex')).toMatchObject({ path: target.codex(), resolved_path: join(stores.a, 'AGENTS.md') })
    approve(WITHOUT_LUNA)
    rmSync(join(home, '.codex'))
    symlinkSync(stores.b, join(home, '.codex'))
    expect(await applyTeamUpdate(plan.targets, { environment: env })).toMatchObject({ code: 'OK', skipped: ['codex'], written: [{ harness: 'claude' }, { harness: 'opencode' }, { harness: 'cursor' }] })
    for (const store of Object.values(stores)) expect(readFileSync(join(store, 'AGENTS.md'), 'utf8')).toContain(TEAM)
  })

  it('binds the whole inspection: another app version or another deciding source skips the target', async () => {
    expect(states().codex).toBe('current')
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    expect(plan.targets.map((entry: { harness: string }) => entry.harness)).toEqual([...ALL])
    approve(WITHOUT_LUNA)
    const only = (harness: string) => plan.targets.filter((entry: { harness: string }) => entry.harness === harness)
    // Still Codex's own servers, but a setting now says so where nothing did when the plan was shown.
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "openai"\n')
    expect(await applyTeamUpdate(only('codex'), { environment: env })).toMatchObject({ transaction: null, written: [], skipped: ['codex'] })
    rmSync(join(home, '.codex/config.toml'))
    // A supported version, but not the one inspected for the plan.
    stub('codex', 'echo "codex-cli 0.170.0"')
    expect(await applyTeamUpdate(only('codex'), { environment: env })).toMatchObject({ transaction: null, written: [], skipped: ['codex'] })
    stub('codex', 'echo "codex-cli 0.161.0"')
    expect((await applyTeamUpdate(only('codex'), { environment: env })).written).toEqual([{ harness: 'codex', path: target.codex(), kind: 'full' }])
  })

  it('never writes beyond what was shown, and nothing when nothing was shown or another roster was approved', async () => {
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    approve(WITHOUT_LUNA)
    expect(await applyTeamUpdate([], { environment: env })).toEqual({ code: 'OK', transaction: null, written: [], skipped: [] })
    const onlyCodex = await applyTeamUpdate(plan.targets.filter((entry: { harness: string }) => entry.harness === 'codex'), { environment: env })
    expect(onlyCodex.written).toEqual([{ harness: 'codex', path: target.codex(), kind: 'full' }])
    expect(states()).toEqual({ claude: 'stale', codex: 'current', opencode: 'stale', cursor: 'stale' })
    // The roster approved is not the one the bindings were shown for: the proposed bytes differ.
    approve(edit(WITHOUT_LUNA, 'name: Astra', 'name: Astra2'))
    expect((await applyTeamUpdate(plan.targets, { environment: env })).written).toEqual([])
  })

  it('stops after a failure part-way, reports what changed and keeps the manifest for rollback', async () => {
    const plan = await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })
    approve(WITHOUT_LUNA)
    const result = await applyTeamUpdate(plan.targets, { environment: env, beforeTarget: (_harness: string, index: number) => { if (index === 2) throw new Error('disk full') } })
    expect(result).toMatchObject({ code: 'INSTALL_FAILED', written: [{ harness: 'claude' }, { harness: 'codex' }] })
    expect(states()).toEqual({ claude: 'current', codex: 'current', opencode: 'stale', cursor: 'stale' })
    expect((await restoreTransaction(result.transaction!, { yes: true })).code).toBe('OK')
    expect(readFileSync(target.claude(), 'utf8')).toContain(TEAM)
  })

  it('plans nothing when the approval leaves the Team phrase alone, or there is no master', async () => {
    const sameTeam = edit(EXAMPLE, 'pre-reviewer: {candidates: [luna@max], then: skip}\nepic', 'pre-reviewer: {candidates: [luna@max], then: lead}\nepic')
    expect(await planTeamUpdate(dataOf(sameTeam), { environment: env })).toEqual({ targets: [] })
    rmSync(join(home, '.config/bmn/agents/global-rules.md'))
    expect(await planTeamUpdate(dataOf(WITHOUT_LUNA), { environment: env })).toEqual({ targets: [] })
  })

  it('a loading test goes stale when the Team phrase in the tested file changes', async () => {
    stub('claude', `case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; grep -o 'master sha256 [0-9a-f]*' "$HOME/.claude/CLAUDE.md" | cut -d' ' -f3;; esac`)
    expect(await probe('claude', { environment: env })).toMatchObject({ outcome: 'pass' })
    expect(lastProbes().find((entry: { harness: string }) => entry.harness === 'claude')).toMatchObject({ stale: false })
    approve(WITHOUT_LUNA)
    expect(lastProbes().find((entry: { harness: string }) => entry.harness === 'claude')).toMatchObject({ stale: true })
  })
})

describe('the panel binds install and restore to the plan it showed (60.6 AC4)', () => {
  it('a plan names each target\'s change; a stale plan hash writes nothing; the shown one installs and restores', async () => {
    mkdirSync(join(home, 'dotfiles'))
    writeFileSync(join(home, 'dotfiles/CLAUDE.md'), '# kept elsewhere\n')
    mkdirSync(join(home, '.claude'))
    symlinkSync(join(home, 'dotfiles/CLAUDE.md'), target.claude())
    mkdirSync(join(home, '.codex'))
    writeFileSync(target.codex(), '# by hand\n')
    const planned = await runCli(['rules', 'install', '--plan', '--json'])
    const plan = JSON.parse(planned.stdout)
    expect(plan.code).toBe('OK')
    expect(Object.fromEntries(plan.targets.map((entry: { harness: string; change: string }) => [entry.harness, entry.change])))
      .toEqual({ claude: 'link', codex: 'unmanaged', opencode: 'missing', cursor: 'missing' })
    expect(existsSync(target.opencode())).toBe(false)

    writeFileSync(target.codex(), '# by hand, changed after the plan was shown\n')
    const stale = JSON.parse((await runCli(['rules', 'install', '--expect-plan', plan.plan_hash, '--yes', '--json'])).stdout)
    expect(stale.code).toBe('REVISION_CONFLICT')
    expect(lstatSync(target.claude()).isSymbolicLink()).toBe(true)
    expect(existsSync(target.opencode())).toBe(false)

    const fresh = JSON.parse((await runCli(['rules', 'install', '--plan', '--json'])).stdout)
    const installed = JSON.parse((await runCli(['rules', 'install', '--expect-plan', fresh.plan_hash, '--yes', '--json'])).stdout)
    expect(installed.code).toBe('OK')
    expect(lstatSync(target.claude()).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(home, 'dotfiles/CLAUDE.md'), 'utf8')).toBe('# kept elsewhere\n')

    const restorePlan = JSON.parse((await runCli(['rules', 'restore', '--transaction', installed.transaction, '--plan', '--json'])).stdout)
    expect(restorePlan.targets.find((entry: { harness: string }) => entry.harness === 'claude').change).toBe('link')
    expect((await runCli(['rules', 'restore', '--transaction', installed.transaction, '--expect-plan', '0'.repeat(64), '--yes', '--json'])).stdout)
      .toContain('REVISION_CONFLICT')
    const restored = await runCli(['rules', 'restore', '--transaction', installed.transaction, '--expect-plan', restorePlan.plan_hash, '--yes', '--json'])
    expect(JSON.parse(restored.stdout).code).toBe('OK')
    expect(readlinkSync(target.claude())).toBe(join(home, 'dotfiles/CLAUDE.md'))
    expect(readFileSync(target.codex(), 'utf8')).toBe('# by hand, changed after the plan was shown\n')
  })
})
