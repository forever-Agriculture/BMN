import { describe, expect, it } from 'vitest'
import { boundSuggestionLines, suggestVocabulary } from './voice-suggestions'

const base = { workspaceName: 'BMN', sessionName: 'dev-auto lead', cwd: '/home/o/code/BMN', lines: [], approved: [] }

describe('voice vocabulary suggestions', () => {
  it('offers the workspace, session and directory names first, once each', () => {
    expect(suggestVocabulary({ ...base, cwd: '/home/o/code/bmn' })).toEqual(['BMN', 'dev-auto lead'])
    expect(suggestVocabulary({ ...base, cwd: '/' })).toEqual(['BMN', 'dev-auto lead'])
    expect(suggestVocabulary({ ...base, workspaceName: 'Chancel, main', sessionName: 'x'.repeat(41), cwd: '/srv/chancel' }))
      .toEqual(['chancel'])
  })

  it('finds file names, then identifiers, newest line first, and skips prose, numbers, hashes, URLs and secrets', () => {
    const lines = [
      'Compiled SessionManager and pty_host in 1.2 s',
      'commit 3f2a9c1e7b0d4 by someone on 2026-09-19 at 12:30',
      'see https://github.com/org/repo/blob/main/src/parser.ts and www.example.com/x',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123 key sk-proj-abc123 AKIAIOSFODNN7EXAMPLE',
      'raw q7Zk9vWp3mQxT1rL8yB2 stays out but node18 and utf8-decoder stay in',
      'edit refs/src/file-reference.ts:42:7 and "docs/voice.md"',
      'Plain English words like Terminal are not identifiers.',
      'started 2026-09-18T20:00:00.000Z v1.2.3 x86 rc-1'
    ]
    expect(suggestVocabulary({ ...base, lines })).toEqual([
      'BMN', 'dev-auto lead',
      'file-reference.ts', 'voice.md',
      'rc-1', 'node18', 'utf8-decoder', 'SessionManager', 'pty_host'
    ])
  })

  it('accepts Ukrainian and dotted identifiers, dedupes against the approved list case-insensitively and caps at 30', () => {
    const lines = ['Запуск pty_host: робочий_простір і КаталогФайлів готові', 'package.json read by Sessionmanager']
    expect(suggestVocabulary({ ...base, lines, approved: ['sessionmanager', 'bmn'] })).toEqual([
      'dev-auto lead', 'package.json', 'pty_host', 'робочий_простір', 'КаталогФайлів'
    ])
    const many = Array.from({ length: 50 }, (_, index) => `word_${index}`)
    const suggestions = suggestVocabulary({ ...base, workspaceName: '', sessionName: '', cwd: '', lines: many })
    expect(suggestions).toHaveLength(30)
    expect(suggestions[0]).toBe('word_49')
    expect(suggestions.at(-1)).toBe('word_20')
  })

  it('reads only the newest rows within the byte bound', () => {
    const lines = ['old_line_one', 'x'.repeat(16 * 1024 - 10), 'new_line']
    expect(boundSuggestionLines(lines)).toEqual(['x'.repeat(16 * 1024 - 10), 'new_line'])
    expect(boundSuggestionLines(['Олександр'], 4)).toEqual([])
    expect(suggestVocabulary({ ...base, workspaceName: '', sessionName: '', cwd: '', lines })).toEqual(['new_line'])
  })
})
