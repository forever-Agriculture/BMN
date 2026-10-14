// MODULE: retired-references.test.mjs - Epic 71 (71.2 AC5): the retired app is named only where the allowlist says why
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { ALLOWED, compareWithAllowed, findReferences } from '../lib/retired-references.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Built from parts, so this file names nothing the check looks for.
const NAME = ['Cur', 'sor'].join('')
const ID = NAME.toLowerCase()

describe('the retired app named in the repository (Epic 71, 71.2 AC5)', () => {
  it('finds each way of naming it, and not a text cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-retired-references-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      await mkdir(join(root, 'src'))
      const lines = [`${NAME} finished its turn`, `run ${ID}-agent`, `tag ${ID}-support-final`, `~/.${ID}/hooks.json`, `harness: '${ID}'`, `${ID.toUpperCase()}_API_KEY`]
      const plain = ['the cursor moves', 'applicationCursorKeysMode', `state.${ID} === 0`, `${ID}: '#e8e8e8'`, `lines[${ID}]`]
      await writeFile(join(root, 'src/named.ts'), `${lines.join('\n')}\n`)
      await writeFile(join(root, 'src/plain.ts'), `${plain.join('\n')}\n`)
      execFileSync('git', ['add', '.'], { cwd: root })
      const found = findReferences(root)
      assert.deepEqual(found.map((entry) => `${entry.file}:${entry.line}`), lines.map((_, index) => `src/named.ts:${index + 1}`))
      assert.deepEqual(compareWithAllowed(found, { 'src/gone.ts': 'old' }), { unexpected: ['src/named.ts'], stale: ['src/gone.ts'] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names it only where the allowlist says why, and every entry still names it', () => {
    const found = findReferences(repoRoot)
    assert.deepEqual(compareWithAllowed(found), { unexpected: [], stale: [] })
    for (const [file, reason] of Object.entries(ALLOWED)) assert.ok(typeof reason === 'string' && reason !== '', `${file} has no reason`)
  })

  it('keeps none of its history reader, its recorded payloads or its hook writer', () => {
    assert.equal(existsSync(join(repoRoot, `apps/desktop/src/utility/agent-history-${ID}.ts`)), false)
    assert.equal(existsSync(join(repoRoot, `apps/desktop/src/utility/test-fixtures/${ID}`)), false)
    // The hook writer lived in bin/bmn; what is left there is the refusal of its payloads in bmn hook claude.
    const bmn = readFileSync(join(repoRoot, 'apps/desktop/bin/bmn'), 'utf8')
    assert.equal(bmn.includes(`${ID}Requests`), false)
    assert.deepEqual(findReferences(repoRoot).filter((entry) => entry.file === 'apps/desktop/bin/bmn').map((entry) => entry.line).length, 2)
    assert.match(bmn, new RegExp(`agent === 'claude' && Object\\.hasOwn\\(event, '${ID}_version'\\)\\) return 0`))
  })
})
