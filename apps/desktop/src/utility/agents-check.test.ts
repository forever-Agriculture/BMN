// MODULE: agents-check.test.ts - Epic 60.3: `bmn roster check` over synthetic rosters, configs, stub harnesses, visibility records and argv
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bindSession, consequences, evaluate, evaluateResearch, harnessVersion, normalizedGithubOrigin, prepareResearchRun, readCodexConfig, refreshVisibility,
  setReadTracer, verifyReceipt, visibilityPath, workspaceRoot, workspaceVisibility
} from '../../bin/agents-check.mjs'
import { machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { canonicalJson, parseRoster, sha256 } from '../../bin/agents-roster.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const NOW = new Date('2026-10-10T12:00:00.000Z')
const ORIGIN = 'github.com/synthetic-owner/synthetic-repo'

let home: string
let stubs: string
let workspace: string
let env: Record<string, string>
const savedHome = process.env.HOME

function edit(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
  return text.replace(from, to)
}

const GLM_OFF = 'enabled: false\nstatus: active\nefforts: []\nroles: [helper]\nenabled_note: NOTE-SENTINEL-GLM'
const KIMI = '## kimi\n\n```yaml\nname: Kimi\nclass: pawn\nharness: opencode\nmodel: kimi-k3\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [low]\nroles: [helper]\n```\n\n## roles'

/** The example plus GLM switched on (a public-only provider on an explicit host) and Kimi on OpenCode, an app BMN cannot check. */
function roster(extra: (text: string) => string = (text) => text): string {
  let text = EXAMPLE
  text = edit(text, GLM_OFF, 'enabled: true\nstatus: active\nefforts: [low]\nroles: [helper]')
  text = edit(text, '## roles', KIMI)
  return extra(text)
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** A visibility record as `bmn roster visibility --refresh` writes it, for a workspace GitHub reports public. */
function recordVisibility(folder: string, fields: Record<string, unknown> = {}): void {
  const record = { version: 1, workspace: folder, checked_at: new Date(NOW.getTime() - 60_000).toISOString(), origin: ORIGIN, repository_id: 4242,
    visibility: 'public', default_branch: 'main', commit: 'a'.repeat(40), ...fields }
  mkdirSync(dirname(visibilityPath(folder)), { recursive: true })
  writeFileSync(visibilityPath(folder), JSON.stringify(record))
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-check-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stub('codex', 'codex-cli 0.161.0')
  stub('claude', '2.1.295 (Claude Code)')
  workspace = join(home, 'work')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  approve(roster())
})

afterEach(() => {
  setReadTracer(null)
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const ASTRA_REVIEW = (project: string) => ['codex', 'exec', '--skip-git-repo-check', '-C', project, '-m', 'gpt-6-astra',
  '-c', 'model_reasoning_effort=medium', '-c', 'mcp_servers={}', '-c', 'approval_policy="never"', '--sandbox', 'read-only',
  '--json', '-o', join(project, 'out.md'), '-']
const LUNA_BROWSE = (project: string) => ['codex', 'exec', '--skip-git-repo-check', '-C', project, '-m', 'gpt-6-luna',
  '-c', 'model_reasoning_effort=max', '-c', 'mcp_servers={playwright={command="npx",args=["--offline","@playwright/mcp@0.0.75"]}}',
  '-c', 'approval_policy="never"', '--sandbox', 'read-only', '--json', '-o', join(project, 'out.md'), '-']
const FABLE_PACKET = (rules: string) => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'fable',
  '--effort', 'medium', '--output-format', 'json', '--tools', '', '--permission-mode', 'dontAsk', '--safe-mode',
  '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--append-system-prompt', rules]
/** GLM through Claude Code on Z.ai's host: a public-only provider on an explicit, listed host. */
const GLM = (rules?: string) => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic', 'claude', '-p', '--model', 'glm-5.3',
  '--effort', 'low', '--tools', '', '--safe-mode', '--output-format', 'json', ...(rules === undefined ? [] : ['--append-system-prompt', rules])]

type Inputs = Parameters<typeof evaluate>[0]
type Options = NonNullable<Parameters<typeof evaluate>[1]>

function check(inputs: Partial<Inputs> & { argv: string[] }, environment = env, options: Options = {}) {
  return evaluate({ agent: 'astra', role: 'epic-reviewer', workspace, data: 'private', cwd: workspace, ...inputs } as Inputs,
    { environment, cwd: workspace, now: NOW, ...options })
}

describe('dispatch forms dev-auto documents (60.3 AC1-AC2)', () => {
  it('accepts every documented form as written, including the fable alias', () => {
    const astra = check({ argv: ASTRA_REVIEW(workspace) })
    expect(astra.verdict, JSON.stringify(astra)).toBe('PASS')
    expect(astra.receipt).toMatchObject({ mode: 'dispatch', agent: 'astra', class: 'bishop', model: 'gpt-6-astra', effort: 'medium', data: 'private',
      context_limit_applied: null, public_status: { public: false, reason: 'no record' },
      route: { provider: 'openai', host: 'default:openai', basis: 'observed-default', sources: [], harness_provider: 'openai' },
      private_work: { answer: 'allowed', allowed: true }, harness_version: { version: '0.161.0', state: 'tested' } })
    expect(check({ agent: 'luna', role: 'browser', argv: LUNA_BROWSE(workspace) }).verdict).toBe('PASS')
    const fable = check({ agent: 'fable', argv: FABLE_PACKET('the owner global rules') })
    expect(fable.verdict, JSON.stringify(fable)).toBe('PASS')
    expect(fable.receipt).toMatchObject({ model: 'fable', route: { host: 'default:anthropic', provider: 'anthropic' } })
  })

  it.each([
    ['an unsupported flag', [...ASTRA_REVIEW('/x').slice(0, -1), '--oss', '-'], 'ROUTE_UNSUPPORTED'],
    ['a prompt on the command line', ['codex', 'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', 'do the review'], 'ROUTE_UNSUPPORTED'],
    ['an unknown -c key', ['codex', 'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '-c', 'chatgpt_base_url_x=1', '-'], 'ROUTE_UNSUPPORTED'],
    ['a wrapper script', ['/home/x/luna-browse.sh', 'a', 'b'], 'ROUTE_UNSUPPORTED'],
    ['env without -i', ['env', 'A=1', 'codex', 'exec', '-'], 'ROUTE_UNSUPPORTED'],
    ['the wrong harness', ['claude', '-p', '--model', 'gpt-6-astra', '--effort', 'medium'], 'ROUTE_UNSUPPORTED'],
    ['another model', ['codex', 'exec', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=medium', '-'], 'MODEL_MISMATCH'],
    ['an effort the agent lacks', ['codex', 'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=max', '-'], 'EFFORT_UNSUPPORTED'],
    ['no effort', ['codex', 'exec', '-m', 'gpt-6-astra', '-'], 'EFFORT_UNSUPPORTED']
  ])('refuses %s', (_name, argv, code) => {
    const result = check({ argv: argv as string[] })
    expect(result).toMatchObject({ verdict: 'REFUSED', code })
    expect(typeof result.next).toBe('string')
  })

  it('refuses disabled, proposed, unknown and ineligible agents, and a bishop or pawn as lead, in contract order', () => {
    approve(roster((text) => edit(text, 'name: Opus\nclass: knight\nharness: claude\nmodel: claude-opus-5-5\nprovider: anthropic\nhost: default\nenabled: true',
      'name: Opus\nclass: knight\nharness: claude\nmodel: claude-opus-5-5\nprovider: anthropic\nhost: default\nenabled: false')))
    const argv = ASTRA_REVIEW(workspace)
    expect(check({ agent: 'nova', argv }).code).toBe('UNKNOWN_AGENT')
    expect(check({ agent: 'sonnet', argv }).code).toBe('PROPOSED')
    expect(check({ agent: 'opus', role: 'lead', argv }).code).toBe('DISABLED')
    expect(check({ role: 'jester', argv }).code).toBe('ROLE_UNKNOWN')
    expect(check({ role: 'helper', argv }).code).toBe('ROLE_INELIGIBLE')
    // The validator never approves a bishop or pawn holding lead, so the role is simply not held.
    expect(check({ agent: 'astra', role: 'lead', argv }).code).toBe('ROLE_INELIGIBLE')
    expect(check({ agent: 'luna', role: 'lead', argv }).code).toBe('ROLE_INELIGIBLE')
  })

  it('refuses a class holding a role in approved data edited by hand: CLASS_CANNOT_LEAD, CLASS_CANNOT_DESIGN', () => {
    // The validator never approves this, so the test edits approved state the way a program could: approval is not an OS boundary.
    const pointerPath = join(home, '.config/bmn/agents/state/current')
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
    const file = join(home, `.config/bmn/agents/state/generations/${String(pointer.generation).padStart(6, '0')}.json`)
    const generation = JSON.parse(readFileSync(file, 'utf8'))
    const astra = generation.data.agents.find((agent: { id: string }) => agent.id === 'astra')
    astra.roles.push('lead', 'designer')
    generation.data.agents.find((agent: { id: string }) => agent.id === 'fable').roles.push('lead')
    const rest = { ...generation }
    delete rest.hash
    const hash = sha256(canonicalJson(rest))
    writeFileSync(file, JSON.stringify({ ...rest, hash }))
    writeFileSync(pointerPath, JSON.stringify({ ...pointer, hash }))
    expect(check({ agent: 'astra', role: 'lead', argv: ASTRA_REVIEW(workspace) })).toMatchObject({ code: 'CLASS_CANNOT_LEAD', message: 'astra is a bishop; only a knight or a queen leads' })
    expect(check({ agent: 'fable', role: 'lead', argv: FABLE_PACKET('rules') }).code).toBe('CLASS_CANNOT_LEAD')
    expect(check({ agent: 'astra', role: 'designer', argv: ASTRA_REVIEW(workspace) })).toMatchObject({ code: 'CLASS_CANNOT_DESIGN', message: 'astra is a bishop; only a rook or a queen designs' })
  })

  it('a rook designs, and reviews and advises like a bishop', () => {
    expect(check({ agent: 'fable', role: 'designer', argv: FABLE_PACKET('rules') }).receipt).toMatchObject({ class: 'rook', role: 'designer' })
    expect(check({ agent: 'fable', role: 'consultant', argv: FABLE_PACKET('rules') }).verdict).toBe('PASS')
  })

  it('a queen does what she wants: she leads, designs and reviews', () => {
    approve(roster((text) => edit(edit(text, 'name: Fable\nclass: rook', 'name: Fable\nclass: queen'),
      'roles: [designer, epic-reviewer, final-reviewer, consultant]', 'roles: [lead, designer, epic-reviewer, final-reviewer, consultant]')))
    for (const role of ['lead', 'designer', 'epic-reviewer']) {
      expect(check({ agent: 'fable', role, argv: FABLE_PACKET('rules') }).receipt).toMatchObject({ verdict: 'PASS', class: 'queen', role })
    }
  })

  it('reports the first refusal when several apply', () => {
    // An app BMN cannot check, with private data: the form is refused before the data is.
    expect(check({ agent: 'kimi', role: 'helper', argv: ['opencode', 'run', '--model', 'opencode-go/kimi-k3', 'x'] }).code).toBe('ROUTE_UNSUPPORTED')
    expect(check({ agent: 'kimi', role: 'helper', argv: ASTRA_REVIEW(workspace) })).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: 'BMN does not check OpenCode dispatches' })
    // A wrong model with private data for a public-only provider: the model is refused first.
    expect(check({ agent: 'glm', role: 'helper', argv: GLM().map((part) => (part === 'glm-5.3' ? 'glm-9' : part)) }).code).toBe('MODEL_MISMATCH')
  })
})

describe('destination resolution (60.3 AC3-AC4)', () => {
  it('reads OPENAI_BASE_URL, a custom provider, a profile and -c with fixed precedence', () => {
    const argv = ASTRA_REVIEW(workspace)
    const viaEnv = check({ argv }, { ...env, OPENAI_BASE_URL: 'https://proxy.example.test/v1?key=SECRET-QUERY' })
    expect(viaEnv).toMatchObject({ code: 'HOST_MISMATCH' })
    expect(viaEnv.message).toContain('proxy.example.test')
    expect(viaEnv.message).not.toContain('SECRET-QUERY')
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/config.toml'), [
      'model = "gpt-6-astra"', 'model_provider = "corp"', '', '[model_providers.corp]', 'base_url = "https://llm.corp.example/v1"',
      'env_key = "CORP_KEY"', '', '[profiles.home]', 'model_provider = "openai"', '', '[projects."/x"]', 'trust_level = "trusted"'
    ].join('\n'))
    const custom = check({ argv })
    expect(custom).toMatchObject({ code: 'HOST_MISMATCH' })
    expect(custom.message).toContain('llm.corp.example')
    expect(check({ argv: [...argv.slice(0, -1), '--profile', 'home', '-'] }).verdict).toBe('PASS')
    expect(check({ argv: [...argv.slice(0, -1), '-c', 'model_provider="openai"', '-'] }).verdict).toBe('PASS')
    expect(check({ argv: [...argv.slice(0, -1), '-c', 'model_providers.corp.base_url="https://other.example"', '-c', 'model_provider=corp', '-'] }).message).toContain('other.example')
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "local"\n')
    expect(check({ argv }).code).toBe('HOST_UNKNOWN')
    writeFileSync(join(home, '.codex/config.toml'), 'model_providers = { corp = { base_url = "https://x" } }\n')
    expect(check({ argv }).code).toBe('HOST_UNKNOWN')
  })

  it('reads settings env for Claude even under --safe-mode, and env -i drops the inherited base URL', () => {
    const argv = FABLE_PACKET('rules')
    expect(check({ agent: 'fable', argv }, { ...env, ANTHROPIC_BASE_URL: 'https://inherited.example' }).verdict).toBe('PASS')
    const noWrapper = argv.slice(4)
    expect(check({ agent: 'fable', argv: noWrapper }, { ...env, ANTHROPIC_BASE_URL: 'https://inherited.example' }).code).toBe('HOST_MISMATCH')
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }))
    expect(check({ agent: 'fable', argv }).code).toBe('HOST_MISMATCH')
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))
    expect(check({ agent: 'fable', argv }).code).toBe('HOST_UNKNOWN')
    rmSync(join(home, '.claude/settings.json'))
    mkdirSync(join(workspace, '.claude'))
    writeFileSync(join(workspace, '.claude/settings.local.json'), '{ not json')
    expect(check({ agent: 'fable', argv }).code).toBe('HOST_UNKNOWN')
  })

  it('a config file BMN cannot combine with the user\'s own never leaves the destination guessed', () => {
    // Codex may also load a .codex/config.toml from the working folder or one above it.
    mkdirSync(join(workspace, '.codex'))
    writeFileSync(join(workspace, '.codex/config.toml'), 'model_reasoning_summary = "auto"\n')
    expect(check({ argv: ASTRA_REVIEW(workspace) }).verdict).toBe('PASS')
    writeFileSync(join(workspace, '.codex/config.toml'), 'model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://proxy.example.test/v1"\n')
    for (const folder of [workspace, join(workspace, 'src')]) {
      const project = check({ argv: ASTRA_REVIEW(folder) })
      expect(project).toMatchObject({ verdict: 'REFUSED', code: 'HOST_UNKNOWN' })
      expect(project.message).toContain(`${workspace}/.codex/config.toml also says where Codex sends data`)
    }
    rmSync(join(workspace, '.codex'), { recursive: true })
    expect(check({ argv: ASTRA_REVIEW(join(workspace, 'src')) }).verdict).toBe('PASS')
    // Claude Code: settings in a folder above the working one count like the project's own.
    mkdirSync(join(workspace, '.claude'))
    writeFileSync(join(workspace, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.test' } }))
    const above = check({ agent: 'fable', argv: FABLE_PACKET('rules'), cwd: join(workspace, 'src') })
    expect(above).toMatchObject({ verdict: 'REFUSED', code: 'HOST_MISMATCH' })
    expect(above.message).toContain('proxy.example.test')
  })

  it('reads a profile written on one line, a -C that passes through a link, and a local settings file beside the user\'s own', () => {
    // A whole profile on one line cannot be read key by key: the destination is unknown, in a project file or the user's own.
    for (const folder of [workspace, home]) {
      mkdirSync(join(folder, '.codex'))
      writeFileSync(join(folder, '.codex/config.toml'), 'profiles.work = { model_provider = "proxy" }\n')
      expect(check({ argv: ASTRA_REVIEW(workspace) })).toMatchObject({ verdict: 'REFUSED', code: 'HOST_UNKNOWN' })
      rmSync(join(folder, '.codex'), { recursive: true })
    }
    // -C names a link: the folders above where it really leads count too.
    mkdirSync(join(workspace, 'area/project'), { recursive: true })
    mkdirSync(join(workspace, 'area/.codex'))
    writeFileSync(join(workspace, 'area/.codex/config.toml'), 'model_provider = "proxy"\n')
    symlinkSync(join(workspace, 'area/project'), join(workspace, 'link'))
    for (const spelling of [join(workspace, 'link'), 'link']) {
      const argv = ASTRA_REVIEW(join(workspace, 'link'))
      argv[argv.indexOf('-C') + 1] = spelling
      const linked = check({ argv })
      expect(linked).toMatchObject({ verdict: 'REFUSED', code: 'HOST_UNKNOWN' })
      expect(linked.message).toContain(`${workspace}/area/.codex/config.toml also says where Codex sends data`)
    }
    rmSync(join(workspace, 'link'))
    rmSync(join(workspace, 'area'), { recursive: true })
    expect(check({ argv: ASTRA_REVIEW(workspace) }).verdict).toBe('PASS')
    // Beside the user settings, already read, their folder may hold a local file: one more source.
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude/settings.json'), '{}')
    writeFileSync(join(home, '.claude/settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.test' } }))
    const local = check({ agent: 'fable', argv: FABLE_PACKET('rules') })
    expect(local).toMatchObject({ verdict: 'REFUSED', code: 'HOST_MISMATCH' })
    expect(local.message).toContain('proxy.example.test')
  })

  it('refuses a command that runs without HOME, a named setting that is not text, and reads past brackets inside a string', () => {
    // env -i without HOME: the app would read the account's own settings, which the command hides from BMN.
    const bare = check({ argv: ['env', '-i', `PATH=${env.PATH}`, ...ASTRA_REVIEW(workspace)] })
    expect(bare).toMatchObject({ verdict: 'REFUSED', code: 'ROUTE_UNSUPPORTED' })
    expect(bare.message).toContain('runs without HOME')
    expect(check({ argv: ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, ...ASTRA_REVIEW(workspace)] }).verdict).toBe('PASS')
    expect(check({ agent: 'fable', argv: FABLE_PACKET('rules').filter((part) => !part.startsWith('HOME=')) })).toMatchObject({ code: 'ROUTE_UNSUPPORTED' })
    // A switch written as a number or true may still switch the provider.
    mkdirSync(join(home, '.claude'))
    for (const env of [{ CLAUDE_CODE_USE_BEDROCK: 1 }, { CLAUDE_CODE_USE_VERTEX: true }, { ANTHROPIC_BASE_URL: 5 }]) {
      writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env }))
      expect(check({ agent: 'fable', argv: FABLE_PACKET('rules') })).toMatchObject({ verdict: 'REFUSED', code: 'HOST_UNKNOWN' })
    }
    rmSync(join(home, '.claude'), { recursive: true })
    // A bracket inside a string closes nothing: the tables after it still count.
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/config.toml'), 'notify = ["bash", "-c", "echo [ # not a comment"]\nmodel_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://proxy.example.test/v1"\n')
    const past = check({ argv: ASTRA_REVIEW(workspace) })
    expect(past).toMatchObject({ verdict: 'REFUSED', code: 'HOST_MISMATCH' })
    expect(past.message).toContain('proxy.example.test')
    expect(readCodexConfig('tags = [\n  "one", "two [",\n]\nmodel_provider = "proxy"\n').top).toMatchObject({ model_provider: 'proxy' })
    // A string left open across lines is a value BMN cannot follow.
    expect(readCodexConfig('tags = ["one\ntwo"]\nmodel_provider = "proxy"\n').unreadable).toContain('a value that spans lines')
  })

  it('an explicit host names the provider that lists it, and an approved host must match exactly', () => {
    const glm = check({ agent: 'glm', role: 'helper', argv: GLM() })
    // The destination is known and matches; the provider's answer is what refuses private work.
    expect(glm).toMatchObject({ code: 'DATA_FORBIDDEN' })
    expect(check({ agent: 'glm', role: 'helper', argv: GLM().map((part) => part.replace('api.z.ai', 'api.other.example')) }).code).toBe('HOST_MISMATCH')
    // GLM approved on an explicit host never matches Claude Code's own default.
    expect(check({ agent: 'glm', role: 'helper', argv: GLM().filter((part) => !part.startsWith('ANTHROPIC_BASE_URL')) }).code).toBe('HOST_MISMATCH')
  })

  it('a default destination needs an approved entry for that app, and an observed default must still be that provider', () => {
    const argv = ASTRA_REVIEW(workspace)
    approve(roster((text) => edit(text, 'codex: {provider: openai, basis: observed-default}\n', '')))
    expect(check({ argv })).toMatchObject({ code: 'HOST_UNKNOWN', message: expect.stringContaining('no approved destination for codex') })
  })

  it('an owner-declared destination gets public work only, whatever its provider answers', () => {
    approve(roster((text) => edit(text, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: owner-declared}')))
    const refused = check({ argv: ASTRA_REVIEW(workspace) })
    expect(refused).toMatchObject({ code: 'DATA_FORBIDDEN', message: expect.stringContaining('owner-declared') })
    expect(refused.next).toContain('next candidate')
  })

  it('records only provider, host and source names, never URL paths or other environment values', () => {
    const result = check({ agent: 'glm', role: 'helper', data: 'public', argv: ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic?token=SECRET', 'claude', '-p', '--model', 'glm-5.3', '--effort', 'low'] })
    expect(result.verdict).toBe('REFUSED')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('/api/anthropic')
  })
})

describe('private work, providers and exceptions (60.3 AC4)', () => {
  it("a provider's answer covers every agent on it", () => {
    approve(roster((text) => edit(text, 'hosts: [api.openai.com], sites: [openai.com], private_work: allowed', 'hosts: [api.openai.com], sites: [openai.com], private_work: public_only')))
    expect(check({ argv: ASTRA_REVIEW(workspace) })).toMatchObject({ code: 'DATA_FORBIDDEN', message: expect.stringContaining('OpenAI gets public work only') })
    expect(check({ agent: 'luna', role: 'browser', argv: LUNA_BROWSE(workspace) }).code).toBe('DATA_FORBIDDEN')
    expect(check({ agent: 'fable', argv: FABLE_PACKET('rules') }).verdict).toBe('PASS')
  })

  const withException = (folder: string) => roster((text) => edit(text, 'folder: /synthetic/EXCEPTION-SENTINEL-FOLDER', `folder: ${folder}`))

  it('an exception lets a public-only provider receive private work in that one workspace, and the receipt carries only its id', () => {
    approve(withException(workspace))
    const pass = check({ agent: 'glm', role: 'helper', argv: GLM() })
    expect(pass.verdict, JSON.stringify(pass)).toBe('PASS')
    expect(pass.receipt?.private_work).toEqual({ answer: 'public_only', allowed: true, exception: { id: 'zai-synthetic', scope: 'this workspace' } })
    expect(JSON.stringify(pass.receipt?.private_work)).not.toContain(workspace)
    // A sibling folder is not covered.
    mkdirSync(join(home, 'sibling'))
    expect(check({ agent: 'glm', role: 'helper', workspace: join(home, 'sibling'), cwd: join(home, 'sibling'), argv: GLM() }).code).toBe('DATA_FORBIDDEN')
  })

  it('an exception covers a workspace root: folders inside it, never a nested repository with its own top-level', () => {
    const outer = join(home, 'outer')
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(outer, 'sub/deep'), { recursive: true })
    mkdirSync(join(outer, 'nested/.git'), { recursive: true })
    expect(workspaceRoot(join(outer, 'sub/deep'))).toBe(outer)
    expect(workspaceRoot(join(outer, 'nested'))).toBe(join(outer, 'nested'))
    expect(workspaceRoot(workspace)).toBe(workspace)
    approve(withException(outer))
    const inner = (folder: string) => check({ agent: 'glm', role: 'helper', workspace: folder, cwd: folder, argv: GLM() })
    expect(inner(join(outer, 'sub/deep')).verdict).toBe('PASS')
    expect(inner(join(outer, 'nested')).code).toBe('DATA_FORBIDDEN')
  })

  it('an exception for the outer workspace never covers a dispatch that works in a repository nested in it, or in a packet elsewhere', () => {
    const outer = join(home, 'outer')
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(outer, 'sub'), { recursive: true })
    mkdirSync(join(outer, 'nested/.git'), { recursive: true })
    mkdirSync(join(home, 'elsewhere'))
    approve(withException(outer))
    const from = (overrides: Partial<Inputs>, argv = GLM()) => check({ agent: 'glm', role: 'helper', workspace: outer, cwd: outer, argv, ...overrides })
    expect(from({}).verdict).toBe('PASS')
    expect(from({ cwd: join(outer, 'sub') }).verdict).toBe('PASS')
    // The workspace named is the excepted one; the folder the agent would work in is not.
    expect(from({ cwd: join(outer, 'nested') })).toMatchObject({ code: 'DATA_FORBIDDEN' })
    expect(from({}, [...GLM(), '--add-dir', join(outer, 'nested')])).toMatchObject({ code: 'DATA_FORBIDDEN' })
    expect(from({}, [...GLM(), '--add-dir', join(outer, 'sub')]).verdict).toBe('PASS')
    expect(from({ cwd: join(home, 'elsewhere'), packet: join(home, 'elsewhere') })).toMatchObject({ code: 'DATA_FORBIDDEN' })
  })

  it('work in a repository nested in a public workspace is private', () => {
    const outer = join(home, 'outer')
    mkdirSync(join(outer, 'nested/.git'), { recursive: true })
    execFileSync('git', ['init', '-q', outer])
    execFileSync('git', ['-C', outer, 'remote', 'add', 'origin', 'https://github.com/synthetic-owner/synthetic-repo.git'])
    recordVisibility(outer)
    const astra = (folder: string) => check({ workspace: outer, cwd: outer, data: 'public', argv: ASTRA_REVIEW(folder) })
    expect(astra(outer).receipt).toMatchObject({ data: 'public', public_status: { public: true } })
    expect(astra(join(outer, 'nested')).receipt).toMatchObject({ data: 'private', public_status: { public: true } })
  })

  it('an exception counts only for a workspace\'s real path: one written through a link grants nothing, wherever the link points', () => {
    const link = join(home, 'link-to-work')
    symlinkSync(workspace, link)
    approve(withException(link))
    expect(readValidRoster().data.exceptions.find((entry) => entry.id === 'zai-synthetic')?.folder).toBe(link)
    expect(readValidRoster().warnings).toEqual([expect.objectContaining({ code: 'EXCEPTION_LINK', message: expect.not.stringContaining(home) })])
    expect(check({ agent: 'glm', role: 'helper', argv: GLM() })).toMatchObject({ code: 'DATA_FORBIDDEN', message: expect.stringContaining('through a link') })
    // The link points at another workspace afterwards: nothing was ever approved for it.
    const other = join(home, 'other-work')
    mkdirSync(other)
    rmSync(link)
    symlinkSync(other, link)
    expect(check({ agent: 'glm', role: 'helper', workspace: other, cwd: other, argv: GLM() })).toMatchObject({ code: 'DATA_FORBIDDEN' })
    expect(check({ agent: 'glm', role: 'helper', workspace: link, cwd: other, argv: GLM() })).toMatchObject({ code: 'DATA_FORBIDDEN' })
    // The real path is what an exception names.
    approve(withException(workspace))
    expect(readValidRoster().warnings).toEqual([])
    expect(check({ agent: 'glm', role: 'helper', argv: GLM() }).verdict).toBe('PASS')
    // A changed folder is a pending difference: redacted for agents, exact for the owner's review.
    writeFileSync(join(home, '.config/bmn/agents/roster.md'), withException(other))
    const approved = readApproved().data
    const file = readValidRoster().data
    expect(machineDiff(approved, file)).toEqual([expect.objectContaining({ scope: 'exceptions', id: 'zai-synthetic', field: 'folder', free_text: true })])
    expect(JSON.stringify(machineDiff(approved, file))).not.toContain(other)
    expect(machineDiff(approved, file, { folders: true })).toEqual([expect.objectContaining({ field: 'folder', before: { present: true, value: workspace }, after: { present: true, value: other } })])
    expect(check({ agent: 'glm', role: 'helper', workspace: other, cwd: other, argv: GLM() })).toMatchObject({ code: 'DATA_FORBIDDEN' })
  })

  it('no exception applies to an owner-declared destination, and none changes the host check or the need for a readable app version', () => {
    approve(roster((text) => edit(edit(text, 'folder: /synthetic/EXCEPTION-SENTINEL-FOLDER', `folder: ${workspace}`),
      'zai-synthetic: {provider: zai', 'cursor-here: {provider: cursor, folder: ' + workspace + '}\nzai-synthetic: {provider: zai')))
    expect(check({ agent: 'glm', role: 'helper', argv: GLM().map((part) => part.replace('api.z.ai', 'api.other.example')) }).code).toBe('HOST_MISMATCH')
    stub('claude', '2.9.0 (Claude Code)')
    expect(check({ agent: 'glm', role: 'helper', argv: GLM() }).receipt?.harness_version).toEqual({ version: '2.9.0', state: 'newer than BMN tested' })
    stub('claude', 'Claude Code')
    expect(check({ agent: 'glm', role: 'helper', argv: GLM() }).code).toBe('HARNESS_UNKNOWN')
  })
})

