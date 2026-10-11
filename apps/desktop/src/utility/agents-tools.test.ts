// MODULE: agents-tools.test.ts - Story 60.12: one list of MCP tools for every app, over a synthetic team, synthetic settings files in a temporary home and stub apps; no real app is started
import { execFile } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluate } from '../../bin/agents-check.mjs'
import { parseRoster, rewriteRoster, type RosterTool } from '../../bin/agents-roster.mjs'
import { listTransactions, restoreTransaction } from '../../bin/agents-rules.mjs'
import { machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import {
  appStateWord, appTools, checkExit, checkRunTools, checkTools, installTools, looksSecret, maskedEntry, neutralOf, pendingCounts, plainArgument, planToolsInstall, proposeTools,
  readAppTools, renderTool, runTools, testTools, toolItems, toolsPlanView, toolsTestsPath, transportWords, uncoveredSources, type ToolState, type ToolsTestEntry
} from '../../bin/agents-tools.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const NOW = new Date('2026-10-10T12:00:00.000Z')
const CODEX = '0.161.0'
const CLAUDE = '2.1.295'
const OPENCODE = '1.18.31'
const CURSOR = '2026.10.01'
const VERSIONS = { codex: CODEX, claude: CLAUDE, opencode: OPENCODE, cursor: CURSOR }
/** A value only an app's own entry holds: no plan, result, record or team file may carry it. */
const SECRET = 'sk-SYNTHETIC-SECRET-9f8e7d6c5b4a'

/**
 * The synthetic list. `docs` is an address for every app and public; `files` is a program kept to
 * Claude Code and Codex that names a variable under its own name; `notes` reaches every app that
 * may have private work; `browser` is kept to Luna's runs and `review` to Astra's and Fable's.
 */
const TOOLS = [
  'docs: {name: Docs, url: "https://docs.example.test/mcp", headers: {Authorization: DOCS_TOKEN}, public: true}',
  'files: {name: Files, command: files-tool, args: ["--root", /srv/files], env: {FILES_KEY: FILES_KEY}, apps: [claude, codex]}',
  'notes: {name: Notes, command: notes-tool}',
  'browser: {name: Browser, command: npx, args: ["--offline", "@synthetic/browser-mcp@1.0.0"], agents: [luna]}',
  'review: {name: Review, command: review-tool, env: {REVIEW_KEY: REVIEW_KEY}, agents: [astra, fable]}'
]

let home: string
let stubs: string
let workspace: string
let env: Record<string, string>
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }

const withTools = (lines: string[] = TOOLS, text = EXAMPLE): string => (lines.length === 0 ? text : `${text}\n## tools\n\n\`\`\`yaml\n${lines.join('\n')}\n\`\`\`\n`)

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

/**
 * A stand-in for an agent app, as a script. It answers `--version`, lists the tools in its own
 * settings file under the home folder it is given (starting each program the way the real app
 * does when `starts` is set), and runs its own add and remove commands. `reads` false makes it an
 * app that keeps its tools somewhere else; `listFails` one whose listing names the tools and ends
 * with an error. A run (`-p`) prints the line a real run prints once it has started its tools:
 * its own, and, unless told to take only those, the ones in its settings; with `folders` also the
 * ones in its settings for the folder and in the folder's `.mcp.json`. `leaky` is an app whose
 * run keeps the settings' tools whatever it is told, `leakyFolder` one that keeps the folder's.
 */
function app(name: string, version: string, { reads = true, starts = false, leaky = false, signIn = false, folders = false, leakyFolder = false, listFails = false } = {}): void {
  const kind = name === 'cursor-agent' ? 'cursor' : name
  writeFileSync(join(stubs, name), `#!${process.execPath}
const fs = require('fs'); const cp = require('child_process'); const path = require('path')
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('${name} ${version}'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(join(home, `calls-${name}.log`))}, JSON.stringify({ argv, env: Object.keys(process.env).sort(), home: process.env.HOME }) + '\\n')
if (${signIn}) { console.error('Please sign in'); process.exit(1) }
const HOME = process.env.HOME
const file = { claude: HOME + '/.claude.json', codex: HOME + '/.codex/config.toml', opencode: HOME + '/.config/opencode/opencode.jsonc', cursor: HOME + '/.cursor/mcp.json' }['${kind}']
const text = (() => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } })()
const fromEnv = (value) => String(value).replace(/\\$\\{(?:env:)?(\\w+)\\}|\\{env:(\\w+)\\}/g, (_all, a, b) => process.env[a || b] || '')
let servers = {}
if ('${kind}' === 'codex') {
  for (const block of text.split(/^(?=\\[mcp_servers\\.)/m)) {
    const id = /^\\[mcp_servers\\.([A-Za-z0-9_-]+)\\]/.exec(block); if (!id) continue
    servers[id[1]] = { command: (/^command = "(.*)"$/m.exec(block) || [])[1], vars: JSON.parse((/^env_vars = (\\[.*\\])$/m.exec(block) || [null, '[]'])[1]) }
  }
} else if (text.trim() !== '') {
  const data = JSON.parse(text); const held = '${kind}' === 'opencode' ? data.mcp : data.mcpServers
  for (const [id, entry] of Object.entries(held || {})) servers[id] = entry
}
if (!${reads}) servers = {}
let inFolder = {}
if (${folders}) {
  try {
    if ('${kind}' === 'codex') for (const id of fs.readFileSync('.codex/config.toml', 'utf8').matchAll(/^\\[mcp_servers\\.([A-Za-z0-9_-]+)\\]/gm)) inFolder[id[1]] = { vars: [] }
    else if ('${kind}' === 'claude') inFolder = JSON.parse(fs.readFileSync('.mcp.json', 'utf8')).mcpServers
  } catch {}
  try { if ('${kind}' === 'claude') Object.assign(inFolder, JSON.parse(text).projects[process.cwd()].mcpServers) } catch {}
}
const sub = argv.indexOf('mcp')
if (argv.includes('-p')) {
  const own = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers
  const kept = argv.includes('--strict-mcp-config')
  const seen = { ...(!kept || ${leaky} ? servers : {}), ...(!kept || ${leakyFolder} ? inFolder : {}), ...own }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: Object.keys(seen).map((name) => ({ name })) }))
  process.exit(1)
}
if (sub === -1) process.exit(4)
if ('${kind}' === 'codex') {
  const overrides = argv.slice(0, sub).filter((item, index, all) => all[index - 1] === '-c')
  if (overrides[0] === 'mcp_servers={}' && !${leaky}) servers = {}
  if (overrides[0] === 'mcp_servers={}' && !${leakyFolder}) inFolder = {}
  for (const item of overrides) { const own = /^mcp_servers\\.([A-Za-z0-9_-]+)\\.command=/.exec(item); if (own) servers[own[1]] = { vars: [] } }
}
const rest = argv.slice(sub + 1)
if (rest[0] === 'list') {
  for (const [id, entry] of Object.entries({ ...servers, ...inFolder })) {
    if (${starts} && entry.command !== undefined) {
      const command = Array.isArray(entry.command) ? entry.command : [entry.command, ...(entry.args || [])]
      const given = Object.fromEntries(Object.entries(entry.env || entry.environment || {}).map(([key, value]) => [key, fromEnv(value)]))
      cp.spawnSync(command[0], command.slice(1).map(fromEnv), { env: { ...process.env, ...given } })
    }
    console.log(id + '  ' + (entry.vars || []).map((name) => name + '=*****').join(', '))
  }
  process.exit(${listFails} ? 3 : 0)
}
const id = rest.filter((item) => !item.startsWith('--') && item !== 'user')[1]
if (rest[0] === 'add') {
  const program = rest[rest.indexOf('--') + 1]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if ('${kind}' === 'codex') fs.writeFileSync(file, text + '\\n[mcp_servers.' + id + ']\\ncommand = "' + program + '"\\n')
  else { const data = text.trim() === '' ? {} : JSON.parse(text); data.mcpServers = { ...(data.mcpServers || {}), [id]: { type: 'stdio', command: program, args: [] } }; fs.writeFileSync(file, JSON.stringify(data, null, 2)) }
  process.exit(0)
}
if (rest[0] === 'remove') {
  if ('${kind}' === 'codex') fs.writeFileSync(file, text.split(/^(?=\\[mcp_servers\\.)/m).filter((block) => !block.startsWith('[mcp_servers.' + id + ']')).join(''))
  else { const data = JSON.parse(text); delete data.mcpServers[id]; fs.writeFileSync(file, JSON.stringify(data, null, 2)) }
  process.exit(0)
}
process.exit(4)
`)
  chmodSync(join(stubs, name), 0o755)
}

const passed = (harness: string, version: string, fields: Partial<ToolsTestEntry> = {}): ToolsTestEntry =>
  ({ harness, kind: 'capability', at: NOW.toISOString(), version, outcome: 'pass', variable: 'pass', argument: 'pass', header: 'pass', isolation: 'pass', isolation_basis: 'run', isolation_covers: ['settings', 'local', 'folder'], isolation_empty: 'pass', own_command: 'pass', detail: 'synthetic', ...fields }) as ToolsTestEntry

/** Records a test as the owner's test would. */
function tested(harness: string, version: string, fields: Partial<ToolsTestEntry> = {}): ToolsTestEntry {
  const entry = passed(harness, version, fields)
  mkdirSync(join(home, '.config/bmn/agents/state'), { recursive: true })
  appendFileSync(toolsTestsPath(), `${JSON.stringify(entry)}\n`)
  return entry
}

const claudeFile = (): string => join(home, '.claude.json')
const codexFile = (): string => join(home, '.codex/config.toml')
const opencodeFile = (): string => join(home, '.config/opencode/opencode.jsonc')
const cursorFile = (): string => join(home, '.cursor/mcp.json')
const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, { mode: 0o600 })
}
const check = () => checkTools({ environment: env, versions: VERSIONS })
const appOf = (harness: string) => check().apps.find((entry) => entry.harness === harness)!
const states = (harness: string): Record<string, ToolState> => Object.fromEntries(appOf(harness).tools.map((row) => [row.id, row.state]))
const install = (apps: string[] = [], options = {}) => installTools(apps, { yes: true, environment: env, versions: VERSIONS, now: NOW, ...options })
const run = (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...argv], { env }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }))
})
/** Every file BMN keeps, as one text: where a value an app's entry held must never be. */
function everythingBmnKeeps(): string {
  const out: string[] = []
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(readFileSync(path, 'utf8'))
    }
  }
  walk(join(home, '.config/bmn'))
  return out.join('\n')
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-tools-')))
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
  delete process.env.XDG_CONFIG_HOME
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  app('claude', CLAUDE, { starts: true })
  app('codex', CODEX)
  app('opencode', OPENCODE, { starts: true })
  app('cursor-agent', CURSOR)
  workspace = join(home, 'work')
  mkdirSync(workspace, { recursive: true })
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  approve(withTools())
  for (const [harness, version] of Object.entries(VERSIONS)) tested(harness, version)
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

