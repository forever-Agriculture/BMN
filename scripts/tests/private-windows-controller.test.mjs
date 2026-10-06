import { createHash } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifyPrivateWindowsController, writePrivateWindowsController } from '../test/fixtures/private-windows-controller.mjs'
const roots = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'bmn-controller-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
// Filesystem/byte fences run locally; native ACL and PowerShell policy execution
// are verified by the actual Windows controller entrypoint, not these callbacks.
const protect = paths => { for (const path of paths) { mkdirSync(path, { recursive: true }); chmodSync(path, 0o700) } }
it('carries large exact source in a canonical private file with BOM and short literal argv', () => {
  const root = fixture(), source = '# literal 雪 & %PATH% "quote"\n' + 'Write-Output synthetic\n'.repeat(1000)
  const controller = writePrivateWindowsController(join(root, 'controllers'), source, { protect })
  const bytes = readFileSync(controller.file)
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  expect(bytes.subarray(3).toString('utf8')).toBe(source)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(controller.sha256)
  expect(Buffer.from(source, 'utf16le').toString('base64').length + 1024).toBeGreaterThan(32767)
  expect(controller.argv.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-File'])
  expect(controller.argv.join(' ').length + 1024).toBeLessThan(32767)
  expect(controller.argv.join(' ')).not.toMatch(/ExecutionPolicy|Bypass|EncodedCommand/iu)
})
it('refuses collisions and changed bytes rather than adopting or executing another script', () => {
  const root = fixture(), controller = writePrivateWindowsController(join(root, 'controllers'), 'Write-Output synthetic', { protect })
  expect(() => writePrivateWindowsController(controller.root, 'Write-Output synthetic', { protect })).toThrow()
  writeFileSync(controller.file, Buffer.concat([readFileSync(controller.file), Buffer.from('tamper')]))
  expect(() => verifyPrivateWindowsController(controller, { protect })).toThrow(/changed/)
})
it('refuses directory and file links plus hardlinks while preserving their targets', () => {
  const root = fixture(), controller = writePrivateWindowsController(join(root, 'controllers'), 'Write-Output synthetic', { protect })
  const target = join(root, 'target.ps1'); writeFileSync(target, 'untouched')
  unlinkSync(controller.file); symlinkSync(target, controller.file, 'file')
  expect(() => verifyPrivateWindowsController(controller, { protect })).toThrow(/single-link/)
  expect(readFileSync(target, 'utf8')).toBe('untouched')
  unlinkSync(controller.file); linkSync(target, controller.file)
  expect(() => verifyPrivateWindowsController(controller, { protect })).toThrow(/single-link/)
  unlinkSync(controller.file)
  const alias = join(root, 'directory-link'); symlinkSync(controller.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => writePrivateWindowsController(alias, 'Write-Output other', { protect })).toThrow(/ordinary directory/)
})
it('propagates protection refusal and never changes the operating system execution policy', () => {
  const root = fixture()
  expect(() => writePrivateWindowsController(join(root, 'controllers'), 'Write-Output synthetic', { protect: () => { throw new Error('synthetic ACL refusal') } })).toThrow('synthetic ACL refusal')
})
