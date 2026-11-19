// MODULE: epic-actions-service.ts - the host checks the plan and live client before an epic action is counted
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { deployHold, deployRule, deployRuleWords, grantStatus, openGrantPeriod, type AwayRecord, type DeployEvent,
  type EpicActionAnswer, type EpicActionCard, type EpicPlanContext, type EpicRunBinding, type GrantCommandTerm, type GrantRead,
  type GrantTerm, type PlanAction, type PushPolicyRead } from '@bmn/protocol'
import { epicCommandTarget, pinnedFileSha } from '../../bin/grant-command.mjs'
import { readEpicActionContext } from '../../bin/plan-cli.mjs'
import { heldMergeProblem, parsePlanAction, planPolicyTarget } from '../../bin/plan-actions.mjs'
import { githubFacts, remoteRepository } from '../../bin/policy-cli.mjs'
import type { ControlScope } from './control-auth'
import type { DatabaseWorkerClient } from './database-client'
import { epicActionRemaining, matchingEpicCard, nightBoundTo, nightCommandHash, type EpicActionRecord, type EpicAuthority } from './database-epic-actions'
import { foregroundClientChild, foregroundProcessFolder, type ForegroundCaller } from './foreground-process'

type Agent = EpicRunBinding['agent']
type SessionScope = Extract<ControlScope, { kind: 'session' }>
type Lifecycle = Omit<EpicRunBinding, 'id' | 'go' | 'at'>
type Command = Extract<PlanAction, { kind: 'command' }>

interface Options {
  database: DatabaseWorkerClient
  liveIncarnation(sessionId: string): string | undefined
  foreground(sessionId: string, agent: Agent): string | null
  now(): string
  changed(): void
  /** A native claim wrote the night grant row; the window's night view is refreshed from it. */
  grantChanged(read: GrantRead): void
  /** Only an isolated test instance may lift a push to a local repository it inspected; BMN itself holds one (S1). */
  localReceivers?: boolean
}

function text(value: unknown, name: string, max = 1000): string {
  // The hook uses literal text. A line or terminal control cannot stand in for the shown command.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is missing or invalid`)
  }
  return value
}

function folder(value: unknown): string {
  const path = text(value, 'Folder', 4096)
  if (!isAbsolute(path)) throw new Error('Name an absolute folder')
  return path
}

function readGit(cwd: string, args: string[]) {
  return spawnSync('/usr/bin/git', args, {
    cwd, timeout: 1000, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_OPTIONAL_LOCKS: '0' }
  })
}

/** A remote's actual push URL, including configured rewrites and explicit push URLs. */
function pushRepository(cwd: string, remote: string): string | null {
  const result = readGit(cwd, ['remote', 'get-url', '--push', '--all', remote])
  const urls = result.stdout?.trim().split('\n') ?? []
  if (result.status !== 0 || urls.length !== 1 || !urls[0]) return null
  const url = urls[0]
  if (/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/u.test(url)) return remoteRepository(url)
  if (/^[^/]+:/u.test(url)) return null
  try { return realpathSync(resolve(cwd, url)) } catch { return null }
}

