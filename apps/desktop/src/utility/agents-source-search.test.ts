// MODULE: agents-source-search.test.ts - Epic 60.1 AC5 and R60-NFR3: PASS/FAIL searches proving no schema-1 roster word is left, and that team and rules state has no path into the database, Backup export, Telegram or logs
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))
const OBSOLETE = ['title', 'trust', 'authority', 'security', 'cost', 'quota', 'tags', 'small_epic', 'max_context_tokens', 'data-labels'] as const
const WORDS = OBSOLETE.join('|')

const inFolder = (folder: string, pattern: RegExp): string[] => readdirSync(join(REPOSITORY, folder)).filter((name) => pattern.test(name)).map((name) => `${folder}/${name}`)

/** Everything that reads, writes, types, shows or tests the team file. */
const ROSTER_CODE = [
  ...inFolder('apps/desktop/bin', /^agents-.*\.(mjs|d\.mts)$/),
  ...inFolder('apps/desktop/src/main', /^(agents-.*|visibility-refresh)\.ts$/),
  ...inFolder('apps/desktop/src/utility', /^agents-(?!source-search).*\.ts$/),
  ...inFolder('apps/desktop/src/utility/test-fixtures/agents', /./),
  ...inFolder('apps/desktop/src/renderer/src', /^(team-.*|rules-preferences|roster-.*)\.tsx?$/),
  'shared/protocol/src/agents-roster.ts',
  'scripts/test/agents-rules-visual.mjs'
]
const COMPONENTS = [...inFolder('apps/desktop/src/renderer/src', /^(team-preferences|rules-preferences|roster-marks|preferences-dialog)\.(tsx|css)$/)]
const DOCS = ['docs/agent-control.md', 'docs/features.md', 'README.md']

/**
 * Lines that name an obsolete key on purpose: the refusal that tells the owner what the earlier
 * layout became, and the tests proving an earlier file or approved version is refused.
 */
const HISTORICAL: Array<[file: string, line: RegExp]> = [
  ['apps/desktop/bin/agents-roster.mjs', /^const SCHEMA_1_CHANGES = /],
  ['apps/desktop/src/utility/agents-roster.test.ts', /'the earlier small_epic rule'|'the earlier ## data-labels section'|toMatch\(\/title became class\/\)|toMatch\(\/trust, authority, security, cost, quota, tags and ## data-labels are gone\/\)|schema_version: 1, agents: \[/],
  // Not a team field: OpenCode's own session export names what a session spent `cost` (70.4), read once into reported_cost.
  ['apps/desktop/bin/agents-opencode.mjs', /^\s*reported_cost: number\(info\.cost\)$/]
]

interface Hit { file: string; line: number; text: string }

function search(files: string[], pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    readFileSync(join(REPOSITORY, file), 'utf8').split('\n').forEach((text, index) => {
      if (!pattern.test(text)) return
      if (HISTORICAL.some(([name, line]) => name === file && line.test(text))) return
      hits.push({ file, line: index + 1, text: text.trim().slice(0, 160) })
    })
  }
  return hits
}

const report = (hits: Hit[]): string => hits.length === 0 ? 'PASS' : `FAIL\n${hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`).join('\n')}`

describe('no schema-1 roster word is left (60.1 AC5)', () => {
  it('searches a real set of files', () => {
    expect(ROSTER_CODE.length).toBeGreaterThan(20)
    expect(COMPONENTS).toHaveLength(5)
  })

  it('as a YAML key in code, fixtures, tests or docs', () => {
    // `key:` opening a line or inside a flow mapping, as the team file writes its fields; the quoted key a parser would list.
    const quoted = `['"\`](trust|authority|security|cost|quota|tags|small_epic|max_context_tokens|data-labels)['"\`]`
    const yamlKey = new RegExp(`(^|[{,])\\s*-?\\s*(${WORDS}):(\\s|$)|^#+ data-labels\\b|${quoted}`)
    // In a TypeScript test a `title:` inside braces is an object's own member (a sheet's title), so only the other keys are searched there.
    const yamlKeyInTypeScript = new RegExp(`^\\s*-?\\s*(${WORDS}):(\\s|$)|[{,]\\s*(${WORDS.replace('title|', '')}):\\s|${quoted}`)
    for (const sample of ['trust: 2', '  security: high', 'luna: {name: Luna, authority: read}', '## data-labels', "const KEYS = ['name', 'quota']"]) {
      expect(yamlKey.test(sample), sample).toBe(true)
    }
    expect(yamlKeyInTypeScript.test("{ id: 'luna', trust: 2 }")).toBe(true)
    expect(report(search([...ROSTER_CODE.filter((file) => /\.(mjs|md)$/.test(file)), ...DOCS], yamlKey))).toBe('PASS')
    expect(report(search(ROSTER_CODE.filter((file) => /\.test\.ts$/.test(file)), yamlKeyInTypeScript))).toBe('PASS')
  })

  it('as a protocol member or a field the code reads', () => {
    const typed = ['shared/protocol/src/agents-roster.ts', ...ROSTER_CODE.filter((file) => file.endsWith('.d.mts'))]
    expect(report(search(typed, new RegExp(`^\\s*(readonly\\s+)?['"]?(${WORDS})['"]?\\??:`)))).toBe('PASS')
    // `.title` is left out here: a sheet's or a page's title is unrelated, and the member search above covers the shapes.
    const read = new RegExp(`\\.(trust|authority|security|cost|quota|tags|small_epic|max_context_tokens)\\b|\\[['"](${WORDS})['"]\\]`)
    expect(report(search(ROSTER_CODE.filter((file) => !file.endsWith('.md')), read))).toBe('PASS')
  })

  it('as a label or an accessible name on the Team and Rules pages', () => {
    const label = />\s*(Title|Trust|Authority|Security|Cost|Quota|Tags|Small epic|Data labels?)\s*[<{]|(label|aria-label|name|title|placeholder)=["'{`]+\s*(Title|Trust|Authority|Security|Cost|Quota|Tags|Small epic|Data labels?)\b|['"`](Title|Trust|Authority|Security|Cost|Quota|Tags|Small epic|Data labels?)['"`]/
    expect(report(search(COMPONENTS.filter((file) => file.endsWith('.tsx')), label))).toBe('PASS')
  })

  it('as a seal or a trust pip', () => {
    expect(report(search(COMPONENTS, /\bseal(s|ed)?\b|[Ss]eal[A-Z]|\bpips?\b|[Pp]ip[A-Z]|trust-pip|-seal\b|-pip\b/))).toBe('PASS')
  })

  it('in the docs that describe the team file', () => {
    const text = readFileSync(join(REPOSITORY, 'docs/agent-control.md'), 'utf8')
    const start = text.indexOf('## The team: team file, check and rules')
    expect(start).toBeGreaterThan(0)
    const section = text.slice(start, text.indexOf('\n## ', start + 1))
    expect(section).toContain('schema_version: 2')
    const hits = section.split('\n').flatMap((line, index) => new RegExp(`\`(${WORDS})\`|\\b(squire|trust|authority|data label|sealed|pips?)\\b|\\b(High|Low) (route|security)`).test(line) ? [`${index + 1}: ${line}`] : [])
    expect(hits.length === 0 ? 'PASS' : `FAIL\n${hits.join('\n')}`).toBe('PASS')
  })
})

