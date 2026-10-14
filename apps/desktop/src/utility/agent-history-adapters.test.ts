// MODULE: agent-history-adapters.test.ts - Codex and OpenCode history adapters against fixture databases and recording stand-in binaries
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexHistoryAdapter } from './agent-history-codex'
import { openCodeHistoryAdapter } from './agent-history-opencode'
import { agentCommandEnvironment, failureLine, findOnPath, type OpenReadOnly } from './agent-history-store'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) =>
  ReturnType<OpenReadOnly> & { exec(sql: string): void }
const open: OpenReadOnly = (path) => new BetterSqlite3(path, { readonly: true, fileMustExist: true })
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const CODEX_IDS: [string, string, string] = ['01a0e466-9639-7372-89eb-960c2fe7e28a', '01a0e466-fa1c-77c2-8f99-88f5ace4fe7f', '01a0e467-3f6c-7650-8a17-14c32cc71174']
const OPENCODE_IDS: [string, string] = ['ses_f1b971253ffeDV9XIFvU67lmdh', 'ses_f1b96fb27ffe706PCFZxEkJQYt']
const NOW = Date.parse('2026-09-28T12:00:00.000Z')
const DAY = 86_400_000

/** A stand-in agent binary that appends its argv and cwd to a log and exits with `code`. */
async function fakeBinary(bin: string, name: string, code = 0, output = ''): Promise<string> {
  await mkdir(bin, { recursive: true })
  const log = join(bin, `${name}.log`)
  await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\nprintf '%s\\n' ${JSON.stringify(output)} >&2\nexit ${code}\n`)
  await chmod(join(bin, name), 0o755)
  return log
}

/**
 * A stand-in `opencode` that answers `--version` with `version` (exiting `versionCode`), noting each such
 * call in opencode-version.log, and otherwise records its call like fakeBinary.
 */
async function fakeOpenCode(bin: string, version: string, versionCode = 0): Promise<string> {
  await mkdir(bin, { recursive: true })
  const log = join(bin, 'opencode.log')
  const versions = join(bin, 'opencode-version.log')
  await writeFile(join(bin, 'opencode'), `#!/bin/sh\nif [ "$1" = --version ]; then echo x >> ${JSON.stringify(versions)}; echo ${JSON.stringify(version)}; exit ${versionCode}; fi\nprintf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\n`)
  await chmod(join(bin, 'opencode'), 0o755)
  return log
}

async function versionReads(bin: string): Promise<number> {
  return (await readFile(join(bin, 'opencode-version.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bmn-history-adapter-'))
  roots.push(path)
  return path
}

async function codexStore(home: string, columns = 'id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER'): Promise<void> {
  await mkdir(join(home, '.codex'), { recursive: true })
  const database = new BetterSqlite3(join(home, '.codex', 'state_5.sqlite'))
  database.exec(`PRAGMA journal_mode = WAL; CREATE TABLE threads (${columns})`)
  if (columns.includes('updated_at')) {
    const insert = database.prepare('INSERT INTO threads (id, created_at, updated_at, archived) VALUES (?, ?, ?, ?)')
    insert.run(CODEX_IDS[0], (NOW - 60 * DAY) / 1000, (NOW - 45 * DAY) / 1000, 1)
    insert.run(CODEX_IDS[1], (NOW - 60 * DAY) / 1000, (NOW - 2 * DAY) / 1000, 0)
    insert.run(CODEX_IDS[2], (NOW - 40 * DAY) / 1000, (NOW - 31 * DAY) / 1000, 0)
    insert.run('not-a-uuid', (NOW - 90 * DAY) / 1000, (NOW - 90 * DAY) / 1000, 0)
  }
  // Left open, like Codex itself: the rows sit in the WAL, which a read-only connection still sees.
  openStores.push(database)
}
const openStores: Array<{ close(): unknown }> = []
afterEach(() => { for (const store of openStores.splice(0)) store.close() })

async function openCodeStore(home: string, columns = 'id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER'): Promise<void> {
  await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true })
  const database = new BetterSqlite3(join(home, '.local', 'share', 'opencode', 'opencode.db'))
  database.exec(`PRAGMA journal_mode = WAL; CREATE TABLE session (${columns})`)
  if (columns.includes('time_updated')) {
    const insert = database.prepare('INSERT INTO session (id, project_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
    insert.run(OPENCODE_IDS[0], 'project-a', '/work/a', NOW - 50 * DAY, NOW - 40 * DAY)
    insert.run(OPENCODE_IDS[1], 'project-b', '/work/b', NOW - 50 * DAY, NOW - 1 * DAY)
  }
  openStores.push(database)
}

