// MODULE: push-policy-health.tsx - Health › Pushes and merges (Story 83.3): allow or deny each owner, and each repository's level
import { useEffect, useRef, useState } from 'react'
import { PUSH_LEVELS, PUSH_LEVEL_WORDS, type PushLevel, type PushPolicyChange, type PushPolicyOwnerView, type PushPolicyView } from '@bmn/protocol'
import { Segmented } from './history-preferences'
import { Switch } from './team-preferences'
import { Dot } from './roster-marks'

const KIND_WORDS: Record<PushPolicyOwnerView['kind'], string> = { account: 'Account', organisation: 'Org', unknown: 'Owner' }

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/**
 * Fable's design, approved on the epic's card (2026-10-18): one row per owner the sessions work in, its switch at the row's end;
 * under an allowed owner one row per repository with its three-step level. Every change is the owner's own, against the
 * revision this view read; a change that lost the race reads the policy again and says so.
 */
export function PushPolicyHealth(): React.JSX.Element {
  const [view, setView] = useState<PushPolicyView | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The last view the store answered with, whose revision the next change is sent against; changes go one after another.
  const stored = useRef<PushPolicyView | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const show = (next: PushPolicyView): void => { stored.current = next; setView(next) }
  useEffect(() => {
    let live = true
    window.aiTerminal.getPushPolicy().then((next) => { if (live) show(next) }, (failure: unknown) => {
      if (live) setError(failure instanceof Error ? failure.message : 'The policy could not be read')
    })
    return () => { live = false }
  }, [])
  type Change = { kind: 'owner'; login: string; allowed: boolean } | { kind: 'level'; repository: string; level: PushLevel }
  // The row shows the change at once, so the arrow keys keep the focus on the step they chose; the store's answer replaces it.
  const change = (next: Change): void => {
    if (view === null || view.state !== 'read') return
    setError(null)
    setView((shown) => shown === null ? shown : { ...shown, owners: shown.owners.map((owner) => next.kind === 'owner'
      ? owner.login === next.login ? { ...owner, allowed: next.allowed } : owner
      : { ...owner, repositories: owner.repositories.map((repository) => repository.repository === next.repository ? { ...repository, level: next.level } : repository) }) })
    queue.current = queue.current.then(async () => {
      const current = stored.current
      if (current === null || current.state !== 'read') return
      const request: PushPolicyChange = { ...next, expectedRevision: current.revision }
      try {
        show(await window.aiTerminal.setPushPolicy(request))
      } catch (failure: unknown) {
        setError(failure instanceof Error ? failure.message : 'The change was not saved')
        show(await window.aiTerminal.getPushPolicy().catch(() => current))
      }
    })
  }
  const inForce = view?.standing.authorizes === true
  return (
    <>
      <h4 className="group-head" id="health-push-policy">Pushes and merges<span className="caption">what your sessions may merge or push, by owner{inForce ? ' · in force' : ''}</span></h4>
      {view === null && error === null ? <p className="preferences-help">Reading…</p> : null}
      {view?.state === 'unknown' ? <p className="preferences-error" role="alert">The policy could not be read: {view.reason}. Everything counts as denied.</p> : null}
      {view?.state === 'read' && !inForce ? <p className="page-note" role="status"><Dot label="Not in force" />Not in force yet: {view.standing.why}.</p> : null}
      {error !== null ? <p className="preferences-error" role="alert">{error}</p> : null}
      {view?.owners.map((owner) => {
        const denied = !owner.allowed
        const count = owner.repositories.length
        return (
          <div key={owner.login} className="policy-owner-block">
            <div className="health-row policy-owner" data-allowed={owner.allowed}>
              <span><span className="mono">{owner.login}</span> <span className="muted">{KIND_WORDS[owner.kind]}</span></span>
              <span className="health-state">
                <span>{view.state === 'unknown' ? 'Unknown' : owner.allowed ? 'Allowed' : `Denied${count === 0 ? '' : ` · ${count} repositor${count === 1 ? 'y' : 'ies'}`}`}</span>
              </span>
              <Switch label={`Allow ${owner.login}`} on={owner.allowed} disabled={view.state !== 'read'}
                onChange={(allowed) => change({ kind: 'owner', login: owner.login, allowed })} />
            </div>
            {denied ? null : owner.repositories.map((repository) => {
              const id = `policy-${repository.repository.replace(/[^a-z0-9-]/g, '-')}`
              return (
                <div key={repository.repository} className="health-row policy-repository">
                  <span className="health-state">
                    <span id={id} className="mono">{repository.name}</span>
                    {repository.unread === null ? null : <span className="faint"><Dot label="Not read" />{sentence(repository.unread)}</span>}
                  </span>
                  {view.state === 'unknown' ? <span className="faint">unknown</span> : (
                    <Segmented<PushLevel> labelledBy={id} options={PUSH_LEVELS} value={repository.level} fit
                      disabled={repository.unread !== null}
                      optionLabel={(level) => PUSH_LEVEL_WORDS[level]}
                      onChange={(level) => change({ kind: 'level', repository: repository.repository, level })} />
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
      <p className="preferences-help">The list is the owners and repositories your sessions work in. Each owner starts denied; each repository starts at PRs only.</p>
    </>
  )
}
