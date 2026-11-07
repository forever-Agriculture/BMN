// MODULE: agents-team-vision.mjs - Epic 112: a reviewer's ask is given the project's plan/VISION.md, found from any worktree, read whole or not at all
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { FORMAT, PlanError, VISION_LIMIT, resolvePlan } from './plan-board.mjs'
import { InputRefusal, textFile } from './agents-team-inputs.mjs'

/**
 * The implementation reviews dev-auto asks through BMN (R112-FR1). The quick pre-reviews only map
 * and are left out, as are consultants, helpers and QA (D5).
 */
export const VISION_ROLES = Object.freeze(['focused-reviewer', 'epic-reviewer', 'final-reviewer'])

/** Plans BMN cannot find say there is no vision; any other plan error is a reason the vision was left out. */
const NO_PLAN = new Set(['NO_PROJECT', 'NO_REPOSITORY', 'NO_PLAN'])

/**
 * The project's vision for a reviewer's ask, found as the plan is found from that folder (D2: the
 * canonical plan, from a linked worktree without plan/ too). Returns null when the role is not a
 * reviewer, the ask has no project or the project has no BMN-format plan with a VISION.md;
 * `{ path, real, sha256, bytes }` when the whole file is given; `{ path, omitted }` when the ask goes
 * without it and why (over the plan check's ceiling, unreadable, not text, or holding a credential):
 * an ask never carries part of a vision (112.1 AC3).
 */
export async function reviewVision(role, project, { home } = {}) {
  if (!VISION_ROLES.includes(role) || project === null || project === undefined) return null
  let plan
  try {
    plan = await resolvePlan(project)
  } catch (error) {
    if (error instanceof PlanError && NO_PLAN.has(error.code)) return null
    return { path: null, omitted: `the project's plan could not be read (${error instanceof PlanError ? error.code : 'error'}), so its vision was not given` }
  }
  if (plan.format !== FORMAT) return null
  const path = join(plan.planRoot, 'VISION.md')
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return null
  }
  if (stat.isFile() && stat.size > VISION_LIMIT) return { path, omitted: `${path} is ${stat.size} bytes, over the ${VISION_LIMIT}-byte ceiling bmn plan check keeps for a vision` }
  try {
    const file = textFile(path, { home, limit: VISION_LIMIT })
    return { path, real: file.real, sha256: file.sha256, bytes: file.bytes.length }
  } catch (error) {
    if (error instanceof InputRefusal) return { path, omitted: `${error.message.replace(/; nothing was sent$/u, '')}, so it was not given` }
    throw error
  }
}

/** The one instruction a reviewer gets with the vision (R112-FR1, R112-FR2), naming the attached file by its place. */
export function visionPrompt(prompt, vision) {
  return `${prompt.replace(/\n?$/u, '\n')}\nFile ${vision.file} above, ${vision.label}, is the project's vision (sha256 ${vision.sha256}). Besides the question, report any change you review that works against one of its principles or one of its "We refuse" lines: quote the principle or refusal line, give the code's file:line and say the consequence. If you find none, say so in one line.\n`
}