describe('Codex history adapter', () => {
  it('reads every thread read-only, by last activity, archived or not', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeBinary(bin, 'codex')
    await codexStore(home)
    const adapter = codexHistoryAdapter({ home, open, env: { PATH: bin } })

    expect(await adapter.available()).toEqual({ ok: true, sessions: 4 })
    const candidates = await adapter.candidates(NOW - 30 * DAY)
    expect(candidates.map((candidate) => candidate.id).sort()).toEqual([CODEX_IDS[0], CODEX_IDS[2]])
    expect(candidates.find((candidate) => candidate.id === CODEX_IDS[2])?.updatedAt).toBe(NOW - 31 * DAY)
  })

  it('removes through `codex delete --force <uuid>` and nothing else', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    const log = await fakeBinary(bin, 'codex', 0, 'Deleted session.')
    await codexStore(home)
    const adapter = codexHistoryAdapter({ home, open, env: { PATH: bin, BMN_TOKEN: 'secret', AITERM_TOKEN: 'secret' } })
    const before = await readdir(join(home, '.codex'))

    expect(await adapter.remove(CODEX_IDS[0]!)).toEqual({ ok: true })
    expect(await adapter.remove('not-a-uuid')).toEqual({ ok: false, reason: 'not a session UUID' })

    expect(await readFile(log, 'utf8')).toBe(`${home}|delete --force ${CODEX_IDS[0]}\n`)
    expect(await readdir(join(home, '.codex'))).toEqual(before)
  })

  it('reports the failure line when codex refuses', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeBinary(bin, 'codex', 1, 'Error: failed to delete session')
    await codexStore(home)

    expect(await codexHistoryAdapter({ home, open, env: { PATH: bin } }).remove(CODEX_IDS[0]!))
      .toEqual({ ok: false, reason: 'Error: failed to delete session' })
  })

  it('is not recognised when the table lacks its columns, and absent without the binary or the store', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeBinary(bin, 'codex')
    expect(await codexHistoryAdapter({ home, open, env: { PATH: bin } }).available()).toMatchObject({ ok: false, absent: true })
    await codexStore(home, 'id TEXT, created_at INTEGER')
    expect(await codexHistoryAdapter({ home, open, env: { PATH: bin } }).available())
      .toEqual({ ok: false, reason: 'threads has no updated_at' })
    expect(await codexHistoryAdapter({ home, open, env: { PATH: join(home, 'nowhere') } }).available())
      .toEqual({ ok: false, reason: 'codex is not on PATH', absent: true })
  })

  it('follows CODEX_HOME', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeBinary(bin, 'codex')
    await codexStore(join(home, 'elsewhere'))
    expect(await codexHistoryAdapter({ home, open, env: { PATH: bin, CODEX_HOME: join(home, 'elsewhere', '.codex') } }).available())
      .toEqual({ ok: true, sessions: 4 })
  })
})

