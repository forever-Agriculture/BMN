// MODULE: agents-team-resolve.mjs - Epic 72: the one resolver that picks who answers an ask and at which effort: a recheck's teammate, else the project's approved choice, else a named agent, else the small-work candidate, else the role's chain
import { agentState, classRefusal, initialEfforts, isCalled, parseCandidate, roleEfforts } from './agents-roster.mjs'

/**
 * Who answers is decided by rules the asker can predict (R72-FR3, 72.2 AC1), in this order: a valid
 * recheck asks the earlier run's teammate at the role's recheck effort; an approved project choice
 * binds (73.2): asking someone else there needs the owner to change the choice first; a named agent; the role's small-work candidate;
 * the chain's first candidate that is active, has a proven form for this access mode and may get
 * this data. A recheck, a project choice or a named agent that is not valid now is refused with the
 * reason and the eligible alternatives, never passed over (R72-NFR7). The result says which rule chose.
 */

/** A refusal of the resolver: `USAGE` is a usage problem (exit 2), every other code a refusal (exit 10). */
export class AskRefusal extends Error {
  constructor(code, message, alternatives = undefined) {
    super(message)
    this.code = code
    if (alternatives !== undefined) this.alternatives = alternatives
  }
}
const refuse = (code, message, alternatives) => {
  throw new AskRefusal(code, message, alternatives)
}

/**
 * Why an agent cannot answer this ask now, or null. `context.standing(agent)` says whether its app
 * has a proven form for this mode (`proven`, or the words of why not); `context.allowed(agent)`
 * whether it may get this data (`{ allowed, reason }`).
 */
export function notEligible(data, role, agent, context) {
  if (agent === undefined) return 'is not on the approved team'
  const state = agentState(agent)
  if (state !== 'active') return `is ${state}`
  if (isCalled(agent)) return 'is called by BMN itself and answers no asks'
  if (!agent.roles.includes(role.id)) return `does not hold the role ${role.id}`
  const rule = classRefusal(agent.class, role.id)
  if (rule !== null) return `is a ${agent.class}; ${rule.rule}`
  const standing = context.standing(agent)
  if (standing !== 'proven') return standing
  const consent = context.allowed(agent)
  if (!consent.allowed) return `may not get this ask's data: ${consent.reason}`
  return null
}

/** The efforts an agent may be asked at in a phase of a role. */
export function phaseEfforts(role, agent, phase) {
  if (phase === 'recheck' && role.recheck !== undefined && Object.hasOwn(role.recheck, agent.id) && agent.id !== 'same_reviewer') return [role.recheck[agent.id]]
  if (phase === 'small-work') {
    const small = role.small_work === undefined ? null : parseCandidate(role.small_work)
    if (small?.agent === agent.id) return small.efforts
  }
  return initialEfforts(role, agent)
}

/** The effort of an ask: the one asked for, if the phase allows it; the phase's one; else the asker must choose. */
function pickEffort(efforts, asked, agent, phase) {
  if (asked !== undefined) {
    if (!efforts.includes(asked)) refuse('EFFORT_NOT_ALLOWED', `${agent.id} is asked at ${efforts.join(' or ')} ${phase === 'recheck' ? 'for a recheck' : 'here'}, not ${asked}`, efforts.map((effort) => `${agent.id}@${effort}`))
    return asked
  }
  if (efforts.length === 1) return efforts[0]
  refuse('EFFORT_REQUIRED', `${agent.id} may be asked at ${efforts.join(', ')}: choose one with --effort`, efforts.map((effort) => `${agent.id}@${effort}`))
  return null
}

/** The role's candidates that could answer this ask now, each as `id@effort|effort`. */
export function alternatives(data, role, context) {
  const byId = new Map(data.agents.map((agent) => [agent.id, agent]))
  const texts = [...role.candidates, ...(role.small_work === undefined ? [] : [role.small_work])]
  const seen = new Set()
  const list = []
  for (const text of texts) {
    const candidate = parseCandidate(text)
    if (candidate === null || seen.has(text)) continue
    seen.add(text)
    if (notEligible(data, role, byId.get(candidate.agent), context) === null) list.push(text)
  }
  return list
}

/**
 * Picks the teammate. `request`: `{ role, agent, effort, smallWork, recheck }`, where `recheck` is
 * `{ id, run }` (`run` null when the earlier run is gone) and `run` is `{ role, project, agent }`.
 * `context`: `{ project, standing(agent), allowed(agent), projectChoice(role) }`, where
 * `projectChoice` gives the approved choice that applies (`{ id, agent, effort? }`) or null. Returns
 * `{ agent, effort, rule, phase }`, and `choice` (its id) when a project choice chose.
 */