function pushEffects(cwd: string, remote: string): string | null {
  const local = readGit(cwd, ['config', '--local', '--includes', '--null', '--list'])
  if (local.status !== 0) return 'The repository push configuration could not be read'
  // Git also reads this worktree's own config file when the repository enables it.
  let entries = local.stdout.split('\0')
  if (entries.some(entry => /^extensions\.worktreeconfig\n(?!false$|no$|off$|0$)/iu.test(entry))) {
    const worktree = readGit(cwd, ['config', '--worktree', '--includes', '--null', '--list'])
    if (worktree.status !== 0) return 'The worktree push configuration could not be read'
    entries = [...entries, ...worktree.stdout.split('\0')]
  }
  const extra = entries.some(entry => {
    const separator = entry.indexOf('\n')
    const key = (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase()
    const value = separator === -1 ? '' : entry.slice(separator + 1).toLowerCase()
    if (key === 'push.followtags' || key === `remote.${remote.toLowerCase()}.mirror`) return !['false', 'no', 'off', '0'].includes(value)
    if (key === 'push.recursesubmodules') return value !== 'no'
    return ['push.pushoption', `remote.${remote.toLowerCase()}.push`,
      `remote.${remote.toLowerCase()}.receivepack`, `remote.${remote.toLowerCase()}.vcs`].includes(key)
  })
  if (extra) return 'The repository push configuration can affect more than the named target'
  const hook = readGit(cwd, ['rev-parse', '--git-path', 'hooks/pre-push'])
  if (hook.status !== 0 || !hook.stdout.trim()) return 'The pre-push hook location could not be confirmed'
  try {
    if (statSync(resolve(cwd, hook.stdout.trim())).mode & 0o111) return 'An executable pre-push hook is outside the named action'
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return 'The pre-push hook could not be checked'
  }
  return null
}

function commandProblem(term: Command, cwd: string): string | null {
  if (cwd !== term.folder) return 'The command folder differs from the approved folder'
  try {
    if (realpathSync(cwd) !== cwd) return 'The command folder no longer resolves to the approved path'
  } catch { return 'The command folder cannot be read' }
  const target = epicCommandTarget(term)
  if ('problem' in target) return target.problem
  if (pushRepository(cwd, target.remote ?? 'origin') !== term.repository) return 'The remote differs from the approved repository'
  if (target.remote !== null && target.program === 'git') {
    const problem = pushEffects(cwd, target.remote)
    if (problem !== null) return problem
  }
  if (term.script && pinnedFileSha(term.script, cwd) !== term.script.sha256) return 'The pinned file hash differs from the approved hash'
  return null
}

/** Everything a held command is checked for before and at its use: its exact target, and a merge's CI fence (D7). */
async function heldCommandProblem(term: Command, cwd: string): Promise<string | null> {
  const problem = commandProblem(term, cwd)
  if (problem !== null) return problem
  return /^gh\s+pr\s+merge\s/u.test(term.command) ? await heldMergeProblem(cwd, term.repository, term.ref) : null
}

const RECEIVE_HOOKS = ['pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout']
const LOCAL_RULE = 'a local repository that runs no hook on a push'

/** A local receiving repository deploys nothing BMN cannot see only while no hook of its own runs on a push. */
export function receiverProblem(path: string): string | null {
  const hooks = readGit(path, ['rev-parse', '--git-path', 'hooks'])
  if (hooks.status !== 0 || !hooks.stdout.trim()) return 'The local receiving repository could not be inspected'
  for (const name of RECEIVE_HOOKS) {
    try {
      if (statSync(resolve(path, hooks.stdout.trim(), name)).mode & 0o111) return 'The local receiving repository runs a hook on a push; BMN cannot tell what it starts'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return 'The local receiving repository\'s hooks could not be checked'
    }
  }
  return null
}

/**
 * What an action sets off in its GitHub repository, in the words of his deploy rule; null when BMN cannot place it. A bare
 * ref name may be a branch or a tag, so it counts as both; a merge lands on a branch BMN does not resolve here, so on any.
 */
export function actionEvents(action: PlanAction, defaultBranch: string | null): DeployEvent[] | null {
  if (action.kind === 'push-default') return ['default-branch']
  if (action.kind === 'pr-elsewhere') return ['branches', 'pull-requests']
  if (action.kind === 'merge') return ['default-branch', 'branches', 'pull-requests']
  const target = epicCommandTarget(action)
  if ('problem' in target) return null
  if (target.program === 'gh') return /^gh\s+release\s/u.test(action.command) ? ['releases', 'tags'] : ['default-branch', 'branches', 'pull-requests']
  if (target.program !== 'git') return null
  if (action.ref.startsWith('refs/tags/')) return ['tags']
  if (defaultBranch === null) return null
  const qualified = action.ref.startsWith('refs/heads/')
  const name = qualified ? action.ref.slice('refs/heads/'.length) : action.ref
  if (action.ref.startsWith('refs/') && !qualified) return null
  return [name === defaultBranch ? 'default-branch' : 'branches', ...(qualified ? [] : ['tags' as const])]
}

/**
 * Owner 2026-11-19 (S1, "Yes, same rule"): a night merge, default-branch push or PR write passes only where his deploy rule
 * says nothing it sets off deploys, exactly as the epic action of that kind; no rule keeps it held. Null for other terms.
 */
export function nightTermHold(read: PushPolicyRead, term: GrantTerm): string | null {
  if (term.kind === 'merge') return deployHold(read, term.repository, ['default-branch', 'branches', 'pull-requests'])
  if (term.kind === 'push-default') return deployHold(read, term.repository, ['default-branch'])
  if (term.kind === 'pr-elsewhere') return deployHold(read, term.repository, ['branches', 'pull-requests'])
  return null
}

function nightCommand(term: GrantCommandTerm): Command {
  const parsed = parsePlanAction({
    kind: 'command', id: term.id, command: term.command, folder: term.folder, repository: term.repository, ref: term.ref,
    count: term.count, ...(term.script !== null ? { script: term.script } : {})
  })
  if ('problem' in parsed || parsed.action.kind !== 'command') throw new Error('The night command has an invalid exact target')
  return parsed.action
}

export class EpicActionsService {
  private readonly lifecycles = new Map<string, Lifecycle>()
  private readonly runs = new Map<string, { project: string; epic: number }>()
  private readonly bindingInFlight = new Set<string>()
  private readonly guardOutcomes = new Map<string, Map<string, { plan: EpicPlanContext; binding: EpicRunBinding }>>()

  constructor(private readonly options: Options) {}

  observe(sessionId: string, incarnationId: string | null, agent: Agent, conversation: string, caller: ForegroundCaller | undefined): string | null {
    if (incarnationId === null || incarnationId !== this.options.liveIncarnation(sessionId)) return 'The session incarnation is no longer live'
    const foreground = this.options.foreground(sessionId, agent)
    const reason = foreground === null ? 'The native foreground process is unavailable'
      : !caller ? 'The native start hook has no verified control peer'
        : !foregroundClientChild(foreground, caller, agent) ? 'The native start hook does not belong to the foreground client' : null
    if (reason !== null || foreground === null) {
      this.lifecycles.delete(sessionId)
      return reason
    }
    // The same conversation reported again by the same process (a compaction) is the same life; anything else is a new one.
    const before = this.lifecycles.get(sessionId)
    if (before && before.incarnationId === incarnationId && before.agent === agent && before.conversation === conversation &&
      before.foreground === foreground) return null
    this.lifecycles.set(sessionId, { sessionId, incarnationId, agent, conversation, foreground, generation: randomUUID() })
    this.guardOutcomes.delete(sessionId)
    this.options.changed()
    return null
  }

  end(sessionId: string, incarnationId: string | null, agent: Agent, conversation: string, caller: ForegroundCaller): void {
    const life = this.lifecycles.get(sessionId)
    if (life && life.incarnationId === incarnationId && life.agent === agent && life.conversation === conversation &&
      foregroundClientChild(life.foreground, caller, agent)) {
      this.lifecycles.delete(sessionId)
      this.guardOutcomes.delete(sessionId)
      this.options.changed()
    }
  }

  private life(scope: SessionScope): Lifecycle | null {
    const life = this.lifecycles.get(scope.sessionId)
    if (!life || life.incarnationId !== scope.incarnationId || life.incarnationId !== this.options.liveIncarnation(scope.sessionId) ||
      life.foreground !== this.options.foreground(life.sessionId, life.agent)) return null
    return life
  }

  private current(binding: EpicRunBinding | null, plan: EpicPlanContext): EpicRunBinding | null {
    if (!binding || !plan.go || binding.go !== plan.go) return null
    const life = this.life({ kind: 'session', sessionId: binding.sessionId, incarnationId: binding.incarnationId })
    return life?.generation === binding.generation ? binding : null
  }

  /** The plan as BMN reads it now. A malformed action list voids the stored answer first, then refuses (D6). */
  private async context(project: string, epic: number): Promise<EpicPlanContext> {
    const plan = await readEpicActionContext(project, epic)
    if (plan.malformed === undefined) return plan
    await this.options.database.companion('settledEpicActionRecord', plan, this.options.now())
    throw new Error(`The allowance file cannot be read: ${plan.malformed}`)
  }

  private async scopedPlan(scope: ControlScope, project: string, epic: number): Promise<EpicPlanContext> {
    const plan = await this.context(project, epic)
    if (scope.kind === 'session') {
      const life = this.life(scope)
      if (!life) throw new Error('The live Claude Code or Codex conversation could not be confirmed')
      const cwd = foregroundProcessFolder(life.foreground)
      if (!cwd || (await readEpicActionContext(cwd, epic)).planKey !== plan.planKey) {
        throw new Error('The plan is outside this live session’s product checkout')
      }
    }
    return plan
  }

  private async bound(scope: ControlScope) {
    if (scope.kind !== 'session') return null
    const run = this.runs.get(scope.sessionId)
    if (!run || !this.life(scope)) return null
    try {
      const plan = await this.scopedPlan(scope, run.project, run.epic)
      const record = await this.options.database.companion('settledEpicActionRecord', plan, this.options.now())
      const binding = this.current(record.binding, plan)
      return binding?.sessionId === scope.sessionId ? { plan, record, binding } : null
    } catch { return null }
  }

  /**
   * D3, the one place the deploy rule meets an action: the rule's words as Health holds it now, and why the action stays
   * held under it (null: his rule says nothing this action sets off deploys). A package registry is no repository event.
   */
  private async deploy(action: PlanAction, policy?: PushPolicyRead): Promise<{ rule: string | null; hold: string | null }> {
    if (action.kind === 'command') {
      const target = epicCommandTarget(action)
      if ('problem' in target) return { rule: null, hold: target.problem }
      if (target.remote === null) return { rule: null, hold: null }
      if (isAbsolute(action.repository)) {
        // A local repository has no deploy rule of his in Health, so BMN holds it; a test instance inspects its own fixture.
        return this.options.localReceivers === true ? { rule: LOCAL_RULE, hold: receiverProblem(action.repository) }
          : { rule: null, hold: 'A local receiving repository has no deploy rule in Health; BMN holds this action' }
      }
    }
    const read = policy ?? await this.options.database.companion('getPushPolicy')
    const set = deployRule(read, action.repository)
    const rule = deployRuleWords(set)
    // The default branch matters only to a Git push under a rule that tells the default branch from the others.
    let branch: string | null = null
    if (action.kind === 'command' && Array.isArray(set) && set.includes('default-branch') !== set.includes('branches')) {
      const facts = await githubFacts(action.repository)
      branch = 'unread' in facts || facts.repository !== action.repository ? null : facts.defaultBranch
    }
    return { rule, hold: deployHold(read, action.repository, actionEvents(action, branch)) }
  }

  private async deployProblem(action: PlanAction): Promise<string | null> {
    return (await this.deploy(action)).hold
  }

  /** The night term's deploy hold under the policy BMN reads now; see nightTermHold. */
  async nightRepositoryHold(term: GrantTerm, policy?: PushPolicyRead): Promise<string | null> {
    if (term.kind !== 'merge' && term.kind !== 'push-default' && term.kind !== 'pr-elsewhere') return null
    return nightTermHold(policy ?? await this.options.database.companion('getPushPolicy'), term)
  }

  private async view(record: EpicActionRecord, plan: EpicPlanContext): Promise<EpicActionCard | null> {
    const card = matchingEpicCard(record, plan)
    const binding = this.current(record.binding, plan)
    const visible = binding === null ? null : { id: binding.id, sessionId: binding.sessionId, go: binding.go, at: binding.at }
    if (card) {
      const policy = await this.options.database.companion('getPushPolicy')
      const actions: EpicActionCard['actions'] = []
      const answers: EpicActionCard['answers'] = {}
      for (const item of card.actions) {
        const action = plan.actions.find(action => action.id === item.id)
        const state = action ? await this.deploy(action, policy) : { rule: null, hold: 'The action is no longer in the list' }
        actions.push({ ...item, ...(state.rule === null ? {} : { rule: state.rule }), ...(state.hold === null ? {} : { held: state.hold }) })
        const answer = card.answers[item.id]
        // A Yes given under another rule, or for an action now held, is no answer: the card asks again.
        if (answer && (answer.choice === 'no' || (answer.rule ?? null) === state.rule && state.hold === null)) answers[item.id] = answer
      }
      return { id: card.id, epic: card.epic, project: card.project, requestedAt: card.requestedAt,
        revision: card.revision, actions, answers, binding: visible }
    }
    if (!binding) return null
    return { id: binding.id, epic: plan.epic, project: plan.project, requestedAt: binding.at,
      revision: 0, actions: [], answers: {}, binding: visible }
  }

  async list(): Promise<EpicActionCard[]> {
    const records = await this.options.database.companion('listEpicActionRecords')
    const results = await Promise.all(records.map(async record => {
      const run = record.binding === null ? null : this.runs.get(record.binding.sessionId)
      const project = record.card?.project ?? run?.project
      if (!project) return null
      try {
        const plan = await this.context(project, record.epic)
        if (plan.planKey !== record.planKey) return null
        return await this.view(await this.options.database.companion('settledEpicActionRecord', plan, this.options.now()), plan)
      } catch { return null }
    }))
    return results.filter(card => card !== null)
  }

  async answer(input: EpicActionAnswer, via: 'app' | 'telegram'): Promise<void> {
    const card = (await this.list()).find(card => card.id === input.card)
    if (!card) throw new Error('The actions changed. Open the current card.')
    const plan = await this.context(card.project, card.epic)
    let rule: string | null = null
    if (input.choice === 'yes') {
      // Checked again at the answer (D3): the rule must be the one the answering surface showed, and it must cover the action.
      const action = plan.actions.find(action => action.id === input.action)
      if (!action) throw new Error('The actions changed. Open the current card.')
      const state = await this.deploy(action)
      if (input.rule === undefined || input.rule !== state.rule) {
        this.options.changed()
        throw new Error('The deploy rule for this repository changed. Look at the card again.')
      }
      if (state.hold !== null) throw new Error(state.hold)
      rule = state.rule
    }
    await this.options.database.companion('answerEpicActionCard', plan, input, via, this.options.now(), rule)
    this.options.changed()
  }

  async unbind(project: string, epic: number, binding: string): Promise<boolean> {
    const plan = await this.context(project, epic)
    const result = await this.options.database.companion('revokeEpicRun', plan, binding, this.options.now())
    if (result) this.options.changed()
    return result
  }

  /** The card's terms, each held command checked and stamped with the plan, epic and go of the bound run asking for it. */
  async checkNightCard(scope: ControlScope, terms: readonly GrantTerm[]): Promise<GrantTerm[]> {
    // A merge or push his deploy rule does not cover is refused by name before any card, as an epic action is.
    for (const term of terms) {
      const hold = term.kind === 'rounds' || term.kind === 'limit' || term.proposed === 'no' ? null : await this.nightRepositoryHold(term)
      if (hold !== null) throw new Error(`${term.id}: ${hold}`)
    }
    if (!terms.some(term => term.kind === 'command' && term.repository !== undefined)) return [...terms]
    const run = await this.bound(scope)
    if (!run) throw new Error('A night command held by the guard needs a bound run')
    return Promise.all(terms.map(async term => {
      if (term.kind !== 'command' || term.repository === undefined) return term
      const action = nightCommand(term)
      const problem = await heldCommandProblem(action, action.folder) ?? await this.deployProblem(action)
      if (problem) throw new Error(problem)
      return { ...term, bound: { plan: run.plan.planKey, epic: run.plan.epic, go: run.binding.go, session: run.binding.sessionId } }
    }))
  }

  async reserveNight(scope: SessionScope, input: { runId: string; useId: string; item: string },
    read: GrantRead, away: AwayRecord, peer: (() => Promise<ForegroundCaller | undefined>) | undefined) {
    const status = grantStatus(read, away, input.runId)
    const term = status.active ? status.grant.items.find(item => item.term.id === input.item)?.term : undefined
    if (term?.kind !== 'command' || term.repository === undefined || !status.active) return null
    const run = await this.bound(scope)
    if (!run) throw new Error('A night command held by the guard needs a bound run')
    if (!nightBoundTo(term, run.plan, run.binding)) throw new Error('The night command was approved for another epic or go')
    const caller = await peer?.()
    if (!caller || !foregroundClientChild(run.binding.foreground, caller, run.binding.agent)) {
      throw new Error('The caller does not belong to the bound foreground conversation')
    }
    const problem = await heldCommandProblem(nightCommand(term), term.folder) ?? await this.deployProblem(nightCommand(term))
    if (problem) throw new Error(problem)
    const file = term.script === null ? undefined : {
      folder: term.folder, path: term.script.path, sha256: pinnedFileSha(term.script, term.folder),
      periodId: status.grant.periodId, cardRevision: status.grant.cardRevision
    }
    const current = await this.dispatchPlan(run.binding, run.plan)
    return this.options.database.companion('reserveNightEpicCommand', current, run.binding,
      { runId: input.runId, item: input.item, id: input.useId, targetHash: nightCommandHash(term),
        ...(file === undefined ? {} : { file }) }, this.options.now())
  }

  async policy(scope: ControlScope) {
    const run = await this.bound(scope)
    if (!run) return { binding: null, actions: [] }
    const { plan, record, binding } = run
    const card = matchingEpicCard(record, plan)
    const view = !plan.activeApproval || !card || card.go !== binding.go ? null : await this.view(record, plan)
    // Only what his current deploy rule still covers is printed as approved.
    const actions = view === null ? [] :
      plan.actions.filter(action => action.kind !== 'command' && view.answers[action.id]?.choice === 'yes')
        .map(action => ({ ...action, remaining: epicActionRemaining(record, binding.go, action) }))
    return { binding: { epic: plan.epic, go: binding.go, sessionId: binding.sessionId }, actions }
  }

  async control(scope: ControlScope, method: string, input: Record<string, unknown>): Promise<unknown> {
    if (method === 'epic.run.status') return this.policy(scope)
    if (method === 'epic.guard.claim' || method === 'epic.run.reserve' || method === 'epic.run.dispatch' || method === 'epic.run.result') {
      if (scope.kind !== 'session') throw new Error('An action needs a live session')
      const run = await this.bound(scope)
      if (!run) throw new Error('This session has no current epic binding')
      if (method === 'epic.run.result') {
        const caller = input.caller as ForegroundCaller | undefined
        if (!caller || !foregroundClientChild(run.binding.foreground, caller, run.binding.agent)) {
          throw new Error('The caller does not belong to the bound foreground conversation')
        }
        const receipt = text(input.useId, 'Use id', 160)
        if (input.outcome !== 'returned' && input.outcome !== 'failed') throw new Error('Name the command outcome')
        const recorded = await this.options.database.companion('recordEpicActionOutcome', run.plan, run.binding,
          `policy:${receipt}`, input.outcome, this.options.now())
        return { recorded }
      }
      return this.reserve(scope, run, method, input)
    }
    const epic = input.epic
    if (typeof epic !== 'number' || !Number.isSafeInteger(epic) || epic <= 0) throw new Error('Name an epic number')
    const plan = await this.scopedPlan(scope, folder(input.project), epic)
    if (method === 'epic.actions.status') {
      const record = await this.options.database.companion('settledEpicActionRecord', plan, this.options.now())
      const view = await this.view(record, plan)
      const current = this.current(record.binding, plan)
      return { binding: current ? { sessionId: current.sessionId, go: current.go, at: current.at } : null,
        uses: record.audit, actionsHash: plan.actionsHash, actions: plan.actions.map(action => ({
        id: action.id, status: view?.answers[action.id]?.choice === 'yes' ? 'approved' :
          view?.answers[action.id]?.choice === 'no' ? 'declined' : 'not asked',
        ...(view?.actions.find(shown => shown.id === action.id)?.rule === undefined ? {} : { rule: view.actions.find(shown => shown.id === action.id)!.rule }),
        ...(view?.actions.find(shown => shown.id === action.id)?.held === undefined ? {} : { held: view.actions.find(shown => shown.id === action.id)!.held }),
        remaining: view?.answers[action.id]?.choice === 'yes' && plan.go && plan.activeApproval
          ? epicActionRemaining(record, plan.go, action) : null
      })) }
    }
    if (method === 'epic.actions.ask') {
      if (plan.actions.length === 0) throw new Error('This epic names no actions')
      for (const action of plan.actions) {
        // Nothing he cannot approve reaches his card: an action his deploy rule does not cover is refused here, by name.
        const problem = (action.kind === 'command' ? await heldCommandProblem(action, action.folder) : null) ?? await this.deployProblem(action)
        if (problem !== null) throw new Error(`Action ${action.id}: ${problem}`)
      }
      await this.options.database.companion('askEpicActionCard', plan, this.options.now())
      const card = await this.view(await this.options.database.companion('settledEpicActionRecord', plan, this.options.now()), plan)
      if (!card) throw new Error('The actions changed. Ask again.')
      this.options.changed()
      return { id: card.id, pending: card.actions.filter(action => !card.answers[action.id]).length }
    }
    if (scope.kind !== 'session' || !plan.go) throw new Error('A live session and a go in force are required')
    if (this.bindingInFlight.has(scope.sessionId)) throw new Error('This session is already binding to an epic')
    this.bindingInFlight.add(scope.sessionId)
    try { return await this.bind(scope, plan, input.caller as ForegroundCaller | undefined) }
    finally { this.bindingInFlight.delete(scope.sessionId) }
  }

  private async bind(scope: SessionScope, plan: EpicPlanContext, caller: ForegroundCaller | undefined) {
    const life = this.life(scope)
    if (!life || !plan.go || !caller || !foregroundClientChild(life.foreground, caller, life.agent)) {
      throw new Error('The live Claude Code or Codex conversation could not be confirmed')
    }
    const bound = await this.bound(scope)
    if (bound && (bound.plan.planKey !== plan.planKey || bound.plan.epic !== plan.epic)) throw new Error('This session is already bound to another epic')
    const record = await this.options.database.companion('settledEpicActionRecord', plan, this.options.now())
    if (this.life(scope)?.generation !== life.generation) throw new Error('The live conversation changed while binding')
    const binding = await this.options.database.companion('bindEpicRun', plan,
      { ...life, go: plan.go, id: randomUUID(), at: this.options.now() }, record.binding?.id ?? null, this.current(record.binding, plan) !== null)
    this.runs.set(scope.sessionId, { project: plan.project, epic: plan.epic })
    this.options.changed()
    return { epic: plan.epic, go: binding.go, sessionId: binding.sessionId }
  }

  private async dispatchPlan(binding: EpicRunBinding, plan: EpicPlanContext): Promise<EpicPlanContext> {
    const current = await this.context(plan.project, plan.epic)
    if (current.actionsHash !== plan.actionsHash || current.activeApproval !== plan.activeApproval ||
      this.current(binding, current) === null) throw new Error('The go, action list or live conversation changed before the use')
    return current
  }

  private async reserve(scope: SessionScope, run: NonNullable<Awaited<ReturnType<EpicActionsService['bound']>>>,
    method: string, input: Record<string, unknown>) {
    const { binding, plan } = run
    const caller = input.caller as ForegroundCaller | undefined
    if (!caller || !foregroundClientChild(binding.foreground, caller, binding.agent)) {
      throw new Error('The tool caller does not belong to the bound foreground conversation')
    }
    const guard = method === 'epic.guard.claim'
    const dispatch = method === 'epic.run.dispatch'
    if (guard && (input.agent !== binding.agent || input.conversation !== binding.conversation)) {
      throw new Error('The hook does not belong to the bound conversation')
    }
    const command = text(input.command, 'Command')
    const cwd = folder(input.cwd)
    const receipt = guard ? null : text(input.useId, 'Use id', 160)
    const call = guard ? text(input.callId, 'Tool call id', 160) : dispatch ? `policy:${receipt}` : null
    const commandHash = createHash('sha256').update(command).digest('hex')
    const track = (current: EpicPlanContext) => {
      if (call === null) return
      const pending = this.guardOutcomes.get(scope.sessionId) ?? new Map()
      pending.set(call, { plan: current, binding })
      this.guardOutcomes.set(scope.sessionId, pending)
    }
    // A typed dispatch BMN withheld at its last check stays withheld when retried; the use stays spent (D9).
    if (dispatch && call !== null) await this.options.database.companion('epicCallDecision', plan, binding, call, commandHash)
    if (guard && call !== null) {
      // One decision per tool call across the file and the night: a retry gets the first one back and takes nothing.
      // The retry still passes every live check of its own source; it never moves to the other one.
      const decided = await this.options.database.companion('epicCallDecision', plan, binding, call, commandHash)
      const night = decided === 'file' ? null : await this.claimNight(run, command, cwd, call)
      if (night) {
        if (decided === null) track(night.plan)
        return night.answer
      }
      if (decided === 'night') throw new Error('The night approval this tool call used is no longer in force')
    }
    const named = plan.actions.filter(action => guard
      ? action.kind === 'command' && action.command === command : action.id === input.action)
    const candidates = guard ? named.filter(action => action.kind === 'command' && action.folder === cwd) : named
    if (guard && named.length > 0 && candidates.length === 0) throw new Error('The command folder differs from the approved folder')
    const [action, ...others] = candidates
    if (!action || others.length > 0) throw new Error('No unique action names this exact command')
    if (dispatch && action.kind === 'command') throw new Error('A held command must run through its native hook')
    // Every check of the target, run before the use is taken and once more at the decision's edge (D7).
    let rule: string | null = null
    const check = async (): Promise<string | null> => {
      if (action.kind === 'command') {
        if (action.command !== command) return 'The exact command text differs'
        const problem = await heldCommandProblem(action, cwd)
        if (problem !== null) return problem
      } else {
        const repository = await githubFacts(action.repository)
        if ('unread' in repository || repository.repository !== action.repository) return 'GitHub could not confirm the exact repository'
        if (action.kind === 'push-default' && repository.defaultBranch !== action.branch) return 'The approved branch is no longer the default'
        const target = await planPolicyTarget(action, command, cwd)
        if ('problem' in target) return target.problem
        if (target.remote) {
          if (pushRepository(cwd, target.remote) !== action.repository) return 'The push remote differs from the approved repository'
          const problem = pushEffects(cwd, target.remote)
          if (problem !== null) return problem
        }
      }
      const state = await this.deploy(action)
      if (state.hold === null && rule !== null && state.rule !== rule) return 'His deploy rule for this repository changed after the use was taken'
      rule = state.rule
      return state.hold
    }
    const problem = await check()
    if (problem !== null) throw new Error(problem)
    const current = await this.dispatchPlan(binding, plan)
    const id = guard ? `hook:${call}` : receipt!
    const targetHash = createHash('sha256').update(JSON.stringify([command, cwd, action])).digest('hex')
    const use = await this.options.database.companion('reserveEpicAction', current, binding,
      { action: action.id, id, targetHash, call, commandHash, rule,
        ...(dispatch ? { receipt: id } : {}), mayReserve: !dispatch }, this.options.now())
    if (guard && !('repeated' in use)) track(current)
    // The command that follows this answer is the one that runs: a held command's hook, or a typed push or merge's dispatch.
    if (call !== null) await this.lastCheck(current, binding, call,
      async () => await check() ?? await this.authority(binding, current, { kind: 'file', action: action.id, rule }))
    return { allowed: true, epic: plan.epic, action: action.id, useId: use.id, at: use.at,
      ...(dispatch ? { launch: !('repeated' in use) } : {}) }
  }

  async reportGuardOutcome(sessionId: string, incarnationId: string | null, agent: Agent, conversation: string, call: string,
    outcome: 'returned' | 'failed', peer: (() => Promise<ForegroundCaller | undefined>) | undefined): Promise<void> {
    const pending = this.guardOutcomes.get(sessionId)
    const target = pending?.get(call)
    if (!target || target.binding.incarnationId !== incarnationId ||
      target.binding.conversation !== conversation || target.binding.agent !== agent) return
    const caller = await peer?.()
    if (!caller || !foregroundClientChild(target.binding.foreground, caller, agent)) return
    if (await this.options.database.companion('recordEpicActionOutcome', target.plan, target.binding, call, outcome, this.options.now())) {
      pending?.delete(call)
      if (pending?.size === 0 && this.guardOutcomes.get(sessionId) === pending) this.guardOutcomes.delete(sessionId)
    }
  }

  /**
   * D7 at the decision's edge: the folder, remote, push configuration and pinned file are read once more after the use is
   * taken and right before permission is returned. A change during the plan read and the write is caught here; the use stays
   * spent and the row says BMN withheld it. What changes after this answer is not seen (docs/agent-control.md).
   */
  private async lastCheck(plan: EpicPlanContext, binding: EpicRunBinding, call: string, check: () => Promise<string | null>): Promise<void> {
    const problem = await check().catch(() => 'The last check could not be completed')
    if (problem === null) return
    // The refusal stands whether or not its record could be written.
    await this.options.database.companion('recordEpicActionOutcome', plan, binding, call, 'withheld', this.options.now()).catch(() => false)
    throw new Error(`${problem}; the use stays spent`)
  }

  /** The authority behind a taken use, read once more at the decision's edge (D4/D9): go, binding, answer or night term. */
  private async authority(binding: EpicRunBinding, plan: EpicPlanContext, source: EpicAuthority): Promise<string | null> {
    const fresh = await this.dispatchPlan(binding, plan)
    return await this.options.database.companion('epicAuthorityProblem', fresh, binding, source, this.options.now())
  }

  private async claimNight(run: NonNullable<Awaited<ReturnType<EpicActionsService['bound']>>>, command: string, cwd: string, call: string) {
    const { read, away } = await this.options.database.companion('getGrants')
    if (read.state !== 'read') throw new Error('The night grant could not be read before deciding which approval to use')
    const period = openGrantPeriod(read.record)
    const matched = (period?.runs ?? []).flatMap(card => {
      if (card.card.sessionId !== run.binding.sessionId) return []
      const status = grantStatus(read, away, card.runId)
      if (!status.active) return []
      return status.grant.items.flatMap(({ term }) => term.kind === 'command' && term.repository !== undefined &&
        term.command === command && term.folder === cwd && nightBoundTo(term, run.plan, run.binding) ? [{ runId: card.runId, term }] : [])
    })
    if (matched.length === 0) return null
    if (matched.length !== 1) throw new Error('More than one night action names this exact command')
    const { runId, term } = matched[0]!
    const check = async () => await heldCommandProblem(nightCommand(term), cwd) ?? await this.deployProblem(nightCommand(term))
    const problem = await check()
    if (problem) throw new Error(problem)
    const current = await this.dispatchPlan(run.binding, run.plan)
    const targetHash = nightCommandHash(term)
    const claimed = await this.options.database.companion('claimNightEpicCommand', current, run.binding,
      { runId, item: term.id, targetHash, call }, this.options.now())
    // No night receipt waits for this command: the file's approval, if any, decides the call.
    if (claimed === null) return null
    const { use, read: written } = claimed
    if (written !== null) this.options.grantChanged(written)
    await this.lastCheck(current, run.binding, call,
      async () => await check() ?? await this.authority(run.binding, current, { kind: 'night', runId, item: term.id, targetHash }))
    return { plan: current, answer: { allowed: true, epic: run.plan.epic, action: term.id, useId: use.id, at: use.at } }
  }
}
