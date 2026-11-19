// MODULE: epic-actions-live.mjs - drive an owner-approved action and native binding under the isolated test profiles
/* global document, getComputedStyle, window */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { startFakeBotApi } from '../../apps/desktop/src/main/fake-bot-api.ts'
import { testedApp } from '../lib/tested-app.mjs'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { assertNativeTestEnvironment, assertNativeTestSignIn } from './native-test-home.mjs'
import { visibleScreen } from './away-skills-startup.mjs'
import { classifyMessageStartup, messageSocketGuidance, messageStartupStep } from './message-wake-startup.mjs'
import { processTree, stopTree } from './away-skills-processes.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tested = testedApp(join(repo, 'apps/desktop'))
const [agent, reportPath, handoff, scenario = 'binding'] = tested.rest
if (!['card', 'claude', 'codex'].includes(agent) || !reportPath || !['binding', 'argument', 'typed', 'submit', 'guard', 'lifecycle', 'policy', 'night'].includes(scenario)) {
  throw Error('Usage: native-test-home.mjs -- xvfb-run -a node scripts/test/epic-actions-live.mjs card|claude|codex REPORT [HANDOFF] [binding|argument|typed|submit|guard|lifecycle|policy|night] [--binary BMN]')
}
const native = assertNativeTestEnvironment(process.env)
if (agent !== 'card') assertNativeTestSignIn(agent)
const shortRoot = join(native.home, 'r')
mkdirSync(shortRoot, { recursive: true, mode: 0o700 })
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const report = { agent, build: tested.build, cliSha256: sha256(tested.cliPath), checks: [] }
function check(name, pass, detail) {
  report.checks.push({ name, result: pass ? 'PASS' : 'FAIL', ...(detail === undefined ? {} : { detail }) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  assert.ok(pass, name)
}
async function until(what, probe, timeout = 30_000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    const result = await probe()
    if (result) return result
    await sleep(300)
  }
  throw Error(`Timed out waiting for ${what}`)
}
function inventory(identity, add) {
  if (!handoff) return
  const line = `- ${JSON.stringify(identity)}\n`
  const prior = readFileSync(handoff, 'utf8')
  if (!prior.includes('## Started\n')) throw Error('Missing process inventory in handoff')
  const next = add ? prior.replace('## Started\n', `## Started\n\n${line}`) : prior.replace(line, '')
  assert.ok(next.length < 9000, 'Handoff exceeds the recovery limit')
  const temporary = handoff + `.${process.pid}.new`
  writeFileSync(temporary, next)
  renameSync(temporary, handoff)
  assert.equal(readFileSync(handoff, 'utf8'), next)
}
await withTemporaryRoot({ ...temporaryRootContracts.electronDevelopment, prefix: 'e' }, async ({ root, roots }) => {
  const environment = { ...process.env, BMN_LAUNCH_CWD: join(root, 'work'),
    XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
    XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
    BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
    BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn') }
  const fromOtherBmn = dir => {
    try { return readFileSync(join(dir, 'codex'), 'utf8').includes("Keep Codex's hooks in this BMN session") }
    catch { return false }
  }
  environment.PATH = environment.PATH.split(':').filter(dir => dir && !fromOtherBmn(dir)).join(':')
  assertNativeTestEnvironment(environment)
  const project = environment.BMN_LAUNCH_CWD
  const planRoot = join(project, 'plan')
  const bare = join(root, 'remote.git')
  const ghLog = join(root, 'synthetic-gh-writes')
  const head = 'a'.repeat(40)
  const merge = `gh pr merge 12 --repo sample/fixture --match-head-commit ${head} --merge`
  if (scenario === 'policy') {
    const bin = join(root, 'bin')
    mkdirSync(bin, { mode: 0o700 })
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/node
const fs = require('node:fs')
const args = process.argv.slice(2).join(' ')
const replies = {
  'repo view sample/fixture --json owner,defaultBranchRef,name,isFork,parent': { owner: { login: 'sample' }, name: 'fixture', defaultBranchRef: { name: 'main' }, isFork: false },
  'pr view 12 --repo sample/fixture --json headRefOid,state,files': { headRefOid: '${head}', state: 'OPEN', files: [{ path: 'README.md' }] },
  'pr checks 12 --repo sample/fixture --required --json bucket,state': [{ bucket: 'pass', state: 'SUCCESS' }]
}
if (Object.hasOwn(replies, args)) console.log(JSON.stringify(replies[args]))
else if (args === ${JSON.stringify(merge.slice(3))}) fs.appendFileSync(${JSON.stringify(ghLog)}, args + '\\n')
else process.exit(91)
`, { mode: 0o700 })
    environment.PATH = `${bin}:${environment.PATH}`
  }
  for (const dir of [project, planRoot, join(planRoot, 'epics'), join(planRoot, 'allowances')]) mkdirSync(dir, { recursive: true })
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { env: environment, encoding: 'utf8' }).trim()
  for (const dir of [project, planRoot]) {
    git(dir, 'init', '-qb', 'main')
    git(dir, 'config', 'user.name', 'Synthetic Fixture')
    git(dir, 'config', 'user.email', 'synthetic@example.invalid')
  }
  const exact = 'git push --force-with-lease origin feature/x'
  const phoneFixtures = agent === 'card'
    ? Array.from({ length: 45 }, (_, index) => `  - {id: long-${index}, kind: merge, repository: synthetic-fixture/repository-for-overflow-test, pr: ${index + 100}, headSha: ${'a'.repeat(40)}, changesCI: false, count: 1}`)
    : []
  const allowance = [
    'schema: 1', 'epic: 7', 'limits:', '  repair_rounds: {limit: 6, ceiling: 6, per: boundary}', 'actions:',
    `  - {id: push, kind: command, command: "${exact}", folder: "${project}", repository: "${bare}", ref: "feature/x", count: 1}`,
    '  - {id: merge, kind: merge, repository: sample/fixture, pr: 12, whenGreen: true, changesCI: false, count: 1}',
    ...phoneFixtures, ''
  ].join('\n')
  writeFileSync(join(project, '.gitignore'), '/plan/\n')
  git(project, 'add', '.gitignore')
  git(project, 'commit', '-qm', 'chore: synthetic checkout')
  git(root, 'init', '-qb', 'main', '--bare', bare)
  git(project, 'remote', 'add', 'origin', bare)
  git(project, 'push', '-q', 'origin', 'main')
  git(project, 'remote', 'set-head', 'origin', 'main')
  git(project, 'branch', 'feature/x')
  writeFileSync(join(planRoot, 'status.yaml'),
    'format: bmn-plan\nschema_version: 1\nqueue: []\nrules_from_challenges: 100\nrules_from_allowances: 7\ndevelopment_status:\n  epic-7: backlog\n  7-1-sample: backlog\n')
  writeFileSync(join(planRoot, 'PLAN.md'), ['Purpose', 'Users', 'Goals', 'Non-goals', 'Success signals', 'Standing constraints',
    'Architecture', 'Decisions', 'Truth documents'].map(section => `## ${section}\n\nSynthetic fixture.\n\n`).join(''))
  writeFileSync(join(planRoot, 'VISION.md'), '## Vision\n\nSynthetic fixture.\n\n## Principles\n\n1. Use only synthetic data.\n')
  writeFileSync(join(planRoot, 'epics/007-fixture.md'), [
    '# Epic 7: Synthetic', '## Outcome\n\nOne local action.', '## Why\n\n**Serves:** P1.',
    '## Boundary and dependencies\n\nOne test repository.', '## Truth impact\n\nSynthetic documents only.',
    '## Run needs\n\nSee plan/allowances/007.yaml.', '## Decisions\n\nSynthetic local actions.',
    '## Stories\n\n### Story 7.1: Sample\n\n**Owner:** none\n\n**Acceptance criteria:**\n\n1. **Given** this fixture, **when** approved, **then** show the count.\n\n**Verification:** Isolated Electron.\n'
  ].join('\n\n'))
  writeFileSync(join(planRoot, 'allowances/007.yaml'), allowance)
  git(planRoot, 'add', '-A')
  git(planRoot, 'commit', '-qm', 'docs: synthetic plan')
  const fixtureCheck = execFileSync(process.execPath, [tested.cliPath, 'plan', 'check', '--json'], {
    cwd: project, encoding: 'utf8', env: environment, timeout: 10_000
  })
  assert.equal(JSON.parse(fixtureCheck).ok, true, 'Synthetic plan validation')
  const socket = join(roots.runtime, 'bmn/control/control.sock')
  const bot = agent === 'card' ? await startFakeBotApi(424242, 424242) : null
  if (bot) environment.BMN_TEST_TELEGRAM_ORIGIN = bot.origin
  console.log('Launching isolated Electron')
  const bindCommand = 'bmn run bind --epic 7'
  const prompt = `Run \`${bindCommand}\` using Bash and show its output. ${messageSocketGuidance(agent, [bindCommand], 'sender')}`.trim()
  const initial = agent === 'claude'
    ? ['claude', '--model', 'haiku', '--allowedTools', `Bash(${bindCommand})`, `Bash(${exact})`]
    : agent === 'codex'
      ? ['codex', '--no-alt-screen', '-c', 'mcp_servers={}', '-c', `projects."${project}".trust_level="trusted"`,
        '-c', 'model_reasoning_effort="low"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"',
        '-c', 'sandbox_mode="workspace-write"']
      : ['/bin/bash', '--noprofile', '--norc']
  const starting = scenario === 'argument' ? ['/bin/bash', '--noprofile', '--norc'] : initial
  const live = await electron.launch({
    executablePath: tested.executablePath,
    chromiumSandbox: true,
    args: ['--ozone-platform=headless', '--disable-gpu', ...tested.appArgs, '--bmn-test-mode', '--', ...starting],
    cwd: project, env: environment, timeout: 30_000
  }).catch(async error => { await bot?.close(); throw error })
  const processIdentity = processTree(live.process().pid)[0]
  assert.ok(processIdentity, 'Missing isolated app process identity')
  const owned = { kind: 'process', pid: processIdentity.pid, start_ticks: processIdentity.start_ticks,
    command: `Isolated Epic 132 fixture ${agent}`, evidence: resolve(reportPath) }
  let recorded = false
  // What the native client and BMN's refusal log showed when the run ended, pass or fail (synthetic fixture text only).
  let lastLook = async () => {}
  try {
    // Inside the try: a refused inventory write must still stop the app it just launched.
    inventory(owned, true)
    recorded = true
    const page = await live.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForSelector('.session-row')
    await live.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(0, 0)
      if (window.isMaximized()) window.unmaximize()
      window.show()
      window.setContentSize(540, 860)
    })
    console.log('Window and terminal are ready')
    const commandsPath = join(dirname(tested.cliPath), 'bmn-commands.mjs')
    const { call, readCredentials } = await import(pathToFileURL(commandsPath))
    const owner = readCredentials({ owner: true, socket })
    const request = (method, params = {}) => call(owner.socketPath, owner.token, method, params)
    const cli = (...args) => {
      try {
        return JSON.parse(execFileSync(process.execPath, [tested.cliPath, ...args, '--json'], {
          cwd: project, encoding: 'utf8', timeout: 10_000,
          env: { ...environment, BMN_CONTROL_SOCKET: owner.socketPath, BMN_TOKEN: owner.token }
        }))
      } catch (error) {
        throw Error(`${args.join(' ')} failed: ${String(error.stdout || error.stderr || error.message).trim().slice(0, 3000)}`, { cause: error })
      }
    }
    if (bot) {
      await page.evaluate(async () => {
        const settings = await window.aiTerminal.getSettings()
        await window.aiTerminal.putSettings('telegram', { ...settings.telegram, enabled: true, allowedChatId: 424242, allowedUserId: null })
        await window.aiTerminal.configureTelegram('123456789:SELFTEST_fake_bot_token_not_real')
      })
      await until('synthetic Telegram connector', async () => (await page.evaluate(() => window.aiTerminal.getTelegramStatus())).state === 'polling')
    }
    if (agent === 'card') {
      git(project, 'config', 'remote.origin.push', 'refs/heads/feature/x:refs/heads/feature/y')
      try {
        assert.throws(() => cli('plan', 'actions', 'ask', '7'), /push configuration can affect more than the named target/u)
        check('An inherited destination from the repository push config is refused before owner approval', true)
      } finally {
        git(project, 'config', '--unset', 'remote.origin.push')
      }
    }
    // D3: with no deploy rule for the GitHub repository nothing reaches his card; he sets the rule in Health.
    const deployRule = async (events, repository = 'sample/fixture') => {
      const now = await page.evaluate(() => window.aiTerminal.getPushPolicy())
      assert.equal(now.state, 'read')
      await page.evaluate(change => window.aiTerminal.setPushPolicy(change),
        { kind: 'deploys', repository, events, expectedRevision: now.revision })
    }
    assert.throws(() => cli('plan', 'actions', 'ask', '7'), /no deploy rule for sample\/fixture/u)
    check('Without his deploy rule the GitHub action is refused by name before any card', true)
    await deployRule(['default-branch'])
    assert.throws(() => cli('plan', 'actions', 'ask', '7'), /a push to the default branch deploys; a deploy is never approved/u)
    check('An action his rule says deploys is refused before any card', true)
    await deployRule([])
    if (agent === 'card') await deployRule([], 'synthetic-fixture/repository-for-overflow-test')
    const asked = cli('plan', 'actions', 'ask', '7')
    const rejected = await request('epic.actions.answer', { card: asked.id, action: 'push', revision: 1, choice: 'yes' })
      .then(() => false, error => /only the owner/iu.test(error.message))
    check('Owner socket token cannot answer an action', rejected)
    const dialog = page.getByRole('dialog', { name: 'Actions for Epic 7' })
    try { await dialog.waitFor({ timeout: 6000 }) }
    catch (error) {
      report.dialogs = await page.evaluate(() => Array.from(document.querySelectorAll('dialog')).map(dialog => {
        const { width, height } = dialog.getBoundingClientRect()
        const { display, visibility, opacity } = getComputedStyle(dialog)
        return { name: dialog.getAttribute('aria-label'), width, height, display, visibility, opacity }
      }))
      throw error
    }
    const firstAction = dialog.locator('.grant-term').filter({ hasText: exact })
    const full = await firstAction.innerText()
    check('The owner sees the full exact command and target before the go', [exact, project, bare, 'feature/x'].every(part => full.includes(part)))
    let phoneMessage
    if (bot) {
      const sent = await until('fake phone card', () => bot.calls.find(call =>
        call.method === 'sendMessage' && String(call.body.text).includes('Actions for Epic 7')))
      phoneMessage = sent.messageId
      const text = String(sent.body.text)
      const buttons = sent.body.reply_markup.inline_keyboard.flat().map(button => button.text)
      check('Fake phone sees the exact same first action', [exact, project, bare, 'feature/x'].every(part => text.includes(part)))
      check('Overflow directs the owner to desktop without an incomplete approval button',
        text.includes('answer on desktop') && !buttons.includes('Yes · long-44') &&
        (await dialog.locator('.grant-term').last().innerText()).includes('PR #144'))
    }
    await firstAction.getByRole('radio', { name: 'Yes', exact: true }).click()
    await until('first answer', async () => (await firstAction.innerText()).includes('Approved'))
    const secondAction = dialog.locator('.grant-term').filter({ hasText: 'sample/fixture' }).first()
    check('The card shows each target\'s deploy rule: his Health rule, or the inspected local receiver',
      (await secondAction.innerText()).includes('Deploy rule: nothing deploys') && full.includes('Deploy rule: a local repository that runs no hook on a push'))
    if (bot) {
      bot.tapOn('Actions for Epic 7', [[{ tap: 'No · merge' }, { tap: 'Yes · long-0' }]], phoneMessage)
      const answers = () => bot.calls.filter(call => call.method === 'answerCallbackQuery').map(call => call.body.text)
      await until('one accepted and one stale Telegram answer', () =>
        answers().includes('Saved') && answers().some(text => String(text).includes('This card changed')))
      check('Fake phone saves its current answer and refuses a stale button from the same card revision',
        cli('plan', 'allowances', '7').actions[2].status === 'not asked')
    } else await secondAction.getByRole('radio', { name: scenario === 'policy' ? 'Yes' : 'No', exact: true }).click()
    const approveMerge = scenario === 'policy'
    await until('second answer', async () => (await secondAction.innerText()).includes(approveMerge ? 'Approved' : 'Declined'))
    const planStatus = cli('plan', 'status', '--epic', '7')
    const go = cli('plan', 'go', '7', '--expect', planStatus.rows[0].token, '--approved',
      `sha256:${planStatus.approval_texts[0].sha256}`, '--source', `Synthetic owner ${new Date().toISOString().slice(0, 16)}Z: "Go"`)
    const statuses = cli('plan', 'allowances', '7').actions
    check('The matching go activates the approved action without a second card',
      statuses[0].status === 'approved' && statuses[0].remaining === 1 && statuses[1].status === (approveMerge ? 'approved' : 'declined'))
    if (approveMerge) {
      // A rule changed after his Yes: the action is held and asks again; the receiver growing a hook holds the local one.
      await deployRule(['default-branch', 'pull-requests'])
      const held = cli('plan', 'allowances', '7').actions
      await deployRule([])
      const hook = join(bare, 'hooks', 'post-receive')
      writeFileSync(hook, '#!/bin/sh\n', { mode: 0o755 })
      const hooked = cli('plan', 'allowances', '7').actions
      rmSync(hook)
      const back = cli('plan', 'allowances', '7').actions
      check('A deploy rule changed after his Yes holds the action; a hook on the local receiver holds that one',
        held[1].status === 'not asked' && /deploys/u.test(held[1].held ?? '') && held[0].status === 'approved' &&
        hooked[0].status === 'not asked' && /runs a hook/u.test(hooked[0].held ?? '') &&
        back[0].status === 'approved' && back[1].status === 'approved', { held: held[1], hooked: hooked[0] })
    }
    if (agent === 'card') return
    await page.keyboard.press('Escape')
    await live.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860))
    const input = page.locator('.session-terminal.selected .xterm-helper-textarea')
    const palette = async (query, label) => {
      await page.getByRole('button', { name: 'Command palette' }).click()
      await page.getByRole('dialog', { name: 'Command palette' }).locator('input').fill(query)
      await page.getByText(label, { exact: true }).click()
    }
    const startSession = async (argv, name) => {
      const executable = environment.PATH.split(':').map(directory => resolve(directory, argv[0])).find(path => {
        try { accessSync(path, constants.X_OK); return true } catch { return false }
      })
      if (!executable) throw Error('The native test executable was not found')
      await palette('New session', 'New session…')
      const launcher = page.locator('.session-launcher')
      await launcher.getByRole('textbox', { name: 'Session name' }).fill(name)
      await launcher.getByRole('textbox', { name: 'Working directory' }).fill(project)
      await launcher.locator('summary').click()
      await launcher.getByRole('textbox', { name: 'Executable' }).fill(executable)
      await launcher.getByRole('textbox', { name: 'Arguments' }).fill(argv.slice(1).map(argument => JSON.stringify(argument)).join(' '))
      await launcher.getByRole('button', { name: 'Create session' }).click()
      const row = page.locator('.session-row').filter({ has: page.getByText(name, { exact: true }) })
      await row.waitFor()
      const id = await row.locator('button[data-session-id]').getAttribute('data-session-id')
      assert.ok(id, 'New session has no visible row identity')
      return id
    }
    if (scenario === 'argument') {
      const argv = agent === 'claude' ? [initial[0], prompt, ...initial.slice(1)] : [...initial, prompt]
      const invoked = await startSession(argv, 'Synthetic native binding')
      await page.locator(`.session-row button[data-session-id="${invoked}"]`).click()
      await page.locator(`.session-terminal.selected[data-session-id="${invoked}"]`).waitFor()
    }
    const sessionId = await page.locator('.session-terminal.selected').getAttribute('data-session-id')
    let selectedSession = sessionId
    const snapshot = () => page.evaluate(id => globalThis.__aitermTest.snapshot(id), selectedSession)
    // A stopped or resuming session has no terminal for a moment: that is an empty screen, not a failure.
    const terminal = () => snapshot().then(visibleScreen, error => {
      if (/snapshot unavailable/u.test(String(error?.message))) return []
      throw error
    })
    const holdsText = lines => lines.some(line => /^\s*❯\s/u.test(line) && line.includes(prompt))
    const type = async text => {
      await input.focus()
      await page.keyboard.type(text, { delay: scenario === 'typed' ? 40 : 0 })
      await sleep(1800)
      if (scenario === 'typed') {
        report.exactComposerBeforeEnter = holdsText(await terminal())
        check('Claude Code shows the entire synthetic prompt in its composer before Enter', report.exactComposerBeforeEnter)
      }
      const before = (await snapshot()).inputEvents
      await page.keyboard.press('Enter')
      await sleep(250)
      report.enterReachedTerminal = (await snapshot()).inputEvents > before
      await allowProviderHere()
      // BMN's prompt guard can ask for the prompt again ("Send it again"); Claude Code then puts it back in its composer.
      const start = text.slice(0, 40)
      for (let again = 0; agent === 'claude' && again < 3; again += 1) {
        await sleep(2500)
        if (!(await terminal()).some(line => /^\s*❯\s/u.test(line) && line.includes(start))) break
        await input.focus()
        await page.keyboard.press('Enter')
        report.promptResent = (report.promptResent ?? 0) + 1
      }
    }
    const hookEvents = () => page.evaluate(id => window.aiTerminal.listHookEvents(id), sessionId)
    const turnEnded = async (since, what) => until(what, async () => (await hookEvents()).some(event =>
      Date.parse(event.observedAt) >= since && (event.event === 'Stop' || event.event === 'StopFailure')), 120_000)
    // BMN's prompt guard holds a first prompt in a folder its provider may not see yet. In this isolated instance the
    // synthetic owner allows exactly this fixture folder for exactly this provider, then sends the held prompt again.
    let providerAllowed = false
    const allowProviderHere = async () => {
      if (providerAllowed) return
      const guard = page.getByRole('dialog', { name: 'Prompt guard', exact: true })
      for (const end = Date.now() + 8000; Date.now() < end && !await guard.isVisible();) await sleep(300)
      if (!await guard.isVisible()) return
      const providerName = agent === 'claude' ? 'Anthropic' : 'OpenAI'
      const folder = await guard.locator('.guard-facts dd[title]').first().getAttribute('title')
      const title = await guard.locator('h3').innerText()
      if (folder !== realpathSync(project) || !title.includes(providerName)) throw Error('The privacy card does not match the fixture folder and provider')
      await guard.getByRole('button', { name: 'Allow here', exact: true }).click()
      await until('provider approval card closed', async () => !await guard.isVisible())
      providerAllowed = true
      check('The isolated owner allows this provider for the fixture folder only', true, { provider: providerName, folder })
      await input.focus()
      if (agent === 'claude' && holdsText(await terminal())) await page.keyboard.press('Enter')
    }
    // A resumed conversation redraws its earlier prompts above the composer. Only for that wait, an earlier prompt line
    // that is not the composer's (one line between two rules) is read as history; the composer rules stay unchanged.
    const earlier = lines => {
      if (agent === 'codex') {
        // Codex redraws the conversation between its header and the live composer (the last "›" line); that history
        // (its own words, e.g. sandbox_permissions) is not a dialog. Header, composer and footer are read as before.
        const header = lines.findIndex(line => /^\s*[│|]?\s*>_ OpenAI Codex \(v/u.test(line))
        const composer = lines.findLastIndex(line => /^›(?:\s|$)/u.test(line))
        return header < 0 || composer <= header ? lines : lines.map((line, index) => index > header && index < composer ? '' : line)
      }
      const rule = line => /^─{20,}$/u.test(line ?? '')
      return lines.map((line, index) => agent === 'claude' && /^\s*❯\s*\S/u.test(line) && !(rule(lines[index - 1]) && rule(lines[index + 1]))
        ? `  (earlier prompt) ${line.replace(/^\s*❯\s*/u, '')}` : line)
    }
    const waitForComposer = async ({ resumed = false } = {}) => {
      const history = [], keys = { keys: 0 }
      let unclassifiedSince = null
      await until(`${agent} prompt`, async () => {
        const lines = resumed ? earlier(await terminal()) : await terminal()
        const screen = classifyMessageStartup(agent, lines, project)
        // What the last look saw, kept for a timeout's report.
        report.composerWait = { state: screen.state, detail: screen.detail ?? null, lines: lines.length, session: selectedSession,
          tail: lines.slice(-6).map(line => line.slice(0, 160)) }
        if (screen.state === 'composer') return true
        if (screen.state === 'dialog') {
          // The path arrives before the title on some frames. No key is sent without a complete, stable trust dialog.
          if (screen.detail?.startsWith('trust dialog')) {
            unclassifiedSince ??= Date.now()
            if (Date.now() - unclassifiedSince < 4000) return false
            report.trustShape = lines.filter(line => /trust|folder|workspace|enter|esc/iu.test(line) &&
              !/authenticat|key|sign in|log in/iu.test(line)).map(line => line.trim()).slice(-10)
          }
          throw Error(`Native startup requires owner action (${screen.detail ?? 'unknown dialog'})`)
        }
        unclassifiedSince = null
        if (screen.state === 'trust' || screen.state === 'trust-negative') {
          history.push({ ...screen, at: Date.now() })
          const action = messageStartupStep(history, keys)
          if (action.action === 'fail') throw Error(action.reason)
          if (action.action === 'key') {
            await input.focus()
            await page.keyboard.press(action.key)
            keys.keys++
            keys[action.mark] = true
            // Take the next snapshot after the native terminal has had time to redraw the exact trust dialog.
            await sleep(1700)
          }
        }
        return false
      }, 65_000)
    }
    await waitForComposer()
    check('Native client reaches its prompt in the isolated profile', true)
    const refusalFile = join(environment.BMN_STATE_HOME, 'refused-requests.log')
    const nativeRefusals = () => {
      try {
        return readFileSync(refusalFile, 'utf8').split('\n').flatMap(line => {
          const match = /\b(conversation\.observe|epic\.(?:run\.(?:observe|bind|reserve|dispatch)|guard\.claim)) refused for [^:]+: (.*)$/u.exec(line)
          return match ? [{ method: match[1], reason: match[2] }] : []
        }).slice(-8)
      } catch { return [] }
    }
    lastLook = async () => {
      report.screenTail = (await terminal()).map(line => line.trimEnd()).filter(Boolean).slice(-40)
      report.refusals = nativeRefusals()
    }
    if (scenario === 'submit') {
      const sent = await request('input.submit', { sessionId, text: prompt, submit: true, idempotencyKey: 'epic-132-native-proof-prompt' })
      check('BMN input delivery accepts one synthetic prompt for the selected native terminal', sent.ok === true)
    } else if (scenario !== 'argument') await type(prompt)
    let retriedEnter = false, retriedEscalation = false
    const promptAt = Date.now()
    const observation = await until('native binding or a visible refusal', async () => {
      const shown = (await terminal()).join('\n')
      const conversation = await page.evaluate(id => window.aiTerminal.getConversationBinding(id), sessionId)
      report.nativeLifecycle = { status: conversation.status, route: conversation.captureRoute }
      const events = await page.evaluate(id => window.aiTerminal.listHookEvents(id), sessionId)
      report.nativeEvents = events.map(event => ({
        name: event.event, tool: event.toolName, source: event.source,
        effects: event.effects, observedAt: event.observedAt
      }))
      report.refusals = nativeRefusals()
      // Synthetic fixture text only: what the native client showed when the wait ended.
      report.screenTail = shown.split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-30)
      report.nativeScreen = {
        promptEcho: shown.includes(prompt),
        composerHoldsPrompt: holdsText(shown.split('\n')),
        commandMentioned: shown.includes('bmn run bind --epic 7'),
        approvalWait: /Allow (this|once|always)|approval request|Esc to cancel/iu.test(shown),
        networkFault: /API Error|Reconnecting|failed to connect|stream disconnected|rate limit/iu.test(shown),
        noCredentials: /sign in|log in|unauthorized/iu.test(shown),
        refusedPath: /no credential|no control socket|not found|SandboxDenied/iu.test(shown),
        sandboxRefusal: /sandbox|approval reviewer|permission denied|operation not permitted/iu.test(shown)
      }
      if (scenario === 'typed' && !retriedEnter && Date.now() - promptAt > 4000 &&
        report.nativeScreen.composerHoldsPrompt && !events.some(event => event.event === 'UserPromptSubmit')) {
        retriedEnter = true
        report.retriedEnterWithExactEcho = true
        await input.focus()
        await page.keyboard.press('Enter')
      }
      // A low-effort Codex sometimes stops at BMN's own sandbox refusal without asking to escalate. As an owner would, the
      // harness asks once more with the same words; the report says it did. A second refusal stands.
      if (agent === 'codex' && !retriedEscalation && /A sandbox may be keeping this command from BMN/u.test(shown) &&
        /Worked for \d/u.test(shown)) {
        retriedEscalation = true
        report.retriedEscalationAfterSandboxRefusal = true
        await type(`Run \`bmn run bind --epic 7\` again using Bash, this time with sandbox_permissions=require_escalated and justification: synthetic BMN socket check. Honor any refusal.`)
        return false
      }
      const binding = (await request('epic.actions.status', { epic: 7, project })).binding
      if (binding?.sessionId === sessionId) return { outcome: 'bound', sessionId, go: binding.go }
      const refusal = report.refusals.findLast(entry => entry.method === 'epic.run.bind')
      if (refusal) return { outcome: 'native CLI refused the binding', reason: refusal.reason }
      if (/could not be confirmed|no current epic binding|outside this live session|live session and a go in force/iu.test(shown)) {
        return { outcome: 'native CLI refused the binding' }
      }
      return false
    }, 80_000)
    check('Real native caller binds its live conversation to the exact go',
      observation.outcome === 'bound' && observation.go === go.commit, observation)
    check('CLI displays the same live binding', cli('plan', 'allowances', '7').binding?.sessionId === sessionId)
    if (['binding', 'argument', 'typed', 'submit'].includes(scenario)) return
    if (scenario === 'policy') {
      const setting = await page.evaluate(() => window.aiTerminal.getPushPolicy())
      assert.equal(setting.state, 'read')
      await page.evaluate(change => window.aiTerminal.setPushPolicy(change),
        { kind: 'owner', login: 'sample', allowed: true, expectedRevision: setting.revision })
      assert.equal(cli('policy', '--repo', 'sample/fixture').repository.level, 'prs-only', 'The synthetic policy must start at PRs only')
      const action = receipt => `--action merge --use-id ${receipt} --command '${merge}'`
      const reserve = receipt => `bmn run reserve ${action(receipt)}`
      const dispatch = receipt => `bmn run dispatch ${action(receipt)}`
      const reads = 'bmn policy --repo sample/fixture --json'
      const writes = () => { try { return readFileSync(ghLog, 'utf8').trim().split('\n') } catch { return [] } }
      const a = reserve('fixture-one')
      const b = dispatch('fixture-one')
      const c = reserve('fixture-two')
      await type(`Run these Bash calls in order, one per tool call. ${[reads, reads, a, b, b, c].map(command => `\`${command}\``).join(', ')}. The repository is a local fake gh fixture. Call dispatch only after the matching reservation succeeds. ${messageSocketGuidance(agent, [reads, a, b, c], 'sender')}`)
      await until('native policy write and second reservation refusal', () => writes().length > 0 && nativeRefusals().some(entry =>
        entry.method === 'epic.run.reserve' && entry.reason.includes('The action has no uses left')), 145_000)
      check('At PRs only, the native client merges the approved PR once and the next use waits',
        writes().length === 1 && writes()[0] === merge.slice(3) &&
        cli('plan', 'allowances', '7').actions[1].remaining === 0 && cli('plan', 'allowances', '7').uses.length === 1)
      return
    }

    const gitPrompt = command => `Run exactly \`${command}\` once using Bash in the current folder and show its output. This is a synthetic repository and local bare test remote. ${agent === 'codex' ? 'Request sandbox_permissions=require_escalated on the first attempt, with justification: synthetic local fixture only. Honor any refusal.' : ''}`.trim()
    const bareRef = () => {
      try { return git(bare, 'rev-parse', '--verify', 'refs/heads/feature/x') } catch { return null }
    }
    if (scenario === 'night') {
      const where = join(roots.state, 'dev-auto', 'budgets')
      mkdirSync(where, { recursive: true })
      writeFileSync(join(where, '0123456789abcdef-epic-7.json'), JSON.stringify({ plan_root: planRoot,
        rounds: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`round-${index}`, { answer: 'TAKEN', boundary: '7.1' }])) }))
      const runId = 'fixture-epic-7'
      const proposal = { title: 'Synthetic Epic 7 night', scope: 'The local ref and an optional round', terms: [
        { kind: 'rounds', proposed: 2, reason: 'Synthetic local fixture extra rounds' },
        { id: 'night-push', kind: 'command', command: exact, folder: project, repository: bare, ref: 'feature/x',
          count: 1, proposed: 'yes', reason: 'Synthetic local fixture exact force-with-lease' }
      ] }
      writeFileSync(join(project, 'night.json'), JSON.stringify(proposal))
      // The card is read from standard input; that is the command's only form.
      const ask = `bmn grant ask --run ${runId} --card-file - < night.json`
      // The instruction first, the leaving signal after its turn ended: BMN's own getting-ready line then starts the ask.
      const seeded = Date.now()
      await type(`This is a synthetic test. The push described in night.json is unfinished authorised work in this folder. When BMN's getting-ready line arrives, use Bash to run exactly \`${ask}\` once and nothing else; do not answer --nothing. ${messageSocketGuidance(agent, [ask], 'sender')}For now use no tools; reply READY.`)
      await turnEnded(seeded, 'the night instruction turn to end')
      await request('away.set', { to: 'leaving' })
      const departure = page.locator('dialog.before-you-go-dialog')
      const card = departure.locator(`article.grant-card[data-run-id="${runId}"]`)
      await card.waitFor({ timeout: 80_000 })
      const words = await card.innerText()
      check('Night card shows the exact held target and six base, eight total, four remaining rounds',
        [exact, bare, project, '6 base', '8 total', '4 remaining'].every(word => words.includes(word)))
      const answer = await page.evaluate(async id => {
        const view = await window.aiTerminal.getGrant()
        const current = view.period.runs.find(run => run.runId === id)
        return window.aiTerminal.answerGrant({ periodId: view.period.periodId, runId: id, cardRevision: current.card.revision,
          choices: { rounds: 2, 'night-push': 'yes' }, operationKey: '132-synthetic-night', expectedRevision: view.revision })
      }, runId)
      check('The isolated window approves those exact night terms', answer.outcome === 'granted')
      await departure.locator('.grant-footer .grant-go').click()
      await departure.waitFor({ state: 'hidden' })
      const reserve = `bmn grant use --run ${runId} --item night-push --use-id synthetic-night-use`
      await type(`Use two Bash calls. First run exactly \`${reserve}\`. ${messageSocketGuidance(agent, [reserve], 'sender')}Only if the reservation succeeded, ${gitPrompt(exact)}`)
      const use = await until('night reserve and native hook claim on the local bare ref', () => {
        const { uses } = cli('plan', 'allowances', '7')
        return bareRef() === git(project, 'rev-parse', 'feature/x') && uses?.length === 1 ? uses[0] : false
      }, 90_000)
      const view = await page.evaluate(() => window.aiTerminal.getGrant())
      const uses = view.period.uses.filter(item => item.runId === runId && item.item === 'night-push')
      check('The reserved night action and native write share one receipt',
        use.source === 'night' && uses.length === 1 && uses[0].id === 'synthetic-night-use' && uses[0].dispatch?.call != null,
        { audit: use, grantUses: uses })
      await request('away.set', { to: 'back' })
      const limits = cli('plan', 'allowances', '7')
      check('On Back the base allowance remains six and the night period closes',
        limits.current.fields.limits.repair_rounds.limit === 6 && (await page.evaluate(() => window.aiTerminal.getAway())).state === 'back')
      return
    }
    if (scenario === 'guard') {
      check('Synthetic remote has no feature branch before the approved command', bareRef() === null)
      await type(gitPrompt(exact))
      const use = await until('approved force-with-lease updates the local bare ref', () => {
        const { uses } = cli('plan', 'allowances', '7')
        return bareRef() === git(project, 'rev-parse', 'feature/x') && uses?.length === 1 ? uses[0] : false
      }, 80_000)
      check('The approved native hook passes one exact write and records its session and hash',
        use.sessionId === sessionId && use.commandHash === createHash('sha256').update(exact).digest('hex'), use)
      const firstRef = bareRef()
      git(project, 'commit', '--allow-empty', '-qm', 'chore: synthetic second commit')
      git(project, 'branch', '-f', 'feature/x', 'HEAD')
      await type(gitPrompt(exact))
      await until('the second exact native call is held for a spent count', async () =>
        nativeRefusals().some(entry => entry.method === 'epic.guard.claim' && entry.reason.includes('The action has no uses left')), 80_000)
      check('A second exact call stays held without updating the synthetic remote or taking a receipt',
        bareRef() === firstRef && cli('plan', 'allowances', '7').uses.length === 1)

      return
    }

    const other = await startSession(initial, 'Synthetic competing session')
    const select = async id => {
      await page.locator(`.session-row button[data-session-id="${id}"]`).click()
      selectedSession = id
      await page.locator(`.session-terminal.selected[data-session-id="${id}"]`).waitFor()
    }
    await select(other)
    await waitForComposer()
    await type(prompt)
    await until('second native session refused binding', () => nativeRefusals().some(entry => entry.method === 'epic.run.bind' &&
      entry.reason.includes('already has a live bound session')), 80_000)
    check('A competing native session in the same folder cannot take the binding',
      cli('plan', 'allowances', '7').binding?.sessionId === sessionId)
    await type(gitPrompt(exact))
    await until('the competing native session is held', () => nativeRefusals().some(entry =>
      entry.method === 'epic.guard.claim' && entry.reason.includes('This session has no current epic binding')), 80_000)
    check('The competing session cannot use the approved held command',
      bareRef() === null && (cli('plan', 'allowances', '7').uses ?? []).length === 0)

    await select(sessionId)
    await palette('Stop session', 'Stop session…')
    await page.getByRole('dialog', { name: 'Stop session' }).getByRole('button', { name: 'Stop session', exact: true }).click()
    await until('stopped process loses its binding', () => !cli('plan', 'allowances', '7').binding)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.getByRole('dialog', { name: 'Resume conversation' }).getByRole('button', { name: 'Resume', exact: true }).click()
    await waitForComposer({ resumed: true })
    check('The same native conversation resumes with no active binding', !cli('plan', 'allowances', '7').binding)
    await type(prompt)
    await until('resumed native session rebinds', () => cli('plan', 'allowances', '7').binding?.sessionId === sessionId, 80_000)
    await palette('Epic actions', 'Epic actions…')
    await dialog.getByRole('button', { name: 'Unbind', exact: true }).click()
    await until('owner unbind removes the binding', () => !cli('plan', 'allowances', '7').binding)
    await page.keyboard.press('Escape')
    await type(prompt)
    await until('same conversation is refused after owner Unbind', () => nativeRefusals().some(entry =>
      entry.method === 'epic.run.bind' && entry.reason.includes('The owner unbound this conversation')), 80_000)
    check('The owner can unbind in the window and that native conversation cannot rebind',
      !cli('plan', 'allowances', '7').binding)
  } finally {
    await lastLook().catch(() => undefined)
    const identities = processTree(owned.pid)
    await Promise.race([live.close().catch(() => undefined), sleep(8000)])
    const cleanup = await stopTree(identities, { graceMs: 600, afterKillMs: 2000, wait: sleep })
    await bot?.close()
    check('Isolated Electron process tree stopped', cleanup.remaining.length === 0, cleanup)
    if (recorded) inventory(owned, false)
  }
}, shortRoot).catch(error => {
  report.error = error.message
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.error(report.error)
  process.exitCode = 1
})