/**
 * R60-NFR3: the team file, notes, exceptions, visibility records, receipts and rules live in
 * owner files under ~/.config/bmn/agents and nowhere else. Backup export copies the database and
 * stored files; Telegram and diagnostics read the database and the app's own state. So the proof
 * is structural: the modules that hold this state reach no store, service or logger, and nothing
 * but the app's entry point and the CLI reaches them.
 */
describe('team and rules state has no path into the database, Backup export, Telegram or logs (R60-NFR3)', () => {
  const HOLDERS = [
    ...inFolder('apps/desktop/bin', /^(agents-.*|safe-config-write|text-diff)\.mjs$/),
    // app-program only finds an agent app's program on PATH for Health; it is held to the same rule because the IPC module imports it.
    ...inFolder('apps/desktop/src/main', /^(agents-(approval|ipc)|auto-tests|visibility-refresh|app-program)\.ts$/)
  ]
  // Static imports and re-exports (their binding lists hold no quotes or brackets), bare imports and dynamic ones.
  const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\w*\s{},$]+?\s+from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  const imports = (file: string): string[] => [...readFileSync(join(REPOSITORY, file), 'utf8').matchAll(IMPORT)].map((match) => (match[1] ?? match[2] ?? match[3]) as string)

  it('searches the modules that hold it, and reads their imports', () => {
    // Story 72.9 removed the container and frozen-copy modules (agents-container, agents-team-tree); 74.3 added agents-team-browser;
    // 75.8 put context-auto and skills-auto into the one auto-tests; 77.4 added agents-own-skills;
    // 80.16 split agents-check into seven parts behind its facade.
    expect(HOLDERS).toHaveLength(43)
    expect(imports('apps/desktop/src/main/app-program.ts')).toEqual(['node:fs', 'node:path'])
    expect(imports('apps/desktop/src/main/agents-ipc.ts')).toEqual(expect.arrayContaining(['node:fs', '@bmn/protocol', '../../bin/agents-roster.mjs', './agents-approval', './workspace-ipc']))
    expect(imports('apps/desktop/bin/agents-rules.mjs')).toEqual(expect.arrayContaining(['./agents-check.mjs']))
  })

  it('they import only Node, the protocol types, each other and the IPC error type', () => {
    const allowed = /^(node:[a-z/_]+|electron|@bmn\/protocol|\.\.?\/(\.\.\/bin\/)?(agents-(roster|state|check(-(base|argv|routes|workspace|consequences|evaluate|team-ask))?|rules|cli|approval|guard|context|skills|own-skills|research|ask|fence|supervised|judge|tools|tool-files|opencode|container|team-app|team-ask|team-browser|team-cli|team-forms|team-inputs|team-nested|team-pictures|team-places|team-resolve|team-run|team-supervisor|team-tree)|safe-config-write|text-diff)(\.mjs)?|\.\/workspace-ipc|\.\/app-program|\.\/auto-tests)$/
    const hits = HOLDERS.flatMap((file) => imports(file).filter((name) => !allowed.test(name)).map((name) => `${file}: imports ${name}`))
    expect(hits.length === 0 ? 'PASS' : `FAIL\n${hits.join('\n')}`).toBe('PASS')
    // The one Electron import is a type, and the IPC module takes only its error class from the workspace handlers.
    expect(readFileSync(join(REPOSITORY, 'apps/desktop/src/main/agents-ipc.ts'), 'utf8')).toMatch(/^import type \{ IpcMainInvokeEvent \} from 'electron'$/m)
    expect(readFileSync(join(REPOSITORY, 'apps/desktop/src/main/agents-ipc.ts'), 'utf8')).toMatch(/^import \{ MainIpcError \} from '\.\/workspace-ipc'$/m)
  })

  it('they write nothing to a console or a logger', () => {
    const main = HOLDERS.filter((file) => file.endsWith('.ts'))
    expect(report(search(main, /\bconsole\.|\blogger\b|\blog\.(info|warn|error|debug)\(/))).toBe('PASS')
  })

  it('only the app entry point and the CLI reach them', () => {
    const sources = [
      ...inFolder('apps/desktop/src/main', /\.ts$/), ...inFolder('apps/desktop/src/utility', /\.ts$/),
      ...inFolder('apps/desktop/src/preload', /\.ts$/), ...inFolder('apps/desktop/src/renderer/src', /\.tsx?$/), 'apps/desktop/bin/bmn'
    ].filter((file) => !/\.test\.tsx?$/.test(file) && !HOLDERS.includes(file))
    const reaching = sources.filter((file) => imports(file).some((name) => /(^|\/)(agents-(roster|state|check|rules|cli|approval|ipc|context|skills|research|guard)|visibility-refresh)(\.mjs)?$/.test(name)))
    expect(reaching.sort()).toEqual(['apps/desktop/bin/bmn', 'apps/desktop/src/main/index.ts'])
  })
})

