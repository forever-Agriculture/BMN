// MODULE: team-preferences.tsx - Epic 60.5: Preferences › Team: agents as solid cards, an agent's rows, New agent, role chains, approved versions and the approval footer
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  ROSTER_APP_NAMES,
  ROSTER_CLASSES,
  ROSTER_EFFORTS,
  ROSTER_HARNESSES,
  ROSTER_THEN,
  type AgentsGenerationSummary,
  type RosterAgentShape,
  type RosterClass,
  type RosterDataShape,
  type RosterEffort,
  type RosterHarness,
  type RosterIssueShape,
  type RosterPrivateWork,
  type RosterRoleShape
} from '@bmn/protocol'
import { Segmented } from './history-preferences'
import { Dot, Piece } from './roster-marks'
import {
  CLASS_WORDS,
  PRIVATE_WORK_WORDS,
  THEN_WORDS,
  activateAgent,
  addAgent,
  addRole,
  agentGroups,
  agentsOnProvider,
  classBar,
  consequenceWords,
  diffBody,
  effortWords,
  firstApprovalGroups,
  firstLine,
  groupDifferences,
  landingFor,
  moveAgent,
  moveCandidate,
  newAgentConsequence,
  parseCandidate,
  priceWords,
  roleIdsOf,
  providerOf,
  publicOnly,
  roleName,
  setAgentClass,
  setAgentOn,
  setProviderAnswer,
  setRoleThen,
  summarize,
  summaryWords,
  teamUpdateWords,
  thousands,
  toggleAgentEffort,
  toggleAgentRole,
  undoWords,
  toggleCandidateEffort,
  updateAgent,
  type DiffGroup,
  type DiffLine,
  type NewAgent
} from './roster-staging'
import { displayPath } from './session-presentation'
import type { TeamState } from './team-state'

export type TeamPage = { name: 'agents' } | { name: 'agent'; id: string } | { name: 'new' } | { name: 'roles' } | { name: 'changes' }

/** "Oct 9, 22:13": the short date every Team and Rules page uses. */
export function shortDate(iso: string | undefined): string {
  if (!iso) return 'unknown time'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** A page's title line: the title or crumb, one faint status, then its actions at the far end. */
export function PageHead(props: { title: ReactNode; status?: ReactNode; children?: ReactNode }): React.JSX.Element {
  return (
    <header className="page-head">
      <h3 className="page-title">{props.title}</h3>
      {props.status ? <span className="faint">{props.status}</span> : null}
      <span className="spacer" />
      {props.children}
    </header>
  )
}

/** A label column and its control, as every Preferences page lays rows out. */
export function Row(props: { label: string; id?: string; hint?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div className="preferences-row">
      <div className="preferences-row-label"><span id={props.id}>{props.label}</span></div>
      <div className="preferences-row-control">{props.children}{props.hint ? <p className="preferences-help">{props.hint}</p> : null}</div>
    </div>
  )
}

/** A neutral switch: the thumb's position carries the state. */
export function Switch(props: { label: string; on: boolean; disabled?: boolean; onChange(next: boolean): void }): React.JSX.Element {
  return (
    <button type="button" className={props.on ? 'switch on' : 'switch'} role="switch" aria-checked={props.on} aria-label={props.label} disabled={props.disabled}
      onClick={(event) => { event.stopPropagation(); props.onChange(!props.on) }} />
  )
}

/** A toggle chip: pressed is the brighter plate. */
function Chip(props: { on: boolean; disabled?: boolean; title?: string; onToggle(): void; children: ReactNode }): React.JSX.Element {
  return <button type="button" className={props.on ? 'chip on' : 'chip'} aria-pressed={props.on} disabled={props.disabled} title={props.title} onClick={props.onToggle}>{props.children}</button>
}

export function Issues(props: { issues: readonly RosterIssueShape[] }): React.JSX.Element | null {
  if (props.issues.length === 0) return null
  return (
    <ul className="issue-list">
      {props.issues.map((issue, index) => <li key={index}>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>)}
    </ul>
  )
}

function ClassChoice(props: { name: string; value: RosterClass; onChange(next: RosterClass): void }): React.JSX.Element {
  return (
    <div className="choice-list" role="radiogroup" aria-label="Class">
      {ROSTER_CLASSES.map((agentClass) => (
        <label key={agentClass} className="choice">
          <input type="radio" name={props.name} checked={props.value === agentClass} onChange={() => props.onChange(agentClass)} />
          <Piece agentClass={agentClass} />{CLASS_WORDS[agentClass].name} <span className="choice-line">{CLASS_WORDS[agentClass].line}</span>
        </label>
      ))}
    </div>
  )
}

function RoleChoices(props: { data: RosterDataShape; agentClass: RosterClass; held: readonly string[]; onToggle(role: string): void }): React.JSX.Element {
  return (
    <div className="choice-list">
      {props.data.roles.map((role) => {
        const bar = props.held.includes(role.id) ? null : classBar(props.agentClass, role.id)
        return (
          <label key={role.id} className={bar ? 'choice disabled' : 'choice'}>
            <input type="checkbox" checked={props.held.includes(role.id)} disabled={bar !== null} onChange={() => props.onToggle(role.id)} />
            {roleName(role.id)} <span className="choice-line">{bar ?? role.description ?? ''}</span>
          </label>
        )
      })}
    </div>
  )
}

function EffortChips(props: { efforts: readonly RosterEffort[]; onToggle(effort: RosterEffort): void }): React.JSX.Element {
  return (
    <div className="chips mono" role="group" aria-label="Efforts">
      {ROSTER_EFFORTS.map((effort) => <Chip key={effort} on={props.efforts.includes(effort)} onToggle={() => props.onToggle(effort)}>{effort}</Chip>)}
    </div>
  )
}

/** A whole number of tokens from what the owner typed ("272 000"), `undefined` for empty, `null` when it is not one. */
function tokens(text: string): number | undefined | null {
  const digits = text.replace(/[\s,_]/g, '')
  if (digits === '') return undefined
  return /^\d{1,9}$/.test(digits) && Number(digits) > 0 ? Number(digits) : null
}

function NumberField(props: { label: string; value: number | undefined; placeholder?: string; onChange(next: number | undefined): void }): React.JSX.Element {
  const [text, setText] = useState(props.value === undefined ? '' : thousands(props.value))
  useEffect(() => setText(props.value === undefined ? '' : thousands(props.value)), [props.value])
  const parsed = tokens(text)
  return (
    <input className="field number mono" inputMode="numeric" aria-label={props.label} aria-invalid={parsed === null} placeholder={props.placeholder} value={text}
      onChange={(event) => {
        setText(event.currentTarget.value)
        const next = tokens(event.currentTarget.value)
        if (next !== null) props.onChange(next)
      }} />
  )
}

// ---------------------------------------------------------------------------------------------
// Team › Agents

/** The reason an agent is off, asked once in place before the switch moves. */
function TurnOff(props: { agent: RosterAgentShape; onDone(reason: string | null): void }): React.JSX.Element {
  const [reason, setReason] = useState('')
  return (
    <form className="inline-ask" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); props.onDone(reason) }}>
      <input className="field" autoFocus maxLength={120} aria-label={`Why ${props.agent.name} is off`} placeholder="A short reason, for example: subscription ended" value={reason}
        onChange={(event) => setReason(event.currentTarget.value)} />
      <button type="submit">Turn off</button>
      <button type="button" onClick={() => props.onDone(null)}>Cancel</button>
    </form>
  )
}

