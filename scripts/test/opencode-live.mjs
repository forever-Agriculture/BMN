/* global window */
// MODULE: opencode-live.mjs - the installed OpenCode CLI, BMN's shipped plugin and a paid model, driven in an isolated BMN
// Run after build: node scripts/test/opencode-live.mjs [--model opencode-go/gpt-6-luna] [--show]
// It spends a few cents of the owner's OpenCode allowance. OpenCode gets disposable XDG folders, so the
// owner's rules, history and settings are never read; the launcher reads the key from OpenCode's own
// auth.json when the session starts and hands it over in the environment, never writing or printing it.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const flag = (name) => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1] }
const model = flag('--model') ?? 'opencode-go/gpt-6-luna'
const show = process.argv.includes('--show')
const openCode = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const authFile = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/auth.json')
const provider = model.split('/')[0]
if (!existsSync(openCode)) throw new Error(`UNVERIFIED: no OpenCode at ${openCode}`)
if (typeof JSON.parse(readFileSync(authFile, 'utf8'))[provider]?.key !== 'string') {
  throw new Error(`UNVERIFIED: OpenCode's auth.json holds no key for ${provider}`)
}
const version = execFileSync(openCode, ['--version'], { encoding: 'utf8' }).trim()
const evidence = process.env.BMN_OPENCODE_LIVE_EVIDENCE ?? join(repo, '.dev-auto/evidence/opencode-live', version)
mkdirSync(evidence, { recursive: true })

