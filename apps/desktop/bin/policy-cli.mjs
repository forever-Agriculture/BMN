// MODULE: policy-cli.mjs - `bmn policy`: the owner's push and merge policy as an agent reads it before each push, merge or PR write (Story 83.3)
//
// The stored policy comes from BMN through the control socket (read by any scope, written by none); the repository's owner
// and default branch come from GitHub through the agent's own `gh`, each signed-in account in turn, read at this call, so a
// renamed or transferred repository counts as its real owner's. Nothing here allows anything by itself: the agents follow what it prints (Epic 83, R83-FR1).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { planActionWords } from './plan-actions.mjs'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 8_000

/** The words of each level; control-cli.test.ts fails when they differ from @bmn/protocol's PUSH_LEVEL_WORDS. */
export const LEVEL_WORDS = Object.freeze({ 'prs-only': 'PRs only', 'merge-when-green': 'Merge when green', 'merge-and-push-main': 'Merge and push main' })

const POLICY_USAGE = `Usage: bmn policy [--repo OWNER/NAME] [--json]

The owner's push and merge policy (Epic 83), read before each push, merge and pull-request write.
Without --repo it reads the checkout's GitHub remote (origin), if there is one. It prints whether the
policy authorizes anything and why not, the repository's level and default branch, what that level
lets you do without asking, and what still asks. The owner changes it only in BMN Health. While he
is away, the merges and pushes he granted for the night in that repository, and each exact command and
message he granted, follow the level's lines (bmn grant --help); they raise no level.`

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
const REPOSITORY = /^([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9._-]{1,100})$/

function repositoryName(value) {
  const lower = String(value).toLowerCase().replace(/\.git$/, '')
  return REPOSITORY.test(lower) ? lower : null
}

/** The same remote forms as @bmn/protocol's githubRepositoryFromRemote. */
export function remoteRepository(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|git@[A-Za-z0-9._-]*github[A-Za-z0-9._-]*:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? repositoryName(`${match[1]}/${match[2]}`) : null
}

async function checkoutRepository() {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { timeout: TIMEOUT_MS, encoding: 'utf8' })
    return remoteRepository(stdout)
  } catch {
    return null
  }
}

/** The accounts signed in with `gh`, spelled as `gh` spells them (its token lookup matches the name exactly). */
async function signedInAccounts(env) {
  let text
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: TIMEOUT_MS, encoding: 'utf8', env })
    text = `${stdout}\n${stderr}`
  } catch (error) {
    // `gh auth status` exits 1 when any one account's token is invalid, and still lists the others.
    text = `${typeof error?.stdout === 'string' ? error.stdout : ''}\n${typeof error?.stderr === 'string' ? error.stderr : ''}`
  }
  return [...text.matchAll(/Logged in to github\.com account ([A-Za-z0-9-]+)/g)].map((match) => match[1]).filter((account) => LOGIN.test(account.toLowerCase()))
}

/** Read with the active gh account, then each other signed-in account. Tokens stay in child environments. */
export async function readWithGithubAccounts(read) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
  try { return await read(env) } catch { /* another signed-in account may see it */ }
  for (const account of await signedInAccounts(env)) {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token', '--user', account], { timeout: TIMEOUT_MS, encoding: 'utf8', env })
      if (stdout.trim()) return await read({ ...env, GH_TOKEN: stdout.trim() })
    } catch { /* the next account */ }
  }
  return null
}

/** The repository and default branch as GitHub names them, including its upstream when it is a fork. */
export async function githubFacts(repository) {
  const checked = await readWithGithubAccounts(async env => {
    const { stdout } = await execFileAsync('gh', ['repo', 'view', repository, '--json', 'owner,defaultBranchRef,name,isFork,parent'], {
      timeout: TIMEOUT_MS, encoding: 'utf8', env
    })
    const value = JSON.parse(stdout)
    const owner = typeof value?.owner?.login === 'string' && LOGIN.test(value.owner.login.toLowerCase()) ? value.owner.login.toLowerCase() : null
    const branch = typeof value?.defaultBranchRef?.name === 'string' && value.defaultBranchRef.name !== '' ? value.defaultBranchRef.name : null
    const name = typeof value?.name === 'string' ? value.name.toLowerCase() : null
    if (owner === null || branch === null || name === null) return { unread: 'GitHub did not name the owner or the default branch' }
    const parent = value.parent == null ? null : repositoryName(value.parent.nameWithOwner ?? `${value.parent.owner?.login}/${value.parent.name}`)
    return { repository: `${owner}/${name}`, owner, defaultBranch: branch, ...(parent !== null ? { parent } : value.isFork === true ? { upstreamUnread: true } : {}) }
  })
  return checked ?? { unread: 'GitHub could not be read for this repository with your gh' }
}

