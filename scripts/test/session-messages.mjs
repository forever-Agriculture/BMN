/* global window */
// MODULE: session-messages.mjs - Epic 66 in an isolated BMN: stand-in agents run the real bmn and emit real hook events; the owner's side is the real window
// Four made-up sessions: Lead, Planner and Scout in one workspace, Outsider in another. Each is a stand-in agent
// on a real terminal that records every byte typed into it, runs `bmn` commands as its own child and emits an
// app's hook events: Codex's for Planner (`bmn hook codex`), Claude Code's for Lead (`bmn hook claude`). A fifth,
// Reviewer, joins late to send Lead its message. HOME is a scratch folder with a made-up approved
// team, so neither BMN nor a hook reads the owner's own. Nothing reaches a provider. Since Story 75.4 messages are on
// everywhere, the owner pastes, pauses and resumes nothing, and a session whose agent BMN hands no message to is
// refused to its sender.
// Screenshots and the result land in .dev-auto/evidence/epic-66/electron/ (ignored).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/epic-66/electron')
mkdirSync(evidence, { recursive: true })
const cli = join(repo, 'apps/desktop/bin/bmn')
const wayland = process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY)
  ? join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
const passed = []
const pass = (label) => { passed.push(label); console.error(`[BMN session messages] PASS ${label}`) }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const NOT_A_PEER = 'That session is not one of your peers; run bmn peers'
const NO_AGENT = 'That session runs no agent whose hook BMN has heard from; nothing was sent'
const SHELL_ONLY = 'That session runs no agent now, only its shell; nothing was sent'
const CODEX_SESSION = '0a0a0a0a-1b1b-2c2c-3d3d-4e4e4e4e4e4e'
const CLAUDE_SESSION = '5b5b5b5b-1b1b-2c2c-3d3d-4e4e4e4e4e4e'

