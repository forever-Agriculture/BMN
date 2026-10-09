// MODULE: agents-approval.test.ts - Epic 60.2: crash-safe generations, the approval lock, revert and restore
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRoster, sha256 } from '../../bin/agents-roster.mjs'
import { approvalLockPath, currentPointerPath, generationPath, historyLogPath, machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster, approveSections, restoreGeneration, revertFileToApproved, saveAndApprove } from './agents-approval'

const EXAMPLE = readFileSync(fileURLToPath(new URL('../utility/test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const BIN = fileURLToPath(new URL('../../bin/', import.meta.url))

let home: string
const savedHome = process.env.HOME

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-approval-')))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

function rosterFile(): string {
  return join(home, '.config/bmn/agents/roster.md')
}

function writeRoster(text: string): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(rosterFile(), text)
}

function shown() {
  let generation: number | null
  try { generation = readApproved().number } catch { generation = null }
  return { generation, fileHash: sha256(readFileSync(rosterFile(), 'utf8')) }
}

function edit(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
  return text.replace(from, to)
}

const LUNA_HIGH = 'name: Luna\ntitle: squire\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nsecurity: high'
const LUNA_LOW = LUNA_HIGH.replace('security: high', 'security: low')

describe('approved generations (60.2 AC1-AC2)', () => {
  it('writes a generation, then the pointer, with private modes', () => {
    writeRoster(EXAMPLE)
    const generation = approveRoster(shown())
    expect(generation).toMatchObject({ number: 1, parent: null, kind: 'approval', roster_file_hash: sha256(EXAMPLE) })
    expect(readApproved().hash).toBe(generation.hash)
    expect(statSync(join(home, '.config/bmn/agents/state')).mode & 0o777).toBe(0o700)
    expect(statSync(generationPath(1)).mode & 0o777).toBe(0o600)
    expect(statSync(currentPointerPath()).mode & 0o777).toBe(0o600)
    expect(existsSync(approvalLockPath())).toBe(false)
  })

  it('a file edit raising security changes nothing until approved', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_HIGH, LUNA_LOW))
    expect(readApproved().data.agents.find((agent) => agent.id === 'luna')?.security).toBe('high')
    approveRoster(shown())
    expect(readApproved().data.agents.find((agent) => agent.id === 'luna')?.security).toBe('low')
    expect(readApproved()).toMatchObject({ number: 2, parent: 1 })
  })

  it('an approval killed after the generation and before the pointer leaves the previous one current', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_HIGH, LUNA_LOW))
    expect(() => approveRoster(shown(), { beforePointer: () => { throw new Error('killed') } })).toThrow('killed')
    expect(existsSync(generationPath(2))).toBe(true)
    expect(readApproved().number).toBe(1)
    // The next approval skips the orphan's number and is pointed to.
    expect(approveRoster(shown()).number).toBe(3)
  })

  it('a corrupted generation exits 6 and names the last good one', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_HIGH, LUNA_LOW))
    approveRoster(shown())
    const path = generationPath(2)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"security": "low"', '"security": "high"'))
    expect(() => readApproved()).toThrow(expect.objectContaining({ code: 'STATE_CORRUPT', lastGood: 1 }))
    const cli = execCli(['team'])
    expect(cli.code).toBe(6)
    expect(cli.stderr).toContain('the last good generation is 1')
    // The owner recovers from the panel: restore the last good generation.
    restoreGeneration({ generation: null, fileHash: sha256(readFileSync(rosterFile(), 'utf8')) }, 1)
    expect(readApproved()).toMatchObject({ number: 3, kind: 'restore', restored_from: 1 })
  })
})

function execCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [join(BIN, 'bmn'), ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string }
    return { code: failure.status, stdout: failure.stdout, stderr: failure.stderr }
  }
}

