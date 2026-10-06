import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { workerOnlySubprocessRoute } from './windows-native-capability-routing.test-support.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const worker = resolve(repo, 'scripts/lib/windows-installed-worker.mjs')
const config = resolve(repo, 'apps/desktop/bin/safe-config-write.mjs')
const esbuild = createRequire(createRequire(join(repo, 'apps/desktop/package.json')).resolve('vite/package.json'))('esbuild')

it('routes only the exact resolved worker, refusing non-worker and same-filename importers', () => {
  const route = workerOnlySubprocessRoute(worker)
  expect(route({ path: 'node:child_process', importer: worker })).toEqual({ path: 'node:child_process', namespace: 'synthetic-native' })
  expect(route({ path: 'node:child_process', importer: config })).toBeUndefined()
  expect(route({ path: 'node:child_process', importer: join(repo, 'other/windows-installed-worker.mjs') })).toBeUndefined()
  expect(route({ path: 'node:fs', importer: worker })).toBeUndefined()
})

it('executes actual config operations through real subprocess capability while the original global mock rejects them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-native-routing-')), systemRoot = process.env.SystemRoot
  const sameSuffix = join(root, 'other/windows-installed-worker.mjs')
  mkdirSync(dirname(sameSuffix))
  writeFileSync(sameSuffix, "import { spawnSync } from 'node:child_process'; export const version = () => spawnSync(process.execPath,['--version'],{encoding:'utf8',timeout:2000});")
  try {
    process.env.SystemRoot ??= 'C:\\Windows'
    const modules = {}
    for (const mode of ['original', 'repaired']) {
      const output = join(root, mode + '.mjs'), route = workerOnlySubprocessRoute(worker)
      await esbuild.build({ stdin: { contents: `export { windowsConfigOperation as configOperation } from ${JSON.stringify(config)}; export { probe } from ${JSON.stringify(worker)}; export { version } from ${JSON.stringify(sameSuffix)};`, resolveDir: repo },
        outfile: output, bundle: true, platform: 'node', target: 'node24', format: 'esm', plugins: [{ name: 'exact-worker-routing-fence', setup(build) {
          build.onResolve({ filter: /^node:child_process$/ }, args => mode === 'original' ? { path: args.path, namespace: 'synthetic-native' } : route(args))
          build.onLoad({ filter: /.*/, namespace: 'synthetic-native' }, () => ({ contents: "export const spawnSync=(_exe,args)=>{if(args[0]!=='__worker_probe__')throw Error('Unexpected process operation');return {status:0,stdout:'__worker_mock__'}};" }))
          build.onLoad({ filter: /windows-installed-worker\.mjs$/ }, args => resolve(args.path) === worker
            ? { contents: "import {spawnSync} from 'node:child_process';export const probe=()=>spawnSync('unused',['__worker_probe__']);" } : undefined)
          build.onLoad({ filter: /safe-config-write\.mjs$/ }, args => {
            expect(resolve(args.path)).toBe(config)
            const source = readFileSync(args.path, 'utf8')
            expect(source.includes('function windowsConfigOperation(request)')).toBe(true)
            return { contents: source + '\nexport { windowsConfigOperation };\n', loader: 'js' }
          })
        } }] })
      modules[mode] = await import(pathToFileURL(output).href)
    }
    const request = { mode: 'prepare', target: join(root, 'probe.json'), temporary: join(root, 'probe.tmp'), text: '{"synthetic":true}', existed: false, expectedHash: null }
    expect(() => modules.original.configOperation(request)).toThrow('Unexpected process operation')
    expect(() => modules.original.version()).toThrow('Unexpected process operation')
    expect(modules.repaired.probe()).toMatchObject({ status: 0, stdout: '__worker_mock__' })
    const version = modules.repaired.version()
    expect(version.status).toBe(0); expect(version.stdout.trim()).toBe(process.version)
    if (process.platform === 'win32') {
      const result = modules.repaired.configOperation(request)
      expect(result.ok).toBe(true)
      expect(modules.repaired.configOperation({ mode: 'cleanup', temporary: request.temporary, stagedIdentity: result.stagedIdentity }).ok).toBe(true)
    } else {
      // The real Node capability attempts the Windows executable and reports
      // ENOENT on this host, rather than entering the synthetic worker mock.
      try { modules.repaired.configOperation(request); throw new Error('Windows executable unexpectedly available') }
      catch (error) { expect(error.code).toBe('IO_ERROR'); expect(error.nativeLaunchError).toBe('ENOENT') }
    }
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot
    rmSync(root, { recursive: true, force: true })
  }
}, process.platform === 'win32' ? 30000 : 5000)
