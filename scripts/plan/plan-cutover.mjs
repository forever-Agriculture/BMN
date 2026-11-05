// MODULE: plan-cutover.mjs - Epic 107 per-file planning reconciliation and durable cutover inputs
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { migrationPaths } from '../../apps/desktop/bin/plan-migration-lock.mjs'
import { checkPlan, defaultLocation, PlanError, ROW } from '../../apps/desktop/bin/plan-board.mjs'
import { replaceRow } from '../../apps/desktop/bin/plan-cli.mjs'
import { TO_BMAD } from '../../apps/desktop/bin/plan-statuses.mjs'
import { verifyParserProof } from '../../apps/desktop/bin/plan-bmad-parser.mjs'
import { preparedBmadProof } from './prepare-bmad-copy.mjs'
export { migrationPaths, withMigrationWriter } from '../../apps/desktop/bin/plan-migration-lock.mjs'
import { archive, checkSpans, sources, stagePlan } from './migrate-bmad-plan.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
function git(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { maxBuffer: 512 * 1024 * 1024, ...options })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed while capturing planning inputs`)
  return result.stdout
}
const textGit = (repo, args) => git(repo, args).toString().trim()
async function upstreamFor(repo, supplied, location) {
  if (supplied) return supplied
  const selected = location ?? await defaultLocation(repo)
  if (selected.remote && !selected.branch) throw new PlanError('NO_DEFAULT_CHECKOUT', 'the remote default branch cannot be established; no switch is safe')
  return selected.remote ? `origin/${selected.branch}` : textGit(selected.checkout, ['rev-parse', 'HEAD'])
}
export function saveJournal(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    const file = openSync(temporary, 'r'); try { fsyncSync(file) } finally { closeSync(file) }
    renameSync(temporary, path)
    const folder = openSync(dirname(path), 'r'); try { fsyncSync(folder) } finally { closeSync(folder) }
  } finally { rmSync(temporary, { force: true }) }
}
const loadJournal = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
const ancestor = (repo, commit) => spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, 'HEAD']).status === 0

function startTicks(pid) { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)[19] }

/** Independent child owns the writer lease until it restores modes, including after this process is killed. */
export async function startWatchdog(repo) {
  const paths = migrationPaths(repo); mkdirSync(paths.folder, { recursive: true })
  const child = spawn('python3', [fileURLToPath(new URL('./cutover-watchdog.py', import.meta.url)), paths.journal, paths.lock, String(process.pid), startTicks(process.pid)], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = new Map(), pending = new Map(); let error = null, exited = false, stderr = ''
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2000) })
  const fail = value => { error = value; for (const list of pending.values()) for (const entry of list) entry.reject(value); pending.clear() }
  child.once('error', fail)
  const done = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code); fail(new Error(`migration watchdog exited${stderr ? ': ' + stderr : ''}`)) }))
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try {
      const data = JSON.parse(line), waiting = pending.get(data.event)
      if (waiting?.length) { pending.delete(data.event); for (const entry of waiting) entry.resolve(data) }
      else events.set(data.event, data)
    } catch { fail(new Error('invalid migration watchdog readiness')) }
  })
  const event = name => {
    if (events.has(name)) { const value = events.get(name); events.delete(name); return Promise.resolve(value) }
    if (error) return Promise.reject(error)
    return new Promise((resolve, reject) => pending.set(name, [...(pending.get(name) ?? []), { resolve, reject }]))
  }
  const identity = await event('LOCKED')
  return { ...identity, journal: paths.journal,
    async arm() { const ready = event('ARMED'); child.stdin.write('arm\n'); return await ready },
    async release() { if (!exited) child.stdin.end('release\n'); const code = await done; if (code !== 0) throw new Error(`RECOVERY_REQUIRED: watchdog failed${stderr ? ': ' + stderr : ''}`) }
  }
}

/** Original inode/mode inventory, complete before any chmod; links may only target another planning input. */
export function fenceInventory(checkouts) {
  const entries = new Map()
  const visit = (path, allowed) => {
    let stat
    try { stat = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (stat.isSymbolicLink()) {
      const target = existsSync(path) ? realpathSync(path) : resolve(dirname(path), readlinkSync(path))
      if (!allowed.some(root => inside(root, target))) throw new Error(`SYMLINK_OUTSIDE_PLANNING: ${path}`)
      if (existsSync(target)) visit(target, allowed)
      return
    }
    const physical = realpathSync(path)
    if (entries.has(physical)) return
    entries.set(physical, { path: physical, device: String(stat.dev), inode: String(stat.ino), mode: stat.mode & 0o777 })
    if (stat.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child), allowed)
  }
  for (const checkout of checkouts) {
    const root = typeof checkout === 'string' ? checkout : checkout.root, inventory = sources(root)
    const allowed = inventory.roots.map(path => join(root, path))
    for (const path of allowed) visit(path, allowed)
    for (const file of inventory.files.filter(file => file.path.startsWith('docs/platform/'))) {
      const path = join(root, file.path); visit(path, [join(root, 'docs/platform')])
      for (let dir = dirname(path); inside(join(root, 'docs/platform'), dir); dir = dirname(dir)) {
        const stat = lstatSync(dir)
        entries.set(dir, { path: dir, device: String(stat.dev), inode: String(stat.ino), mode: stat.mode & 0o777 })
        if (dir === join(root, 'docs/platform')) break
      }
    }
  }
  return [...entries.values()]
}
export function applyFence(entries) {
  for (const entry of entries) {
    const stat = lstatSync(entry.path)
    if (String(stat.dev) !== entry.device || String(stat.ino) !== entry.inode) throw new Error(`INPUT_CHANGED: ${entry.path}`)
    chmodSync(entry.path, entry.mode & ~0o222)
  }
}
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep)) }
function worktrees(repo) {
  return git(repo, ['worktree', 'list', '--porcelain', '-z']).toString().split('\0\0').filter(Boolean).map(block => {
    const data = Object.fromEntries(block.split('\0').filter(Boolean).map(line => { const at = line.indexOf(' '); return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)] }))
    if (!existsSync(data.worktree)) throw new PlanError('MISSING_WORKTREE', `registered worktree ${data.worktree} is absent; retain its registration and settle its index/history before cutover`)
    return { root: realpathSync(data.worktree), head: data.HEAD }
  })
}
function tree(repo, ref, planning) {
  const result = new Map()
  for (const record of git(repo, ['ls-tree', '-r', '-z', ref]).toString().split('\0')) {
    const m = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/u.exec(record)
    if (m && planning(m[3])) result.set(m[3], { mode: m[1], oid: m[2] })
  }
  return result
}
function index(repo, planning) {
  const result = new Map()
  for (const record of git(repo, ['ls-files', '-s', '-z']).toString().split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/u.exec(record)
    if (!m || !planning(m[4])) continue
    if (m[3] !== '0') throw new Error(`UNMERGED_INPUT: ${repo}/${m[4]}`)
    result.set(m[4], { mode: m[1], oid: m[2] })
  }
  return result
}
function blobs(repo, ids) {
  const unique = [...new Set(ids)], data = git(repo, ['cat-file', '--batch'], { input: unique.join('\n') + '\n' }), result = new Map()
  let offset = 0
  for (const oid of unique) {
    const end = data.indexOf(10, offset), header = data.subarray(offset, end).toString().split(' ')
    if (header[0] !== oid || header[1] !== 'blob' || !/^\d+$/u.test(header[2])) throw new Error(`unreadable planning object ${oid}`)
    const length = Number(header[2]), bytes = data.subarray(end + 1, end + 1 + length)
    result.set(oid, { bytes, sha256: sha256(bytes) }); offset = end + 2 + length
  }
  return result
}
function working(root, path) {
  const full = join(root, path)
  let stat
  try { stat = lstatSync(full) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const link = stat.isSymbolicLink()
  if (!link && !stat.isFile()) throw new Error(`UNSUPPORTED_INPUT: ${full}`)
  if (link) {
    const target = resolve(dirname(full), readlinkSync(full))
    if (!inside(root, target) || (existsSync(target) && !inside(root, realpathSync(target)))) throw new Error(`SYMLINK_ESCAPE: ${full}`)
  }
  const bytes = link ? Buffer.from(readlinkSync(full)) : readFileSync(full)
  return { bytes, sha256: sha256(bytes), mode: link ? '120000' : stat.mode & 0o111 ? '100755' : '100644', permissions: stat.mode & 0o777, inode: String(stat.ino), device: String(stat.dev) }
}
function put(root, path, image) {
  if (!image) return
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  if (image.mode === '120000') symlinkSync(image.bytes.toString(), full)
  else writeFileSync(full, image.bytes, { mode: image.mode === '100755' ? 0o755 : 0o644 })
}
const equal = (a, b) => !a ? !b : Boolean(b) && a.sha256 === b.sha256 && a.mode === b.mode

function approvalParts(image, path) {
  const text = image?.bytes.toString() ?? '', heads = [...text.matchAll(/^#{1,3} Epic (\d+)\b[^\n]*$/gmu)], result = new Map()
  const sections = value => ['Run needs', 'Decisions'].map(name => new RegExp(`^#{2,4} ${name}[ \\t]*\\n([\\s\\S]*?)(?=^#{1,4} |(?![\\s\\S]))`, 'mu').exec(value)?.[1].trim() ?? '')
  for (let i = 0; i < heads.length; i++) result.set(Number(heads[i][1]), sections(text.slice(heads[i].index, heads[i + 1]?.index ?? text.length)))
  if (!heads.length && /(?:^|\/)epic-\d+[-.]/u.test(path)) result.set(Number(/(?:^|\/)epic-(\d+)/u.exec(path)[1]), sections(text))
  return result
}

