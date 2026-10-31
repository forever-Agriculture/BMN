// MODULE: qa-pane-readiness.test.mjs - real Linux shebang transition cannot race strict QA agent registration
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { QaSessions } from './qa-sessions'
import { qaPaneLines, waitForQaChild } from '../../bin/qa-pane-run.mjs'
import { processIdentity } from '../../bin/browser-process.mjs'

async function heldLauncher(check, exitFirst = false) {
  const root = mkdtempSync(join(tmpdir(), 'qa-ready-')), bin = join(root, 'bin'), folder = join(root, 'run')
  mkdirSync(bin); mkdirSync(folder)
  const launcher = join(root, 'synthetic-agent'), shim = join(bin, 'node')
  writeFileSync(launcher, '#!/usr/bin/env node\nconst timer=setTimeout(()=>process.exit(2),10000);process.stdin.resume();process.stdin.on("end",()=>clearTimeout(timer))\n', { mode: 0o700 })
  writeFileSync(shim, '#!/bin/sh\nprintf "held\\n"\nread gate <&3\nif [ "$BMN_TEST_EXIT_FIRST" = yes ]; then exit 0; fi\nexec "$BMN_TEST_REAL_NODE" "$@"\n', { mode: 0o700 })
  const launch = { built: { command: [launcher, '--synthetic'] }, identity: { launcher: { real: realpathSync(launcher) } } }
  writeFileSync(join(folder, 'launch.json'), JSON.stringify(launch))
  const child = spawn(launcher, ['--synthetic'], { cwd: folder,
    env: { PATH: `${bin}:/usr/bin:/bin`, BMN_TEST_REAL_NODE: process.execPath, BMN_TEST_EXIT_FIRST: exitFirst ? 'yes' : 'no' }, stdio: ['pipe', 'pipe', 'inherit', 'pipe'] })
  const exited = once(child, 'exit')
  try {
    await once(child.stdout, 'data')
    const identity = processIdentity(child.pid), run = { folder, sessionId: 'synthetic-qa' }
    const server = new QaSessions({ processId: () => process.pid })
    expect(server.agentProcess(run, child.pid, identity.ticks)).toBe(false)
    await check({ child, launch, folder, identity, server, run })
  } finally {
    if (!child.stdio[3].writableEnded) child.stdio[3].end('go\n')
    child.stdin.end()
    await exited
    rmSync(root, { recursive: true, force: true })
  }
}

it('holds the same child until its pinned Node launcher appears; the server remains strict', () => heldLauncher(async ({ child, launch, folder, identity, server, run }) => {
  let ready = false
  const pending = waitForQaChild(child, launch, folder, 2000).then(result => { ready = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  expect(ready).toBe(false)
  child.stdio[3].end('go\n')
  const result = await pending
  expect(result).toMatchObject({ pid: identity.pid, ticks: identity.ticks, form: 'node' })
  expect(server.agentProcess(run, child.pid, identity.ticks)).toBe(true)
  expect(processIdentity(child.pid)).toEqual(identity)
}), 10_000)

it('times out without accepting the held interpreter or writing a prompt', () => heldLauncher(async ({ child, launch, folder, identity, server, run }) => {
  await expect(waitForQaChild(child, launch, folder, 30)).rejects.toThrow('QA_AGENT_NOT_READY')
  expect(server.agentProcess(run, child.pid, identity.ticks)).toBe(false)
  expect(child.stdin.writableLength).toBe(0)
}), 10_000)

it('fails closed when that same child exits before its pinned launcher appears', () => heldLauncher(async ({ child, launch, folder }) => {
  const pending = waitForQaChild(child, launch, folder, 2000)
  const rejected = expect(pending).rejects.toThrow('QA_AGENT_NOT_READY')
  child.stdio[3].end('go\n')
  await rejected
  expect(child.stdin.writableLength).toBe(0)
}, true), 10_000)

it('the QA pane shows readable agent words, browser actions and refusals instead of raw Claude Code events', () => {
  expect(qaPaneLines({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['mcp__playwright__browser_click', 'mcp__playwright__browser_snapshot'] }))
    .toEqual(['QA agent started: claude-opus-5-5, 2 browser tools.'])
  expect(qaPaneLines({ type: 'assistant', message: { content: [{ type: 'text', text: 'Picking the\ntest account.' }, { type: 'tool_use', name: 'mcp__playwright__browser_account_pick', input: { name: 'Synthetic test' } }] } }))
    .toEqual(['Picking the test account.', '→ browser_account_pick {"name":"Synthetic test"}'])
  expect(qaPaneLines({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'This account is look-only in this QA.' }] }, { type: 'tool_result', content: 'snapshot' }] } }))
    .toEqual(['  refused or failed: This account is look-only in this QA.'])
  expect(qaPaneLines({ type: 'result', subtype: 'success', num_turns: 12 })).toEqual(['QA finished: success, 12 turns.'])
  expect(qaPaneLines({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(900) }] } })[0]).toHaveLength(600)
  expect(qaPaneLines({ type: 'rate_limit_event' })).toEqual([])
})