describe('the tools section of the team file (60.12 AC2)', () => {
  it('reads each tool with its program or address, the variables it names and who gets it; a team file without the section keeps its data', () => {
    const plain = parseRoster(EXAMPLE).data!
    expect(Object.keys(plain)).not.toContain('tools')
    const parsed = parseRoster(withTools([...TOOLS, 'args-tool: {name: Args, command: a, args: ["--key", {env: A_KEY}], public: false, apps: [cursor, claude]}']))
    expect(parsed.errors).toEqual([])
    expect(parsed.data!.tools).toEqual([
      { id: 'args-tool', name: 'Args', command: 'a', args: ['--key', { env: 'A_KEY' }], apps: ['claude', 'cursor'] },
      { id: 'browser', name: 'Browser', command: 'npx', args: ['--offline', '@synthetic/browser-mcp@1.0.0'], agents: ['luna'] },
      { id: 'docs', name: 'Docs', url: 'https://docs.example.test/mcp', headers: { Authorization: 'DOCS_TOKEN' }, public: true },
      { id: 'files', name: 'Files', command: 'files-tool', args: ['--root', '/srv/files'], env: { FILES_KEY: 'FILES_KEY' }, apps: ['claude', 'codex'] },
      { id: 'notes', name: 'Notes', command: 'notes-tool' },
      { id: 'review', name: 'Review', command: 'review-tool', env: { REVIEW_KEY: 'REVIEW_KEY' }, agents: ['astra', 'fable'] }
    ])
    expect(machineDiff(plain, parseRoster(withTools()).data!).map((diff) => [diff.scope, diff.id, diff.kind])).toEqual([
      ['tools', 'browser', 'added'], ['tools', 'docs', 'added'], ['tools', 'files', 'added'], ['tools', 'notes', 'added'], ['tools', 'review', 'added']
    ])
    const narrowed = parseRoster(withTools(TOOLS.map((line) => line.replace('apps: [claude, codex]', 'apps: [codex]')))).data!
    expect(machineDiff(parseRoster(withTools()).data!, narrowed).map((diff) => [diff.scope, diff.id, diff.field, diff.kind])).toEqual([['tools', 'files', 'apps', 'changed']])
  })

  it('refuses what a tool cannot be, each with its code', () => {
    const codes = (line: string): string[] => parseRoster(withTools([line])).errors.map((error) => error.code)
    expect(codes('Bad_Id: {name: X, command: x}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, command: x, url: "https://x.example.test"}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, command: x, secret: 1}')).toEqual(['UNKNOWN_FIELD'])
    expect(codes('x: {name: X, command: x, apps: [claude], agents: [luna]}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, command: x, apps: [vim]}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, command: x, apps: [claude, claude]}')).toEqual(['DUPLICATE_ID'])
    expect(codes('x: {name: X, command: x, agents: [nobody]}')).toEqual(['AGENT_UNKNOWN'])
    expect(codes('x: {name: X, command: x, public: yes}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, command: x, headers: {Authorization: A_TOKEN}}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, url: "https://x.example.test", args: [a]}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, url: "http://x.example.test"}')).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, url: "https://user:pass@x.example.test"}')).toEqual(['INVALID_VALUE'])
    // A variable is named, never held: a value that is not a variable's name is refused.
    expect(codes(`x: {name: X, command: x, env: {X_KEY: "${SECRET}"}}`)).toEqual(['INVALID_VALUE'])
    expect(codes('x: {name: X, command: x, env: {X_KEY: "two words"}}')).toEqual(['INVALID_VALUE'])
    expect(parseRoster(withTools(['x: {name: X, url: "http://localhost:8931/mcp"}'])).errors).toEqual([])
    const doubled = parseRoster(withTools(['x: {name: X, command: x}', 'x: {name: Y, command: y}']))
    expect(doubled.data).toBeNull()
  })

  it('writes the section back as it read it, and an emptied list leaves a section that still reads', () => {
    const text = withTools()
    const data = parseRoster(text).data!
    expect(rewriteRoster(text, data)).toBe(text)
    const added: RosterTool = { id: 'extra', name: 'Extra @ home', command: '@scope/tool', args: ['-y', { env: 'EXTRA_ARG' }], env: { A: 'B' }, public: true, apps: ['codex'] }
    const more = rewriteRoster(text, { ...data, tools: [...data.tools!, added] })
    expect(parseRoster(more).errors).toEqual([])
    expect(parseRoster(more).data!.tools!.find((tool) => tool.id === 'extra')).toEqual(added)
    const none = rewriteRoster(text, { ...data, tools: [] })
    expect(parseRoster(none).errors).toEqual([])
    expect(parseRoster(none).data).toEqual(parseRoster(EXAMPLE).data)
    // A team file that never had the section gets one when a tool is added.
    const fresh = rewriteRoster(EXAMPLE, { ...parseRoster(EXAMPLE).data!, tools: [added] })
    expect(parseRoster(fresh).data!.tools).toEqual([added])
  })
})

describe('what the owner\'s test proved for a version (60.12 AC1)', () => {
  it('counts only the latest test of exactly the installed version', () => {
    const pass = { harness: 'codex', kind: 'capability', at: '', version: CODEX, outcome: 'pass', variable: 'pass', isolation: 'unproven', own_command: 'pass', detail: '' } as ToolsTestEntry
    expect(appTools('codex', { version: CODEX, tests: [] })).toMatchObject({ supported: false, reason: `no test has run on Codex ${CODEX}` })
    expect(appTools('codex', { version: CODEX, tests: [pass] })).toMatchObject({ supported: true, variable: true, isolation: false, own_command: 'pass' })
    expect(appTools('codex', { version: '0.162.0', tests: [pass] })).toMatchObject({ supported: false })
    expect(appTools('codex', { version: null, tests: [pass] })).toMatchObject({ supported: false, reason: 'Codex is not installed, or its version cannot be read' })
    expect(appTools('codex', { version: CODEX, tests: [pass, { ...pass, outcome: 'fail', detail: 'it reads its tools elsewhere' }] })).toMatchObject({ supported: false, reason: `the test on Codex ${CODEX} did not pass: it reads its tools elsewhere` })
    expect(appTools('codex', { version: CODEX, tests: [pass, { ...pass, variable: 'unproven' }] })).toMatchObject({ supported: true, variable: false })
    expect(appTools('vim', { version: '1.0.0', tests: [] })).toMatchObject({ supported: false })
  })

  it('takes a run as kept to its tools only from a run that was seen with and then without the settings\' tools', () => {
    const run = passed('claude', CLAUDE)
    expect(appTools('claude', { version: CLAUDE, tests: [run] })).toMatchObject({ isolation: true, empty: true, covers: ['settings', 'local', 'folder'] })
    // A listing is not a run, and neither is a record from before BMN wrote down what the run was seen without.
    expect(appTools('claude', { version: CLAUDE, tests: [{ ...run, isolation_basis: 'list' }] })).toMatchObject({ supported: true, isolation: false, empty: false, covers: [] })
    const legacy: Record<string, unknown> = { ...run }
    delete legacy.isolation_basis
    delete legacy.isolation_covers
    expect(appTools('claude', { version: CLAUDE, tests: [legacy as unknown as ToolsTestEntry] })).toMatchObject({ isolation: false })
    expect(appTools('claude', { version: CLAUDE, tests: [{ ...run, isolation_covers: ['folder'] }] })).toMatchObject({ isolation: false })
    expect(appTools('claude', { version: CLAUDE, tests: [{ ...run, isolation: 'fail' }] })).toMatchObject({ isolation: false, empty: false })
    expect(appTools('claude', { version: CLAUDE, tests: [{ ...run, isolation_empty: 'unproven' }] })).toMatchObject({ isolation: true, empty: false })
    // BMN has no run test for Codex: no record makes a Codex run one that is kept to its tools.
    expect(appTools('codex', { version: CODEX, tests: [passed('codex', CODEX)] })).toMatchObject({ supported: true, isolation: false, empty: false, covers: [] })
  })

  it('writes nothing and judges no tool for an app without a passed test', async () => {
    rmSync(toolsTestsPath())
    tested('codex', CODEX)
    const result = check()
    expect(result.apps.map((entry) => [entry.harness, entry.supported])).toEqual([['claude', false], ['codex', true], ['opencode', false], ['cursor', false]])
    expect(appOf('claude')).toMatchObject({ tools: [], unlisted: [], reason: `no test has run on Claude Code ${CLAUDE}` })
    expect(appStateWord(appOf('claude'))).toBe('Not supported yet')
    expect(await install(['claude'])).toMatchObject({ code: 'TOOLS_UNSUPPORTED', transaction: null, written: [] })
    expect(existsSync(claudeFile())).toBe(false)
    const all = await install()
    expect(all.written.map((entry) => entry.harness)).toEqual(['codex', 'codex', 'codex'])
    expect(existsSync(claudeFile())).toBe(false)
    rmSync(toolsTestsPath())
    expect(await install()).toMatchObject({ code: 'TOOLS_UNSUPPORTED' })
    expect(checkExit(check())).toBe(1)
  })
})

