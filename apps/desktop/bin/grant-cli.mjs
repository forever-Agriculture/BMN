// MODULE: grant-cli.mjs - `bmn grant`: a run's card before the owner leaves, the grant he answered, each use of it, and what each step did (Epic 84, Stories 84.3, 84.7)
//
// Everything is decided in BMN through the control socket: the card is checked there, only the owner's own surfaces
// answer it (no token reaching the socket can), and the grant read here is read fresh each time, never from a handoff.

const GRANT_USAGE = `Usage: bmn grant [--run ID] [--json]
       bmn grant ask --run ID --card-file - [--key K] [--json]
       bmn grant ask --run ID --nothing [--title T] [--scope S] [--key K] [--json]
       bmn grant use --run ID --use-id U (--boundary B | --item I) [--json]
       bmn grant report --run ID (--period P --use-id U --result R | --boundary B --step-back | --item I) [--text T] [--json]

The Away grant (Epic 84). Before the owner leaves (BMN tells your session he is leaving or away), a
run with authorised work left for the night asks him once, on one card, for only what that work
needs. Only he answers, in the BMN window or on Telegram; an unanswered card grants nothing, and
every grant ends when he is back.

grant        The run's grant in force, or "No grant" and why. Read it right before each step that
             uses it; a grant never comes from a handoff. Without --run: the runs this session asked.
grant ask    The run's card for this departure, as JSON on standard input, for example:
               {"title": "Epic 80 · clean up ai slop", "scope": "Stories 80.2-80.6, then Epic 81",
                "terms": [
                 {"kind": "rounds", "proposed": 3, "reason": "two review boundaries are ahead"},
                 {"kind": "merge", "id": "merge-12", "repository": "OWNER/NAME", "pr": 12,
                  "headSha": "3f2a9c1", "upTo": 2, "proposed": "pr", "reason": "checks green at 22:20"},
                 {"kind": "push-default", "repository": "OWNER/NAME", "branch": "dev-auto/epic-81",
                  "proposed": "yes", "reason": "this repository takes no PRs"},
                 {"kind": "pr-elsewhere", "repository": "OWNER/NAME", "branch": "fix/skill",
                  "proposed": "yes", "reason": "..."}]}
             rounds: 2, 3 or 4 extra repair rounds per boundary, when a boundary is ahead. merge
             offers "pr" (this PR at headSha) and/or "green" (up to upTo of this run's PRs, each when
             its required checks are green); "no" is always offered. pr-elsewhere names its PR's
             branch, its pr number, or both. count (1-10, default 1) bounds a push or a PR. Ask only what the remaining work needs, each term with its reason. Asking
             again with other terms makes a new revision; his earlier answer holds until he answers
             it. --nothing says the run needs nothing. Never on a card: force pushes, deletions,
             releases, publishes, killing BMN, credentials and acceptance changes.
grant use    Records one extra round at a boundary (--boundary) or one use of a granted item
             (--item), before the step runs, and prints the period it is recorded in: keep it with
             the use for its report. The same --use-id returns the first record, so a retry after an
             uncertain outcome reuses it; once his answer has changed, or after he is back, a retried
             action waits. A refused use means the step waits.
grant report Tells BMN what happened, for his morning summary; it grants nothing. --period with
             --use-id and --result (the period grant use printed, also after Back): a round passed,
             failed or blocked (parked BLOCKED), an action done or
             refused (by GitHub or a guard; --text says why), or uncertain while you read the
             target's state. --boundary B --step-back --text: the step-back consult's option,
             before the boundary's last granted round. --item I --text: a granted step that a rule
             or GitHub refused before any use. --text is at most 1,000 characters. Kept as the
             agent's report, apart from BMN's record.

Exit 0 printed or recorded, 1 refused or BMN unreachable (then nothing is granted), 2 usage.`

const CARD_LIMIT_BYTES = 32_768
const VALUE_OPTIONS = new Set(['--run', '--card-file', '--key', '--title', '--scope', '--period', '--use-id', '--boundary', '--item', '--result', '--text', '--socket', '--token-file'])

