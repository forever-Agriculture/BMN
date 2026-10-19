// MODULE: agents-check-consequences.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: the consequences of an approval, in words (60.5 AC7)
import { APP_NAMES, DESIGNER_ROLE, HARNESSES, LEAD_ROLE, agentState, appName, canonicalJson, classRefusal, harnessPrivateWork, isCalled, namedResearchers, projectChoiceCollisions, projectChoiceFor, projectChoiceProblem, publicOnlyReasons } from './agents-roster.mjs'
import { canonicalProject } from './agents-team-inputs.mjs'
import { RUN_TEST_APPS } from './agents-tools.mjs'

// ---------------------------------------------------------------------------------------------
// Consequences of an approval, in words (60.5 AC7; shared with `roster status` and `roster explain`)

/** What approved data lets each agent do, in the terms the check enforces. */
function capabilities(data) {
  const out = new Map()
  for (const agent of data.agents) {
    const active = agentState(agent) === 'active'
    out.set(agent.id, {
      name: agent.name, active, provider: agent.provider, called: isCalled(agent),
      lead: active && agent.roles.includes(LEAD_ROLE) && classRefusal(agent.class, LEAD_ROLE) === null,
      design: active && agent.roles.includes(DESIGNER_ROLE) && classRefusal(agent.class, DESIGNER_ROLE) === null,
      private: active && publicOnlyReasons(agent, data).length === 0,
      roles: new Set(active ? agent.roles : []),
      limit: agent.context_limit
    })
  }
  return out
}

function firstEligible(data, role) {
  const states = new Map(data.agents.map((agent) => [agent.id, agentState(agent)]))
  for (const text of role.candidates) {
    const agent = /^([a-z0-9-]+)@/.exec(text)?.[1]
    if (agent !== undefined && states.get(agent) === 'active') return agent
  }
  return null
}

function listed(names) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function thousands(value) {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ' ')
}

/**
 * The consequences of moving from `before` to `after` approved data, in words: who could start or
 * stop leading, receiving private work, or taking a role; what a provider's answer changes for its
 * agents; which chain starts elsewhere; which workspaces gain or lose an exception; which app
 * versions the owner accepts. `before` may be null (first approval). Folders are never named here.
 */
