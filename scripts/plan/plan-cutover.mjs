// MODULE: plan-cutover.mjs - Epic 107 per-file planning reconciliation and durable cutover inputs
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, cpSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
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
    if (!existsSync(data.worktree)) {
      if (!absentHoldsNothing(repo, data)) throw new PlanError('MISSING_WORKTREE', `registered worktree ${data.worktree} is absent; retain its registration and settle its index/history before cutover`)
      return null
    }
    return { root: realpathSync(data.worktree), head: data.HEAD }
  }).filter(Boolean)
}
/** A registration whose folder is gone can only still hold staged work; with an index equal to its HEAD there is nothing to capture. Its registration stays. */
function absentHoldsNothing(repo, data) {
  const admin = join(textGit(repo, ['rev-parse', '--git-common-dir']).replace(/^(?!\/)/u, `${repo}/`), 'worktrees')
  if (!existsSync(admin) || !data.prunable || !data.HEAD) return false
  for (const id of readdirSync(admin)) {
    const pointer = join(admin, id, 'gitdir')
    if (!existsSync(pointer) || dirname(readFileSync(pointer, 'utf8').trim()) !== data.worktree) continue
    return spawnSync('git', ['--git-dir', join(admin, id), 'diff', '--cached', '--quiet', data.HEAD]).status === 0
  }
  return false
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

/** An owner-declared historical exception is pinned to one registered noncanonical root and HEAD. */
async function historicalDeclarations(repo, checkouts, declarations) {
  const fail = reason => { throw new PlanError('HISTORICAL_SCOPE_CHANGED', reason) }
  if (!Array.isArray(declarations)) fail('historical_worktrees must list exact owner-approved roots, heads and evidence')
  const location = declarations.length ? await defaultLocation(repo) : null
  if (location && !location.available) fail('the canonical default checkout must be confirmed before archiving another worktree')
  const canonical = location ? realpathSync(location.checkout) : repo
  const result = new Map()
  for (const entry of declarations) {
    let root
    try { root = typeof entry?.root === 'string' ? realpathSync(entry.root) : null } catch { fail('an approved historical worktree is absent') }
    const checkout = checkouts.find(value => value.root === root)
    if (!checkout || root === repo || root === canonical || result.has(root) || !/^[0-9a-f]{40,64}$/u.test(entry?.head ?? '') || checkout.head !== entry.head || typeof entry.evidence !== 'string' || !entry.evidence.trim()) {
      fail(`historical exception does not match one registered noncanonical worktree at its approved HEAD: ${root ?? '(missing)'}`)
    }
    result.set(root, { root, head: entry.head, evidence: entry.evidence })
  }
  return result
}

/** The original index, reachable history and registration remain local, beside their captured planning images. */
async function historicalSnapshot(capture, destination, registration) {
  const folder = join(destination, 'historical', sha256(capture.root))
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const save = (name, bytes) => {
    const path = join(folder, name); writeFileSync(path, bytes, { mode: 0o600 })
    return { path, sha256: sha256(bytes) }
  }
  const indexPath = resolve(capture.root, textGit(capture.root, ['rev-parse', '--git-path', 'index']))
  const index = existsSync(indexPath) ? save('index', readFileSync(indexPath)) : null
  const sharedPath = textGit(capture.root, ['rev-parse', '--shared-index-path'])
  const sharedIndex = sharedPath ? save(basename(sharedPath), readFileSync(resolve(capture.root, sharedPath))) : null
  if ((existsSync(indexPath) ? sha256(readFileSync(indexPath)) : null) !== (index?.sha256 ?? null)) {
    throw new PlanError('HISTORICAL_SCOPE_CHANGED', 'the historical index changed while its complete image was captured')
  }
  const bundlePath = join(folder, 'history.bundle')
  git(capture.root, ['bundle', 'create', bundlePath, 'HEAD'])
  chmodSync(bundlePath, 0o600)
  if (!textGit(capture.root, ['bundle', 'list-heads', bundlePath]).split('\n').some(line => line === `${capture.head} HEAD`)) {
    throw new PlanError('HISTORICAL_SCOPE_CHANGED', 'historical HEAD changed while its history was captured')
  }
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(bundlePath)) hash.update(bytes)
  return { root: capture.root, head: capture.head, base: null, evidence: capture.historical.evidence,
    index, shared_index: sharedIndex, bundle: { path: bundlePath, sha256: hash.digest('hex') }, registration: save('worktrees.porcelain', registration) }
}

