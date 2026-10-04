// Electron-builder calls this after resource copying. Linux packaging is unchanged.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWindowsWorkerImage, sealWindowsReleasePayload } from '../lib/windows-release-payload.mjs'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  assert.equal(commitResult.status, 0, 'Packaged release must identify its source commit')
  const schemaSource = readFileSync(join(repo, 'apps/desktop/src/utility/store-schema.ts'), 'utf8')
  const versions = [...schemaSource.matchAll(/^\s+version:\s+(\d+),?\s*$/gmu)].map(match => Number(match[1]))
  assert.ok(versions.length > 0 && versions.every((value, index) => value === index + 1), 'Cannot identify the packaged data schema')
  const app = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8'))
  createWindowsWorkerImage(context.appOutDir)
  await sealWindowsReleasePayload(context.appOutDir, { commit: commitResult.stdout.trim(), schemaVersion: versions.at(-1), electronVersion: app.devDependencies.electron })
}
