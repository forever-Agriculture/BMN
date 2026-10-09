// MODULE: agents-preferences.tsx - Epic 60.5: Preferences → Agents: the roster as solid rows, staged edits, one grouped diff, approval and history
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ROSTER_AUTHORITIES,
  ROSTER_EFFORTS,
  ROSTER_HARNESSES,
  ROSTER_THEN,
  type AgentsOutcome,
  type AgentsPreview,
  type AgentsShownRevision,
  type AgentsSnapshot,
  type RosterAgentShape,
  type RosterDataShape,
  type RosterEffort,
  type RosterHarness,
  type RosterIssueShape,
  type RosterRoleShape,
  type RosterRouteShape,
  type RouteInspectionView,
  type WorkspaceLabelView
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Segmented } from './history-preferences'
import { Pips, PipsShape, Seal, SealShape, Sigil } from './roster-marks'
import {
  acceptVersion,
  agentGroups,
  groupDifferences,
  hostKind,
  moveCandidate,
  parseCandidate,
  sameData,
  setDefaultLabel,
  setLabel,
  setRecheck,
  setRoleThen,
  setSmallEpic,
  summarize,
  toggleAgentRole,
  toggleCandidateEffort,
  updateAgent,
  updateRoute,
  type AgentPatch,
  type DiffGroup
} from './roster-staging'

const PREVIEW_DELAY_MS = 250
const cap = <Word extends string>(word: Word): string => word.charAt(0).toUpperCase() + word.slice(1)
const when = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown time')

/** The one row a label and control column make, with optional one-line help (Story 40.3 rows). */
function Row(props: { id: string; label: string; help?: string | undefined; children: ReactNode }): React.JSX.Element {
  return (
    <div className="preferences-row">
      <div className="preferences-row-label"><span id={props.id}>{props.label}</span></div>
      <div className="preferences-row-control">{props.children}{props.help ? <p className="preferences-help">{props.help}</p> : null}</div>
    </div>
  )
}

/** Shared diff anatomy: the confirm band, the outside-difference rows and an opened generation. */
export function DiffGroups(props: { groups: readonly DiffGroup[] }): React.JSX.Element {
  return (
    <ul className="diff-groups">
      {props.groups.map((group) => (
        <li key={group.key}>
          {group.subject ? <div className="diff-group-head">{group.agent ? <Sigil title={group.agent.title} /> : null}{group.subject}</div> : null}
          <dl className="diff-lines">
            {group.lines.map((line, index) => (
              <Fragment key={`${line.field}-${index}`}>
                <dt>{line.field}</dt>
                <dd><del>{line.before}</del> <span aria-hidden="true">▸</span><span className="visually-hidden">becomes</span> <ins>{line.after}</ins></dd>
              </Fragment>
            ))}
          </dl>
          {group.consequences.map((sentence) => <p key={sentence} className="diff-consequence">{cap(sentence)}.</p>)}
        </li>
      ))}
    </ul>
  )
}

function Issues(props: { issues: readonly RosterIssueShape[] }): React.JSX.Element | null {
  if (props.issues.length === 0) return null
  return (
    <div className="preferences-error" role="alert">
      <p>The roster would not be valid:</p>
      <ul>{props.issues.map((issue, index) => <li key={index}>{issue.code}{issue.line ? ` (line ${issue.line})` : ''}: {issue.message}</li>)}</ul>
    </div>
  )
}

/** The collapsed summary line: sigil, name, harness and model, seal, pips, authority, then the switch or Activate. */
export function AgentSummary(props: {
  agent: RosterAgentShape
  open: boolean
  disabled?: boolean | undefined
  onToggleOpen(): void
  onEnabled(enabled: boolean): void
  onActivate(): void
}): React.JSX.Element {
  const agent = props.agent
  const editorId = `agent-${agent.id}-editor`
  return (
    <div className="agent-summary">
      <button type="button" className="agent-open" aria-expanded={props.open} aria-controls={editorId}
        aria-label={`${agent.name}: ${agent.title}, ${agent.harness} ${agent.model}, security ${agent.security}, trust ${agent.trust} of 3, ${agent.authority}`}
        onClick={props.onToggleOpen}>
        <Sigil title={agent.title} />
        <span className="agent-name">{agent.name}</span>
        <span className="agent-model" title={`${agent.harness} · ${agent.model}`}>{agent.harness} · {agent.model}</span>
        <Seal level={agent.security} />
        <Pips count={agent.trust} />
        <span className="agent-authority">{agent.authority}</span>
      </button>
      {agent.status === 'proposed'
        ? <button type="button" className="small" disabled={props.disabled} onClick={props.onActivate}>Activate</button>
        : <button type="button" role="switch" className="switch" aria-checked={agent.enabled} aria-label={`${agent.name} enabled`}
            disabled={props.disabled} onClick={() => props.onEnabled(!agent.enabled)} />}
      {agent.status === 'active' && !agent.enabled && agent.enabled_note ? <span className="agent-note">{agent.enabled_note}</span> : null}
    </div>
  )
}

