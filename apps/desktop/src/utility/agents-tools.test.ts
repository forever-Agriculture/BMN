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
  appStateWord, appTools, checkExit, checkRunTools, checkTools, inheritedTools, installTools, looksSecret, maskedEntry, neutralOf, pendingCounts, plainArgument, planToolsInstall, proposeTools,
  readAppTools, renderTool, testTools, toolItems, toolsPlanView, toolsTestsPath, transportWords, type ToolState, type ToolsTestEntry
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
 * app that keeps its tools somewhere else; `leaky` one whose run keeps the inherited tools.
 * `folders` makes it also take the tools the folder it runs in names (`leakyFolder`: even when
 * told to take only its own); `listFails` one whose listing names the tools and ends with an error.
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
}
const sub = argv.indexOf('mcp')
if (argv.includes('-p')) {
  const own = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers
  const seen = { ...(${leaky} ? servers : {}), ...(${leakyFolder} ? inFolder : {}), ...own }
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
  ({ harness, kind: 'capability', at: NOW.toISOString(), version, outcome: 'pass', variable: 'pass', argument: 'pass', header: 'pass', isolation: 'pass', project_isolation: 'pass', own_command: 'pass', detail: 'synthetic', ...fields }) as ToolsTestEntry

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
    const pass = { harness: 'codex', kind: 'capability', at: '', version: CODEX, outcome: 'pass', variable: 'pass', isolation: 'pass', own_command: 'pass', detail: '' } as ToolsTestEntry
    expect(appTools('codex', { version: CODEX, tests: [] })).toMatchObject({ supported: false, reason: `no test has run on Codex ${CODEX}` })
    expect(appTools('codex', { version: CODEX, tests: [pass] })).toMatchObject({ supported: true, variable: true, isolation: true, own_command: 'pass' })
    expect(appTools('codex', { version: '0.162.0', tests: [pass] })).toMatchObject({ supported: false })
    expect(appTools('codex', { version: null, tests: [pass] })).toMatchObject({ supported: false, reason: 'Codex is not installed, or its version cannot be read' })
    expect(appTools('codex', { version: CODEX, tests: [pass, { ...pass, outcome: 'fail', detail: 'it reads its tools elsewhere' }] })).toMatchObject({ supported: false, reason: `the test on Codex ${CODEX} did not pass: it reads its tools elsewhere` })
    expect(appTools('codex', { version: CODEX, tests: [pass, { ...pass, variable: 'unproven', isolation: 'fail' }] })).toMatchObject({ supported: true, variable: false, isolation: false })
    expect(appTools('vim', { version: '1.0.0', tests: [] })).toMatchObject({ supported: false })
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
    // The same end, but the owner changed that entry before undoing: it is his, and stays.
    const again = await install(['claude'], { afterTarget: (_target: unknown, index: number) => {
      if (index === 1) throw Object.assign(new Error('ended here'), { code: 'EIO' })
    } })
    put(claudeFile(), readFileSync(claudeFile(), 'utf8').replace('"files-tool"', '"files-edited"'))
    expect((await restoreTransaction(again.transaction!, { planOnly: true })).targets!.map((target) => (target as { tool?: string }).tool)).toEqual(['docs'])
    expect((await restoreTransaction(again.transaction!, { yes: true })).code).toBe('OK')
    expect([...readAppTools('claude', env).entries.keys()]).toEqual(['files'])
    expect(readFileSync(claudeFile(), 'utf8')).toContain('"files-edited"')
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
  const proven = { isolation: true, variable: true }
  const BROWSER = ['-c', 'mcp_servers={}', '-c', 'mcp_servers.browser.command="npx"', '-c', 'mcp_servers.browser.args=["--offline", "@synthetic/browser-mcp@1.0.0"]']
  const REVIEW_CLAUDE = JSON.stringify({ mcpServers: { review: { type: 'stdio', command: 'review-tool', args: [], env: { REVIEW_KEY: '${REVIEW_KEY}' } } } })

  it('gives each candidate the items for exactly its own tools, in its app\'s form', () => {
    expect(toolItems(agent('sol'), data(), proven)).toEqual({ state: 'none' })
    expect(toolItems(agent('luna'), data(), proven)).toMatchObject({ state: 'applied', tools: ['browser'], argv: BROWSER })
    expect(toolItems(agent('astra'), data(), proven)).toMatchObject({ state: 'applied', tools: ['review'], argv: ['-c', 'mcp_servers={}', '-c', 'mcp_servers.review.command="review-tool"', '-c', 'mcp_servers.review.env_vars=["REVIEW_KEY"]'] })
    expect(toolItems(agent('fable'), data(), proven)).toMatchObject({ state: 'applied', tools: ['review'], argv: ['--strict-mcp-config', '--mcp-config', REVIEW_CLAUDE] })
    expect(toolItems(agent('luna'), data(), { isolation: false, variable: true })).toEqual({ state: 'not-supported-yet', tools: ['browser'], reason: 'no test on this Codex version showed a run with only its own tools (bmn tools test codex)' })
    expect(toolItems(agent('astra'), data(), { isolation: true, variable: false })).toMatchObject({ state: 'blocked', reason: 'review: BMN has not seen Codex pass an environment variable to a tool on this version' })
    const elsewhere = { ...agent('luna'), harness: 'opencode' as const }
    expect(toolItems(elsewhere, data(), proven)).toMatchObject({ state: 'not-supported-yet', reason: 'BMN has no way to give a run of OpenCode its own tools' })
  })

  const LUNA = (...extra: string[]) => ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=max', ...extra, '-']
  const ASTRA = (...extra: string[]) => ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', ...extra, '-']
  const FABLE = (...extra: string[]) => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'fable', '--effort', 'medium', ...extra]
  type Inputs = Parameters<typeof evaluate>[0]
  const run = (id: string, role: string, argv: string[], log?: ToolsTestEntry[]) =>
    evaluate({ agent: id, role, workspace, data: 'private', cwd: workspace, argv } as Inputs, { environment: env, cwd: workspace, now: NOW, ...(log === undefined ? {} : { toolsTestLog: log }) })

  it('passes a run that carries exactly its agent\'s tools, and binds them in the receipt', () => {
    const luna = run('luna', 'browser', LUNA(...BROWSER))
    expect(luna.verdict, JSON.stringify(luna)).toBe('PASS')
    expect(luna.receipt!.tools).toEqual({ applied: ['browser'], sha256: (toolItems(agent('luna'), data(), proven) as { hash: string }).hash })
    expect(luna.steps).toContain('tools: browser, and none from Codex\'s own settings')
    // The whole set written inline is not a form any test saw shut the app's own settings out.
    expect(run('luna', 'browser', LUNA('-c', 'mcp_servers={browser={command="npx",args=["--offline","@synthetic/browser-mcp@1.0.0"]}}'))).toMatchObject({ code: 'TOOL_MISMATCH',
      message: "the tools this command gives cannot be resolved: tools written inline after mcp_servers= are not a form BMN has tested: write -c 'mcp_servers={}' first, then one -c per setting" })
    const astra = run('astra', 'consultant', ASTRA('-c', 'mcp_servers={}', '-c', 'mcp_servers.review.command="review-tool"', '-c', 'mcp_servers.review.env_vars=["REVIEW_KEY"]'))
    expect(astra.verdict, JSON.stringify(astra)).toBe('PASS')
    expect(astra.receipt!.tools!.applied).toEqual(['review'])
    const fable = run('fable', 'designer', FABLE('--strict-mcp-config', '--mcp-config', REVIEW_CLAUDE))
    expect(fable.verdict, JSON.stringify(fable)).toBe('PASS')
    expect(fable.receipt!.tools!.applied).toEqual(['review'])
    // An agent with no tools of its own is checked as before, and its receipt names none.
    const sol = run('sol', 'lead', ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', '-c', 'mcp_servers={}', '-'])
    expect(sol.verdict, JSON.stringify(sol)).toBe('PASS')
    expect(sol.receipt).not.toHaveProperty('tools')
    expect(sol.steps).toContain("tools: none, and none from Codex's own settings")
  })

  it.each([
    ['its tools missing', () => LUNA('-c', 'mcp_servers={}'), "luna's tools are missing from the command: browser"],
    ['no tools named at all', () => LUNA(), "luna's tools are missing from the command: browser"],
    ['another agent\'s tool', () => LUNA(...BROWSER, '-c', 'mcp_servers.review.command="review-tool"', '-c', 'mcp_servers.review.env_vars=["REVIEW_KEY"]'), "review is not among luna's tools"],
    ['an altered definition', () => LUNA('-c', 'mcp_servers={}', '-c', 'mcp_servers.browser.command="npx"', '-c', 'mcp_servers.browser.args=["@synthetic/browser-mcp@latest"]'), 'browser differs from the approved tool'],
    ['an added setting', () => LUNA(...BROWSER, '-c', 'mcp_servers.browser.env={ X = "y" }'), 'browser differs from the approved tool'],
    ['the inherited tools left in', () => LUNA(...BROWSER.slice(2)), "the command does not shut out the tools in Codex's own settings (-c 'mcp_servers={}' first)"],
    ['a value BMN cannot read', () => LUNA('-c', 'mcp_servers={}', '-c', 'mcp_servers.browser.command=npx run'), 'the tools this command gives cannot be resolved: BMN cannot read the value of mcp_servers.browser.command'],
    ['a setting given twice', () => LUNA(...BROWSER, '-c', 'mcp_servers.browser.command="other"'), 'the tools this command gives cannot be resolved: mcp_servers.browser.command is given twice']
  ])('refuses a Codex run with %s: TOOL_MISMATCH', (_name, argv, message) => {
    expect(run('luna', 'browser', argv())).toMatchObject({ verdict: 'REFUSED', code: 'TOOL_MISMATCH', message, next: 'pass exactly the tools `bmn roster role --json` gives for this agent' })
  })

  it('refuses a Claude Code run whose tools are not its agent\'s, or not shut off from its settings', () => {
    expect(run('fable', 'designer', FABLE('--mcp-config', REVIEW_CLAUDE))).toMatchObject({ code: 'TOOL_MISMATCH', message: "the command does not shut out the tools in Claude Code's own settings (--strict-mcp-config)" })
    expect(run('fable', 'designer', FABLE('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'))).toMatchObject({ code: 'TOOL_MISMATCH', message: "fable's tools are missing from the command: review" })
    expect(run('fable', 'designer', FABLE('--strict-mcp-config', '--mcp-config', join(home, 'servers.json')))).toMatchObject({ code: 'TOOL_MISMATCH' })
    const withValue = JSON.stringify({ mcpServers: { review: { type: 'stdio', command: 'review-tool', args: [], env: { REVIEW_KEY: SECRET } } } })
    const refused = run('fable', 'designer', FABLE('--strict-mcp-config', '--mcp-config', withValue))
    expect(refused).toMatchObject({ code: 'TOOL_MISMATCH', message: 'review differs from the approved tool' })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    // An agent without tools of its own may not be handed any.
    expect(run('opus', 'lead', ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--strict-mcp-config', '--mcp-config', REVIEW_CLAUDE]))
      .toMatchObject({ code: 'TOOL_MISMATCH', message: "review is not among opus's tools: it has none of its own" })
  })

  it('refuses a run with tools where that app version was never seen keeping a run to its own: ROUTE_UNSUPPORTED', () => {
    const unproven = [passed('codex', CODEX, { isolation: 'unproven' })]
    expect(run('luna', 'browser', LUNA(...BROWSER), unproven)).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: 'no test on this Codex version showed a run with only its own tools (bmn tools test codex)' })
    expect(run('luna', 'browser', LUNA(...BROWSER), [])).toMatchObject({ code: 'ROUTE_UNSUPPORTED' })
    expect(run('luna', 'browser', LUNA(...BROWSER), [passed('codex', '0.162.0')])).toMatchObject({ code: 'ROUTE_UNSUPPORTED' })
    // A profile may bring tools of its own, whichever way the run takes it.
    put(codexFile(), 'profile = "deep"\n\n[profiles.deep]\nmodel = "gpt-6-luna"\n')
    expect(run('luna', 'browser', LUNA(...BROWSER))).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: 'a Codex profile may add tools of its own; a run of an agent with tools takes none' })
    put(codexFile(), '[profiles.deep]\nmodel = "gpt-6-luna"\n')
    expect(run('luna', 'browser', LUNA('-p', 'deep', ...BROWSER))).toMatchObject({ code: 'ROUTE_UNSUPPORTED' })
    expect(run('luna', 'browser', LUNA(...BROWSER)).verdict).toBe('PASS')
    // An agent without tools is not held to a test nobody ran.
    expect(run('sol', 'lead', ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', '-'], []).verdict).toBe('PASS')
  })

  it('holds a run of an agent with no tools to what its app\'s own settings would give it (TOOL_MISMATCH)', async () => {
    const SOL = (...extra: string[]) => ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', ...extra, '-']
    const OPUS = (...extra: string[]) => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', ...extra]
    // Settings that hold nothing give nothing.
    expect(run('sol', 'lead', SOL()).steps).toContain("tools: none of its own, and none in its app's settings")
    // Another agent's tool, left in the app's settings: the run would have it.
    put(codexFile(), '[mcp_servers.browser]\ncommand = "npx"\nargs = ["--offline", "@synthetic/browser-mcp@1.0.0"]\n\n[mcp_servers.stray]\ncommand = "stray-tool"\n')
    expect(run('sol', 'lead', SOL())).toMatchObject({ verdict: 'REFUSED', code: 'TOOL_MISMATCH',
      message: "Codex's own settings would give this run tools it may not have: browser is not for Codex; stray is not on your list. Remove them there, or shut them out in the command (-c 'mcp_servers={}')" })
    // Shut out by the command, on a version whose test saw that work.
    expect(run('sol', 'lead', SOL('-c', 'mcp_servers={}')).verdict).toBe('PASS')
    // The same flag where no test saw it work shuts nothing out.
    expect(run('sol', 'lead', SOL('-c', 'mcp_servers={}'), [passed('codex', CODEX, { isolation: 'unproven' })])).toMatchObject({ code: 'TOOL_MISMATCH',
      message: expect.stringContaining("-c 'mcp_servers={}' is in the command, but no test on this Codex version showed it shut them out (bmn tools test codex)") })
    // Exactly the tools the app may have, as approved, are no reason to refuse.
    rmSync(codexFile())
    await install(['codex'])
    const held = run('sol', 'lead', SOL())
    expect(held.verdict, JSON.stringify(held)).toBe('PASS')
    expect(held.steps).toContain("tools: none of its own; Codex's settings hold only tools it may have (docs, files, notes)")
    // One of them changed outside, or holding a value inline, is not the approved tool.
    put(codexFile(), readFileSync(codexFile(), 'utf8').replace('"notes-tool"', '"notes-other"'))
    expect(run('sol', 'lead', SOL())).toMatchObject({ code: 'TOOL_MISMATCH', message: expect.stringContaining('notes differs from the approved tool') })
    put(codexFile(), `[mcp_servers.notes]\ncommand = "notes-tool"\n\n[mcp_servers.notes.env]\nNOTES_KEY = "${SECRET}"\n`)
    const keyed = run('sol', 'lead', SOL())
    expect(keyed).toMatchObject({ code: 'TOOL_MISMATCH', message: expect.stringContaining('notes differs from the approved tool') })
    expect(JSON.stringify(keyed)).not.toContain(SECRET)
    // Settings BMN cannot read, or a profile that names tools, cannot be resolved.
    put(codexFile(), 'mcp_servers = { stray = { command = "stray-tool" } }\n')
    expect(run('sol', 'lead', SOL())).toMatchObject({ code: 'TOOL_MISMATCH', message: expect.stringContaining("the tools this run would take from Codex's own settings cannot be resolved") })
    put(codexFile(), '[profiles.deep]\nmodel = "gpt-6.1-sol"\n\n[profiles.deep.mcp_servers.stray]\ncommand = "stray-tool"\n')
    expect(run('sol', 'lead', SOL('-p', 'deep'))).toMatchObject({ code: 'TOOL_MISMATCH', message: expect.stringContaining('a Codex profile names tools of its own') })
    expect(run('sol', 'lead', SOL()).verdict).toBe('PASS')
    // The folder's own settings count too; shutting them out needs its own evidence.
    rmSync(codexFile())
    put(join(workspace, '.codex/config.toml'), '[mcp_servers.local]\ncommand = "local-tool"\n')
    expect(run('sol', 'lead', SOL())).toMatchObject({ code: 'TOOL_MISMATCH', message: expect.stringContaining('local is not on your list') })
    expect(run('sol', 'lead', SOL('-c', 'mcp_servers={}'), [passed('codex', CODEX, { project_isolation: 'unproven' })])).toMatchObject({ code: 'ROUTE_UNSUPPORTED',
      message: "no test on this Codex version showed a command shutting out the tools this folder's own settings name (local); remove them there, or run bmn tools test codex" })
    expect(run('sol', 'lead', SOL('-c', 'mcp_servers={}')).verdict).toBe('PASS')
    expect(run('luna', 'browser', LUNA(...BROWSER), [passed('codex', CODEX, { project_isolation: 'unproven' })])).toMatchObject({ code: 'ROUTE_UNSUPPORTED' })
    // Claude Code: its settings, its settings for this folder, and the folder's own file.
    put(claudeFile(), JSON.stringify({ projects: { [workspace]: { mcpServers: { here: { type: 'stdio', command: 'here-tool', args: [] } } } } }))
    expect(run('opus', 'lead', OPUS())).toMatchObject({ code: 'TOOL_MISMATCH', message: expect.stringContaining('here is not on your list') })
    put(claudeFile(), '{}')
    put(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'stdio', command: 'shared-tool', args: [] } } }))
    expect(run('opus', 'lead', OPUS())).toMatchObject({ code: 'TOOL_MISMATCH', message: expect.stringContaining('shared is not on your list') })
    expect(run('opus', 'lead', OPUS('--strict-mcp-config')).verdict).toBe('PASS')
    expect(inheritedTools('claude', { environment: env, cwd: workspace }).entries.map((entry) => [entry.id, entry.folder])).toEqual([['shared', true]])
  })

  it('judges no command\'s tools while the team lists none, as before this check', () => {
    approve(EXAMPLE)
    const result = run('luna', 'browser', LUNA('-c', 'mcp_servers={playwright={command="npx",args=["--offline","@playwright/mcp@0.0.75"]}}'), [])
    expect(result.verdict, JSON.stringify(result)).toBe('PASS')
    expect(result.steps).toContain('tools: not checked (your team lists no tools)')
    expect(checkRunTools(agent('luna'), data(), { harness: 'codex', config: ['mcp_servers.x.command="y"'] }, { isolation: false, variable: false })).toEqual({ applied: [], note: 'tools: not checked (your team lists no tools)' })
  })

  it('gives a packet run no tools, whatever its agent has', () => {
    expect(checkRunTools(agent('fable'), data(), { harness: 'claude', strictMcp: true, mcpConfig: '{"mcpServers":{}}' }, { isolation: false, variable: false }, { packet: true })).toEqual({ applied: [], note: 'tools: none in a packet run' })
    expect(checkRunTools(agent('fable'), data(), { harness: 'claude', strictMcp: true, mcpConfig: REVIEW_CLAUDE }, proven, { packet: true }))
      .toEqual({ refusal: { code: 'TOOL_MISMATCH', message: "review is not among fable's tools: a packet run carries none" } })
    // Not even a tool its app may have: what the settings hold must be shut out.
    put(claudeFile(), JSON.stringify({ mcpServers: { notes: { type: 'stdio', command: 'notes-tool', args: [] } } }))
    expect(checkRunTools(agent('fable'), data(), { harness: 'claude' }, proven, { packet: true, environment: env })).toEqual({ refusal: { code: 'TOOL_MISMATCH',
      message: "Claude Code's own settings would give this run tools it may not have: notes (a packet run carries no tools). Remove them there, or shut them out in the command (--strict-mcp-config)" } })
    expect(checkRunTools(agent('fable'), data(), { harness: 'claude', strictMcp: true }, proven, { packet: true, environment: env })).toEqual({ applied: [], note: "tools: none, and none from Claude Code's own settings" })
  })
})

