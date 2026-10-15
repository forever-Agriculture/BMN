// MODULE: agents-project-choices.test.ts - Story 73.2: the owner's teammate for a role in one project: the team file's ## project-choices, its approval and its effect, asks in the project and its worktrees, and `bmn roster role --project`; a synthetic team, stand-in apps and made-up projects, nothing of the owner's is read
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consequences } from '../../bin/agents-check.mjs'
import { RETIRED_APPS, parseRoster, projectChoiceFor, projectChoiceProblem, rewriteRoster } from '../../bin/agents-roster.mjs'
import { machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { AskRefusal } from '../../bin/agents-team-resolve.mjs'
import { approveRoster, approveSections } from '../main/agents-approval'
import { previewApproval } from '../main/agents-ipc'

const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const NOW = new Date('2026-10-15T09:00:00')
const QUESTION = 'Is the retry loop bounded?'

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.org', '-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
})

/** The synthetic team with a `## project-choices` block of these lines. */
const withChoices = (...lines: string[]): string => `${EXAMPLE}\n## project-choices\n\n\`\`\`yaml\n${lines.join('\n')}\n\`\`\`\n`
const rosterFile = (): string => join(home, '.config/bmn/agents/roster.md')
/** The team file with Fable turned off, as the owner's switch writes it. */
const fableOff = (text: string): string => {
  const off = text.replace(/(## fable\n\n```yaml\n(?:.*\n)*?)enabled: true/u, '$1enabled: false')
  if (off === text) throw new Error('Fable is not on in this team file')
  return off
}
const generation = (): number | null => {
  try {
    return JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation
  } catch {
    return null
  }
}
const shown = () => ({ generation: generation(), fileHash: readValidRoster().hash })
/** Writes the team file and approves it whole, as the owner's Approve in the Team view does. */
function approve(text: string, now = NOW): void {
  writeFileSync(rosterFile(), text)
  approveRoster(shown(), { checkInspectedRoutes: () => {}, now: () => now })
}

/** A project with one commit. */
function makeProject(name: string): string {
  const root = join(home, 'code', name)
  mkdirSync(join(root, 'src'), { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'src/retry.ts'), 'export const tries = 3\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'first')
  return realpathSync(root)
}

const ask = (request: Partial<Parameters<typeof prepareAsk>[0]>, now = NOW) =>
  prepareAsk({ role: 'epic-reviewer', question: QUESTION, ...request }, { environment: env, cwd: home, home, now })
const refusal = (run: () => unknown): AskRefusal => {
  try {
    run()
  } catch (error) {
    if (error instanceof AskRefusal) return error
    throw error
  }
  throw new Error('expected a refusal')
}
const role = (...args: string[]) => {
  const run = spawnSync(process.execPath, [BMN, 'roster', 'role', ...args], { env: { HOME: home, PATH: '/usr/bin:/bin' }, cwd: home, encoding: 'utf8' })
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, json: () => JSON.parse(run.stdout) }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-project-choices-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  for (const [name, version] of [['claude', '2.1.300 (Claude Code)'], ['codex', 'codex-cli 0.162.1']] as const) {
    writeFileSync(join(stubs, name), `#!/bin/sh\n[ "$1" = --version ] && echo ${JSON.stringify(version)} && exit 0\nexit 3\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  // Made-up sign-in files: an ask binds them in and never reads them.
  for (const path of ['.codex/auth.json', '.claude/.credentials.json']) {
    mkdirSync(join(home, path, '..'), { recursive: true })
    writeFileSync(join(home, path), '{"synthetic": true}\n')
  }
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  approve(EXAMPLE)
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('the team file\'s ## project-choices (73.2 AC1)', () => {
  it('reads each choice with its project\'s folder, role, agent and the optional effort and end date', () => {
    const parsed = parseRoster(withChoices('shop-review: {project: /synthetic/code/shop/, role: epic-reviewer, agent: fable, effort: medium, ends: 2026-12-31}', 'shop-design: {project: /synthetic/code/shop, role: designer, agent: fable}'), { now: NOW })
    expect(parsed.errors).toEqual([])
    expect(parsed.data?.project_choices).toEqual([
      { id: 'shop-review', project: '/synthetic/code/shop', role: 'epic-reviewer', agent: 'fable', effort: 'medium', ends: '2026-12-31' },
      { id: 'shop-design', project: '/synthetic/code/shop', role: 'designer', agent: 'fable' }
    ])
    // A team without choices holds none, so its approved data does not change.
    expect(parseRoster(EXAMPLE).data).not.toHaveProperty('project_choices')
    expect(parseRoster(withChoices('# none yet')).data).not.toHaveProperty('project_choices')
  })

  it('refuses a choice it cannot read, and two choices for one project and role', () => {
    const codes = (line: string): string[] => parseRoster(withChoices(line)).errors.map((error) => error.code)
    expect(codes('a: {project: code/shop, role: epic-reviewer, agent: fable}')).toEqual(['PROJECT_CHOICE_PATH'])
    expect(codes('a: {project: ~/code/shop, role: epic-reviewer, agent: fable}')).toEqual(['PROJECT_CHOICE_PATH'])
    expect(codes('a: {project: /synthetic/../shop, role: epic-reviewer, agent: fable}')).toEqual(['PROJECT_CHOICE_PATH'])
    expect(codes('a: {project: /, role: epic-reviewer, agent: fable}')).toEqual(['PROJECT_CHOICE_PATH'])
    expect(codes('a: {project: /synthetic/shop, role: epic-reviewer, agent: fable, wide: true}')).toEqual(['UNKNOWN_FIELD'])
    expect(codes('a: {project: /synthetic/shop, role: epic-reviewer, agent: fable, effort: huge}')).toEqual(['INVALID_VALUE'])
    expect(codes('a: {project: /synthetic/shop, role: epic-reviewer, agent: fable, ends: 2026-02-30}')).toEqual(['INVALID_VALUE'])
    expect(codes('a: {project: /synthetic/shop, role: epic-reviewer}')).toEqual(['INVALID_VALUE'])
    expect(codes('Shop: {project: /synthetic/shop, role: epic-reviewer, agent: fable}')).toEqual(['INVALID_VALUE'])
    expect(parseRoster(withChoices('a: {project: /synthetic/shop, role: epic-reviewer, agent: fable}', 'b: {project: /synthetic/shop/, role: epic-reviewer, agent: astra}')).errors)
      .toMatchObject([{ code: 'PROJECT_CHOICE_COLLISION', message: expect.stringContaining('same project and role as a') }])
  })

  it('a choice its agent cannot answer, or one that ended, leaves the team valid and is noted (AC4)', () => {
    const parsed = parseRoster(withChoices(
      'off: {project: /synthetic/a, role: helper, agent: glm}',
      'proposed: {project: /synthetic/b, role: helper, agent: sonnet}',
      'no-role: {project: /synthetic/c, role: epic-reviewer, agent: luna}',
      'effort: {project: /synthetic/d, role: epic-reviewer, agent: astra, effort: high}',
      'gone-role: {project: /synthetic/e, role: auditor, agent: astra}',
      'ended: {project: /synthetic/f, role: epic-reviewer, agent: fable, ends: 2026-10-14}',
      'today: {project: /synthetic/g, role: epic-reviewer, agent: fable, ends: 2026-10-15}'
    ), { now: NOW })
    expect(parsed.data).not.toBeNull()
    const notes = parsed.warnings.filter((warning) => warning.code.startsWith('PROJECT_CHOICE')).map((warning) => `${warning.code} ${warning.message}`)
    expect(notes).toEqual([
      expect.stringMatching(/^PROJECT_CHOICE_UNAVAILABLE ## project-choices\.off: glm is disabled; helper asks in that project are refused until the choice is changed$/u),
      expect.stringMatching(/^PROJECT_CHOICE_UNAVAILABLE ## project-choices\.proposed: sonnet is proposed;/u),
      expect.stringMatching(/^PROJECT_CHOICE_UNAVAILABLE ## project-choices\.no-role: luna does not hold the role epic-reviewer;/u),
      expect.stringMatching(/^PROJECT_CHOICE_UNAVAILABLE ## project-choices\.effort: astra is asked at medium for epic-reviewer, not high;/u),
      expect.stringMatching(/^PROJECT_CHOICE_UNAVAILABLE ## project-choices\.gone-role: the role auditor is not in the team;/u),
      'PROJECT_CHOICE_ENDED ## project-choices.ended ended on 2026-10-14; it no longer applies'
    ])
    // No folder is printed where the check speaks: the choice is named by its id.
    expect(notes.join('\n')).not.toContain('/synthetic/')
    // An agent on a retired app answers nothing, whatever the file says of it.
    const data = parsed.data!
    const retired = { ...data, agents: data.agents.map((agent) => (agent.id === 'fable' ? { ...agent, harness: Object.keys(RETIRED_APPS)[0] as never } : agent)) }
    expect(projectChoiceProblem(retired, { id: 'a', project: '/synthetic/g', role: 'epic-reviewer', agent: 'fable' })).toBe('fable is retired')
  })

  it('a project through a link is noted: a choice counts only for the real folder', () => {
    const real = makeProject('shop')
    symlinkSync(real, join(home, 'shop-link'))
    const text = withChoices(`a: {project: ${join(home, 'shop-link')}, role: epic-reviewer, agent: fable}`)
    expect(parseRoster(text).warnings.map((warning) => warning.code)).toContain('PROJECT_CHOICE_LINK')
    // Asks find the project by its real path, so such a choice is never approved to sit there unused.
    writeFileSync(rosterFile(), text)
    expect(() => approveRoster(shown(), { checkInspectedRoutes: () => {}, now: () => NOW })).toThrow('the project choice a names its project through a link; a choice counts only for a project\'s real path, so write that path; nothing was approved')
    expect(readApproved().data.project_choices).toBeUndefined()
    approve(withChoices(`a: {project: ${real}, role: epic-reviewer, agent: fable}`))
    expect(readApproved().data.project_choices).toEqual([{ id: 'a', project: real, role: 'epic-reviewer', agent: 'fable' }])
  })

  it('a rewrite keeps the section as written while its data holds, and writes the data where it does not', () => {
    const text = withChoices('shop-review: {project: /synthetic/shop, role: epic-reviewer, agent: fable}   # chosen after the October review')
    const data = parseRoster(text).data!
    expect(rewriteRoster(text, data)).toBe(text)
    const changed = rewriteRoster(text, { ...data, project_choices: [{ ...data.project_choices![0]!, agent: 'astra', effort: 'medium' }] })
    expect(parseRoster(changed).data?.project_choices).toEqual([{ id: 'shop-review', project: '/synthetic/shop', role: 'epic-reviewer', agent: 'astra', effort: 'medium' }])
    // A team that gains its first choice gets the section.
    expect(parseRoster(rewriteRoster(EXAMPLE, { ...parseRoster(EXAMPLE).data!, project_choices: data.project_choices! })).data?.project_choices).toEqual(data.project_choices)
  })
})

describe('approving a choice in the Team view (73.2 AC2)', () => {
  it('takes effect only once approved, and its difference names the folder only in BMN\'s own review', () => {
    const shop = makeProject('shop')
    writeFileSync(rosterFile(), withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable, effort: medium}`))
    expect(readApproved().data.project_choices).toBeUndefined()
    const file = readValidRoster().data
    const status = machineDiff(readApproved().data, file)
    expect(status).toMatchObject([{ scope: 'project-choices', id: 'shop-review', field: null, kind: 'added' }])
    expect(JSON.stringify(status)).not.toContain(shop)
    expect(machineDiff(readApproved().data, file, { folders: true })[0]?.after?.value).toMatchObject({ project: shop, role: 'epic-reviewer', agent: 'fable', effort: 'medium' })
    // The review says who that role's asks there would reach, before and after.
    expect(consequences(readApproved().data, file)).toContain('epic-reviewer asks in one project would reach Fable at medium instead of the role\'s chain (Astra first)')
    approveSections(shown(), ['project-choices'], { checkInspectedRoutes: () => {}, now: () => NOW })
    expect(readApproved().data.project_choices).toEqual([{ id: 'shop-review', project: shop, role: 'epic-reviewer', agent: 'fable', effort: 'medium' }])
  })

  it('the Team view\'s preview refuses a choice its agent cannot answer, with the reason, before he approves', async () => {
    const shop = makeProject('shop')
    writeFileSync(rosterFile(), withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: luna}`))
    expect(await previewApproval({ kind: 'sections', scope: ['project-choices'] }, env)).toMatchObject({
      valid: false, errors: [{ code: 'PROJECT_CHOICE_UNAVAILABLE', message: 'the project choice shop-review cannot be kept: luna does not hold the role epic-reviewer; nothing was approved' }]
    })
    writeFileSync(rosterFile(), withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable}`))
    const preview = await previewApproval({ kind: 'sections', scope: ['project-choices'] }, env)
    expect(preview).toMatchObject({ valid: true, differences: [{ scope: 'project-choices', id: 'shop-review', kind: 'added' }] })
    expect(preview.consequences).toContain('epic-reviewer asks in one project would reach Fable instead of the role\'s chain (Astra first)')
  })

  it('says a changed, an extended and a removed choice in the same words', () => {
    const before = parseRoster(withChoices('a: {project: /synthetic/shop, role: epic-reviewer, agent: fable}')).data!
    const astra = parseRoster(withChoices('a: {project: /synthetic/shop, role: epic-reviewer, agent: astra, effort: medium}')).data!
    const ends = parseRoster(withChoices('a: {project: /synthetic/shop, role: epic-reviewer, agent: fable, ends: 2026-12-31}')).data!
    expect(consequences(before, astra)).toContain('epic-reviewer asks in one project would reach Astra at medium instead of Fable')
    expect(consequences(before, ends)).toContain('epic-reviewer asks in one project would reach Fable until 2026-12-31 instead of with no end date')
    expect(consequences(before, parseRoster(EXAMPLE).data!)).toContain('epic-reviewer asks in one project would reach the role\'s chain (Astra first) instead of Fable')
  })

  it('a new or changed choice is approved only for an agent that can answer it, and one that ended is refused', () => {
    const shop = makeProject('shop')
    const refused = (line: string): string => {
      writeFileSync(rosterFile(), withChoices(line))
      try {
        approveRoster(shown(), { checkInspectedRoutes: () => {}, now: () => NOW })
      } catch (error) {
        return (error as { code: string; message: string }).message
      }
      return 'approved'
    }
    expect(refused(`a: {project: ${shop}, role: epic-reviewer, agent: luna}`)).toBe('the project choice a cannot be kept: luna does not hold the role epic-reviewer; nothing was approved')
    expect(refused(`a: {project: ${shop}, role: epic-reviewer, agent: astra, effort: high}`)).toMatch(/astra is asked at medium for epic-reviewer, not high; nothing was approved/u)
    expect(refused(`a: {project: ${shop}, role: helper, agent: glm}`)).toMatch(/glm is disabled/u)
    expect(refused(`a: {project: ${shop}, role: epic-reviewer, agent: fable, ends: 2026-10-14}`)).toBe('the project choice a ended on 2026-10-14; nothing was approved')
    expect(readApproved().data.project_choices).toBeUndefined()
    expect(refused(`a: {project: ${shop}, role: epic-reviewer, agent: fable}`)).toBe('approved')
    // Its agent turned off later: the team stays valid and that change is approved; the choice stays, unavailable (AC4).
    approve(fableOff(readFileSync(rosterFile(), 'utf8')))
    expect(readApproved().data.agents.find((agent) => agent.id === 'fable')?.enabled).toBe(false)
    expect(readApproved().data.project_choices).toEqual([{ id: 'a', project: shop, role: 'epic-reviewer', agent: 'fable' }])
  })
})

