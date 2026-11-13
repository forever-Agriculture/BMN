// MODULE: update-restart-qa-fixture.mjs - Epic 125: the restart dialog's four states for renderer QA, through the real preload IPC envelope
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson } from '../qa/bench-lib.mjs'

export async function installRestartQaFixture(application, config) {
  const seedPath = join(config.run, 'bench/seed.json'), raw = readFileSync(seedPath)
  const seed = JSON.parse(raw)
  if (seed.kind !== 'update-restart-v2') throw new Error('Unknown restart QA seed kind')
  if (Object.keys(seed).sort().join(',') !== 'id,kind' || seed.id !== 'epic-125-restart-states') throw new Error('Invalid fixed restart QA seed')
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
  if (sha256(raw) !== config.qaInput.fixture.seedSha256) throw new Error('Restart QA seed changed after reservation')
  if (sha256(readFileSync(import.meta.filename)) !== config.qaInput.fixture.adapterSha256) throw new Error('Restart QA adapter changed after reservation')
  const applied = { version: 1, runId: config.runId, candidateSha256: config.candidateSha256,
    seedSha256: sha256(raw), adapterSha256: sha256(readFileSync(import.meta.filename)), scope: 'restart dialog states with substituted IPC' }
  atomicJson(join(config.run, 'bench/restart-adapter.json'), applied)
  await application.evaluate(({ ipcMain }, binding) => {
    const build = '1234567890abcdef', closesAt = new Date(2026, 10, 13, 14, 37).getTime()
    const member = (sessionId, name, agent, over) => ({ sessionId, incarnationId: `run-${sessionId}`, name, workspace: 'QA review', agent,
      conversation: `conversation-${sessionId}`, atPress: 'working', ready: false, notice: 'queued', claim: `claim-${sessionId}`, printedAt: null, atClose: null,
      stop: 'pending', capture: 'pending', resume: 'pending', resumedIncarnation: null, tell: 'unnecessary', tellUntil: null, reason: null, ...over })
    let run = null, show = false, sequence = 0
    // One row per state of the waiting dialog: the notice printed, not told yet (state not known), and ready at the press.
    const members = [member('fixture-claude', 'Epic 114', 'claude', { notice: 'printed', printedAt: '2026-11-13T12:32:05Z' }),
      member('fixture-codex', 'Epic 118', 'codex', { atPress: 'unknown' }), member('fixture-codex-stopped', 'Epic 119', 'codex', { notice: 'printed', ready: true }),
      member('fixture-idle', 'Pet-128', 'claude', { atPress: 'ended', ready: true, notice: 'none' })]
    const each = change => { for (const m of run.members) Object.assign(m, change[m.sessionId]) }
    globalThis.bmnRestartQa = { binding, transitions: [] }
    ipcMain.removeHandler('aiterm:app:update-restart')
    ipcMain.handle('aiterm:app:update-restart', (_event, op) => {
      if (!['status', 'recover', 'begin', 'cancel', 'now', 'dismiss'].includes(op)) return { ok: false, error: { message: 'Unknown fixed fixture action' } }
      if (op === 'begin') { run = { version: 2, revision: 1, id: `${binding.runId}-restart-${++sequence}`, build, startedAt: '2026-11-13T12:32:00Z', closesAt, phase: 'waiting', openedBuild: null, members: structuredClone(members) }; show = true }
      // Cancel: the Claude Code session is told at its next tool call; the two Codex sessions are never typed into and are listed.
      if (op === 'cancel' && run) { run.phase = 'cancelled'; each({ 'fixture-claude': { tell: 'pending' }, 'fixture-codex': { tell: 'not-told', notice: 'withdrawn' }, 'fixture-codex-stopped': { tell: 'not-told' } }) }
      if (op === 'now' && run) {
        run.phase = 'complete'; run.openedBuild = build
        for (const m of run.members) Object.assign(m, { stop: 'confirmed', capture: 'saved', resume: 'resumed', resumedIncarnation: `resumed-${m.sessionId}`, atClose: m.ready ? 'ready' : 'not-ready' })
        each({ 'fixture-claude': { tell: 'told' }, 'fixture-codex': { tell: 'not-told' }, 'fixture-codex-stopped': { tell: 'not-told' } })
      }
      if (op === 'dismiss') { run = null; show = false }
      globalThis.bmnRestartQa.transitions.push({ op, phase: run?.phase ?? 'preview' })
      return { ok: true, result: { waitingBuild: build, run: structuredClone(run), sessions: structuredClone(members), reportedCohort: null, recovered: [], show } }
    })
  }, applied)
}