function TextField(props: { id: string; label: string; value: string; maxLength?: number; placeholder?: string; type?: 'text' | 'number'; onChange(value: string): void }): React.JSX.Element {
  return (
    <input id={props.id} type={props.type ?? 'text'} aria-label={props.label} value={props.value} maxLength={props.maxLength}
      placeholder={props.placeholder} spellCheck={false} onChange={(event) => props.onChange(event.target.value)} />
  )
}

function AgentEditor(props: {
  agent: RosterAgentShape
  roles: readonly RosterRoleShape[]
  opinion: string
  opinionBusy: boolean
  onPatch(patch: AgentPatch): void
  onRole(roleId: string): void
  onOpinion(text: string): void
}): React.JSX.Element {
  const agent = props.agent
  const id = `agent-${agent.id}`
  const [hostDraft, setHostDraft] = useState(hostKind(agent) === 'hostname' ? agent.host ?? '' : '')
  const [tagDraft, setTagDraft] = useState('')
  const [opinion, setOpinion] = useState(props.opinion)
  useEffect(() => setOpinion(props.opinion), [props.opinion])
  const numberOrUndefined = (raw: string): number | undefined => (raw.trim() === '' ? undefined : Number(raw))
  const tags = agent.tags ?? []
  return (
    <div id={`${id}-editor`} className="agent-editor">
      <Row id={`${id}-name`} label="Name"><TextField id={`${id}-name-input`} label="Name" value={agent.name} maxLength={64} onChange={(name) => props.onPatch({ name })} /></Row>
      <Row id={`${id}-title`} label="Title">
        <Segmented labelledBy={`${id}-title`} options={['knight', 'squire'] as const} value={agent.title} optionLabel={cap} onChange={(title) => props.onPatch({ title })} />
      </Row>
      <Row id={`${id}-harness`} label="Harness">
        <Segmented labelledBy={`${id}-harness`} options={ROSTER_HARNESSES} value={agent.harness} optionLabel={cap} onChange={(harness) => props.onPatch({ harness })} />
      </Row>
      <Row id={`${id}-model`} label="Model"><TextField id={`${id}-model-input`} label="Model" value={agent.model} maxLength={128} onChange={(model) => props.onPatch({ model })} /></Row>
      <Row id={`${id}-provider`} label="Provider"><TextField id={`${id}-provider-input`} label="Provider" value={agent.provider} maxLength={64} onChange={(provider) => props.onPatch({ provider })} /></Row>
      <Row id={`${id}-host`} label="Host" help="Default follows the harness route; none is a local model.">
        <Segmented labelledBy={`${id}-host`} options={['default', 'hostname', 'none'] as const} value={hostKind(agent)} optionLabel={cap}
          onChange={(kind) => props.onPatch({ host: kind === 'default' ? 'default' : kind === 'none' ? null : hostDraft })} />
        {hostKind(agent) === 'hostname'
          ? <TextField id={`${id}-host-input`} label="Hostname" value={agent.host ?? ''} placeholder="api.example.com" maxLength={253}
              onChange={(host) => { setHostDraft(host); props.onPatch({ host }) }} />
          : null}
      </Row>
      <Row id={`${id}-security`} label="Security">
        <Segmented labelledBy={`${id}-security`} options={['high', 'low'] as const} value={agent.security}
          optionLabel={(level) => <><SealShape level={level} />{cap(level)}</>} onChange={(security) => props.onPatch({ security })} />
      </Row>
      <Row id={`${id}-trust`} label="Trust">
        <Segmented labelledBy={`${id}-trust`} options={[1, 2, 3] as const} value={agent.trust}
          optionLabel={(count) => <><PipsShape count={count} />{count}</>} onChange={(trust) => props.onPatch({ trust })} />
      </Row>
      <Row id={`${id}-authority`} label="Authority">
        <Segmented labelledBy={`${id}-authority`} options={ROSTER_AUTHORITIES} value={agent.authority} optionLabel={cap} onChange={(authority) => props.onPatch({ authority })} />
      </Row>
      <Row id={`${id}-efforts`} label="Efforts">
        <div className="chip-row" role="group" aria-labelledby={`${id}-efforts`}>
          {ROSTER_EFFORTS.map((effort) => (
            <button key={effort} type="button" className="chip-toggle" aria-pressed={agent.efforts.includes(effort)}
              onClick={() => props.onPatch({ efforts: ROSTER_EFFORTS.filter((value) => value === effort ? !agent.efforts.includes(effort) : agent.efforts.includes(value)) })}>
              {effort}
            </button>
          ))}
        </div>
      </Row>
      <Row id={`${id}-cost`} label="Cost">
        <Segmented labelledBy={`${id}-cost`} options={['none', 'low', 'medium', 'high'] as const} value={agent.cost ?? 'none'} optionLabel={cap}
          onChange={(cost) => props.onPatch({ cost: cost === 'none' ? undefined : cost })} />
      </Row>
      <Row id={`${id}-roles`} label="Roles" help="Holding a role puts the agent last in its chain; order chains under Roles.">
        <div className="chip-row" role="group" aria-labelledby={`${id}-roles`}>
          {props.roles.map((role) => (
            <button key={role.id} type="button" className="chip-toggle" aria-pressed={agent.roles.includes(role.id)} onClick={() => props.onRole(role.id)}>
              {role.id}
            </button>
          ))}
        </div>
      </Row>
      <Row id={`${id}-tags`} label="Tags">
        <div className="chip-row">
          {tags.map((tag) => (
            <span key={tag} className="roster-chip">
              <span>{tag}</span>
              <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => props.onPatch({ tags: tags.length === 1 ? undefined : tags.filter((value) => value !== tag) })}>×</button>
            </span>
          ))}
        </div>
        <input type="text" aria-label={`Add tag to ${agent.name}`} placeholder="Add tag" value={tagDraft} maxLength={40} disabled={tags.length >= 8}
          onChange={(event) => setTagDraft(event.target.value)}
          onKeyDown={(event) => {
            const tag = tagDraft.trim()
            if (event.key !== 'Enter' || tag === '' || tags.includes(tag)) return
            event.preventDefault()
            props.onPatch({ tags: [...tags, tag] })
            setTagDraft('')
          }} />
      </Row>
      {!agent.enabled ? (
        <Row id={`${id}-note`} label="Note" help="Why it is off; shown under its row.">
          <TextField id={`${id}-note-input`} label="Disabled note" value={agent.enabled_note ?? ''} maxLength={120}
            onChange={(note) => props.onPatch({ enabled_note: note === '' ? undefined : note })} />
        </Row>
      ) : null}
      <Row id={`${id}-opinion`} label="Opinion" help="Kept in the roster file below its settings; no agent ever reads it. Saves at once, no approval.">
        <textarea id={`${id}-opinion-input`} aria-labelledby={`${id}-opinion`} value={opinion} maxLength={8000} onChange={(event) => setOpinion(event.target.value)} />
        <button type="button" disabled={props.opinionBusy || opinion === props.opinion} onClick={() => props.onOpinion(opinion)}>
          {props.opinionBusy ? 'Saving…' : 'Save opinion'}
        </button>
      </Row>
      <details className="advanced">
        <summary>Advanced</summary>
        <div className="advanced-body">
          <Row id={`${id}-aliases`} label="Aliases" help="Other names a dispatch may use, comma separated.">
            <TextField id={`${id}-aliases-input`} label="Aliases" value={(agent.aliases ?? []).join(', ')}
              onChange={(raw) => { const aliases = raw.split(',').map((alias) => alias.trim()).filter(Boolean); props.onPatch({ aliases: aliases.length ? aliases : undefined }) }} />
          </Row>
          <Row id={`${id}-quota`} label="Quota">
            <TextField id={`${id}-quota-input`} label="Quota" value={agent.quota ?? ''} maxLength={120} onChange={(quota) => props.onPatch({ quota: quota === '' ? undefined : quota })} />
          </Row>
          <Row id={`${id}-context`} label="Context window">
            <TextField id={`${id}-context-input`} label="Context window" type="number" value={agent.context_window === undefined ? '' : String(agent.context_window)}
              onChange={(raw) => props.onPatch({ context_window: numberOrUndefined(raw) })} />
          </Row>
          <Row id={`${id}-max-context`} label="Max context tokens">
            <TextField id={`${id}-max-context-input`} label="Max context tokens" type="number" value={agent.max_context_tokens === undefined ? '' : String(agent.max_context_tokens)}
              onChange={(raw) => props.onPatch({ max_context_tokens: numberOrUndefined(raw) })} />
          </Row>
        </div>
      </details>
    </div>
  )
}

