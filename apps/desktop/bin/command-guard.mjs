// MODULE: command-guard.mjs - Story 83.4: the deny-only guard that holds the clearly critical shell commands for the owner
//
// It decides from the command text alone, inside the hook process: no socket, no file, no state, so it holds while BMN is
// closed. Its only outputs are nothing, Claude Code's `ask` (Claude's own permission prompt, measured in Story 83.1 to show in
// default and auto mode, for an allow-listed command too, and to leave a deny standing) and Codex's block with a reason that
// tells the agent to ask him. It never allows. Matching is a conservative pattern list over the whole text, quoted parts
// included, so a commit message that only mentions a held command is held too: a false match only asks. An agent hiding a
// command on purpose (encoded text, a script it writes first) is not stopped here; GitHub's own rules are the hard guard there.

/** The shell tool each app's PreToolUse names, as Story 83.1 measured it (Claude Code 2.1.302, codex-cli 0.162.1). */
export const GUARDED_TOOLS = { claude: 'Bash', codex: 'Bash' }

// One simple command at a time for the flags that only count on their own command (`git push`, `gh pr merge`, `gh api`).
const SEPARATORS = /&&|\|\||[;|&\n]/
const words = (segment) => segment.split(/\s+/).map((word) => word.replace(/^["'`(]+|["'`)]+$/g, '')).filter(Boolean)
const shortFlags = (word, letters) => /^-[A-Za-z0-9]+$/.test(word) && [...letters].some((letter) => word.slice(1).includes(letter))

/** What a `git ... push` holds, from the words after `push`. */
function pushHold(segment) {
  const at = segment.search(/\bpush\b/)
  if (!/\bgit\b/.test(segment.slice(0, Math.max(at, 0))) || at < 0) return null
  const after = words(segment.slice(at + 4))
  if (after.some((word) => /^--force(-with-lease|-if-includes)?(=|$)/.test(word) || shortFlags(word, 'f') || /^\+./.test(word))) return 'a force push'
  if (after.some((word) => /^--(delete|prune)(=|$)/.test(word) || shortFlags(word, 'd') || /^:./.test(word))) return 'a branch or tag deletion on a remote'
  if (after.some((word) => /^--(mirror|tags|follow-tags)(=|$)/.test(word) || word.includes('refs/tags/'))) return 'a push of tags or a mirror'
  return null
}

const API_PATH = /^\/?repos\/[^/\s]+\/[^/\s?]+(\/?$|\/rulesets(\/|$)|\/branches\/\S+\/protection(\/|$))/

/** A `gh api` call that writes to a repository's own path, its rulesets or its branch protection. */
function apiHold(segment) {
  const at = segment.search(/\bgh\s+api\b/)
  if (at < 0) return null
  const list = words(segment.slice(at))
  let method = null
  let fields = false
  for (let index = 0; index < list.length; index += 1) {
    const word = list[index]
    const joined = /^(-X|--method)=?(.*)$/.exec(word)
    if (joined) method = (joined[2] || list[index + 1] || '').toUpperCase()
    else if (/^-X[A-Za-z]+$/.test(word)) method = word.slice(2).toUpperCase()
    if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(word)) fields = true
  }
  const writes = method === null ? fields : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  return writes && list.some((word) => API_PATH.test(word.split('?')[0])) ? 'a change to a repository, its rulesets or its branch protection' : null
}

/** A `gh pr merge` that bypasses checks, merges later by itself or deletes the branch. */
function mergeHold(segment) {
  const at = segment.search(/\bgh\s+pr\s+merge\b/)
  if (at < 0) return null
  return words(segment.slice(at)).some((word) => /^--(admin|auto|delete-branch)(=|$)/.test(word) || shortFlags(word, 'd'))
    ? 'a pull request merge with --admin, --auto or --delete-branch' : null
}

/** Rules over one simple command. */
const SEGMENT_RULES = [
  pushHold,
  apiHold,
  mergeHold,
  (segment) => /\bgh\b.*\brepo\s+(delete|edit|rename|archive|transfer)\b/.test(segment) ? 'a repository change (delete, edit, rename, archive or transfer)' : null,
  (segment) => /\bgh\b.*\brelease\s+(create|edit|delete)\b/.test(segment) ? 'a release' : null,
  (segment) => /\b(npm|pnpm|yarn)\b.*\bpublish\b/.test(segment) ? 'publishing a package' : null
]

/**
 * What the guard holds in this command, or null. `kill`, `pkill` or `killall` count over the whole text, since the process
 * they name often comes from another command in the pipeline (`pgrep bmn | xargs kill`); packaged BMN's executable is `bmn`.
 */
export function heldCommand(command) {
  if (typeof command !== 'string' || command === '') return null
  for (const segment of command.split(SEPARATORS)) {
    for (const rule of SEGMENT_RULES) {
      const held = rule(segment)
      if (held !== null) return held
    }
  }
  if (/\b(kill|pkill|killall)\b/.test(command) && /\bbmn\b/i.test(command)) return 'stopping BMN, which only the owner does'
  return null
}

/** The guard's answer for one hook event, as printed to the app, or null for nothing: never an allow. */
export function guardAnswer(agent, event) {
  if (event?.hook_event_name !== 'PreToolUse' || GUARDED_TOOLS[agent] === undefined || event.tool_name !== GUARDED_TOOLS[agent]) return null
  const held = heldCommand(event.tool_input?.command)
  if (held === null) return null
  if (agent === 'claude') {
    const reason = `BMN holds ${held} for the owner (his policy: \`bmn policy\`).`
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })
  }
  const reason = `BMN held this command: ${held}. Only the owner approves it; ask him before running it.`
  return JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}
