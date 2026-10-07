// Real shell/foreground-job replay; synthetic hook payloads, no provider or credentials.
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CompanionService } from './companion-service'
import { DatabaseWorkerClient } from './database-client'
import { SessionManager, type SessionIdentity } from './session-manager'
import { DEFAULT_WORKSPACE_ID } from './store-schema'
import type { AttentionRecord } from '@bmn/protocol'

const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
// Use the already-installed Vite compiler; each replay builds its actual source worker in its private root.
const compiler = createRequire(createRequire(import.meta.url).resolve('vite'))('esbuild') as {
  buildSync(options: { entryPoints: string[]; outfile: string; bundle: boolean; platform: string; format: string }): void
}
const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  const until = Date.now() + 5000
  while (!await condition()) {
    if (Date.now() > until) throw new Error('Synthetic foreground replay timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

it.skipIf(process.platform !== 'linux').each(['exit', 'suspend', 'replace', 'direct-exit'] as const)(
  'refuses manual input after the observed foreground agent %s without SessionEnd', async transition => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-foreground-'))
    for (const name of ['home', 'config', 'data', 'state', 'runtime']) mkdirSync(join(root, name))
    const repo = resolve(import.meta.dirname, '../../../..')
    symlinkSync(join(repo, 'apps/desktop/node_modules'), join(root, 'node_modules'), 'dir')
    const worker = join(root, 'database-worker.cjs')
    compiler.buildSync({ entryPoints: [join(repo, 'apps/desktop/src/utility/database-worker.ts')], outfile: worker,
      bundle: true, platform: 'node', format: 'cjs' })
    const database = new DatabaseWorkerClient(worker, join(root, 'data/state.sqlite3'))
    const writes: string[] = []
    let output = '', identity: SessionIdentity | undefined, service: CompanionService | undefined
    let ptyPid = 0, foregroundPid = 0
    const manager = new SessionManager({ store: database, homeDirectory: join(root, 'home'),
      environment: { HOME: join(root, 'home'), PATH: process.env.PATH, TERM: 'xterm-256color', PS1: 'SYNTHETIC_SHELL> ' },
      spawnPty: (exe, args, options) => {
        const child = pty.spawn(exe, [...args], { ...options, env: { ...options.env }, encoding: null })
        ptyPid = child.pid
        return child
      },
      sendTerminalMessage: () => {},
      sessionEnvironment: value => service?.sessionEnvironment(value) ?? {},
      sessionPath: () => service?.sessionPath() ?? process.env.PATH ?? '',
      onSessionStateChange: value => service?.sessionStateChanged(value.sessionId, value.state),
      onOutput: (id, bytes) => { output = (output + Buffer.from(bytes).toString()).slice(-20000); service?.sessionOutput(id, bytes) }
    })
    const input = manager.writeToSession.bind(manager)
    manager.writeToSession = (id, bytes) => { writes.push(Buffer.from(bytes).toString()); input(id, bytes) }
    const stub = join(root, 'stub.py')
    const candidateCli = join(repo, 'apps/desktop/bin/bmn')
    writeFileSync(stub, `import json, os, shutil, signal, subprocess, sys
assert os.path.realpath(shutil.which('bmn')) == os.path.realpath(sys.argv[2]), 'candidate CLI mismatch'
subprocess.run(['bmn', 'hook', 'codex'], input=json.dumps({'hook_event_name':'SessionStart','source':'startup','session_id':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}), text=True, check=True)
choices=json.dumps({'options':[{'label':'Wait','description':None},{'label':'Proceed','description':None}]})
for key in ['positive','retained']:
    subprocess.run(['bmn','ask',key,'Synthetic decision','--kind','question','--choices-json',choices], check=True, stdout=subprocess.DEVNULL)
print('STUB_READY', flush=True)
for line in sys.stdin:
    if 'TRANSITION_NOW' in line:
        if sys.argv[1]=='suspend':
            os.kill(os.getpid(), signal.SIGTSTP)
        elif sys.argv[1]=='replace':
            os.execl('/bin/sleep','sleep','30')
        break
`)
    try {
      await database.initialize()
      service = new CompanionService({ database, manager, roots: { config: join(root, 'config'), data: join(root, 'data'), state: join(root, 'state'), runtime: join(root, 'runtime') },
        cliPath: candidateCli, home: join(root, 'home'), emit: () => {}, pageAfterMs: 600000 })
      await service.start()
      identity = await manager.create({ workspaceId: DEFAULT_WORKSPACE_ID, name: 'Synthetic foreground', cwd: root,
        executable: transition === 'direct-exit' ? '/usr/bin/python3' : '/bin/bash',
        argv: transition === 'direct-exit' ? [stub, 'exit', candidateCli] : ['--noprofile', '--norc', '-i'], cols: 100, rows: 30, backgroundChoice: 'stop' })
      const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
      if (transition !== 'direct-exit') input(identity.sessionId, Buffer.from(
        ['/usr/bin/python3', stub, transition, candidateCli].map(quote).join(' ') + "; printf '\\nSTUB_RETURNED\\n'\r"))
      try { await waitFor(() => /(?:^|[\r\n])STUB_READY\r?\n/.test(output)) }
      catch { throw new Error(`Synthetic startup output: ${JSON.stringify(output.slice(-4000))}`) }
      const terminalStat = readFileSync(`/proc/${ptyPid}/stat`, 'utf8')
      foregroundPid = Number(terminalStat.slice(terminalStat.lastIndexOf(')') + 2).split(' ')[5])
      const records = await database.companion('listAttention')
      const positive = records.find(row => row.requestKey === 'positive')!
      const retained = records.find(row => row.requestKey === 'retained')!
      expect(positive.producer).toMatchObject({ agentCli: 'codex' })
      const answer = (record: AttentionRecord) => service!.answerAttention({ requestId: record.requestId, revision: record.revision,
        incarnationId: identity!.incarnationId, epoch: -1, answer: { type: 'choices', choices: [0] } })
      expect(await answer(positive)).toMatchObject({ state: 'submitted' })
      expect(writes).toHaveLength(1)
      input(identity.sessionId, Buffer.from('TRANSITION_NOW\r'))
      if (transition === 'replace') {
        await waitFor(() => {
          const stat = readFileSync(`/proc/${ptyPid}/stat`, 'utf8')
          const group = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[5]
          try { return readFileSync(`/proc/${group}/comm`, 'utf8').trim() === 'sleep' } catch { return false }
        })
      } else if (transition === 'direct-exit') await waitFor(() => manager.liveIncarnationId(identity!.sessionId) === undefined)
      else await waitFor(() => output.includes(transition === 'exit' ? '\r\nSTUB_RETURNED\r\n' : 'Stopped'))
      expect(manager.liveIncarnationId(identity.sessionId)).toBe(transition === 'direct-exit' ? undefined : identity.incarnationId)
      expect(await answer(retained)).toMatchObject({ state: 'refused' })
      expect(writes).toHaveLength(1)
      expect(await service.answerability(retained)).toMatchObject({ answerable: false })
      if (transition !== 'direct-exit') expect(await database.companion('getAttention', retained.requestId)).toMatchObject({ state: 'open', revision: retained.revision })
    } finally {
      if (foregroundPid && foregroundPid !== ptyPid) {
        try { if (readlinkSync(`/proc/${foregroundPid}/cwd`) === root) process.kill(-foregroundPid, 'SIGKILL') } catch { /* Already exited. */ }
      }
      if (identity) await manager.stop(identity).catch(() => undefined)
      await service?.close()
      await database.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
