// MODULE: consumers.test.mjs - Story 91.5 AC2: the consumer inventory finds a planted IPC name, a name built from strings, a mention only in a doc, computed imports and each hit's blame
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtFrom, historyOf, hitsOf, scan, spellings } from '../audit/consumers.mjs'

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

  it('lists the imports of a variable or a template a file could be loaded through, with the variable\'s defining line', () => {
    const root = tree({
      'src/loader.mjs': [
        "const RUN_MODULE = new URL('./run.mjs', import.meta.url).href",
        'const run = await import(RUN_MODULE)',
        "const fixed = await import('./fixed.mjs')",
        'const plugin = await import(`./plugins/${name}.mjs`)',
        "const plain = require(`./plain.mjs`)",
        'const typed = null as unknown as typeof import(\'./types.js\')'
      ].join('\n'),
      'docs/loading.md': 'Call `await import(name)` to load one.\n'
    })
    const { dynamic } = scan(['scripts/demo.mjs'], { roots: [root] })
    expect(dynamic.map((site) => [site.file, site.line, site.specifier, site.defined?.line ?? null])).toEqual([
      ['src/loader.mjs', 2, 'RUN_MODULE', 1],
      ['src/loader.mjs', 4, '`./plugins/${name}.mjs`', null]
    ])
  })

  it('gives each hit the commit that last changed its line, and none outside a checkout', () => {
    const root = tree({ 'src/user.ts': "import { shot } from './shot'\n" })
    const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], { encoding: 'utf8' })
    expect(hitsOf('shot', { roots: [root] }).map((hit) => hit.blame)).toEqual([null])
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'use the shot')
    const commit = git('rev-parse', 'HEAD').trim().slice(0, 8)
    expect(hitsOf('shot', { roots: [root] }).map((hit) => hit.blame)).toEqual([expect.stringMatching(new RegExp(`^${commit} \\d{4}-\\d{2}-\\d{2}$`, 'u'))])
    writeFileSync(join(root, 'src/later.ts'), 'shot()\n')
    git('add', '.')
    expect(hitsOf('shot', { roots: [root] }).map((hit) => [hit.file, hit.blame])).toContainEqual(['src/later.ts', 'uncommitted'])
  })
})