export function RoleChain(props: { role: RosterRoleShape; data: RosterDataShape; onData(next: RosterDataShape): void }): React.JSX.Element {
  const role = props.role
  const id = `role-${role.id}`
  const agentOf = (agentId: string): RosterAgentShape | undefined => props.data.agents.find((agent) => agent.id === agentId)
  return (
    <div className="chain" role="group" aria-labelledby={`${id}-name`}>
      <div className="chain-head">
        <span id={`${id}-name`}>{role.id}</span>
        <span className="chain-then">
          <span id={`${id}-then`} className="preferences-help">When every candidate fails</span>
          <Segmented fit labelledBy={`${id}-then`} options={ROSTER_THEN} value={role.then}
            optionLabel={(then) => (then === 'owner-chooses' ? 'owner chooses' : then)} onChange={(then) => props.onData(setRoleThen(props.data, role.id, then))} />
        </span>
      </div>
      <ol className="chain-list">
        {role.candidates.map((text, index) => {
          const candidate = parseCandidate(text)
          const agent = agentOf(candidate.agent)
          const name = agent?.name ?? candidate.agent
          return (
            <li key={candidate.agent} className="candidate">
              <span className="order">
                <button type="button" className="icon-button" aria-label={`Move ${name} up in ${role.id}`} disabled={index === 0}
                  onClick={() => props.onData(moveCandidate(props.data, role.id, index, -1))}>▲</button>
                <button type="button" className="icon-button" aria-label={`Move ${name} down in ${role.id}`} disabled={index === role.candidates.length - 1}
                  onClick={() => props.onData(moveCandidate(props.data, role.id, index, 1))}>▼</button>
              </span>
              {agent ? <Sigil title={agent.title} /> : <span />}
              <span className="agent-name">{name}</span>
              <span className="candidate-efforts" role="group" aria-label={`Effort for ${name} in ${role.id}`}>
                {(agent?.efforts ?? candidate.efforts).map((effort: RosterEffort) => (
                  <button key={effort} type="button" className="chip-toggle" aria-pressed={candidate.efforts.includes(effort)}
                    onClick={() => props.onData(toggleCandidateEffort(props.data, role.id, candidate.agent, effort))}>{effort}</button>
                ))}
                {candidate.efforts.length > 1 ? <small>lead chooses</small> : null}
              </span>
            </li>
          )
        })}
      </ol>
      <details className="advanced">
        <summary>Recheck and small epics</summary>
        <div className="advanced-body">
          <Row id={`${id}-recheck`} label="Recheck" help="The same reviewer checks the repair; per-agent recheck efforts stay as the file sets them.">
            <button type="button" role="switch" className="switch" aria-checked={role.recheck?.same_reviewer === true} aria-labelledby={`${id}-recheck`}
              onClick={() => props.onData(setRecheck(props.data, role.id, role.recheck?.same_reviewer !== true))} />
          </Row>
          <Row id={`${id}-small`} label="Small epic" help="One candidate as agent@effort, used instead for a small epic; empty for none.">
            <TextField id={`${id}-small-input`} label={`Small epic agent for ${role.id}`} value={role.small_epic ?? ''} placeholder="astra@low" maxLength={48}
              onChange={(value) => props.onData(setSmallEpic(props.data, role.id, value))} />
          </Row>
        </div>
      </details>
    </div>
  )
}

