// MODULE: plan-bmad-sync.test.mjs - Epic108 D25 two-way board sync with full-note preservation and approval holds
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolvePlan, rowToken } from '../../apps/desktop/bin/plan-board.mjs'
import * as copy from '../../apps/desktop/bin/plan-bmad-copy.mjs'
import { publishPlan, publicationState } from '../../apps/desktop/bin/plan-publish.mjs'
import { approvalText, recordGo } from '../../apps/desktop/bin/plan-cli.mjs'
import { stagePlan } from '../plan/migrate-bmad-plan.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
async function fixture(note = 'original') {
  const root = mkdtempSync(join(tmpdir(), 'bmn-sync-')); roots.push(root)
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-qb', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 's@example.invalid')
  mkdirSync(join(root, '_bmad-output/implementation-artifacts'), { recursive: true }); mkdirSync(join(root, 'plan/epics'), { recursive: true })
  const target = join(root, '_bmad-output/implementation-artifacts/sprint-status.yaml'), board = join(root, 'plan/status.yaml'), record = join(root, 'plan/bmad-copy.json')
  writeFileSync(target, `# Original bytes\r\ndevelopment_status:\r\n  epic-7: backlog\r\n  7-1-one: optional # ${note}\r\n`)
  const projected = [...note].slice(0, 160).join('')
  writeFileSync(board, `format: bmn-plan\nschema_version: 1\nbmad_board: _bmad-output/implementation-artifacts/sprint-status.yaml\nbmad_copy: true\nqueue: []\ndevelopment_status:\n  epic-7: backlog\n  7-1-one: backlog # ${projected}\n`)
  writeFileSync(join(root, 'plan/epics/007-probe.md'), '# Epic 7: Probe\n## Run needs\n- **Money cap:** none.\n## Decisions\nSynthetic.\n## Stories\n### Story 7.1: Probe\n')
  const entry = (key, status, oldStatus, text) => ({ last_copied: { status: oldStatus, note: text }, source_value: { status, note: [...text].slice(0, 160).join('') }, source_token: rowToken(key, status, [...text].slice(0, 160).join('')) })
  writeFileSync(record, JSON.stringify({ version: 2, source_board: '_bmad-output/implementation-artifacts/sprint-status.yaml', rows: { 'epic-7': entry('epic-7', 'backlog', 'backlog', ''), '7-1-one': entry('7-1-one', 'backlog', 'optional', note) }, excluded: {}, unresolved: {}, holds: {} }))
  git('add', '.'); git('commit', '-qm', 'Synthetic sync baseline')
  return { root, board, target, record, plan: await resolvePlan(root), git, environment: { XDG_STATE_HOME: join(root, 'state') } }
}
const replace = (path, before, after) => writeFileSync(path, readFileSync(path, 'utf8').replace(before, after))

it('maintains the ready and finished queue through CLI sync and recovered journals', async () => {
  const f = await fixture(), bmn = new URL('../../apps/desktop/bin/bmn', import.meta.url).pathname
  writeFileSync(f.board, readFileSync(f.board, 'utf8').replace('queue: []', 'queue:\n  - 9\n  - 8') + '  epic-8: in-progress\n  epic-9: in-progress\n')
  const cli = (...args) => {
    const p = spawnSync(process.execPath, [bmn, 'plan', ...args, '--project', f.root, '--json'], { encoding: 'utf8' })
    return { exit: p.status, value: JSON.parse(p.stdout) }
  }
  replace(f.target, 'epic-7: backlog', 'epic-7: ready-for-dev')
  expect(cli('sync').exit).toBe(0)
  expect(readFileSync(f.board, 'utf8')).toContain('queue:\n  - 9\n  - 8\n  - 7')
  expect(JSON.stringify(cli('check').value)).not.toMatch(/ready but not in queue|queue names epic/u)
  replace(f.target, 'epic-7: ready-for-dev', 'epic-7: done')
  await copy.syncPlan(f.plan, { seam: phase => { if (phase === 'plan-replaced') throw new Error('synthetic interruption') } })
  expect(cli('sync').exit).toBe(0)
  expect(readFileSync(f.board, 'utf8')).toContain('queue:\n  - 9\n  - 8\ndevelopment_status:')
  expect(JSON.stringify(cli('check').value)).not.toMatch(/ready but not in queue|queue names epic/u)
})

