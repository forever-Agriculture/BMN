// MODULE: rules-preferences.tsx - Epic 60.6: Preferences → Rules: the master editor, per-harness preview, health, install, restore, revert and probe
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ROSTER_HARNESSES,
  type RosterHarness,
  type RulesMasterPlan,
  type RulesOutcome,
  type RulesPlan,
  type RulesProbeView,
  type RulesRenderingView,
  type RulesSnapshot,
  type RulesTargetState
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Segmented } from './history-preferences'

const PLAN_DELAY_MS = 300
const cap = <Word extends string>(word: Word): string => word.charAt(0).toUpperCase() + word.slice(1)
const when = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown time')

export function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** Added and removed line counts of a unified diff, headers excluded. */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

export const STATE_WORDS: Readonly<Record<RulesTargetState, string>> = {
  current: 'Current',
  stale: 'Stale: install to update',
  'edited-outside': 'Edited outside BMN',
  unmanaged: 'Not written by BMN',
  link: 'A link; install replaces the link',
  missing: 'Not installed',
  unreadable: 'Cannot be read'
}

export const PROBE_WORDS: Readonly<Record<NonNullable<RulesProbeView['outcome']>, string>> = {
  pass: 'Passed: the agent read these rules',
  fail: 'Failed: the agent did not read these rules',
  inconclusive: 'Inconclusive: no proof either way',
  unavailable: 'Unavailable on this route'
}

export function probeLine(probe: RulesProbeView | undefined): string {
  if (!probe || probe.outcome === null) return 'Never probed'
  return `${PROBE_WORDS[probe.outcome]} · ${when(probe.at)}${probe.stale ? ' · stale' : ''}`
}

type Pending =
  | { kind: 'save'; plan: RulesMasterPlan }
  | { kind: 'install'; plan: RulesPlan }
  | { kind: 'restore'; transaction: string | null; plan: RulesPlan | null }
  | { kind: 'revert'; revision: number | null; plan: { ok: boolean; diff: string; expectedHash: string | null; text?: string; message?: string } | null }
  | { kind: 'probe'; harness: RosterHarness }

/** A vertical list of choices with radio semantics: arrow keys move, the chosen row is the raised plate. */
function ChoiceList<Value extends string | number>(props: {
  label: string
  options: readonly { value: Value; text: string; disabled?: boolean }[]
  value: Value | null
  onChange(value: Value): void
}): React.JSX.Element {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = props.options.filter((option) => !option.disabled)
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0 || enabled.length === 0) return
    event.preventDefault()
    const index = enabled.findIndex((option) => option.value === props.value)
    const next = enabled[(index + step + enabled.length) % enabled.length] as (typeof enabled)[number]
    props.onChange(next.value)
    buttons.current[props.options.indexOf(next)]?.focus()
  }
  const focusable = props.value ?? enabled[0]?.value
  return (
    <div className="choice-list" role="radiogroup" aria-label={props.label} onKeyDown={move}>
      {props.options.map((option, index) => (
        <button key={String(option.value)} ref={(element) => { buttons.current[index] = element }} type="button" role="radio"
          aria-checked={option.value === props.value} tabIndex={option.value === focusable ? 0 : -1} disabled={option.disabled}
          onClick={() => props.onChange(option.value)}>{option.text}</button>
      ))}
    </div>
  )
}

