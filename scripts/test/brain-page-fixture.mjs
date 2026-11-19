// MODULE: brain-page-fixture.mjs - A switched synthetic brain for the Brain page's checks (Epic 128): linked notes, every status, and a dense 1,000-note brain
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync, renameSync } from 'node:fs'
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

/** A dense synthetic brain: 1,000 notes, each linking to three others by a fixed pseudo-random sequence (3,000 links). */
export function denseNotes(count = 1000) {
  let seed = 128
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % count }
  const kinds = ['fact', 'project', 'map', 'reference', 'lesson', 'preference', 'feedback', 'user', 'check']
  const titles = Array.from({ length: count }, (_, i) => `Synthetic note ${String(i).padStart(4, '0')} about topic ${i % 37}`)
  return titles.map((title, i) => ({
    source: `dense/${i}.md`, title, kind: kinds[i % kinds.length], origin: 'import', scope: 'all', status: 'active', source_time: at(1 + (i % 28)),
    markdown: `Synthetic dense note ${i}.\n\n` + [0, 1, 2].map(() => { let to = next(); if (to === i) to = (to + 1) % count; return `- [[${titles[to]}]]` }).join('\n') + '\n'
  }))
}

function workerRequests(entry, workerData) {
  const worker = new Worker(entry, { workerData })
  const pending = new Map()
  let sequence = 0
  worker.on('message', value => { const request = pending.get(value.id); if (!request) return; pending.delete(value.id); if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result) })
  worker.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear() })
  const request = (operation, args = []) => new Promise((resolveRequest, reject) => { const id = ++sequence; pending.set(id, { resolve: resolveRequest, reject }); worker.postMessage({ id, operation, args }) })
  return { request, close: async () => { try { await request('close') } finally { await worker.terminate() } } }
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
  if (existsSync(databasePath)) throw new Error('The Brain page fixture needs a fresh synthetic database')
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  const journal = join(stateRoot, 'brain-cutover', 'journal.json')
  mkdirSync(dirname(journal), { recursive: true, mode: 0o700 })
  const entry = join(repo, 'apps/desktop/out/main/brain-worker.js')
  const brain = workerRequests(entry, { databasePath, attachmentsRoot: join(dataRoot, 'files'), cutoverJournal: journal })
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