export function consequences(before, after) {
  const empty = { agents: [], roles: [], providers: [], exceptions: [], harness_routes: [] }
  const prior = before ?? empty
  const old = capabilities(prior)
  const next = capabilities(after)
  const out = []
  const name = (id) => next.get(id)?.name ?? old.get(id)?.name ?? id
  const none = { active: false, lead: false, design: false, private: false, roles: new Set(), limit: undefined }
  // A provider's changed answer is said once, naming the agents it changes, not once per agent.
  const explained = new Set()
  const oldProviders = new Map(prior.providers.map((provider) => [provider.id, provider]))
  for (const provider of after.providers) {
    const was = oldProviders.get(provider.id)
    if (was === undefined || was.private_work === provider.private_work) continue
    const gains = provider.private_work === 'allowed'
    const affected = [...next.entries()].filter(([id, now]) => now.provider === provider.id && (old.get(id) ?? none).private !== now.private && now.private === gains)
    for (const [id] of affected) explained.add(id)
    const who = listed(affected.map(([id]) => name(id)))
    out.push(gains
      ? `Changing ${provider.name} to Allowed ${who === '' ? 'changes no active agent yet' : `lets ${who} receive private work`}`
      : `Changing ${provider.name} to Public work only ${who === '' ? 'changes no active agent yet' : `stops ${who} receiving private work`}`)
  }
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id) ?? none
    const b = next.get(id) ?? none
    // An agent BMN itself calls is given no work: it is asked, and it is sent text.
    const called = (next.get(id) ?? old.get(id))?.called === true
    if (!a.active && b.active) out.push(called ? `${name(id)} could be asked as the judge` : `${name(id)} could be given work`)
    if (a.active && !b.active) out.push(called ? `${name(id)} could no longer be asked as the judge` : `${name(id)} could no longer be given work`)
    if (!a.lead && b.lead) out.push(`${name(id)} could lead`)
    if (a.lead && !b.lead) out.push(`${name(id)} could no longer lead`)
    if (!a.design && b.design) out.push(`${name(id)} could design`)
    if (a.design && !b.design) out.push(`${name(id)} could no longer design`)
    if (!explained.has(id)) {
      if (!a.private && b.private) out.push(called ? `${name(id)} could be sent private text` : `${name(id)} could receive private work`)
      if (a.private && !b.private) out.push(called ? `${name(id)} could no longer be sent private text` : `${name(id)} could no longer receive private work`)
    }
    if (a.active && b.active) {
      for (const role of b.roles) if (!a.roles.has(role)) out.push(`${name(id)} could take the ${role} role`)
      for (const role of a.roles) if (!b.roles.has(role)) out.push(`${name(id)} could no longer take the ${role} role`)
    }
    if (old.has(id) && next.has(id) && a.limit !== b.limit) {
      out.push(`${name(id)}: context limit ${a.limit === undefined ? 'app default' : thousands(a.limit)} → ${b.limit === undefined ? 'app default' : thousands(b.limit)}`)
    }
  }
  const oldRoles = new Map(prior.roles.map((role) => [role.id, role]))
  for (const role of after.roles) {
    const previous = oldRoles.get(role.id)
    const first = firstEligible(after, role)
    const was = previous === undefined ? null : firstEligible(prior, previous)
    if (first !== was) {
      out.push(first === null ? `${role.id} would have no agent to start with (then ${role.then})` : `${role.id} would start with ${name(first)}${was === null ? '' : ` instead of ${name(was)}`}`)
    }
    if (previous !== undefined && previous.then !== role.then) out.push(`when every ${role.id} candidate fails: ${role.then} instead of ${previous.then}`)
    // What the check asks of a run for the role (63.2): a role new to read-only refuses more, one freed of it refuses less.
    const heldBefore = previous?.read_only === true
    if (role.read_only === true && !heldBefore) out.push(`${role.id} runs would be refused unless they are started so that they cannot write`)
    if (role.read_only !== true && heldBefore) out.push(`${role.id} runs could be started with write access again`)
  }
  for (const role of prior.roles) if (!after.roles.some((entry) => entry.id === role.id)) out.push(`the ${role.id} role would be removed`)
  // A project choice (73.2): who a role's asks in that project would reach, before and after. The folder is named only in BMN's own review.
  const chosen = (choice) => `${name(choice.agent)}${choice.effort === undefined ? '' : ` at ${choice.effort}`}`
  const chain = (data, roleId) => {
    const role = data.roles.find((entry) => entry.id === roleId)
    const first = role === undefined ? null : firstEligible(data, role)
    return first === null ? "the role's chain, which has no agent to start with" : `the role's chain (${name(first)} first)`
  }
  const oldChoices = new Map((prior.project_choices ?? []).map((choice) => [choice.id, choice]))
  const newChoices = new Map((after.project_choices ?? []).map((choice) => [choice.id, choice]))
  // Two choices that still apply for one role in one project decide nothing: that role's asks there are refused (epic recheck 2).
  // A change that ends or starts such a pair is said as that, for the pair, instead of choice by choice.
  const said = new Set()
  const today = new Date()
  // What a role's asks in one project get under `data`: the choice that applies, the role's chain, or a refusal and why. Every
  // line below says this, never a choice's agent by itself, so a choice whose agent cannot be asked is never said to be reached (AC2, AC4).
  const outcome = (data, project, roleId) => {
    const found = projectChoiceFor(data, project, roleId, canonicalProject, today)
    if (found === null || found.ended) return { reach: chain(data, roleId) }
    if (found.collision !== undefined) return { refused: ' for two choices there' }
    const problem = projectChoiceProblem(data, found.choice)
    return problem === null ? { reach: chosen(found.choice) } : { refused: `: the choice ${found.choice.id} names ${chosen(found.choice)}, who cannot be asked now (${problem})` }
  }
  const was = (group) => (group.reach !== undefined ? group.reach : `being refused${group.refused}`)
  const change = (roleId, before, now) => {
    if (now.refused !== undefined) return now.refused === before.refused ? null : `${roleId} asks in one project would be refused${now.refused}, instead of ${before.reach === undefined ? `being refused${before.refused}` : `reaching ${before.reach}`}`
    return now.reach === before.reach ? null : `${roleId} asks in one project would reach ${now.reach} instead of ${was(before)}`
  }
  const push = (line) => {
    if (line !== null && !out.includes(line)) out.push(line)
  }
  if (oldChoices.size + newChoices.size > 0) {
    const pairKey = (group) => `${group.project}\n${group.role}`
    const pairsBefore = new Map(projectChoiceCollisions(prior.project_choices, canonicalProject, today).map((group) => [pairKey(group), group]))
    const pairsAfter = new Map(projectChoiceCollisions(after.project_choices, canonicalProject, today).map((group) => [pairKey(group), group]))
    // A pair that ends: the choice left decides, or its asks stay refused because its agent cannot be asked (AC4).
    for (const [key, group] of pairsBefore) {
      if (pairsAfter.has(key)) continue
      const left = outcome(after, group.project, group.role)
      out.push(left.refused === undefined ? `${group.role} asks in one project would reach ${left.reach} instead of being refused for two choices there`
        : `${group.role} asks in one project would stay refused${left.refused.replace(/^: the choice (\S+) names/u, ': the choice left, $1, names')}, instead of being refused for two choices there`)
      for (const choice of group.choices) said.add(choice.id)
    }
    for (const [key, group] of pairsAfter) {
      if (pairsBefore.has(key)) continue
      const before = outcome(prior, group.project, group.role)
      out.push(`${group.role} asks in one project would be refused for two choices there instead of ${before.reach === undefined ? `being refused${before.refused}` : `reaching ${before.reach}`}`)
      for (const choice of group.choices) said.add(choice.id)
    }
  }
  for (const id of new Set([...oldChoices.keys(), ...newChoices.keys()])) {
    if (said.has(id)) continue
    const then = oldChoices.get(id)
    const now = newChoices.get(id)
    const moved = then === undefined || now === undefined || then.project !== now.project || then.role !== now.role
    if (moved) {
      if (then !== undefined) push(change(then.role, outcome(prior, canonicalProject(then.project), then.role), outcome(after, canonicalProject(then.project), then.role)))
      // A choice for a role the team did not have was compared with that role's chain as it will be.
      if (now !== undefined) {
        const project = canonicalProject(now.project)
        push(change(now.role, prior.roles.some((role) => role.id === now.role) ? outcome(prior, project, now.role) : { reach: chain(after, now.role) }, outcome(after, project, now.role)))
      }
      continue
    }
    // An unchanged choice is said too when what its asks get changes: its agent turned off, or back on (AC4).
    const project = canonicalProject(now.project)
    const before = outcome(prior, project, now.role)
    const current = outcome(after, project, now.role)
    const ends = (choice) => (choice.ends === undefined ? 'with no end date' : `until ${choice.ends}`)
    // The end date is said with the choice it belongs to when that choice decides before and after.
    if (then.ends !== now.ends && current.reach === chosen(now) && before.reach === chosen(then)) {
      push(`${now.role} asks in one project would reach ${chosen(now)} ${ends(now)} instead of ${chosen(then) === chosen(now) ? '' : `${chosen(then)} `}${ends(then)}`)
    } else push(change(now.role, before, current))
  }
  // Who researches (63.3): naming the first researcher closes the offer to every other agent; after that only the named ones change.
  const researched = namedResearchers(prior)
  const researching = namedResearchers(after)
  const nobody = 'no agent would be offered as a researcher; every research would be refused'
  if (researched === null && researching !== null) out.push(researching.length === 0 ? nobody : `only ${listed(researching.map(name))} would be offered as researchers; a research with any other agent would be refused`)
  else if (researched !== null && researching === null) out.push('every agent that can research would be offered as a researcher again')
  else if (researched !== null && researching !== null) {
    for (const id of researching) if (!researched.includes(id)) out.push(`${name(id)} would be offered as a researcher`)
    for (const id of researched) if (!researching.includes(id)) out.push(`${name(id)} would no longer be offered as a researcher`)
    if (researching.length === 0 && researched.length > 0) out.push(nobody)
  }
  const providerName = (id) => after.providers.find((provider) => provider.id === id)?.name ?? oldProviders.get(id)?.name ?? id
  const exceptionKey = (entry) => `${entry.provider}\n${entry.folder}`
  const oldExceptions = new Set(prior.exceptions.map(exceptionKey))
  const newExceptions = new Set(after.exceptions.map(exceptionKey))
  const count = (entries, others) => {
    const perProvider = new Map()
    for (const entry of entries) if (!others.has(exceptionKey(entry))) perProvider.set(entry.provider, (perProvider.get(entry.provider) ?? 0) + 1)
    return perProvider
  }
  for (const [provider, added] of count(after.exceptions, oldExceptions)) {
    out.push(`${providerName(provider)} could receive private work in ${added === 1 ? 'one more workspace' : `${added} more workspaces`}`)
  }
  for (const [provider, removed] of count(prior.exceptions, newExceptions)) {
    out.push(`${providerName(provider)} could no longer receive private work in ${removed === 1 ? 'one workspace' : `${removed} workspaces`}`)
  }
  const oldRoutes = new Map(prior.harness_routes.map((route) => [route.harness, route]))
  for (const route of after.harness_routes) {
    const app = appName(route.harness)
    const previous = oldRoutes.get(route.harness)
    if (previous !== undefined && (previous.provider !== route.provider || previous.basis !== route.basis)) {
      out.push(route.basis === 'owner-declared'
        ? `${app} would count as sending data to ${providerName(route.provider)} on your word, so it gets public work only`
        : `${app} would count as sending data to ${providerName(route.provider)}, as inspected`)
    }
  }
  // A skill's marks: which apps would start or stop being meant to have it (60.11 AC5). The folder is never named here.
  const marks = (data) => new Map((data.skills ?? []).map((entry) => [entry.id, entry]))
  const oldMarks = marks(prior)
  const newMarks = marks(after)
  const mayHave = (mark, harness) => (mark?.only === undefined || mark.only.includes(harness)) && (harnessPrivateWork(after, harness).allowed || mark?.public === true)
  for (const id of [...new Set([...oldMarks.keys(), ...newMarks.keys()])].sort()) {
    const was = oldMarks.get(id)
    const now = newMarks.get(id)
    if (canonicalJson(was ?? null) === canonicalJson(now ?? null)) continue
    const gains = HARNESSES.filter((harness) => !mayHave(was, harness) && mayHave(now, harness)).map((harness) => APP_NAMES[harness])
    const loses = HARNESSES.filter((harness) => mayHave(was, harness) && !mayHave(now, harness)).map((harness) => APP_NAMES[harness])
    if (gains.length > 0) out.push(`Skill ${id} would reach ${listed(gains)}`)
    if (loses.length > 0) out.push(`Skill ${id} would no longer reach ${listed(loses)}`)
    if (gains.length === 0 && loses.length === 0) out.push(`Skill ${id}: no app gains or loses it`)
  }
  if ((prior.skills_source ?? null) !== (after.skills_source ?? null)) out.push('Skills would come from another folder')
  // A tool: which apps' settings would gain it, lose it or hold it changed at the next install, and whose runs would carry it (60.12 AC6).
  const toolsOf = (data) => new Map((data.tools ?? []).map((tool) => [tool.id, tool]))
  const oldTools = toolsOf(prior)
  const newTools = toolsOf(after)
  const inApp = (data, tool, harness) => tool !== undefined && tool.agents === undefined && (tool.apps === undefined || tool.apps.includes(harness))
    && (harnessPrivateWork(data, harness).allowed || tool.public === true)
  const what = (tool) => canonicalJson([tool.command ?? null, tool.args ?? [], tool.url ?? null, tool.env ?? {}, tool.headers ?? {}])
  for (const id of [...new Set([...oldTools.keys(), ...newTools.keys()])].sort()) {
    const was = oldTools.get(id)
    const now = newTools.get(id)
    if (canonicalJson(was ?? null) === canonicalJson(now ?? null)) continue
    const gains = HARNESSES.filter((harness) => !inApp(prior, was, harness) && inApp(after, now, harness)).map((harness) => APP_NAMES[harness])
    const loses = HARNESSES.filter((harness) => inApp(prior, was, harness) && !inApp(after, now, harness)).map((harness) => APP_NAMES[harness])
    const changes = was !== undefined && now !== undefined && what(was) !== what(now)
      ? HARNESSES.filter((harness) => inApp(prior, was, harness) && inApp(after, now, harness)).map((harness) => APP_NAMES[harness]) : []
    const gained = (now?.agents ?? []).filter((agent) => !(was?.agents ?? []).includes(agent))
    // A run gets a tool of its own only in an app BMN can keep to its tools; elsewhere the tool is listed and waits.
    const appOf = (agent) => after.agents.find((entry) => entry.id === agent)?.harness
    const given = gained.filter((agent) => RUN_TEST_APPS.includes(appOf(agent))).map(name)
    const waiting = gained.filter((agent) => !RUN_TEST_APPS.includes(appOf(agent)))
    const taken = (was?.agents ?? []).filter((agent) => !(now?.agents ?? []).includes(agent)).map(name)
    // The owner knows a tool by its name, as its row shows it.
    const title = (now ?? was).name
    const said = out.length
    if (gains.length > 0) out.push(`Tool ${title} would reach ${listed(gains)}`)
    if (loses.length > 0) out.push(`Tool ${title} would no longer reach ${listed(loses)}`)
    if (changes.length > 0) out.push(`Tool ${title} would change in ${listed(changes)}`)
    if (given.length > 0) out.push(`Tool ${title} would be given to the runs of ${listed(given)}`)
    for (const agent of waiting) out.push(`Tool ${title} is for the runs of ${name(agent)}, and BMN cannot give a ${appName(appOf(agent))} run a tool yet`)
    if (taken.length > 0) out.push(`Tool ${title} would no longer be given to the runs of ${listed(taken)}`)
    if (out.length === said) out.push(`Tool ${title}: no app gains or loses it`)
  }
  // The first tool on the list changes what the check asks of every run, also of an agent that has none.
  if (oldTools.size === 0 && newTools.size > 0) out.push('With a tool on the list, the check keeps every Claude Code run to exactly its own tools, once its tools test passed there; it does not judge the tools of a Codex run')
  if (oldTools.size > 0 && newTools.size === 0) out.push('With no tool on the list, the check no longer looks at which tools a run has')
  return [...new Set(out)]
}