/** Capture every worktree; historical planning images never contribute canonical values. */
export async function reconcilePlan({ repo: given, upstream, output, historicalWorktrees = [], upstreamInHistory = false }) {
  const repo = realpathSync(given), destination = resolve(output)
  upstream = await upstreamFor(repo, upstream)
  if (existsSync(destination) && readdirSync(destination).length) throw new Error('reconciliation output is not empty')
  mkdirSync(destination, { recursive: true })
  const projection = join(destination, 'projection'), objects = join(destination, 'objects')
  mkdirSync(projection); mkdirSync(objects)
  const wt = worktrees(repo).sort((a, b) => a.root === repo ? -1 : b.root === repo ? 1 : a.root.localeCompare(b.root))
  const historical = await historicalDeclarations(repo, wt, historicalWorktrees)
  const roots = new Set(wt.flatMap(w => sources(w.root).roots))
  const planning = path => [...roots].some(root => path === root || path.startsWith(root + '/')) || /^docs\/platform\/(?:.*\/)?epic-\d+[-.].*\.md$/u.test(path)
  const upstreamHead = textGit(repo, ['rev-parse', upstream]), incomingTree = tree(repo, upstreamHead, planning)
  const captures = wt.map(w => {
    const merged = spawnSync('git', ['-C', repo, 'merge-base', w.head, upstreamHead], { encoding: 'utf8' })
    const archived = historical.get(w.root)
    if (archived && merged.status !== 1) throw new PlanError('HISTORICAL_SCOPE_CHANGED', 'the historical exception no longer describes unrelated history')
    if (merged.status === 1 && !archived) throw new PlanError('NO_COMMON_PLANNING_BASE', `${w.root} has unrelated history (${w.head}); preserve it and settle the handover before cutover`)
    if (merged.status !== 0 && !archived) throw new PlanError('UNREADABLE_PLANNING_BASE', `the common ancestor of ${w.root} cannot be read`)
    const base = archived ? null : merged.stdout.trim(), inventory = sources(w.root)
    // A checkout already holding a move retired its old files; those deletions are not local edits.
    const moved = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${w.head}:plan/migration.json`]).status === 0
    return { ...w, base, moved, historical: archived ?? null, files: inventory.files, baseTree: base === null ? new Map() : tree(repo, base, planning), headTree: tree(repo, w.head, planning), indexTree: index(w.root, planning) }
  })
  const stored = blobs(repo, [...incomingTree.values(), ...captures.flatMap(c => [...c.baseTree.values(), ...c.headTree.values(), ...c.indexTree.values()])].map(entry => entry.oid))
  const image = entry => entry ? { ...entry, ...stored.get(entry.oid) } : null
  const inputs = [], conflicts = [], approvalValues = [], settledConflicts = [], historicalArchives = [], canonical = new Map([...incomingTree].map(([path, entry]) => [path, image(entry)]))
  const keepInput = (owner, kind, path, value, historical = false) => {
    if (value && !existsSync(join(objects, value.sha256))) writeFileSync(join(objects, value.sha256), value.bytes, { mode: 0o600 })
    inputs.push({ owner, kind, path, sha256: value?.sha256 ?? sha256('absent'), present: Boolean(value), mode: value?.mode ?? null, ...(historical ? { historical: true } : {}), ...(value?.inode ? { inode: value.inode, device: value.device, permissions: value.permissions } : {}), object: value ? join(objects, value.sha256) : null })
  }
  const merge = (path, base, local, incoming, owner, phase) => {
    if (equal(local, base)) return incoming
    if (equal(incoming, base) || equal(local, incoming)) return local
    if (base && local && incoming && [base, local, incoming].every(value => value.mode !== '120000')) {
      const folder = join(destination, 'merge'); mkdirSync(folder, { recursive: true })
      for (const [name, value] of [['base', base], ['local', local], ['incoming', incoming]]) writeFileSync(join(folder, name), value.bytes)
      const combined = spawnSync('git', ['merge-file', '-p', join(folder, 'local'), join(folder, 'base'), join(folder, 'incoming')], { maxBuffer: 64 * 1024 * 1024 })
      const modeConflict = local.mode !== base.mode && incoming.mode !== base.mode && local.mode !== incoming.mode
      if (combined.status === 0 && !modeConflict && !(path.endsWith('/sprint-status.yaml') && repeatsRows(combined.stdout.toString('utf8')))) return { bytes: combined.stdout, sha256: sha256(combined.stdout), mode: local.mode === base.mode ? incoming.mode : local.mode }
    }
    const kept = join(destination, 'conflicts', sha256(owner).slice(0, 12), phase, path)
    mkdirSync(dirname(kept), { recursive: true }); writeFileSync(kept, local?.bytes ?? Buffer.alloc(0))
    // A stale image with repeated rows cannot be merged by row; it stays whole under conflicts, with upstream's text in the plan.
    let board = null
    try { board = path.endsWith('/sprint-status.yaml') && local && incoming ? mergeBoard(base, local, incoming) : null } catch (error) { if (!/^DUPLICATE: /u.test(error.message)) throw error }
    conflicts.push({ path, owner, phase, kept, local_present: Boolean(local), incoming_present: Boolean(incoming), local_sha256: local?.sha256 ?? null, incoming_sha256: incoming?.sha256 ?? null, ...(board ? { rows: board.conflicts.map(row => row.key) } : {}) })
    if (!board) return incoming
    for (const row of board.conflicts) {
      if (row.approval) approvalValues.push({ path, key: row.key, epic: row.approval, local: JSON.stringify(row.local), upstream: JSON.stringify(row.upstream), reason: 'conflicting go or withdrawal on the old board' })
      else settledConflicts.push({ path, key: row.key, owner, kept, local: row.local, upstream: row.upstream, settled: 'no go or withdrawal in dispute; upstream text kept, whole local kept' })
    }
    return { ...incoming, bytes: Buffer.from(board.text), sha256: sha256(board.text) }
  }
  for (const capture of captures) {
    if (capture.historical) {
      for (const path of new Set([...capture.files.map(file => file.path), ...capture.headTree.keys(), ...capture.indexTree.keys()])) {
        keepInput(capture.head, 'HEAD', path, image(capture.headTree.get(path)), true)
        keepInput(capture.root, 'index', path, image(capture.indexTree.get(path)), true)
        keepInput(capture.root, 'working', path, working(capture.root, path), true)
      }
      historicalArchives.push(await historicalSnapshot(capture, destination, git(repo, ['worktree', 'list', '--porcelain', '-z'])))
      continue
    }
    if (capture.moved) continue
    const paths = new Set([...capture.files.map(file => file.path), ...capture.baseTree.keys(), ...capture.headTree.keys(), ...capture.indexTree.keys(), ...incomingTree.keys()])
    for (const path of paths) {
      const base = image(capture.baseTree.get(path)), head = image(capture.headTree.get(path)), staged = image(capture.indexTree.get(path)), live = working(capture.root, path), incoming = image(incomingTree.get(path))
      for (const [kind, value, owner] of [['base', base, capture.base], ['HEAD', head, capture.head], ['index', staged, capture.root], ['working', live, capture.root], ['upstream', incoming, upstreamHead]]) keepInput(owner, kind, path, value)
      if (path.endsWith('.md') && !equal(base, incoming)) {
        const prior = approvalParts(base, path), next = approvalParts(incoming, path)
        // When the moved history keeps upstream, its reader sees upstream's change at once; a worktree only behind it holds nothing.
        const mine = approvalParts(live ?? head, path), same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
        for (const [epic, terms] of prior) if (terms.some(Boolean) && !same(terms, next.get(epic)) && (!upstreamInHistory || (!same(terms, mine.get(epic)) && !same(mine.get(epic), next.get(epic))))) approvalValues.push({ path, key: `epic-${epic}`, epic, local: JSON.stringify(mine.get(epic) ?? null), upstream: JSON.stringify(next.get(epic) ?? null), reason: 'upstream approved sections changed' })
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
  const fingerprint = sha256(JSON.stringify({ upstreamHead, worktrees: captures.map(c => [c.root, c.head, c.historical]), historical_archives: historicalArchives.map(c => [c.root, c.index?.sha256 ?? null, c.shared_index?.sha256 ?? null, c.registration.sha256]), inputs: inputs.map(({ owner, kind, path, sha256, mode, inode, device, historical }) => ({ owner, kind, path, sha256, mode, inode, device, historical })) }))
  const result = { version: 1, repo, projection, upstream: upstreamHead, worktrees: captures.map(c => ({ root: c.root, head: c.head, base: c.base })), historical_worktrees: historicalArchives, inputs, conflicts, fingerprint, approval_conflicts: [...new Set(approvalValues.map(value => value.epic))].sort((a, b) => a - b), approval_conflict_values: [...new Map(approvalValues.map(value => [JSON.stringify(value), value])).values()], settled_conflicts: settledConflicts }
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
export function planFingerprint(folder) {
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

/** Upstream already holding a confirmed move: its plan, the pre-move commit it was cut from, and the move commit. */
export function mergedMoveOf(repo, upstream) {
  const head = textGit(repo, ['rev-parse', upstream])
  const read = spawnSync('git', ['-C', repo, 'show', `${head}:plan/migration.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (read.status !== 0) return null
  let metadata
  try { metadata = JSON.parse(read.stdout) } catch { throw new PlanError('MOVE_BOUNDARY_UNCONFIRMED', 'the upstream migration record is unreadable') }
  const added = textGit(repo, ['log', '--reverse', '--topo-order', '--full-history', '--diff-filter=A', '--format=%H', head, '--', 'plan/migration.json']).split('\n').filter(Boolean)
  const commit = added.find(id => spawnSync('git', ['-C', repo, 'rev-parse', `${id}^1`], { encoding: 'utf8' }).stdout.trim() === metadata.history_head)
  if (metadata.version !== 1 || !commit) throw new PlanError('MOVE_BOUNDARY_UNCONFIRMED', `upstream's move commit does not descend directly from ${metadata.history_head}; it was squashed or rebased after master advanced`)
  return { head, anchor: metadata.history_head, commit, source_board: metadata.source_board }
}
/** The reader seeds gos through the cut only: an approval event after it, even one later reverted, must not vanish silently. */
export function approvalEventsAfterCut(repo, source, anchor, tips) {
  const events = []
  const boardAt = commit => { const read = spawnSync('git', ['-C', repo, 'show', `${commit}:${source}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return read.status === 0 ? rowsOf(read.stdout) : null }
  for (const tip of new Set(tips)) {
    let previous = boardAt(anchor)
    if (!previous) continue
    for (const commit of textGit(repo, ['rev-list', '--reverse', '--topo-order', '--full-history', `${anchor}..${tip}`, '--', source]).split('\n').filter(Boolean)) {
      const rows = boardAt(commit)
      if (!rows) {
        if (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${commit}:plan/migration.json`]).status === 0) continue // The move's own retirement of the board.
        events.push({ commit, key: 'board removed', before: null, after: null }); continue
      }
      for (const key of new Set([...previous.keys(), ...rows.keys()])) {
        if (!/^epic-\d+$/u.test(key)) continue
        const old = previous.get(key), now = rows.get(key)
        if (goTokens(old) !== goTokens(now) || (Boolean(old) && (!now || (WITHDRAWN.has(now.status) && !WITHDRAWN.has(old.status))))) events.push({ commit, key, before: old ?? null, after: now ?? null })
      }
      previous = rows
    }
  }
  return events
}
export function extractPlan(repo, commit, output) {
  mkdirSync(output, { recursive: true })
  const archived = spawnSync('git', ['-C', repo, 'archive', commit, 'plan'], { maxBuffer: 2 * 1024 * 1024 * 1024 })
  if (archived.status !== 0) throw new Error('the upstream plan cannot be read')
  const unpacked = spawnSync('tar', ['-x', '-C', output], { input: archived.stdout, maxBuffer: 64 * 1024 * 1024 })
  if (unpacked.status !== 0) throw new Error('the upstream plan cannot be unpacked')
  return join(output, 'plan')
}
const epicNumber = path => /^epics\/0*(\d+)[-.]/u.exec(path)?.[1] ?? null
/** One generated epic may be renamed by a title edit; it keeps the file upstream established. */
function establishedPaths(generated, theirs) {
  const byNumber = new Map()
  for (const path of theirs) { const number = epicNumber(path); if (number) byNumber.set(number, [...(byNumber.get(number) ?? []), path]) }
  const mapped = new Map()
  for (const path of generated) {
    const number = epicNumber(path), established = number ? byNumber.get(number) : null
    if (established?.length > 1 && !established.includes(path)) throw new PlanError('EPIC_FILE_AMBIGUOUS', `epic ${number} has several files upstream: ${established.join(', ')}`)
    mapped.set(established?.length === 1 ? established[0] : path, path)
  }
  return mapped
}
const INCOMING_ONLY = new Set(['migration.json', 'VISION.md', 'PLAN.md', 'bmad-copy.json'])
/**
 * base and ours are stagePlan outputs from the two captures under one context, so base to ours is exactly what changed in
 * the old sources; base to theirs is every edit made to the plan since. D15's rule applies per path, and per row on the board.
 * Text under a local-only pattern, or changed locally after upstream removed it, stays out of the plan and only its hash is named.
 */
