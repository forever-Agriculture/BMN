// MODULE: prepare-move-branch.mjs - Epic 108 cut a move commit directly on the current default branch, in an isolated publish clone
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { checkPlan } from '../../apps/desktop/bin/plan-board.mjs'
import { archive, checkSpans, stagePlan } from './migrate-bmad-plan.mjs'
import { extractPlan, mergeStagedPlan, planFingerprint, publishedInputs, reconcilePlan, saveJournal, staysLocal } from './plan-cutover.mjs'

function git(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { maxBuffer: 512 * 1024 * 1024, ...options })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`git ${args[0]} failed: ${result.stderr?.toString().slice(0, 400)}`)
  return options.allowFailure ? result : result.stdout
}
const text = (repo, args) => git(repo, args).toString().trim()
const loadJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** An old URL keeps opening: where its record went, and its headings. Original bytes stay in the plan or in history. */
export function forwardingStub(path, original, target) {
  const relative = to => posix.relative(posix.dirname(path), to)
  const headings = []; let fenced = false
  for (const line of original.split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced
    if (!fenced && /^#{1,6} /u.test(line) && !line.startsWith('# MODULE:') && !line.includes('_bmad')) headings.push(line)
  }
  return `The preserved record is [in the plan](${relative(target)}). The [canonical board](${relative('plan/status.yaml')}) and [plan guide](${relative('plan/PLAN.md')}) hold current work.\n\n${headings.join('\n\n')}\n`
}
const STUB = 'The preserved record is'
const isStub = (repo, commit, path) => { const read = git(repo, ['show', `${commit}:${path}`], { allowFailure: true }); return read.status === 0 && read.stdout.toString().startsWith(STUB) }
const retiredRoot = path => path === '_bmad' || path === '_bmad-output' || /^(?:_bmad|_bmad-output)\//u.test(path) || /^\.[^/]+\/skills\/bmad-/u.test(path)
const platformEpic = path => /^docs\/platform\/(?:.*\/)?epic-\d+[-.].*\.md$/u.test(path)

/**
 * The move's first parent is the upstream tip it was cut from, which is what the approval reader pins as the boundary.
 * A previous cut supplies the plan's hand edits and the product-side cleanup; nothing is pushed here.
 */
export async function prepareMoveBranch({ repo, publish, upstream, branch, previous = null, date = new Date().toISOString().slice(0, 10), vision = null, keepBmad = false, copyOwners = {}, historicalWorktrees = [], localOnly = [], output, message }) {
  const head = text(publish, ['rev-parse', upstream])
  if (git(repo, ['cat-file', '-e', `${head}^{commit}`], { allowFailure: true }).status !== 0) return { outcome: 'parked', code: 'UPSTREAM_UNKNOWN', reason: `fetch ${head} into the source repository first` }
  const stagedDate = previous?.date ?? date
  const capture = await reconcilePlan({ repo, upstream: head, upstreamInHistory: true, historicalWorktrees, output: join(output, 'capture') })
  const generated = join(output, 'generated', 'plan')
  const manifest = stagePlan({ repo: capture.projection, contextRepo: repo, stage: generated, keepBmad, copyOwners, vision, date: stagedDate, historyHead: head, archive: join(output, 'archive') })
  if (manifest.copy && Object.keys(manifest.copy.unresolved).length) return { outcome: 'parked', code: 'COPY_PROVENANCE_REQUIRED', rows: Object.keys(manifest.copy.unresolved) }
  const archiveFailures = archive({ repo: capture.projection, manifest, folder: manifest.archive })
  if (archiveFailures.length) return { outcome: 'parked', code: 'ARCHIVE_INVALID', failures: archiveFailures }
  const spans = checkSpans({ repo: capture.projection, stage: generated, manifest })
  if (spans.length) return { outcome: 'parked', code: 'STAGE_INVALID', failures: spans }
  let stage = generated, merged = null
  if (previous) {
    const base = join(output, 'previous-generated', 'plan')
    stagePlan({ repo: previous.projection, contextRepo: repo, stage: base, keepBmad, vision, date: stagedDate, historyHead: head, archive: join(output, 'previous-archive') })
    const theirs = extractPlan(publish, previous.head, join(output, 'previous-plan'))
    stage = join(output, 'merged', 'plan')
    merged = mergeStagedPlan({ base, ours: generated, theirs, output: stage, date: stagedDate, localOnly, keep: join(output, 'local-only') })
  } else {
    const patterns = localOnly.map(source => new RegExp(source, 'u'))
    for (const path of manifest.files.map(file => file.to).filter(Boolean)) if (patterns.some(pattern => pattern.test(path))) rmSync(join(stage, path), { force: true })
  }
  const moved = join(stage, 'references', 'moved', stagedDate); mkdirSync(join(moved, 'conflicts'), { recursive: true })
  capture.conflicts.forEach((conflict, index) => { if (!staysLocal(conflict.path, manifest.files, localOnly)) cpSync(conflict.kept, join(moved, 'conflicts', `conflict-${index + 1}.local`)) })
  writeFileSync(join(moved, 'inputs.json'), JSON.stringify(publishedInputs(capture), null, 2) + '\n')
  writeFileSync(join(moved, 'settled-conflicts.json'), JSON.stringify({ capture: capture.settled_conflicts.map(({ path, key, local, upstream: value, settled }) => ({ path, key, local, upstream: value, settled })), plan: merged?.settled_conflicts ?? [], plan_conflicts: merged?.conflicts ?? [], local_only: (merged?.local_only ?? []).map(({ path, sha256, reason }) => ({ path, sha256, reason })) }, null, 2) + '\n')
  const metadataPath = join(stage, 'migration.json'), metadata = loadJson(metadataPath)
  saveJournal(metadataPath, { ...metadata, history_head: head, baseline_fingerprint: planFingerprint(capture.projection), approval_conflicts: [...new Set([...capture.approval_conflicts, ...(merged?.approval_conflicts ?? [])])].sort((a, b) => a - b), approval_conflict_values: [...capture.approval_conflict_values, ...(merged?.approval_conflict_values ?? [])] })
  const checked = await checkPlan({ productRoot: publish, planRoot: stage, boardPath: join(stage, 'status.yaml'), format: 'bmn-plan' })
  if (checked.findings.length) return { outcome: 'parked', code: 'STAGE_INVALID', failures: checked.findings.map(finding => finding.reason) }

  const index = join(output, 'move.index'), env = { ...process.env, GIT_INDEX_FILE: index }, gitDir = text(publish, ['rev-parse', '--absolute-git-dir'])
  try {
    let unmerged = []
    if (previous) {
      const combined = git(publish, ['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', previous.head, head], { allowFailure: true })
      if (combined.status > 1) throw new Error('the product trees cannot be merged')
      const [tree, ...conflicted] = combined.stdout.toString().split('\0').filter(Boolean)
      git(publish, ['read-tree', tree], { env })
      unmerged = conflicted
      const stubbed = new Set(conflicted.filter(path => isStub(publish, previous.head, path)))
      const blocking = conflicted.filter(path => !retiredRoot(path) && !platformEpic(path) && !stubbed.has(path))
      if (blocking.length) return { outcome: 'parked', code: 'MOVE_PRODUCT_CONFLICT', paths: blocking }
      for (const path of stubbed) {
        // The branch forwards this document; upstream's newer full text moves to its preserved record.
        const record = join(stage, 'references', 'history', path); mkdirSync(dirname(record), { recursive: true })
        writeFileSync(record, git(publish, ['show', `${head}:${path}`]))
        const oid = git(publish, ['rev-parse', `${previous.head}:${path}`]).toString().trim()
        git(publish, ['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], { env })
      }
    } else git(publish, ['read-tree', head], { env })
    const tracked = git(publish, ['ls-files', '-z'], { env }).toString().split('\0').filter(Boolean)
    if (!keepBmad) {
      const retired = tracked.filter(retiredRoot)
      if (retired.length) git(publish, ['update-index', '--force-remove', '-z', '--stdin'], { env, input: retired.join('\0') + '\0' })
    }
    const placed = new Map((manifest.spans ?? []).map(span => [span.source, span.to]))
    for (const path of keepBmad ? [] : tracked.filter(platformEpic)) {
      const current = git(publish, ['show', `${head}:${path}`], { allowFailure: true })
      // A stub already on the branch stays; an upstream edit of a retired document is captured and needs no second copy here.
      const bytes = previous && isStub(publish, previous.head, path) ? git(publish, ['show', `${previous.head}:${path}`]).toString()
        : forwardingStub(path, current.status === 0 ? current.stdout.toString() : '', placed.get(path) ? `plan/${placed.get(path)}` : 'plan/PLAN.md')
      const oid = git(publish, ['hash-object', '-w', '--stdin'], { input: bytes }).toString().trim()
      git(publish, ['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], { env })
    }
    git(dirname(stage), ['add', '--sparse', '--all', '--', 'plan'], { env: { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: dirname(stage) } })
    const tree = git(publish, ['write-tree'], { env }).toString().trim()
    const commit = text(publish, ['commit-tree', tree, '-p', head, '-m', message])
    git(publish, ['branch', branch, commit])
    return { outcome: 'cut', commit, branch, upstream: head, unmerged_resolved: unmerged, baseline: { projection: capture.projection, fingerprint: planFingerprint(capture.projection), date: stagedDate }, approval_conflicts: loadJson(metadataPath).approval_conflicts, conflicts: capture.conflicts.length, settled: capture.settled_conflicts.length, plan_conflicts: merged?.conflicts ?? [], local_only: merged?.local_only?.map(({ path, reason }) => ({ path, reason })) ?? [], stage }
  } finally { rmSync(index, { force: true }) }
}
