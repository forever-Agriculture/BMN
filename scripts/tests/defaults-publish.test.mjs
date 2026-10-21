// MODULE: defaults-publish.test.mjs - Actual Linux helper qualification and fail-closed packaged bridge
import assert from 'node:assert/strict'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { publishSetupEntry } from '../../apps/desktop/bin/defaults-publish.mjs'
import { buildDefaultsNative } from '../build/defaults-native.mjs'
import { cliModules } from '../lib/cli-modules.mjs'

let root, helper, count = 0
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'bmn-defaults-publish-')); helper = buildDefaultsNative(join(root, 'defaults-publish')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
function fixture(kind = 'tree') {
  const path = join(root, `case-${count++}`); mkdirSync(path)
  if (kind === 'tree') { mkdirSync(join(path, 'staged')); writeFileSync(join(path, 'staged/SKILL.md'), '# Synthetic skill\n') }
  else symlinkSync('synthetic-owned-source', join(path, 'staged'))
  const source = lstatSync(join(path, 'staged')), parent = lstatSync(path), fd = openSync(path, 'r')
  return { path, fd, expected: { kind, object: `${source.dev}:${source.ino}`, parent: `${parent.dev}:${parent.ino}` } }
}
function admitted(fixture, work) {
  try { return withDefaultsAdmission(work, { directory: join(root, 'admission') }) } finally { closeSync(fixture.fd) }
}
const publish = (f, options = {}) => publishSetupEntry(f.fd, 'staged', 'target', f.expected, { helper, ...options })

describe('Linux setup publication helper', () => {
  for (const kind of ['tree', 'link']) {
    it(`publishes an absent ${kind} with exactly its staged inode`, () => {
      const f = fixture(kind)
      admitted(f, () => assert.equal(publish(f).code, 'OK'))
      const after = lstatSync(join(f.path, 'target'))
      assert.equal(`${after.dev}:${after.ino}`, f.expected.object); assert(!existsSync(join(f.path, 'staged')))
      if (kind === 'tree') assert.equal(readFileSync(join(f.path, 'target/SKILL.md'), 'utf8'), '# Synthetic skill\n')
      else assert(after.isSymbolicLink())
    })
  }

  for (const destination of ['empty-directory', 'nonempty-directory', 'file', 'link']) {
    it(`refuses a competing ${destination} without replacing it`, () => {
      const f = fixture(), target = join(f.path, 'target')
      if (destination.includes('directory')) { mkdirSync(target); if (destination.startsWith('nonempty')) writeFileSync(join(target, 'user'), 'synthetic user file') }
      else if (destination === 'file') writeFileSync(target, 'synthetic user file')
      else symlinkSync('synthetic-user-link', target)
      const prior = lstatSync(target)
      admitted(f, () => assert.throws(() => publish(f), error => error.code === 'REVISION_CONFLICT' && error.published === false))
      const after = lstatSync(target)
      assert.equal(after.ino, prior.ino); assert.equal(after.dev, prior.dev); assert(existsSync(join(f.path, 'staged/SKILL.md')))
    })
  }

  it('refuses a staged object replaced with identical contents', () => {
    const f = fixture(); renameSync(join(f.path, 'staged'), join(f.path, 'original'))
    mkdirSync(join(f.path, 'staged')); writeFileSync(join(f.path, 'staged/SKILL.md'), '# Synthetic skill\n')
    admitted(f, () => assert.throws(() => publish(f), /SOURCE_CHANGED/))
    assert(!existsSync(join(f.path, 'target'))); assert(existsSync(join(f.path, 'original/SKILL.md')))
  })

  it('refuses a mismatched parent identity and path traversal', () => {
    const f = fixture()
    admitted(f, () => {
      assert.throws(() => publishSetupEntry(f.fd, '../staged', 'target', f.expected, { helper }), /Invalid setup publication/)
      assert.throws(() => publishSetupEntry(f.fd, 'staged', 'target', { ...f.expected, parent: '0:0' }, { helper }), /parent changed/)
    })
    assert(!existsSync(join(f.path, 'target')))
  })

  it('does not fall back when the helper reports an unsupported operation', () => {
    const f = fixture(), unsupported = join(root, 'unsupported-helper')
    writeFileSync(unsupported, '#!/bin/sh\nprintf \'{"version":1,"published":false,"code":"UNSUPPORTED","errno":38}\\n\'\nexit 1\n', { mode: 0o700 })
    admitted(f, () => assert.throws(() => publish(f, { helper: unsupported }), error => error.code === 'DEFAULTS_PUBLICATION_UNAVAILABLE' && !error.published && !error.publicationUnknown))
    assert(!existsSync(join(f.path, 'target'))); assert(existsSync(join(f.path, 'staged/SKILL.md')))
  })

  it('marks missing receipts as uncertain and leaves recovery to the ownership journal', () => {
    const f = fixture(), broken = join(root, 'broken-helper')
    writeFileSync(broken, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    admitted(f, () => assert.throws(() => publish(f, { helper: broken }), error => error.publicationUnknown === true && error.published === false))
    assert(!existsSync(join(f.path, 'target')))
  })

  it('uses the same bridge and compiled helper from the packaged resources/bin layout', async () => {
    const source = new URL('../../apps/desktop/bin/', import.meta.url), packaged = join(root, 'resources/bin')
    mkdirSync(packaged, { recursive: true })
    // The bridge is packaged explicitly before the setup coordinator starts loading it from bmn.
    const modules = new Set([...cliModules(source.pathname), 'defaults-publish.mjs', ...cliModules(source.pathname, 'defaults-publish.mjs')])
    for (const name of modules) copyFileSync(new URL(name, source), join(packaged, name))
    copyFileSync(helper, join(packaged, 'defaults-publish'))
    const bridge = await import(pathToFileURL(join(packaged, 'defaults-publish.mjs')).href)
    const admission = await import(pathToFileURL(join(packaged, 'defaults-admission.mjs')).href)
    assert.equal(bridge.defaultsPublicationHelper(), join(packaged, 'defaults-publish'))
    const f = fixture()
    try {
      admission.withDefaultsAdmission(() => assert.equal(bridge.publishSetupEntry(f.fd, 'staged', 'target', f.expected).code, 'OK'), { directory: join(root, 'packaged-admission') })
    } finally { closeSync(f.fd) }
    assert(existsSync(join(f.path, 'target/SKILL.md')))
  })
})
