// MODULE: bench-server.mjs - private D-Bus bench daemon with one persistent Playwright connection and serialized shell actions
/* global window */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { atomicJson, isLiveProcess, loopbackEndpoint, processIdentity, validateAction } from './bench-lib.mjs'
import { allTraces, configFor, groupState, requestStop, transition } from './bench-state.mjs'

const config = configFor(JSON.parse(readFileSync(process.argv[2], 'utf8')).runId)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
let application, server, stopping

async function shutdown(error) {
  if (stopping) return stopping
  stopping = (async () => {
    requestStop(config.runId, error)
    if (server) await new Promise(resolveClose => server.close(resolveClose))
    atomicJson(join(config.run, 'shutdown-processes.json'), groupState(config).processes)
    if (application) {
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await application.close().catch(() => {})
    }
    // The outside-group watchdog owns the final group drain, trace completion and root deletion.
    process.exit(error ? 1 : 0)
  })()
  return stopping
}

async function main() {
  const membership = readFileSync('/proc/self/cgroup', 'utf8')
  if (!membership.includes(`::${config.group.path.slice('/sys/fs/cgroup'.length)}\n`) || process.env.HOME !== join(config.root, 'home') || !process.env.DBUS_SESSION_BUS_ADDRESS?.includes(join(config.root, 'runtime'))) {
    throw new Error('The QA server must run inside its private launch environment and cgroup')
  }
  atomicJson(join(config.run, 'bus.json'), { address: process.env.DBUS_SESSION_BUS_ADDRESS })
  const identity = processIdentity(process.pid)
  const starting = transition(config.runId, ['starting'], state => {
    const tracers = allTraces(state)
    return { ...state, tracers, tracer: tracers.find(trace => trace.role === 'workload').identity,
      pid: identity.pid, start_ticks: identity.start_ticks, dbus: process.env.DBUS_SESSION_BUS_ADDRESS }
  })
  if (starting?.pid !== process.pid) throw new Error('QA startup was cancelled or superseded')
  if (config.build) {
    const result = spawnSync(join(config.root, 'bin/pnpm'), ['run', 'build'], { cwd: repo, env: process.env, stdio: 'inherit' })
    if (result.status !== 0) throw new Error('Build failed inside the isolated QA workload')
  }
  application = await electron.launch({ chromiumSandbox: true, executablePath: config.binary, timeout: 40000,
    args: ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--force-device-scale-factor=1',
      '--disable-partial-raster', '--num-raster-threads=1', '--password-store=basic', '--remote-debugging-address=127.0.0.1',
      ...(config.packaged ? [] : [join(repo, 'apps/desktop')]), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: join(config.root, 'synthetic-project'), env: process.env
  })
  application.on('close', () => { void shutdown() })
  const page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  await page.waitForSelector('.session-row', { timeout: 30000 })
  // Use the normal create flow so the renderer knows the seeded shell is live.
  // A raw preload create bypasses its reducer; reloading would add a recovery notice.
  const cwd = join(config.root, 'synthetic-project')
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('QA review')
  await page.getByRole('textbox', { name: 'Optional workspace directory' }).fill(cwd)
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Review shell')
  const sessionForm = page.getByRole('complementary', { name: 'New session', exact: true })
  await sessionForm.getByText('Advanced', { exact: true }).click()
  await sessionForm.getByRole('textbox', { name: 'Arguments', exact: true }).fill('--noprofile --norc')
  await page.getByRole('button', { name: 'Create session', exact: true }).click()
  await page.getByRole('button', { name: 'Actions for Review shell', exact: true }).waitFor()
  const fixture = await page.evaluate(async cwd => {
    const rows = await window.aiTerminal.listWorkspaces()
    const primary = rows.find(item => item.workspaceId === '00000000-0000-4000-8000-000000000001')
    const second = rows.find(item => item.name === 'QA review')
    return { primary: primary.workspaceId, second: second.workspaceId, cwd }
  }, cwd)
  const userData = await application.evaluate(({ app }) => app.getPath('userData'))
  const portFile = join(userData, 'DevToolsActivePort')
  const deadline = Date.now() + 5000
  while (!existsSync(portFile) && Date.now() < deadline) await sleep(50)
  const cdp = loopbackEndpoint(Number(readFileSync(portFile, 'utf8').split('\n')[0]))
  const processes = groupState(config).processes.map(item => {
    let dbus = null
    try { dbus = readFileSync(`/proc/${item.pid}/environ`, 'utf8').split('\0').find(value => value.startsWith('DBUS_SESSION_BUS_ADDRESS='))?.slice(25) ?? null } catch { /* sandboxed Chromium children may hide environ */ }
    return { ...item, dbus }
  })
  let queue = Promise.resolve()
  server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${config.token}` || request.method !== 'POST' || request.url !== '/action') {
      response.writeHead(403).end(); return
    }
    let body = ''
    request.on('data', part => { body += part; if (body.length > 262144) request.destroy() })
    request.on('end', () => {
      queue = queue.then(async () => {
        try {
          const args = validateAction(JSON.parse(body))
          if (stopping) throw new Error('Bench is stopping')
          let result
          switch (args[0]) {
            case 'snapshot': result = { snapshot: await page.locator('body').ariaSnapshot() }; break
            case 'click': await page.locator(args[1]).click(); result = { clicked: args[1] }; break
            case 'type': await page.locator(args[1]).fill(args[2]); result = { typed: args[1] }; break
            case 'press': await page.keyboard.press(args[1]); result = { pressed: args[1] }; break
            case 'screenshot': {
              const path = join(config.run, args[1].endsWith('.png') ? args[1] : `${args[1]}.png`)
              await page.screenshot({ path }); result = { screenshot: path }; break
            }
            case 'stop': result = { stopping: true }; break
          }
          appendFileSync(join(config.run, 'actions.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), args, result })}\n`, { mode: 0o600 })
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
          if (args[0] === 'stop') setImmediate(() => { void shutdown().catch(fatal) })
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }))
        }
      }).catch(fatal)
    })
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolveListen) })
  const running = transition(config.runId, ['starting'], state => {
    if (!isLiveProcess(state.watchdog?.identity) || !isLiveProcess(state.watchdog?.tracer)) return null
    return { ...state, status: 'running', cdp, control: loopbackEndpoint(server.address().port), fixture, processes }
  })
  if (running?.status !== 'running' || running.pid !== process.pid) throw new Error('QA startup lost its recovery monitor or was cancelled')
}

function fatal(error) { console.error(error); void shutdown(error).catch(cleanupError => { console.error(cleanupError); process.exit(1) }) }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void shutdown().catch(fatal) })
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)
main().catch(fatal)
