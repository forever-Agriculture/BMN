// MODULE: plan-bmad-copy.test.mjs - D10 one-way copy, protected rows and recoverable value-based transactions
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rowToken, resolvePlan } from '../../apps/desktop/bin/plan-board.mjs'
import { approvalText, recordGo } from '../../apps/desktop/bin/plan-cli.mjs'
import { copyFindings, copyRow, copyToken, setWithCopy } from '../../apps/desktop/bin/plan-bmad-copy.mjs'
import { publishPlan } from '../../apps/desktop/bin/plan-publish.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
function file(repo, path, text) { const full = join(repo, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, text); return full }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-copy-')); roots.push(root)
  git(root, 'init', '-qb', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'f@example.invalid')
  const target = '_bmad-output/implementation-artifacts/sprint-status.yaml'
  const before = '# Keep every byte\r\ndevelopment_status:\r\n  epic-7: backlog\r\n  7-1-one: optional # old note\r\n  7-2-artem: ready-for-dev # Artem\r\n  target-only: backlog # theirs\r\n'
  file(root, target, before)
  const board = file(root, 'plan/status.yaml', `format: bmn-plan\nschema_version: 1\nbmad_board: ${target}\nbmad_copy: true\nqueue: []\ndevelopment_status:\n  epic-7: backlog\n  7-1-one: backlog # old note\n  7-2-artem: ready # Artem\n`)
  const epic = '# Epic 7: Probe\n## Run needs\n- **Money cap:** none.\n## Decisions\nSynthetic.\n## Stories\n### Story 7.1: Probe\n'
  file(root, 'plan/epics/007-probe.md', epic)
  const metadata = { version: 1, source_board: target, rows: {
    'epic-7': { last_copied: { status: 'backlog', note: '' }, source_token: rowToken('epic-7', 'backlog', ''), provenance: { author: 'Fixture', commit: 'fixture' } },
    '7-1-one': { last_copied: { status: 'optional', note: 'old note' }, source_token: rowToken('7-1-one', 'backlog', 'old note'), provenance: { author: 'Fixture', commit: 'fixture' } }
  }, excluded: { '7-2-artem': { author: 'Artem Kobrin', commit: 'fixture' } }, unresolved: {} }
  file(root, 'plan/bmad-copy.json', JSON.stringify(metadata, null, 2) + '\n')
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'copy fixture')
  const plan = await resolvePlan(root)
  return { root, target: join(root, target), board, plan, before, epic, environment: { XDG_STATE_HOME: join(root, 'state') } }
}

