// MODULE: agents-check.test.ts - Epic 60.3: `bmn roster check` over synthetic rosters, configs, stub harnesses and argv
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consequences, evaluate, harnessVersion, readCodexConfig, setReadTracer, verifyReceipt } from '../../bin/agents-check.mjs'
import { readValidRoster } from '../../bin/agents-state.mjs'
import { parseRoster } from '../../bin/agents-roster.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')

let home: string
let stubs: string
let workspace: string
let env: Record<string, string>
const savedHome = process.env.HOME

function edit(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
  return text.replace(from, to)
}

/** The example plus an enabled Low agent on a Low host, and a public and a private workspace label. */
function roster(extra: (text: string) => string = (text) => text): string {
  let text = EXAMPLE
  text = edit(text, 'enabled: false\nenabled_note: NOTE-SENTINEL-GLM\nstatus: active\nefforts: []', 'enabled: true\nstatus: active\nefforts: [low]')
  text = edit(text, 'default: private\n', `default: private\n${home}/public: public\n${home}/work: private\n`)
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
  approveRoster({ generation, fileHash: readValidRoster().hash }, { checkNewlyAccepted: () => {} })
}

function stub(name: string, version: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\necho "${version}"\n`)
  chmodSync(join(stubs, name), 0o755)
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

function check(inputs: Partial<Parameters<typeof evaluate>[0]> & { argv: string[] }, environment = env) {
  return evaluate({ agent: 'astra', role: 'epic-reviewer', workspace, data: 'private', cwd: workspace, ...inputs } as Parameters<typeof evaluate>[0],
    { environment, cwd: workspace })
}

describe('dispatch forms dev-auto documents (60.3 AC1-AC2)', () => {
  it('accepts every documented form as written, including the fable alias', () => {
    const astra = check({ argv: ASTRA_REVIEW(workspace) })
    expect(astra.verdict, JSON.stringify(astra)).toBe('PASS')
    expect(astra.receipt).toMatchObject({ agent: 'astra', model: 'gpt-6-astra', effort: 'medium', security: 'high', data: 'private',
      route: { provider: 'openai', host: 'default:openai', basis: 'default', sources: [] }, harness_version: { version: '0.161.0', state: 'tested' } })
    expect(check({ agent: 'luna', role: 'browser', argv: LUNA_BROWSE(workspace) }).verdict).toBe('PASS')
    const fable = check({ agent: 'fable', argv: FABLE_PACKET('the owner global rules') })
    expect(fable.verdict, JSON.stringify(fable)).toBe('PASS')
    expect(fable.receipt).toMatchObject({ model: 'fable', route: { host: 'default:anthropic' } })
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

  it('refuses disabled, proposed, unknown, ineligible agents and a squire as lead, in contract order', () => {
    approve(roster((text) => edit(text, 'name: Opus\ntitle: knight\nharness: claude\nmodel: claude-opus-5-5\nprovider: anthropic\nhost: default\nsecurity: high\ntrust: 3\nauthority: lead\nenabled: true',
      'name: Opus\ntitle: knight\nharness: claude\nmodel: claude-opus-5-5\nprovider: anthropic\nhost: default\nsecurity: high\ntrust: 3\nauthority: lead\nenabled: false')))
    const argv = ASTRA_REVIEW(workspace)
    expect(check({ agent: 'nova', argv }).code).toBe('UNKNOWN_AGENT')
    expect(check({ agent: 'sonnet', argv }).code).toBe('PROPOSED')
    expect(check({ agent: 'opus', role: 'lead', argv }).code).toBe('DISABLED')
    expect(check({ role: 'jester', argv }).code).toBe('ROLE_UNKNOWN')
    expect(check({ role: 'helper', argv }).code).toBe('ROLE_INELIGIBLE')
    // A squire that somehow holds lead (approved data edited by hand is outside the validator) is still refused.
    expect(check({ agent: 'luna', role: 'lead', argv }).code).toBe('ROLE_INELIGIBLE')
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

  it('treats a Low agent or a missing route as Low (an owner-declared route with a High default agent fails validation)', () => {
    const argv = ASTRA_REVIEW(workspace)
    // Treated as Low: Codex is never a Low route (ROUTE_UNSUPPORTED comes before DATA_FORBIDDEN in the contract order).
    const asLow = { code: 'ROUTE_UNSUPPORTED', message: expect.stringContaining('a Low dispatch goes only through a packet') }
    approve(roster((text) => edit(text, 'codex: {provider: openai, security: high, basis: observed-default}\n', '')))
    expect(check({ argv })).toMatchObject(asLow)
    mkdirSync(join(home, 'public'))
    const publicDir = join(home, 'public')
    expect(check({ argv: ASTRA_REVIEW(publicDir), workspace: publicDir, cwd: publicDir, data: 'public' })).toMatchObject({ code: 'ROUTE_UNSUPPORTED' })
    approve(roster((text) => edit(text, 'name: Astra\ntitle: knight\nharness: codex\nmodel: gpt-6-astra\nprovider: openai\nhost: default\nsecurity: high',
      'name: Astra\ntitle: knight\nharness: codex\nmodel: gpt-6-astra\nprovider: openai\nhost: default\nsecurity: low')))
    expect(check({ argv })).toMatchObject(asLow)
  })

  it('records only provider, host and source names, never URL paths or other environment values', () => {
    const result = check({ agent: 'glm', role: 'helper', data: 'public', argv: ['env', '-i', `PATH=${env.PATH}`, 'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic?token=SECRET', 'claude', '-p', '--model', 'glm-5.3', '--effort', 'low'] })
    expect(result.verdict).toBe('REFUSED')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('/api/anthropic')
  })
})

describe('workspaces and labels (60.3 AC5)', () => {
  it('canonicalizes, refuses .., nonexistent and outside paths, and matches labels on directory boundaries', () => {
    expect(check({ workspace: join(home, 'nope'), argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_UNKNOWN')
    expect(check({ workspace: `${workspace}/../work`, argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_UNKNOWN')
    expect(check({ argv: ASTRA_REVIEW(home) }).code).toBe('WORKSPACE_MISMATCH')
    expect(check({ cwd: home, argv: ASTRA_REVIEW(workspace) }).code).toBe('WORKSPACE_MISMATCH')
    mkdirSync(join(home, 'public/sub'), { recursive: true })
    mkdirSync(join(home, 'public-private'))
    const pub = check({ workspace: join(home, 'public/sub'), cwd: join(home, 'public/sub'), data: 'public', argv: ASTRA_REVIEW(join(home, 'public/sub')) })
    expect(pub.receipt).toMatchObject({ label: { value: 'public', source: 'inherited' }, data: 'public' })
    const sibling = check({ workspace: join(home, 'public-private'), cwd: join(home, 'public-private'), data: 'public', argv: ASTRA_REVIEW(join(home, 'public-private')) })
    expect(sibling.receipt).toMatchObject({ label: { value: 'private', source: 'default' }, data: 'private' })
    symlinkSync(join(home, 'public'), join(home, 'linked'))
    const linked = check({ workspace: join(home, 'linked'), cwd: join(home, 'public'), data: 'public', argv: ASTRA_REVIEW(join(home, 'public')) })
    expect(linked.receipt).toMatchObject({ workspace: join(home, 'public'), label: { value: 'public', source: 'explicit' } })
    // --data tightens public to private and never loosens.
    expect(check({ data: 'public', argv: ASTRA_REVIEW(workspace) }).receipt).toMatchObject({ label: { value: 'private', source: 'explicit' }, data: 'private' })
  })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
}

describe('Low routes and packet mode (60.3 AC6)', () => {
  let publicRepo: string
  let packet: string
  const LOW = (rules?: string) => ['env', '-i', `PATH=${env.PATH}`, 'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic', 'claude', '-p', '--model', 'glm-5.3',
    '--effort', 'low', '--tools', '', '--safe-mode', '--output-format', 'json', ...(rules === undefined ? [] : ['--append-system-prompt', rules])]

  beforeEach(() => {
    publicRepo = join(home, 'public')
    mkdirSync(join(publicRepo, 'src'), { recursive: true })
    writeFileSync(join(publicRepo, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(publicRepo, '.gitignore'), 'secret.env\n')
    writeFileSync(join(publicRepo, 'secret.env'), 'TOKEN=private\n')
    git(publicRepo, 'init', '-q')
    git(publicRepo, 'add', 'src/a.ts', '.gitignore')
    git(publicRepo, 'commit', '-q', '-m', 'init')
    writeFileSync(join(publicRepo, 'untracked.ts'), 'private draft\n')
    packet = join(home, 'packet')
    mkdirSync(join(packet, 'src'), { recursive: true })
    writeFileSync(join(packet, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(packet, 'prompt.md'), 'Review src/a.ts.\n')
  })

  const low = (overrides: Partial<Parameters<typeof evaluate>[0]> & { argv?: string[] } = {}) => check({
    agent: 'glm', role: 'helper', workspace: publicRepo, data: 'public', cwd: packet, packet, stdin: join(packet, 'prompt.md'), argv: LOW(), ...overrides
  })

  it('passes a packet of public tracked files and marks the prompt unverified', () => {
    const result = low()
    expect(result.verdict, JSON.stringify(result)).toBe('PASS')
    expect(result.receipt).toMatchObject({ security: 'low', data: 'public', route: { host: 'api.z.ai', basis: 'explicit' },
      packet: { path: packet, prompt: 'lead-authored, not verified', manifest: [{ name: 'prompt.md' }, { name: 'src/a.ts' }] } })
  })

  it('refuses private data on a Low route', () => {
    expect(low({ data: 'private' }).code).toBe('DATA_FORBIDDEN')
    expect(low({ workspace, cwd: workspace, packet: undefined, stdin: undefined, data: 'private' }).code).toBe('DATA_FORBIDDEN')
  })

  it.each([
    ['a private untracked file', () => writeFileSync(join(packet, 'untracked.ts'), 'private draft\n'), () => ({})],
    ['an ignored file', () => writeFileSync(join(packet, 'secret.env'), 'TOKEN=private\n'), () => ({})],
    ['a changed tracked file', () => writeFileSync(join(packet, 'src/a.ts'), 'export const a = 2\n'), () => ({})],
    ['the full global rules', () => undefined, () => ({ argv: LOW('the full global rules with private sections') })],
    ['a missing --safe-mode', () => undefined, () => ({ argv: LOW().filter((argument) => argument !== '--safe-mode') })],
    ['tools left on', () => undefined, () => ({ argv: LOW().map((argument) => (argument === '' ? 'Read' : argument)) })],
    ['no env -i', () => undefined, () => ({ argv: [...LOW().slice(4)] })],
    ['a cwd outside the packet', () => undefined, () => ({ cwd: publicRepo })],
    ['a prompt outside the packet', () => writeFileSync(join(home, 'prompt.md'), 'x'), () => ({ stdin: join(home, 'prompt.md') })],
    ['no packet', () => undefined, () => ({ packet: undefined, cwd: publicRepo, stdin: undefined })],
    ['a private-labelled workspace', () => undefined, () => ({ workspace })]
  ])('refuses packet mode with %s', (_name, prepare, overrides) => {
    prepare()
    const result = low(overrides() as Partial<Parameters<typeof evaluate>[0]>)
    expect(result.verdict).toBe('REFUSED')
    expect(['PACKET_INVALID', 'HOST_UNKNOWN', 'HOST_MISMATCH', 'WORKSPACE_MISMATCH', 'DATA_FORBIDDEN']).toContain(result.code)
  })

  it('--verify refuses a packet receipt once a packet file changed after the check', () => {
    const result = low()
    expect(result.verdict).toBe('PASS')
    writeFileSync(join(home, 'packet-receipt.json'), JSON.stringify(result.receipt))
    expect(verifyReceipt(join(home, 'packet-receipt.json'), LOW(), { environment: env, cwd: packet })).toEqual({ ok: true })
    writeFileSync(join(packet, 'src/a.ts'), 'export const a = 2\n')
    expect(verifyReceipt(join(home, 'packet-receipt.json'), LOW(), { environment: env, cwd: packet })).toMatchObject({ ok: false })
  })

  it('accepts the restricted rendering in --append-system-prompt and nothing else', () => {
    const result = evaluate({ agent: 'glm', role: 'helper', workspace: publicRepo, data: 'public', cwd: packet, packet, stdin: join(packet, 'prompt.md'), argv: LOW('RESTRICTED') },
      { environment: env, cwd: packet, restrictedRules: 'RESTRICTED' })
    expect(result.verdict).toBe('PASS')
  })

  it('refuses a Low dispatch through Codex', () => {
    approve(roster((text) => edit(text, 'name: Luna\ntitle: squire\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nsecurity: high',
      'name: Luna\ntitle: squire\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nsecurity: low')))
    expect(check({ agent: 'luna', role: 'helper', workspace: publicRepo, cwd: publicRepo, data: 'public', argv: LUNA_BROWSE(publicRepo) }).code).toBe('ROUTE_UNSUPPORTED')
    // ROUTE_UNSUPPORTED comes before DATA_FORBIDDEN in the contract order.
    expect(check({ agent: 'luna', role: 'helper', workspace: publicRepo, cwd: publicRepo, data: 'private', argv: LUNA_BROWSE(publicRepo) }).code).toBe('ROUTE_UNSUPPORTED')
  })

  it('a missing packet is a packet refusal and never pre-empts an earlier one', () => {
    const missing = join(home, 'no-such-packet')
    expect(low({ packet: missing, cwd: publicRepo, stdin: undefined, data: 'private' }).code).toBe('DATA_FORBIDDEN')
    expect(low({ packet: missing, cwd: publicRepo, stdin: undefined })).toMatchObject({ code: 'PACKET_INVALID', message: expect.stringContaining('not an existing directory') })
    expect(check({ packet: missing, argv: ASTRA_REVIEW(workspace) })).toMatchObject({ code: 'PACKET_INVALID' })
  })
})

describe('harness versions (60.3 AC3)', () => {
  it('refuses private data on an untested version, notes it for public data, and passes an owner-accepted one', () => {
    stub('codex', 'codex-cli 0.170.0')
    const argv = ASTRA_REVIEW(workspace)
    expect(check({ argv })).toMatchObject({ code: 'HARNESS_UNTESTED' })
    mkdirSync(join(home, 'public'))
    const pub = check({ workspace: join(home, 'public'), cwd: join(home, 'public'), data: 'public', argv: ASTRA_REVIEW(join(home, 'public')) })
    expect(pub.receipt?.harness_version).toEqual({ version: '0.170.0', state: 'untested' })
    approve(roster((text) => edit(text, 'codex: {provider: openai, security: high, basis: observed-default}', 'codex: {provider: openai, security: high, basis: observed-default, accepted_versions: ["0.170.0"]}')))
    expect(check({ argv }).receipt?.harness_version).toEqual({ version: '0.170.0', state: 'owner-accepted, untested' })
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

describe('receipts and --verify (60.3 AC7)', () => {
  it('returns a hashed receipt and refuses it after any hashed input changes', async () => {
    writeFileSync(join(workspace, 'prompt.md'), 'Review this.\n')
    const argv = ASTRA_REVIEW(workspace)
    const pass = await runCli(['roster', 'check', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--stdin', 'prompt.md', '--json', '--', ...argv])
    expect(pass.code, pass.stderr).toBe(0)
    const receipt = JSON.parse(pass.stdout)
    expect(receipt).toMatchObject({ version: 1, verdict: 'PASS', stdin: { path: join(workspace, 'prompt.md') } })
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
    approve(roster((text) => edit(text, 'name: Sol', 'name: Sol2')))
    expect((await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])).code).toBe(11)
    // Approved state that is gone or corrupt makes the receipt unverifiable: exit 11, not 5 or 6.
    writeFileSync(join(home, '.config/bmn/agents/state/current'), '{corrupt')
    const corrupt = await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])
    expect(corrupt.code, corrupt.stdout + corrupt.stderr).toBe(11)
    rmSync(join(home, '.config/bmn/agents/state'), { recursive: true, force: true })
    expect((await runCli(['roster', 'check', '--verify', join(home, 'receipt.json'), '--', ...argv])).code).toBe(11)
  })

  it('refuses with exit 10 and a next step, and explains in words', async () => {
    const refused = await runCli(['roster', 'check', '--agent', 'sonnet', '--role', 'consultant', '--workspace', workspace, '--data', 'private', '--', ...ASTRA_REVIEW(workspace)])
    expect(refused.code).toBe(10)
    expect(refused.stdout).toMatch(/^REFUSED PROPOSED: .*\nNext: /)
    const explained = await runCli(['roster', 'explain', '--agent', 'astra', '--role', 'epic-reviewer', '--workspace', workspace, '--data', 'private', '--', ...ASTRA_REVIEW(workspace)])
    expect(explained.code).toBe(0)
    expect(explained.stdout).toContain('route default:openai (default)')
    expect(explained.stdout).toContain('PASS: this dispatch may proceed.')
    expect((await runCli(['roster', 'check', '--agent', 'astra', '--workspace', workspace, '--data', 'private', '--', 'codex'])).code).toBe(2)
  })
})

describe('codex exec resume (60.3 AC8)', () => {
  const SESSION = '01a2b3c4-0000-7000-8000-000000000001'
  const resumeArgv = () => ['codex', 'exec', 'resume', SESSION, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=low', '-c', 'approval_policy="never"', '--sandbox', 'read-only', '--json', '-']
  let original: string

  function sessionRecord(meta: Record<string, unknown>): void {
    const folder = join(home, '.codex/sessions/2026/10/09')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `rollout-2026-10-09T10-00-00-${SESSION}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: SESSION, cwd: workspace, model_provider: 'openai', cli_version: '0.161.0', base_instructions: 'x', ...meta } })}\n{"type":"later"}\n`)
  }

  beforeEach(() => {
    const first = check({ argv: ASTRA_REVIEW(workspace) })
    original = join(home, 'original.json')
    writeFileSync(original, JSON.stringify(first.receipt))
    sessionRecord({})
  })

  it('passes only bound to the original receipt and the session record', () => {
    const pass = check({ argv: resumeArgv(), resumeOf: original })
    expect(pass.verdict, JSON.stringify(pass)).toBe('PASS')
    expect(pass.receipt?.resume).toMatchObject({ session_id: SESSION })
    expect(check({ argv: resumeArgv() }).code).toBe('RESUME_UNBOUND')
    writeFileSync(join(home, 'tampered.json'), JSON.stringify({ ...JSON.parse(readFileSync(original, 'utf8')), workspace: home }))
    expect(check({ argv: resumeArgv(), resumeOf: join(home, 'tampered.json') }).code).toBe('RESUME_UNBOUND')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "openai"\n')
    expect(check({ argv: resumeArgv(), resumeOf: original }).code).toBe('RESUME_UNBOUND')
  })

  it.each([
    ['a provider mismatch', { model_provider: 'corp' }],
    ['a cwd outside the workspace', { cwd: '/' }],
    ['a different id', { id: 'ffffffff-0000-7000-8000-000000000001' }]
  ])('refuses %s in the session record', (_name, meta) => {
    sessionRecord(meta)
    expect(check({ argv: resumeArgv(), resumeOf: original }).code).toBe('RESUME_UNBOUND')
  })

  it('refuses a missing session record', () => {
    rmSync(join(home, '.codex/sessions'), { recursive: true })
    expect(check({ argv: resumeArgv(), resumeOf: original }).code).toBe('RESUME_UNBOUND')
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
      new RegExp(`^${home}/\\.config/bmn/agents/(roster\\.md|state/current|state/generations/\\d+\\.json|state/generations)$`),
      new RegExp(`^${home}/\\.codex/config\\.toml$`),
      new RegExp(`^${workspace}(/prompt\\.md)?$`), new RegExp(`^${home}/(public|work)$`),
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

describe('consequences in words (60.5 AC2; the same sentences `bmn roster status` prints)', () => {
  const data = (text: string) => {
    const parsed = parseRoster(text)
    if (parsed.data === null) throw new Error(JSON.stringify(parsed.errors))
    return parsed.data
  }
  const LUNA = 'name: Luna\ntitle: squire\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nsecurity: high\ntrust: 2\nauthority: read'
  const ASTRA_SECURITY = 'model: gpt-6-astra\nprovider: openai\nhost: default\nsecurity: high'

  it.each([
    ['security High to Low', (text: string) => edit(text, ASTRA_SECURITY, ASTRA_SECURITY.replace('high', 'low')), ['Astra could no longer receive private work']],
    ['a squire made knight with lead authority and the lead role', (text: string) => edit(edit(edit(text, LUNA, LUNA.replace('squire', 'knight').replace('authority: read', 'authority: lead')),
      'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]', 'roles: [lead, helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]'),
    'lead: {candidates: [sol@xhigh, opus@xhigh], then: owner-chooses}', 'lead: {candidates: [sol@xhigh, opus@xhigh, luna@max], then: owner-chooses}'),
    ['Luna could lead', 'Luna could take the lead role']],
    ['a chain reordered', (text: string) => edit(text, 'epic-reviewer: {candidates: [astra@medium, fable@medium]', 'epic-reviewer: {candidates: [fable@medium, astra@medium]'),
      ['epic-reviewer would start with Fable instead of Astra']],
    ['then changed', (text: string) => edit(text, 'pre-reviewer: {candidates: [luna@max], then: skip}\nepic', 'pre-reviewer: {candidates: [luna@max], then: lead}\nepic'),
      ['when every pre-reviewer candidate fails: lead instead of skip']],
    ['an agent switched off', (text: string) => edit(text, 'authority: lead\nenabled: true\nstatus: active\nefforts: [low, medium, high, xhigh, max]\nroles: [lead]\ncost: low',
      'authority: lead\nenabled: false\nstatus: active\nefforts: [low, medium, high, xhigh, max]\nroles: [lead]\ncost: low'),
    ['Sol could no longer be dispatched', 'Sol could no longer lead', 'Sol could no longer receive private work', 'lead would start with Opus instead of Sol']]
  ])('%s', (_name, change, expected) => {
    const before = data(EXAMPLE)
    expect(consequences(before, data(change(EXAMPLE)))).toEqual(expected)
  })

  it('names a revoked accepted version', () => {
    const accepted = edit(EXAMPLE, 'codex: {provider: openai, security: high, basis: observed-default}', 'codex: {provider: openai, security: high, basis: observed-default, accepted_versions: [0.170.0]}')
    expect(consequences(data(accepted), data(EXAMPLE))).toEqual(['codex 0.170.0 could no longer carry private work (acceptance revoked)'])
  })

  it('names a folder becoming public, the default label and an accepted version', () => {
    const after = data(edit(edit(EXAMPLE, 'default: private\n', 'default: public\n/srv/app: public\n'),
      'codex: {provider: openai, security: high, basis: observed-default}', 'codex: {provider: openai, security: high, basis: observed-default, accepted_versions: [0.170.0]}'))
    expect(consequences(data(EXAMPLE), after)).toEqual([
      '/srv/app becomes public: Low routes could receive its tracked files in packets',
      'unlabelled workspaces become public',
      'codex 0.170.0 could carry private work (owner-accepted, untested by BMN)'
    ])
  })

  it('`bmn roster status` prints the same sentences under "If approved:"', async () => {
    approve(EXAMPLE)
    writeFileSync(join(home, '.config/bmn/agents/roster.md'), edit(EXAMPLE, ASTRA_SECURITY, ASTRA_SECURITY.replace('high', 'low')))
    const output = await new Promise<string>((resolve) => {
      execFile(process.execPath, [CLI, 'roster', 'status'], { env }, (_error, stdout) => resolve(stdout))
    })
    expect(output).toContain('If approved:\n  Astra could no longer receive private work')
  })
})
