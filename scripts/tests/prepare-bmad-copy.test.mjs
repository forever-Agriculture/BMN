// MODULE: prepare-bmad-copy.test.mjs - real BMAD parser semantics and recoverable two-client preparation
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compatibleParser, digest } from '../plan/bmad-parser-patch.mjs'
import { prepareBmadCopy, preparedBmadProof, rollbackBmadPreparation } from '../plan/prepare-bmad-copy.mjs'
import { cutoverPlan, rollbackPlan } from '../plan/plan-cutover.mjs'
import { stagePlan } from '../plan/migrate-bmad-plan.mjs'
import { resolvePlan, rowToken } from '../../apps/desktop/bin/plan-board.mjs'
import { setWithCopy } from '../../apps/desktop/bin/plan-bmad-copy.mjs'
import { publishPlan } from '../../apps/desktop/bin/plan-publish.mjs'
import { BMAD_PARSER_ORIGINAL, BMAD_PARSER_PATHS, BMAD_PARSER_PREPARED, verifyParserProof } from '../../apps/desktop/bin/plan-bmad-parser.mjs'

const roots = [], original = readFileSync(new URL('./fixtures/bmad-sprint-plan.py', import.meta.url))
const handover = repo => ({ inventory_verified: true, worktrees: [repo], writers: [] })
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
function file(repo, path, bytes) { const full = join(repo, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, bytes); return full }
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'bmn-parser-')); roots.push(repo)
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
  for (const path of BMAD_PARSER_PATHS) file(repo, path, original)
  file(repo, 'product.txt', 'unrelated\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture')
  return repo
}
function run(repo, client, args) {
  const result = spawnSync('uv', ['run', '--offline', join(repo, BMAD_PARSER_PATHS[client]), ...args], { cwd: repo, encoding: 'utf8' })
  if (!result.stdout) throw new Error('parser did not run: ' + result.stderr)
  return { exit: result.status, value: JSON.parse(result.stdout) }
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

describe('internal BMAD compatibility preparation', () => {
  it('recovers or names uncertainty after real SIGKILL at every write phase in both clients and rollback', async () => {
    const module = new URL('../plan/prepare-bmad-copy.mjs', import.meta.url).href
    const boundaries = [['prepared', null], ['complete', null], ...['writing', 'replaced', 'written'].flatMap(phase => BMAD_PARSER_PATHS.map(file => [phase, file])), ['rollback', null], ...BMAD_PARSER_PATHS.map(file => ['rollback-replaced', file]), ['rolled-back', null]]
    for (const [boundary, file] of boundaries) {
      const repo = fixture(), rollback = boundary.startsWith('rollback') || boundary === 'rolled-back'
      if (rollback) await prepareBmadCopy({ repo, handover: handover(repo) })
      const code = `import{prepareBmadCopy,rollbackBmadPreparation}from ${JSON.stringify(module)};import{readFileSync}from'node:fs';
await ${rollback ? 'rollbackBmadPreparation' : 'prepareBmadCopy'}({repo:${JSON.stringify(repo)},handover:${JSON.stringify(handover(repo))},seam:async(phase,state)=>{if(phase!==${JSON.stringify(boundary)}||(${JSON.stringify(file)}!==null&&state.file!==${JSON.stringify(file)}))return;const raw=readFileSync('/proc/'+process.pid+'/stat','utf8');console.log(JSON.stringify({pid:process.pid,start_ticks:raw.slice(raw.lastIndexOf(')')+1).trim().split(/\\s+/)[19]}));await new Promise(()=>setInterval(()=>{},1000));}});`
      const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] })
      const identity = await new Promise((resolve, reject) => {
        let out = '', error = ''
        child.stderr.on('data', bytes => { error += bytes.toString() })
        child.stdout.on('data', bytes => { out += bytes.toString(); if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0])) })
        child.once('exit', () => reject(new Error('preparation ended before boundary: ' + error)))
      })
      if (process.env.BMN_CUTOVER_RESOURCE_LOG) appendFileSync(process.env.BMN_CUTOVER_RESOURCE_LOG, JSON.stringify({ kind: 'process', ...identity, command: `Epic107 BMAD preparation kill at ${boundary} ${file ?? ''}` }) + '\n')
      const exited = once(child, 'exit')
      execFileSync('python3', ['-c', "import os,sys,signal; from pathlib import Path; pid=int(sys.argv[1]); fd=os.pidfd_open(pid); assert Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]==sys.argv[2]; signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd)", String(identity.pid), identity.start_ticks])
      await exited
      if (rollback) expect((await rollbackBmadPreparation({ repo, handover: handover(repo) })).outcome).toBe('rolled-back')
      else if (boundary === 'writing') await expect(prepareBmadCopy({ repo, handover: handover(repo) })).rejects.toMatchObject({ code: 'BMAD_PREPARATION_UNCERTAIN' })
      else expect(await prepareBmadCopy({ repo, handover: handover(repo) })).toEqual(preparedBmadProof(repo))
    }
  }, 30_000)
  it('keeps staging byte-identical and requires completed preparation at cutover, then publishes both prepared clients with copied rows', async () => {
    const repo = fixture()
    file(repo, '_bmad-output/planning-artifacts/epics.md', '# Epics\n## Epic 7: Fixture\n### Story 7.1: One\n')
    const target = '_bmad-output/implementation-artifacts/sprint-status.yaml', before = 'development_status:\n  epic-7: in-progress\n  7-1-one: backlog\n'
    file(repo, target, before); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'BMAD board')
    git(repo, 'branch', 'upstream')
    const remote = join(repo, 'remote.git'); git(repo, 'clone', '--bare', repo, remote)
    git(repo, 'remote', 'add', 'origin', remote); git(repo, 'fetch', '-q', 'origin'); git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    stagePlan({ repo, stage: join(repo, 'scratch/plan'), archive: join(repo, 'archive'), keepBmad: true })
    for (const path of BMAD_PARSER_PATHS) expect(readFileSync(join(repo, path))).toEqual(original)
    expect(readFileSync(join(repo, target), 'utf8')).toBe(before)
    expect((await cutoverPlan({ repo, upstream: 'upstream', handover: handover(repo), keepBmad: true })).outcome).toBe('parked')
    await prepareBmadCopy({ repo, handover: handover(repo) })
    expect((await cutoverPlan({ repo, upstream: 'upstream', handover: handover(repo), keepBmad: true })).outcome).toBe('moved')
    const plan = await resolvePlan(repo), meta = JSON.parse(readFileSync(join(repo, 'plan/bmad-copy.json')))
    expect(verifyParserProof(repo, meta.parser_preparation)).toEqual(BMAD_PARSER_PATHS)
    for (const path of BMAD_PARSER_PATHS) expect(digest(execFileSync('git', ['-C', repo, 'show', `HEAD:${path}`]))).toBe(BMAD_PARSER_PREPARED)
    expect((await setWithCopy(plan, { key: '7-1-one', status: 'paused', expect: rowToken('7-1-one', 'backlog', ''), environment: { XDG_STATE_HOME: join(repo, 'state') } })).copy.outcome).toBe('copied')
    file(repo, 'product.txt', 'unrelated working edit\n')
    const published = await publishPlan(plan, { direct: true, readPolicy: async () => ({ repository: { authorizes: true, level: 'merge-and-push-main' } }) })
    expect(published.outcome).toBe('published')
    for (const path of BMAD_PARSER_PATHS) expect(digest(execFileSync('git', ['-C', remote, 'show', `main:${path}`]))).toBe(BMAD_PARSER_PREPARED)
    expect(git(remote, 'show', `main:${target}`)).toContain('7-1-one: deferred')
    expect(readFileSync(join(repo, 'product.txt'), 'utf8')).toBe('unrelated working edit\n')
    expect((await rollbackPlan({ repo, handover: handover(repo) })).outcome).toBe('rolled-back')
    for (const path of BMAD_PARSER_PATHS) expect(digest(execFileSync('git', ['-C', repo, 'show', `HEAD:${path}`]))).toBe(BMAD_PARSER_PREPARED)
    expect(readFileSync(join(repo, target), 'utf8')).toContain('7-1-one: deferred')
    await expect(rollbackBmadPreparation({ repo, handover: handover(repo) })).rejects.toMatchObject({ code: 'BMAD_PREPARATION_IN_USE' })
  }, 30_000)
  it('runs every D10 story/epic output through both real generators, fresh repair and status selection', async () => {
    const repo = fixture(), statuses = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done', 'blocked', 'deferred', 'withdrawn']
    const bytes = process.env.BMN_PARSER_UNPATCHED ? original : compatibleParser(original)
    for (const path of BMAD_PARSER_PATHS) file(repo, path, bytes)
    for (let client = 0; client < 2; client++) {
      const board = file(repo, `board-${client}.yaml`, 'development_status:\n' + statuses.map((status, i) => `  epic-${i + 1}: ${status}\n  ${i + 1}-1-one: ${status}\n`).join(''))
      const epics = file(repo, 'epics.md', statuses.map((_, i) => `## Epic ${i + 1}: Fixture\n### Story ${i + 1}.1: One\n`).join('\n'))
      const stories = join(repo, 'stories'); mkdirSync(stories, { recursive: true })
      for (let i = 5; i < 8; i++) file(repo, `stories/${i + 1}-1-one.md`, '# Existing story file\n')
      const args = ['generate', '--status-file', board, '--epic-file', epics, '--stories-dir', stories, '--project', 'Fixture', '--date', '11-05-2026 01:00']
      const generated = run(repo, client, args)
      expect(generated.exit).toBe(0); expect(generated.value.illegal).toEqual([])
      for (const [i, status] of statuses.entries()) {
        expect(readFileSync(board, 'utf8')).toContain(`epic-${i + 1}: ${status}`)
        expect(readFileSync(board, 'utf8')).toContain(`${i + 1}-1-one: ${status}`)
      }
      const beforeFresh = readFileSync(board)
      const fresh = run(repo, client, [...args, '--fresh'])
      expect(fresh.exit).toBe(1); expect(fresh.value.error).toContain('BMN_HELD_ROWS'); expect(readFileSync(board)).toEqual(beforeFresh)
      const repaired = run(repo, client, [...args, '--fresh', ...[6, 7, 8].flatMap(i => ['--set', `epic-${i}=backlog`, '--set', `${i}-1-one=backlog`])])
      expect(repaired.exit).toBe(0)
      const held = file(repo, 'held.yaml', 'development_status:\n  epic-1: deferred\n  1-1-one: in-progress\n  epic-1-retrospective: optional\n  epic-2: blocked\n  2-1-one: ready-for-dev\n  epic-2-retrospective: optional\n  epic-3: withdrawn\n  3-1-one: backlog\n  epic-3-retrospective: optional\n')
      const status = run(repo, client, ['status', '--status-file', held]).value
      expect(status.illegal).toEqual([]); expect(status.recommendation).toBeNull(); expect(status.all_done).toBe(false)
      const orphan = file(repo, 'orphan.yaml', 'development_status:\n  epic-1: backlog\n  99-1-held: deferred\n')
      expect(run(repo, client, [...args.slice(0, 1), '--status-file', orphan, '--epic-file', epics, '--stories-dir', stories, '--project', 'Fixture', '--date', '11-05-2026 01:00']).exit).toBe(0)
      expect(readFileSync(orphan, 'utf8')).toContain('99-1-held: deferred')
    }
  }, 30_000)
  it('preflights both exact files and handover before any mutation, then repeats and rolls back byte-for-byte', async () => {
    const repo = fixture(), first = join(repo, BMAD_PARSER_PATHS[0]), second = join(repo, BMAD_PARSER_PATHS[1]), mode = statSync(first).mode
    expect(digest(original)).toBe(BMAD_PARSER_ORIGINAL); expect(digest(compatibleParser(original))).toBe(BMAD_PARSER_PREPARED)
    await expect(prepareBmadCopy({ repo, handover: { ...handover(repo), writers: [{ id: 'live', state: 'running' }] } })).rejects.toMatchObject({ code: 'HANDOVER_REQUIRED' })
    rmSync(second)
    await expect(prepareBmadCopy({ repo, handover: handover(repo) })).rejects.toMatchObject({ code: 'BMAD_VERSION_UNSUPPORTED' })
    expect(readFileSync(first)).toEqual(original)
    writeFileSync(second, Buffer.concat([original, Buffer.from('# divergent\n')]))
    await expect(prepareBmadCopy({ repo, handover: handover(repo) })).rejects.toMatchObject({ code: 'BMAD_VERSION_UNSUPPORTED' })
    writeFileSync(second, original)
    const proof = await prepareBmadCopy({ repo, handover: handover(repo) })
    expect(verifyParserProof(repo, proof)).toEqual(BMAD_PARSER_PATHS)
    expect(await prepareBmadCopy({ repo, handover: handover(repo) })).toEqual(proof)
    expect(readFileSync(join(repo, 'product.txt'), 'utf8')).toBe('unrelated\n')
    await rollbackBmadPreparation({ repo, handover: handover(repo) }); await rollbackBmadPreparation({ repo, handover: handover(repo) })
    expect(statSync(first).mode).toBe(mode)
    for (const path of BMAD_PARSER_PATHS) expect(readFileSync(join(repo, path))).toEqual(original)
  })
  it('recovers every durable phase, preserves ambiguous reversions and refuses later edits or active copies on rollback', async () => {
    for (const boundary of ['prepared', 'writing', 'replaced', 'written', 'complete']) {
      const repo = fixture(); let stopped = false
      await expect(prepareBmadCopy({ repo, handover: handover(repo), seam: phase => { if (!stopped && phase === boundary) { stopped = true; throw new Error('interrupted') } } })).rejects.toThrow('interrupted')
      if (boundary !== 'complete') expect(() => preparedBmadProof(repo)).toThrow('incomplete')
      if (boundary === 'writing') {
        await expect(prepareBmadCopy({ repo, handover: handover(repo) })).rejects.toMatchObject({ code: 'BMAD_PREPARATION_UNCERTAIN' })
      } else {
        expect(await prepareBmadCopy({ repo, handover: handover(repo) })).toEqual(preparedBmadProof(repo))
        if (boundary === 'replaced') {
          let stoppedRollback = false
          await expect(rollbackBmadPreparation({ repo, handover: handover(repo), seam: phase => { if (!stoppedRollback && phase === 'rollback-replaced') { stoppedRollback = true; throw new Error('interrupted rollback') } } })).rejects.toThrow('interrupted rollback')
          expect((await rollbackBmadPreparation({ repo, handover: handover(repo) })).outcome).toBe('rolled-back')
        }
      }
    }
    const repo = fixture(); await prepareBmadCopy({ repo, handover: handover(repo) })
    file(repo, 'plan/bmad-copy.json', '{"active":true}')
    await expect(rollbackBmadPreparation({ repo, handover: handover(repo) })).rejects.toMatchObject({ code: 'BMAD_PREPARATION_IN_USE' })
    rmSync(join(repo, 'plan'), { recursive: true }); writeFileSync(join(repo, BMAD_PARSER_PATHS[1]), '# later edit\n')
    await expect(rollbackBmadPreparation({ repo, handover: handover(repo) })).rejects.toMatchObject({ code: 'BMAD_PREPARATION_DIVERGED' })
    expect(readFileSync(join(repo, BMAD_PARSER_PATHS[1]), 'utf8')).toBe('# later edit\n')
    const direct = fixture(); await prepareBmadCopy({ repo: direct, handover: handover(direct) })
    file(direct, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  7-1-one: deferred\n')
    await expect(rollbackBmadPreparation({ repo: direct, handover: handover(direct) })).rejects.toMatchObject({ code: 'BMAD_PREPARATION_IN_USE' })
  })
})
