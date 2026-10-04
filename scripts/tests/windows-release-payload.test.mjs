import { mkdtempSync, mkdirSync, writeFileSync, rmSync, linkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sealWindowsReleasePayload, validateWindowsReleasePayload, validateWindowsPayloadName, createWindowsWorkerImage } from '../lib/windows-release-payload.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-payload-')); roots.push(root)
  mkdirSync(join(root, 'resources'))
  writeFileSync(join(root, 'BMN.exe'), 'synthetic executable')
  createWindowsWorkerImage(root)
  writeFileSync(join(root, 'resources/app.asar'), 'synthetic application')
  return root
}
const identity = { commit: 'a'.repeat(40), schemaVersion: 23 }
it('validates exact content and detects changed, missing and additional files', async () => {
  const root = fixture(), release = await sealWindowsReleasePayload(root, identity)
  expect(await validateWindowsReleasePayload(root, release)).toEqual(release)
  writeFileSync(join(root, 'BMN.exe'), 'corruption')
  await expect(validateWindowsReleasePayload(root, release)).rejects.toThrow('content differs')
  writeFileSync(join(root, 'BMN.exe'), 'synthetic executable')
  writeFileSync(join(root, 'unexpected.dll'), 'extra')
  await expect(validateWindowsReleasePayload(root, release)).rejects.toThrow('content differs')
  rmSync(join(root, 'unexpected.dll')); rmSync(join(root, 'resources/app.asar'))
  await expect(validateWindowsReleasePayload(root, release)).rejects.toThrow('content differs')
})
it('rejects a different identity and an edited manifest', async () => {
  const root = fixture(), release = await sealWindowsReleasePayload(root, identity)
  await expect(validateWindowsReleasePayload(root, { ...release, commit: 'b'.repeat(40) })).rejects.toThrow('identity differs')
  writeFileSync(join(root, 'bmn-release.json'), '{}')
  await expect(validateWindowsReleasePayload(root, release)).rejects.toThrow('Unsupported payload')
})
it('refuses Windows aliases, special names and directory links', async () => {
  const root = fixture()
  expect(() => validateWindowsPayloadName('NUL.txt')).toThrow('Reserved payload')
  expect(() => validateWindowsPayloadName('unsafe:stream')).toThrow('Unsupported payload')
  expect(() => validateWindowsPayloadName('trailing.')).toThrow('Unsupported payload')
  // Directory junctions require no symlink privilege on native Windows.
  symlinkSync(join(root, 'resources'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(sealWindowsReleasePayload(root, identity)).rejects.toThrow('refuses links')
})

it('requires an ordinary byte-equal worker image before accepting an offline payload', async () => {
  const root = fixture()
  rmSync(join(root, 'BMN-worker.exe'))
  await expect(sealWindowsReleasePayload(root, identity)).rejects.toThrow('worker image')
})

it('rejects a differing, preexisting or hardlinked worker image', async () => {
  const root = fixture()
  expect(() => createWindowsWorkerImage(root)).toThrow()
  writeFileSync(join(root, 'BMN-worker.exe'), 'different runtime')
  await expect(sealWindowsReleasePayload(root, identity)).rejects.toThrow('worker image differs')
  rmSync(join(root, 'BMN-worker.exe')); linkSync(join(root, 'BMN.exe'), join(root, 'BMN-worker.exe'))
  await expect(sealWindowsReleasePayload(root, identity)).rejects.toThrow('hardlinked')
})