function AgentCard(props: { agent: RosterAgentShape; data: RosterDataShape; notes: string; changed: boolean; team: TeamState; open(): void }): React.JSX.Element {
  const { agent, data, team } = props
  const [asking, setAsking] = useState(false)
  const off = agent.status === 'active' && !agent.enabled
  const price = priceWords(agent)
  return (
    <article className={off ? 'agent-card off' : 'agent-card'} onClick={props.open}>
      <Piece agentClass={agent.class} plate />
      <div className="agent-main">
        <div className="agent-name">
          <button type="button" className="agent-open" aria-label={`Open ${agent.name}`} onClick={(event) => { event.stopPropagation(); props.open() }}>{agent.name}</button>
          <span className="class-word">{CLASS_WORDS[agent.class].name}</span>
          {props.changed ? <Dot label="Unapproved change" /> : null}
        </div>
        <div className="agent-notes">{off ? agent.enabled_note ?? 'Off' : firstLine(props.notes)}</div>
        <div className="agent-app">{ROSTER_APP_NAMES[agent.harness]} · <span className="mono">{agent.model}</span>{publicOnly(data, agent) ? ' · public work only' : ''}</div>
        {asking ? <TurnOff agent={agent} onDone={(reason) => { setAsking(false); if (reason !== null) team.stage(setAgentOn(data, agent.id, false, reason)) }} /> : null}
      </div>
      <div className="agent-side">
        {agent.status === 'proposed'
          ? <button type="button" className="small" onClick={(event) => { event.stopPropagation(); team.stage(activateAgent(data, agent.id)) }}>Activate</button>
          : <Switch label={`${agent.name} on`} on={agent.enabled} onChange={(on) => { if (on) team.stage(setAgentOn(data, agent.id, true)); else setAsking(true) }} />}
        {price ? <span className="price mono">{price}</span> : null}
      </div>
    </article>
  )
}

function OutsideRow(props: { group: DiffGroup; team: TeamState }): React.JSX.Element {
  const { group, team } = props
  return (
    <div className="outside-row">
      {group.agent ? <Piece agentClass={group.agent.class} /> : null}
      <b>{group.subject}</b>
      <span className="muted">changed outside BMN:</span>
      <span className="outside-diff">{group.lines.filter((line) => line.detail !== true).map((line, index) => <span key={index} className="difference"><Difference line={line} data={team.data} /></span>)}</span>
      <span className="actions">
        <button type="button" className="small" disabled={team.busy} aria-label={`Keep the change to ${group.subject}`}
          onClick={() => void team.requestApproval({ kind: 'sections', scope: [group.key] }, { title: `Keep the change to ${group.subject}`, action: 'Keep' })}>Keep</button>
        <button type="button" className="small" disabled={team.busy} aria-label={`Revert the change to ${group.subject}`} onClick={() => void team.revert([group.key])}>Revert</button>
      </span>
    </div>
  )
}

function AgentsPage(props: { team: TeamState; data: RosterDataShape; go(page: TeamPage): void }): React.JSX.Element {
  const { team, data } = props
  const groups = agentGroups(data)
  const prose = team.snapshot?.file.prose ?? {}
  const cards = (title: string, agents: RosterAgentShape[], caption?: string): React.JSX.Element | null => agents.length === 0 ? null : (
    <>
      <h4 className="group-head">{title}{caption ? <span className="caption">{caption}</span> : null}</h4>
      <div className="agent-cards">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} data={data} notes={team.pendingNotes[agent.id] ?? prose[agent.id] ?? ''} changed={team.changed.has(agent.id)} team={team}
            open={() => props.go({ name: 'agent', id: agent.id })} />
        ))}
      </div>
    </>
  )
  return (
    <>
      <PageHead title="Team" status={team.snapshot?.approved ? `Approved ${shortDate(team.snapshot.approved.createdAt)}` : 'Nothing approved yet'}>
        <button type="button" onClick={() => props.go({ name: 'new' })}>New agent</button>
      </PageHead>
      {team.snapshot?.approved || team.hasStaged ? null : <FirstApproval team={team} />}
      {team.outside.groups.map((group) => <OutsideRow key={group.key} group={group} team={team} />)}
      {data.agents.length === 0 ? <p className="page-note">No agents yet. New agent adds the first one.</p> : null}
      {cards('Active', groups.active, 'Prices per M tokens, in / out')}
      {cards('Proposed', groups.proposed)}
      {cards('Off', groups.off)}
    </>
  )
}