describe('the owner\'s test of where an app reads its tools (60.12 AC1)', () => {
  const calls = (name: string): { argv: string[]; env: string[]; home: string }[] => readFileSync(join(home, `calls-${name}.log`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

  it('records, per version, where the app reads tools, that it passes a named variable, that a run keeps to its own, and its own commands', async () => {
    rmSync(toolsTestsPath())
    const result = await testTools('claude', { environment: { ...env, ANTHROPIC_API_KEY: SECRET, CLAUDE_CONFIG_DIR: join(home, 'real-claude'), OWNER_VALUE: 'kept' }, now: NOW })
    expect(result).toMatchObject({ harness: 'claude', kind: 'capability', version: CLAUDE, outcome: 'pass', file: '~/.claude.json', variable: 'pass', variable_basis: 'started', isolation: 'pass', own_command: 'pass', at: NOW.toISOString() })
    expect(result).toMatchObject({ argument: 'pass', isolation_basis: 'run', project_isolation: 'unproven' })
    expect(result.detail).toBe('Claude Code reads its tools from ~/.claude.json; it passes a named environment variable to a tool; it gives a tool an argument from a variable; a run told to take only its own tools left out the one in its settings; whether it also leaves out tools a folder names was not seen')
    // Nothing shows a header sent from a variable, or a folder's tools shut out: neither is claimed.
    expect(appTools('claude', { version: CLAUDE })).toMatchObject({ supported: true, variable: true, argument: true, header: false, isolation: true, project: false })
    // The app ran in a throwaway home under the owner's, without the owner's sign-in or settings, and nothing of it is left.
    for (const call of calls('claude')) {
      expect(call.home.startsWith(`${home}/.bmn-tools-test-`)).toBe(true)
      expect(call.env).not.toContain('ANTHROPIC_API_KEY')
      expect(call.env).not.toContain('CLAUDE_CONFIG_DIR')
      expect(call.env).toContain('OWNER_VALUE')
    }
    expect(calls('claude').map((call) => call.argv.slice(0, 2).join(' '))).toEqual(['mcp list', '-p --strict-mcp-config', 'mcp add', 'mcp remove'])
    expect(readdirSync(home).filter((name) => name.startsWith('.bmn-tools-test-'))).toEqual([])
    expect(existsSync(claudeFile())).toBe(false)
    expect(readFileSync(toolsTestsPath(), 'utf8')).not.toContain(SECRET)
  })

  it('takes an app\'s own list naming the variable as its way to pass one, where the list starts no tool', async () => {
    rmSync(toolsTestsPath())
    expect(await testTools('codex', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', file: '~/.codex/config.toml', variable: 'pass', variable_basis: 'listed', isolation: 'pass', own_command: 'pass',
      argument: 'unproven', isolation_basis: 'list',
      detail: 'Codex reads its tools from ~/.codex/config.toml; its own list names the environment variable a tool is given (the tool was not started); a command told to take only its own tools (its own list, not a run) left out the one in its settings; whether it also leaves out tools a folder names was not seen' })
    expect(await testTools('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', file: '~/.config/opencode/opencode.jsonc', variable: 'pass', variable_basis: 'started', isolation: 'unproven', own_command: 'none' })
  })

  it('records what it could not see, and an app that fails the test stays unsupported', async () => {
    rmSync(toolsTestsPath())
    app('codex', CODEX, { leaky: true })
    expect(await testTools('codex', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', isolation: 'fail', detail: expect.stringContaining('a command told to take only its own tools (its own list, not a run) still had the one in its settings') })
    expect(appTools('codex', { version: CODEX })).toMatchObject({ supported: true, isolation: false })
    app('claude', CLAUDE, { starts: false })
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', variable: 'unproven', detail: expect.stringContaining('BMN did not see it pass an environment variable to a tool') })
    app('cursor-agent', CURSOR, { reads: false })
    expect(await testTools('cursor', { environment: env, now: NOW })).toMatchObject({ outcome: 'fail', detail: 'Cursor did not name a tool written to ~/.cursor/mcp.json, so it reads its tools somewhere BMN does not know' })
    expect(appTools('cursor', { version: CURSOR })).toMatchObject({ supported: false })
    app('opencode', OPENCODE, { signIn: true })
    expect(await testTools('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'inconclusive', detail: 'opencode did not answer in a home folder without its sign-in' })
    rmSync(join(stubs, 'opencode'))
    expect(await testTools('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'unavailable', version: null })
  })

  it('takes a listing that ends with an error as no answer, and judges the folder\'s own tools apart from the settings\'', async () => {
    rmSync(toolsTestsPath())
    // The tool is named, but the command failed: nothing it printed counts.
    app('codex', CODEX, { listFails: true })
    expect(await testTools('codex', { environment: env, now: NOW })).toMatchObject({ outcome: 'inconclusive', detail: 'codex named the tool but ended with an error, so its answer proves nothing' })
    expect(appTools('codex', { version: CODEX })).toMatchObject({ supported: false })
    // An app that takes a folder's tools, and leaves them out with the settings' when told to.
    app('codex', CODEX, { folders: true })
    expect(await testTools('codex', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', isolation: 'pass', project_isolation: 'pass', detail: expect.stringContaining('left out the one in its settings; and the one the folder names') })
    expect(appTools('codex', { version: CODEX })).toMatchObject({ isolation: true, project: true })
    // One that keeps the folder's tools whatever the command says.
    app('claude', CLAUDE, { starts: true, folders: true, leakyFolder: true })
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', isolation: 'pass', project_isolation: 'fail', detail: expect.stringContaining('but kept the one the folder names') })
    expect(appTools('claude', { version: CLAUDE })).toMatchObject({ isolation: true, project: false })
    // A run that printed no start-up line shows nothing, even when its words name the tools.
    writeFileSync(join(stubs, 'claude'), readFileSync(join(stubs, 'claude'), 'utf8').replace("console.log(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: Object.keys(seen).map((name) => ({ name })) }))", "console.log('tools: ' + Object.keys(own).join(', '))"))
    expect(await testTools('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'pass', isolation: 'unproven', project_isolation: 'unproven' })
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
    expect(test.stdout).toBe(`codex: pass - Codex reads its tools from ~/.codex/config.toml; its own list names the environment variable a tool is given (the tool was not started); a command told to take only its own tools (its own list, not a run) left out the one in its settings; whether it also leaves out tools a folder names was not seen (${CODEX})\n`)
    expect((await run(['tools', 'test'])).code).toBe(2)
  })

  it('gives a role\'s candidates their tools', async () => {
    const role = JSON.parse((await run(['roster', 'role', 'browser', '--json'])).stdout)
    expect(role.candidates[0]).toMatchObject({ agent: 'luna', tools: { state: 'applied', tools: ['browser'], argv: expect.arrayContaining(['mcp_servers={}', 'mcp_servers.browser.command="npx"']) } })
    const lead = JSON.parse((await run(['roster', 'role', 'lead', '--json'])).stdout)
    expect(lead.candidates.map((candidate: { tools: unknown }) => candidate.tools)).toEqual([{ state: 'none' }, { state: 'none' }])
  })
})
