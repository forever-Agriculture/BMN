// MODULE: agent-history-adapters.test.ts - Codex and OpenCode history adapters against fixture databases and recording stand-in binaries
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexHistoryAdapter } from './agent-history-codex'
import { openCodeHistoryAdapter } from './agent-history-opencode'
import { agentCommandEnvironment, failureLine, findOnPath, runAgentCommand, type OpenReadOnly } from './agent-history-store'

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
  if (process.platform === 'win32') {
    const shim = await readFile(new URL('./fixtures/npm-node.cmd', import.meta.url), 'utf8')
    await writeFile(join(bin, `${name}.cmd`), shim.replace('..\\package\\entry.js', `${name}.mjs`))
    await writeFile(join(bin, `${name}.mjs`), `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, process.cwd()+'|'+process.argv.slice(2).join(' ')+'\\n');
appendFileSync(${JSON.stringify(log+'.argv')}, JSON.stringify(process.argv.slice(2))+'\\n');
console.error(${JSON.stringify(output)});process.exit(${code});`)
    try { await link(process.execPath, join(bin, 'node.exe')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await copyFile(process.execPath, join(bin, 'node.exe'))
    }
    return log
  }
  await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\nprintf '%s\\n' ${JSON.stringify(output)} >&2\nexit ${code}\n`)
  await chmod(join(bin, name), 0o755)
  return log
}

async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'bmn-history-adapter-')))
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
    const log = await fakeBinary(bin, 'opencode')
    await openCodeStore(home)
    const adapter = openCodeHistoryAdapter({ home, open, env: { PATH: bin } })

    expect(await adapter.available()).toEqual({ ok: true, sessions: 2 })
    expect(await adapter.candidates(NOW - 30 * DAY)).toEqual([{ id: OPENCODE_IDS[0], updatedAt: NOW - 40 * DAY }])
    expect(await adapter.remove(OPENCODE_IDS[0]!)).toEqual({ ok: true })
    expect(await adapter.remove('../../etc')).toEqual({ ok: false, reason: 'not an OpenCode session id' })
    expect(await readFile(log, 'utf8')).toBe(`${home}|session delete ${OPENCODE_IDS[0]} --pure\n`)
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
  it.skipIf(process.platform !== 'win32')('passes literal npm argv without expansion and refuses modified batch wrappers', async () => {
    const home = await root(), bin = join(home, 'my tools')
    const log = await fakeBinary(bin, 'codex')
    const env = { Path: bin, Pathext: '.CMD;.EXE' }
    const binary = findOnPath('codex', undefined, env)
    expect(binary).toBe(join(bin, 'codex.CMD'))
    const args = ['delete', 'space value', 'a"b', 'tail\\', '%HOME%', 'a&b', '!VALUE!', '雪']
    expect(await runAgentCommand(binary!, args, { cwd: home, env })).toMatchObject({ code: 0 })
    expect(JSON.parse((await readFile(`${log}.argv`, 'utf8')).trim())).toEqual(args)
    const shim = await readFile(binary!, 'utf8')
    await writeFile(binary!, shim.replace('SETLOCAL', 'SETLOCAL\r\necho modified'))
    expect(await runAgentCommand(binary!, ['MUST_NOT_RUN'], { cwd: home, env })).toMatchObject({ code: null })
    expect((await readFile(`${log}.argv`, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('finds executables on PATH, strips BMN variables and picks the error line', async () => {
    const home = await root()
    const bin = join(home, 'bin')
    await fakeBinary(bin, 'codex')
    expect(findOnPath('codex', `/nowhere${delimiter}${delimiter}${bin}`)).toBe(join(bin, process.platform === 'win32' ? 'codex.CMD' : 'codex'))
    expect(findOnPath('missing', bin)).toBeNull()
    expect(agentCommandEnvironment({ PATH: '/bin', BMN_TOKEN: 'x', AITERM_CONTROL_SOCKET: 'y', HOME: '/h' }))
      .toEqual({ PATH: '/bin', HOME: '/h' })
    expect(failureLine('WARNING: proceeding\n\u001b[91mError: \u001b[0mSession not found\n')).toBe('Error: Session not found')
  })
})
