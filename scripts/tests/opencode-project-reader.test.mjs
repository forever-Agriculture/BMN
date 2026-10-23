// MODULE: opencode-project-reader.test.mjs - Driven filesystem, history and child-admission boundary controls
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { openProjectReader, singleReaderChild } from '../../apps/desktop/bin/opencode-project-reader.mjs'

const git = argv => execFileSync('/usr/bin/git', argv, { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })

test('project descriptors keep reads, searches and Git inside the approved root', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bmn-opencode-reader-')), project = join(fixture, 'project')
  mkdirSync(project); mkdirSync(join(project, 'src')); writeFileSync(join(project, 'src/note.txt'), 'ordinary\nneedle\n')
  writeFileSync(join(fixture, 'outside.txt'), 'SYNTHETIC-OUTSIDE')
  symlinkSync(join(fixture, 'outside.txt'), join(project, 'escape.txt')); symlinkSync(fixture, join(project, 'escape-dir'))
  git( ['init', '-q', project]); git( ['-C', project, 'add', 'src/note.txt'])
  git( ['-C', project, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic fixture'])
  const reader = openProjectReader(project)
  try {
    assert.equal(reader.read('src/note.txt'), 'ordinary\nneedle\n')
    assert.deepEqual(await reader.glob('**/*.txt'), ['src/note.txt'])
    assert.deepEqual(await reader.grep('needle'), [{ path: 'src/note.txt', matches: '2:needle' }])
    for (const path of ['../outside.txt', join(fixture, 'outside.txt'), 'escape.txt', 'escape-dir/outside.txt']) assert.throws(() => reader.read(path), /BMN read-only/)
    for (const path of ['../', 'escape-dir']) {
      await assert.rejects(() => reader.glob('**/*', path), /BMN read-only/)
      await assert.rejects(() => reader.grep('SYNTHETIC', path), /BMN read-only/)
    }
    for (const args of [['log', '-1'], ['show', 'HEAD:src/note.txt'], ['diff'], ['blame', 'src/note.txt']]) assert.equal(typeof reader.git(args), 'string')
    for (const args of [['log', '>', 'changed'], ['diff', '--no-index', '../outside.txt', 'src/note.txt'], ['log', '--output=changed'], ['show', 'HEAD:../outside.txt']]) assert.throws(() => reader.git(args), /BMN read-only/)
    renameSync(project, join(fixture, 'moved'))
    assert.throws(() => reader.read('src/note.txt'), /BMN read-only/)
  } finally { reader.close(); rmSync(fixture, { recursive: true, force: true }) }
})

test('one child admission is atomic and cannot be reused by failure, retry or recursion', async () => {
  const admit = singleReaderChild()
  const results = await Promise.allSettled([1, 2].map(async () => admit('root')))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.throws(() => admit('root'), /BMN read-only/)
  assert.throws(() => admit('child', true), /BMN read-only/)
  assert.doesNotThrow(() => admit('independent-root'))
})


test('persistent child admission survives a new plugin instance and rejects recursion', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bmn-reader-admission-'))
  try {
    singleReaderChild(fixture)('root')
    const reloaded = singleReaderChild(fixture)
    assert.throws(() => reloaded('root'), /BMN read-only/)
    assert.throws(() => reloaded('child', true), /BMN read-only/)
    assert.doesNotThrow(() => reloaded('independent-root'))
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})


test('history scopes enclosing repositories, accepts linked worktrees, and masks local configuration', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bmn-reader-history-')), repository = join(fixture, 'repo'), project = join(repository, 'project')
  mkdirSync(project, { recursive: true }); writeFileSync(join(project, 'notes.txt'), 'inside original\n')
  writeFileSync(join(repository, 'sibling.txt'), 'SYNTHETIC-OUTSIDE-BLOB')
  git(['init', '-q', repository]); git(['-C', repository, 'add', '.'])
  git(['-C', repository, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic fixture'])
  const outsideBlob = git(['-C', repository, 'rev-parse', 'HEAD:sibling.txt']).toString().trim(), linked = join(fixture, 'linked')
  git(['-C', repository, 'worktree', 'add', '--detach', '-q', linked, 'HEAD'])
  const reader = openProjectReader(project), linkedReader = openProjectReader(linked)
  try {
    assert.match(reader.git(['show', 'HEAD:notes.txt']), /inside original/)
    assert.throws(() => reader.git(['show', 'HEAD:sibling.txt']), /BMN read-only/)
    assert.throws(() => reader.git(['show', outsideBlob]), /BMN read-only/)
    git(['-C', repository, 'update-ref', 'refs/tags/outside-blob', outsideBlob])
    assert.throws(() => reader.git(['show', '--all']), /BMN read-only/)
    assert.throws(() => reader.git(['show', 'outside-blob']), /BMN read-only/)
    assert.throws(() => reader.git(['log', '--follow', '--', 'notes.txt']), /BMN read-only/)
    assert.equal(reader.git(['show', 'HEAD']).includes('SYNTHETIC-OUTSIDE-BLOB'), false)
    assert.match(linkedReader.git(['show', 'HEAD:project/notes.txt']), /inside original/)
    assert.match(linkedReader.git(['blame', 'project/notes.txt']), /inside original/)
    writeFileSync(join(project, 'notes.txt'), 'inside changed\n')
    const marker = join(fixture, 'filter-ran'), outsideConfig = join(fixture, 'outside-config')
    writeFileSync(outsideConfig, `[filter "evil"]\nclean = touch ${marker}\n`)
    writeFileSync(join(project, '.gitattributes'), 'notes.txt filter=evil\n')
    const config = join(repository, '.git/config')
    writeFileSync(config, readFileSync(config, 'utf8') + `\n[include]\npath = ${outsideConfig}\n[core]\nworktree = ${fixture}\n`)
    assert.match(reader.git(['diff']), /inside changed/)
    assert.equal(reader.git(['diff']).includes('SYNTHETIC-OUTSIDE-BLOB'), false)
    assert.throws(() => readFileSync(marker), { code: 'ENOENT' })
    assert.match(reader.git(['log', '-1']), /synthetic fixture/)
  } finally { reader.close(); linkedReader.close(); rmSync(fixture, { recursive: true, force: true }) }
})

test('history refuses forged Git metadata indirection', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bmn-reader-forged-')), project = join(fixture, 'project'), outside = join(fixture, 'outside')
  mkdirSync(project); mkdirSync(outside); git(['init', '-q', outside])
  writeFileSync(join(project, '.git'), `gitdir: ${join(outside, '.git')}\n`)
  const reader = openProjectReader(project)
  try { assert.throws(() => reader.git(['log']), /BMN read-only/) }
  finally { reader.close(); rmSync(fixture, { recursive: true, force: true }) }
})


test('concurrent component replacement never exposes an outside file', async () => {
 const fixture=mkdtempSync(join(tmpdir(),'bmn-reader-race-')),project=join(fixture,'project'),outside=join(fixture,'outside')
 mkdirSync(join(project,'active'),{recursive:true});mkdirSync(outside)
 writeFileSync(join(project,'active/note.txt'),'SYNTHETIC-INSIDE');writeFileSync(join(outside,'note.txt'),'SYNTHETIC-OUTSIDE')
 const state=new Int32Array(new SharedArrayBuffer(4)),reader=openProjectReader(project)
 const worker=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{renameSync,symlinkSync,unlinkSync}=require('node:fs');const{join}=require('node:path');const a=join(workerData.project,'active'),b=join(workerData.project,'parked'),s=new Int32Array(workerData.state);renameSync(a,b);symlinkSync(workerData.outside,a);parentPort.postMessage('ready');Atomics.wait(s,0,0);while(Atomics.load(s,0)===1){unlinkSync(a);renameSync(b,a);renameSync(a,b);symlinkSync(workerData.outside,a)}unlinkSync(a);renameSync(b,a);`,{eval:true,workerData:{project,outside,state:state.buffer}})
 try {
  await once(worker,'message')
  assert.throws(()=>reader.read('active/note.txt'),/BMN read-only/)
  Atomics.store(state,0,1);Atomics.notify(state,0)
  let accepted=0,refused=0
  for(let i=0;i<1000;i++)try{assert.equal(reader.read('active/note.txt'),'SYNTHETIC-INSIDE');accepted++}catch(error){assert.match(error.message,/BMN read-only/);refused++}
  assert.equal(accepted+refused,1000)
 }finally{Atomics.store(state,0,2);Atomics.notify(state,0);await worker.terminate();reader.close();rmSync(fixture,{recursive:true,force:true})}
})
