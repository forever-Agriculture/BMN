// MODULE: agents-role-check.test.ts - Story 63.2: the check holds a dispatch to its role: the efforts the role names, and no write access for a read-only role
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_READ_ONLY_TESTED, CLAUDE_READ_ONLY_TOOLS, READ_ONLY_ITEMS, evaluate, readCodexConfig, verifyReceipt } from '../../bin/agents-check.mjs'
import { machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { parseRoster, readOnlyProposal, readOnlyProposed, rewriteRoster, roleChain, roleChainText, roleEfforts } from '../../bin/agents-roster.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const NOW = new Date('2026-10-11T12:00:00.000Z')

let home: string
let stubs: string
let workspace: string
let env: Record<string, string>
const savedHome = process.env.HOME

function edit(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
  return text.replace(from, to)
}

/** The example team with BMN's proposal approved: every role ending in `reviewer`, and the consultant, held to read-only. */
function held(text = EXAMPLE): string {
  const marked = text.replace(/^((?:[a-z-]*reviewer|consultant): \{.*)\}$/gm, '$1, read_only: true}')
  if (marked.split('read_only: true').length !== 7) throw new Error('fixture: six roles are held to read-only')
  return marked
}

function approve(text: string): void {
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

function stub(name: string, version: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\necho "${version}"\n`)
  chmodSync(join(stubs, name), 0o755)
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-role-check-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stub('codex', 'codex-cli 0.161.0')
  stub('claude', '2.1.295 (Claude Code)')
  workspace = join(home, 'work')
  mkdirSync(workspace, { recursive: true })
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

type Inputs = Parameters<typeof evaluate>[0]

/** A Codex command for one agent: its model and effort, then what the test adds, then the prompt from stdin. */
const codex = (model: string, effort: string, ...extra: string[]): string[] => ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', model, '-c', `model_reasoning_effort=${effort}`, ...extra, '-']
const ASTRA = (effort: string, ...extra: string[]): string[] => codex('gpt-6-astra', effort, ...extra)
const READ_ONLY = ['--sandbox', 'read-only', '-c', 'approval_policy="never"']
/** A Claude Code command for Fable at medium, then what the test adds. */
const FABLE = (...extra: string[]): string[] => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'claude-fable-5-1', '--effort', 'medium', ...extra]
const NO_MCP = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']

function check(agent: string, role: string, argv: string[]) {
  return evaluate({ agent, role, workspace, data: 'private', cwd: workspace, argv } as Inputs, { environment: env, cwd: workspace, now: NOW })
}
/** PASS, or the refusal's code with its message. */
function answer(agent: string, role: string, argv: string[]): string {
  const result = check(agent, role, argv)
  return result.verdict === 'PASS' ? 'PASS' : `${result.code}: ${result.message}`
}
const config = (text: string): void => {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex/config.toml'), text)
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...env }, cwd: workspace }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
    })
  })
}

describe('a role allows only the efforts it names for an agent (63.2 AC1)', () => {
  it('refuses an effort the agent has but the role does not name, and says which the role allows', () => {
    approve(EXAMPLE)
    // epic-reviewer: astra@medium, with low for a recheck and for small work; Astra itself also lists high.
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', ...READ_ONLY))).toBe('PASS')
    expect(answer('astra', 'epic-reviewer', ASTRA('low', ...READ_ONLY))).toBe('PASS')
    const refused = check('astra', 'epic-reviewer', ASTRA('high', ...READ_ONLY))
    expect(refused).toMatchObject({
      verdict: 'REFUSED', code: 'EFFORT_UNSUPPORTED', detail: 'role epic-reviewer allows medium, low',
      message: '-c model_reasoning_effort high is not an effort the role epic-reviewer names for astra (medium, low)'
    })
    expect(refused.next).toContain('bmn roster role')
    // The same agent under a role that names high passes with it, and is refused the effort that role leaves out.
    expect(answer('astra', 'consultant', ASTRA('high', ...READ_ONLY))).toBe('PASS')
    expect(answer('astra', 'consultant', ASTRA('low', ...READ_ONLY))).toMatch(/^EFFORT_UNSUPPORTED: .* the role consultant names for astra \(medium, high\)$/)
    // An effort the agent does not list at all is refused as before, in the agent's words.
    expect(answer('astra', 'epic-reviewer', ASTRA('max', ...READ_ONLY))).toMatch(/^EFFORT_UNSUPPORTED: .* is not among astra's efforts/)
  })

  it('names the efforts of a candidate, of its recheck and of small work, and nothing for an agent the role does not name', () => {
    const { data } = parseRoster(EXAMPLE)
    const role = (id: string) => data!.roles.find((entry) => entry.id === id)!
    expect(roleEfforts(role('epic-reviewer'), 'astra')).toEqual(['medium', 'low'])
    expect(roleEfforts(role('final-reviewer'), 'astra')).toEqual(['high', 'low'])
    expect(roleEfforts(role('consultant'), 'fable')).toEqual(['medium', 'high'])
    expect(roleEfforts(role('lead'), 'astra')).toEqual([])
    expect(roleEfforts(role('epic-reviewer'), 'same_reviewer')).toEqual([])
  })

  it('judges an agent that holds a role without being one of its candidates by its own efforts, as before', () => {
    approve(edit(EXAMPLE, 'focused-reviewer: {candidates: [luna@max, astra@low], then: lead}', 'focused-reviewer: {candidates: [luna@max], then: lead}'))
    expect(answer('astra', 'focused-reviewer', ASTRA('high'))).toBe('PASS')
  })
})

describe('a team file from before the story reads as before (63.2 AC4)', () => {
  it('holds no role to read-only until the owner approves it, and proposes the reviewers and the consultant', () => {
    approve(EXAMPLE)
    const data = readApproved().data
    expect(data.roles.some((role) => role.read_only !== undefined)).toBe(false)
    expect(readOnlyProposal(data)).toEqual(['focused-reviewer', 'pre-reviewer', 'epic-reviewer', 'project-pre-reviewer', 'final-reviewer', 'consultant'])
    expect(['lead', 'designer', 'helper', 'browser', 'reviewer', 'consultant', 'consultants'].map(readOnlyProposed)).toEqual([false, false, false, false, true, true, false])
    // A reviewer started with write access passes, as it did, and its receipt says nothing of a sandbox.
    const result = check('astra', 'epic-reviewer', ASTRA('medium', '--sandbox', 'workspace-write'))
    expect(result.verdict).toBe('PASS')
    expect(result.receipt).not.toHaveProperty('sandbox')
    expect(roleChain(data, 'epic-reviewer')).not.toHaveProperty('read_only')
  })

  it('takes the mark through the file, the approval and what `bmn roster role` shows', async () => {
    approve(EXAMPLE)
    expect(parseRoster(edit(EXAMPLE, 'consultant: {candidates:', 'consultant: {read_only: yes, candidates:')).errors.map((error) => [error.code, error.message]))
      .toEqual([['INVALID_VALUE', '## roles.consultant: read_only must be true or false']])
    writeFileSync(join(home, '.config/bmn/agents/roster.md'), held())
    // Until he approves, the file differs from the team in effect and nothing is held.
    expect(machineDiff(readApproved().data, readValidRoster().data).filter((diff) => diff.field === 'read_only').map((diff) => `${diff.scope}:${diff.id}`))
      .toEqual(['roles:focused-reviewer', 'roles:pre-reviewer', 'roles:epic-reviewer', 'roles:project-pre-reviewer', 'roles:final-reviewer', 'roles:consultant'])
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--sandbox', 'workspace-write'))).toBe('PASS')
    approve(held())
    const data = readApproved().data
    expect(readOnlyProposal(data)).toEqual([])
    expect(data.roles.filter((role) => role.read_only === true).map((role) => role.id)).toHaveLength(6)
    // Written back from the data, the file keeps the mark.
    expect(parseRoster(rewriteRoster(held(), data)).data?.roles.find((role) => role.id === 'consultant')).toMatchObject({ read_only: true })
    expect(roleChain(data, 'epic-reviewer')).toMatchObject({ read_only: true })
    expect(roleChain(data, 'lead')).not.toHaveProperty('read_only')
    const shown = JSON.parse((await runCli(['roster', 'role', 'epic-reviewer', '--json'])).stdout)
    expect(shown).toMatchObject({ read_only: true, small_work: { agent: 'astra', read_only: { argv: READ_ONLY_ITEMS.codex } } })
    expect(shown.candidates.map((candidate: { agent: string; read_only: { argv: string[] } }) => [candidate.agent, candidate.read_only.argv]))
      .toEqual([['astra', ['--sandbox', 'read-only', '-c', 'approval_policy="never"']], ['fable', ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']]])
    const words = (await runCli(['roster', 'role', 'epic-reviewer'])).stdout
    expect(words).toContain('  read-only: a run for this role is refused unless it is started so that it cannot write')
    expect(words).toContain("    codex exec must carry: --sandbox read-only -c 'approval_policy=\"never\"'")
    expect(words).toContain("    claude -p must carry: --tools Read,Grep,Glob --strict-mcp-config --mcp-config '{\"mcpServers\":{}}'")
    expect(JSON.parse((await runCli(['roster', 'role', 'lead', '--json'])).stdout).candidates[0]).not.toHaveProperty('read_only')
    expect(roleChainText(roleChain(data, 'lead'))).not.toContain('read-only')
  })
})

describe('a Codex run for a read-only role resolves to a read-only sandbox with approvals never (63.2 AC2, AC6)', () => {
  const MUST = 'the command must carry --sandbox read-only and -c approval_policy="never"'
  beforeEach(() => approve(held()))

  it('passes the form the route documents and records the sandbox and the effort it saw', () => {
    const result = check('astra', 'epic-reviewer', ASTRA('medium', '-c', 'mcp_servers={}', ...READ_ONLY, '--json'))
    expect(result.verdict).toBe('PASS')
    expect(result.receipt).toMatchObject({ role: 'epic-reviewer', effort: 'medium', sandbox: { mode: 'read-only', source: '--sandbox', approval_policy: 'never', approval_source: '-c approval_policy' } })
    expect(result.steps.join('\n')).toContain('read-only role: sandbox read-only (--sandbox), approvals never (-c approval_policy)')
    // A later reader recomputes the same receipt from the same command, and a command that lost the sandbox no longer matches.
    writeFileSync(join(home, 'receipt.json'), JSON.stringify(result.receipt))
    expect(verifyReceipt(join(home, 'receipt.json'), ASTRA('medium', '-c', 'mcp_servers={}', ...READ_ONLY, '--json'), { environment: env, cwd: workspace, now: NOW })).toMatchObject({ ok: true })
    expect(verifyReceipt(join(home, 'receipt.json'), ASTRA('medium', '-c', 'mcp_servers={}', '--json'), { environment: env, cwd: workspace, now: NOW })).toMatchObject({ ok: false })
  })

  it('refuses write access, no sandbox named and approvals that are not never, each saying what the command must carry', () => {
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"')))
      .toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and --sandbox gives the run the workspace-write sandbox; ${MUST}`)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"')))
      .toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and -c sandbox_mode gives the run the danger-full-access sandbox; ${MUST}`)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium'))).toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and the command names no sandbox; ${MUST}`)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '-c', 'approval_policy="never"'))).toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and the command names no sandbox; ${MUST}`)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--sandbox', 'read-only')))
      .toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and nothing says the run may never ask for more access; ${MUST}`)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--sandbox', 'read-only', '-c', 'approval_policy="on-request"')))
      .toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and -c approval_policy lets the run ask for more access (on-request); ${MUST}`)
    // Two names for the sandbox that disagree, or a value BMN cannot read, resolve to nothing.
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--sandbox', 'read-only', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"')))
      .toMatch(/^READ_ONLY_REQUIRED: .* its sandbox cannot be resolved: --sandbox read-only and a -c sandbox_mode item name the sandbox twice; /)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--sandbox', 'read-only', '-c', 'approval_policy={granular={}}')))
      .toMatch(/^READ_ONLY_REQUIRED: .* whether it may ask for more access cannot be resolved: -c approval_policy has a value BMN cannot read; /)
    // The same for every role the team holds, and for the other reviewer on Codex.
    expect(answer('astra', 'consultant', ASTRA('medium', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"'))).toMatch(/^READ_ONLY_REQUIRED: consultant is a read-only role/)
    expect(answer('luna', 'pre-reviewer', codex('gpt-6-luna', 'max'))).toMatch(/^READ_ONLY_REQUIRED: pre-reviewer is a read-only role and the command names no sandbox/)
    expect(answer('luna', 'pre-reviewer', codex('gpt-6-luna', 'max', ...READ_ONLY))).toBe('PASS')
  })

  it('takes read-only from the selected profile or from the owner\'s own file, and from neither when the profile is not selected', () => {
    config('[profiles.review]\nsandbox_mode = "read-only"\napproval_policy = "never"\n')
    // Set only in a profile the command does not select: nothing names the sandbox.
    expect(answer('astra', 'epic-reviewer', ASTRA('medium'))).toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and the command names no sandbox; ${MUST}`)
    const profile = check('astra', 'epic-reviewer', ASTRA('medium', '--profile', 'review'))
    expect(profile.verdict).toBe('PASS')
    expect(profile.receipt?.sandbox).toEqual({ mode: 'read-only', source: 'config.toml profiles.review.sandbox_mode', approval_policy: 'never', approval_source: 'config.toml profiles.review.approval_policy' })
    // The command's own flag wins over the profile.
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--profile', 'review', '--sandbox', 'workspace-write'))).toMatch(/--sandbox gives the run the workspace-write sandbox/)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', '--profile', 'gone'))).toMatch(/^ROUTE_UNSUPPORTED|^HOST_UNKNOWN|^READ_ONLY_REQUIRED: .* profile gone is not in config\.toml/)
    config('sandbox_mode = "read-only"\napproval_policy = "never"\n')
    const own = check('astra', 'epic-reviewer', ASTRA('medium'))
    expect(own.receipt?.sandbox).toEqual({ mode: 'read-only', source: 'config.toml sandbox_mode', approval_policy: 'never', approval_source: 'config.toml approval_policy' })
    config('sandbox_mode = "workspace-write"\napproval_policy = "never"\n')
    expect(answer('astra', 'epic-reviewer', ASTRA('medium'))).toMatch(/config\.toml sandbox_mode gives the run the workspace-write sandbox/)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', ...READ_ONLY))).toBe('PASS')
    // An approval policy written as a table is one BMN cannot read; the command's own item still settles it.
    config('sandbox_mode = "read-only"\n\n[approval_policy]\ngranular = true\n')
    expect(readCodexConfig(readFileSync(join(home, '.codex/config.toml'), 'utf8')).access).toEqual({ top: { sandbox_mode: 'read-only' }, profiles: {}, unreadable: 'config.toml approval_policy is a table BMN cannot read' })
    expect(answer('astra', 'epic-reviewer', ASTRA('medium'))).toMatch(/^READ_ONLY_REQUIRED: .* its sandbox cannot be resolved: config\.toml approval_policy is a table BMN cannot read/)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', ...READ_ONLY))).toBe('PASS')
  })

  it('does not guess between the owner\'s file and a project\'s own: the command settles it', () => {
    config('sandbox_mode = "read-only"\napproval_policy = "never"\n')
    mkdirSync(join(workspace, '.codex'))
    writeFileSync(join(workspace, '.codex/config.toml'), 'sandbox_mode = "danger-full-access"\n')
    expect(answer('astra', 'epic-reviewer', ASTRA('medium'))).toMatch(/^READ_ONLY_REQUIRED: .* its sandbox cannot be resolved: .*\.codex\/config\.toml also says what a run may do, and BMN cannot tell which file wins/)
    expect(answer('astra', 'epic-reviewer', ASTRA('medium', ...READ_ONLY))).toBe('PASS')
  })
})

