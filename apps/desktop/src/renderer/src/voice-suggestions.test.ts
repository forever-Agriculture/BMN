import { describe, expect, it } from 'vitest'
import { readRecentLines, suggestVocabulary, type RecentTextBuffer } from './voice-suggestions'

const base = { workspaceName: 'BMN', sessionName: 'dev-auto lead', cwd: '/home/o/code/BMN', lines: [], approved: [] }

describe('voice vocabulary suggestions', () => {
  it('offers the workspace, session and directory names first, once each', () => {
    expect(suggestVocabulary({ ...base, cwd: '/home/o/code/bmn' })).toEqual(['BMN', 'dev-auto lead'])
    expect(suggestVocabulary({ ...base, cwd: '/' })).toEqual(['BMN', 'dev-auto lead'])
    expect(suggestVocabulary({ ...base, workspaceName: 'Chancel, main', sessionName: 'x'.repeat(41), cwd: '/srv/chancel' }))
      .toEqual(['chancel'])
  })

  it('never offers a workspace, session or directory name that is a number, hash, URL or secret', () => {
    const excluded = ['12345', 'deadbeef', 'https://example.com', 'www.example.com', 'sk-project-secret123', 'q7Zk9vWp3mQxT1rL8yB2']
    for (const name of excluded) {
      expect(suggestVocabulary({ ...base, workspaceName: name, sessionName: '', cwd: '' }), `workspace ${name}`).toEqual([])
      expect(suggestVocabulary({ ...base, workspaceName: '', sessionName: name, cwd: '' }), `session ${name}`).toEqual([])
      // A directory's last segment cannot hold a scheme's slashes; the rest apply as they are.
      if (!name.includes('://')) {
        expect(suggestVocabulary({ ...base, workspaceName: '', sessionName: '', cwd: `/srv/${name}` }), `directory ${name}`).toEqual([])
      }
    }
    expect(suggestVocabulary({ ...base, workspaceName: '', sessionName: 'Deploy with ghp_abcdefghijklmnopqrstuvwxyz0123', cwd: '' })).toEqual([])
    // A long plain name is still a name, even with capitals and digits in it.
    expect(suggestVocabulary({ ...base, workspaceName: '', sessionName: 'Refactor SessionManager for Epic 9', cwd: '' }))
      .toEqual(['Refactor SessionManager for Epic 9'])
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
      'started 2026-09-18T20:00:00.000Z v1.2.3 v18 x86 h264 rc-1 in 120ms'
    ]
    expect(suggestVocabulary({ ...base, lines })).toEqual([
      'BMN', 'dev-auto lead',
      'file-reference.ts', 'voice.md',
      'x86', 'h264', 'rc-1', 'node18', 'utf8-decoder', 'SessionManager', 'pty_host'
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

  it('reads the newest rows first and stops at the row or byte bound, joining wrapped rows', () => {
    const rows: Array<{ text: string; wrapped?: boolean }> = [
      { text: 'old_line_one' },
      { text: 'Олександр'.repeat(4) },
      { text: 'first_half_', wrapped: false },
      { text: 'second_half', wrapped: true },
      { text: 'new_line  ' }
    ]
    const read: number[] = []
    const buffer: RecentTextBuffer = {
      length: rows.length,
      getLine(index) {
        const row = rows[index]
        if (!row) return undefined
        return {
          isWrapped: row.wrapped === true,
          translateToString: () => {
            read.push(index)
            return row.text
          }
        }
      }
    }
    expect(readRecentLines(buffer, 120, 16 * 1024)).toEqual(['old_line_one', 'Олександр'.repeat(4), 'first_half_second_half', 'new_line'])
    // The Cyrillic row is 72 bytes: with 40 bytes the read stops there, and nothing older is touched.
    read.length = 0
    expect(readRecentLines(buffer, 120, 40)).toEqual(['first_half_second_half', 'new_line'])
    expect(read).toEqual([4, 3, 2, 1])
    // A wrapped line whose first row is beyond the row bound is left out rather than cut mid-word.
    expect(readRecentLines(buffer, 2, 16 * 1024)).toEqual(['new_line'])
    expect(suggestVocabulary({ ...base, workspaceName: '', sessionName: '', cwd: '', lines: readRecentLines(buffer, 120, 40) }))
      .toEqual(['new_line', 'first_half_second_half'])
  })
})
