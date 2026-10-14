import { describe, expect, it } from 'vitest'
import type { LaunchTemplateRecord, SessionRecord } from '@bmn/protocol'
import { exactCommand, launchSetParams, matchingLiveCommands, retiredEntryWords, seededEntry } from './launch-set-editor'

describe('saved launch-set form', () => {
  it('copies template argv exactly without its cwd and preserves argument boundaries', () => {
    const template = {
      templateId: 'template', name: 'Claude', executable: '/bin/echo', argv: ['one value', '--flag'],
      cwd: '/another', backgroundChoice: 'hide', terminalGraphics: 'sixel', revision: 1,
      createdAt: '2026-09-24T10:00:00.000Z'
    } satisfies LaunchTemplateRecord
    const form = seededEntry(template, 'entry-1')
    expect(form).not.toHaveProperty('cwd')
    expect(launchSetParams('workspace-1', 'Daily', [form]).entries[0]?.argv).toEqual(['one value', '--flag'])
    expect(exactCommand(template.executable, template.argv)).toBe('["/bin/echo","one value","--flag"]')
  })

  it('says on its line that an entry starting Cursor opens as a terminal, and nothing on any other (Epic 71)', () => {
    const words = 'opens as a terminal: Cursor was retired on 14 Oct 2026'
    expect(retiredEntryWords({ executable: '/usr/local/bin/cursor-agent', argv: [] })).toBe(words)
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-ic', 'cursor-agent; exec bash -i'] })).toBe(words)
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-ic', 'codex; exec bash -i'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/echo', argv: ['the cursor moves'] })).toBeNull()
    // Only where a program is started counts (Astra, Epic 71 review): a shell's commands, the program env runs.
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-lc', 'cd /repo && NO_COLOR=1 exec cursor-agent --model gpt-5'] })).toBe(words)
    expect(retiredEntryWords({ executable: '/usr/bin/env', argv: ['-u', 'TERM', 'NO_COLOR=1', 'cursor-agent'] })).toBe(words)
    expect(retiredEntryWords({ executable: '/usr/bin/env', argv: ['bash', '-c', 'cursor-agent'] })).toBe(words)
    // A prompt, a path or an echo that names it is the command's own data.
    expect(retiredEntryWords({ executable: 'codex', argv: ['exec', 'Explain cursor-agent'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-ic', 'codex "explain cursor-agent"; exec bash -i'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', 'echo cursor-agent'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['/repo/cursor-agent'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/usr/bin/env', argv: ['-u', 'cursor-agent', 'codex'] })).toBeNull()
    // A separator inside quotes parts nothing; a command substitution starts its own commands (Astra, Epic 71 recheck).
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-ic', 'codex "explain; cursor-agent"; exec bash -i'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', "codex 'a | cursor-agent && b'"] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', 'codex "say \\"x; cursor-agent\\""'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', 'codex explain\\;cursor-agent'] })).toBeNull()
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', 'echo "$(cursor-agent --version)"'] })).toBe(words)
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', 'version=`cursor-agent --version`'] })).toBe(words)
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', 'if true; then "cursor-agent"; fi'] })).toBe(words)
    expect(retiredEntryWords({ executable: '/bin/bash', argv: ['-c', 'codex & { cursor-agent; }'] })).toBe(words)
  })

  it('preserves invalid input for correction and warns only about matching live commands', () => {
    const form = { entryId: 'entry-1', name: 'Shell', executable: '/bin/echo', argvJson: '[wrong',
      backgroundChoice: null, terminalGraphics: null }
    expect(() => launchSetParams('workspace-1', 'Daily', [form])).toThrow('JSON array')
    const entry = { entryId: 'entry-1', name: 'Shell', executable: '/bin/echo', argv: ['hello'],
      backgroundChoice: null, terminalGraphics: null }
    const session = { sessionId: 'session-1', cwd: '/tmp', executable: '/bin/echo', argv: ['hello'] } as SessionRecord
    expect(matchingLiveCommands('/tmp', [entry], [session], new Set(['session-1']))).toEqual(['Shell'])
    expect(matchingLiveCommands('/tmp', [entry], [session], new Set())).toEqual([])
    expect(matchingLiveCommands('/other', [entry], [session], new Set(['session-1']))).toEqual([])
  })

  it('warns for a live command when the selected directory resolves to the same path', () => {
    const entry = { entryId: 'entry-1', name: 'Shell', executable: '/bin/echo', argv: ['hello'],
      backgroundChoice: null, terminalGraphics: null }
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