/** What one repository's level lets an agent do without asking, when the policy authorizes it there. */
function mayWords(level, branch) {
  const words = [`push branches other than ${branch}, never forced and never deleting a branch or tag`, 'create, edit, mark ready and comment on pull requests, with no label or comment that triggers a deployment or a bot']
  if (level !== 'prs-only') words.push('merge a pull request whose current head has every required check green (at least one), with no --admin, --auto or --delete-branch')
  if (level === 'merge-and-push-main') words.push(`push ${branch}, never forced, once the work passed its acceptance`)
  return words
}

/** The policy for one repository: its level, and whether the policy authorizes anything there and why not. */
export function repositoryVerdict(status, asked, facts) {
  if ('unread' in facts) {
    return { repository: asked, owner: null, defaultBranch: null, level: 'prs-only', authorizes: false, why: facts.unread }
  }
  const stored = status.state === 'read' ? status.levels.find((entry) => entry.repository === facts.repository)?.level : undefined
  const level = stored ?? 'prs-only'
  const base = { repository: facts.repository, owner: facts.owner, defaultBranch: facts.defaultBranch, level }
  if (!status.standing.authorizes) return { ...base, authorizes: false, why: status.standing.why }
  if (!status.allowed.includes(facts.owner)) return { ...base, authorizes: false, why: `the owner ${facts.owner} is not allowed in Health` }
  return { ...base, authorizes: true, why: null, ...(stored === undefined ? { note: 'not raised in Health, so PRs only' } : {}) }
}

/** The night's granted merges and pushes in the repository asked about (Story 84.9); none without a grant. */
function grantedHere(status, verdict) {
  if (verdict === null || !Array.isArray(status.granted)) return []
  // A command or a message belongs to no repository (Story 103.3 AC4), so every repository's output lists it.
  return status.granted.filter((entry) => entry.repository === verdict.repository || entry.repository === null)
}

function epicHere(status, verdict, asked) {
  if (!status.epic) return null
  if (!status.epic.binding) return { binding: null, actions: [] }
  const { binding } = status.epic
  const actions = status.epic.actions.filter(action => action.repository === asked).map(action => {
    const reason = verdict?.defaultBranch === null || !verdict ? 'GitHub could not confirm the repository'
      : verdict.repository !== asked ? 'GitHub names a different repository'
        : action.kind === 'push-default' && action.branch !== verdict.defaultBranch ? 'The approved branch is no longer the default'
          : null
    return { ...action, ...(reason === null ? {} : { unavailable: reason }) }
  })
  return { binding, actions }
}

