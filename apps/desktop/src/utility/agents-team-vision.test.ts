// MODULE: agents-team-vision.test.ts - Story 112.1: a reviewer's ask carries the project's plan/VISION.md from any worktree, whole or not at all, named with its hash in the manifest and receipt; other roles and projects without a vision are unchanged; a synthetic team, stand-in apps and made-up projects, no provider reached
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { teamRunsDirectory } from '../../bin/agents-check.mjs'
import { ASK_RUN_FILES } from '../../bin/agents-team-forms.mjs'
import { AskUsageError, prepareAsk } from '../../bin/agents-team-ask.mjs'
import { VISION_LIMIT, VISION_ROLES, reviewVision } from '../../bin/agents-team-vision.mjs'
import { VISION_LIMIT as CHECK_LIMIT, resolvePlan } from '../../bin/plan-board.mjs'
import { SCOPES, leftovers as harnessLeftovers, ownSystemd, settle, teamAskHome } from './test-fixtures/team-ask-harness'

const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const VISION = `# Vision

## Vision

A synthetic app that serves every customer's own scope.

## Principles

- **P1. No hard-coded segment.** No hard-coded segment overrides the customer's scope.

## We refuse

- A company-size check the customer did not set.
`
const INSTRUCTION = /is the project's vision \(sha256 [0-9a-f]{64}\)\. Besides the question, report any change you review that works against one of its principles or one of its "We refuse" lines: quote the principle or refusal line, give the code's file:line and say the consequence\./u

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=made-up', '-c', 'user.email=made-up@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })

/** A project whose BMN plan is ignored by Git (as BMN's own is), and a linked worktree of it that has no plan/. */
function planned(vision: string | Buffer | null = VISION): { main: string; worktree: string; visionPath: string } {
  const main = join(home, 'code/app')
  mkdirSync(join(main, 'src'), { recursive: true })
  writeFileSync(join(main, '.gitignore'), 'plan/\n')
  writeFileSync(join(main, 'src/scope.ts'), 'export const inScope = (size: number) => size < 500\n')
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'one')
  mkdirSync(join(main, 'plan'))
  writeFileSync(join(main, 'plan/status.yaml'), 'format: bmn-plan\nschema_version: 1\n\ndevelopment_status:\n  epic-1: ready\n')
  if (vision !== null) writeFileSync(join(main, 'plan/VISION.md'), vision)
  const worktree = join(home, 'code/app-wt')
  git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree)
  return { main, worktree, visionPath: join(main, 'plan/VISION.md') }
}

/** The ask the asking command makes for a reviewer: the vision found, added to the files and named in the request. */
async function reviewerAsk(role: string, project: string, extra: Partial<Parameters<typeof prepareAsk>[0]> = {}) {
  const vision = await reviewVision(role, project, { home, resolvePlan })
  const files = [...(extra.files ?? [])]
  if (vision?.real !== undefined && !files.includes(vision.real)) files.push(vision.real)
  const request = { role, question: 'Review the change.', project, files, ...(vision === null ? {} : { vision }) }
  return { vision, prepared: prepareAsk(request, { environment: env, cwd: project, home }) }
}

beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-vision-'))
})