describe('asks in the project and its worktrees (73.2 AC1, AC3, AC4)', () => {
  it('the choice answers its role\'s asks there and the record says which choice chose; naming someone else is refused naming it', () => {
    const shop = makeProject('shop')
    approve(withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable, effort: medium}`))
    const prepared = ask({ project: shop })
    expect(prepared.choice).toEqual({ agent: 'fable', effort: 'medium', rule: 'project-choice', phase: 'initial', project_choice: 'shop-review' })
    expect(JSON.parse(readFileSync(join(prepared.folder, 'request.json'), 'utf8'))).toMatchObject({ agent: 'fable', chosen_by: 'project-choice', project_choice: 'shop-review' })
    expect(refusal(() => ask({ project: shop, agent: 'astra' }))).toMatchObject({ code: 'PROJECT_CHOICE_CONFLICT', message: expect.stringContaining('needs the owner to change the choice first') })
    // Asked from inside the project, with no --project, the same.
    expect(prepareAsk({ role: 'epic-reviewer', question: QUESTION }, { environment: env, cwd: join(shop, 'src'), home, now: NOW }).choice.rule).toBe('project-choice')
    // Another role there, and the role elsewhere, follow the chain.
    expect(ask({ project: shop, role: 'final-reviewer', effort: 'high' }).choice.rule).toBe('chain')
    expect(ask({ project: makeProject('invoices') }).choice).toMatchObject({ agent: 'astra', rule: 'chain' })
  })

  it('a linked worktree of the repository counts as it; a subfolder named as the project and a copy do not', () => {
    const shop = makeProject('shop')
    approve(withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable}`))
    const worktree = join(home, 'worktrees/shop-feature')
    git(shop, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    expect(ask({ project: realpathSync(worktree) }).choice).toMatchObject({ agent: 'fable', rule: 'project-choice' })
    expect(ask({ project: join(shop, 'src') }).choice).toMatchObject({ agent: 'astra', rule: 'chain' })
    const copy = join(home, 'code/shop-copy')
    execFileSync('cp', ['-r', shop, copy])
    expect(ask({ project: realpathSync(copy) }).choice).toMatchObject({ agent: 'astra', rule: 'chain' })
  })

  it('a copy of a linked worktree, or a folder whose .git file points into the repository, does not count as it (epic review)', () => {
    const shop = makeProject('shop')
    approve(withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable}`))
    const worktree = join(home, 'worktrees/shop-feature')
    git(shop, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    const copy = join(home, 'worktrees/shop-feature-copy')
    execFileSync('cp', ['-r', worktree, copy])
    expect(readFileSync(join(copy, '.git'), 'utf8')).toContain(join(shop, '.git/worktrees/'))
    expect(ask({ project: realpathSync(copy) }).choice).toMatchObject({ agent: 'astra', rule: 'chain' })
    const forged = join(home, 'code/forged')
    mkdirSync(forged, { recursive: true })
    writeFileSync(join(forged, '.git'), `gitdir: ${join(shop, '.git/worktrees/shop-feature')}\n`)
    expect(ask({ project: realpathSync(forged) }).choice).toMatchObject({ agent: 'astra', rule: 'chain' })
    expect(ask({ project: realpathSync(worktree) }).choice).toMatchObject({ agent: 'fable', rule: 'project-choice' })
  })

  it('a choice naming a linked worktree is never approved: the repository\'s main folder holds it (epic review)', () => {
    const shop = makeProject('shop')
    const worktree = join(home, 'worktrees/shop-feature')
    git(shop, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    writeFileSync(rosterFile(), withChoices(`main: {project: ${shop}, role: epic-reviewer, agent: fable}`, `tree: {project: ${realpathSync(worktree)}, role: epic-reviewer, agent: astra}`))
    expect(() => approveRoster(shown(), { checkInspectedRoutes: () => {}, now: () => NOW })).toThrow('the project choice tree names a linked worktree; a choice names its repository\'s main folder, whose linked worktrees count as it; nothing was approved')
    expect(readApproved().data.project_choices).toBeUndefined()
  })

  it('the first folder with a choice that has not ended decides, whatever the team file\'s order (epic review)', () => {
    const data = parseRoster(EXAMPLE).data!
    const main = { id: 'main', project: '/synthetic/shop', role: 'epic-reviewer', agent: 'fable' }
    const tree = { id: 'tree', project: '/synthetic/shop-feature', role: 'epic-reviewer', agent: 'astra' }
    const folders = ['/synthetic/shop-feature', '/synthetic/shop']
    for (const order of [[main, tree], [tree, main]]) {
      expect(projectChoiceFor({ ...data, project_choices: order }, folders, 'epic-reviewer', NOW)).toEqual({ choice: tree, ended: false })
      expect(projectChoiceFor({ ...data, project_choices: order.map((choice) => (choice.id === 'tree' ? { ...choice, ends: '2026-10-14' } : choice)) }, folders, 'epic-reviewer', NOW)).toEqual({ choice: main, ended: false })
    }
    const both = [{ ...main, ends: '2026-10-13' }, { ...tree, ends: '2026-10-14' }]
    expect(projectChoiceFor({ ...data, project_choices: both }, folders, 'epic-reviewer', NOW)).toEqual({ choice: both[1], ended: true })
  })

  it('an ended choice no longer applies; one whose agent cannot answer is refused with the reason, never sent to another', () => {
    const shop = makeProject('shop')
    approve(withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable, ends: 2026-10-15}`))
    expect(ask({ project: shop }).choice.rule).toBe('project-choice')
    expect(ask({ project: shop }, new Date('2026-10-16T09:00:00')).choice).toMatchObject({ agent: 'astra', rule: 'chain' })
    approve(fableOff(readFileSync(rosterFile(), 'utf8')))
    expect(refusal(() => ask({ project: shop }))).toMatchObject({ code: 'AGENT_NOT_ELIGIBLE', message: expect.stringMatching(/^this project's approved choice fable \(shop-review\) is disabled; asks for epic-reviewer here are refused until the owner changes the choice$/u) })
  })
})