/** Read-only capture of every worktree; output contains the merged old tree and whole conflicting local images. */
export async function reconcilePlan({ repo: given, upstream, output }) {
  const repo = realpathSync(given), destination = resolve(output)
  upstream = await upstreamFor(repo, upstream)
  if (existsSync(destination) && readdirSync(destination).length) throw new Error('reconciliation output is not empty')
  mkdirSync(destination, { recursive: true })
  const projection = join(destination, 'projection'), objects = join(destination, 'objects')
  mkdirSync(projection); mkdirSync(objects)
  const wt = worktrees(repo).sort((a, b) => a.root === repo ? -1 : b.root === repo ? 1 : a.root.localeCompare(b.root))
  const roots = new Set(wt.flatMap(w => sources(w.root).roots))
  const planning = path => [...roots].some(root => path === root || path.startsWith(root + '/')) || /^docs\/platform\/(?:.*\/)?epic-\d+[-.].*\.md$/u.test(path)
  const upstreamHead = textGit(repo, ['rev-parse', upstream]), incomingTree = tree(repo, upstreamHead, planning)
  const captures = wt.map(w => {
    const merged = spawnSync('git', ['-C', repo, 'merge-base', w.head, upstreamHead], { encoding: 'utf8' })
    if (merged.status === 1) throw new PlanError('NO_COMMON_PLANNING_BASE', `${w.root} has unrelated history (${w.head}); preserve it and settle the handover before cutover`)
    if (merged.status !== 0) throw new PlanError('UNREADABLE_PLANNING_BASE', `the common ancestor of ${w.root} cannot be read`)
    const base = merged.stdout.trim(), inventory = sources(w.root)
    return { ...w, base, files: inventory.files, baseTree: tree(repo, base, planning), headTree: tree(repo, w.head, planning), indexTree: index(w.root, planning) }
  })
  const stored = blobs(repo, [...incomingTree.values(), ...captures.flatMap(c => [...c.baseTree.values(), ...c.headTree.values(), ...c.indexTree.values()])].map(entry => entry.oid))
  const image = entry => entry ? { ...entry, ...stored.get(entry.oid) } : null
  const inputs = [], conflicts = [], approvalValues = [], canonical = new Map([...incomingTree].map(([path, entry]) => [path, image(entry)]))
  const keepInput = (owner, kind, path, value) => {
    if (value && !existsSync(join(objects, value.sha256))) writeFileSync(join(objects, value.sha256), value.bytes)
    inputs.push({ owner, kind, path, sha256: value?.sha256 ?? sha256('absent'), present: Boolean(value), mode: value?.mode ?? null, ...(value?.inode ? { inode: value.inode, device: value.device, permissions: value.permissions } : {}), object: value ? join(objects, value.sha256) : null })
  }
  const merge = (path, base, local, incoming, owner, phase) => {
    if (equal(local, base)) return incoming
    if (equal(incoming, base) || equal(local, incoming)) return local
    if (base && local && incoming && [base, local, incoming].every(value => value.mode !== '120000')) {
      const folder = join(destination, 'merge'); mkdirSync(folder, { recursive: true })
      for (const [name, value] of [['base', base], ['local', local], ['incoming', incoming]]) writeFileSync(join(folder, name), value.bytes)
      const combined = spawnSync('git', ['merge-file', '-p', join(folder, 'local'), join(folder, 'base'), join(folder, 'incoming')], { maxBuffer: 64 * 1024 * 1024 })
      const modeConflict = local.mode !== base.mode && incoming.mode !== base.mode && local.mode !== incoming.mode
      if (combined.status === 0 && !modeConflict) return { bytes: combined.stdout, sha256: sha256(combined.stdout), mode: local.mode === base.mode ? incoming.mode : local.mode }
    }
    const kept = join(destination, 'conflicts', sha256(owner).slice(0, 12), phase, path)
    mkdirSync(dirname(kept), { recursive: true }); writeFileSync(kept, local?.bytes ?? Buffer.alloc(0))
    conflicts.push({ path, owner, phase, kept, local_present: Boolean(local), incoming_present: Boolean(incoming), local_sha256: local?.sha256 ?? null, incoming_sha256: incoming?.sha256 ?? null })
    if (path.endsWith('/sprint-status.yaml')) {
      const ours = rowsOf(local?.bytes.toString() ?? ''), theirs = rowsOf(incoming?.bytes.toString() ?? '')
      for (const key of new Set([...ours.keys(), ...theirs.keys()])) {
        const epic = Number(/^(?:epic-)?(\d+)(?:[-.]|$)/u.exec(key)?.[1])
        if (Number.isFinite(epic) && JSON.stringify(ours.get(key)) !== JSON.stringify(theirs.get(key))) approvalValues.push({ path, key, epic, local: JSON.stringify(ours.get(key) ?? null), upstream: JSON.stringify(theirs.get(key) ?? null), reason: 'conflicting old board values' })
      }
    }
    return incoming
  }
  for (const capture of captures) {
    const paths = new Set([...capture.files.map(file => file.path), ...capture.baseTree.keys(), ...capture.headTree.keys(), ...capture.indexTree.keys(), ...incomingTree.keys()])
    for (const path of paths) {
      const base = image(capture.baseTree.get(path)), head = image(capture.headTree.get(path)), staged = image(capture.indexTree.get(path)), live = working(capture.root, path), incoming = image(incomingTree.get(path))
      for (const [kind, value, owner] of [['base', base, capture.base], ['HEAD', head, capture.head], ['index', staged, capture.root], ['working', live, capture.root], ['upstream', incoming, upstreamHead]]) keepInput(owner, kind, path, value)
      if (path.endsWith('.md') && !equal(base, incoming)) {
        const prior = approvalParts(base, path), next = approvalParts(incoming, path)
        for (const [epic, terms] of prior) if (JSON.stringify(terms) !== JSON.stringify(next.get(epic)) && terms.some(Boolean)) approvalValues.push({ path, key: `epic-${epic}`, epic, local: JSON.stringify(approvalParts(head, path).get(epic) ?? terms), upstream: JSON.stringify(next.get(epic) ?? null), reason: 'upstream approved sections changed' })
      }
      if (path.endsWith('/sprint-status.yaml') && !equal(base, incoming)) {
        const prior = rowsOf(base?.bytes.toString() ?? ''), next = rowsOf(incoming?.bytes.toString() ?? '')
        for (const [key, old] of prior) {
          const epic = /^epic-(\d+)$/u.exec(key), current = next.get(key)
          if (epic && (!current || ['backlog', 'withdrawn', 'superseded', 'skipped'].includes(current.status)) && JSON.stringify(old) !== JSON.stringify(current) && (!['backlog', 'withdrawn', 'superseded', 'skipped'].includes(old.status) || /\bgo \d{4}-/u.test(old.note))) approvalValues.push({ path, key, epic: Number(epic[1]), local: JSON.stringify(old), upstream: JSON.stringify(current ?? null), reason: 'upstream withdrawal' })
        }
      }
      const committed = merge(path, base, head, incoming, capture.root, 'committed')
      const resolved = merge(path, head, live, committed, capture.root, 'working')
      canonical.set(path, capture.root === repo ? resolved : merge(path, incoming, resolved, canonical.get(path) ?? null, capture.root, 'worktrees'))
    }
  }
  for (const [path, value] of canonical) put(projection, path, value)
  const fingerprint = sha256(JSON.stringify({ upstreamHead, worktrees: captures.map(c => [c.root, c.head]), inputs: inputs.map(({ owner, kind, path, sha256, mode, inode, device }) => ({ owner, kind, path, sha256, mode, inode, device })) }))
  const result = { version: 1, repo, projection, upstream: upstreamHead, worktrees: captures.map(c => ({ root: c.root, head: c.head, base: c.base })), inputs, conflicts, fingerprint, approval_conflicts: [...new Set(approvalValues.map(value => value.epic))].sort((a, b) => a - b), approval_conflict_values: [...new Map(approvalValues.map(value => [JSON.stringify(value), value])).values()] }
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

function filesUnder(root, prefix = '') {
  const files = []
  if (!existsSync(root)) return files
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name), relativePath = prefix ? prefix + '/' + name : name
    if (lstatSync(path).isDirectory()) files.push(...filesUnder(path, relativePath))
    else files.push(relativePath)
  }
  return files
}
function planFingerprint(folder) {
  return sha256(JSON.stringify(filesUnder(folder).map(path => {
    const full = join(folder, path), stat = lstatSync(full), link = stat.isSymbolicLink()
    return [path, link ? '120000' : stat.mode & 0o111 ? '100755' : '100644', sha256(link ? Buffer.from(readlinkSync(full)) : readFileSync(full))]
  })))
}
function handoverProblem(capture, handover) {
  if (!handover?.inventory_verified || !Array.isArray(handover.worktrees) || !Array.isArray(handover.writers)) return 'a verified writer/worktree inventory is required'
  const expected = capture.worktrees.map(w => w.root).sort(), observed = handover.worktrees.map(root => realpathSync(root)).sort()
  if (JSON.stringify(expected) !== JSON.stringify(observed)) return 'the worktree inventory changed or is incomplete'
  if (new Set(handover.writers.map(writer => writer.id)).size !== handover.writers.length) return 'writer IDs are repeated'
  const unacknowledged = handover.writers.find(writer => !writer.id || (writer.state !== 'ended' && (writer.state !== 'acknowledged' || !writer.closed_descriptors || !writer.closed_mappings || !writer.children_quiescent)))
  return unacknowledged ? `writer ${unacknowledged.id ?? '(unnamed)'} has not acknowledged closed writable descriptors, mappings and children` : null
}
export function validateHandover(repo, handover) {
  const problem = handoverProblem({ worktrees: worktrees(repo) }, handover)
  if (problem) throw new PlanError('HANDOVER_REQUIRED', problem)
}
function prepareCommit(repo, stage, capture, keepBmad, expected, parserProof) {
  const paths = migrationPaths(repo), indexFile = join(paths.folder, `move-${process.pid}.index`)
  const environment = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    git(repo, ['read-tree', expected], { env: environment })
    const retired = keepBmad ? [] : [...new Set(capture.inputs.filter(input => input.kind === 'HEAD' && input.owner === expected && input.present).map(input => input.path))]
    if (retired.length) git(repo, ['update-index', '--force-remove', '-z', '--stdin'], { env: environment, input: retired.join('\0') + '\0' })
    const gitDir = textGit(repo, ['rev-parse', '--absolute-git-dir'])
    git(dirname(stage), ['add', '--sparse', '--all', '--', 'plan'], { env: { ...environment, GIT_DIR: gitDir, GIT_WORK_TREE: dirname(stage) } })
    const parserPaths = keepBmad ? verifyParserProof(repo, parserProof) : []
    if (parserPaths.length) git(repo, ['add', '--sparse', '--force', '--', ...parserPaths], { env: environment })
    const tree = git(repo, ['write-tree'], { env: environment }).toString().trim()
    const commit = textGit(repo, ['commit-tree', tree, '-p', expected, '-m', 'plan: move planning with captured history'])
    const affected = [...new Set([...retired, ...filesUnder(stage).map(path => 'plan/' + path), ...parserPaths])]
    const beforeIndex = Object.fromEntries(affected.map(path => [path, textGit(repo, ['ls-files', '-s', '--', path])]))
    return { commit, tree, affected, beforeIndex }
  } finally { rmSync(indexFile, { force: true }) }
}
function refreshIndex(repo, state) {
  const path = resolve(repo, textGit(repo, ['rev-parse', '--git-path', 'index'])), lock = path + '.lock'
  const fd = openSync(lock, 'wx', existsSync(path) ? statSync(path).mode & 0o777 : 0o600)
  try {
    if (existsSync(path)) writeFileSync(fd, readFileSync(path))
    closeSync(fd)
    const env = { ...process.env, GIT_INDEX_FILE: lock }
    const updates = [], kept = []
    for (const file of state.affected) {
      const current = git(repo, ['ls-files', '-s', '--', file], { env }).toString().trim()
      const row = textGit(repo, ['ls-tree', state.switch_commit, '--', file])
      const match = /^(\d+) blob ([0-9a-f]+)\t/u.exec(row), next = match ? `${match[1]} ${match[2]} 0\t${file}` : ''
      if (current !== state.before_index[file] && current !== next) { kept.push(file); continue }
      updates.push(`${match ? match[1] + ' ' + match[2] : '0 ' + '0'.repeat(40)}\t${file}\0`)
    }
    if (updates.length) git(repo, ['update-index', '-z', '--index-info'], { env, input: updates.join('') })
    renameSync(lock, path)
    return kept
  } finally { try { closeSync(fd) } catch { /* already closed after copying */ } rmSync(lock, { force: true }); rmSync(lock + '.lock', { force: true }) }
}