describe('D10 BMAD copy', () => {
  it('refuses publication before checkpointing an ambiguous copy journal', async () => {
    const f = await fixture(), before = git(f.root, 'rev-parse', 'HEAD')
    await expect(setWithCopy(f.plan, { key: '7-1-one', status: 'paused', expect: rowToken('7-1-one', 'backlog', 'old note'), environment: f.environment, seam: phase => { if (phase === 'plan-writing') throw new Error('interrupted') } })).rejects.toThrow('interrupted')
    let policyReads = 0
    expect(await publishPlan(f.plan, { direct: true, readPolicy: async () => { policyReads++; throw new Error('must not reach external writes') } })).toMatchObject({ outcome: 'unpublished', error: 'COPY_UNCERTAIN' })
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(f.target, 'utf8')).toBe(f.before); expect(policyReads).toBe(0)
  })
  it('retries a committed Go through its existing completion logic and discards definitely withdrawn copy intent', async () => {
    for (const withdraw of [false, true]) {
      const f = await fixture(), options = { epic: 7, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-7', 'backlog', '') }
      await expect(recordGo(f.plan, { ...options, seam: phase => { if (phase === 'committed') throw new Error('lead interrupted after authoritative commit') } })).rejects.toThrow('interrupted')
      expect(await copyFindings(f.plan, { recover: true })).toContainEqual(expect.objectContaining({ code: 'COPY_GO_PENDING' }))
      if (withdraw) {
        await setWithCopy(f.plan, { key: 'epic-7', status: 'dropped', note: 'withdrawn by owner', expect: options.expect, environment: f.environment })
        await expect(recordGo(f.plan, options)).rejects.toMatchObject({ code: 'WITHDRAWN' })
        expect(readFileSync(f.target, 'utf8')).toContain('epic-7: withdrawn # withdrawn by owner')
      } else {
        expect((await recordGo(f.plan, options)).pending).toBe(false)
        expect(readFileSync(f.target, 'utf8')).toContain('epic-7: ready-for-dev')
      }
      expect(await copyFindings(f.plan, { recover: true })).toEqual([])
    }
  })
  it('drives CLI set, conflict check and explicit copy with a fresh token', async () => {
    const f = await fixture(), bmn = new URL('../../apps/desktop/bin/bmn', import.meta.url).pathname
    const cli = args => {
      const result = spawnSync(process.execPath, [bmn, 'plan', ...args, '--project', f.root, '--json'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(f.root, 'state') } })
      return { exit: result.status, value: JSON.parse(result.stdout) }
    }
    writeFileSync(f.target, f.before.replace('optional # old note', 'done # independent target edit'))
    const set = cli(['set', '7-1-one', 'review', '--expect', rowToken('7-1-one', 'backlog', 'old note')])
    expect(set.exit).toBe(0); expect(set.value.copy.outcome).toBe('COPY_CONFLICT')
    const check = cli(['check']), finding = check.value.findings.find(one => one.code === 'COPY_CONFLICT')
    expect(finding.key).toBe('7-1-one')
    expect(cli(['copy', '--row', finding.key, '--expect', finding.token]).exit).toBe(0)
    expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: review # old note')
    expect(cli(['check']).value.findings.some(one => one.code?.startsWith('COPY_'))).toBe(false)
  })
  it('uses real CLI recovery after SIGKILL at each copy write boundary', async () => {
    const module = new URL('../../apps/desktop/bin/plan-bmad-copy.mjs', import.meta.url).href, boardModule = new URL('../../apps/desktop/bin/plan-board.mjs', import.meta.url).href
    const bmn = new URL('../../apps/desktop/bin/bmn', import.meta.url).pathname
    for (const boundary of ['prepared', 'plan-writing', 'plan-replaced', 'plan-written', 'target-writing', 'target-replaced', 'target-written', 'record-writing', 'record-replaced', 'complete']) {
      const f = await fixture(), code = `import{setWithCopy}from ${JSON.stringify(module)};import{resolvePlan,rowToken}from ${JSON.stringify(boardModule)};import{readFileSync}from'node:fs';
await setWithCopy(await resolvePlan(${JSON.stringify(f.root)}),{key:'7-1-one',status:'review',expect:rowToken('7-1-one','backlog','old note'),environment:{XDG_STATE_HOME:${JSON.stringify(join(f.root, 'state'))}},seam:async phase=>{if(phase!==${JSON.stringify(boundary)})return;const stat=readFileSync('/proc/'+process.pid+'/stat','utf8');console.log(JSON.stringify({pid:process.pid,start_ticks:stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19]}));await new Promise(()=>setInterval(()=>{},1000));}});`
      const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] })
      const identity = await new Promise((resolve, reject) => {
        let out = '', err = ''
        child.stderr.on('data', bytes => { err += bytes.toString() })
        child.stdout.on('data', bytes => { out += bytes.toString(); if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0])) })
        child.once('exit', () => reject(new Error('copy exited before boundary: ' + err)))
      })
      if (process.env.BMN_CUTOVER_RESOURCE_LOG) appendFileSync(process.env.BMN_CUTOVER_RESOURCE_LOG, JSON.stringify({ kind: 'process', ...identity, command: `Epic107 copy crash lead at ${boundary}` }) + '\n')
      const exited = once(child, 'exit')
      execFileSync('python3', ['-c', "import os,sys,signal; from pathlib import Path; pid=int(sys.argv[1]); fd=os.pidfd_open(pid); observed=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]; assert observed==sys.argv[2]; signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd)", String(identity.pid), identity.start_ticks])
      await exited
      const result = spawnSync(process.execPath, [bmn, 'plan', 'check', '--project', f.root, '--json'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(f.root, 'state') } })
      const findings = JSON.parse(result.stdout).findings.filter(one => one.code?.startsWith('COPY_'))
      if (['plan-writing', 'target-writing', 'record-writing'].includes(boundary)) expect(findings, boundary).toContainEqual(expect.objectContaining({ code: 'COPY_UNCERTAIN' }))
      else {
        expect(findings, boundary).toEqual([])
        expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: review')
      }
    }
  }, 30_000)
  it('copies each status one row at a time while retaining every unrelated byte and initial original words', async () => {
    const f = await fixture(), key = '7-1-one'
    expect(readFileSync(f.target, 'utf8')).toBe(f.before)
    expect(await copyFindings(f.plan)).toEqual([])
    let token = rowToken(key, 'backlog', 'old note')
    for (const [status, mapped] of Object.entries({ ready: 'ready-for-dev', 'in-progress': 'in-progress', review: 'review', done: 'done', blocked: 'blocked', paused: 'deferred', dropped: 'withdrawn', backlog: 'backlog' })) {
      const result = await setWithCopy(f.plan, { key, status, note: 'copied note', expect: token, environment: f.environment })
      token = result.token
      expect(readFileSync(f.target, 'utf8')).toBe(f.before.replace('  7-1-one: optional # old note', `  7-1-one: ${mapped} # copied note`))
      expect(await copyFindings(f.plan)).toEqual([])
    }
  })
  it('keeps Artem changes, updates the canonical row, and requires a fresh combined token to overwrite', async () => {
    const f = await fixture(), key = '7-1-one', stale = await copyToken(f.plan, key)
    writeFileSync(f.target, f.before.replace('optional # old note', 'in-progress # Artem changed this'))
    const result = await setWithCopy(f.plan, { key, status: 'review', expect: rowToken(key, 'backlog', 'old note'), environment: f.environment })
    expect(result.copy.outcome).toBe('COPY_CONFLICT')
    expect(readFileSync(f.board, 'utf8')).toContain('7-1-one: review')
    expect(readFileSync(f.target, 'utf8')).toContain('in-progress # Artem changed this')
    const findings = await copyFindings(f.plan)
    expect(findings).toContainEqual(expect.objectContaining({ code: 'COPY_CONFLICT', key }))
    await expect(copyRow(f.plan, { key, expect: stale })).rejects.toMatchObject({ code: 'COPY_STALE' })
    await copyRow(f.plan, { key, expect: findings.find(f => f.key === key).token })
    expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: review # old note')
    expect(await copyFindings(f.plan)).toEqual([])
  })
  it('never copies protected or target-only rows and preserves independent target edits during a transaction', async () => {
    const f = await fixture()
    await setWithCopy(f.plan, { key: '7-2-artem', status: 'done', expect: rowToken('7-2-artem', 'ready', 'Artem'), environment: f.environment })
    expect(readFileSync(f.target, 'utf8')).toBe(f.before)
    for (const key of ['7-2-artem', 'target-only']) await expect(copyRow(f.plan, { key, expect: 'anything' })).rejects.toMatchObject({ code: 'COPY_PROTECTED' })
    await setWithCopy(f.plan, { key: '7-1-one', status: 'review', expect: rowToken('7-1-one', 'backlog', 'old note'), environment: f.environment, seam: phase => {
      if (phase === 'plan-written') writeFileSync(f.target, readFileSync(f.target, 'utf8').replace('target-only: backlog # theirs', 'target-only: done # independent edit'))
    } })
    expect(readFileSync(f.target, 'utf8')).toContain('target-only: done # independent edit')
  })
  it('finishes consistent interrupted transactions or reports an uncertain attempted write', async () => {
    for (const boundary of ['prepared', 'plan-writing', 'plan-written', 'target-writing', 'target-written', 'record-writing', 'complete']) {
      const f = await fixture(), key = '7-1-one'
      await expect(setWithCopy(f.plan, { key, status: 'review', expect: rowToken(key, 'backlog', 'old note'), environment: f.environment, seam: phase => { if (phase === boundary) throw new Error('simulated interruption') } })).rejects.toThrow('simulated interruption')
      const findings = await copyFindings(f.plan, { recover: true, environment: f.environment })
      if (['plan-writing', 'target-writing', 'record-writing'].includes(boundary)) expect(findings).toContainEqual(expect.objectContaining({ code: 'COPY_UNCERTAIN' }))
      else {
        expect(findings).toEqual([])
        expect(readFileSync(f.board, 'utf8')).toContain('7-1-one: review')
        expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: review')
      }
    }
  })
  it('copies a successful Go and reports a pending Go without copying stale readiness', async () => {
    const f = await fixture(), options = { epic: 7, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-7', 'backlog', '') }
    const result = await recordGo(f.plan, options)
    expect(result.pending).toBe(false)
    expect(readFileSync(f.target, 'utf8')).toContain('epic-7: ready-for-dev # go 2026-11-04')
    expect(await copyFindings(f.plan)).toEqual([])
    const pending = await fixture()
    const first = await recordGo(pending.plan, { ...options, seam: phase => { if (phase === 'committed') writeFileSync(pending.board, readFileSync(pending.board, 'utf8').replace('epic-7: backlog', 'epic-7: in-progress # changed after commit')) } })
    expect(first.pending).toBe(true)
    expect(readFileSync(pending.target, 'utf8')).toBe(pending.before)
    expect(await copyFindings(pending.plan, { recover: true })).toContainEqual(expect.objectContaining({ code: 'COPY_GO_PENDING' }))
  })
})
