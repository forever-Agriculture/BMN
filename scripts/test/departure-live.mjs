// MODULE: departure-live.mjs - Epic 130's fixed departure line on real, isolated Claude Code and Codex prompts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { withTemporaryRoot, temporaryRootContracts } from '../lib/temporary-root.mjs'
import { assertNativeTestEnvironment, assertNativeTestSignIn } from './native-test-home.mjs'
import { processTree, stopTree } from './away-skills-processes.mjs'
import { classifyMessageStartup, messageStartupStep, messageSocketGuidance } from './message-wake-startup.mjs'
import { visibleScreen } from './away-skills-startup.mjs'
import { seedNativeNight } from './night-grant-fixture.mjs'
const DEPARTURE_LINE = readFileSync(new URL('../../shared/protocol/src/departure.ts', import.meta.url), 'utf8').match(/DEPARTURE_LINE = '([^']+)'/u)[1]

const sleep = ms => new Promise(done => setTimeout(done, ms))
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'"
const until = async (read, what, ms = 90_000, intervalMs = 500) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const remaining = deadline - Date.now(); let timer
    const result = await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out reading: ${what}`)), remaining) })]).finally(() => clearTimeout(timer))
    if (result) return result; await sleep(intervalMs) }
  throw Error(`Timed out: ${what}`)
}

export async function departureLive({ tested, args, recordProcess, caller: sanitizedCaller }) {
  const scratchRoot = args[0], reportPath = args[1]
  const nightAt = args.indexOf('--night-composer')
  const nightComposer = nightAt < 0 ? null : resolve(args[nightAt + 1] ?? '')
  if (!scratchRoot || !reportPath) throw Error('departure cases need a synthetic scratch folder and report path')
  const at = args.indexOf('--count')
  const count = at < 0 ? 10 : Number(args[at + 1])
  if (!Number.isInteger(count) || count < 1 || count > 10) throw Error('--count is 1 through 10')
  const apps = (args[2] ?? 'claude,codex').split(',')
  if (apps.some(app => !['claude', 'codex'].includes(app))) throw Error('Only Claude Code and Codex are selected')
  const scenarioAt = args.indexOf('--proof-case')
  const scenario = scenarioAt < 0 ? null : args[scenarioAt + 1]
  if (scenario !== null && (count !== 1 || (scenario === 'resumed' ? apps.join(',') !== 'codex' : !['draft', 'input', 'control', 'restart'].includes(scenario) || apps.join(',') !== 'claude'))) throw Error('--proof-case needs one Claude draft/input/control/restart or one Codex resumed case; startup dialogs still require the owner')
  const restoring = scenario === 'restart' || scenario === 'resumed'
  const home = assertNativeTestEnvironment(process.env)
  for (const app of apps) assertNativeTestSignIn(app)
  if (nightComposer && (count > 3 || scenario !== null || !args.includes('--private-display') ||
    !/^\/var\/tmp\/bmn-native-tests\/epic131-night-[a-z0-9-]+$/u.test(scratchRoot))) {
    throw Error('Epic 131 uses up to three cases per app on the run-owned private display and synthetic workspace')
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 })
  const allowTestProviders = args.includes('--allow-test-providers')
  const approvedRoot = nightComposer ? scratchRoot : join(home.home, 'epic130-native-m2')
  if ((nightComposer || allowTestProviders) && (realpathSync(scratchRoot) !== resolve(scratchRoot) ||
    !(resolve(scratchRoot) === approvedRoot || resolve(scratchRoot).startsWith(`${approvedRoot}/`)))) throw Error('Provider approval is limited to the owner-approved synthetic workspace')
  const shotName = suffix => join(dirname(reportPath), `${basename(reportPath, '.json')}-${suffix}.png`)
  const base = join(home.home, 'r'); mkdirSync(base, { recursive: true, mode: 0o700 })
  const report = { generatedAt: new Date().toISOString(), build: tested.build, count, cases: [], checks: [] }
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  const check = (name, ok, detail = {}) => { report.checks.push({ name, result: ok ? 'PASS' : 'FAIL', ...detail }); save(); console.error(`[departure] ${ok ? 'PASS' : 'FAIL'} ${name}`) }
  const caller = sanitizedCaller
  const privateDisplay = args.includes('--private-display')
  if (privateDisplay) {
    const display = process.env.DISPLAY
    const authority = process.env.XAUTHORITY
    if (!/^:\d+$/.test(display ?? '') || !authority?.startsWith('/tmp/xvfb-run.')) throw Error('A native private-display case requires its run-owned xvfb-run server')
    const auth = lstatSync(authority)
    if (!auth.isFile() || auth.isSymbolicLink() || realpathSync(authority) !== authority || auth.uid !== process.getuid() || (auth.mode & 0o077) !== 0) throw Error('The private display authority is not a private run-owned file')
    const serverPid = Number(readFileSync(`/tmp/.X${display.slice(1)}-lock`, 'utf8').trim())
    const server = processTree(serverPid)[0]
    const ancestors = new Set()
    for (let pid = process.pid; pid > 1 && !ancestors.has(pid);) {
      ancestors.add(pid)
      pid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 1).trim().split(/\s+/)[1])
    }
    if (server?.comm !== 'Xvfb' || !ancestors.has(server.ppid)) throw Error('The private display server is not owned by this native job')
    report.display = { display, server, privateAuthority: true, method: 'Fable M2 whole case on private X11/Xvfb; no third M1 headless patch' }
    recordProcess({ kind: 'process', pid: server.pid, start_ticks: server.start_ticks, command: 'Epic130 private Xvfb; xvfb-run owns shutdown', evidence: reportPath }, true)
    save()
  }
  if (args.includes('--display-preflight')) {
    if (!privateDisplay) throw Error('Display preflight requires the private display mode')
    check('private display ownership qualified without launching BMN or a native model', true, report.display)
    report.result = 'PASS'; save(); return 0
  }
  // Keep the socket below the kernel's 108-byte path limit, still under the guarded test home.
  const contract = { ...temporaryRootContracts.electronDevelopment, prefix: 'd' }
  for (const app of apps) {
    for (let index = 0; index < count; index++) {
      const scratch = nightComposer ? join(scratchRoot, `${app}-${index + 1}`) : scratchRoot
      const result = { app, index: index + 1, mode: scenario ?? 'resting', selectedAt: null, toldAt: null, answeredAt: null, delivered: false, answered: false }
      report.cases.push(result); save()
      const stage = name => { result.stage = name; save(); console.error(`[departure] ${app} ${index + 1}: ${name}`) }
      try {
        await withTemporaryRoot(contract, async ({ roots }) => {
          const hostWrites = join(roots.state, 'departure-host-writes.jsonl')
          const barrierDirectory = join(roots.state, 'bmn', 'departure-proof-test')
          const environment = { ...caller, SHELL: '/bin/bash',
            BMN_TEST_HOST_WRITES: hostWrites,
            ...(scenario === 'input' || scenario === 'control' ? { BMN_TEST_DEPARTURE_BARRIER: '1' } : {}),
            XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
            BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn') }
          assertNativeTestEnvironment(environment)
          const night = nightComposer ? seedNativeNight(scratch, tested, environment, nightComposer) : null
          const socket = join(environment.BMN_RUNTIME_HOME, 'control/control.sock')
          const bmn = (...argv) => execFileSync(process.execPath, [tested.cliPath, '--owner', '--socket', socket, ...argv], { encoding: 'utf8', env: environment, cwd: scratch })
          stage('launching isolated BMN')
          let application = await electron.launch({ chromiumSandbox: true, executablePath: tested.executablePath,
            args: [privateDisplay ? '--ozone-platform=x11' : '--ozone-platform=headless', '--disable-gpu', ...tested.appArgs, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'], cwd: scratch, env: environment })
          let identity = processTree(application.process().pid)[0]
          if (!identity) throw Error('No isolated process identity')
          let owned = { kind: 'process', pid: identity.pid, start_ticks: identity.start_ticks, command: `130 ${app} departure ${index + 1}`, evidence: reportPath }
          try {
            recordProcess(owned, true)
            let page = await application.firstWindow(); page.setDefaultTimeout(15_000)
            await page.waitForSelector('.session-row', { timeout: 60_000 })
            await application.evaluate(({ BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows()[0]
              window.setMinimumSize(0, 0)
              if (window.isMaximized()) window.unmaximize()
              window.show(); window.setContentSize(1280, 860)
            })
            await until(async () => page.locator('.session-terminal.selected').evaluate(node => {
              const bounds = node.getBoundingClientRect()
              return bounds.width >= 640 && bounds.height >= 400
            }), 'usable native terminal viewport', 10_000)
            let input = page.locator('.session-terminal.selected .xterm-helper-textarea')
            const sessionId = await page.locator('.session-row [data-session-id]').first().getAttribute('data-session-id')
            result.sessionId = sessionId
            const snapshot = () => page.evaluate(id => globalThis.__aitermTest.snapshot(id), sessionId)
            const screen = async () => visibleScreen(await snapshot()).join('\n')
            const windowState = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), bounds: win.getContentBounds() })))
            result.windowState = windowState
            if (!sessionId || !await input.isVisible() || !windowState.some(win => win.visible)) throw Error('Native diagnostic has no visible selected session')
            result.startupObservations = []
            const type = async text => { await input.focus(); await page.keyboard.type(text); await sleep(1000); await page.keyboard.press('Enter') }
            const claudeTool = night ? 'Bash(./fixture-night:*)' : 'Bash(bmn grant ask:*)'
            let command = app === 'claude'
              ? `env XDG_DATA_HOME=${quote(process.env.XDG_DATA_HOME)} DISABLE_AUTOUPDATER=1 claude --allowedTools ${quote(claudeTool)}`
              : `codex --no-alt-screen -c 'mcp_servers={}' -c ${quote(`projects."${scratch}".trust_level="trusted"`)}`
            const launchNative = async () => {
              stage('qualifying verified short launch')
              const shells = processTree(identity.pid).filter(row => row.comm === 'bash')
              if (shells.length !== 1 || readlinkSync(`/proc/${shells[0].pid}/cwd`) !== scratch) throw Error('Native fixture is not one owned bare shell in the expected folder')
              const lastLine = async () => (await screen()).split('\n').filter(line => line.trim()).at(-1)?.trimEnd()
              const prompt = await until(async () => { const line = await lastLine(); return line?.endsWith('$') ? line : false }, 'bare shell prompt', 15_000)
              const launcher = '.departure-native.sh'
              writeFileSync(join(scratch, launcher), `#!/bin/bash\nexec ${command}\n`, { mode: 0o700 })
              await input.focus(); await page.keyboard.type(`./${launcher}`, { delay: 40 }); await sleep(700)
              const echo = await lastLine()
              result.launch = { prompt, echo, expected: `${prompt} ./${launcher}`, shell: shells[0] }; save()
              if (echo !== result.launch.expected) throw Error('Native short launch echo differs; Enter not sent')
              await page.keyboard.press('Enter')
              stage('starting native app')
              const startup = [], used = { keys: 0 }
              await until(async () => {
                const value = await snapshot(), text = visibleScreen(value).join('\n')
                if (!(value.cols >= 40 && value.rows >= 15)) throw Error('Native diagnostic has unusable terminal dimensions')
                const frame = classifyMessageStartup(app, text.split('\n'), scratch)
                const observation = { ...frame, at: Date.now(), screen: text, dom: await page.locator('.session-terminal.selected .xterm-rows').innerText(), cols: value.cols, rows: value.rows, modes: value.modes }
                startup.push(observation); result.startupObservations.push(observation)
                result.startupState = { state: frame.state, detail: frame.detail ?? null }; save()
                if (frame.state === 'dialog') { result.startup = text.split('\n').slice(-12); throw Error('Native profile needs an owner startup or permission action; zero dialog keys sent') }
                const step = messageStartupStep(startup, used)
                if (step.action === 'ready') return true
                if (step.action === 'fail') throw Error(step.reason)
                if (step.action === 'key') {
                  const fresh = classifyMessageStartup(app, visibleScreen(await snapshot()), scratch)
                  if (fresh.state !== frame.state) return false
                  used.keys++; used[step.mark] = true
                  await input.focus(); await page.keyboard.press(step.key)
                }
                return false
              }, `${app} prompt`, 90_000, 2000)
            }
            await launchNative()
            const events = () => page.evaluate(id => globalThis.aiTerminal.listHookEvents(id), sessionId)
            stage('seeding synthetic unfinished work')
            let seedAt = Date.now()
            const seedPrompt = night
              ? `This is a synthetic test. On BMN's getting-ready line, immediately run exactly ./fixture-night ask. If I ask to apply an approved line, run ./fixture-night apply ITEM using that line's item id. When BMN gives a login check notice, run ./fixture-night check ITEM ATTEMPT with its item and attempt ids. Never send check output or run bmn away or back. ${messageSocketGuidance(app, ['./fixture-night'], 'receiver')}For now use no tools and reply READY.`
              : `This is a synthetic, owner-authorised test. Our unfinished work is one synthetic departure response. When BMN's fixed getting-ready line arrives, immediately run exactly: bmn grant ask --run departure-probe --nothing --reason "Synthetic departure response; nothing else needed". Never run bmn away or bmn back. ${messageSocketGuidance(app, ['bmn grant ask'], 'receiver')}For now do not use tools; reply READY.`
            await type(seedPrompt)
            if (allowTestProviders) {
              const guard = page.getByRole('dialog', { name: 'Prompt guard', exact: true })
              const outcome = await until(async () => await guard.isVisible() ? 'guard'
                : (await events()).some(event => Date.parse(event.observedAt) >= seedAt && event.agent === app && (event.event === 'Stop' || event.event === 'StopFailure')) ? 'finished' : false,
              `${app} isolated approval or finished seed`, 180_000)
              if (outcome === 'guard') {
                const provider = app === 'claude' ? 'anthropic' : 'openai'
                const providerName = app === 'claude' ? 'Anthropic' : 'OpenAI'
                const folder = await guard.locator('.guard-facts dd[title]').first().getAttribute('title')
                const title = await guard.locator('h3').innerText()
                if (folder !== realpathSync(scratch) || !title.includes(providerName)) throw Error('The privacy card does not match the named approval')
                const before = await page.evaluate(() => globalThis.aiTerminal.agentsSnapshot())
                await page.screenshot({ path: shotName(`${app}-${index + 1}-approval`) })
                await guard.getByRole('button', { name: 'Allow here', exact: true }).click()
                await until(async () => {
                  const current = await page.evaluate(() => globalThis.aiTerminal.agentsSnapshot())
                  return current.approved?.data.exceptions.some(entry => entry.provider === provider && entry.folder === folder) ? current : false
                }, 'the isolated provider exception')
                const after = await page.evaluate(() => globalThis.aiTerminal.agentsSnapshot())
                if (!before.approved || !after.approved || JSON.stringify({ ...before.approved.data, exceptions: [] }) !== JSON.stringify({ ...after.approved.data, exceptions: [] })) throw Error('Allow here changed more than workspace exceptions')
                result.providerApproval = { provider, folder, before: before.approved.number, after: after.approved.number, via: 'Allow here' }; save()
                await until(async () => !await guard.isVisible(), 'approval card closed')
                seedAt = Date.now()
                await type(seedPrompt)
              }
            }
            const finished = await until(async () => (await events()).findLast(event => Date.parse(event.observedAt) >= seedAt && event.agent === app && (event.event === 'Stop' || event.event === 'StopFailure')), `${app} real own finished turn`, 180_000)
            result.finishedAt = finished.observedAt; stage('waiting for unchanged 20-second quiet proof')
            // The production departure quiet time is 20 seconds, never shortened by this harness.
            if (!restoring) await sleep(Math.max(0, Date.parse(finished.observedAt) + 21_000 - Date.now()))
            if (scenario === 'draft') {
              await input.focus(); await page.keyboard.type('Synthetic draft; do not submit')
              await until(async () => (await screen()).includes('Synthetic draft; do not submit'), 'actual native draft visible', 10_000)
              result.draftVisibleBeforeDeparture = true
              await page.screenshot({ path: shotName(`${app}-${index + 1}-draft-before`) })
            }
            stage('starting departure')
            bmn('away', '--leaving')
            const get = () => page.evaluate(() => globalThis.aiTerminal.getGrant())
            const started = await until(async () => { const view = await get(); return view.period?.collection?.sessions.some(session => session.sessionId === sessionId && session.selected) ? view : false }, 'selected session')
            result.selectedAt = started.period.collection.selectedAt
            if (restoring) {
              stage('exiting before the genuine twenty-second quiet interval ends')
              const status = await page.evaluate(() => globalThis.aiTerminal.updateRestart('status'))
              const member = status.sessions.find(row => row.sessionId === sessionId)
              if (!member?.conversation || !/^[A-Za-z0-9-]+$/.test(member.conversation)) throw Error('No genuine typed-native conversation to restore; restart refusal unverified')
              result.restart = { before: started.period, oldIdentity: identity, conversation: member.conversation, oldLaunch: result.launch }
              save()
              const oldTree = processTree(identity.pid)
              await Promise.race([application.close().catch(() => {}), sleep(2000)])
              result.restart.cleanupBefore = await stopTree(oldTree, { graceMs: 500, afterKillMs: 1500, wait: sleep })
              result.restart.closedAt = new Date().toISOString()
              if (result.restart.cleanupBefore.remaining.length || Date.parse(result.restart.closedAt) >= Date.parse(finished.observedAt) + 20_000) throw Error('BMN did not stop inside the genuine quiet interval; antecedent unqualified')
              recordProcess(owned, false)
              stage('relaunching the same isolated profile and restoring the actual native target')
              application = await electron.launch({ chromiumSandbox: true, executablePath: tested.executablePath,
                args: [privateDisplay ? '--ozone-platform=x11' : '--ozone-platform=headless', '--disable-gpu', ...tested.appArgs, '--bmn-test-mode'], cwd: scratch, env: environment })
              identity = processTree(application.process().pid)[0]
              if (!identity || identity.start_ticks === result.restart.oldIdentity.start_ticks && identity.pid === result.restart.oldIdentity.pid) throw Error('No new BMN process identity')
              owned = { kind: 'process', pid: identity.pid, start_ticks: identity.start_ticks, command: `130 ${app} restored target`, evidence: reportPath }
              recordProcess(owned, true)
              result.restart.newIdentity = identity
              page = await application.firstWindow(); page.setDefaultTimeout(15_000)
              await page.waitForSelector('.session-row', { timeout: 60_000 })
              result.restart.after = (await get()).period
              check('restart retains the exact period and stored deadline without an owner action', result.restart.after?.periodId === started.period.periodId && result.restart.after?.collection?.autoAwayAt === started.period.collection.autoAwayAt)
              // Use the real Start again flow; reloading a live shell instead opens BMN's stop confirmation.
              for (let pass = 0; pass < 3 && await page.locator('dialog[open]').count(); pass++) await page.keyboard.press('Escape')
              if (await page.locator('dialog[open]').count()) throw Error('An unexpected BMN dialog blocks native restore; no action guessed')
              await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
              await page.getByRole('button', { name: 'Start again', exact: true }).click()
              input = page.locator('.session-terminal.selected .xterm-helper-textarea')
              await input.waitFor({ state: 'visible' })
              command = app === 'claude'
                ? `env XDG_DATA_HOME=${quote(process.env.XDG_DATA_HOME)} DISABLE_AUTOUPDATER=1 claude --resume ${quote(member.conversation)} --allowedTools 'Bash(bmn grant ask:*)'`
                : `codex resume ${quote(member.conversation)} --no-alt-screen -c 'mcp_servers={}' -c ${quote(`projects."${scratch}".trust_level="trusted"`)}`
              await launchNative()
              const resumed = await until(async () => (await events()).findLast(row => row.agent === app && row.event === 'SessionStart' && row.incarnationId !== result.restart.before.collection.sessions.find(row => row.sessionId === sessionId).incarnationId), 'actual resumed native SessionStart', 30_000)
              result.restart.liveTarget = { event: resumed, screen: (await screen()).split('\n').slice(-8) }
              save()
            }
            if (scenario === 'input' || scenario === 'control') {
              stage('waiting for durable-claim screen barrier')
              const heldPath = join(barrierDirectory, 'held.json')
              const held = await until(async () => existsSync(heldPath) ? JSON.parse(readFileSync(heldPath, 'utf8')) : null, 'test-host screen barrier after claim', 65_000)
              const claimed = (await get()).period.collection.sessions.find(row => row.sessionId === sessionId)
              if (held.sessionId !== sessionId || claimed.claim === null) throw Error('The held proof is not this selected session with a durable claim')
              result.barrier = { held, claim: claimed.claim, inputAt: null, inputVisibleAt: null, released: null }
              save()
              if (scenario === 'input') {
                const list = page.getByRole('dialog', { name: 'Before you go', exact: true })
                if (await list.isVisible()) await page.keyboard.press('Escape')
                await input.focus()
                if (!await input.evaluate(node => node === node.ownerDocument.activeElement)) throw Error('The native input did not gain focus; no proof input sent')
                result.barrier.inputAt = new Date().toISOString()
                await page.keyboard.type('Synthetic owner input during proof')
                await until(async () => (await screen()).includes('Synthetic owner input during proof'), 'real renderer input reached the native PTY', 10_000)
                result.barrier.inputVisibleAt = new Date().toISOString()
                await page.screenshot({ path: shotName(`${app}-${index + 1}-input-before-release`) })
              }
              writeFileSync(join(barrierDirectory, 'release'), held.token, { mode: 0o600 })
              const releasedPath = join(barrierDirectory, 'released.json')
              result.barrier.released = await until(async () => existsSync(releasedPath) ? JSON.parse(readFileSync(releasedPath, 'utf8')) : null, 'release back to unchanged idle proof', 10_000)
              save()
            }
            if (scenario === 'draft' || scenario === 'input' || restoring) {
              stage('observing the full unchanged three-minute answer window')
              await sleep(Math.max(0, Date.parse(result.selectedAt) + 181_000 - Date.now()))
              result.observedThrough = new Date().toISOString()
              const current = await get()
              result.collection = current.period.collection
              result.refusal = current.period.collection.sessions.find(row => row.sessionId === sessionId)
              result.hostWrites = existsSync(hostWrites) ? readFileSync(hostWrites, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
              result.screen = (await screen()).split('\n').slice(-8)
              result.away = await page.evaluate(() => globalThis.aiTerminal.getAway())
              await page.screenshot({ path: shotName(`${app}-${index + 1}`) })
              const writes = result.hostWrites.filter(row => row.sessionId === sessionId && Date.parse(row.at) >= Date.parse(result.selectedAt))
              check(`${app} ${scenario}: actual unsafe prompt refused for the full window`, result.refusal?.toldAt === null && result.refusal?.claim === null && (restoring ? /no fresh|resumed|restarted/.test(result.refusal?.reason ?? '') : /not empty and idle/.test(result.refusal?.reason ?? '')) && writes.length === 0 && result.away.state !== 'away', { refusal: result.refusal, writes: writes.length, observedThrough: result.observedThrough })
              bmn('back')
              return
            }
            stage('waiting for typed line')
            const told = await until(async () => (await get()).period.collection.sessions.find(session => session.sessionId === sessionId && session.toldAt !== null), 'typed departure line', 65_000).catch(() => null)
            result.toldAt = told?.toldAt ?? null; stage('waiting for native answer')
            result.delivered = told?.via === 'typed' && Date.parse(told.toldAt) - Date.parse(result.selectedAt) <= 60_000
            const answered = told === null ? null : await until(async () => (await get()).period.runs.find(run => run.runId === (night?.run ?? 'departure-probe')), 'native departure answer', 180_000).catch(() => null)
            result.answeredAt = answered?.card.askedAt ?? null
            const terms = answered?.card.terms
            const correctCard = night
              ? terms?.length === 3 && terms[0]?.kind === 'limit' && terms[0].from === 4 && terms[0].to === 6 &&
                terms[1]?.kind === 'access' && terms[1].name === night.access.name &&
                terms[2]?.kind === 'merge' && terms[2].pr === 7 && terms[2].headSha === night.head
              : answered?.card.nothing === true
            result.answered = correctCard === true && Date.parse(answered.card.askedAt) - Date.parse(told.toldAt) <= 180_000
            if (night && answered) {
              check(`${app} ${index + 1}: exhausted limit refused and all three lines match`, result.answered && night.emptyWasRefused())
            }
            result.collection = (await get()).period.collection
            result.screen = (await screen()).split('\n').slice(-6)
            result.departureLineVisible = (await screen()).includes(DEPARTURE_LINE.slice(0, 45))
            if (night && !answered) result.noCardCause = /approval|declined|permission|reviewer/iu.test(result.screen.join(' '))
              ? 'Approval or permission stopped the command' : told === null ? 'BMN did not deliver the line' : 'No card reached BMN in the answer window'
            result.away = await page.evaluate(() => globalThis.aiTerminal.getAway())
            result.hostWrites = existsSync(hostWrites) ? readFileSync(hostWrites, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
            const writes = result.hostWrites.filter(row => row.sessionId === sessionId && Date.parse(row.at) >= Date.parse(result.selectedAt))
            const expectedBytes = Buffer.from(`\u001b[200~${DEPARTURE_LINE}\u001b[201~\r`)
            result.exactlyOneFixedWrite = writes.length === 1 && writes[0].bytes === expectedBytes.length && writes[0].sha256 === createHash('sha256').update(expectedBytes).digest('hex')
            check(`${app} ${index + 1}: exactly one recorded write contains the complete fixed line`, result.exactlyOneFixedWrite, { writes: writes.length })
            await page.screenshot({ path: shotName(`${app}-${index + 1}`) })
            // D12: each case is an observation; the cohort verdict below grades delivery for both apps and answers for
            // Claude Code only. A case that set Away or wrote more than the one fixed line still fails at once.
            check(`${app} ${index + 1}: no Away and at most the one fixed write`, result.away.state !== 'away' && writes.length <= 1)
            if (night && result.answered && index === 0) {
              const list = page.getByRole('dialog', { name: 'Before you go', exact: true })
              const row = list.locator(`[data-run-id="${night.run}"]`)
              if (!await list.isVisible()) await page.locator('button.away-grant').click()
              await row.getByRole('radio', { name: 'Yes', exact: true }).click()
              await list.getByRole('button', { name: 'Close Before you go', exact: true }).click()
              await type(`Run ./fixture-night apply ${terms[0].id} now. This uses the synthetic approval in the test window.`)
              const written = await until(async () => (await get()).period?.limitApplies?.find(item => item.state === 'written'), 'native allowance apply', 120_000).catch(() => null)
              check(`${app}: real session applied the allowance approval`, written !== null &&
                night.plan('allowances', '7').current.fields.limits.rechecks.limit === 6)
              await page.locator('button.away-grant').click()
              night.markSignedIn()
              await row.getByRole('button', { name: 'Done', exact: true }).click()
              const checked = await until(async () => (await get()).period?.runs.find(run => run.runId === night.run)?.access?.find(item => item.outcome === 'works'), 'native login report', 65_000).catch(() => null)
              check(`${app}: real session checked its synthetic sign-in`, checked !== null)
              await page.screenshot({ path: shotName(`${app}-night-result`) })
            }
            bmn('back')
          } catch (error) {
            const page = application.windows()[0]
            if (page) {
              await page.screenshot({ path: shotName(`${app}-${index + 1}-startup`), timeout: 5000 }).catch(() => {})
            }
            throw error
          } finally {
            const current = processTree(identity.pid)
            const identities = current[0]?.start_ticks === identity.start_ticks ? current : []
            await Promise.race([application.close().catch(() => {}), sleep(10_000)])
            const cleanup = await stopTree(identities, { graceMs: 1000, afterKillMs: 1500, wait: sleep })
            result.cleanup = cleanup
            if (cleanup.remaining.length === 0) recordProcess(owned, false)
            check(`${app} ${index + 1}: owned resources stopped`, cleanup.remaining.length === 0)
          }
        }, base)
      } catch (error) {
        result.error = String(error).slice(0, 8000)
        check(`${app} ${index + 1}: live case completed`, false, { error: result.error })
        // A failed representative preflight parks this route; do not spend nine more turns on the same failure.
        break
      }
    }
  }
  if (!scenario) {
    // D12 cohort verdict (130.2 AC5): of N resting cases per app, at least N - 1 when N is 10 (all of them below 10) are
    // told within 60 seconds with exactly one fixed write; Claude Code answers as many within 3 minutes; Codex answers
    // are best effort and recorded.
    for (const app of apps) {
      const cases = report.cases.filter(row => row.app === app)
      const needed = nightComposer ? count : cases.length >= 10 ? cases.length - 1 : cases.length
      const delivered = cases.filter(row => row.delivered && row.exactlyOneFixedWrite).length
      const answered = cases.filter(row => row.delivered && row.answered).length
      report.cohorts = { ...report.cohorts, [app]: { cases: cases.length, needed, delivered, answered, answersRequired: app === 'claude' } }
      check(`${app} cohort: ${delivered} of ${cases.length} told once within 60 seconds (needs ${needed})`, delivered >= needed)
      if (app === 'claude') check(`claude cohort: ${answered} of ${cases.length} answered within 3 minutes (needs ${needed})`, answered >= needed)
      else console.error(`[departure] ${app} cohort: ${answered} of ${cases.length} answered within 3 minutes (best effort, D12)`)
    }
  }
  report.result = report.checks.some(check => check.result === 'FAIL') ? 'FAIL' : 'PASS'
  save(); console.log(JSON.stringify({ result: report.result, cases: report.cases.length, reportPath }))
  return report.result === 'PASS' ? 0 : 1
}
