import { describe, expect, it } from 'vitest'
import type { LaunchTemplateRecord, SessionRecord } from '@bmn/protocol'
import { exactCommand, launchSetParams, matchingLiveCommands, seededEntry } from './launch-set-editor'

describe('saved launch-set form', () => {
  it('copies template argv exactly without its cwd and preserves argument boundaries', () => {
    const template = {
      templateId: 'template', name: 'Claude', executable: '/bin/echo', argv: ['one value', '--flag'],
      cwd: '/another', backgroundChoice: 'hide', revision: 1, createdAt: '2026-09-24T10:00:00.000Z'
    } satisfies LaunchTemplateRecord
    const form = seededEntry(template, 'entry-1')
    expect(form).not.toHaveProperty('cwd')
    expect(launchSetParams('workspace-1', 'Daily', [form]).entries[0]?.argv).toEqual(['one value', '--flag'])
    expect(exactCommand(template.executable, template.argv)).toBe('["/bin/echo","one value","--flag"]')
  })

  it('preserves invalid input for correction and warns only about matching live commands', () => {
    const form = { entryId: 'entry-1', name: 'Shell', executable: '/bin/echo', argvJson: '[wrong',
      backgroundChoice: null }
    expect(() => launchSetParams('workspace-1', 'Daily', [form])).toThrow('JSON array')
    const entry = { entryId: 'entry-1', name: 'Shell', executable: '/bin/echo', argv: ['hello'],
      backgroundChoice: null }
    const session = { sessionId: 'session-1', cwd: '/tmp', executable: '/bin/echo', argv: ['hello'] } as SessionRecord
    expect(matchingLiveCommands('/tmp', [entry], [session], new Set(['session-1']))).toEqual(['Shell'])
    expect(matchingLiveCommands('/tmp', [entry], [session], new Set())).toEqual([])
    expect(matchingLiveCommands('/other', [entry], [session], new Set(['session-1']))).toEqual([])
  })

  it('warns for a live command when the selected directory resolves to the same path', () => {
    const entry = { entryId: 'entry-1', name: 'Shell', executable: '/bin/echo', argv: ['hello'],
      backgroundChoice: null }
    const session = { sessionId: 'session-1', cwd: '/home/example/project',
      executable: '/bin/echo', argv: ['hello'] } as SessionRecord
    const canonical = (directory: string): string => (directory.startsWith('~/')
      ? `/home/example/${directory.slice(2)}` : directory).replace(/\/$/u, '').replace(/\/\.$/u, '')
    for (const directory of ['~/project', '~/project/', '/home/example/project/.']) {
      expect(matchingLiveCommands(directory, [entry], [session], new Set(['session-1']), canonical))
        .toEqual(['Shell'])
    }
  })
})