/** Switch only with complete handover and a stable final capture. All original physical files remain for recovery. */
export async function cutoverPlan({ repo: given, upstream, handover, keepBmad = false, vision = null, date = new Date().toISOString().slice(0, 10), seam = async () => {} }) {
  const repo = realpathSync(given), paths = migrationPaths(repo), watchdog = await startWatchdog(repo)
  let state = loadJournal(paths.journal)
  const step = async (phase, extra = {}) => { state = { ...state, ...extra, phase }; saveJournal(paths.journal, state); await seam(phase, state) }
  try {
    if (state?.rollback_commit) throw new Error('MOVE_ROLLED_BACK: keep the completed rollback journal; a later move needs a new handover')
    await step('lease-held', { fenced: false, watchdog_nonce: watchdog.nonce, watchdog: { pid: watchdog.pid, start_ticks: watchdog.start_ticks } })
    const location = await defaultLocation(repo)
    if (!location.available) throw new PlanError('NO_DEFAULT_CHECKOUT', 'add a checkout on the remote default branch before switching its plan')
    if (realpathSync(location.checkout) !== repo) throw new PlanError('NOT_DEFAULT_CHECKOUT', `switch the plan from the canonical default checkout: ${location.checkout}`)
    upstream = await upstreamFor(repo, upstream, location)
    if (state?.switch_commit && ancestor(repo, state.switch_commit)) {
      const kept = refreshIndex(repo, state)
      await step('ref-committed', { index_refreshed: true, preserved_index_entries: kept })
      return { outcome: 'already-moved', commit: state.switch_commit, journal: paths.journal }
    }
    if (existsSync(join(repo, 'plan'))) {
      if (!state?.switch_commit || planFingerprint(join(repo, 'plan')) !== state.installed_fingerprint) throw new Error('EXISTING_PLAN: keep and settle the existing plan before starting another move')
      const preserved = join(paths.folder, `interrupted-plan-${randomBytes(5).toString('hex')}`)
      renameSync(join(repo, 'plan'), preserved)
      state.preserved_interrupted_plan = preserved
    }
    const nonce = randomBytes(8).toString('hex'), runFolder = join(paths.folder, nonce)
    mkdirSync(runFolder, { recursive: true })
    state = { version: 1, repo, phase: 'capturing', fenced: false, watchdog_nonce: watchdog.nonce, watchdog: { pid: watchdog.pid, start_ticks: watchdog.start_ticks }, owner: { pid: process.pid, start_ticks: startTicks(process.pid) }, run_folder: runFolder, keep_bmad: keepBmad, date }
    await step('capturing')
    const parserProof = keepBmad ? preparedBmadProof(repo) : null
    let capture, stage, manifest
    for (let pass = 1; pass <= 3; pass++) {
      capture = await reconcilePlan({ repo, upstream, output: join(runFolder, `capture-${pass}`) })
      await step('captured', { pass, capture_manifest: join(runFolder, `capture-${pass}`, 'manifest.json') })
      const problem = handoverProblem(capture, handover)
      if (problem) return { outcome: 'parked', code: 'HANDOVER_REQUIRED', reason: problem, journal: paths.journal }
      stage = join(runFolder, `stage-${pass}`, 'plan')
      manifest = stagePlan({ repo: capture.projection, contextRepo: repo, stage, keepBmad, copyOwners: handover.copy_owners ?? {}, vision, date, archive: join(runFolder, `archive-${pass}`) })
      if (manifest.copy && Object.keys(manifest.copy.unresolved).length) return { outcome: 'parked', code: 'COPY_PROVENANCE_REQUIRED', rows: Object.keys(manifest.copy.unresolved), journal: paths.journal }
      const archiveFailures = archive({ repo: capture.projection, manifest, folder: manifest.archive })
      if (archiveFailures.length) throw new Error('ARCHIVE_INVALID: ' + archiveFailures.join('; '))
      await step('archived', { archive: manifest.archive })
      const spans = checkSpans({ repo: capture.projection, stage, manifest })
      if (spans.length) throw new Error('STAGE_INVALID: ' + spans.join('; '))
      const checked = await checkPlan({ productRoot: repo, planRoot: stage, boardPath: join(stage, 'status.yaml'), format: 'bmn-plan' })
      if (checked.findings.length) throw new Error('STAGE_INVALID: ' + checked.findings.map(f => f.reason).join('; '))
      await step('staged', { stage })
      const next = await reconcilePlan({ repo, upstream, output: join(runFolder, `verify-${pass}`) })
      if (next.fingerprint === capture.fingerprint) break
      if (pass === 3) return { outcome: 'parked', code: 'INPUTS_STILL_CHANGING', journal: paths.journal }
    }
    const problem = handoverProblem(capture, handover)
    if (problem) return { outcome: 'parked', code: 'HANDOVER_REQUIRED', reason: problem, journal: paths.journal }
    const fence = fenceInventory(capture.worktrees)
    await step('armed', { fence, final_fingerprint: capture.fingerprint })
    await watchdog.arm()
    await step('fenced', { fenced: true })
    for (let index = 0; index < fence.length; index++) { applyFence([fence[index]]); await seam('chmod', { ...state, chmod_index: index }) }
    const final = await reconcilePlan({ repo, upstream, output: join(runFolder, 'final-capture') })
    if (final.fingerprint !== capture.fingerprint) return { outcome: 'parked', code: 'INPUT_CHANGED_DURING_HANDOVER', journal: paths.journal }
    await step('final-captured')
    const moved = join(stage, 'references', 'moved', date)
    mkdirSync(moved, { recursive: true })
    mkdirSync(join(moved, 'conflicts'), { recursive: true })
    for (let index = 0; index < capture.conflicts.length; index++) cpSync(capture.conflicts[index].kept, join(moved, 'conflicts', `conflict-${index + 1}.local`))
    writeFileSync(join(moved, 'inputs.json'), JSON.stringify(capture, null, 2) + '\n')
    const metadata = join(stage, 'migration.json')
    saveJournal(metadata, { ...loadJournal(metadata), approval_conflicts: capture.approval_conflicts, approval_conflict_values: capture.approval_conflict_values })
    if (keepBmad) {
      const record = join(stage, 'bmad-copy.json'); saveJournal(record, { ...loadJournal(record), active: true, parser_preparation: parserProof })
    }
    const expected = textGit(repo, ['rev-parse', 'HEAD']), prepared = prepareCommit(repo, stage, capture, keepBmad, expected, parserProof)
    await step('commit-prepared', { expected_parent: expected, branch: textGit(repo, ['symbolic-ref', 'HEAD']), switch_commit: prepared.commit, affected: prepared.affected, before_index: prepared.beforeIndex, installed_fingerprint: planFingerprint(stage), source_board: manifest.moved_from, original_projection: capture.projection })
    renameSync(stage, join(repo, 'plan'))
    await step('installed')
    git(repo, ['update-ref', state.branch, prepared.commit, expected])
    await step('ref-committed')
    const kept = refreshIndex(repo, state)
    await step('ref-committed', { index_refreshed: true, preserved_index_entries: kept })
    return { outcome: 'moved', commit: prepared.commit, journal: paths.journal, conflicts: capture.conflicts, preserved_index_entries: kept }
  } catch (error) {
    if (['MISSING_WORKTREE', 'NO_COMMON_PLANNING_BASE', 'UNREADABLE_PLANNING_BASE', 'BMAD_PREPARATION_REQUIRED', 'BMAD_PREPARATION_UNREADABLE', 'NO_DEFAULT_CHECKOUT', 'NOT_DEFAULT_CHECKOUT'].includes(error.code)) return { outcome: 'parked', code: error.code, reason: error.message, journal: paths.journal }
    throw error
  } finally { await watchdog.release(); await seam('restored', loadJournal(paths.journal)) }
}