function describePolicy(status, verdict, asked) {
  const lines = []
  lines.push(status.standing.authorizes ? `Push policy: in force (revision ${status.revision}).` : `Push policy: authorizes nothing: ${status.standing.why}.`)
  if (status.state === 'read') {
    lines.push(`Allowed owners: ${status.allowed.length === 0 ? 'none' : status.allowed.join(', ')}`)
    if (status.levels.length > 0) lines.push(`Raised repositories: ${status.levels.map((entry) => `${entry.repository} ${LEVEL_WORDS[entry.level]}`).join('; ')}`)
  }
  if (status.state === 'read' && asked) {
    // Epic 132 D3: an approved epic or night action is let through only where his rule says it deploys nothing.
    const rule = (status.deploys ?? []).find((entry) => entry.repository === (verdict?.repository ?? asked))
    lines.push(`Deploy rule for ${verdict?.repository ?? asked}: ${rule === undefined ? 'not set in Health, so every action BMN holds there stays held'
      : rule.events.length === 0 ? 'nothing deploys' : `deploys on ${rule.events.join(', ')}; an action that sets one of these off stays held`}.`)
  }
  const epic = epicHere(status, verdict, asked)
  if (epic?.binding) {
    lines.push(`Bound to Epic ${epic.binding.epic}, go ${epic.binding.go.slice(0, 12)}.`)
    if (epic.actions.length > 0) {
      lines.push(`Allowed for Epic ${epic.binding.epic}:`)
      for (const action of epic.actions) {
        const reason = action.unavailable ? ` · unavailable: ${action.unavailable}` : ''
        lines.push(`- ${action.id}: ${planActionWords(action)} · ${action.remaining} left${reason}`)
      }
      lines.push('- Reserve the exact operation with bmn run reserve, then pass the same action, use id and command to bmn run dispatch.')
    }
  } else if (epic) lines.push('This session has no epic binding.')
  if (verdict !== null) {
    const branch = verdict.defaultBranch === null ? '' : ` (default branch ${verdict.defaultBranch})`
    lines.push(`Repository ${verdict.repository}: ${LEVEL_WORDS[verdict.level]}${branch}${verdict.note ? `, ${verdict.note}` : ''}.`)
    if (verdict.authorizes) {
      lines.push('Without asking you may:', ...mayWords(verdict.level, verdict.defaultBranch).map((line) => `- ${line}`))
    } else {
      if (epic?.actions.some(action => !action.unavailable && action.remaining > 0)) {
        lines.push(`Standing policy does not authorize this repository: ${verdict.why}. Other pushes, merges and pull-request writes ask the owner.`)
      } else {
        lines.push(`Not authorized here: ${verdict.why}. Every push, merge and pull-request write asks the owner.`)
      }
    }
    const granted = grantedHere(status, verdict)
    if (granted.length > 0) {
      lines.push(`Granted by the owner for the night, on his card in BMN (until he is back; for that run and target only; it raises no level):`)
      for (const entry of granted) {
        const night = entry.night ? `; Epic ${entry.night.epic}, answered ${entry.night.source === 'app' ? 'in BMN' : 'on Telegram'} at ${entry.night.at}, expires on Back` : ''
        lines.push(`- run ${entry.runId} (${entry.title}), item ${entry.item}: ${entry.words}; ${entry.left} of ${entry.count} left${night}`)
      }
      lines.push('- for each: read bmn grant --run <run> and record the use first; no admin bypass; a PR that changes CI or workflows, or deploys, still asks')
    }
  }
  lines.push('Still asks the owner:', ...status.stillAsks.map((line) => `- ${line}`))
  return lines.join('\n')
}

/**
 * `bmn policy [--repo OWNER/NAME] [--json]`. Exit 0 when the policy was read, 1 when BMN could not be reached (then nothing
 * is authorized), 2 on a usage error.
 */
export async function runPolicyCommand(argv, { readCredentials, call }) {
  const options = { json: false, repo: undefined }
  const credentials = {}
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--json') options.json = true
    else if (word === '--help' || word === '-h') { process.stdout.write(`${POLICY_USAGE}\n`); return 0 }
    else if (word === '--owner') credentials.owner = true
    else if (word === '--repo' || word === '--socket' || word === '--token-file') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) return usage(`${word} needs a value`)
      if (word === '--repo') options.repo = value
      else credentials[word.slice(2)] = value
      index += 1
    } else return usage(`policy does not accept ${word.slice(0, 40)}${word.startsWith('-') ? '' : ' (it changes only in BMN Health)'}`)
  }
  let asked
  if (options.repo !== undefined) {
    asked = repositoryName(options.repo)
    if (asked === null) return usage('--repo must be OWNER/NAME')
  } else asked = await checkoutRepository()
  let status
  try {
    const { socketPath, token } = readCredentials(credentials)
    status = await call(socketPath, token, 'policy.status', {})
  } catch (error) {
    process.stderr.write(`bmn: the push policy could not be read (${error instanceof Error ? error.message : String(error)}); it authorizes nothing, so every push, merge and pull-request write asks the owner\n`)
    return 1
  }
  const verdict = asked === null ? null : repositoryVerdict(status, asked, await githubFacts(asked))
  // Without a grant here the output is as before Story 84.9: the night's list joins only when it names this repository.
  const policy = { ...status }
  delete policy.granted
  delete policy.epic
  const granted = grantedHere(status, verdict)
  const epic = epicHere(status, verdict, asked)
  const json = { ...policy, repository: verdict, ...(granted.length > 0 ? { granted } : {}), ...(epic ? { epic } : {}) }
  process.stdout.write(`${options.json ? JSON.stringify(json, null, 2) : describePolicy(status, verdict, asked)}\n`)
  return 0
}

function usage(message) {
  process.stderr.write(`bmn: ${message}\n${POLICY_USAGE}\n`)
  return 2
}