describe('a tool as each app writes it', () => {
  const docs: RosterTool = { id: 'docs', name: 'Docs', url: 'https://docs.example.test/mcp', headers: { Authorization: 'DOCS_TOKEN' } }
  const local: RosterTool = { id: 'local', name: 'Local', command: 'local-tool', args: ['--root', '/srv', { env: 'LOCAL_ARG' }], env: { LOCAL_KEY: 'OWNER_KEY' } }
  const plain: RosterTool = { id: 'plain', name: 'Plain', command: 'plain-tool' }
  /** Every way of naming a variable, as a test that saw each would allow. */
  const SEEN = { variable: true, argument: true, header: true }

  it('names each variable the way that app does, and never a value', () => {
    expect(renderTool(docs, 'claude', SEEN).entry).toEqual({ type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: '${DOCS_TOKEN}' } })
    expect(renderTool(docs, 'cursor', SEEN).entry).toEqual({ url: 'https://docs.example.test/mcp', headers: { Authorization: '${env:DOCS_TOKEN}' } })
    expect(renderTool(docs, 'opencode', SEEN).entry).toEqual({ type: 'remote', url: 'https://docs.example.test/mcp', headers: { Authorization: '{env:DOCS_TOKEN}' }, enabled: true })
    expect(renderTool(docs, 'codex', SEEN).entry).toEqual({ url: 'https://docs.example.test/mcp', env_http_headers: { Authorization: 'DOCS_TOKEN' } })
    expect(renderTool(local, 'claude', SEEN).entry).toEqual({ type: 'stdio', command: 'local-tool', args: ['--root', '/srv', '${LOCAL_ARG}'], env: { LOCAL_KEY: '${OWNER_KEY}' } })
    expect(renderTool(local, 'opencode', SEEN).entry).toEqual({ type: 'local', command: ['local-tool', '--root', '/srv', '{env:LOCAL_ARG}'], environment: { LOCAL_KEY: '{env:OWNER_KEY}' }, enabled: true })
    expect(renderTool(plain, 'codex').entry).toEqual({ command: 'plain-tool' })
    expect(renderTool(plain, 'claude').entry).toEqual({ type: 'stdio', command: 'plain-tool', args: [] })
    expect(renderTool({ ...plain, env: { SAME: 'SAME' } }, 'codex', SEEN).entry).toEqual({ command: 'plain-tool', env_vars: ['SAME'] })
  })

  it('says why an app cannot take a tool instead of writing something else', () => {
    expect(renderTool(local, 'codex', SEEN).blocked).toBe('Codex has no way to pass an environment variable as an argument')
    expect(renderTool({ ...plain, env: { LOCAL_KEY: 'OWNER_KEY' } }, 'codex', SEEN).blocked).toBe('Codex passes a variable only under its own name: LOCAL_KEY cannot come from OWNER_KEY')
    // A tool that names a variable is written only in a form the test saw work: each form needs its own evidence.
    expect(renderTool({ ...plain, env: { A: 'A' } }, 'claude').blocked).toBe('BMN has not seen Claude Code pass an environment variable to a tool on this version')
    expect(renderTool(local, 'claude', { variable: true }).blocked).toBe('BMN has not seen Claude Code give a tool an argument from an environment variable on this version')
    expect(renderTool(docs, 'claude', { variable: true, argument: true }).blocked).toBe('BMN has no test yet that shows Claude Code sending a header from an environment variable')
    expect(renderTool(docs, 'codex', { variable: true }).blocked).toBe('BMN has no test yet that shows Codex sending a header from an environment variable')
    expect(renderTool(plain, 'claude').blocked).toBeUndefined()
  })

  it('reads an app\'s entry back as a tool, and names what holds a value inline without keeping it', () => {
    for (const harness of ['claude', 'cursor', 'opencode', 'codex']) {
      for (const tool of [docs, plain, { ...plain, env: { SAME: 'SAME' } }]) {
        const { entry } = renderTool(tool, harness, SEEN)
        const definition = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'id' && key !== 'name'))
        expect(neutralOf(entry, harness), `${harness} ${tool.id}`).toEqual({ definition, secrets: [], extras: [] })
      }
    }
    expect(neutralOf({ type: 'stdio', command: 'x', args: ['--api-key', SECRET], env: { X_KEY: SECRET, FINE: '${FINE_VAR}' }, timeout: 5 }, 'claude'))
      .toEqual({ definition: { command: 'x', args: ['--api-key', SECRET], env: { FINE: 'FINE_VAR' } }, secrets: ['args[1]', 'env.X_KEY'], extras: ['timeout'] })
    expect(neutralOf({ command: 'x', env: { X_KEY: SECRET } }, 'codex')!.secrets).toEqual(['env.X_KEY'])
    expect(neutralOf({ url: 'https://x.example.test', http_headers: { Authorization: `Bearer ${SECRET}` } }, 'codex')!.secrets).toEqual(['headers.Authorization'])
    expect(neutralOf({ type: 'remote', url: `https://x.example.test/mcp?api_key=${SECRET}`, enabled: false }, 'opencode')).toMatchObject({ secrets: ['url'], extras: ['enabled'] })
    expect(neutralOf('not an entry', 'claude')).toBeNull()
    expect(neutralOf({ type: 'sse' }, 'claude')).toBeNull()
    for (const [value, harness] of [
      [{ type: 'stdio', command: 'x', args: ['--api-key', SECRET], env: { X_KEY: SECRET } }, 'claude'],
      [{ command: 'x', env: { X_KEY: SECRET }, args: [`--token=${SECRET}`] }, 'codex'],
      [{ url: 'https://x.example.test', http_headers: { Authorization: `Bearer ${SECRET}` } }, 'codex'],
      [{ type: 'local', command: ['x', '--token', SECRET], environment: { X_KEY: SECRET } }, 'opencode'],
      [{ url: `https://name:${SECRET}@x.example.test/mcp` }, 'cursor']
    ] as const) {
      const shown = JSON.stringify(maskedEntry(value, harness))
      expect(shown, `${harness} ${shown}`).not.toContain(SECRET)
      expect(shown).toContain('•••')
    }
    expect(maskedEntry({ type: 'stdio', command: 'x', args: ['--root', '/srv'], env: { A: '${A}' } }, 'claude')).toEqual({ type: 'stdio', command: 'x', args: ['--root', '/srv'], env: { A: '${A}' } })
  })

  it('counts as a value whatever is not plainly a flag, a number, a name, a path or a plain address', () => {
    for (const text of ['-y', '--offline', '--port=8931', '8931', '@playwright/mcp@0.0.75', '/srv/files', '~/notes', 'run', 'localhost:8931', 'https://docs.example.test/mcp', 'https://docs.example.test/mcp?mode=read', 'docker run -i --rm mcp/server', 'REGION=eu']) {
      expect(plainArgument(text), text).toBe(true)
    }
    // A header, a cookie, a sign-in in an address, a long mixed run, an id, a pair named like a key: none is plainly not a value.
    for (const text of ['Authorization: Bearer synthetic-value', 'Cookie: sid=synthetic', 'X-Api-Key: synthetic', 'Bearer synthetic', 'https://name:word@x.example.test/mcp', 'https://x.example.test/mcp?key=synthetic',
      'https://x.example.test/hooks/a1b2c3d4e5f6g7h8i9j0', 'a1b2c3d4e5f6g7h8i9j0', '550e8400-e29b-41d4-a716-446655440000', 'API_KEY=synthetic', '--token=synthetic', '{"key":"synthetic"}', SECRET, 'x'.repeat(201)]) {
      expect(plainArgument(text), text).toBe(false)
    }
    // Whatever follows a flag named like a key, a header or a cookie is a value, however plain it looks.
    for (const flag of ['--header', '-H', '--api-key', '--cookie', '--auth-token', '--password']) expect(plainArgument('plain', flag), flag).toBe(false)
    expect(plainArgument('plain', '--root')).toBe(true)
    expect(plainArgument('--next', '--header')).toBe(true)
  })

  it('finds a value in an ordinary-looking argument or header, masks it, and never proposes or replaces the entry', async () => {
    const SENTINEL = 'synthetic-sentinel-value'
    const entry = { type: 'stdio', command: 'api-tool', args: ['--header', `Authorization: Bearer ${SENTINEL}`, '--cookie', SENTINEL, '--root', '/srv'], env: { MIXED: `prefix-${SENTINEL} \${API_USER}`, SCHEME: 'Bearer ${API_TOKEN}' } }
    expect(neutralOf(entry, 'claude')).toMatchObject({ secrets: ['args[1]', 'args[3]', 'env.MIXED'], extras: ['env.SCHEME'] })
    expect(JSON.stringify(maskedEntry(entry, 'claude'))).not.toContain(SENTINEL)
    expect(maskedEntry(entry, 'claude')).toEqual({ type: 'stdio', command: 'api-tool', args: ['--header', '•••', '--cookie', '•••', '--root', '/srv'], env: { MIXED: '•••', SCHEME: 'Bearer ${API_TOKEN}' } })
    expect(neutralOf({ command: 'api-tool', args: ['--header', `Authorization: Bearer ${SENTINEL}`] }, 'codex')!.secrets).toEqual(['args[1]'])
    expect(neutralOf({ type: 'local', command: ['api-tool', '-H', `X-Api-Key: ${SENTINEL}`], enabled: true }, 'opencode')!.secrets).toEqual(['command[1]'])
    expect(JSON.stringify(maskedEntry({ type: 'local', command: ['api-tool', '-H', `X-Api-Key: ${SENTINEL}`], enabled: true }, 'opencode'))).not.toContain(SENTINEL)
    // On the list as `files`, in the app with a header argument: shown masked, never replaced; off the list: never proposed with it, never removed.
    put(claudeFile(), JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'files-tool', args: ['--header', `Authorization: Bearer ${SENTINEL}`] }, api: entry } }, null, 2))
    const proposal = proposeTools({ environment: env }).proposals.find((item) => item.id === 'api')!
    expect(proposal).toMatchObject({ state: 'secret', tool: { command: 'api-tool', args: ['--header', '--cookie', '--root', '/srv'] } })
    expect(proposal.tool).not.toHaveProperty('env')
    const planned = await planToolsInstall(['claude'], { environment: env, versions: VERSIONS, removeUnlisted: true })
    expect(planned.targets.map((target) => target.tool)).toEqual(['docs', 'notes'])
    expect(planned.blocked.map((item) => item.tool)).toEqual(['files', 'api'])
    const result = await install(['claude'], { removeUnlisted: true })
    expect(result.written.map((item) => item.tool)).toEqual(['docs', 'notes'])
    expect(readFileSync(claudeFile(), 'utf8')).toContain(`Authorization: Bearer ${SENTINEL}`)
    expect((await restoreTransaction(result.transaction!, { yes: true })).code).toBe('OK')
    expect(JSON.stringify([proposeTools({ environment: env }), toolsPlanView(planned), result, check()])).not.toContain(SENTINEL)
    expect(everythingBmnKeeps()).not.toContain(SENTINEL)
  })

  it('tells a secret from an ordinary argument by its look, and names a tool in a few words', () => {
    for (const text of [SECRET, `--token=${SECRET}`, 'https://user:hunter2@x.example.test', 'https://x.example.test/?access_token=abc123', 'ghp_abcdefghijklmnop1234', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6']) expect(looksSecret(text), text).toBe(true)
    for (const text of ['--offline', '@playwright/mcp@0.0.75', '/srv/files', 'https://docs.example.test/mcp', '-y', 'run', '--port=8931']) expect(looksSecret(text), text).toBe(false)
    expect(transportWords({ url: 'https://docs.example.test/mcp' })).toBe('docs.example.test')
    expect(transportWords({ command: 'npx', args: ['--offline', '@synthetic/browser-mcp@1.0.0'] })).toBe('npx @synthetic/browser-mcp@1.0.0')
    expect(transportWords({ command: 'files-tool', args: ['--root'] })).toBe('files-tool')
    expect(transportWords({ command: 'x', args: [SECRET] })).toBe('x')
  })
})

describe('one state per app and per tool (60.12 AC4)', () => {
  it('starts with every tool an app may have missing, the rest rightly absent, and nothing for a tool kept to agents', () => {
    expect(states('claude')).toEqual({ browser: 'excluded', docs: 'missing', files: 'missing', notes: 'missing', review: 'excluded' })
    expect(states('codex')).toEqual({ browser: 'excluded', docs: 'missing', files: 'missing', notes: 'missing', review: 'excluded' })
    // OpenCode and Cursor get public work only: of this list, the public tool.
    expect(states('opencode')).toEqual({ browser: 'excluded', docs: 'missing', files: 'excluded', notes: 'excluded', review: 'excluded' })
    expect(appOf('opencode').kind).toBe('public')
    expect(appStateWord(appOf('claude'))).toBe('Missing')
    expect(checkExit(check())).toBe(1)
    expect(pendingCounts(check())).toEqual({ pending: 8, exposed: 0, blocked: 0 })
    expect(check().tools.find((tool) => tool.id === 'browser')).toEqual({ id: 'browser', name: 'Browser', transport: 'npx @synthetic/browser-mcp@1.0.0', public: false, apps: null, agents: ['luna'] })
  })

  it('tells current from stale, edited outside, unmanaged, exposed, blocked and unreadable', async () => {
    expect((await install()).code).toBe('OK')
    expect(states('claude')).toEqual({ browser: 'excluded', docs: 'current', files: 'current', notes: 'current', review: 'excluded' })
    expect(checkExit(check())).toBe(0)
    expect(appStateWord(appOf('claude'))).toBe('Set up')
    expect(pendingCounts(check())).toEqual({ pending: 0, exposed: 0, blocked: 0 })
    // The tool changes in the team: BMN's entry is stale.
    approve(withTools(TOOLS.map((line) => line.replace('command: notes-tool', 'command: notes-tool-2'))))
    expect(states('claude').notes).toBe('stale')
    expect(states('codex').notes).toBe('stale')
    // Somebody edits BMN's entry.
    put(codexFile(), readFileSync(codexFile(), 'utf8').replace('url = "https://docs.example.test/mcp"', 'url = "https://docs.example.test/v2"'))
    expect(states('codex').docs).toBe('edited-outside')
    // Entries that are not on the list at all: exposed where the app gets public work only, unmanaged elsewhere.
    put(cursorFile(), JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example.test/mcp' }, own: { command: 'own-tool' } } }, null, 2))
    expect(states('cursor').docs).toBe('edited-outside')
    expect(appOf('cursor').unlisted).toEqual([{ id: 'own', state: 'exposed', managed: false }])
    put(claudeFile(), readFileSync(claudeFile(), 'utf8').replace(/\n}\s*$/, ',\n  "extra": 1\n}\n').replace('"mcpServers": {', '"mcpServers": {\n    "mine": { "command": "mine-tool" },'))
    expect(appOf('claude').unlisted).toEqual([{ id: 'mine', state: 'unmanaged', managed: false }])
    // A tool the app may not have, held by it: BMN's own entry after the team narrowed, and somebody else's.
    approve(withTools(TOOLS.map((line) => line.replace('apps: [claude, codex]', 'apps: [codex]').replace('command: notes-tool', 'command: notes-tool-2'))))
    expect(appOf('claude').tools.find((row) => row.id === 'files')).toEqual({ id: 'files', state: 'exposed', managed: true })
    put(opencodeFile(), JSON.stringify({ mcp: { notes: { type: 'local', command: ['notes-tool'], enabled: true }, docs: readAppTools('opencode', env).entries.get('docs')!.value } }, null, 2))
    expect(appOf('opencode').tools.find((row) => row.id === 'notes')).toEqual({ id: 'notes', state: 'exposed', managed: false })
    expect(appStateWord(appOf('opencode'))).toBe('Exposed')
    expect(checkExit(check())).toBe(1)
    // An entry BMN cannot read, and a file it cannot read.
    put(codexFile(), `${readFileSync(codexFile(), 'utf8')}\n[other]\nx = 1\n\n[mcp_servers.notes.env]\nK = "v"\n`)
    expect(appOf('codex').tools.find((row) => row.id === 'notes')).toMatchObject({ state: 'unreadable', detail: 'BMN cannot read the entry there: its tables stand apart from each other' })
    put(cursorFile(), '{ "mcpServers": [')
    expect(appOf('cursor')).toMatchObject({ readable: false, tools: expect.arrayContaining([{ id: 'docs', state: 'unreadable', detail: expect.any(String) }]) })
    expect(appStateWord(appOf('cursor'))).toBe('Differs')
  })

  it('takes an entry that is exactly the approved tool as holding nothing unapproved, whatever its arguments look like', async () => {
    approve(withTools([`shape: {name: Shape, command: shape-tool, args: ["--options", '{"mode":"read"}'], apps: [claude]}`]))
    // Written by hand, to the letter what BMN would write: not BMN's yet, and nothing in it to move anywhere.
    put(claudeFile(), JSON.stringify({ mcpServers: { shape: { type: 'stdio', command: 'shape-tool', args: ['--options', '{"mode":"read"}'] } } }))
    expect(appOf('claude').tools).toEqual([{ id: 'shape', state: 'unmanaged' }])
    expect((await install(['claude'])).code).toBe('OK')
    expect(appOf('claude').tools).toEqual([{ id: 'shape', state: 'current' }])
    // The same look in an entry that is not the approved tool still counts as a value.
    put(claudeFile(), JSON.stringify({ mcpServers: { shape: { type: 'stdio', command: 'shape-tool', args: ['--options', '{"mode":"write"}'] } } }))
    expect(appOf('claude').tools).toMatchObject([{ id: 'shape', state: 'edited-outside', secret: true }])
  })

  it('blocks a tool an app cannot take, and one whose variable that app version was never seen passing', () => {
    approve(withTools(['renamed: {name: Renamed, command: r, env: {R_KEY: OWNER_R_KEY}}', 'plain: {name: Plain, command: p}']))
    expect(appOf('codex').tools).toEqual([
      { id: 'plain', state: 'missing' },
      { id: 'renamed', state: 'blocked', detail: 'Codex passes a variable only under its own name: R_KEY cannot come from OWNER_R_KEY' }
    ])
    expect(states('claude')).toEqual({ plain: 'missing', renamed: 'missing' })
    tested('claude', CLAUDE, { variable: 'unproven' })
    expect(appOf('claude').tools).toEqual([
      { id: 'plain', state: 'missing' },
      { id: 'renamed', state: 'blocked', detail: 'BMN has not seen Claude Code pass an environment variable to a tool on this version' }
    ])
    expect(pendingCounts(check())).toEqual({ pending: 2, exposed: 0, blocked: 2 })
  })
})

