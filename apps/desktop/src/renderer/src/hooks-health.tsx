// MODULE: hooks-health.tsx - Health › Hooks: what BMN's install at start found in each app's hook file, in words (Stories 75.9, 96.3, 96.6)
import { useContext } from 'react'
import { ROSTER_APP_NAMES, type HookAppAtStart, type HookLeftWhy, type HooksAtStart } from '@bmn/protocol'
import { SteadyOrderContext } from './health-order'
import { Dot } from './roster-marks'
import { displayPath } from './session-presentation'

/** Why BMN left a hook event as it is, in words (Story 75.9). */
const HOOK_LEFT_WORDS: Readonly<Record<HookLeftWhy, string>> = {
  gated: 'inside a matcher', changed: 'changed', foreign: 'not BMN\'s', unreadable: 'the file cannot be read', unparsable: 'the file is not valid JSON',
  unusable: 'not a hook file BMN can add to', numbers: 'holds a number BMN cannot write back unchanged', failed: 'could not be written'
}

/** One app's row in Health › Hooks: whether it needs him, its line, and the faint lines under it, one left entry per line. */
export function hookRowWords(app: HookAppAtStart): { needs: boolean; head: string; lines: string[] } {
  if (app.state === 'not-set-up') return { needs: false, head: 'Not set up on this computer', lines: [] }
  const count = app.placed.length
  const inPlace = `${count} entr${count === 1 ? 'y' : 'ies'} in place`
  const added = app.installed.length > 0 ? [`Added at start: ${app.installed.join(', ')}${app.harness === 'codex' ? ' · Codex asks you once, in /hooks, before it runs them' : ''}`] : []
  // A file upgraded on disk says nothing of what a running OpenCode loaded (Story 96.3): it is woken once its own events carry the new plugin's mark.
  const upgraded = (app.upgraded ?? []).length > 0 ? [`Upgraded at start: ${app.upgraded!.join(', ')} · a running OpenCode is woken only once it reports the new plugin`] : []
  // OpenCode's plugin left in an earlier release (BMN could not write beside it) cannot tell the owner's stop from a finished turn (Story 96.6).
  const obsolete = app.harness === 'opencode' && app.older.includes('plugin') && app.state === 'left'
  const olderNames = obsolete ? app.older.filter((name) => name !== 'plugin') : app.older
  const older = [
    ...(obsolete ? ['Older plugin · stopped turns cannot be distinguished. Automatic wake is unavailable for this session until a qualified plugin is loaded.'] : []),
    ...(olderNames.length === 0 ? [] : app.harness === 'opencode'
      ? [`OpenCode 1's plugin file is still there too · \`bmn hooks install opencode\` removes it`]
      : [`${olderNames.join(', ')} · in an older wording, which does the same and still runs`])
  ]
  const leftWords = (entry: HookAppAtStart['left'][number]): string => app.harness === 'opencode' && entry.event === 'plugin' && (entry.why === 'changed' || entry.why === 'foreign')
    ? `plugin · ${HOOK_LEFT_WORDS[entry.why]} · Not BMN's · BMN leaves it` : `${entry.event} · ${HOOK_LEFT_WORDS[entry.why]}`
  if (app.why !== undefined) return { needs: true, head: `The file · ${HOOK_LEFT_WORDS[app.why]} · left as it is`, lines: older }
  if (app.left.length === 0) return { needs: obsolete, head: inPlace, lines: [...added, ...upgraded, ...older] }
  return {
    needs: true, head: `${inPlace} · ${app.left.length === 1 ? 'one left as it is' : `${app.left.length} left as they are`}`,
    lines: [...app.left.map(leftWords), ...added, ...upgraded, ...older]
  }
}

/** "13:31": the time of day BMN checked something at start. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Health › Hooks (Story 75.9): what BMN's install at start found in each app's hook file, failure first; there is no button. */
export function HooksHealth(props: { hooks: HooksAtStart | null; home: string | null }): React.JSX.Element {
  const steady = useContext(SteadyOrderContext)
  const { hooks } = props
  return (
    <>
      <h4 className="group-head" id="health-hooks">Hooks<span className="caption">BMN's entries in each app's hook file, installed at start</span></h4>
      {hooks === null ? <p className="preferences-help">Not checked yet: BMN checks them each time it starts.</p>
        : hooks.state === 'failed' ? <p className="preferences-error" role="alert">{hooks.reason}</p>
          : steady('hooks', hooks.apps, (app) => hookRowWords(app).needs).map((app) => {
            const words = hookRowWords(app)
            return (
              <div key={app.harness} className="health-row" data-hooks={words.needs ? 'left' : 'in-place'}>
                <span>{ROSTER_APP_NAMES[app.harness]}</span>
                <span className="path mono" title={app.file}>{displayPath(app.file, props.home)}</span>
                <span className="health-state">
                  <span className={words.needs ? undefined : 'faint'}>{words.needs ? <Dot label="Needs you" /> : null}{words.head}</span>
                  {words.lines.map((line) => <span key={line} className="faint">{line}</span>)}
                </span>
                <span />
              </div>
            )
          })}
      {hooks === null ? null : (
        <>
          <p className="preferences-help">Checked at start, {clockTime(hooks.checkedAt)}. BMN adds an entry only where an event has none of its own.</p>
          <p className="preferences-help">An entry it did not write, a changed one, or one inside a matcher is left as it is.</p>
        </>
      )}
    </>
  )
}
