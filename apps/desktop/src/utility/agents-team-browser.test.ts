// MODULE: agents-team-browser.test.ts - Story 74.3: a browser ask: the loopback origin and --disposable, Playwright's MCP server added to Codex and Claude Code through BMN's relay with the look or --interact tools only, refused for OpenCode, a public ask or a missing server, and the record of pages and screenshots read from the server's own session log with everything else removed, after a normal end and after a crash, shown and exported; a synthetic team, stand-in apps and a stand-in npx; no browser starts and no provider is reached
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BROWSER_CONFIG, BROWSER_LIMITS, BROWSER_LIMIT_WORDS, BROWSER_MCP_PACKAGE, BROWSER_RELAY, BROWSER_STATEMENT, INTERACT_TOOLS, LOOK_TOOLS, browserOrigin, browserRecord, browserServer, browserTemporary, browserTools, sessionCalls } from '../../bin/agents-team-browser.mjs'
import { ASK_RUN_FILES } from '../../bin/agents-team-forms.mjs'
import { modeInput } from '../../bin/agents-check.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { askOutcome, exportAsk, finishBrowser, startAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { askJson, showWords } from '../../bin/agents-team-cli.mjs'
import { recordInterrupted, requestHash } from '../../bin/agents-team-places.mjs'
import { appAskDetail } from '../../bin/agents-team-app.mjs'
import { ANSWER_KEY, EXAMPLE, SCOPES, approve, goSignInInBmnFolder, leftovers, scopeGone, settle, stubOpenCode, teamAskHome } from './test-fixtures/team-ask-harness'

const CLI = fileURLToPath(new URL('../../bin/agents-team-cli.mjs', import.meta.url))
const ORIGIN = 'http://127.0.0.1:4173'
const savedHome = process.env.HOME
let home: string
let stubs: string
let env: Record<string, string>
type Asked = Parameters<typeof prepareAsk>[0]
const ask = (request: Partial<Asked> = {}) =>
  prepareAsk({ role: 'browser', question: 'Does the checkout page load?', browser: { origin: ORIGIN, disposable: true, interact: false }, ...request } as Asked, { environment: env, cwd: home, home })
