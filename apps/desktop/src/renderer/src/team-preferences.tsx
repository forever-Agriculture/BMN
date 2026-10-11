// MODULE: team-preferences.tsx - Epic 60.5: Preferences › Team: agents as solid cards, an agent's rows, New agent, role chains, approved versions and the approval footer
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  ROSTER_APP_NAMES,
  ROSTER_CLASSES,
  ROSTER_EFFORTS,
  ROSTER_HARNESSES,
  ROSTER_THEN,
  type AgentAppView,
  type ContextLimitView,
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
import { ModelField } from './model-field'
import { modelSourceWords, modelSuggestions, type ReportedModel } from './model-suggestions'
import { ModelsPage, researchedModels, type ResearchState } from './models-preferences'
import { dayWords, fillFrom, fillWords, lookupFits, priceText, type ResearchFill } from './research-view'
import { Dot, Piece } from './roster-marks'
import {
  CLASS_WORDS,
  PRIVATE_WORK_WORDS,
  THEN_WORDS,
  activateAgent,
  addAgent,
  addRole,
  agentGroups,
  changeModel,
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
  modelTwin,
  moveCandidate,
  newAgentConsequence,
  parseCandidate,
  priceWords,
  roleIdsOf,
  providerOf,
  publicOnly,
  removeException,
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
  unrecordedBasis,
  updateAgent,
  type DiffGroup,
  type DiffLine,
  type NewAgent
} from './roster-staging'
import { displayPath } from './session-presentation'
import type { TeamState } from './team-state'

/** Each agent app as BMN inspected it (Rules › Health), or null while that was not read. */
type Apps = readonly AgentAppView[] | null
/** Each app's context-limit setting as Rules › Health reads it; null before the rules were read. */
type Context = readonly ContextLimitView[] | null
/** What the apps reported in sessions that are running now. */
type Reported = readonly ReportedModel[]

export type TeamPage = { name: 'agents' } | { name: 'agent'; id: string } | { name: 'new'; fill?: ResearchFill } | { name: 'roles' } | { name: 'models' } | { name: 'changes' }

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
export function tokens(text: string): number | undefined | null {
  const digits = text.replace(/[\s,_]/g, '')
  if (digits === '') return undefined
  return /^\d{1,9}$/.test(digits) && Number(digits) > 0 ? Number(digits) : null
}

/**
 * A number of tokens. A value that is not one, or that `refuse` names a reason against, stays in
 * the field marked invalid with the reason beside it, and is never handed on.
 */
export function NumberField(props: {
  label: string; value: number | undefined; placeholder?: string; onChange(next: number | undefined): void
  /** Why a number may not be taken, in words, or null when it may. */
  refuse?: ((value: number) => string | null) | undefined
}): React.JSX.Element {
  const [text, setText] = useState(props.value === undefined ? '' : thousands(props.value))
  useEffect(() => setText(props.value === undefined ? '' : thousands(props.value)), [props.value])
  const parsed = tokens(text)
  const refusal = typeof parsed === 'number' ? props.refuse?.(parsed) ?? null : null
  return (
    <>
      <input className="field number mono" inputMode="numeric" aria-label={props.label} aria-invalid={parsed === null || refusal !== null} placeholder={props.placeholder} value={text}
        onChange={(event) => {
          setText(event.currentTarget.value)
          const next = tokens(event.currentTarget.value)
          if (next !== null && (next === undefined || (props.refuse?.(next) ?? null) === null)) props.onChange(next)
        }} />
      {refusal !== null ? <span className="field-refusal" role="alert">{refusal}</span> : null}
    </>
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
      <span className="muted">in the team file:</span>
      <span className="outside-diff">{group.lines.filter((line) => line.detail !== true).map((line, index) => <span key={index} className="difference"><Difference line={line} data={team.data} /></span>)}</span>
      <span className="actions">
        <button type="button" className="small" disabled={team.busy} aria-label={`Keep the change to ${group.subject}`}
          onClick={() => void team.requestApproval({ kind: 'sections', scope: [group.key] }, { title: `Keep the change to ${group.subject}`, action: 'Keep' })}>Keep</button>
        <button type="button" className="small" disabled={team.busy} aria-label={`Revert the change to ${group.subject}`} onClick={() => void team.revert([group.key])}>Revert</button>
      </span>
    </div>
  )
}