function rowsOf(text) {
  const rows = new Map(); let section = false
  for (const line of text.split('\n')) {
    if (/^\S/u.test(line) && !line.startsWith('#')) section = /^development_status:/u.test(line)
    const row = section && ROW.exec(line.replace(/\r$/u, ''))
    if (!row) continue
    if (rows.has(row[1])) throw new Error(`DUPLICATE: ${row[1]}`)
    rows.set(row[1], { status: row[2], note: row[3] ?? '' })
  }
  return rows
}
function appendRow(text, key, status, note) {
  const lines = text.split('\n'); let start = -1, end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^development_status:/u.test(lines[i])) start = i
    else if (start >= 0 && /^\S/u.test(lines[i]) && !lines[i].startsWith('#')) { end = i; break }
  }
  if (start < 0) throw new Error('MALFORMED: old board has no development_status')
  if (end === lines.length && lines.at(-1) === '') end--
  lines.splice(end, 0, `  ${key}: ${status}${note ? ' # ' + note : ''}${text.includes('\r\n') ? '\r' : ''}`)
  return lines.join('\n')
}
function mergeRollbackImage(folder, path, base, local, incoming) {
  if (equal(local, base)) return incoming
  if (equal(incoming, base) || equal(local, incoming)) return local
  if (base && local && incoming && [base, local, incoming].every(value => value.mode !== '120000')) {
    const merge = join(folder, 'merge'); mkdirSync(merge, { recursive: true })
    for (const [name, image] of [['base', base], ['local', local], ['incoming', incoming]]) writeFileSync(join(merge, name), image.bytes)
    const result = spawnSync('git', ['merge-file', '-p', join(merge, 'local'), join(merge, 'base'), join(merge, 'incoming')], { maxBuffer: 64 * 1024 * 1024 })
    if (result.status === 0) return { ...local, bytes: result.stdout, sha256: sha256(result.stdout) }
  }
  throw new Error(`ROLLBACK_CONFLICT: ${path}; both inputs remain in the migration capture and working tree`)
}
function atomicImage(path, image, mode) {
  if (!image) { rmSync(path, { force: true }); return }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.rollback-${process.pid}.tmp`
  try {
    if (image.mode === '120000') symlinkSync(image.bytes.toString(), temporary)
    else {
      writeFileSync(temporary, image.bytes, { mode: mode ?? (image.mode === '100755' ? 0o755 : 0o644) })
      const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    }
    renameSync(temporary, path)
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
  } finally { rmSync(temporary, { force: true }) }
}
function prepareRollback(repo, state, writes, currentHead, folder) {
  const indexFile = join(folder, 'rollback.index'), env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    git(repo, ['read-tree', currentHead], { env })
    // Later held rows need the compatible parser even when the canonical plan is rolled back.
    const parserPaths = state.keep_bmad ? verifyParserProof(repo, loadJournal(join(repo, 'plan/bmad-copy.json'))?.parser_preparation) : []
    const retired = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', `${state.switch_commit}^`, state.switch_commit]).toString().split('\0').filter(path => path && !parserPaths.includes(path))
    const planPaths = git(repo, ['ls-tree', '-r', '--name-only', '-z', currentHead, '--', 'plan']).toString().split('\0').filter(Boolean)
    const affected = [...new Set([...retired, ...planPaths, state.source_board])]
    const parentTree = tree(repo, `${state.switch_commit}^`, path => affected.includes(path))
    const updates = affected.map(path => {
      const entry = parentTree.get(path)
      return `${entry ? entry.mode + ' ' + entry.oid : '0 ' + '0'.repeat(40)}\t${path}\0`
    })
    git(repo, ['update-index', '-z', '--index-info'], { env, input: updates.join('') })
    const board = writes.find(write => write.path === state.source_board)
    const oid = git(repo, ['hash-object', '-w', '--stdin'], { input: readFileSync(board.object) }).toString().trim()
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${oid},${state.source_board}`], { env })
    const treeId = git(repo, ['write-tree'], { env }).toString().trim()
    const commit = textGit(repo, ['commit-tree', treeId, '-p', currentHead, '-m', 'plan: roll back move and retain later rows'])
    return { commit, affected, before_index: Object.fromEntries(affected.map(path => [path, textGit(repo, ['ls-files', '-s', '--', path])])) }
  } finally { rmSync(indexFile, { force: true }) }
}

