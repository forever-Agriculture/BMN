// MODULE: bench-qa-record.mjs - pre-run input binding and post-cleanup lead-run evidence receipt
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { atomicJson } from './bench-lib.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))

export function prepareBenchQa({ options, run, runId, candidateSha256 }) {
  if (!options['qa-brief']) return undefined
  if (!candidateSha256) throw new Error('Lead-run QA requires a built candidate (--no-build or --binary)')
  const brief = read(resolve(options['qa-brief'])), seedBytes = readFileSync(resolve(options['qa-seed'])), seed = JSON.parse(seedBytes)
  if (brief.version !== 1 || brief.mode !== 'quick-bench' || brief.target !== 'bmn-bench:pending' || brief.accounts?.length !== 0 ||
      !brief.revision || typeof seed.id !== 'string' || !seed.id.trim()) throw new Error('Expected a signed-out V1 quick-bench brief with pending target and a named synthetic seed')
  brief.target = `bmn-bench:${runId}`
  mkdirSync(join(run, 'qa'), { recursive: true }); mkdirSync(join(run, 'bench'), { recursive: true })
  atomicJson(join(run, 'qa/brief.json'), brief)
  // Normalize the seed once; its retained bytes, rather than the source's formatting, bind the fixture.
  atomicJson(join(run, 'bench/seed.json'), seed)
  const input = { version: 1, route: 'lead-bench', executor: 'lead', runId, revision: brief.revision, target: brief.target,
    candidateSha256, fixture: { id: seed.id, seedSha256: hash(readFileSync(join(run, 'bench/seed.json'))) },
    briefSha256: hash(readFileSync(join(run, 'qa/brief.json'))), startedAt: new Date().toISOString() }
  atomicJson(join(run, 'bench/input.json'), input)
  return input
}

export function finishBenchQa({ run, runId, reportPath }) {
  if (realpathSync(run) !== run) throw new Error('Bench evidence directory contains a symlink')
  const state = read(join(run, 'receipt.json')), completion = read(join(run, 'completion-proof.json')), input = read(join(run, 'bench/input.json'))
  if (state.runId !== runId || state.status !== 'stopped' || state.qaInput?.runId !== runId || JSON.stringify(state.qaInput) !== JSON.stringify(input) ||
      !completion.stopped || !completion.rootsDeleted || !completion.groupRemoved || completion.traces.some(item => !item.complete)) throw new Error('Bench cleanup or capture is incomplete')
  const report = read(resolve(reportPath))
  if (report.version !== 1 || report.mode !== 'quick-bench' || report.revision !== input.revision || report.target !== input.target) throw new Error('QA report differs from reserved target/revision')
  atomicJson(join(run, 'qa/report.json'), report)
  const artifact = path => {
    const full = join(run, path), name = relative(run, full)
    if (!name || name.startsWith('../') || realpathSync(full) !== full) throw new Error('Bench evidence path is foreign or symlinked')
    const raw = readFileSync(full)
    return { path: name, bytes: raw.length, sha256: hash(raw), runId }
  }
  const actions = readFileSync(join(run, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (!actions.length || actions.some(action => action.runId !== runId)) throw new Error('Bench action log has no bound generation')
  const shots = [...new Set(actions.map(action => action.result?.screenshot).filter(Boolean))].map(path => {
    if (!path.startsWith(run + '/')) throw new Error('Screenshot leaves bench evidence directory')
    return artifact(relative(run, path))
  })
  if (!shots.length) throw new Error('Bench receipt requires a captured screenshot')
  const launches = state.tracers.map(trace => ({ key: trace.key, role: trace.role, identity: trace.identity,
    trace: artifact(trace.file), certificate: artifact(trace.certificateFile) }))
  if (state.root && existsSync(state.root)) throw new Error('Bench workload root remains after cleanup')
  const receipt = { version: 1, route: 'lead-bench', executor: 'lead', runId, finishedAt: new Date().toISOString(),
    input: artifact('bench/input.json'), brief: artifact('qa/brief.json'), report: artifact('qa/report.json'), seed: artifact('bench/seed.json'),
    actions: artifact('actions.jsonl'), screenshots: shots, state: artifact('receipt.json'), completion: artifact('completion-proof.json'), launches }
  atomicJson(join(run, 'lead-bench.json'), receipt)
  return { receipt: join(run, 'lead-bench.json'), runId, revision: input.revision, target: input.target }
}