describe('OpenCode history adapter', () => {
  it('reads sessions across every project and removes with `opencode session delete <id> --pure`', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    const log = await fakeOpenCode(bin, '1.19.0')
    await openCodeStore(home)
    const adapter = openCodeHistoryAdapter({ home, open, env: { PATH: bin } })

    expect(await adapter.available()).toEqual({ ok: true, sessions: 2 })
    expect(await adapter.candidates(NOW - 30 * DAY)).toEqual([{ id: OPENCODE_IDS[0], updatedAt: NOW - 40 * DAY }])
    expect(await adapter.remove(OPENCODE_IDS[0]!)).toEqual({ ok: true })
    expect(await adapter.remove('../../etc')).toEqual({ ok: false, reason: 'not an OpenCode session id' })
    expect(await readFile(log, 'utf8')).toBe(`${home}|session delete ${OPENCODE_IDS[0]} --pure\n`)
  })

  it('on OpenCode 2 reads top-level sessions from session_v2 and removes with `--standalone`, never `--pure`', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    const log = await fakeOpenCode(bin, 'opencode v2.0.28')
    // OpenCode 1's table stays behind after the move to 2 and is no longer written: it must not be read.
    await openCodeStore(home)
    const database = new BetterSqlite3(join(home, '.local', 'share', 'opencode', 'opencode.db'))
    database.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)')
    const insert = database.prepare('INSERT INTO session_v2 (id, parent_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
    const [fresh, child] = ['ses_f1c0aa11bffeQ2wErTyUiOpAsD', 'ses_f1c0aa22cffeZxCvBnMqWeRtYu']
    insert.run(OPENCODE_IDS[1], null, '/work/b', NOW - 50 * DAY, NOW - 35 * DAY)
    insert.run(child, OPENCODE_IDS[1], '/work/b', NOW - 50 * DAY, NOW - 36 * DAY)
    insert.run(fresh, null, '/work/c', NOW - 2 * DAY, NOW - 1 * DAY)
    openStores.push(database)

    // A family whose subagent is still at work is kept whole; one whose members carry no time or no session id too.
    const [busy, busyChild, odd, undated, undatedChild] = ['ses_f1c0aa33dffeAbCdEfGhIjKlMn', 'ses_f1c0aa44effeOpQrStUvWxYzAb',
      'ses_f1c0aa55fffeCdEfGhIjKlMnOp', 'ses_f1c0aa66affeQrStUvWxYzAbCd', 'ses_f1c0aa77bffeEfGhIjKlMnOpQr']
    insert.run(busy, null, '/work/d', NOW - 90 * DAY, NOW - 80 * DAY)
    insert.run(busyChild, busy, '/work/d', NOW - 3 * DAY, NOW - 2 * DAY)
    insert.run(odd, null, '/work/e', NOW - 90 * DAY, NOW - 80 * DAY)
    insert.run('not-a-session', odd, '/work/e', NOW - 90 * DAY, NOW - 80 * DAY)
    insert.run(undated, null, '/work/f', NOW - 90 * DAY, NOW - 80 * DAY)
    insert.run(undatedChild, undated, '/work/f', NOW - 90 * DAY, null)
    const adapter = openCodeHistoryAdapter({ home, open, env: { PATH: bin } })

    // Sessions are counted as the owner sees them: top-level only.
    expect(await adapter.available()).toEqual({ ok: true, sessions: 5 })
    // The family is aged by its newest member and named with the candidate, so the runner protects every member.
    expect(await adapter.candidates(NOW - 30 * DAY)).toEqual([{ id: OPENCODE_IDS[1], updatedAt: NOW - 35 * DAY, family: [child] }])
    expect(await adapter.remove(OPENCODE_IDS[1]!)).toEqual({ ok: true })
    expect(await readFile(log, 'utf8')).toBe(`${home}|session delete ${OPENCODE_IDS[1]} --standalone\n`)
  })

  it('reads the version once for status while the binary stays the same, and afresh for a run, a change or after a failed read', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeOpenCode(bin, '1.19.0')
    await openCodeStore(home)
    const adapter = openCodeHistoryAdapter({ home, open, env: { PATH: bin } })

    for (let pass = 0; pass < 3; pass += 1) expect(await adapter.available()).toEqual({ ok: true, sessions: 2 })
    expect(await versionReads(bin)).toBe(1)
    // A run never trusts a remembered answer: a launcher can start another version from the same file.
    expect(await adapter.available({ fresh: true })).toEqual({ ok: true, sessions: 2 })
    expect(await versionReads(bin)).toBe(2)

    // An upgrade replaces the file; the next pass asks again and moves to OpenCode 2's table.
    await fakeOpenCode(bin, 'opencode v2.0.28')
    const database = new BetterSqlite3(join(home, '.local', 'share', 'opencode', 'opencode.db'))
    database.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)')
    openStores.push(database)
    expect(await adapter.available()).toEqual({ ok: true, sessions: 0 })
    expect(await versionReads(bin)).toBe(3)

    // A failed read counts as OpenCode 1 for that pass only.
    await fakeOpenCode(bin, 'opencode v2.0.28 (broken)', 1)
    expect(await adapter.available()).toEqual({ ok: true, sessions: 2 })
    expect(await adapter.available()).toEqual({ ok: true, sessions: 2 })
    expect(await versionReads(bin)).toBe(5)
  })

  it('follows XDG_DATA_HOME and is not recognised without time_updated', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeBinary(bin, 'opencode')
    const data = join(home, 'data')
    await mkdir(join(data, 'opencode'), { recursive: true })
    const database = new BetterSqlite3(join(data, 'opencode', 'opencode.db'))
    database.exec('CREATE TABLE session (id TEXT, time_created INTEGER)')
    openStores.push(database)

    expect(await openCodeHistoryAdapter({ home, open, env: { PATH: bin, XDG_DATA_HOME: data } }).available())
      .toEqual({ ok: false, reason: 'session has no time_updated' })
  })
})

describe('history adapter helpers', () => {
  it('finds executables on PATH, strips BMN variables and picks the error line', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeBinary(bin, 'codex')
    expect(findOnPath('codex', `/nowhere::${bin}`)).toBe(join(bin, 'codex'))
    expect(findOnPath('missing', bin)).toBeNull()
    expect(agentCommandEnvironment({ PATH: '/bin', BMN_TOKEN: 'x', AITERM_CONTROL_SOCKET: 'y', HOME: '/h' }))
      .toEqual({ PATH: '/bin', HOME: '/h' })
    expect(failureLine('WARNING: proceeding\n\u001b[91mError: \u001b[0mSession not found\n')).toBe('Error: Session not found')
  })
})
