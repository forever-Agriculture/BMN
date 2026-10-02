/* global window */
// Seed synthetic legacy drafts in the isolated store, then drive the real renderer/host/PTY delivery.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/epic-54/drafts')
mkdirSync(evidence, { recursive: true })
const wayland = process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY)
  ? join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const app = await _electron.launch({
    executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'),
      OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'), BMN_LAUNCH_CWD: root,
      ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}) }
  })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const receiver = join(root, 'receiver.mjs'), input = join(root, 'input.txt')
    writeFileSync(receiver, `import{appendFileSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));setTimeout(()=>process.stdout.write('DRAFT RECEIVER READY\\r\\n'),500);setInterval(()=>{},1000);`)
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const created = await page.evaluate(params => window.aiTerminal.createSession(params), {
      workspaceId: workspace.workspaceId, name: 'Draft delivery audit', cwd: root,
      executable: process.execPath, argv: [receiver], cols: 80, rows: 24, backgroundChoice: 'stop'
    })
    const sessionId = created.session.sessionId
    const fixture = join(root, 'attachment.txt'); writeFileSync(fixture, 'Synthetic attached context\n')
    const artifact = await app.evaluate(async ({ ipcMain, BrowserWindow }, params) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const event = { sender: contents, senderFrame: contents.mainFrame }
      const response = await ipcMain._invokeHandlers.get('aiterm:artifact:import-paths')(event, params)
      if (!response.ok) throw new Error(response.message)
      return response.result[0]
    }, { sessionId, paths: [fixture] })
    const rows = [
      { id: 'type-draft', text: 'SYNTHETIC TYPE REPLY', state: 'draft', artifact: artifact.artifactId },
      { id: 'send-draft', text: 'SYNTHETIC SUBMITTED REPLY', state: 'draft', artifact: artifact.artifactId },
      { id: 'uncertain-draft', text: 'SYNTHETIC UNCERTAIN REPLY', state: 'uncertain', artifact: null }
    ]
    // Fixture creation only; all send/claim/retry behavior below uses the real installed IPC and host.
    await app.evaluate((_electron, params) => {
      const { createRequire } = process.mainModule.require('node:module')
      const Database = createRequire(params.packagePath)('better-sqlite3')
      const database = new Database(params.path, { fileMustExist: true })
      try {
        const insert = database.prepare(`INSERT INTO input_draft
          (draft_id,session_id,origin,text,artifact_id,state,detail,created_at,updated_at)
          VALUES (?,?,'telegram',?,?,?,NULL,?,?)`)
        const now = new Date().toISOString()
        for (const row of params.rows) insert.run(row.id, params.sessionId, row.text, row.artifact, row.state, now, now)
      } finally { database.close() }
    }, { path: join(roots.data, 'bmn/state.sqlite3'), packagePath: join(repo, 'apps/desktop/package.json'), sessionId, rows })
    await page.reload()
    await page.locator(`.session-row button[data-session-id="${sessionId}"]`).click()
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).bufferLines.some(line => line.includes('DRAFT RECEIVER READY')), sessionId)
    await page.locator('.session-terminal.selected').getByRole('button', { name: 'Files', exact: true }).click()
    const type = page.locator('.files-draft').filter({ hasText: 'SYNTHETIC TYPE REPLY' })
    await type.getByRole('button', { name: 'Type into session', exact: true }).click()
    await page.waitForFunction(async () => (await window.aiTerminal.listDrafts()).find(d => d.draftId === 'type-draft')?.state === 'accepted')
    const typed = readFileSync(input, 'utf8')
    assert.ok(typed.includes('SYNTHETIC TYPE REPLY') && typed.includes(`${artifact.artifactId}.txt`))
    assert.equal(typed.split('\u001b[200~').length - 1, 1)
    assert.equal(typed.includes('\r'), false, 'Type submitted input')
    assert.equal(await type.getByRole('button', { name: 'Type into session', exact: true }).isDisabled(), true)
    const send = page.locator('.files-draft').filter({ hasText: 'SYNTHETIC SUBMITTED REPLY' })
    await send.getByRole('button', { name: 'Send with Enter', exact: true }).click()
    await page.waitForFunction(async () => (await window.aiTerminal.listDrafts()).find(d => d.draftId === 'send-draft')?.state === 'submitted')
    const submitted = readFileSync(input, 'utf8').slice(typed.length)
    assert.ok(submitted.includes('SYNTHETIC SUBMITTED REPLY') && submitted.includes(`${artifact.artifactId}.txt`))
    assert.equal(submitted.split('\u001b[200~').length - 1, 1)
    assert.ok(submitted.endsWith('\u001b[201~\r'), 'Enter must follow text and attachment')
    const uncertain = page.locator('.files-draft').filter({ hasText: 'SYNTHETIC UNCERTAIN REPLY' })
    assert.equal(await uncertain.getByRole('button', { name: 'Type into session', exact: true }).isDisabled(), true)
    assert.equal(await uncertain.getByRole('button', { name: 'Send with Enter', exact: true }).isDisabled(), true)
    const beforeRetry = readFileSync(input, 'utf8')
    const refusal = await page.evaluate(async () => {
      try { await window.aiTerminal.sendDraft('uncertain-draft', true); return null }
      catch (error) { return { code: error.code, message: error.message } }
    })
    assert.equal(refusal.code, 'REVISION_CONFLICT')
    assert.match(refusal.message, /uncertain/i)
    await uncertain.getByRole('button', { name: 'Create retry draft', exact: true }).click()
    await page.waitForFunction(async () => (await window.aiTerminal.listDrafts()).filter(d => d.text === 'SYNTHETIC UNCERTAIN REPLY').length === 2)
    assert.equal(readFileSync(input, 'utf8'), beforeRetry, 'Creating a retry sent input')
    const retry = page.locator('.files-draft').filter({ hasText: 'SYNTHETIC UNCERTAIN REPLY' })
      .filter({ has: page.locator('.files-draft-meta', { hasText: /· draft$/ }) })
    await retry.getByRole('button', { name: 'Type into session', exact: true }).click()
    await page.waitForFunction(async () => (await window.aiTerminal.listDrafts()).some(d => d.draftId !== 'uncertain-draft' && d.text === 'SYNTHETIC UNCERTAIN REPLY' && d.state === 'accepted'))
    const drafts = await page.evaluate(() => window.aiTerminal.listDrafts())
    assert.equal(drafts.find(d => d.draftId === 'uncertain-draft').state, 'uncertain')
    assert.equal((readFileSync(input, 'utf8').slice(beforeRetry.length).match(/SYNTHETIC UNCERTAIN REPLY/g) ?? []).length, 1)
    await page.screenshot({ path: join(evidence, 'draft-states.png') })
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'PASS', fixture: 'Synthetic drafts inserted in isolated SQLite; real renderer/host/PTY delivery',
      checks: ['combined Type without Enter', 'combined Send with final Enter', 'uncertain actions disabled', 'host rejects ordinary replay', 'explicit retry creates without input', 'retry pastes once; original stays uncertain'],
      drafts: drafts.map(d => ({ id: d.draftId, state: d.state, attemptedIncarnationId: d.attemptedIncarnationId })) }, null, 2))
    console.log('PASS: real renderer/host/PTY Type+Send text/files, uncertain replay rejection and explicit retry flow')
  } finally {
    const page = (await app.windows())[0]
    await page?.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces(true)) {
        for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
      }
    }).catch(() => {})
    await app.close()
  }
})
