// MODULE: departure-qa-fixture.mjs - local synthetic sessions for Epic 130 bench UI checks, never a native-model proof
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { readCredentials, call } from '../../apps/desktop/bin/bmn-commands.mjs'

const taskRoot = dirname(process.env.HOME ?? '')
if (!readFileSync(join(taskRoot, '.bmn-qa-run'), 'utf8').trim() || resolve(process.cwd()) !== join(taskRoot, 'synthetic-project')) throw Error('Use only the isolated bench fixture folder')
for (const name of ['BMN_CONFIG_HOME', 'BMN_DATA_HOME', 'BMN_STATE_HOME', 'BMN_RUNTIME_HOME']) {
  if (!process.env[name]?.startsWith(`${taskRoot}/`)) throw Error('Use only isolated bench roots')
}
const sessionId = process.env.BMN_SESSION_ID
if (!sessionId) throw Error('Start the synthetic fixture through the bench session UI')
const mode = process.argv[2] ?? 'request'
if (!['request', 'nothing', 'no-answer', 'not-told', 'revise', 'late'].includes(mode)) throw Error('Unknown fixed synthetic mode')
const label = process.argv[3] ?? 'QA builder'
const socket = join(process.env.BMN_RUNTIME_HOME, 'control/control.sock')
const session = readCredentials({ socket })
const sessionCall = (method, params) => call(session.socketPath, session.token, method, params)
const conversation = randomUUID()
await sessionCall('hook.observe', { agent: 'claude', event: 'Stop', conversation, effects: [] })
const runId = `qa-${sessionId}`
const terms = proposed => [
  { id: 'rounds', kind: 'rounds', proposed, reason: 'Synthetic review boundaries for the list check.' },
  { id: 'long', kind: 'command', command: `git log --format=${'x'.repeat(1000 - 'git log --format='.length)}`, folder: process.cwd(), count: 1, script: null, proposed: 'yes', reason: 'Display the complete synthetic command; the fixture never runs it.' }
]
const ask = async proposed => sessionCall('grant.ask', { runId, card: mode === 'nothing'
  ? { title: label, scope: 'Only synthetic documentation remains.', nothing: true }
  : { title: label, scope: 'Synthetic list review only.', nothing: false, terms: terms(proposed) } })
let periodId = null
let running = false
const tick = async () => {
  if (running) return
  running = true
  try {
    const status = await sessionCall('grant.status', {})
    if (status.departure?.state !== 'leaving' || status.departure.periodId === periodId) return
    periodId = status.departure.periodId
    if (mode === 'not-told') return
    const notice = await sessionCall('hook.observe', { agent: 'claude', event: 'PostToolUse', conversation, effects: [] })
    if (!notice.grantNotice) throw Error('The fixture was not handed the departure notice')
    if (mode === 'no-answer') return
    if (mode === 'late') { setTimeout(() => { void ask(3).catch(() => console.error('Late synthetic answer was refused')) }, 185_000); return }
    await ask(3)
    if (mode === 'revise') setTimeout(() => { void ask(2).catch(() => console.error('Revised synthetic answer was refused')) }, 12_000)
    console.log('Synthetic departure response recorded')
  } catch (error) { console.error(`Synthetic fixture operation failed: ${error instanceof Error ? error.message : 'unknown error'}; no native-model evidence`) }
  finally { running = false }
}
setInterval(() => { void tick() }, 500)
console.log(`Synthetic ${mode} fixture ready. No model runs; no command executes; no owner answer is sent.`)
