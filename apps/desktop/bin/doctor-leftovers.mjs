// MODULE: doctor-leftovers.mjs - One bounded scanner for acquisition and private item/reason reconstruction
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { readJsonItems, readOpenCodeEntries, readTomlEntries } from './agents-tool-files.mjs'
import { selectedProfile } from './doctor-profile.mjs'
import { createInspectionSession, inspectionResult } from './doctor-inspection.mjs'
import { matchContinuity, privateTag } from './doctor-continuity.mjs'
import { projectedResult } from './doctor-results.mjs'

export const leftoversModule = import.meta.url
const malformed = Object.freeze({ code: 'MALFORMED' })
const RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpm', 'pnpx', 'yarn', 'docker', 'podman', 'uv', 'pipx', 'deno'])
const BMN_SKILLS = new Set(['plan', 'team-ask', 'report-artifact', 'team-page', 'web-question', 'jev-judge', 'manual-qa', 'dev-auto', '.system', 'synced'])

async function scanOnce(versions, keys, deadline) {
  const { SKILL_APPS, rootPath } = await import('./agents-skills.mjs')
  const { TOOL_APPS, neutralOf } = await import('./agents-tools.mjs')
  const env = process.env, profile = selectedProfile(env), H = profile.home
  const s = createInspectionSession(profile, keys, deadline)
  if (profile.invalid || profile.unavailable) { s.gap('profile', 'step', { code: 'UNSUPPORTED' }); return s.finish() }
  if (profile.inline) s.gap('inline-config', 'step', { code: 'UNSUPPORTED' })
  const file = (path) => s.file(path)
  const json = (path) => { const source = file(path); return { source, data: s.json(source) } }
  const entries = (source, at = [], toml = false, strict = false) => {
    if (!source.known || s.text(source) === null) return []
    try { return toml ? [...readTomlEntries(s.text(source), at, { strict })].map(([key, entry]) => ({ ...entry, key })) :
      at === null ? [...readOpenCodeEntries(s.text(source), { strict })].map(([key, entry]) => ({ ...entry, key })) : readJsonItems(s.text(source), at, { strict }) }
    catch { s.gap(source.key, 'file', malformed); source.known = false; return [] }
  }
  const exists = (path) => { const source = s.meta(path); return { source, value: s.exists(source) } }
  const dir = (path) => { const source = s.meta(path); return { source, value: s.dir(source) } }
  const use = (result, projection = result.value) => s.dep(result.source, projection)
  const canonical = (path) => { const source = s.meta(path); return { source, value: source.known && s.exists(source) ? source.value.route.nodes.at(-1).path : null } }
  const writtenSkills = json(join(profile.bmn, 'state/rules/skills-written.json'))
  const ownSkills = json(join(profile.bmn, 'state/own-skills.json'))
  const writtenTools = json(join(profile.bmn, 'state/rules/tools-written.json'))

  function slugProject(slug) {
    if (slug.startsWith('-tmp-') || slug.startsWith('-var-tmp-')) return { state: 'ambiguous', deps: [] }
    const deps = [], found = []; let uncertain = false, visited = 0
    const walk = (path, rest, depth) => {
      if (++visited > 512 || depth > 14 || found.length > 3) { uncertain = true; s.gap('slug-frontier', 'step', { code: 'BOUND_EXCEEDED' }); return }
      const source = s.directory(path), relevant = []
      if (!source.known) { uncertain = true; deps.push(s.dep(source, null)); return }
      for (const name of s.names(source)) {
        const encoded = `/${name}`.replace(/[^a-zA-Z0-9]/g, '-')
        if (rest !== encoded && !(rest.startsWith(encoded) && rest[encoded.length] === '-')) continue
        const target = dir(join(path, name)); relevant.push([name, target.value, s.tuple(target.source)])
        deps.push(use(target))
        if (!target.source.known) uncertain = true
        if (!target.value) continue
        if (rest === encoded) found.push(join(path, name))
        else walk(join(path, name), rest.slice(encoded.length), depth + 1)
      }
      deps.push(s.dep(source, relevant))
    }
    walk('/', slug, 0)
    return { state: uncertain || found.length > 1 ? 'ambiguous' : found.length ? 'exists' : 'missing', deps }
  }

  function claudeMemory() {
    const projects = join(profile.claude, 'projects'), discovery = s.directory(projects)
    for (const slug of s.names(discovery)) {
      const folder = join(projects, slug), memory = join(folder, 'memory'), present = dir(memory)
      if (!present.source.known || !present.value) continue
      if (/--claude-worktrees-|--codex-worktrees-|-worktrees-/.test(slug)) continue
      const tree = s.tree(memory), project = slugProject(slug)
      if (project.state === 'exists') continue
      s.row('memory', 'claude', project.state === 'missing' ? 'missing-project' : 'ambiguous-project', tree, [slug],
        [s.dep(discovery, slug), use(present), ...project.deps])
    }
  }

  async function codexMemory() {
    const paths = ['memories_1.sqlite', 'state_5.sqlite'].map((name) => join(profile.codex, name))
    const present = paths.map(exists)
    if (!present[0].source.known || !present[0].value) return
    const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((line) => line.split(' - '))
    if (process.cwd() !== '/tmp/bmn-doctor-work' || !mounts.some(([left, right]) => left.split(' ')[4] === '/tmp' && right?.startsWith('tmpfs ')) ||
      !mounts.some(([left]) => left.split(' ')[4] === '/' && left.split(' ')[5].split(',').includes('ro'))) throw Object.assign(new Error(), { code: 'UNSUPPORTED' })
    const source = s.databases(paths)
    if (!source.known) return
    const { DatabaseSync } = await import('node:sqlite')
    // No host destination: these copies exist only in bwrap's already-private /tmp mount.
    const scratch = mkdtempSync('/tmp/bmn-doctor-work/read-'), opened = []
    const copy = (observed, name) => {
      if (observed === null) return null
      writeFileSync(join(scratch, name), observed.bytes, { mode: 0o600 })
      if (observed.walBytes !== null) writeFileSync(join(scratch, `${name}-wal`), observed.walBytes, { mode: 0o600 })
      const db = new DatabaseSync(join(scratch, name), { readOnly: true }); opened.push(db)
      if (db.prepare('pragma integrity_check').all().some((row) => Object.values(row)[0] !== 'ok')) throw malformed
      return db
    }
    try {
      const memory = copy(source.value[0], 'memories_1.sqlite'), state = copy(source.value[1], 'state_5.sqlite')
      const schema = memory.prepare("select sql from sqlite_master where type='table' and name='stage1_outputs'").get()?.sql
      const columns = memory.prepare('pragma table_xinfo(stage1_outputs)').all()
      if (typeof schema !== 'string' || /WITHOUT\s+ROWID/i.test(schema) || columns.some((v) => ['rowid', '_rowid_', 'oid', 'bmn_rowid'].includes(v.name.toLowerCase()))) throw malformed
      const query = memory.prepare('select rowid as bmn_rowid, * from stage1_outputs limit 10001'); query.setReadBigInts(true)
      const rows = query.all()
      if (rows.length > 10000) throw Object.assign(new Error(), { code: 'BOUND_EXCEEDED' })
      const stateSchema = state?.prepare("select sql from sqlite_master where type='table' and name='threads'").get()?.sql ?? null
      const stateColumns = state?.prepare('pragma table_info(threads)').all() ?? []
      for (const row of rows) {
        s.guard()
        if (row.bmn_rowid < 1n || row.bmn_rowid > 1000000000n || typeof row.thread_id !== 'string') { s.gap(source.key, 'database', malformed); continue }
        const relations = state ? state.prepare('select id, cwd from threads where id = ? limit 3').all(row.thread_id) : []
        if (relations.length > 1) { s.gap(source.key, 'database', malformed); continue }
        const cwd = relations[0]?.cwd, project = typeof cwd === 'string' && isAbsolute(cwd) ? dir(cwd) : null
        if (project?.value) continue
        if (relations.length && typeof cwd !== 'string') { s.gap(source.key, 'database', malformed); continue }
        const deps = [s.dep(source, [schema, columns, stateSchema, stateColumns, relations]), ...present.map((p) => use(p))]
        if (project) deps.push(use(project))
        s.row('memory', 'codex', 'unused-memory', source, [Number(row.bmn_rowid), row], deps, { rowid: Number(row.bmn_rowid) })
      }
    } catch (error) { s.gap(source.key, 'database', error); source.known = false }
    finally { for (const db of opened) db.close(); rmSync(scratch, { recursive: true, force: true }) }
  }

  function skills() {
    const capability = file(join(profile.bmn, 'state/skills-tests.jsonl')), latest = {}
    for (const line of (s.text(capability) ?? '').split('\n').filter(Boolean)) {
      try {
        const value = JSON.parse(line)
        if (!value || typeof value !== 'object' || typeof value.harness !== 'string') throw malformed
        if (value.kind === 'capability') latest[value.harness] = value
      } catch { s.gap(capability.key, 'file', malformed); capability.known = false }
    }
    const roots = new Map(), rootEvidence = []
    for (const [app, spec] of Object.entries(SKILL_APPS)) for (const root of spec.roots) {
      const path = root.startsWith('.config/opencode/') ? join(profile.opencode, root.slice('.config/opencode/'.length)) : rootPath(root, env)
      const probe = dir(path); rootEvidence.push(use(probe))
      const target = probe.source.value?.route.nodes.at(-1)?.object
      const key = probe.value ? `${target.device}:${target.inode}` : path
      const entry = roots.get(key) ?? { root, path, apps: [], verified: [], discovery: s.directory(path) }
      if (!entry.apps.includes(app)) entry.apps.push(app)
      const test = latest[app]
      if (test && test.version === versions[app] && test.outcome === 'pass' && (test.roots ?? []).some((r) => r.root === root && (r.folder || r.link))) entry.verified.push(app)
      roots.set(key, entry)
    }
    const items = []
    for (const root of roots.values()) for (const name of s.names(root.discovery)) {
      const path = join(root.path, name), source = s.tree(path), value = source.value
      const protectedItem = BMN_SKILLS.has(name) || Object.hasOwn(ownSkills.data?.skills ?? {}, name) || Object.hasOwn(writtenSkills.data ?? {}, path) || (value?.body ?? '').includes('/.config/bmn/')
      const body = value?.files.get('SKILL.md')
      if (!body && value?.directories.get('')?.includes('SKILL.md')) s.gap(join(path, 'SKILL.md'), 'file', malformed)
      items.push({ name, root, source, protectedItem, body, hash: body ? value.hash : null, broken: Boolean(value?.missingTarget), verdict: null })
    }
    for (const item of items) {
      const { name, root, source } = item
      const group = items.filter((other) => other.name === name), deps = [
        ...rootEvidence, s.dep(capability, root.apps.map((app) => [app, versions[app] ?? null, latest[app] ?
          [latest[app].version ?? null, latest[app].outcome ?? null, latest[app].roots ?? []] : null])), s.dep(ownSkills.source, ownSkills.data ? Object.hasOwn(ownSkills.data.skills ?? {}, name) : undefined),
        s.dep(writtenSkills.source, writtenSkills.data ? Object.hasOwn(writtenSkills.data, join(root.path, name)) : undefined),
        ...[...roots.values()].map((r) => s.dep(r.discovery, [r.root, r.apps, r.verified, s.names(r.discovery).includes(name)])),
        ...group.map((g) => s.dep(g.source, [g.name, g.root.root, g.root.apps, g.root.verified, g.hash, g.broken, g.protectedItem, g.verdict]))]
      if (item.protectedItem) { item.verdict = 'protected'; continue }
      let reason = null
      if (!source.known) reason = 'unreadable'
      else if (item.broken) reason = 'broken-link'
      else if (!item.body) continue
      else {
        const duplicate = Object.fromEntries(root.apps.map((app) => {
          const verified = latest[app]?.version === versions[app] && latest[app]?.outcome === 'pass'
          const members = group.filter((g) => (verified ? g.root.verified : g.root.apps).includes(app) && !g.broken && g.body)
          return [app, members.length < 2 ? null : new Set(members.map((g) => g.hash)).size === 1 ? 'same' : 'different']
        }))
        if (root.apps.length && root.apps.every((app) => duplicate[app] === 'same')) {
          const others = group.filter((g) => g !== item && g.hash === item.hash && !g.broken && g.verdict !== 'candidate')
          const covered = others.some((g) => root.apps.every((app) => g.root.apps.includes(app)))
          const verified = others.some((g) => root.apps.every((app) => g.root.verified.includes(app)))
          if (covered) { reason = verified ? 'duplicate' : 'unverified'; item.verdict = verified ? 'candidate' : 'unverified' }
        } else if (Object.values(duplicate).includes('different')) reason = 'conflict'
      }
      if (reason) s.row('skills', null, reason, source, [name, root.root], deps)
    }
  }

  function caches(app, root, referenced, dependencies) {
    const markets = s.directory(root)
    for (const market of s.names(markets)) {
      if (!dir(join(root, market)).value) continue
      const plugins = s.directory(join(root, market))
      for (const plugin of s.names(plugins)) {
        if (!dir(join(root, market, plugin)).value) continue
        const versions = s.directory(join(root, market, plugin))
        for (const version of s.names(versions)) {
          const path = join(root, market, plugin, version), target = dir(path)
          if (!target.value) continue
          const reference = referenced(path, plugin, market)
          if (reference.value) continue
          const source = s.tree(path, { locationOnly: true })
          s.row('plugins', app, 'app-managed', source, [market, plugin, version], [...dependencies,
            s.dep(markets, market), s.dep(plugins, plugin), s.dep(versions, version), use(target), ...reference.deps])
        }
      }
    }
  }

  function pluginsClaude() {
    const settings = file(join(profile.claude, 'settings.json')), registry = file(join(profile.claude, 'plugins/installed_plugins.json'))
    const enabled = new Map(entries(settings, ['enabledPlugins']).map((entry) => [entry.key, entry]))
    const plugins = entries(registry, ['plugins']), referenced = new Set(), referenceDeps = []
    for (const plugin of plugins) {
      const installs = Array.isArray(plugin.value) ? entries(registry, ['plugins', plugin.key]) : []
      if (!Array.isArray(plugin.value)) { s.gap(registry.key, 'file', malformed); registry.known = false }
      if (!installs.length) s.row('plugins', 'claude', 'plugin-missing', registry, [plugin.key, plugin.value], [s.dep(settings, enabled.get(plugin.key)?.value ?? null)], { start: plugin.start })
      for (const entry of installs) {
        const install = entry.value, path = typeof install?.installPath === 'string' ? install.installPath : null
        if (path) { const target = canonical(path); referenceDeps.push(s.dep(target.source, null, { witnessOnly: true })); if (target.value) referenced.add(target.value); else if (target.source.known) referenced.add(path) }
        const deps = [s.dep(settings, enabled.get(plugin.key)?.value ?? null)]
        let reason = enabled.get(plugin.key)?.value === false ? 'disabled' : null
        if (!reason) {
          const installed = path && isAbsolute(path) ? dir(path) : null
          if (installed) deps.push(use(installed))
          if (installed && !installed.source.known) reason = 'unreadable'
          else if (!installed?.value) reason = 'plugin-missing'
          else if (typeof install.projectPath === 'string') {
            const project = dir(install.projectPath); deps.push(use(project)); if (!project.value) reason = project.source.known ? 'plugin-missing' : 'unreadable'
          }
        }
        if (reason) s.row('plugins', 'claude', reason, registry, [plugin.key, entry.key, install], deps, { start: entry.start })
      }
    }
    for (const [id, entry] of enabled) if (!plugins.some((p) => p.key === id)) s.row('plugins', 'claude', entry.value === false ? 'disabled' : 'plugin-missing',
      settings, [id, entry.value], [s.dep(registry, ['membership', id, false])], { start: entry.start })
    caches('claude', join(profile.claude, 'plugins/cache'), (path) => {
      const target = canonical(path)
      const present = referenced.has(target.value ?? path)
      return { value: present, deps: [use(target), ...referenceDeps, s.dep(registry, ['membership', target.value ?? path, present])] }
    }, [])
  }

  function pluginsCodex() {
    const source = file(join(profile.codex, 'config.toml')), plugins = entries(source, 'plugins', true), listed = new Set(plugins.map((p) => p.key))
    for (const entry of plugins) {
      if (entry.unreadable) { s.gap(source.key, 'file', malformed); s.row('plugins', 'codex', 'unreadable', source, [entry.key], [s.dep(null, undefined)]); continue }
      const deps = []
      let reason = entry.value?.enabled === false ? 'disabled' : null
      if (!reason) {
        const index = entry.key.lastIndexOf('@')
        const target = index < 0 ? null : dir(join(profile.codex, 'plugins/cache', entry.key.slice(index + 1), entry.key.slice(0, index)))
        if (target) deps.push(use(target))
        if (!target?.value) reason = target && !target.source.known ? 'unreadable' : 'plugin-missing'
      }
      if (reason) s.row('plugins', 'codex', reason, source, [entry.key, entry.value], deps, { start: entry.start })
    }
    caches('codex', join(profile.codex, 'plugins/cache'), (_path, plugin, market) =>
      ({ value: listed.has(`${plugin}@${market}`), deps: [s.dep(source, ['membership', `${plugin}@${market}`, listed.has(`${plugin}@${market}`)])] }), [])
  }

  function pluginsOpenCode() {
    const seen = new Set()
    // Managed sources come first so a shared reference is listed once with its managed origin.
    const files = [...profile.opencodeFiles.flatMap((path) => [['plugin'], ['plugins']].map((at) => [path, at])),
      [join(profile.opencode, 'cli.json'), ['plugins']]]
    for (const [path, at] of files) {
      const source = file(path)
      for (const entry of entries(source, at)) {
        const reference = typeof entry.value === 'string' ? entry.value : at[0] === 'plugins' ? entry.value?.package : null
        if (typeof reference !== 'string' || reference.length === 0) { s.gap(source.key, 'file', malformed); s.row('plugins', 'opencode', 'unreadable', source, [at, entry.key], [s.dep(null, undefined)]); continue }
        const raw = reference.startsWith('file:') ? reference.slice(5) : reference
        const local = raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('~')
        const resolved = local ? resolve(dirname(path), raw.replace(/^~/, H)) : null
        const key = local ? `local:${resolved}` : `package:${reference}`
        if (seen.has(key)) continue
        seen.add(key)
        const target = local ? exists(resolved) : null
        if (!local || !target.value) s.row('plugins', 'opencode', local ? target.source.known ? 'plugin-missing' : 'unreadable' : 'app-managed', source,
          [at, entry.key, entry.value], target ? [use(target)] : [], { start: entry.start })
      }
    }
    for (const folder of ['plugin', 'plugins']) {
      const discovery = s.directory(join(profile.opencode, folder))
      for (const name of s.names(discovery)) {
        const source = s.tree(join(profile.opencode, folder, name))
        if (source.known && source.value.missingTarget) s.row('plugins', 'opencode', 'plugin-missing', source, [folder, name], [s.dep(discovery, name)])
      }
    }
  }

  async function approvedTools() {
    const pointer = file(join(profile.bmn, 'state/current')), deps = [s.dep(pointer, null)]
    if (!pointer.known) return { known: false, ids: new Set(), deps }
    if (s.text(pointer) === null) {
      const generations = s.directory(join(profile.bmn, 'state/generations')), history = exists(join(profile.bmn, 'state/history.jsonl'))
      deps.push(s.dep(generations, s.names(generations).filter((name) => /^\d{6}\.json$/.test(name))), use(history))
      const known = generations.known && history.source.known && !history.value && !s.names(generations).some((name) => /^\d{6}\.json$/.test(name))
      if (!known) s.gap(pointer.key, 'file', malformed)
      return { known, ids: new Set(), deps }
    }
    const value = s.json(pointer)
    if (!Number.isSafeInteger(value?.generation) || value.generation < 0 || value.generation > 999999) { s.gap(pointer.key, 'file', malformed); return { known: false, ids: new Set(), deps } }
    const generation = file(join(profile.bmn, 'state/generations', `${String(value.generation).padStart(6, '0')}.json`))
    deps.push(s.dep(generation, null))
    const { approvedSnapshot } = await import('./agents-state.mjs')
    const verified = generation.known && s.text(generation) !== null ? approvedSnapshot(s.text(pointer), s.text(generation)) : null
    if (!verified) s.gap(generation.key, 'file', malformed)
    return { known: Boolean(verified), ids: new Set((verified?.data.tools ?? []).map((t) => t.id)), deps }
  }

  function program(command, args) {
    const deps = [], paths = (env.PATH ?? '').split(':').filter(Boolean)
    if (typeof command !== 'string' || !command) return { value: 'missing', deps }
    if (!isAbsolute(command) && command.includes('/')) return { value: 'unverified', deps }
    const candidates = isAbsolute(command) ? [command] : paths.map((path) => join(path, command))
    let found = false, known = true
    for (const path of candidates) {
      const source = s.access(path); deps.push(s.dep(source, [paths, source.value?.outcome ?? null]))
      if (!source.known) known = false
      if (source.value?.outcome) { found = true; break }
    }
    if (!known) return { value: 'unknown', deps }
    if (!found) return { value: 'missing', deps }
    if (RUNNERS.has(basename(command))) return { value: 'unverified', deps }
    for (const arg of args) if (typeof arg === 'string' && isAbsolute(arg) && /\.(?:m?js|cjs|ts|py|sh|rb)$/.test(arg)) {
      const target = exists(arg); deps.push(use(target)); if (!target.source.known) return { value: 'unknown', deps }; if (!target.value) return { value: 'missing', deps }
    }
    return { value: 'present', deps }
  }

  async function mcp() {
    const team = await approvedTools()
    const toolRows = (app, path, at, scope = [], inherited = [], supplied = null) => {
      const source = file(path)
      if (!source.known) { s.row('mcp', app, 'unreadable', source, [at, scope], []); return 0 }
      const list = supplied ?? entries(source, at, app === 'codex', true)
      for (const entry of list) {
        const value = entry.value, neutral = entry.unreadable ? null : neutralOf(value, app), deps = [...inherited]
        let reason = null
        if (!neutral) { reason = 'unreadable'; s.gap(source.key, 'file', malformed); deps.push(s.dep(null, undefined)) }
        else if ((neutral.secrets ?? []).length) reason = 'secret-inline'
        else {
          const written = writtenTools.data ? Object.hasOwn(writtenTools.data, `${app}|${entry.key}`) : undefined
          deps.push(s.dep(writtenTools.source, written), ...team.deps.map((d) => s.dep(d.source, [entry.key, team.known ? team.ids.has(entry.key) : undefined])))
          if (written || team.known && team.ids.has(entry.key)) continue
          if (!team.known) deps.push(s.dep(null, undefined))
          if (scope[0] === 'plugin') reason = 'plugin-owned'
          else {
            const run = neutral.definition?.url !== undefined ? { value: 'present', deps: [] } : program(neutral.definition?.command, neutral.definition?.args ?? [])
            deps.push(...run.deps)
            if (run.value === 'missing') reason = 'missing-program'
            else if (scope[0] === 'project') { const project = dir(scope[1]); deps.push(use(project)); if (!project.value) reason = project.source.known ? 'missing-project' : 'unverified' }
            if (!reason && ['unverified', 'unknown'].includes(run.value)) reason = 'unverified'
          }
        }
        if (reason) s.row('mcp', app, reason, source, [entry.at ?? at, scope, entry.key, value ?? null], deps,
          { start: entry.start, ...(neutral ? { identity: 'mcp-entry' } : {}) })
      }
      return list.length
    }
    toolRows('claude', TOOL_APPS.claude.file(env), TOOL_APPS.claude.path)
    toolRows('codex', TOOL_APPS.codex.file(env), 'mcp_servers')
    const openCode = new Map()
    for (const path of profile.opencodeFiles) {
      const source = file(path)
      if (!source.known) { toolRows('opencode', path, null); continue }
      for (const entry of entries(source, null, false, true)) {
        const group = openCode.get(entry.key) ?? []
        group.push({ path, source, entry }); openCode.set(entry.key, group)
      }
    }
    for (const group of openCode.values()) {
      const first = group[0]
      const tag = (entry) => privateTag(keys.context, 'mcp-definition', entry.value ?? null)
      const conflict = group.some(({ entry }) => entry.unreadable || !neutralOf(entry.value, 'opencode') || tag(entry) !== tag(first.entry))
      const dependencies = group.slice(1).map(({ source, entry }) => s.dep(source, [entry.at, entry.key, entry.value ?? null]))
      toolRows('opencode', first.path, null, [], dependencies, [{ ...first.entry, ...(conflict ? { unreadable: true } : {}) }])
    }
    const config = file(profile.claudeJson)
    for (const project of entries(config, ['projects'])) toolRows('claude', profile.claudeJson, ['projects', project.key, 'mcpServers'], ['project', project.key])
    const registry = file(join(profile.claude, 'plugins/installed_plugins.json')), seen = new Set()
    for (const plugin of entries(registry, ['plugins'])) for (const install of Array.isArray(plugin.value) ? entries(registry, ['plugins', plugin.key]) : []) {
      if (typeof install.value?.installPath !== 'string') continue
      const path = join(install.value.installPath, '.mcp.json'), target = exists(path)
      if (!target.value || seen.has(path)) continue
      seen.add(path)
      const source = file(path), nested = entries(source, ['mcpServers'])
      toolRows('claude', path, nested.length ? ['mcpServers'] : [], ['plugin', plugin.key, install.key],
        [s.dep(registry, [plugin.key, install.key, install.value]), use(target), s.dep(source, ['fallback', nested.length === 0])])
    }
  }

  for (const [name, run] of [['memory-claude', claudeMemory], ['memory-codex', codexMemory], ['skills', skills],
    ['plugins-claude', pluginsClaude], ['plugins-codex', pluginsCodex], ['plugins-opencode', pluginsOpenCode], ['mcp', mcp]]) {
    try { await run() } catch (error) { s.gap(name, 'step', error, 'scan') }
  }
  return s.finish()
}