export function mergeStagedPlan({ base, ours, theirs, output, date, localOnly = [], keep, incomingOnly = INCOMING_ONLY }) {
  const patterns = localOnly.map(source => new RegExp(source, 'u')), privatePath = path => patterns.some(pattern => pattern.test(path))
  const theirFiles = filesUnder(theirs), oursBy = establishedPaths(filesUnder(ours), theirFiles), baseBy = establishedPaths(filesUnder(base), theirFiles)
  const renames = [...oursBy].filter(([established, generated]) => established !== generated).map(([established, generated]) => [basename(generated), basename(established)])
  const relinked = image => {
    if (!image || !renames.length || image.mode === '120000') return image
    let text = image.bytes.toString()
    for (const [generated, established] of renames) text = text.split(generated).join(established)
    return { ...image, bytes: Buffer.from(text), sha256: sha256(text) }
  }
  const result = { conflicts: [], rows: [], approval_conflicts: [], approval_conflict_values: [], settled_conflicts: [], local_only: [] }
  const keepAside = (path, image, reason) => {
    const kept = join(keep, sha256(path).slice(0, 16)); mkdirSync(keep, { recursive: true, mode: 0o700 }); writeFileSync(kept, image.bytes, { mode: 0o600 })
    result.local_only.push({ path, sha256: image.sha256, kept, reason })
  }
  const conflictFile = (path, image) => { const kept = `references/moved/${date}/conflicts/${path}.local`; put(output, kept, { ...image, mode: '100644' }); return kept }
  mkdirSync(output, { recursive: true })
  for (const path of new Set([...oursBy.keys(), ...baseBy.keys(), ...theirFiles])) {
    const load = (root, name) => name === undefined ? null : working(root, name)
    const b = load(base, baseBy.get(path)), o = relinked(load(ours, oursBy.get(path))), u = theirFiles.includes(path) ? working(theirs, path) : null
    if (privatePath(path)) { if (o && !equal(o, b)) keepAside(path, o, 'local-only path changed'); continue }
    let chosen
    if (incomingOnly.has(path) || equal(o, b)) chosen = u
    else if (equal(u, b) || equal(o, u)) chosen = o
    else if (!u) { keepAside(path, o, 'changed locally after upstream removed it'); chosen = null }
    else if (path === 'status.yaml' && o) {
      const board = mergeBoard(b, o, u)
      chosen = { ...u, bytes: Buffer.from(board.text), sha256: sha256(board.text) }
      if (board.conflicts.length) {
        const kept = conflictFile(path, o)
        for (const row of board.conflicts) {
          result.rows.push({ key: row.key, kept })
          if (row.approval) { result.approval_conflicts.push(row.approval); result.approval_conflict_values.push({ path, key: row.key, epic: row.approval, local: JSON.stringify(row.local), upstream: JSON.stringify(row.upstream), reason: 'conflicting go or withdrawal on the board' }) }
          else result.settled_conflicts.push({ path, key: row.key, kept, local: row.local, upstream: row.upstream, settled: 'no go or withdrawal in dispute; upstream text kept, whole local kept' })
        }
      }
    } else if (!o) chosen = u
    else {
      const folder = `${output}.merge`; mkdirSync(folder, { recursive: true })
      for (const [name, value] of [['base', b], ['local', o], ['incoming', u]]) writeFileSync(join(folder, name), value?.bytes ?? Buffer.alloc(0))
      const combined = o.mode !== '120000' && u.mode !== '120000' ? spawnSync('git', ['merge-file', '-p', join(folder, 'local'), join(folder, 'base'), join(folder, 'incoming')], { maxBuffer: 64 * 1024 * 1024 }) : { status: 1 }
      if (combined.status === 0) chosen = { ...u, bytes: combined.stdout, sha256: sha256(combined.stdout) }
      else { chosen = u; result.conflicts.push({ path, kept: conflictFile(path, o), local_sha256: o.sha256, incoming_sha256: u.sha256 }) }
    }
    put(output, path, chosen)
  }
  rmSync(`${output}.merge`, { recursive: true, force: true })
  result.approval_conflicts = [...new Set(result.approval_conflicts)].sort((x, y) => x - y)
  return result
}
/** Is this old-source path, under its generated placement too, one that must stay out of anything published? */
export const staysLocal = (path, placements, localOnly) => {
  const patterns = localOnly.map(source => new RegExp(source, 'u')), placed = placements.find(file => file.path === path)?.to
  // A kept BMAD document stays in its own checkout; a conflict over it publishes nothing.
  return placed === 'linked' || patterns.some(pattern => pattern.test(path) || (placed && pattern.test(placed)))
}
/** The published record of a capture: paths and hashes, no absolute local paths or kept bytes. */
export function publishedInputs(capture) {
  return { upstream: capture.upstream, fingerprint: capture.fingerprint, worktrees: capture.worktrees.length, inputs: capture.inputs.length, conflicts: capture.conflicts.map(({ path, phase, local_sha256, incoming_sha256, rows }) => ({ path, phase, local_sha256, incoming_sha256, ...(rows ? { rows } : {}) })) }
}
function blobAt(repo, commit, path) {
  const entry = textGit(repo, ['ls-tree', commit, '--', path])
  const match = /^(\d+) blob ([0-9a-f]+)\t/u.exec(entry)
  if (!match) return null
  const bytes = git(repo, ['cat-file', 'blob', match[2]])
  return { bytes, sha256: sha256(bytes), mode: match[1], oid: match[2] }
}
/** What advancing the default checkout from H to C does outside plan/. Nothing is written here; an overlap parks before any write. */
export function productInstall(repo, from, to, planningPaths, keepBmad) {
  const entries = git(repo, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to]).toString().split('\0').filter(Boolean)
  const writes = [], overlaps = []
  for (const path of entries) {
    if (path === 'plan' || path.startsWith('plan/')) continue
    const planning = planningPaths.has(path), incoming = blobAt(repo, to, path)
    // A retired old file stays physically for recovery unless it survives as a kept board or a forwarding stub.
    if (planning && !keepBmad && !incoming) continue
    const old = blobAt(repo, from, path), live = working(repo, path)
    const staged = textGit(repo, ['ls-files', '-s', '--', path]), entryOf = blob => blob ? `${blob.mode} ${blob.oid} 0\t${path}` : ''
    if (!planning && staged !== entryOf(old) && staged !== entryOf(incoming)) { overlaps.push({ path, reason: 'staged change overlaps the incoming one' }); continue }
    if (equal(live, incoming)) continue
    if (equal(live, old)) { writes.push({ path, image: incoming, planning }); continue }
    if (planning) { writes.push({ path, image: incoming, planning, captured: true }); continue } // Its local bytes are already in the capture.
    if (old && live && incoming && live.mode !== '120000' && incoming.mode !== '120000') {
      const folder = join(migrationPaths(repo).folder, `product-merge-${process.pid}`); mkdirSync(folder, { recursive: true })
      try {
        for (const [name, value] of [['base', old], ['local', live], ['incoming', incoming]]) writeFileSync(join(folder, name), value.bytes)
        const combined = spawnSync('git', ['merge-file', '-p', join(folder, 'local'), join(folder, 'base'), join(folder, 'incoming')], { maxBuffer: 64 * 1024 * 1024 })
        if (combined.status === 0) { writes.push({ path, image: { ...incoming, bytes: combined.stdout, sha256: sha256(combined.stdout), mode: live.mode }, planning: false, merged: true }); continue }
      } finally { rmSync(folder, { recursive: true, force: true }) }
    }
    overlaps.push({ path, reason: 'local changes conflict with the incoming ones' })
  }
  return { writes, overlaps, affected: entries }
}
/** A fenced planning file keeps its inode, so the watchdog can still restore its mode. */
function writeProduct(repo, write) {
  const full = join(repo, write.path)
  if (!write.planning) { atomicImage(full, write.image, write.image?.mode === '100755' ? 0o755 : undefined); return }
  if (!write.image) { const mode = statSync(dirname(full)).mode & 0o777; chmodSync(dirname(full), mode | 0o200); try { rmSync(full, { force: true }) } finally { chmodSync(dirname(full), mode) } return }
  const mode = statSync(full).mode & 0o777
  chmodSync(full, mode | 0o200); try { writeFileSync(full, write.image.bytes) } finally { chmodSync(full, mode) }
}
/** The local commits stay in history as C's first parent; upstream's move is its second. Old planning paths follow upstream. */
function prepareMergedCommit(repo, stage, merged, expected, planningPaths) {
  const paths = migrationPaths(repo), indexFile = join(paths.folder, `merged-${process.pid}.index`), environment = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    if (merged.divergent) {
      const combined = spawnSync('git', ['-C', repo, 'merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', expected, merged.head], { maxBuffer: 512 * 1024 * 1024 })
      if (combined.status > 1 || combined.status === null) throw new Error('the local and upstream product trees cannot be merged')
      const [tree, ...conflicted] = combined.stdout.toString().split('\0').filter(Boolean)
      const blocking = conflicted.filter(path => !planningPaths.has(path) && path !== 'plan' && !path.startsWith('plan/'))
      if (blocking.length) return { overlaps: blocking.map(path => ({ path, reason: 'local commits conflict with upstream' })) }
      git(repo, ['read-tree', tree], { env: environment })
      for (const path of conflicted) {
        const entry = textGit(repo, ['ls-tree', merged.head, '--', path]), match = /^(\d+) blob ([0-9a-f]+)\t/u.exec(entry)
        git(repo, ['update-index', '-z', '--index-info'], { env: environment, input: `${match ? `${match[1]} ${match[2]}` : `0 ${'0'.repeat(40)}`}\t${path}\0` })
      }
      // Old planning paths at upstream's value: their local values are already in the plan.
      for (const path of planningPaths) {
        const entry = textGit(repo, ['ls-tree', merged.head, '--', path]), match = /^(\d+) blob ([0-9a-f]+)\t/u.exec(entry)
        git(repo, ['update-index', '-z', '--index-info'], { env: environment, input: `${match ? `${match[1]} ${match[2]}` : `0 ${'0'.repeat(40)}`}\t${path}\0` })
      }
    } else git(repo, ['read-tree', merged.head], { env: environment })
    const gitDir = textGit(repo, ['rev-parse', '--absolute-git-dir'])
    git(dirname(stage), ['add', '--sparse', '--all', '--', 'plan'], { env: { ...environment, GIT_DIR: gitDir, GIT_WORK_TREE: dirname(stage) } })
    const tree = git(repo, ['write-tree'], { env: environment }).toString().trim()
    const message = ['plan: bring the move up to the live plan', '', 'Plan-Cutover: yes'].join('\n')
    if (merged.divergent) return { commit: textGit(repo, ['commit-tree', tree, '-p', expected, '-p', merged.head, '-m', message]) }
    const unchanged = tree === textGit(repo, ['rev-parse', `${merged.head}^{tree}`])
    return { commit: unchanged ? merged.head : textGit(repo, ['commit-tree', tree, '-p', merged.head, '-m', message]) }
  } finally { rmSync(indexFile, { force: true }) }
}

