// MODULE: grant-facts.mjs - Epic 131: read the run's recorded allowances and its branch's open pull requests
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { ledgerLimitUsage, readAllowances } from './plan-allowances.mjs'
import { boardProblems, readBoard, resolvePlan } from './plan-board.mjs'
import { githubFacts, remoteRepository, repositoryVerdict } from './policy-cli.mjs'

const exec = promisify(execFile)
const MAX_PRS = 20
const TIMEOUT = 5_000
const terminalStories = new Set(['done', 'dropped'])
const knownActions = new Set(['prs-only', 'merge-when-green', 'merge-and-push-main'])
const EMPTY_PLAN = { state: 'no-go', reason: 'No recorded go', limits: [], prepared: [] }
const UNKNOWN_PLAN = { state: 'unknown', reason: 'The run plan or its recorded go could not be confirmed', limits: [], prepared: [] }

const git = async (cwd, args) => (await exec('git', args, {
  cwd, timeout: TIMEOUT, maxBuffer: 64 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
})).stdout.trim()

async function github(args) {
  try {
    const { stdout } = await exec('gh', args, {
      timeout: TIMEOUT, maxBuffer: 256 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    })
    return JSON.parse(stdout)
  } catch (error) {
    // gh pr checks keeps its JSON on non-green exits.
    try { return JSON.parse(error.stdout) } catch { return null }
  }
}

function limitFacts(fields, usage, stories) {
  return Object.entries(fields.limits).map(([name, limit]) => {
    const amounts = usage.used.get(name) ?? new Map()
    const usageAt = (used) => usage.unreadable ? { used: null, left: null }
      : { used, left: Math.max(0, limit.limit - used) }
    return {
      name, value: limit.limit, ceiling: limit.ceiling ?? null, per: limit.per, unit: limit.unit,
      mayRaise: limit.ceiling !== undefined && limit.limit < limit.ceiling,
      ...usageAt(limit.per === 'epic' ? [...amounts.values()].reduce((sum, value) => sum + value, 0) : Math.max(0, ...stories.map(boundary => amounts.get(boundary) ?? 0))),
      ...(limit.per === 'boundary' ? { boundaries: stories.map(boundary => ({ boundary, ...usageAt(amounts.get(boundary) ?? 0) })) } : {})
    }
  })
}

async function runEpic(project, runId, board) {
  // The current worktree carries the lead's run id. It is a locator; only plan history establishes a go.
  try {
    const handoff = await readFile(join(project, '.dev-auto', 'handoff.md'), 'utf8')
    const id = /^- Run id: ([^\r\n]+)$/mu.exec(handoff)?.[1]?.trim()
    if (id === runId) {
      const scope = /^- Project \/ selected epics: ([^\r\n]+)$/mu.exec(handoff)?.[1] ?? ''
      const epics = [...scope.matchAll(/\bepic\s+(\d+)\b/giu)].map(match => Number(match[1]))
      if (epics.length === 1) return epics[0]
    }
  } catch { /* Most non-dev-auto runs have no handoff. */ }
  const named = /(?:^|[\/:-])epic[-/](\d+)(?:$|[\/:-])/u.exec(runId)
  if (named) return Number(named[1])
  // If there is only one active epic the worktree can use it without a handoff.
  const active = board.rows.filter(row => row.story === null && ['in-progress', 'review', 'blocked'].includes(row.status))
  return active.length === 1 ? active[0].epic : null
}