/** "3 changes" for the rows that follow. */
export function outsideCountWords(count: number): string {
  return `${count} change${count === 1 ? '' : 's'}`
}

/**
 * Why the rows below exist: the team file was edited where BMN did not stage it. More than one row
 * can be kept or put back together; keeping opens the sheet first, since it commits every row at once.
 */
function OutsideHead(props: { team: TeamState }): React.JSX.Element {
  const { team } = props
  const count = team.outside.groups.length
  return (
    <div className="outside-row outside-head">
      <Dot label="Needs you" />
      <span className="outside-why">The team file was edited directly, not on these pages: by hand, by a script or by an agent. The approved team stays in effect until you keep {count === 1 ? 'the change' : 'them'}.</span>
      {count > 1 ? (
        <span className="actions">
          <button type="button" className="small" disabled={team.busy} aria-label={`Keep all ${outsideCountWords(count)} to the team file`}
            onClick={() => void team.requestApproval({ kind: 'file' }, { title: `Keep all ${outsideCountWords(count)}`, action: 'Keep all' }, true)}>Keep all…</button>
          <button type="button" className="small" disabled={team.busy} aria-label={`Revert all ${outsideCountWords(count)} to the team file`} onClick={() => void team.revert(null)}>Revert all</button>
        </span>
      ) : null}
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
      <PageHead title="Team" status={team.snapshot?.approved ? `Approved ${shortDate(team.snapshot.approved.createdAt)}` : damagedApproval(team) ? 'The approved team cannot be read' : 'Nothing approved yet'}>
        <button type="button" onClick={() => props.go({ name: 'new' })}>New agent</button>
      </PageHead>
      {team.snapshot?.approved || team.hasStaged ? null : <FirstApproval team={team} />}
      {team.snapshot?.file.link ? (
        <p className="page-note">
          The team file is a link to <span className="path mono" title={team.snapshot.file.link}>{displayPath(team.snapshot.file.link, team.snapshot.home)}</span>.
          {' '}A change saved from these pages replaces the link with a regular file here; the file it points to stays as it is.
        </p>
      ) : null}
      {team.outside.groups.length > 0 ? <OutsideHead team={team} /> : null}
      {team.outside.groups.map((group) => <OutsideRow key={group.key} group={group} team={team} />)}
      {data.agents.length === 0 ? <p className="page-note">No agents yet. New agent adds the first one.</p> : null}
      {cards('Active', groups.active, 'Prices per M tokens, in / out')}
      {cards('Proposed', groups.proposed)}
      {cards('Off', groups.off)}
    </>
  )
}

/** Whether an approval exists that BMN can no longer read: damaged or altered, so nothing is in effect. */
function damagedApproval(team: TeamState): boolean {
  return team.snapshot?.approved === null && team.snapshot.approvalProblem?.code === 'STATE_CORRUPT'
}

/** What the owner reads while nothing is in effect: never approved, or approved and no longer readable. */
export function nothingInEffectWords(damaged: boolean, lastGood: number | null): string {
  if (!damaged) return 'Nothing here takes effect until you approve the team for the first time.'
  return `BMN cannot read the approved team, so nothing here is in effect. ${lastGood === null ? 'Approve the team again.' : `Version ${lastGood} still reads: restore it on Changes, or approve the team again.`}`
}