// scan is an internal deterministic test seam, never an environment or worker-context switch.
export async function inspectLeftovers(versions = {}, { keys = null, privateReceipts = false, deadline = Date.now() + 58000, scan = scanOnce } = {}) {
  keys ??= { item: randomBytes(32).toString('hex'), context: randomBytes(32).toString('hex') }
  const first = await scan(versions, keys, deadline)
  const acquisitionChanged = first.acquisitionChanged ?? new Set()
  const changing = new Set([...first.unstable, ...acquisitionChanged])
  const changed = (source, second = null, itemPath = null) => {
    const paths = [...new Set([...(first.inputs.get(source.key)?.changedPaths ?? []), ...(source.changedPaths ?? []), ...(second?.inputs.get(source.key)?.changedPaths ?? [])])]
    first.gap(source.key, source.kind, { code: 'SOURCE_CHANGED', ...(source.kind === 'database' ? {
      observationPaths: paths.length ? paths : itemPath ? [itemPath] : source.physicalPaths ?? [source.path]
    } : {}) }, 'revalidate')
  }
  if (changing.size && !first.timedOut && Date.now() + 1000 < deadline) {
    // Retain compact commitments and attribution, not a second database-sized byte graph.
    for (const source of first.inputs.values()) { source.value = null; source.stable = null }
    const second = await scan(versions, keys, deadline).catch((error) => {
      if (error?.code !== 'TIME_BOUND') throw error
      first.gap('inspection-deadline', 'step', error, 'revalidate')
      return { rows: [], inputs: new Map(), unstable: new Set(), unverified: new Set(), gaps: new Map(), timedOut: true }
    })
    const fresh = second.rows.filter((r) => r.receipt && r.sources.every((s) => s.known && !second.unstable.has(s.key)))
    const matches = new Map(matchContinuity(first.rows.filter((r) => r.receipt).map((r) => r.receipt), fresh.map((r) => r.receipt)).map((m) => [m.item, m.current]))
    const byItem = new Map(fresh.map((r) => [r.value.item, r]))
    // Every coordinate published after recovery needs that recovery's own certification.
    for (const row of first.rows) row.value.locator = byItem.get(matches.get(row.value.item))?.value.locator ?? { status: 'unresolved' }
    const recovered = new Set([...acquisitionChanged].filter((key) => second.inputs.get(key)?.known && !second.unstable.has(key) && !second.timedOut))
    // A recovered acquisition still changed during this check. Retain that truthful
    // partial count while publishing the subsequently verified rows and coordinates.
    for (const [key, gap] of second.gaps) first.gaps.set(key, gap)
    // A second observation with incomplete coverage cannot certify the first inventory.
    for (const input of second.unstable) if (!second.unverified?.has(input)) changed(second.inputs.get(input), second)
    if (second.timedOut) for (const input of first.unstable) if (!first.unverified?.has(input)) changed(first.inputs.get(input), second)
    const added = fresh.filter((r) => !first.rows.some((old) => old.receipt?.itemTag === r.receipt.itemTag && old.receipt.contextTag === r.receipt.contextTag))
    const adopted = added.filter((r) => r.sources.some((s) => recovered.has(s.key)))
    const unmatched = [...first.rows.filter((r) => r.receipt && !matches.get(r.value.item)), ...added.filter((r) => !adopted.includes(r))]
    if (!second.timedOut) {
      const oldReasons = first.rows.filter((row) => !row.receipt && row.reasonTag)
      const newReasons = second.rows.filter((row) => !row.receipt && row.reasonTag &&
        row.sources.every((source) => source.bound || source.known && !second.unstable.has(source.key)))
      const counts = (rows) => {
        const values = new Map()
        for (const row of rows) values.set(row.reasonTag, (values.get(row.reasonTag) ?? 0) + 1)
        return values
      }
      const oldCounts = counts(oldReasons), newCounts = counts(newReasons)
      const unique = (row) => oldCounts.get(row.reasonTag) === 1 && newCounts.get(row.reasonTag) === 1
      unmatched.push(...oldReasons.filter((row) => !unique(row)))
      for (const row of newReasons.filter((row) => !unique(row))) {
        if (row.sources.some((source) => recovered.has(source.key))) adopted.push(row)
        else unmatched.push(row)
      }
    }
    for (const row of unmatched) {
      const affected = row.sources.filter((source) => first.unstable.has(source.key) || second.unstable.has(source.key))
      if (!second.timedOut) for (const source of affected.length ? affected : row.sources.slice(0, 1)) changed(source, second, row.itemPath)
    }
    // An acquisition failure did not establish those provisional reasons. Replace only
    // that recovered portion with the fully reconstructed inventory, including new rows.
    const settled = (key) => second.inputs.get(key)?.known && !second.unstable.has(key)
    const pending = new Set(second.rows.filter((row) => !adopted.includes(row)).flatMap((row) => row.sources.map((source) => source.key)))
    first.rows = first.rows.filter((r) => r.receipt || !r.sources.some((s) => recovered.has(s.key)) ||
      r.sources.some((s) => !recovered.has(s.key) && !settled(s.key) && !(s.kind === 'cache-tree' && !pending.has(s.key))))
    first.rows.push(...adopted)
  } else for (const input of first.unstable) if (!first.unverified?.has(input)) changed(first.inputs.get(input))
  for (const [i, row] of first.rows.entries()) {
    row.value.item = i + 1
    if (row.receipt) row.receipt = { ...row.receipt, item: i + 1 }
  }
  const result = projectedResult(inspectionResult(first.rows, first.gaps))
  if (!result) throw new Error('inspection unavailable')
  const receipts = first.rows.filter((r) => r.receipt && r.value.locator.status === 'located' && result.leftovers?.some((item) => item.item === r.value.item)).map((r) => r.receipt)
  return privateReceipts ? { result, rows: receipts } : result
}
