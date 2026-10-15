// MODULE: agents-team-ask.mjs - Epic 72: one teammate's ask made ready to start: the teammate chosen, every input read, scanned and its consent decided before anything is copied, the run's folder built, the command built and judged
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAMES, agentState, projectChoiceFor, publicOnlyReasons } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { askConsent, askRequest, evaluateAsk, expectedDestination, harnessVersion, teamRunsDirectory, workspaceRoot, workspaceVisibility, askStandingWords } from './agents-check.mjs'
import { ASK_ACCESS, ASK_APPS, ASK_RUN_FILES, appSearchPath, askArgv, askProgram, claudePictureMessage, executableIdentity, signInBind } from './agents-team-forms.mjs'
import { readMaster, render } from './agents-rules.mjs'
import { openCodeFolders } from './agents-opencode.mjs'
import { askerOf } from './agents-ask.mjs'
import { INSIDE } from './agents-container.mjs'
import { InputRefusal, LIMITS, askProject, checkQuestion, freezeProject, mainWorktree, sha256Of, textFile, workingTreeRoot } from './agents-team-inputs.mjs'
import { AskRefusal, resolveTeammate } from './agents-team-resolve.mjs'
import { pictureFile } from './agents-team-pictures.mjs'
import { TREE_FILE, runTree } from './agents-team-tree.mjs'

/**
 * Making an ask ready follows one order, so that nothing is copied before it is allowed: the
 * question and each file are read and scanned (R72-NFR5), the project is named, the teammate is
 * chosen by the resolver with each candidate's consent for these very inputs decided first
 * (R72-NFR6), and only then is the run's folder built: the files' text in the prompt, the frozen
 * project with its history, the run's own app home. The command for it is built and judged by the
 * check's ask mode; Story 72.3 starts exactly that command.
 */

const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{8}$/
const PICTURE_EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })
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

/**
 * The prompt of a project ask: the question, where the project is, and that its history is there to be read. The last
 * sentence is 72.6 AC2's repair: in the gate a reviewer listed the log and judged a change without opening the commit
 * that had reverted it, so a project ask now says to read the commits behind what it judges.
 */
export function projectPrompt(question, frozen, root) {
  const changed = frozen.files.filter((file) => file.changed !== null).length
  return `${question}\n\nThe project is in your working folder (${INSIDE.project}), read-only: a frozen copy of ${root.split('/').pop()} at commit ${frozen.revision.slice(0, 12)}${frozen.public_commit === null ? '' : ' (its public commit)'}, ${frozen.files.length} files, with its Git history (git log, git show, git diff and git blame answer)${changed === 0 ? '' : `; ${changed} file(s) changed since that commit show as uncommitted changes`}. The history can say why the code is as it is: before you judge code, read the commits behind it (git log -p or git blame on the lines in question, then git show).\n`
}

/** A prompt with the pictures named in the order they are attached: by label, type and size, never by what was taken out of them. */
export function picturePrompt(prompt, pictures) {
  if (pictures.length === 0) return prompt
  const lines = pictures.map((picture, index) => `${index + 1}. ${picture.label} (${picture.media_type.slice(6).toUpperCase()}, ${picture.width}x${picture.height})`)
  return `${prompt.replace(/\n?$/u, '\n')}\nThe asker gave you ${pictures.length === 1 ? 'this picture' : `these ${pictures.length} pictures`}, attached as ${pictures.length === 1 ? 'an image' : 'images in this order'}:\n${lines.join('\n')}\n`
}

/** The owner's global rules for an app as BMN generates them, or null when there is no rules master. */
export function instructionRules(harness, generation) {
  try {
    return render(readMaster(), harness, generation).text
  } catch {
    return null
  }
}

function writePrivate(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode })
}

/**
 * Makes one ask ready. `request`: `{ role, question, agent, effort, smallWork, recheckOf, project,
 * access, files, images, data, wide }` as the asker gave them, with the reservation's `{ key, keyScope,
 * requestSha256, askedBy }` (72.4), `cwd` the asking session's folder.
 * Returns `{ id, folder, choice, verdict, argv, stdin }`, `verdict` the check's answer for the
 * command; a refusal before the folder exists throws AskRefusal, InputRefusal or AskUsageError.
 */
