// MODULE: plan-publish.mjs - Epic 107 plan-only checkpoints, publication and local go ancestry
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, fsyncSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { PlanError, ROW } from './plan-board.mjs'
import { parseAllowances } from './plan-allowances.mjs'
import { approvalText, lockBoard } from './plan-cli.mjs'
import { copyAuthorityState, copyFindings, isCopiedPlan } from './plan-bmad-copy.mjs'
import { verifyParserProof } from './plan-bmad-parser.mjs'

function git(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env } })
  if (result.status !== 0) throw new PlanError('GIT_FAILED', `git ${args[0]} failed (exit ${result.status}); local plan commits are kept`)
  return result.stdout
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}
function location(plan) {
  const repo = plan.boardCheckout
  const common = resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim())
  return { repo, common, folder: join(common, 'bmn-plan-publish'), path: join(common, 'bmn-plan-publish', 'state.json') }
}
function pathsFor(plan) {
  const header = readFileSync(plan.boardPath, 'utf8')
  const bmad = /^bmad_board:\s*([^\s#]+)\s*$/mu.exec(header)?.[1]
  if (!isCopiedPlan(plan)) return ['plan']
  if (!bmad || bmad.startsWith('/') || bmad.split('/').some(part => !part || part === '..' || part === '.')) throw new PlanError('COPY_UNREADABLE', 'publication requires a project-relative BMAD board')
  const meta = JSON.parse(readFileSync(join(plan.planRoot, 'bmad-copy.json'), 'utf8'))
  return ['plan', bmad, ...verifyParserProof(plan.boardCheckout, meta.parser_preparation)]
}
function load(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {} }
function blob(repo, commit, path) {
  const p = spawnSync('git', ['-C', repo, 'show', `${commit}:${path}`], { maxBuffer: 64 * 1024 * 1024 })
  return p.status === 0 ? p.stdout : null
}
const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b)
const allowanceEpic = file => Number(/^plan\/allowances\/(\d+)\.yaml$/u.exec(file)?.[1])
function equalAllowances(file, a, b) {
  const epic = allowanceEpic(file)
  if (!Number.isInteger(epic) || a === null || b === null) return false
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const left = parseAllowances(decoder.decode(a), epic), right = parseAllowances(decoder.decode(b), epic)
    return left.problems.length === 0 && right.problems.length === 0 && isDeepStrictEqual(left.data, right.data)
  } catch { return false }
}
function names(repo, commit, paths) { return git(repo, ['ls-tree', '-r', '--name-only', commit, '--', ...paths]).trim().split('\n').filter(Boolean) }
function indexEntry(repo, path, env = {}) { return git(repo, ['ls-files', '-s', '--', path], { env }).trim() }