/** Revert only move paths on today's HEAD, preserve the complete new plan, and replay later rows into the old board. */
export async function rollbackPlan({ repo: given, handover, seam = async () => {} }) {
  const repo = realpathSync(given), paths = migrationPaths(repo), watchdog = await startWatchdog(repo)
  let state = loadJournal(paths.journal)
  const step = async (phase, extra = {}) => { state = { ...state, ...extra, phase }; saveJournal(paths.journal, state); await seam(phase, state) }
  try {
    if (!state?.switch_commit || !ancestor(repo, state.switch_commit)) throw new Error('NO_MOVE: no committed move is recorded for this checkout')
    if (state.phase === 'rolled-back' && ancestor(repo, state.rollback_commit)) return { outcome: 'already-rolled-back', commit: state.rollback_commit, preserved_plan: state.preserved_plan }
    const problem = handoverProblem({ worktrees: worktrees(repo) }, handover)
    if (problem) return { outcome: 'parked', code: 'HANDOVER_REQUIRED', reason: problem }
    await step('rollback-lease', { watchdog_nonce: watchdog.nonce, watchdog: { pid: watchdog.pid, start_ticks: watchdog.start_ticks } })
    if (!state.rollback_commit) {
      const folder = join(repo, 'plan-rollback', randomBytes(8).toString('hex')); mkdirSync(folder, { recursive: true })
      const exclude = join(paths.common, 'info', 'exclude'); mkdirSync(dirname(exclude), { recursive: true })
      const excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (!excluded.split('\n').includes('/plan-rollback/')) atomicImage(exclude, { bytes: Buffer.from(excluded + (excluded && !excluded.endsWith('\n') ? '\n' : '') + '/plan-rollback/\n'), mode: '100644' })
      const plan = join(repo, 'plan'), fingerprint = planFingerprint(plan)
      cpSync(plan, join(folder, 'snapshot'), { recursive: true, verbatimSymlinks: true })
      const captured = loadJournal(state.capture_manifest), writes = []
      const defaults = new Map(captured.inputs.filter(input => input.kind === 'working' && input.owner === repo).map(input => [input.path, input]))
      for (const path of new Set([...defaults.keys(), ...filesUnder(state.original_projection)])) {
        const input = defaults.get(path), base = input?.present ? { bytes: readFileSync(input.object), sha256: input.sha256, mode: input.mode } : null
        const old = working(repo, path), projected = working(state.original_projection, path)
        const image = mergeRollbackImage(folder, path, base, old, projected)
        if (!equal(old, image) || path === state.source_board) {
          const object = join(folder, `image-${writes.length}`)
          if (image) writeFileSync(object, image.bytes)
          writes.push({ path, before: old ? { sha256: old.sha256, mode: old.mode } : null, after: image ? { sha256: image.sha256, mode: image.mode } : null, object: image ? object : null, permissions: old?.permissions })
        }
      }
      const boardWrite = writes.find(write => write.path === state.source_board)
      let boardText = readFileSync(boardWrite.object, 'utf8')
      const before = rowsOf(git(repo, ['show', `${state.switch_commit}:plan/status.yaml`]).toString()), after = rowsOf(readFileSync(join(plan, 'status.yaml'), 'utf8'))
      const copy = existsSync(join(plan, 'bmad-copy.json')) ? loadJournal(join(plan, 'bmad-copy.json')) : null
      const protectedRows = copy?.excluded ?? {}
      const targetRows = rowsOf(boardText), originalRows = rowsOf(readFileSync(join(state.original_projection, state.source_board), 'utf8'))
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (Object.hasOwn(protectedRows, key)) continue
        const old = before.get(key), current = after.get(key)
        if (JSON.stringify(old) === JSON.stringify(current)) continue
        const status = current ? TO_BMAD[current.status] : 'withdrawn', note = current?.note ?? 'removed from the owner plan after cutover'
        if (!status) throw new Error(`UNKNOWN_STATUS: ${key} has ${current?.status}`)
        const desired = { status, note: [...note].slice(0, 1000).join('') }, target = targetRows.get(key) ?? null
        const baseline = copy?.rows?.[key]?.last_copied ?? originalRows.get(key) ?? null
        if (JSON.stringify(target) !== JSON.stringify(baseline) && JSON.stringify(target) !== JSON.stringify(desired)) throw new Error(`ROLLBACK_COPY_CONFLICT: ${key}; the later BMAD row and canonical plan are retained; resolve the row before retrying rollback`)
        boardText = replaceRow(boardText, key, status, [...note].slice(0, 1000).join(''))?.text ?? appendRow(boardText, key, status, [...note].slice(0, 1000).join(''))
      }
      writeFileSync(boardWrite.object, boardText); boardWrite.after.sha256 = sha256(boardText)
      if (planFingerprint(plan) !== fingerprint) throw new Error('INPUT_CHANGED: plan changed while preparing rollback; snapshot retained')
      const currentHead = textGit(repo, ['rev-parse', 'HEAD']), prepared = prepareRollback(repo, state, writes, currentHead, folder)
      await step('rollback-prepared', { rollback_commit: prepared.commit, rollback_parent: currentHead, rollback_branch: textGit(repo, ['symbolic-ref', 'HEAD']), rollback_writes: writes, rollback_affected: prepared.affected, rollback_before_index: prepared.before_index, rollback_fingerprint: fingerprint, preserved_plan: join(folder, 'plan'), rollback_snapshot: join(folder, 'snapshot') })
    }
    for (const write of state.rollback_writes) {
      const current = working(repo, write.path)
      if (equal(current, write.after)) continue
      if (!equal(current, write.before)) throw new Error(`ROLLBACK_INPUT_CHANGED: ${write.path}; journal and both states retained`)
      atomicImage(join(repo, write.path), write.after ? { ...write.after, bytes: readFileSync(write.object) } : null, write.permissions)
      await seam('rollback-write', { ...state, path: write.path })
    }
    await step('rollback-files')
    if (!ancestor(repo, state.rollback_commit)) git(repo, ['update-ref', state.rollback_branch, state.rollback_commit, state.rollback_parent])
    await step('rollback-ref')
    const kept = refreshIndex(repo, { switch_commit: state.rollback_commit, affected: state.rollback_affected, before_index: state.rollback_before_index })
    if (existsSync(join(repo, 'plan'))) {
      if (planFingerprint(join(repo, 'plan')) !== state.rollback_fingerprint) throw new Error('ROLLBACK_PLAN_CHANGED: original plan and snapshot retained; settle before resuming')
      renameSync(join(repo, 'plan'), state.preserved_plan)
    }
    await step('rolled-back', { preserved_index_entries: kept })
    return { outcome: 'rolled-back', commit: state.rollback_commit, preserved_plan: state.preserved_plan, journal: paths.journal }
  } finally { await watchdog.release() }
}
