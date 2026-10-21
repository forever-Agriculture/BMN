// MODULE: defaults-admission.test.mjs - Real flock and async-lifetime boundaries for defaults admission
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertDefaultsAdmission, withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'

const roots = []
function root() { const path = mkdtempSync(join(tmpdir(), 'bmn-defaults-admission-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const moduleUrl = new URL('../../apps/desktop/bin/defaults-admission.mjs', import.meta.url).href

describe('defaults admission', () => {
  it('refuses writes outside admission and releases on sync/async exceptions', async () => {
    const directory = root()
    assert.throws(() => assertDefaultsAdmission(), { code: 'REVISION_CONFLICT' })
    assert.throws(() => withDefaultsAdmission(() => { throw new Error('synthetic') }, { directory }), /synthetic/)
    await assert.rejects(withDefaultsAdmission(async guard => { guard(); throw new Error('synthetic async') }, { directory }), /synthetic async/)
    withDefaultsAdmission(guard => guard(), { directory })
  })

  it('keeps a permanent inode and supports serial nested adapters', async () => {
    const directory = root(), path = join(directory, 'defaults-admission.lock')
    await withDefaultsAdmission(async guard => {
      guard()
      await withDefaultsAdmission(async nestedGuard => { await Promise.resolve(); nestedGuard() })
      guard()
      withDefaultsAdmission(nestedGuard => nestedGuard())
    }, { directory })
    const ino = lstatSync(path).ino
    withDefaultsAdmission(guard => guard(), { directory })
    assert.equal(lstatSync(path).ino, ino)
  })

  it('does not allow parallel sibling adapters under a shared async token', async () => {
    const directory = root()
    await withDefaultsAdmission(async guard => {
      let finish
      const pending = withDefaultsAdmission(() => new Promise(resolve => { finish = resolve }))
      assert.throws(() => withDefaultsAdmission(() => {}), { code: 'REVISION_CONFLICT' })
      assert.throws(guard, { code: 'REVISION_CONFLICT' })
      finish(); await pending; guard()
    }, { directory })
  })

  it('invalidates an inherited callback before closing the descriptor', async () => {
    const directory = root()
    let deferred, resolveCallback
    const finished = new Promise(resolve => { resolveCallback = resolve })
    withDefaultsAdmission(() => {
      deferred = setTimeout(() => {
        assert.throws(() => assertDefaultsAdmission(), { code: 'REVISION_CONFLICT' })
        assert.throws(() => withDefaultsAdmission(() => {}), { code: 'REVISION_CONFLICT' })
        resolveCallback()
      }, 5)
    }, { directory })
    await finished; clearTimeout(deferred)
    withDefaultsAdmission(guard => guard(), { directory })
  })

  it('fails closed on a replaced lock, replaced parent, symlink and missing flock', () => {
    const directory = root(), path = join(directory, 'defaults-admission.lock')
    withDefaultsAdmission(guard => {
      renameSync(path, `${path}.old`); writeFileSync(path, '')
      assert.throws(guard, { code: 'REVISION_CONFLICT' })
    }, { directory })
    withDefaultsAdmission(guard => {
      renameSync(directory, `${directory}.old`); roots.push(`${directory}.old`); mkdirSync(directory)
      assert.throws(guard, { code: 'REVISION_CONFLICT' })
    }, { directory })
    symlinkSync(join(directory, 'target'), path)
    assert.throws(() => withDefaultsAdmission(() => {}, { directory }))
    rmSync(path)
    assert.throws(() => withDefaultsAdmission(() => {}, { directory, flockCommand: '/missing-synthetic-flock' }), { code: 'REVISION_CONFLICT' })
  })

  it('excludes an independent process and permits admission after its natural exit', async () => {
    const directory = root()
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {withDefaultsAdmission} from ${JSON.stringify(moduleUrl)};
      await withDefaultsAdmission(async guard=>{
        process.stdout.write('ADMITTED\\n');
        await new Promise(resolve=>process.stdin.once('data',resolve));guard();
      },{directory:process.argv[1]});
    `, directory], { stdio: ['pipe', 'pipe', 'pipe'] })
    let errors = ''
    child.stderr.on('data', bytes => { errors += bytes.toString() })
    const ended = once(child, 'exit')
    const [bytes] = await Promise.race([
      once(child.stdout, 'data'),
      ended.then(([code]) => { throw new Error(`child exited before admission (${code}): ${errors}`) })
    ])
    assert.match(bytes.toString(), /ADMITTED/)
    try { assert.throws(() => withDefaultsAdmission(() => {}, { directory }), { code: 'REVISION_CONFLICT' }) }
    finally { child.stdin.end('release\n') }
    const [code] = await ended
    assert.equal(code, 0)
    withDefaultsAdmission(guard => guard(), { directory })
    assert.equal(readFileSync(join(directory, 'defaults-admission.lock'), 'utf8'), '')
  })

  it('admits the existing skills-own writer only after conflicting work finishes', () => {
    const home = root(), shipped = join(home, 'shipped'), source = join(home, '.claude/skills')
    mkdirSync(join(shipped, 'synthetic-skill'), { recursive: true }); mkdirSync(source, { recursive: true })
    writeFileSync(join(shipped, 'manifest.json'), JSON.stringify({ skills: ['synthetic-skill'] }))
    writeFileSync(join(shipped, 'synthetic-skill/SKILL.md'), '---\nname: synthetic-skill\ndescription: synthetic fixture\n---\n')
    const ownUrl = new URL('../../apps/desktop/bin/agents-own-skills.mjs', import.meta.url).href
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {installOwnSkills} from ${JSON.stringify(ownUrl)};
      try { const result=installOwnSkills({source:process.argv[1],environment:process.env}); process.exit(result.ok?0:1) }
      catch(error){process.stderr.write(String(error.code));process.exit(error.code==='REVISION_CONFLICT'?75:1)}
    `, source], { env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, BMN_SHIPPED_SKILLS: shipped }, encoding: 'utf8' })
    withDefaultsAdmission(() => {
      const refused = run()
      assert.equal(refused.status, 75, `conflicting existing writer must refuse: ${refused.stderr}`)
      assert.match(refused.stderr, /REVISION_CONFLICT/)
    }, { directory: join(home, '.config/bmn/agents/state') })
    assert.equal(run().status, 0, 'normal write can proceed once the other operation releases admission')
  })
})
