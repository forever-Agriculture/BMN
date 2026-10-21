// MODULE: setup-app-view.ts - Shared Setup/Health readiness words and the measured Codex trust step
import type { SessionRecord, SetupAppReadiness } from '@bmn/protocol'

export function setupAppView(row: SetupAppReadiness, session?: SessionRecord): { head: string; lines: string[] } {
  const trustLines: string[] = []
  if (row.app === 'codex' && row.hookTrust === 'pending') trustLines.push('Approve BMN’s hooks with /hooks, then start a normal Codex session in BMN. This stays pending until BMN observes a hook.')
  if (row.app === 'codex' && row.hookTrust === 'unavailable') trustLines.push('Hook observation is unavailable. Open /hooks in Codex to check BMN’s hooks.')
  if (row.app === 'codex' && row.hookTrust === 'observed') trustLines.push('BMN hook observed')
  if (session?.lastProcess?.state === 'live') return {
    head: session.setup?.action === 'install' ? 'Installing…' : session.setup?.action === 'login' ? 'Signing in…' : 'Finish in the session', lines: trustLines
  }
  if (row.signIn === 'missing') return { head: 'Not installed', lines: [] }
  const ready = row.signIn === 'ready' || row.signIn === 'confirmed'
  const lines = [row.signIn === 'ready' ? 'Signed in' : row.signIn === 'confirmed' ? 'Confirmed by you'
    : row.signIn === 'signed-out' ? 'Not signed in' : 'Sign-in unknown']
  if (row.qualification === 'checking') lines.push('Checking this version…')
  lines.push(...trustLines)
  return { head: ready ? 'Ready' : 'Installed', lines }
}

export function setupAppNeedsAction(row: SetupAppReadiness, session?: SessionRecord): boolean {
  return row.signIn !== 'ready' && row.signIn !== 'confirmed' || session?.lastProcess?.state === 'live' ||
    row.app === 'codex' && (row.hookTrust === 'pending' || row.hookTrust === 'unavailable')
}
