// MODULE: staged-build.test.mjs - a failed update leaves the live build byte for byte; a passed one swaps it in (Story 38.2)
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFolders, liveBuildState, packageSmokeAndSwap, prepareBuildFolders, swapInStagedBuild } from '../lib/staged-build.mjs'

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
      .replace(repoRoot, '@REPO_ROOT@').replaceAll('\\', '/')
    expect(profile).toMatch(new RegExp(`profile bmn-electron-packaged-next "${staged}/bmn" flags=\\(unconfined\\) \\{\\s+userns,`, 'u'))
  })

  it('smokes the staged build and only then swaps it in, keeping the replaced one as prev', async () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    const oldBuild = fingerprint(folders.live)
    const fake = steps(folders, { smokePasses: true })
    const states = []
    let waited = 0

    await packageSmokeAndSwap({
      folders, step: fake.step, waitForExit: async () => { waited += 1 }, log: () => undefined, onLiveBuild: (state) => states.push(state)
    })

    expect(fake.ran).toEqual([
      ['package', ['run', 'package', `--config.directories.output=${folders.staging}`]],
      ['packaged smoke test', ['run', 'smoke:packaged', '--root', folders.next]]
    ])
    expect(waited).toBe(1)
    expect(states).toEqual(['new'])
    expect(readFileSync(join(folders.live, 'bmn'), 'utf8')).toContain('echo new')
    expect(fingerprint(folders.prev)).toBe(oldBuild)
    expect(existsSync(folders.next)).toBe(false)
    expect(existsSync(folders.staging)).toBe(false)
  })

  it('leaves the live build byte for byte and the staged one for inspection when the smoke fails', async () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    const oldBuild = fingerprint(folders.live)
    const fake = steps(folders, { smokePasses: false })
    const states = []

    await expect(packageSmokeAndSwap({
      folders, step: fake.step, waitForExit: async () => undefined, log: () => undefined, onLiveBuild: (state) => states.push(state)
    })).rejects.toThrow('packaged smoke test failed')

    expect(fingerprint(folders.live)).toBe(oldBuild)
    expect(readFileSync(join(folders.next, 'bmn'), 'utf8')).toContain('echo new')
    expect(existsSync(folders.prev)).toBe(false)
    expect(states).toEqual([])
  })

  it('never swaps while BMN is still running from the live build', async () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    const fake = steps(folders, { smokePasses: true })
    const order = []

    await packageSmokeAndSwap({
      folders,
      step: (label, args) => { order.push(label); fake.step(label, args) },
      waitForExit: async () => { order.push(`wait (live still old: ${readFileSync(join(folders.live, 'bmn'), 'utf8').includes('old')})`) },
      log: () => undefined,
      onLiveBuild: (state) => order.push(`swap ${state}`)
    })

    expect(order).toEqual(['package', 'packaged smoke test', 'wait (live still old: true)', 'swap new'])
  })

  it('puts the live build back when the second rename fails', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.next, 'new')
    const oldBuild = fingerprint(folders.live)
    const failing = { ...nodeFs, renameSync: (from, to) => {
      if (from === folders.next) throw new Error('EXDEV: cross-device link not permitted')
      renameSync(from, to)
    } }

    const result = swapInStagedBuild(folders, failing)

    expect(result.liveBuild).toBe('previous')
    expect(result.error.message).toContain('EXDEV')
    expect(fingerprint(folders.live)).toBe(oldBuild)
  })

  it('reports no live build when the rollback fails too', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.next, 'new')
    const failing = { ...nodeFs, renameSync: (from, to) => {
      if (from === folders.live) return renameSync(from, to)
      throw new Error('EIO')
    } }

    expect(swapInStagedBuild(folders, failing).liveBuild).toBe('none')
    expect(liveBuildState(folders)).toBe('half-swapped')
  })

  it('detects a stop between the two renames and restores the previous build at the next update', () => {
    const folders = release()
    writeBuild(folders.live, 'old')
    writeBuild(folders.next, 'new')
    const oldBuild = fingerprint(folders.live)
    // The worker died right after live -> prev.
    renameSync(folders.live, folders.prev)

    expect(liveBuildState(folders)).toBe('half-swapped')
    expect(prepareBuildFolders(folders)).toEqual({ restored: true })
    expect(fingerprint(folders.live)).toBe(oldBuild)
    expect(existsSync(folders.prev)).toBe(false)
    expect(existsSync(folders.next)).toBe(false)
  })

  it('removes the previous generation and old staging at the start, so an update holds at most three builds', async () => {
    const folders = release()
    writeBuild(folders.live, 'live')
    writeBuild(folders.prev, 'two-updates-ago')
    writeBuild(folders.next, 'failed-last-time')
    writeBuild(join(folders.staging, 'linux-unpacked'), 'half-packaged')
    let most = 0
    const count = () => { most = Math.max(most, [folders.live, folders.next, folders.prev, join(folders.staging, 'linux-unpacked')].filter(existsSync).length) }
    const fake = steps(folders, { smokePasses: true })

    await packageSmokeAndSwap({
      folders,
      step: (label, args) => { count(); fake.step(label, args); count() },
      waitForExit: async () => count(),
      log: () => undefined,
      onLiveBuild: () => count()
    })

    expect(most).toBeLessThanOrEqual(3)
    expect(readFileSync(join(folders.prev, 'bmn'), 'utf8')).toContain('echo live')
    expect(readFileSync(join(folders.live, 'bmn'), 'utf8')).toContain('echo new')
  })
})