describe('a Claude Code run for a read-only role carries the form the write-attempt test showed (63.2 AC3)', () => {
  const MUST = "the command must carry --tools naming only Read, Grep, Glob (or '' for none), --strict-mcp-config and --mcp-config '{\"mcpServers\":{}}'"
  beforeEach(() => approve(held()))

  it('records the test with the version it ran on', () => {
    expect(CLAUDE_READ_ONLY_TESTED).toEqual({ version: '2.1.296', on: '2026-10-11' })
    expect(CLAUDE_READ_ONLY_TOOLS).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('passes a tool list without a writing tool and no MCP server, with or without safe mode', () => {
    const none = check('fable', 'epic-reviewer', FABLE('--tools', '', '--permission-mode', 'dontAsk', '--safe-mode', ...NO_MCP))
    expect(none.verdict).toBe('PASS')
    expect(none.receipt).toMatchObject({ effort: 'medium', sandbox: { mode: 'read-only', source: '--tools', tools: [], form_tested_on: '2.1.296' } })
    const reads = check('fable', 'epic-reviewer', FABLE('--tools', 'Read,Grep,Glob', ...NO_MCP))
    expect(reads.receipt?.sandbox).toEqual({ mode: 'read-only', source: '--tools', tools: ['Read', 'Grep', 'Glob'], form_tested_on: '2.1.296' })
    // The form was shown on another version than the stand-in's, and the check says so without refusing.
    expect(reads.steps.join('\n')).toContain('read-only role: tools Read, Grep, Glob, no MCP server (the form shown on Claude Code 2.1.296; this is 2.1.295)')
    expect(answer('fable', 'epic-reviewer', FABLE('--tools', 'Read Glob', ...NO_MCP))).toBe('PASS')
    // The empty server list is part of the form the write test showed: without it the command is not that form.
    expect(answer('fable', 'epic-reviewer', FABLE('--tools', 'Read Glob', '--strict-mcp-config'))).toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and the command names no empty MCP server list, which is part of the form the write test showed; ${MUST}`)
  })

  it('refuses every form that leaves a way to write', () => {
    const refused = (...extra: string[]): string => answer('fable', 'epic-reviewer', FABLE(...extra))
    expect(refused(...NO_MCP)).toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and the command names no tool list, so the run gets the tools that write; ${MUST}`)
    // Plan mode is not the form that held.
    expect(refused('--permission-mode', 'plan', ...NO_MCP)).toMatch(/^READ_ONLY_REQUIRED: .* the command names no tool list/)
    expect(refused('--tools', 'Read,Bash,Write', ...NO_MCP)).toBe(`READ_ONLY_REQUIRED: epic-reviewer is a read-only role and --tools gives the run Bash, Write; ${MUST}`)
    expect(refused('--tools', 'default', ...NO_MCP)).toMatch(/--tools gives the run default; /)
    expect(refused('--tools', 'Read,Grep,Glob')).toMatch(/without --strict-mcp-config the run is offered your MCP tools, which BMN cannot hold to reading; /)
    expect(refused('--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{"files":{"command":"npx"}}}')).toMatch(/--mcp-config gives the run an MCP server, which BMN cannot hold to reading; /)
    expect(refused('--tools', 'Read', '--permission-mode', 'bypassPermissions', ...NO_MCP)).toMatch(/--permission-mode bypassPermissions switches every permission check off; /)
  })
})

describe('a role that may write is judged as before (63.2 AC5)', () => {
  it('passes lead, designer, helper and browser commands with write access, and their receipts carry no sandbox', () => {
    approve(held())
    const runs: Array<[string, string, string[]]> = [
      ['sol', 'lead', codex('gpt-6.1-sol', 'xhigh', '--sandbox', 'workspace-write')],
      ['sol', 'lead', codex('gpt-6.1-sol', 'xhigh')],
      ['opus', 'lead', ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh']],
      ['fable', 'designer', FABLE('--permission-mode', 'acceptEdits')],
      ['luna', 'helper', codex('gpt-6-luna', 'max', '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"')],
      ['luna', 'browser', codex('gpt-6-luna', 'max', '--sandbox', 'danger-full-access')]
    ]
    for (const [agent, role, argv] of runs) {
      const result = check(agent, role, argv)
      expect([agent, role, result.verdict, result.verdict === 'PASS' ? null : result.message]).toEqual([agent, role, 'PASS', null])
      expect(result.receipt).not.toHaveProperty('sandbox')
    }
  })
})