describe('revision checks and the lock (60.2 AC4)', () => {
  it('refuses an approval of something other than what was shown', () => {
    writeRoster(EXAMPLE)
    const before = shown()
    writeRoster(edit(EXAMPLE, LUNA_HIGH, LUNA_LOW))
    expect(() => approveRoster(before)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    approveRoster(shown())
    expect(() => approveRoster({ generation: null, fileHash: shown().fileHash })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })

  it('two concurrent approvals produce one commit and one revision conflict', () => {
    writeRoster(EXAMPLE)
    const revision = shown()
    let inner: unknown = null
    const outer = approveRoster(revision, {
      afterLock: () => {
        try { approveRoster(revision) } catch (error) { inner = error }
      }
    })
    expect(outer.number).toBe(1)
    expect(inner).toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(readdirSync(join(home, '.config/bmn/agents/state/generations'))).toEqual(['000001.json'])
  })

  it('breaks a stale lock left by a dead process, with a logged note', () => {
    writeRoster(EXAMPLE)
    mkdirSync(join(home, '.config/bmn/agents/state'), { recursive: true })
    writeFileSync(approvalLockPath(), JSON.stringify({ pid: 999_999_999, start: '1' }))
    expect(approveRoster(shown()).number).toBe(1)
    expect(readFileSync(historyLogPath(), 'utf8')).toContain('"event":"lock-broken"')
  })

  it('a reused pid with a different start time does not hold the lock', () => {
    writeRoster(EXAMPLE)
    mkdirSync(join(home, '.config/bmn/agents/state'), { recursive: true })
    writeFileSync(approvalLockPath(), JSON.stringify({ pid: process.pid, start: 'not-this-process' }))
    expect(approveRoster(shown()).number).toBe(1)
  })

  it('a save writes the file first; a crash before publication leaves only a pending difference', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const data = parseRoster(EXAMPLE).data!
    const next = { ...data, agents: data.agents.map((agent) => agent.id === 'luna' ? { ...agent, security: 'low' as const } : agent) }
    expect(() => saveAndApprove(shown(), next, { beforePublish: () => { throw new Error('crash') } })).toThrow('crash')
    expect(readApproved().number).toBe(1)
    const file = readValidRoster()
    expect(machineDiff(readApproved().data, file.data).map((d) => `${d.id}.${d.field}`)).toEqual(['luna.security'])
    const saved = saveAndApprove(shown(), file.data)
    expect(saved.data.agents.find((agent) => agent.id === 'luna')?.security).toBe('low')
  })
})

describe('revert and restore (60.2 AC6)', () => {
  it('revert preserves every byte outside the edited blocks', () => {
    const prose = edit(EXAMPLE, 'Owner\'s opinion: PROSE-SENTINEL-OPUS.', 'Owner\'s opinion: rewritten prose the revert must keep.')
    writeRoster(prose)
    approveRoster(shown())
    const edited = edit(edit(prose, LUNA_HIGH, `${LUNA_LOW}  # a comment`), 'helper: {candidates: [luna@max], then: lead}', 'helper: {candidates: [luna@max], then: skip}')
    writeRoster(edited)
    expect(revertFileToApproved(shown())).toEqual({ changed: true })
    const reverted = readFileSync(rosterFile(), 'utf8')
    expect(machineDiff(readApproved().data, readValidRoster().data)).toEqual([])
    // Outside the two rewritten blocks, the bytes are the edited file's.
    const outside = (text: string) => text.replace(/## luna\n\n```yaml\n[\s\S]*?```/, '').replace(/## roles\n\n```yaml\n[\s\S]*?```/, '')
    expect(outside(reverted)).toBe(outside(edited))
    expect(reverted).toContain('rewritten prose the revert must keep.')
  })

  it('revert replaces a linked roster as a regular file and leaves the link target untouched', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const elsewhere = join(home, 'dotfiles-roster.md')
    writeFileSync(elsewhere, edit(EXAMPLE, LUNA_HIGH, LUNA_LOW))
    rmSync(rosterFile())
    symlinkSync(elsewhere, rosterFile())
    revertFileToApproved(shown())
    expect(lstatSync(rosterFile()).isFile()).toBe(true)
    expect(readFileSync(elsewhere, 'utf8')).toBe(edit(EXAMPLE, LUNA_HIGH, LUNA_LOW))
    const backups = readdirSync(join(home, '.config/bmn/agents/state/roster-backups'))
    expect(JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/roster-backups', backups[0]!), 'utf8'))).toEqual({ kind: 'link', target: elsewhere })
    expect(() => readlinkSync(rosterFile())).toThrow()
  })

  it("restore makes an earlier generation's data a new generation", () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_HIGH, LUNA_LOW))
    approveRoster(shown())
    const restored = restoreGeneration(shown(), 1)
    expect(restored).toMatchObject({ number: 3, parent: 2, kind: 'restore', restored_from: 1 })
    expect(restored.data).toEqual(parseRoster(EXAMPLE).data)
  })
})