function usage(message) {
  process.stderr.write(`bmn: ${message}\n${GRANT_USAGE}\n`)
  return 2
}

async function readCard() {
  if (process.stdin.isTTY) throw new Error('--card-file - needs piped input, not a terminal')
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
    size += chunk.length
    if (size > CARD_LIMIT_BYTES) throw new Error(`the card on standard input must be at most ${CARD_LIMIT_BYTES} bytes`)
  }
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { throw new Error('the card on standard input is not valid UTF-8') }
  try { return JSON.parse(text) } catch { throw new Error('the card on standard input is not valid JSON') }
}

/** What `grant ask` prints for the host's answer. */
function describeAsk(result) {
  const run = result?.runId ?? 'this run'
  if (result?.state === 'nothing') return `Recorded: run ${run} needs nothing for the night${result.outcome === 'unchanged' || result.outcome === 'repeated' ? ' (already said; nothing changed)' : ''}.`
  const same = result?.outcome === 'unchanged' || result?.outcome === 'repeated' ? ' (the same as before; nothing changed)' : ''
  const what = result?.outcome === 'replaced' ? 'replaces the earlier one' : 'is open'
  return `Card revision ${result?.cardRevision} for run ${run} ${what} in the BMN window and on his phone${same}. Nothing is granted until he answers; read it with bmn grant --run ${run}.`
}

/** What `grant` prints: each run's lines as BMN words them, or why there is none. */
function describeStatus(result, runId) {
  const runs = Array.isArray(result?.runs) ? result.runs : []
  const lines = []
  const departure = result?.departure
  if (runId === undefined) {
    if (departure === null || departure === undefined) lines.push('No departure: the owner has not said he is leaving and is not away.')
    else lines.push(`The owner is ${departure.state === 'away' ? 'away' : 'leaving'} since ${departure.since} (period ${departure.periodId}).`)
    if (runs.length === 0 && departure) lines.push('This session has asked no card.')
  }
  for (const run of runs) {
    if (Array.isArray(run.lines)) lines.push(...run.lines)
    else lines.push(run.active ? `Grant for run ${run.runId}.` : `No grant for run ${run.runId}: ${run.reason}.`)
  }
  return lines.join('\n')
}

function describeUse(result, use) {
  const what = use.boundary !== undefined ? `one extra round at ${use.boundary}` : `one use of item ${use.item}`
  return `Recorded ${what} for run ${use.runId} in period ${result?.periodId}${result?.outcome === 'repeated' ? ' (already recorded under this use id; not repeated)' : ''}; ${result?.left ?? 0} left. Report its outcome with --period ${result?.periodId}.`
}

function describeReport(result, runId) {
  return `Kept as the agent's report for run ${runId}${result?.outcome === 'repeated' ? ' (already kept; not repeated)' : ''}; it grants nothing.`
}