const refusal = (run: () => unknown): { code: string; message: string } => {
  try {
    run()
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('expected a refusal')
}

/** A stand-in npx that knows the browser's server is in its cache, or not. */
function stubNpx(cached = true): void {
  writeFileSync(join(stubs, 'npx'), `#!/bin/sh\n[ "$2" = ${JSON.stringify(BROWSER_MCP_PACKAGE)} ] && [ "$3" = --version ] && ${cached ? 'echo 0.0.75 && exit 0' : 'echo "npm error code ENOTCACHED" >&2 && exit 1'}\nexit 1\n`)
  chmodSync(join(stubs, 'npx'), 0o755)
}

/** Playwright MCP 0.0.75's session log as it writes it, run from the ask's browser folder (measured: .dev-auto/evidence/74-3-session-probe.txt). */
const call = (tool: string, args: object, result: object): string => `\n### Tool call: ${tool}\n- Args\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n- Result\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`
const page = (path: string, title: string): string => `- Page URL: ${ORIGIN}${path}\n- Page Title: ${title}\n- Console: 0 errors, 0 warnings`
const shot = (name: string): object => ({ result: `- [Screenshot of viewport](./${name})`, code: `await page.screenshot({ path: './${name}' });`, attachments: [{ type: 'image', data: 'iVBORw0KGgo=' }] })
const SESSION = [
  call('browser_navigate', { url: ORIGIN }, { code: `await page.goto('${ORIGIN}');`, page: page('/', 'Synthetic shop'), snapshot: '- heading "Shop"' }),
  call('browser_take_screenshot', { type: 'png' }, shot('page-2026-10-15T15-40-09-594Z.png')),
  call('browser_navigate', { url: `${ORIGIN}/two` }, { page: page('/two', 'Second page') }),
  call('browser_navigate_back', {}, { page: page('/', 'Synthetic shop') }),
  // The same page again: one line in the record.
  call('browser_snapshot', {}, { page: page('/', 'Synthetic shop') }),
  call('browser_navigate', { url: `${ORIGIN}/file` }, { page: page('/', 'Synthetic shop'), events: '- Downloaded file made-up.png to "./made-up.png"' }),
  call('browser_navigate', { url: `${ORIGIN}/account?key=${ANSWER_KEY}` }, { page: page(`/account?key=${ANSWER_KEY}`, `Account ${ANSWER_KEY}`) }),
  call('browser_take_screenshot', { filename: 'named.png' }, shot('named.png')),
  call('browser_take_screenshot', { type: 'png' }, shot('big.png')),
  call('browser_take_screenshot', { type: 'png' }, shot('link.png'))
].join('')

/** What the server leaves in the ask's browser folder: its log, two screenshots, an oversized one, a link, page snapshots, a console log and two downloads (one a PNG the log never names as a screenshot). */
function serverFiles(folder: string): void {
  mkdirSync(join(folder, 'session-1792078809142'), { recursive: true })
  writeFileSync(join(folder, 'session-1792078809142', 'session.md'), SESSION)
  writeFileSync(join(folder, 'page-2026-10-15T15-40-09-594Z.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'))
  writeFileSync(join(folder, 'named.png'), Buffer.from('89504e470d0a1a0a1111', 'hex'))
  writeFileSync(join(folder, 'big.png'), Buffer.alloc(BROWSER_LIMITS.screenshot + 1))
  symlinkSync('/etc/hostname', join(folder, 'link.png'))
  writeFileSync(join(folder, 'page-2026-10-15T15-40-09-516Z.yml'), '- heading "Shop"\n')
  writeFileSync(join(folder, 'console-2026-10-15T15-40-09-392Z.log'), 'made-up console\n')
  writeFileSync(join(folder, 'made-up.png'), Buffer.from('89504e470d0a1a0a2222', 'hex'))
  writeFileSync(join(folder, 'made-up.bin'), 'made-up payload')
}

/** A run's manifest naming its browser, as an ask writes it: what the finish reads. */
function browserManifest(folder: string, interact = false): void {
  mkdirSync(join(folder, 'inputs'), { recursive: true })
  writeFileSync(join(folder, ASK_RUN_FILES.manifest), JSON.stringify({ browser: { origin: ORIGIN, interact, tools: browserTools(interact) } }))
}

/** The record every test of a finished browser ask expects of `serverFiles`. */
function expectRecord(folder: string, interact = false): void {
  const record = JSON.parse(readFileSync(join(folder, ASK_RUN_FILES.browserRecord), 'utf8'))
  expect(record).toMatchObject({
    version: 1, origin: ORIGIN, interact, tools: browserTools(interact), statement: BROWSER_STATEMENT, calls: 10,
    pages: [
      { url: `${ORIGIN}/`, title: 'Synthetic shop' }, { url: `${ORIGIN}/two`, title: 'Second page' }, { url: `${ORIGIN}/`, title: 'Synthetic shop' },
      { url: expect.stringContaining(`${ORIGIN}/account?key=`), title: expect.stringContaining('Account') }
    ],
    screenshots: [{ name: 'named.png', bytes: 10, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }, { name: 'page-2026-10-15T15-40-09-594Z.png', bytes: 10, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }],
    removed: 7
  })
  // A credential in an address or title is masked in the record.
  expect(JSON.stringify(record)).not.toContain(ANSWER_KEY)
  // Only the screenshots stay: no download, page snapshot, log, link or oversized picture.
  expect(readdirSync(join(folder, ASK_RUN_FILES.browser)).sort()).toEqual(['named.png', 'page-2026-10-15T15-40-09-594Z.png'])
}

/**
 * Stand-in apps that act as the browser's server would before answering: from their own arguments (Codex's
 * `-c mcp_servers=…`, Claude Code's `--mcp-config`) they take the output folder and leave there what the
 * server leaves (`serverFiles`), then answer as the harness's stand-ins do.
 */
function stubBrowsingApps(): void {
  const fixture = join(home, 'server-files.sh')
  const files = join(home, 'server-template')
  mkdirSync(files)
  serverFiles(files)
  writeFileSync(fixture, `cp -a ${JSON.stringify(files)}/. "$1"/\n`)
  for (const app of ['codex', 'claude']) {
    renameSync(join(stubs, app), join(stubs, `${app}-answer`))
    writeFileSync(join(stubs, app), `#!/bin/sh
[ "$1" = --version ] && exec "$(dirname "$0")/${app}-answer" "$@"
[ "$1" = mcp ] && exec "$(dirname "$0")/${app}-answer" "$@"
dir=
for a in "$@"; do case $a in *'"--output-dir","'*) dir=$(printf %s "$a" | sed -n 's/.*"--output-dir","\\([^"]*\\)".*/\\1/p');; esac; done
[ -n "$dir" ] && sh ${JSON.stringify(fixture)} "$dir"
exec "$(dirname "$0")/${app}-answer" "$@"
`)
    chmodSync(join(stubs, app), 0o755)
  }
}

beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-browser-'))
  stubNpx()
})

