// MODULE: quick-look.test.ts - the facts Quick look's path row and file states show, from names and sizes alone (Story 67.1)
import { describe, expect, it } from 'vitest'
import { quickLookCount, quickLookFileType, quickLookHomePath, quickLookInside, quickLookPathParts, quickLookSize } from './quick-look'

describe('Quick look file facts', () => {
  it('names a type and the colour set for each language criterion 6 lists', () => {
    const languages = Object.fromEntries(['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.json', 'a.jsonc', 'a.yaml', 'a.yml', 'a.toml', 'a.md',
      'a.css', 'a.html', 'a.py', 'a.rs', 'a.go', 'a.sql', 'a.sh', 'Dockerfile', 'a.diff'].map((name) => [name, quickLookFileType(name).language]))
    expect(languages).toEqual({
      'a.ts': 'typescript', 'a.tsx': 'tsx', 'a.js': 'javascript', 'a.jsx': 'jsx', 'a.json': 'json', 'a.jsonc': 'jsonc', 'a.yaml': 'yaml',
      'a.yml': 'yaml', 'a.toml': 'toml', 'a.md': 'markdown', 'a.css': 'css', 'a.html': 'html', 'a.py': 'python', 'a.rs': 'rust', 'a.go': 'go',
      'a.sql': 'sql', 'a.sh': 'shell', Dockerfile: 'dockerfile', 'a.diff': 'diff'
    })
    expect(quickLookFileType('/x/files-panel.tsx').label).toBe('TSX')
    expect(quickLookFileType('build.log')).toEqual({ label: 'Plain text log', language: null })
    expect(quickLookFileType('notes.zip')).toEqual({ label: 'Zip archive', language: null })
    expect(quickLookFileType('.env.local')).toEqual({ label: 'Environment', language: null })
    expect(quickLookFileType('LICENSE')).toEqual({ label: 'Text', language: null })
  })

  it('writes sizes and counts as the board does', () => {
    expect(quickLookSize(0)).toBe('0 bytes')
    expect(quickLookSize(742)).toBe('742 B')
    expect(quickLookSize(32_154)).toBe('31.4 KB')
    expect(quickLookSize(40_474_112)).toBe('38.6 MB')
    expect(quickLookSize(214_290)).toBe('209 KB')
    expect(quickLookCount(1240)).toBe('1,240')
    expect(quickLookCount(40474112)).toBe('40,474,112')
  })

  it('shortens the home folder and cuts the path so the name stays', () => {
    expect(quickLookHomePath('/home/me/code/BMN', '/home/me')).toBe('~/code/BMN')
    expect(quickLookHomePath('/home/me', '/home/me')).toBe('~')
    expect(quickLookHomePath('/home/meow/x', '/home/me')).toBe('/home/meow/x')
    expect(quickLookInside('/a/b', '/a/b/c')).toBe(true)
    expect(quickLookInside('/a/b', '/a/bc')).toBe(false)
    expect(quickLookPathParts('/a/b/src/x.ts', '/a/b')).toEqual({ directory: 'src/', name: 'x.ts', outside: false })
    expect(quickLookPathParts('/elsewhere/y.md', '/a/b')).toEqual({ directory: '/elsewhere/', name: 'y.md', outside: true })
  })
})
