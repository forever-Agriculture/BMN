// MODULE: agents-schema-search.test.ts - Epic 60.1 AC5: a PASS/FAIL search proving no schema-1 roster key, label, seal or trust pip is left in code, fixtures, tests or current docs
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
  ...inFolder('apps/desktop/src/main', /^(agents-.*|route-baselines|visibility-refresh)\.ts$/),
  ...inFolder('apps/desktop/src/utility', /^agents-(?!schema-search).*\.ts$/),
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
  ['apps/desktop/src/utility/agents-roster.test.ts', /'the earlier small_epic rule'|'the earlier ## data-labels section'|toMatch\(\/title became class\/\)|toMatch\(\/trust, authority, security, cost, quota, tags and ## data-labels are gone\/\)|schema_version: 1, agents: \[/]
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
