// MODULE: agent-history-self-test.ts - Electron self-test fixtures for Epic 31's history limit: fake home, Claude folders, agent stores and recording binaries
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

const DAY_MS = 86_400_000

/** The self-test host's home and the folder whose stand-in `codex`/`opencode` it finds first on PATH. */
export function selfTestHistoryRoots(): { home: string; bin: string } | null {
  const state = process.env.BMN_STATE_HOME
  if (!state) return null
  return { home: join(state, 'self-test-home'), bin: join(state, 'self-test-bin') }
}

/** Host environment additions for the self-test: its own home, and stand-in agents ahead of the real ones. */
export function selfTestHistoryEnvironment(): NodeJS.ProcessEnv {
  const roots = selfTestHistoryRoots()
  if (!roots) return {}
  mkdirSync(roots.home, { recursive: true })
  return { BMN_SELF_TEST_HOME: roots.home, PATH: `${roots.bin}:${process.env.PATH ?? ''}` }
}

export interface HistoryFixture {
  home: string
  claudeHome: string
  glm: string
  work: string
  codexLog: string
  openCodeLog: string
  /** A stand-in `cursor-agent` on PATH, so Cursor's own-history row shows on any machine; nothing may call it. */
  cursorLog: string
  ids: { oldCodex: string; recentCodex: string; heldCodex: string; oldOpenCode: string; recentOpenCode: string; heldOpenCode: string }
  holder: ChildProcess
  /** Every file under the two agent stores with its size, so the run can be shown to remove none. */
  storeFiles(): string[]
}

type Database = { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown }; close(): void }