const results = []
const record = (name, verdict, detail = '') => {
  results.push({ name, verdict, detail })
  console.log(`${verdict.padEnd(5)} ${name}${detail ? `  ${detail}` : ''}`)
}
const check = (name, ok, detail) => record(name, ok ? 'PASS' : 'FAIL', detail)
const sleep = (ms) => new Promise(done => setTimeout(done, ms))
/** Polls until the probe answers something truthy; null when the time runs out. */
const until = async (probe, timeout) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(500)
  }
}

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const project = join(root, 'project'), bin = join(root, 'bin'), launcher = join(bin, 'opencode')
  mkdirSync(project); mkdirSync(bin); mkdirSync(join(roots.config, 'opencode'), { recursive: true })
  writeFileSync(join(project, 'README.md'), 'BMN live check\n')
  writeFileSync(join(roots.config, 'opencode/opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json', model, small_model: model, autoupdate: false, share: 'disabled',
    permission: { bash: 'ask' }
  }, null, 2))
  const disposable = { XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache }
  const readKey = 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].key)'
  writeFileSync(launcher, ['#!/bin/bash',
    ...Object.entries(disposable).map(([name, value]) => `export ${name}=${JSON.stringify(value)}`),
    'export OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_AUTOUPDATE=1',
    `OPENCODE_API_KEY="$(${JSON.stringify(process.execPath)} -e '${readKey}' ${JSON.stringify(authFile)} ${JSON.stringify(provider)})" || exit 97`,
    'export OPENCODE_API_KEY', `exec ${JSON.stringify(openCode)} "$@"`, ''].join('\n'))
  chmodSync(launcher, 0o700)

  const env = { ...process.env }
  if (env.WAYLAND_DISPLAY && !isAbsolute(env.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY)
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID', 'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT']) delete env[key]
  const cli = (args, extra = {}) => execFileSync(process.execPath, [join(repo, 'apps/desktop/bin/bmn'), ...args],
    { env: { ...env, ...disposable, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  cli(['hooks', 'install', 'opencode', '--yes'])
  const hooks = cli(['hooks', 'check', 'opencode'])
  writeFileSync(join(evidence, 'hooks-check.txt'), hooks)
  check('plugin installed by bmn hooks install', /plugin\s+wired\s*$/m.test(hooks), hooks.split('\n').find(line => line.includes('plugin'))?.trim())

  const display = show ? (!env.WAYLAND_DISPLAY && env.DISPLAY ? ['--ozone-platform=x11'] : []) : ['--ozone-platform=headless']
  const app = await _electron.launch({ executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...display, '--bmn-test-mode'],
    env: { ...env, ...disposable, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: root } })
  let page = null, sid = null
  const bridge = (method, ...args) => page.evaluate(([name, rest]) => window.aiTerminal[name](...rest), [method, args])
  const screen = async () => (await page.evaluate(id => window.__aitermTest.snapshot(id).bufferLines, sid)).map(line => line.trimEnd())
  const dump = async (name) => { const lines = await screen(); writeFileSync(join(evidence, `screen-${name}.txt`), lines.join('\n') + '\n'); return lines }
  // BMN lists a session's latest events only, and OpenCode sends bursts (28 plugin.added at start), so every name ever listed is kept.
  const everSeen = new Set()
  const events = async () => { const names = (await bridge('listHookEvents', sid)).map(row => row.event); for (const name of names) everSeen.add(name); return names }
  const requests = async () => (await bridge('listAttention')).filter(row => row.sessionId === sid)
  const opened = (kind, mark) => until(async () => (await requests()).find(row => row.state === 'open' && row.kind === kind &&
    (mark === undefined || mark(row))) ?? null, 120000)
  const closed = (requestId) => until(async () => (await requests()).find(row => row.requestId === requestId && row.state !== 'open') ?? null, 30000)
  const seen = (event) => until(async () => { await events(); return everSeen.has(event) }, 30000)
  const watch = setInterval(() => { if (page && sid) events().catch(() => {}) }, 250)
  // A turn has ended when BMN opens a finished-turn notice that was not there before the prompt.
  const notices = async () => new Set((await requests()).filter(row => row.kind === 'notice').map(row => row.requestId))
  const turnEnded = (before) => until(async () => (await requests()).find(row => row.kind === 'notice' && !before.has(row.requestId)) ?? null, 120000)
  const say = async (text) => {
    const before = await notices()
    await page.locator('.terminal-surface:visible').first().click()
    await page.keyboard.type(text)
    await sleep(300)
    await page.keyboard.press('Enter')
    return before
  }
  const stop = async () => { await page?.evaluate(async () => { for (const ws of await window.aiTerminal.listWorkspaces(true)) {
    for (const s of await window.aiTerminal.listSessions(ws.workspaceId)) await window.aiTerminal.stopSession(s.sessionId).catch(() => {})
  } }).catch(() => {}) }
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(20000); await page.waitForSelector('.shell-window')
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(0, 0); w.setContentSize(1280, 900); w.show() })
    const workspace = (await bridge('listWorkspaces'))[0]
    const created = await bridge('createSession', { workspaceId: workspace.workspaceId, name: 'OpenCode live', cwd: project,
      executable: launcher, argv: [], cols: 120, rows: 40 })
    sid = created.session.sessionId
    await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
    const drawn = await until(async () => (await screen()).filter(line => line.trim()).length >= 3, 90000)
    await sleep(3000)
    const start = await dump('start')
    check('OpenCode starts in a BMN session', Boolean(drawn), start.find(line => line.trim())?.trim().slice(0, 80))

    // 1. A permission ask, answered in OpenCode itself.
    let before = await say('Run this exact shell command with the bash tool, then reply with the single word done: echo bmn-live-one')
    const permission = await opened('permission')
    await dump('permission')
    check('permission.asked opens a permission request', Boolean(permission), permission ? permission.title : (await events()).join(' '))
    check('the request carries the exact command', JSON.stringify(permission ?? '').includes('echo bmn-live-one'))
    const binding = await bridge('getConversationBinding', sid)
    check('the conversation is captured for Resume', binding.status === 'bound' && binding.agentCli === 'opencode',
      `${binding.status} ${binding.agentCli ?? ''} ${binding.captureRoute ?? ''} ${String(binding.conversationReference ?? '').slice(0, 8)}…`)
    if (permission) {
      await page.keyboard.press('Enter')
      const answered = await closed(permission.requestId)
      check('permission.replied closes that request', Boolean(answered) && await seen('permission.replied'),
        answered ? `${answered.state} ${answered.resolution ?? ''} by ${answered.resolvedBy ?? '?'}` : 'still open')
    }
    const notice = await turnEnded(before)
    check('the turn ends with session.idle', Boolean(notice) && Boolean(await seen('session.idle')))
    check('a finished-turn notice opens', Boolean(notice), notice?.title)
    const origin = (await bridge('listHookOrigins')).find(row => row.sessionId === sid)
    check('the model is reported', Boolean(origin?.model) && model.endsWith(origin.model), origin ? `${origin.model} ${origin.apiHost ?? 'no host'} ${origin.country ?? 'no country'}` : 'none')
    await dump('after-permission')

    // 2. A question, answered in OpenCode itself.
    before = await say('Call the question tool once with the question "Pick a color" and exactly two options, Red and Blue. After I answer, reply with the picked color only.')
    const question = await opened('question')
    await dump('question')
    check('question.asked opens a question request', Boolean(question), question ? question.title : (await events()).slice(-6).join(' '))
    const labels = JSON.stringify(question?.prompt ?? '')
    check('the request carries both options', labels.includes('Red') && labels.includes('Blue'))
    if (question) {
      await page.keyboard.press('Enter')
      let answered = await until(async () => (await requests()).find(row => row.requestId === question.requestId && row.state !== 'open') ?? null, 6000)
      if (!answered) { await page.keyboard.press('Enter'); answered = await closed(question.requestId) }
      check('question.replied closes that request', Boolean(answered) && await seen('question.replied'),
        answered ? `${answered.state} ${answered.resolution ?? ''}` : 'still open')
    }
    check('the question turn ends', Boolean(await turnEnded(before)))
    await dump('after-question')

    // 3. A permission ask from a subagent.
    before = await say('Use the task tool to start one general subagent with this instruction: "Run the shell command echo bmn-live-sub with the bash tool and report its output." Then reply with the single word done.')
    const sub = await opened('permission', row => JSON.stringify(row).includes('bmn-live-sub'))
    await dump('subagent')
    check('a subagent permission opens its own request', Boolean(sub) && sub.requestKey.includes('subagent'), sub ? sub.requestKey : (await events()).slice(-8).join(' '))
    if (sub) {
      await page.keyboard.press('Enter')
      const answered = await closed(sub.requestId)
      check('the subagent request closes when answered', Boolean(answered), answered ? `${answered.state} ${answered.resolution ?? ''}` : 'still open')
    }
    check('the subagent turn ends', Boolean(await turnEnded(before)))
    await dump('after-subagent')

    // 4. Stop, then Resume through BMN.
    const reference = (await bridge('getConversationBinding', sid)).conversationReference
    await bridge('stopSession', sid)
    await until(async () => (await bridge('listSessions', workspace.workspaceId)).find(row => row.sessionId === sid)?.lastProcess?.state !== 'live', 20000)
    const preview = await bridge('previewConversationResume', sid)
    writeFileSync(join(evidence, 'resume-preview.json'), JSON.stringify(preview, null, 2).replaceAll(root, '<root>'))
    const command = JSON.stringify(preview)
    check('Resume offers opencode --session with the captured id', command.includes('--session') && command.includes(reference), command.replaceAll(root, '<root>').slice(0, 160))
    // Resume as the owner does: the session's Resume button, then the dialog that shows the exact command. The
    // bridge call alone starts the process but leaves this window showing the ended one.
    // BMN offers it on a stopped session once it is opened again, so the window is reloaded as after a restart.
    await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
    await page.screenshot({ path: join(evidence, 'stopped.png') }).catch(() => {})
    await page.locator('.actions button.primary', { hasText: 'Resume' }).first().click()
    await page.locator('.dialog-actions button.primary', { hasText: 'Resume' }).click()
    // The banner OpenCode prints when it stops carries the session's title, so the conversation counts only inside OpenCode's own screen.
    const conversation = async () => { const lines = await screen().catch(() => []); return lines.some(line => line.includes('┃')) && lines.some(line => /bmn-live-(one|sub)|Pick a color/.test(line)) }
    const back = await until(conversation, 45000)
    await dump('resumed'); await page.screenshot({ path: join(evidence, 'resumed.png') }).catch(() => {})
    const last = (await bridge('listSessions', workspace.workspaceId)).find(row => row.sessionId === sid)?.lastProcess
    check('the resumed session shows the earlier conversation', Boolean(back), `process ${JSON.stringify(last ?? null).replaceAll(root, '<root>').slice(0, 200)}`)
    if (!back) {
      await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
      const after = await until(conversation, 30000)
      await dump('resumed-after-reload'); await page.screenshot({ path: join(evidence, 'resumed-after-reload.png') }).catch(() => {})
      check('after reloading the window the resumed conversation is shown', Boolean(after))
    }
    await bridge('stopSession', sid)
    await sleep(1500)

    // 5. Deleting an old session, as history cleanup does.
    const openCodeRun = (args) => { try { return { code: 0, out: execFileSync(launcher, args, { env, cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }) } }
      catch (error) { return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } } }
    const removed = openCodeRun(['session', 'delete', reference, '--pure'])
    const left = openCodeRun(['session', 'list'])
    check('opencode session delete <id> --pure removes the session', removed.code === 0 && !left.out.includes(reference), `rc ${removed.code}`)

    writeFileSync(join(evidence, 'event-names.json'), JSON.stringify([...everSeen].sort(), null, 2))
    const all = await bridge('listHookEvents', sid, true)
    writeFileSync(join(evidence, 'hook-events.json'), JSON.stringify(all, null, 2))
    writeFileSync(join(evidence, 'requests.json'), JSON.stringify(await requests(), null, 2).replaceAll(root, '<root>'))
  } catch (error) {
    record('run completed', 'FAIL', String(error?.message ?? error).split('\n')[0])
    if (page && sid) await dump('failure').catch(() => {})
    await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
  } finally {
    clearInterval(watch)
    await stop()
    await app.close().catch(() => {})
  }
})

const failed = results.filter(row => row.verdict === 'FAIL')
writeFileSync(join(evidence, 'result.json'), JSON.stringify({ openCode: version, model, checkedAt: new Date().toISOString(), results }, null, 2))
console.log(`OpenCode ${version} live in BMN: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} of ${results.length})`}`)
process.exit(failed.length === 0 ? 0 : 1)
