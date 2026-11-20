// MODULE: staged-build.test.mjs - a failed update leaves the live build byte for byte; a passed one swaps it in (Story 38.2)
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFolders, keepPassedBuild, liveBuildState, packageAndSmoke, prepareBuildFolders, swapInReadyBuild, undoSwap } from '../lib/staged-build.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function release() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-staged-build-'))
  roots.push(root)
  return buildFolders(join(root, 'linux-unpacked'))
}

function writeBuild(folder, label) {
  mkdirSync(join(folder, 'resources'), { recursive: true })
  writeFileSync(join(folder, 'bmn'), `#!/bin/sh\necho ${label}\n`, { mode: 0o755 })
  writeFileSync(join(folder, 'resources', 'app.asar'), `asar of ${label}`)
}

/** Every file under a folder with its bytes, so "unchanged" means byte for byte. */
function fingerprint(folder) {
  const hash = createHash('sha256')
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`)
      else hash.update(`${prefix}${entry.name}\0`).update(readFileSync(path)).update('\0')
    }
  }
  walk(folder, '')
  return hash.digest('hex')
}

/** A fake pnpm: package writes a new build where electron-builder would; the smoke passes or fails. */
function steps(folders, { smokePasses }) {
  const ran = []
  return {
    ran,
    step(label, args) {
      ran.push([label, args])
      if (label === 'package') writeBuild(join(folders.staging, 'linux-unpacked'), 'new')
      if (label === 'packaged smoke test' && !smokePasses) throw new Error('packaged smoke test failed with exit 1')
    }
  }
}

describe('staged desktop update', () => {
  it('allows Chromium user namespaces for the staged executable that the smoke runs', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const profile = readFileSync(join(repoRoot, 'scripts/sandbox/bmn-electron'), 'utf8')
    const staged = buildFolders(join(repoRoot, 'apps/desktop/release/linux-unpacked')).next
      .replace(repoRoot, '@REPO_ROOT@')
    expect(profile).toMatch(new RegExp(`profile bmn-electron-packaged-next "${staged}/bmn" flags=\\(unconfined\\) \\{\\s+userns,`, 'u'))
  })

  it('packages and smokes in next while the live build stays as it is, then keeps the passed build as ready (134.2)', async () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    const oldBuild = fingerprint(folders.live)
    const fake = steps(folders, { smokePasses: true })
    const logged = []

    await packageAndSmoke({ folders, step: async (label, args) => fake.step(label, args), log: (line) => logged.push(line) })

    expect(fake.ran).toEqual([
      ['package', ['run', 'package', `--config.directories.output=${folders.staging}`]],
      ['packaged smoke test', ['run', 'smoke:packaged', '--root', folders.next]]
    ])
    expect(logged).toEqual([`STAGED ${folders.next}`])
    expect(fingerprint(folders.live)).toBe(oldBuild)
    expect(existsSync(folders.staging)).toBe(false)
    keepPassedBuild(folders)
    expect(readFileSync(join(folders.ready, 'bmn'), 'utf8')).toContain('echo new')
    expect(existsSync(folders.next)).toBe(false)
    expect(fingerprint(folders.live)).toBe(oldBuild)
  })

  it('leaves the live build byte for byte and the tested one in next for inspection when the smoke fails', async () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.ready, 'passed-earlier')
    const oldBuild = fingerprint(folders.live), passed = fingerprint(folders.ready)
    const fake = steps(folders, { smokePasses: false })

    await expect(packageAndSmoke({ folders, step: async (label, args) => fake.step(label, args), log: () => undefined }))
      .rejects.toThrow('packaged smoke test failed')

    expect(fingerprint(folders.live)).toBe(oldBuild)
    expect(fingerprint(folders.ready)).toBe(passed)
    expect(readFileSync(join(folders.next, 'bmn'), 'utf8')).toContain('echo new')
    expect(existsSync(folders.prev)).toBe(false)
  })

  it('swaps the ready build in, keeping the replaced one as prev and removing an older prev', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.prev, 'two-updates-ago')
    writeBuild(folders.ready, 'new')
    const oldBuild = fingerprint(folders.live)

    expect(swapInReadyBuild(folders)).toEqual({ liveBuild: 'new' })
    expect(readFileSync(join(folders.live, 'bmn'), 'utf8')).toContain('echo new')
    expect(fingerprint(folders.prev)).toBe(oldBuild)
    expect(existsSync(folders.ready)).toBe(false)
  })

  it('a newer passed build replaces the older ready one', () => {
    const folders = release()
    writeBuild(folders.ready, 'a')
    writeBuild(folders.next, 'b')
    keepPassedBuild(folders)
    expect(readFileSync(join(folders.ready, 'bmn'), 'utf8')).toContain('echo b')
    expect(existsSync(folders.next)).toBe(false)
  })

  it('keeps the waiting build when the newer one cannot be moved into place (review F5)', () => {
    const folders = release()
    writeBuild(folders.ready, 'a')
    writeBuild(folders.next, 'b')
    const waiting = fingerprint(folders.ready)
    const failing = { ...nodeFs, renameSync: (from, to) => {
      if (from === folders.next) throw new Error('ENOSPC: no space left on device')
      renameSync(from, to)
    } }
    expect(() => keepPassedBuild(folders, failing)).toThrow(/ENOSPC/u)
    expect(fingerprint(folders.ready)).toBe(waiting)
    expect(existsSync(`${folders.ready}.old`)).toBe(false)
  })

  it('a failed install puts the previous build back live and keeps the new one ready (review F2)', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.ready, 'new')
    const oldBuild = fingerprint(folders.live), newBuild = fingerprint(folders.ready)
    expect(swapInReadyBuild(folders)).toEqual({ liveBuild: 'new' })
    expect(undoSwap(folders)).toEqual({ liveBuild: 'previous' })
    expect(fingerprint(folders.live)).toBe(oldBuild)
    expect(fingerprint(folders.ready)).toBe(newBuild)
    expect(existsSync(folders.prev)).toBe(false)
  })

  it('puts the live build back when the second rename fails', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.ready, 'new')
    const oldBuild = fingerprint(folders.live)
    const failing = { ...nodeFs, renameSync: (from, to) => {
      if (from === folders.ready) throw new Error('EXDEV: cross-device link not permitted')
      renameSync(from, to)
    } }

    const result = swapInReadyBuild(folders, failing)

    expect(result.liveBuild).toBe('previous')
    expect(result.error.message).toContain('EXDEV')
    expect(fingerprint(folders.live)).toBe(oldBuild)
  })

  it('reports no live build when the rollback fails too', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.ready, 'new')
    const failing = { ...nodeFs, renameSync: (from, to) => {
      if (from === folders.live) return renameSync(from, to)
      throw new Error('EIO')
    } }

    expect(swapInReadyBuild(folders, failing).liveBuild).toBe('none')
    expect(liveBuildState(folders)).toBe('half-swapped')
  })

  it('detects a stop between the two renames and restores the previous build at the next update', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.ready, 'new')
    const oldBuild = fingerprint(folders.live)
    // The worker died right after live -> prev.
    renameSync(folders.live, folders.prev)

    expect(liveBuildState(folders)).toBe('half-swapped')
    expect(prepareBuildFolders(folders)).toEqual({ restored: true })
    expect(fingerprint(folders.live)).toBe(oldBuild)
    expect(existsSync(folders.prev)).toBe(false)
    expect(existsSync(folders.ready)).toBe(false)
  })

  it('removes the previous generation and old staging at the start, so an update holds at most three builds', async () => {
    const folders = release()
    writeBuild(folders.live, 'live')
    writeBuild(folders.prev, 'two-updates-ago')
    writeBuild(folders.next, 'failed-last-time')
    writeBuild(folders.ready, 'passed-but-never-swapped')
    writeBuild(`${folders.ready}.old`, 'interrupted-promotion')
    writeBuild(join(folders.staging, 'linux-unpacked'), 'half-packaged')
    let most = 0
    const count = () => { most = Math.max(most, [folders.live, folders.next, folders.ready, folders.prev, join(folders.staging, 'linux-unpacked')].filter(existsSync).length) }
    const fake = steps(folders, { smokePasses: true })

    expect(prepareBuildFolders(folders)).toEqual({ restored: false })
    expect(existsSync(`${folders.ready}.old`)).toBe(false)
    await packageAndSmoke({ folders, step: async (label, args) => { count(); fake.step(label, args); count() }, log: () => undefined })
    keepPassedBuild(folders); count()
    swapInReadyBuild(folders); count()

    expect(most).toBeLessThanOrEqual(3)
    expect(readFileSync(join(folders.prev, 'bmn'), 'utf8')).toContain('echo live')
    expect(readFileSync(join(folders.live, 'bmn'), 'utf8')).toContain('echo new')
  })
})
