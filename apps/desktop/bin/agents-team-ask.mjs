// MODULE: agents-team-ask.mjs - Epic 72: one teammate's ask made ready to start: the teammate chosen, every input read, scanned and its consent decided before anything is written, the run's folder built, the app's own read-only command built and judged
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { APP_NAMES, agentState, collisionWords, projectChoiceFor, publicOnlyReasons } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { askConsent, askRequest, evaluateAsk, expectedDestination, harnessVersion, modeInput, teamRunsDirectory, workspaceRoot } from './agents-check.mjs'
import { ASK_APPS, ASK_READS, ASK_RUN_FILES, ASK_UNSUPPORTED, appSearchPath, askCommand, askFormName, askProgram, claudePictureMessage, executableIdentity } from './agents-team-forms.mjs'
import { readMaster, render } from './agents-rules.mjs'
import { openCodeFolders } from './agents-opencode.mjs'
import { askerOf } from './agents-ask.mjs'
import { InputRefusal, LIMITS, askProject, canonicalProject, checkQuestion, sha256Of, textFile } from './agents-team-inputs.mjs'
import { AskRefusal, resolveTeammate } from './agents-team-resolve.mjs'
import { pictureFile } from './agents-team-pictures.mjs'
import { ASK_GIT } from './agents-team-run.mjs'
import { BROWSER_STATEMENT, browserInstalled, browserOrigin, browserPrompt, browserTools } from './agents-team-browser.mjs'

/**
 * Making an ask ready follows one order, so that nothing is written before it is allowed: the
 * question and each file are read and scanned (R72-NFR5), the project is named, the teammate is
 * chosen by the resolver with each candidate's consent decided first for these very inputs and for
 * what its app's own mode can read (R72-NFR6), and only then is the run's folder built: the prompt
 * with the files' text, the pictures, an empty work folder and BMN's git. The app's own read-only
 * command for it is built and judged by the check's ask mode; Story 72.3 starts exactly that command.
 */

const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{8}$/
const PICTURE_EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })

/** A run's id: when it was made (UTC, to the second) and eight random hex digits. */
export function askRunId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(4).toString('hex')}`
}

/** A usage problem of an ask (exit 2), as the contract's exit codes say. */
export class AskUsageError extends Error {}

/** What an old `--access` or `--wide-read` is told: the new spelling (72.9 AC4). */
export const ACCESS_GONE = '--access is gone: a teammate reads with its own app\'s read-only tools; name the project it works in with --project (the default is your repository) and give files with --file'
export const WIDE_READ_GONE = '--wide-read is gone: a teammate reads with its own app\'s read-only tools; name the project it works in with --project'

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

/** The prompt of an ask with files: the question, then each file whole, with its path and hash. */
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
 * Where a teammate that reads the project works, said after the question. The last sentence is 72.6
 * AC2's repair: in the gate a reviewer listed the log and judged a change without opening the commit
 * that had reverted it, so a project ask says to read the commits behind what it judges.
 */
export function projectPrompt(prompt, root) {
  return `${prompt.replace(/\n?$/u, '\n')}\nYou work in the project ${root} (your working folder), read-only, with its Git history: git log, git show, git diff and git blame answer. The history can say why the code is as it is: before you judge code, read the commits behind it (git log -p or git blame on the lines in question, then git show).\n`
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
 * files, images, data }` as the asker gave them, with the reservation's `{ key, keyScope,
 * requestSha256, askedBy }` (72.4), `cwd` the asking session's folder.
 * Returns `{ id, folder, choice, verdict, argv, cwd, stdin }`, `verdict` the check's answer for the
 * command; a refusal before the folder exists throws AskRefusal, InputRefusal or AskUsageError.
 */
export function prepareAsk(request, { environment = process.env, cwd = process.cwd(), home = environment.HOME ?? homedir(), now = new Date(), runs = teamRunsDirectory(), id = askRunId(now), contextTestLog = undefined } = {}) {
  if (request.access !== undefined) throw new AskUsageError(ACCESS_GONE)
  if (request.wide !== undefined) throw new AskUsageError(WIDE_READ_GONE)
  const files = request.files ?? []
  const images = request.images ?? []
  if (files.length > LIMITS.files) throw new InputRefusal('INPUT_TOO_LARGE', `${files.length} files, over the limit of ${LIMITS.files}`)
  if (images.length > LIMITS.pictures) throw new InputRefusal('INPUT_TOO_LARGE', `${images.length} pictures, over the limit of ${LIMITS.pictures}`)
  if (request.data !== undefined && request.data !== 'public') throw new AskUsageError('--data takes only public; without it the ask is private')
  const label = request.data === 'public' ? 'public' : 'private'
  // A browser ask (74.3): the asker's own app at a loopback origin, stated disposable, and the browser's server where npx keeps it.
  let browser = null
  if (request.browser !== undefined && request.browser !== null) {
    const origin = browserOrigin(request.browser.origin)
    if (origin.reason !== undefined) throw new InputRefusal('INPUT_INVALID', origin.reason)
    if (request.browser.disposable !== true) throw new AskRefusal('DISPOSABLE_REQUIRED', `a browser ask needs --disposable: your statement that ${BROWSER_STATEMENT}; Playwright's origin limit does not stop redirects or requests the page makes itself`)
    const ready = browserInstalled({ PATH: appSearchPath(environment), HOME: environment.HOME ?? '' })
    if (ready.reason !== undefined) throw new AskRefusal('BROWSER_UNAVAILABLE', ready.reason)
    browser = { origin: origin.origin, interact: request.browser.interact === true }
  }

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

  // Each input with the folder it comes from: the consent of a folder exception counts only inside it (R72-NFR6).
  const cwdRoot = workspaceRoot(cwd)
  const named = [{ kind: 'question', label: 'the question', root: project !== null && cwdRoot === project ? project : null }]
  for (const file of texts) {
    const root = workspaceRoot(dirname(file.real))
    named.push({ kind: 'file', label: file.path, root, relative: relative(root, file.real), sha256: file.sha256 })
  }
  // A picture is public only when the bytes sent are a file of the verified public commit.
  for (const picture of pictures) {
    const root = workspaceRoot(dirname(picture.real))
    named.push({ kind: 'picture', label: picture.path, root, relative: relative(root, picture.real), sha256: picture.sha256 })
  }
  // What the browser shows is the asker's app: private work no folder exception names (74.3).
  if (browser !== null) named.push({ kind: 'browser', label: `the app at ${browser.origin}`, root: null })
  // What a candidate's form reads besides: the project it works in, and whatever its mode reaches beyond (72.9 AC1).
  // A teammate whose provider takes public work only reads only the text its folder exceptions can cover.
  const formOf = (agent) => askFormName(agent.harness, { project, label, textOnly: publicOnlyReasons(agent, data).length > 0 })
  const inputsOf = (agent) => (project !== null && ASK_READS[formOf(agent)].scope !== 'text' ? [...named, { kind: 'project', label: `the project ${project}`, root: project }] : named)

  // The teammate, judged for these inputs and what its app's mode can read.
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
    // What an app's form does not offer stays unavailable and says why (R72-NFR12).
    if (pictures.length > 0 && ASK_UNSUPPORTED[agent.harness]?.pictures !== undefined) return `cannot answer here: ${ASK_UNSUPPORTED[agent.harness].pictures}`
    if (browser !== null && ASK_UNSUPPORTED[agent.harness]?.browser !== undefined) return `cannot answer here: ${ASK_UNSUPPORTED[agent.harness].browser}`
    // OpenCode runs in BMN's own OpenCode folder, with the OpenCode Go sign-in BMN copied there (70.4).
    if (agent.harness === 'opencode' && !existsSync(openCodeFolders().data)) return 'runs on OpenCode, and BMN\'s OpenCode folder holds no sign-in yet: BMN copies your OpenCode Go sign-in when you approve an OpenCode teammate in the Team view'
    return 'proven'
  }
  const allowed = (agent) => {
    const form = formOf(agent)
    // A teammate with tools reads beyond what the asker hands over, so its asks are private (R72-NFR5).
    if (label === 'public' && ASK_READS[form].scope !== 'text') return { allowed: false, reason: `${APP_NAMES[agent.harness]}'s own tools read beyond what you hand over, so its asks are private`, code: 'PUBLIC_NOT_VERIFIED' }
    try {
      const reading = modeInput(form, APP_NAMES[agent.harness], project)
      // A private ask needs the agent's destination to allow it for every input and for what its mode can read; a public one is verified as R72-NFR5 says.
      if (label === 'private' && publicOnlyReasons(agent, data).length === 0 && reading === null) return { allowed: true }
      askConsent(data, expectedDestination(data, agent), [...inputsOf(agent), ...(reading === null ? [] : [reading])], label, now)
      return { allowed: true }
    } catch (error) {
      if (error?.code === 'PRIVATE_NOT_ALLOWED' || error?.code === 'PUBLIC_NOT_VERIFIED') return { allowed: false, reason: error.message, code: error.code }
      throw error
    }
  }
  const recheck = request.recheckOf === undefined ? undefined : { id: request.recheckOf, run: earlierRun(request.recheckOf, runs) }
  // The owner's approved choice for the role in this project (73.2): any choice for the project or one of its linked worktrees; an ended one no longer applies.
  // Two that still apply decide nothing: the role's asks here are refused, before anyone is chosen or anything copied (epic recheck 2).
  const projectChoice = (role) => {
    if (project === null || (data.project_choices ?? []).length === 0) return null
    const found = projectChoiceFor(data, canonicalProject(project), role.id, canonicalProject, now)
    if (found?.collision !== undefined) throw new AskRefusal('PROJECT_CHOICE_COLLISION', `${collisionWords(found.collision)}; asks for ${role.id} here are refused until the owner removes one of them in the team file and approves it in BMN`)
    return found === null || found.ended ? null : found.choice
  }
  const choice = resolveTeammate(data, { role: request.role, agent: request.agent, effort: request.effort, smallWork: request.smallWork === true, recheck },
    { project, standing, allowed, projectChoice })
  // A teammate the data may not reach is refused for that reason: the asker's data decides, not who else is on the team.
  const consent = allowed(choice.agent)
  if (!consent.allowed) throw new AskRefusal(consent.code, consent.reason)
  if (agentState(choice.agent) !== 'active') throw new AskRefusal('AGENT_NOT_ELIGIBLE', `${choice.agent.id} is ${agentState(choice.agent)}`)

  // Only now is anything written: the run's folder and its inputs.
  const harness = choice.agent.harness
  const form = formOf(choice.agent)
  const folder = join(runs, id)
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  mkdirSync(folder, { mode: 0o700 })
  const inputs = join(folder, ASK_RUN_FILES.inputs)
  mkdirSync(inputs, { mode: 0o700 })
  // A teammate with no project works in an empty folder of the run's own.
  const workIn = project ?? join(folder, ASK_RUN_FILES.work)
  if (project === null) mkdirSync(workIn, { mode: 0o700 })
  const installed = versionOf(harness)
  // Each file is kept in the run as it was read and scanned; its text is in the prompt.
  const copies = texts.map((file, index) => {
    const copy = `${ASK_RUN_FILES.files.slice(ASK_RUN_FILES.inputs.length + 1)}/${index + 1}-${basename(file.real)}`
    writePrivate(join(inputs, copy), file.bytes)
    return copy
  })
  // Each picture as it is sent, named by its place: the asker's file name stays in the record.
  const pictureCopies = pictures.map((picture, index) => {
    const copy = `${ASK_RUN_FILES.pictures.slice(ASK_RUN_FILES.inputs.length + 1)}/${index + 1}.${PICTURE_EXTENSIONS[picture.media_type]}`
    writePrivate(join(inputs, copy), picture.bytes)
    return copy
  })
  // A file of the project is named by its path in it; any other by the path the asker gave.
  const nameOf = (file) => (project !== null && !relative(project, file.real).startsWith('..') ? relative(project, file.real) : file.path)
  let prompt = picturePrompt(filePrompt(request.question, texts.map((file) => ({ ...file, label: nameOf(file) }))), pictures.map((picture) => ({ ...picture, label: nameOf(picture) })))
  if (project !== null && ASK_READS[form].scope !== 'text') prompt = projectPrompt(prompt, project)
  if (browser !== null) prompt = browserPrompt(prompt, browser)
  writePrivate(join(folder, ASK_RUN_FILES.prompt), prompt)
  // The question alone, as the asker wrote it, for the record and Agents › Asks (73.1); the prompt above is what is sent.
  writePrivate(join(folder, ASK_RUN_FILES.question), request.question)
  // The forms that read history run BMN's own git, first on their PATH (72.1 AC1, 72.9 AC1).
  if (form === 'claude-read-tools' || form === 'opencode-reader') writePrivate(join(folder, ASK_RUN_FILES.bin, 'git'), readFileSync(ASK_GIT), 0o700)
  // Codex and Claude Code read the owner's own rules in their own homes; a private OpenCode ask carries them in its agent (BMN's folder holds none).
  const rules = harness === 'opencode' && label === 'private' ? instructionRules(harness, generation) : null
  if (rules !== null) writePrivate(join(folder, ASK_RUN_FILES.rules), rules)
  // The browser's server saves its files here, its session log among them; BMN reads its record from it (74.3 AC3).
  if (browser !== null) mkdirSync(join(folder, ASK_RUN_FILES.browser), { mode: 0o700 })
  const manifest = {
    version: 2, id, data: label, form, reads: { scope: ASK_READS[form].scope, words: ASK_READS[form].words, folder: workIn },
    project: project === null ? null : { root: project },
    question: { bytes: question.bytes, sha256: question.sha256 },
    inputs: inputsOf(choice.agent),
    files: texts.map((file, index) => ({ path: file.path, real: file.real, copy: copies[index], bytes: file.bytes.length, sha256: file.sha256 })),
    rules: rules === null ? null : { sha256: sha256Of(Buffer.from(rules)), bytes: Buffer.byteLength(rules) },
    // Each picture with its hashes before and after and what was taken out and kept, by name (72.8 AC2).
    pictures: pictures.map((picture, index) => ({
      label: picture.path, real: picture.real, copy: pictureCopies[index], media_type: picture.media_type, width: picture.width, height: picture.height,
      before: picture.before, bytes: picture.bytes.length, sha256: picture.sha256, removed: picture.removed, kept: picture.kept
    })),
    ...(browser === null ? {} : { browser: { ...browser, tools: browserTools(browser.interact), statement: BROWSER_STATEMENT } }),
    prompt_sha256: sha256Of(Buffer.from(prompt))
  }
  writePrivate(join(folder, ASK_RUN_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`)
  writePrivate(join(folder, ASK_RUN_FILES.request), `${JSON.stringify({
    version: 1, id, role: request.role, agent: choice.agent.id, model: choice.agent.model, provider: choice.agent.provider, aliases: choice.agent.aliases ?? [], effort: choice.effort, chosen_by: choice.rule, phase: choice.phase, ...(choice.choice === undefined ? {} : { project_choice: choice.choice }),
    billing: choice.agent.paid_by ?? 'unknown', project, form, reads: ASK_READS[form].words, data: label, app_version: installed.version, ...(request.recheckOf === undefined ? {} : { recheck_of: request.recheckOf }),
    ...(browser === null ? {} : { browser: { origin: browser.origin, interact: browser.interact, statement: BROWSER_STATEMENT } }),
    // The retry key, whose it is and the request's hash (72.4): a retry with the same three finds this run.
    ...(request.key === undefined ? {} : { key: request.key, key_scope: request.keyScope, request_sha256: request.requestSha256 }),
    asked_by: request.askedBy ?? askerOf(environment), asked_at: now.toISOString()
  }, null, 2)}\n`)

  const built = askCommand(harness, installed.program, askRequest(choice.agent, installed.version, {
    form, effort: choice.effort, cwd: workIn, folder, rules, pictures: pictureCopies.map((copy) => join(inputs, copy)), browser, environment, contextTestLog
  }))
  // Claude Code takes its pictures as one user message on standard input, the pictures first, then the prompt.
  if (built.stdin === 'stream-json') writePrivate(join(folder, ASK_RUN_FILES.message), claudePictureMessage(pictures, prompt))
  // The snapshots the check judges and the start uses (72.3 AC1): the app's program and its environment once.
  writePrivate(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'), `${JSON.stringify(executableIdentity(installed.program), null, 2)}\n`)
  writePrivate(join(folder, ASK_RUN_FILES.snapshots, 'environment.json'), `${JSON.stringify({ names: Object.keys(built.environment), sha256: sha256Of(Buffer.from(JSON.stringify(built.environment))) }, null, 2)}\n`)
  const verdict = evaluateAsk({ agent: choice.agent.id, role: request.role, effort: choice.effort, data: label, run: folder, argv: built.argv, cwd: workIn },
    { environment, now, program: installed.program, version: installed.version, contextTestLog })
  if (verdict.verdict === 'PASS') writePrivate(join(folder, ASK_RUN_FILES.receipt), `${JSON.stringify(verdict.receipt, null, 2)}\n`)
  return {
    id, folder, choice: { agent: choice.agent.id, effort: choice.effort, rule: choice.rule, phase: choice.phase, ...(choice.choice === undefined ? {} : { project_choice: choice.choice }) },
    verdict, argv: built.argv, cwd: workIn, stdin: built.stdin, manifest, program: installed.program
  }
}