describe('install and undo (60.12 AC4)', () => {
  it('adds each app\'s entries to a file that holds much else, and changes no other byte', async () => {
    const claudeBefore = `{\n  "numStartups": 18446744073709551615,\n  // SYNTHETIC-COMMENT\n  "projects": { "/synthetic": { "history": ["a"] } },\n  "mcpServers": {\n    "mine": { "command": "mine-tool", "env": { "MINE_KEY": "${SECRET}" } }\n  },\n  "tips": {}\n}\n`
    const codexBefore = '# SYNTHETIC\nmodel = "gpt-synthetic"\n\n[mcp_servers.mine]\ncommand = "mine-tool"\n\n[profiles.deep]\nmodel = "gpt-deep"\n'
    put(claudeFile(), claudeBefore)
    put(codexFile(), codexBefore)
    const planned = await planToolsInstall([], { environment: env, versions: VERSIONS })
    expect(planned.code).toBe('OK')
    expect(planned.targets.map((target) => `${target.harness} ${target.tool} ${target.action}`)).toEqual([
      'claude docs set', 'claude files set', 'claude notes set', 'codex docs set', 'codex files set', 'codex notes set', 'opencode docs set', 'cursor docs set'
    ])
    expect(planned.targets[0]).toMatchObject({ path: claudeFile(), change: 'missing', words: 'adds the tool', before: null })
    expect(planned.targets[0]!.after).toContain('"Authorization": "${DOCS_TOKEN}"')
    const result = await install([], { expectedPlanHash: planned.planHash! })
    expect(result).toMatchObject({ code: 'OK', exposed: [], blocked: [] })
    expect(result.written).toHaveLength(8)
    // Claude Code: the entries joined the list; everything before and after it is the same bytes.
    const claudeAfter = readFileSync(claudeFile(), 'utf8')
    const mine = '    "mine": { "command": "mine-tool", "env": { "MINE_KEY": "' + SECRET + '" } }'
    expect(claudeAfter.startsWith(claudeBefore.slice(0, claudeBefore.indexOf(mine) + mine.length))).toBe(true)
    expect(claudeAfter.endsWith('\n  },\n  "tips": {}\n}\n')).toBe(true)
    expect(statSync(claudeFile()).mode & 0o777).toBe(0o600)
    expect([...readAppTools('claude', env).entries.keys()]).toEqual(['mine', 'docs', 'files', 'notes'])
    expect(readAppTools('claude', env).entries.get('files')!.value).toEqual({ type: 'stdio', command: 'files-tool', args: ['--root', '/srv/files'], env: { FILES_KEY: '${FILES_KEY}' } })
    // Codex: the new tables stand after what was there.
    const codexAfter = readFileSync(codexFile(), 'utf8')
    expect(codexAfter.startsWith(codexBefore)).toBe(true)
    expect(codexAfter.slice(codexBefore.length)).toBe([
      '', '[mcp_servers.docs]', 'url = "https://docs.example.test/mcp"', 'env_http_headers = { Authorization = "DOCS_TOKEN" }', '',
      '[mcp_servers.files]', 'command = "files-tool"', 'args = ["--root", "/srv/files"]', 'env_vars = ["FILES_KEY"]', '', '[mcp_servers.notes]', 'command = "notes-tool"', ''
    ].join('\n'))
    expect(JSON.parse(readFileSync(opencodeFile(), 'utf8'))).toEqual({ mcp: { docs: { type: 'remote', url: 'https://docs.example.test/mcp', headers: { Authorization: '{env:DOCS_TOKEN}' }, enabled: true } } })
    expect(JSON.parse(readFileSync(cursorFile(), 'utf8'))).toEqual({ mcpServers: { docs: { url: 'https://docs.example.test/mcp', headers: { Authorization: '${env:DOCS_TOKEN}' } } } })
    // Entries BMN did not write stay, and stay named.
    expect(appOf('claude').unlisted).toEqual([{ id: 'mine', state: 'unmanaged', managed: false, secret: true }])
    expect(checkExit(check())).toBe(0)
    expect(await install()).toMatchObject({ code: 'OK', transaction: null, message: 'Every app already has its tools.' })
    // What BMN keeps of it names no value an entry held.
    expect(everythingBmnKeeps()).not.toContain(SECRET)
    expect(JSON.stringify(toolsPlanView(planned))).not.toContain(SECRET)

    // Undo: only BMN's entries go; what the apps wrote meanwhile stays.
    put(claudeFile(), claudeAfter.replace('"tips": {}', '"tips": { "seen": 4 }'))
    put(codexFile(), `${codexAfter}\n[history]\npersistence = "none"\n`)
    const undone = await restoreTransaction(result.transaction!, { yes: true })
    expect(undone).toMatchObject({ code: 'OK', kind: 'tools' })
    expect(readFileSync(claudeFile(), 'utf8')).toBe(claudeBefore.replace('"tips": {}', '"tips": { "seen": 4 }'))
    expect(readFileSync(codexFile(), 'utf8')).toBe(`${codexBefore}\n[history]\npersistence = "none"\n`)
    expect(readAppTools('opencode', env).entries.size).toBe(0)
    expect(states('claude')).toMatchObject({ docs: 'missing', files: 'missing', notes: 'missing' })
    expect(listTransactions().find((entry) => entry.id === result.transaction)).toMatchObject({ reason: 'tools install', state: 'complete' })
  })

  it('installs for the named apps only, and for a tool kept to some apps only there', async () => {
    const result = await install(['codex'])
    expect(result.written.map((entry) => `${entry.harness} ${entry.tool}`)).toEqual(['codex docs', 'codex files', 'codex notes'])
    expect(existsSync(claudeFile())).toBe(false)
    approve(withTools(TOOLS.map((line) => line.replace('apps: [claude, codex]', 'apps: [claude]'))))
    const next = await install()
    expect(next.written.map((entry) => `${entry.harness} ${entry.tool} ${entry.action}`)).toEqual(['claude docs set', 'claude files set', 'claude notes set', 'codex files remove', 'opencode docs set', 'cursor docs set'])
    expect([...readAppTools('codex', env).entries.keys()]).toEqual(['docs', 'notes'])
    expect(checkExit(check())).toBe(0)
    // The removal is undone with the rest.
    await restoreTransaction(next.transaction!, { yes: true })
    expect(readAppTools('codex', env).entries.get('files')!.value).toEqual({ command: 'files-tool', args: ['--root', '/srv/files'], env_vars: ['FILES_KEY'] })
    expect(existsSync(claudeFile()) ? readAppTools('claude', env).entries.size : 0).toBe(0)
  })

  it('updates a stale entry in place, takes over an entry it did not write, and puts both back as they were', async () => {
    const own = '{\n  "mcpServers": {\n    "notes": { "command": "notes-tool", "args": [] }, // SYNTHETIC-OWN-ENTRY\n    "keep": { "command": "keep-tool" }\n  }\n}\n'
    put(claudeFile(), own)
    expect(states('claude').notes).toBe('unmanaged')
    const planned = await planToolsInstall(['claude'], { environment: env, versions: VERSIONS })
    expect(planned.targets.find((target) => target.tool === 'notes')).toMatchObject({ change: 'unmanaged', words: 'takes over an entry BMN did not write (unmanaged)', before: '"notes": {\n  "command": "notes-tool",\n  "args": []\n}' })
    const first = await install(['claude'])
    expect(states('claude').notes).toBe('current')
    expect(readFileSync(claudeFile(), 'utf8')).toContain('// SYNTHETIC-OWN-ENTRY')
    approve(withTools(TOOLS.map((line) => line.replace('command: notes-tool', 'command: notes-tool-2'))))
    const second = await install(['claude'])
    expect(second.written).toEqual([{ harness: 'claude', tool: 'notes', path: claudeFile(), action: 'set' }])
    expect(readAppTools('claude', env).entries.get('notes')!.value).toEqual({ type: 'stdio', command: 'notes-tool-2', args: [] })
    expect((await restoreTransaction(second.transaction!, { yes: true })).code).toBe('OK')
    expect(readAppTools('claude', env).entries.get('notes')!.value).toEqual({ type: 'stdio', command: 'notes-tool', args: [] })
    expect((await restoreTransaction(first.transaction!, { yes: true })).code).toBe('OK')
    expect(readFileSync(claudeFile(), 'utf8')).toBe(own)
    expect(states('claude').notes).toBe('unmanaged')
  })

  it('leaves entries that are not on the list until their removal is asked for, and never removes one it could not put back', async () => {
    put(codexFile(), '[mcp_servers.mine]\ncommand = "mine-tool"\n\n[mcp_servers.keyed]\ncommand = "keyed-tool"\n\n[mcp_servers.keyed.env]\nKEYED = "' + SECRET + '"\n')
    await install(['codex'])
    expect([...readAppTools('codex', env).entries.keys()]).toEqual(['mine', 'keyed', 'docs', 'files', 'notes'])
    const planned = await planToolsInstall(['codex'], { environment: env, versions: VERSIONS, removeUnlisted: true })
    expect(planned.targets.map((target) => `${target.tool} ${target.action} ${target.change}`)).toEqual(['mine remove unmanaged'])
    expect(planned.targets[0]!.words).toBe('removes an entry that is not on your list (BMN did not write it)')
    expect(planned.blocked).toEqual([{ harness: 'codex', tool: 'keyed', path: codexFile(), unlisted: true, fix: 'BMN cannot put this entry back if you undo, so it leaves it: remove it by hand' }])
    expect(JSON.stringify(toolsPlanView(planned))).not.toContain(SECRET)
    const result = await install(['codex'], { removeUnlisted: true })
    expect(result.written).toEqual([{ harness: 'codex', tool: 'mine', path: codexFile(), action: 'remove' }])
    expect([...readAppTools('codex', env).entries.keys()]).toEqual(['keyed', 'docs', 'files', 'notes'])
    expect(readFileSync(codexFile(), 'utf8')).toContain(`KEYED = "${SECRET}"`)
    expect(everythingBmnKeeps()).not.toContain(SECRET)
    await restoreTransaction(result.transaction!, { yes: true })
    expect(readAppTools('codex', env).entries.get('mine')!.value).toEqual({ command: 'mine-tool' })
  })

  it('never replaces an entry that holds a value inline, and says what to do', async () => {
    put(claudeFile(), JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'files-tool', args: ['--root', '/srv/files'], env: { FILES_KEY: SECRET } } } }, null, 2))
    expect(appOf('claude').tools.find((row) => row.id === 'files')).toEqual({ id: 'files', state: 'unmanaged', secret: true,
      detail: 'it holds a value inline (env.FILES_KEY): move it into an environment variable, then name the variable in the tool' })
    const planned = await planToolsInstall(['claude'], { environment: env, versions: VERSIONS })
    expect(planned.targets.map((target) => target.tool)).toEqual(['docs', 'notes'])
    expect(planned.blocked).toEqual([{ harness: 'claude', tool: 'files', path: claudeFile(), fix: 'it holds a value inline (env.FILES_KEY): move it into an environment variable, then name the variable in the tool' }])
    const result = await install(['claude'])
    expect(result.blocked).toHaveLength(1)
    expect(readAppTools('claude', env).entries.get('files')!.value).toMatchObject({ env: { FILES_KEY: SECRET } })
    expect(everythingBmnKeeps()).not.toContain(SECRET)
    expect(JSON.stringify([toolsPlanView(planned), result, check()])).not.toContain(SECRET)
    expect(pendingCounts(check())).toMatchObject({ blocked: 1 })
    expect(checkExit(check())).toBe(1)
  })

  it('refuses to write through a link, an unreadable file and a changed destination, with nothing written', async () => {
    put(join(home, 'dotfiles/claude.json'), '{}\n')
    symlinkSync(join(home, 'dotfiles/claude.json'), claudeFile())
    expect(appOf('claude')).toMatchObject({ readable: true, link: join(home, 'dotfiles/claude.json') })
    expect(await install(['claude'])).toMatchObject({ code: 'TOOL_FILE_LINK', written: [] })
    expect(readFileSync(join(home, 'dotfiles/claude.json'), 'utf8')).toBe('{}\n')
    put(cursorFile(), '{ "mcpServers": [')
    expect(await install(['cursor'])).toMatchObject({ code: 'TOOL_FILE_UNREADABLE', written: [] })
    // Codex now talks to another destination than the approved team says.
    put(codexFile(), 'openai_base_url = "https://elsewhere.example.test/v1"\n')
    expect(await install(['codex'])).toMatchObject({ code: 'ROUTE_CHANGED', written: [] })
    expect(readFileSync(codexFile(), 'utf8')).toBe('openai_base_url = "https://elsewhere.example.test/v1"\n')
    expect(listTransactions()).toEqual([])
  })

  it('stops when what it showed is no longer what is there, and keeps what the app wrote in the same instant', async () => {
    const planned = await planToolsInstall(['claude'], { environment: env, versions: VERSIONS })
    put(claudeFile(), JSON.stringify({ mcpServers: { notes: { command: 'somebody-else' } } }, null, 2))
    expect(await install(['claude'], { expectedPlanHash: planned.planHash! })).toMatchObject({ code: 'REVISION_CONFLICT', transaction: null })
    // The entry changes between the confirmation and the write.
    expect(await install(['claude'], { afterConfirm: () => put(claudeFile(), JSON.stringify({ mcpServers: { notes: { command: 'again' } } }, null, 2)) })).toMatchObject({ code: 'REVISION_CONFLICT', written: [] })
    rmSync(claudeFile())
    // The app rewrites other parts of its file while BMN is writing: its bytes survive and the entry lands.
    const result = await install(['claude'], { beforeCommit: (_target: unknown, index: number) => {
      if (index === 0) put(claudeFile(), '{\n  "numStartups": 7\n}\n')
    } })
    expect(result.code).toBe('OK')
    expect(JSON.parse(readFileSync(claudeFile(), 'utf8'))).toMatchObject({ numStartups: 7, mcpServers: { docs: expect.any(Object), files: expect.any(Object), notes: expect.any(Object) } })
    // An entry changed after the install is the owner's: undo leaves it and says so.
    put(claudeFile(), readFileSync(claudeFile(), 'utf8').replace('"notes-tool"', '"notes-edited"'))
    const undone = await restoreTransaction(result.transaction!, { yes: true })
    expect(undone).toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(readFileSync(claudeFile(), 'utf8')).toContain('"notes-edited"')
  })

  it('keeps a failed install\'s manifest, so what changed can be undone', async () => {
    const result = await install(['claude', 'codex'], { beforeTarget: (_target: unknown, index: number) => {
      if (index === 4) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    } })
    expect(result).toMatchObject({ code: 'INSTALL_FAILED' })
    expect(result.written).toHaveLength(4)
    expect(result.message).toContain(`undo with bmn rules restore --transaction ${result.transaction}`)
    expect(listTransactions()[0]).toMatchObject({ id: result.transaction, state: 'failed' })
    expect((await restoreTransaction(result.transaction!, { yes: true })).code).toBe('OK')
    expect(readAppTools('claude', env).entries.size).toBe(0)
    expect(readAppTools('codex', env).entries.size).toBe(0)
    expect(states('claude')).toMatchObject({ docs: 'missing' })
  })

  it('undoes an entry it wrote but never got to record, and leaves one it never reached', async () => {
    // BMN ends between the write of the second entry and its record.
    const result = await install(['claude'], { afterTarget: (_target: unknown, index: number) => {
      if (index === 1) throw Object.assign(new Error('ended here'), { code: 'EIO' })
    } })
    expect(result).toMatchObject({ code: 'INSTALL_FAILED' })
    expect(result.written.map((entry) => entry.tool)).toEqual(['docs'])
    expect([...readAppTools('claude', env).entries.keys()]).toEqual(['docs', 'files'])
    const plan = await restoreTransaction(result.transaction!, { planOnly: true })
    expect(plan.targets!.map((target) => (target as { tool?: string }).tool)).toEqual(['files', 'docs'])
    expect((await restoreTransaction(result.transaction!, { yes: true })).code).toBe('OK')
    expect(readAppTools('claude', env).entries.size).toBe(0)
    expect(states('claude')).toMatchObject({ docs: 'missing', files: 'missing', notes: 'missing' })
    // The same end, but the owner changed that entry before undoing: it is shown, the restore stops there, and it stays his.
    const again = await install(['claude'], { afterTarget: (_target: unknown, index: number) => {
      if (index === 1) throw Object.assign(new Error('ended here'), { code: 'EIO' })
    } })
    put(claudeFile(), readFileSync(claudeFile(), 'utf8').replace('"files-tool"', '"files-edited"'))
    expect((await restoreTransaction(again.transaction!, { planOnly: true })).targets!.map((target) => (target as { tool?: string }).tool)).toEqual(['files', 'docs'])
    expect(await restoreTransaction(again.transaction!, { yes: true })).toMatchObject({ code: 'REVISION_CONFLICT', message: `files in ${claudeFile()} changed since BMN wrote it; 0 entries restored` })
    expect([...readAppTools('claude', env).entries.keys()]).toEqual(['docs', 'files'])
    expect(readFileSync(claudeFile(), 'utf8')).toContain('"files-edited"')
  })

  it('knows an interrupted write by the exact text it noted first, not by what the entry means', async () => {
    const manifestOf = (id: string) => JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/rules/transactions', id, 'manifest.json'), 'utf8')) as { targets: { tool: string; started: boolean; done: boolean; written_text: string | null; prior_text: string | null }[] }
    const endAt = (stage: 'beforeCommit' | 'afterTarget', tool: string) => ({ [stage]: (target: { tool: string }) => {
      if (target.tool === tool) throw Object.assign(new Error('ended here'), { code: 'EIO' })
    } })
    // An entry written by hand that means exactly the approved tool, in other bytes and with the owner's comment.
    const mine = '# mine\n[mcp_servers.notes]\n# SYNTHETIC kept as written\ncommand   =   "notes-tool"\n\n[other]\nkept = true\n'
    put(codexFile(), mine)
    tested('codex', CODEX)
    // BMN ends after it replaced that entry and before it recorded the change: the bytes changed, the meaning did not.
    const taken = await install(['codex'], endAt('afterTarget', 'notes'))
    expect(taken).toMatchObject({ code: 'INSTALL_FAILED' })
    expect(readFileSync(codexFile(), 'utf8')).not.toContain('SYNTHETIC kept as written')
    const noted = manifestOf(taken.transaction!).targets.find((target) => target.tool === 'notes')!
    expect(noted).toMatchObject({ started: true, done: false })
    expect(noted.written_text).toBe((readAppTools('codex', env).entries.get('notes') as { text_hash?: string }).text_hash)
    expect(noted.written_text).not.toBe(noted.prior_text)
    // Undo sees the write, and puts the owner's own bytes back.
    expect((await restoreTransaction(taken.transaction!, { planOnly: true })).targets!.map((target) => (target as { tool?: string }).tool)).toContain('notes')
    expect((await restoreTransaction(taken.transaction!, { yes: true })).code).toBe('OK')
    expect(readFileSync(codexFile(), 'utf8')).toBe(mine)

    // BMN ends before the file is replaced: the note says the write began, the entry says it did not happen.
    const early = await install(['codex'], endAt('beforeCommit', 'notes'))
    expect(early).toMatchObject({ code: 'INSTALL_FAILED' })
    expect(manifestOf(early.transaction!).targets.find((target) => target.tool === 'notes')).toMatchObject({ started: true, done: false })
    expect((await restoreTransaction(early.transaction!, { planOnly: true })).targets!.map((target) => (target as { tool?: string }).tool)).not.toContain('notes')
    expect((await restoreTransaction(early.transaction!, { yes: true })).code).toBe('OK')
    expect(readFileSync(codexFile(), 'utf8')).toBe(mine)

    // After an unrecorded write the owner changes only a comment inside the entry: no longer the text BMN wrote, so it stays.
    const late = await install(['codex'], endAt('afterTarget', 'notes'))
    const commented = readFileSync(codexFile(), 'utf8').replace('[mcp_servers.notes]\n', '[mcp_servers.notes]\n# SYNTHETIC added later\n')
    expect(commented).toContain('SYNTHETIC added later')
    put(codexFile(), commented)
    expect(await restoreTransaction(late.transaction!, { yes: true })).toMatchObject({ code: 'REVISION_CONFLICT', message: expect.stringContaining(`notes in ${codexFile()} changed since BMN wrote it`) })
    expect(readFileSync(codexFile(), 'utf8')).toBe(commented)

    // The same for a finished install: a comment added afterwards is the owner's, and Undo does not write over it.
    put(codexFile(), mine)
    const whole = await install(['codex'])
    expect(whole.code).toBe('OK')
    expect(manifestOf(whole.transaction!).targets.every((target) => target.started && target.done)).toBe(true)
    const after = readFileSync(codexFile(), 'utf8').replace('[mcp_servers.notes]\n', '[mcp_servers.notes]\n# SYNTHETIC added later\n')
    put(codexFile(), after)
    expect(await restoreTransaction(whole.transaction!, { yes: true })).toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(readFileSync(codexFile(), 'utf8')).toContain('SYNTHETIC added later')
  })

  it('undoes a removal it made but never got to record', async () => {
    const before = '[mcp_servers.mine]\n# SYNTHETIC mine\ncommand = "mine-tool"\n'
    put(codexFile(), before)
    await install(['codex'])
    put(join(home, 'settled.toml'), readFileSync(codexFile(), 'utf8'))
    const result = await install(['codex'], { removeUnlisted: true, afterTarget: () => {
      throw Object.assign(new Error('ended here'), { code: 'EIO' })
    } })
    expect(result).toMatchObject({ code: 'INSTALL_FAILED', written: [] })
    expect(readAppTools('codex', env).entries.has('mine')).toBe(false)
    expect((await restoreTransaction(result.transaction!, { planOnly: true })).targets!.map((target) => (target as { tool?: string }).tool)).toEqual(['mine'])
    expect((await restoreTransaction(result.transaction!, { yes: true })).code).toBe('OK')
    // The entry is back with its own text; where in the file it stands is the file's business.
    expect(readFileSync(codexFile(), 'utf8')).toContain(before.trim())
    expect([...readAppTools('codex', env).entries.keys()].sort()).toEqual([...readAppTools('codex', env, { path: join(home, 'settled.toml') }).entries.keys()].sort())
  })

  it('stops when only a comment of the entry changed, or the path now leads into another folder', async () => {
    const before = '[mcp_servers.notes]\n# SYNTHETIC first note\ncommand = "notes-old"\n\n[other]\nkept = true\n'
    put(codexFile(), before)
    tested('codex', CODEX)
    // The value BMN read is the same; the text shown is not.
    const edited = before.replace('first note', 'second note')
    expect(await install(['codex'], { afterConfirm: () => put(codexFile(), edited) })).toMatchObject({ code: 'REVISION_CONFLICT', written: [] })
    expect(readFileSync(codexFile(), 'utf8')).toBe(edited)
    // Between the last look and the write.
    put(codexFile(), before)
    const late = await install(['codex'], { beforeTarget: (target: { tool: string }) => {
      if (target.tool === 'notes') put(codexFile(), edited)
    } })
    expect(late).toMatchObject({ code: 'INSTALL_FAILED', message: expect.stringContaining('REVISION_CONFLICT') })
    expect(readFileSync(codexFile(), 'utf8')).toContain('# SYNTHETIC second note\ncommand = "notes-old"')
    await restoreTransaction(late.transaction!, { yes: true })
    // An edit elsewhere in the file is no reason to stop.
    put(codexFile(), before)
    const fine = await install(['codex'], { afterConfirm: () => put(codexFile(), before.replace('kept = true', 'kept = false')) })
    expect(fine.code).toBe('OK')
    expect(readFileSync(codexFile(), 'utf8')).toContain('kept = false')
    await restoreTransaction(fine.transaction!, { yes: true })
    // The settings folder is a link, and it is pointed at another folder holding the same file.
    rmSync(join(home, '.codex'), { recursive: true })
    put(join(home, 'one/config.toml'), before)
    put(join(home, 'two/config.toml'), before)
    symlinkSync(join(home, 'one'), join(home, '.codex'))
    const swap = (): void => {
      rmSync(join(home, '.codex'))
      symlinkSync(join(home, 'two'), join(home, '.codex'))
    }
    expect(await install(['codex'], { afterConfirm: swap })).toMatchObject({ code: 'REVISION_CONFLICT', written: [] })
    rmSync(join(home, '.codex'))
    symlinkSync(join(home, 'one'), join(home, '.codex'))
    const moved = await install(['codex'], { beforeTarget: (_target: unknown, index: number) => {
      if (index === 0) swap()
    } })
    expect(moved).toMatchObject({ code: 'INSTALL_FAILED', written: [], message: expect.stringContaining('now leads to another folder than the one shown') })
    expect(readFileSync(join(home, 'one/config.toml'), 'utf8')).toBe(before)
    expect(readFileSync(join(home, 'two/config.toml'), 'utf8')).toBe(before)
  })

  it('treats approval state it cannot read as an error, never as a team without tools', async () => {
    await install(['codex'])
    const settings = readFileSync(codexFile(), 'utf8')
    const pointer = join(home, '.config/bmn/agents/state/current')
    const good = readFileSync(pointer, 'utf8')
    for (const damage of [() => writeFileSync(pointer, '{ not json'), () => rmSync(pointer)]) {
      damage()
      expect(() => check()).toThrow(/approved|cannot read|not valid JSON|nothing is approved/)
      await expect(install(['codex'])).rejects.toThrow()
      expect(() => proposeTools({ environment: env })).toThrow()
      const cli = await run(['tools', 'check', '--json'])
      expect(cli.code).not.toBe(0)
      expect(cli.stdout).not.toContain('"tools": []')
      expect((await run(['tools', 'install', 'codex', '--yes'])).code).not.toBe(0)
      expect(readFileSync(codexFile(), 'utf8')).toBe(settings)
      writeFileSync(pointer, good)
    }
    expect(checkExit(check())).toBe(1)
    // An installation that never approved a team has none, and that is not an error.
    rmSync(join(home, '.config/bmn/agents/state'), { recursive: true })
    expect(check().tools).toEqual([])
  })

  it('reports what stays exposed whatever is installed', async () => {
    put(opencodeFile(), JSON.stringify({ mcp: { notes: { type: 'local', command: ['notes-tool'], enabled: true }, stray: { type: 'local', command: ['stray-tool'] } } }, null, 2))
    const result = await install(['opencode'])
    expect(result.written.map((entry) => entry.tool)).toEqual(['docs'])
    expect(result.exposed.map((entry) => [entry.tool, entry.fix])).toEqual([
      ['notes', `BMN did not write this entry in ${opencodeFile()}: remove it there, or let OpenCode have the tool`],
      ['stray', 'OpenCode gets public work only and holds an entry that is not on your list: remove it there, or add it to the list and mark it Public']
    ])
    expect(pendingCounts(check())).toEqual({ pending: 7, exposed: 2, blocked: 0 })
  })
})

