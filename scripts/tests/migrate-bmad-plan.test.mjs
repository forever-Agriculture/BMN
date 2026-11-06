// MODULE: migrate-bmad-plan.test.mjs - Story 77.6: the BMAD-to-plan move on a synthetic BMAD project: shared sections, links, long comments, a park, binaries, a rerun and a collision
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archive, checkLinks, checkSpans, normalizeEpic, rehearseRollback, reverseRewrites, rewriteLinks, segmentEpics, selectUnfinishedPlan, stagePlan, verifyTree } from '../plan/migrate-bmad-plan.mjs'

const BMN = resolve(import.meta.dirname, '../../apps/desktop/bin/bmn')
const roots = []
it('keeps generated foreign-project context neutral and derives its purpose from the source', () => {
  const { repo, root } = fixture(), stage = join(root, 'out/plan')
  stagePlan({ repo, stage })
  const plan = readFileSync(join(stage, 'PLAN.md'), 'utf8'), vision = readFileSync(join(stage, 'VISION.md'), 'utf8')
  expect(plan).toContain('[docs/architecture.md](../docs/architecture.md)')
  expect(plan).not.toMatch(/control socket|phone connector|Story 77\./u)
  expect(vision).toContain('A synthetic product for the move.')
  expect(vision).not.toMatch(/Epic 75|Story 77\.|every epic since/u)
})
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-migrate-')); roots.push(root)
  const repo = join(root, 'repo')
  const file = (path, text) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), text) }
  file('docs/architecture.md', '# Architecture\n')
  file('apps/x.ts', 'export {}\n')
  file('_bmad/bmm/config.yaml', 'implementation_artifacts: "{project-root}/_bmad-output/implementation-artifacts"\n')
  file('.claude/skills/bmad-help/SKILL.md', '---\nname: bmad-help\n---\n')
  file('_bmad-output/planning-artifacts/epics.md', `---
stepsCompleted: ['step-01']
---

# Fixture — Epics 1–4

## Overview

A synthetic product for the move.

## Shared Context and Completion Rules

Every epic is verified on the running build.

## Epic 1: First Thing

Text with a [sibling](reference-context.md#part) and [code](../../apps/x.ts) and [gone](../../apps/deleted.ts:12).

### Story 1.1: Do It

**Acceptance criteria:**
1. **Given** a, **then** b.

## Extension: Two Together (2, 3), 2026-10-01

Shared by epics 2 and 3; see [epic 1](epics.md#epic-1-first-thing).

## Epic 2: Second

### Story 2.1: A

## Epic 3: Third

### Story 3.1: B
### Story 3.2: C (dropped)

## Extension: Only Four (4), 2026-10-02

Four's own extension, canonical contract in \`docs/epic-4-plan.md\`.

## Epic 4: Fourth

Delegated: the canonical contract is \`docs/epic-4-plan.md\`.

### Story 4.1: D
`)
  file('_bmad-output/planning-artifacts/reference-context.md', '# Context\n\nBack to [the plan](epics.md) and [docs](../../docs/architecture.md).\n\n## Part\n\nThe part an epic links to.\n')
  file('_bmad-output/planning-artifacts/reference-1/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  file('_bmad-output/implementation-artifacts/1-1-story.md', '# Story file\n')
  file('_bmad-output/implementation-artifacts/sprint-status.yaml', `# Scope: fixture
# Delivery order: 1 -> 2 -> 3 -> 4
development_status:
  epic-1: done # accepted on main abc1234
  1-1-do-it: done
  epic-1-retrospective: optional
  epic-2: in-progress # ${'long comment '.repeat(20)}
  2-1-a: review
  epic-3: done
  3-1-b: done
  epic-4: backlog # parked 2026-10-16 by the owner
  4-1-d: ready-for-dev
  4-2-extra-on-board: backlog
`)
  symlinkSync('reference-context.md', join(repo, '_bmad-output/planning-artifacts/context-link.md'))
  return { root, repo }
}

