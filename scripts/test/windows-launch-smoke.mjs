/* global window */
// Real renderer -> main -> utility -> owned ConPTY launch, using synthetic files.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

assert.equal(process.platform, 'win32', 'This acceptance check requires native Windows')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, 'test-results')
mkdirSync(evidence, { recursive: true })
const observations = []
const quote = args => args.map(value => value && !/[\s"]/.test(value) ? value
  : `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`).join(' ')
const readEventually = async path => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { await delay(100) }
  }
  throw new Error(`No complete launch receipt: ${path}`)
}

try {
  await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
    const cwd = join(root, 'launch space 数据')
    mkdirSync(cwd)
    const bin = join(cwd, 'bin')
    mkdirSync(bin)
    // This program needs no neighbouring files. A spaced executable path and an
    // extensionless PATH lookup both reach a real native receiver.
    const nativeCopy = join(bin, 'native-fixture.exe')
    copyFileSync(process.execPath, nativeCopy)
    // A PATH lookalike cannot replace BMN's chosen system batch interpreter.
    copyFileSync(process.execPath, join(bin, 'cmd.exe'))
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\necho BMN_SYNTHETIC_AGENT_EXIT\r\nexit /b 0\r\n')
    const env = { ...process.env,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_RUNTIME_DIR: roots.runtime, XDG_CACHE_HOME: roots.cache,
      CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'),
      OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'), BMN_LAUNCH_CWD: cwd,
      BMN_SYNTHETIC_PRIVATE: 'must-not-reach-child', SYNTHETIC_PUBLIC: 'literal-public-value'
    }
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
    env.Path = [bin, process.env.PATH ?? ''].join(';')
    env.PATHEXT = '.EXE;.CMD;.BAT;.COM'
    delete env.ELECTRON_RUN_AS_NODE
    for (const name of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[name]
    const app = await _electron.launch({ executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'),
      cwd: repo, args: [join(repo, 'apps/desktop'), '--bmn-test-mode'], env, chromiumSandbox: true, timeout: 45000 })
    let page
    try {
      page = await app.firstWindow()
      page.setDefaultTimeout(20000)
      await page.waitForFunction(async () => {
        try { return (await window.aiTerminal.listWorkspaces()).length > 0 } catch { return false }
      })
      assert.equal(await page.evaluate(() => window.aiTerminal.platform), 'win32')
      const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
      const launch = async (name, executable, argv) => page.evaluate(async params => {
        try { return await window.aiTerminal.createSession(params) }
        catch (error) { throw new Error(JSON.stringify({ phase: 'create-session', name: params.name,
          code: error?.code, message: String(error?.message ?? error).slice(0, 1000) }), { cause: error }) }
      }, {
        workspaceId: workspace.workspaceId, name, executable, argv, cwd, cols: 80, rows: 24
      })
      const stop = result => page.evaluate(id => window.aiTerminal.stopSession(id), result.session.sessionId)
      const send = (result, text) => page.evaluate(({ id, text }) => window.aiTerminal.sendTerminalInput(id, new TextEncoder().encode(text)),
        { id: result.startup.attachmentId, text })

      // Both shells must execute input, resize and stop through the actual utility.
      for (const shell of ['powershell.exe', 'cmd.exe']) {
        const output = join(cwd, shell + '.json')
        const session = await launch(shell, shell, shell === 'cmd.exe' ? ['/d'] : ['-NoLogo', '-NoProfile'])
        await page.evaluate(id => window.aiTerminal.activateTerminal(id), session.session.sessionId)
        await page.evaluate(id => window.aiTerminal.resizeTerminal(id, 101, 37), session.session.sessionId)
        await send(session, shell === 'cmd.exe'
          ? `echo {"shell":"cmd"}>"${output}"\r`
          : `[IO.File]::WriteAllText('${output.replaceAll("'", "''")}', '{"shell":"powershell"}')\r`)
        assert.equal((await readEventually(output)).shell, shell === 'cmd.exe' ? 'cmd' : 'powershell')
        await send(session, '\x03')
        await stop(session)
        observations.push({ shell, input: true, resizeRequest: [101, 37], stop: true })
      }

      const receiver = join(cwd, 'receiver.cjs')
      writeFileSync(receiver, "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),public:process.env.SYNTHETIC_PUBLIC,private:process.env.BMN_SYNTHETIC_PRIVATE,stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY}));setInterval(()=>{},1000)")
      const args = ['', 'with spaces', '数据', '%PATH%', '^&|<>!', 'quote"value', '"quoted space"', 'C:\\trailing slash\\']
      const verifyArgs = async (executable, prefix, name) => {
        const output = join(cwd, name + '.json')
        const result = await launch(name, executable, [...prefix, output, ...args])
        const receipt = await readEventually(output)
        assert.deepEqual(receipt.args, args)
        assert.equal(receipt.cwd, cwd)
        assert.equal(receipt.public, 'literal-public-value')
        assert.equal(receipt.private, undefined)
        assert.equal(receipt.stdinTTY, true)
        assert.equal(receipt.stdoutTTY, true)
        await stop(result)
        observations.push({ name, literalArguments: true, cwd: true, environment: true, tty: true })
      }
      await verifyArgs(process.execPath, [receiver], 'native argv')
      await verifyArgs('native-fixture', [receiver], 'PATH native argv')
      await verifyArgs(nativeCopy, [receiver], 'spaced executable argv')
      const pkg = join(cwd, 'package')
      mkdirSync(pkg)
      writeFileSync(join(pkg, 'entry.js'), readFileSync(receiver))
      const shim = join(bin, 'synthetic-agent.cmd')
      writeFileSync(shim, readFileSync(join(repo, 'apps/desktop/src/utility/fixtures/npm-node.cmd')))
      await verifyArgs('synthetic-agent', [], 'PATH npm shim argv')
      const unknown = join(bin, 'unknown.cmd')
      writeFileSync(unknown, '@echo off\r\necho this requires explicit batch mode\r\n')
      const rejection = await page.evaluate(async params => {
        try { await window.aiTerminal.createSession(params); return null }
        catch (error) { return String(error?.message ?? error) }
      }, { workspaceId: workspace.workspaceId, name: 'Unknown shim rejection', executable: unknown, argv: ['%PATH%', '^&'], cwd, cols: 80, rows: 24 })
      assert.match(rejection ?? '', /Batch command mode/)
      observations.push({ unknownBatchRejectedInProgramMode: true })

      const promptReceipt = join(cwd, 'agent-prompt.json')
      const agent = await launch('Agent prompt fixture', 'cmd.exe', ['/d', '/v:off', '/s', '/k', 'codex'])
      await page.evaluate(id => window.aiTerminal.activateTerminal(id), agent.session.sessionId)
      await send(agent, `echo {"prompt":true}>"${promptReceipt}"\r`)
      assert.deepEqual(await readEventually(promptReceipt), { prompt: true })
      await stop(agent)
      observations.push({ agentExitedPromptUsable: true })

      // A native Node producer must cross ConPTY and decode in the actual pane.
      // Keep the saved text separate from the image layer; no direct renderer injection.
      const graphicsFixture = join(cwd, 'graphics-producer.cjs')
      const graphicsTrace = join(cwd, 'graphics-trace.json')
      const frame = `\x1bP9;1;0q"1;1;60;75#1;2;100;0;0#1${Array(13).fill('!60~').join('-')}\x1b\\`
      writeFileSync(graphicsFixture, `const fs=require('node:fs');const trace=${JSON.stringify(graphicsTrace)};
process.on('uncaughtException',error=>{fs.writeFileSync(trace,JSON.stringify({stage:'error',name:error.name,code:error.code,message:error.message}));process.exit(1)});
fs.writeFileSync(trace,JSON.stringify({stage:'entered',stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY}));
const frame=${JSON.stringify(frame)};
process.stdin.setRawMode(true);process.stdin.resume();let emitted=false;
process.stdin.on('data',()=>{if(!emitted){emitted=true;process.stdout.write(frame+'BMN_GRAPHICS_NATIVE_READY\\r\\n')}
else process.stdout.write('BMN_GRAPHICS_INPUT_OK\\r\\n')});setInterval(()=>{},1000);`)
      // The real creation form adopts the returned attachment into the renderer.
      // Direct IPC creation only records it in preload for a future subscription.
      await page.keyboard.press('Control+Shift+P')
      await page.locator('dialog[open] input').fill('New session')
      await page.getByRole('option').filter({ has: page.locator('.label', { hasText: /^New session…$/ }) }).click()
      await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Native graphics fixture')
      await page.getByRole('textbox', { name: 'Working directory', exact: true }).fill(cwd)
      await page.locator('.advanced summary').click()
      await page.getByLabel('Launch type', { exact: true }).selectOption('program')
      await page.getByRole('textbox', { name: 'Executable', exact: true }).fill(process.execPath)
      await page.getByRole('textbox', { name: 'Arguments', exact: true }).fill(JSON.stringify([graphicsFixture]))
      await page.getByRole('button', { name: 'Create session', exact: true }).click()
      await page.waitForFunction(async workspaceId =>
        (await window.aiTerminal.listSessions(workspaceId)).some(session => session.name === 'Native graphics fixture'), workspace.workspaceId)
      const graphics = { session: await page.evaluate(async workspaceId =>
        (await window.aiTerminal.listSessions(workspaceId)).find(session => session.name === 'Native graphics fixture'), workspace.workspaceId) }
      const graphicsId = graphics.session.sessionId
      await page.locator(`.session-row button[data-session-id="${graphicsId}"]`).click()
      await page.waitForFunction(id => {
        try { return !!window.__aitermTest?.snapshot(id) } catch { return false }
      }, graphicsId)
      await page.locator(`.session-terminal[data-session-id="${graphicsId}"] .terminal-surface`).click()
      // Produce the image only after a real pane and keyboard input are connected.
      await page.keyboard.type('g')
      try { await page.waitForFunction(id => {
        try {
          const snapshot = window.__aitermTest.snapshot(id)
          return snapshot.imageStorageMB > 0 && snapshot.imageLayerPresent &&
            snapshot.bufferLines.some(line => line.includes('BMN_GRAPHICS_NATIVE_READY'))
        } catch { return false }
      }, graphicsId) } catch (error) {
        let producer
        try { producer = JSON.parse(readFileSync(graphicsTrace, 'utf8')) } catch { producer = { stage: 'not-entered' } }
        observations.push({ nativeGraphicsFailure: true, producer,
          renderer: await page.evaluate(async ({ workspaceId, sessionId }) => {
            let snapshots
            try { snapshots = window.__aitermTest.snapshots() }
            catch (error) { snapshots = { error: String(error?.message ?? error) } }
            return { snapshots, sessions: await window.aiTerminal.listSessions(workspaceId),
              savedOutput: await window.aiTerminal.getSavedOutput(sessionId) }
          }, { workspaceId: workspace.workspaceId, sessionId: graphicsId }).catch(error => ({ error: error.message })) })
        throw error
      }
      const beforeResize = await page.evaluate(id => window.__aitermTest.snapshot(id), graphicsId)
      await page.evaluate(id => window.aiTerminal.resizeTerminal(id, 101, 37), graphicsId)
      await page.locator(`.session-terminal[data-session-id="${graphicsId}"] .terminal-surface`).click()
      await page.keyboard.type('synthetic input')
      await page.waitForFunction(id => {
        const snapshot = window.__aitermTest.snapshot(id)
        return snapshot.imageStorageMB > 0 && snapshot.imageLayerPresent &&
          snapshot.bufferLines.some(line => line.includes('BMN_GRAPHICS_INPUT_OK'))
      }, graphicsId)
      await page.screenshot({ path: join(evidence, 'windows-native-sixel.png') })
      observations.push({ nativeSixelThroughPty: true, imageStorageMB: beforeResize.imageStorageMB,
        imageAfterResize: true, inputAfterGraphics: true })
      await stop(graphics)

      // Drive the actual launch form, then reopen its saved settings.
      await page.keyboard.press('Control+Shift+P')
      await page.locator('dialog[open] input').fill('New session')
      await page.getByRole('option').filter({ has: page.locator('.label', { hasText: /^New session…$/ }) }).click()
      await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Explicit batch fixture')
      await page.getByRole('textbox', { name: 'Working directory', exact: true }).fill(cwd)
      await page.locator('.advanced summary').click()
      await page.getByLabel('Launch type', { exact: true }).selectOption('batch')
      const batchReceipt = join(cwd, 'batch.json')
      const batchScript = join(cwd, 'explicit script.cmd')
      writeFileSync(batchScript, '@echo off\r\necho {"batch":true}>"%~1"\r\n')
      const command = `"${batchScript}" "${batchReceipt}" & pause`
      await page.getByRole('textbox', { name: 'Batch command', exact: true }).fill(command)
      assert.equal(await page.getByRole('textbox', { name: 'Arguments', exact: true }).count(), 0)
      await page.getByRole('button', { name: 'Create session', exact: true }).click()
      assert.deepEqual(await readEventually(batchReceipt), { batch: true })
      await page.getByRole('button', { name: 'More actions for Explicit batch fixture', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Edit launch settings', exact: true }).click()
      assert.equal(await page.getByLabel('Launch type', { exact: true }).inputValue(), 'batch')
      assert.equal(await page.getByRole('textbox', { name: 'Batch command', exact: true }).inputValue(), command)
      await page.screenshot({ path: join(evidence, 'windows-batch-mode.png') })
      await page.getByRole('button', { name: 'Cancel edit', exact: true }).click()
      observations.push({ batchMode: true, arbitraryScript: true, savedMode: true })

      // The same literal argv also crosses the user-editable Arguments field.
      await page.keyboard.press('Control+Shift+P')
      await page.locator('dialog[open] input').fill('New session')
      await page.getByRole('option').filter({ has: page.locator('.label', { hasText: /^New session…$/ }) }).click()
      await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Literal UI fixture')
      await page.getByRole('textbox', { name: 'Working directory', exact: true }).fill(cwd)
      await page.locator('.advanced summary').click()
      await page.getByLabel('Launch type', { exact: true }).selectOption('program')
      await page.getByRole('textbox', { name: 'Executable', exact: true }).fill(process.execPath)
      const uiReceipt = join(cwd, 'ui-argv.json')
      await page.getByRole('textbox', { name: 'Arguments', exact: true }).fill(quote([receiver, uiReceipt, ...args]))
      await page.getByRole('button', { name: 'Create session', exact: true }).click()
      assert.deepEqual((await readEventually(uiReceipt)).args, args)
      observations.push({ literalArgumentField: true })
    } catch (error) {
      await page?.screenshot({ path: join(evidence, 'windows-launch-failure.png') }).catch(() => {})
      throw error
    } finally {
      await page?.evaluate(async () => {
        for (const workspace of await window.aiTerminal.listWorkspaces())
          for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
      }).catch(() => {})
      await app.close()
    }
  })
  console.log(JSON.stringify({ passed: true, observations }))
} finally {
  writeFileSync(join(evidence, 'windows-launch-observations.json'), JSON.stringify(observations, null, 2))
}