/** A private index commits plan files while every unrelated index entry and working file stays put. */
export function checkpointPlan(plan) {
  const repo = plan.boardCheckout, paths = pathsFor(plan)
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  const branch = git(repo, ['symbolic-ref', 'HEAD']).trim()
  const index = join(location(plan).common, `bmn-plan-checkpoint-${process.pid}-${randomBytes(4).toString('hex')}.index`)
  const env = { GIT_INDEX_FILE: index }
  try {
    git(repo, ['read-tree', head], { env })
    const before = new Map(names(repo, head, paths).map((path) => [path, git(repo, ['ls-tree', head, '--', path]).trim().replace(/^([0-7]+) blob ([0-9a-f]+)\t/u, '$1 $2 0\t')]))
    git(repo, ['add', '--sparse', '--all', '--', ...paths], { env })
    const tree = git(repo, ['write-tree'], { env }).trim()
    if (tree === git(repo, ['rev-parse', `${head}^{tree}`]).trim()) return head
    const commit = git(repo, ['commit-tree', tree, '-p', head, '-m', 'plan: local checkpoint']).trim()
    git(repo, ['update-ref', branch, commit, head])
    for (const path of new Set([...before.keys(), ...names(repo, commit, paths)])) {
      const current = indexEntry(repo, path)
      if (current !== (before.get(path) ?? '')) continue
      const next = indexEntry(repo, path, env)
      if (!next) git(repo, ['update-index', '--force-remove', '--', path])
      else {
        const [, mode, sha] = /^(\d+) ([0-9a-f]+) 0\t/u.exec(next) ?? []
        git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`])
      }
    }
    return commit
  } finally { rmSync(index, { force: true }) }
}

export function publicationState(plan) {
  if (!plan.tracked || plan.format !== 'bmn-plan') return { unpublished: 0, conflicts: [] }
  let migration, state, loc, authorityUnconfirmed = false
  try { migration = load(join(plan.planRoot, 'migration.json')); if (!migration || typeof migration !== 'object' || Array.isArray(migration)) throw new Error('invalid migration state') } catch { migration = {}; authorityUnconfirmed = true }
  try { loc = location(plan); state = load(loc.path); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid publication state') } catch { state = {}; authorityUnconfirmed = true }
  const numbers = value => Array.isArray(value) && value.every(number => Number.isInteger(number) && number >= 0)
  if (!numbers(migration.approval_conflicts ?? []) || !numbers(state.conflicts ?? []) || !Array.isArray(migration.approval_conflict_values ?? []) || !Array.isArray(state.conflict_values ?? [])) authorityUnconfirmed = true
  let copied = { conflicts: [], conflict_values: [] }
  try { copied = copyAuthorityState(plan) } catch { authorityUnconfirmed = true }
  const known = {
    conflicts: [...new Set([...(numbers(migration.approval_conflicts ?? []) ? migration.approval_conflicts ?? [] : []), ...(numbers(state.conflicts ?? []) ? state.conflicts ?? [] : []), ...copied.conflicts])],
    conflict_values: [...(Array.isArray(migration.approval_conflict_values) ? migration.approval_conflict_values : []), ...(Array.isArray(state.conflict_values) ? state.conflict_values : []), ...copied.conflict_values],
    publication: state.pr ?? null,
    ...(authorityUnconfirmed ? { authority_unconfirmed: true } : {})
  }
  if (authorityUnconfirmed) return { unpublished: null, ...known, publication_unavailable: true }
  try {
    const { repo } = loc
    const base = state.acknowledged ?? `origin/${plan.defaultBranch ?? git(repo, ['branch', '--show-current']).trim()}`
    const commits = git(repo, ['log', '--format=%H', `${base}..HEAD`, '--', ...pathsFor(plan)]).trim().split('\n').filter(Boolean)
    return { unpublished: commits.length, ...known }
  } catch { return { unpublished: null, ...known, publication_unavailable: true } }
}
function repoName(remote) { return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote)?.[1] ?? null }
async function policyFor(repo, name) {
  if (!name) throw new PlanError('POLICY_UNAVAILABLE', 'origin is not a named GitHub repository; no external write authorized')
  const result = spawnSync('bmn', ['policy', '--repo', name, '--json'], { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) throw new PlanError('POLICY_UNAVAILABLE', 'BMN policy could not be read; local plan commits are kept')
  const policy = JSON.parse(result.stdout)
  if (!policy.repository?.authorizes) throw new PlanError('POLICY_REFUSED', 'BMN policy authorizes no write to this repository; local plan commits are kept')
  return policy
}
function gh(repo, args) {
  const result = spawnSync('gh', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) throw new PlanError('PUBLICATION_FAILED', `gh ${args[0]} ${args[1]} failed; local plan commits are kept`)
  return result.stdout.trim()
}

function boardRows(value) {
  return new Map((value?.toString('utf8') ?? '').split('\n').flatMap((line) => { const m = ROW.exec(line); return m ? [[m[1], line]] : [] }))
}
function conflictingEpics(path, base, ours, theirs) {
  if (path === 'plan/status.yaml') {
    const b = boardRows(base), o = boardRows(ours), t = boardRows(theirs)
    return [...new Set([...o.keys(), ...t.keys()].filter((key) => o.get(key) !== t.get(key) && o.get(key) !== b.get(key) && t.get(key) !== b.get(key)).map((key) => Number(/^(?:epic-)?(\d+)/u.exec(key)?.[1])).filter(Number.isFinite))]
  }
  const number = /^plan\/(?:epics\/(\d+)-|allowances\/(\d+)\.yaml$)/u.exec(path)
  return number ? [Number(number[1] ?? number[2])] : []
}

function mergeBytes(folder, file, base, ours, theirs, suffix) {
  // Formatting cannot replace the exact bytes pinned by a recorded go/allow change.
  if (equalAllowances(file, ours, theirs) || equalAllowances(file, base, theirs)) return { bytes: ours }
  if (equal(ours, base)) return { bytes: theirs }
  if (equal(theirs, base) || equal(ours, theirs)) return { bytes: ours }
  const parse = (bytes) => {
    const rows = new Map()
    const skeleton = (bytes?.toString() ?? '').replace(/^ {2}([\w.-]+):[^\r\n]*(\r?)$/gmu, (line, key, cr) => {
      rows.set(key, cr ? line.slice(0, -1) : line)
      return `@@bmn-row:${key}@@${cr}`
    })
    return { rows, skeleton }
  }
  let rows = null, images = { base, local: ours, incoming: theirs }, rowConflict = false
  if (file === 'plan/status.yaml') {
    const b = parse(base), o = parse(ours), t = parse(theirs)
    rows = new Map()
    for (const key of new Set([...b.rows.keys(), ...o.rows.keys(), ...t.rows.keys()])) {
      const before = b.rows.get(key), local = o.rows.get(key), incoming = t.rows.get(key)
      if (local === before) rows.set(key, incoming)
      else if (incoming === before || local === incoming) rows.set(key, local)
      else rowConflict = true
    }
    images = { base: Buffer.from(b.skeleton), local: Buffer.from(o.skeleton), incoming: Buffer.from(t.skeleton) }
  }
  const merge = join(folder, 'merge'); mkdirSync(merge, { recursive: true })
  for (const [key, bytes] of Object.entries(images)) writeFileSync(join(merge, key), bytes ?? Buffer.alloc(0))
  const result = spawnSync('git', ['merge-file', '-p', join(merge, 'local'), join(merge, 'base'), join(merge, 'incoming')], { maxBuffer: 64 * 1024 * 1024 })
  if (!rowConflict && result.status === 0) {
    const bytes = rows === null ? result.stdout : Buffer.from(result.stdout.toString().replace(/^@@bmn-row:([\w.-]+)@@(\r?\n|$)/gmu, (_, key, ending) => rows.get(key) === undefined ? '' : rows.get(key) + ending))
    return { bytes }
  }
  const kept = join(folder, 'conflicts', file); mkdirSync(dirname(kept), { recursive: true })
  writeFileSync(kept + '.local', ours ?? Buffer.alloc(0)); writeFileSync(kept + `.${suffix}`, theirs ?? Buffer.alloc(0))
  return { conflict: true, epics: conflictingEpics(file, base, ours, theirs) }
}

function projectPlan(repo, folder, paths, base, checkpoint, upstream, prTip, state) {
  const all = new Set([...names(repo, base, paths), ...names(repo, checkpoint, paths), ...names(repo, upstream, paths), ...(prTip ? names(repo, prTip, paths) : [])])
  const projected = new Map(), conflicts = []
  let conflict = false
  for (const file of all) {
    const b = blob(repo, base, file), o = blob(repo, checkpoint, file), t = blob(repo, upstream, file)
    const merged = mergeBytes(folder, file, b, o, t, 'upstream')
    if (merged.conflict) { conflict = true; conflicts.push(...merged.epics) }
    else projected.set(file, merged.bytes)
    // A newly observed withdrawal or narrower approved text grants nothing before integration.
    if (!equal(b, t) && file === 'plan/status.yaml') {
      const old = boardRows(b), incoming = boardRows(t), local = boardRows(o)
      for (const [key, previous] of old) {
        const epic = /^epic-(\d+)$/u.exec(key), line = incoming.get(key)
        if (!epic || (line !== undefined && !/^ {2}epic-\d+: (backlog|dropped)\b/u.test(line))) continue
        if (previous !== line && local.get(key) !== line && (!/^ {2}epic-\d+: (backlog|dropped)\b/u.test(previous) || /\bgo \d{4}-/u.test(previous))) conflicts.push(Number(epic[1]))
      }
    }
    if (b !== null && !equal(b, t) && !equal(o, t) && /^plan\/epics\/\d+-/u.test(file) && approvalText(b.toString()) !== approvalText(t?.toString() ?? '')) conflicts.push(Number(/^plan\/epics\/(\d+)/u.exec(file)[1]))
    // An upstream restriction or deletion of an epic's allowances file is read as its changed terms are (110.5 AC6).
    const allowances = /^plan\/allowances\/(\d+)\.yaml$/u.exec(file)
    if (allowances && !equal(b, t) && !equal(o, t) && !equalAllowances(file, b, t) && !equalAllowances(file, o, t)) conflicts.push(Number(allowances[1]))
    if (prTip && !merged.conflict) {
      const prBase = blob(repo, state.published ?? upstream, file), incoming = blob(repo, prTip, file)
      const combined = mergeBytes(folder, file, prBase, projected.get(file), incoming, 'pr')
      if (combined.conflict) { conflict = true; conflicts.push(...combined.epics) }
      else projected.set(file, combined.bytes)
    }
  }
  state.conflicts = [...new Set(conflicts)]
  const localRows = boardRows(blob(repo, checkpoint, 'plan/status.yaml')), values = new Map()
  for (const [side, commit] of [['upstream', upstream], ['pr', prTip]]) {
    if (!commit) continue
    const incoming = boardRows(blob(repo, commit, 'plan/status.yaml'))
    for (const key of new Set([...localRows.keys(), ...incoming.keys()])) {
      const epic = Number(/^(?:epic-)?(\d+)/u.exec(key)?.[1])
      if (!state.conflicts.includes(epic) || localRows.get(key) === incoming.get(key)) continue
      const value = values.get(key) ?? { path: 'plan/status.yaml', key, epic, local: localRows.get(key) ?? null }
      value[side] = incoming.get(key) ?? null
      values.set(key, value)
    }
  }
  state.conflict_values = [...values.values()]
  return { projected, conflict: conflict || state.conflicts.length > 0 }
}

function projectionTree(repo, folder, base, projected, checkpoint) {
  const index = join(folder, `projection-${process.pid}-${randomBytes(4).toString('hex')}.index`), env = { GIT_INDEX_FILE: index }
  try {
    git(repo, ['read-tree', base], { env })
    for (const [file, bytes] of projected) {
      if (bytes === null) git(repo, ['update-index', '--force-remove', '--', file], { env })
      else {
        const sha = git(repo, ['hash-object', '-w', '--stdin'], { input: bytes }).trim()
        const entry = git(repo, ['ls-tree', checkpoint, '--', file]).trim() || git(repo, ['ls-tree', base, '--', file]).trim()
        const mode = /^([0-7]+)/u.exec(entry)?.[1] ?? '100644'
        git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${file}`], { env })
      }
    }
    return git(repo, ['write-tree'], { env }).trim()
  } finally { rmSync(index, { force: true }) }
}

