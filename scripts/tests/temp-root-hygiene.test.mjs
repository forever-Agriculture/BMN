import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDevelopmentRoot } from '../../apps/desktop/src/main/development-root'
import {
  createTemporaryRoot,
  startWithTemporaryRoot,
  temporaryRootContracts,
  withTemporaryRoot
} from '../lib/temporary-root.mjs'

const harnessRoots = new Set()

function harnessRoot() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-temp-hygiene-'))
  harnessRoots.add(root)
  return root
}

afterEach(() => {
  for (const root of harnessRoots) rmSync(root, { recursive: true, force: true })
  harnessRoots.clear()
})

describe('temporary root hygiene', () => {
  it.each([
    ['electron self-test', temporaryRootContracts.electronSelfTest],
    ['live shell drive', temporaryRootContracts.liveShell],
    ['packaged smoke', temporaryRootContracts.packagedSmoke]
  ])('%s removes its exact root after success', async (_name, contract) => {
    const outerRoot = harnessRoot()
    let createdRoot

    await withTemporaryRoot(contract, async (temporaryRoot) => {
      createdRoot = temporaryRoot.root
      writeFileSync(join(temporaryRoot.roots.state, 'receipt'), 'ok')
      expect(existsSync(temporaryRoot.root)).toBe(true)
    }, outerRoot)

    expect(existsSync(createdRoot)).toBe(false)
    expect(existsSync(outerRoot)).toBe(true)
  })

  it.each([
    ['electron self-test', temporaryRootContracts.electronSelfTest],
    ['live shell drive', temporaryRootContracts.liveShell],
    ['packaged smoke', temporaryRootContracts.packagedSmoke]
  ])('%s removes its exact root after an error', async (_name, contract) => {
    const outerRoot = harnessRoot()
    let createdRoot

    await expect(
      withTemporaryRoot(contract, async (temporaryRoot) => {
        createdRoot = temporaryRoot.root
        throw new Error('simulated launcher failure')
      }, outerRoot)
    ).rejects.toThrow('simulated launcher failure')

    expect(existsSync(createdRoot)).toBe(false)
    expect(existsSync(outerRoot)).toBe(true)
  })

  it('electron development cleanup is idempotent and bound to its created root', () => {
    const outerRoot = harnessRoot()
    const temporaryRoot = createTemporaryRoot(temporaryRootContracts.electronDevelopment, outerRoot)
    writeFileSync(join(temporaryRoot.roots.state, 'dev-state'), 'ok')

    temporaryRoot.cleanup()
    temporaryRoot.cleanup()

    expect(existsSync(temporaryRoot.root)).toBe(false)
    expect(existsSync(outerRoot)).toBe(true)
  })

  it('electron development removes its root when child startup throws', () => {
    const outerRoot = harnessRoot()
    let createdRoot

    expect(() => startWithTemporaryRoot(
      temporaryRootContracts.electronDevelopment,
      (temporaryRoot) => {
        createdRoot = temporaryRoot.root
        throw new Error('simulated child startup failure')
      },
      outerRoot
    )).toThrow('simulated child startup failure')

    expect(existsSync(createdRoot)).toBe(false)
    expect(existsSync(outerRoot)).toBe(true)
  })

  it('Electron main cleanup removes its fallback root after an error path', () => {
    const outerRoot = harnessRoot()
    const environment = {}
    const developmentRoot = createDevelopmentRoot(environment, outerRoot)
    if (!developmentRoot) throw new Error('expected a fallback development root')
    expect(existsSync(developmentRoot.root)).toBe(true)

    try {
      throw new Error('simulated startup failure')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    } finally {
      developmentRoot.cleanup()
    }

    expect(existsSync(developmentRoot.root)).toBe(false)
    expect(existsSync(outerRoot)).toBe(true)
  })

  // Epic 111 F20: Claude Code started inside a run re-pointed the owner's `claude` link into the run's root, then deleted.
  it('fails loudly, naming the way back, when a run points the claude link into its root', async () => {
    const outerRoot = harnessRoot()
    const bin = join(harnessRoot(), 'bin'); mkdirSync(bin)
    const link = join(bin, 'claude')
    symlinkSync('/synthetic/share/claude/versions/9.9.9', link)
    await expect(withTemporaryRoot(temporaryRootContracts.electronDevelopment, async (temporaryRoot) => {
      rmSync(link); symlinkSync(join(temporaryRoot.roots.data, 'claude/versions/9.9.9'), link)
    }, outerRoot, link)).rejects.toThrow("ln -sfn '/synthetic/share/claude/versions/9.9.9'")
  })

  it('leaves a claude link the run did not move, or moved elsewhere, alone', async () => {
    const outerRoot = harnessRoot()
    const bin = join(harnessRoot(), 'bin'); mkdirSync(bin)
    const link = join(bin, 'claude')
    symlinkSync('/synthetic/share/claude/versions/9.9.9', link)
    await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async () => {}, outerRoot, link)
    await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async () => {
      rmSync(link); symlinkSync('/synthetic/share/claude/versions/9.9.10', link)
    }, outerRoot, link)
    expect(readlinkSync(link)).toBe('/synthetic/share/claude/versions/9.9.10')
  })
})