/** With nothing approved, no agent, role or provider answer takes effect: say so and offer the first approval. */
function FirstApproval(props: { team: TeamState }): React.JSX.Element {
  return (
    <div className="outside-row">
      <Dot label="Needs you" />
      <span>Nothing here takes effect until you approve the team for the first time.</span>
      <span className="actions">
        <button type="button" className="primary small" disabled={props.team.busy}
          onClick={() => void props.team.requestApproval({ kind: 'file' }, { title: 'Approve the team for the first time', action: 'Approve' }, true)}>Approve…</button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Team › an agent

function PrivateWorkRow(props: { team: TeamState; data: RosterDataShape; agent: RosterAgentShape }): React.JSX.Element {
  const { team, data, agent } = props
  const [changing, setChanging] = useState(false)
  const labelId = useId()
  const provider = providerOf(data, agent)
  const answer: RosterPrivateWork = provider?.private_work ?? 'public_only'
  const others = agentsOnProvider(data, agent.provider).map((entry) => entry.name)
  const name = provider?.name ?? agent.provider
  return (
    <Row label="Private work" id={labelId} hint={`Set once for ${name}; it covers every agent there${others.length > 1 ? `: ${others.join(', ')}` : ''}.`}>
      {changing && provider
        ? <Segmented labelledBy={labelId} fit options={['allowed', 'public_only'] as const} value={answer} optionLabel={(value) => PRIVATE_WORK_WORDS[value]}
            onChange={(value) => team.stage(setProviderAnswer(data, provider.id, value))} />
        : <><span>{PRIVATE_WORK_WORDS[answer]}</span> <button type="button" className="small" disabled={!provider} aria-label={`Change private work for ${name}`} onClick={() => setChanging(true)}>Change…</button></>}
    </Row>
  )
}

function HostRow(props: { team: TeamState; data: RosterDataShape; agent: RosterAgentShape }): React.JSX.Element {
  const { team, data, agent } = props
  const labelId = useId()
  const custom = agent.host !== null && agent.host !== 'default'
  const [kind, setKind] = useState<'default' | 'custom'>(custom ? 'custom' : 'default')
  const [host, setHost] = useState(custom ? agent.host ?? '' : '')
  const [answer, setAnswer] = useState<RosterPrivateWork>('public_only')
  const answerId = useId()
  const landing = landingFor(data, agent.harness, kind === 'custom' ? host : '')
  const pending = kind === 'custom' && host.trim() !== '' && host.trim().toLowerCase() !== agent.host
  return (
    <Row label="Host" id={labelId} hint="A custom host counts as its own provider; BMN asks once whether it may see private work.">
      <Segmented labelledBy={labelId} fit options={['default', 'custom'] as const} value={kind} optionLabel={(value) => (value === 'default' ? 'Provider default' : 'Custom host')}
        onChange={(value) => {
          setKind(value)
          if (value === 'default' && agent.host !== 'default') team.stage(moveAgent(data, agent.id, agent.harness, ''))
        }} />
      {kind === 'custom' ? (
        <div className="stack">
          <input className="field mono" aria-label="Custom host" placeholder="api.example.com" value={host} onChange={(event) => setHost(event.currentTarget.value)} />
          {pending && landing.isNew ? (
            <>
              <span className="muted" id={answerId}>{landing.provider.name} is new here. May it see private work?</span>
              <Segmented<RosterPrivateWork> labelledBy={answerId} fit options={['allowed', 'public_only']} value={answer} optionLabel={(value) => PRIVATE_WORK_WORDS[value]} onChange={(value) => setAnswer(value)} />
            </>
          ) : null}
          {pending ? <button type="button" className="small" onClick={() => team.stage(moveAgent(data, agent.id, agent.harness, host, answer))}>Use this host</button> : null}
        </div>
      ) : null}
    </Row>
  )
}

function AlsoCalled(props: { team: TeamState; data: RosterDataShape; agent: RosterAgentShape }): React.JSX.Element {
  const { team, data, agent } = props
  const [draft, setDraft] = useState('')
  const aliases = agent.aliases ?? []
  const set = (next: string[]): void => team.stage(updateAgent(data, agent.id, { aliases: next.length === 0 ? undefined : next }))
  return (
    <Row label="Also called" hint="Other names the app accepts for this model.">
      <div className="chips">
        {aliases.map((alias) => (
          <span key={alias} className="chip on mono">{alias}<button type="button" className="chip-remove" aria-label={`Remove ${alias}`} onClick={() => set(aliases.filter((entry) => entry !== alias))}>×</button></span>
        ))}
        <form className="chip-add" onSubmit={(event) => {
          event.preventDefault()
          const value = draft.trim()
          if (value !== '' && !aliases.includes(value)) set([...aliases, value])
          setDraft('')
        }}>
          <input className="field mono" aria-label="Add another name" placeholder="Add a name" maxLength={128} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
        </form>
      </div>
    </Row>
  )
}

function AgentPage(props: { team: TeamState; data: RosterDataShape; agent: RosterAgentShape; go(page: TeamPage): void }): React.JSX.Element {
  const { team, data, agent } = props
  const saved = team.snapshot?.file.prose[agent.id]
  const [notes, setNotes] = useState(team.pendingNotes[agent.id] ?? saved ?? '')
  const [asking, setAsking] = useState(false)
  const [fileMessage, setFileMessage] = useState<string | null>(null)
  const appId = useId()
  const paidId = useId()
  useEffect(() => setNotes(team.pendingNotes[agent.id] ?? saved ?? ''), [agent.id, saved])
  const off = agent.status === 'active' && !agent.enabled
  const price = priceWords(agent)
  const patch = (change: Parameters<typeof updateAgent>[2]): void => team.stage(updateAgent(data, agent.id, change))
  const keepNotes = (): void => {
    if (saved === undefined) team.setPendingNote(agent.id, notes)
    else if (notes !== saved) void team.saveNotes(agent.id, notes)
  }
  return (
    <>
      <PageHead title={<><button type="button" className="crumb" onClick={() => props.go({ name: 'agents' })}>Team</button> <span className="faint">›</span> {agent.name}</>}
        status={agent.status === 'proposed' ? 'Proposed' : off ? 'Off' : 'Active'}>
        {team.changed.has(agent.id) ? <Dot label="Unapproved change" /> : null}
        {agent.status === 'proposed' ? <button type="button" onClick={() => team.stage(activateAgent(data, agent.id))}>Activate</button>
          : off ? <button type="button" onClick={() => team.stage(setAgentOn(data, agent.id, true))}>Turn on</button>
            : <button type="button" onClick={() => setAsking(true)}>Turn off…</button>}
      </PageHead>
      {asking ? <TurnOff agent={agent} onDone={(reason) => { setAsking(false); if (reason !== null) team.stage(setAgentOn(data, agent.id, false, reason)) }} /> : null}
      {off && agent.enabled_note ? <p className="page-note">Off: {agent.enabled_note}</p> : null}

      <h4 className="group-head">Identity</h4>
      <Row label="Name"><input className="field" aria-label="Name" maxLength={40} value={agent.name} onChange={(event) => patch({ name: event.currentTarget.value })} /></Row>
      <Row label="Class"><ClassChoice name={`class-${agent.id}`} value={agent.class} onChange={(next) => team.stage(setAgentClass(data, agent.id, next))} /></Row>
      <Row label="Notes" hint="Only you see this. The first line shows on the card.">
        <textarea className="field wide" aria-label="Notes" rows={3} maxLength={8000} value={notes} onChange={(event) => setNotes(event.currentTarget.value)} onBlur={keepNotes} />
      </Row>

      <h4 className="group-head">Model</h4>
      <Row label="Agent app" id={appId}>
        <Segmented labelledBy={appId} fit options={ROSTER_HARNESSES} value={agent.harness} optionLabel={(harness) => ROSTER_APP_NAMES[harness]}
          onChange={(harness: RosterHarness) => team.stage(moveAgent(data, agent.id, harness, agent.host === 'default' || agent.host === null ? '' : agent.host))} />
      </Row>
      <Row label="Model"><input className="field mono" aria-label="Model" maxLength={128} value={agent.model} onChange={(event) => patch({ model: event.currentTarget.value })} /></Row>
      <PrivateWorkRow team={team} data={data} agent={agent} />
      <Row label="Price" hint={agent.price ? [agent.price.source ? hostOf(agent.price.source) : null, agent.price.as_of].filter(Boolean).join(', ') || undefined : 'No price recorded.'}>
        <span className="mono">{price ?? '—'}</span>{price ? <span className="faint"> per M tokens, in / out</span> : null}
      </Row>
      <Row label="Context limit" hint="Empty means the app's own default.">
        <div className="inline">
          <NumberField label="Context limit" value={agent.context_limit} placeholder="App default" onChange={(next) => patch({ context_limit: next })} />
          <span className="faint">{agent.context_window ? `of ${thousands(agent.context_window)} tokens` : 'capacity unknown'}</span>
        </div>
      </Row>

      <h4 className="group-head">Work</h4>
      <Row label="Roles"><RoleChoices data={data} agentClass={agent.class} held={agent.roles} onToggle={(role) => team.stage(toggleAgentRole(data, agent.id, role))} /></Row>
      <Row label="Efforts" hint="Effort levels its roles may ask for.">
        <EffortChips efforts={agent.efforts} onToggle={(effort) => team.stage(toggleAgentEffort(data, agent.id, effort, ROSTER_EFFORTS))} />
      </Row>

      <details className="advanced">
        <summary>Advanced</summary>
        <Row label="Paid by" id={paidId}>
          <Segmented labelledBy={paidId} fit options={['per_token', 'subscription'] as const} value={agent.paid_by ?? 'per_token'}
            optionLabel={(value) => (value === 'per_token' ? 'Per token' : 'Subscription')} onChange={(value) => patch({ paid_by: value })} />
        </Row>
        <Row label="Compact at" hint="The app starts summarising the conversation here.">
          <NumberField label="Compact at" value={agent.compact_at} placeholder="App default" onChange={(next) => patch({ compact_at: next })} />
        </Row>
        <HostRow key={`${agent.id}-${agent.host}`} team={team} data={data} agent={agent} />
        <AlsoCalled team={team} data={data} agent={agent} />
        <Row label="Team file" hint={fileMessage ?? undefined}>
          <div className="inline">
            <button type="button" className="small" onClick={() => {
              window.aiTerminal.openTeamFile().then((result) => setFileMessage(result.ok ? `Opened ${result.path}` : `${result.path}: ${result.message ?? 'could not be opened'}`))
                .catch(() => setFileMessage('The team file could not be opened'))
            }}>Open team file</button>
            <button type="button" className="small" onClick={() => props.go({ name: 'changes' })}>See earlier changes</button>
          </div>
        </Row>
      </details>
    </>
  )
}

function hostOf(source: string): string {
  try {
    return new URL(source).hostname
  } catch {
    return source
  }
}

// ---------------------------------------------------------------------------------------------
// Team › New agent

function NewAgentPage(props: { team: TeamState; data: RosterDataShape; go(page: TeamPage): void }): React.JSX.Element {
  const { team, data } = props
  const [draft, setDraft] = useState<NewAgent>({ name: '', class: 'pawn', harness: 'claude', model: '', host: '', privateWork: 'public_only', roles: [], efforts: ['low'] })
  const [notes, setNotes] = useState('')
  const appId = useId()
  const answerId = useId()
  const set = (change: Partial<NewAgent>): void => setDraft((current) => ({ ...current, ...change }))
  const landing = landingFor(data, draft.harness, draft.host)
  const known = data.providers.find((provider) => provider.id === landing.provider.id)
  const answer: RosterPrivateWork = landing.isNew ? draft.privateWork : known?.private_work ?? 'public_only'
  const declared = landing.host === null && (data.harness_routes.find((route) => route.harness === draft.harness)?.basis ?? 'owner-declared') === 'owner-declared'
  const ready = draft.name.trim() !== '' && draft.model.trim() !== '' && draft.efforts.length > 0
  return (
    <>
      <PageHead title={<><button type="button" className="crumb" onClick={() => props.go({ name: 'agents' })}>Team</button> <span className="faint">›</span> New agent</>} />
      <h4 className="group-head">Model</h4>
      <Row label="Agent app" id={appId}>
        <Segmented labelledBy={appId} fit options={ROSTER_HARNESSES} value={draft.harness} optionLabel={(harness) => ROSTER_APP_NAMES[harness]} onChange={(harness: RosterHarness) => set({ harness })} />
      </Row>
      <Row label="Model"><input className="field mono" aria-label="Model" maxLength={128} placeholder="The model name the app takes" value={draft.model} onChange={(event) => set({ model: event.currentTarget.value })} /></Row>
      <Row label="Host" hint={`${landing.provider.name}${landing.isNew ? ' · new provider' : ''}`}>
        <input className="field mono" aria-label="Host" placeholder="Provider default" value={draft.host} onChange={(event) => set({ host: event.currentTarget.value })} />
      </Row>
      <Row label="Private work" id={answerId}
        hint={landing.isNew ? `First agent on ${landing.provider.name}. This answer covers every agent there.` : `Set once for ${landing.provider.name}; change it on any of its agents.`}>
        {landing.isNew
          ? <Segmented labelledBy={answerId} fit options={['allowed', 'public_only'] as const} value={draft.privateWork} optionLabel={(value) => PRIVATE_WORK_WORDS[value]} onChange={(privateWork) => set({ privateWork })} />
          : <span>{PRIVATE_WORK_WORDS[answer]}</span>}
      </Row>
      <Row label="Context limit" hint="Empty means the app's own default.">
        <NumberField label="Context limit" value={draft.contextLimit} placeholder="App default" onChange={(next) => setDraft((current) => {
          const rest = { ...current }
          delete rest.contextLimit
          return next === undefined ? rest : { ...rest, contextLimit: next }
        })} />
      </Row>
      <h4 className="group-head">Identity</h4>
      <Row label="Name"><input className="field" aria-label="Name" maxLength={40} value={draft.name} onChange={(event) => set({ name: event.currentTarget.value })} /></Row>
      <Row label="Class">
        <ClassChoice name="class-new" value={draft.class} onChange={(next) => set({ class: next, roles: draft.roles.filter((role) => classBar(next, role) === null) })} />
      </Row>
      <Row label="Notes" hint="Only you see this. The first line shows on the card.">
        <textarea className="field wide" aria-label="Notes" rows={2} maxLength={8000} placeholder="What it's good at, in your words" value={notes} onChange={(event) => setNotes(event.currentTarget.value)} />
      </Row>
      <h4 className="group-head">Work</h4>
      <Row label="Roles">
        <RoleChoices data={data} agentClass={draft.class} held={draft.roles}
          onToggle={(role) => set({ roles: draft.roles.includes(role) ? draft.roles.filter((entry) => entry !== role) : [...draft.roles, role] })} />
      </Row>
      <Row label="Efforts">
        <EffortChips efforts={draft.efforts} onToggle={(effort) => set({ efforts: ROSTER_EFFORTS.filter((entry) => (entry === effort ? !draft.efforts.includes(entry) : draft.efforts.includes(entry))) })} />
      </Row>
      <div className="page-foot">
        <span className="muted">{newAgentConsequence(draft.name, landing.provider.name, answer, declared)}</span>
        <span className="spacer" />
        <button type="button" onClick={() => props.go({ name: 'agents' })}>Cancel</button>
        <button type="button" className="primary" disabled={!ready} onClick={() => {
          const added = addAgent(data, draft)
          team.stage(added.data)
          if (notes.trim() !== '') team.setPendingNote(added.id, notes)
          props.go({ name: 'agents' })
        }}>Add to team</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Team › Roles

/** A chain in words and pieces: who gets the work in order, then what happens when all of them fail. */
/** A role's candidates in order, each as its piece, name and effort. */
function Steps(props: { candidates: readonly string[]; data: RosterDataShape }): React.JSX.Element {
  const { candidates, data } = props
  return (
    <>
      {candidates.length === 0 ? <span className="faint">Nobody yet</span> : null}
      {candidates.map((text, index) => {
        const candidate = parseCandidate(text)
        const agent = data.agents.find((entry) => entry.id === candidate.agent)
        const state = !agent ? 'unknown' : agent.status === 'proposed' ? 'proposed' : agent.enabled ? null : 'off'
        return (
          <span key={text} className="chain-step">
            {index > 0 ? <span className="faint" aria-hidden="true">›</span> : null}
            {agent ? <Piece agentClass={agent.class} /> : null}
            <span>{agent?.name ?? candidate.agent}{state ? `, ${state}` : ''}</span>
            <span className="effort mono">{effortWords(candidate)}</span>
            {agent && publicOnly(data, agent) ? <span className="faint">public work only</span> : null}
          </span>
        )
      })}
    </>
  )
}

export function Chain(props: { role: RosterRoleShape; data: RosterDataShape }): React.JSX.Element {
  const { role, data } = props
  return (
    <div className="chain">
      <Steps candidates={role.candidates} data={data} />
      <span className="chain-step"><span className="faint" aria-hidden="true">→</span><span className="muted">{THEN_WORDS[role.then]}</span></span>
    </div>
  )
}

/** One changed value, before and after; a role's order is drawn as its steps. */
function Difference(props: { line: DiffLine; data: RosterDataShape | null }): React.JSX.Element {
  const { line, data } = props
  const side = (candidates: string[] | null | undefined, words: string): ReactNode =>
    candidates && data ? <span className="chain"><Steps candidates={candidates} data={data} /></span> : words
  return <><span className="muted">{line.field}:</span> {side(line.chain?.before, line.before)} → {side(line.chain?.after, line.after)}</>
}

function ChainEditor(props: { team: TeamState; data: RosterDataShape; role: RosterRoleShape }): React.JSX.Element {
  const { team, data, role } = props
  const thenId = useId()
  const inChain = new Set(role.candidates.map((text) => parseCandidate(text).agent))
  const addable = data.agents.filter((agent) => !inChain.has(agent.id) && agent.efforts.length > 0 && classBar(agent.class, role.id) === null)
  return (
    <div className="chain-editor">
      {role.candidates.map((text, index) => {
        const candidate = parseCandidate(text)
        const agent = data.agents.find((entry) => entry.id === candidate.agent)
        const name = agent?.name ?? candidate.agent
        return (
          <div key={text} className="candidate">
            <span className="order">
              <button type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => team.stage(moveCandidate(data, role.id, index, -1))}>↑</button>
              <button type="button" aria-label={`Move ${name} down`} disabled={index === role.candidates.length - 1} onClick={() => team.stage(moveCandidate(data, role.id, index, 1))}>↓</button>
            </span>
            {agent ? <Piece agentClass={agent.class} /> : null}
            <span className="candidate-name">{name}</span>
            <span className="chips mono" role="group" aria-label={`${name} efforts for ${roleName(role.id)}`}>
              {(agent?.efforts ?? candidate.efforts).map((effort) => (
                <Chip key={effort} on={candidate.efforts.includes(effort)} onToggle={() => team.stage(toggleCandidateEffort(data, role.id, candidate.agent, effort))}>{effort}</Chip>
              ))}
            </span>
            {candidate.choice ? <span className="faint">the lead chooses</span> : null}
            <span className="spacer" />
            <button type="button" className="small" aria-label={`Remove ${name} from ${roleName(role.id)}`} onClick={() => team.stage(toggleAgentRole(data, candidate.agent, role.id))}>Remove</button>
          </div>
        )
      })}
      {addable.length > 0 ? (
        <div className="candidate">
          <span className="muted">Add</span>
          <span className="chips">
            {addable.map((agent) => (
              <button key={agent.id} type="button" className="chip" aria-label={`Add ${agent.name} to ${roleName(role.id)}`} onClick={() => team.stage(toggleAgentRole(data, agent.id, role.id))}>
                <Piece agentClass={agent.class} /> {agent.name}
              </button>
            ))}
          </span>
        </div>
      ) : null}
      <div className="candidate">
        <span className="muted" id={thenId}>If all of them fail</span>
        <Segmented labelledBy={thenId} fit options={ROSTER_THEN} value={role.then} optionLabel={(then) => THEN_WORDS[then]} onChange={(then) => team.stage(setRoleThen(data, role.id, then))} />
      </div>
    </div>
  )
}

function NewRole(props: { team: TeamState; data: RosterDataShape; done(): void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [line, setLine] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const usable = props.data.agents.filter((agent) => agent.efforts.length > 0)
  return (
    <form className="chain-editor" onSubmit={(event) => {
      event.preventDefault()
      props.team.stage(addRole(props.data, name, line, picked))
      props.done()
    }}>
      <div className="candidate"><input className="field" autoFocus aria-label="Role name" placeholder="Name, for example Tester" maxLength={32} value={name} onChange={(event) => setName(event.currentTarget.value)} /></div>
      <div className="candidate"><input className="field wide" aria-label="What the role does, in one line" placeholder="One line: what this role does" maxLength={160} value={line} onChange={(event) => setLine(event.currentTarget.value)} /></div>
      <div className="candidate">
        <span className="muted">Who, in order</span>
        <span className="chips" role="group" aria-label="Candidates">
          {usable.map((agent) => (
            <Chip key={agent.id} on={picked.includes(agent.id)} onToggle={() => setPicked(picked.includes(agent.id) ? picked.filter((id) => id !== agent.id) : [...picked, agent.id])}>
              <Piece agentClass={agent.class} /> {agent.name}
            </Chip>
          ))}
        </span>
      </div>
      <div className="candidate">
        <button type="submit" disabled={name.trim() === ''}>Add role</button>
        <button type="button" onClick={props.done}>Cancel</button>
      </div>
    </form>
  )
}

function RolesPage(props: { team: TeamState; data: RosterDataShape }): React.JSX.Element {
  const { team, data } = props
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  return (
    <>
      <PageHead title="Roles" status="Who gets each kind of work, in order">
        {team.changed.has('roles') ? <Dot label="Unapproved change" /> : null}
        <button type="button" onClick={() => setAdding(true)}>New role</button>
      </PageHead>
      {adding ? <NewRole team={team} data={data} done={() => setAdding(false)} /> : null}
      {data.roles.map((role) => (
        <div key={role.id} className="role">
          <div className="list-line">
            <div>
              <b>{roleName(role.id)}</b>{role.description ? <span className="line-detail"> {role.description}</span> : null}
              <Chain role={role} data={data} />
            </div>
            <button type="button" className="small" aria-expanded={editing === role.id} aria-label={`${editing === role.id ? 'Done editing' : 'Edit'} ${roleName(role.id)}`}
              onClick={() => setEditing(editing === role.id ? null : role.id)}>{editing === role.id ? 'Done' : 'Edit'}</button>
          </div>
          {editing === role.id ? <ChainEditor team={team} data={data} role={role} /> : null}
        </div>
      ))}
      <p className="preferences-help">For private work, public-only agents are skipped and the next one takes the job.</p>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Team › Changes

function VersionView(props: { number: number; earlier: boolean }): React.JSX.Element {
  const [data, setData] = useState<RosterDataShape | null | 'missing'>(null)
  useEffect(() => {
    if (props.earlier) return
    let cancelled = false
    window.aiTerminal.agentsGeneration(props.number).then((version) => { if (!cancelled) setData(version?.data ?? 'missing') }).catch(() => { if (!cancelled) setData('missing') })
    return () => { cancelled = true }
  }, [props.number, props.earlier])
  if (props.earlier) return <p className="page-note">This version was approved under an earlier layout of the team file. It can be viewed in the file's history, never restored.</p>
  if (data === null) return <p className="page-note">Reading version {props.number}…</p>
  if (data === 'missing') return <p className="page-note">Version {props.number} cannot be read.</p>
  return (
    <div className="version-view">
      {data.agents.map((agent) => (
        <div key={agent.id} className="version-agent">
          <Piece agentClass={agent.class} />
          <span>{agent.name}</span>
          <span className="muted">{CLASS_WORDS[agent.class].name}{agent.status === 'proposed' ? ', proposed' : agent.enabled ? '' : ', off'}</span>
          <span className="faint">{ROSTER_APP_NAMES[agent.harness]} · <span className="mono">{agent.model}</span>{publicOnly(data, agent) ? ' · public work only' : ''}</span>
        </div>
      ))}
      {data.roles.map((role) => <div key={role.id} className="version-role"><span>{roleName(role.id)}</span><Chain role={role} data={data} /></div>)}
    </div>
  )
}

function ChangesPage(props: { team: TeamState }): React.JSX.Element {
  const { team } = props
  const [viewing, setViewing] = useState<number | null>(null)
  const history = team.snapshot?.history ?? []
  const current = team.snapshot?.approved?.generation ?? null
  const roleIds = roleIdsOf(team.data, team.approved)
  const title = (entry: AgentsGenerationSummary): string => !entry.valid ? 'This version cannot be read'
    : entry.summary !== undefined ? summaryWords(entry.summary, roleIds) : entry.earlier_schema === undefined ? 'Approved' : 'Approved under an earlier layout'
  return (
    <>
      <PageHead title="Changes" status="Every approved version of the team" />
      {history.length === 0 ? <FirstApproval team={team} /> : null}
      {history.map((entry) => (
        <div key={entry.number} className="role">
          <div className="list-line">
            <div><b>{title(entry)}</b> <span className="line-detail">version {entry.number} · {shortDate(entry.created_at)}{entry.number === current ? ' · in effect' : ''}</span></div>
            <span className="inline">
              <button type="button" className="small" disabled={!entry.valid} aria-expanded={viewing === entry.number} aria-label={`View version ${entry.number}`}
                onClick={() => setViewing(viewing === entry.number ? null : entry.number)}>{viewing === entry.number ? 'Close' : 'View'}</button>
              {entry.valid && entry.earlier_schema === undefined && entry.number !== current ? (
                <button type="button" className="small" disabled={team.busy || team.hasStaged} aria-label={`Restore version ${entry.number}`}
                  onClick={() => void team.requestApproval({ kind: 'restore', number: entry.number }, { title: `Restore version ${entry.number}`, action: 'Restore' }, true)}>Restore…</button>
              ) : null}
            </span>
          </div>
          {viewing === entry.number ? <VersionView number={entry.number} earlier={entry.earlier_schema !== undefined} /> : null}
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// The pages and their footer

export function TeamPreferences(props: { team: TeamState; page: TeamPage; go(page: TeamPage): void }): React.JSX.Element {
  const { team, page } = props
  const snapshot = team.snapshot
  if (team.loadError) return <><PageHead title="Team" /><p className="preferences-error" role="alert">{team.loadError}</p></>
  if (snapshot === null) return <><PageHead title="Team" /><p className="page-note">Reading the team…</p></>
  if (!snapshot.file.exists) {
    return (
      <>
        <PageHead title="Team" status="No team yet" />
        <p className="page-note">Your agents, the providers they run on and who does which job live in one file. Start with an empty team and add agents here.</p>
        <button type="button" className="primary" disabled={team.busy} onClick={() => {
          window.aiTerminal.startTeam().then((result) => { team.setNotice({ ok: result.ok, text: result.message }); return team.reload() })
            .catch(() => team.setNotice({ ok: false, text: 'The team file could not be created' }))
        }}>Start a team</button>
      </>
    )
  }
  const data = team.data
  if (data === null) {
    return (
      <>
        <PageHead title="Team" status="The team file needs fixing">
          <button type="button" onClick={() => void team.reload()}>Check again</button>
        </PageHead>
        <p className="page-note">BMN cannot read <span className="mono">{displayPath(snapshot.rosterPath, snapshot.home)}</span>. Nothing in it takes effect until it is fixed and approved.</p>
        <Issues issues={snapshot.file.errors} />
        <button type="button" onClick={() => void window.aiTerminal.openTeamFile()}>Open team file</button>
      </>
    )
  }
  if (page.name === 'new') return <NewAgentPage team={team} data={data} go={props.go} />
  if (page.name === 'roles') return <RolesPage team={team} data={data} />
  if (page.name === 'changes') return <ChangesPage team={team} />
  const agent = page.name === 'agent' ? data.agents.find((entry) => entry.id === page.id) : undefined
  if (agent) return <AgentPage key={agent.id} team={team} data={data} agent={agent} go={props.go} />
  return <AgentsPage team={team} data={data} go={props.go} />
}

function ReviewGroups(props: { groups: readonly DiffGroup[]; general: readonly string[]; data: RosterDataShape | null }): React.JSX.Element {
  return (
    <div className="review">
      {props.groups.map((group) => (
        <div key={group.key} className="review-group">
          <span className="review-subject">{group.agent ? <Piece agentClass={group.agent.class} /> : null}{group.subject}</span>
          <div>
            {group.lines.map((line, index) => <div key={index}><Difference line={line} data={props.data} /></div>)}
            {group.role && props.data ? <Chain role={group.role} data={props.data} /> : null}
            {group.consequences.map((sentence) => <div key={sentence} className="consequence">{sentence}</div>)}
          </div>
        </div>
      ))}
      {props.general.map((sentence) => <div key={sentence} className="consequence">{sentence}</div>)}
    </div>
  )
}

/**
 * The footer under the Team pages: the staged edits with Review, Discard and Approve; the
 * confirmation an approving control commits from, with the rules files it would also update;
 * and what the last action did.
 */
export function TeamLedger(props: { team: TeamState }): React.JSX.Element | null {
  const { team } = props
  const [reviewing, setReviewing] = useState(false)
  // Review belongs to the edits it was opened for; the next ones start closed.
  useEffect(() => { if (!team.hasStaged) setReviewing(false) }, [team.hasStaged])
  const home = team.snapshot?.home ?? null
  const confirmation = team.confirmation
  const preview = team.preview
  const undo = team.rulesUndo
  if (!team.hasStaged && confirmation === null && undo === null) return null
  const staged = preview === null ? null : groupDifferencesFor(team)
  const also = preview ? teamUpdateWords(preview.teamUpdate.length) : null
  const first = team.snapshot !== null && team.snapshot.approved === null
  return (
    <footer className="ledger">
      {undo ? (
        <div className="ledger-sheet" role="group" aria-label="Undo the rules update">
          <b>Undo the rules update</b>
          <p className="preferences-help">Each file goes back to what it was before the update. The team stays as approved.</p>
          {undo.plan.targets.map((target) => (
            <details key={target.harness} className="rules-target">
              <summary><span>{ROSTER_APP_NAMES[target.harness]}</span> <TargetPath target={target} home={home} /> <span className="faint">{undoWords(target)}</span></summary>
              <pre className="diff">{diffBody(target.diff) || 'No change.'}</pre>
            </details>
          ))}
          <div className="inline">
            <button type="button" className="primary" disabled={team.busy || undo.plan.planHash === null} onClick={() => void team.confirmRulesUndo()}>Undo update</button>
            <button type="button" disabled={team.busy} onClick={team.cancelRulesUndo}>Cancel</button>
          </div>
        </div>
      ) : confirmation ? (
        <div className="ledger-sheet" role="group" aria-label={confirmation.title}>
          <b>{confirmation.title}</b>
          {(() => {
            const grouped = groupFor(confirmation.preview, team)
            return <ReviewGroups groups={grouped.groups} general={grouped.general} data={team.data} />
          })()}
          {confirmation.preview.teamUpdate.length > 0 ? (
            <>
              <div className="consequence">{teamUpdateWords(confirmation.preview.teamUpdate.length)}</div>
              {confirmation.preview.teamUpdate.map((target) => (
                <details key={target.harness} className="rules-target">
                  <summary><span>{ROSTER_APP_NAMES[target.harness]}</span> <TargetPath target={target} home={home} /> <span className="faint">{target.kind === 'full' ? 'Full rules' : 'Public sections only'}</span></summary>
                  <pre className="diff">{diffBody(target.diff)}</pre>
                </details>
              ))}
            </>
          ) : null}
          <div className="inline">
            <button type="button" className="primary" disabled={team.busy} onClick={() => void team.commit()}>{confirmation.action}</button>
            <button type="button" disabled={team.busy} onClick={team.cancelConfirmation}>Cancel</button>
          </div>
        </div>
      ) : team.hasStaged ? (
        <>
          <div className="ledger-line">
            <Dot label="Unapproved change" />
            <b>{preview === null ? 'Checking the change…' : first ? 'First approval' : preview.valid ? summarize(preview.differences) : 'Unapproved changes'}</b>
            <span className="muted">{preview === null ? '' : !preview.valid ? 'This would not be a valid team' : first ? firstApprovalWords(team.data) : firstConsequence(preview.consequences, staged?.groups ?? [], roleIdsOf(team.data, team.approved))}</span>
            <span className="actions">
              <button type="button" aria-expanded={reviewing} disabled={preview === null} onClick={() => setReviewing(!reviewing)}>Review</button>
              <button type="button" disabled={team.busy} onClick={() => { setReviewing(false); team.discard() }}>Discard</button>
              <button type="button" className="primary" disabled={team.busy || preview === null || !preview.valid || team.data === null}
                onClick={() => { if (team.data) void team.requestApproval({ kind: 'staged', data: team.data }, { title: first ? 'Approve the team for the first time' : 'Approve these changes', action: 'Approve' }) }}>Approve</button>
            </span>
          </div>
          {preview && !preview.valid ? <Issues issues={preview.errors} /> : null}
          {reviewing && preview?.valid && staged ? (
            <div className="ledger-sheet">
              <ReviewGroups groups={staged.groups} general={staged.general} data={team.data} />
              {also ? <div className="consequence">{also}</div> : null}
              <p className="preferences-help">Approve saves exactly this. If the team file changed meanwhile, BMN reloads instead.</p>
            </div>
          ) : null}
        </>
      ) : null}
    </footer>
  )
}

/**
 * A rules file as a confirmation names it: its path and, when a link on the way to it leads
 * elsewhere, the place the write would really land (R60-NFR2).
 */
export function TargetPath(props: { target: { path: string; resolvedPath?: string }; home: string | null }): React.JSX.Element {
  const { target, home } = props
  return (
    <span className="target-path">
      <span className="path mono" title={target.path}>{displayPath(target.path, home)}</span>
      {target.resolvedPath ? <span className="path mono" title={target.resolvedPath}>→ {displayPath(target.resolvedPath, home)}</span> : null}
    </span>
  )
}

/** What a first approval puts into effect, counted. */
export function firstApprovalWords(data: RosterDataShape | null): string {
  const agents = agentGroups(data ?? { schema_version: 2, agents: [], roles: [], providers: [], exceptions: [], harness_routes: [] }).active.length
  const roles = data?.roles.length ?? 0
  return `${agents} active agent${agents === 1 ? '' : 's'} and ${roles} role${roles === 1 ? '' : 's'} take effect`
}

/** The footer's one line of meaning: the first consequence, else the first changed value. */
function firstConsequence(consequences: readonly string[], groups: readonly DiffGroup[], roleIds: ReadonlySet<string>): string {
  const line = groups[0]?.lines[0]
  if (consequences[0] !== undefined) return consequenceWords(consequences[0], roleIds)
  return groups[0] && line ? `${groups[0].subject}: ${line.field.toLowerCase()} ${line.before} → ${line.after}` : ''
}

/** What a review lists: the grouped differences, or for a first approval what each agent and role could then do. */
function groupFor(preview: NonNullable<TeamState['preview']>, team: TeamState): { groups: DiffGroup[]; general: string[] } {
  if (team.snapshot?.approved === null && team.data !== null) return firstApprovalGroups(team.data, preview.consequences)
  return groupDifferences(preview.differences, team.data, team.approved, preview.consequences)
}

/**
 * What the last action did, floating over the foot of the dialog so it takes no room from the
 * page: a success goes away by itself, a failure stays until dismissed.
 */
export function TeamToast(props: { team: TeamState }): React.JSX.Element | null {
  const { team } = props
  const notice = team.notice
  if (notice === null) return null
  return (
    <div className={notice.ok ? 'toast' : 'toast failed'} role={notice.ok ? 'status' : 'alert'}>
      <span className={notice.ok ? undefined : 'error-text'}>{notice.text}</span>
      {notice.issues ? <Issues issues={notice.issues} /> : null}
      {notice.undo ? <button type="button" className="small" disabled={team.busy} onClick={() => void team.undoRulesUpdate(notice.undo ?? '')}>Undo</button> : null}
      {notice.ok ? null : <button type="button" className="small" aria-label="Dismiss the message" onClick={() => team.setNotice(null)}>Dismiss</button>}
    </div>
  )
}

function groupDifferencesFor(team: TeamState): { groups: DiffGroup[]; general: string[] } | null {
  return team.preview === null ? null : groupFor(team.preview, team)
}
