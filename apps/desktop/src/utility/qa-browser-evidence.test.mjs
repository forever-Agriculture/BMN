// MODULE: qa-browser-evidence.test.mjs - only native inline PNGs can enter a QA report
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { captureQaScreenshot } from '../../bin/qa-browser-relay.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg=='
const other = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DQAAAEgQGA3iVNQgAAAABJRU5ErkJggg=='
const response = data => ({ content: [{ type: 'image', mimeType: 'image/png', data }] })
const roots = []
const fixture = () => {
  const folder = mkdtempSync(join(tmpdir(), 'qa-native-shot-'))
  roots.push(folder); mkdirSync(join(folder, 'browser'))
  return { folder, record: { screenshots: [] } }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('a browser-prefixed filename gets an inline native PNG, canonical path and verified hash', async () => {
  const { folder, record } = fixture(), native = vi.fn(async () => response(png))
  const result = await captureQaScreenshot(folder, record, { filename: 'browser/cart.png', fullPage: true }, native)
  expect(native).toHaveBeenCalledWith({ type: 'png', fullPage: true })
  const bytes = readFileSync(join(folder, 'browser/cart.png'))
  expect(bytes.equals(Buffer.from(png, 'base64'))).toBe(true)
  expect(record.screenshots).toEqual([{ name: 'cart.png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])
  expect(result.content).toContainEqual(response(png).content[0])
  expect(result.content.at(-1).text).toContain('browser/cart.png')
})

it.each(['/tmp/out.png', '../out.png', 'browser/../out.png', 'browser/a/b.png', 'a\\b.png', '%2e%2e.png', 'cart.jpg', '', null])('rejects unsafe filename %s before calling the browser', async filename => {
  const { folder, record } = fixture(), native = vi.fn()
  await expect(captureQaScreenshot(folder, record, { filename }, native)).rejects.toThrow('QA_SCREENSHOT_FILENAME')
  expect(native).not.toHaveBeenCalled(); expect(record.screenshots).toEqual([])
})

it('an unnamed native screenshot receives a generated canonical name', async () => {
  const { folder, record } = fixture()
  await captureQaScreenshot(folder, record, {}, async () => response(png))
  expect(record.screenshots[0].name).toMatch(/^shot-[a-f0-9-]+\.png$/)
  expect(existsSync(join(folder, 'browser', record.screenshots[0].name))).toBe(true)
})

it('never admits an unrelated file or overwrites a preplanted destination', async () => {
  const { folder, record } = fixture(), path = join(folder, 'browser/cart.png')
  writeFileSync(path, 'unrelated')
  await expect(captureQaScreenshot(folder, record, { filename: 'cart.png' }, async () => response(png))).rejects.toThrow()
  expect(readFileSync(path, 'utf8')).toBe('unrelated'); expect(record.screenshots).toEqual([])
})

it('refuses a symlink destination without modifying its target', async () => {
  const { folder, record } = fixture(), target = join(folder, 'outside')
  writeFileSync(target, 'keep'); symlinkSync(target, join(folder, 'browser/cart.png'))
  await expect(captureQaScreenshot(folder, record, { filename: 'cart.png' }, async () => response(png))).rejects.toThrow()
  expect(readFileSync(target, 'utf8')).toBe('keep'); expect(record.screenshots).toEqual([])
})

it('rechecks the owned directory after the browser returns', async () => {
  const { folder, record } = fixture(), outside = join(folder, 'outside')
  mkdirSync(outside)
  await expect(captureQaScreenshot(folder, record, { filename: 'cart.png' }, async () => {
    renameSync(join(folder, 'browser'), join(folder, 'retired')); symlinkSync(outside, join(folder, 'browser'))
    return response(png)
  })).rejects.toThrow()
  expect(existsSync(join(outside, 'cart.png'))).toBe(false); expect(record.screenshots).toEqual([])
})

it('keeps the first bytes when a duplicate name conflicts', async () => {
  const { folder, record } = fixture()
  await captureQaScreenshot(folder, record, { filename: 'cart.png' }, async () => response(png))
  await expect(captureQaScreenshot(folder, record, { filename: 'cart.png' }, async () => response(other))).rejects.toThrow('QA_SCREENSHOT_CONFLICT')
  expect(readFileSync(join(folder, 'browser/cart.png')).equals(Buffer.from(png, 'base64'))).toBe(true)
  expect(record.screenshots).toHaveLength(1)
})

it.each([
  { label: 'invalid base64', data: 'not-base64' },
  { label: 'wrong format', data: Buffer.from('not a PNG').toString('base64') },
  { label: 'truncated PNG', data: png.slice(0, -8) },
  { label: 'oversized image', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }
])('refuses $label', async ({ data }) => {
  const { folder, record } = fixture()
  await expect(captureQaScreenshot(folder, record, {}, async () => response(data))).rejects.toThrow()
  expect(record.screenshots).toEqual([])
})

it('preserves a native error without admitting an image', async () => {
  const { folder, record } = fixture(), error = { isError: true, content: [{ type: 'text', text: 'No page' }] }
  expect(await captureQaScreenshot(folder, record, {}, async () => error)).toEqual(error)
  expect(record.screenshots).toEqual([])
})
