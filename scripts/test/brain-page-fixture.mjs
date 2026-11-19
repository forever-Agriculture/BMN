// MODULE: brain-page-fixture.mjs - A switched synthetic brain for the Brain page's checks (Epic 128): linked notes, every status, and a dense 1,000-note brain
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { brainJournalCommit } from '../../apps/desktop/bin/brain-state.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const at = day => new Date(Date.UTC(2026, 10, day, 9, 30)).toISOString()

/** A small brain with links, every status and a name not in the brain; synthetic text only. */
export function linkedNotes() {
  const note = (title, kind, day, markdown, status = 'active') => ({ source: `synthetic/${title}.md`, title, kind, origin: 'import', scope: 'all', markdown, status, source_time: at(day) })
  return [
    note('Backup plan', 'project', 16, '# Backup plan\n\nNightly backup at 03:00, keep 30 days. Decided in [[Backup decision]].\n\n## Links\n\n- [[Restore drill]] proves it weekly.\n- [[Retention policy]] says what is kept.\n- [[Disk sizes]] measured the target.\n- [[Old archive question]] is still open.\n'),
    note('Backup decision', 'fact', 15, 'The backup runs nightly and a restore drill runs weekly. Part of [[Backup plan]].\n\nSee also [[Store schema]] and [[Missing design note]].\n'),
    note('Restore drill', 'check', 14, 'A weekly QA backup drill restores last night\'s backup into a scratch folder. Follows [[Backup decision]].\n'),
    note('Retention policy', 'preference', 12, 'Keep 14 nightly and 8 weekly copies. Applies to [[Backup plan]].\n'),
    note('Disk sizes', 'reference', 11, 'Measured sizes for the backup disk: 1.2 TB free. Used by [[Backup plan]].\n'),
    note('Store schema', 'map', 10, 'One file per store, every version kept. See [[Backup decision]] and [[Session rules for a very long synthetic note title]].\n'),
    note('Session rules for a very long synthetic note title', 'lesson', 9, 'A lesson with a long title, to test labels. Back to [[Store schema]].\n'),
    note('Old archive question', 'feedback', 8, 'Do we need a second archive? Asked in [[Backup plan]].\n'),
    note('Owner profile', 'user', 7, 'Prefers short answers and concrete numbers.\n'),
    note('Weekly review', 'project', 6, 'Each Friday: read the [[Restore drill]] receipt.\n'),
    note('Old backup plan', 'fact', 2, 'Weekly full copy by hand. Replaced by [[Backup plan]].\n', 'archived'),
    note('Mistaken note', 'fact', 5, 'Written by mistake; withdrawn.\n')
  ]
}

/** A dense synthetic brain: 1,000 notes, each linking to three distinct others by a fixed pseudo-random sequence (3,000 links). */
export function denseNotes(count = 1000) {
  let seed = 128
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % count }
  const kinds = ['fact', 'project', 'map', 'reference', 'lesson', 'preference', 'feedback', 'user', 'check']
  const titles = Array.from({ length: count }, (_, i) => `Synthetic note ${String(i).padStart(4, '0')} about topic ${i % 37}`)
  return titles.map((title, i) => {
    const targets = new Set()
    while (targets.size < 3) { const to = next(); if (to !== i) targets.add(to) }
    return { source: `dense/${i}.md`, title, kind: kinds[i % kinds.length], origin: 'import', scope: 'all', status: 'active', source_time: at(1 + (i % 28)),
      markdown: `Synthetic dense note ${i}.\n\n` + [...targets].map(to => `- [[${titles[to]}]]`).join('\n') + '\n' }
  })
}

/**
 * One bounded way to ask a built brain worker (the Brain page fixture and the bench's brain fixture share it): each
 * request times out, a worker that exits or fails rejects every request, and close asks the worker only when it lives.
 */