/**
 * 65.3 AC6 and R65-NFR4: Jev is ready for the uses the owner finds, and nothing in BMN uses an
 * answer yet. So nothing but the command, the judge's own page and their wiring may start a call
 * or read what one returns. (The dev-auto repository is searched apart; its output is kept with
 * the epic's evidence.)
 */
describe('nothing in BMN asks the judge or reads its answer but the command and its page (65.3 AC6)', () => {
  const folders: Array<[folder: string, pattern: RegExp]> = [
    ['apps/desktop/bin', /^(bmn|.*\.mjs)$/], ['apps/desktop/src/main', /\.ts$/], ['apps/desktop/src/utility', /\.ts$/], ['apps/desktop/src/preload', /\.ts$/],
    ['apps/desktop/src/renderer/src', /\.tsx?$/], ['scripts', /\.(mjs|sh)$/], ['scripts/lib', /\.mjs$/], ['shared/protocol/src', /\.ts$/]
  ]
  const sources = folders.flatMap(([folder, pattern]) => inFolder(folder, pattern)).filter((file) => !/\.test\.tsx?$/.test(file))
  /** A call of the command from code, the module that makes the request, the function that asks, or the page's own channel. */
  const ASKS = /agents-judge(\.mjs)?['"]|\brunJudge(Command)?\(|\btryJudge\(|aiterm:judge:try|['"`]judge['"`],\s*['"`]ask['"`]|\bspawn\w*\([^)]*judge/
  const asking = (): string[] => sources.filter((file) => ASKS.test(readFileSync(join(REPOSITORY, file), 'utf8'))).sort()

  it('searches a real set of files', () => {
    expect(sources.length).toBeGreaterThan(150)
    expect(sources).toContain('apps/desktop/bin/agents-judge.mjs')
    expect(sources).toContain('apps/desktop/src/renderer/src/judge-page.tsx')
  })

  it('only the command, its wiring into the CLI, and the page with its three handlers reach a call', () => {
    expect(asking()).toEqual([
      // The command itself, and the CLI's entry that starts it.
      'apps/desktop/bin/agents-judge.mjs', 'apps/desktop/bin/bmn',
      // Try it on the judge's page: the handler, the bridge with its types, and the page.
      'apps/desktop/src/main/agents-ipc.ts', 'apps/desktop/src/preload/bridge.d.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/judge-page.tsx'
    ])
  })

  it('nothing reads the record of calls but the command and the page\'s handler', () => {
    const readers = sources.filter((file) => /\b(readJudgeRecord|judgeTotals|judgeRecordPath)\b/.test(readFileSync(join(REPOSITORY, file), 'utf8'))).sort()
    expect(readers).toEqual(['apps/desktop/bin/agents-judge.mjs', 'apps/desktop/src/main/agents-ipc.ts'])
  })
})