export function prepareAsk(request, { environment = process.env, cwd = process.cwd(), home = environment.HOME ?? homedir(), now = new Date(), runs = teamRunsDirectory(), id = askRunId(now), contextTestLog = undefined } = {}) {
  const access = request.access ?? 'question'
  const files = request.files ?? []
  const images = request.images ?? []
  if (!ASK_ACCESS.includes(access)) throw new AskUsageError(`--access takes question, files or project, not ${access}`)
  if (access === 'question' && files.length > 0) throw new AskUsageError('--file goes with --access files or --access project')
  if (access === 'files' && files.length === 0) throw new AskUsageError('--access files needs at least one --file')
  if (files.length > LIMITS.files) throw new InputRefusal('INPUT_TOO_LARGE', `${files.length} files, over the limit of ${LIMITS.files}`)
  // A picture is image input to a teammate with no tool that reads a file; a project names whose pictures they are and grants no other reads (72.8 AC1).
  if (images.length > 0 && access === 'project') throw new AskUsageError('--image goes with --access question or files: a picture ask gives the teammate no tool that reads the project; ask about the project in an ask of its own')
  if (images.length > LIMITS.pictures) throw new InputRefusal('INPUT_TOO_LARGE', `${images.length} pictures, over the limit of ${LIMITS.pictures}`)
  if (request.data !== undefined && request.data !== 'public') throw new AskUsageError('--data takes only public; without it the ask is private')
  if (request.wide === true) throw new AskRefusal('WIDE_READ_NOT_ENABLED', 'the owner has not enabled a wider-read mode for any app in the Team view')
  const label = request.data === 'public' ? 'public' : 'private'

  // Everything the asker gave is read and scanned before anything else happens.
  const question = checkQuestion(request.question)
  const texts = files.map((path) => textFile(path, { cwd, home }))
  const promptBytes = Buffer.byteLength(request.question) + texts.reduce((sum, file) => sum + file.bytes.length, 0)
  if (promptBytes > LIMITS.prompt) throw new InputRefusal('INPUT_TOO_LARGE', `the question and the files' text are ${Math.round(promptBytes / 1024)} KiB together, over the limit of ${LIMITS.prompt / 1024 / 1024} MiB`)
  const project = askProject(request.project, { cwd, home })
  // Each picture is read, bounded and its metadata taken out before anything else: what may leave is what is sent (72.8 AC2).
  const pictures = images.map((path) => pictureFile(path, { cwd, home }))
  // The bytes read here must be the bytes the request's hash names: a file changed after the asking command hashed
  // it is refused, never sent under a key that names other bytes (epic pre-review).
  if (request.inputHashes !== undefined) {
    const pairs = [...texts.map((file, index) => [files[index], file.sha256, request.inputHashes.files?.[index]]), ...pictures.map((picture, index) => [images[index], picture.before.sha256, request.inputHashes.images?.[index]])]
    const changed = pairs.find(([, read, hashed]) => read !== hashed)
    if (changed !== undefined) throw new InputRefusal('INPUT_CHANGED', `${changed[0]} changed while the ask was being made; nothing was sent: ask again with another key`)
  }
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
  // A picture is public only when the bytes sent are a file of the verified public commit.
  for (const picture of pictures) {
    const root = workspaceRoot(dirname(picture.real))
    inputs.push({ kind: 'picture', label: picture.path, root, relative: relative(root, picture.real), sha256: picture.sha256 })
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
    if (words !== null) return `cannot answer here: ${words}`
    // An app whose picture rows 72.1 did not pass is not asked about pictures (72.8 AC3).
    const seeing = pictures.length === 0 ? null : askStandingWords(agent.harness, installed.version, 'pictures')
    if (seeing !== null) return `cannot answer here: ${seeing}`
    // The owner's sign-in file is bound into the run, never read: without it the app cannot answer.
    const signIn = signInBind(agent.harness, environment)
    if (signIn !== null && !existsSync(signIn.from)) return `runs on ${APP_NAMES[agent.harness]}, which is not signed in on this computer (no ${signIn.from})`
    // OpenCode's run gets a copy of the OpenCode Go sign-in BMN keeps in its own folder (70.4), made at the start.
    if (agent.harness === 'opencode' && !existsSync(openCodeFolders().data)) return 'runs on OpenCode, and BMN\'s OpenCode folder holds no sign-in yet: BMN copies your OpenCode Go sign-in when you approve an OpenCode teammate in the Team view'
    return 'proven'
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
  // The owner's approved choice for the role in this project (73.2): made for the project, or for the repository a linked worktree belongs to; an ended one no longer applies.
  const projectChoice = (role) => {
    if (project === null || (data.project_choices ?? []).length === 0) return null
    const linked = mainWorktree(project)
    const found = projectChoiceFor(data, linked === null ? [project] : [project, linked], role.id, now)
    return found === null || found.ended ? null : found.choice
  }
  const choice = resolveTeammate(data, { role: request.role, agent: request.agent, effort: request.effort, smallWork: request.smallWork === true, recheck },
    { project, standing, allowed, projectChoice })
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
  // Each file is copied into the run as it was read and scanned.
  const copies = texts.map((file, index) => {
    const copy = `${ASK_RUN_FILES.files.slice(ASK_RUN_FILES.inputs.length + 1)}/${index + 1}-${basename(file.real)}`
    writePrivate(join(run.inputs, copy), file.bytes)
    return copy
  })
  // Each picture as it is sent, named by its place: the asker's file name stays in the record, not in the container.
  const pictureCopies = pictures.map((picture, index) => {
    const copy = `${ASK_RUN_FILES.pictures.slice(ASK_RUN_FILES.inputs.length + 1)}/${index + 1}.${PICTURE_EXTENSIONS[picture.media_type]}`
    writePrivate(join(run.inputs, copy), picture.bytes)
    return copy
  })
  if (access === 'project') {
    frozen = freezeProject(project, run.project, { extraFiles: texts, publicCommit })
    // The one git a project ask may run: log, show, diff and blame of the frozen copy (72.1 AC1).
    if (choice.agent.harness === 'claude') writePrivate(join(run.inputs, 'bin/git'), readFileSync(join(here, 'ask-git.sh')), 0o755)
    writePrivate(join(folder, ASK_RUN_FILES.projectManifest), `${JSON.stringify({ version: 1, ...frozen }, null, 2)}\n`)
    prompt = projectPrompt(request.question, frozen, project)
  } else {
    // A file of the project is named by its path in it; any other by the path the asker gave.
    const named = (file) => project !== null && !relative(project, file.real).startsWith('..') ? relative(project, file.real) : file.path
    prompt = picturePrompt(filePrompt(request.question, texts.map((file) => ({ ...file, label: named(file) }))), pictures.map((picture) => ({ ...picture, label: named(picture) })))
  }
  writePrivate(join(folder, ASK_RUN_FILES.prompt), prompt)
  // The question alone, as the asker wrote it, for the record and Team › Asks (73.1); the prompt above is what is sent.
  writePrivate(join(folder, ASK_RUN_FILES.question), request.question)
  // The instruction inputs: a private ask carries the owner's global rules for that app as BMN generates them; a public one none.
  const rules = label === 'private' ? instructionRules(choice.agent.harness, generation) : null
  if (rules !== null) writePrivate(join(folder, ASK_RUN_FILES.rules), rules)
  const manifest = {
    version: 1, id, access, data: label,
    question: { bytes: question.bytes, sha256: question.sha256 },
    inputs,
    files: texts.map((file, index) => ({ path: file.path, real: file.real, copy: copies[index], bytes: file.bytes.length, sha256: file.sha256 })),
    project: frozen === null ? null : {
      root: frozen.root, revision: frozen.revision, head: frozen.head, public_commit: frozen.public_commit, files: frozen.files.length,
      files_sha256: sha256Of(Buffer.from(JSON.stringify(frozen.files))), history: { commits: frozen.history.commits.length, shallow: frozen.history.shallow, counts: frozen.history.counts, objects_sha256: frozen.history.objects_sha256 },
      // The project's own instruction files, as an app reads them in the frozen copy.
      instructions: frozen.files.filter((file) => file.kind === 'file' && /(^|\/)(CLAUDE|AGENTS)\.md$/u.test(file.path)).map((file) => ({ path: file.path, sha256: file.sha256 }))
    },
    rules: rules === null ? null : { sha256: sha256Of(Buffer.from(rules)), bytes: Buffer.byteLength(rules) },
    // Each picture with its hashes before and after and what was taken out and kept, by name (72.8 AC2).
    pictures: pictures.map((picture, index) => ({
      label: picture.path, real: picture.real, copy: pictureCopies[index], media_type: picture.media_type, width: picture.width, height: picture.height,
      before: picture.before, bytes: picture.bytes.length, sha256: picture.sha256, removed: picture.removed, kept: picture.kept
    })),
    prompt_sha256: sha256Of(Buffer.from(prompt))
  }
  writePrivate(join(folder, ASK_RUN_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`)
  writePrivate(join(folder, ASK_RUN_FILES.request), `${JSON.stringify({
    version: 1, id, role: request.role, agent: choice.agent.id, model: choice.agent.model, provider: choice.agent.provider, aliases: choice.agent.aliases ?? [], effort: choice.effort, chosen_by: choice.rule, phase: choice.phase, ...(choice.choice === undefined ? {} : { project_choice: choice.choice }),
    billing: choice.agent.paid_by ?? 'unknown', project, access, data: label, ...(request.recheckOf === undefined ? {} : { recheck_of: request.recheckOf }),
    // The retry key, whose it is and the request's hash (72.4): a retry with the same three finds this run.
    ...(request.key === undefined ? {} : { key: request.key, key_scope: request.keyScope, request_sha256: request.requestSha256 }),
    asked_by: request.askedBy ?? askerOf(environment), asked_at: now.toISOString()
  }, null, 2)}\n`)

  const built = askRequest(choice.agent, installed.version, { access, effort: choice.effort, rules, pictures: pictureCopies.map((copy) => `${INSIDE.inputs}/${copy}`), contextTestLog })
  const { argv, form } = askArgv(choice.agent.harness, installed.program, run, built, environment)
  // Claude Code takes its pictures as one user message on standard input, the pictures first, then the prompt.
  if (form.stdin === 'stream-json') writePrivate(join(folder, ASK_RUN_FILES.message), claudePictureMessage(pictures, prompt))
  // The run's own app home: what the form names, and the empty files the sign-in is bound onto.
  for (const [path, text] of Object.entries(form.home)) writePrivate(join(run.home, path), text)
  for (const path of form.mountPoints) writePrivate(join(run.home, path), '')
  for (const path of form.folders ?? []) mkdirSync(join(run.home, path), { recursive: true, mode: 0o700 })
  // OpenCode searches with ripgrep; a copy of the one BMN's OpenCode folder links to, so the run fetches none from the web (70.1).
  if (choice.agent.harness === 'opencode') {
    const ripgrep = join(openCodeFolders().cache, 'opencode/bin/rg')
    if (existsSync(ripgrep)) {
      mkdirSync(join(run.home, 'oc/cache/opencode/bin'), { recursive: true, mode: 0o700 })
      copyFileSync(ripgrep, join(run.home, 'oc/cache/opencode/bin/rg'))
      chmodSync(join(run.home, 'oc/cache/opencode/bin/rg'), 0o700)
    }
  }
  // The snapshots the check judges and the start uses (72.3 AC1): the app's configuration as BMN wrote it, its program, its environment once.
  for (const [path, text] of Object.entries(form.home)) writePrivate(join(folder, ASK_RUN_FILES.snapshots, 'config', path), text)
  writePrivate(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'), `${JSON.stringify(executableIdentity(installed.program), null, 2)}\n`)
  // A form that keeps the app's sign-in hosts out of reach gets its own /etc/hosts (agents-team-forms.mjs CLAUDE_ASK_HOSTS).
  if (form.hosts !== undefined) writePrivate(join(folder, ASK_RUN_FILES.snapshots, 'hosts'), form.hosts)
  writePrivate(join(folder, ASK_RUN_FILES.snapshots, 'environment.json'), `${JSON.stringify({ names: Object.keys(form.environment), sha256: sha256Of(Buffer.from(JSON.stringify(form.environment))) }, null, 2)}\n`)
  const verdict = evaluateAsk({ agent: choice.agent.id, role: request.role, effort: choice.effort, access, data: label, wide: request.wide === true, run: folder, argv },
    { environment, now, program: installed.program, version: installed.version, contextTestLog })
  if (verdict.verdict === 'PASS') {
    writePrivate(join(folder, ASK_RUN_FILES.receipt), `${JSON.stringify(verdict.receipt, null, 2)}\n`)
    // The judged manifest, beside the run's roots, so a later change names the entry that changed (agents-team-tree.mjs).
    writePrivate(join(folder, TREE_FILE), `${JSON.stringify(runTree(folder).entries)}\n`)
  }
  return { id, folder, choice: { agent: choice.agent.id, effort: choice.effort, rule: choice.rule, phase: choice.phase, ...(choice.choice === undefined ? {} : { project_choice: choice.choice }) }, verdict, argv, stdin: form.stdin, manifest, program: installed.program }
}