function recordingBinary(bin: string, name: string): string {
  const log = join(bin, `${name}.log`)
  writeFileSync(join(bin, name),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> '${log}'\necho "Deleted session $*"\nexit 0\n`)
  chmodSync(join(bin, name), 0o755)
  return log
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      // WAL side files come and go with any reader; the stores and transcripts are what must stay.
      else if (!/-(wal|shm)$/.test(entry.name)) out.push(`${path}:${statSync(path).size}`)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * A home with `~/.claude`, two more Claude folders for the stand-in's hook calls to teach BMN, a Codex and
 * an OpenCode store (one old, one recent and one old-but-held session each), and recording binaries.
 */
export function prepareHistoryFixture(isolatedCwd: string, now = Date.now()): HistoryFixture {
  const roots = selfTestHistoryRoots()
  const codexHome = process.env.CODEX_HOME
  const dataHome = process.env.XDG_DATA_HOME
  if (!roots || !codexHome || !dataHome) throw new Error('the agent history self-test needs BMN_STATE_HOME, CODEX_HOME and XDG_DATA_HOME')
  const claudeHome = join(roots.home, '.claude')
  const glm = join(isolatedCwd, 'history', '.claude-glm')
  const work = join(isolatedCwd, 'history', 'claude-work')
  for (const folder of [claudeHome, glm, work, roots.bin, codexHome, join(dataHome, 'opencode')]) mkdirSync(folder, { recursive: true })
  writeFileSync(join(claudeHome, 'settings.json'), '{\n  "model": "opus"\n}\n')
  writeFileSync(join(glm, 'settings.json'), '{\n  "cleanupPeriodDays": 90,\n  "env": { "ANTHROPIC_MODEL": "glm" }\n}\n')
  writeFileSync(join(work, 'settings.json'), '{}\n')

  const ids = {
    oldCodex: '01a0e466-9639-7372-89eb-960c2fe7e28a',
    recentCodex: '01a0e466-fa1c-77c2-8f99-88f5ace4fe7f',
    heldCodex: '01a0e467-3f6c-7650-8a17-14c32cc71174',
    oldOpenCode: 'ses_f1b971253ffeDV9XIFvU67lmdh',
    recentOpenCode: 'ses_f1b96fb27ffe706PCFZxEkJQYt',
    heldOpenCode: 'ses_f1b8c7a8cffe1ljwMNzpE9rw9Q'
  }
  const BetterSqlite3 = createRequire(__filename)('better-sqlite3') as new (path: string) => Database
  const codex = new BetterSqlite3(join(codexHome, 'state_5.sqlite'))
  codex.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)')
  const thread = codex.prepare('INSERT OR REPLACE INTO threads (id, rollout_path, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)')
  for (const [id, age] of [[ids.oldCodex, 40], [ids.recentCodex, 2], [ids.heldCodex, 45]] as const) {
    const rollout = join(codexHome, 'sessions', `rollout-${id}.jsonl`)
    mkdirSync(join(codexHome, 'sessions'), { recursive: true })
    writeFileSync(rollout, '{"type":"session_meta"}\n')
    thread.run(id, rollout, Math.floor((now - (age + 5) * DAY_MS) / 1000), Math.floor((now - age * DAY_MS) / 1000))
  }
  codex.close()
  const opencode = new BetterSqlite3(join(dataHome, 'opencode', 'opencode.db'))
  opencode.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)')
  const session = opencode.prepare('INSERT OR REPLACE INTO session VALUES (?, ?, ?, ?, ?)')
  for (const [id, age] of [[ids.oldOpenCode, 40], [ids.recentOpenCode, 2], [ids.heldOpenCode, 45]] as const) {
    session.run(id, 'project', isolatedCwd, now - (age + 5) * DAY_MS, now - age * DAY_MS)
  }
  opencode.close()

  const codexLog = recordingBinary(roots.bin, 'codex')
  const openCodeLog = recordingBinary(roots.bin, 'opencode')
  const cursorLog = recordingBinary(roots.bin, 'cursor-agent')
  // A process outside BMN that has both held sessions open, as `codex resume <id>` would.
  const holder = spawn('/bin/sh', ['-c', 'sleep 120', 'bmn-history-holder', ids.heldCodex, ids.heldOpenCode], { stdio: 'ignore' })
  return {
    home: roots.home, claudeHome, glm, work, codexLog, openCodeLog, cursorLog, ids, holder,
    storeFiles: () => [...listFiles(codexHome), ...listFiles(join(dataHome, 'opencode'))]
  }
}

export function recordedCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '') : []
}

export function claudeDays(folder: string): unknown {
  return (JSON.parse(readFileSync(join(folder, 'settings.json'), 'utf8')) as Record<string, unknown>).cleanupPeriodDays
}

export function backupsOf(folder: string): number {
  return readdirSync(folder).filter((name) => name.startsWith('settings.json.bmn-backup-')).length
}

/** What the owner sees: the dot on the Preferences button and, with Preferences open, the History rows. */
export async function historyView(window: BrowserWindow, action: 'read' | 'start-cleanup'): Promise<{
  dot: boolean
  rows: string[]
  confirm: string | null
}> {
  return window.webContents.executeJavaScript(`(async () => {
    const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
      const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
    } throw new Error('history view timed out: ' + label); };
    const dot = !!document.querySelector('.preferences-button .status-dot.needs-you');
    document.querySelector('.preferences-button').click();
    const rowsOf = () => [...document.querySelectorAll('.history-rows .history-row')]
      .map(row => [...row.children].map(cell => cell.textContent.trim()).filter(Boolean).join(' | '));
    await wait(() => rowsOf().length > 0, 'history rows');
    const confirm = document.querySelector('.history-confirm p')?.textContent ?? null;
    if (${JSON.stringify(action)} === 'start-cleanup') {
      (await wait(() => document.querySelector('.history-confirm button.primary:not(:disabled)'), 'Start cleanup')).click();
      await wait(() => !document.querySelector('.history-confirm'), 'confirm line gone');
    }
    const rows = rowsOf();
    document.querySelector('.preferences-dialog [aria-label="Close Preferences"]').click();
    await wait(() => !document.querySelector('.preferences-dialog'), 'Preferences closed');
    return { dot, rows, confirm };
  })()`) as Promise<{ dot: boolean; rows: string[]; confirm: string | null }>
}