export function resolveTeammate(data, request, context) {
  const role = data.roles.find((candidate) => candidate.id === request.role)
  if (role === undefined) refuse('ROLE_UNKNOWN', `no role ${request.role} in the approved team`)
  const byId = new Map(data.agents.map((agent) => [agent.id, agent]))
  const others = () => alternatives(data, role, context)
  const named = (id, rule, phase) => {
    const agent = byId.get(id)
    const why = notEligible(data, role, agent, context)
    if (why !== null) refuse('AGENT_NOT_ELIGIBLE', `${id} ${why}`, others())
    const efforts = phase === 'recheck-named' ? roleEfforts(role, id) : phaseEfforts(role, agent, phase)
    return { agent, effort: pickEffort(efforts, request.effort, agent, phase), rule, phase: phase === 'recheck-named' ? 'recheck' : phase }
  }
  const choice = context.projectChoice?.(role) ?? null

  if (request.recheck !== undefined && request.recheck !== null) {
    if (request.smallWork) refuse('USAGE', 'a recheck asks the earlier run\'s teammate; --small-work does not go with --recheck-of')
    const earlier = request.recheck.run
    if (earlier === null) {
      // The earlier run is gone: the asker names its teammate and an effort the role allows, judged as a named agent.
      if (request.agent === undefined || request.effort === undefined) refuse('RECHECK_INVALID', `run ${request.recheck.id} is gone; name its teammate with --agent and an effort the role allows with --effort`)
      if (choice !== null && choice.agent !== request.agent) refuse('PROJECT_CHOICE_CONFLICT', `this project's approved choice for ${role.id} is ${choice.agent} (${choice.id}); a recheck by ${request.agent} there needs the owner to change the choice first`, [choice.agent])
      return named(request.agent, 'recheck', 'recheck-named')
    }
    if (earlier.role !== role.id) refuse('RECHECK_INVALID', `run ${request.recheck.id} was for the role ${earlier.role}, not ${role.id}`)
    if ((earlier.project ?? null) !== (context.project ?? null)) refuse('RECHECK_INVALID', `run ${request.recheck.id} was for ${earlier.project ?? 'no project'}, not ${context.project ?? 'no project'}`)
    if (request.agent !== undefined && request.agent !== earlier.agent) refuse('USAGE', `a recheck of run ${request.recheck.id} asks ${earlier.agent}, its teammate, not ${request.agent}`)
    return named(earlier.agent, 'recheck', 'recheck')
  }
  if (choice !== null) {
    if (request.agent !== undefined && request.agent !== choice.agent) refuse('PROJECT_CHOICE_CONFLICT', `this project's approved choice for ${role.id} is ${choice.agent} (${choice.id}), not ${request.agent}; asking someone else there needs the owner to change the choice first`, [choice.agent])
    if (request.smallWork) refuse('PROJECT_CHOICE_CONFLICT', `this project's approved choice for ${role.id} is ${choice.agent} (${choice.id}); --small-work does not change it`, [choice.agent])
    const agent = byId.get(choice.agent)
    // An unavailable choice is refused with its reason, never passed to another (73.2 AC4).
    const why = notEligible(data, role, agent, context)
    if (why !== null) refuse('AGENT_NOT_ELIGIBLE', `this project's approved choice ${choice.agent} (${choice.id}) ${why}; asks for ${role.id} here are refused until the owner changes the choice`, others())
    const allowed = phaseEfforts(role, agent, 'initial')
    if (choice.effort !== undefined && !allowed.includes(choice.effort)) refuse('AGENT_NOT_ELIGIBLE', `this project's approved choice ${choice.agent} (${choice.id}) is at ${choice.effort}, which ${role.id} no longer allows it (${allowed.join(' or ')}); asks for ${role.id} here are refused until the owner changes the choice`, others())
    const efforts = choice.effort !== undefined ? [choice.effort] : allowed
    return { agent, effort: pickEffort(efforts, request.effort, agent, 'initial'), rule: 'project-choice', phase: 'initial', choice: choice.id }
  }
  if (request.agent !== undefined) {
    if (request.smallWork) refuse('USAGE', '--agent and --small-work name two ways to choose; give one')
    return named(request.agent, 'agent', 'initial')
  }
  if (request.smallWork) {
    if (role.small_work === undefined) refuse('ROLE_UNKNOWN', `the role ${role.id} names no small-work candidate`, others())
    const small = parseCandidate(role.small_work)
    const why = notEligible(data, role, byId.get(small.agent), context)
    if (why !== null) refuse('AGENT_NOT_ELIGIBLE', `the small-work candidate ${small.agent} ${why}`, others())
    return named(small.agent, 'small-work', 'small-work')
  }
  const reasons = []
  for (const text of role.candidates) {
    const candidate = parseCandidate(text)
    if (candidate === null) continue
    const agent = byId.get(candidate.agent)
    const why = notEligible(data, role, agent, context)
    if (why === null) return { agent, effort: pickEffort(candidate.efforts, request.effort, agent, 'initial'), rule: 'chain', phase: 'initial' }
    reasons.push(`${candidate.agent} ${why}`)
  }
  refuse('AGENT_NOT_ELIGIBLE', `no candidate of ${role.id} can answer this ask (${reasons.join('; ') || 'the role names none'}); the role says: ${role.then}`, [])
  return null
}