afterEach(async () => {
  await settle(() => harnessLeftovers(home).length === 0, 5000)
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('a reviewer is given the vision (112.1 AC1)', () => {
  it('each reviewer role from a worktree without plan/ carries the vision whole, its hash and the one instruction, in prompt, manifest and receipt', async () => {
    const { worktree, visionPath } = planned()
    expect(existsSync(join(worktree, 'plan'))).toBe(false)
    expect(VISION_ROLES).toEqual(['focused-reviewer', 'epic-reviewer', 'final-reviewer'])
    for (const role of VISION_ROLES) {
      const { vision, prepared } = await reviewerAsk(role, worktree)
      expect(vision).toEqual({ path: visionPath, real: visionPath, sha256: sha(VISION), bytes: Buffer.byteLength(VISION) })
      expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
      const prompt = readFileSync(join(prepared.folder, ASK_RUN_FILES.prompt), 'utf8')
      expect(prompt).toContain('No hard-coded segment overrides the customer\'s scope.')
      expect(prompt).toMatch(INSTRUCTION)
      expect(prompt.match(/Besides the question, report any change/gu)).toHaveLength(1)
      const named = { path: visionPath, file: 1, bytes: Buffer.byteLength(VISION), sha256: sha(VISION) }
      expect(prepared.manifest.vision).toEqual(named)
      expect(prepared.verdict.receipt?.vision).toEqual(named)
      const receipt = JSON.parse(readFileSync(join(prepared.folder, ASK_RUN_FILES.receipt), 'utf8'))
      expect(receipt.vision).toEqual(named)
    }
  })

  it('a consultant, a designer and a pre-reviewer get no vision; a project without a vision or without a plan is unchanged', async () => {
    const { worktree } = planned()
    for (const role of ['consultant', 'designer', 'pre-reviewer', 'qa', 'helper']) expect(await reviewVision(role, worktree, { home, resolvePlan })).toBeNull()
    // The ceiling is the plan check's, and a command handed no plan reader says so rather than skipping in silence.
    expect(VISION_LIMIT).toBe(CHECK_LIMIT)
    expect(await reviewVision('epic-reviewer', worktree, { home })).toEqual({ path: null, omitted: expect.stringContaining('no plan reader') })
    const plain = await reviewerAsk('consultant', worktree)
    expect(plain.prepared.manifest).not.toHaveProperty('vision')
    expect(plain.prepared.verdict.receipt).not.toHaveProperty('vision')
    expect(readFileSync(join(plain.prepared.folder, ASK_RUN_FILES.prompt), 'utf8')).not.toContain('project\'s vision')
    // Only a reviewer's ask takes one: a vision handed to another role is a usage error, nothing written.
    expect(() => prepareAsk({ role: 'consultant', question: 'x', project: worktree, files: [], vision: { path: 'v', real: 'v', sha256: 'x' } }, { environment: env, cwd: worktree, home })).toThrow(AskUsageError)
    rmSync(join(home, 'code'), { recursive: true, force: true })
    const { worktree: bare } = planned(null)
    expect(await reviewVision('epic-reviewer', bare, { home, resolvePlan })).toBeNull()
    const none = await reviewerAsk('epic-reviewer', bare)
    expect(none.prepared.manifest).not.toHaveProperty('vision')
    // No plan at all, and no project.
    rmSync(join(home, 'code/app/plan'), { recursive: true, force: true })
    expect(await reviewVision('epic-reviewer', bare, { home, resolvePlan })).toBeNull()
    expect(await reviewVision('epic-reviewer', null, { home, resolvePlan })).toBeNull()
  })
})

describe('the vision once, by its bytes (112.1 AC2)', () => {
  it('passed also with --file it is sent once; bytes changed after it was read refuse the ask', async () => {
    const { worktree, visionPath } = planned()
    const { prepared } = await reviewerAsk('epic-reviewer', worktree, { files: [visionPath] })
    const prompt = readFileSync(join(prepared.folder, ASK_RUN_FILES.prompt), 'utf8')
    expect(prompt.match(/BEGIN FILE/gu)).toHaveLength(1)
    expect(prepared.manifest.files).toHaveLength(1)
    const vision = await reviewVision('epic-reviewer', worktree, { home, resolvePlan })
    writeFileSync(visionPath, `${VISION}- **P2. Another.**\n`)
    expect(() => prepareAsk({ role: 'epic-reviewer', question: 'x', project: worktree, files: [visionPath], vision: vision! }, { environment: env, cwd: worktree, home })).toThrow(/changed while the ask was being made/u)
  })
})

describe('whole or not at all (112.1 AC3)', () => {
  it('a vision over the 8 KiB ceiling, not text, or holding a credential is left out with the reason in manifest and receipt', async () => {
    const big = `${VISION}${'x'.repeat(8 * 1024)}\n`
    const cases: Array<[string | Buffer, RegExp]> = [
      [big, /is \d+ bytes, over the 8192-byte ceiling bmn plan check keeps for a vision/u],
      [Buffer.from([0xff, 0xfe, 0x00, 0x01]), /is not UTF-8 text/u],
      [`${VISION}token: gh${'p'}_${'a1B2c3D4e5'.repeat(4)}\n`, /holds .*so it was not given/u]
    ]
    for (const [bytes, reason] of cases) {
      rmSync(join(home, 'code'), { recursive: true, force: true })
      const { worktree, visionPath } = planned(bytes)
      const { vision, prepared } = await reviewerAsk('epic-reviewer', worktree)
      expect(vision).toEqual({ path: visionPath, omitted: expect.stringMatching(reason) })
      expect(prepared.verdict.verdict).toBe('PASS')
      expect(prepared.manifest.files).toHaveLength(0)
      expect(prepared.manifest.vision).toEqual(vision)
      expect(prepared.verdict.receipt?.vision).toEqual(vision)
      expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.prompt), 'utf8')).not.toContain('P1.')
    }
  })
})

