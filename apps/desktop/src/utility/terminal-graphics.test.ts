import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SIXEL_TERM, STANDARD_TERM, installBundledTerminfo, sixelTerminfoReady,
  terminalGraphicsEnvironment
} from './terminal-graphics'

const bundled = fileURLToPath(new URL('../../resources/terminfo/x/xterm-sixel-256color', import.meta.url))

describe('graphics terminal identity', () => {
  it('resolves the bundled entry without hiding ordinary entries, then falls back if the copy changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-sixel-terminfo-'))
    try {
      const asset = installBundledTerminfo(root, bundled)
      expect(sixelTerminfoReady(asset)).toBe(true)
      const environment = { HOME: join(root, 'home'), TERMINFO_DIRS: '/owner/extra' }
      const graphics = terminalGraphicsEnvironment(null, environment, asset)
      expect(graphics.TERM).toBe(SIXEL_TERM)
      expect(graphics.TERMINFO_DIRS).toContain('/owner/extra')
      expect(graphics.TERMINFO_DIRS).toContain(join(root, 'home', '.terminfo'))
      expect(spawnSync('infocmp', [SIXEL_TERM], { env: { ...process.env, ...graphics }, encoding: 'utf8' }).status).toBe(0)
      expect(spawnSync('infocmp', [STANDARD_TERM], { env: { ...process.env, ...graphics }, encoding: 'utf8' }).status).toBe(0)
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
})