describe('import of what the apps already hold (60.12 AC3)', () => {
  it('proposes each entry once where the apps agree, apart where they differ, and never with a value it held', () => {
    approve(withTools(['notes: {name: Notes, command: notes-tool}']))
    put(claudeFile(), JSON.stringify({ mcpServers: {
      playwright: { type: 'stdio', command: 'npx', args: ['--offline', '@synthetic/browser-mcp@1.0.0'] },
      canva: { type: 'http', url: 'https://canva.example.test/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
      search: { type: 'stdio', command: 'search-tool', args: ['--api-key', SECRET], env: { SEARCH_REGION: '${SEARCH_REGION}', SEARCH_KEY: SECRET } },
      differs: { type: 'stdio', command: 'differs-a', args: [] },
      notes: { type: 'stdio', command: 'notes-tool', args: [] },
      'Bad Name': { type: 'stdio', command: 'x', args: [] }
    } }, null, 2))
    put(codexFile(), '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["--offline", "@synthetic/browser-mcp@1.0.0"]\n\n[mcp_servers.differs]\ncommand = "differs-b"\n\n[mcp_servers]\ninline = { command = "x" }\n')
    put(opencodeFile(), '{\n  // SYNTHETIC\n  "mcp": { "playwright": { "type": "local", "command": ["npx", "--offline", "@synthetic/browser-mcp@1.0.0"], "enabled": true } },\n}\n')
    const result = proposeTools({ environment: env })
    expect(result.files.map((file) => [file.harness, file.readable])).toEqual([['claude', true], ['codex', true], ['opencode', true], ['cursor', true]])
    const byId = (id: string) => result.proposals.filter((proposal) => proposal.id === id)
    expect(byId('playwright')).toEqual([{ id: 'playwright', state: 'ready', apps: ['claude', 'codex', 'opencode'], notes: [],
      tool: { id: 'playwright', name: 'Playwright', command: 'npx', args: ['--offline', '@synthetic/browser-mcp@1.0.0'], apps: ['claude', 'codex', 'opencode'] } }])
    expect(byId('canva')).toEqual([{ id: 'canva', state: 'secret', apps: ['claude'], tool: { id: 'canva', name: 'Canva', url: 'https://canva.example.test/mcp', apps: ['claude'] },
      notes: ['holds a value inline (Claude Code headers.Authorization): move this value into an environment variable; it was left out and the tool cannot be installed until then'] }])
    expect(byId('search')[0]).toMatchObject({ state: 'secret', tool: { id: 'search', name: 'Search', command: 'search-tool', args: ['--api-key'], env: { SEARCH_REGION: 'SEARCH_REGION' }, apps: ['claude'] } })
    expect(byId('differs').map((proposal) => [proposal.state, proposal.apps, proposal.tool?.command])).toEqual([['conflict', ['claude'], 'differs-a'], ['conflict', ['codex'], 'differs-b']])
    expect(byId('differs')[0]!.notes[0]).toBe('the apps define differs differently: keep one, or give each its own id')
    expect(byId('notes')).toEqual([{ id: 'notes', state: 'known', apps: ['claude'], notes: ['already on your list'] }])
    expect(byId('Bad Name')[0]).toMatchObject({ state: 'unreadable' })
    expect(byId('inline')[0]).toMatchObject({ state: 'unreadable', notes: ['Codex: it is written inline under [mcp_servers]'] })
    // No proposal makes a tool public, and none carries the value.
    expect(result.proposals.every((proposal) => proposal.tool?.public === undefined)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

describe('the tools of one agent\'s run (60.12 AC5)', () => {
  const data = () => readApproved().data
  const agent = (id: string) => data().agents.find((entry) => entry.id === id)!
  const proven = { isolation: true, empty: true, covers: ['settings', 'local', 'folder'], variable: true, argument: true, header: true }
  const NONE = '{"mcpServers":{}}'
  const KEEP = "the command does not keep this run to its tools: it must shut out what Claude Code would take from elsewhere and name its own (--strict-mcp-config --mcp-config '{\"mcpServers\":{…}}')"
  const NO_CODEX_TEST = 'BMN has no test yet that shows which tools a run of Codex starts with, so it cannot keep one to its own tools'
  const itemsOf = (id: string) => toolItems(agent(id), data(), proven) as { state: string; tools: string[]; argv: string[]; hash: string }
  const setOf = (id: string): Record<string, unknown> => JSON.parse(itemsOf(id).argv[2]!).mcpServers
  const REVIEW = { type: 'stdio', command: 'review-tool', args: [], env: { REVIEW_KEY: '${REVIEW_KEY}' } }

  it('gives every candidate the items for exactly the tools its run may have: for all apps, for its app, and its own', () => {
    expect(runTools(data(), agent('fable')).map((tool) => tool.id)).toEqual(['docs', 'files', 'notes', 'review'])
    expect(runTools(data(), agent('opus')).map((tool) => tool.id)).toEqual(['docs', 'files', 'notes'])
    expect(runTools(data(), agent('luna')).map((tool) => tool.id)).toEqual(['browser', 'docs', 'files', 'notes'])
    // An agent whose provider gets public work only may carry the Public ones alone.
    const publicOnly = data().providers.find((provider) => provider.private_work !== 'allowed')!
    expect(runTools(data(), { ...agent('fable'), provider: publicOnly.id }).map((tool) => tool.id)).toEqual(['docs'])
    const fable = itemsOf('fable')
    expect(fable).toMatchObject({ state: 'applied', tools: ['docs', 'files', 'notes', 'review'] })
    expect(fable.argv.slice(0, 2)).toEqual(['--strict-mcp-config', '--mcp-config'])
    expect(Object.keys(setOf('fable'))).toEqual(['docs', 'files', 'notes', 'review'])
    expect(setOf('fable').review).toEqual(REVIEW)
    expect(itemsOf('opus').tools).toEqual(['docs', 'files', 'notes'])
    // Without a test that saw a run kept to its tools there are no items, and for Codex BMN has no such test at all.
    expect(toolItems(agent('fable'), data(), { ...proven, isolation: false })).toEqual({ state: 'not-supported-yet', tools: ['docs', 'files', 'notes', 'review'], reason: 'no test on this Claude Code version showed a run kept to its own tools (bmn tools test claude)' })
    expect(toolItems(agent('luna'), data(), proven)).toEqual({ state: 'not-supported-yet', tools: ['browser', 'docs', 'files', 'notes'], reason: NO_CODEX_TEST })
    // A tool the app cannot take as it is leaves the run without items, with the reason.
    expect(toolItems(agent('fable'), data(), { ...proven, header: false })).toMatchObject({ state: 'blocked', reason: 'docs: BMN has no test yet that shows Claude Code sending a header from an environment variable' })
  })

  it('gives a candidate that may have no tools the items for an empty set', () => {
    approve(withTools([TOOLS[3]!]))
    expect(toolItems(agent('opus'), data(), proven)).toMatchObject({ state: 'applied', tools: [], argv: ['--strict-mcp-config', '--mcp-config', NONE] })
    expect(toolItems(agent('opus'), data(), { ...proven, empty: false })).toEqual({ state: 'not-supported-yet', tools: [], reason: 'no test on this Claude Code version showed a run kept to no tools (bmn tools test claude)' })
    approve(EXAMPLE)
    expect(toolItems(agent('opus'), data(), proven)).toEqual({ state: 'none' })
  })

  const FABLE = (...extra: string[]) => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'fable', '--effort', 'medium', ...extra]
  const OPUS = (...extra: string[]) => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', ...extra]
  const LUNA = (...extra: string[]) => ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=max', ...extra, '-']
  const SOL = (...extra: string[]) => ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', ...extra, '-']
  const only = (servers: Record<string, unknown>) => ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers })]
  type Inputs = Parameters<typeof evaluate>[0]
  /** A folder that holds no policy file, whatever this machine has. */
  const noPolicy = () => join(home, 'no-policy')
  const run = (id: string, role: string, argv: string[], log?: ToolsTestEntry[], options: { cwd?: string; policyRoot?: string } = {}) =>
    evaluate({ agent: id, role, workspace, data: 'private', cwd: options.cwd ?? workspace, argv } as Inputs,
      { environment: env, cwd: workspace, now: NOW, toolsPolicyRoot: options.policyRoot ?? noPolicy(), ...(log === undefined ? {} : { toolsTestLog: log }) })

  it('passes a run that names exactly its set, and binds the set in the receipt', () => {
    const fable = run('fable', 'designer', FABLE(...itemsOf('fable').argv))
    expect(fable.verdict, JSON.stringify(fable)).toBe('PASS')
    expect(fable.receipt!.tools).toEqual({ applied: ['docs', 'files', 'notes', 'review'], sha256: itemsOf('fable').hash })
    expect(fable.steps).toContain('tools: docs, files, notes, review, and none from anywhere else Claude Code would take them')
    // The order the command names them in does not matter; what each is does.
    const reordered = run('fable', 'designer', FABLE(...only(Object.fromEntries(Object.entries(setOf('fable')).reverse()))))
    expect(reordered.receipt!.tools).toEqual(fable.receipt!.tools)
    // What BMN's own check saw passes again only while the same test stands: another version's test, or none, refuses it.
    expect(run('fable', 'designer', FABLE(...itemsOf('fable').argv), [passed('claude', '2.1.296')])).toMatchObject({ verdict: 'REFUSED', code: 'ROUTE_UNSUPPORTED' })
  })

  it('passes an approved tool whose argument is structured text, exactly as approved', () => {
    approve(withTools([`shape: {name: Shape, command: shape-tool, args: ["--options", '{"mode":"read"}'], apps: [claude]}`]))
    expect(setOf('opus')).toEqual({ shape: { type: 'stdio', command: 'shape-tool', args: ['--options', '{"mode":"read"}'] } })
    const result = run('opus', 'lead', OPUS(...itemsOf('opus').argv))
    expect(result.verdict, JSON.stringify(result)).toBe('PASS')
    expect(result.receipt!.tools!.applied).toEqual(['shape'])
  })

  it('keeps a run of an agent that may have no tools to none, and says so in the receipt', () => {
    approve(withTools([TOOLS[3]!]))
    const opus = run('opus', 'lead', OPUS('--strict-mcp-config', '--mcp-config', NONE))
    expect(opus.verdict, JSON.stringify(opus)).toBe('PASS')
    expect(opus.receipt!.tools).toEqual({ applied: [], sha256: itemsOf('opus').hash })
    expect(opus.steps).toContain('tools: none, and none from anywhere else Claude Code would take them')
    expect(run('opus', 'lead', OPUS())).toMatchObject({ verdict: 'REFUSED', code: 'TOOL_MISMATCH', message: KEEP })
    expect(run('opus', 'lead', OPUS(...only({ review: REVIEW })))).toMatchObject({ code: 'TOOL_MISMATCH', message: "review is not among opus's tools: opus may have none" })
    expect(run('opus', 'lead', OPUS('--strict-mcp-config', '--mcp-config', NONE), [passed('claude', CLAUDE, { isolation_empty: 'unproven' })]))
      .toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: 'no test on this Claude Code version showed a run kept to no tools at all (bmn tools test claude)' })
  })

  it.each([
    ['nothing about its tools', () => FABLE(), KEEP],
    ['its tools named but the rest not shut out', () => FABLE('--mcp-config', JSON.stringify({ mcpServers: setOf('fable') })), KEEP],
    ['the rest shut out but no set named', () => FABLE('--strict-mcp-config'), KEEP],
    ['its tools missing', () => FABLE('--strict-mcp-config', '--mcp-config', NONE), "fable's tools are missing from the command: docs, files, notes, review"],
    ['one of its tools missing', () => FABLE(...only({ ...setOf('fable'), review: undefined })), "fable's tools are missing from the command: review"],
    ['a tool that is not on the list', () => FABLE(...only({ ...setOf('fable'), stray: { type: 'stdio', command: 'stray-tool', args: [] } })), "stray is not among fable's tools"],
    ['an altered definition', () => FABLE(...only({ ...setOf('fable'), review: { ...REVIEW, command: 'other-tool' } })), 'review differs from the approved tool'],
    ['an added setting', () => FABLE(...only({ ...setOf('fable'), notes: { type: 'stdio', command: 'notes-tool', args: [], env: { X: 'y' } } })), 'notes differs from the approved tool'],
    ['a file instead of the set', () => FABLE('--strict-mcp-config', '--mcp-config', '/synthetic/servers.json'), 'the tools this command gives cannot be resolved: --mcp-config is not a list of tools BMN can read (a file path is not followed)']
  ])('refuses a Claude Code run with %s: TOOL_MISMATCH', (_name, argv, message) => {
    expect(run('fable', 'designer', argv())).toMatchObject({ verdict: 'REFUSED', code: 'TOOL_MISMATCH', message, next: 'pass exactly the tools `bmn roster role --json` gives for this agent' })
  })

  it('refuses another agent\'s tool and a value in place of a variable, and prints no value', () => {
    expect(run('opus', 'lead', OPUS(...only({ ...setOf('opus'), review: REVIEW })))).toMatchObject({ code: 'TOOL_MISMATCH', message: "review is not among opus's tools" })
    const refused = run('fable', 'designer', FABLE(...only({ ...setOf('fable'), review: { ...REVIEW, env: { REVIEW_KEY: SECRET } } })))
    expect(refused).toMatchObject({ code: 'TOOL_MISMATCH', message: 'review differs from the approved tool' })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
  })

  it('refuses every run where no test saw a run kept to its tools: ROUTE_UNSUPPORTED', () => {
    const unseen = 'no test on this Claude Code version showed a run kept to the tools its command names (bmn tools test claude)'
    const argv = () => FABLE(...itemsOf('fable').argv)
    expect(run('fable', 'designer', argv(), [passed('claude', CLAUDE, { isolation: 'unproven' })])).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: unseen })
    expect(run('fable', 'designer', argv(), [])).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: unseen })
    expect(run('fable', 'designer', argv(), [passed('claude', '2.1.296')])).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: unseen })
    // A listing was never a run.
    expect(run('fable', 'designer', argv(), [passed('claude', CLAUDE, { isolation_basis: 'list' })])).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: unseen })
    // Codex: BMN has no run test, with or without tools of the agent's own, whatever a record says.
    expect(run('luna', 'browser', LUNA('-c', 'mcp_servers={}', '-c', 'mcp_servers.browser.command="npx"'))).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: NO_CODEX_TEST })
    expect(run('sol', 'lead', SOL('-c', 'mcp_servers={}'))).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: NO_CODEX_TEST })
    expect(run('sol', 'lead', SOL())).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: NO_CODEX_TEST })
    // A resume and a profile are not something BMN saw kept to a set.
    const parsed = { harness: 'claude', strictMcp: true, mcpConfig: JSON.stringify({ mcpServers: setOf('fable') }) }
    const call = (extra: Record<string, unknown>, options: Record<string, unknown> = {}) => checkRunTools(agent('fable'), data(), { ...parsed, ...extra }, proven, { environment: env, cwd: workspace, policyRoot: noPolicy(), ...options })
    expect(call({})).toMatchObject({ applied: ['docs', 'files', 'notes', 'review'] })
    expect(call({ resume: 'last' })).toEqual({ refusal: { code: 'ROUTE_UNSUPPORTED', message: 'a resumed Claude Code run is not something BMN has seen kept to its tools; start a fresh run' } })
    expect(call({}, { profile: true })).toEqual({ refusal: { code: 'ROUTE_UNSUPPORTED', message: 'a Claude Code profile may add tools of its own, and BMN has not seen a run with a profile kept to its tools' } })
  })

  it('refuses a run that could take tools from a place the test did not cover, by what is there and not by what it holds', () => {
    const argv = () => FABLE(...itemsOf('fable').argv)
    const stray = { mcpServers: { stray: { type: 'stdio', command: 'stray-tool', args: [], env: { STRAY_KEY: SECRET } } } }
    const settingsOnly = [passed('claude', CLAUDE, { isolation_covers: ['settings'] })]
    const refusal = (found: string) => ({ verdict: 'REFUSED', code: 'ROUTE_UNSUPPORTED', message: `the test on this Claude Code version did not cover every place this run could take tools from: ${found}` })
    // The folder's own file: covered only where the test saw a tool from there taken up and then left out.
    put(join(workspace, '.mcp.json'), JSON.stringify(stray))
    expect(run('fable', 'designer', argv()).verdict).toBe('PASS')
    const inFolder = run('fable', 'designer', argv(), settingsOnly)
    expect(inFolder).toMatchObject(refusal(join(workspace, '.mcp.json')))
    expect(JSON.stringify(inFolder)).not.toContain(SECRET)
    rmSync(join(workspace, '.mcp.json'))
    // The same file in a folder above is never covered; neither is the folder the run really works in when it has one.
    put(join(home, '.mcp.json'), '{ not json')
    expect(run('fable', 'designer', argv())).toMatchObject(refusal(join(home, '.mcp.json')))
    rmSync(join(home, '.mcp.json'))
    mkdirSync(join(workspace, 'part'))
    put(join(workspace, 'part/.mcp.json'), JSON.stringify(stray))
    expect(run('fable', 'designer', argv(), settingsOnly).verdict).toBe('PASS')
    expect(run('fable', 'designer', argv(), settingsOnly, { cwd: join(workspace, 'part') })).toMatchObject(refusal(join(workspace, 'part/.mcp.json')))
    rmSync(join(workspace, 'part'), { recursive: true })
    // Claude Code's own settings for the folder.
    put(claudeFile(), JSON.stringify({ projects: { [workspace]: stray } }))
    expect(run('fable', 'designer', argv()).verdict).toBe('PASS')
    expect(run('fable', 'designer', argv(), settingsOnly)).toMatchObject(refusal("tools in Claude Code's settings for this folder"))
    put(claudeFile(), '{ not json')
    expect(run('fable', 'designer', argv(), settingsOnly)).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: expect.stringContaining("Claude Code's settings for this folder (") })
    rmSync(claudeFile())
    // Plug-ins and an organisation's policy file: BMN's test cannot stage either, so their presence alone refuses.
    put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'synthetic@market': true } }))
    expect(run('fable', 'designer', argv())).toMatchObject(refusal(`plug-ins switched on in ${join(home, '.claude/settings.json')}`))
    put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: {}, model: 'x' }))
    expect(run('fable', 'designer', argv()).verdict).toBe('PASS')
    put(join(home, '.claude/settings.json'), '{ not json')
    expect(run('fable', 'designer', argv())).toMatchObject(refusal(`${join(home, '.claude/settings.json')} (cannot be read)`))
    rmSync(join(home, '.claude/settings.json'))
    put(join(workspace, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'synthetic@market': true } }))
    expect(run('fable', 'designer', argv())).toMatchObject(refusal(`plug-ins switched on in ${join(workspace, '.claude/settings.local.json')}`))
    rmSync(join(workspace, '.claude'), { recursive: true })
    put(join(home, 'policy/managed-mcp.json'), '{}')
    expect(run('fable', 'designer', argv(), undefined, { policyRoot: join(home, 'policy') })).toMatchObject(refusal(join(home, 'policy/managed-mcp.json')))
    expect(run('fable', 'designer', argv()).verdict).toBe('PASS')
    // Another app, or a run whose folder is not known, is never covered.
    expect(uncoveredSources('codex', { environment: env, cwd: workspace, covers: ['settings', 'local', 'folder'], policyRoot: noPolicy() })).toEqual(['the places Codex takes tools from besides its settings'])
    expect(uncoveredSources('claude', { environment: env, cwd: null, covers: ['settings', 'local', 'folder'], policyRoot: noPolicy() })).toEqual(['the folder of this run (unknown)'])
  })

  it('judges no command\'s tools while the team lists none, as before this check', () => {
    approve(EXAMPLE)
    const result = run('luna', 'browser', LUNA('-c', 'mcp_servers={playwright={command="npx",args=["--offline","@playwright/mcp@0.0.75"]}}'), [])
    expect(result.verdict, JSON.stringify(result)).toBe('PASS')
    expect(result.steps).toContain('tools: not checked (your team lists no tools)')
    expect(result.receipt).not.toHaveProperty('tools')
    expect(checkRunTools(agent('luna'), data(), { harness: 'codex', config: ['mcp_servers.x.command="y"'] }, { isolation: false, variable: false })).toEqual({ applied: [], note: 'tools: not checked (your team lists no tools)' })
  })

  it('gives a packet run no tools, whatever its agent has', () => {
    const packet = (parsed: Record<string, unknown>, seen: Record<string, unknown> = proven) => checkRunTools(agent('fable'), data(), { harness: 'claude', ...parsed }, seen as typeof proven, { packet: true, environment: env, cwd: workspace, policyRoot: noPolicy() })
    expect(packet({ strictMcp: true, mcpConfig: NONE })).toMatchObject({ applied: [], note: 'tools: none, and none from anywhere else Claude Code would take them' })
    expect(packet({ strictMcp: true, mcpConfig: JSON.stringify({ mcpServers: { review: REVIEW } }) })).toEqual({ refusal: { code: 'TOOL_MISMATCH', message: "review is not among fable's tools: a packet run carries none" } })
    expect(packet({})).toEqual({ refusal: { code: 'TOOL_MISMATCH', message: KEEP } })
    expect(packet({ strictMcp: true, mcpConfig: NONE }, { ...proven, isolation: false })).toMatchObject({ refusal: { code: 'ROUTE_UNSUPPORTED' } })
  })
})

