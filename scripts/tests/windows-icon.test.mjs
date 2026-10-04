import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { windowsIconFromPng } from '../lib/windows-icon.mjs'

it('preserves the supplied 256-pixel PNG inside a standard ICO entry', () => {
  const png = readFileSync(new URL('../../apps/desktop/resources/icons/hicolor/256x256.png', import.meta.url))
  const ico = windowsIconFromPng(png)
  expect(ico.readUInt16LE(2)).toBe(1); expect(ico.readUInt16LE(4)).toBe(1)
  expect(ico[6]).toBe(0); expect(ico[7]).toBe(0)
  expect(ico.readUInt32LE(14)).toBe(png.length); expect(ico.readUInt32LE(18)).toBe(22)
  expect(ico.subarray(22)).toEqual(png)
  expect(() => windowsIconFromPng(Buffer.alloc(30))).toThrow('not PNG')
})
