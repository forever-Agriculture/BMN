// MODULE: renderer-html-strings.test.ts - the renderer builds every element itself and never from an HTML string, so a Markdown file's raw HTML stays text (Story 67.4 AC3)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('the renderer builds elements, never HTML strings', () => {
  it('has no dangerouslySetInnerHTML or innerHTML anywhere in its source', () => {
    const files: string[] = []
    const walk = (folder: string): void => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(?:ts|tsx)$/u.test(name) && !/\.test\.tsx?$/u.test(name)) files.push(path)
      }
    }
    walk(join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer'))
    const offenders = files.filter((path) => /dangerouslySetInnerHTML|innerHTML/u.test(readFileSync(path, 'utf8')))
    expect(files.length).toBeGreaterThan(50)
    expect(offenders).toEqual([])
  })
})