/** Tests inject only remote policy/PR transport; all Git projection, push and integration remain real. */
export async function publishPlan(plan, { readPolicy = policyFor, pullRequest, direct = false } = {}) {
  if (plan.format !== 'bmn-plan' || !plan.tracked) return { outcome: 'ignored', ...publicationState(plan) }
  if (plan.defaultAvailable === false) throw new PlanError('NO_DEFAULT_CHECKOUT', 'add a worktree on the remote default branch before publishing')
  const { repo, common, folder, path } = location(plan)
  const release = await lockBoard(join(common, 'bmn-plan-publish'))
  mkdirSync(folder, { recursive: true })
  let state = load(path)
  try {
    const unresolved = (await copyFindings(plan, { recover: true })).filter(finding => finding.code !== 'COPY_CONFLICT')
    if (unresolved.length) throw new PlanError(unresolved[0].code, unresolved[0].reason)
    const checkpoint = checkpointPlan(plan)
    state.checkpoint = checkpoint
    atomic(path, state)
    const branch = plan.defaultBranch ?? git(repo, ['branch', '--show-current']).trim()
    const remote = git(repo, ['remote', 'get-url', 'origin']).trim(), name = repoName(remote)
    git(repo, ['fetch', '--no-tags', 'origin', `${branch}:refs/remotes/origin/${branch}`])
    let upstream = git(repo, ['rev-parse', `origin/${branch}`]).trim()
    const paths = pathsFor(plan)
    const ancestor = (before, after) => spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', before, after]).status === 0
    const acknowledgePublished = () => {
      if (state.publishedCheckpoint && (!state.acknowledged || ancestor(state.acknowledged, state.publishedCheckpoint))) state.acknowledged = state.publishedCheckpoint
    }
    // A merged publication remains the baseline after unrelated upstream work. Only an
    // equivalent local checkpoint can serve as that baseline; projected incoming changes
    // absent from it must never disappear from later conflict detection.
    if (state.published && state.publishedCheckpoint && ancestor(state.published, upstream) && ancestor(state.publishedCheckpoint, checkpoint) &&
        git(repo, ['diff', '--name-only', state.publishedCheckpoint, state.published, '--', ...paths]).trim() === '') acknowledgePublished()
    const integrate = (projected = null) => {
      const head = git(repo, ['rev-parse', 'HEAD']).trim()
      if (spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', upstream, head]).status === 0) return
      let merged
      if (projected === null) merged = git(repo, ['merge-tree', '--write-tree', head, upstream]).split('\n')[0]
      else {
        const result = spawnSync('git', ['-C', repo, 'merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', head, upstream], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        const [tree, ...conflicts] = (result.stdout ?? '').split('\0')
        if (![0, 1].includes(result.status) || !/^[0-9a-f]{40,64}$/u.test(tree) || conflicts.some(file => file && !projected.has(file))) throw new PlanError('GIT_FAILED', 'integration has an unresolved non-plan conflict; local commits are kept')
        merged = projectionTree(repo, folder, tree, projected, checkpoint)
      }
      const next = git(repo, ['commit-tree', merged, '-p', head, '-p', upstream, '-m', 'plan: take published default branch']).trim()
      // Two-tree read-tree protects unrelated staged/unstaged changes before the branch moves.
      git(repo, ['read-tree', '-u', '-m', head, next])
      git(repo, ['update-ref', git(repo, ['symbolic-ref', 'HEAD']).trim(), next, head])
    }
    if (state.published && git(repo, ['diff', '--name-only', state.published, upstream, '--', ...paths]).trim() === '') {
      integrate()
      acknowledgePublished()
      state.conflicts = []
      atomic(path, state)
    }
    const mergeBase = git(repo, ['merge-base', checkpoint, upstream]).trim()
    const base = mergeBase === upstream ? upstream : state.acknowledged ?? mergeBase
    let prTip = null
    if (git(repo, ['ls-remote', '--heads', 'origin', 'refs/heads/bmn/plan']).trim()) {
      git(repo, ['fetch', '--no-tags', 'origin', 'bmn/plan:refs/remotes/origin/bmn/plan'])
      const tip = git(repo, ['rev-parse', 'origin/bmn/plan']).trim()
      if (spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', tip, upstream]).status !== 0) prTip = tip
    }
    const { projected, conflict } = projectPlan(repo, folder, paths, base, checkpoint, upstream, prTip, state)
    atomic(path, state)
    if (conflict) return { outcome: 'PLAN_CONFLICT', ...publicationState(plan) }
    let tip
    {
      const tree = projectionTree(repo, folder, upstream, projected, checkpoint)
      if (tree === git(repo, ['rev-parse', `${upstream}^{tree}`]).trim()) {
        integrate(projected)
        state.acknowledged = checkpoint; atomic(path, state)
        return { outcome: 'published', ...publicationState(plan) }
      }
      if (prTip && state.pr && tree === git(repo, ['rev-parse', `${prTip}^{tree}`]).trim()) {
        state.published = prTip; state.publishedCheckpoint = checkpoint; atomic(path, state)
        return { outcome: 'unpublished', ...publicationState(plan) }
      }
      const parents = ['-p', upstream]
      if (prTip) parents.push('-p', prTip)
      tip = git(repo, ['commit-tree', tree, ...parents, '-m', 'plan: publish checkpoint']).trim()
    }
    const policy = await readPolicy(repo, name)
    if (!policy.repository?.authorizes) throw new PlanError('POLICY_REFUSED', 'repository write not authorized; checkpoint kept')
    if (direct && policy.repository.level !== 'merge-and-push-main') throw new PlanError('POLICY_REFUSED', 'direct publication exceeds repository policy')
    const scratch = join(folder, `worktree-${randomBytes(6).toString('hex')}`)
    git(repo, ['worktree', 'add', '--detach', scratch, upstream])
    try {
      git(scratch, ['checkout', '--detach', tip])
      // The detached publication checkout has only the projected plan difference.
      git(scratch, ['push', 'origin', `${tip}:refs/heads/${direct ? branch : 'bmn/plan'}`])
    } finally { git(repo, ['worktree', 'remove', scratch]) }
    state.published = tip; state.publishedCheckpoint = checkpoint; atomic(path, state)
    if (direct) {
      git(repo, ['fetch', '--no-tags', 'origin', `${branch}:refs/remotes/origin/${branch}`])
      upstream = git(repo, ['rev-parse', `origin/${branch}`]).trim()
      // A projection is valid only for the plan version it published. A concurrent withdrawal
      // must be read before any overlay, integration or acknowledgement can erase it.
      if (git(repo, ['diff', '--name-only', tip, upstream, '--', ...paths]).trim()) {
        const changed = projectPlan(repo, folder, paths, base, checkpoint, upstream, null, state)
        atomic(path, state)
        return { outcome: changed.conflict ? 'PLAN_CONFLICT' : 'unpublished', error: 'UPSTREAM_CHANGED', ...publicationState(plan) }
      }
      integrate(projected); state.acknowledged = checkpoint; atomic(path, state)
    } else {
      const prs = pullRequest ? await pullRequest({ repo, name, branch, tip, readPolicy }) : JSON.parse(gh(repo, ['pr', 'list', '--repo', name, '--state', 'open', '--head', 'bmn/plan', '--json', 'number,url']))
      if (Array.isArray(prs) && prs.length) state.pr = prs[0].url
      else if (typeof prs === 'string') state.pr = prs
      else {
        await readPolicy(repo, name)
        state.pr = gh(repo, ['pr', 'create', '--repo', name, '--base', branch, '--head', 'bmn/plan', '--title', 'plan: publish planning checkpoint', '--body', 'Planning paths only. Local approval commits remain authoritative while this change awaits the default branch.'])
      }
      atomic(path, state)
    }
    return { outcome: direct ? 'published' : 'unpublished', ...publicationState(plan) }
  } catch (error) {
    state.error = error.code ?? 'PUBLICATION_FAILED'; atomic(path, state)
    return { outcome: 'unpublished', error: state.error, ...publicationState(plan) }
  } finally { release() }
}
