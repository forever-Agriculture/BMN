// MODULE: plan-reconciliation.mjs - verified per-allowance publication baselines, never new authority
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { allowanceHistoryAt, parseAllowances } from './plan-allowances.mjs'
import { approvalText } from './plan-cli.mjs'
import { PlanError } from './plan-board.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const commitId = value => typeof value === 'string' && /^[0-9a-f]{40,64}$/u.test(value)
const epicOf = file => Number(/^plan\/allowances\/(\d+)\.yaml$/u.exec(file)?.[1])
const active = status => typeof status === 'string' && !['backlog', 'dropped'].includes(status)
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

export function planWorkingDigest(plan) {
  const names = execFileSync('git', ['-C', plan.boardCheckout, 'ls-files', '-c', '--others', '--exclude-standard', '-z', '--', 'plan'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const boardLock = relative(plan.boardCheckout, join(dirname(plan.boardPath), `.${basename(plan.boardPath)}.lock`)).split('\\').join('/')
  return sha(JSON.stringify([...new Set(names)].filter(file => file !== boardLock).sort().map(file => {
    const path = join(plan.boardCheckout, file)
    let stat
    try { stat = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return [file, 'deleted']; throw error }
    if (stat.isSymbolicLink()) return [file, 'link', sha(readlinkSync(path))]
    if (!stat.isFile()) throw new PlanError('RECONCILIATION_CHANGED', 'a pinned planning path is not a file')
    return [file, 'file', sha(readFileSync(path))]
  })))
}

export function equivalentAllowance(file, a, b) {
  if (!Number.isInteger(epicOf(file)) || a === null || b === null) return false
  try {
    const left = parseAllowances(text(a), epicOf(file)), right = parseAllowances(text(b), epicOf(file))
    return !left.problems.length && !right.problems.length && isDeepStrictEqual(left.data, right.data)
  } catch { return false }
}

export function validReconciliations(value) {
  return value === undefined || Boolean(value && value.version === 1 && Object.keys(value).length === 2 &&
    value.files && typeof value.files === 'object' && !Array.isArray(value.files) &&
    Object.entries(value.files).every(([file, anchor]) => Number.isInteger(epicOf(file)) && anchor &&
      Object.keys(anchor).length === 2 && commitId(anchor.checkpoint) && commitId(anchor.upstream)))
}

export function planReconciliation(plan, state, checkpoint, upstream, migration = null) {
  const repo = plan.boardCheckout
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const blob = (revision, file) => {
    const result = spawnSync('git', ['-C', repo, 'show', `${revision}:${file}`], { maxBuffer: 64 * 1024 * 1024 })
    return result.status === 0 ? result.stdout : null
  }
  // A shallow history can hide intervening incoming commits, including a merged side's transient restriction.
  const shallow = git('rev-parse', '--is-shallow-repository') !== 'false'
  const ancestor = (a, b) => commitId(a) && commitId(b) && spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b]).status === 0
  const files = revision => git('ls-tree', '-r', '--name-only', revision, '--', 'plan').split('\n').filter(Boolean)
  const unique = (revision, file) => files(revision).filter(name => epicOf(name) === epicOf(file)).length === 1
  const snapshot = (revision, file) => {
    const record = allowanceHistoryAt(plan, epicOf(file), revision), bytes = blob(revision, file)
    return record && record.path === file && active(record.status) && unique(revision, file) &&
      bytes !== null && bytes.equals(Buffer.from(record.text)) && equivalentAllowance(file, bytes, bytes) ? record : null
  }
  const authorityText = (revision, epic) => {
    const names = files(revision).filter(file => new RegExp(`^plan/epics/0*${epic}-`, 'u').test(file))
    return names.length === 1 ? approvalText(text(blob(revision, names[0]))) : null
  }
  const incomingStable = (file, anchor) => {
    const original = blob(anchor.upstream, file), epic = epicOf(file)
    // A plan-only publication replicates reviewed bytes, not the local Go commit's ancestry.
    const incomingGo = revision => git('log', '-1', '--format=%H', '-E', `--grep=^Go-Epic: 0*${epic}[[:space:]]*$`, revision) || null
    const originalGo = incomingGo(anchor.upstream)
    const approval = authorityText(anchor.upstream, epic)
    if (approval === null) return false
    // Include every merge parent. Endpoint equality cannot excuse a restriction followed by a revert.
    const intervening = git('rev-list', '--max-count=257', `${anchor.upstream}..${upstream}`).split('\n').filter(Boolean)
    if (intervening.length > 256) return false
    for (const revision of [upstream, ...intervening]) {
      const board = blob(revision, 'plan/status.yaml')
      const status = new RegExp(`^ {2}epic-${epic}: ([\\w-]+)`, 'mu').exec(board === null ? '' : text(board))?.[1]
      if (!active(status) || !unique(revision, file) || !equivalentAllowance(file, original, blob(revision, file)) ||
          authorityText(revision, epic) !== approval || incomingGo(revision) !== originalGo) return false
    }
    return true
  }
  const prove = (file, anchor) => {
    if (shallow || git('rev-parse', 'HEAD') !== checkpoint || !ancestor(anchor.checkpoint, checkpoint) || !ancestor(anchor.upstream, upstream)) return null
    const before = snapshot(anchor.checkpoint, file), current = snapshot(checkpoint, file)
    if (!before || !current || before.go !== current.go || before.chain.some((id, index) => current.chain[index] !== id) ||
        !blob(checkpoint, file).equals(readFileSync(join(repo, file))) ||
        !equivalentAllowance(file, blob(anchor.checkpoint, file), blob(anchor.upstream, file)) || !incomingStable(file, anchor)) return null
    return blob(anchor.checkpoint, file)
  }
  if (!validReconciliations(state.allowanceBaselines)) throw new PlanError('INVALID_RECONCILIATION', 'allowance reconciliation cache is malformed; no hold can be cleared')
  const anchors = { ...(state.allowanceBaselines?.files ?? {}) }, bases = new Map(), holds = new Set(), migrated = new Set()
  if (migration !== null) {
    const bytes = readFileSync(migration.receiptPath)
    if (sha(bytes) !== migration.receiptSha256 || !Array.isArray(migration.files) || !migration.files.length) throw new PlanError('INVALID_RECONCILIATION', 'the named reconciliation receipt or pinned hash changed')
    const receipt = JSON.parse(text(bytes))
    const required = ['authority unchanged', 'budgets unchanged', 'planFiles unchanged', 'authorityHistory unchanged', 'no external publication path reached']
    if (receipt.verdict !== 'PASS' || !Array.isArray(receipt.checks) || !required.every(name => receipt.checks.some(check => check.name === name && check.result === 'PASS')) || receipt.checks.some(check => check.result !== 'PASS')) throw new PlanError('INVALID_RECONCILIATION', 'the named receipt does not prove a completed authority-preserving reconciliation')
    for (const { file, checkpoint: prior, upstream: incoming } of migration.files) {
      if (!commitId(prior) || !commitId(incoming)) throw new PlanError('INVALID_RECONCILIATION', 'the named reconciliation anchor is not a commit ID')
      const anchor = { checkpoint: prior, upstream: incoming }, historical = snapshot(prior, file), epic = epicOf(file)
      const authority = receipt.after?.authority?.[epic], reader = receipt.ordinaryReaders?.[`epic${epic}`]
      const token = historical && sha(`${historical.go}\n${sha(historical.text.replace(/\r\n?/gu, '\n'))}`).slice(0, 16)
      if (!Number.isInteger(epic) || !historical || receipt.after?.head !== prior || authority?.go !== historical.go ||
          typeof authority?.fingerprint !== 'string' || receipt.before?.authority?.[epic]?.fingerprint !== authority.fingerprint || authority.token !== token || reader?.state !== 'recorded' || reader?.hand_edit !== null || reader?.token !== token ||
          receipt.after?.planFiles?.[file] !== sha(blob(prior, file)) || receipt.before?.planFiles?.[file] !== receipt.after.planFiles[file] || !prove(file, anchor)) throw new PlanError('INVALID_RECONCILIATION', 'the receipt cannot prove this allowance baseline; approvals and holds are preserved')
      anchors[file] = anchor
      migrated.add(file)
    }
  }
  for (const [file, anchor] of Object.entries(anchors)) {
    let base = null
    try { base = prove(file, anchor) } catch { /* An unreadable historical fact never excuses a hold. */ }
    if (base === null) holds.add(epicOf(file))
    else bases.set(file, base)
  }
  return {
    bases, holds,
    admit(conflicts, candidates) {
      for (const file of migrated) if (conflicts.includes(epicOf(file))) delete anchors[file]
      const rejected = []
      for (const file of candidates) {
        if (conflicts.includes(epicOf(file)) || holds.has(epicOf(file))) continue
        let proven = null
        const candidate = { checkpoint, upstream }
        try { proven = prove(file, candidate) } catch { /* An unprovable reconciliation is rejected below. */ }
        // A reconciliation that cannot be remembered keeps its hold now rather than relapsing at the next amendment.
        if (proven) anchors[file] = candidate
        else rejected.push(epicOf(file))
      }
      if (Object.keys(anchors).length) state.allowanceBaselines = { version: 1, files: anchors }
      return [...new Set(rejected)]
    }
  }
}