describe('moving a BMAD plan into plan/ (Story 77.6)', () => {
  it('moves only unfinished epics and their transitive linked documents, accounting for omitted history (108 D25)', () => {
    const { root, repo } = fixture(), source = '_bmad-output/planning-artifacts/epics.md'
    const original = readFileSync(join(repo, source), 'utf8')
    writeFileSync(join(repo, source), original.replace('## Epic 2: Second', '## Epic 2: Second\n\n[context](reference-context.md#part) and [finished](epics.md#epic-1-first-thing).'))
    mkdirSync(join(repo, 'docs/platform'), { recursive: true })
    writeFileSync(join(repo, 'docs/platform/epic-1-old.md'), '# Epic 1: Old\n')
    const stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage, unfinishedOnly: true })
    const board = readFileSync(join(stage, 'status.yaml'), 'utf8')
    expect(board).not.toMatch(/epic-[13]:|[13]-1-/u)
    expect(readdirSync(join(stage, 'epics'))).toHaveLength(2)
    expect(readFileSync(join(stage, 'epics/002-second.md'), 'utf8')).toContain('gone-link-targets.md')
    expect(existsSync(join(stage, 'references/reference-context.md'))).toBe(true)
    expect(existsSync(join(stage, 'references/reference-1/shot.png'))).toBe(false)
    expect(existsSync(join(stage, 'references/platform/epic-1-old.md'))).toBe(false)
    expect(manifest.spans).toContainEqual(expect.objectContaining({ source, to: 'archive-only', sha256: createHash('sha256').update(segmentEpics(original).segments.find(s => s.number === 1).text).digest('hex') }))
    expect(manifest.board.rows.find(row => row.key === 'epic-1').to).toBe('archive-only')
    expect(manifest.unfinished_only).toBe(true)
    expect(readFileSync(join(stage, 'PLAN.md'), 'utf8')).toContain('New epics number from 5.')
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
  })
  it('does not copy an extension covering only finished epics (108 D25)', () => {
    const { root, repo } = fixture(), path = join(repo, '_bmad-output/planning-artifacts/epics.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace('## Epic 1: First Thing', '## Extension: Finished only\n\nHistorical extension.\n\n## Epic 1: First Thing'))
    const stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage, unfinishedOnly: true })
    expect(existsSync(join(stage, 'shared/finished-only.md'))).toBe(false)
    expect(manifest.spans.some(span => span.to === 'archive-only')).toBe(true)
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
  })
  it('does not resurrect a hand-edited finished epic or its unlinked evidence when carrying an older cut forward (108 D25)', () => {
    const { root, repo } = fixture(), stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage, unfinishedOnly: true })
    const old = join(stage, 'epics/001-hand-edited-title.md')
    writeFileSync(old, '# Epic 1: Hand edited historical contract\n')
    mkdirSync(join(stage, 'references/historical-evidence'), { recursive: true })
    writeFileSync(join(stage, 'references/historical-evidence/raw.log'), 'old evidence\n')
    const open = join(stage, 'epics/002-second.md')
    writeFileSync(open, readFileSync(open, 'utf8') + '\n[finished](001-hand-edited-title.md)\n')
    selectUnfinishedPlan(stage, manifest)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(stage, 'references/historical-evidence/raw.log'))).toBe(false)
    expect(readFileSync(open, 'utf8')).toContain('gone-link-targets.md')
    expect(readFileSync(join(stage, 'references/gone-link-targets.md'), 'utf8')).toContain('001-hand-edited-title.md')
  })
  it('prunes merged finished rows and plan-only completed epics while preserving the next unused number (108 D25)', () => {
    const { root, repo } = fixture(), stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage, unfinishedOnly: true })
    const board = join(stage, 'status.yaml')
    writeFileSync(board, readFileSync(board, 'utf8').replace('queue: []', 'queue:\n  - 1\n  - 9\n  - 2') + '  epic-1: done\n  1-1-do-it: done\n  epic-9: done\n  9-1-newly-finished: done\n')
    writeFileSync(join(stage, 'epics/009-newly-finished.md'), '# Epic 9: Newly finished\n')
    selectUnfinishedPlan(stage, manifest)
    expect(readFileSync(board, 'utf8')).not.toMatch(/epic-[19]:|[19]-1-/u)
    expect(readFileSync(board, 'utf8')).toContain('queue:\n  - 2')
    expect(existsSync(join(stage, 'epics/009-newly-finished.md'))).toBe(false)
    expect(readFileSync(join(stage, 'PLAN.md'), 'utf8')).toContain('New epics number from 10.')
  })
  it('retains owner numbering reservations and prose through repeated final unfinished selections', () => {
    const { root, repo } = fixture(), generated = join(root, 'out/plan'), manifest = stagePlan({ repo, stage: generated, unfinishedOnly: true })
    const stage = join(root, 'merged'); cpSync(generated, stage, { recursive: true })
    const plan = join(stage, 'PLAN.md'), declaration = 'New epics number from 200. Owner reserves the earlier numbers.'
    writeFileSync(plan, readFileSync(plan, 'utf8').replace(/^New epics number from .*$/mu, declaration))
    for (let pass = 0; pass < 2; pass++) {
      selectUnfinishedPlan(stage, manifest)
      expect(readFileSync(plan, 'utf8')).toContain(declaration)
    }
  })
  it.each(['07', '008', '9'])('discovers a platform contract whose filename uses epic number %s', padded => {
    const { root, repo } = fixture(), number = Number(padded), source = `docs/platform/epic-${padded}-hygiene.md`
    const text = `# Epic ${number}: Hygiene\n\n## Story ${number}.1: Preserve the contract\n\n**Acceptance criteria:**\n1. **Given** the original plan, **then** its complete contract remains primary.\n`
    mkdirSync(join(repo, 'docs/platform'), { recursive: true }); writeFileSync(join(repo, source), text)
    const board = join(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    writeFileSync(board, readFileSync(board, 'utf8') + `  epic-${number}: in-progress\n  ${number}-1-preserve-the-contract: backlog\n`)
    const stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage })
    const target = `epics/${String(number).padStart(3, '0')}-hygiene.md`
    expect(existsSync(join(stage, target))).toBe(true)
    expect(readFileSync(join(stage, target), 'utf8')).toContain(text)
    expect(manifest.spans).toContainEqual(expect.objectContaining({ source, to: target }))
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
  })
  it.each(['existing-primary', 'ambiguous-padded', 'explicit-padded'])('keeps the established contract or requires a padded candidate decision (%s)', shape => {
    const { root, repo } = fixture(), first = shape === 'existing-primary' ? 'epic-7-primary.md' : 'epic-07-first.md'
    const later = 'epic-007-later.md', one = '# Epic 7: Original\n\n## Story 7.1: Original\n', two = '# Epic 7: Later\n\n## Story 7.1: Later\n\n## Story 7.2: Extra\n'
    mkdirSync(join(repo, 'docs/platform'), { recursive: true })
    writeFileSync(join(repo, 'docs/platform', first), one); writeFileSync(join(repo, 'docs/platform', later), two)
    const board = join(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    writeFileSync(board, readFileSync(board, 'utf8') + `  epic-7: in-progress${shape === 'explicit-padded' ? ' # canonical docs/platform/' + later : ''}\n  7-1-original: backlog\n`)
    const stage = join(root, 'out/plan')
    if (shape === 'ambiguous-padded') {
      expect(() => stagePlan({ repo, stage })).toThrow(/multiple padded contracts/u)
      return
    }
    const manifest = stagePlan({ repo, stage }), target = shape === 'existing-primary' ? 'epics/007-primary.md' : 'epics/007-later.md'
    expect(existsSync(join(stage, target))).toBe(true)
    expect(readFileSync(join(stage, target), 'utf8')).toContain(shape === 'existing-primary' ? one : two)
    expect(manifest.spans).toContainEqual(expect.objectContaining({ source: `docs/platform/${shape === 'existing-primary' ? first : later}`, to: target }))
  })
  it('seeds every row for two-way sync, including Artem and dirty rows (108 D25)', () => {
    const { root, repo } = fixture(), board = join(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-qb', 'main'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'initial plan')
    writeFileSync(board, readFileSync(board, 'utf8').replace('4-1-d: ready-for-dev', '4-1-d: review'))
    git('add', '.'); git('-c', 'user.name=Artem Kobrin', '-c', 'user.email=artem@example.invalid', 'commit', '-qm', 'Artem row')
    const upstream = git('rev-parse', 'HEAD').toString().trim()
    writeFileSync(board, readFileSync(board, 'utf8').replace('4-2-extra-on-board: backlog', '4-2-extra-on-board: in-progress'))
    const result = stagePlan({ repo, stage: join(root, 'one/plan'), keepBmad: true, historyHead: upstream })
    expect(result.copy.version).toBe(2)
    expect(result.copy.active).toBe(false)
    expect(result.copy.excluded).toEqual({})
    expect(result.copy.unresolved).toEqual({})
    expect(result.copy.rows['4-1-d'].last_copied.status).toBe('review')
    expect(result.copy.rows['4-2-extra-on-board'].last_copied.status).toBe('backlog')
    expect(result.copy.rows['4-2-extra-on-board'].source_value.status).toBe('backlog')
  })
  it('normalizes headings and missing planning sections while keeping every story requirement byte (107.4)', () => {
    const { root } = fixture(), path = join(root, '110-fixture.md')
    const story = '### Story 110.1 — Keep the packet\n\n**Owner:** none.\n**Acceptance criteria:**\n1. **Given** the original packet, **then** use every byte.\n\n**Verification:** real replay.\n'
    writeFileSync(path, '<!-- bmn-plan: bmad-legacy -->\n# Epic 110 — Fixture\n\n## 1. Outcome\nKeep it.\n\n## 3. Boundary and order\nOnly this.\n\n## Run needs\n- **Money cap:** $55.\n\n## 9. Stories\n\n' + story)
    const result = normalizeEpic({ path, additions: { Why: 'Synthetic fixture.', 'Truth impact': 'none', Prepared: 'none, because this fixture is entirely local.', Challenges: ['Scale', 'Origin', 'Verified', 'Exists', 'People'].map((label) => `- **${label}:** synthetic fixture.`).join('\n') } })
    const text = readFileSync(path, 'utf8')
    expect(text).toContain(story)
    expect(text).toContain('- **Money cap:** $55.')
    expect(text).toContain('## Boundary and dependencies\nOnly this.')
    expect(text).toContain('**Prepared:** none, because this fixture is entirely local.')
    expect(text).not.toContain('bmad-legacy')
    expect(result.story_bytes_unchanged).toBe(true)
    expect(() => normalizeEpic({ path, additions: {} })).toThrow('already normalized')
  })
  it('adds a Stories heading before the first story when the legacy epic has none, and takes Prepared from an allowances file (BMN 109.1)', () => {
    const { root } = fixture(), epics = join(root, 'plan/epics'), path = join(epics, '023-fixture.md')
    mkdirSync(epics, { recursive: true })
    mkdirSync(join(root, 'plan/allowances'), { recursive: true })
    writeFileSync(join(root, 'plan/allowances/023.yaml'), 'schema: 1\nepic: 23\n')
    const story = '## Story 23.1: Keep the packet\n\n**Do:** use every byte.\n\n### Detail\nkept.\n'
    writeFileSync(path, '<!-- bmn-plan: bmad-legacy -->\n# Epic 23: fixture\n\n## What is open\nA table.\n\n' + story + '\n## Order\n23.1 first.\n')
    const additions = { Outcome: 'Kept.', Why: 'Synthetic.', 'Boundary and dependencies': 'Alone.', 'Run needs': 'See `plan/allowances/023.yaml`.', 'Truth impact': 'none', Challenges: '- **Scale:** small.' }
    const result = normalizeEpic({ path, additions })
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('## What is open\nA table.\n\n## Outcome\n\nKept.')
    expect(text).toContain('## Stories\n### Story 23.1: Keep the packet\n\n**Do:** use every byte.\n\n### Detail\nkept.\n')
    expect(text).toContain('## Order\n23.1 first.')
    expect(text).not.toContain('**Prepared:**')
    expect(result.story_bytes_unchanged).toBe(true)
    writeFileSync(path, '<!-- bmn-plan: bmad-legacy -->\n## Epic 23: fixture at level two\n\n' + story)
    normalizeEpic({ path, additions })
    expect(readFileSync(path, 'utf8')).not.toContain('**Prepared:**')
    rmSync(join(root, 'plan/allowances/023.yaml'))
    writeFileSync(path, '<!-- bmn-plan: bmad-legacy -->\n# Epic 23: fixture\n\n' + story)
    expect(() => normalizeEpic({ path, additions })).toThrow('missing normalization content for Prepared')
  })
  it('preserves opaque and duplicate legacy IDs explicitly without weakening new row checks (107.4)', () => {
    const { root, repo } = fixture()
    const source = join(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    writeFileSync(source, readFileSync(source, 'utf8') + '  1-1-distinct-finished-work: done\n  epic-33b: backlog\n  33b-1-kept: backlog\n  rpc-integer-inputs-delivery: review\n')
    const stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage, keepBmad: true })
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
    const metadata = JSON.parse(readFileSync(join(stage, 'legacy-rows.json'), 'utf8'))
    expect(Object.keys(metadata.rows)).toEqual(['epic-1-retrospective', '1-1-distinct-finished-work', 'epic-33b', '33b-1-kept', 'rpc-integer-inputs-delivery'])
    expect(metadata.rows['epic-33b'].original_key).toBe('epic-33b')
    execFileSync('git', ['init', '-q', join(root, 'out')])
    const check = () => spawnSync(process.execPath, [BMN, 'plan', 'check', '--json'], { cwd: join(root, 'out'), encoding: 'utf8' })
    expect(JSON.parse(check().stdout).findings).toEqual([])
    const board = join(stage, 'status.yaml')
    writeFileSync(board, readFileSync(board, 'utf8') + '  1-1-new-duplicate: done\n  new-opaque-work: backlog\n')
    const findings = JSON.parse(check().stdout).findings
    expect(findings.some((f) => f.reason.includes('1-1-new-duplicate') && f.reason.includes('again'))).toBe(true)
    expect(findings.some((f) => f.reason.includes('new-opaque-work') && f.reason.includes('no epic'))).toBe(true)
  })
  it('discovers delegated platform epics and keeps comment-only rows in history (107.4)', () => {
    const { root, repo } = fixture()
    const source = '# MODULE: epic-12.md - delegated contract\n\n**Suggested lead:** Sol 🇺🇸 — synthetic.\n\n## Story 12.1: Keep the words\n\nThe exact requirement must survive.\n'
    mkdirSync(join(repo, 'docs/platform'), { recursive: true })
    writeFileSync(join(repo, 'docs/platform/epic-12-provider.md'), source)
    const board = join(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    const comment = 'comment without an epic '.repeat(20).trim()
    writeFileSync(board, readFileSync(board, 'utf8') + `  epic-12: in-progress # delegated docs/platform/epic-12-provider.md\n  12-1-keep: review\n  epic-99: backlog # ${comment}\n`)
    const stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage, keepBmad: true })
    expect(manifest.keep_bmad).toBe(true)
    expect(readFileSync(join(stage, 'epics/012-provider.md'), 'utf8')).toContain(source)
    expect(readFileSync(join(stage, 'history.md'), 'utf8')).toContain(comment)
    expect(readFileSync(join(stage, 'status.yaml'), 'utf8')).toContain('epic-12: in-progress # Suggested lead: Sol 🇺🇸')
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
  })
  it('maps every D10 status and keeps BMAD bytes with migration identity and plan thresholds (107.4)', () => {
    const { root, repo } = fixture(), board = join(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    const table = { 'ready-for-dev': 'ready', optional: 'backlog', superseded: 'dropped', withdrawn: 'dropped', skipped: 'dropped', deferred: 'paused', complete_with_blocked: 'blocked', blocked: 'blocked' }
    const additions = Object.keys(table).map((status, i) => `  epic-${50 + i}: ${status}`).join('\n') + '\n'
    const original = readFileSync(board, 'utf8') + additions; writeFileSync(board, original)
    const stage = join(root, 'out/plan'), manifest = stagePlan({ repo, stage, keepBmad: true })
    const moved = readFileSync(join(stage, 'status.yaml'), 'utf8')
    expect(moved).toContain('bmad_board: _bmad-output/implementation-artifacts/sprint-status.yaml')
    expect(moved).toContain('moved_from: _bmad-output/implementation-artifacts/sprint-status.yaml')
    expect(moved).toContain('rules_from_run_needs: 1')
    expect(moved).toContain('rules_from_challenges: 1')
    for (const [i, [old, next]] of Object.entries(table).entries()) {
      expect(moved).toMatch(new RegExp(`  epic-${50 + i}: ${next} # .*${old}`))
    }
    expect(readFileSync(board, 'utf8')).toBe(original)
    expect(manifest.retired).toEqual([])
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
  })
  it('rewrites links so the span check can reverse them exactly', () => {
    const exists = (path) => ['_bmad-output/planning-artifacts/reference-context.md', 'apps/x.ts'].includes(path)
    const map = (path) => (path === '_bmad-output/planning-artifacts/reference-context.md' ? 'plan/references/reference-context.md' : null)
    const text = 'a [s](reference-context.md#part) b [c](../../apps/x.ts) c [w](https://example.invalid) d [g](../../apps/gone.ts:3)'
    const result = rewriteLinks(text, '_bmad-output/planning-artifacts/epics.md', 'plan/epics/001-x.md', map, exists)
    expect(result.text).toBe('a [s](../references/reference-context.md#part) b [c](../../apps/x.ts) c [w](https://example.invalid) d [g](../../apps/gone.ts:3)')
    expect(result.rewrites).toHaveLength(1)
    expect(result.unresolved).toEqual([{ file: 'plan/epics/001-x.md', dest: '../../apps/gone.ts:3', broken_in_source: true }])
    expect(reverseRewrites(result.text, result.rewrites)).toBe(text)
  })

  it('segments epics.md into the front matter, extensions and epics, each extension covering the epics after it', () => {
    const { repo } = fixture()
    const { segments } = segmentEpics(readFileSync(join(repo, '_bmad-output/planning-artifacts/epics.md'), 'utf8'))
    expect(segments.map((segment) => segment.kind === 'epic' ? segment.number : segment.kind)).toEqual(['front', 1, 'extension', 2, 3, 'extension', 4])
    expect(segments.filter((segment) => segment.kind === 'extension').map((segment) => segment.covers)).toEqual([[2, 3], [4]])
  })

  it('stages a plan that passes bmn plan check and the span check, keeping every file, and never touches the originals', () => {
    const { root, repo } = fixture()
    const before = execFileSync('sh', ['-c', `cd ${repo} && find . -type f -o -type l | sort | xargs sha256sum 2>/dev/null; find . -type l -exec readlink {} \\;`], { encoding: 'utf8' })
    const stage = join(root, 'out', 'plan')
    const manifest = stagePlan({ repo, stage, date: '2026-10-17', docs: ['docs/architecture.md'] })
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
    const one = readFileSync(join(stage, 'epics/001-first-thing.md'), 'utf8')
    expect(one.split('\n')[0]).toBe('<!-- bmn-plan: bmad-legacy -->')
    expect(one).toContain('[sibling](../references/reference-context.md#part)')
    expect(one).toContain('[code](../../apps/x.ts)')
    expect(readFileSync(join(stage, 'shared/two-together-2-3-2026-10-01.md'), 'utf8')).toContain('[epic 1](../epics/001-first-thing.md#epic-1-first-thing)')
    expect(readFileSync(join(stage, 'epics/002-second.md'), 'utf8')).toContain('[two-together-2-3-2026-10-01](../shared/two-together-2-3-2026-10-01.md)')
    const four = readFileSync(join(stage, 'epics/004-fourth.md'), 'utf8')
    expect(four.split('\n')[0]).toBe('<!-- bmn-plan: bmad-legacy; contracts: docs/epic-4-plan.md -->')
    expect(four).toContain('Four\'s own extension')
    expect(four).toContain('### Story 4.2: Extra on board')
    const status = readFileSync(join(stage, 'status.yaml'), 'utf8')
    expect(status).toContain('format: bmn-plan\nschema_version: 1\n')
    expect(status).toContain('  epic-2: in-progress # board comment moved to the epic\'s Log 2026-10-17\n')
    expect(readFileSync(join(stage, 'epics/002-second.md'), 'utf8')).toContain(`- epic-2 (board comment until 2026-10-17): ${'long comment '.repeat(20).trim()}`)
    expect(status).toContain('  epic-4: paused # parked 2026-10-16 by the owner; BMAD backlog\n')
    expect(status).toContain('  4-1-d: ready # BMAD ready-for-dev\n')
    expect(status).toContain('  3-2-c: dropped # no board row before the move; dropped in the epic text\n')
    expect(status).not.toMatch(/^ {2}epic-1-retrospective/mu)
    expect(status).not.toMatch(/^ {2}epic-\d+: ready\b/mu)
    expect(readFileSync(join(stage, 'history.md'), 'utf8')).toContain('# Delivery order: 1 -> 2 -> 3 -> 4')
    expect(readFileSync(join(stage, 'references/reference-1/shot.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    expect(readlinkSync(join(stage, 'references/context-link.md'))).toBe('reference-context.md')
    expect(readFileSync(join(stage, 'references/reference-context.md'), 'utf8')).toContain('[the plan](../shared/front-matter.md)')
    expect(readFileSync(join(stage, 'references/implementation-artifacts/1-1-story.md'), 'utf8')).toBe('# Story file\n')
    expect(manifest.files.filter((file) => file.to === 'archive-only').map((file) => file.path).sort()).toEqual(['.claude/skills/bmad-help/SKILL.md', '_bmad/bmm/config.yaml'])
    expect(manifest.reconciled.map((entry) => entry.key)).toEqual(['3-2-c', '4-2-extra-on-board'])
    // The foundation (owner 2026-10-17): a vision draft he approves before the switch, and the architecture linked.
    const vision = readFileSync(join(stage, 'VISION.md'), 'utf8')
    expect(vision).toMatch(/^## Principles\n\n1\. .*\*provisional\*/mu)
    expect(vision).toContain('The owner approves it, or replaces it, before the switch;')
    expect(readFileSync(join(stage, 'PLAN.md'), 'utf8')).toMatch(/^## Architecture\n\nProject architecture: \[docs\/architecture\.md\]\(\.\.\/docs\/architecture\.md\)/mu)
    const approved = join(root, 'approved-vision.md')
    writeFileSync(approved, '# x: vision\n\n## Vision\n\nApproved.\n\n## Principles\n\n1. **One.** (owner, 2026-10-17)\n')
    const again = join(root, 'again', 'plan')
    stagePlan({ repo, stage: again, date: '2026-10-17', docs: ['docs/architecture.md'], vision: approved })
    expect(readFileSync(join(again, 'VISION.md'), 'utf8')).toBe(readFileSync(approved, 'utf8'))
    execFileSync('git', ['init', '-q', join(root, 'out')])
    const check = spawnSync(process.execPath, [BMN, 'plan', 'check'], { cwd: join(root, 'out'), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } })
    expect(check.stdout).toContain('PASS')
    const after = execFileSync('sh', ['-c', `cd ${repo} && find . -type f -o -type l | sort | xargs sha256sum 2>/dev/null; find . -type l -exec readlink {} \\;`], { encoding: 'utf8' })
    expect(after).toBe(before)
  })

  it('lands every link on its heading, sends gone targets to one note, keeps short notes, and checks every source (Sol review F4, F5, F6, F9)', () => {
    const { root, repo } = fixture()
    const epics = join(repo, '_bmad-output/planning-artifacts/epics.md')
    writeFileSync(epics, readFileSync(epics, 'utf8')
      .replace('Shared by epics 2 and 3; see [epic 1](epics.md#epic-1-first-thing).', 'Shared by epics 2 and 3; see [epic 1](epics.md#epic-1-first-thing), [its story](epics.md#story-11-do-it), [no such](epics.md#no-such-heading) and [below](#story-21-a).')
      .replace('Delegated: the canonical contract is \\`docs/epic-4-plan.md\\`.', '**Canonical requirements:** [the contract](../../docs/epic-4-plan.md).')
      .replace('### Story 1.1: Do It', `Absolute: [context](${repo}/_bmad-output/planning-artifacts/reference-context.md#part), [help](../../.claude/skills/bmad-help/SKILL.md), [config](${repo}/_bmad/bmm/config.yaml).\n\n### Story 1.1: Do It`))
    const board = join(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    writeFileSync(board, readFileSync(board, 'utf8').replace('  3-1-b: done\n', '  3-1-b: done\n  3-3-e: backlog # waits for the phone check\n'))
    const second = readFileSync(epics, 'utf8').split('\n').indexOf('## Epic 2: Second') + 2
    mkdirSync(join(repo, '_bmad-output/planning-artifacts/reviews'))
    writeFileSync(join(repo, '_bmad-output/planning-artifacts/reviews/r.md'), `# Review\n\nSee [the line](../epics.md:${second}).\n`)
    writeFileSync(join(repo, '_bmad-output/implementation-artifacts/audit.md'), '# Audit\n\nIn [x](../apps/x.ts).\n')
    const approved = join(root, 'approved-vision.md')
    writeFileSync(approved, '# x: vision\n\n## Vision\n\nOne workspace where the owner gives commands.\n\n## Principles\n\n1. **One.** (owner, 2026-10-17)\n')
    const stage = join(root, 'out', 'plan')
    const kept = join(root, 'kept')
    const manifest = stagePlan({ repo, stage, date: '2026-10-17', docs: ['docs/architecture.md'], vision: approved, archive: kept })
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
    const first = readFileSync(join(stage, 'epics/001-first-thing.md'), 'utf8')
    expect(first).toContain(`[context](${repo}/plan/references/reference-context.md#part)`)
    expect(first).toContain(`[help](${kept}/files/.claude/skills/bmad-help/SKILL.md)`)
    expect(first).toContain(`[config](${kept}/files/_bmad/bmm/config.yaml)`)
    expect(archive({ repo, manifest, folder: kept })).toEqual([])
    expect(checkLinks({ repo, stage, manifest })).toEqual([])
    // A link left pointing into a retired root fails, though the original is still there.
    const epicOne = join(stage, 'epics/001-first-thing.md')
    writeFileSync(epicOne, `${first}\n[left](${repo}/_bmad-output/planning-artifacts/epics.md) and [also](../../_bmad/bmm/config.yaml)\n`)
    expect(checkLinks({ repo, stage, manifest })).toEqual([
      `plan/epics/001-first-thing.md: link ${repo}/_bmad-output/planning-artifacts/epics.md points into _bmad-output, which leaves at the switch`,
      'plan/epics/001-first-thing.md: link ../../_bmad/bmm/config.yaml points into _bmad, which leaves at the switch'
    ])
    writeFileSync(epicOne, first)
    const shared = readFileSync(join(stage, 'shared/two-together-2-3-2026-10-01.md'), 'utf8')
    expect(shared).toContain('[its story](../epics/001-first-thing.md#story-11-do-it)')
    expect(shared).toContain('[no such](front-matter.md)')
    expect(shared).toContain('[below](../epics/002-second.md#story-21-a)')
    expect(readFileSync(join(stage, 'epics/001-first-thing.md'), 'utf8')).toContain('[gone](../references/gone-link-targets.md#appsdeletedts12)')
    const goneNote = readFileSync(join(stage, 'references/gone-link-targets.md'), 'utf8')
    expect(goneNote).toContain('## apps/deleted.ts:12')
    expect(goneNote).toContain('`_bmad-output/planning-artifacts/epics.md#no-such-heading`')
    expect(readFileSync(join(stage, 'references/reviews/r.md'), 'utf8')).toContain('[the line](../../epics/002-second.md)')
    expect(goneNote).toContain('## _bmad-output/apps/x.ts\n\nNot found in this repository\'s history. The repository has `apps/x.ts`; the link was likely meant for it.')
    expect(manifest.unresolved).toEqual([])
    expect(readFileSync(join(stage, 'epics/004-fourth.md'), 'utf8').split('\n')[0]).toBe('<!-- bmn-plan: bmad-legacy; contracts: docs/epic-4-plan.md -->')
    const plan = readFileSync(join(stage, 'PLAN.md'), 'utf8')
    expect(plan).toMatch(/^## Purpose\n\nOne workspace where the owner gives commands\.\n\nThe principles every epic serves are in \[VISION\.md\]\(VISION\.md\)\. The plan holds epics 1–4: 2 finished/mu)
    expect(plan).not.toContain('A synthetic product for the move')
    expect(plan).not.toContain('_bmad-output')
    expect(readFileSync(join(stage, 'status.yaml'), 'utf8')).toContain('  3-3-e: dropped # deferred when epic 3 was accepted; waits for the phone check\n')
    // The span check fails on a dropped short note and on a source the manifest does not list.
    const status = join(stage, 'status.yaml')
    const staged = readFileSync(status, 'utf8')
    writeFileSync(status, staged.replace(' # deferred when epic 3 was accepted; waits for the phone check', ''))
    expect(checkSpans({ repo, stage, manifest })).toEqual(expect.arrayContaining([
      '3-3-e\'s note in status.yaml is not the one the move wrote',
      expect.stringMatching(/comment of 3-3-e is in neither its note nor status\.yaml$/u)
    ]))
    writeFileSync(status, staged)
    writeFileSync(join(repo, '_bmad-output/planning-artifacts/late-note.md'), '# Written after staging\n')
    expect(checkSpans({ repo, stage, manifest })).toEqual(['_bmad-output/planning-artifacts/late-note.md is not in the manifest (new since staging): stage again'])
  })

  it('an archive link names a plain file of the archive, through no link, and a heading of it, before and after archiving (Sol F5 rechecks)', () => {
    const { root, repo } = fixture()
    writeFileSync(join(repo, '.claude/skills/bmad-help/SKILL.md'), '---\nname: bmad-help\n---\n\n## Use\n\nHow.\n\n## Привіт\n\nHello.\n')
    mkdirSync(join(repo, '_bmad/bmm/child'))
    writeFileSync(join(repo, '_bmad/SKILL.md'), '# Outside\n')
    symlinkSync('SKILL.md', join(repo, '.claude/skills/bmad-help/inside.md'))
    symlinkSync(join(repo, '_bmad/bmm/notes.md'), join(repo, '.claude/skills/bmad-help/escape.md'))
    symlinkSync(join(repo, '_bmad/bmm/child'), join(repo, '.claude/skills/bmad-help/alias'))
    const encoded = encodeURIComponent('привіт')
    const epics = join(repo, '_bmad-output/planning-artifacts/epics.md')
    writeFileSync(epics, readFileSync(epics, 'utf8').replace('### Story 1.1: Do It', `Archive: [use](../../.claude/skills/bmad-help/SKILL.md#use), [no heading](../../.claude/skills/bmad-help/SKILL.md#no-such-heading), [hello](../../.claude/skills/bmad-help/SKILL.md#${encoded}).\n\n### Story 1.1: Do It`))
    const stage = join(root, 'out', 'plan')
    const kept = join(root, 'kept')
    const manifest = stagePlan({ repo, stage, date: '2026-10-17', docs: ['docs/architecture.md'], archive: kept })
    expect(checkSpans({ repo, stage, manifest })).toEqual([])
    const epicOne = join(stage, 'epics/001-first-thing.md')
    const first = readFileSync(epicOne, 'utf8')
    const help = `${kept}/files/.claude/skills/bmad-help`
    expect(first).toContain(`[use](${help}/SKILL.md#use), [no heading](${help}/SKILL.md), [hello](${help}/SKILL.md#${encoded})`)
    expect(manifest.gone).toContainEqual(expect.objectContaining({ kind: 'anchor', target: '.claude/skills/bmad-help/SKILL.md', anchor: 'no-such-heading' }))
    expect(manifest.gone).not.toContainEqual(expect.objectContaining({ anchor: encoded }))
    const bad = `\n[inside](${help}/inside.md#use), [escape](${help}/escape.md), [chain](${help}/alias/../SKILL.md), [through](${help}/alias/x.md) and [nope](${help}/SKILL.md#nope)\n`
    const refused = [
      `plan/epics/001-first-thing.md: link ${help}/inside.md#use passes through a link`,
      `plan/epics/001-first-thing.md: link ${help}/escape.md passes through a link`,
      `plan/epics/001-first-thing.md: link ${help}/alias/../SKILL.md is not a plain path into the archive`,
      `plan/epics/001-first-thing.md: link ${help}/alias/x.md passes through a link`,
      `plan/epics/001-first-thing.md: link ${help}/SKILL.md#nope names no heading of .claude/skills/bmad-help/SKILL.md`
    ]
    writeFileSync(epicOne, `${first}${bad}`)
    expect(checkLinks({ repo, stage, manifest })).toEqual(refused)
    writeFileSync(epicOne, first)
    expect(archive({ repo, manifest, folder: kept })).toEqual([])
    expect(checkLinks({ repo, stage, manifest })).toEqual([])
    writeFileSync(epicOne, `${first}${bad}`)
    expect(checkLinks({ repo, stage, manifest })).toEqual(refused)
  })

  it('archives byte-identical originals, verifies them and rehearses the rollback on a copy', () => {
    const { root, repo } = fixture()
    const stage = join(root, 'out', 'plan')
    const manifest = stagePlan({ repo, stage, date: '2026-10-17', docs: [] })
    const folder = join(root, 'archive')
    expect(archive({ repo, manifest, folder })).toEqual([])
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toContain('## Restore')
    expect(readFileSync(join(folder, 'SHA256SUMS'), 'utf8')).toContain('_bmad-output/planning-artifacts/epics.md')
    expect(rehearseRollback({ manifest, folder, scratch: join(root, 'restored') })).toEqual([])
    writeFileSync(join(root, 'restored/_bmad-output/planning-artifacts/epics.md'), 'tampered')
    expect(verifyTree({ root: join(root, 'restored'), manifest })).toEqual(['_bmad-output/planning-artifacts/epics.md: differs'])
  })

  it('refuses to stage or archive over a folder that is not empty, and a changed source fails the span check', () => {
    const { root, repo } = fixture()
    const stage = join(root, 'out', 'plan')
    const manifest = stagePlan({ repo, stage, date: '2026-10-17', docs: [] })
    expect(() => stagePlan({ repo, stage, date: '2026-10-17', docs: [] })).toThrow(/not empty/u)
    mkdirSync(join(root, 'archive')); writeFileSync(join(root, 'archive/x'), 'x')
    expect(() => archive({ repo, manifest, folder: join(root, 'archive') })).toThrow(/not empty/u)
    writeFileSync(join(repo, '_bmad-output/planning-artifacts/reference-context.md'), '# changed\n')
    expect(checkSpans({ repo, stage, manifest })).toContain('_bmad-output/planning-artifacts/reference-context.md changed since the manifest')
    const rerun = join(root, 'again', 'plan')
    expect(checkSpans({ repo, stage: rerun, manifest: stagePlan({ repo, stage: rerun, date: '2026-10-17', docs: [] }) })).toEqual([])
    expect(existsSync(join(rerun, 'status.yaml'))).toBe(true)
  })
})
