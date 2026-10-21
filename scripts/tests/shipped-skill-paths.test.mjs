// MODULE: shipped-skill-paths.test.mjs - Story79.5 guards shipped instructions against required owner-only home paths
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// The parent of BMN's default plan-version store is created by BMN, rather than supplied by its owner.
const createdPaths = new Set(['~/.local/state'])
const exceptions = [{ file: 'skills/jev-judge/SKILL.md', path: '~/code/jev-eval',
  reason: 'Historical synthetic proof named as evidence; running the judge does not need this directory.' }]

function shippedHomePaths() {
  const entries = []
  const visit = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue
      const file = join(relative, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        const bytes = readFileSync(join(root, file))
        if (bytes.includes(0)) continue
        for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
          for (const match of line.matchAll(/~\/[^\s`"'<>),;]+/gu)) entries.push({ file, line: index + 1, path: match[0] })
        }
      }
    }
  }
  for (const skill of JSON.parse(readFileSync(join(root, 'skills/manifest.json'), 'utf8')).skills) visit(join('skills', skill))
  return entries
}

describe('shipped skills work without the owner machine (79.5)', () => {
  it('names only BMN-created home paths or a documented optional reference', () => {
    const unexpected = shippedHomePaths().filter((entry) => !createdPaths.has(entry.path) &&
      !exceptions.some((exception) => exception.file === entry.file && exception.path === entry.path))
    assert.deepEqual(unexpected, [], unexpected.map((entry) => `${entry.file}:${entry.line}: ${entry.path}`).join('\n'))
  })

  it('keeps every optional exception specific, explained and present in the shipped instructions', () => {
    const found = shippedHomePaths()
    for (const exception of exceptions) {
      assert(exception.reason.trim())
      assert(found.some((entry) => entry.file === exception.file && entry.path === exception.path), `stale exception: ${exception.file} ${exception.path}`)
    }
  })
})