export function brainWorkerRequests(entry, workerData, { label = 'Brain fixture worker', timeoutMs = 10_000 } = {}) {
  const worker = new Worker(entry, { workerData })
  const pending = new Map()
  let sequence = 0, failure = null, closing = false
  worker.on('message', value => { const request = pending.get(value.id); if (!request) return; pending.delete(value.id); clearTimeout(request.timer); if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result) })
  const failed = error => { failure = error; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) } pending.clear() }
  worker.on('error', failed)
  worker.on('exit', code => { if (!closing) failed(new Error(`${label} exited ${code}`)) })
  const request = (operation, args = []) => failure ? Promise.reject(failure) : new Promise((resolveRequest, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${label} timed out`)) }, timeoutMs)
    pending.set(id, { resolve: resolveRequest, reject, timer }); worker.postMessage({ id, operation, args })
  })
  return { request, get failure() { return failure }, close: async () => { closing = true; try { if (!failure) await request('close') } finally { await worker.terminate() } } }
}

/**
 * Seeds a fresh synthetic brain with the built worker and marks it switched: a journal (state complete, delivered,
 * no recovery paths, so start-up recovery stops at once inside the test root) and the worker's matching receipt.
 * Never point it at a real data or state root.
 */
export async function seedSwitchedBrain({ dataRoot, stateRoot, notes, withdraw = ['Mistaken note'] }) {
  // Never the owner's real data, state, config or vault, whatever the caller passes: compared as resolved paths,
  // through symbolic links and `..`, from the nearest folder that exists.
  const resolved = path => {
    let head = resolve(path), tail = ''
    while (!existsSync(head)) { tail = join(head.slice(dirname(head).length + 1), tail); head = dirname(head) }
    return join(realpathSync(head), tail)
  }
  const real = ['.local', '.config', 'brain'].map(name => resolved(join(homedir(), name)))
  for (const root of [dataRoot, stateRoot]) {
    const actual = resolved(root)
    if (!root.startsWith('/') || real.some(path => actual === path || actual.startsWith(path + '/'))) throw new Error(`Refusing a non-test root: ${root}`)
  }
  const databasePath = join(dataRoot, 'brain.sqlite3')
  const journal = join(stateRoot, 'brain-cutover', 'journal.json')
  // Fresh destinations only: an existing database or journal, or a folder redirected elsewhere, is refused before any write.
  for (const path of [databasePath, journal, dirname(journal)]) if (existsSync(path)) throw new Error(`The Brain page fixture needs a fresh destination: ${path}`)
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(journal), { recursive: true, mode: 0o700 })
  for (const [made, root] of [[dataRoot, dataRoot], [dirname(journal), stateRoot]]) {
    if (lstatSync(made).isSymbolicLink() || !realpathSync(made).startsWith(resolved(root))) throw new Error(`Refusing a redirected fixture folder: ${made}`)
  }
  const entry = join(repo, 'apps/desktop/out/main/brain-worker.js')
  const brain = brainWorkerRequests(entry, { databasePath, attachmentsRoot: join(dataRoot, 'files'), cutoverJournal: journal })
  try {
    await brain.request('initialize')
    await brain.request('import', [notes])
    const { storeId } = await brain.request('admission-status')
    const record = { version: 1, cutoverId: randomUUID(), originatingCommit: '0'.repeat(40), phases: ['write-barrier', 'source-proof', 'write-door', 'installed-checks'], state: 'complete', delivered: true }
    record.commit = brainJournalCommit(record, storeId)
    writeFileSync(journal + '.tmp', JSON.stringify(record) + '\n', { mode: 0o600 })
    renameSync(journal + '.tmp', journal)
    const committed = await brain.request('commit-cutover', [record.commit.payloadHash])
    if (!committed.committed) throw new Error('The synthetic brain did not take its receipt')
    await brain.request('resume-cutover')
    const list = await brain.request('list')
    for (const title of withdraw) {
      const note = list.find(each => each.title === title)
      if (note) await brain.request('withdraw', [note.id, note.revision, 'synthetic-fixture'])
    }
    const final = await brain.request('list')
    return { databasePath, journal, notes: final.length, ids: Object.fromEntries(final.map(note => [note.title, note.id])) }
  } finally { await brain.close() }
}
