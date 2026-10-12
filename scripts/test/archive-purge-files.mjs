/* global window */
// MODULE: archive-purge-files.mjs - runtime check that an expired session's files leave the disk at the next start
// An isolated BMN with a backdated archived session: after the next start its delivered file and that
// file's link are gone from the disk, and a file a kept session's pending handoff names is still there.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/epic-61/runtime')
mkdirSync(evidence, { recursive: true })
const wayland = process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY)
  ? join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const dataRoot = join(roots.data, 'bmn')
  const databasePath = join(dataRoot, 'state.sqlite3')
  const packagePath = join(repo, 'apps/desktop/package.json')
  const launch = async () => {
    const app = await _electron.launch({
      executablePath: createRequire(packagePath)('electron'), cwd: repo,
      args: [join(repo, 'apps/desktop'), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
      env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
        XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
        BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: dataRoot,
        BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
        CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'),
        OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'), BMN_LAUNCH_CWD: root,
        ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}) }
    })
    return app
  }
  const close = async (app) => {
    const page = (await app.windows())[0]
    await page?.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces(true)) {
        for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
      }
    }).catch(() => {})
    await app.close()
  }
  /** Runs SQL against the isolated store from the app's own process, where the native module loads. */
  const sql = (app, statements) => app.evaluate((_electron, params) => {
    const { createRequire } = process.mainModule.require('node:module')
    const Database = createRequire(params.packagePath)('better-sqlite3')
    const database = new Database(params.path, { fileMustExist: true })
    try {
      return params.statements.map(([text, values, read]) => {
        const statement = database.prepare(text)
        return read ? statement.all(...values) : statement.run(...values).changes
      })
    } finally { database.close() }
  }, { path: databasePath, packagePath, statements })

  let app = await launch()
  try {
    let page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const receiver = join(root, 'receiver.mjs'), input = join(root, 'input.txt')
    writeFileSync(receiver, `import{appendFileSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));setTimeout(()=>process.stdout.write('PURGE RECEIVER READY\\r\\n'),300);setInterval(()=>{},1000);`)
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const create = (name) => page.evaluate(params => window.aiTerminal.createSession(params), {
      workspaceId: workspace.workspaceId, name, cwd: root, executable: process.execPath, argv: [receiver], cols: 80, rows: 24, backgroundChoice: 'stop'
    })
    const expired = (await create('Expired synthetic session')).session.sessionId
    const kept = (await create('Kept synthetic session')).session.sessionId
    const importFile = async (sessionId, name, text) => {
      const path = join(root, name); writeFileSync(path, text)
      return app.evaluate(async ({ ipcMain, BrowserWindow }, params) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        const response = await ipcMain._invokeHandlers.get('aiterm:artifact:import-paths')({ sender: contents, senderFrame: contents.mainFrame }, params)
        if (!response.ok) throw new Error(response.message)
        return response.result[0]
      }, { sessionId, paths: [path] })
    }
    const delivered = await importFile(expired, 'delivered.txt', 'Synthetic delivered file\n')
    const handed = await importFile(expired, 'handed.txt', 'Synthetic handed-over file\n')
    const own = await importFile(kept, 'own.txt', 'Synthetic file of the kept session\n')
    const ownerFile = join(root, 'owner-file.txt'); writeFileSync(ownerFile, 'Synthetic owner file outside the store\n')

    await page.reload()
    await page.locator(`.session-row button[data-session-id="${expired}"]`).click()
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).bufferLines.some(line => line.includes('PURGE RECEIVER READY')), expired)
    const delivery = await page.evaluate(([artifactId, sessionId]) => window.aiTerminal.deliverArtifact(artifactId, sessionId), [delivered.artifactId, expired])
    assert.ok(lstatSync(delivery.path).isSymbolicLink(), 'delivery made no link')
    for (const record of [delivered, handed, own]) assert.ok(existsSync(record.storedPath), `${record.originalName} was not stored`)

    await page.evaluate(() => window.aiTerminal.putSettings('archive', { deleteAfterDays: 10 }))
    await page.evaluate(async (ids) => { for (const id of ids) await window.aiTerminal.stopSession(id).catch(() => {}) }, [expired, kept])
    const now = new Date()
    const backdated = new Date(now.getTime() - 11 * 86_400_000).toISOString()
    // Fixture only: a pending handoff in the kept session that names one file of the session about to
    // expire, and an archive date the retention period has passed. The purge itself is the app's own.
    const seeded = await sql(app, [
      [`INSERT INTO input_draft(draft_id, session_id, origin, source_session_id, text, artifact_ids_json, state, created_at, updated_at)
        VALUES ('pending-handoff', ?, 'handoff', ?, 'Synthetic handoff', ?, 'draft', ?, ?)`,
      [kept, expired, JSON.stringify([handed.artifactId]), now.toISOString(), now.toISOString()], false],
      ['UPDATE session SET archived_at = ? WHERE session_id = ?', [backdated, expired], false]
    ])
    assert.deepEqual(seeded, [1, 1])
    await close(app)
    assert.ok(existsSync(delivered.storedPath) && lstatSync(delivery.path).isSymbolicLink(), 'files left before the purging start')

    app = await launch()
    page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.waitForSelector('.shell-window')
    const sessions = (await page.evaluate(async () => {
      const all = []
      for (const ws of await window.aiTerminal.listWorkspaces(true)) all.push(...await window.aiTerminal.listSessions(ws.workspaceId))
      return all.map(s => s.sessionId)
    }))
    assert.ok(!sessions.includes(expired), 'the expired session is still listed')
    assert.ok(sessions.includes(kept), 'the kept session is gone')
    const deadline = Date.now() + 10000
    while (existsSync(delivered.storedPath) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    assert.equal(existsSync(delivered.storedPath), false, 'the delivered original is still on disk')
    assert.equal(lstatSync(delivery.path, { throwIfNoEntry: false }), undefined, 'the delivery link is still on disk')
    assert.ok(existsSync(handed.storedPath), 'the file a pending handoff names was removed')
    assert.ok(existsSync(own.storedPath), 'a kept session lost its own file')
    assert.equal(readFileSync(ownerFile, 'utf8'), 'Synthetic owner file outside the store\n')
    const [rows, drafts] = await sql(app, [
      ['SELECT artifact_id, session_id FROM artifact ORDER BY artifact_id', [], true],
      ["SELECT draft_id, session_id, source_session_id, state FROM input_draft WHERE draft_id = 'pending-handoff'", [], true]
    ])
    assert.deepEqual(rows, [
      { artifact_id: handed.artifactId, session_id: null },
      { artifact_id: own.artifactId, session_id: kept }
    ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)))
    assert.deepEqual(drafts, [{ draft_id: 'pending-handoff', session_id: kept, source_session_id: null, state: 'draft' }])
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'PASS',
      revision: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      uncommittedChanges: execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      fixture: 'Synthetic sessions and files in an isolated data root; archive date and pending handoff set in its SQLite; the purge ran at a real start',
      checks: ['expired session deleted', 'delivered original removed', 'delivery link removed', 'pending-handoff file kept and unlinked',
        'kept session file and record untouched', 'owner file outside the store untouched'],
      notObserved: 'the host log line (kept in the main process, not printed); its wording is unit-tested',
      linksLeft: readdirSync(join(dataRoot, 'artifacts', 'links')), artifactRows: rows, handoff: drafts[0] }, null, 2))
    console.log('PASS: an expired session takes its delivered file and link; a pending handoff file survives')
  } finally { await close(app) }
})
