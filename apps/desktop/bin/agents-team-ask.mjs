// MODULE: agents-team-ask.mjs - Epic 72: one teammate's ask made ready to start: the teammate chosen, every input read, scanned and its consent decided before anything is copied, the run's folder built, the command built and judged
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAMES, agentState, publicOnlyReasons } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { askConsent, askRequest, evaluateAsk, expectedDestination, harnessVersion, teamRunsDirectory, workspaceRoot, workspaceVisibility, askStandingWords } from './agents-check.mjs'
import { ASK_ACCESS, ASK_APPS, ASK_RUN_FILES, appSearchPath, askArgv, askProgram } from './agents-team-forms.mjs'
import { INSIDE } from './agents-container.mjs'
import { InputRefusal, LIMITS, askProject, checkQuestion, freezeProject, sha256Of, textFile, workingTreeRoot } from './agents-team-inputs.mjs'
import { AskRefusal, resolveTeammate } from './agents-team-resolve.mjs'

/**
 * Making an ask ready follows one order, so that nothing is copied before it is allowed: the
 * question and each file are read and scanned (R72-NFR5), the project is named, the teammate is
 * chosen by the resolver with each candidate's consent for these very inputs decided first
 * (R72-NFR6), and only then is the run's folder built: the files' text in the prompt, the frozen
 * project with its history, the run's own app home. The command for it is built and judged by the
 * check's ask mode; Story 72.3 starts exactly that command.
 */

const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{8}$/
const here = dirname(fileURLToPath(import.meta.url))