/** The health table: state, restriction, last probe, and the Probe plate (High routes only). */
export function RulesHealth(props: {
  snapshot: RulesSnapshot
  renderings: readonly RulesRenderingView[]
  disabled: boolean
  onProbe(harness: RosterHarness): void
}): React.JSX.Element {
  const health = props.snapshot.health
  if (health.state === 'failed') return <p className="preferences-error" role="alert">{health.reason}</p>
  return (
    <dl className="rules-health" aria-label="Rules health">
      {health.targets.map((target) => {
        const probe = props.snapshot.probes.find((entry) => entry.harness === target.harness)
        const restricted = props.renderings.find((rendering) => rendering.harness === target.harness)?.restricted ?? target.restricted
        return (
          <div key={target.harness} className="rules-target" data-state={target.state}>
            <dt>{cap(target.harness)}</dt>
            <dd className="state">
              <span className={`status-dot${target.state === 'current' ? '' : ' needs-you'}`} aria-hidden="true" />
              <span title={target.reason || undefined}>{STATE_WORDS[target.state]}</span>
              {restricted ? <span className="roster-chip"><span>restricted</span></span> : null}
            </dd>
            <dd className="probe">{probeLine(probe)}</dd>
            <dd>
              <button type="button" className="small" disabled={props.disabled || restricted}
                title={restricted ? 'Probes run only for High routes' : undefined} aria-label={`Probe ${target.harness}`}
                onClick={() => props.onProbe(target.harness)}>Probe…</button>
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

export function RulesPreferences(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RulesSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftPlan, setDraftPlan] = useState<RulesMasterPlan | null>(null)
  const [previewHarness, setPreviewHarness] = useState<RosterHarness>('claude')
  const [pending, setPending] = useState<Pending | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const adopt = useCallback((next: RulesSnapshot): void => {
    setSnapshot(next)
    setDraft(next.master.text ?? '')
    setDraftPlan(null)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      adopt(await window.aiTerminal.rulesSnapshot())
      setLoadError(null)
    } catch (error) {
      setLoadError(failureDetail(error, 'Could not read the rules'))
    } finally {
      setBusy(false)
    }
  }, [adopt])

  useEffect(() => { void load() }, [load])

  const saved = snapshot?.master.text ?? ''
  const dirty = snapshot !== null && draft !== saved

  // A dirty draft is checked as a save would check it, and previewed with its own renderings.
  useEffect(() => {
    if (!dirty) {
      setDraftPlan(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      window.aiTerminal.planRulesMaster(draft)
        .then((plan) => { if (!cancelled) setDraftPlan(plan) })
        .catch(() => { if (!cancelled) setDraftPlan(null) })
    }, PLAN_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [draft, dirty])

  const renderings = dirty && draftPlan?.valid ? draftPlan.renderings : snapshot?.renderings ?? []
  const rendering = renderings.find((entry) => entry.harness === previewHarness)
  const renderErrors = dirty ? draftPlan?.errors ?? [] : snapshot?.master.errors ?? []

  function open(next: Pending): void {
    setResult(null)
    setPending(next)
  }

  async function begin(kind: Pending['kind'], harness?: RosterHarness): Promise<void> {
    setResult(null)
    try {
      if (kind === 'save') open({ kind, plan: await window.aiTerminal.planRulesMaster(draft) })
      else if (kind === 'install') open({ kind, plan: await window.aiTerminal.planRulesInstall() })
      else if (kind === 'restore') open({ kind, transaction: null, plan: null })
      else if (kind === 'revert') open({ kind, revision: null, plan: null })
      else if (harness) open({ kind: 'probe', harness })
    } catch (error) {
      setResult({ ok: false, text: failureDetail(error, 'Could not prepare that action') })
    }
  }

  async function chooseTransaction(transaction: string): Promise<void> {
    open({ kind: 'restore', transaction, plan: null })
    try {
      open({ kind: 'restore', transaction, plan: await window.aiTerminal.planRulesRestore(transaction) })
    } catch (error) {
      setResult({ ok: false, text: failureDetail(error, 'Could not plan the restore') })
    }
  }

  async function chooseRevision(revision: number): Promise<void> {
    open({ kind: 'revert', revision, plan: null })
    try {
      open({ kind: 'revert', revision, plan: await window.aiTerminal.planRulesRevertMaster(revision) })
    } catch (error) {
      setResult({ ok: false, text: failureDetail(error, 'Could not read that snapshot') })
    }
  }

  async function confirm(): Promise<void> {
    if (pending === null) return
    let run: (() => Promise<RulesOutcome>) | null = null
    if (pending.kind === 'save') run = () => window.aiTerminal.saveRulesMaster(draft, pending.plan.expectedHash)
    else if (pending.kind === 'install' && pending.plan.planHash) {
      const planHash = pending.plan.planHash
      run = () => window.aiTerminal.installRules(planHash)
    } else if (pending.kind === 'restore' && pending.transaction && pending.plan?.planHash) {
      const { transaction } = pending
      const planHash = pending.plan.planHash
      run = () => window.aiTerminal.restoreRules(transaction, planHash)
    } else if (pending.kind === 'revert' && pending.plan?.ok && pending.plan.text !== undefined) {
      const { text, expectedHash } = pending.plan
      run = () => window.aiTerminal.saveRulesMaster(text, expectedHash)
    } else if (pending.kind === 'probe') {
      const { harness } = pending
      run = () => window.aiTerminal.probeRules(harness)
    }
    if (run === null) return
    setBusy(true)
    try {
      const outcome = await run()
      adopt(outcome.snapshot)
      const text = outcome.ok ? outcome.message
        : outcome.code === 'REVISION_CONFLICT'
          ? `Something changed since this was shown (${outcome.message}); reloaded without writing.` : outcome.message
      setResult({ ok: outcome.ok, text })
      setPending(null)
    } catch (error) {
      setResult({ ok: false, text: failureDetail(error, 'The rules action failed') })
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || pending === null) return
    event.preventDefault()
    event.stopPropagation()
    setPending(null)
  }

  const sentence = (): string => {
    if (pending === null) return ''
    switch (pending.kind) {
      case 'save': {
        const counts = diffCounts(pending.plan.diff)
        return pending.plan.valid
          ? `Save the master (+${counts.added} −${counts.removed}) and keep the earlier text as a source snapshot. A change made meanwhile refuses; nothing installs.`
          : 'This master would not render, so it cannot be saved.'
      }
      case 'install': {
        if (!pending.plan.ok) return pending.plan.message ?? 'Install cannot run now.'
        const writes = pending.plan.targets
        if (writes.length === 0) return 'Every target already holds its current rendering.'
        const links = writes.filter((target) => target.change === 'link').length
        const outside = writes.filter((target) => target.change === 'edited-outside' || target.change === 'unmanaged').length
        return `Install into ${writes.length} target${writes.length === 1 ? '' : 's'} in one transaction`
          + `${links ? `; ${links} replace${links === 1 ? 's' : ''} a link` : ''}${outside ? `; ${outside} replace${outside === 1 ? 's' : ''} an outside edit` : ''}.`
          + ' Each file can be restored from this transaction.'
      }
      case 'restore':
        return pending.plan && !pending.plan.ok ? pending.plan.message ?? 'That transaction cannot be restored.'
          : 'Put each file back as it was before the chosen install. Choose a transaction:'
      case 'revert':
        return pending.plan && !pending.plan.ok ? pending.plan.message ?? 'That snapshot cannot be read.'
          : 'Replace the master with an earlier source snapshot; the current text is kept as a new snapshot and nothing installs. Choose one:'
      case 'probe':
        return `Sends the rendered rules to ${pending.harness}'s provider and asks the agent which rules it read. Runs only for High routes; the answer is passed, failed, inconclusive or unavailable.`
    }
  }

  const ready = pending !== null && !busy && (
    pending.kind === 'save' ? pending.plan.valid && pending.plan.diff !== ''
      : pending.kind === 'install' ? pending.plan.ok && pending.plan.planHash !== null && pending.plan.targets.length > 0
        : pending.kind === 'restore' ? !!pending.plan?.ok && !!pending.plan.planHash
          : pending.kind === 'revert' ? !!pending.plan?.ok
            : true)
  const confirmLabel = pending === null ? '' : { save: 'Save master', install: 'Install', restore: 'Restore', revert: 'Revert master', probe: 'Send probe' }[pending.kind]
  const planTargets = pending?.kind === 'install' ? pending.plan.targets : pending?.kind === 'restore' ? pending.plan?.targets ?? [] : []
  const diffText = pending?.kind === 'save' ? pending.plan.diff : pending?.kind === 'revert' ? pending.plan?.diff ?? '' : ''

  return (
    <section className="preferences-section rules-section" aria-labelledby="rules-head" onKeyDown={onKeyDown}>
      <div className="preferences-section-head">
        <h3 id="rules-head">Rules</h3>
        <span className="meta">
          {snapshot && !snapshot.master.exists ? 'No master yet' : ''}
          <button type="button" className="small" disabled={busy} onClick={() => void load()}>{busy && !pending ? 'Checking…' : 'Check'}</button>
        </span>
      </div>
      {result ? <p className={result.ok ? 'preferences-success' : 'preferences-error'} role={result.ok ? 'status' : 'alert'}>{result.text}</p> : null}
      {loadError ? <p className="preferences-error" role="alert">{loadError}</p> : null}
      {snapshot === null && loadError === null ? <p className="preferences-help">Loading…</p> : null}
      {snapshot ? (
        <>
          <h4 className="preferences-subhead">Health</h4>
          <RulesHealth snapshot={snapshot} renderings={renderings} disabled={busy} onProbe={(harness) => void begin('probe', harness)} />
          <p className="preferences-help">
            {snapshot.health.state === 'checked' ? `Checked ${when(snapshot.health.checkedAt)} · a snapshot of each agent's file. ` : ''}
            A probe sends the rules to that harness's provider and runs only for High routes.
          </p>
          <div className="preferences-button-row rules-actions">
            <button type="button" disabled={busy || !snapshot.master.exists || dirty} title={dirty ? 'Save or discard the master first' : undefined}
              onClick={() => void begin('install')}>Install…</button>
            <button type="button" disabled={busy || snapshot.transactions.length === 0} onClick={() => void begin('restore')}>Restore…</button>
          </div>

          <h4 className="preferences-subhead" id="rules-master-head">Master</h4>
          <div className="rules-editor-head">
            <span className="meta">{kilobytes(new TextEncoder().encode(draft).length)} · {lineCount(draft)} lines{dirty ? ' · unsaved' : ''}</span>
            <span className="chip-row" aria-label="Markers">
              <span className="roster-chip"><code>{'<!-- bmn:harness claude codex -->'}</code></span>
              <span className="roster-chip"><code>{'<!-- bmn:shareable -->'}</code></span>
              <span className="roster-chip"><code>{'<!-- bmn:team -->'}</code></span>
            </span>
          </div>
          <textarea className="rules-master" aria-labelledby="rules-master-head" value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
          <p className="preferences-help">Harness blocks reach only the harnesses they name; shareable blocks survive restriction for Low routes; one team marker expands to the approved team.</p>
          {renderErrors.length > 0 ? (
            <div className="preferences-error" role="alert">
              <p>This master would not render:</p>
              <ul>{renderErrors.map((issue, index) => <li key={index}>{issue.line ? `Line ${issue.line}: ` : ''}{issue.message}</li>)}</ul>
            </div>
          ) : null}
          <div className="preferences-button-row">
            <button type="button" className="primary" disabled={busy || !dirty || renderErrors.length > 0} onClick={() => void begin('save')}>Save…</button>
            <button type="button" disabled={busy || !dirty} onClick={() => setDraft(saved)}>Discard</button>
          </div>

          <h4 className="preferences-subhead" id="rules-preview-head">Preview{dirty ? ' of the unsaved master' : ''}</h4>
          <Segmented<RosterHarness> labelledBy="rules-preview-head" options={ROSTER_HARNESSES} value={previewHarness} optionLabel={cap} onChange={setPreviewHarness} />
          {rendering ? (
            <>
              <p className="preferences-help rules-preview-meta">
                {rendering.restricted ? `Restricted (${rendering.reason})` : 'Full'} · {kilobytes(rendering.bytes)} · Team {rendering.teamForm}
              </p>
              <pre className="rules-preview" tabIndex={0} aria-label={`Rendering for ${previewHarness}`}>{rendering.text}</pre>
            </>
          ) : <p className="preferences-help">{snapshot.master.exists ? 'No rendering while the master has errors.' : 'Write a master to see each rendering.'}</p>}
        </>
      ) : null}

      {pending ? (
        <div className="rules-confirm" role="region" aria-live="polite" aria-label="Pending rules action">
          <div className="confirm-head"><span className="status-dot needs-you" aria-hidden="true" /><p>{sentence()}</p></div>
          {pending.kind === 'restore' && snapshot ? (
            <ChoiceList label="Install transactions" value={pending.transaction}
              options={snapshot.transactions.map((entry) => ({
                value: entry.id, disabled: !entry.valid,
                text: `${when(entry.createdAt)} · ${(entry.targets ?? []).join(', ') || 'no targets'}${entry.state ? ` · ${entry.state}` : ''}${entry.valid ? '' : ' · damaged'}`
              }))}
              onChange={(id) => void chooseTransaction(id)} />
          ) : null}
          {pending.kind === 'revert' && snapshot?.history ? (
            <ChoiceList label="Master snapshots" value={pending.revision}
              options={[...snapshot.history].reverse().map((entry) => ({
                value: entry.revision, disabled: !entry.intact,
                text: `${when(entry.at)} · ${kilobytes(entry.bytes)} · ${entry.reason}${entry.intact ? '' : ' · damaged'}`
              }))}
              onChange={(revision) => void chooseRevision(revision)} />
          ) : null}
          {planTargets.map((target) => {
            const counts = diffCounts(target.diff)
            return (
              <details key={target.path}>
                <summary>{target.path} · {pending.kind === 'restore' ? `becomes ${target.kind}` : target.kind}{pending.kind === 'install' && target.linkTarget ? ` (→ ${target.linkTarget})` : ''}{target.restricted ? ' · restricted' : ''} · +{counts.added} −{counts.removed}</summary>
                <pre className="rules-preview">{target.diff || 'No change.'}</pre>
              </details>
            )
          })}
          {diffText ? (
            <details open>
              <summary>Master · +{diffCounts(diffText).added} −{diffCounts(diffText).removed}</summary>
              <pre className="rules-preview">{diffText}</pre>
            </details>
          ) : null}
          <div className="confirm-actions">
            <button type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
            <button type="button" className="primary" disabled={!ready} onClick={() => void confirm()}>{busy ? 'Working…' : confirmLabel}</button>
          </div>
        </div>
      ) : null}

      {snapshot ? (
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="advanced-body">
            <div className="preferences-button-row">
              <button type="button" disabled={busy || !snapshot.history || snapshot.history.length === 0} onClick={() => void begin('revert')}>Revert master…</button>
            </div>
            <p>Every save keeps the earlier master as a source snapshot. Sessions already running keep the rules they started with.</p>
            <div className="preferences-row">
              <div className="preferences-row-label"><span>Master</span></div>
              <div className="preferences-row-control"><code className="preferences-mono preferences-path" title={snapshot.masterPath}><bdi>{snapshot.masterPath}</bdi></code></div>
            </div>
            {snapshot.health.state === 'checked' ? snapshot.health.targets.map((target) => (
              <div key={target.harness} className="preferences-row">
                <div className="preferences-row-label"><span>{cap(target.harness)}</span></div>
                <div className="preferences-row-control"><code className="preferences-mono preferences-path" title={target.path}><bdi>{target.path}</bdi></code></div>
              </div>
            )) : null}
          </div>
        </details>
      ) : null}
    </section>
  )
}
