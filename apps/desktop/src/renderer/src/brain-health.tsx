// MODULE: brain-health.tsx - Brain backup, export and recovery alerts on the existing Health page
import type { RulesSnapshot } from '@bmn/protocol'

export function brainHealthAttention(brain: RulesSnapshot['brain']): Array<[string, number]> {
  if (!brain) return []
  const count = Number(brain.backup !== 'ok') + Number(brain.export !== 'ok') + Number(brain.recovery === 'failed')
  return count ? [['Brain', count]] : []
}

export function BrainHealth({ brain }: { brain: RulesSnapshot['brain'] }): React.JSX.Element | null {
  if (!brain || !brainHealthAttention(brain).length) return null
  return (
    <section className="preferences-section" aria-label="Brain health">
      <h4 className="group-head">Brain</h4>
      {brain.recovery === 'failed' ? <p className="preferences-error" role="alert">The brain switch needs a recovery check. Ask an agent to inspect it.</p> : null}
      {brain.backup !== 'ok' ? <p className="preferences-error" role="alert">Brain backup {brain.backup === 'failed' ? 'failed' : 'has not been verified'}. Check free space and backup-folder permissions.</p> : null}
      {brain.export !== 'ok' ? <p className="preferences-error" role="alert">Brain export {brain.export === 'failed' ? 'failed' : 'has not been verified'}. Saved note history remains in the brain database.</p> : null}
    </section>
  )
}