async function readPlanFacts(project, runId, epic, environment) {
  let plan
  try { plan = await resolvePlan(project) } catch (error) {
    return ['NO_REPOSITORY', 'NO_PLAN'].includes(error.code) ? EMPTY_PLAN : UNKNOWN_PLAN
  }
  if (plan.format !== 'bmn-plan') return EMPTY_PLAN
  const board = await readBoard(plan.boardPath)
  if (boardProblems(board, plan.boardPath).length > 0) return UNKNOWN_PLAN
  const selected = epic ?? await runEpic(plan.runCheckout, runId, board)
  if (selected === null) {
    return board.rows.some(row => row.story === null && ['ready', 'in-progress', 'review', 'blocked'].includes(row.status))
      ? UNKNOWN_PLAN : EMPTY_PLAN
  }
  const allowance = await readAllowances(plan, selected)
  if (allowance.state === 'draft' || allowance.state === 'none' && !allowance.go_commit) return EMPTY_PLAN
  if (allowance.state === 'none') return { ...EMPTY_PLAN, state: 'no-allowances', reason: 'The recorded go has no allowance file', epic: selected }
  if (allowance.state !== 'recorded') return UNKNOWN_PLAN
  const fields = allowance.current.fields
  const stories = ['epic', ...board.rows.filter(row => row.epic === selected && row.story !== null && !terminalStories.has(row.status)).map(row => row.story)]
  const usage = ledgerLimitUsage(plan, selected, environment)
  return { state: usage.unreadable ? 'unknown' : 'recorded',
    reason: usage.unreadable ? 'The run ledger could not be read' : null,
    epic: selected, limits: limitFacts(fields, usage, stories), prepared: fields.prepared }
}

export function classifyRequiredChecks(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'unknown'
  if (rows.some(row => !row || !['pass', 'pending', 'fail', 'skipping', 'cancel'].includes(row.bucket))) return 'unknown'
  if (rows.every(row => row.state === 'SUCCESS' && row.bucket === 'pass')) return 'green'
  return rows.some(row => row.bucket === 'fail' || row.bucket === 'cancel') ? 'failed'
    : rows.some(row => row.bucket === 'pending') ? 'pending' : 'unconfirmed'
}

async function pullRequests(project, policy) {
  const unknown = { state: 'unknown', reason: 'The run’s open pull requests or repository policy could not be read', items: [] }
  const empty = { state: 'read', reason: null, items: [] }
  try { await git(project, ['rev-parse', '--git-dir']) } catch (error) {
    return error.code === 128 && /not a git repository/u.test(error.stderr) ? empty : unknown
  }
  let origin, branch
  try {
    const remotes = await git(project, ['remote'])
    if (!remotes.split('\n').includes('origin')) return empty
    origin = remoteRepository(await git(project, ['remote', 'get-url', 'origin']))
    branch = await git(project, ['branch', '--show-current'])
  } catch { return unknown }
  if (origin === null || branch === '') return unknown
  const list = () => github(['pr', 'list', '--repo', origin, '--state', 'open',
    '--head', branch, '--limit', String(MAX_PRS), '--json', 'number,headRefName,headRefOid,baseRefName,isCrossRepository'])
  const [rows, facts] = await Promise.all([list(), githubFacts(origin)])
  if (!Array.isArray(rows)) return unknown
  if (rows.length === 0) return empty
  const verdict = facts === null ? null : repositoryVerdict(policy, origin, facts)
  const relevant = rows.filter(row => row?.headRefName === branch && row.isCrossRepository === false &&
    Number.isSafeInteger(row.number) && /^[a-f0-9]{40,64}$/u.test(row.headRefOid) && typeof row.baseRefName === 'string')
  const reported = await Promise.all(relevant.map(row =>
    github(['pr', 'checks', String(row.number), '--repo', origin, '--required', '--json', 'state,bucket'])))
  const confirmed = relevant.length > 0 ? await list() : []
  const items = relevant.map((row, index) => {
    const sameHead = Array.isArray(confirmed) && confirmed.some(current => current.number === row.number &&
      current.headRefOid === row.headRefOid && current.headRefName === branch &&
      current.baseRefName === row.baseRefName && current.isCrossRepository === false)
    const checks = sameHead ? classifyRequiredChecks(reported[index]) : 'unknown'
    const status = policy?.state === 'read' && verdict && verdict.owner !== null && knownActions.has(verdict.level)
      ? verdict.authorizes ? verdict.level : 'asks-owner' : null
    return { repository: verdict?.repository ?? origin, number: row.number, headSha: row.headRefOid, head: branch,
      base: row.baseRefName, checks, policy: status,
      mayMerge: !sameHead || status === null ? null : status === 'prs-only' || status === 'asks-owner' ? false
        : checks === 'unknown' ? null : checks === 'green' }
  })
  const unreadable = verdict?.owner == null || items.some(item => item.policy === null || item.checks === 'unknown')
  return { state: unreadable || rows.length >= MAX_PRS ? 'unknown' : 'read',
    reason: unreadable ? unknown.reason : rows.length >= MAX_PRS ? 'At most 20 open pull requests were read' : null, items }
}