/** With nothing approved, no agent, role or provider answer takes effect: say so, and why, and offer the approval. */
function FirstApproval(props: { team: TeamState }): React.JSX.Element {
  const damaged = damagedApproval(props.team)
  const title = damaged ? 'Approve the team again' : 'Approve the team for the first time'
  return (
    <div className="outside-row">
      <Dot label="Needs you" />
      <span>{nothingInEffectWords(damaged, props.team.snapshot?.approvalProblem?.lastGood ?? null)}</span>
      <span className="actions">
        <button type="button" className="primary small" disabled={props.team.busy}
          onClick={() => void props.team.requestApproval({ kind: 'file' }, { title, action: 'Approve' }, true)}>Approve…</button>
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

/**
 * The workspaces in which a provider that may otherwise see public work only was allowed (60.8
 * AC5). One is added from the card a stopped prompt raises; taking one away here is a staged
 * change, approved like any other. `provider` limits the list to one provider's.
 */
export function AllowedWorkspaces(props: { team: TeamState; data: RosterDataShape; provider?: string }): React.JSX.Element | null {
  const { team, data } = props
  const entries = data.exceptions.filter((entry) => props.provider === undefined || entry.provider === props.provider)
  const nameOf = (id: string): string => data.providers.find((provider) => provider.id === id)?.name ?? id
  if (entries.length === 0) return props.provider === undefined ? null : <span className="line-detail">None</span>
  return (
    <div className="allowed-workspaces">
      {entries.map((entry) => (
        <div key={entry.id} className="list-line">
          <div>{props.provider === undefined ? <><b>{nameOf(entry.provider)}</b>{' '}</> : null}<span className="path mono wrap">{entry.folder}</span></div>
          <button type="button" className="small" aria-label={`Stop allowing ${nameOf(entry.provider)} in ${entry.folder}`}
            onClick={() => team.stage(removeException(data, entry.id))}>Remove</button>
        </div>
      ))}
    </div>
  )
}

/** What the Host row selects for a recorded host: nothing while none is recorded, since the check then refuses the agent. */
export function hostKind(host: string | null): 'default' | 'custom' | null {
  return host === null ? null : host === 'default' ? 'default' : 'custom'
}

function HostRow(props: { team: TeamState; data: RosterDataShape; agent: RosterAgentShape; apps: Apps }): React.JSX.Element {
  const { team, data, agent } = props
  const labelId = useId()
  const custom = hostKind(agent.host) === 'custom'
  const [kind, setKind] = useState<'default' | 'custom' | null>(hostKind(agent.host))
  const [host, setHost] = useState(custom ? agent.host ?? '' : '')
  const [answer, setAnswer] = useState<RosterPrivateWork>('public_only')
  const answerId = useId()
  const landing = landingFor(data, agent.harness, kind === 'custom' ? host : '')
  const pending = kind === 'custom' && host.trim() !== '' && host.trim().toLowerCase() !== agent.host
  return (
    <Row label="Host" id={labelId} hint={agent.host === null ? `No host is recorded, so BMN refuses every request for ${agent.name}. Choose one.`
      : 'A custom host counts as its own provider; BMN asks once whether it may see private work.'}>
      <Segmented<'default' | 'custom' | null> labelledBy={labelId} fit options={['default', 'custom']} value={kind} optionLabel={(value) => (value === 'default' ? 'Provider default' : 'Custom host')}
        onChange={(value) => {
          setKind(value)
          if (value === 'default' && agent.host !== 'default') team.stage(moveAgent(data, agent.id, agent.harness, '', 'public_only', props.apps))
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
          {pending ? <button type="button" className="small" onClick={() => team.stage(moveAgent(data, agent.id, agent.harness, host, answer, props.apps))}>Use this host</button> : null}
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
    <Row label="Also called" hint="Other names allowed for this agent. BMN does not check what the app maps them to.">
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

/** Why a context limit may not be taken: only a size above what the model holds. */
export function limitRefusal(agent: Pick<RosterAgentShape, 'context_window' | 'compact_at'>, value: number): string | null {
  if (agent.context_window !== undefined && value > agent.context_window) return `Above the model's ${thousands(agent.context_window)} tokens`
  return agent.compact_at !== undefined && value <= agent.compact_at ? `Must be above Compact at, ${thousands(agent.compact_at)}` : null
}

export function compactRefusal(agent: Pick<RosterAgentShape, 'context_limit'>, value: number): string | null {
  return agent.context_limit !== undefined && value >= agent.context_limit ? `Must be below the context limit, ${thousands(agent.context_limit)}` : null
}

/** What the limit does on this agent's app today: applied, or not supported yet on the installed version (60.9 AC1). */
export function contextLimitHint(agent: Pick<RosterAgentShape, 'harness' | 'context_limit'>, context: Context): string {
  const base = "Empty means the app's own default."
  if (agent.context_limit === undefined || context === null) return base
  const app = ROSTER_APP_NAMES[agent.harness]
  const row = context.find((entry) => entry.harness === agent.harness)
  if (row === undefined) return `Not supported yet: BMN has no context setting for ${app}. The limit is kept but not applied.`
  if (!row.limitProven) return `Not supported yet on ${app}${row.version ? ` ${row.version}` : ''}: kept but not applied until its test passes in Rules › Health.`
  if (row.min !== undefined && row.max !== undefined && (agent.context_limit < row.min || agent.context_limit > row.max)) return `${app} takes ${thousands(row.min)} to ${thousands(row.max)} tokens; a run with this limit is refused.`
  return `Added to each run BMN or dev-auto starts with this agent, and checked before it leaves. ${base}`
}

export function compactHint(agent: Pick<RosterAgentShape, 'harness'>, context: Context): string {
  const base = 'The app starts summarising the conversation here.'
  if (context === null) return base
  const row = context.find((entry) => entry.harness === agent.harness)
  return row?.compactProven ? base : `Not supported yet on ${ROSTER_APP_NAMES[agent.harness]}: kept but not applied. ${base}`
}

function AgentPage(props: { team: TeamState; data: RosterDataShape; agent: RosterAgentShape; apps: Apps; context: Context; reported: Reported; research: ResearchState | null; go(page: TeamPage): void }): React.JSX.Element {
  const researched = researchedModels(props.research?.snapshot ?? null)
  const { team, data, agent } = props
  // A price and a capacity belong to a model: once the name changes they still describe the old one until the owner says otherwise.
  const before = team.approved?.agents.find((entry) => entry.id === agent.id)
  const renamed = before !== undefined && before.model !== agent.model ? before.model : null
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  // Another agent on the new model: what the team recorded for it was taken over with the name.
  const twin = renamed === null ? undefined : modelTwin({ ...data, agents: data.agents.filter((entry) => entry.id !== agent.id) }, agent.harness, agent.provider, agent.model)
  const twinPrice = twin?.price !== undefined && same(agent.price, twin.price)
  const twinCapacity = twin?.context_window !== undefined && agent.context_window === twin.context_window
  const oldPrice = renamed !== null && agent.price !== undefined && !twinPrice && same(agent.price, before?.price)
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
          onChange={(harness: RosterHarness) => team.stage(moveAgent(data, agent.id, harness, agent.host === 'default' || agent.host === null ? '' : agent.host, 'public_only', props.apps))} />
      </Row>
      <Row label="Model">
        <ModelField value={agent.model} hint={modelSourceWords(agent.model, data, agent.harness, props.reported, { self: agent.id, ...(before ? { approved: before.model } : {}), ...(researched ? { research: researched } : {}) })}
          suggest={(query) => modelSuggestions(data, agent.harness, props.reported, query, agent.id, researched)} onChange={(model) => team.stage(changeModel(data, agent.id, model, before))} />
      </Row>
      <PrivateWorkRow team={team} data={data} agent={agent} />
      <Row label="Price" hint={twinPrice && twin ? `Taken from ${twin.name}, which uses the same model.`
        : oldPrice ? `Recorded for ${renamed}. Clear it unless the new model costs the same.`
        : agent.price ? [agent.price.source ? hostOf(agent.price.source) : null, agent.price.as_of].filter(Boolean).join(', ') || undefined : 'No price recorded.'}>
        <span className="mono">{price ?? '—'}</span>{price ? <span className="faint"> per M tokens, in / out</span> : null}
        {oldPrice ? <button type="button" className="small" aria-label={`Clear the price recorded for ${renamed}`} onClick={() => patch({ price: undefined })}>Clear</button> : null}
      </Row>
      <Row label="Context limit" hint={contextLimitHint(agent, props.context)}>
        <div className="inline">
          {/* Clearing the limit clears where summarising starts with it: one has no meaning without the other. */}
          <NumberField label="Context limit" value={agent.context_limit} placeholder="App default" refuse={(value) => limitRefusal(agent, value)}
            onChange={(next) => patch(next === undefined ? { context_limit: undefined, compact_at: undefined } : { context_limit: next })} />
          <span className="faint">{agent.context_window ? `of ${thousands(agent.context_window)} tokens${twinCapacity && twin ? `, taken from ${twin.name}` : renamed !== null && agent.context_window === before?.context_window ? `, recorded for ${renamed}` : ''}` : 'capacity unknown'}</span>
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
        {agent.context_limit !== undefined ? (
          <Row label="Compact at" hint={compactHint(agent, props.context)}>
            <NumberField label="Compact at" value={agent.compact_at} placeholder="App default" refuse={(value) => compactRefusal(agent, value)} onChange={(next) => patch({ compact_at: next })} />
          </Row>
        ) : null}
        <HostRow key={`${agent.id}-${agent.host}`} team={team} data={data} agent={agent} apps={props.apps} />
        <AlsoCalled team={team} data={data} agent={agent} />
        {publicOnly(data, agent) || data.exceptions.some((entry) => entry.provider === agent.provider) ? (
          <Row label="Allowed workspaces" hint={`Where ${providerOf(data, agent)?.name ?? agent.provider} may see private work although it otherwise may not. One is added from the card a stopped prompt shows.`}>
            <AllowedWorkspaces team={team} data={data} provider={agent.provider} />
          </Row>
        ) : null}
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

/** New agent as it opens: empty, or with what research found of one model. */
function newDraft(fill?: ResearchFill): NewAgent {
  return {
    name: '', class: 'pawn', harness: fill?.harness ?? 'claude', model: fill?.model ?? '', host: '', privateWork: 'public_only', roles: [], efforts: ['low'],
    ...(fill?.price ? { price: fill.price } : {}), ...(fill?.contextWindow ? { contextWindow: fill.contextWindow } : {})
  }
}

/** A draft without what research filled in: the model changed, or the owner undid it. */
function withoutFill(draft: NewAgent): NewAgent {
  const rest = { ...draft }
  delete rest.price
  delete rest.contextWindow
  return rest
}

function NewAgentPage(props: { team: TeamState; data: RosterDataShape; apps: Apps; reported: Reported; research: ResearchState | null; fill?: ResearchFill | undefined; go(page: TeamPage): void }): React.JSX.Element {
  const { team, data, research } = props
  const [draft, setDraft] = useState<NewAgent>(() => newDraft(props.fill))
  // What research filled in, said once with the draft as it was before, so one Undo takes it all back.
  const [filled, setFilled] = useState<{ words: string; before: NewAgent } | null>(() => (props.fill ? { words: fillWords(props.fill), before: newDraft() } : null))
  const [lookup, setLookup] = useState<{ ok: boolean; text: string } | null>(null)
  const [looking, setLooking] = useState(false)
  const researched = researchedModels(research?.snapshot ?? null)
  const canResearch = research?.snapshot?.researcher != null
  const [notes, setNotes] = useState('')
  const appId = useId()
  const answerId = useId()
  const set = (change: Partial<NewAgent>): void => setDraft((current) => ({ ...current, ...change }))
  const landing = landingFor(data, draft.harness, draft.host)
  const known = data.providers.find((provider) => provider.id === landing.provider.id)
  const answer: RosterPrivateWork = landing.isNew ? draft.privateWork : known?.private_work ?? 'public_only'
  const declared = landing.host === null
    && (data.harness_routes.find((route) => route.harness === draft.harness)?.basis ?? unrecordedBasis(draft.harness, landing.provider.id, props.apps)) === 'owner-declared'
  const twin = modelTwin(data, draft.harness, landing.provider.id, draft.model)
  // Until the owner picks efforts himself, a new agent takes the ones of an agent on the same model.
  const [ownEfforts, setOwnEfforts] = useState(false)
  const efforts = ownEfforts || !twin ? draft.efforts : twin.efforts
  const ready = draft.name.trim() !== '' && draft.model.trim() !== '' && efforts.length > 0
  const price = draft.price ?? twin?.price
  const capacity = draft.contextWindow ?? twin?.context_window
  // The form as it is at this moment, for an answer that arrives later than the render that asked.
  const latest = useRef(draft)
  latest.current = draft
  const lookUp = async (): Promise<void> => {
    if (research === null) return
    const asked = { model: draft.model.trim(), provider: landing.provider.id }
    const name = asked.model
    setLooking(true)
    setLookup(null)
    const result = await research.lookUp(asked.provider, name)
    setLooking(false)
    if (!result.ok || result.model === null) return setLookup({ ok: false, text: result.message })
    // The fields stayed open meanwhile: an answer about one model never fills the form of another.
    const now = latest.current
    if (!lookupFits(asked, { model: now.model.trim(), provider: landingFor(data, now.harness, now.host).provider.id }, result.model.id)) {
      return setLookup({ ok: false, text: `Research answered for ${name}, but the model, app or host changed meanwhile. Nothing was filled in; look it up again.` })
    }
    const fill = fillFrom(result.model, data)
    if (fill.price === undefined && fill.contextWindow === undefined) return setLookup({ ok: false, text: `Research answered for ${name}, but BMN could not confirm a price or a capacity on the pages it cited.` })
    setFilled({ words: fillWords(fill, true), before: now })
    setDraft((current) => ({ ...current, ...(fill.price ? { price: fill.price } : {}), ...(fill.contextWindow ? { contextWindow: fill.contextWindow } : {}) }))
  }
  return (
    <>
      <PageHead title={<><button type="button" className="crumb" onClick={() => props.go({ name: 'agents' })}>Team</button> <span className="faint">›</span> New agent</>} />
      {filled ? (
        <div className="page-note with-action" role="status">
          <span className="note-text">{filled.words}</span>
          <button type="button" className="small" onClick={() => { setDraft(filled.before); setFilled(null) }}>Undo</button>
        </div>
      ) : null}
      {lookup ? <p className={lookup.ok ? 'preferences-success' : 'preferences-error'} role={lookup.ok ? 'status' : 'alert'}>{lookup.text}</p> : null}
      <h4 className="group-head">Model</h4>
      <Row label="Agent app" id={appId}>
        <Segmented labelledBy={appId} fit options={ROSTER_HARNESSES} value={draft.harness} optionLabel={(harness) => ROSTER_APP_NAMES[harness]} onChange={(harness: RosterHarness) => set({ harness })} />
      </Row>
      <Row label="Model">
        <ModelField value={draft.model} placeholder="The model name the app takes" hint={modelSourceWords(draft.model, data, draft.harness, props.reported, researched ? { research: researched } : {})}
          suggest={(query) => modelSuggestions(data, draft.harness, props.reported, query, undefined, researched)}
          onChange={(model) => {
            // A price and a capacity belong to the name they were found for.
            setDraft((current) => ({ ...withoutFill(current), model }))
            setFilled(null)
          }} />
        <button type="button" className="small" disabled={looking || !canResearch || draft.model.trim() === ''} aria-label="Look up this model"
          title={canResearch ? 'Asks your researcher for this model\'s published price and capacity' : 'No agent on your team can research'} onClick={() => void lookUp()}>
          {looking ? 'Looking up…' : 'Look up'}
        </button>
      </Row>
      <Row label="Host" hint={`${landing.provider.name}${landing.isNew ? ' · new provider' : ''}`}>
        <input className="field mono" aria-label="Host" placeholder="Provider default" value={draft.host} onChange={(event) => set({ host: event.currentTarget.value })} />
      </Row>
      <Row label="Private work" id={answerId}
        hint={landing.isNew ? `First agent on ${landing.provider.name}. This answer covers every agent there.` : `Set once for ${landing.provider.name}; change it on any of its agents.`}>
        {landing.isNew
          ? <Segmented labelledBy={answerId} fit options={['allowed', 'public_only'] as const} value={draft.privateWork} optionLabel={(value) => PRIVATE_WORK_WORDS[value]} onChange={(privateWork) => set({ privateWork })} />
          : <span>{PRIVATE_WORK_WORDS[answer]}</span>}
      </Row>
      {price ? (
        <Row label="Price" hint={draft.price ? [draft.price.source ? `Read on ${hostOf(draft.price.source)}` : null, draft.price.as_of ? dayWords(String(draft.price.as_of)) : null].filter(Boolean).join(', ') : `Taken from ${twin?.name}, which uses the same model.`}>
          <span className="mono">{priceText(price)}</span><span className="faint"> per M tokens, in / out</span>
        </Row>
      ) : null}
      <Row label="Context limit" hint={capacity
        ? `Empty means the app's own default. Capacity ${thousands(capacity)} tokens, ${draft.contextWindow ? 'from research' : `taken from ${twin?.name}`}.`
        : "Empty means the app's own default."}>
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
      <Row label="Efforts" hint={!ownEfforts && twin ? `Taken from ${twin.name}, which uses the same model.` : undefined}>
        <EffortChips efforts={efforts} onToggle={(effort) => {
          setOwnEfforts(true)
          set({ efforts: ROSTER_EFFORTS.filter((entry) => (entry === effort ? !efforts.includes(entry) : efforts.includes(entry))) })
        }} />
      </Row>
      <div className="page-foot">
        <span className="muted">{newAgentConsequence(draft.name, landing.provider.name, answer, declared)}</span>
        <span className="spacer" />
        <button type="button" onClick={() => props.go({ name: 'agents' })}>Cancel</button>
        <button type="button" className="primary" disabled={!ready} onClick={() => {
          const added = addAgent(data, { ...draft, efforts }, props.apps)
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
  const field = <span className="muted">{line.field}:</span>
  // Something that was not there before, or is gone, is said as that: an arrow from or to nothing reads as noise.
  if (!line.chain && line.before === '—') return <>{field} {line.after}{line.detail === true || line.after === 'added' ? null : <span className="muted"> · new</span>}</>
  if (!line.chain && (line.after === '—' || (line.before === 'present' && line.after === 'removed'))) return <>{field} {line.after === '—' ? line.before : 'removed'}{line.detail === true || line.after === 'removed' ? null : <span className="muted"> · removed</span>}</>
  return <>{field} {side(line.chain?.before, line.before)} → {side(line.chain?.after, line.after)}</>
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
  const outside = team.outside.groups.length > 0
  const title = (entry: AgentsGenerationSummary): string => !entry.valid ? 'This version cannot be read'
    : entry.unfinished === true ? 'Never took effect: BMN stopped before this approval finished'
    : entry.summary !== undefined ? summaryWords(entry.summary, roleIds) : entry.earlier_schema === undefined ? 'Approved' : 'Approved under an earlier layout'
  return (
    <>
      <PageHead title="Changes" status="Every approved version of the team" />
      {history.length === 0 || damagedApproval(team) ? <FirstApproval team={team} /> : null}
      {outside ? <p className="page-note">The team file holds changes made outside BMN. Keep or revert them on Agents before restoring a version.</p> : null}
      {team.data !== null && team.data.exceptions.length > 0 ? (
        <>
          <h4 className="group-head">Allowed workspaces<span className="caption">where a provider that may see public work only was allowed</span></h4>
          <AllowedWorkspaces team={team} data={team.data} />
          <h4 className="group-head">Versions</h4>
        </>
      ) : null}
      {history.map((entry) => (
        <div key={entry.number} className="role">
          <div className="list-line">
            <div><b>{title(entry)}</b> <span className="line-detail">version {entry.number} · {shortDate(entry.created_at)}{entry.number === current ? ' · in effect' : ''}</span></div>
            <span className="inline">
              <button type="button" className="small" disabled={!entry.valid} aria-expanded={viewing === entry.number} aria-label={`View version ${entry.number}`}
                onClick={() => setViewing(viewing === entry.number ? null : entry.number)}>{viewing === entry.number ? 'Close' : 'View'}</button>
              {entry.valid && entry.earlier_schema === undefined && entry.number !== current ? (
                <button type="button" className="small" disabled={team.busy || team.hasStaged || outside} aria-label={`Restore version ${entry.number}`}
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

export function TeamPreferences(props: { team: TeamState; page: TeamPage; apps?: Apps; context?: Context; reported?: Reported; research?: ResearchState; go(page: TeamPage): void }): React.JSX.Element {
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
          <button type="button" onClick={() => void team.reload()}>Check now</button>
        </PageHead>
        <p className="page-note">BMN cannot read <span className="mono">{displayPath(snapshot.rosterPath, snapshot.home)}</span>. Nothing in it takes effect until it is fixed and approved.</p>
        <Issues issues={snapshot.file.errors} />
        <button type="button" onClick={() => void window.aiTerminal.openTeamFile()}>Open team file</button>
      </>
    )
  }
  const apps = props.apps ?? null
  const reported = props.reported ?? []
  const research = props.research ?? null
  if (page.name === 'new') return <NewAgentPage key={page.fill?.model ?? ''} team={team} data={data} apps={apps} reported={reported} research={research} fill={page.fill} go={props.go} />
  if (page.name === 'roles') return <RolesPage team={team} data={data} />
  if (page.name === 'models' && research !== null) return <ModelsPage team={team} data={data} research={research} add={(fill) => props.go({ name: 'new', fill })} />
  if (page.name === 'changes') return <ChangesPage team={team} />
  const agent = page.name === 'agent' ? data.agents.find((entry) => entry.id === page.id) : undefined
  if (agent) return <AgentPage key={agent.id} team={team} data={data} agent={agent} apps={apps} context={props.context ?? null} reported={reported} research={research} go={props.go} />
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
  // With nothing approved a review lists the whole team that would take effect: the file's, or for a restore that version's.
  const whole = preview.restored ?? team.data
  if (team.snapshot?.approved === null && whole !== null) return firstApprovalGroups(whole, preview.consequences)
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
