// MODULE: file-reference-presentation.test.ts - base labels, marked lines and out-of-range wording for the file preview
import { describe, expect, it } from 'vitest'
import { baseDescription, byteSize, previewLines } from './file-reference-presentation'

describe('file-reference presentation', () => {
  it('names the launch directory and a chosen folder, never a current directory', () => {
    expect(baseDescription({ kind: 'launch-directory', path: '/p' })).toEqual({ label: 'Launch directory', path: '/p' })
    expect(baseDescription({ kind: 'chosen-directory', path: '/q' }))
      .toEqual({ label: 'Chosen folder, this opening only', path: '/q' })
    expect(baseDescription(null)).toEqual({ label: 'Absolute path', path: null })
  })

  it('marks only the referenced line and keeps the rest of the file around it', () => {
    const preview = previewLines({ content: 'one\ntwo\nthree\n', line: 2, column: 5 })
    expect(preview).toEqual({
      gutter: '1\n2\n3',
      before: 'one',
      target: 'two',
      after: 'three',
      lineCount: 3,
      position: 'Line 2, column 5 of 3 lines'
    })
    expect(previewLines({ content: 'only', line: 1, column: null })).toMatchObject({
      before: '', target: 'only', after: '', position: 'Line 1 of 1 line'
    })
  })

  it('explains a line past the end instead of claiming a jump', () => {
    expect(previewLines({ content: 'a\nb\n', line: 9, column: null })).toMatchObject({
      target: null,
      before: 'a\nb',
      position: 'Line 9 is past the end of the file (2 lines).'
    })
    expect(previewLines({ content: '', line: 1, column: null }).position)
      .toBe('Line 1 is past the end of the file (0 lines).')
  })

  it('shows a whole file when no line was given', () => {
    expect(previewLines({ content: 'a\nb', line: null, column: null }))
      .toMatchObject({ before: 'a\nb', target: null, position: '2 lines' })
  })

  it('formats sizes', () => {
    expect(byteSize(12)).toBe('12 B')
    expect(byteSize(12_600)).toBe('12.3 KiB')
    expect(byteSize(1024 * 1024)).toBe('1.0 MiB')
  })
})