/** Switch only with complete handover and a stable final capture. All original physical files remain for recovery. */
export async function cutoverPlan({ repo: given, upstream, handover, keepBmad = false, vision = null, date = new Date().toISOString().slice(0, 10), baseline = null, localOnly = [], seam = async () => {} }) {
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
    const merged = mergedMoveOf(repo, upstream)
    if (merged) {
      const parked = (code, reason, extra = {}) => ({ outcome: 'parked', code, reason, journal: paths.journal, ...extra })
      if (!baseline?.projection || !existsSync(baseline.projection) || planFingerprint(baseline.projection) !== baseline.fingerprint || !baseline.date) return parked('BASELINE_REQUIRED', 'a merged move needs the capture projection it was generated from, pinned by fingerprint and date')
      date = baseline.date
      const head = textGit(repo, ['rev-parse', 'HEAD'])
      merged.divergent = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', head, merged.head]).status !== 0
      const auditFrom = merged.divergent ? textGit(repo, ['merge-base', head, merged.head]) : merged.anchor
      const events = approvalEventsAfterCut(repo, merged.source_board, auditFrom, [merged.head])
      if (events.length) return parked('APPROVAL_HISTORY_AFTER_CUT', 'the old board recorded approval events after the move was cut; cut the move again', { events })
    }
    const native = Boolean(merged) && ancestor(repo, merged.commit)
    const planExists = existsSync(join(repo, 'plan')), interrupted = planExists && state?.switch_commit && planFingerprint(join(repo, 'plan')) === state.installed_fingerprint
    if (planExists && !interrupted && !native) throw new Error('EXISTING_PLAN: keep and settle the existing plan before starting another move')
    if (interrupted) {
      const preserved = join(paths.folder, `interrupted-plan-${randomBytes(5).toString('hex')}`)
      renameSync(join(repo, 'plan'), preserved)
      state.preserved_interrupted_plan = preserved
    }
    if (state?.native_backup && existsSync(state.native_backup)) {
      if (existsSync(join(repo, 'plan'))) throw new Error('EXISTING_PLAN: both a native plan and its interrupted backup exist; settle them before retrying')
      renameSync(state.native_backup, join(repo, 'plan'))
    }
    if (native) {
      const staged = textGit(repo, ['diff', '--cached', '--name-only', 'HEAD', '--', 'plan'])
      if (staged) return { outcome: 'parked', code: 'NATIVE_INDEX_STAGED', reason: 'plan files are staged in the default checkout; commit or unstage them first', paths: staged.split('\n'), journal: paths.journal }
    }
    for (const worktree of worktrees(repo)) {
      if (worktree.root === repo || spawnSync('git', ['-C', repo, 'cat-file', '-e', `${worktree.head}:plan/migration.json`]).status !== 0) continue
      const dirty = textGit(worktree.root, ['status', '--porcelain', '--', 'plan'])
      if (dirty) return { outcome: 'parked', code: 'NATIVE_WORKTREE_DIRTY', reason: `${worktree.root} has uncommitted plan edits outside the default checkout`, journal: paths.journal }
    }
    const nonce = randomBytes(8).toString('hex'), runFolder = join(paths.folder, nonce)
    mkdirSync(runFolder, { recursive: true })
    state = { version: 1, repo, phase: 'capturing', fenced: false, watchdog_nonce: watchdog.nonce, watchdog: { pid: watchdog.pid, start_ticks: watchdog.start_ticks }, owner: { pid: process.pid, start_ticks: startTicks(process.pid) }, run_folder: runFolder, keep_bmad: keepBmad, date }
    await step('capturing')
    const parserProof = keepBmad ? preparedBmadProof(repo) : null
    const capturing = output => reconcilePlan({ repo, upstream: merged ? merged.anchor : upstream, upstreamInHistory: Boolean(merged), historicalWorktrees: handover?.historical_worktrees, output })
    let capture, stage, manifest, planMerge = null, nativeFingerprint = null
    for (let pass = 1; pass <= 3; pass++) {
      nativeFingerprint = native ? planFingerprint(join(repo, 'plan')) : null
      capture = await capturing(join(runFolder, `capture-${pass}`))
      await step('captured', { pass, capture_manifest: join(runFolder, `capture-${pass}`, 'manifest.json') })
      const problem = handoverProblem(capture, handover)
      if (problem) return { outcome: 'parked', code: 'HANDOVER_REQUIRED', reason: problem, journal: paths.journal }
      stage = join(runFolder, `stage-${pass}`, 'plan')
      manifest = stagePlan({ repo: capture.projection, contextRepo: repo, stage, keepBmad, copyOwners: handover.copy_owners ?? {}, vision, date, historyHead: merged?.anchor ?? null, archive: join(runFolder, `archive-${pass}`) })
      if (manifest.copy && Object.keys(manifest.copy.unresolved).length) return { outcome: 'parked', code: 'COPY_PROVENANCE_REQUIRED', rows: Object.keys(manifest.copy.unresolved), journal: paths.journal }
      const archiveFailures = archive({ repo: capture.projection, manifest, folder: manifest.archive })
      if (archiveFailures.length) throw new Error('ARCHIVE_INVALID: ' + archiveFailures.join('; '))
      await step('archived', { archive: manifest.archive })
      const spans = checkSpans({ repo: capture.projection, stage, manifest })
      if (spans.length) throw new Error('STAGE_INVALID: ' + spans.join('; '))
      if (merged) {
        const baseStage = join(runFolder, `base-${pass}`, 'plan')
        stagePlan({ repo: baseline.projection, contextRepo: repo, stage: baseStage, keepBmad, copyOwners: handover.copy_owners ?? {}, vision, date, historyHead: merged.anchor, archive: join(runFolder, `base-archive-${pass}`) })
        let theirs = extractPlan(repo, merged.head, join(runFolder, `upstream-${pass}`))
        if (native) {
          // What the checkout has beyond upstream, committed or live, on top of upstream's plan: the base is where the two forked.
          const combined = join(runFolder, `native-${pass}`, 'plan')
          const nativeMerge = mergeStagedPlan({ base: extractPlan(repo, textGit(repo, ['merge-base', 'HEAD', merged.head]), join(runFolder, `native-head-${pass}`)), ours: join(repo, 'plan'), theirs, output: combined, date, keep: join(runFolder, 'local-only'), incomingOnly: new Set() })
          if (nativeMerge.conflicts.length || nativeMerge.rows.length) return { outcome: 'parked', code: 'NATIVE_PLAN_CONFLICT', conflicts: [...nativeMerge.conflicts.map(entry => entry.path), ...nativeMerge.rows.map(entry => entry.key)], journal: paths.journal }
          theirs = combined
        }
        const output = join(runFolder, `merged-${pass}`, 'plan')
        planMerge = mergeStagedPlan({ base: baseStage, ours: stage, theirs, output, date, localOnly, keep: join(runFolder, 'local-only') })
        stage = output
      }
      const checked = await checkPlan({ productRoot: repo, planRoot: stage, boardPath: join(stage, 'status.yaml'), format: 'bmn-plan' })
      if (checked.findings.length) throw new Error('STAGE_INVALID: ' + checked.findings.map(f => f.reason).join('; '))
      await step('staged', { stage })
      const next = await capturing(join(runFolder, `verify-${pass}`))
      if (next.fingerprint === capture.fingerprint && (!native || planFingerprint(join(repo, 'plan')) === nativeFingerprint)) break
      if (pass === 3) return { outcome: 'parked', code: 'INPUTS_STILL_CHANGING', journal: paths.journal }
    }
    const problem = handoverProblem(capture, handover)
    if (problem) return { outcome: 'parked', code: 'HANDOVER_REQUIRED', reason: problem, journal: paths.journal }
    const nativePaths = native ? [join(repo, 'plan'), ...filesUnder(join(repo, 'plan')).flatMap(path => { const full = join(repo, 'plan', path), parents = []; for (let dir = dirname(full); dir !== join(repo, 'plan'); dir = dirname(dir)) parents.push(dir); return [full, ...parents] })] : []
    const nativeFence = [...new Set(nativePaths)].filter(path => !lstatSync(path).isSymbolicLink()).map(path => { const stat = lstatSync(path); return { path, device: String(stat.dev), inode: String(stat.ino), mode: stat.mode & 0o777 } })
    const fence = [...fenceInventory(capture.worktrees), ...nativeFence]
    await step('armed', { fence, final_fingerprint: capture.fingerprint })
    await watchdog.arm()
    await step('fenced', { fenced: true })
    for (let index = 0; index < fence.length; index++) { applyFence([fence[index]]); await seam('chmod', { ...state, chmod_index: index }) }
    const final = await capturing(join(runFolder, 'final-capture'))
    if (final.fingerprint !== capture.fingerprint || (native && planFingerprint(join(repo, 'plan')) !== nativeFingerprint)) return { outcome: 'parked', code: 'INPUT_CHANGED_DURING_HANDOVER', journal: paths.journal }
    await step('final-captured')
    const moved = join(stage, 'references', 'moved', date)
    mkdirSync(moved, { recursive: true })
    mkdirSync(join(moved, 'conflicts'), { recursive: true })
    for (let index = 0; index < capture.conflicts.length; index++) if (!staysLocal(capture.conflicts[index].path, manifest.files, localOnly)) cpSync(capture.conflicts[index].kept, join(moved, 'conflicts', `conflict-${index + 1}.local`))
    writeFileSync(join(moved, 'inputs.json'), JSON.stringify(merged ? publishedInputs(capture) : capture, null, 2) + '\n')
    const metadata = join(stage, 'migration.json')
    const metadataNow = loadJournal(metadata)
    saveJournal(metadata, { ...metadataNow,
      approval_conflicts: [...new Set([...(metadataNow.approval_conflicts ?? []), ...capture.approval_conflicts, ...(planMerge?.approval_conflicts ?? [])])].sort((a, b) => a - b),
      approval_conflict_values: [...(metadataNow.approval_conflict_values ?? []), ...capture.approval_conflict_values, ...(planMerge?.approval_conflict_values ?? [])] })
    if (capture.settled_conflicts.length || planMerge) {
      const settled = { capture: capture.settled_conflicts, plan: planMerge?.settled_conflicts ?? [], plan_conflicts: planMerge?.conflicts ?? [], local_only: (planMerge?.local_only ?? []).map(({ path, sha256, reason }) => ({ path, sha256, reason })) }
      writeFileSync(join(moved, 'settled-conflicts.json'), JSON.stringify(settled, null, 2) + '\n')
    }
    if (keepBmad && existsSync(join(stage, 'bmad-copy.json'))) {
      const record = join(stage, 'bmad-copy.json'); saveJournal(record, { ...loadJournal(record), active: true, parser_preparation: parserProof })
    }
    const expected = textGit(repo, ['rev-parse', 'HEAD'])
    let prepared, install = null
    if (merged) {
      const planningPaths = new Set(capture.inputs.map(input => input.path))
      if (merged.divergent) saveJournal(metadata, { ...loadJournal(metadata), local_history_head: expected })
      const made = prepareMergedCommit(repo, stage, merged, expected, planningPaths)
      if (made.overlaps) return { outcome: 'parked', code: 'PRODUCT_OVERLAP', overlaps: made.overlaps, journal: paths.journal }
      const commit = made.commit
      install = productInstall(repo, expected, commit, planningPaths, keepBmad)
      if (install.overlaps.length) return { outcome: 'parked', code: 'PRODUCT_OVERLAP', overlaps: install.overlaps, journal: paths.journal }
      prepared = { commit, affected: install.affected, beforeIndex: Object.fromEntries(install.affected.map(path => [path, textGit(repo, ['ls-files', '-s', '--', path])])) }
      const images = join(runFolder, 'product-before'); mkdirSync(images, { recursive: true, mode: 0o700 })
      prepared.productWrites = install.writes.map(write => {
        const before = working(repo, write.path), object = before ? join(images, before.sha256) : null
        if (before) writeFileSync(object, before.bytes, { mode: 0o600 })
        return { path: write.path, before: before ? { sha256: before.sha256, mode: before.mode } : null, object, after: write.image ? { sha256: write.image.sha256, mode: write.image.mode } : null }
      })
    } else prepared = prepareCommit(repo, stage, capture, keepBmad, expected, parserProof)
    const retiredPaths = merged && !keepBmad ? [...new Set(capture.inputs.filter(input => input.kind === 'upstream' && input.present).map(input => input.path))] : null
    await step('commit-prepared', { expected_parent: expected, branch: textGit(repo, ['symbolic-ref', 'HEAD']), switch_commit: prepared.commit, affected: prepared.affected, before_index: prepared.beforeIndex, installed_fingerprint: planFingerprint(stage), source_board: manifest.moved_from, original_projection: capture.projection, ...(merged ? { rollback_baseline: merged.anchor, retired_paths: retiredPaths ?? [], product_writes: prepared.productWrites } : {}) })
    if (native) {
      const moving = new Set(nativeFence.map(entry => entry.path))
      for (const entry of nativeFence) chmodSync(entry.path, entry.mode)
      const backup = join(paths.folder, `native-plan-${nonce}`)
      await step('native-released', { fence: state.fence.filter(entry => !moving.has(entry.path)), native_backup: backup })
      renameSync(join(repo, 'plan'), backup)
      await seam('native-moved', state)
    }
    renameSync(stage, join(repo, 'plan'))
    for (const write of install?.writes ?? []) writeProduct(repo, write)
    await step('installed')
    if (prepared.commit !== expected) git(repo, ['update-ref', state.branch, prepared.commit, expected])
    await step('ref-committed')
    const kept = refreshIndex(repo, state)
    await step('ref-committed', { index_refreshed: true, preserved_index_entries: kept })
    return { outcome: 'moved', commit: prepared.commit, journal: paths.journal, conflicts: capture.conflicts, preserved_index_entries: kept }
  } catch (error) {
    if (['MISSING_WORKTREE', 'NO_COMMON_PLANNING_BASE', 'UNREADABLE_PLANNING_BASE', 'BMAD_PREPARATION_REQUIRED', 'BMAD_PREPARATION_UNREADABLE', 'NO_DEFAULT_CHECKOUT', 'NOT_DEFAULT_CHECKOUT', 'HISTORICAL_SCOPE_CHANGED'].includes(error.code)) return { outcome: 'parked', code: error.code, reason: error.message, journal: paths.journal }
    throw error
  } finally { await watchdog.release(); await seam('restored', loadJournal(paths.journal)) }
}

