// MODULE: doctor-leftovers.mjs - Measured read-only leftover predicates, isolated in bwrap and projected before output
// Adapted from Story 81.1 ac3_scan.mjs; no cleanup, no raw inventory leaves this function.
import { writeFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, accessSync, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, isAbsolute, basename, dirname } from 'node:path'

import { projectLeftovers } from './doctor-leftover-results.mjs'
import { selectedProfile } from './doctor-profile.mjs'
import { bindLocation, locationRoots, observeDatabases, observeFile, observeTree, resolveLocation, unresolvedLocation } from './doctor-locations.mjs'
import { readJsonEntries, readJsonItems, readTomlEntries } from './agents-tool-files.mjs'

export const leftoversModule = import.meta.url

export async function inspectLeftovers(currentVersions = {}) {
const { SKILL_APPS, rootPath, skillsTests } = await import('./agents-skills.mjs')
const { TOOL_APPS, neutralOf } = await import('./agents-tools.mjs')
const env = process.env
const profile = selectedProfile(env)
const H = profile.home
const roots = locationRoots(profile)
const observed = new Map()
const databaseAbsences = []
const locateTree = (path) => { try { return observeTree(path, roots) } catch { errors.push('unstable-tree'); return null } }
const tilde = (path) => (path.startsWith(`${H}/`) ? `~/${path.slice(H.length + 1)}` : path === H ? '~' : path)
const sha = (text) => createHash('sha256').update(text).digest('hex')
const errors = []
if (profile.invalid || profile.unavailable) return projectLeftovers({ errors: ['unavailable-profile'] })
if (profile.inline) errors.push('uninspected-inline-scope')
const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code)
const readObservation = (path) => {
  if (!observed.has(path)) {
    if (observed.size >= 256) { errors.push('observation-bound-exhausted'); return { path, text: null, missing: false, locator: unresolvedLocation() } }
    try { observed.set(path, observeFile(path, roots)) }
    catch (error) { if (!absent(error)) errors.push('unreadable-or-unstable-file'); observed.set(path, { path, missing: absent(error), locator: unresolvedLocation(), text: null }) }
  }
  return observed.get(path)
}
const tryRead = (path) => readObservation(path).text
const tryJson = (path) => {
  const text = tryRead(path)
  if (text === null) return { missing: true }
  try {
    const data = JSON.parse(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid shape')
    return { data }
  } catch { errors.push('malformed-configuration'); return { unreadable: true } }
}
const isDir = (path) => {
  try { return statSync(path).isDirectory() } catch (error) { if (!absent(error)) errors.push('unreadable-directory'); return false }
}
const real = (path) => {
  try { return realpathSync(path) } catch (error) { if (!absent(error)) errors.push('unreadable-path'); return null }
}

// A text holds a credential shape: a known key prefix, a bearer value, or a key=value form. Only a boolean leaves.
// (BMN's looksSecret, word by word, flags 187 of 254 memory files on this machine, long hyphenated slugs among them:
// right for an MCP argument, too broad for prose.)
const SHAPES = [/\b(?:sk|pk|ghp|gho|ghu|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/, /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /(?:api[_-]?key|token|secret|passw(?:or)?d|credential)s?["']?\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i]
const holdsSecret = (text) => SHAPES.some((shape) => shape.test(text))

// ---------------------------------------------------------------------------------------------
// Programs on PATH, as the owner's shells see them

const PATH_DIRS = (env.PATH ?? '').split(':').filter(Boolean)
const executable = (path) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false } }
const onPath = (command) => PATH_DIRS.some((directory) => executable(join(directory, command)))
const RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpm', 'pnpx', 'yarn', 'docker', 'podman', 'uv', 'pipx', 'deno'])
function programClass(command, args = []) {
  if (typeof command !== 'string' || command === '') return 'no-program'
  const present = isAbsolute(command) ? executable(command) : command.includes('/') ? null : onPath(command)
  if (present === null) return 'relative-path'
  if (!present) return 'missing'
  if (RUNNERS.has(basename(command))) return 'runner-present-package-unresolved'
  const scripts = args.filter((arg) => typeof arg === 'string' && isAbsolute(arg) && /\.(?:m?js|cjs|ts|py|sh|rb)$/.test(arg))
  if (scripts.some((arg) => !existsSync(arg))) return 'present-script-missing'
  return 'present'
}

// ---------------------------------------------------------------------------------------------
// Where a Claude Code project folder's name came from: every character but letters and digits became '-'

function resolveSlug(slug) {
  if (slug.startsWith('-tmp-') || slug.startsWith('-var-tmp-')) return { state: 'ambiguous' }
  let uncertain = false
  const found = []
  const walk = (directory, rest, depth) => {
    if (found.length > 3 || depth > 14) { uncertain = true; return }
    let names
    try { names = readdirSync(directory, { withFileTypes: true }) } catch { uncertain = true; return }
    for (const entry of names) {
      const full = join(directory, entry.name)
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDir(full))) continue
      const encoded = `/${entry.name}`.replace(/[^a-zA-Z0-9]/g, '-')
      if (rest === encoded) found.push(full)
      else if (rest.startsWith(encoded) && rest[encoded.length] === '-') walk(full, rest.slice(encoded.length), depth + 1)
    }
  }
  walk('/', slug, 0)
  return uncertain ? { state: 'ambiguous' } : found.length === 0 ? { state: 'missing' } : found.length === 1 ? { state: 'exists', path: found[0] } : { state: 'ambiguous', paths: found }
}

