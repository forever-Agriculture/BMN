// MODULE: qa-bench-record.test.mjs - inputs bind before launch; unfinished evidence cannot become a receipt
import { expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareBenchQa, finishBenchQa, prepareBenchRoster } from '../qa/bench-qa-record.mjs'
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

it('installs the bound synthetic approved roster before either checkout or packaged Electron starts', () => {
  const run = mkdtempSync(join(tmpdir(), 'bmn-qa-seed-')), root = join(run, 'private')
  try {
    mkdirSync(join(root, 'home'), {recursive:true}); writeFileSync(join(root, '.bmn-qa-run'), '123-0123456789abcdef')
    const roster = readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8')
    const brief = join(run,'brief.json'), seed = join(run,'seed.json')
    writeFileSync(brief,JSON.stringify({version:1,mode:'quick-bench',revision:'candidate',target:'bmn-bench:pending',accounts:[]}))
    writeFileSync(seed,JSON.stringify({id:'synthetic-roster',roster}))
    const config = {root,run,runId:'123-0123456789abcdef',qaInput:prepareBenchQa({options:{'qa-brief':brief,'qa-seed':seed},run,runId:'123-0123456789abcdef',candidateSha256:'a'.repeat(64)})}
    expect(prepareBenchRoster(config)).toMatchObject({id:'synthetic-roster',generation:1})
    expect(readFileSync(join(root,'home/.config/bmn/agents/roster.md'),'utf8')).toBe(roster)
    const current = JSON.parse(readFileSync(join(root,'home/.config/bmn/agents/state/current'),'utf8'))
    const generation = JSON.parse(readFileSync(join(root,'home/.config/bmn/agents/state/generations/000001.json'),'utf8'))
    expect(current.hash).toBe(generation.hash)
    expect(prepareBenchRoster({})).toBeNull()
    expect(() => prepareBenchRoster(config)).toThrow('fresh private home')
    expect(readFileSync(join(root,'home/.config/bmn/agents/roster.md'),'utf8')).toBe(roster)
    writeFileSync(join(run,'bench/seed.json'),'{}')
    expect(() => prepareBenchRoster(config)).toThrow('reserved bench')
  } finally {rmSync(run,{recursive:true,force:true})}
})

it('refuses foreign seed ownership and skips seed records with no roster', () => {
  const run = mkdtempSync(join(tmpdir(), 'bmn-qa-seed-')), root = join(run,'private')
  try {
    mkdirSync(root); mkdirSync(join(run,'bench'));writeFileSync(join(root,'.bmn-qa-run'),'foreign')
    const bytes = JSON.stringify({id:'no-roster'});writeFileSync(join(run,'bench/seed.json'),bytes)
    const config={root,run,runId:'123-0123456789abcdef',qaInput:{runId:'123-0123456789abcdef',fixture:{seedSha256:createHash('sha256').update(bytes).digest('hex')}}}
    expect(() => prepareBenchRoster(config)).toThrow('reserved bench')
    writeFileSync(join(root,'.bmn-qa-run'),config.runId)
    expect(prepareBenchRoster(config)).toBeNull()
    expect(existsSync(join(root,'home'))).toBe(false)
  } finally {rmSync(run,{recursive:true,force:true})}
})