export function grantFactConflicts(facts) {
  const result = []
  for (const limit of facts.plan.limits) {
    const maximum = limit.ceiling ?? limit.value
    if (limit.value < maximum || limit.left !== 0) continue
    for (const use of limit.boundaries ?? [{ boundary: null, used: limit.used, left: limit.left }]) {
      if (use.left !== 0 || use.used === null) continue
      const where = use.boundary === null ? '' : ` at ${use.boundary}`
      result.push({ id: `limit:${limit.name}${use.boundary === null ? '' : `:${use.boundary}`}`,
        words: `${limit.name.replaceAll('_', ' ')}${where}: ${use.used} of ${limit.value} used` })
    }
  }
  for (const pr of facts.pullRequests.items) {
    if (pr.mayMerge !== false) continue
    const reason = pr.policy === 'prs-only' || pr.policy === 'asks-owner' ? 'needs merge approval' : 'is waiting for green required checks'
    result.push({ id: `pr:${pr.repository}:${pr.number}`, words: `PR #${pr.number} in ${pr.repository} ${reason}` })
  }
  return result
}

export async function sameGrantCheckout(cwd, project) {
  if (!cwd || !project || !isAbsolute(cwd) || !isAbsolute(project)) return false
  if (cwd === project) return true
  const top = (path) => git(path, ['rev-parse', '--show-toplevel'])
  try {
    const [bound, requested] = await Promise.all([top(cwd), top(project)])
    return bound === requested
  } catch { return false }
}

export async function pinGrantLimit(cwd, term) {
  if (!await sameGrantCheckout(cwd, term.project)) throw new Error('The allowance must belong to this run’s checkout')
  const plan = await resolvePlan(term.project)
  const recorded = await readAllowances(plan, term.epic)
  const limit = recorded.state === 'recorded' ? recorded.current.fields.limits[term.name] : null
  if (!limit || recorded.hand_edit || limit.limit !== term.from) throw new Error('Read the current recorded allowance before asking for this raise')
  if (limit.ceiling !== undefined && term.to <= limit.ceiling) throw new Error('This is within the ceiling. Use bmn plan allow.')
  if (limit.unit === 'count' && !Number.isInteger(term.to)) throw new Error('This limit takes a whole number')
  return { go: recorded.go_commit, commit: recorded.current.commit, token: recorded.token }
}

export { resolvePlan as resolveGrantLimitPlan }

/** A caller path is checked against the session's checkout before it is allowed to name a different worktree. */
export async function grantFacts({ cwd, project, runId, epic, policy, environment = process.env }) {
  const unknown = { plan: UNKNOWN_PLAN, pullRequests: { state: 'unknown', reason: 'The run project could not be bound', items: [] } }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return { ...unknown, conflicts: [] }
  const resolved = project ?? cwd
  if (!await sameGrantCheckout(cwd, resolved)) return { ...unknown, conflicts: [] }
  const [plan, prs] = await Promise.all([
    readPlanFacts(resolved, runId, epic, environment).catch(() => UNKNOWN_PLAN),
    pullRequests(resolved, policy).catch(() => unknown.pullRequests)
  ])
  const facts = { runId, plan, pullRequests: prs }
  return { ...facts, conflicts: grantFactConflicts(facts) }
}
