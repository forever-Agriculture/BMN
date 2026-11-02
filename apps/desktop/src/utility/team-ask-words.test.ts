// MODULE: team-ask-words.test.ts - Story 102.5: the skill, the help and the prompt say what a teammate's form reads and writes, in the words the record says
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ASK_READS, askReads } from '../../bin/agents-team-forms.mjs'
import { browserPrompt } from '../../bin/agents-team-browser.mjs'
import { CODEX_DENIED_WORDS } from '../../bin/native-rules.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\s+/gu, ' ')
const skill = read('skills/team-ask/SKILL.md')
const planSkill = read('skills/plan/SKILL.md')
const help = read('apps/desktop/bin/agents-team-cli.mjs')
const docs = read('docs/agent-control.md')
const SCRIPTS = 'read and write files and reach the network and local sockets'

describe('the words about a teammate (102.5)', () => {
  it('says with --interact that browser scripts run as his user and what they reach, everywhere an agent reads it', () => {
    const reads = askReads('codex-read-only', { interact: true })
    expect(reads.words).toContain(`as your user, and can ${SCRIPTS}`)
    expect(skill).toContain(`run as your user, and can ${SCRIPTS}`)
    expect(help).toContain(`run as your user, and can ${SCRIPTS}`)
    expect(docs).toContain(`as your user. They can read and write files and reach the network and local sockets`)
    expect(browserPrompt('Look.', { interact: true, origin: 'http://127.0.0.1:4173' })).toContain(`as your user, outside the app's read-only mode, and can ${SCRIPTS}`)
  })

  it('keeps "writes nothing" for every other ask and says Codex\'s reach as the form does (102.7 AC5)', () => {
    expect(skill).toContain('The teammate\'s app writes nothing')
    expect(askReads('codex-read-only')).toBe(ASK_READS['codex-read-only'])
    const reach = 'any file your user can read except the listed credential stores'
    expect(ASK_READS['codex-read-only'].reach).toBe(reach)
    expect(ASK_READS['codex-read-only'].words).toContain(CODEX_DENIED_WORDS)
    expect(skill).toContain(reach)
    for (const store of ['SSH private keys', 'GnuPG private keys', 'the Codex and Claude Code sign-ins', 'KeePass']) expect(skill).toContain(store)
    expect(browserPrompt('Look.', { interact: false, origin: 'http://127.0.0.1:4173' })).not.toContain('local sockets')
  })

  it('says masking comes after the provider has seen the text', () => {
    expect(skill).toContain('masked in the record and output, after the provider has seen it')
    expect(docs).toContain('Masking happens only there, after the provider has seen the text')
  })

  it('sends a consult to his recorded decisions first, and plan rule 7 says which lead fits which work, naming no model', () => {
    const decisions = 'where the owner\'s recorded decisions on that area live (the plan\'s Decisions, epic Logs, shared memory)'
    expect(skill).toContain(decisions)
    expect(planSkill).toContain('naming where his recorded decisions on that area live (the plan\'s Decisions, epic Logs, shared memory)')
    const rule = /7\. \*\*People from the team\.\*\*.*?(?= 8\. \*\*)/u.exec(planSkill)?.[0] ?? ''
    expect(rule).toContain('a provider the project keeps private data away from never leads it')
    expect(rule).toContain('A cheaper lead from the roster fits bounded routine work with clear patterns and tests')
    expect(rule).toContain('the roster\'s strongest leads fit coupled systems, migration, concurrency, security, privacy or evidence-heavy acceptance')
    expect(rule.slice(rule.indexOf('A cheaper lead'))).not.toMatch(/Opus|Sol\b|Luna|Terra|Astra|Fable|Haiku/u)
  })
})