// The stand-in agent: the session's own program, so it holds the terminal as a typed agent does. It keeps what
// is typed into it, and runs each command file as a child of itself, as an agent runs a tool or its hook.
const AGENT = `import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [dir, bmn] = process.argv.slice(2)
writeFileSync(join(dir, 'input'), '')
process.stdin.setRawMode(true)
process.stdin.on('data', (bytes) => appendFileSync(join(dir, 'input'), bytes))
process.stdout.write('STAND-IN READY\\r\\n')
let busy = false
setInterval(() => {
  if (busy) return
  const next = readdirSync(dir).filter((name) => /^cmd-\\d+\\.json$/.test(name)).sort()[0]
  if (!next) return
  busy = true
  const command = JSON.parse(readFileSync(join(dir, next), 'utf8'))
  renameSync(join(dir, next), join(dir, next.replace('cmd-', 'taken-')))
  const child = spawn(process.execPath, [bmn, ...command.argv], { cwd: command.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (bytes) => { stdout += bytes })
  child.stderr.on('data', (bytes) => { stderr += bytes })
  child.on('close', (code) => {
    const out = join(dir, next.replace('cmd-', 'out-'))
    writeFileSync(out + '.part', JSON.stringify({ code, stdout, stderr }))
    renameSync(out + '.part', out)
    busy = false
  })
  child.stdin.end(command.input ?? '')
}, 20)
`

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const home = join(root, 'home')
  const agents = join(home, '.config/bmn/agents')
  mkdirSync(join(agents, 'state'), { recursive: true, mode: 0o700 })
  // The unit tests' made-up team: OpenAI and Anthropic may see private work. This home holds no OpenCode settings, so its destination is the owner's word here.
  writeFileSync(join(agents, 'roster.md'), readFileSync(join(repo, 'apps/desktop/src/utility/test-fixtures/agents/roster-example.md'), 'utf8')
    .replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}'))
  const stubs = join(root, 'stubs')
  mkdirSync(stubs)
  writeFileSync(join(stubs, 'codex'), '#!/bin/sh\necho "codex-cli 0.162.1"\n', { mode: 0o755 })
  writeFileSync(join(stubs, 'claude'), '#!/bin/sh\necho "2.1.296 (Claude Code)"\n', { mode: 0o755 })
  // The record Codex saves for a conversation: the guard's resolver reads the session's provider from it.
  const codexHome = join(home, '.codex')
  const record = join(codexHome, `sessions/2026/10/13/rollout-2026-10-13T09-00-00-${CODEX_SESSION}.jsonl`)
  mkdirSync(dirname(record), { recursive: true })
  // Three made-up repositories and a plain folder.
  const repos = Object.fromEntries(['lead', 'planner', 'elsewhere', 'outsider'].map((name) => {
    const path = join(root, 'code', name)
    mkdirSync(join(path, '.git'), { recursive: true })
    // What Git leaves at a top-level: BMN reads past an empty .git folder, as Git does.
    writeFileSync(join(path, '.git/HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(path, 'deep/er'), { recursive: true })
    return [name, path]
  }))
  writeFileSync(record, `${JSON.stringify({ type: 'session_meta', payload: { id: CODEX_SESSION, cwd: repos.planner, model_provider: 'openai', cli_version: '0.162.1' } })}\n`)
  const agentScript = join(root, 'agent.mjs')
  writeFileSync(agentScript, AGENT)

  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_BASE_URL']) delete env[key]
  const app = await _electron.launch({
    executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, HOME: home, SHELL: '/bin/bash', PATH: `${stubs}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root,
      ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}) }
  })
  try {
    let page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {})
    const shot = (name) => page.screenshot({ path: join(evidence, name) })

    // The made-up team is approved as the window's own Approve does it.
    const approval = await page.evaluate(async () => {
      const snapshot = await window.aiTerminal.agentsSnapshot()
      return window.aiTerminal.approveAgents({ generation: null, fileHash: snapshot.file.hash, link: snapshot.file.link, directory: snapshot.file.directory })
    })
    assert.equal(existsSync(join(agents, 'state/current')), true, `the made-up team was not approved: ${JSON.stringify(approval)}`)

    const first = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    // The shell BMN itself starts with is a session of the first workspace, so it is a peer there like any other.
    const starter = (await page.evaluate((id) => window.aiTerminal.listSessions(id), first.workspaceId))[0]
    await page.evaluate((p) => window.aiTerminal.updateWorkspace(p), { workspaceId: first.workspaceId, expectedRevision: first.revision, name: 'Epic talk' })
    const other = await page.evaluate((cwd) => window.aiTerminal.createWorkspace({ name: 'Other project', defaultCwd: cwd }), repos.outsider)

    const sessions = {}
    let commandNumber = 0
    const start = async (key, name, workspaceId, cwd) => {
      const dir = join(root, 'agents', key)
      mkdirSync(dir, { recursive: true })
      const created = await page.evaluate((p) => window.aiTerminal.createSession(p), {
        workspaceId, name, cwd, executable: process.execPath, argv: [agentScript, dir, cli], cols: 100, rows: 30, backgroundChoice: 'stop'
      })
      sessions[key] = { id: created.session.sessionId, name, dir, cwd }
    }
    await start('lead', 'Lead', first.workspaceId, repos.lead)
    await start('planner', 'Planner', first.workspaceId, repos.planner)
    await start('scout', 'Scout', first.workspaceId, repos.lead)
    await start('outsider', 'Outsider', other.workspaceId, repos.outsider)
    const typed = (key) => readFileSync(join(sessions[key].dir, 'input'), 'utf8')
    const nothingTyped = (label) => { for (const key of Object.keys(sessions)) assert.equal(typed(key), '', `${label}: bytes reached ${key}'s terminal`) }
    /** Runs `bmn <argv>` as a child of that session's agent, in `cwd`, and returns what it printed. */
    const bmn = async (key, argv, { input = '', cwd = sessions[key].cwd } = {}) => {
      const name = `cmd-${String(++commandNumber).padStart(4, '0')}.json`
      const file = join(sessions[key].dir, name)
      writeFileSync(`${file}.part`, JSON.stringify({ argv, input, cwd }))
      renameSync(`${file}.part`, file)
      const out = join(sessions[key].dir, name.replace('cmd-', 'out-'))
      const end = Date.now() + 15000
      while (!existsSync(out)) {
        if (Date.now() > end) throw new Error(`bmn ${argv.join(' ')} in ${key} never finished`)
        await sleep(20)
      }
      return JSON.parse(readFileSync(out, 'utf8'))
    }
    const json = (result) => {
      assert.equal(result.code, 0, `bmn failed: ${result.stderr}`)
      return JSON.parse(result.stdout)
    }
    /** One of Codex's events after a tool call, as Codex 0.162.1 sends it to its hook. */
    const codexEvent = (more = {}) => JSON.stringify({
      session_id: CODEX_SESSION, turn_id: 'turn-1', transcript_path: record, cwd: repos.planner, hook_event_name: 'PostToolUse', model: 'gpt-6-luna',
      permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'echo one' }, tool_response: 'one', tool_use_id: 'call-1', ...more
    })
    const messages = () => page.evaluate((id) => window.aiTerminal.listSessionMessages(id), first.workspaceId)
    const stateOf = async (messageId) => (await messages()).messages.find((message) => message.messageId === messageId)?.state

    // The window reads sessions made behind its back on a reload.
    await page.reload()
    await page.waitForSelector(`.session-row button[data-session-id="${sessions.planner.id}"]`)
    for (const key of Object.keys(sessions)) {
      const end = Date.now() + 15000
      while (!existsSync(join(sessions[key].dir, 'input'))) {
        if (Date.now() > end) throw new Error(`${key}'s stand-in agent never started`)
        await sleep(20)
      }
    }
    const menuEntries = () => page.locator('.popup-menu [role="menuitem"], .popup-menu [role="menuitemcheckbox"]').allTextContents()
    const openWorkspaceMenu = () => page.getByRole('button', { name: 'Actions for Epic talk', exact: true }).click()
    const openSessionMenu = (name) => page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()

    // ---- 75.4 AC1, AC2: messages are on from the start; no menu switches them, shuts a session out or pastes ----
    await openWorkspaceMenu()
    const workspaceEntries = await menuEntries()
    await shot('workspace-menu.png')
    await page.keyboard.press('Escape')
    await openSessionMenu('Scout')
    const sessionEntries = await menuEntries()
    await page.keyboard.press('Escape')
    assert.notEqual(workspaceEntries.length, 0, 'the workspace menu did not open')
    assert.notEqual(sessionEntries.length, 0, 'the session menu did not open')
    for (const entry of [...workspaceEntries, ...sessionEntries]) {
      assert.doesNotMatch(entry, /Sessions here may message each other|Record what each turn changes|Receive messages|Resume recording/, `a menu still has ${entry}`)
    }
    pass('75.4 AC1, AC2: messages are on in a new workspace; neither menu switches them, shuts a session out or resumes recording')

    // ---- 66.2 AC2: peers of the caller's own workspace, by id, name and the agent in front there now ----
    // Planner's Codex is heard once, after a tool call with no message waiting: its hook prints nothing.
    assert.deepEqual(await bmn('planner', ['hook', 'codex'], { input: codexEvent() }), { code: 0, stdout: '', stderr: '' })
    const peers = json(await bmn('lead', ['peers', '--json']))
    assert.deepEqual(peers.peers.map((peer) => [peer.sessionId, peer.name, peer.app]).sort(),
      [[sessions.planner.id, 'Planner', 'Codex'], [sessions.scout.id, 'Scout', null], [starter.sessionId, starter.name, null]].sort())
    assert.deepEqual(Object.keys(peers.peers[0]).sort(), ['app', 'name', 'sessionId'], 'a peer row shows more than id, name and app')
    assert.equal(JSON.stringify(peers).includes(sessions.outsider.id), false, 'a session of another workspace is listed')
    // The other workspace has messages on too: its session still reaches nothing here, in the one wording.
    assert.deepEqual(json(await bmn('outsider', ['peers', '--json'])).peers, [])
    const fromOutside = await bmn('outsider', ['tell', sessions.lead.id, '--text', 'made-up text', '--key', 'outside-1'])
    assert.notEqual(fromOutside.code, 0)
    assert.match(fromOutside.stderr, new RegExp(NOT_A_PEER))
    const toOutside = await bmn('lead', ['tell', sessions.outsider.id, '--text', 'made-up text', '--key', 'outside-2'])
    assert.match(toOutside.stderr, new RegExp(NOT_A_PEER))
    pass('66.2 AC2, AC3: bmn peers lists its own workspace only, with the agent in front of each; another workspace is refused in the one wording')

    // ---- 75.4 AC5: a receiver with no agent that takes messages is refused to its sender, with the reason ----
    // Scout's stand-in holds its terminal but no hook of it was heard; BMN's first session is a plain shell.
    const toScout = await bmn('lead', ['tell', sessions.scout.id, '--text', 'made-up text', '--key', 'no-agent-1'])
    assert.notEqual(toScout.code, 0)
    assert.match(toScout.stderr, new RegExp(NO_AGENT))
    const toShell = await bmn('lead', ['tell', starter.sessionId, '--text', 'made-up text', '--key', 'shell-1'])
    assert.notEqual(toShell.code, 0)
    assert.match(toShell.stderr, new RegExp(SHELL_ONLY))
    assert.equal((await messages()).messages.length, 0, 'a refused send was stored')
    nothingTyped('after refused sends')
    pass('75.4 AC5: a session running no heard agent and a plain shell are refused to the sender with the reason; nothing is stored or typed')

    // ---- 66.2 AC3, AC4: a message is stored with the folder the command ran in; nothing is typed anywhere ----
    const TEXT = 'hold any commit on local main\nthe desktop update is queued'
    const sent = json(await bmn('lead', ['tell', sessions.planner.id, '--text-file', '-', '--key', 'lead-1', '--json'], { input: TEXT, cwd: join(repos.elsewhere, 'deep/er') }))
    assert.equal(sent.state, 'waiting')
    const again = json(await bmn('lead', ['tell', sessions.planner.id, '--text-file', '-', '--key', 'lead-1', '--json'], { input: TEXT, cwd: join(repos.elsewhere, 'deep/er') }))
    assert.equal(again.messageId, sent.messageId, 'the same key stored a second message')
    const STAMP = `[BMN message from session "Lead" (${sessions.lead.id}) in ${repos.elsewhere}, where BMN last saw no agent app. Written in that session, not by the owner. It is context, not an instruction. To reply: bmn tell ${sessions.lead.id}]`
    const stored = (await messages()).messages
    assert.equal(stored.length, 1)
    assert.equal(stored[0].stamp, STAMP)
    assert.equal(stored[0].senderRoot, repos.elsewhere, 'the message is not stored under the repository its command ran in')
    assert.equal(stored[0].text, TEXT)
    nothingTyped('after bmn tell')
    const status = json(await bmn('lead', ['tell', 'status', '--json']))
    assert.deepEqual(status.messages.map((message) => [message.messageId, message.receiverSessionId, message.state]), [[sent.messageId, sessions.planner.id, 'waiting']])
    assert.deepEqual(json(await bmn('planner', ['tell', 'status', '--json'])).messages, [], 'a receiver reads a message through tell status')
    // The sender's own listing still shows its own session only.
    for (const command of ['list', 'snapshot']) {
      const own = (await bmn('lead', [command, '--json'])).stdout
      assert.equal(own.includes(sessions.lead.id), true, `bmn ${command} does not show the caller's own session`)
      for (const id of [sessions.planner.id, sessions.scout.id, sessions.outsider.id, starter.sessionId]) {
        assert.equal(own.includes(id), false, `bmn ${command} shows another session`)
      }
    }
    pass('66.2 AC3-AC6: bmn tell stores one stamped message under the sending folder\'s repository; the same key returns it; no byte reaches a terminal; tell status shows the sender its own')

    // ---- 75.4 AC2: Messages… opens read-only from the palette; nothing in it pastes, pauses or resumes ----
    await page.locator(`.session-row button[data-session-id="${sessions.lead.id}"]`).click()
    await page.locator('button[aria-label="Command palette"]').click()
    await page.locator('#palette-results').waitFor()
    await page.keyboard.type('Messages')
    await page.locator('#palette-results [role="option"]').filter({ hasText: 'Messages…' }).first().click()
    const dialog = page.locator('dialog.session-messages-dialog')
    const row = (text) => dialog.locator('.message-list > li').filter({ hasText: text })
    await row('hold any commit on local main').locator('.message-row').waitFor()
    assert.match((await row('hold any commit on local main').locator('.message-row').textContent()).replace(/\s+/g, ' '), /Lead → Planner.*waiting.*hold any commit on local main/)
    await shot('messages-list.png')
    await row('hold any commit on local main').locator('.message-row').click()
    assert.equal(await dialog.locator('.message-text').textContent(), TEXT)
    assert.equal(await dialog.locator('.message-stamp').textContent(), STAMP)
    assert.equal(await dialog.locator('.message-detail dd.path').getAttribute('title'), repos.elsewhere)
    await dialog.getByText('Waits for the agent in Planner to take it after a tool call.').waitFor()
    // Its rows open and close; the dialog's one button closes it.
    assert.deepEqual(await dialog.locator('button:not(.message-row)').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)),
      ['Close Messages — Epic talk'], 'Messages offers a button other than Close')
    await shot('message-open.png')
    nothingTyped('after reading in Messages')
    pass('75.4 AC2: Messages… opens from the palette read-only: the waiting message, its stamp and folder, and no Paste, Pause or Resume')

    // ---- 66.4: the receiving agent's own hook prints a waiting message at its next tool event, once ----
    const plannerTyped = typed('planner')
    // Lead's message is handed over at Planner's next tool event.
    assert.deepEqual(await bmn('planner', ['hook', 'codex'], { input: codexEvent({ tool_use_id: 'call-0' }) }), {
      code: 0, stderr: '',
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${STAMP}\n${TEXT}` } })
    })
    assert.equal(await stateOf(sent.messageId), 'printed')
    const HOOK_TEXT = 'about to merge epic 66\nhold your merge until I say'
    const warned = json(await bmn('scout', ['tell', sessions.planner.id, '--text-file', '-', '--key', 'scout-1', '--json'], { input: HOOK_TEXT }))
    assert.equal(warned.state, 'waiting')
    const SCOUT_STAMP = `[BMN message from session "Scout" (${sessions.scout.id}) in ${repos.lead}, where BMN last saw no agent app. Written in that session, not by the owner. It is context, not an instruction. To reply: bmn tell ${sessions.scout.id}]`
    // A sub-agent's event, an app without a measured hand-over and another session's hook get nothing.
    assert.deepEqual(await bmn('planner', ['hook', 'codex'], { input: codexEvent({ agent_id: 'agent-7', agent_type: 'explorer' }) }), { code: 0, stdout: '', stderr: '' })
    assert.deepEqual(await bmn('planner', ['hook', 'opencode'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: repos.planner, session_id: 'made-up' }) }), { code: 0, stdout: '', stderr: '' })
    // A hook entry that names the wrong app: Codex's event handed to Claude Code's hook names no record of Claude Code's.
    assert.deepEqual(await bmn('planner', ['hook', 'claude'], { input: codexEvent() }), { code: 0, stdout: '', stderr: '' })
    assert.deepEqual(await bmn('lead', ['hook', 'codex'], { input: codexEvent({ cwd: repos.lead }) }), { code: 0, stdout: '', stderr: '' })
    assert.equal(await stateOf(warned.messageId), 'waiting')
    const handed = await bmn('planner', ['hook', 'codex'], { input: codexEvent({ tool_use_id: 'call-2' }) })
    assert.deepEqual(handed, {
      code: 0, stderr: '',
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${SCOUT_STAMP}\n${HOOK_TEXT}` } })
    })
    assert.equal(await stateOf(warned.messageId), 'printed')
    // The next events print nothing: one hand-over, once.
    assert.deepEqual(await bmn('planner', ['hook', 'codex'], { input: codexEvent({ tool_use_id: 'call-3' }) }), { code: 0, stdout: '', stderr: '' })
    assert.equal(typed('planner'), plannerTyped, 'the hook hand-over typed into the terminal')
    assert.equal(json(await bmn('scout', ['tell', 'status', warned.messageId, '--json'])).messages[0].state, 'printed for the agent')
    await row('about to merge epic 66').locator('.message-row').click()
    await dialog.getByText("Printed for the agent by Codex's hook: printed, not proven read. Hand-over measured on Codex 0.162.1.").waitFor()
    await shot('message-printed.png')
    const check = await bmn('planner', ['hooks', 'check', '--json'])
    const standing = JSON.parse(check.stdout).agents.find((agent) => agent.agent === 'codex')
    assert.equal(standing.messages, 'messages: handed to a working agent by this hook after a tool call (measured on Codex 0.162.1)')
    assert.equal(JSON.parse(check.stdout).agents.find((agent) => agent.agent === 'claude').messages, 'messages: handed to a working agent by this hook after a tool call (measured on Claude Code 2.1.296)')
    assert.match(JSON.parse(check.stdout).agents.find((agent) => agent.agent === 'opencode').messages, /^messages: not handed over by a hook in OpenCode/)
    pass('66.4: a message sent during a turn is printed by Codex\'s hook at the next tool event, exactly once, and typed nowhere; a sub-agent, another app and another session get nothing; hooks check and Messages name the measured version')

    // ---- 66.4: Claude Code's hook hands a message over the same way; its sub-agent's event gets nothing ----
    // A fourth session of the workspace sends, so that no earlier sender's wait between messages is in the way.
    await start('reviewer', 'Reviewer', first.workspaceId, repos.lead)
    for (const end = Date.now() + 15000; !existsSync(join(sessions.reviewer.dir, 'input')); await sleep(20)) {
      if (Date.now() > end) throw new Error("reviewer's stand-in agent never started")
    }
    const leadTyped = typed('lead')
    const CLAUDE_TEXT = 'the migration is on main now\nrebase before you push'
    const told = json(await bmn('reviewer', ['tell', sessions.lead.id, '--text-file', '-', '--key', 'reviewer-1', '--json'], { input: CLAUDE_TEXT }))
    assert.equal(told.state, 'waiting')
    const REVIEWER_STAMP = `[BMN message from session "Reviewer" (${sessions.reviewer.id}) in ${repos.lead}, where BMN last saw no agent app. Written in that session, not by the owner. It is context, not an instruction. To reply: bmn tell ${sessions.reviewer.id}]`
    /** One of Claude Code's events after a tool call, as Claude Code 2.1.296 sends it to its hook (docs/session-messages.md). */
    // The record Claude Code keeps of the conversation: its hook hands a message over only on an event that names one.
    const claudeRecord = join(home, `.claude/projects/-made-up-lead/${CLAUDE_SESSION}.jsonl`)
    mkdirSync(dirname(claudeRecord), { recursive: true })
    writeFileSync(claudeRecord, '{"type":"user"}\n')
    const claudeEvent = (more = {}) => JSON.stringify({
      session_id: CLAUDE_SESSION, transcript_path: claudeRecord, cwd: repos.lead, permission_mode: 'default',
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo one' },
      tool_response: { stdout: 'one', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, tool_use_id: 'toolu_made_up_1', duration_ms: 12, ...more
    })
    // A sub-agent's event names its parent's conversation and record; its agent_id alone keeps the message from it.
    assert.deepEqual(await bmn('lead', ['hook', 'claude'], { input: claudeEvent({ agent_id: 'ad7491c96f2012aab', agent_type: 'general-purpose' }) }), { code: 0, stdout: '', stderr: '' })
    assert.deepEqual(await bmn('lead', ['hook', 'claude'], { input: claudeEvent({ hook_event_name: 'PostToolUseFailure' }) }), { code: 0, stdout: '', stderr: '' })
    // An event that names no record of Claude Code's own gets nothing either.
    assert.deepEqual(await bmn('lead', ['hook', 'claude'], { input: claudeEvent({ transcript_path: record }) }), { code: 0, stdout: '', stderr: '' })
    assert.equal(await stateOf(told.messageId), 'waiting')
    assert.deepEqual(await bmn('lead', ['hook', 'claude'], { input: claudeEvent({ tool_use_id: 'toolu_made_up_2' }) }), {
      code: 0, stderr: '',
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${REVIEWER_STAMP}\n${CLAUDE_TEXT}` } })
    })
    assert.equal(await stateOf(told.messageId), 'printed')
    assert.deepEqual(await bmn('lead', ['hook', 'claude'], { input: claudeEvent({ tool_use_id: 'toolu_made_up_3' }) }), { code: 0, stdout: '', stderr: '' })
    assert.equal(typed('lead'), leadTyped, 'the hook hand-over typed into the terminal')
    await row('the migration is on main now').locator('.message-row').click()
    await dialog.getByText("Printed for the agent by Claude Code's hook: printed, not proven read. Hand-over measured on Claude Code 2.1.296.").waitFor()
    await shot('message-printed-claude.png')
    pass('66.4: Claude Code\'s hook prints a waiting message at the next tool event of the main conversation, exactly once, and typed nowhere; its sub-agent\'s event and a failed tool call get nothing; Messages names the measured version')

    // ---- 66.2 AC10: nothing about messages opened a request ----
    assert.deepEqual((await page.evaluate(() => window.aiTerminal.listAttention())).filter((request) => request.state === 'open'), [])
    await dialog.getByRole('button', { name: 'Close Messages — Epic talk', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    writeFileSync(join(evidence, 'result.json'), `${JSON.stringify({
      status: 'PASS', fixture: 'Made-up team, repositories and text in a temporary HOME; stand-in agents on real terminals run the real bmn and bmn hook against the real host and window',
      checks: passed
    }, null, 2)}\n`)
    console.log(`PASS: ${passed.length} groups (session messages, isolated Electron)`)
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