/** `bmn grant …`. */
export async function runGrantCommand(argv, { readCredentials, call }) {
  const action = argv[0] === 'ask' || argv[0] === 'use' || argv[0] === 'report' ? argv[0] : null
  const words = action === null ? argv : argv.slice(1)
  const options = {}
  const credentials = {}
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === '--help' || word === '-h') { process.stdout.write(`${GRANT_USAGE}\n`); return 0 }
    if (word === '--json' || word === '--nothing' || word === '--step-back') { options[word.slice(2)] = true; continue }
    if (word === '--owner') { credentials.owner = true; continue }
    if (!VALUE_OPTIONS.has(word)) return usage(`grant${action === null ? '' : ` ${action}`} does not accept ${word.slice(0, 40)}`)
    const value = words[index + 1]
    if (value === undefined || (value.startsWith('--') && value !== '-')) return usage(`${word} needs a value`)
    if (word === '--socket' || word === '--token-file') credentials[word.slice(2)] = value
    else options[word.slice(2)] = value
    index += 1
  }
  const allowed = action === 'ask' ? ['run', 'card-file', 'key', 'title', 'scope', 'nothing', 'json']
    : action === 'use' ? ['run', 'use-id', 'boundary', 'item', 'json']
      : action === 'report' ? ['run', 'period', 'use-id', 'result', 'boundary', 'step-back', 'item', 'text', 'json'] : ['run', 'json']
  const stray = Object.keys(options).find((name) => !allowed.includes(name))
  if (stray !== undefined) return usage(`grant${action === null ? '' : ` ${action}`} does not take --${stray}`)
  let method
  let params
  if (action === 'ask') {
    if (options.run === undefined) return usage('grant ask needs --run, your run\'s id')
    if ((options['card-file'] === undefined) === (options.nothing !== true)) return usage('grant ask takes either --card-file - or --nothing')
    if (options['card-file'] !== undefined && options['card-file'] !== '-') return usage('--card-file takes - (pipe the card as JSON)')
    if (options.nothing !== true && (options.title !== undefined || options.scope !== undefined)) return usage('--title and --scope go with --nothing; a card carries its own')
    let card
    try {
      card = options.nothing === true ? { title: options.title ?? options.run, scope: options.scope ?? 'Needs nothing for the night', nothing: true } : await readCard()
    } catch (error) {
      return usage(error.message)
    }
    method = 'grant.ask'
    params = { runId: options.run, card, ...(options.key === undefined ? {} : { idempotencyKey: options.key }) }
  } else if (action === 'use') {
    if (options.run === undefined || options['use-id'] === undefined) return usage('grant use needs --run and --use-id')
    if ((options.boundary === undefined) === (options.item === undefined)) return usage('grant use takes either --boundary (a round) or --item')
    method = 'grant.use'
    params = { runId: options.run, useId: options['use-id'], ...(options.boundary === undefined ? {} : { boundary: options.boundary }), ...(options.item === undefined ? {} : { item: options.item }) }
  } else if (action === 'report') {
    if (options.run === undefined) return usage('grant report needs --run')
    const forms = [options['use-id'] !== undefined, options['step-back'] === true, options['use-id'] === undefined && options['step-back'] !== true && options.item !== undefined]
    if (forms.filter(Boolean).length !== 1) return usage('grant report takes --use-id with --result, --boundary with --step-back, or --item')
    if ((options['use-id'] !== undefined) !== (options.result !== undefined)) return usage('--result goes with --use-id')
    if ((options['use-id'] !== undefined) !== (options.period !== undefined)) return usage('--period (the period grant use printed) goes with --use-id')
    if (options['step-back'] === true && options.boundary === undefined) return usage('--step-back needs --boundary')
    method = 'grant.report'
    params = {
      runId: options.run,
      ...(options['use-id'] === undefined ? {} : { periodId: options.period, useId: options['use-id'], result: options.result }),
      ...(options['step-back'] === true ? { stepBack: true, boundary: options.boundary } : {}),
      ...(options.item === undefined ? {} : { item: options.item }),
      ...(options.boundary !== undefined && options['step-back'] !== true ? { boundary: options.boundary } : {}),
      ...(options.text === undefined ? {} : { text: options.text })
    }
  } else {
    method = 'grant.status'
    params = options.run === undefined ? {} : { runId: options.run }
  }
  let result
  try {
    const { socketPath, token } = readCredentials(credentials)
    result = await call(socketPath, token, method, params)
  } catch (error) {
    const words = error instanceof Error ? error.message : String(error)
    process.stderr.write(`bmn: ${method === 'grant.status' ? `the grant could not be read (${words}); nothing is granted` : words}\n`)
    return 1
  }
  const text = method === 'grant.ask' ? describeAsk(result) : method === 'grant.use' ? describeUse(result, { runId: options.run, boundary: options.boundary, item: options.item })
    : method === 'grant.report' ? describeReport(result, options.run) : describeStatus(result, options.run)
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : text}\n`)
  return 0
}
