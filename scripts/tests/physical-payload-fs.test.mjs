// Real Electron archive semantics through the installed worker's CJS build mode.
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { sealWindowsReleasePayload } from '../lib/windows-release-payload.mjs'

const requireApp = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const requireBuild = createRequire(requireApp.resolve('electron-builder/package.json'))
const requireBuilder = createRequire(requireBuild.resolve('app-builder-lib/package.json'))
const asar = requireBuilder('@electron/asar')
const requireVite = createRequire(requireApp.resolve('vite/package.json'))

it('validates physical ASAR bytes, retains loader semantics and rejects damaged payloads in bundled Electron', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-physical-payload-'))
  try {
    const archiveInput = join(root, 'archive-input'), payload = join(root, 'payload')
    mkdirSync(archiveInput); mkdirSync(join(payload, 'resources'), { recursive: true })
    writeFileSync(join(archiveInput, 'package.json'), JSON.stringify({ name: 'synthetic-archive', main: 'index.cjs' }))
    writeFileSync(join(archiveInput, 'index.cjs'), "module.exports='synthetic archive loader'\n")
    await asar.createPackage(archiveInput, join(payload, 'resources/app.asar'))
    writeFileSync(join(payload, 'BMN.exe'), 'synthetic image'); writeFileSync(join(payload, 'BMN-worker.exe'), 'synthetic image')
    const descriptor = await sealWindowsReleasePayload(payload, { commit: 'a'.repeat(40), schemaVersion: 23 })
    const entry = join(root, 'entry.mjs'), bundle = join(root, 'runtime.cjs')
    const payloadModule = resolve('scripts/lib/windows-release-payload.mjs')
    const physicalModule = resolve('scripts/lib/physical-payload-fs.mjs')
    writeFileSync(entry, `import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {join} from 'node:path';
import {validateWindowsReleasePayload,validateWindowsPayloadName} from ${JSON.stringify(payloadModule)};
import {physicalPayloadFs as physical} from ${JSON.stringify(physicalModule)};
async function main(){
const root=${JSON.stringify(root)},payload=${JSON.stringify(payload)},descriptor=${JSON.stringify(descriptor)},archive=join(payload,'resources/app.asar');
const digest=path=>createHash('sha256').update(physical.readFileSync(path)).digest('hex');
assert.ok(process.versions.electron);assert.ok(fs.lstatSync(archive).isDirectory());assert.ok(physical.lstatSync(archive).isFile());
assert.equal(createRequire(process.execPath)(archive),'synthetic archive loader');await validateWindowsReleasePayload(payload,descriptor);
const original=digest(archive);for(const name of ['stage','bootstrap']){const copy=join(root,name);physical.cpSync(payload,copy,{recursive:true,errorOnExist:true,force:false});assert.ok(physical.lstatSync(join(copy,'resources/app.asar')).isFile());assert.equal(digest(join(copy,'resources/app.asar')),original);await validateWindowsReleasePayload(copy,descriptor);physical.rmSync(copy,{recursive:true});}
const bytes=physical.readFileSync(archive);physical.writeFileSync(archive,Buffer.concat([bytes,Buffer.from('corruption')]));await assert.rejects(validateWindowsReleasePayload(payload,descriptor),/content differs/);physical.writeFileSync(archive,bytes);
physical.writeFileSync(join(payload,'extra.dll'),'extra');await assert.rejects(validateWindowsReleasePayload(payload,descriptor),/content differs/);physical.unlinkSync(join(payload,'extra.dll'));
physical.symlinkSync(join(payload,'resources'),join(payload,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(validateWindowsReleasePayload(payload,descriptor),/refuses links/);physical.unlinkSync(join(payload,'linked'));assert.ok(!physical.existsSync(join(payload,'linked')));assert.ok(physical.lstatSync(join(payload,'resources')).isDirectory());assert.equal(digest(archive),original);
physical.linkSync(join(payload,'BMN.exe'),join(payload,'hardlink.exe'));await assert.rejects(validateWindowsReleasePayload(payload,descriptor),/hardlinked/);physical.unlinkSync(join(payload,'hardlink.exe'));
for(const name of ['NUL.txt','unsafe:stream','trailing.'])assert.throws(()=>validateWindowsPayloadName(name));
await validateWindowsReleasePayload(payload,descriptor);assert.ok(fs.lstatSync(archive).isDirectory());assert.equal(createRequire(process.execPath)(archive),'synthetic archive loader');
console.log(JSON.stringify({physicalPayload:'PASS',actualElectron:process.versions.electron,emittedCJS:true,stageBootstrapBytesEqual:true,loaderPreserved:true,corruptionAndEntryRefusals:true}));}
main().catch(error=>{console.error(error);process.exitCode=1});`)
    await requireVite('esbuild').build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs',
      define: { 'import.meta.url': 'undefined' } })
    const env = { ELECTRON_RUN_AS_NODE: '1', HOME: root, USERPROFILE: root }
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[key] !== undefined) env[key] = process.env[key]
    const result = spawnSync(requireApp('electron'), [bundle], { env, encoding: 'utf8', timeout: 15000, windowsHide: true })
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ physicalPayload: 'PASS', emittedCJS: true, stageBootstrapBytesEqual: true,
      loaderPreserved: true, corruptionAndEntryRefusals: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 30000)

it('fails closed when an Electron context cannot obtain original-fs', () => {
  const module = pathToFileURL(resolve('scripts/lib/physical-payload-fs.mjs')).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process.versions,'electron',{value:'synthetic-missing-adapter'});await import(${JSON.stringify(module)})`],
  { encoding: 'utf8', timeout: 5000 })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("Cannot find module 'original-fs'")
})