describe.skipIf(!SCOPES)('bmn team ask with the vision (112.1 AC1, AC2)', { timeout: 60_000 }, () => {
  const bmn = (args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((done) => {
    const child = spawn(process.execPath, [BMN, ...args], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...ownSystemd() }, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdin.end('')
    child.on('exit', (code) => done({ code, stdout, stderr }))
  })
  const day = (): string => new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const runOf = (stderr: string): string => /run (\d{8}T\d{6}-[0-9a-f]{8})/u.exec(stderr)?.[1] ?? ''
  const request = (id: string) => JSON.parse(readFileSync(join(teamRunsDirectory(), id, ASK_RUN_FILES.request), 'utf8'))
  const manifest = (id: string) => JSON.parse(readFileSync(join(teamRunsDirectory(), id, ASK_RUN_FILES.manifest), 'utf8'))

  it('the vision changes the request hash; a same-key retry finds its run; a recheck carries the current vision in the same project and role', async () => {
    const { worktree, visionPath } = planned()
    const first = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Review it.', '--key', `${day()}-vision-1`], worktree)
    expect(first.code, first.stderr).toBe(0)
    expect(first.stderr).toContain(`it is given the project's vision ${visionPath} (sha256 ${sha(VISION).slice(0, 12)})`)
    const id = runOf(first.stderr)
    expect(manifest(id).vision).toMatchObject({ path: visionPath, sha256: sha(VISION) })
    // The same key and request: the original run, not a new one.
    const again = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Review it.', '--key', `${day()}-vision-1`, '--json'], worktree)
    expect(again.code, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout).id).toBe(id)
    // Changed vision bytes make another request: the same key now names a different one.
    const changed = `${VISION}- **P2. Answers say what they could not check.**\n`
    writeFileSync(visionPath, changed)
    const conflict = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Review it.', '--key', `${day()}-vision-1`, '--json'], worktree)
    expect(conflict.code).toBe(10)
    expect(JSON.parse(conflict.stdout)).toMatchObject({ refusal: { code: 'KEY_CONFLICT' } })
    // The recheck reads the current vision, in the earlier run's project and role.
    const recheck = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Recheck it.', '--recheck-of', id, '--key', `${day()}-vision-2`], worktree)
    expect(recheck.code, recheck.stderr).toBe(0)
    const rid = runOf(recheck.stderr)
    expect(request(rid)).toMatchObject({ role: 'epic-reviewer', project: request(id).project, recheck_of: id, agent: request(id).agent })
    expect(manifest(rid).vision).toMatchObject({ sha256: sha(changed) })
    // Given also with --file, it is sent once.
    const twice = await bmn(['team', 'ask', '--role', 'focused-reviewer', '--question', 'Look.', '--file', visionPath, '--key', `${day()}-vision-3`], worktree)
    expect(twice.code, twice.stderr).toBe(0)
    expect(manifest(runOf(twice.stderr)).files).toHaveLength(1)
    // A consultant from the same worktree is asked without it.
    const consult = await bmn(['team', 'ask', '--role', 'consultant', '--question', 'Which way?', '--key', `${day()}-vision-4`], worktree)
    expect(consult.code, consult.stderr).toBe(0)
    expect(consult.stderr).not.toContain('project\'s vision')
    expect(manifest(runOf(consult.stderr))).not.toHaveProperty('vision')
  })
})