function LabelRows(props: {
  data: RosterDataShape
  views: readonly WorkspaceLabelView[]
  onData(next: RosterDataShape): void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const explicit = new Set(props.data.data_labels.paths.map((entry) => entry.path))
  const sourceWord = (view: WorkspaceLabelView): string => view.source === 'explicit' ? 'explicit'
    : view.source === 'inherited' ? 'inherited from a parent folder' : 'default'
  const addable = draft.startsWith('/') && !explicit.has(draft.replace(/\/+$/, '') || '/')
  return (
    <>
      <div className="preferences-row label-row">
        <div className="preferences-row-label"><span id="labels-default">Default</span></div>
        <div className="preferences-row-control">
          <Segmented<'private' | 'public'> labelledBy="labels-default" options={['private', 'public'] as const} value={props.data.data_labels.default} optionLabel={cap}
            onChange={(label) => props.onData(setDefaultLabel(props.data, label))} />
          <span className="label-source">for folders with no label of their own</span>
        </div>
      </div>
      {props.views.map((view, index) => (
        <div key={view.path} className="preferences-row label-row">
          <div className="preferences-row-label"><span id={`label-${index}`} className="preferences-mono label-path" title={view.path}><bdi>{view.path}</bdi></span></div>
          <div className="preferences-row-control">
            <Segmented<'private' | 'public'> labelledBy={`label-${index}`} options={['private', 'public'] as const} value={view.label} optionLabel={cap}
              onChange={(label) => props.onData(setLabel(props.data, view.path, label))} />
            <span className="label-source">{sourceWord(view)}</span>
            {explicit.has(view.path)
              ? <button type="button" className="icon-button" aria-label={`Remove the label on ${view.path}`} onClick={() => props.onData(setLabel(props.data, view.path, null))}>×</button>
              : null}
          </div>
        </div>
      ))}
      <div className="preferences-row">
        <div className="preferences-row-label"><label htmlFor="labels-add">Label a folder</label></div>
        <div className="preferences-row-control">
          <input id="labels-add" type="text" placeholder="/absolute/path" value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value.trim())} />
          <button type="button" disabled={!addable} onClick={() => {
            props.onData(setLabel(props.data, draft.replace(/\/+$/, '') || '/', 'public'))
            setDraft('')
          }}>Label public</button>
          <p className="preferences-help">Folders inherit the nearest labelled parent. Public lets Low routes receive tracked files in packets.</p>
        </div>
      </div>
    </>
  )
}

