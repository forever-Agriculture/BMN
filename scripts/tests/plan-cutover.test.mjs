// MODULE: plan-cutover.test.mjs - Epic 107 real Git reconciliation, fencing, interruption and rollback
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyFence, cutoverPlan, fenceInventory, mergeStagedPlan, migrationPaths, planFingerprint as planFingerprintOf, reconcilePlan, rollbackPlan, saveJournal, startWatchdog, withMigrationWriter } from '../plan/plan-cutover.mjs'
import { stagePlan } from '../plan/migrate-bmad-plan.mjs'
import { prepareMoveBranch } from '../plan/prepare-move-branch.mjs'
import { resolvePlan, rowToken } from '../../apps/desktop/bin/plan-board.mjs'
import { publicationState } from '../../apps/desktop/bin/plan-publish.mjs'
import { setWithCopy } from '../../apps/desktop/bin/plan-bmad-copy.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', ...args], { encoding: 'utf8' }).trim()
function resource(identity) { if (process.env.BMN_CUTOVER_RESOURCE_LOG) appendFileSync(process.env.BMN_CUTOVER_RESOURCE_LOG, JSON.stringify(identity) + '\n') }
const move = options => cutoverPlan({ ...options, seam: async (phase, state) => {
  if (phase === 'lease-held') resource({ kind: 'process', ...state.watchdog, command: 'Epic107 switch test watchdog' })
  await options.seam?.(phase, state)
} })
function file(repo, path, text) { const full = join(repo, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, text); return full }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-cutover-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'f@example.invalid')
  file(repo, 'product.txt', 'original product\n')
  file(repo, '_bmad-output/planning-artifacts/epics.md', '# Epics\n\n## Epic 7: Probe\n\n### Story 7.1: One\n')
  file(repo, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  epic-7: in-progress\n  7-1-one: backlog\n')
  file(repo, '_bmad-output/planning-artifacts/note.md', 'first\nmiddle\nlast\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); git(repo, 'branch', 'upstream')
  return { root, repo }
}
const handover = repo => ({ inventory_verified: true, worktrees: [repo], writers: [] })

async function killAt(repo, phase, chmodIndex = null, action = 'cutover', options = { upstream: 'upstream' }) {
  const module = new URL('../plan/plan-cutover.mjs', import.meta.url).href
  const code = `import {cutoverPlan,rollbackPlan} from ${JSON.stringify(module)};
import{readFileSync}from'node:fs';
await ${action === 'cutover' ? 'cutoverPlan' : 'rollbackPlan'}({...${JSON.stringify(options)},repo:${JSON.stringify(repo)},handover:${JSON.stringify(handover(repo))},seam:async(phase,state)=>{
if(phase!==${JSON.stringify(phase)}||(${JSON.stringify(chmodIndex)}!==null&&state.chmod_index!==${JSON.stringify(chmodIndex)}))return;
const stat=readFileSync('/proc/'+process.pid+'/stat','utf8');
console.log(JSON.stringify({pid:process.pid,start_ticks:stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19],watchdog:state.watchdog}));
await new Promise(()=>setInterval(()=>{},1000));}});`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  const identity = await new Promise((resolve, reject) => {
    let output = '', error = ''
    child.stderr.on('data', bytes => { error += bytes.toString() })
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])) })
    child.once('exit', () => reject(new Error('lead exited before ' + phase + ': ' + error)))
  })
  resource({ kind: 'process', pid: identity.pid, start_ticks: identity.start_ticks, command: `Epic107 crash matrix lead at ${phase}` })
  resource({ kind: 'process', ...identity.watchdog, command: `Epic107 crash matrix watchdog at ${phase}` })
  const exited = once(child, 'exit')
  execFileSync('python3', ['-c', "import os,sys,signal; from pathlib import Path; pid=int(sys.argv[1]); fd=os.pidfd_open(pid); observed=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]; assert observed==sys.argv[2]; signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd)", String(identity.pid), identity.start_ticks])
  await exited
}