// ---------------------------------------------------------------------------------------------
// Rules files and BMN's own records: what depends on a skill, what BMN made

const RULE_FILES = [`${profile.claude}/CLAUDE.md`, `${profile.codex}/AGENTS.md`, `${profile.opencode}/AGENTS.md`, `${H}/.config/bmn/agents/global-rules.md`]
const ruleTexts = RULE_FILES.map(tryRead).filter((text) => text !== null)
const skillsWritten = tryJson(`${H}/.config/bmn/agents/state/rules/skills-written.json`).data ?? {}
const toolsWritten = tryJson(`${H}/.config/bmn/agents/state/rules/tools-written.json`).data ?? {}
const ownRecord = tryJson(`${H}/.config/bmn/agents/state/own-skills.json`).data ?? {}
const BMN_SHIPPED = ['plan', 'team-ask', 'team-page', 'web-question', 'jev-judge']
const PROTECTED_SKILLS = new Set([...BMN_SHIPPED, 'dev-auto', ...Object.keys(ownRecord.skills ?? {})])
const APP_MANAGED_SKILL_NAMES = new Set(['.system', 'synced'])
let approvedTeam = null
try {
  const { approvedIfAny } = await import('./agents-state.mjs')
  approvedTeam = approvedIfAny()?.data ?? null
} catch (error) {
  errors.push(`approved team unreadable (${error.code ?? error.name})`)
}
const teamToolIds = new Set((approvedTeam?.tools ?? []).map((tool) => tool.id))
const versions = {}
for (const line of [...skillsTests()].reverse()) if (line.kind === 'capability' && versions[line.harness] === undefined) versions[line.harness] = { version: line.version, outcome: line.outcome, roots: (line.roots ?? []).filter((r) => r.folder || r.link).map((r) => r.root) }

// =============================================================================================
// 1. Memory

