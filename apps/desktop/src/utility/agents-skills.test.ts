// MODULE: agents-skills.test.ts - Story 60.11: one skills folder for every app, over synthetic skills, a synthetic home and stub apps; no real app is started
import { execFile } from 'node:child_process'
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRoster, rewriteRoster } from '../../bin/agents-roster.mjs'
import { listTransactions, restoreTransaction } from '../../bin/agents-rules.mjs'
import {
  appSkills, appStateWord, checkExit, checkSkills, installSkills, lastLoadingTests, planSkillsInstall, skillDescription, skillsPlanView, skillsTests,
  skillsTestsPath, testSkills, testSkillsFolders, testSkillsLoading, treeHash, withHeader, type SkillsRoot, type SkillState
} from '../../bin/agents-skills.mjs'
import { machineDiff, readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const NOW = new Date('2026-10-10T12:00:00.000Z')
const CODEX = '0.161.0'
const CLAUDE = '2.1.295'
const OPENCODE = '1.18.31'
const VERSIONS = { codex: CODEX, claude: CLAUDE, opencode: OPENCODE, cursor: null }
/** A line only a skill's own text holds: no plan, result or record may carry it. */
const BODY = 'SYNTHETIC-SKILL-BODY-7f3a'

let home: string
let stubs: string
let source: string
let env: Record<string, string>
const savedHome = process.env.HOME

function withSkills(yaml: string, text = EXAMPLE): string {
  return `${text}\n## skills\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n`
}

function approve(text: string): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), text)
  let generation: number | null
  try {
    generation = JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation
  } catch {
    generation = null
  }
  approveRoster({ generation, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

function stub(name: string, body: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}

/** A stub app that names the skills in the given folders under HOME; `links` false makes it skip links, as an app that does not follow them would. */
function lister(name: string, version: string, command: string, folders: string[], { links = true, fail = false } = {}): void {
  stub(name, [
    `if [ "$1" = "--version" ]; then echo "${name} ${version}"; exit 0; fi`,
    `echo "$@" >> "${home}/calls-${name}.log"`,
    `env >> "${home}/env-${name}.log"`,
    ...(fail ? ['exit 3'] : []),
    `case "$*" in "${command}"*) ;; *) exit 4 ;; esac`,
    ...folders.map((folder) => `for d in "$HOME"/${folder}/*/; do ${links ? '' : '[ -L "${d%/}" ] && continue; '}[ -f "\${d}SKILL.md" ] && echo "skill $(basename "$d")"; done`),
    'exit 0'
  ].join('\n'))
}

function skill(name: string, { at = source, description = `Synthetic skill ${name}.`, extra = {} as Record<string, string> } = {}): string {
  const folder = join(at, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${BODY} ${name}\n`)
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(join(folder, file, '..'), { recursive: true })
    writeFileSync(join(folder, file), text)
  }
  return folder
}

function tested(harness: string, version: string, roots: SkillsRoot[], outcome = 'pass'): void {
  mkdirSync(join(home, '.config/bmn/agents/state'), { recursive: true })
  appendFileSync(skillsTestsPath(), `${JSON.stringify({ harness, kind: 'capability', at: NOW.toISOString(), version, outcome, roots, detail: 'synthetic' })}\n`)
}

const codexFolder = (): string => join(home, '.agents/skills')
const opencodeFolder = (): string => join(home, '.config/opencode/skills')
const check = () => checkSkills({ environment: env, versions: VERSIONS })
const states = (harness: string): Record<string, SkillState> => Object.fromEntries(check().apps.find((app) => app.harness === harness)!.skills.map((row) => [row.name, row.state]))
const install = (apps: string[] = [], options = {}) => installSkills(apps, { yes: true, environment: env, versions: VERSIONS, now: NOW, ...options })
const run = (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...argv], { env }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }))
})

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-skills-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  lister('codex', CODEX, 'debug prompt-input', ['.agents/skills'])
  lister('claude', CLAUDE, '-p', ['.claude/skills'])
  lister('opencode', OPENCODE, 'debug skill', ['.config/opencode/skills'])
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  source = join(home, '.claude/skills')
  skill('alpha', { extra: { 'notes/more.md': 'more\n' } })
  skill('beta')
  // gamma is a link into another folder, as a skill kept in a repository is; it holds a link of its own.
  const kept = skill('gamma', { at: join(home, 'kept') })
  writeFileSync(join(home, 'kept/outside.txt'), 'outside\n')
  symlinkSync('../outside.txt', join(kept, 'ref'))
  symlinkSync(kept, join(source, 'gamma'))
  approve(EXAMPLE)
  tested('codex', CODEX, [{ root: '.agents/skills', folder: true, link: true }])
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('the skills section of the team file (60.11 AC2, AC3)', () => {
  it('reads the folder, the public list and the per-app scope, and a team file without the section keeps its data', () => {
    const plain = parseRoster(EXAMPLE).data!
    expect(Object.keys(plain)).not.toContain('skills')
    const parsed = parseRoster(withSkills('public: [beta, alpha]\nonly: {gamma: [codex, claude], alpha: [cursor]}\nsource: /srv/skills'))
    expect(parsed.errors).toEqual([])
    expect(parsed.data!.skills).toEqual([{ id: 'alpha', public: true, only: ['cursor'] }, { id: 'beta', public: true }, { id: 'gamma', only: ['claude', 'codex'] }])
    expect(parsed.data!.skills_source).toBe('/srv/skills')
    expect(machineDiff(plain, parsed.data!).map((diff) => [diff.scope, diff.id, diff.kind])).toEqual([
      ['skills', 'alpha', 'added'], ['skills', 'beta', 'added'], ['skills', 'gamma', 'added'], ['skills', '.source', 'added']
    ])
  })

  it('refuses an unknown key, a name no app could take, an app BMN does not know and a doubled entry', () => {
    const codes = (yaml: string): string[] => parseRoster(withSkills(yaml)).errors.map((error) => error.code)
    expect(codes('extra: 1')).toEqual(['UNKNOWN_FIELD'])
    expect(codes('public: [Alpha]')).toEqual(['INVALID_VALUE'])
    expect(codes('public: [alpha, alpha]')).toEqual(['DUPLICATE_ID'])
    expect(codes('only: {alpha: [vim]}')).toEqual(['INVALID_VALUE'])
    expect(codes('only: {alpha: []}')).toEqual(['INVALID_VALUE'])
    expect(codes('source: skills')).toEqual(['INVALID_VALUE'])
  })

  it('rewrites only the section, keeps a matching block byte for byte and adds the section when it is missing', () => {
    const text = withSkills('# mine\npublic: [alpha]')
    const data = parseRoster(text).data!
    expect(rewriteRoster(text, data)).toBe(text)
    const narrowed = rewriteRoster(text, { ...data, skills: [{ id: 'alpha', public: true, only: ['codex'] }] })
    expect(narrowed).toBe(text.replace('# mine\npublic: [alpha]', 'public: [alpha]\nonly: {alpha: [codex]}'))
    const added = rewriteRoster(EXAMPLE, data)
    expect(added.startsWith(EXAMPLE)).toBe(true)
    expect(parseRoster(added).data!.skills).toEqual([{ id: 'alpha', public: true }])
    const none = { ...data, skills: [] }
    expect(parseRoster(rewriteRoster(text, none)).data).toEqual(parseRoster(EXAMPLE).data)
  })
})

describe('where an app reads skills: the owner-run test (60.11 AC1)', () => {
  it('finds the folder and that links are followed, in a throwaway home without the owner\'s files or sign-in, and sends no prompt', async () => {
    rmSync(skillsTestsPath())
    const result = await testSkillsFolders('codex', { environment: { ...env, OPENAI_API_KEY: 'synthetic-key', CODEX_HOME: join(home, '.codex') }, now: NOW })
    expect(result).toMatchObject({ kind: 'capability', outcome: 'pass', version: CODEX })
    expect(result.roots).toEqual([{ root: '.agents/skills', folder: true, link: true }, { root: '.codex/skills', folder: false, link: false }, { root: '.claude/skills', folder: false, link: false }])
    expect(readFileSync(join(home, 'calls-codex.log'), 'utf8').trim()).toBe('debug prompt-input')
    const seen = readFileSync(join(home, 'env-codex.log'), 'utf8')
    expect(seen).toMatch(new RegExp(`^HOME=${home}/\\.bmn-skills-test-[^/]+/home$`, 'm'))
    expect(seen).not.toMatch(/OPENAI_API_KEY|CODEX_HOME/)
    expect(readdirSync(home).filter((name) => name.startsWith('.bmn-skills-test-'))).toEqual([])
    // Nothing was put into the owner's own folders.
    expect(existsSync(codexFolder())).toBe(false)
    expect(appSkills('codex', { environment: env, version: CODEX, source })).toMatchObject({ supported: true, location: codexFolder(), format: 'link', reads_source: false })
  })

  it('records an app that names only real folders as needing copies, and one that reads the skills folder itself', async () => {
    lister('opencode', OPENCODE, 'debug skill', ['.config/opencode/skills', '.claude/skills'], { links: false })
    const result = await testSkillsFolders('opencode', { environment: env, now: NOW })
    expect(result.outcome).toBe('pass')
    expect(result.detail).toBe('OpenCode reads skills from ~/.config/opencode/skills (folders only, no links), ~/.claude/skills (folders only, no links)')
    expect(appSkills('opencode', { environment: env, version: OPENCODE, source })).toMatchObject({ supported: true, location: opencodeFolder(), format: 'copy', reads_source: true })
    // With the skills kept elsewhere, the same app no longer reads the source itself.
    expect(appSkills('opencode', { environment: env, version: OPENCODE, source: join(home, 'elsewhere') })).toMatchObject({ reads_source: false })
  })

  it('keeps an app unsupported when it cannot be asked, did not answer, or named nothing', async () => {
    stub('cursor-agent', 'echo "2026.09.26-dd393fe"; echo "$@" >> "' + home + '/calls-cursor.log"')
    expect(await testSkillsFolders('cursor', { environment: env, now: NOW })).toMatchObject({ outcome: 'unavailable' })
    lister('claude', CLAUDE, '-p', ['.claude/skills'], { fail: true })
    expect(await testSkillsFolders('claude', { environment: env, now: NOW })).toMatchObject({ outcome: 'inconclusive', detail: 'claude did not answer in a home folder without its sign-in' })
    lister('opencode', OPENCODE, 'debug skill', ['.nowhere'])
    expect(await testSkillsFolders('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'fail' })
    for (const harness of ['cursor', 'claude', 'opencode']) {
      expect(appSkills(harness, { environment: env, version: VERSIONS[harness as 'claude'] ?? '1.0.0', source }).supported).toBe(false)
    }
    expect(check().apps.find((app) => app.harness === 'opencode')).toMatchObject({ supported: false, skills: [] })
    expect(await planSkillsInstall(['opencode'], { environment: env, versions: VERSIONS })).toMatchObject({ code: 'SKILLS_UNSUPPORTED', targets: [] })
  })

  it('counts only a test of exactly the installed version, and the latest one decides', () => {
    expect(appSkills('codex', { environment: env, version: '0.162.0', source })).toMatchObject({ supported: false, reason: 'no test has run on Codex 0.162.0' })
    tested('codex', CODEX, [], 'fail')
    expect(appSkills('codex', { environment: env, version: CODEX, source }).supported).toBe(false)
    tested('codex', CODEX, [{ root: '.agents/skills', folder: true, link: false }])
    expect(appSkills('codex', { environment: env, version: CODEX, source })).toMatchObject({ supported: true, format: 'copy' })
  })
})

describe('check and install with links (60.11 AC2-AC4)', () => {
  it('links every skill into an empty folder, shows the list first, and reads current afterwards', async () => {
    expect(states('codex')).toEqual({ alpha: 'missing', beta: 'missing', gamma: 'missing' })
    expect(checkExit(check())).toBe(1)
    expect(appStateWord(check().apps[1]!)).toBe('Missing')
    const plan = skillsPlanView(await planSkillsInstall([], { environment: env, versions: VERSIONS }))
    expect(plan.targets.map((target) => [target.harness, target.skill, target.action, target.words])).toEqual([
      ['codex', 'alpha', 'link', 'adds the skill'], ['codex', 'beta', 'link', 'adds the skill'], ['codex', 'gamma', 'link', 'adds the skill']
    ])
    expect(existsSync(codexFolder())).toBe(false)
    const result = await install()
    expect(result).toMatchObject({ code: 'OK', exposed: [] })
    expect(result.written.map((entry) => entry.skill)).toEqual(['alpha', 'beta', 'gamma'])
    expect(readlinkSync(join(codexFolder(), 'alpha'))).toBe(join(source, 'alpha'))
    expect(readFileSync(join(codexFolder(), 'gamma/SKILL.md'), 'utf8')).toContain('gamma')
    expect(states('codex')).toEqual({ alpha: 'current', beta: 'current', gamma: 'current' })
    expect(checkExit(check())).toBe(0)
    expect(appStateWord(check().apps[1]!)).toBe('Linked')
    expect(await install()).toMatchObject({ code: 'OK', transaction: null, message: 'Every app already has its skills.' })
  })

  it('takes over an unmanaged folder and a foreign link only after showing them, leaves what the link points at alone, and one undo puts both back', async () => {
    const foreign = skill('elsewhere', { at: join(home, 'foreign') })
    mkdirSync(codexFolder(), { recursive: true })
    symlinkSync(foreign, join(codexFolder(), 'alpha'))
    const mine = skill('beta', { at: codexFolder(), extra: { 'own.md': 'own\n' } })
    chmodSync(join(mine, 'own.md'), 0o640)
    symlinkSync('own.md', join(mine, 'alias'))
    const before = treeHash(mine)
    const foreignBefore = treeHash(foreign)
    expect(states('codex')).toEqual({ alpha: 'link', beta: 'unmanaged', gamma: 'missing' })
    const plan = skillsPlanView(await planSkillsInstall(['codex'], { environment: env, versions: VERSIONS }))
    expect(plan.targets[0]).toMatchObject({ skill: 'alpha', change: 'link', link_target: foreign, detail: `link to ${foreign}; the link is replaced, what it points at is not touched` })
    expect(plan.targets[1]).toMatchObject({ skill: 'beta', change: 'unmanaged', detail: 'the folder there holds alias, own.md, which the skill does not' })
    expect(JSON.stringify(plan)).not.toContain(BODY)
    const result = await install(['codex'])
    expect(result.code).toBe('OK')
    expect(states('codex')).toEqual({ alpha: 'current', beta: 'current', gamma: 'current' })
    expect(treeHash(foreign)).toBe(foreignBefore)
    expect(listTransactions()[0]).toMatchObject({ id: result.transaction, reason: 'skills install', state: 'complete', targets: ['codex'] })
    // The backup is a private copy under BMN's own state.
    const folder = join(home, '.config/bmn/agents/state/rules/transactions', result.transaction!)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(treeHash(join(folder, '1.tree'))).toBe(before)

    const shown = await restoreTransaction(result.transaction!, { planOnly: true })
    expect(shown.targets!.map((target) => target.becomes)).toEqual([`link to ${foreign}`, 'the folder as it was', 'removed (it did not exist)'])
    expect((await restoreTransaction(result.transaction!, { yes: true, expectedPlanHash: shown.plan_hash! })).code).toBe('OK')
    expect(readlinkSync(join(codexFolder(), 'alpha'))).toBe(foreign)
    expect(treeHash(mine)).toBe(before)
    expect(statSync(join(mine, 'own.md')).mode & 0o777).toBe(0o640)
    expect(readlinkSync(join(mine, 'alias'))).toBe('own.md')
    expect(existsSync(join(codexFolder(), 'gamma'))).toBe(false)
    expect(states('codex')).toEqual({ alpha: 'link', beta: 'unmanaged', gamma: 'missing' })
  })

  it('adopts a link that already points at the skill only through an install', async () => {
    mkdirSync(codexFolder(), { recursive: true })
    symlinkSync(join(source, 'alpha'), join(codexFolder(), 'alpha'))
    expect(states('codex').alpha).toBe('unmanaged')
    await install(['codex'])
    expect(states('codex').alpha).toBe('current')
  })

  it('writes nothing when an entry changes after the list was shown, and stops part-way with an undo that puts everything back', async () => {
    const changed = await install(['codex'], { afterConfirm: () => skill('beta', { at: codexFolder() }) })
    expect(changed).toMatchObject({ code: 'REVISION_CONFLICT', transaction: null })
    expect(existsSync(join(codexFolder(), 'alpha'))).toBe(false)
    rmSync(join(codexFolder(), 'beta'), { recursive: true })

    const mine = skill('alpha', { at: codexFolder(), extra: { 'own.md': 'own\n' } })
    symlinkSync('own.md', join(mine, 'alias'))
    const before = treeHash(mine)
    const failed = await install(['codex'], { beforeTarget: (_target: unknown, index: number) => { if (index === 1) throw new Error('disk full') } })
    expect(failed).toMatchObject({ code: 'INSTALL_FAILED', written: [{ skill: 'alpha' }] })
    expect(failed.message).toContain(`1 entry changed; undo with bmn rules restore --transaction ${failed.transaction}`)
    expect(states('codex')).toEqual({ alpha: 'current', beta: 'missing', gamma: 'missing' })
    expect((await restoreTransaction(failed.transaction!, { yes: true })).code).toBe('OK')
    expect(treeHash(mine)).toBe(before)
    expect(readlinkSync(join(mine, 'alias'))).toBe('own.md')
    expect(states('codex')).toEqual({ alpha: 'unmanaged', beta: 'missing', gamma: 'missing' })
  })

  it('follows the source: an edit flows through the link, a new skill is missing, a removed one stays tracked until its removal is confirmed', async () => {
    const own = skill('codex-own', { at: codexFolder() })
    await install()
    writeFileSync(join(source, 'alpha/SKILL.md'), `---\nname: alpha\ndescription: Edited.\n---\n\n${BODY} edited\n`)
    skill('delta')
    rmSync(join(source, 'beta'), { recursive: true })
    expect(states('codex')).toEqual({ alpha: 'current', gamma: 'current', delta: 'missing', beta: 'stale' })
    expect(check().apps[1]!.skills.find((row) => row.name === 'beta')).toMatchObject({ removed: true })
    const plan = skillsPlanView(await planSkillsInstall([], { environment: env, versions: VERSIONS }))
    expect(plan.targets.map((target) => [target.skill, target.action])).toEqual([['delta', 'link'], ['beta', 'remove']])
    const result = await install()
    expect(result.code).toBe('OK')
    expect(states('codex')).toEqual({ alpha: 'current', gamma: 'current', delta: 'current' })
    expect(lstatSync(join(codexFolder(), 'beta'), { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(own, 'SKILL.md'))).toBe(true)
    // The undo brings the removed link back and takes the new one away.
    await restoreTransaction(result.transaction!, { yes: true })
    expect(readlinkSync(join(codexFolder(), 'beta'))).toBe(join(source, 'beta'))
    expect(existsSync(join(codexFolder(), 'delta'))).toBe(false)
  })

  it('refuses when the app no longer sends its data where the approved team says, and never passes an unreadable skills folder', async () => {
    expect(await install(['codex'], { environment: { ...env, OPENAI_BASE_URL: 'https://proxy.example.test/v1' } })).toMatchObject({ code: 'ROUTE_CHANGED', transaction: null })
    expect(existsSync(codexFolder())).toBe(false)
    approve(withSkills(`source: ${join(home, 'nowhere')}`))
    expect(check().source).toEqual({ path: join(home, 'nowhere'), readable: false, detail: 'the folder does not exist' })
    expect(checkExit(check())).toBe(1)
    expect(await install()).toMatchObject({ code: 'SOURCE_UNREADABLE', transaction: null })
  })

  it('lists a skill it cannot use as unreadable instead of leaving it out', () => {
    skill('Bad_Name')
    expect(states('codex').Bad_Name).toBe('unreadable')
    expect(checkExit(check())).toBe(1)
  })
})

describe('generated copies for an app that does not follow links (60.11 AC3, AC4)', () => {
  beforeEach(() => {
    tested('codex', CODEX, [{ root: '.agents/skills', folder: true, link: false }])
  })

  it('copies each skill with BMN\'s line after the front matter, keeps its files, modes and links, and never writes through a linked SKILL.md', async () => {
    chmodSync(join(source, 'alpha/notes/more.md'), 0o640)
    const shared = join(home, 'kept/shared-skill.md')
    writeFileSync(shared, '---\nname: linked\ndescription: Linked text.\n---\n\nshared\n')
    mkdirSync(join(source, 'linked'))
    symlinkSync(shared, join(source, 'linked/SKILL.md'))
    const result = await install()
    expect(result.written.map((entry) => entry.action)).toEqual(['copy', 'copy', 'copy', 'copy'])
    const text = readFileSync(join(codexFolder(), 'alpha/SKILL.md'), 'utf8')
    expect(text).toMatch(/^---\nname: alpha\ndescription: Synthetic skill alpha\.\n---\n\n<!-- Generated by BMN from the skills folder \(skill alpha, sha256 [0-9a-f]{64}\)\. Change the skill there, then run: bmn skills install -->\n\nSYNTHETIC/)
    expect(lstatSync(join(codexFolder(), 'alpha')).isSymbolicLink()).toBe(false)
    expect(statSync(join(codexFolder(), 'alpha/notes/more.md')).mode & 0o777).toBe(0o640)
    expect(readlinkSync(join(codexFolder(), 'gamma/ref'))).toBe('../outside.txt')
    expect(lstatSync(join(codexFolder(), 'linked/SKILL.md')).isFile()).toBe(true)
    expect(readFileSync(shared, 'utf8')).toBe('---\nname: linked\ndescription: Linked text.\n---\n\nshared\n')
    expect(states('codex')).toEqual({ alpha: 'current', beta: 'current', gamma: 'current', linked: 'current' })
    expect(appStateWord(check().apps[1]!)).toBe('Copied')
  })

  it('turns stale when the skill changes, names a copy edited outside by file only, and replaces it after the confirmation', async () => {
    await install()
    writeFileSync(join(source, 'alpha/notes/more.md'), 'more, changed\n')
    appendFileSync(join(codexFolder(), 'beta/SKILL.md'), 'edited outside\n')
    skill('delta')
    rmSync(join(source, 'gamma'))
    expect(states('codex')).toEqual({ alpha: 'stale', beta: 'edited-outside', delta: 'missing', gamma: 'stale' })
    expect(appStateWord(check().apps[1]!)).toBe('Differs')
    const plan = skillsPlanView(await planSkillsInstall([], { environment: env, versions: VERSIONS }))
    expect(plan.targets.map((target) => [target.skill, target.action, target.change])).toEqual([['alpha', 'copy', 'stale'], ['beta', 'copy', 'edited-outside'], ['delta', 'copy', 'missing'], ['gamma', 'remove', 'stale']])
    expect(plan.targets[1]!.detail).toBe('the folder there differs from the skill in SKILL.md')
    expect(JSON.stringify(plan)).not.toContain('edited outside')
    const edited = treeHash(join(codexFolder(), 'beta'))
    const result = await install()
    expect(result.code).toBe('OK')
    expect(states('codex')).toEqual({ alpha: 'current', beta: 'current', delta: 'current' })
    expect(readFileSync(join(codexFolder(), 'alpha/notes/more.md'), 'utf8')).toBe('more, changed\n')
    await restoreTransaction(result.transaction!, { yes: true })
    expect(treeHash(join(codexFolder(), 'beta'))).toBe(edited)
    expect(existsSync(join(codexFolder(), 'gamma/SKILL.md'))).toBe(true)
    expect(states('codex')).toMatchObject({ alpha: 'stale', beta: 'edited-outside', delta: 'missing', gamma: 'stale' })
  })

  it('withHeader keeps a file without front matter readable', () => {
    expect(withHeader('Body\n', 'x', 'h')).toBe('<!-- Generated by BMN from the skills folder (skill x, sha256 h). Change the skill there, then run: bmn skills install -->\n\nBody\n')
    expect(skillDescription('---\nname: a\ndescription: >\n  Folded first line.\n  second\n---\n')).toBe('Folded first line.')
    expect(skillDescription('---\ndescription: "Quoted."\n---\n')).toBe('Quoted.')
    expect(skillDescription('no front matter')).toBe('')
  })
})

describe('which skills an app may have (60.11 AC2, AC3)', () => {
  beforeEach(() => {
    tested('opencode', OPENCODE, [{ root: '.config/opencode/skills', folder: true, link: true }])
  })

  it('gives an app on a public-only route only the public skills, and a scoped skill only to its apps', async () => {
    approve(withSkills('public: [alpha, beta]\nonly: {beta: [codex]}'))
    expect(check().apps.map((app) => [app.harness, app.kind])).toEqual([['claude', 'full'], ['codex', 'full'], ['opencode', 'public'], ['cursor', 'public']])
    expect(states('opencode')).toEqual({ alpha: 'missing', beta: 'excluded', gamma: 'excluded' })
    const result = await install()
    expect(result.written.map((entry) => `${entry.harness}:${entry.skill}`)).toEqual(['codex:alpha', 'codex:beta', 'codex:gamma', 'opencode:alpha'])
    expect(readdirSync(opencodeFolder())).toEqual(['alpha'])
    expect(checkExit(check())).toBe(0)
    expect(appStateWord(check().apps[2]!)).toBe('Linked')
  })

  it('removes BMN\'s entries when a scope narrows, a skill leaves the public list or the app\'s destination stops taking private work', async () => {
    approve(withSkills('public: [alpha, beta]'))
    await install()
    expect(readdirSync(opencodeFolder())).toEqual(['alpha', 'beta'])
    approve(withSkills('public: [alpha]\nonly: {gamma: [claude]}'))
    expect(states('opencode')).toEqual({ alpha: 'current', beta: 'exposed', gamma: 'excluded' })
    expect(states('codex')).toEqual({ alpha: 'current', beta: 'current', gamma: 'exposed' })
    expect(checkExit(check())).toBe(1)
    expect(appStateWord(check().apps[2]!)).toBe('Exposed')
    const narrowed = await install()
    expect(narrowed.written).toEqual([
      { harness: 'codex', skill: 'gamma', path: join(codexFolder(), 'gamma'), action: 'remove' },
      { harness: 'opencode', skill: 'beta', path: join(opencodeFolder(), 'beta'), action: 'remove' }
    ])
    expect(checkExit(check())).toBe(0)
    // Codex's provider stops taking private work: only the public skill stays.
    approve(withSkills('public: [alpha]\nonly: {gamma: [claude]}', EXAMPLE.replace('sites: [openai.com], private_work: allowed', 'sites: [openai.com], private_work: public_only')))
    expect(states('codex')).toEqual({ alpha: 'current', beta: 'exposed', gamma: 'excluded' })
    const downgraded = await install()
    expect(downgraded.written).toEqual([{ harness: 'codex', skill: 'beta', path: join(codexFolder(), 'beta'), action: 'remove' }])
    expect(readdirSync(codexFolder())).toEqual(['alpha'])
    // The undo of a removal brings the link back.
    await restoreTransaction(downgraded.transaction!, { yes: true })
    expect(readlinkSync(join(codexFolder(), 'beta'))).toBe(join(source, 'beta'))
  })

  it('never removes an entry it did not write: it stays exposed, and no install reports success', async () => {
    skill('gamma', { at: opencodeFolder() })
    expect(states('opencode').gamma).toBe('exposed')
    const result = await install()
    expect(result.exposed).toEqual([{ harness: 'opencode', skill: 'gamma', path: join(opencodeFolder(), 'gamma'), fix: `BMN did not write ${join(opencodeFolder(), 'gamma')}: remove it by hand, or let OpenCode have the skill` }])
    expect(existsSync(join(opencodeFolder(), 'gamma/SKILL.md'))).toBe(true)
    expect((await run(['skills', 'install', '--yes'])).code).toBe(1)
    expect(checkExit(check())).toBe(1)
  })

  it('reports an app that reads the skills folder itself as exposed for every skill it may not have', async () => {
    tested('opencode', OPENCODE, [{ root: '.claude/skills', folder: true, link: true }])
    tested('claude', CLAUDE, [{ root: '.claude/skills', folder: true, link: true }])
    approve(withSkills('public: [alpha]\nonly: {beta: [codex]}'))
    expect(states('opencode')).toEqual({ alpha: 'read-directly', beta: 'exposed', gamma: 'exposed' })
    expect(states('claude')).toEqual({ alpha: 'read-directly', beta: 'exposed', gamma: 'read-directly' })
    expect(appStateWord(check().apps[0]!)).toBe('Exposed')
    const plan = await planSkillsInstall([], { environment: env, versions: VERSIONS })
    expect(plan.exposed.map((entry) => `${entry.harness}:${entry.skill}`)).toEqual(['claude:beta', 'opencode:beta', 'opencode:gamma'])
    expect(plan.exposed[0]!.fix).toBe('Claude Code reads the skills folder itself: move beta out of it, or mark it public')
    approve(withSkills('public: [alpha, beta, gamma]'))
    expect(states('opencode')).toEqual({ alpha: 'read-directly', beta: 'read-directly', gamma: 'read-directly' })
    expect(appStateWord(check().apps[2]!)).toBe('Reads the source')
  })
})

describe('whether a skill placed there loads: the owner-run test (60.11 AC5)', () => {
  it('places one empty test skill, asks the app once, removes it, and binds the result to the version, the destination and the skills', async () => {
    const result = await testSkills('codex', { environment: env, now: NOW })
    expect(result).toMatchObject({ outcome: 'pass', version: CODEX })
    expect(result.loading).toMatchObject({ kind: 'loading', outcome: 'pass', route: 'openai/observed-default/full' })
    expect(result.loading!.detail).toBe(`Codex named a test skill placed in ${codexFolder()}`)
    expect(readdirSync(codexFolder())).toEqual([])
    expect(readdirSync(home).filter((name) => name.startsWith('.bmn-skills-test-'))).toEqual([])
    const last = () => lastLoadingTests({ environment: env, versions: VERSIONS }).find((entry) => entry.harness === 'codex')!
    expect(last()).toMatchObject({ outcome: 'pass', stale: false })
    appendFileSync(join(source, 'alpha/SKILL.md'), 'changed\n')
    expect(last().stale).toBe(true)
    expect(lastLoadingTests({ environment: env, versions: { ...VERSIONS, codex: '0.162.0' } })[1]!.stale).toBe(true)
  })

  it('is not offered where the app may not receive private work, and says when the app did not show the skill', async () => {
    tested('opencode', OPENCODE, [{ root: '.config/opencode/skills', folder: true, link: true }])
    expect(await testSkillsLoading('opencode', { environment: env, now: NOW })).toMatchObject({ outcome: 'unavailable' })
    expect(existsSync(opencodeFolder())).toBe(false)
    // An app whose real folder is elsewhere than the test showed.
    lister('codex', CODEX, 'debug prompt-input', ['.nowhere'])
    expect(await testSkillsLoading('codex', { environment: env, now: NOW })).toMatchObject({ outcome: 'fail', detail: `Codex did not name a test skill placed in ${codexFolder()}` })
    expect(skillsTests().filter((entry) => entry.kind === 'loading')).toHaveLength(2)
  })
})

describe('bmn skills (60.11 AC2, AC3)', () => {
  it('check exits 1 while a skill is missing and 0 once installed; the undo goes through bmn rules restore', async () => {
    const before = await run(['skills', 'check', '--json'])
    expect(before.code).toBe(1)
    const parsed = JSON.parse(before.stdout)
    expect(parsed).toMatchObject({ ok: false, source: { path: source, readable: true } })
    expect(parsed.apps[1]).toMatchObject({ harness: 'codex', supported: true, kind: 'full', location: codexFolder(), format: 'link' })
    expect(before.stdout).not.toContain(BODY)
    const plan = JSON.parse((await run(['skills', 'install', '--plan', '--json'])).stdout)
    expect(plan.targets).toHaveLength(3)
    expect((await run(['skills', 'install', '--json'])).code).toBe(2)
    expect((await run(['skills', 'install', '--yes', '--expect-plan', 'wrong'])).code).toBe(7)
    const installed = await run(['skills', 'install', '--yes', '--expect-plan', plan.plan_hash])
    expect(installed.code).toBe(0)
    expect(installed.stdout).toMatch(/^Changed 3 entries \(transaction [0-9TZ-]+-\d+\)\.\nSessions started before this keep the skills they had\.$/m)
    const after = await run(['skills', 'check'])
    expect(after.code).toBe(0)
    expect(after.stdout).toContain(`Codex ${CODEX}: Linked - ${codexFolder()} (links); every skill it may have\n  current: 3`)
    expect(after.stdout).toContain('Cursor: skills not supported yet')
    const id = /transaction ([0-9TZ-]+-\d+)/.exec(installed.stdout)![1]!
    expect((await run(['rules', 'restore', '--transaction', id, '--yes'])).code).toBe(0)
    expect(readdirSync(codexFolder())).toEqual([])
    expect((await run(['skills', 'frobnicate'])).code).toBe(2)
    expect((await run(['skills', 'install', 'vim'])).code).toBe(2)
  })
})