describe('`bmn roster role R --project P` (73.2 AC3, AC4)', () => {
  it('says the choice that applies, one that cannot be asked and why, an ended one, or none', () => {
    const shop = makeProject('shop')
    const invoices = makeProject('invoices')
    approve(withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable, effort: medium}`))
    const applies = role('epic-reviewer', '--project', shop, '--json')
    expect(applies.code).toBe(0)
    expect(applies.json()).toMatchObject({ ok: true, role: 'epic-reviewer', project: shop, project_choice: { id: 'shop-review', agent: 'fable', effort: 'medium', state: 'applies' } })
    expect(role('epic-reviewer', '--project', shop).stdout).toContain(`project ${shop}: fable@medium by the owner's choice shop-review; asks there go to fable, and naming someone else is refused`)
    expect(role('epic-reviewer', '--project', invoices, '--json').json()).toMatchObject({ project: invoices, project_choice: null })
    expect(role('epic-reviewer', '--project', invoices).stdout).toContain(`project ${invoices}: no choice of the owner's; the chain applies`)
    const worktree = join(home, 'worktrees/shop-feature')
    git(shop, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    expect(role('epic-reviewer', '--project', worktree, '--json').json()).toMatchObject({ project: realpathSync(worktree), project_choice: { id: 'shop-review', state: 'applies', worktree_of: shop } })
    approve(fableOff(readFileSync(rosterFile(), 'utf8')))
    expect(role('epic-reviewer', '--project', shop, '--json').json()).toMatchObject({ project_choice: { state: 'unavailable', reason: 'fable is disabled' } })
    expect(role('epic-reviewer', '--project', shop).stdout).toContain('names fable@medium, which cannot be asked now: fable is disabled; asks for the role there are refused until the owner changes the choice')
    expect(role('epic-reviewer', '--project', join(home, 'missing'), '--json')).toMatchObject({ code: 10 })
  })

  it('says an ended choice, and that the chain applies', () => {
    const shop = makeProject('shop')
    // Approved while it held; by now its end date has passed.
    approve(withChoices(`shop-review: {project: ${shop}, role: epic-reviewer, agent: fable, ends: 2020-01-02}`), new Date('2020-01-01T09:00:00'))
    expect(role('epic-reviewer', '--project', shop, '--json').json()).toMatchObject({ project_choice: { id: 'shop-review', state: 'ended', ends: '2020-01-02' } })
    expect(role('epic-reviewer', '--project', shop).stdout).toContain(`project ${shop}: the owner's choice shop-review (fable) ended on 2020-01-02; the chain applies`)
  })
})