function claudeMemory() {
  const projects = `${profile.claude}/projects`
  const rows = []
  let folders = 0
  for (const slug of (isDir(projects) ? readdirSync(projects).sort() : [])) {
    const folder = join(projects, slug)
    if (!isDir(folder)) continue
    folders += 1
    const memory = join(folder, 'memory')
    if (!isDir(memory)) continue
    const snapshot = locateTree(memory)
    if (snapshot === null) { rows.push({ locator: unresolvedLocation(), project: 'ambiguous' }); continue }
    const names = snapshot.directories.get('') ?? []
    const files = names.filter((name) => name.endsWith('.md'))
    const others = names.length - files.length
    const index = snapshot.files.get('MEMORY.md')?.toString('utf8') ?? null
    const links = index === null ? [] : [...index.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((match) => match[1])
    const linked = new Set(links.map((link) => basename(link)))
    const orphans = files.filter((name) => name !== 'MEMORY.md' && !linked.has(name)).length
    const dangling = links.filter((link) => !existsSync(resolve(memory, link))).length
    const secretFiles = files.filter((name) => { const text = snapshot.files.get(name)?.toString('utf8'); return text === undefined ? true : holdsSecret(text) }).length
    const transcripts = readdirSync(folder).filter((name) => name.endsWith('.jsonl')).length
    const project = resolveSlug(slug)
    const hash = snapshot.hash
    rows.push({ locator: bindLocation(snapshot, roots), folder: tilde(memory), project: project.state, project_path: project.path ? tilde(project.path) : project.paths?.map(tilde),
      worktree: /--claude-worktrees-|--codex-worktrees-|-worktrees-/.test(slug), files: files.length, other_entries: others,
      index: index !== null, orphans, dangling_links: dangling, files_with_secret_shape: secretFiles, transcripts_beside: transcripts, tree_hash: hash })
  }
  const by = (predicate) => rows.filter(predicate)
  return {
    project_folders: folders, memory_folders: rows.length, memory_files: rows.reduce((sum, row) => sum + row.files, 0),
    by_project: { exists: by((r) => r.project === 'exists').length, missing: by((r) => r.project === 'missing').length, ambiguous: by((r) => r.project === 'ambiguous').length },
    files_in_missing_projects: by((r) => r.project === 'missing').reduce((sum, row) => sum + row.files, 0),
    missing_and_secret_free: by((r) => r.project === 'missing' && r.files_with_secret_shape === 0).length,
    orphan_files: rows.reduce((sum, row) => sum + row.orphans, 0), dangling_index_links: rows.reduce((sum, row) => sum + row.dangling_links, 0),
    files_with_secret_shape: rows.reduce((sum, row) => sum + row.files_with_secret_shape, 0),
    rows
  }
}

async function codexMemory() {
  const path = join(profile.codex, 'memories_1.sqlite')
  if (!existsSync(path)) { databaseAbsences.push(path); return { items: [] } }
  const { DatabaseSync } = await import('node:sqlite')
  const [memorySource, stateSource] = observeDatabases([path, join(profile.codex, 'state_5.sqlite')], roots)
  if (memorySource === null) throw new Error('memory observation unavailable')
  if (stateSource === null) errors.push('unknown-memory-project-coverage')
  const scratch = mkdtempSync('/tmp/bmn-doctor-memory-')
  const opened = []
  const copy = (source, name) => {
    if (source === null) return null
    writeFileSync(join(scratch, name), source.bytes)
    if (source.walBytes !== null) writeFileSync(join(scratch, `${name}-wal`), source.walBytes)
    const db = new DatabaseSync(join(scratch, name), { readOnly: true })
    opened.push(db)
    if (db.prepare('pragma integrity_check').all().some((row) => Object.values(row)[0] !== 'ok')) throw new Error('unverified database copy')
    return db
  }
  try {
    const memories = copy(memorySource, 'memories_1.sqlite')
    const schema = memories.prepare("select sql from sqlite_master where type='table' and name='stage1_outputs'").get()?.sql
    const columns = memories.prepare('pragma table_info(stage1_outputs)').all().map((row) => row.name.toLowerCase())
    if (typeof schema !== 'string' || /WITHOUT\s+ROWID/i.test(schema) || columns.some((name) => ['rowid', '_rowid_', 'oid'].includes(name))) throw new Error('unsupported memory schema')
    const ids = memories.prepare('select rowid as bmn_rowid, thread_id, usage_count, selected_for_phase2 from stage1_outputs limit 10001').all()
    if (ids.length > 10000) throw new Error('memory observation too large')
    const state = copy(stateSource, 'state_5.sqlite')
    const projects = new Map(state ? state.prepare('select id, cwd from threads').all().map((row) => [row.id, row.cwd]) : [])
    const items = []
    for (const row of ids) {
      const project = projects.get(row.thread_id)
      if (typeof project === 'string' && isDir(project)) continue
      items.push({ locator: bindLocation(memorySource, roots, { rowid: row.bmn_rowid }) })
    }
    return { items }
  } finally {
    for (const db of opened) db.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

// =============================================================================================
// 2. Skills

const ROOTS = new Map()
for (const [app, spec] of Object.entries(SKILL_APPS)) for (const root of spec.roots) {
  const path = root.startsWith('.config/opencode/') ? join(profile.opencode, root.slice('.config/opencode/'.length)) : rootPath(root, env)
  let canonical = path
  try { const info = statSync(path); canonical = `${info.dev}:${info.ino}` } catch { /* Missing roots remain distinct. */ }
  const entry = ROOTS.get(canonical) ?? { root, path, apps: [], verified: [] }
  if (!entry.apps.includes(app)) entry.apps.push(app)
  if (versions[app]?.version === currentVersions[app] && versions[app]?.outcome === 'pass' && versions[app]?.roots.includes(root)) entry.verified.push(app)
  ROOTS.set(canonical, entry)
}

function skillsInventory() {
  const items = []
  for (const root of ROOTS.values()) {
    let names
    try { names = readdirSync(root.path).sort() } catch (error) {
      if (!absent(error)) errors.push('unreadable-skill-root')
      items.push({ root: tilde(root.path), state: absent(error) ? 'root-missing' : 'root-unreadable' })
      continue
    }
    for (const name of names) {
      const path = join(root.path, name)
      const snapshot = locateTree(path)
      if (snapshot === null) { items.push({ name, root: tilde(root.path), seen_by: root.apps, locator: unresolvedLocation(), verdict: 'show-only: content unreadable' }); continue }
      const link = snapshot.link
      const body = snapshot.missingTarget ? null : snapshot.body
      const item = { observation: snapshot, locator: bindLocation(snapshot, roots), name, root: tilde(root.path), seen_by: root.apps, verified_by: root.verified, kind: snapshot.kind }
      if (link !== null) item.link_target = tilde(link)
      if (body === null) { item.state = 'broken-link'; items.push(item); continue }
      item.body = tilde(body)
      item.has_skill_md = snapshot.files.has('SKILL.md')
      if (item.has_skill_md) {
        item.tree_hash = snapshot.hash
        item.skill_text = snapshot.files.get('SKILL.md').toString('utf8')
        item.skill_md_sha256 = sha(item.skill_text)
      } else if (snapshot.directories.get('')?.includes('SKILL.md')) errors.push('unverifiable-skill-body')
      items.push(item)
    }
  }
  const skills = items.filter((item) => item.name !== undefined)
  // What depends on a skill: rules files and other skills that name it (a short name may over-count; that only keeps more).
  const skillTexts = skills.filter((item) => item.has_skill_md).map((item) => ({ key: `${item.root}/${item.name}`, text: item.skill_text }))
  for (const item of skills) {
    const word = new RegExp(`(^|[^A-Za-z0-9_-])${item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`)
    item.named_in_rules = ruleTexts.filter((text) => word.test(text)).length
    item.named_in_other_skills = skillTexts.filter((entry) => entry.key !== `${item.root}/${item.name}` && word.test(entry.text)).length
    item.bmn_written = Object.keys(skillsWritten).some((path) => tilde(path) === `${item.root}/${item.name}`)
    item.protected = PROTECTED_SKILLS.has(item.name) || item.bmn_written || (item.body ?? '').includes('/.config/bmn/') || APP_MANAGED_SKILL_NAMES.has(item.name)
  }
  // Per app: which items it discovers, by name; the same body (one realpath, or one tree hash) is one skill seen twice.
  const perApp = {}
  for (const app of Object.keys(SKILL_APPS)) {
    const byName = new Map()
    const basis = versions[app]?.version === currentVersions[app] && versions[app]?.outcome === 'pass' ? 'verified' : 'declared'
    const sees = (item) => (basis === 'verified' ? item.verified_by : item.seen_by).includes(app)
    for (const item of skills) if (sees(item) && item.state !== 'broken-link' && item.has_skill_md) {
      byName.set(item.name, [...(byName.get(item.name) ?? []), item])
    }
    let same = 0
    let conflicts = 0
    for (const group of byName.values()) {
      if (group.length < 2) continue
      const bodies = new Set(group.map((item) => item.tree_hash ?? item.body))
      if (bodies.size === 1) same += 1
      else conflicts += 1
      for (const item of group) {
        item.duplicates = item.duplicates ?? {}
        item.duplicates[app] = bodies.size === 1 ? 'same-body-elsewhere' : 'different-body-same-name'
      }
    }
    perApp[app] = { basis, discovered: byName.size, entries: [...byName.values()].reduce((sum, group) => sum + group.length, 0), names_seen_twice_same_body: same, name_conflicts: conflicts }
  }
  // The predicate (predicates.md, skills): a candidate is a broken link, or an entry every app that sees it also sees
  // with the same body under the same name elsewhere; never protected, BMN-made, a link into BMN or an app's own.
  for (const item of skills) {
    if (item.protected) { item.verdict = 'protected'; continue }
    if (!item.observation) { item.verdict = 'show-only: content unreadable'; continue }
    if (item.state === 'broken-link') { item.verdict = 'candidate: broken link'; continue }
    if (!item.has_skill_md) { item.verdict = 'show-only: not a skill (no SKILL.md)'; continue }
    if (item.tree_hash === null || item.tree_hash === undefined) { item.verdict = 'show-only: content unreadable'; continue }
    const dup = item.duplicates ?? {}
    const apps = item.seen_by
    if (apps.length > 0 && apps.every((app) => dup[app] === 'same-body-elsewhere')) {
      // Keep one: the entry in the root more apps read stays; this one goes only if another same-body entry is seen by a superset.
      const others = skills.filter((other) => other !== item && other.name === item.name && other.tree_hash === item.tree_hash && other.state !== 'broken-link' && !(other.verdict ?? '').startsWith('candidate'))
      const covered = others.some((other) => apps.every((app) => other.seen_by.includes(app)))
      const verified = others.some((other) => apps.every((app) => other.verified_by.includes(app)))
      item.verdict = !covered ? 'keep: the copy other apps rely on' : verified ? 'candidate: same body seen elsewhere by every app that sees it' : 'show-only: twin seen elsewhere, discovery unverified for this version'
      continue
    }
    if (Object.values(dup).includes('different-body-same-name')) { item.verdict = 'show-only: same name, different content (precedence unverified)'; continue }
    item.verdict = 'keep: unique'
  }
  for (const item of skills) if (item.observation) {
    item.locator = bindLocation(item.observation, roots, { dependencies: skills.filter((other) => other !== item && other.name === item.name).map((other) => other.observation) })
  }
  const count = (prefix) => skills.filter((item) => (item.verdict ?? '').startsWith(prefix)).length
  return {
    roots: [...ROOTS.values()].map((root) => ({ root: tilde(root.path), read_by: root.apps, verified_by: root.verified, entries: skills.filter((item) => item.root === tilde(root.path)).length })),
    entries: skills.length, broken_links: skills.filter((item) => item.state === 'broken-link').length,
    links: skills.filter((item) => item.kind === 'link').length, not_a_skill: skills.filter((item) => item.state !== 'broken-link' && !item.has_skill_md).length,
    protected: count('protected'), candidates: count('candidate'), show_only: count('show-only'), keep: count('keep'),
    per_app: perApp, versions,
    items: skills.map(({ body, ...rest }) => ({ ...rest, body }))
  }
}

// =============================================================================================
// 3. Plugins (from configuration; none is started)

function jsonItems(path, at = []) {
  const source = readObservation(path)
  if (source.text === null) return []
  try { return readJsonItems(source.text, at).map((entry) => ({ ...entry, locator: bindLocation(source, roots, { start: entry.start }) })) }
  catch { errors.push('unreadable-configuration-positions'); return [] }
}

function cacheItems(cache, referenced) {
  const rows = []
  for (const market of isDir(cache) ? readdirSync(cache) : []) for (const plugin of isDir(join(cache, market)) ? readdirSync(join(cache, market)) : []) {
    for (const version of isDir(join(cache, market, plugin)) ? readdirSync(join(cache, market, plugin)) : []) {
      const path = join(cache, market, plugin, version)
      if (isDir(path) && !referenced(path, plugin, market)) rows.push({ class: 'app-managed', locator: bindLocation(locateTree(path), roots) })
    }
  }
  return rows
}

function claudePlugins() {
  const settings = join(profile.claude, 'settings.json')
  const registry = join(profile.claude, 'plugins/installed_plugins.json')
  const enabled = new Map(jsonItems(settings, ['enabledPlugins']).map((entry) => [entry.key, entry]))
  const plugins = jsonItems(registry, ['plugins'])
  const referenced = new Set()
  const rows = []
  for (const plugin of plugins) {
    const installs = Array.isArray(plugin.value) ? jsonItems(registry, ['plugins', plugin.key]) : []
    if (!Array.isArray(plugin.value)) errors.push('unreadable-plugin-installs')
    if (installs.length === 0) rows.push({ class: 'listed, not installed', locator: plugin.locator })
    for (const entry of installs) {
      const install = entry.value
      const path = typeof install?.installPath === 'string' ? install.installPath : null
      if (path) referenced.add(real(path) ?? path)
      rows.push({ locator: entry.locator, class: enabled.get(plugin.key)?.value === false ? 'disabled'
        : !path || !isDir(path) ? 'install folder missing' : typeof install.projectPath === 'string' && !isDir(install.projectPath)
          ? 'install folder missing' : 'enabled' })
    }
  }
  for (const [id, entry] of enabled) if (!plugins.some((plugin) => plugin.key === id)) rows.push({ locator: entry.locator,
    class: entry.value === false ? 'disabled' : 'listed, not installed' })
  rows.push(...cacheItems(join(profile.claude, 'plugins/cache'), (path) => referenced.has(real(path) ?? path)))
  return { rows }
}

function codexPlugins() {
  const path = join(profile.codex, 'config.toml')
  const source = readObservation(path)
  const text = source.text ?? ''
  const rows = []
  const listed = new Set()
  for (const [id, entry] of readTomlEntries(text, 'plugins')) {
    if (entry.unreadable) errors.push('unreadable-plugin-entry')
    listed.add(id)
    const cached = id.includes('@') && isDir(join(profile.codex, 'plugins/cache', id.slice(id.lastIndexOf('@') + 1), id.slice(0, id.lastIndexOf('@'))))
    rows.push({ locator: bindLocation(source, roots, { start: entry.start }), class: entry.value?.enabled === false ? 'disabled' : cached ? 'enabled' : 'failing: enabled, not in cache' })
  }
  rows.push(...cacheItems(join(profile.codex, 'plugins/cache'), (_path, plugin, market) => listed.has(`${plugin}@${market}`)))
  return { rows }
}

function openCodePlugins() {
  const rows = []
  for (const path of profile.opencodeFiles) for (const entry of jsonItems(path, ['plugin'])) {
    const spec = entry.value
    if (typeof spec !== 'string') { errors.push('unreadable-plugin-entry'); rows.push({ locator: entry.locator, class: 'unreadable' }); continue }
    const value = spec.startsWith('file:') ? spec.slice(5) : spec
    const local = value.startsWith('.') || value.startsWith('/') || value.startsWith('~')
    const full = local ? resolve(dirname(path), value.replace(/^~/, H)) : null
    if (local && !existsSync(full)) rows.push({ locator: entry.locator, class: 'failing: file missing' })
    else if (!local) rows.push({ locator: entry.locator, class: 'app-managed' })
  }
  for (const folder of ['plugin', 'plugins']) {
    const dir = join(profile.opencode, folder)
    for (const name of isDir(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name)
      const snapshot = locateTree(path)
      if (!snapshot || snapshot.missingTarget) rows.push({ locator: bindLocation(snapshot, roots), class: 'install folder missing' })
    }
  }
  for (const entry of jsonItems(join(profile.opencode, 'cli.json'), ['plugins'])) {
    if (typeof entry.value === 'string' && (entry.value.startsWith('.') || entry.value.startsWith('/')) && !existsSync(resolve(profile.opencode, entry.value))) {
      rows.push({ locator: entry.locator, class: 'failing: file missing' })
    }
  }
  return { rows }
}

// =============================================================================================
// 4. MCP entries (BMN's own readers; values never leave neutralOf)

function readTools(harness, { path = TOOL_APPS[harness].file(env), at = TOOL_APPS[harness].path } = {}) {
  const observation = readObservation(path)
  if (observation.text === null) return { path, readable: false, missing: observation.missing, entries: new Map() }
  try {
    const raw = harness === 'codex' ? readTomlEntries(observation.text) : readJsonEntries(observation.text, at)
    const entries = new Map()
    for (const [id, entry] of raw) {
      const neutral = entry.unreadable === undefined ? neutralOf(entry.value, harness) : null
      entries.set(id, neutral === null ? { unreadable: true } : { value: entry.value, ...neutral })
    }
    return { path, observation, readable: true, entries, text: observation.text }
  } catch { errors.push('unreadable-mcp-configuration'); return { path, readable: false, missing: false, entries: new Map() } }
}

function mcpRows(harness, file, scope, projectPath = null, at = TOOL_APPS[harness].path) {
  const rows = []
  if (!file.readable) {
    const missing = file.missing === true
    if (!missing) errors.push('unreadable-mcp-configuration')
    return [{ app: harness, scope, file: tilde(file.path), state: missing ? 'file-missing' : 'file-unreadable' }]
  }
  const positions = harness === 'codex' ? readTomlEntries(file.text) : new Map(readJsonItems(file.text, at).map((entry) => [entry.key, entry]))
  for (const [id, entry] of file.entries) {
    const row = { locator: bindLocation(file.observation, roots, { start: positions.get(id)?.start }), app: harness, id, scope, file: tilde(file.path), ...(projectPath ? { project: tilde(projectPath), project_exists: isDir(projectPath) } : {}) }
    if (entry.unreadable !== undefined) { errors.push('unreadable-mcp-entry'); rows.push({ ...row, state: 'unreadable' }); continue }
    const value = entry.value ?? {}
    const definition = entry.definition ?? {}
    row.transport = definition.url !== undefined ? 'remote' : 'stdio'
    row.program = definition.url !== undefined ? 'remote (no program)' : programClass(definition.command, (definition.args ?? []).filter((arg) => typeof arg === 'string'))
    row.secret_inline = (entry.secrets ?? []).length > 0
    row.disabled = value.enabled === false || value.disabled === true
    row.bmn_written = toolsWritten[`${harness}|${id}`] !== undefined
    row.in_team = teamToolIds.has(id)
    rows.push(row)
  }
  return rows
}

function mcpInventory() {
  const rows = []
  for (const harness of ['claude', 'codex']) rows.push(...mcpRows(harness, readTools(harness), 'user'))
  for (const path of profile.opencodeFiles) rows.push(...mcpRows('opencode', readTools('opencode', { path }), 'user'))
  // Claude Code's local scope: entries kept per project inside ~/.claude.json.
  const claudeJson = tryJson(`${profile.claudeJson}`).data ?? {}
  const projects = Object.keys(claudeJson.projects ?? {})
  let projectEntries = 0
  let projectsMissing = 0
  for (const path of projects) {
    if (!isDir(path)) projectsMissing += 1
    const servers = claudeJson.projects[path]?.mcpServers
    if (servers && typeof servers === 'object' && Object.keys(servers).length > 0) {
      projectEntries += Object.keys(servers).length
      rows.push(...mcpRows('claude', readTools('claude', { at: ['projects', path, 'mcpServers'] }), 'project (local)', path, ['projects', path, 'mcpServers']))
    }
  }
  // Plugin-provided entries (Claude): counted, with their program class, never started.
  const installed = tryJson(`${profile.claude}/plugins/installed_plugins.json`).data?.plugins ?? {}
  const pluginFiles = new Set()
  for (const [id, installs] of Object.entries(installed)) for (const install of Array.isArray(installs) ? installs : []) {
    const file = typeof install.installPath === 'string' ? join(install.installPath, '.mcp.json') : null
    if (file && existsSync(file) && !pluginFiles.has(file)) {
      pluginFiles.add(file)
      const read = readTools('claude', { path: file, at: ['mcpServers'] })
      const fallback = read.entries.size === 0 ? readTools('claude', { path: file, at: [] }) : read
      rows.push(...mcpRows('claude', fallback, `plugin ${id}`, null, fallback === read ? ['mcpServers'] : []).map((row) => ({ ...row, plugin: id })))
    }
  }
  for (const row of rows) {
    if (row.state) { row.verdict = 'show-only: unreadable'; continue }
    if (row.secret_inline) { row.verdict = 'show-only: secret inline'; continue }
    if (row.bmn_written || row.in_team) { row.verdict = 'protected: BMN tool'; continue }
    if (row.scope.startsWith('plugin')) { row.verdict = 'show-only: belongs to a plugin'; continue }
    if (row.program === 'missing' || row.program === 'no-program') { row.verdict = 'candidate: program missing'; continue }
    if (row.program === 'present-script-missing') { row.verdict = 'candidate: script missing'; continue }
    if (row.project_exists === false) { row.verdict = 'candidate: project gone'; continue }
    if (row.program === 'relative-path' || row.program.startsWith('runner')) { row.verdict = 'show-only: program resolved at start'; continue }
    row.verdict = 'keep'
  }
  const tally = (key) => Object.fromEntries([...new Set(rows.map((row) => row[key]).filter((v) => v !== undefined))].map((name) => [String(name), rows.filter((row) => row[key] === name).length]))
  return { entries: rows.filter((row) => row.id !== undefined).length, by_app: tally('app'), by_program: tally('program'), by_verdict: tally('verdict'),
    secret_inline: rows.filter((row) => row.secret_inline).length, disabled: rows.filter((row) => row.disabled).length,
    claude_projects_in_config: projects.length, claude_projects_missing: projectsMissing, claude_project_scope_entries: projectEntries, rows }
}

// =============================================================================================

const report = { generated_at: new Date().toISOString(), home: '~', path_dirs: PATH_DIRS.length, versions_from_bmn_tests: versions, errors }
// A failed step reports its error's code or name, never its message: a parser's message can quote the text.
const step = async (name, run) => { try { report[name] = await run() } catch (error) { report[name] = { error: `${error.code ?? error.name}` } } }
await step('memory_claude', claudeMemory)
await step('memory_codex', codexMemory)
report.memory_opencode = { store: 'none', note: 'OpenCode 2.0.29 keeps no memory: no memory table in opencode.db, no memory folder' }
await step('skills', skillsInventory)
await step('plugins_claude', claudePlugins)
await step('plugins_codex', codexPlugins)
await step('plugins_opencode', openCodePlugins)
await step('mcp', mcpInventory)
// Publication uses only the original observations; a later read can never repair their provenance.
const dependencies = [...observed.values()].filter((item) => item.text !== null)
let coverageStable = true
for (const source of observed.values()) {
  if (source.missing ? existsSync(source.path) : source.text !== null && resolveLocation(source.locator, roots) === null) coverageStable = false
}
if (databaseAbsences.some((path) => existsSync(path))) coverageStable = false
if (!coverageStable) errors.push('observation-changed-before-publication')
for (const section of Object.values(report)) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) continue
  for (const row of [...(section.rows ?? []), ...(section.items ?? [])]) {
    if (!row.locator) continue
    row.locator = coverageStable ? bindLocation({ locator: row.locator }, roots, { dependencies }) : unresolvedLocation()
  }
}
return projectLeftovers(report)
}