describe('no CLI route approves (60.2 AC5)', () => {
  it('PASS: nothing under bin/ imports the writer or writes generations or the pointer', () => {
    const offenders: string[] = []
    for (const name of readdirSync(BIN)) {
      if (!/\.(mjs|d\.mts)$/.test(name) && name !== 'bmn') continue
      const source = readFileSync(join(BIN, name), 'utf8')
      if (/(from|import\s*\(?)\s*['"][^'"]*agents-approval/.test(source)) offenders.push(`${name}: imports the approval writer`)
      if (name === 'agents-state.mjs' && /\b(writeFileSync|renameSync|appendFileSync|unlinkSync|openSync|mkdirSync)\b/.test(source)) {
        offenders.push(`${name}: the state reader writes`)
      }
      if (/currentPointerPath\(\)|generationPath\(/.test(source) && name !== 'agents-state.mjs' && !name.endsWith('.d.mts')) {
        offenders.push(`${name}: names a generation or pointer path`)
      }
    }
    expect(offenders, offenders.length ? 'FAIL' : 'PASS').toEqual([])
  })
})

describe('approving one outside section (60.5 AC3)', () => {
  const FOCUSED = 'focused-reviewer: {candidates: [luna@max, astra@low], then: lead}'
  const FOCUSED_SWAPPED = 'focused-reviewer: {candidates: [astra@low, luna@max], then: lead}'

  it('approves only the named section; the other outside change stays pending and the file is untouched', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const outside = edit(edit(EXAMPLE, FOCUSED, FOCUSED_SWAPPED), LUNA_HIGH, LUNA_LOW)
    writeRoster(outside)
    const generation = approveSections(shown(), ['roles'])
    expect(generation).toMatchObject({ number: 2, parent: 1, roster_file_hash: sha256(outside) })
    expect(generation.data.roles.find((role) => role.id === 'focused-reviewer')?.candidates).toEqual(['astra@low', 'luna@max'])
    expect(generation.data.agents.find((agent) => agent.id === 'luna')?.security).toBe('high')
    expect(readFileSync(rosterFile(), 'utf8')).toBe(outside)
    expect(machineDiff(readApproved().data, readValidRoster().data).map((diff) => `${diff.scope}:${diff.id}:${diff.field}`)).toEqual(['agent:luna:security'])
  })

  it('refuses a section whose change depends on another pending one, and writes nothing', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    // Haiku gains the helper role in its own section and joins the helper chain: the chain alone would name a non-holder.
    const outside = edit(EXAMPLE, 'helper: {candidates: [luna@max], then: lead}', 'helper: {candidates: [luna@max, haiku@low], then: lead}')
      .replace(/(## haiku[\s\S]*?roles: )\[\]/, '$1[helper]')
    writeRoster(outside)
    expect(parseRoster(outside).data).not.toBeNull()
    expect(() => approveSections(shown(), ['roles'])).toThrow(expect.objectContaining({ code: 'ROSTER_INVALID' }))
    expect(readApproved().number).toBe(1)
    expect(approveSections(shown(), ['roles', 'haiku']).number).toBe(2)
  })

  it('refuses an unknown section and a stale view', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, FOCUSED, FOCUSED_SWAPPED))
    expect(() => approveSections(shown(), ['nobody'])).toThrow(expect.objectContaining({ code: 'INVALID_VALUE' }))
    const stale = shown()
    writeRoster(EXAMPLE)
    expect(() => approveSections(stale, ['roles'])).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(readApproved().number).toBe(1)
  })
})