/** A run's id: when it was made (UTC, to the second) and eight random hex digits. */
export function askRunId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(4).toString('hex')}`
}

/** A usage problem of an ask (exit 2), as the contract's exit codes say. */
export class AskUsageError extends Error {}

/** The request an earlier run kept, for a recheck: `{ role, project, agent }`, or null when that run is gone. */
export function earlierRun(id, runs = teamRunsDirectory()) {
  if (!RUN_ID.test(id)) throw new AskRefusal('RECHECK_INVALID', `${id} is not the id of an ask`)
  try {
    const request = JSON.parse(readFileSync(join(runs, id, ASK_RUN_FILES.request), 'utf8'))
    if (typeof request.role !== 'string' || typeof request.agent !== 'string') return null
    return { role: request.role, project: request.project ?? null, agent: request.agent }
  } catch {
    return null
  }
}

/** The prompt of a file ask: the question, then each file whole, with its path and hash. */
export function filePrompt(question, files) {
  if (files.length === 0) return question
  const parts = [question, '', `The asker gave you ${files.length === 1 ? 'this file' : `these ${files.length} files`}, each whole between its BEGIN and END lines.`]
  files.forEach((file, index) => {
    const name = `${index + 1}/${files.length}`
    parts.push('', `===== BEGIN FILE ${name}: ${file.label} (sha256 ${file.sha256}, ${file.bytes.length} bytes) =====`, file.bytes.toString('utf8').replace(/\n$/u, ''), `===== END FILE ${name} =====`)
  })
  return `${parts.join('\n')}\n`
}

/** The prompt of a project ask: the question and where the project is. */
export function projectPrompt(question, frozen, root) {
  const changed = frozen.files.filter((file) => file.changed !== null).length
  return `${question}\n\nThe project is in your working folder (${INSIDE.project}), read-only: a frozen copy of ${root.split('/').pop()} at commit ${frozen.revision.slice(0, 12)}${frozen.public_commit === null ? '' : ' (its public commit)'}, ${frozen.files.length} files, with its Git history (git log, git show, git diff and git blame answer)${changed === 0 ? '' : `; ${changed} file(s) changed since that commit show as uncommitted changes`}.\n`
}

function writePrivate(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode })
}

/**
 * Makes one ask ready. `request`: `{ role, question, agent, effort, smallWork, recheckOf, project,
 * access, files, data, wide }` as the asker gave them, `cwd` the asking session's folder.
 * Returns `{ id, folder, choice, verdict, argv, stdin }`, `verdict` the check's answer for the
 * command; a refusal before the folder exists throws AskRefusal, InputRefusal or AskUsageError.
 */
export function prepareAsk(request, { environment = process.env, cwd = process.cwd(), home = environment.HOME ?? homedir(), now = new Date(), runs = teamRunsDirectory(), id = askRunId(now), contextTestLog = undefined } = {}) {
  const access = request.access ?? 'question'
  const files = request.files ?? []
  if (!ASK_ACCESS.includes(access)) throw new AskUsageError(`--access takes question, files or project, not ${access}`)
  if (access === 'question' && files.length > 0) throw new AskUsageError('--file goes with --access files or --access project')
  if (access === 'files' && files.length === 0) throw new AskUsageError('--access files needs at least one --file')
  if (files.length > LIMITS.files) throw new InputRefusal('INPUT_TOO_LARGE', `${files.length} files, over the limit of ${LIMITS.files}`)
  if (request.data !== undefined && request.data !== 'public') throw new AskUsageError('--data takes only public; without it the ask is private')
  if (request.wide === true) throw new AskRefusal('WIDE_READ_NOT_ENABLED', 'the owner has not enabled a wider-read mode for any app in the Team view')
  const label = request.data === 'public' ? 'public' : 'private'

  // Everything the asker gave is read and scanned before anything else happens.
  const question = checkQuestion(request.question)
  const texts = files.map((path) => textFile(path, { cwd, home }))
  const promptBytes = Buffer.byteLength(request.question) + texts.reduce((sum, file) => sum + file.bytes.length, 0)
  if (promptBytes > LIMITS.prompt) throw new InputRefusal('INPUT_TOO_LARGE', `the question and the files' text are ${Math.round(promptBytes / 1024)} KiB together, over the limit of ${LIMITS.prompt / 1024 / 1024} MiB`)
  const project = askProject(request.project, { cwd, home })
  if (access === 'project') {
    if (project === null) throw new InputRefusal('PROJECT_INVALID', 'a project ask needs a project: name it with --project, or ask from inside its repository')
    if (workingTreeRoot(project) !== project) throw new InputRefusal('PROJECT_INVALID', `${project} is not a Git working tree's top folder; to give it files, ask with --access files and --file`)
    const outside = texts.find((file) => relative(project, file.real).startsWith('..'))
    if (outside !== undefined) throw new InputRefusal('INPUT_INVALID', `${outside.path} is outside the project ${project}; files from elsewhere go with --access files`)
  }

  // Each input with the folder it comes from: the consent of a folder exception counts only inside it (R72-NFR6).
  const cwdRoot = workspaceRoot(cwd)
  const inputs = [{ kind: 'question', label: 'the question', root: project !== null && cwdRoot === project ? project : null }]
  for (const file of texts) {
    const root = workspaceRoot(dirname(file.real))
    inputs.push({ kind: 'file', label: file.path, root, relative: relative(root, file.real), sha256: file.sha256 })
  }
  let publicCommit = null
  if (access === 'project') {
    if (label === 'public') {
      const visibility = workspaceVisibility(project, now)
      if (!visibility.public) throw new AskRefusal('PUBLIC_NOT_VERIFIED', `${project} is not proven public (${visibility.reason}); run bmn roster visibility --refresh`)
      publicCommit = visibility.record.commit
    }
    inputs.push({ kind: 'project', label: `the project ${project}`, root: project, public_commit: publicCommit })
  }

  // The teammate, judged for these inputs.
  const generation = readApproved()
  const data = generation.data
  const versions = new Map()
  const versionOf = (harness) => {
    if (!versions.has(harness)) {
      const program = askProgram(harness, environment)
      versions.set(harness, program === null ? null : { program, version: harnessVersion(program.launcher, { PATH: appSearchPath(environment), HOME: environment.HOME ?? '' }) })
    }
    return versions.get(harness)
  }
  const standing = (agent) => {
    if (!ASK_APPS.includes(agent.harness)) return `runs on ${APP_NAMES[agent.harness] ?? agent.harness}, whose teammates are not asked through BMN yet`
    const installed = versionOf(agent.harness)
    if (installed === null) return `runs on ${APP_NAMES[agent.harness]}, which is not installed where BMN looks`
    if (installed.version === null) return `runs on ${APP_NAMES[agent.harness]}, whose version BMN cannot read`
    const words = askStandingWords(agent.harness, installed.version, access)
    return words === null ? 'proven' : `cannot answer here: ${words}`
  }
  const allowed = (agent) => {
    try {
      // A private ask needs the agent's destination to allow it for every input; a public one is verified as R72-NFR5 says.
      if (label === 'private' && publicOnlyReasons(agent, data).length === 0) return { allowed: true }
      askConsent(data, expectedDestination(data, agent), inputs, label, now)
      return { allowed: true }
    } catch (error) {
      if (error?.code === 'PRIVATE_NOT_ALLOWED' || error?.code === 'PUBLIC_NOT_VERIFIED') return { allowed: false, reason: error.message, code: error.code }
      throw error
    }
  }
  const recheck = request.recheckOf === undefined ? undefined : { id: request.recheckOf, run: earlierRun(request.recheckOf, runs) }
  const choice = resolveTeammate(data, { role: request.role, agent: request.agent, effort: request.effort, smallWork: request.smallWork === true, recheck },
    { project, standing, allowed, projectChoice: () => null })
  // A teammate the data may not reach is refused for that reason: the asker's data decides, not who else is on the team.
  const consent = allowed(choice.agent)
  if (!consent.allowed) throw new AskRefusal(consent.code, consent.reason)
  if (agentState(choice.agent) !== 'active') throw new AskRefusal('AGENT_NOT_ELIGIBLE', `${choice.agent.id} is ${agentState(choice.agent)}`)

  // Only now is anything copied: the run's folder, its inputs and its app home.
  const folder = join(runs, id)
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  mkdirSync(folder, { mode: 0o700 })
  const run = { home: join(folder, ASK_RUN_FILES.home), inputs: join(folder, ASK_RUN_FILES.inputs), project: join(folder, ASK_RUN_FILES.project) }
  mkdirSync(run.home, { mode: 0o700 })
  mkdirSync(run.inputs, { mode: 0o700 })
  const installed = versionOf(choice.agent.harness)
  let frozen = null
  let prompt
  if (access === 'project') {
    frozen = freezeProject(project, run.project, { extraFiles: texts, publicCommit })
    writePrivate(join(folder, ASK_RUN_FILES.objects), `${frozen.history.objects}\n`)
    // The one git a project ask may run: log, show, diff and blame of the frozen copy (72.1 AC1).
    if (choice.agent.harness === 'claude') writePrivate(join(run.inputs, 'bin/git'), readFileSync(join(here, 'ask-git.sh')), 0o755)
    prompt = projectPrompt(request.question, frozen, project)
  } else {
    // A file of the project is named by its path in it; any other by the path the asker gave.
    prompt = filePrompt(request.question, texts.map((file) => ({ ...file, label: project !== null && !relative(project, file.real).startsWith('..') ? relative(project, file.real) : file.path })))
  }
  writePrivate(join(folder, ASK_RUN_FILES.prompt), prompt)
  const manifest = {
    version: 1, id, access, data: label,
    question: { bytes: question.bytes, sha256: question.sha256 },
    inputs,
    files: texts.map((file) => ({ path: file.path, real: file.real, bytes: file.bytes.length, sha256: file.sha256 })),
    project: frozen === null ? null : {
      root: frozen.root, revision: frozen.revision, head: frozen.head, public_commit: frozen.public_commit,
      files: frozen.files, history: { commits: frozen.history.commits, shallow: frozen.history.shallow, counts: frozen.history.counts, objects_sha256: frozen.history.objects_sha256 }
    },
    pictures: [],
    prompt_sha256: sha256Of(Buffer.from(prompt))
  }
  writePrivate(join(folder, ASK_RUN_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`)
  writePrivate(join(folder, ASK_RUN_FILES.request), `${JSON.stringify({
    version: 1, id, role: request.role, agent: choice.agent.id, effort: choice.effort, chosen_by: choice.rule, phase: choice.phase,
    project, access, data: label, ...(request.recheckOf === undefined ? {} : { recheck_of: request.recheckOf }), asked_at: now.toISOString()
  }, null, 2)}\n`)

  const built = askRequest(choice.agent, installed.version, { access, effort: choice.effort, rules: null, pictures: [], contextTestLog })
  const { argv, form } = askArgv(choice.agent.harness, installed.program, run, built, environment)
  // The run's own app home: what the form names, and the empty files the sign-in is bound onto.
  for (const [path, text] of Object.entries(form.home)) writePrivate(join(run.home, path), text)
  for (const path of form.mountPoints) writePrivate(join(run.home, path), '')
  const verdict = evaluateAsk({ agent: choice.agent.id, role: request.role, effort: choice.effort, access, data: label, wide: request.wide === true, run: folder, argv },
    { environment, now, program: installed.program, version: installed.version, contextTestLog })
  return { id, folder, choice: { agent: choice.agent.id, effort: choice.effort, rule: choice.rule, phase: choice.phase }, verdict, argv, stdin: form.stdin, manifest }
}
