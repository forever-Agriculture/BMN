// MODULE: agents-approval.test.ts - Epic 60.2: crash-safe generations, the approval lock, revert and restore
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRoster, sha256 } from '../../bin/agents-roster.mjs'
import { approvalLockPath, buildGeneration, currentPointerPath, generationPath, historyLogPath, machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import * as approval from './agents-approval'
import { revertFileToApproved, type ApprovalSeams, type ShownRevision } from './agents-approval'

/** These tests are not about where the apps send data: every inspected destination is taken as matching. */
const INSPECTED: ApprovalSeams = { checkInspectedRoutes: () => {} }
const approveRoster = (shown: ShownRevision, seams: ApprovalSeams = {}) => approval.approveRoster(shown, { ...INSPECTED, ...seams })
const approveSections = (shown: ShownRevision, scope: string[], seams: ApprovalSeams = {}) => approval.approveSections(shown, scope, { ...INSPECTED, ...seams })
const saveAndApprove = (shown: ShownRevision, data: Parameters<typeof approval.saveAndApprove>[1], seams: ApprovalSeams = {}) => approval.saveAndApprove(shown, data, { ...INSPECTED, ...seams })
const restoreGeneration = (shown: ShownRevision, number: number, seams: ApprovalSeams = {}) => approval.restoreGeneration(shown, number, { ...INSPECTED, ...seams })

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

/** The one agent edit these tests make: Luna's class, a pawn in the example. */
const LUNA_PAWN = 'name: Luna\nclass: pawn'
const LUNA_BISHOP = 'name: Luna\nclass: bishop'
const HELPER = 'helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna@max], then: lead}'

describe('approved generations (60.2 AC1-AC2)', () => {
  it('writes a generation, then the pointer, with private modes', () => {
    writeRoster(EXAMPLE)
    const generation = approveRoster(shown())
    expect(generation).toMatchObject({ number: 1, parent: null, kind: 'approval', roster_file_hash: sha256(EXAMPLE) })
    expect(readApproved().hash).toBe(generation.hash)
    expect(statSync(join(home, '.config/bmn/agents/state')).mode & 0o777).toBe(0o700)
    expect(statSync(generationPath(1)).mode & 0o777).toBe(0o600)
    expect(statSync(currentPointerPath()).mode & 0o777).toBe(0o600)
    // The lock file stays in place (one inode), empty while no approval runs.
    expect(readFileSync(approvalLockPath(), 'utf8')).toBe('')
  })

  it('a file edit changing the class of an agent changes nothing until approved', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    expect(readApproved().data.agents.find((agent) => agent.id === 'luna')?.class).toBe('pawn')
    approveRoster(shown())
    expect(readApproved().data.agents.find((agent) => agent.id === 'luna')?.class).toBe('bishop')
    expect(readApproved()).toMatchObject({ number: 2, parent: 1 })
  })

  it('an approval killed after the generation and before the pointer leaves the previous one current', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    expect(() => approveRoster(shown(), { beforePointer: () => { throw new Error('killed') } })).toThrow('killed')
    expect(existsSync(generationPath(2))).toBe(true)
    expect(readApproved().number).toBe(1)
    // The next approval skips the orphan's number and is pointed to.
    expect(approveRoster(shown()).number).toBe(3)
  })

  it('a corrupted generation exits 6 and names the last good one', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    approveRoster(shown())
    const path = generationPath(2)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"class": "bishop"', '"class": "pawn"'))
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
    writeRoster(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
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

  it('the lock file stays in place, empty while idle; an unreadable record left behind is logged as broken', () => {
    writeRoster(EXAMPLE)
    mkdirSync(join(home, '.config/bmn/agents/state'), { recursive: true })
    writeFileSync(approvalLockPath(), '')
    const inode = statSync(approvalLockPath()).ino
    expect(approveRoster(shown()).number).toBe(1)
    expect(statSync(approvalLockPath()).ino).toBe(inode)
    expect(readFileSync(approvalLockPath(), 'utf8')).toBe('')
    expect(existsSync(historyLogPath()) ? readFileSync(historyLogPath(), 'utf8') : '').not.toContain('lock-broken')
    writeFileSync(approvalLockPath(), '{"pid":')
    writeRoster(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    expect(approveRoster(shown()).number).toBe(2)
    expect(readFileSync(historyLogPath(), 'utf8')).toContain('"holder":{"unreadable":true}')
  })

  it('a holder whose lock file was replaced writes nothing more', () => {
    writeRoster(EXAMPLE)
    const replaced = () => {
      unlinkSync(approvalLockPath())
      writeFileSync(approvalLockPath(), '')
    }
    expect(() => approveRoster(shown(), { afterLock: replaced })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(existsSync(currentPointerPath())).toBe(false)
    expect(existsSync(generationPath(1))).toBe(false)
  })

  it('fails closed when the OS lock cannot be taken', () => {
    writeRoster(EXAMPLE)
    expect(() => approveRoster(shown(), { flockCommand: join(home, 'no-such-flock') })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(existsSync(currentPointerPath())).toBe(false)
    expect(existsSync(generationPath(1))).toBe(false)
  })
})

describe('the OS lock across separately scheduled processes (60.2 AC4)', () => {
  const approvalModule = fileURLToPath(new URL('./agents-approval.ts', import.meta.url))
  // A real approval in its own process. With a barrier it writes `paused` just before publishing
  // (generation durable, pointer not yet moved) and waits there until the test creates `go`.
  const CHILD = `import { existsSync, writeFileSync } from 'node:fs'
const [modulePath, paused, go, shownJson] = process.argv.slice(2)
const { approveRoster } = await import(modulePath)
const wait = new Int32Array(new SharedArrayBuffer(4))
const inspected = { checkInspectedRoutes: () => {} }
const seams = go === '' ? inspected : { ...inspected, beforePointer: () => { writeFileSync(paused, 'paused'); while (!existsSync(go)) Atomics.wait(wait, 0, 0, 20) } }
try {
  process.stdout.write(JSON.stringify({ number: approveRoster(JSON.parse(shownJson), seams).number }))
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code ?? String(error) }))
}
`
  const barrier = { paused: '', go: '' }
  let script = ''
  beforeEach(() => {
    script = join(home, 'approve-child.mjs')
    writeFileSync(script, CHILD)
    barrier.paused = join(home, 'paused')
    barrier.go = join(home, 'go')
  })

  function approval(revision: object, withBarrier: boolean): { child: ChildProcess; result: Promise<{ number?: number; code?: string }> } {
    const child = spawn(process.execPath, ['--no-warnings', script, approvalModule, barrier.paused, withBarrier ? barrier.go : '', JSON.stringify(revision)],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout!.on('data', (chunk) => { out += chunk })
    const result = new Promise<{ number?: number; code?: string }>((resolve) => child.on('close', () => resolve(out === '' ? {} : JSON.parse(out))))
    return { child, result }
  }

  async function until(test: () => boolean, label: string): Promise<void> {
    const end = Date.now() + 20_000
    while (!test()) {
      if (Date.now() > end) throw new Error(`never saw ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('a holder paused just before publication refuses contenders here and in another process; then it publishes once', async () => {
    writeRoster(EXAMPLE)
    const revision = shown()
    const holder = approval(revision, true)
    await until(() => existsSync(barrier.paused), 'the holder paused before publication')
    expect(() => approveRoster(revision)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(await approval(revision, false).result).toEqual({ code: 'REVISION_CONFLICT' })
    expect(existsSync(currentPointerPath())).toBe(false)
    expect(readdirSync(join(home, '.config/bmn/agents/state/generations'))).toEqual(['000001.json'])
    writeFileSync(barrier.go, 'go')
    expect(await holder.result).toEqual({ number: 1 })
    expect(readApproved().number).toBe(1)
    expect(readdirSync(join(home, '.config/bmn/agents/state/generations'))).toEqual(['000001.json'])
    expect(readFileSync(approvalLockPath(), 'utf8')).toBe('')
  })

  it('a holder killed mid-approval releases the lock with its process; the next approval logs it broken', async () => {
    writeRoster(EXAMPLE)
    const holder = approval(shown(), true)
    await until(() => existsSync(barrier.paused), 'the holder paused before publication')
    const pid = holder.child.pid
    holder.child.kill('SIGKILL')
    await holder.result
    // The killed approval's generation is durable but was never pointed to.
    expect(existsSync(currentPointerPath())).toBe(false)
    expect(approveRoster(shown()).number).toBe(2)
    expect(readApproved().number).toBe(2)
    expect(readFileSync(historyLogPath(), 'utf8')).toContain(`"event":"lock-broken","holder":{"pid":${pid},`)
  })

  it('refuses when a linked roster was retargeted to identical bytes after it was shown', () => {
    mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
    writeFileSync(join(home, 'a.md'), EXAMPLE)
    writeFileSync(join(home, 'b.md'), EXAMPLE)
    symlinkSync(join(home, 'a.md'), rosterFile())
    const seen = { ...shown(), link: join(home, 'a.md') }
    unlinkSync(rosterFile())
    symlinkSync(join(home, 'b.md'), rosterFile())
    expect(() => approveRoster(seen)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(approveRoster({ ...shown(), link: join(home, 'b.md') }).number).toBe(1)
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
    const next = { ...data, agents: data.agents.map((agent) => agent.id === 'luna' ? { ...agent, class: 'bishop' as const } : agent) }
    expect(() => saveAndApprove(shown(), next, { beforePublish: () => { throw new Error('crash') } })).toThrow('crash')
    expect(readApproved().number).toBe(1)
    const file = readValidRoster()
    expect(machineDiff(readApproved().data, file.data).map((d) => `${d.id}.${d.field}`)).toEqual(['luna.class'])
    const saved = saveAndApprove(shown(), file.data)
    expect(saved.data.agents.find((agent) => agent.id === 'luna')?.class).toBe('bishop')
  })
})

describe('versions accepted under the earlier rule (owner decision 2026-10-10: every installed version is supported)', () => {
  const ACCEPTED = (versions: string) => edit(EXAMPLE, 'codex: {provider: openai, basis: observed-default}',
    `codex: {provider: openai, basis: observed-default, accepted_versions: [${versions}]}`)

  it('a team file that still lists accepted versions stays valid and approves like any other field', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(ACCEPTED('"0.170.0"'))
    expect(approveRoster(shown()).number).toBe(2)
    expect(readApproved().data.harness_routes.find((route) => route.harness === 'codex')?.accepted_versions).toEqual(['0.170.0'])
    // Removing the list is an ordinary change too.
    writeRoster(EXAMPLE)
    expect(approveRoster(shown()).number).toBe(3)
  })

  it('a destination recorded as inspected is refused unless the app inspects it again at commit (60.6 AC4)', () => {
    writeRoster(EXAMPLE)
    // Without the app's inspector nothing is recorded as inspected, on a first approval or later.
    expect(() => approval.approveRoster(shown())).toThrow(expect.objectContaining({ code: 'ROUTE_CHANGED', message: expect.stringContaining('claude, codex, opencode') }))
    const seen: unknown[] = []
    const inspect = (routes: unknown[]) => { seen.push(...routes) }
    expect(approval.approveRoster(shown(), { checkInspectedRoutes: inspect }).number).toBe(1)
    expect(seen).toEqual([{ harness: 'claude', provider: 'anthropic' }, { harness: 'codex', provider: 'openai' }, { harness: 'opencode', provider: 'opencode-go' }])
    // An unchanged destination is not inspected again, and a declared one never is.
    seen.length = 0
    writeRoster(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    expect(approval.approveRoster(shown()).number).toBe(2)
    writeRoster(edit(EXAMPLE, 'codex: {provider: openai, basis: observed-default}', 'codex: {provider: openai, basis: owner-declared}'))
    expect(approval.approveRoster(shown()).number).toBe(3)
    expect(seen).toEqual([])
    // Back to inspected: asked again, and a refusal leaves the approved version where it was.
    writeRoster(EXAMPLE)
    const moved = () => { throw Object.assign(new Error('Codex now sends data elsewhere'), { code: 'ROUTE_CHANGED' }) }
    expect(() => approval.approveRoster(shown(), { checkInspectedRoutes: moved })).toThrow('Codex now sends data elsewhere')
    expect(() => approval.approveSections(shown(), ['harness-routes'], { checkInspectedRoutes: moved })).toThrow('Codex now sends data elsewhere')
    expect(() => approval.restoreGeneration(shown(), 1, { checkInspectedRoutes: moved })).toThrow('Codex now sends data elsewhere')
    expect(readApproved().number).toBe(3)
  })
})

describe('revert and restore (60.2 AC6)', () => {
  it('revert preserves every byte outside the edited blocks', () => {
    const prose = edit(EXAMPLE, 'Owner\'s notes: PROSE-SENTINEL-OPUS.', 'Owner\'s notes: rewritten prose the revert must keep.')
    writeRoster(prose)
    approveRoster(shown())
    const edited = edit(edit(prose, LUNA_PAWN, `${LUNA_BISHOP}  # a comment`), HELPER, HELPER.replace('then: lead', 'then: skip'))
    writeRoster(edited)
    expect(revertFileToApproved(shown())).toEqual({ changed: true })
    const reverted = readFileSync(rosterFile(), 'utf8')
    expect(machineDiff(readApproved().data, readValidRoster().data)).toEqual([])
    // Outside the two rewritten blocks, the bytes are the edited file's.
    const outside = (text: string) => text.replace(/## luna\n\n```yaml\n[\s\S]*?```/, '').replace(/## roles\n\n```yaml\n[\s\S]*?```/, '')
    expect(outside(reverted)).toBe(outside(edited))
    expect(reverted).toContain('rewritten prose the revert must keep.')
  })

  it('refuses to revert an agent the file added, which would delete its section and prose', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const added = `${EXAMPLE}\n## nova\n\n\`\`\`yaml\nname: Nova\nclass: pawn\nharness: codex\nmodel: m\nprovider: openai\nhost: default\nenabled: true\nstatus: proposed\nefforts: [low]\nroles: []\n\`\`\`\n\nThe owner's notes on Nova.\n`
    writeRoster(added)
    expect(readValidRoster().data.agents.some((agent) => agent.id === 'nova')).toBe(true)
    expect(() => revertFileToApproved(shown(), ['nova'])).toThrow(expect.objectContaining({ code: 'INVALID_VALUE' }))
    expect(readFileSync(rosterFile(), 'utf8')).toBe(added)
  })

  it('never deletes an added agent\'s section and prose, even when that section does not validate', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const added = `${EXAMPLE}\n## nova\n\n\`\`\`yaml\nname: Nova\nclass: pawn\nharness: codex\nmodel: m\nprovider: openai\nhost: default\nenabled: true\nstatus: proposed\nefforts: null\nroles: []\n\`\`\`\n\nThe owner's notes on Nova.\n`
    writeRoster(added)
    expect(() => revertFileToApproved(shown())).toThrow(expect.objectContaining({ code: 'INVALID_VALUE' }))
    expect(readFileSync(rosterFile(), 'utf8')).toBe(added)
  })

  it('refuses, byte for byte, a revert that could only remove or insert text outside the yaml blocks', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const changed = edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP)
    const refused = (text: string, scope: string[] | null = null): void => {
      writeRoster(text)
      expect(() => revertFileToApproved(shown(), scope)).toThrow(expect.objectContaining({ code: 'INVALID_VALUE' }))
      expect(readFileSync(rosterFile(), 'utf8')).toBe(text)
    }
    // An added section with a heading and no yaml block at all.
    refused(`${changed}\n## nova\n\nNotes on an agent that has no block yet.\n`)
    // A repeated section: the rewriter would drop the second one and its prose.
    refused(`${changed}\n## luna\n\n\`\`\`yaml\nname: Other\n\`\`\`\n\nProse under the repeated heading.\n`)
    // An approved agent whose block was deleted: the fence would have to be inserted before its prose.
    refused(changed.replace(/(## luna\n\n)```yaml\n[\s\S]*?```\n/, '$1'))
    // Unrelated validation errors elsewhere do not hide the added section.
    refused(`${edit(changed, HELPER, HELPER.replace('luna@max', 'nobody@max'))}\n## nova\n\n\`\`\`yaml\nname: Nova\n\`\`\`\n\nNotes on Nova.\n`)
  })

  it('a scoped revert leaves an unrelated added section alone and still reverts its own block', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const added = `${edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP)}\n## nova\n\n\`\`\`yaml\nname: Nova\nefforts: null\n\`\`\`\n\nThe owner's notes on Nova.\n`
    writeRoster(added)
    expect(revertFileToApproved(shown(), ['luna'])).toEqual({ changed: true })
    expect(readFileSync(rosterFile(), 'utf8')).toBe(edit(added, LUNA_BISHOP, LUNA_PAWN))
  })

  it('a scoped revert that would leave a valid file invalid is refused and writes nothing', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const moved = edit(edit(EXAMPLE, 'zai: {name: Z.ai, hosts: [api.z.ai], private_work: public_only}',
      'zai: {name: Z.ai, hosts: [api.z.ai], private_work: public_only}\nmoon: {name: Moon, hosts: [api.moon.test], private_work: public_only}'),
    'provider: zai\nhost: api.z.ai', 'provider: moon\nhost: api.moon.test')
    writeRoster(moved)
    expect(readValidRoster().data.providers.map((provider) => provider.id)).toContain('moon')
    expect(() => revertFileToApproved(shown(), ['providers'])).toThrow(expect.objectContaining({ code: 'INVALID_VALUE', message: expect.stringContaining('would leave the team file invalid') }))
    expect(readFileSync(rosterFile(), 'utf8')).toBe(moved)
    expect(revertFileToApproved(shown(), ['glm', 'providers'])).toEqual({ changed: true })
    expect(machineDiff(readApproved().data, readValidRoster().data)).toEqual([])
  })

  it('a revert brings back an approved section the file lost, after the end, changing no existing byte', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const lost = EXAMPLE.replace(/## luna\n[\s\S]*?(?=\n## )/, '')
    expect(lost).not.toBe(EXAMPLE)
    writeRoster(lost)
    expect(revertFileToApproved(shown())).toEqual({ changed: true })
    const reverted = readFileSync(rosterFile(), 'utf8')
    expect(reverted.startsWith(lost)).toBe(true)
    expect(machineDiff(readApproved().data, readValidRoster().data)).toEqual([])
  })

  it('revert replaces a linked roster as a regular file and leaves the link target untouched', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    const elsewhere = join(home, 'dotfiles-roster.md')
    writeFileSync(elsewhere, edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    rmSync(rosterFile())
    symlinkSync(elsewhere, rosterFile())
    revertFileToApproved(shown())
    expect(lstatSync(rosterFile()).isFile()).toBe(true)
    expect(readFileSync(elsewhere, 'utf8')).toBe(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    const backups = readdirSync(join(home, '.config/bmn/agents/state/roster-backups'))
    expect(JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/roster-backups', backups[0]!), 'utf8'))).toEqual({ kind: 'link', target: elsewhere, directory: join(home, '.config/bmn/agents') })
    expect(() => readlinkSync(rosterFile())).toThrow()
  })

  it("restore makes an earlier generation's data a new generation", () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    writeRoster(edit(EXAMPLE, LUNA_PAWN, LUNA_BISHOP))
    approveRoster(shown())
    const restored = restoreGeneration(shown(), 1)
    expect(restored).toMatchObject({ number: 3, parent: 2, kind: 'restore', restored_from: 1 })
    expect(restored.data).toEqual(parseRoster(EXAMPLE).data)
  })

  it('never restores a version approved under the earlier layout: it is history to view (60.2 AC7)', () => {
    const earlier = buildGeneration({ number: 1, parent: null, rosterFileHash: 'f'.repeat(64),
      data: { schema_version: 1, agents: [], roles: [], data_labels: { default: 'private', paths: [] }, harness_routes: [] } as never })
    mkdirSync(join(home, '.config/bmn/agents/state/generations'), { recursive: true })
    writeFileSync(generationPath(1), JSON.stringify(earlier))
    writeFileSync(currentPointerPath(), JSON.stringify({ generation: 1, hash: earlier.hash }))
    writeRoster(EXAMPLE)
    expect(approveRoster({ generation: null, fileHash: readValidRoster().hash })).toMatchObject({ number: 2 })
    const before = readFileSync(currentPointerPath(), 'utf8')
    expect(() => restoreGeneration(shown(), 1)).toThrow(expect.objectContaining({ code: 'INVALID_VALUE', message: expect.stringContaining('earlier') }))
    expect(readFileSync(currentPointerPath(), 'utf8')).toBe(before)
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
    const outside = edit(edit(EXAMPLE, FOCUSED, FOCUSED_SWAPPED), LUNA_PAWN, LUNA_BISHOP)
    writeRoster(outside)
    const generation = approveSections(shown(), ['roles'])
    expect(generation).toMatchObject({ number: 2, parent: 1, roster_file_hash: sha256(outside) })
    expect(generation.data.roles.find((role) => role.id === 'focused-reviewer')?.candidates).toEqual(['astra@low', 'luna@max'])
    expect(generation.data.agents.find((agent) => agent.id === 'luna')?.class).toBe('pawn')
    expect(readFileSync(rosterFile(), 'utf8')).toBe(outside)
    expect(machineDiff(readApproved().data, readValidRoster().data).map((diff) => `${diff.scope}:${diff.id}:${diff.field}`)).toEqual(['agent:luna:class'])
  })

  it('refuses a section whose change depends on another pending one, and writes nothing', () => {
    writeRoster(EXAMPLE)
    approveRoster(shown())
    // Haiku gains the helper role in its own section and joins the helper chain: the chain alone would name a non-holder.
    const outside = edit(EXAMPLE, HELPER, HELPER.replace('luna@max', 'luna@max, haiku@low'))
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