describe('workspaces and their public status (60.3 AC5)', () => {
  let repo: string

  beforeEach(() => {
    repo = join(home, 'public')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'remote', 'add', 'origin', 'git@github.com:Synthetic-Owner/Synthetic-Repo.git')
  })

  it('canonicalizes, and refuses .., nonexistent and outside paths', () => {
    expect(check({ workspace: join(home, 'nope'), argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_UNKNOWN')
    expect(check({ workspace: `${workspace}/../work`, argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_UNKNOWN')
    expect(check({ argv: ASTRA_REVIEW(home) }).code).toBe('WORKSPACE_MISMATCH')
    expect(check({ cwd: home, argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_MISMATCH')
    symlinkSync(repo, join(home, 'linked'))
    recordVisibility(repo)
    const linked = check({ workspace: join(home, 'linked'), cwd: repo, data: 'public', argv: ASTRA_REVIEW(repo) })
    expect(linked.receipt).toMatchObject({ workspace: repo, public_status: { public: true, reason: `GitHub reports ${ORIGIN} public`, commit: 'a'.repeat(40) }, data: 'public' })
  })

  it('is public only through a fresh, well-formed record for this path and its current origin', () => {
    const status = (fields?: Record<string, unknown>) => {
      if (fields !== undefined) recordVisibility(repo, fields)
      return workspaceVisibility(repo, NOW)
    }
    expect(status()).toEqual({ public: false, reason: 'no record' })
    expect(status({})).toMatchObject({ public: true })
    // Fresh means younger than seven days: a record exactly that old no longer counts.
    expect(status({ checked_at: new Date(NOW.getTime() - 7 * 86_400_000 + 1000).toISOString() })).toMatchObject({ public: true })
    expect(status({ checked_at: new Date(NOW.getTime() - 7 * 86_400_000).toISOString() })).toMatchObject({ public: false, reason: 'stale' })
    expect(status({ checked_at: new Date(NOW.getTime() - 7 * 86_400_000 - 1000).toISOString() })).toMatchObject({ public: false, reason: 'stale' })
    expect(status({ checked_at: new Date(NOW.getTime() + 60_000).toISOString() })).toMatchObject({ public: false, reason: 'malformed' })
    expect(status({ workspace: workspace })).toMatchObject({ public: false, reason: 'malformed' })
    expect(status({ commit: 'main' })).toMatchObject({ public: false, reason: 'malformed' })
    expect(status({ repository_id: undefined })).toMatchObject({ public: false, reason: 'malformed' })
    expect(status({ visibility: 'private', reason: 'private repository' })).toMatchObject({ public: false, reason: 'private repository' })
    expect(status({ visibility: 'private', reason: 'check failed' })).toMatchObject({ public: false, reason: 'check failed' })
    expect(status({ origin: 'github.com/synthetic-owner/another-repo' })).toMatchObject({ public: false, reason: 'origin changed' })
    writeFileSync(visibilityPath(repo), '{ not json')
    expect(workspaceVisibility(repo, NOW)).toEqual({ public: false, reason: 'malformed' })
    recordVisibility(repo)
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.test/o/n.git')
    expect(workspaceVisibility(repo, NOW)).toMatchObject({ public: false, reason: 'not GitHub' })
    git(repo, 'remote', 'remove', 'origin')
    expect(workspaceVisibility(repo, NOW)).toMatchObject({ public: false, reason: 'no origin' })
  })

  it('--data tightens public to private and never loosens', () => {
    recordVisibility(repo)
    expect(check({ workspace: repo, cwd: repo, data: 'private', argv: ASTRA_REVIEW(repo) }).receipt).toMatchObject({ public_status: { public: true }, data: 'private' })
    expect(check({ data: 'public', argv: ASTRA_REVIEW(workspace) }).receipt).toMatchObject({ public_status: { public: false, reason: 'no record' }, data: 'private' })
  })

  it('reads a GitHub origin in every spelling Git accepts and nothing else', () => {
    for (const url of ['https://github.com/Synthetic-Owner/Synthetic-Repo.git', 'https://github.com/synthetic-owner/synthetic-repo', 'git@github.com:synthetic-owner/synthetic-repo.git',
      'ssh://git@github.com/synthetic-owner/synthetic-repo.git', 'https://user@github.com/synthetic-owner/synthetic-repo/']) {
      expect(normalizedGithubOrigin(url), url).toBe(ORIGIN)
    }
    for (const url of ['https://github.com.evil.example/o/n', 'https://example.test/github.com/o/n', 'https://github.com/o', 'https://github.com/o/n/extra', '/local/path', 'https://github.com/../n']) {
      expect(normalizedGithubOrigin(url), url).toBeNull()
    }
  })
})

describe('bmn roster visibility --refresh against a stub GitHub API (60.3 AC10)', () => {
  let repo: string
  let server: Server
  let api: string
  let answer: (path: string) => { status: number; body?: string; hang?: boolean }
  let asked: { path: string; headers: Record<string, unknown> }[]

  beforeEach(async () => {
    repo = join(home, 'public')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'remote', 'add', 'origin', 'https://github.com/synthetic-owner/synthetic-repo.git')
    asked = []
    server = createServer((request, response) => {
      asked.push({ path: request.url ?? '', headers: request.headers })
      const reply = answer(request.url ?? '')
      if (reply.hang) return
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(reply.body ?? '')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    api = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const repository = (fields: Record<string, unknown>) => JSON.stringify({ id: 4242, private: false, visibility: 'public', default_branch: 'main', ...fields })

  it('records a public repository with its id, default branch and that branch\'s commit, without credentials', async () => {
    answer = (path) => (path.endsWith('/commits/main') ? { status: 200, body: `${'b'.repeat(40)}\n` } : { status: 200, body: repository({}) })
    const record = await refreshVisibility(repo, { now: NOW, api })
    expect(record).toEqual({ version: 1, workspace: repo, checked_at: NOW.toISOString(), origin: ORIGIN, repository_id: 4242, visibility: 'public', default_branch: 'main', commit: 'b'.repeat(40) })
    expect(asked.map((entry) => entry.path)).toEqual(['/repos/synthetic-owner/synthetic-repo', '/repos/synthetic-owner/synthetic-repo/commits/main'])
    expect(asked.every((entry) => entry.headers.authorization === undefined && entry.headers.cookie === undefined)).toBe(true)
    expect(workspaceVisibility(repo, new Date(NOW.getTime() + 1000))).toMatchObject({ public: true, record: { commit: 'b'.repeat(40) } })
    expect(readFileSync(visibilityPath(repo), 'utf8')).not.toMatch(/https?:|token|\.git/)
  })

  it.each([
    ['a private repository', () => ({ status: 200, body: repository({ private: true, visibility: 'private' }) }), 'private repository'],
    ['an internal repository', () => ({ status: 200, body: repository({ visibility: 'internal' }) }), 'private repository'],
    ['a missing repository (404)', () => ({ status: 404, body: '{}' }), 'private repository'],
    ['a server error', () => ({ status: 500, body: '{}' }), 'check failed'],
    ['an answer that is not JSON', () => ({ status: 200, body: '<html>' }), 'check failed'],
    ['a commit answer that is not a SHA', (path: string) => (path.includes('/commits/') ? { status: 200, body: 'main' } : { status: 200, body: repository({}) }), 'check failed'],
    ['a timeout', () => ({ status: 200, hang: true }), 'check failed']
  ])('records private for %s', async (_name, reply, reason) => {
    answer = reply as typeof answer
    const record = await refreshVisibility(repo, { now: NOW, api, timeoutMs: 300 })
    expect(record).toMatchObject({ visibility: 'private', reason })
    expect(workspaceVisibility(repo, NOW)).toMatchObject({ public: false, reason })
  })

  it('records private without asking anyone for a missing origin or another host', async () => {
    answer = () => ({ status: 200, body: repository({}) })
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.test/o/n.git')
    expect(await refreshVisibility(repo, { now: NOW, api })).toMatchObject({ visibility: 'private', reason: 'not GitHub', origin: null })
    git(repo, 'remote', 'remove', 'origin')
    expect(await refreshVisibility(repo, { now: NOW, api })).toMatchObject({ visibility: 'private', reason: 'no origin' })
    expect(asked).toEqual([])
  })

  it('`bmn roster visibility` prints the record and says why a workspace is private', async () => {
    const none = await runCli(['roster', 'visibility', repo])
    expect(none.code).toBe(0)
    expect(none.stdout).toContain(`${repo}: private (no record)`)
    recordVisibility(repo, { checked_at: new Date(Date.now() - 60_000).toISOString() })
    const shown = JSON.parse((await runCli(['roster', 'visibility', repo, '--json'])).stdout)
    expect(shown).toMatchObject({ workspace: repo, public: true, record: { origin: ORIGIN, commit: 'a'.repeat(40) } })
    expect((await runCli(['roster', 'visibility', join(home, 'nope')])).code).toBe(10)
  })
})

describe('public-only destinations and packet mode (60.3 AC6)', () => {
  let publicRepo: string
  let packet: string
  let commit: string

  beforeEach(() => {
    publicRepo = join(home, 'public')
    mkdirSync(join(publicRepo, 'src'), { recursive: true })
    writeFileSync(join(publicRepo, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(publicRepo, '.gitignore'), 'secret.env\n')
    writeFileSync(join(publicRepo, 'secret.env'), 'TOKEN=private\n')
    git(publicRepo, 'init', '-q')
    git(publicRepo, 'remote', 'add', 'origin', 'https://github.com/synthetic-owner/synthetic-repo.git')
    git(publicRepo, 'add', 'src/a.ts', '.gitignore')
    git(publicRepo, 'commit', '-q', '-m', 'init')
    commit = git(publicRepo, 'rev-parse', 'HEAD')
    recordVisibility(publicRepo, { commit })
    writeFileSync(join(publicRepo, 'untracked.ts'), 'private draft\n')
    packet = join(home, 'packet')
    mkdirSync(join(packet, 'src'), { recursive: true })
    writeFileSync(join(packet, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(packet, 'prompt.md'), 'Review src/a.ts.\n')
  })

  const glm = (overrides: Partial<Inputs> & { argv?: string[] } = {}, options: Options = {}) => check({
    agent: 'glm', role: 'helper', workspace: publicRepo, data: 'public', cwd: packet, packet, stdin: join(packet, 'prompt.md'), argv: GLM(), ...overrides
  }, env, options)

  it('passes a packet of files the public repository already serves and marks the prompt unverified', () => {
    const result = glm()
    expect(result.verdict, JSON.stringify(result)).toBe('PASS')
    expect(result.receipt).toMatchObject({ data: 'public', public_status: { public: true, commit }, route: { provider: 'zai', host: 'api.z.ai', basis: 'explicit' },
      private_work: { answer: 'public_only', allowed: false },
      packet: { path: packet, prompt: 'lead-authored, not verified', manifest: [{ name: 'prompt.md' }, { name: 'src/a.ts' }] } })
  })

  it('refuses private data with DATA_FORBIDDEN, the one refusal a lead moves on from', () => {
    const refused = glm({ data: 'private' })
    expect(refused).toMatchObject({ code: 'DATA_FORBIDDEN', next: expect.stringContaining('next candidate') })
    expect(glm({ workspace, cwd: workspace, packet: undefined, stdin: undefined, data: 'private' }).code).toBe('DATA_FORBIDDEN')
    // Private before anything about the packet: an unreadable prompt or a missing packet does not hide it.
    expect(glm({ data: 'private', stdin: join(packet, 'no-such-prompt.md') }).code).toBe('DATA_FORBIDDEN')
    expect(glm({ data: 'private', packet: join(home, 'no-such-packet'), cwd: publicRepo, stdin: undefined }).code).toBe('DATA_FORBIDDEN')
  })

  const special = () => execFileSync('mkfifo', [join(packet, 'pipe')])
  it.each([
    ['a private untracked file', () => writeFileSync(join(packet, 'untracked.ts'), 'private draft\n'), () => ({})],
    ['an ignored file', () => writeFileSync(join(packet, 'secret.env'), 'TOKEN=private\n'), () => ({})],
    ['a changed tracked file', () => writeFileSync(join(packet, 'src/a.ts'), 'export const a = 2\n'), () => ({})],
    ['a symbolic link', () => symlinkSync(join(publicRepo, 'src/a.ts'), join(packet, 'link.ts')), () => ({})],
    ['a special file', special, () => ({})],
    ['the full global rules', () => undefined, () => ({ argv: GLM('the full global rules with private sections') })],
    ['a missing --safe-mode', () => undefined, () => ({ argv: GLM().filter((argument) => argument !== '--safe-mode') })],
    ['tools left on', () => undefined, () => ({ argv: GLM().map((argument) => (argument === '' ? 'Read' : argument)) })],
    ['--settings', () => undefined, () => ({ argv: [...GLM(), '--settings', '{}'] })],
    ['a non-empty --mcp-config', () => undefined, () => ({ argv: [...GLM(), '--mcp-config', '{"mcpServers":{"x":{"command":"y"}}}'] })],
    ['--add-dir', () => undefined, () => ({ argv: [...GLM(), '--add-dir', publicRepo] })],
    ['a cwd outside the packet', () => undefined, () => ({ cwd: publicRepo })],
    ['a prompt outside the packet', () => writeFileSync(join(publicRepo, 'prompt.md'), 'x'), () => ({ stdin: join(publicRepo, 'prompt.md') })],
    ['an unreadable prompt', () => undefined, () => ({ stdin: join(packet, 'no-such-prompt.md') })],
    ['no packet', () => undefined, () => ({ packet: undefined, cwd: publicRepo, stdin: undefined })],
    ['a missing packet folder', () => undefined, () => ({ packet: join(home, 'no-such-packet'), cwd: publicRepo, stdin: undefined })]
  ])('refuses public work in packet mode with %s: PACKET_INVALID', (_name, prepare, overrides) => {
    prepare()
    expect(glm(overrides() as Partial<Inputs>)).toMatchObject({ verdict: 'REFUSED', code: 'PACKET_INVALID' })
  })

  it('refuses packet mode without env -i, whose inherited environment could carry anything', () => {
    const inherited = { ...env, ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
    const result = check({ agent: 'glm', role: 'helper', workspace: publicRepo, data: 'public', cwd: packet, packet, stdin: join(packet, 'prompt.md'), argv: GLM().slice(5) }, inherited)
    expect(result).toMatchObject({ verdict: 'REFUSED', code: 'PACKET_INVALID', message: expect.stringContaining('env -i') })
  })

  it('accepts an empty --mcp-config, and the public rules rendering in --append-system-prompt and nothing else', () => {
    expect(glm({ argv: [...GLM(), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] }).verdict).toBe('PASS')
    expect(glm({ argv: GLM('PUBLIC RULES') }, { publicRules: 'PUBLIC RULES' }).verdict).toBe('PASS')
    expect(glm({ argv: GLM('PUBLIC RULES') }, { publicRules: () => 'OTHER' }).code).toBe('PACKET_INVALID')
  })

  it('compares the packet with the commit in the visibility record, not with whatever the local branch or remote ref says', () => {
    // An unpushed local commit and a rewritten remote-tracking ref both carry the private change.
    writeFileSync(join(publicRepo, 'src/a.ts'), 'export const a = "unpushed"\n')
    git(publicRepo, 'commit', '-q', '-am', 'unpushed')
    git(publicRepo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(publicRepo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    expect(glm().verdict).toBe('PASS')
    writeFileSync(join(packet, 'src/a.ts'), 'export const a = "unpushed"\n')
    expect(glm()).toMatchObject({ code: 'PACKET_INVALID', message: expect.stringContaining(commit.slice(0, 12)) })
  })

  it('refuses when the recorded commit is not in the local object store', () => {
    recordVisibility(publicRepo, { commit: 'c'.repeat(40) })
    expect(glm().code).toBe('PACKET_INVALID')
  })

  it.each([
    ['no record', () => rmSync(visibilityPath(publicRepo))],
    ['a stale record', () => recordVisibility(publicRepo, { commit, checked_at: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() })],
    ['a private repository', () => recordVisibility(publicRepo, { visibility: 'private', reason: 'private repository' })],
    ['a changed origin', () => git(publicRepo, 'remote', 'set-url', 'origin', 'https://github.com/synthetic-owner/renamed.git')],
    ['an origin that is not GitHub', () => git(publicRepo, 'remote', 'set-url', 'origin', 'https://gitlab.example.test/o/n.git')]
  ])('with %s the workspace is private: DATA_FORBIDDEN', (_name, prepare) => {
    prepare()
    expect(glm().code).toBe('DATA_FORBIDDEN')
  })

  it('a public-only Codex destination: private data moves the lead on, public data stops it', () => {
    approve(roster((text) => edit(text, 'hosts: [api.openai.com], sites: [openai.com], private_work: allowed', 'hosts: [api.openai.com], sites: [openai.com], private_work: public_only')))
    const luna = (data: 'private' | 'public') => check({ agent: 'luna', role: 'helper', workspace: publicRepo, cwd: publicRepo, data, argv: LUNA_BROWSE(publicRepo) })
    expect(luna('private').code).toBe('DATA_FORBIDDEN')
    expect(luna('public')).toMatchObject({ code: 'PACKET_INVALID', message: expect.stringContaining('claude -p') })
  })

  it('--verify judges the public record as of now, not as of the receipt', () => {
    recordVisibility(publicRepo, { commit, checked_at: new Date(NOW.getTime() - 6 * 86_400_000).toISOString() })
    const result = glm()
    expect(result.verdict, JSON.stringify(result)).toBe('PASS')
    writeFileSync(join(home, 'packet-receipt.json'), JSON.stringify(result.receipt))
    const verify = (now: Date) => verifyReceipt(join(home, 'packet-receipt.json'), GLM(), { environment: env, cwd: packet, now })
    expect(verify(NOW)).toEqual({ ok: true })
    expect(verify(new Date(NOW.getTime() + 86_400_000 - 1))).toEqual({ ok: true })
    // The record is 7 days old, so the workspace counts as private: a fresh check refuses and the receipt no longer reproduces.
    expect(glm({}, { now: new Date(NOW.getTime() + 86_400_000) }).code).toBe('DATA_FORBIDDEN')
    expect(verify(new Date(NOW.getTime() + 86_400_000))).toMatchObject({ ok: false, reason: expect.stringContaining('no longer passes: DATA_FORBIDDEN') })
  })

  it('reads the published commit itself: a replacement ref or a git environment cannot stand in for it', () => {
    // A private commit, never published, that git would serve in place of the recorded one.
    writeFileSync(join(publicRepo, 'src/a.ts'), 'export const a = "PRIVATE-REPLACEMENT"\n')
    git(publicRepo, 'commit', '-q', '-am', 'private')
    const secret = git(publicRepo, 'rev-parse', 'HEAD')
    git(publicRepo, 'reset', '-q', '--hard', commit)
    git(publicRepo, 'replace', commit, secret)
    expect(git(publicRepo, 'show', `${commit}:src/a.ts`)).toContain('PRIVATE-REPLACEMENT')
    expect(glm().verdict).toBe('PASS')
    writeFileSync(join(packet, 'src/a.ts'), 'export const a = "PRIVATE-REPLACEMENT"\n')
    expect(glm()).toMatchObject({ code: 'PACKET_INVALID', message: expect.stringContaining('src/a.ts is not byte-identical') })
    writeFileSync(join(packet, 'src/a.ts'), 'export const a = 1\n')
    // Another repository named by the environment answers nothing.
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    git(elsewhere, 'init', '-q')
    const saved = { dir: process.env.GIT_DIR, objects: process.env.GIT_OBJECT_DIRECTORY }
    process.env.GIT_DIR = join(elsewhere, '.git')
    process.env.GIT_OBJECT_DIRECTORY = join(elsewhere, '.git/objects')
    try {
      expect(glm().verdict).toBe('PASS')
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved.dir
      if (saved.objects === undefined) delete process.env.GIT_OBJECT_DIRECTORY
      else process.env.GIT_OBJECT_DIRECTORY = saved.objects
    }
  })

  it('--verify refuses a packet receipt once a packet file changed after the check', () => {
    const result = glm()
    expect(result.verdict).toBe('PASS')
    writeFileSync(join(home, 'packet-receipt.json'), JSON.stringify(result.receipt))
    const verify = (now = NOW) => verifyReceipt(join(home, 'packet-receipt.json'), GLM(), { environment: env, cwd: packet, now })
    expect(verify()).toEqual({ ok: true })
    writeFileSync(join(packet, 'prompt.md'), 'Review src/a.ts, and more.\n')
    expect(verify()).toMatchObject({ ok: false, reason: expect.stringContaining('packet') })
    writeFileSync(join(packet, 'prompt.md'), 'Review src/a.ts.\n')
    writeFileSync(join(packet, 'src/a.ts'), 'export const a = 2\n')
    expect(verify()).toMatchObject({ ok: false })
  })

  it('for a destination that may see private work, an unreadable prompt is a workspace problem and a missing packet a packet problem', () => {
    expect(check({ stdin: 'no-such-prompt.md', argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_MISMATCH')
    expect(check({ packet: join(home, 'no-such-packet'), argv: ASTRA_REVIEW(workspace) })).toMatchObject({ code: 'PACKET_INVALID' })
    // The workspace problem comes before the version in the contract order.
    stub('codex', 'codex-cli 0.170.0')
    expect(check({ stdin: 'no-such-prompt.md', argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_MISMATCH')
  })
})

describe('harness versions (60.3 AC3)', () => {
  it('supports every installed version and notes whether BMN tested it (owner decision 2026-10-10)', () => {
    const argv = ASTRA_REVIEW(workspace)
    expect(check({ argv }).receipt?.harness_version).toEqual({ version: '0.161.0', state: 'tested' })
    stub('codex', 'codex-cli 0.170.0')
    expect(check({ argv }).receipt?.harness_version).toEqual({ version: '0.170.0', state: 'newer than BMN tested' })
    stub('codex', 'codex-cli 0.160.9')
    expect(check({ argv }).receipt?.harness_version).toEqual({ version: '0.160.9', state: 'not a version BMN tested' })
    // A list of versions accepted under the earlier rule is still valid in the team file and changes nothing.
    approve(roster((text) => edit(text, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: observed-default, accepted_versions: ["0.170.0"]}')))
    expect(check({ argv }).receipt?.harness_version).toEqual({ version: '0.160.9', state: 'not a version BMN tested' })
  })

  it('still refuses a changed destination on a newer version: the destination is checked at every dispatch', () => {
    stub('codex', 'codex-cli 0.170.0')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://proxy.example.com/v1"\n')
    expect(check({ argv: ASTRA_REVIEW(workspace) })).toMatchObject({ verdict: 'REFUSED', code: 'HOST_MISMATCH' })
  })

  it('refuses private data when the app\'s version cannot be read, and notes it for public data', () => {
    stub('codex', 'codex-cli')
    expect(check({ argv: ASTRA_REVIEW(workspace) })).toMatchObject({ code: 'HARNESS_UNKNOWN', message: expect.stringContaining("cannot read this app's version") })
    const repo = join(home, 'public')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'remote', 'add', 'origin', 'https://github.com/synthetic-owner/synthetic-repo.git')
    recordVisibility(repo)
    const pub = check({ workspace: repo, cwd: repo, data: 'public', argv: ASTRA_REVIEW(repo) })
    expect(pub.receipt?.harness_version).toEqual({ version: null, state: 'version unreadable' })
  })

  it('remembers a version against the executable that ran, never an earlier non-executable file of that name', () => {
    const first = join(home, 'path-a')
    const second = join(home, 'path-b')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'codex'), 'not a program\n', { mode: 0o644 })
    const install = (version: string) => {
      rmSync(join(second, 'codex'), { force: true })
      writeFileSync(join(second, 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 })
    }
    const environment = { ...env, PATH: `${first}:${second}:/usr/bin:/bin` }
    install('0.171.0')
    expect(harnessVersion('codex', environment)).toBe('0.171.0')
    install('0.172.0')
    expect(harnessVersion('codex', environment)).toBe('0.172.0')
  })

  it('asks the version afresh: a launcher that stays the same file while the program behind it changes', () => {
    const bin = join(home, 'launcher-bin')
    const program = join(home, 'real-codex')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${program}" "$@"\n`, { mode: 0o755 })
    const install = (version: string) => writeFileSync(program, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 })
    const environment = { ...env, PATH: `${bin}:/usr/bin:/bin` }
    install('0.171.0')
    expect(harnessVersion('codex', environment)).toBe('0.171.0')
    install('0.172.0')
    expect(harnessVersion('codex', environment)).toBe('0.172.0')
    rmSync(program)
    expect(harnessVersion('codex', environment)).toBeNull()
  })
})

function runCli(args: string[], extraEnv: Record<string, string> = {}, nodeArgs: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [...nodeArgs, CLI, ...args], { env: { ...env, ...extraEnv }, cwd: workspace, timeout: 15_000 },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr }))
    child.stdin?.end()
  })
}

describe('a missing or invalid team file (R60-NFR1)', () => {
  const file = (): string => join(home, '.config/bmn/agents/roster.md')
  const args = (): string[] => ['roster', 'check', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--json', '--', ...ASTRA_REVIEW(workspace)]

  it('never passes a dispatch, though the approved version is intact', async () => {
    const pass = check({ argv: ASTRA_REVIEW(workspace) })
    expect(pass.verdict).toBe('PASS')
    writeFileSync(join(home, 'receipt.json'), JSON.stringify(pass.receipt))
    const text = readFileSync(file(), 'utf8')
    rmSync(file())
    expect(() => check({ argv: ASTRA_REVIEW(workspace) })).toThrowError(expect.objectContaining({ code: 'ROSTER_MISSING' }))
    const missing = await runCli(args())
    expect(missing.code).toBe(3)
    expect(missing.stdout).not.toContain('PASS')
    expect(verifyReceipt(join(home, 'receipt.json'), ASTRA_REVIEW(workspace), { environment: env, cwd: workspace, now: NOW })).toMatchObject({ ok: false, reason: expect.stringContaining('ROSTER_MISSING') })
    writeFileSync(file(), edit(text, 'schema_version: 2', 'schema_version: 9'))
    expect(() => check({ argv: ASTRA_REVIEW(workspace) })).toThrowError(expect.objectContaining({ code: 'ROSTER_INVALID' }))
    const invalid = await runCli(args())
    expect(invalid.code).toBe(4)
    expect(invalid.stdout).not.toContain('PASS')
  })

  it('a valid edit not yet approved changes nothing: the approved version still decides', async () => {
    const text = readFileSync(file(), 'utf8')
    writeFileSync(file(), edit(text, 'hosts: [api.openai.com], sites: [openai.com], private_work: allowed', 'hosts: [api.openai.com], sites: [openai.com], private_work: public_only'))
    const pending = check({ argv: ASTRA_REVIEW(workspace) })
    expect(pending.verdict).toBe('PASS')
    expect(pending.receipt).toMatchObject({ roster_file_hash: sha256(readFileSync(file(), 'utf8')), generation: { number: readApproved().number } })
    expect((await runCli(args())).code).toBe(0)
  })

  it('never passes a research run', () => {
    const run = prepareResearchRun('Research these models: claude-fable-5-1.\n', { now: NOW })
    rmSync(file())
    expect(() => evaluateResearch({ agent: 'fable', argv: [], stdin: run.prompt, cwd: run.cwd }, { environment: env, cwd: run.cwd, now: NOW }))
      .toThrowError(expect.objectContaining({ code: 'ROSTER_MISSING' }))
  })
})

describe('receipts and --verify (60.3 AC7)', () => {
  it('returns a hashed receipt and refuses it after any hashed input changes', async () => {
    writeFileSync(join(workspace, 'prompt.md'), 'Review this.\n')
    const argv = ASTRA_REVIEW(workspace)
    const pass = await runCli(['roster', 'check', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--stdin', 'prompt.md', '--json', '--', ...argv])
    expect(pass.code, pass.stderr).toBe(0)
    const receipt = JSON.parse(pass.stdout)
    expect(receipt).toMatchObject({ version: 1, verdict: 'PASS', class: 'bishop', stdin: { path: join(workspace, 'prompt.md') } })
    expect(Object.keys(receipt).sort()).toEqual(['agent', 'argv_sha256', 'class', 'context_limit_applied', 'cwd', 'data', 'effort', 'generation', 'harness', 'harness_version',
      'issued_at', 'mode', 'model', 'private_work', 'public_status', 'receipt_hash', 'role', 'roster_file_hash', 'route', 'stdin', 'verdict', 'version', 'workspace'])
    writeFileSync(join(home, 'receipt.json'), pass.stdout)
    expect((await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])).code).toBe(0)
    // The argv, the stdin file, a tampered receipt and an approval each invalidate it.
    expect((await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv.slice(0, -2), 'other.md', '-'])).code).toBe(11)
    writeFileSync(join(workspace, 'prompt.md'), 'Review this, and also that.\n')
    const stale = await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])
    expect(stale.code).toBe(11)
    expect(stale.stdout).toContain('stdin changed')
    writeFileSync(join(workspace, 'prompt.md'), 'Review this.\n')
    writeFileSync(join(home, 'tampered.json'), JSON.stringify({ ...receipt, data: 'public' }))
    expect((await runCli(['roster', 'check', '--verify', join(home, 'tampered.json'), '--', ...argv])).code).toBe(11)
    writeFileSync(join(home, 'malformed.json'), '{ not json')
    expect((await runCli(['roster', 'check', '--verify', join(home, 'malformed.json'), '--', ...argv])).code).toBe(11)
    approve(roster((text) => edit(text, 'name: Sol', 'name: Sol2')))
    expect((await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])).code).toBe(11)
    // Approved state that is gone or corrupt makes the receipt unverifiable: exit 11, not 5 or 6.
    writeFileSync(join(home, '.config/bmn/agents/state/current'), '{corrupt')
    const corrupt = await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])
    expect(corrupt.code, corrupt.stdout + corrupt.stderr).toBe(11)
    rmSync(join(home, '.config/bmn/agents/state'), { recursive: true, force: true })
    expect((await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])).code).toBe(11)
  })

  it('refuses with exit 10 and a next step, and explains in words which source decided and why the workspace is private', async () => {
    const refused = await runCli(['roster', 'check', '--agent', 'sonnet', '--role', 'consultant', '--workspace', workspace, '--data', 'private', '--', ...ASTRA_REVIEW(workspace)])
    expect(refused.code).toBe(10)
    expect(refused.stdout).toMatch(/^REFUSED PROPOSED: .*\nNext: /)
    const explained = await runCli(['roster', 'explain', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--', ...ASTRA_REVIEW(workspace)])
    expect(explained.code).toBe(0)
    expect(explained.stdout).toContain('destination default:openai, provider openai (observed-default)')
    expect(explained.stdout).toContain('private work: OpenAI may see private work')
    expect(explained.stdout).toContain(`workspace ${workspace}: private (no record); data private`)
    expect(explained.stdout).toContain('PASS: this dispatch may proceed.')
    const viaEnv = await runCli(['roster', 'explain', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--', ...ASTRA_REVIEW(workspace)],
      { OPENAI_BASE_URL: 'https://api.openai.com/v1' })
    expect(viaEnv.stdout).toContain('REFUSED HOST_MISMATCH')
    expect((await runCli(['roster', 'check', '--agent', 'astra', '--workspace', workspace, '--data', 'private', '--', 'codex'])).code).toBe(2)
  })

  it('`bmn roster route` names the provider a destination reaches, as inspection only', async () => {
    const route = await runCli(['roster', 'route', '--agent', 'astra'])
    expect(route.code, route.stderr).toBe(0)
    expect(route.stdout).toContain('inspection only, never an authorization')
    expect(route.stdout).toContain('destination: default:openai (default)')
    expect(route.stdout).toContain('provider: openai (may see private work)')
    const kimi = JSON.parse((await runCli(['roster', 'route', '--agent', 'kimi', '--json'])).stdout)
    expect(kimi).toMatchObject({ agent: 'kimi', harness: 'opencode', inspection_only: true, basis: 'unknown' })
  })
})

describe('codex exec resume (60.3 AC8)', () => {
  const SESSION = '01a2b3c4-0000-7000-8000-000000000001'
  const resumeArgv = () => ['codex', 'exec', 'resume', SESSION, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=low', '-c', 'approval_policy="never"', '--sandbox', 'read-only', '--json', '-']
  /** Resume is checked only on versions a test covered; these tests stand in for that list. */
  const supported: Options = { resumeVersions: { codex: ['0.161.0'] } }
  let original: string

  function sessionRecord(meta: Record<string, unknown>): void {
    const folder = join(home, '.codex/sessions/2026/10/09')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `rollout-2026-10-09T10-00-00-${SESSION}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: SESSION, cwd: workspace, model_provider: 'openai', cli_version: '0.161.0', base_instructions: 'x', ...meta } })}\n{"type":"later"}\n`)
  }

  const resume = (inputs: Partial<Inputs> = {}, options: Options = supported) => check({ argv: resumeArgv(), resumeOf: original, ...inputs }, env, options)

  beforeEach(() => {
    const first = check({ argv: ASTRA_REVIEW(workspace) })
    original = join(home, 'original.json')
    writeFileSync(original, JSON.stringify(first.receipt))
    sessionRecord({})
  })

  it('passes only with the original receipt, bound to that session when it started', () => {
    expect(resume().code).toBe('RESUME_UNBOUND')
    bindSession(original, SESSION, { now: new Date(NOW.getTime() + 30_000) })
    const pass = resume()
    expect(pass.verdict, JSON.stringify(pass)).toBe('PASS')
    expect(pass.receipt?.resume).toMatchObject({ session_id: SESSION })
    expect(check({ argv: resumeArgv() }, env, supported).code).toBe('RESUME_UNBOUND')
    writeFileSync(join(home, 'tampered.json'), JSON.stringify({ ...JSON.parse(readFileSync(original, 'utf8')), workspace: home }))
    expect(resume({ resumeOf: join(home, 'tampered.json') }).code).toBe('RESUME_UNBOUND')
    // A current configuration that resolves another destination than the checked one.
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "openai"\n')
    expect(resume().code).toBe('RESUME_UNBOUND')
  })

  it('accepts a binding once per receipt, and only within ten minutes of the check', () => {
    expect(() => bindSession(original, SESSION, { now: new Date(NOW.getTime() + 10 * 60_000 + 1) })).toThrow(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(() => bindSession(original, SESSION, { now: new Date(NOW.getTime() - 1) })).toThrow(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(resume().code).toBe('RESUME_UNBOUND')
    bindSession(original, SESSION, { now: new Date(NOW.getTime() + 10 * 60_000) })
    expect(() => bindSession(original, 'ffffffff-0000-7000-8000-000000000002', { now: new Date(NOW.getTime() + 1000) })).toThrow(expect.objectContaining({ code: 'RECEIPT_INVALID', message: expect.stringContaining('once') }))
    expect(resume().verdict).toBe('PASS')
    // Another session than the bound one.
    const other = resumeArgv().map((part) => (part === SESSION ? 'ffffffff-0000-7000-8000-000000000002' : part))
    expect(resume({ argv: other }).code).toBe('RESUME_UNBOUND')
    writeFileSync(join(home, 'tampered.json'), '{}')
    expect(() => bindSession(join(home, 'tampered.json'), SESSION, { now: NOW })).toThrow(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
  })

  it('`bmn roster bind` records the binding and exits 11 for a second one', async () => {
    const receipt = await runCli(['roster', 'check', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--json', '--', ...ASTRA_REVIEW(workspace)])
    writeFileSync(join(home, 'live.json'), receipt.stdout)
    const bound = await runCli(['roster', 'bind', '--receipt', join(home, 'live.json'), '--session', SESSION])
    expect(bound.code, bound.stderr).toBe(0)
    expect(bound.stdout).toContain(`Bound session ${SESSION}`)
    expect((await runCli(['roster', 'bind', '--receipt', join(home, 'live.json'), '--session', SESSION])).code).toBe(11)
    expect((await runCli(['roster', 'bind', '--receipt', join(home, 'live.json')])).code).toBe(2)
  })

  it.each([
    ['a provider mismatch', { model_provider: 'corp' }],
    ['a cwd outside the workspace', { cwd: '/' }],
    ['a different id', { id: 'ffffffff-0000-7000-8000-000000000001' }]
  ])('refuses %s in the session record', (_name, meta) => {
    bindSession(original, SESSION, { now: NOW })
    sessionRecord(meta)
    expect(resume().code).toBe('RESUME_UNBOUND')
  })

  it('refuses a missing session record, and a resume in packet mode', () => {
    bindSession(original, SESSION, { now: NOW })
    mkdirSync(join(home, 'packet'))
    expect(resume({ packet: join(home, 'packet') }).code).toBe('RESUME_UNBOUND')
    rmSync(join(home, '.codex/sessions'), { recursive: true })
    expect(resume().code).toBe('RESUME_UNBOUND')
  })

  it('is not checked at all on a Codex version no test covered: ROUTE_UNSUPPORTED, so a recheck starts a fresh dispatch', () => {
    bindSession(original, SESSION, { now: NOW })
    expect(resume({}, {})).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: expect.stringContaining('start a fresh checked dispatch') })
    expect(resume({}, { resumeVersions: { codex: ['0.160.0'] } }).code).toBe('ROUTE_UNSUPPORTED')
  })
})

describe('research runs (60.3 AC11)', () => {
  const RESEARCH = (extra: string[] = [], model = 'fable') => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', model, '--effort', model === 'fable' ? 'medium' : 'low',
    '--safe-mode', '--tools', 'WebSearch,WebFetch', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'json', ...extra]
  let run: ReturnType<typeof prepareResearchRun>
  type ResearchOptions = NonNullable<Parameters<typeof evaluateResearch>[1]>

  const research = (inputs: { agent?: string; argv?: string[]; stdin?: string; cwd?: string } = {}, options: ResearchOptions = {}) =>
    evaluateResearch({ agent: 'fable', argv: RESEARCH(), stdin: run.prompt, cwd: run.cwd, ...inputs }, { environment: env, cwd: run.cwd, now: NOW, ...options })

  beforeEach(() => {
    run = prepareResearchRun('Research these models: claude-fable-5-1, gpt-6-astra.\n', { now: NOW })
  })

  it('passes the exact fenced form, from the empty folder BMN made, fed the prompt BMN wrote', () => {
    const pass = research()
    expect(pass.verdict, JSON.stringify(pass)).toBe('PASS')
    expect(pass.receipt).toMatchObject({ mode: 'research', agent: 'fable', model: 'fable', effort: 'medium', cwd: run.cwd, stdin: { path: run.prompt },
      route: { host: 'default:anthropic', provider: 'anthropic' }, private_work: { allowed: true } })
    expect(pass.receipt).not.toHaveProperty('workspace')
    writeFileSync(join(home, 'research.json'), JSON.stringify(pass.receipt))
    expect(verifyReceipt(join(home, 'research.json'), RESEARCH(), { environment: env, cwd: run.cwd })).toEqual({ ok: true })
    expect(verifyReceipt(join(home, 'research.json'), RESEARCH(['--add-dir', home]), { environment: env, cwd: run.cwd })).toMatchObject({ ok: false })
  })

  it.each([
    ['other tools', () => RESEARCH().map((part) => (part === 'WebSearch,WebFetch' ? 'WebSearch,WebFetch,Read' : part))],
    ['no --safe-mode', () => RESEARCH().filter((part) => part !== '--safe-mode')],
    ['no --no-session-persistence', () => RESEARCH().filter((part) => part !== '--no-session-persistence')],
    ['another output format', () => RESEARCH().map((part) => (part === 'json' ? 'text' : part))],
    ['a non-empty --mcp-config', () => RESEARCH().map((part) => (part === '{"mcpServers":{}}' ? '{"mcpServers":{"x":{"command":"y"}}}' : part))],
    ['no --strict-mcp-config', () => RESEARCH().filter((part) => part !== '--strict-mcp-config')],
    ['--settings', () => RESEARCH(['--settings', '{}'])],
    ['--add-dir', () => RESEARCH(['--add-dir', '/'])],
    ['--append-system-prompt', () => RESEARCH(['--append-system-prompt', 'rules'])],
    ['--permission-mode', () => RESEARCH(['--permission-mode', 'dontAsk'])],
    ['--resume', () => RESEARCH(['--resume', 'abc'])],
    ['an extra environment value', () => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'EXTRA=1', ...RESEARCH().slice(4)]],
    ['no env -i', () => RESEARCH().slice(4)],
    ['codex', () => ['codex', 'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=low', '-']]
  ])('refuses the form with %s: ROUTE_UNSUPPORTED', (_name, argv) => {
    expect(research({ argv: argv() })).toMatchObject({ verdict: 'REFUSED', code: 'ROUTE_UNSUPPORTED' })
  })

  it('applies every agent-level check of a dispatch', () => {
    expect(research({ agent: 'nova' }).code).toBe('UNKNOWN_AGENT')
    expect(research({ agent: 'sonnet' }).code).toBe('PROPOSED')
    expect(research({ argv: RESEARCH([], 'claude-opus-5-5') }).code).toBe('MODEL_MISMATCH')
    expect(research({ argv: RESEARCH().map((part) => (part === 'medium' ? 'max' : part)) }).code).toBe('EFFORT_UNSUPPORTED')
    expect(research({ argv: ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'ANTHROPIC_BASE_URL=https://proxy.example.test', ...RESEARCH().slice(4)] }).code).toBe('HOST_MISMATCH')
    stub('claude', '2.9.0 (Claude Code)')
    expect(research().receipt?.harness_version).toEqual({ version: '2.9.0', state: 'newer than BMN tested' })
    expect(research({}, { testedVersions: { claude: ['2.9.0'] } }).receipt?.harness_version).toEqual({ version: '2.9.0', state: 'tested' })
    stub('claude', 'Claude Code')
    expect(research().code).toBe('HARNESS_UNKNOWN')
  })

  it('refuses a folder that is not the empty one BMN made, and a prompt that is not the one BMN wrote', () => {
    expect(research({ cwd: workspace }).code).toBe('WORKSPACE_MISMATCH')
    expect(research({ cwd: run.folder }).code).toBe('WORKSPACE_MISMATCH')
    writeFileSync(join(workspace, 'prompt.md'), readFileSync(run.prompt, 'utf8'))
    expect(research({ stdin: join(workspace, 'prompt.md') }).code).toBe('WORKSPACE_MISMATCH')
    writeFileSync(run.prompt, 'Research these models, and read ~/.ssh too.\n')
    expect(research()).toMatchObject({ code: 'WORKSPACE_MISMATCH', next: expect.stringContaining('Team, Models') })
    run = prepareResearchRun('Another prompt.\n', { now: new Date(NOW.getTime() + 1000) })
    writeFileSync(join(run.cwd, 'leftover.txt'), 'x')
    expect(research().code).toBe('WORKSPACE_MISMATCH')
  })

  it('a public-only researcher passes only on an app version whose fence was verified', () => {
    const glm = ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic', ...RESEARCH([], 'glm-5.3').slice(4)]
    expect(research({ agent: 'glm', argv: glm })).toMatchObject({ code: 'PACKET_INVALID', message: expect.stringContaining('fence') })
    const pass = research({ agent: 'glm', argv: glm }, { fenceVersions: { claude: ['2.1.295'] } })
    expect(pass.verdict, JSON.stringify(pass)).toBe('PASS')
    expect(pass.receipt?.private_work).toEqual({ answer: 'public_only', allowed: false })
  })

  it('`bmn roster check --research` takes --agent and --stdin in place of role, workspace and data', async () => {
    const args = ['roster', 'check', '--research', '--agent', 'fable', '--stdin', run.prompt, '--cwd', run.cwd, '--json', '--', ...RESEARCH()]
    const pass = await runCli(args)
    expect(pass.code, pass.stdout + pass.stderr).toBe(0)
    expect(JSON.parse(pass.stdout)).toMatchObject({ mode: 'research', verdict: 'PASS' })
    expect((await runCli(['roster', 'check', '--research', '--agent', 'fable', '--stdin', run.prompt, '--role', 'consultant', '--', ...RESEARCH()])).code).toBe(2)
    expect((await runCli(['roster', 'check', '--research', '--agent', 'fable', '--', ...RESEARCH()])).code).toBe(2)
  })
})

describe('only allowlisted paths are read (R60-NFR3)', () => {
  it('PASS: a full check reads roster state, named config files, stdin and nothing else', async () => {
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/config.toml'), 'model = "gpt-6-astra"\n')
    writeFileSync(join(home, '.codex/auth.json'), '{"secret":"never read"}')
    writeFileSync(join(workspace, 'prompt.md'), 'x')
    const tracer = join(home, 'trace.mjs')
    writeFileSync(tracer, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const log = []
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'realpathSync', 'statSync', 'lstatSync', 'existsSync']) {
  const original = fs[name]
  fs[name] = function (path, ...rest) { if (typeof path === 'string' || path instanceof URL) log.push(name + ' ' + String(path)); return original.call(this, path, ...rest) }
}
syncBuiltinESMExports()
process.on('exit', () => fs.writeFileSync(${JSON.stringify(join(home, 'reads.log'))}, log.join('\\n')))
`)
    const result = await runCli(['roster', 'check', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--stdin', 'prompt.md', '--json', '--', ...ASTRA_REVIEW(workspace)], {}, ['--import', tracer])
    expect(result.code, result.stderr).toBe(0)
    const reads = readFileSync(join(home, 'reads.log'), 'utf8').split('\n').map((line) => line.slice(line.indexOf(' ') + 1))
    const allowed = [
      new RegExp(`^${home}/\\.config/bmn/agents/(roster\\.md|state/current|state/generations/\\d+\\.json|state/generations|state/visibility/[0-9a-f]{64}\\.json)$`),
      new RegExp(`^${home}/\\.codex/config\\.toml$`),
      // Config files Codex may also load: the machine's, and one in the working folder or a folder above it.
      /^\/etc\/codex\/(config|managed_config)\.toml$/, /^(\/[^/]+)*\/\.codex\/config\.toml$/,
      new RegExp(`^${workspace}(/prompt\\.md)?$`),
      // The workspace's root: is there a .git here or in a folder above?
      /^(\/[^/]+)*\/\.git$/,
      // An exception names a folder; the check resolves it and reads nothing in it.
      /^\/synthetic\/EXCEPTION-SENTINEL-FOLDER$/,
      /\/apps\/desktop\/bin\//, /\/node_modules\//, /^\/proc\/self\//, /^\/(usr|lib|etc\/ld)/, new RegExp(`^${stubs}`)
    ]
    const unexpected = reads.filter((path) => path !== '' && !allowed.some((pattern) => pattern.test(path)))
    expect(unexpected, unexpected.length ? 'FAIL' : 'PASS').toEqual([])
    expect(reads.some((path) => path.includes('auth.json'))).toBe(false)
  })
})

describe('readCodexConfig', () => {
  it('reads only the named keys and marks unreadable ones', () => {
    const config = readCodexConfig([
      'model = "m" # comment', 'model_reasoning_effort = "high"', 'instructions = """', 'model_provider = "not-a-key"', '"""',
      'tags = [', '  "model_provider = x"', ']', '[profiles.p]', 'model = \'pm\'', '[model_providers."my-corp"]', 'base_url = "https://h.example"',
      '[tui.model_availability_nux]', '"gpt-6.1-sol" = 1'
    ].join('\n'))
    expect(config.top).toEqual({ model: 'm', model_reasoning_effort: 'high' })
    expect(config.profiles).toEqual({ p: { model: 'pm' } })
    expect(config.providers['my-corp']).toEqual({ base_url: 'https://h.example' })
    expect(config.unreadable).toEqual([])
    expect(readCodexConfig('model_provider = 42\n').unreadable).toEqual(['model_provider'])
  })
})

describe('consequences in words (60.5 AC7; the same sentences `bmn roster status` prints)', () => {
  const data = (text: string) => {
    const parsed = parseRoster(text)
    if (parsed.data === null) throw new Error(JSON.stringify(parsed.errors))
    return parsed.data
  }
  const LUNA = 'name: Luna\nclass: pawn'
  const OPENAI = 'hosts: [api.openai.com], sites: [openai.com], private_work: allowed'
  const ZAI = 'hosts: [api.z.ai], private_work: public_only'
  const SOL_ON = 'provider: openai\nhost: default\nenabled: true\nstatus: active\nefforts: [low, medium, high, xhigh, max]\nroles: [lead]\ncontext_window'
  const GLM_ON = roster()

  it.each([
    ["a provider's answer changed to public work only", EXAMPLE, (text: string) => edit(text, OPENAI, OPENAI.replace('allowed', 'public_only')),
      ['Changing OpenAI to Public work only stops Sol, Astra and Luna receiving private work']],
    ["a provider's answer changed to allowed", GLM_ON, (text: string) => edit(text, ZAI, ZAI.replace('public_only', 'allowed')),
      ['Changing Z.ai to Allowed lets GLM-5.3 receive private work']],
    ['an answer changed for a provider with no active agent', EXAMPLE, (text: string) => edit(text, ZAI, ZAI.replace('public_only', 'allowed')),
      ['Changing Z.ai to Allowed changes no active agent yet']],
    ['a pawn made knight with the lead role', EXAMPLE, (text: string) => edit(edit(edit(text, LUNA, LUNA.replace('pawn', 'knight')),
      'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]', 'roles: [lead, helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]'),
    'candidates: [sol@xhigh, opus@xhigh], then: owner-chooses}', 'candidates: [sol@xhigh, opus@xhigh, luna@max], then: owner-chooses}'),
    ['Luna could lead', 'Luna could take the lead role']],
    ['a chain reordered', EXAMPLE, (text: string) => edit(text, 'epic-reviewer: {candidates: [astra@medium, fable@medium]', 'epic-reviewer: {candidates: [fable@medium, astra@medium]'),
      ['epic-reviewer would start with Fable instead of Astra']],
    ['then changed', EXAMPLE, (text: string) => edit(text, 'pre-reviewer: {candidates: [luna@max], then: skip}\nepic', 'pre-reviewer: {candidates: [luna@max], then: lead}\nepic'),
      ['when every pre-reviewer candidate fails: lead instead of skip']],
    ['an agent switched off', EXAMPLE, (text: string) => edit(text, SOL_ON, SOL_ON.replace('enabled: true', 'enabled: false')),
      ['Sol could no longer be given work', 'Sol could no longer lead', 'Sol could no longer receive private work', 'lead would start with Opus instead of Sol']],
    ['a context limit set and one removed', EXAMPLE, (text: string) => edit(edit(text, 'context_window: 400000\ncontext_limit: 272000', 'context_window: 400000'),
      'efforts: [low, medium, high]\nroles: [focused-reviewer, epic-reviewer, final-reviewer, consultant]', 'efforts: [low, medium, high]\nroles: [focused-reviewer, epic-reviewer, final-reviewer, consultant]\ncontext_limit: 272000'),
    ['Sol: context limit 272 000 → app default', 'Astra: context limit app default → 272 000']],
    ['an exception added, never naming its folder', EXAMPLE, (text: string) => edit(text, 'zai-synthetic: {provider: zai', 'cursor-app: {provider: cursor, folder: /synthetic/EXCEPTION-SENTINEL-NEW}\nzai-synthetic: {provider: zai'),
      ['Cursor could receive private work in one more workspace']],
    ['an exception removed', EXAMPLE, (text: string) => edit(text, '## exceptions\n\n```yaml\nzai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}\n```\n\n', ''),
      ['Z.ai could no longer receive private work in one workspace']],
    ['a destination declared on the owner\'s word', EXAMPLE, (text: string) => edit(text, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: owner-declared}'),
      ['Sol could no longer receive private work', 'Astra could no longer receive private work', 'Luna could no longer receive private work',
        'Codex would count as sending data to OpenAI on your word, so it gets public work only']],
    ['a version list kept from the earlier rule, which changes nothing', EXAMPLE, (text: string) => edit(text, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: observed-default, accepted_versions: ["0.170.0"]}'),
      []]
  ])('%s', (_name, from, change, expected) => {
    expect(consequences(data(from), data(change(from)))).toEqual(expected)
  })

  it('removing a version list kept from the earlier rule changes nothing either', () => {
    const accepted = edit(EXAMPLE, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: observed-default, accepted_versions: ["0.170.0"]}')
    expect(consequences(data(accepted), data(EXAMPLE))).toEqual([])
  })

  it('uses none of the words the owner never sees', () => {
    const all = consequences(null, data(GLM_ON)).join('\n')
    expect(all).not.toMatch(/\b(route|packet|High|Low|seal|generation|trust)\b/)
    expect(all).not.toContain('EXCEPTION-SENTINEL')
  })

  it('`bmn roster status` prints the same sentences under "If approved:"', async () => {
    approve(EXAMPLE)
    writeFileSync(join(home, '.config/bmn/agents/roster.md'), edit(EXAMPLE, OPENAI, OPENAI.replace('allowed', 'public_only')))
    const output = await new Promise<string>((resolve) => {
      execFile(process.execPath, [CLI, 'roster', 'status'], { env }, (_error, stdout) => resolve(stdout))
    })
    expect(output).toContain('If approved:\n  Changing OpenAI to Public work only stops Sol, Astra and Luna receiving private work')
  })
})
