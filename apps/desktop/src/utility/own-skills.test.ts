import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installOwnSkills, ownCopiesRoot, pointsIntoBmn } from '../../bin/agents-own-skills.mjs'
import { checkSkills } from '../../bin/agents-skills.mjs'

let root: string, home: string, shipped: string, source: string, environment: Record<string, string>
const savedHome = process.env.HOME
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-own-skills-'))
  home = join(root, 'home'); shipped = join(root, 'shipped'); source = join(home, '.claude', 'skills')
  mkdirSync(source, { recursive: true })
  for (const name of ['plan', 'report-artifact']) skill(shipped, name, `${name} v1`)
  writeFileSync(join(shipped, 'manifest.json'), JSON.stringify({ skills: ['plan', 'report-artifact'] }))
  environment = { HOME: home, BMN_SHIPPED_SKILLS: shipped }
  process.env.HOME = home
})
afterEach(() => { process.env.HOME = savedHome; rmSync(root, { recursive: true, force: true }) })
function skill(base: string, name: string, text: string): string {
  mkdirSync(join(base, name), { recursive: true })
  writeFileSync(join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${text}\n---\n${text}\n`)
  return join(base, name)
}
const states = (): Record<string, string> => Object.fromEntries(installOwnSkills({ source, environment }).rows.map((row) => [row.name, row.state]))

describe('BMN\'s skills install themselves (Story 77.4)', () => {
  it('puts an absent skill in as a link to BMN\'s copy outside every install, readable with BMN closed', () => {
    expect(states()).toEqual({ plan: 'installed', 'report-artifact': 'installed' })
    const copy = join(ownCopiesRoot(environment), 'plan')
    expect(readlinkSync(join(source, 'plan'))).toBe(copy)
    expect(readFileSync(join(source, 'plan', 'SKILL.md'), 'utf8')).toContain('plan v1')
    rmSync(shipped, { recursive: true })
    expect(readFileSync(join(source, 'plan', 'SKILL.md'), 'utf8')).toContain('plan v1')
  })

  it('takes over a link into a BMN checkout or install, and leaves anything else of that name', () => {
    const checkout = join(root, 'checkout'); mkdirSync(join(checkout, 'apps/desktop/bin'), { recursive: true }); writeFileSync(join(checkout, 'apps/desktop/bin/bmn'), '')
    symlinkSync(skill(join(checkout, 'skills'), 'plan', 'checkout copy'), join(source, 'plan'))
    const elsewhere = skill(join(root, 'mine'), 'report-artifact', 'my own')
    symlinkSync(elsewhere, join(source, 'report-artifact'))
    expect(states()).toEqual({ plan: 'taken-over', 'report-artifact': 'foreign' })
    expect(readlinkSync(join(source, 'plan'))).toBe(join(ownCopiesRoot(environment), 'plan'))
    expect(readlinkSync(join(source, 'report-artifact'))).toBe(elsewhere)
    const install = join(root, 'resources'); mkdirSync(join(install, 'bin'), { recursive: true }); writeFileSync(join(install, 'bin/bmn.mjs'), '')
    expect(pointsIntoBmn(join(install, 'skills', 'plan'), 'plan')).toBe(true)
    expect(pointsIntoBmn(join(root, 'mine', 'plan'), 'plan')).toBe(false)
    rmSync(join(source, 'report-artifact')); skill(source, 'report-artifact', 'a folder of mine')
    expect(states()['report-artifact']).toBe('foreign')
    const view = checkSkills({ environment, versions: {}, generation: null })
    expect(view.own.find((row) => row.name === 'report-artifact')).toMatchObject({ state: 'foreign' })
    expect(view.skills.find((row) => row.name === 'plan')).toMatchObject({ own: true, public: true })
  })

  it('records the owner\'s removal and never adds it back; an unreadable copy is put back, not taken for a removal', () => {
    states()
    rmSync(join(source, 'plan'))
    expect(states().plan).toBe('removed')
    expect(states().plan).toBe('removed')
    expect(existsSync(join(source, 'plan'))).toBe(false)
    rmSync(join(ownCopiesRoot(environment), 'report-artifact'), { recursive: true })
    expect(states()['report-artifact']).toBe('repaired')
    expect(lstatSync(join(source, 'report-artifact')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(source, 'report-artifact', 'SKILL.md'), 'utf8')).toContain('report-artifact v1')
  })

  it('follows an update: the copy changes, the link stays', () => {
    states()
    skill(shipped, 'plan', 'plan v2')
    expect(states()).toEqual({ plan: 'updated', 'report-artifact': 'current' })
    expect(readFileSync(join(source, 'plan', 'SKILL.md'), 'utf8')).toContain('plan v2')
    expect(installOwnSkills({ source, environment, apply: false }).rows.map((row) => row.state)).toEqual(['current', 'current'])
  })

  it('gives a foreign folder or link of a shipped name no public mark (Sol review F1)', () => {
    skill(source, 'plan', 'a folder of mine')
    symlinkSync(skill(join(root, 'mine'), 'report-artifact', 'my own'), join(source, 'report-artifact'))
    expect(states()).toEqual({ plan: 'foreign', 'report-artifact': 'foreign' })
    const view = checkSkills({ environment, versions: {}, generation: null })
    for (const name of ['plan', 'report-artifact']) expect(view.skills.find((row) => row.name === name)).toMatchObject({ own: false, public: false })
    rmSync(join(source, 'plan'), { recursive: true }); states()
    expect(checkSkills({ environment, versions: {}, generation: null }).skills.find((row) => row.name === 'plan')).toMatchObject({ own: true, public: true })
  })

  it('retires a renamed skill\'s old name: BMN\'s link, copy and record go, the owner\'s own entry of that name stays', () => {
    states()
    skill(shipped, 'report-page', 'report-page v1')
    writeFileSync(join(shipped, 'manifest.json'), JSON.stringify({ skills: ['plan', 'report-page'], retired: ['report-artifact', 'plan'] }))
    const copy = join(ownCopiesRoot(environment), 'report-artifact')
    expect(installOwnSkills({ source, environment, apply: false }).rows.find((row) => row.name === 'report-artifact')).toMatchObject({ state: 'retired' })
    expect(lstatSync(join(source, 'report-artifact')).isSymbolicLink()).toBe(true)
    expect(states()).toEqual({ plan: 'current', 'report-page': 'installed', 'report-artifact': 'retired' })
    expect(existsSync(join(source, 'report-artifact')) || existsSync(copy)).toBe(false)
    expect(states()).toEqual({ plan: 'current', 'report-page': 'current' })
    skill(source, 'report-artifact', 'a folder of mine')
    expect(states()).toEqual({ plan: 'current', 'report-page': 'current' })
    expect(readFileSync(join(source, 'report-artifact', 'SKILL.md'), 'utf8')).toContain('a folder of mine')
  })

  it('writes nothing when asked only what it would do', () => {
    expect(installOwnSkills({ source, environment, apply: false }).rows.map((row) => row.state)).toEqual(['installed', 'installed'])
    expect(existsSync(join(source, 'plan'))).toBe(false)
  })
})
