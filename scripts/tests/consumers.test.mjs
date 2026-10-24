// MODULE: consumers.test.mjs - Story 91.5 AC2: the consumer inventory finds a planted IPC name, a name built from strings and a mention only in a doc
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtFrom, historyOf, hitsOf, spellings } from '../audit/consumers.mjs'

let roots = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

/** A folder of synthetic files, not a Git checkout: every file is read. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-consumers-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('consumer inventory (Story 91.5 AC2)', () => {
  it('finds a planted IPC name where a handler registers it, and keeps a candidate\'s own file out when excluded', () => {
    const root = tree({
      'src/main/handlers.ts': "handle('aiterm:demo:thing', async () => null)\n",
      'src/preload/index.ts': "thing: () => ipcRenderer.invoke('aiterm:demo:thing')\n",
      'src/unrelated.ts': "handle('aiterm:demo:things', async () => null)\n"
    })
    const hits = hitsOf('aiterm:demo:thing', { roots: [root] })
    expect(hits.map((hit) => [hit.file, hit.line, hit.kind])).toEqual([['src/main/handlers.ts', 1, 'code'], ['src/preload/index.ts', 1, 'code']])
    expect(hitsOf('aiterm:demo:thing', { roots: [root], exclude: [join(root, 'src/main')] }).map((hit) => hit.file)).toEqual(['src/preload/index.ts'])
  })

  it('finds a name built from strings, by a template or a concatenation', () => {
    const root = tree({
      'src/main/channels.ts': "const channel = `aiterm:${area}:thing`\nconst other = 'aiterm:' + 'demo' + ':thing'\nconst none = `aiterm:${area}:other`\n"
    })
    expect(hitsOf('aiterm:demo:thing', { roots: [root] }).map((hit) => [hit.line, hit.kind])).toEqual([[1, 'built'], [2, 'built']])
    expect(builtFrom('aiterm:demo:thing', 'thing')).toBe(false)
  })

  it('reports a mention only in a doc as a doc hit, and a file by its name with or without its extension', () => {
    const root = tree({
      'docs/development.md': 'Run `scripts/test/demo-visual.mjs` to see it.\n',
      'skills/x/SKILL.md': 'The helper demo-visual draws one screen.\n',
      'src/a.ts': 'const demoVisual = 1\n'
    })
    expect(spellings('scripts/test/demo-visual.mjs')).toEqual(['scripts/test/demo-visual.mjs', 'demo-visual.mjs', 'demo-visual'])
    expect(hitsOf('scripts/test/demo-visual.mjs', { roots: [root] }).map((hit) => [hit.file, hit.kind])).toEqual([['docs/development.md', 'doc'], ['skills/x/SKILL.md', 'skill']])
  })

  it('gives a file the commits that changed it, and a name the commits that added or removed it', () => {
    const root = tree({ 'scripts/test/demo-visual.mjs': 'export const shot = 1\n' })
    const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], { stdio: 'ignore' })
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'add the harness')
    writeFileSync(join(root, 'scripts/test/demo-visual.mjs'), 'export const shot = 2\n')
    git('commit', '-q', '-am', 'change the harness')
    expect(historyOf('scripts/test/demo-visual.mjs', root)).toMatchObject({ commits: 2 })
    expect(historyOf('shot', root)).toMatchObject({ commits: 1 })
  })
})
