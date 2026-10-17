// MODULE: migrate-bmad-plan.test.mjs - Story 77.6: the BMAD-to-plan move on a synthetic BMAD project: shared sections, links, long comments, a park, binaries, a rerun and a collision
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archive, checkSpans, rehearseRollback, reverseRewrites, rewriteLinks, segmentEpics, stagePlan, verifyTree } from '../plan/migrate-bmad-plan.mjs'

const BMN = resolve(import.meta.dirname, '../../apps/desktop/bin/bmn')
const roots = []
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
  file('_bmad-output/planning-artifacts/reference-context.md', '# Context\n\nBack to [the plan](epics.md) and [docs](../../docs/architecture.md).\n')
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
    expect(readFileSync(join(stage, 'shared/two-together-2-3-2026-10-01.md'), 'utf8')).toContain('[epic 1](../epics/001-first-thing.md)')
    expect(readFileSync(join(stage, 'epics/002-second.md'), 'utf8')).toContain('[two-together-2-3-2026-10-01](../shared/two-together-2-3-2026-10-01.md)')
    const four = readFileSync(join(stage, 'epics/004-fourth.md'), 'utf8')
    expect(four.split('\n')[0]).toBe('<!-- bmn-plan: bmad-legacy; contracts: docs/epic-4-plan.md -->')
    expect(four).toContain('Four\'s own extension')
    expect(four).toContain('### Story 4.2: Extra on board')
    const status = readFileSync(join(stage, 'status.yaml'), 'utf8')
    expect(status).toContain('format: bmn-plan\nschema_version: 1\n')
    expect(status).toContain('  epic-2: in-progress # board comment moved to the epic\'s Log 2026-10-17\n')
    expect(readFileSync(join(stage, 'epics/002-second.md'), 'utf8')).toContain(`- epic-2 (board comment until 2026-10-17): ${'long comment '.repeat(20).trim()}`)
    expect(status).toContain('  epic-4: paused # parked 2026-10-16 by the owner\n')
    expect(status).toContain('  4-1-d: backlog\n')
    expect(status).toContain('  3-2-c: dropped # no board row before the move; dropped in the epic text\n')
    expect(status).not.toMatch(/^ {2}epic-1-retrospective/mu)
    expect(status).not.toMatch(/: ready\b/u)
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
    expect(vision).toContain('The owner approves it, or replaces it, before the switch (Story 77.7)')
    expect(readFileSync(join(stage, 'PLAN.md'), 'utf8')).toMatch(/^## Architecture\n\nThe architecture as built: \[docs\/architecture\.md\]\(\.\.\/docs\/architecture\.md\)/mu)
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
