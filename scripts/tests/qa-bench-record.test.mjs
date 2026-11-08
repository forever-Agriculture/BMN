// MODULE: qa-bench-record.test.mjs - inputs bind before launch; unfinished evidence cannot become a receipt
import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareBenchQa, finishBenchQa } from '../qa/bench-qa-record.mjs'
it('retains exact pre-run inputs and fixture before source files can change', () => {
  const run = mkdtempSync(join(tmpdir(), 'bmn-qa-record-'))
  try {
    const brief = { version: 1, mode: 'quick-bench', revision: 'candidate', target: 'bmn-bench:pending', accounts: [] }
    writeFileSync(join(run, 'source-brief.json'), JSON.stringify(brief)); writeFileSync(join(run, 'source-seed.json'), JSON.stringify({ id: 'seed-v1' }))
    const input = prepareBenchQa({ options: { 'qa-brief': join(run, 'source-brief.json'), 'qa-seed': join(run, 'source-seed.json') }, run, runId: '123-0123456789abcdef', candidateSha256: 'a'.repeat(64) })
    writeFileSync(join(run, 'source-brief.json'), '{}'); writeFileSync(join(run, 'source-seed.json'), '{}')
    expect(JSON.parse(readFileSync(join(run, 'bench/input.json'), 'utf8'))).toEqual(input)
    expect(JSON.parse(readFileSync(join(run, 'qa/brief.json'), 'utf8'))).toEqual({ ...brief, target: 'bmn-bench:123-0123456789abcdef' })
    expect(JSON.parse(readFileSync(join(run, 'bench/seed.json'), 'utf8'))).toEqual({ id: 'seed-v1' })
  } finally { rmSync(run, { recursive: true, force: true }) }
})
it('refuses a post-hoc target and unfinished bench capture', () => {
  const run = mkdtempSync(join(tmpdir(), 'bmn-qa-record-'))
  try {
    const brief = join(run, 'source-brief.json'), seed = join(run, 'source-seed.json')
    writeFileSync(brief, JSON.stringify({ version: 1, mode: 'quick-bench', revision: 'candidate', target: 'bmn-bench:old-run', accounts: [] }))
    writeFileSync(seed, JSON.stringify({ id: 'seed-v1' }))
    expect(() => prepareBenchQa({ options: { 'qa-brief': brief, 'qa-seed': seed }, run, runId: '123-0123456789abcdef', candidateSha256: 'a'.repeat(64) })).toThrow('pending target')
    writeFileSync(join(run, 'receipt.json'), JSON.stringify({ runId: '123-0123456789abcdef', status: 'running' }))
    writeFileSync(join(run, 'completion-proof.json'), JSON.stringify({ stopped: false }))
    expect(() => finishBenchQa({ run, runId: '123-0123456789abcdef', reportPath: brief })).toThrow()
  } finally { rmSync(run, { recursive: true, force: true }) }
})