describe('D15 cutover', () => {
  it('refuses rollback over a later edit to the same BMAD row and retains both plans', async () => {
    for (const keepBmad of [false, true]) {
      const f = fixture(), target = '_bmad-output/implementation-artifacts/sprint-status.yaml'
      await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo), keepBmad })
      file(f.repo, target, readFileSync(join(f.repo, target), 'utf8').replace('7-1-one: backlog', '7-1-one: review # Artem later edit'))
      const canonical = readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8').replace('7-1-one: backlog', '7-1-one: paused # owner parked')
      if (keepBmad) {
        const result = await setWithCopy(await resolvePlan(f.repo), { key: '7-1-one', status: 'paused', note: 'owner parked', expect: rowToken('7-1-one', 'backlog', '') })
        expect(result.copy.outcome).toBe('COPY_CONFLICT')
      } else file(f.repo, 'plan/status.yaml', canonical)
      const original = readFileSync(join(f.repo, target)), head = git(f.repo, 'rev-parse', 'HEAD')
      await expect(rollbackPlan({ repo: f.repo, handover: handover(f.repo) })).rejects.toThrow('ROLLBACK_COPY_CONFLICT')
      expect(readFileSync(join(f.repo, target))).toEqual(original)
      expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toBe(canonical)
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    }
  })
  it.each([null, 'archived'])('materializes retired-file links before switching, including recovery at %s', async phase => {
    const f = fixture(), source = '_bmad/bmm/contract.md', bytes = '# Contract\n\nKeep these exact bytes.\n'
    file(f.repo, source, bytes)
    file(f.repo, '_bmad-output/planning-artifacts/note.md', '[contract](../../_bmad/bmm/contract.md#contract)\n')
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'linked contract'); git(f.repo, 'branch', '-f', 'upstream')
    if (phase) await killAt(f.repo, phase)
    expect((await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo) })).outcome).toBe('moved')
    const note = readFileSync(join(f.repo, 'plan/references/note.md'), 'utf8')
    const destination = /\[contract\]\(([^)#]+)#contract\)/u.exec(note)[1]
    expect(readFileSync(destination, 'utf8')).toBe(bytes)
  })
  it('uses the repository default master when the CLI omits upstream', () => {
    const f = fixture(), remote = join(f.root, 'remote.git')
    git(f.repo, 'branch', '-m', 'master'); git(f.repo, 'clone', '--bare', f.repo, remote)
    git(f.repo, 'remote', 'add', 'origin', remote); git(f.repo, 'fetch', '-q', 'origin'); git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master')
    const inventory = file(f.root, 'handover.json', JSON.stringify(handover(f.repo)))
    const result = execFileSync(process.execPath, [new URL('../plan/migrate-bmad-plan.mjs', import.meta.url).pathname, 'cutover', '--repo', f.repo, '--handover', inventory], { encoding: 'utf8', stdio: 'pipe' })
    expect(JSON.parse(result).outcome).toBe('moved')
    expect(git(f.repo, 'branch', '--show-current')).toBe('master')
    const rolledBack = execFileSync(process.execPath, [new URL('../plan/migrate-bmad-plan.mjs', import.meta.url).pathname, 'rollback', '--repo', f.repo, '--handover', inventory], { encoding: 'utf8', stdio: 'pipe' })
    expect(JSON.parse(rolledBack).outcome).toBe('rolled-back')
  })
  it('parks a switch requested outside the canonical default checkout', async () => {
    const f = fixture(), remote = join(f.root, 'remote.git'), old = join(f.root, 'old')
    git(f.repo, 'clone', '--bare', f.repo, remote); git(f.repo, 'remote', 'add', 'origin', remote); git(f.repo, 'fetch', '-q', 'origin')
    git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'); git(f.repo, 'worktree', 'add', '-qb', 'old', old)
    const before = git(f.repo, 'rev-parse', 'HEAD'), result = await move({ repo: old, upstream: 'origin/main', handover: { inventory_verified: true, worktrees: [f.repo, old], writers: [] } })
    expect(result).toMatchObject({ outcome: 'parked', code: 'NOT_DEFAULT_CHECKOUT' })
    expect(git(old, 'rev-parse', 'HEAD')).toBe(before); expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(existsSync(join(old, 'plan'))).toBe(false)
  })
  it('moves into a plan excluded by sparse checkout without changing the sparse definition or product bytes', async () => {
    const f = fixture()
    git(f.repo, 'sparse-checkout', 'set', '_bmad-output')
    const definition = readFileSync(join(f.repo, '.git/info/sparse-checkout'))
    expect((await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo) })).outcome).toBe('moved')
    expect((await resolvePlan(f.repo)).format).toBe('bmn-plan')
    expect(readFileSync(join(f.repo, '.git/info/sparse-checkout'))).toEqual(definition)
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('original product\n')
  })
  it.each([true, false])('preserves the fence when a watchdog dies while its migration owner is still alive (stale lease %s)', async staleLease => {
    const f = fixture(), paths = migrationPaths(f.repo), target = join(f.repo, '_bmad-output/planning-artifacts/note.md')
    const stat = statSync(target), raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8'), ticks = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/u)[19]
    saveJournal(paths.journal, { version: 1, phase: 'fenced', fenced: true, owner: { pid: process.pid, start_ticks: ticks }, fence: [{ path: target, device: String(stat.dev), inode: String(stat.ino), mode: stat.mode & 0o777 }] })
    if (staleLease) writeFileSync(paths.lock, JSON.stringify({ pid: 0, start_ticks: 'missing', nonce: 'dead-watchdog' }))
    chmodSync(target, stat.mode & ~0o222)
    let watchdog
    try {
      let error
      try { watchdog = await startWatchdog(f.repo) } catch (caught) { error = caught }
      expect(error?.message).toContain('RECOVERY_OWNER_ALIVE')
      expect(statSync(target).mode & 0o222).toBe(0)
      expect(JSON.parse(readFileSync(paths.journal, 'utf8')).fenced).toBe(true)
    } finally {
      if (watchdog) await watchdog.release()
      chmodSync(target, stat.mode)
    }
  })
  it('captures a pinned historical worktree separately, preserving its index, history and every planning image (108 D24)', async () => {
    const f = fixture(), linked = join(f.root, 'historical'), note = '_bmad-output/planning-artifacts/note.md'
    const orphan = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated historical root')
    git(f.repo, 'worktree', 'add', '-qb', 'historical', linked, orphan)
    file(linked, note, 'historical committed\n'); git(linked, 'add', note); git(linked, 'commit', '-qm', 'historical note')
    const head = git(linked, 'rev-parse', 'HEAD')
    file(linked, note, 'historical staged\n'); git(linked, 'add', note)
    file(linked, note, 'historical working\n'); file(linked, '_bmad-output/local-only.md', 'untracked history\n')
    const indexFile = git(linked, 'rev-parse', '--git-path', 'index'), index = readFileSync(indexFile)
    const registration = git(f.repo, 'worktree', 'list', '--porcelain')
    const capture = await reconcilePlan({ repo: f.repo, upstream: 'upstream', output: join(f.root, 'capture'), historicalWorktrees: [{ root: linked, head, evidence: 'Synthetic owner historical-archive approval' }] })
    expect(readFileSync(join(capture.projection, note), 'utf8')).toBe('first\nmiddle\nlast\n')
    expect(existsSync(join(capture.projection, '_bmad-output/local-only.md'))).toBe(false)
    const historical = capture.historical_worktrees[0]
    expect(historical).toMatchObject({ root: linked, head, base: null, evidence: 'Synthetic owner historical-archive approval' })
    expect(readFileSync(historical.index.path)).toEqual(index)
    expect(git(linked, 'bundle', 'verify', historical.bundle.path)).toContain(head)
    const variants = capture.inputs.filter(input => input.historical && input.path === note && input.present)
    expect(variants.map(input => [input.kind, readFileSync(input.object, 'utf8')])).toEqual([
      ['HEAD', 'historical committed\n'], ['index', 'historical staged\n'], ['working', 'historical working\n']
    ])
    expect(readFileSync(capture.inputs.find(input => input.historical && input.path === '_bmad-output/local-only.md' && input.kind === 'working').object, 'utf8')).toBe('untracked history\n')
    expect(readFileSync(indexFile)).toEqual(index)
    expect(git(f.repo, 'worktree', 'list', '--porcelain')).toBe(registration)
    expect(git(linked, 'rev-parse', 'HEAD')).toBe(head)
  })
  it.each(['changed-head', 'canonical', 'canonical-from-linked', 'unregistered'])('refuses a historical declaration whose exact approved scope does not hold (%s)', async shape => {
    const f = fixture(), linked = join(f.root, 'historical')
    const orphan = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated historical root')
    git(f.repo, 'worktree', 'add', '-qb', 'historical', linked, orphan)
    const declared = { root: linked, head: orphan, evidence: 'Synthetic owner historical-archive approval' }
    if (shape === 'changed-head') { file(linked, '_bmad-output/local.md', 'later edit'); git(linked, 'add', '.'); git(linked, 'commit', '-qm', 'after approval') }
    if (shape === 'canonical') { declared.root = f.repo; declared.head = git(f.repo, 'rev-parse', 'HEAD') }
    if (shape === 'canonical-from-linked') { git(f.repo, 'branch', '-f', 'upstream', orphan); declared.root = f.repo; declared.head = git(f.repo, 'rev-parse', 'HEAD') }
    if (shape === 'unregistered') declared.root = f.root
    await expect(reconcilePlan({ repo: shape === 'canonical-from-linked' ? linked : f.repo, upstream: 'upstream', output: join(f.root, 'capture'), historicalWorktrees: [declared] })).rejects.toMatchObject({ code: 'HISTORICAL_SCOPE_CHANGED' })
    expect(existsSync(join(f.repo, 'plan'))).toBe(false)
  })
  it('keeps the historical exception through final capture and rollback without changing the historical checkout', async () => {
    const f = fixture(), linked = join(f.root, 'historical'), note = '_bmad-output/planning-artifacts/note.md'
    const orphan = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated historical root')
    git(f.repo, 'worktree', 'add', '-qb', 'historical', linked, orphan)
    file(linked, note, 'historical value, never canonical\n')
    const indexPath = git(linked, 'rev-parse', '--git-path', 'index'), index = readFileSync(indexPath)
    const inventory = { inventory_verified: true, worktrees: [f.repo, linked], writers: [], historical_worktrees: [{ root: linked, head: orphan, evidence: 'Synthetic owner historical-archive approval' }] }
    const result = await move({ repo: f.repo, upstream: 'upstream', handover: inventory })
    expect(result.outcome).toBe('moved')
    expect(readFileSync(join(f.repo, 'plan/references/note.md'), 'utf8')).toBe('first\nmiddle\nlast\n')
    expect(JSON.parse(readFileSync(join(f.repo, 'plan/references/moved', new Date().toISOString().slice(0, 10), 'inputs.json'), 'utf8')).historical_worktrees).toHaveLength(1)
    expect((await rollbackPlan({ repo: f.repo, handover: inventory })).outcome).toBe('rolled-back')
    expect(git(linked, 'rev-parse', 'HEAD')).toBe(orphan)
    expect(readFileSync(indexPath)).toEqual(index)
    expect(readFileSync(join(linked, note), 'utf8')).toBe('historical value, never canonical\n')
  })
  it.each(['index', 'registration'])('includes historical archive-only changes in its final fingerprint (%s)', async shape => {
    const f = fixture(), linked = join(f.root, 'historical')
    const head = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated historical root')
    git(f.repo, 'worktree', 'add', '-qb', 'historical', linked, head)
    const options = { repo: f.repo, upstream: 'upstream', historicalWorktrees: [{ root: linked, head, evidence: 'Synthetic owner archive approval' }] }
    const first = await reconcilePlan({ ...options, output: join(f.root, 'first') })
    if (shape === 'index') { file(linked, 'product.txt', 'later staged product\n'); git(linked, 'add', 'product.txt') }
    else git(f.repo, 'worktree', 'lock', '--reason', 'owner retains history', linked)
    const next = await reconcilePlan({ ...options, output: join(f.root, 'next') })
    expect(next.fingerprint).not.toBe(first.fingerprint)
  })
  it('archives the shared index beside a split index so its full staged entries remain readable', async () => {
    const f = fixture(), linked = join(f.root, 'historical')
    const head = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated historical root')
    git(f.repo, 'worktree', 'add', '-qb', 'historical', linked, head)
    git(linked, 'update-index', '--split-index')
    file(linked, 'product.txt', 'staged product\n'); git(linked, 'add', 'product.txt')
    const sharedPath = resolve(linked, git(linked, 'rev-parse', '--shared-index-path')), shared = readFileSync(sharedPath)
    const indexPath = git(linked, 'rev-parse', '--git-path', 'index'), index = readFileSync(indexPath), entries = git(linked, 'ls-files', '--stage')
    const capture = await reconcilePlan({ repo: f.repo, upstream: 'upstream', output: join(f.root, 'capture'), historicalWorktrees: [{ root: linked, head, evidence: 'Synthetic owner archive approval' }] })
    const archived = capture.historical_worktrees[0]
    expect(archived.shared_index).toBeTruthy()
    expect(readFileSync(archived.shared_index.path)).toEqual(shared)
    expect(execFileSync('git', ['-C', linked, 'ls-files', '--stage'], { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: archived.index.path } }).trim()).toBe(entries)
    expect(readFileSync(indexPath)).toEqual(index)
    expect(readFileSync(sharedPath)).toEqual(shared)
  })
  it('recaptures a later historical product-index write before recording the cutover archive', async () => {
    const f = fixture(), linked = join(f.root, 'historical')
    const head = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated historical root')
    git(f.repo, 'worktree', 'add', '-qb', 'historical', linked, head)
    const inventory = { inventory_verified: true, worktrees: [f.repo, linked], writers: [], historical_worktrees: [{ root: linked, head, evidence: 'Synthetic owner archive approval' }] }
    let changed = false
    const result = await move({ repo: f.repo, upstream: 'upstream', handover: inventory, seam: async phase => {
      if (phase === 'staged' && !changed) { changed = true; file(linked, 'product.txt', 'later staged product\n'); git(linked, 'add', 'product.txt') }
    } })
    expect(result.outcome).toBe('moved')
    const input = JSON.parse(readFileSync(join(f.repo, 'plan/references/moved', new Date().toISOString().slice(0, 10), 'inputs.json'), 'utf8')).historical_worktrees[0]
    expect(readFileSync(input.index.path)).toEqual(readFileSync(git(linked, 'rev-parse', '--git-path', 'index')))
  })
  it('parks unrelated legacy worktree history without inventing a merge base or changing its files', async () => {
    const f = fixture(), linked = join(f.root, 'legacy-pre-rewrite'), initial = git(f.repo, 'rev-parse', 'HEAD')
    const orphan = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated legacy root')
    git(f.repo, 'worktree', 'add', '-qb', 'legacy', linked, orphan)
    const result = await move({ repo: f.repo, upstream: 'upstream', handover: { inventory_verified: true, worktrees: [f.repo, linked], writers: [] } })
    expect(result).toMatchObject({ outcome: 'parked', code: 'NO_COMMON_PLANNING_BASE' })
    expect(result.reason).toContain(linked)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(initial)
    expect(git(linked, 'rev-parse', 'HEAD')).toBe(orphan)
    expect(readFileSync(join(linked, '_bmad-output/planning-artifacts/note.md'), 'utf8')).toBe('first\nmiddle\nlast\n')
  })
  it('parks a missing registered worktree and unresolved copied-row ownership before fencing', async () => {
    const missing = fixture(), linked = join(missing.root, 'gone')
    git(missing.repo, 'worktree', 'add', '-qb', 'gone', linked); rmSync(linked, { recursive: true })
    const initial = git(missing.repo, 'rev-parse', 'HEAD')
    const parked = await move({ repo: missing.repo, upstream: 'upstream', handover: handover(missing.repo) })
    expect(parked).toMatchObject({ outcome: 'parked', code: 'MISSING_WORKTREE' })
    expect(parked.reason).toContain(linked)
    expect(git(missing.repo, 'rev-parse', 'HEAD')).toBe(initial)
    const f = fixture(), board = join(f.repo, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    writeFileSync(board, readFileSync(board, 'utf8').replace('7-1-one: backlog', '7-1-one: review'))
    const result = await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo), keepBmad: true })
    expect(result).toMatchObject({ outcome: 'parked', code: 'COPY_PROVENANCE_REQUIRED', rows: ['7-1-one'] })
  })
  it('holds only the affected epic when upstream narrows its approved terms during reconciliation', async () => {
    const f = fixture(), epics = '_bmad-output/planning-artifacts/epics.md'
    const original = readFileSync(join(f.repo, epics), 'utf8').replace('### Story 7.1', '### Run needs\n- **Money cap:** $55.\n\n### Story 7.1')
    file(f.repo, epics, original); git(f.repo, 'add', epics); git(f.repo, 'commit', '-qm', 'old terms'); git(f.repo, 'branch', '-f', 'upstream')
    git(f.repo, 'switch', '-q', 'upstream'); file(f.repo, epics, original.replace('$55', '$10')); git(f.repo, 'commit', '-qam', 'narrower upstream terms')
    git(f.repo, 'switch', '-q', 'main')
    await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo) })
    const plan = await resolvePlan(f.repo)
    expect(publicationState(plan).conflicts).toEqual([7])
    expect(publicationState(plan).conflict_values).toContainEqual(expect.objectContaining({ epic: 7, path: epics }))
    expect(JSON.parse(readFileSync(join(f.repo, 'plan/migration.json'), 'utf8')).approval_conflicts).toEqual([7])
  })
  it('recaptures an old-file edit after an interrupted installation', async () => {
    const f = fixture()
    await killAt(f.repo, 'installed')
    const recovery = await startWatchdog(f.repo)
    resource({ kind: 'process', pid: recovery.pid, start_ticks: recovery.start_ticks, command: 'Epic107 interrupted-install recovery watchdog' })
    await recovery.release()
    file(f.repo, '_bmad-output/planning-artifacts/note.md', 'edited after interrupted install\n')
    const result = await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo) })
    expect(result.outcome).toBe('moved')
    expect(readFileSync(join(f.repo, 'plan/references/note.md'), 'utf8')).toBe('edited after interrupted install\n')
  })
  it('exposes an old-branch delete/modify conflict and uses the canonical row after its documented resolution', async () => {
    const f = fixture(), linked = join(f.root, 'old-branch'), oldBoard = '_bmad-output/implementation-artifacts/sprint-status.yaml'
    git(f.repo, 'worktree', 'add', '-qb', 'old-client', linked)
    file(linked, oldBoard, readFileSync(join(linked, oldBoard), 'utf8').replace('7-1-one: backlog', '7-1-one: ready-for-dev # old branch edit'))
    git(linked, 'add', oldBoard); git(linked, 'commit', '-qm', 'old branch planning edit')
    await move({ repo: f.repo, upstream: 'upstream', handover: { inventory_verified: true, worktrees: [f.repo, linked], writers: [] } })
    expect(() => git(linked, 'merge', '--no-edit', 'main')).toThrow()
    expect(git(linked, 'diff', '--name-only', '--diff-filter=U')).toBe(oldBoard)
    expect(readFileSync(join(linked, oldBoard), 'utf8')).toContain('old branch edit')
    expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('old branch edit')
    git(linked, 'rm', '--', oldBoard); git(linked, 'commit', '-qm', 'resolve old plan retirement')
    const bmn = new URL('../../apps/desktop/bin/bmn', import.meta.url).pathname
    const observed = JSON.parse(execFileSync(process.execPath, [bmn, 'plan', 'status', '--epic', '7', '--project', linked, '--json'], { encoding: 'utf8' }))
    const row = observed.rows.find(row => row.key === '7-1-one')
    const result = JSON.parse(execFileSync(process.execPath, [bmn, 'plan', 'set', '7-1-one', 'review', '--expect', row.token, '--project', linked, '--json'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(f.root, 'state') } }))
    expect(result.ok).toBe(true)
    expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('7-1-one: review')
    expect(readFileSync(join(linked, 'plan/status.yaml'), 'utf8')).toContain('7-1-one: ready')
  })
  it('replays rollback at each journal boundary without losing later rows', async () => {
    for (const phase of ['rollback-lease', 'rollback-prepared', 'rollback-write', 'rollback-files', 'rollback-ref', 'rolled-back']) {
      const f = fixture()
      await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo) })
      const board = join(f.repo, 'plan/status.yaml')
      writeFileSync(board, readFileSync(board, 'utf8').replace('7-1-one: backlog', '7-1-one: review'))
      await killAt(f.repo, phase, null, 'rollback')
      const result = await rollbackPlan({ repo: f.repo, handover: handover(f.repo) })
      expect(['rolled-back', 'already-rolled-back'], phase).toContain(result.outcome)
      expect(readFileSync(join(f.repo, '_bmad-output/implementation-artifacts/sprint-status.yaml'), 'utf8')).toContain('7-1-one: review')
      expect(readFileSync(join(result.preserved_plan, 'status.yaml'), 'utf8')).toContain('7-1-one: review')
      expect((await resolvePlan(f.repo)).format).toBe('bmad')
      expect(existsSync(migrationPaths(f.repo).lock)).toBe(false)
    }
  }, 30_000)
  it('rolls back later rows while preserving the post-move plan, old notes and unrelated later product work', async () => {
    for (const keepBmad of [false, true]) {
      const f = fixture(), boardPath = '_bmad-output/implementation-artifacts/sprint-status.yaml'
      await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo), keepBmad })
      file(f.repo, 'product.txt', 'later committed product\n'); git(f.repo, 'add', 'product.txt'); git(f.repo, 'commit', '-qm', 'later product change')
      const parent = git(f.repo, 'rev-parse', 'HEAD')
      file(f.repo, 'product.txt', 'later staged product\n'); git(f.repo, 'add', 'product.txt'); file(f.repo, 'product.txt', 'later unstaged product\n')
      const index = git(f.repo, 'ls-files', '-s', 'product.txt')
      const plan = readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8').replace('7-1-one: backlog', '7-1-one: paused # owner parked').replace('  epic-7: in-progress', '  epic-7: in-progress # later note') + '  7-2-added: dropped # removed from scope\n'
      file(f.repo, 'plan/status.yaml', plan)
      file(f.repo, 'plan/new-reference.md', 'post-cutover reference\n')
      appendFileSync(join(f.repo, boardPath), '  artem-only: ready-for-dev # leave this exact line\n')
      const oldNote = readFileSync(join(f.repo, '_bmad-output/planning-artifacts/note.md'))
      const result = await rollbackPlan({ repo: f.repo, handover: handover(f.repo) })
      expect(result.outcome).toBe('rolled-back')
      expect(git(f.repo, 'rev-parse', 'HEAD^')).toBe(parent)
      expect(readFileSync(join(f.repo, boardPath), 'utf8')).toContain('7-1-one: deferred # owner parked')
      expect(readFileSync(join(f.repo, boardPath), 'utf8')).toContain('7-2-added: withdrawn # removed from scope')
      expect(readFileSync(join(f.repo, boardPath), 'utf8')).toContain('  artem-only: ready-for-dev # leave this exact line\n')
      expect(readFileSync(join(result.preserved_plan, 'status.yaml'), 'utf8')).toBe(plan)
      expect(readFileSync(join(result.preserved_plan, 'new-reference.md'), 'utf8')).toBe('post-cutover reference\n')
      expect(readFileSync(join(f.repo, '_bmad-output/planning-artifacts/note.md'))).toEqual(oldNote)
      expect(git(f.repo, 'ls-files', '-s', 'product.txt')).toBe(index)
      expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('later unstaged product\n')
      expect((await resolvePlan(f.repo)).format).toBe('bmad')
      expect((await rollbackPlan({ repo: f.repo, handover: handover(f.repo) })).outcome).toBe('already-rolled-back')
    }
  })
  it('replays SIGKILL at every journal boundary and each chmod with original modes and product edits kept', async () => {
    const probe = fixture(), chmodCount = fenceInventory([probe.repo]).length
    const boundaries = ['lease-held', 'capturing', 'captured', 'staged', 'armed', 'fenced', 'final-captured', 'commit-prepared', 'installed', 'ref-committed', 'restored'].map(phase => [phase, null])
    boundaries.push(...Array.from({ length: chmodCount }, (_, index) => ['chmod', index]))
    for (const [phase, chmodIndex] of boundaries) {
      const f = fixture(), fence = fenceInventory([f.repo])
      file(f.repo, 'product.txt', 'staged product\n'); git(f.repo, 'add', 'product.txt'); file(f.repo, 'product.txt', 'unstaged product\n')
      const index = git(f.repo, 'ls-files', '-s', 'product.txt'), original = git(f.repo, 'rev-parse', 'HEAD')
      await killAt(f.repo, phase, chmodIndex)
      const result = await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo) })
      expect(['moved', 'already-moved'], `${phase}/${chmodIndex}`).toContain(result.outcome)
      expect(git(f.repo, 'rev-parse', 'HEAD^')).toBe(original)
      expect(git(f.repo, 'ls-files', '-s', 'product.txt')).toBe(index)
      expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('unstaged product\n')
      expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('7-1-one: backlog')
      expect(readFileSync(join(f.repo, 'plan/references/note.md'), 'utf8')).toBe('first\nmiddle\nlast\n')
      for (const entry of fence) expect(statSync(entry.path).mode & 0o777, `${phase}: ${entry.path}`).toBe(entry.mode)
      expect(existsSync(migrationPaths(f.repo).lock)).toBe(false)
    }
  }, 30_000)
  it('holds only rows whose go diverges, and keeps local-only rows when the board file conflicts', async () => {
    const f = fixture(), board = '_bmad-output/implementation-artifacts/sprint-status.yaml'
    const rows = (a, b, c, d) => `development_status:\n  epic-7: in-progress # ${a}\n  epic-8: backlog # ${b}\n  epic-9: ready-for-dev # ${c}\n  epic-10: backlog # ${d}\n`
    file(f.repo, board, rows('note', 'note', 'go 2026-01-01', 'note')); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'rows'); git(f.repo, 'branch', '-f', 'upstream')
    git(f.repo, 'switch', '-q', 'upstream'); file(f.repo, board, rows('upstream note', 'go 2026-02-02', 'go 2026-03-03', 'note')); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'upstream'); git(f.repo, 'switch', '-q', 'main')
    file(f.repo, board, rows('local note', 'local note', 'go 2026-04-04', 'local only'))
    const output = join(f.root, 'capture'), result = await reconcilePlan({ repo: f.repo, upstream: 'upstream', output })
    expect(result.approval_conflicts).toEqual([9])
    const merged = readFileSync(join(output, 'projection', board), 'utf8')
    expect(merged).toContain('epic-7: in-progress # upstream note')
    expect(merged).toContain('epic-8: backlog # go 2026-02-02')
    expect(merged).toContain('epic-9: ready-for-dev # go 2026-03-03')
    expect(merged).toContain('epic-10: backlog # local only')
    const named = result.conflicts.filter(conflict => conflict.path === board)
    expect(named.flatMap(conflict => conflict.rows).sort()).toEqual(['epic-7', 'epic-8', 'epic-9'])
    expect(result.settled_conflicts.map(row => row.key).sort()).toEqual(['epic-7', 'epic-8'])
    expect(readFileSync(named[0].kept, 'utf8')).toContain('epic-7: in-progress # local note')
  })
  it('does not hold approved text only upstream changed when the moved history keeps upstream', async () => {
    const f = fixture(), epics = '_bmad-output/planning-artifacts/epics.md'
    const text = terms => `# Epics\n\n## Epic 7: Probe\n\n### Run needs\n\n${terms}\n\n### Story 7.1: One\n`
    file(f.repo, epics, text('old terms')); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'terms'); git(f.repo, 'branch', '-f', 'upstream')
    git(f.repo, 'switch', '-q', 'upstream'); file(f.repo, epics, text('upstream terms')); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'upstream'); git(f.repo, 'switch', '-q', 'main')
    expect((await reconcilePlan({ repo: f.repo, upstream: 'upstream', upstreamInHistory: true, output: join(f.root, 'behind') })).approval_conflicts).toEqual([])
    file(f.repo, epics, text('local terms'))
    expect((await reconcilePlan({ repo: f.repo, upstream: 'upstream', upstreamInHistory: true, output: join(f.root, 'both') })).approval_conflicts).toEqual([7])
  })
  const visionText = words => `# Vision\n\n## Vision\n\n${words}\n\n## Principles\n\n1. One rule.\n`
  // A PR's move merged remotely: fixture cut from A, plan edited upstream, the default checkout still on the old board.
  async function mergedFixture({ keepBmad = false, afterCut = () => {}, moveCheckout = false } = {}) {
    const f = fixture(), board = '_bmad-output/implementation-artifacts/sprint-status.yaml'
    const remote = join(f.root, 'remote.git'); git(f.repo, 'clone', '-q', '--bare', f.repo, remote); git(f.repo, 'remote', 'add', 'origin', remote); git(f.repo, 'fetch', '-q', 'origin'); git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    const anchor = git(f.repo, 'rev-parse', 'HEAD'), date = '2026-11-05'
    const first = await reconcilePlan({ repo: f.repo, upstream: anchor, upstreamInHistory: true, output: join(f.root, 'first') })
    const publish = join(f.root, 'publish'); git(f.root, 'clone', '-q', remote, publish); git(publish, 'config', 'user.name', 'Fixture'); git(publish, 'config', 'user.email', 'f@example.invalid')
    git(publish, 'switch', '-qc', 'move', anchor)
    stagePlan({ repo: first.projection, contextRepo: f.repo, stage: join(publish, 'plan'), historyHead: anchor, keepBmad, date, archive: join(f.root, 'first-archive') })
    if (!keepBmad) git(publish, 'rm', '-rqf', '_bmad-output')
    file(publish, 'plan/VISION.md', visionText('edited on the branch'))
    git(publish, 'add', '-A'); git(publish, 'commit', '-qm', 'move'); const moveCommit = git(publish, 'rev-parse', 'HEAD')
    git(publish, 'switch', '-q', 'main'); file(publish, 'upstream-product.txt', 'incoming product\n'); git(publish, 'add', '.'); git(publish, 'commit', '-qm', 'product on master')
    afterCut(publish, board)
    git(publish, 'merge', '-q', '--no-ff', '-m', 'Merge move', 'move'); git(publish, 'push', '-q', 'origin', 'main'); git(f.repo, 'fetch', '-q', 'origin')
    if (moveCheckout) { git(f.repo, 'merge', '-q', '--ff-only', 'origin/main') }
    return { ...f, board, anchor, moveCommit, baseline: { projection: first.projection, fingerprint: planFingerprintOf(first.projection), date }, publish }
  }
  it('brings a live old-board edit into a move already merged, keeping plan edits and product changes', async () => {
    const f = await mergedFixture()
    file(f.repo, f.board, readFileSync(join(f.repo, f.board), 'utf8').replace('7-1-one: backlog', '7-1-one: review # live note'))
    file(f.repo, '_bmad-output/planning-artifacts/late.md', 'written after the PR snapshot\n')
    file(f.repo, 'product.txt', 'unrelated local product work\n')
    const before = git(f.repo, 'rev-parse', 'HEAD')
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(result.outcome).toBe('moved')
    expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('7-1-one: review # live note')
    expect(readFileSync(join(f.repo, 'plan/references/late.md'), 'utf8')).toBe('written after the PR snapshot\n')
    expect(readFileSync(join(f.repo, 'plan/VISION.md'), 'utf8')).toBe(visionText('edited on the branch'))
    expect(readFileSync(join(f.repo, 'upstream-product.txt'), 'utf8')).toBe('incoming product\n')
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('unrelated local product work\n')
    expect(git(f.repo, 'merge-base', '--is-ancestor', before, 'HEAD')).toBe('')
    expect(git(f.repo, 'rev-parse', 'HEAD^')).toBe(git(f.repo, 'rev-parse', 'origin/main'))
    expect(git(f.repo, 'status', '--short', '--', 'upstream-product.txt', 'plan')).toBe('')
    expect((await resolvePlan(f.repo)).format).toBe('bmn-plan')
    expect((await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })).outcome).toBe('already-moved')
  }, 30_000)
  it('reconciles a checkout that already pulled the merged move, keeping its live plan edits', async () => {
    const f = await mergedFixture({ moveCheckout: true })
    expect(existsSync(join(f.repo, 'plan/status.yaml'))).toBe(true)
    file(f.repo, 'plan/VISION.md', visionText('dirty native edit'))
    const other = join(f.root, 'late-worktree'); git(f.repo, 'worktree', 'add', '-qb', 'late', other, f.anchor)
    file(other, f.board, readFileSync(join(other, f.board), 'utf8').replace('7-1-one: backlog', '7-1-one: review # from a worktree'))
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: { ...handover(f.repo), worktrees: [f.repo, other] }, baseline: f.baseline })
    expect(result.outcome).toBe('moved')
    expect(readFileSync(join(f.repo, 'plan/VISION.md'), 'utf8')).toBe(visionText('dirty native edit'))
    expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('7-1-one: review # from a worktree')
    expect(statSync(join(f.repo, 'plan/status.yaml')).mode & 0o200).toBe(0o200)
  }, 30_000)
  it('parks a merged move when a go was withdrawn to backlog and restored after the cut', async () => {
    const f = await mergedFixture({ afterCut: (publish, board) => {
      const text = readFileSync(join(publish, board), 'utf8')
      file(publish, board, text.replace('epic-7: in-progress', 'epic-7: backlog # go 2026-11-01')); git(publish, 'commit', '-qam', 'withdraw by backlog')
      file(publish, board, text); git(publish, 'commit', '-qam', 'restore')
    } })
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(result).toMatchObject({ outcome: 'parked', code: 'APPROVAL_HISTORY_AFTER_CUT' })
  }, 30_000)
  it('takes upstream plan changes into a checkout behind it, and parks staged or conflicting native plan work', async () => {
    const f = await mergedFixture({ moveCheckout: true })
    git(f.publish, 'switch', '-q', 'main'); git(f.publish, 'pull', '-q', 'origin', 'main'); file(f.publish, 'plan/VISION.md', visionText('changed upstream later')); git(f.publish, 'add', '.'); git(f.publish, 'commit', '-qm', 'later plan'); git(f.publish, 'push', '-q', 'origin', 'main'); git(f.repo, 'fetch', '-q', 'origin')
    file(f.repo, 'plan/history.md', readFileSync(join(f.repo, 'plan/history.md'), 'utf8') + 'live native note\n'); git(f.repo, 'add', 'plan/history.md')
    expect(await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })).toMatchObject({ outcome: 'parked', code: 'NATIVE_INDEX_STAGED' })
    git(f.repo, 'reset', '-q', '--', 'plan/history.md')
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(result.outcome).toBe('moved')
    expect(readFileSync(join(f.repo, 'plan/VISION.md'), 'utf8')).toBe(visionText('changed upstream later'))
    expect(readFileSync(join(f.repo, 'plan/history.md'), 'utf8')).toContain('live native note')
  }, 30_000)
  it('recovers a merged native switch killed after its plan left the checkout', async () => {
    const f = await mergedFixture({ moveCheckout: true })
    file(f.repo, 'plan/VISION.md', visionText('dirty native edit'))
    await killAt(f.repo, 'native-moved', null, 'cutover', { upstream: 'origin/main', baseline: f.baseline })
    expect(existsSync(join(f.repo, 'plan'))).toBe(false)
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(result.outcome).toBe('moved')
    expect(readFileSync(join(f.repo, 'plan/VISION.md'), 'utf8')).toBe(visionText('dirty native edit'))
    expect(statSync(join(f.repo, 'plan/VISION.md')).mode & 0o200).toBe(0o200)
    expect(statSync(join(f.repo, 'plan')).mode & 0o200).toBe(0o200)
  }, 45_000)
  it('recovers a merged switch killed after product files changed, without losing or duplicating them', async () => {
    const f = await mergedFixture()
    file(f.repo, f.board, readFileSync(join(f.repo, f.board), 'utf8').replace('7-1-one: backlog', '7-1-one: review # live'))
    await killAt(f.repo, 'installed', null, 'cutover', { upstream: 'origin/main', baseline: f.baseline })
    expect(readFileSync(join(f.repo, 'upstream-product.txt'), 'utf8')).toBe('incoming product\n')
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(result.outcome).toBe('moved')
    expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('7-1-one: review # live')
    expect(git(f.repo, 'status', '--short', '--', 'upstream-product.txt')).toBe('')
  }, 45_000)
  it('holds a go row whose withdrawal is disputed, and settles a plain note conflict', async () => {
    const f = fixture(), board = '_bmad-output/implementation-artifacts/sprint-status.yaml'
    const rows = (a, b) => `development_status:\n  epic-7: ${a}\n  epic-8: ${b}\n`
    file(f.repo, board, rows('ready-for-dev # go 2026-01-01', 'in-progress # old')); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'rows'); git(f.repo, 'branch', '-f', 'upstream')
    git(f.repo, 'switch', '-q', 'upstream'); file(f.repo, board, rows('ready-for-dev # go 2026-01-01 upstream note', 'in-progress # upstream')); git(f.repo, 'commit', '-qam', 'upstream'); git(f.repo, 'switch', '-q', 'main')
    file(f.repo, board, rows('backlog # go 2026-01-01', 'in-progress # local'))
    const result = await reconcilePlan({ repo: f.repo, upstream: 'upstream', upstreamInHistory: true, output: join(f.root, 'c') })
    expect(result.approval_conflicts).toEqual([7])
    expect(result.settled_conflicts.map(row => row.key)).toEqual(['epic-8'])
  })
  it('never publishes a private file through a capture conflict', async () => {
    const f = fixture(), secret = '_bmad-output/planning-artifacts/secret/job.json'
    file(f.repo, secret, '{"raw":"base"}\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'secret'); git(f.repo, 'branch', '-f', 'upstream')
    const remote = join(f.root, 'remote.git'); git(f.repo, 'clone', '-q', '--bare', f.repo, remote); git(f.repo, 'remote', 'add', 'origin', remote)
    const publish = join(f.root, 'publish'); git(f.root, 'clone', '-q', remote, publish); git(publish, 'config', 'user.name', 'Fixture'); git(publish, 'config', 'user.email', 'f@example.invalid')
    file(publish, secret, '{"raw":"upstream"}\n'); git(publish, 'commit', '-qam', 'upstream'); git(publish, 'push', '-q', 'origin', 'main'); git(f.repo, 'fetch', '-q', 'origin')
    file(f.repo, secret, '{"raw":"LOCAL SECRET"}\n')
    const cut = await prepareMoveBranch({ repo: f.repo, publish, upstream: 'origin/main', branch: 'b', date: '2026-11-05', localOnly: ['^references/secret/'], output: join(f.root, 'c'), message: 'docs: move' })
    expect(cut.outcome).toBe('cut')
    expect(() => git(publish, 'grep', '-q', 'LOCAL SECRET', 'b', '--', 'plan')).toThrow()
    expect(git(publish, 'ls-tree', '-r', '--name-only', 'b', '--', 'plan')).toContain('plan/status.yaml')
  }, 30_000)
  it('parks a merged move with a go recorded and reverted on the old board after the cut', async () => {
    const f = await mergedFixture({ afterCut: (publish, board) => {
      const text = readFileSync(join(publish, board), 'utf8')
      file(publish, board, text.replace('epic-7: in-progress', 'epic-7: withdrawn')); git(publish, 'commit', '-qam', 'withdraw')
      file(publish, board, text); git(publish, 'commit', '-qam', 'restore')
    } })
    const before = git(f.repo, 'rev-parse', 'HEAD')
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(result).toMatchObject({ outcome: 'parked', code: 'APPROVAL_HISTORY_AFTER_CUT' })
    expect(result.events.map(event => event.key)).toContain('epic-7')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before)
  }, 30_000)
  it('parks a merged move without its pinned baseline and with unpublished local commits', async () => {
    const f = await mergedFixture()
    expect(await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo) })).toMatchObject({ outcome: 'parked', code: 'BASELINE_REQUIRED' })
    expect(await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: { ...f.baseline, fingerprint: 'other' } })).toMatchObject({ outcome: 'parked', code: 'BASELINE_REQUIRED' })
  }, 30_000)
  it('keeps unpublished local commits in history under a true merge and names the local history for the approval reader', async () => {
    const f = await mergedFixture()
    file(f.repo, 'local.txt', 'local\n'); file(f.repo, f.board, readFileSync(join(f.repo, f.board), 'utf8').replace('epic-7: in-progress', 'epic-7: in-progress # committed locally'))
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'local commit'); const local = git(f.repo, 'rev-parse', 'HEAD')
    const result = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(result.outcome).toBe('moved')
    expect(git(f.repo, 'rev-parse', 'HEAD^1')).toBe(local); expect(git(f.repo, 'rev-parse', 'HEAD^2')).toBe(git(f.repo, 'rev-parse', 'origin/main'))
    expect(git(f.repo, 'log', '-1', '--format=%B')).toContain('Plan-Cutover: yes')
    expect(JSON.parse(git(f.repo, 'show', 'HEAD:plan/migration.json')).local_history_head).toBe(local)
    expect(git(f.repo, 'show', 'HEAD:plan/status.yaml')).toContain('committed locally')
    expect(readFileSync(join(f.repo, 'local.txt'), 'utf8')).toBe('local\n'); expect(readFileSync(join(f.repo, 'upstream-product.txt'), 'utf8')).toBe('incoming product\n')
    expect(git(f.repo, 'ls-tree', 'HEAD', '--', f.board)).toBe('')
    expect(git(f.repo, 'status', '--short', '--', 'plan', 'local.txt', 'upstream-product.txt')).toBe('')
  }, 30_000)
  it('parks instead of overwriting staged or conflicting product work', async () => {
    const f = await mergedFixture({ afterCut: publish => { file(publish, 'product.txt', 'incoming change\n'); git(publish, 'commit', '-qam', 'incoming') } })
    const head = git(f.repo, 'rev-parse', 'HEAD')
    file(f.repo, 'product.txt', 'staged\n'); git(f.repo, 'add', 'product.txt'); file(f.repo, 'product.txt', 'original product\n')
    const staged = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(staged).toMatchObject({ outcome: 'parked', code: 'PRODUCT_OVERLAP' })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(f.repo, 'show', ':product.txt')).toBe('staged')
    expect(existsSync(join(f.repo, 'plan'))).toBe(false)
  }, 30_000)
  it('keeps a renamed epic in its established file and private text out of the merged plan', async () => {
    const f = fixture(), roots2 = name => { const dir = join(f.root, name); mkdirSync(dir, { recursive: true }); return dir }
    const base = roots2('base'), ours = roots2('ours'), theirs = roots2('theirs')
    file(base, 'epics/007-alpha.md', 'one\ntwo\n'); file(ours, 'epics/007-beta.md', 'one\ntwo\nthree\n'); file(theirs, 'epics/007-alpha.md', 'zero\none\ntwo\n')
    file(base, 'PLAN-index.md', 'see epics/007-alpha.md\n'); file(ours, 'PLAN-index.md', 'see epics/007-beta.md\n'); file(theirs, 'PLAN-index.md', 'see epics/007-alpha.md\n')
    file(base, 'references/secret/job.json', 'old secret\n'); file(ours, 'references/secret/job.json', 'new secret\n'); file(ours, 'references/secret/other.json', 'new private file\n')
    file(base, 'references/removed.md', 'old\n'); file(ours, 'references/removed.md', 'changed\n')
    const output = join(f.root, 'out', 'plan'), result = mergeStagedPlan({ base, ours, theirs, output, date: '2026-11-05', localOnly: ['^references/secret/'], keep: join(f.root, 'kept') })
    expect(readFileSync(join(output, 'epics/007-alpha.md'), 'utf8')).toBe('zero\none\ntwo\nthree\n')
    expect(existsSync(join(output, 'epics/007-beta.md'))).toBe(false)
    expect(readFileSync(join(output, 'PLAN-index.md'), 'utf8')).toBe('see epics/007-alpha.md\n')
    expect(existsSync(join(output, 'references/secret'))).toBe(false)
    expect(existsSync(join(output, 'references/removed.md'))).toBe(false)
    expect(result.local_only.map(entry => entry.path).sort()).toEqual(['references/removed.md', 'references/secret/job.json', 'references/secret/other.json'])
    expect(JSON.stringify(result)).not.toContain('new secret')
  })
  it('rolls a merged move back from its baseline, keeping later product and rows', async () => {
    const f = await mergedFixture()
    const moved = await move({ repo: f.repo, upstream: 'origin/main', handover: handover(f.repo), baseline: f.baseline })
    expect(moved.outcome).toBe('moved')
    const plan = readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8'); file(f.repo, 'plan/status.yaml', plan.replace('7-1-one: backlog', '7-1-one: review # after the move'))
    const result = await rollbackPlan({ repo: f.repo, handover: handover(f.repo) })
    expect(result.outcome).toBe('rolled-back')
    expect(readFileSync(join(f.repo, f.board), 'utf8')).toContain('7-1-one: review # after the move')
    expect(readFileSync(join(f.repo, 'upstream-product.txt'), 'utf8')).toBe('incoming product\n')
    expect(git(f.repo, 'ls-tree', 'HEAD', '--', f.board)).not.toBe('')
    expect(git(f.repo, 'ls-tree', 'HEAD', '--', 'plan')).toBe('')
    expect(existsSync(join(f.repo, 'plan'))).toBe(false)
  }, 30_000)
  it('cuts a move directly on the upstream tip, keeps branch edits from an earlier cut and forwards platform documents', async () => {
    const f = fixture()
    file(f.repo, 'docs/platform/epic-7-probe.md', '# Epic 7\n\n## Why\n\nA platform contract.\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'platform doc')
    const remote = join(f.root, 'remote.git'); git(f.repo, 'clone', '-q', '--bare', f.repo, remote); git(f.repo, 'remote', 'add', 'origin', remote); git(f.repo, 'fetch', '-q', 'origin')
    const publish = join(f.root, 'publish'); git(f.root, 'clone', '-q', remote, publish); git(publish, 'config', 'user.name', 'Fixture'); git(publish, 'config', 'user.email', 'f@example.invalid')
    const cut = options => prepareMoveBranch({ repo: f.repo, publish, upstream: 'origin/main', date: '2026-11-05', localOnly: ['^references/secret/'], message: 'docs: move', ...options })
    file(f.repo, '_bmad-output/planning-artifacts/secret/job.json', '{"raw":1}\n')
    const first = await cut({ branch: 'move-1', output: join(f.root, 'cut-1') })
    expect(first).toMatchObject({ outcome: 'cut', approval_conflicts: [] })
    expect(git(publish, 'rev-parse', 'move-1^1')).toBe(git(publish, 'rev-parse', 'origin/main'))
    expect(JSON.parse(git(publish, 'show', 'move-1:plan/migration.json')).history_head).toBe(git(publish, 'rev-parse', 'origin/main'))
    expect(git(publish, 'ls-tree', '-r', '--name-only', 'move-1', '--', '_bmad-output', 'plan/references/secret')).toBe('')
    expect(git(publish, 'show', 'move-1:docs/platform/epic-7-probe.md')).toContain('The preserved record is')
    git(publish, 'switch', '-q', 'move-1'); file(publish, 'plan/VISION.md', visionText('edited on the branch')); file(publish, 'AGENTS.md', 'plan lives in plan/\n'); git(publish, 'add', '.'); git(publish, 'commit', '-qm', 'cleanup'); git(publish, 'switch', '-q', 'main')
    file(publish, 'upstream-product.txt', 'later product\n'); file(publish, 'docs/platform/epic-7-probe.md', '# Epic 7\n\n## Why\n\nEdited upstream.\n'); git(publish, 'add', '.'); git(publish, 'commit', '-qm', 'later master'); git(publish, 'push', '-q', 'origin', 'main')
    git(f.repo, 'fetch', '-q', 'origin'); git(publish, 'fetch', '-q', 'origin')
    file(f.repo, '_bmad-output/planning-artifacts/late.md', 'after the first cut\n')
    const second = await cut({ branch: 'move-2', output: join(f.root, 'cut-2'), previous: { head: git(publish, 'rev-parse', 'move-1') + '', projection: first.baseline.projection, date: first.baseline.date } })
    expect(second).toMatchObject({ outcome: 'cut' })
    git(publish, 'rev-parse', 'move-2')
    expect(git(publish, 'rev-parse', 'move-2^1')).toBe(git(publish, 'rev-parse', 'origin/main'))
    expect(() => git(publish, 'rev-parse', '--verify', 'move-2^2')).toThrow()
    expect(git(publish, 'show', 'move-2:plan/VISION.md')).toContain('edited on the branch')
    expect(git(publish, 'show', 'move-2:AGENTS.md')).toBe('plan lives in plan/')
    expect(git(publish, 'show', 'move-2:upstream-product.txt')).toBe('later product')
    expect(git(publish, 'show', 'move-2:plan/references/late.md')).toBe('after the first cut')
    expect(git(publish, 'show', 'move-2:docs/platform/epic-7-probe.md')).toContain('The preserved record is')
    expect(git(publish, 'ls-tree', '-r', '--name-only', 'move-2', '--', '_bmad-output', 'plan/references/secret')).toBe('')
  }, 30_000)
  it('attributes copied rows from the upstream board at the cut, leaving local-only rows in the plan', async () => {
    const f = fixture(), board = '_bmad-output/implementation-artifacts/sprint-status.yaml'
    const author = (name, message) => execFileSync('git', ['-C', f.repo, '-c', `user.name=${name}`, '-c', 'user.email=a@example.invalid', 'commit', '-qam', message])
    file(f.repo, board, 'development_status:\n  epic-7: in-progress\n  7-1-one: backlog\n  7-2-two: ready-for-dev # his\n'); git(f.repo, 'add', '.'); author('Oleksandr', 'owner rows')
    file(f.repo, board, 'development_status:\n  epic-7: in-progress\n  7-1-one: review # Artem took it\n  7-2-two: ready-for-dev # his\n'); author('Artem Kobrin', 'artem row')
    const remote = join(f.root, 'remote.git'); git(f.repo, 'clone', '-q', '--bare', f.repo, remote); git(f.repo, 'remote', 'add', 'origin', remote); git(f.repo, 'fetch', '-q', 'origin')
    const publish = join(f.root, 'publish'); git(f.root, 'clone', '-q', remote, publish); git(publish, 'config', 'user.name', 'Fixture'); git(publish, 'config', 'user.email', 'f@example.invalid')
    file(f.repo, board, 'development_status:\n  epic-7: in-progress\n  7-1-one: done # owner local\n  7-2-two: in-progress # owner local\n  7-3-new: backlog\n')
    const before = readFileSync(join(f.repo, board))
    const cut = await prepareMoveBranch({ repo: f.repo, publish, upstream: 'origin/main', branch: 'b2', keepBmad: true, date: '2026-11-05', output: join(f.root, 'c'), message: 'docs: move' })
    expect(cut).toMatchObject({ outcome: 'cut' })
    const copy = JSON.parse(git(publish, 'show', 'b2:plan/bmad-copy.json'))
    expect(Object.keys(copy.excluded)).toEqual(['7-1-one'])
    expect(copy.rows['7-2-two'].last_copied).toEqual({ status: 'ready-for-dev', note: 'his' })
    expect(copy.plan_only).toEqual(['7-3-new']); expect(copy.unresolved).toEqual({}); expect(copy.active).toBe(false)
    expect(git(publish, 'show', 'b2:plan/status.yaml')).toContain('7-3-new')
    expect(git(publish, 'show', `b2:${board}`)).toContain('7-1-one: review # Artem took it')
    expect(git(publish, 'diff', '--name-only', 'origin/main', 'b2', '--', '_bmad-output')).toBe('')
    expect(readFileSync(join(f.repo, board)).equals(before)).toBe(true)
  }, 30_000)
  it('parks a re-cut whose product side conflicts instead of guessing', async () => {
    const f = fixture()
    const remote = join(f.root, 'remote.git'); git(f.repo, 'clone', '-q', '--bare', f.repo, remote); git(f.repo, 'remote', 'add', 'origin', remote); git(f.repo, 'fetch', '-q', 'origin')
    const publish = join(f.root, 'publish'); git(f.root, 'clone', '-q', remote, publish); git(publish, 'config', 'user.name', 'Fixture'); git(publish, 'config', 'user.email', 'f@example.invalid')
    const first = await prepareMoveBranch({ repo: f.repo, publish, upstream: 'origin/main', branch: 'one', date: '2026-11-05', output: join(f.root, 'a'), message: 'docs: move' })
    git(publish, 'switch', '-q', 'one'); file(publish, 'product.txt', 'branch\n'); git(publish, 'commit', '-qam', 'branch product'); git(publish, 'switch', '-q', 'main')
    file(publish, 'product.txt', 'master\n'); git(publish, 'commit', '-qam', 'master product'); git(publish, 'push', '-q', 'origin', 'main'); git(f.repo, 'fetch', '-q', 'origin'); git(publish, 'fetch', '-q', 'origin')
    const second = await prepareMoveBranch({ repo: f.repo, publish, upstream: 'origin/main', branch: 'two', date: '2026-11-05', output: join(f.root, 'b'), message: 'docs: move', previous: { head: git(publish, 'rev-parse', 'one'), projection: first.baseline.projection, date: first.baseline.date } })
    expect(second).toMatchObject({ outcome: 'parked', code: 'MOVE_PRODUCT_CONFLICT', paths: ['product.txt'] })
    expect(() => git(publish, 'rev-parse', '--verify', 'two')).toThrow()
  }, 30_000)
  it('switches a stable acknowledged plan with a dirty product index and preserves foreign product ancestry', async () => {
    const f = fixture()
    git(f.repo, 'switch', '-q', 'upstream'); file(f.repo, 'upstream-product.txt', 'foreign product\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'foreign product')
    const incoming = git(f.repo, 'rev-parse', 'HEAD'); git(f.repo, 'switch', '-q', 'main')
    file(f.repo, 'product.txt', 'staged product\n'); git(f.repo, 'add', 'product.txt'); file(f.repo, 'product.txt', 'unstaged product\n')
    const index = git(f.repo, 'ls-files', '-s', 'product.txt'), head = git(f.repo, 'rev-parse', 'HEAD')
    const observed = []
    const result = await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo), seam: async phase => {
      if (['installed', 'ref-committed'].includes(phase)) observed.push((await resolvePlan(f.repo)).format)
    } })
    expect(result.outcome).toBe('moved')
    expect(observed[0]).toBe('bmad'); expect(observed.at(-1)).toBe('bmn-plan')
    expect(git(f.repo, 'rev-parse', 'HEAD^')).toBe(head)
    expect(() => git(f.repo, 'merge-base', '--is-ancestor', incoming, 'HEAD')).toThrow()
    expect(git(f.repo, 'ls-files', '-s', 'product.txt')).toBe(index)
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('unstaged product\n')
    expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('epic-7: in-progress')
    expect(JSON.parse(readFileSync(join(f.repo, 'plan/migration.json'), 'utf8')).history_head).toBe(head)
    expect(git(f.repo, 'ls-tree', 'HEAD', '--', '_bmad-output/implementation-artifacts/sprint-status.yaml')).toBe('')
    expect(readFileSync(join(f.repo, '_bmad-output/implementation-artifacts/sprint-status.yaml'), 'utf8')).toContain('epic-7: in-progress')
    expect((await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo) })).outcome).toBe('already-moved')
  })
  it('includes a late write and parks after three continuing writes without moving HEAD', async () => {
    for (const continuous of [false, true]) {
      const f = fixture(), before = git(f.repo, 'rev-parse', 'HEAD')
      let passes = 0
      const result = await move({ repo: f.repo, upstream: 'upstream', handover: handover(f.repo), seam: async phase => {
        if (phase === 'staged' && (continuous || passes === 0)) file(f.repo, '_bmad-output/planning-artifacts/late.md', `late edit ${++passes}\n`)
      } })
      if (continuous) {
        expect(result).toMatchObject({ outcome: 'parked', code: 'INPUTS_STILL_CHANGING' })
        expect(passes).toBe(3)
        expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before)
      } else {
        expect(result.outcome).toBe('moved')
        expect(readFileSync(join(f.repo, 'plan/references/late.md'), 'utf8')).toBe('late edit 1\n')
      }
    }
  })
  it('parks an unacknowledged writer before changing a mode or ref', async () => {
    const f = fixture(), path = join(f.repo, '_bmad-output/planning-artifacts/note.md'), mode = statSync(path).mode
    const before = git(f.repo, 'rev-parse', 'HEAD')
    const result = await move({ repo: f.repo, upstream: 'upstream', handover: { ...handover(f.repo), writers: [{ id: 'late-client', state: 'running' }] } })
    expect(result).toMatchObject({ outcome: 'parked', code: 'HANDOVER_REQUIRED' })
    expect(statSync(path).mode).toBe(mode)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before)
  })
  it('fences truncation and nested creation, holds installed writers and restores exact modes on release', async () => {
    const f = fixture(), path = join(f.repo, '_bmad-output/planning-artifacts/note.md')
    chmodSync(path, 0o640)
    const fence = fenceInventory([f.repo]), watchdog = await startWatchdog(f.repo), journal = migrationPaths(f.repo).journal
    resource({ kind: 'process', pid: watchdog.pid, start_ticks: watchdog.start_ticks, command: 'Epic107 fence release test watchdog' })
    const state = { phase: 'armed', fenced: false, fence, watchdog_nonce: watchdog.nonce }
    let writer, writerExit, writerOutput = ''
    try {
      saveJournal(journal, state); await watchdog.arm()
      saveJournal(journal, { ...state, phase: 'fenced', fenced: true }); applyFence(fence)
      expect(() => writeFileSync(path, 'lost')).toThrow()
      expect(() => writeFileSync(join(f.repo, '_bmad-output/planning-artifacts/new.md'), 'late')).toThrow()
      await expect(withMigrationWriter(f.repo, async () => true, { waitMs: 20 })).rejects.toMatchObject({ code: 'LOCKED' })
      writer = spawn(process.execPath, [new URL('../../apps/desktop/bin/bmn', import.meta.url).pathname, 'plan', 'set', '7-1-one', 'review', '--expect', rowToken('7-1-one', 'backlog', ''), '--project', f.repo, '--json'], { env: { ...process.env, XDG_STATE_HOME: join(f.root, 'state') }, stdio: ['ignore', 'pipe', 'pipe'] })
      writerExit = once(writer, 'exit'); writer.stdout.on('data', bytes => { writerOutput += bytes.toString() })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(writer.exitCode).toBe(null)
      expect(writerOutput).toBe('')
      saveJournal(journal, { ...state, phase: 'ref-committed', fenced: true })
    } finally { await watchdog.release(); if (writerExit) await writerExit }
    expect(writer.exitCode, writerOutput).toBe(0)
    for (const entry of fence) expect(statSync(entry.path).mode & 0o777).toBe(entry.mode)
    expect(readFileSync(path, 'utf8')).toBe('first\nmiddle\nlast\n')
  })
  it('restores the fenced modes after the lead is killed through its verified pidfd', async () => {
    const f = fixture(), module = new URL('../plan/plan-cutover.mjs', import.meta.url).href
    const code = `import {applyFence,fenceInventory,migrationPaths,saveJournal,startWatchdog} from ${JSON.stringify(module)};\nimport{readFileSync}from'node:fs';\nconst repo=${JSON.stringify(f.repo)}, fence=fenceInventory([repo]), watchdog=await startWatchdog(repo);\nconst state={phase:'fenced',fenced:true,fence,watchdog_nonce:watchdog.nonce};\nsaveJournal(migrationPaths(repo).journal,{...state,phase:'armed',fenced:false});await watchdog.arm();saveJournal(migrationPaths(repo).journal,state);applyFence(fence);\nconst stat=readFileSync('/proc/'+process.pid+'/stat','utf8');console.log(JSON.stringify({pid:process.pid,start_ticks:stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19],watchdog:{kind:'process',pid:watchdog.pid,start_ticks:watchdog.start_ticks,command:'Epic107 SIGKILL test watchdog'}}));\nsetInterval(()=>{},1000);`
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] })
    const identity = await new Promise((resolve, reject) => {
      let output = '', error = ''
      child.stderr.on('data', bytes => { error += bytes.toString() })
      child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])) })
      child.once('exit', () => reject(new Error('lead exited before fencing: ' + error)))
    })
    resource(identity.watchdog)
    const exited = once(child, 'exit')
    execFileSync('python3', ['-c', "import os,sys,signal; from pathlib import Path; pid=int(sys.argv[1]); fd=os.pidfd_open(pid); observed=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]; assert observed==sys.argv[2]; signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd)", String(identity.pid), identity.start_ticks])
    await exited
    await withMigrationWriter(f.repo, async () => {
      const state = JSON.parse(readFileSync(migrationPaths(f.repo).journal, 'utf8'))
      expect(state.fenced).toBe(false)
      expect(state.phase).toBe('interrupted')
      for (const entry of state.fence) expect(statSync(entry.path).mode & 0o777).toBe(entry.mode)
    }, { waitMs: 5000 })
  })
  it('merges committed upstream, local committed, working and untracked planning images with owners/hashes', async () => {
    const f = fixture(), path = '_bmad-output/planning-artifacts/note.md'
    git(f.repo, 'switch', '-q', 'upstream'); file(f.repo, path, 'upstream first\nmiddle\nlast\n'); git(f.repo, 'commit', '-qam', 'upstream planning')
    git(f.repo, 'switch', '-q', 'main'); file(f.repo, path, 'first\nmiddle\nlocal last\n'); git(f.repo, 'commit', '-qam', 'local planning')
    file(f.repo, '_bmad-output/planning-artifacts/untracked.md', '# Untracked planning\n')
    file(f.repo, 'product.txt', 'dirty product\n')
    const result = await reconcilePlan({ repo: f.repo, upstream: 'upstream', output: join(f.root, 'projection') })
    expect(readFileSync(join(result.projection, path), 'utf8')).toBe('upstream first\nmiddle\nlocal last\n')
    expect(readFileSync(join(result.projection, '_bmad-output/planning-artifacts/untracked.md'), 'utf8')).toBe('# Untracked planning\n')
    expect(result.conflicts).toEqual([])
    expect(result.inputs.some(input => input.path === path && input.owner && /^[a-f0-9]{64}$/u.test(input.sha256))).toBe(true)
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('dirty product\n')
  })
  it('keeps upstream text and each whole local conflicting image, including another worktree', async () => {
    const f = fixture(), path = '_bmad-output/planning-artifacts/note.md'
    git(f.repo, 'switch', '-q', 'upstream'); file(f.repo, path, 'UPSTREAM\n'); git(f.repo, 'commit', '-qam', 'upstream')
    git(f.repo, 'switch', '-q', 'main'); file(f.repo, path, 'LOCAL\n'); git(f.repo, 'commit', '-qam', 'local')
    const linked = join(f.root, 'linked'); git(f.repo, 'worktree', 'add', '-qb', 'other', linked)
    file(linked, path, 'OTHER WORKTREE\n')
    const result = await reconcilePlan({ repo: f.repo, upstream: 'upstream', output: join(f.root, 'projection') })
    expect(readFileSync(join(result.projection, path), 'utf8')).toBe('UPSTREAM\n')
    const images = result.conflicts.map(conflict => readFileSync(conflict.kept, 'utf8'))
    expect(images).toContain('LOCAL\n')
    expect(images).toContain('OTHER WORKTREE\n')
    expect(readFileSync(join(linked, path), 'utf8')).toBe('OTHER WORKTREE\n')
  })
})
