// MODULE: plan-actions.mjs - validate the exact actions that can appear on an epic's owner approval card
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isAbsolute, normalize } from 'node:path'
import { promisify } from 'node:util'
import { simpleCommandWords } from './command-guard.mjs'
import { epicCommandTarget } from './grant-command.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/u
const REPOSITORY = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/u
const SHA = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const FIELDS = {
  merge: ['pr', 'headSha', 'whenGreen', 'changesCI'],
  'push-default': ['branch'],
  'pr-elsewhere': ['branch', 'pr'],
  command: ['command', 'folder', 'ref', 'script']
}
const NEVER = new Map([
  ['deploy', 'deploys'], ['release-deploy', 'deploy triggers'],
  ['repository-settings', 'repository settings'], ['repository-visibility', 'repository visibility'],
  ['repository-delete', 'repository deletion'], ['repository-transfer', 'repository transfer'],
  ['credential', 'credentials'], ['secret', 'secrets'], ['acceptance', 'acceptance changes'],
  ['machine', 'machine rules']
])

// An owner card must render the exact target without invisible or direction-changing characters.
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u
const plain = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 &&
  value.length <= max && !controls.test(value)
const boolean = value => value === true || value === 'true' ? true : value === false || value === 'false' ? false : null
const number = value => typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : NaN
const natural = value => Number.isSafeInteger(number(value)) && number(value) > 0
const branch = value => plain(value, 200) && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/u.test(value)
const pinPath = value => plain(value, 500) && normalize(value) === value
const invalid = problem => ({ problem })
const exec = promisify(execFile)
const readGh = async (cwd, args) => JSON.parse((await exec('gh', args, {
  cwd, timeout: 5000, maxBuffer: 256 * 1024
})).stdout)

export function parsePlanAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('an action is a typed map')
  const { id, kind } = raw
  if (!Object.hasOwn(FIELDS, kind)) return invalid(NEVER.has(kind) ? `${NEVER.get(kind)} can never be approved` : `action kind ${String(kind)} is outside the approved list`)
  if (typeof id !== 'string' || !ID.test(id)) return invalid('each action needs a stable id')
  const extra = Object.keys(raw).find(key => !['id', 'kind', 'repository', 'count', ...FIELDS[kind]].includes(key))
  if (extra !== undefined) return invalid(`unknown action field ${extra}`)
  if (!plain(raw.repository, 500)) return invalid('name the exact repository')
  const local = kind === 'command' && isAbsolute(raw.repository) && normalize(raw.repository) === raw.repository
  const repository = local ? raw.repository : raw.repository.toLowerCase()
  if (!local && !REPOSITORY.test(repository)) return invalid('repository must name OWNER/NAME')
  const count = raw.count === undefined ? 1 : number(raw.count)
  if (!natural(count)) return invalid('count must be a positive whole number')
  const action = { id, kind, repository, count }
  if (kind === 'merge') {
    const headSha = raw.headSha?.toLowerCase?.() ?? null
    const whenGreen = raw.whenGreen === undefined ? false : boolean(raw.whenGreen)
    const changesCI = boolean(raw.changesCI)
    if (!natural(raw.pr) || changesCI === null || whenGreen === null ||
      (whenGreen ? headSha !== null : !SHA.test(headSha ?? ''))) {
      return invalid('a merge needs the PR number, full headSha or whenGreen: true, and changesCI: true or false')
    }
    return { action: { ...action, pr: number(raw.pr), headSha, whenGreen, changesCI } }
  }
  if (kind === 'push-default') {
    return branch(raw.branch) ? { action: { ...action, branch: raw.branch } } : invalid('name the exact default branch')
  }
  if (kind === 'pr-elsewhere') {
    if (raw.branch === undefined && raw.pr === undefined ||
      raw.branch !== undefined && !branch(raw.branch) || raw.pr !== undefined && !natural(raw.pr)) {
      return invalid('name the exact PR or branch')
    }
    return { action: { ...action, branch: raw.branch ?? null, pr: raw.pr === undefined ? null : number(raw.pr) } }
  }
  if (!plain(raw.command, 1000) || !plain(raw.folder, 500) || !isAbsolute(raw.folder) ||
    normalize(raw.folder) !== raw.folder || !plain(raw.ref, 200)) {
    return invalid('a command needs its exact text, absolute folder, repository and ref')
  }
  let script = null
  if (raw.script !== undefined) {
    const { path, sha256 } = raw.script ?? {}
    if (!pinPath(path) || typeof sha256 !== 'string' || !SHA256.test(sha256) || Object.keys(raw.script).some(key => !['path', 'sha256'].includes(key))) {
      return invalid('a pin needs the exact file path and SHA-256')
    }
    script = { path, sha256 }
  }
  const command = { ...action, command: raw.command, folder: raw.folder, ref: raw.ref, script }
  const target = epicCommandTarget(command)
  if ('problem' in target) return invalid(target.problem)
  if (script !== null && target.script === null) return invalid('this command does not select the pinned file')
  return { action: command }
}

export const planActionsHash = actions => createHash('sha256').update(JSON.stringify(actions)).digest('hex')

