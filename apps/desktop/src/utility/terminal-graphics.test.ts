import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  SIXEL_TERM, STANDARD_TERM, installBundledTerminfo, sixelTerminfoReady,
  terminalGraphicsEnvironment
} from './terminal-graphics'

const bundled = fileURLToPath(new URL('../../resources/terminfo/x/xterm-sixel-256color', import.meta.url))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

describe('graphics terminal identity', () => {
  it('resolves the bundled entry without hiding ordinary entries, then falls back if the copy changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-sixel-terminfo-'))
    try {
      const asset = installBundledTerminfo(root, bundled)
      expect(sixelTerminfoReady(asset)).toBe(true)
      const environment = { HOME: join(root, 'home'), TERMINFO_DIRS: '/owner/extra' }
      const graphics = terminalGraphicsEnvironment(null, environment, asset)
      expect(graphics.TERM).toBe(SIXEL_TERM)
      if (process.platform !== 'win32') {
        expect(graphics.TERMINFO_DIRS).toContain('/owner/extra')
        expect(graphics.TERMINFO_DIRS).toContain(join(root, 'home', '.terminfo'))
        expect(spawnSync('infocmp', [SIXEL_TERM], { env: { ...process.env, ...graphics }, encoding: 'utf8' }).status).toBe(0)
        expect(spawnSync('infocmp', [STANDARD_TERM], { env: { ...process.env, ...graphics }, encoding: 'utf8' }).status).toBe(0)
      } else {
        expect(graphics).toEqual({ TERM: SIXEL_TERM })
      }
      expect(terminalGraphicsEnvironment('standard', environment, asset)).toEqual({ TERM: STANDARD_TERM })
      expect(terminalGraphicsEnvironment(null, environment)).toEqual({ TERM: STANDARD_TERM })
      const target = join(asset.directory, 'x', SIXEL_TERM)
      writeFileSync(target, Buffer.from('broken'))
      expect(terminalGraphicsEnvironment('sixel', environment, asset)).toEqual({ TERM: STANDARD_TERM })
      installBundledTerminfo(root, bundled)
      expect(readFileSync(target).equals(readFileSync(bundled))).toBe(true)
      expect(sixelTerminfoReady(asset)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the verified native graphics identity without requiring Unix infocmp or search paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-sixel-native-'))
    try {
      const asset = installBundledTerminfo(root, bundled)
      vi.mocked(spawnSync).mockClear()
      vi.mocked(spawnSync).mockImplementation(() => { throw new Error('Unix infocmp unavailable') })
      expect(sixelTerminfoReady(asset, 'win32')).toBe(true)
      expect(terminalGraphicsEnvironment(null, { HOME: root, TERMINFO_DIRS: '/linux/only' }, asset, 'win32'))
        .toEqual({ TERM: SIXEL_TERM })
      expect(spawnSync).not.toHaveBeenCalled()
      expect(terminalGraphicsEnvironment('standard', {}, asset, 'win32')).toEqual({ TERM: STANDARD_TERM })
      const target = join(asset.directory, 'x', SIXEL_TERM)
      writeFileSync(target, 'changed')
      expect(terminalGraphicsEnvironment('sixel', {}, asset, 'win32')).toEqual({ TERM: STANDARD_TERM })
    } finally {
      vi.mocked(spawnSync).mockReset()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