afterEach(async () => {
  await settle(() => leftovers(home).length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe('the app\'s address and the tools a browser ask offers (74.3 AC1, AC4)', () => {
  it('takes only a loopback http address with a port, and says why another is refused', () => {
    expect(browserOrigin('http://127.0.0.1:4173')).toEqual({ origin: 'http://127.0.0.1:4173' })
    expect(browserOrigin('http://localhost:8080/')).toEqual({ origin: 'http://localhost:8080' })
    expect(browserOrigin('http://[::1]:3000')).toEqual({ origin: 'http://[::1]:3000' })
    for (const value of ['https://127.0.0.1:4173', 'http://example.org:80', 'http://10.0.0.5:8080', 'http://127.0.0.1', 'http://127.0.0.1:4173/shop', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://user@127.0.0.1:4173', 'file:///etc/hostname']) {
      expect(browserOrigin(value), value).toEqual({ reason: expect.stringContaining('is not a loopback address of an app you started') })
    }
  })

  it('retains every browser tool and adds native callback execution and evaluation with --interact (74.5)', () => {
    expect(browserTools(false)).toEqual(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_wait_for', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests', 'browser_tabs', 'browser_resize', 'browser_close'])
    expect(browserTools(true)).toEqual([...LOOK_TOOLS, 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_run_code_unsafe', 'browser_evaluate'])
    for (const script of ['browser_evaluate', 'browser_run_code_unsafe']) expect(LOOK_TOOLS).not.toContain(script)
    for (const never of ['browser_file_upload', 'browser_drag', 'browser_drop', 'browser_handle_dialog', 'browser_network_request']) {
      expect([...LOOK_TOOLS, ...INTERACT_TOOLS]).not.toContain(never)
    }
  })

  it('the server runs through BMN\'s relay from the ask\'s own browser folder, its temporary files in the run\'s own, headless, profile in memory, Chrome\'s own sandbox on, downloads refused, limited to the origin, saving its session there', () => {
    const folder = '/runs/20261015T034100-7c2e91ab'
    const temporary = `/run/user/${process.getuid?.()}/bmn-ask-20261015T034100-7c2e91ab`
    expect(browserTemporary(folder)).toBe(temporary)
    expect(browserServer({ origin: ORIGIN, interact: false }, folder)).toEqual({
      command: 'node',
      args: [BROWSER_RELAY, `${folder}/browser`, temporary, 'npx', '--offline', '@playwright/mcp@0.0.75', '--headless', '--isolated', '--sandbox', '--config', BROWSER_CONFIG,
        '--allowed-origins', ORIGIN, '--output-dir', `${folder}/browser`, '--save-session']
    })
    expect(existsSync(BROWSER_RELAY)).toBe(true)
    // Playwright's own configuration: downloads refused, nothing else (measured: a download could take a screenshot's name).
    expect(JSON.parse(readFileSync(BROWSER_CONFIG, 'utf8'))).toEqual({ browser: { contextOptions: { acceptDownloads: false } } })
  })
})

describe('a browser ask to each app (74.3 AC1, AC4)', () => {
  it('Codex: the server in mcp_servers with only the ask\'s tools enabled and approved; nothing else of its MCP configuration', () => {
    const look = ask()
    expect(look.verdict.verdict).toBe('PASS')
    const servers = look.argv.find((part) => part.startsWith('mcp_servers='))
    expect(servers).toBe(`mcp_servers={playwright={command="node",args=${JSON.stringify(browserServer({ origin: ORIGIN, interact: false }, look.folder).args)},cwd=${JSON.stringify(join(look.folder, 'browser'))},env={},env_vars=[],enabled=true,enabled_tools=${JSON.stringify(LOOK_TOOLS)},default_tools_approval_mode="approve",startup_timeout_sec=60,tool_timeout_sec=240}}`)
    expect(look.argv.filter((part) => part.startsWith('mcp_servers'))).toHaveLength(1)
    const interact = ask({ browser: { origin: ORIGIN, disposable: true, interact: true } })
    expect(interact.argv.find((part) => part.startsWith('mcp_servers='))).toContain(`enabled_tools=${JSON.stringify([...LOOK_TOOLS, ...INTERACT_TOOLS])}`)
    expect(interact.argv.find((part) => part.startsWith('mcp_servers='))).toContain('"browser_run_code_unsafe","browser_evaluate"')
    expect(readFileSync(join(interact.folder, ASK_RUN_FILES.prompt), 'utf8')).toContain('browser_run_code_unsafe({ code: "async (page) => { ... }" })')
    // The prompt says where the app is and what the teammate may do there; the record keeps the asker's statement.
    expect(readFileSync(join(look.folder, ASK_RUN_FILES.prompt), 'utf8')).toContain(`The asker started a web app at ${ORIGIN}`)
    expect(JSON.parse(readFileSync(join(look.folder, ASK_RUN_FILES.request), 'utf8')).browser).toEqual({ origin: ORIGIN, interact: false, statement: BROWSER_STATEMENT })
    expect(existsSync(join(look.folder, ASK_RUN_FILES.browser))).toBe(true)
  })

  it('Codex disables inherited servers except its own browser and refuses an HTTP transport collision', () => {
    writeFileSync(join(home, 'mcp-list.json'), JSON.stringify([
      { name: 'playwright', enabled: true, transport: { type: 'stdio' } }, { name: 'other.read', enabled: true, transport: { type: 'stdio' } }
    ]))
    const look = ask({})
    expect(look.verdict.verdict).toBe('PASS')
    expect(look.argv.find((part) => part.startsWith('mcp_servers='))).toContain('"other.read"={enabled=false}')
    expect(look.argv.find((part) => part.startsWith('mcp_servers='))).not.toContain('"playwright"={enabled=false}')
    writeFileSync(join(home, 'mcp-list.json'), JSON.stringify([{ name: 'playwright', enabled: true, transport: { type: 'streamable_http' } }]))
    expect(refusal(() => ask({}))).toMatchObject({ code: 'ACCESS_UNAVAILABLE', message: expect.stringContaining('HTTP transport') })
  })

  it('Claude Code: the server alone in its strict MCP configuration, its tools allowed by their MCP names, every other tool of the server refused by dontAsk', () => {
    const look = ask({ role: 'designer' })
    expect(look.verdict.verdict).toBe('PASS')
    const at = look.argv.indexOf('--mcp-config')
    expect(look.argv[at - 1]).toBe('--strict-mcp-config')
    expect(JSON.parse(look.argv[at + 1] as string)).toEqual({ mcpServers: { playwright: browserServer({ origin: ORIGIN, interact: false }, look.folder) } })
    const allowed = look.argv.slice(look.argv.indexOf('--allowedTools') + 1, look.argv.indexOf('--permission-mode'))
    expect(allowed).toEqual(['Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)', 'WebSearch', 'Agent', ...LOOK_TOOLS.map((tool) => `mcp__playwright__${tool}`)])
    expect(look.argv[look.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    const interact = ask({ role: 'designer', browser: { origin: ORIGIN, disposable: true, interact: true } })
    expect(interact.argv).toEqual(expect.arrayContaining(INTERACT_TOOLS.map((tool) => `mcp__playwright__${tool}`)))
    expect(interact.argv).toEqual(expect.arrayContaining(['mcp__playwright__browser_run_code_unsafe', 'mcp__playwright__browser_evaluate']))
    expect(interact.argv.join(' ')).not.toMatch(/browser_(file_upload|drag|drop|handle_dialog)/u)
  })

  it('accounts for script server access in consent, manifests, receipts and displayed scope (74.5)', () => {
    const project = mkdtempSync(join(home, 'project-'))
    spawnSync('git', ['init', '-q', project])
    const browser = { origin: ORIGIN, disposable: true, interact: true }
    // A folder-only provider exception must never cover a server script's computer-wide reads.
    expect(modeInput('claude-read-tools', 'Claude Code', project, browser)).toMatchObject({ kind: 'mode', root: null })
    expect(modeInput('claude-read-tools', 'Claude Code', project, { ...browser, interact: false })).toMatchObject({ root: project })
    const prepared = ask({ role: 'designer', project, browser })
    const receipt = prepared.verdict.receipt!
    expect(receipt.reads).toMatchObject({ scope: 'computer', words: expect.stringContaining('MCP server process') })
    expect(receipt.reads.words).not.toContain('writes nothing')
    const manifest = JSON.parse(readFileSync(join(prepared.folder, ASK_RUN_FILES.manifest), 'utf8'))
    expect(manifest.reads).toEqual(receipt.reads)
    expect(askJson(prepared.folder)).toMatchObject({ teammate: { could_read: manifest.reads.words } })
    expect(appAskDetail(prepared.id).line.reads).toMatchObject({ scope: 'computer', words: manifest.reads.words })
    // Old interactive records did not have scripts; do not widen their historical access claims.
    manifest.browser.tools = manifest.browser.tools.filter((name: string) => !['browser_run_code_unsafe', 'browser_evaluate'].includes(name))
    manifest.reads = { scope: 'folder', words: 'Historical folder-only mode', folder: project }
    writeFileSync(join(prepared.folder, ASK_RUN_FILES.manifest), JSON.stringify(manifest))
    expect(appAskDetail(prepared.id).line.reads).toMatchObject({ scope: 'folder', words: 'Historical folder-only mode' })
  })

  it('an ask without --origin keeps each app\'s MCP configuration empty, and its request hash is the one it had', () => {
    const plain = ask({ browser: null, role: 'epic-reviewer' })
    expect(plain.argv).toContain('mcp_servers={}')
    expect(existsSync(join(plain.folder, ASK_RUN_FILES.browser))).toBe(false)
    const request = { role: 'helper', question: 'q', files: [], images: [], timeLimitMinutes: 30 }
    expect(requestHash(request)).toBe(requestHash({ ...request, browser: null }))
    expect(requestHash({ ...request, browser: { origin: ORIGIN, interact: false, disposable: true } })).not.toBe(requestHash({ ...request, browser: { origin: ORIGIN, interact: true, disposable: true } }))
  })

  it('refuses, saying why: an address that is not loopback, no --disposable, a public ask, the server not in npx\'s cache, an OpenCode teammate', () => {
    expect(refusal(() => ask({ browser: { origin: 'http://192.168.1.20:8080', disposable: true } }))).toMatchObject({ code: 'INPUT_INVALID', message: expect.stringContaining('is not a loopback address') })
    expect(refusal(() => ask({ browser: { origin: ORIGIN, disposable: false } }))).toMatchObject({ code: 'DISPOSABLE_REQUIRED', message: expect.stringContaining(BROWSER_STATEMENT) })
    // What the browser shows is the asker's private app: Codex and Claude Code asks are private, and so is every browser ask.
    expect(refusal(() => ask({ data: 'public' } as Partial<Asked>))).toMatchObject({ message: expect.stringContaining('its asks are private') })
    stubNpx(false)
    expect(refusal(() => ask())).toMatchObject({ code: 'BROWSER_UNAVAILABLE', message: expect.stringContaining('npx @playwright/mcp@0.0.75 --version') })
    stubNpx()
    stubOpenCode(stubs)
    goSignInInBmnFolder(home)
    approve(home, EXAMPLE.replace('## roles', '## luna-go\n\n```yaml\nname: Luna (Go)\nclass: pawn\nharness: opencode\nmodel: gpt-6-luna\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [high]\nroles: [browser]\n```\n\n## roles')
      .replace('browser: {candidates: [luna@max], then: lead}', 'browser: {candidates: [luna-go@high], then: lead}')
      .replace('opencode-go: {name: OpenCode Go, hosts: [], private_work: public_only}', 'opencode-go: {name: OpenCode Go, hosts: [], private_work: allowed}'))
    expect(refusal(() => ask({ agent: 'luna-go', effort: 'high' }))).toMatchObject({ message: expect.stringContaining('BMN adds a browser only to Codex and Claude Code') })
  })
})

describe('the record of a browser ask (74.3 AC3)', () => {
  it('preserves the run\'s tool snapshot on first finish and repeated recovery after an upgrade (74.5 P2)', () => {
    const folder = mkdtempSync(join(home, 'historical-browser-'))
    const beforeScripts = browserTools(true).filter(tool => !['browser_run_code_unsafe', 'browser_evaluate'].includes(tool))
    mkdirSync(join(folder, 'inputs'))
    writeFileSync(join(folder, ASK_RUN_FILES.manifest), JSON.stringify({ browser: { origin: ORIGIN, interact: true, tools: beforeScripts } }))
    serverFiles(join(folder, 'browser'))
    const first = finishBrowser(folder)!
    expect(first.tools).toEqual(beforeScripts)
    expect(finishBrowser(folder)!.tools).toEqual(beforeScripts)
    expect(browserRecord(folder, { origin: ORIGIN, interact: true, tools: browserTools(true) }, first).record.tools).toEqual(beforeScripts)
    const current = mkdtempSync(join(home, 'current-browser-'))
    browserManifest(current, true)
    expect(finishBrowser(current)!.tools).toEqual(browserTools(true))
    const unknown = mkdtempSync(join(home, 'unknown-browser-'))
    expect(browserRecord(unknown, { origin: ORIGIN, interact: true }).record.tools).toEqual([])
  })

  it('reads the server\'s own session log: each call, the page it left, the screenshots it saved by name', () => {
    const calls = sessionCalls(SESSION)
    expect(calls).toHaveLength(10)
    expect(calls[0]).toEqual({ tool: 'browser_navigate', args: { url: ORIGIN }, page: { url: `${ORIGIN}/`, title: 'Synthetic shop' }, shots: [] })
    expect(calls[1]).toMatchObject({ tool: 'browser_take_screenshot', page: null, shots: ['page-2026-10-15T15-40-09-594Z.png'] })
    expect(calls[7]).toMatchObject({ tool: 'browser_take_screenshot', args: { filename: 'named.png' }, shots: ['named.png'] })
    expect(sessionCalls('no log here')).toEqual([])
  })

  it('keeps the pages in order and the screenshots the log names, bounded; removes the log, page snapshots, downloads, links and anything oversized, the record written first', () => {
    const folder = mkdtempSync(join(home, 'run-'))
    serverFiles(join(folder, 'browser'))
    const { record, removed } = browserRecord(folder, { origin: ORIGIN, interact: false, tools: browserTools(false) })
    expect([...removed].sort()).toEqual(['big.png', 'console-2026-10-15T15-40-09-392Z.log', 'link.png', 'made-up.bin', 'made-up.png', 'page-2026-10-15T15-40-09-516Z.yml', 'session-1792078809142'])
    expect(record.removed).toBe(removed.length)
    // Reading deletes nothing: the finish writes the record, then deletes.
    expect(readdirSync(join(folder, 'browser'))).toHaveLength(9)
    browserManifest(folder)
    finishBrowser(folder)
    expectRecord(folder)
    // The link's target is untouched.
    expect(existsSync('/etc/hostname')).toBe(true)
    // An ask whose server never started leaves an empty record.
    const empty = mkdtempSync(join(home, 'run-'))
    expect(browserRecord(empty, { origin: ORIGIN, interact: true }).record).toMatchObject({ calls: 0, pages: [], screenshots: [], removed: 0, interact: true })
  })
})

describe('a finish a crash ended is finished again from its record (74.3 AC3, full review)', () => {
  it('after the record and before the deletions, and after both: the same pages and screenshots, recovered twice; a screenshot replaced since is not kept; the temporary folder goes', () => {
    const folder = mkdtempSync(join(home, '20261015T190000-'))
    const temporary = browserTemporary(folder)
    try {
      serverFiles(join(folder, 'browser'))
      browserManifest(folder)
      // The record written, the crash before the deletions.
      const { record } = browserRecord(folder, { origin: ORIGIN, interact: false, tools: browserTools(false) })
      writeFileSync(join(folder, ASK_RUN_FILES.browserRecord), JSON.stringify(record))
      mkdirSync(join(temporary, 'playwright_chromiumdev_profile-made-up'), { recursive: true })
      writeFileSync(join(temporary, 'playwright_chromiumdev_profile-made-up', 'Cookies'), 'made-up')
      for (let time = 0; time < 2; time += 1) {
        expect(finishBrowser(folder)).toEqual(record)
        expectRecord(folder)
        expect(existsSync(temporary)).toBe(false)
      }
      // A screenshot replaced after the record (its bytes no longer the recorded ones) is neither kept nor shown.
      writeFileSync(join(folder, 'browser', 'named.png'), 'DOWNLOAD-PAYLOAD made-up')
      expect(finishBrowser(folder)?.screenshots.map((shot: { name: string }) => shot.name)).toEqual(['page-2026-10-15T15-40-09-594Z.png'])
      expect(readdirSync(join(folder, 'browser'))).toEqual(['page-2026-10-15T15-40-09-594Z.png'])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})

describe('BMN\'s relay between the app and the browser\'s server (74.3 AC1)', () => {
  it('starts the server in the browser folder, takes the app\'s workspace roots out of its start, passes every other message both ways and its exit', async () => {
    const browser = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-relay-')))
    try {
      // A stand-in server: it writes where it runs and what it received, and answers each line with its id.
      const server = join(browser, 'server.mjs')
      writeFileSync(server, `import { appendFileSync, writeFileSync } from 'node:fs'
writeFileSync('cwd.txt', process.cwd())
writeFileSync('tmpdir.txt', process.env.TMPDIR ?? '')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\\n'); at !== -1; at = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    appendFileSync('received.jsonl', line + '\\n')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(line).id ?? null, result: {} }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(7))
`)
      const temporary = join(browser, 'temporary')
      const relay = spawn(process.execPath, [BROWSER_RELAY, browser, temporary, process.execPath, server], { cwd: home, stdio: ['pipe', 'pipe', 'inherit'] })
      let output = ''
      relay.stdout.setEncoding('utf8')
      relay.stdout.on('data', (chunk) => { output += chunk })
      const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true }, elicitation: {} }, clientInfo: { name: 'made-up', version: '1' } } }
      const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: { filename: 'named.png', capabilities: { roots: {} } } } }
      relay.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(call)}\n`)
      relay.stdin.end()
      const code = await new Promise<number | null>((done) => relay.on('exit', done))
      expect(code).toBe(7)
      expect(readFileSync(join(browser, 'cwd.txt'), 'utf8')).toBe(browser)
      // The browser's profile and Playwright's working files go to the run's own temporary folder, owner-only.
      expect(readFileSync(join(browser, 'tmpdir.txt'), 'utf8')).toBe(temporary)
      expect(statSync(temporary).mode & 0o777).toBe(0o700)
      const received = readFileSync(join(browser, 'received.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(received).toEqual([{ ...initialize, params: { ...initialize.params, capabilities: { elicitation: {} } } }, call])
      expect(output.trim().split('\n').map((line) => JSON.parse(line).id)).toEqual([1, 2])
    } finally {
      rmSync(browser, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!SCOPES)('a browser ask run whole (74.3 AC3)', { timeout: 30_000 }, () => {
  beforeEach(() => stubBrowsingApps())

  it('Codex and Claude Code: the record holds the pages and screenshots and nothing else stays; asks show, the app\'s view and the export say the same', async () => {
    for (const role of ['browser', 'designer']) {
      const prepared = ask({ role, browser: { origin: ORIGIN, disposable: true, interact: role === 'designer' } })
      expect(prepared.verdict.verdict).toBe('PASS')
      startAsk(prepared, { timeLimitMinutes: 2 })
      const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
      expect(outcome.state, role).toBe('answered')
      expectRecord(prepared.folder, role === 'designer')
      const shown = askJson(prepared.folder)
      expect(shown.browser).toMatchObject({ origin: ORIGIN, interact: role === 'designer', recorded: true, calls: 10, screenshots: [{ name: 'named.png', path: join(prepared.folder, 'browser', 'named.png') }, { name: 'page-2026-10-15T15-40-09-594Z.png' }] })
      const words = showWords(shown)
      expect(words).toContain(`Browser: ${ORIGIN} (${role === 'designer' ? 'look and interact' : 'look only'}); 4 pages and 2 screenshots`)
      expect(words).toContain(`  page ${ORIGIN}/two  Second page`)
      expect(words).toContain(`  screenshot ${join(prepared.folder, 'browser', 'named.png')} (10 bytes)`)
      expect(words).not.toContain(ANSWER_KEY)
      expect(words).toContain(`  ${BROWSER_LIMIT_WORDS}`)
      expect(shown.browser).toMatchObject({ limit: BROWSER_LIMIT_WORDS })
      const detail = appAskDetail(prepared.id)
      expect(detail.browser).toMatchObject({ origin: ORIGIN, interact: role === 'designer', pages: expect.arrayContaining([{ url: `${ORIGIN}/two`, title: 'Second page' }]), screenshots: [{ name: 'named.png', bytes: 10 }, { name: 'page-2026-10-15T15-40-09-594Z.png', bytes: 10 }] })
      expect(detail.line.reads.browser).toEqual({ origin: ORIGIN, interact: role === 'designer' })
      expect(detail.browser?.limit).toBe(BROWSER_LIMIT_WORDS)
      const output = join(home, `export-${role}`)
      const files = exportAsk(prepared.folder, output)
      expect(files).toEqual(expect.arrayContaining(['browser.json', 'browser/named.png', 'browser/page-2026-10-15T15-40-09-594Z.png']))
      expect(files.filter((file) => file.startsWith('browser/'))).toHaveLength(2)
    }
  })

  it('after a crash, whoever finishes the record keeps the pages and screenshots and removes every download and snapshot', async () => {
    const prepared = ask({ question: 'Does the checkout page load? SLEEP' })
    expect(existsSync(join(prepared.folder, 'browser', 'made-up.bin'))).toBe(false)
    // What the browser's profile leaves in the run's temporary folder: recovery removes it.
    mkdirSync(join(browserTemporary(prepared.folder), 'playwright-artifacts-made-up'), { recursive: true })
    const started = startAsk(prepared, { timeLimitMinutes: 2 })
    await settle(() => existsSync(join(prepared.folder, 'browser', 'made-up.bin')))
    const cgroup = JSON.parse(readFileSync(join(prepared.folder, 'state.json'), 'utf8')).scope?.cgroup
    process.kill(started.pid, 'SIGKILL')
    await settle(() => scopeGone(cgroup) && leftovers(home).length === 0)
    expect(askOutcome(prepared.folder).state).toBe('interrupted')
    recordInterrupted(prepared.folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
    expect(askOutcome(prepared.folder)).toMatchObject({ state: 'interrupted', exit: 1 })
    expectRecord(prepared.folder)
    expect(existsSync(browserTemporary(prepared.folder))).toBe(false)
  })
})

describe('the command\'s browser options (74.3 AC4)', () => {
  it('--disposable and --interact go with --origin; a question with neither --role, --image nor --origin is refused', () => {
    const run = (...argv: string[]) => spawnSync(process.execPath, ['-e', `import(${JSON.stringify(CLI)}).then((m) => m.runTeamAsk(${JSON.stringify(argv)})).then((code) => process.exit(code))`], { env: { ...env, BMN_SESSION_ID: '' }, cwd: home, encoding: 'utf8' })
    for (const [flag, argv] of [['--disposable', ['--question', 'q', '--role', 'helper', '--disposable']], ['--interact', ['--question', 'q', '--role', 'helper', '--interact']]] as const) {
      const result = run(...argv)
      expect(result.status, flag).toBe(2)
      expect(result.stderr).toContain(`${flag} goes with --origin, the address of the app to check`)
    }
    expect(run('--question', 'q')).toMatchObject({ status: 2, stderr: expect.stringContaining('team ask needs --role') })
  })
})