/** Full owner-facing description, also used by the plan CLI. */
export function planActionWords(action) {
  const uses = `${action.count} use${action.count === 1 ? '' : 's'}`
  if (action.kind === 'merge') {
    return `Merge ${action.repository} PR #${action.pr} ${action.whenGreen ? 'when green' : `at ${action.headSha}`} · ${action.changesCI ? 'CI changes approved' : 'no CI changes'} · ${uses}`
  }
  if (action.kind === 'push-default') return `Push ${action.repository} default branch ${action.branch} · ${uses}`
  if (action.kind === 'pr-elsewhere') {
    return `Write a PR in ${action.repository}${action.pr === null ? '' : ` #${action.pr}`}${action.branch === null ? '' : ` from ${action.branch}`} · ${uses}`
  }
  return `Run ${action.command}\nFolder ${action.folder}\nTarget ${action.repository} · ${action.ref} · ${uses}${action.script === null ? '' : `\nFile ${action.script.path} SHA-256 ${action.script.sha256}`}`
}

/** Check one policy operation against its approved target before counting it. */
export async function planPolicyTarget(action, command, cwd) {
  const parsed = simpleCommandWords(command)
  if ('problem' in parsed) return invalid(parsed.problem)
  const [program, noun, verb, ...args] = parsed.words
  if (action.kind === 'push-default') {
    const [spec, ...other] = args
    if (program !== 'git' || noun !== 'push' || !/^[A-Za-z0-9_][\w.-]*$/u.test(verb ?? '') ||
      spec !== action.branch && spec !== `HEAD:refs/heads/${action.branch}` || other.length > 0) {
      return invalid('Name one direct push to the approved default branch')
    }
    return { remote: verb }
  }
  if (program !== 'gh' || noun !== 'pr' || !['create', 'edit', 'merge'].includes(verb)) return invalid('Name the exact gh pr write')
  const at = args.indexOf('--repo')
  if (at === -1 || args[at + 1]?.toLowerCase() !== action.repository || args.filter(word => word === '--repo').length !== 1) {
    return invalid('Name the approved repository with --repo OWNER/NAME')
  }
  if (action.kind === 'pr-elsewhere') {
    const [pr, repoFlag, , ...options] = args
    if (verb === 'edit' && action.pr !== null && pr === String(action.pr) && repoFlag === '--repo' && options.length > 0 &&
      options.length % 2 === 0 && options.every((value, index) => index % 2 === 1 || ['--title', '--body', '--base'].includes(value))) {
      if (action.branch === null) return { remote: null }
      try {
        const found = await readGh(cwd, ['pr', 'view', String(action.pr), '--repo', action.repository, '--json', 'headRefName'])
        if (found.headRefName === action.branch) return { remote: null }
      } catch { /* Unconfirmed branches may not use the line. */ }
      return invalid('The current PR does not confirm the approved branch')
    }
    if (verb === 'create' && action.pr === null && action.branch !== null && pr === '--repo') {
      const options = args.slice(2)
      if (options.length % 2 === 0 && options.every((value, index) => index % 2 === 1 || ['--title', '--body', '--base', '--head'].includes(value)) &&
        options.filter((value, index) => index % 2 === 0 && value === '--head').length === 1 &&
        options[options.indexOf('--head') + 1] === action.branch) return { remote: null }
    }
    return invalid('The proposed PR write differs from the approved branch or PR')
  }
  if (action.kind !== 'merge' || verb !== 'merge' || args[0] !== String(action.pr)) return invalid('The PR differs from the approved target')
  const head = args[4]
  if (args.length !== 6 || args[1] !== '--repo' || args[3] !== '--match-head-commit' || !SHA.test(head ?? '') ||
    !['--merge', '--squash', '--rebase'].includes(args[5])) return invalid('Name the approved PR, repository, exact head and merge method')
  if (action.headSha !== null && head !== action.headSha) return invalid('The merge head differs from the approved commit')
  try {
    const read = list => readGh(cwd, list)
    const pr = await read(['pr', 'view', String(action.pr), '--repo', action.repository, '--json', 'headRefOid,state,files'])
    if (pr.headRefOid !== head || pr.state !== 'OPEN' || !Array.isArray(pr.files)) return invalid('The current PR head or open state could not be confirmed')
    const paths = pr.files.map(file => file?.path)
    if (paths.some(path => typeof path !== 'string')) return invalid('The files in the current PR could not be confirmed')
    if (!action.changesCI && paths.some(path => /^\.github\/|(^|\/)(?:Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines.yml)$/u.test(path))) {
      return invalid('This PR changes CI and the owner did not approve that')
    }
    const checks = await read(['pr', 'checks', String(action.pr), '--repo', action.repository, '--required', '--json', 'bucket,state'])
    if (!Array.isArray(checks) || checks.length === 0 || !checks.every(check => check.state === 'SUCCESS' && check.bucket === 'pass')) {
      return invalid('The current PR must have green required checks')
    }
  } catch { return invalid('GitHub could not confirm the current head, files and required checks') }
  return { remote: null }
}