it('imports Artem edits, exports plan edits and creates new rows in both directions through the real CLI', async () => {
  const f = await fixture(), bmn = new URL('../../apps/desktop/bin/bmn', import.meta.url).pathname
  replace(f.target, 'optional # original', 'review # Artem')
  const cli = (...args) => { const p = spawnSync(process.execPath, [bmn, 'plan', ...args, '--project', f.root, '--json'], { encoding: 'utf8' }); return { exit: p.status, value: JSON.parse(p.stdout) } }
  expect(cli('sync').exit).toBe(0)
  expect(readFileSync(f.board, 'utf8')).toContain('7-1-one: review # Artem')
  expect(cli('set', '7-1-one', 'done', '--expect', rowToken('7-1-one', 'review', 'Artem')).exit).toBe(0)
  expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: done # Artem\r\n')
  writeFileSync(f.board, readFileSync(f.board, 'utf8') + '  epic-8: backlog\n')
  writeFileSync(f.target, readFileSync(f.target, 'utf8') + '  7-2-new: drafted\r\n')
  expect(cli('sync').exit).toBe(0)
  expect(readFileSync(f.target, 'utf8')).toContain('epic-8: backlog\r\n')
  expect(readFileSync(f.board, 'utf8')).toContain('7-2-new: backlog')
  const before = [readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8'), readFileSync(f.record, 'utf8')]
  expect(cli('sync').exit).toBe(0)
  expect([readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8'), readFileSync(f.record, 'utf8')]).toEqual(before)
})
it.each([160, 161, 1000])('keeps the full %i-character BMAD note and aliases on status-only roundtrips', async size => {
  const note = '🙂'.repeat(size), f = await fixture(note)
  await copy.syncPlan(f.plan, { environment: f.environment })
  replace(f.target, 'optional', 'review')
  await copy.syncPlan(f.plan, { environment: f.environment })
  expect(readFileSync(f.board, 'utf8')).toContain('7-1-one: review # ' + '🙂'.repeat(Math.min(size, 160)))
  await copy.setWithCopy(f.plan, { key: '7-1-one', status: 'done', expect: rowToken('7-1-one', 'review', '🙂'.repeat(Math.min(size, 160))), environment: f.environment })
  expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: done # ' + note + '\r\n')
  await copy.setWithCopy(f.plan, { key: '7-1-one', status: 'done', note: '', expect: rowToken('7-1-one', 'done', '🙂'.repeat(Math.min(size, 160))), environment: f.environment })
  expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: done\r\n')
})
it('syncs before set and refuses its stale token instead of overwriting the imported change', async () => {
  const f = await fixture(); replace(f.target, 'optional # original', 'review # changed')
  expect(await copy.setWithCopy(f.plan, { key: '7-1-one', status: 'done', expect: rowToken('7-1-one', 'backlog', 'original'), environment: f.environment })).toMatchObject({ outcome: 'conflict' })
  expect(readFileSync(f.board, 'utf8')).toContain('7-1-one: review # changed')
})
it('settles both changed rows further along and records both originals once', async () => {
  const f = await fixture(); replace(f.target, 'optional # original', 'done # Artem'); replace(f.board, 'backlog # original', 'review # owner')
  await copy.syncPlan(f.plan, { environment: f.environment })
  expect(readFileSync(f.board, 'utf8')).toContain('7-1-one: done # Artem')
  const meta = JSON.parse(readFileSync(f.record, 'utf8'))
  expect(meta.rows['7-1-one'].conflicts).toHaveLength(1)
  expect(meta.rows['7-1-one'].conflicts[0]).toMatchObject({ plan: { status: 'review', note: 'owner' }, bmad: { status: 'done', note: 'Artem' } })
})
it('holds a disputed go before any story write; status sees it and publish never checkpoints or reads policy', async () => {
  const f = await fixture(); replace(f.board, 'epic-7: backlog', 'epic-7: ready # go 2026-11-05'); replace(f.target, 'optional # original', 'done # Artem')
  const before = [readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')], head = f.git('rev-parse', 'HEAD')
  expect(publicationState(f.plan).conflicts).toContain(7)
  expect((await copy.syncPlan(f.plan)).findings).toContainEqual(expect.objectContaining({ code: 'COPY_APPROVAL_HOLD' }))
  expect([readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')]).toEqual(before)
  expect(await publishPlan(f.plan, { readPolicy: () => { throw new Error('must not read policy') } })).toMatchObject({ error: 'COPY_APPROVAL_HOLD' })
  expect(f.git('rev-parse', 'HEAD')).toBe(head)
})
it('holds baselined deletions rather than silently recreating removed work', async () => {
  const f = await fixture(); replace(f.target, '  7-1-one: optional # original\r\n', '')
  expect((await copy.syncPlan(f.plan)).findings).toContainEqual(expect.objectContaining({ code: 'COPY_ROW_MISSING' }))
  expect(readFileSync(f.target, 'utf8')).not.toContain('7-1-one')
})
it.each(['standing-go', 'mismatch', 'withdrawal', 'deletion'])('acknowledges a quiesced %s resolution without clearing sibling holds or creating approval', async mode => {
  const f = await fixture()
  replace(f.board, 'epic-7: backlog', 'epic-7: ready # go 2026-11-05')
  await copy.syncPlan(f.plan, { environment: f.environment })
  let meta = JSON.parse(readFileSync(f.record, 'utf8'))
  const originalHold = structuredClone(meta.holds['7'])
  meta.holds['8'] = { code: 'COPY_APPROVAL_HOLD', key: 'epic-8', reason: 'independent sibling dispute' }
  writeFileSync(f.record, JSON.stringify(meta))
  if (mode === 'standing-go') replace(f.target, 'epic-7: backlog', 'epic-7: ready-for-dev # go 2026-11-05')
  if (mode === 'withdrawal') {
    replace(f.board, 'epic-7: ready # go 2026-11-05', 'epic-7: backlog # go 2026-11-05')
    replace(f.target, 'epic-7: backlog', 'epic-7: backlog # go 2026-11-05')
    meta.rows['epic-7'] = { last_copied: { status: 'backlog', note: 'go 2026-11-05' }, source_value: { status: 'backlog', note: 'go 2026-11-05' }, source_token: rowToken('epic-7', 'backlog', 'go 2026-11-05') }
  }
  if (mode === 'deletion') {
    replace(f.board, '  epic-7: ready # go 2026-11-05\n', '')
    replace(f.target, '  epic-7: backlog\r\n', '')
    meta.rows['epic-7'] = { last_copied: null, source_value: null, source_token: null }
  }
  // Models the documented manual acknowledgement after all writers have stopped.
  meta.resolutions = [{ epic: 7, original_hold: originalHold, reason: `synthetic owner ${mode}` }]
  delete meta.holds['7']; writeFileSync(f.record + '.tmp', JSON.stringify(meta));
  const { renameSync } = await import('node:fs'); renameSync(f.record + '.tmp', f.record)
  f.git('add', '.'); f.git('commit', '-qm', 'Synthetic explicit resolution')
  const findings = (await copy.syncPlan(f.plan, { environment: f.environment })).findings
  expect(findings.filter(finding => finding.key === 'epic-7')).toHaveLength(mode === 'mismatch' ? 1 : 0)
  meta = JSON.parse(readFileSync(f.record, 'utf8'))
  expect(meta.holds['8']).toMatchObject({ reason: 'independent sibling dispute' })
  expect(meta.resolutions[0].original_hold).toEqual(originalHold)
  if (mode === 'withdrawal') expect(readFileSync(f.target, 'utf8')).toContain('epic-7: backlog # go 2026-11-05')
  if (mode === 'deletion') expect(readFileSync(f.target, 'utf8')).not.toContain('epic-7:')
})
it('preserves an existing over-limit historical note without rejecting unrelated sync or status-only changes', async () => {
  const f = await fixture('x'.repeat(1058))
  expect((await copy.syncPlan(f.plan)).findings).toEqual([])
  await copy.setWithCopy(f.plan, { key: '7-1-one', status: 'review', expect: rowToken('7-1-one', 'backlog', 'x'.repeat(160)) })
  expect(readFileSync(f.target, 'utf8')).toContain('7-1-one: review # ' + 'x'.repeat(1058))
})
it('copies a recorded Go, and recovers its original operation after an interrupted commit', async () => {
  const f = await fixture(), epic = readFileSync(join(f.root, 'plan/epics/007-probe.md'), 'utf8')
  const options = { epic: 7, source: '"Go" 2026-11-05T17:00', approved: `sha256:${approvalText(epic)}`, expect: rowToken('epic-7', 'backlog', '') }
  await expect(recordGo(f.plan, { ...options, seam: phase => { if (phase === 'committed') throw new Error('interrupted after commit') } })).rejects.toThrow('interrupted after commit')
  expect((await copy.syncPlan(f.plan)).findings).toContainEqual(expect.objectContaining({ code: 'COPY_GO_PENDING' }))
  const result = await recordGo(f.plan, options)
  expect(result.pending).toBe(false)
  expect(readFileSync(f.target, 'utf8')).toContain('epic-7: ready-for-dev # go 2026-11-05')
  expect((await copy.syncPlan(f.plan)).findings).toEqual([])
})
it('recovers a prepared recorded-Go journal through its original Go retry, including a preflight-created hold', async () => {
  const f = await fixture(), epic = readFileSync(join(f.root, 'plan/epics/007-probe.md'), 'utf8')
  const options = { epic: 7, source: '"Go" 2026-11-05T17:00', approved: `sha256:${approvalText(epic)}`, expect: rowToken('epic-7', 'backlog', '') }
  await expect(recordGo(f.plan, { ...options, copySeam: phase => { if (phase === 'prepared') throw new Error('copy prepared interruption') } })).rejects.toThrow('copy prepared interruption')
  expect((await copy.syncPlan(f.plan)).findings).toContainEqual(expect.objectContaining({ code: 'COPY_APPROVAL_HOLD' }))
  expect((await recordGo(f.plan, options)).pending).toBe(false)
  expect(readFileSync(f.target, 'utf8')).toContain('epic-7: ready-for-dev # go 2026-11-05')
  expect((await copy.syncPlan(f.plan)).findings).toEqual([])
})
it('copies a new plan epic before its first Go without losing the recorded readiness', async () => {
  const f = await fixture(), epic = readFileSync(join(f.root, 'plan/epics/007-probe.md'), 'utf8').replaceAll('7', '8')
  writeFileSync(join(f.root, 'plan/epics/008-probe.md'), epic)
  writeFileSync(f.board, readFileSync(f.board, 'utf8') + '  epic-8: backlog\n')
  f.git('add', 'plan'); f.git('commit', '-qm', 'new plan epic')
  expect((await recordGo(f.plan, { epic: 8, source: '"Go" 2026-11-05T17:00', approved: `sha256:${approvalText(epic)}`, expect: rowToken('epic-8', 'backlog', '') })).pending).toBe(false)
  expect(readFileSync(f.target, 'utf8')).toContain('epic-8: ready-for-dev # go 2026-11-05')
  expect((await copy.syncPlan(f.plan)).findings).toEqual([])
})
it('seeds a deleted captured row from the pinned BMAD baseline and holds it instead of importing it as new', async () => {
  const f = await fixture(), original = readFileSync(f.target, 'utf8') + '  7-2-retired: review # original\r\n'
  mkdirSync(join(f.root, '_bmad-output/planning-artifacts'), { recursive: true })
  writeFileSync(join(f.root, '_bmad-output/planning-artifacts/epics.md'), '# Epics\n\n## Epic 7: Probe\n\n### Story 7.1: One\n')
  writeFileSync(f.target, original); f.git('add', '.'); f.git('commit', '-qm', 'pinned baseline')
  replace(f.target, '  7-2-retired: review # original\r\n', '')
  const stage = join(f.root, 'stage/plan')
  stagePlan({ repo: f.root, stage, keepBmad: true, historyHead: f.git('rev-parse', 'HEAD') })
  cpSync(stage, join(f.root, 'plan'), { recursive: true })
  const meta = JSON.parse(readFileSync(f.record, 'utf8')); meta.active = true; writeFileSync(f.record, JSON.stringify(meta))
  expect(meta.rows['7-2-retired']).toMatchObject({ last_copied: { status: 'review', note: 'original' } })
  expect(readFileSync(f.board, 'utf8')).not.toContain('7-2-retired:')
  writeFileSync(f.target, original)
  const before = [readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')]
  expect((await copy.syncPlan(f.plan)).findings).toContainEqual(expect.objectContaining({ code: 'COPY_ROW_MISSING', key: '7-2-retired' }))
  expect([readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')]).toEqual(before)
})
it.each(['from-bmad', 'to-bmad', 'conflict', 'append'])('recovers immutable %s intent or retains an uncertain write at every journal boundary', async direction => {
  for (const boundary of ['prepared', 'plan-writing', 'plan-replaced', 'plan-written', 'target-writing', 'target-replaced', 'target-written', 'record-writing', 'record-replaced', 'complete']) {
    const f = await fixture()
    if (direction === 'from-bmad') replace(f.target, 'optional # original', 'review # import')
    if (direction === 'to-bmad') replace(f.board, 'backlog # original', 'review # export')
    if (direction === 'conflict') { replace(f.board, 'backlog # original', 'review # owner'); replace(f.target, 'optional # original', 'done # Artem') }
    if (direction === 'append') writeFileSync(f.board, readFileSync(f.board, 'utf8') + '  7-2-new: backlog\n')
    let reached = false
    await copy.syncPlan(f.plan, { environment: f.environment, seam: phase => { if (phase === boundary) { reached = true; throw new Error('interruption') } } })
    const recovered = await copy.syncPlan(f.plan, { environment: f.environment })
    const uncertain = reached && ['plan-writing', 'target-writing', 'record-writing'].includes(boundary)
    if (uncertain) expect(recovered.findings, direction + boundary).toContainEqual(expect.objectContaining({ code: 'COPY_UNCERTAIN' }))
    else {
      expect(recovered.findings, direction + boundary).toEqual([])
      if (direction === 'append') expect(readFileSync(f.target, 'utf8').match(/7-2-new:/gu)).toHaveLength(1)
      else expect(readFileSync(f.board, 'utf8')).toContain(`7-1-one: ${direction === 'conflict' ? 'done' : 'review'}`)
    }
  }
}, 30_000)
it('preflights a later-sorting disputed epic before recovering its pending story journal', async () => {
  const f = await fixture()
  replace(f.board, 'backlog # original', 'review # owner')
  await copy.syncPlan(f.plan, { seam: phase => { if (phase === 'prepared') throw new Error('interrupted') } })
  replace(f.board, 'epic-7: backlog', 'epic-7: ready # go 2026-11-05')
  const before = [readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')]
  expect((await copy.syncPlan(f.plan)).findings).toContainEqual(expect.objectContaining({ code: 'COPY_APPROVAL_HOLD' }))
  expect([readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')]).toEqual(before)
})
it('uses the complete deterministic status order on concurrent edits, and imports unilateral regressions', async () => {
  const statuses = { backlog: 'backlog', ready: 'ready-for-dev', 'in-progress': 'in-progress', review: 'review', done: 'done', paused: 'deferred', blocked: 'blocked', dropped: 'withdrawn' }
  const order = Object.keys(statuses), f = await fixture(), baseline = readFileSync(f.record, 'utf8')
  for (const mine of order) for (const other of order) {
    writeFileSync(f.record, baseline)
    writeFileSync(f.board, readFileSync(f.board, 'utf8').replace(/^ {2}7-1-one:.*$/mu, `  7-1-one: ${mine} # owner`))
    writeFileSync(f.target, readFileSync(f.target, 'utf8').replace(/^ {2}7-1-one:[^\r\n]*/mu, `  7-1-one: ${statuses[other]} # Artem`))
    expect((await copy.syncPlan(f.plan)).findings).toEqual([])
    const winner = order.indexOf(other) > order.indexOf(mine) ? `${other} # Artem` : `${mine} # owner`
    expect(readFileSync(f.board, 'utf8'), mine + '/' + other).toContain(`7-1-one: ${winner}`)
  }
  replace(f.target, /^ {2}7-1-one:[^\r\n]*/mu, '  7-1-one: backlog # unilateral regression')
  await copy.syncPlan(f.plan)
  expect(readFileSync(f.board, 'utf8')).toContain('7-1-one: backlog # unilateral regression')
})
it('imports tail-only long-note edits and detects a full-note withdrawal beyond the visible projection', async () => {
  const f = await fixture('🙂'.repeat(161))
  replace(f.target, '🙂'.repeat(161), '🙂'.repeat(160) + 'TAIL')
  expect((await copy.syncPlan(f.plan)).findings).toEqual([])
  expect(JSON.parse(readFileSync(f.record, 'utf8')).rows['7-1-one'].last_copied.note).toContain('TAIL')
  const meta = JSON.parse(readFileSync(f.record, 'utf8')), rawNote = 'x'.repeat(161) + ' go 2026-11-05'
  meta.rows['epic-7'] = { last_copied: { status: 'in-progress', note: rawNote }, source_value: { status: 'in-progress', note: 'x'.repeat(160) }, source_token: rowToken('epic-7', 'in-progress', 'x'.repeat(160)) }
  writeFileSync(f.record, JSON.stringify(meta))
  replace(f.board, 'epic-7: backlog', 'epic-7: in-progress # ' + 'x'.repeat(160))
  replace(f.target, 'epic-7: backlog', 'epic-7: in-progress # ' + rawNote)
  expect((await copy.syncPlan(f.plan)).findings).toEqual([])
  replace(f.target, 'epic-7: in-progress', 'epic-7: backlog')
  const before = [readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')]
  expect((await copy.syncPlan(f.plan)).findings).toContainEqual(expect.objectContaining({ code: 'COPY_APPROVAL_HOLD' }))
  expect([readFileSync(f.board, 'utf8'), readFileSync(f.target, 'utf8')]).toEqual(before)
})