function RouteRows(props: {
  data: RosterDataShape
  inspected: Partial<Record<RosterHarness, RouteInspectionView | string>>
  onInspect(harness: RosterHarness): void
  onData(next: RosterDataShape): void
}): React.JSX.Element {
  return (
    <>
      {props.data.harness_routes.map((route: RosterRouteShape) => {
        const id = `route-${route.harness}`
        const inspection = props.inspected[route.harness]
        const accepted = route.accepted_versions ?? []
        return (
          <div key={route.harness} className="preferences-row route-row">
            <div className="preferences-row-label"><span id={id}>{cap(route.harness)}</span><span className="preferences-help">{route.provider}</span></div>
            <div className="preferences-row-control">
              <Segmented labelledBy={id} options={['high', 'low'] as const} value={route.security}
                optionLabel={(level) => <><SealShape level={level} />{cap(level)}</>} onChange={(security) => props.onData(updateRoute(props.data, route.harness, { security }))} />
              <span id={`${id}-basis`} className="visually-hidden">Basis for {route.harness}</span>
              <Segmented labelledBy={`${id}-basis`} options={['observed-default', 'owner-declared'] as const} value={route.basis}
                optionLabel={(basis) => (basis === 'observed-default' ? 'Observed' : 'Declared')} onChange={(basis) => props.onData(updateRoute(props.data, route.harness, { basis }))} />
              {accepted.length > 0
                ? <span className="chip-row" aria-label={`Accepted ${route.harness} versions`}>{accepted.map((version) => <span key={version} className="roster-chip"><span>{version}</span></span>)}</span>
                : null}
              <button type="button" className="small" onClick={() => props.onInspect(route.harness)}>Inspect</button>
              {typeof inspection === 'string' ? <p className="preferences-error">{inspection}</p> : inspection ? (
                <p className="preferences-help route-inspected">
                  {inspection.provider ?? 'unknown provider'} · {inspection.host ?? 'unknown host'} · version {inspection.version ?? 'unknown'}
                  {inspection.versionTested ? ' · tested by BMN' : accepted.includes(inspection.version ?? '') ? ' · accepted' : ' · untested'}
                  {inspection.reason ? ` · ${inspection.reason}` : ''}
                  {inspection.version && !inspection.versionTested && !accepted.includes(inspection.version) ? (
                    <button type="button" className="small" onClick={() => props.onData(acceptVersion(props.data, route.harness, inspection.version as string))}>
                      Accept {inspection.version}
                    </button>
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>
        )
      })}
    </>
  )
}

type Band =
  | { kind: 'save' }
  | { kind: 'first' }
  | { kind: 'restore'; number: number; preview: AgentsPreview }

export function AgentsPreferences(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [staged, setStaged] = useState<RosterDataShape | null>(null)
  const [preview, setPreview] = useState<AgentsPreview | null>(null)
  const [band, setBand] = useState<Band | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string; issues?: RosterIssueShape[] } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [opened, setOpened] = useState<{ number: number; groups: DiffGroup[]; general: string[] } | null>(null)
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([])
  const [labelViews, setLabelViews] = useState<WorkspaceLabelView[]>([])
  const [inspected, setInspected] = useState<Partial<Record<RosterHarness, RouteInspectionView | string>>>({})
  const [opinionBusy, setOpinionBusy] = useState(false)
  const section = useRef<HTMLElement>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await window.aiTerminal.agentsSnapshot())
      setLoadError(null)
    } catch (error) {
      setLoadError(failureDetail(error, 'Could not read the roster'))
    }
  }, [])

  useEffect(() => {
    void load()
    window.aiTerminal.listWorkspaces()
      .then((workspaces) => setWorkspacePaths(workspaces.map((workspace) => workspace.defaultCwd).filter((path): path is string => !!path && path.startsWith('/'))))
      .catch(() => setWorkspacePaths([]))
  }, [load])

  const base = snapshot?.file.data ?? null
  const data = staged ?? base
  const shown: AgentsShownRevision | null = snapshot?.file.hash ? { generation: snapshot.approved?.generation ?? null, fileHash: snapshot.file.hash } : null

  // The staged data as the file would hold it: validity, the diff against the approval and its consequences.
  useEffect(() => {
    if (staged === null) {
      setPreview(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      window.aiTerminal.previewAgents(staged)
        .then((result) => { if (!cancelled) setPreview(result) })
        .catch((error: unknown) => { if (!cancelled) setNotice({ ok: false, text: failureDetail(error, 'Could not preview the change') }) })
    }, PREVIEW_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [staged])

  const labelPaths = [...new Set([...(data?.data_labels.paths.map((entry) => entry.path) ?? []), ...workspacePaths])].sort().slice(0, 64)
  const labelKey = JSON.stringify([labelPaths, data?.data_labels])
  useEffect(() => {
    if (data === null || labelPaths.length === 0) {
      setLabelViews([])
      return
    }
    let cancelled = false
    window.aiTerminal.agentsLabels(labelPaths, data)
      .then((views) => { if (!cancelled) setLabelViews(views) })
      .catch(() => { if (!cancelled) setLabelViews([]) })
    return () => { cancelled = true }
    // labelKey carries exactly the inputs that change a label's answer.
  }, [labelKey])

  function stage(next: RosterDataShape): void {
    setNotice(null)
    setOpened(null)
    if (sameData(next, base)) {
      setStaged(null)
      setBand(snapshot?.approved || band === null ? null : { kind: 'first' })
      return
    }
    setStaged(next)
    setBand({ kind: 'save' })
  }

  function discard(): void {
    setStaged(null)
    setPreview(null)
    setBand(null)
    setNotice(null)
  }

  async function settle(run: () => Promise<AgentsOutcome>): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const result = await run()
      setSnapshot(result.snapshot)
      if (result.ok) {
        discard()
        setNotice({ ok: true, text: result.message })
      } else if (result.code === 'REVISION_CONFLICT') {
        discard()
        setNotice({ ok: false, text: 'The roster changed on disk; reloaded without saving.' })
      } else {
        setNotice({ ok: false, text: result.message, ...(result.errors ? { issues: result.errors } : {}) })
      }
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'The roster could not be changed') })
    } finally {
      setBusy(false)
    }
  }

  async function confirmBand(): Promise<void> {
    if (!shown || band === null) return
    if (band.kind === 'restore') return settle(() => window.aiTerminal.restoreAgents(shown, band.number))
    if (staged !== null) return settle(() => window.aiTerminal.saveAgents(shown, staged))
    return settle(() => window.aiTerminal.approveAgents(shown))
  }

  async function openGeneration(number: number): Promise<void> {
    if (opened?.number === number) {
      setOpened(null)
      return
    }
    try {
      const generation = await window.aiTerminal.agentsGeneration(number)
      if (generation === null) {
        setNotice({ ok: false, text: `Generation ${number} is missing or does not verify.` })
        return
      }
      const result = await window.aiTerminal.previewAgents(generation.data)
      const grouped = groupDifferences(result.differences, generation.data, snapshot?.approved?.data ?? null, result.consequences)
      setOpened({ number, ...grouped })
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, `Could not open generation ${number}`) })
    }
  }

  async function stageRestore(number: number): Promise<void> {
    try {
      const generation = await window.aiTerminal.agentsGeneration(number)
      if (generation === null) return setNotice({ ok: false, text: `Generation ${number} is missing or does not verify.` })
      setStaged(null)
      setBand({ kind: 'restore', number, preview: await window.aiTerminal.previewAgents(generation.data) })
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, `Could not prepare generation ${number}`) })
    }
  }

  async function inspect(harness: RosterHarness): Promise<void> {
    try {
      const view = await window.aiTerminal.inspectAgentRoute(harness)
      setInspected((current) => ({ ...current, [harness]: view }))
    } catch (error) {
      setInspected((current) => ({ ...current, [harness]: failureDetail(error, `Could not inspect the ${harness} route`) }))
    }
  }

  async function saveOpinion(agentId: string, text: string): Promise<void> {
    if (!shown) return
    setOpinionBusy(true)
    try {
      const result = await window.aiTerminal.saveAgentOpinion(shown, agentId, text)
      setSnapshot(result.snapshot)
      setNotice(result.ok ? { ok: true, text: result.message }
        : { ok: false, text: result.code === 'REVISION_CONFLICT' ? 'The roster changed on disk; reloaded without saving the opinion.' : result.message })
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'Could not save the opinion') })
    } finally {
      setOpinionBusy(false)
    }
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await window.aiTerminal.writeClipboardText(path)
      setNotice({ ok: true, text: 'Roster path copied.' })
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'Could not copy to the clipboard') })
    }
  }

  // Escape inside the section discards staged edits first; a second Escape closes Preferences.
  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || band === null) return
    event.preventDefault()
    event.stopPropagation()
    discard()
  }

  const approved = snapshot?.approved ?? null
  const outside = snapshot && staged === null && approved && snapshot.differences && snapshot.differences.length > 0
    ? groupDifferences(snapshot.differences, snapshot.file.data, approved.data, snapshot.consequences) : null
  const groups = data ? agentGroups(data) : null
  const edit = (next: RosterDataShape): void => stage(next)
  const patchAgent = (id: string, patch: AgentPatch): void => { if (data) stage(updateAgent(data, id, patch)) }

  const agentRow = (agent: RosterAgentShape): React.JSX.Element => (
    <li key={agent.id} className="agent-row" data-open={expanded === agent.id}>
      <AgentSummary agent={agent} open={expanded === agent.id} disabled={busy}
        onToggleOpen={() => setExpanded(expanded === agent.id ? null : agent.id)}
        onEnabled={(enabled) => patchAgent(agent.id, { enabled })}
        onActivate={() => patchAgent(agent.id, { status: 'active' })} />
      {expanded === agent.id && data ? (
        <AgentEditor agent={agent} roles={data.roles} opinion={snapshot?.file.prose[agent.id] ?? ''} opinionBusy={opinionBusy}
          onPatch={(patch) => patchAgent(agent.id, patch)} onRole={(roleId) => stage(toggleAgentRole(data, agent.id, roleId))}
          onOpinion={(text) => void saveOpinion(agent.id, text)} />
      ) : null}
    </li>
  )

  const bandBody = (): React.JSX.Element | null => {
    if (band === null || !snapshot) return null
    const source = band.kind === 'restore' ? band.preview : staged !== null ? preview : null
    const firstWithoutEdits = band.kind === 'first' && staged === null
    const grouped = source ? groupDifferences(source.differences, band.kind === 'restore' ? null : data, approved?.data ?? null, source.consequences)
      : firstWithoutEdits ? { groups: [], general: snapshot.consequences } : null
    const sentence = band.kind === 'restore'
      ? `Restore generation ${band.number} as a new approval. ${summarize(band.preview.differences)}; the roster file keeps its text.`
      : !approved ? `First approval: ${groups?.active.length ?? 0} active agents and ${data?.roles.length ?? 0} roles take effect.`
        : source ? `${summarize(source.differences)}.` : 'Checking the change…'
    const invalid = source !== null && !source.valid
    return (
      <div className="roster-confirm" role="region" aria-live="polite" aria-label="Staged roster changes">
        <div className="confirm-head"><span className="status-dot needs-you" aria-hidden="true" /><p>{sentence}</p></div>
        {grouped ? <DiffGroups groups={grouped.groups} /> : null}
        {grouped && grouped.general.length > 0
          ? <ul className="diff-general">{grouped.general.map((line) => <li key={line} className="diff-consequence">{cap(line)}.</li>)}</ul>
          : null}
        {source && !source.valid ? <Issues issues={source.errors} /> : null}
        <div className="confirm-actions">
          <button type="button" disabled={busy} onClick={discard}>{staged !== null ? 'Discard' : 'Cancel'}</button>
          <button type="button" className="primary" disabled={busy || invalid || (staged !== null && preview === null)} onClick={() => void confirmBand()}>
            {busy ? 'Saving…' : band.kind === 'restore' ? `Restore generation ${band.number}` : staged !== null ? 'Save & approve' : 'Approve roster'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <section ref={section} className="preferences-section agents-section" aria-labelledby="agents-head" onKeyDown={onKeyDown}>
      <div className="preferences-section-head">
        <h3 id="agents-head">Agents</h3>
        <span className="meta">
          {approved ? `Generation ${approved.generation} · approved ${when(approved.createdAt)}` : snapshot ? 'Not approved yet' : ''}
          {snapshot && !approved && snapshot.file.data && band === null
            ? <button type="button" className="small" onClick={() => { setNotice(null); setBand({ kind: 'first' }) }}>Approve roster…</button>
            : null}
          <button type="button" className="small" disabled={busy || staged !== null} title={staged !== null ? 'Save or discard staged edits first' : undefined}
            onClick={() => { setNotice(null); setOpened(null); void load() }}>Reload</button>
        </span>
      </div>
      {notice ? (
        notice.ok ? <p className="preferences-success" role="status">{notice.text}</p>
          : <><p className="preferences-error" role="alert">{notice.text}</p>{notice.issues ? <Issues issues={notice.issues} /> : null}</>
      ) : null}
      {loadError ? <p className="preferences-error" role="alert">{loadError}</p> : null}
      {snapshot === null && loadError === null ? <p className="preferences-help">Loading…</p> : null}
      {snapshot && !approved ? (
        <p className="preferences-help">
          {snapshot.approvalProblem && snapshot.approvalProblem.code !== 'NOT_APPROVED'
            ? `The approved state cannot be read (${snapshot.approvalProblem.message}); nothing is dispatched until you approve or restore a generation.`
            : 'Nothing takes effect until the first approval: until then every dispatch check refuses.'}
        </p>
      ) : null}
      {snapshot && !snapshot.file.exists ? <p className="preferences-help">No roster yet at <code>{snapshot.rosterPath}</code>.</p> : null}
      {snapshot && snapshot.file.exists && snapshot.file.data === null ? <Issues issues={snapshot.file.errors} /> : null}

      {outside?.groups.map((group) => (
        <div key={group.key} className="roster-outside" role="group" aria-label={`${group.subject} changed outside BMN`}>
          <div className="confirm-head"><span className="status-dot needs-you" aria-hidden="true" /><p>{group.subject} · changed outside BMN</p></div>
          <DiffGroups groups={[{ ...group, subject: '' }]} />
          <div className="confirm-actions">
            <button type="button" disabled={busy || !shown} onClick={() => shown && void settle(() => window.aiTerminal.revertAgents(shown, [group.key]))}>
              Revert file to approved
            </button>
            <button type="button" className="primary" disabled={busy || !shown} onClick={() => shown && void settle(() => window.aiTerminal.approveAgents(shown, [group.key]))}>
              Approve
            </button>
          </div>
        </div>
      ))}
      {outside && outside.general.length > 0
        ? <ul className="diff-general">{outside.general.map((line) => <li key={line} className="diff-consequence">{cap(line)}.</li>)}</ul>
        : null}
      {outside && outside.groups.length > 1 ? (
        <div className="preferences-button-row outside-all">
          <button type="button" disabled={busy || !shown} onClick={() => shown && void settle(() => window.aiTerminal.approveAgents(shown))}>Approve all outside changes</button>
        </div>
      ) : null}

      {data && groups ? (
        <>
          <ul className="agent-list" aria-label="Active agents">{groups.active.map(agentRow)}</ul>
          {groups.proposed.length > 0 ? (
            <>
              <h4 className="preferences-subhead">Awaiting approval</h4>
              <ul className="agent-list" aria-label="Agents awaiting approval">{groups.proposed.map(agentRow)}</ul>
            </>
          ) : null}
          {groups.disabled.length > 0 ? (
            <>
              <h4 className="preferences-subhead">Disabled</h4>
              <ul className="agent-list disabled" aria-label="Disabled agents">{groups.disabled.map(agentRow)}</ul>
            </>
          ) : null}

          <h4 className="preferences-subhead">Roles</h4>
          {data.roles.map((role) => <RoleChain key={role.id} role={role} data={data} onData={edit} />)}

          <h4 className="preferences-subhead">Workspace labels</h4>
          <LabelRows data={data} views={labelViews} onData={edit} />

          <h4 className="preferences-subhead">Harness routes</h4>
          <RouteRows data={data} inspected={inspected} onInspect={(harness) => void inspect(harness)} onData={edit} />
        </>
      ) : null}

      {bandBody()}

      {snapshot ? (
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="advanced-body">
            <div className="preferences-row">
              <div className="preferences-row-label"><span>Roster file</span></div>
              <div className="preferences-row-control">
                <code className="preferences-mono preferences-path" title={snapshot.rosterPath}><bdi>{snapshot.rosterPath}</bdi></code>
                <button type="button" onClick={() => void copyPath(snapshot.rosterPath)}>Copy</button>
              </div>
            </div>
            <h4 className="preferences-subhead">History</h4>
            {snapshot.history.length === 0 ? <p>No approvals yet.</p> : null}
            <ul className="generation-list">
              {[...snapshot.history].reverse().map((generation) => (
                <li key={generation.number} className="generation">
                  <span>
                    Generation {generation.number} · {when(generation.created_at)}
                    {generation.kind === 'restore' ? ` · restored from ${generation.restored_from}` : ''}
                    {generation.agents !== undefined ? ` · ${generation.agents} agents` : ''}
                    {generation.valid ? '' : ' · does not verify'}
                    {generation.number === approved?.generation ? ' · current' : ''}
                  </span>
                  <button type="button" className="small" aria-expanded={opened?.number === generation.number} disabled={!generation.valid}
                    onClick={() => void openGeneration(generation.number)}>Open</button>
                  <button type="button" className="small" disabled={busy || !generation.valid || generation.number === approved?.generation || !shown}
                    onClick={() => void stageRestore(generation.number)}>Restore…</button>
                  {opened?.number === generation.number ? (
                    <div className="generation-open">
                      {opened.groups.length === 0 ? <p>Same machine data as the current approval.</p> : <DiffGroups groups={opened.groups} />}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <p>Restoring makes an earlier generation the approval again as a new generation; the roster file then shows its differences above.</p>
          </div>
        </details>
      ) : null}
    </section>
  )
}