describe('the owner\'s test of where an app reads its tools (60.12 AC1)', () => {
  const calls = (name: string): { argv: string[]; env: string[]; home: string }[] => readFileSync(join(home, `calls-${name}.log`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

  const CLAUDE_READS = 'Claude Code reads its tools from ~/.claude.json; it passes a named environment variable to a tool; it gives a tool an argument from a variable'
  const NO_RUN_TEST = (app: string) => `BMN has no test yet that shows which tools a run of ${app} starts with, so a run cannot be kept to its own tools`

  it('records, per version, where the app reads tools, that it passes a named variable, that a run keeps to its own, and its own commands', async () => {
    rmSync(toolsTestsPath())
    const result = await testTools('claude', { environment: { ...env, ANTHROPIC_API_KEY: SECRET, CLAUDE_CONFIG_DIR: join(home, 'real-claude'), OWNER_VALUE: 'kept' }, now: NOW })
    expect(result).toMatchObject({ harness: 'claude', kind: 'capability', version: CLAUDE, outcome: 'pass', file: '~/.claude.json', variable: 'pass', variable_basis: 'started', own_command: 'pass', at: NOW.toISOString() })
    expect(result).toMatchObject({ argument: 'pass', isolation: 'pass', isolation_basis: 'run', isolation_covers: ['settings'], isolation_empty: 'pass' })
    expect(result.detail).toBe(`${CLAUDE_READS}; a run told to take only its own tools started with those alone, without the ones in its settings; a run told to take none started with none`)
    // Nothing shows a header sent from a variable, or a folder's tools shut out: neither is claimed.
    expect(appTools('claude', { version: CLAUDE })).toMatchObject({ supported: true, variable: true, argument: true, header: false, isolation: true, empty: true, covers: ['settings'] })
    // The app ran in a throwaway home under the owner's, without the owner's sign-in or settings, and nothing of it is left.
    for (const call of calls('claude')) {
      expect(call.home.startsWith(`${home}/.bmn-tools-test-`)).toBe(true)
      expect(call.env).not.toContain('ANTHROPIC_API_KEY')
      expect(call.env).not.toContain('CLAUDE_CONFIG_DIR')
      expect(call.env).toContain('OWNER_VALUE')
    }
    // One listing; a run with nothing shut out, one kept to its own tool, one kept to none; then the app's own commands.
    expect(calls('claude').map((call) => call.argv.slice(0, 2).join(' '))).toEqual(['mcp list', '-p --mcp-config', '-p --strict-mcp-config', '-p --strict-mcp-config', 'mcp add', 'mcp remove'])
    expect(calls('claude')[3]!.argv[3]).toBe('{"mcpServers":{}}')
    expect(readdirSync(home).filter((name) => name.startsWith('.bmn-tools-test-'))).toEqual([])
    expect(existsSync(claudeFile())).toBe(false)
    expect(readFileSync(toolsTestsPath(), 'utf8')).not.toContain(SECRET)
  })

  it('counts a place as shut out only when the run was first seen with a tool from there', async () => {
    rmSync(toolsTestsPath())
    // An app that also takes tools from its settings for the folder and from the folder's own file.
    app('claude', CLAUDE, { starts: true, folders: true })
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ isolation: 'pass', isolation_covers: ['settings', 'local', 'folder'], isolation_empty: 'pass',
      detail: `${CLAUDE_READS}; a run told to take only its own tools started with those alone, without the ones in its settings, its settings for the folder, the folder's .mcp.json; a run told to take none started with none` })
    expect(appTools('claude', { version: CLAUDE })).toMatchObject({ isolation: true, covers: ['settings', 'local', 'folder'] })
    // One that keeps the folder's tools, or the settings', whatever the command says.
    app('claude', CLAUDE, { starts: true, folders: true, leakyFolder: true })
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', isolation: 'fail', isolation_covers: [], detail: expect.stringContaining('a run told to take only its own tools still started with one from elsewhere') })
    expect(appTools('claude', { version: CLAUDE })).toMatchObject({ supported: true, isolation: false, empty: false })
    app('claude', CLAUDE, { starts: true, leaky: true })
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ isolation: 'fail' })
    // A run that never showed the settings' tool, shut out or not, shows nothing about shutting it out.
    const stub = (from: string, to: string): void => {
      app('claude', CLAUDE, { starts: true })
      const text = readFileSync(join(stubs, 'claude'), 'utf8')
      expect(text).toContain(from)
      writeFileSync(join(stubs, 'claude'), text.replace(from, to))
    }
    stub('...(!kept || false ? servers : {})', '...{}')
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', isolation: 'unproven', isolation_covers: [], isolation_empty: 'unproven',
      detail: expect.stringContaining('BMN could not see a run start first with the tools in its settings and then without them') })
    expect(appTools('claude', { version: CLAUDE })).toMatchObject({ isolation: false })
    // A run that printed no start-up line shows nothing, even when its words name the tools.
    stub("console.log(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: Object.keys(seen).map((name) => ({ name })) }))", "console.log('tools: ' + Object.keys(own).join(', '))")
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', isolation: 'unproven' })
    // A run told to take none that still starts one: its own tools are kept to, an empty set is not.
    stub('const seen = {', 'const seen = (kept && Object.keys(own).length === 0) ? servers : {')
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ isolation: 'pass', isolation_empty: 'fail', detail: expect.stringContaining('but a run told to take none still started with one') })
    expect(appTools('claude', { version: CLAUDE })).toMatchObject({ isolation: true, empty: false })
  })

  it('takes an app\'s own list naming the variable as its way to pass one, and never a list as a run kept to its tools', async () => {
    rmSync(toolsTestsPath())
    const codex = await testTools('codex', { environment: env, now: NOW })
    expect(codex).toMatchObject({ outcome: 'pass', file: '~/.codex/config.toml', variable: 'pass', variable_basis: 'listed', isolation: 'unproven', own_command: 'pass', argument: 'unproven',
      detail: `Codex reads its tools from ~/.codex/config.toml; its own list names the environment variable a tool is given (the tool was not started); ${NO_RUN_TEST('Codex')}` })
    expect(codex).not.toHaveProperty('isolation_basis')
    expect(calls('codex').map((call) => call.argv.join(' ').replace(/bmn-own-\w+.*/, 'bmn-own'))).toEqual(['mcp list', 'mcp add bmn-own', 'mcp remove bmn-own'])
    expect(appTools('codex', { version: CODEX })).toMatchObject({ supported: true, variable: true, isolation: false })
    expect(await testTools('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', file: '~/.config/opencode/opencode.jsonc', variable: 'pass', variable_basis: 'started', isolation: 'unproven', own_command: 'none',
      detail: expect.stringContaining(NO_RUN_TEST('OpenCode')) })
  })

  it('records what it could not see, and an app that fails the test stays unsupported', async () => {
    rmSync(toolsTestsPath())
    app('claude', CLAUDE, { starts: false })
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', variable: 'unproven', detail: expect.stringContaining('BMN did not see it pass an environment variable to a tool') })
    app('cursor-agent', CURSOR, { reads: false })
    expect(await testTools('cursor', { environment: env, now: NOW })).toMatchObject({ outcome: 'fail', detail: 'Cursor did not name a tool written to ~/.cursor/mcp.json, so it reads its tools somewhere BMN does not know' })
    expect(appTools('cursor', { version: CURSOR })).toMatchObject({ supported: false })
    app('opencode', OPENCODE, { signIn: true })
    expect(await testTools('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'inconclusive', detail: 'opencode did not answer in a home folder without its sign-in' })
    rmSync(join(stubs, 'opencode'))
    expect(await testTools('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'unavailable', version: null })
    // The tool is named, but the command failed: nothing it printed counts.
    app('codex', CODEX, { listFails: true })
    expect(await testTools('codex', { environment: env, now: NOW })).toMatchObject({ outcome: 'inconclusive', detail: 'codex named the tool but ended with an error, so its answer proves nothing' })
    expect(appTools('codex', { version: CODEX })).toMatchObject({ supported: false })
  })
})

describe('bmn tools', () => {
  it('checks, plans, installs and undoes from the command line, and never prints a value an entry held', async () => {
    put(claudeFile(), JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'files-tool', args: [], env: { FILES_KEY: SECRET } }, mine: { command: 'mine-tool', args: ['--token', SECRET] } } }, null, 2))
    const outputs: string[] = []
    const call = async (argv: string[]) => {
      const result = await run(argv)
      outputs.push(result.stdout, result.stderr)
      return result
    }
    const checked = await call(['tools', 'check'])
    expect(checked.code).toBe(1)
    expect(checked.stdout).toContain('Tools: browser, docs, files, notes, review')
    expect(checked.stdout).toContain(`Claude Code ${CLAUDE}: Differs - ${claudeFile()}; every tool it may have`)
    expect(checked.stdout).toContain('  excluded: 2\n  missing: docs, notes\n  unmanaged: files')
    expect(checked.stdout).toContain('  not on your list: mine')
    expect(checked.stdout).toContain(`OpenCode ${OPENCODE}: Missing - ${opencodeFile()}; public tools only`)
    const json = JSON.parse((await call(['tools', 'check', '--json'])).stdout)
    expect(json).toMatchObject({ ok: false, tools: expect.any(Array), apps: expect.any(Array) })
    const plan = await call(['tools', 'install', 'claude', '--plan'])
    expect(plan.code).toBe(0)
    expect(plan.stdout).toContain(`claude: docs in ${claudeFile()}\n  adds the tool\n  + "docs": {`)
    expect(plan.stdout).toContain('not changed: claude files - it holds a value inline (env.FILES_KEY)')
    const planJson = JSON.parse((await call(['tools', 'install', '--plan', '--json'])).stdout)
    expect(planJson.targets).toHaveLength(7)
    // Without a terminal and without --yes nothing is written.
    const unconfirmed = await call(['tools', 'install', 'codex'])
    expect(unconfirmed.code).toBe(1)
    expect(unconfirmed.stderr).toContain('CONFIRMATION_REQUIRED')
    expect(existsSync(codexFile())).toBe(false)
    expect((await call(['tools', 'install', '--expect-plan', 'not-the-plan', '--yes'])).code).toBe(7)
    const installed = await call(['tools', 'install', '--yes'])
    // The install changed what it could and says what it could not: that is not a success.
    expect(installed.code).toBe(1)
    expect(installed.stdout).toMatch(/^Changed 7 entries \(transaction [0-9TZ-]+-\d+\)\.$/m)
    expect(installed.stdout).toContain('Sessions started before this keep the tools they had.')
    const id = /transaction ([0-9TZ-]+-\d+)/.exec(installed.stdout)![1]!
    expect((await call(['tools', 'check'])).stdout).toContain('  unmanaged: files')
    const restored = await call(['rules', 'restore', '--transaction', id, '--yes'])
    expect(restored.code, restored.stderr).toBe(0)
    expect(readAppTools('codex', env).entries.size).toBe(0)
    expect((await call(['tools', 'install', 'vim'])).code).toBe(2)
    expect((await call(['tools', 'frobnicate'])).code).toBe(2)
    expect((await call(['tools', '--help'])).stdout).toContain('bmn tools check [--json]')
    expect((await call(['help'])).stdout).toContain('tools check|install|import|test')
    expect(outputs.join('\n')).not.toContain(SECRET)
    expect(everythingBmnKeeps()).not.toContain(SECRET)
  })

  it('imports the apps\' entries into the team file for the owner to approve, and runs the owner\'s test', async () => {
    approve(EXAMPLE)
    put(codexFile(), '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["--offline", "@synthetic/browser-mcp@1.0.0"]\n\n[mcp_servers.keyed]\ncommand = "keyed-tool"\n\n[mcp_servers.keyed.env]\nKEYED = "' + SECRET + '"\n')
    const listed = await run(['tools', 'import'])
    expect(listed.code).toBe(1)
    expect(listed.stdout).toContain('playwright (Codex): ready - npx @synthetic/browser-mcp@1.0.0')
    expect(listed.stdout).toContain('keyed (Codex): secret - keyed-tool\n  holds a value inline (Codex env.KEYED): move this value into an environment variable')
    expect(parseRoster(readFileSync(join(home, '.config/bmn/agents/roster.md'), 'utf8')).data!.tools).toBeUndefined()
    const json = await run(['tools', 'import', '--json'])
    expect(JSON.parse(json.stdout).proposals).toHaveLength(2)
    const written = await run(['tools', 'import', '--yes'])
    expect(written.code, written.stderr).toBe(0)
    expect(written.stdout).toContain('Added keyed, playwright to the team file. Nothing reaches an app until you approve them in BMN (Preferences > Team) and install.')
    const file = readFileSync(join(home, '.config/bmn/agents/roster.md'), 'utf8')
    expect(parseRoster(file).data!.tools).toEqual([
      { id: 'keyed', name: 'Keyed', command: 'keyed-tool', apps: ['codex'] },
      { id: 'playwright', name: 'Playwright', command: 'npx', args: ['--offline', '@synthetic/browser-mcp@1.0.0'], apps: ['codex'] }
    ])
    // The approved team is unchanged: the tools are a pending edit.
    expect(readApproved().data.tools).toBeUndefined()
    expect((await run(['tools', 'import', '--yes'])).stdout).toContain('The team file already holds these tools; approve them in BMN.')
    for (const text of [listed.stdout, listed.stderr, json.stdout, written.stdout, written.stderr, file, everythingBmnKeeps()]) expect(text).not.toContain(SECRET)
    // Once approved, the entry that held a value stays blocked until the owner moves it.
    approve(file)
    expect(appOf('codex').tools).toEqual([
      { id: 'keyed', state: 'unmanaged', secret: true, detail: 'it holds a value inline (env.KEYED): move it into an environment variable, then name the variable in the tool' },
      { id: 'playwright', state: 'unmanaged' }
    ])

    rmSync(toolsTestsPath())
    const test = await run(['tools', 'test', 'codex'])
    expect(test.code, test.stderr).toBe(0)
    expect(test.stdout).toBe(`codex: pass - Codex reads its tools from ~/.codex/config.toml; its own list names the environment variable a tool is given (the tool was not started); BMN has no test yet that shows which tools a run of Codex starts with, so a run cannot be kept to its own tools (${CODEX})\n`)
    expect((await run(['tools', 'test'])).code).toBe(2)
  })

  it('gives every candidate of a role the tools its run may have, or why it cannot be kept to them', async () => {
    const role = JSON.parse((await run(['roster', 'role', 'browser', '--json'])).stdout)
    expect(role.candidates[0]).toMatchObject({ agent: 'luna', tools: { state: 'not-supported-yet', tools: ['browser', 'docs', 'files', 'notes'], reason: 'BMN has no test yet that shows which tools a run of Codex starts with, so it cannot keep one to its own tools' } })
    const lead = JSON.parse((await run(['roster', 'role', 'lead', '--json'])).stdout)
    expect(lead.candidates.map((candidate: { agent: string; tools: { state: string } }) => [candidate.agent, candidate.tools.state])).toEqual([['sol', 'not-supported-yet'], ['opus', 'applied']])
    expect(lead.candidates[1].tools).toMatchObject({ tools: ['docs', 'files', 'notes'], argv: ['--strict-mcp-config', '--mcp-config', expect.stringContaining('"notes"')] })
    // A team without tools keeps no run to any.
    approve(EXAMPLE)
    const plain = JSON.parse((await run(['roster', 'role', 'lead', '--json'])).stdout)
    expect(plain.candidates.map((candidate: { tools: unknown }) => candidate.tools)).toEqual([{ state: 'none' }, { state: 'none' }])
  })
})