// The approval reader's own withdrawal words (dev-auto run_needs.py), plus this format's dropped.
const WITHDRAWN = new Set(['backlog', 'withdrawn', 'superseded', 'skipped', 'dropped'])
const GO_TOKEN = /\bgo \d{4}-\d{2}-\d{2}\b/gu
const goTokens = row => JSON.stringify([...new Set(row?.note.match(GO_TOKEN) ?? [])].sort())
/**
 * Row by row, D15's rule per row instead of per file: one side changed, take it; both differently, upstream's text.
 * Only a go both sides changed differently can affect authority (D11); a diverged status note grants and removes nothing.
 */
function mergeBoard(base, local, incoming) {
  const before = rowsOf(base?.bytes.toString() ?? ''), ours = rowsOf(local.bytes.toString()), theirs = rowsOf(incoming.bytes.toString())
  let text = incoming.bytes.toString()
  const conflicts = [], same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  for (const key of new Set([...before.keys(), ...ours.keys(), ...theirs.keys()])) {
    const old = before.get(key), mine = ours.get(key), other = theirs.get(key)
    if (same(mine, old) || same(mine, other)) continue
    if (same(other, old)) {
      if (!mine) continue // Upstream keeps a row a stale local copy dropped; the whole local image remains kept.
      text = replaceRow(text, key, mine.status, mine.note)?.text ?? appendRow(text, key, mine.status, mine.note)
      continue
    }
    const goOld = goTokens(old), goMine = goTokens(mine), goOther = goTokens(other), epic = /^epic-(\d+)$/u.exec(key)
    const withdrawn = row => !row || WITHDRAWN.has(row.status), carriesGo = [goOld, goMine, goOther].some(value => value !== '[]')
    const disputed = (goMine !== goOld && goOther !== goOld && goMine !== goOther) || (carriesGo && withdrawn(mine) !== withdrawn(other))
    conflicts.push({ key, local: mine ?? null, upstream: other ?? null, approval: epic && disputed ? Number(epic[1]) : null })
  }
  return { text, conflicts }
}

const repeatsRows = (text) => { try { rowsOf(text); return false } catch (error) { if (/^DUPLICATE: /u.test(error.message)) return true; throw error } }
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
    const baseline = state.rollback_baseline ?? `${state.switch_commit}^`
    const retired = (state.retired_paths ?? git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', baseline, state.switch_commit]).toString().split('\0')).filter(path => path && !parserPaths.includes(path))
    const planPaths = git(repo, ['ls-tree', '-r', '--name-only', '-z', currentHead, '--', 'plan']).toString().split('\0').filter(Boolean)
    const affected = [...new Set([...retired, ...planPaths, state.source_board])]
    const wanted = new Set(affected), parentTree = tree(repo, baseline, path => wanted.has(path))
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
