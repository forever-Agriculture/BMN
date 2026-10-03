import { describe, expect, it } from 'vitest'
import { fixtureArguments } from '../lib/fixture-arguments.mjs'

describe('Electron fixture arguments', () => {
  it('preserves all payload bytes after the entry, with or without Playwright flags', () => {
    const entry = 'D:\\a\\BMN\\scripts\\fixture.mjs'
    const payload = ['D:\\a\\BMN', 'C:\\fixture 数据', 'node.exe', 'tree.cjs', 'report.json', 'without-backstop', '--bmn-test-mode']
    expect(fixtureArguments(['electron.exe', entry, ...payload], entry)).toEqual(payload)
    expect(fixtureArguments(['electron.exe', '--inspect=0', '--remote-debugging-port=0', entry, ...payload], entry)).toEqual(payload)
    expect(() => fixtureArguments(['electron.exe', '--inspect=0', ...payload], entry)).toThrow(/entry path/)
  })
})
