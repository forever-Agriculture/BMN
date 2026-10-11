// MODULE: session-guard-card.test.ts - Story 60.8 markup: the card says who may not see what and where, offers Allow here only when it can be recorded, and uses plain words
import type { GuardStop } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionGuardCard, guardMark, guardNote, guardPath, guardTitle } from './session-guard-card'

const STOP: GuardStop = {
  sessionId: 's1', incarnationId: 'incarnation-1', agent: 'claude', outcome: 'stop', cause: 'public-only',
  line: "Moonshot AI can't see private work in ~/code/app. Allow it in BMN.", allow: true,
  workspace: '/home/synthetic/code/app', folder: '/home/synthetic/code/app/src', processFolder: '/home/synthetic/code/app/src', providerId: 'moonshot', providerName: 'Moonshot AI', agentName: 'Kimi',
  host: 'api.moonshot.ai', pid: 7001, start: '777', conversation: null, at: '2026-10-10T12:00:00.000Z', kept: false
}
const NOW = Date.parse('2026-10-10T12:00:30.000Z')
const noop = (): void => undefined

function markup(stop: GuardStop, more: { busy?: boolean; refusal?: string | null } = {}): string {
  return renderToStaticMarkup(createElement(SessionGuardCard, {
    stop, place: { workspace: 'App', session: 'kimi' }, home: '/home/synthetic', now: NOW, anchor: null,
    busy: more.busy ?? false, refusal: more.refusal ?? null, onAllow: noop, onKeep: noop, onClose: noop
  }))
}
const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? '')

describe('the card a stopped prompt raises (60.8 AC3)', () => {
  it('asks to allow the agent and its provider in this workspace, with Allow here and Keep blocked', () => {
    const html = markup(STOP)

    expect(guardTitle(STOP)).toBe('Allow Kimi (Moonshot AI) in this workspace?')
    expect(html).toContain('<h3>Allow Kimi (Moonshot AI) in this workspace?</h3>')
    expect(html).toContain('Moonshot AI can&#x27;t see private work in ~/code/app. Allow it in BMN.')
    expect(html).toContain('<dt>Workspace</dt><dd class="mono" title="/home/synthetic/code/app">~/code/app</dd>')
    expect(html).toContain('<dt>Address</dt><dd class="mono">api.moonshot.ai</dd>')
    expect(html).toContain('Allow here adds this one workspace for Moonshot AI to your team as a new version. Then send the prompt again.')
    expect(html).toContain('stays on this computer')
    expect(buttons(html)).toEqual(['×', 'Allow here', 'Keep blocked'])
    expect(html).toContain('role="dialog" aria-label="Prompt guard"')
  })

  it('names the provider alone when the team has no agent on it, and disables both actions while Allow here runs', () => {
    expect(guardTitle({ ...STOP, agentName: null })).toBe('Allow Moonshot AI in this workspace?')
    expect(markup(STOP, { busy: true }).match(/disabled=""/g)).toHaveLength(2)
    expect(markup(STOP, { refusal: 'This session changed since the prompt was stopped. Send the prompt again.' }))
      .toContain('<p class="guard-refusal" role="alert">This session changed since the prompt was stopped. Send the prompt again.</p>')
  })

  it.each([
    ['unknown', "BMN can't tell where this Claude Code session sends work"],
    ['declared', "Moonshot AI can't see private work here"],
    ['state', "BMN can't read the approved team"],
    ['process', "BMN can't read how this Claude Code session was started"],
    ['slow', 'The check took too long']
  ] as const)('offers no Allow here for a stop caused by %s, and says what it is', (cause, title) => {
    const stop: GuardStop = { ...STOP, cause, allow: false, line: 'BMN stopped this prompt: a synthetic reason.' }
    const html = markup(stop)

    expect(guardTitle(stop)).toBe(title)
    expect(buttons(html)).toEqual(['×', 'Close'])
    expect(html).toContain('Send the prompt again once this is fixed.')
    // The card says what BMN did and on which version a live test showed the app obeys; another version is still the owner's to check.
    expect(html).toContain('BMN told Claude Code to stop this prompt. A live test showed Claude Code 2.1.296 obeys; on another version, check that the agent did not answer.')
    expect(markup({ ...stop, agent: 'codex' })).toContain('A live test showed Codex 0.162.1 obeys; on another version, check that the agent did not answer.')
    expect(html).not.toMatch(/went nowhere|Prompt stopped/)
  })

  it('keeps only the mark once the owner chose Keep blocked', () => {
    const html = markup({ ...STOP, kept: true })

    expect(buttons(html)).toEqual(['×', 'Allow here'])
    expect(html).not.toContain('needs-you')
  })
})

describe('an app BMN can only warn in (60.8 AC4)', () => {
  const WARNING: GuardStop = { ...STOP, agent: 'cursor', outcome: 'warn', cause: 'declared', allow: false, providerId: 'cursor', providerName: 'Cursor', agentName: null, host: 'default:cursor' }

  it('marks the session and says the prompt went on', () => {
    const html = markup(WARNING)

    expect(guardMark(WARNING)).toBe('Public-only provider on private work')
    expect(guardMark({ ...WARNING, cause: 'unknown' })).toBe('Unknown destination on private work')
    expect(guardMark(STOP)).toBe('Told to stop')
    expect(guardNote(WARNING)).toBe('Cursor cannot be told to stop a prompt, so this one went on. BMN only warns in Cursor.')
    expect(html).toContain('<strong>Prompt went on</strong>')
    expect(html).not.toContain('<dt>Address</dt>')
    expect(buttons(html)).toEqual(['×', 'Dismiss'])
  })
})

describe('the words of the card (R60-NFR8)', () => {
  it('writes a path under the home folder with ~ and leaves any other as it is', () => {
    expect(guardPath('/home/synthetic/code/app', '/home/synthetic')).toBe('~/code/app')
    expect(guardPath('/home/synthetic', '/home/synthetic')).toBe('~')
    expect(guardPath('/srv/app', '/home/synthetic')).toBe('/srv/app')
    expect(guardPath('/srv/app', null)).toBe('/srv/app')
  })

  it('uses none of the words the owner is never shown', () => {
    const text = [markup(STOP), markup({ ...STOP, cause: 'unknown', allow: false }), markup({ ...STOP, agent: 'cursor', outcome: 'warn', allow: false })].join(' ').replace(/<[^>]*>/g, ' ')

    expect(text).not.toMatch(/\b(harness|roster|route|generation|packet|seal|trust|exception)\b/i)
  })
})
