// MODULE: team-ask-harness.ts - Epic 72 test harness: an isolated home with a synthetic approved team, made-up sign-in files and stand-in Codex and Claude Code apps written in sh that run in BMN's real systemd user scope, as each app's own read-only mode would; no provider is reached
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readValidRoster } from '../../../bin/agents-state.mjs'
import { scopeStarts } from '../../../bin/agents-team-supervisor.mjs'
import { approveRoster } from '../../main/agents-approval'

export const EXAMPLE = readFileSync(fileURLToPath(new URL('./agents/roster-example.md', import.meta.url)), 'utf8')
export const SIGN_IN_SENTINEL = 'SIGN-IN-SENTINEL-not-a-real-token'
export const ENV_SENTINEL = 'ENVIRONMENT-SENTINEL-value'
/**
 * A made-up OpenAI-shaped key a stand-in app puts in its answer when the question says CREDANSWER. It must not say it is made
 * up (agents-team-inputs.mjs SYNTHETIC_WORDS leaves such a value alone), so it is built here and no file holds it whole.
 */
export const ANSWER_KEY = ['sk', 'proj', 'Qw7Er9Ty2Ui4Op6As8Df1Gh3Jk5Lz0Xc'].join('-')
/** A Codex sub-agent's made-up thread, and one no rollout names. */
export const CODEX_CHILD = 'eeeeeeee-0000-7000-8000-000000000000'
export const CODEX_STRANGER = 'dddddddd-0000-7000-8000-000000000000'

/** Config-only stand-in. Native override/merge semantics are checked separately with installed Codex. */
export const CODEX_MCP_LIST = `if [ "$1" = mcp ] && [ "$2" = list ]; then
exec ${JSON.stringify(process.execPath)} -e '
const fs = require("node:fs");
const file = process.env.HOME + "/mcp-list.json";
const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const args = process.argv.slice(1);
const config = args.filter((_, index) => args[index - 1] === "-c");
if (fs.existsSync(process.env.HOME + "/mcp-list-ignores-overrides")) { console.log(JSON.stringify(servers)); process.exit(0); }
for (const item of config) {
  if (!item.startsWith("mcp_servers=")) continue;
  for (const server of servers) if (item.includes(JSON.stringify(server.name) + "={enabled=false}")) server.enabled = false;
  if (item.includes("playwright={command=")) {
    const own = servers.find(server => server.name === "playwright");
    const value = item.slice(item.indexOf("playwright={") + 12);
    const field = (name, next) => JSON.parse(value.slice(value.indexOf(name + "=") + name.length + 1, value.indexOf("," + next + "=")));
    const transport = { type: "stdio", command: field("command", "args"), args: field("args", "cwd"), cwd: field("cwd", "env"), env: own?.transport?.env ?? {}, env_vars: [] };
    if (own) { own.enabled = true; own.transport = transport; }
    else servers.push({ name: "playwright", enabled: true, transport });
  }
}
console.log(JSON.stringify(servers));
' "$@"
fi`

/** Approves a team file in the home `process.env.HOME` names, as the owner does in the Team view. */
export function approve(home: string, text: string): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), text)
  let generation: number | null
  try {
    generation = JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation
  } catch {
    generation = null
  }
  approveRoster({ generation, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

/**
 * Stand-in apps that run as BMN starts each app, in the folder it works in: they read the prompt, take
 * the model and effort from their own arguments and answer as each app does, saying the folder they
 * worked in. Words in the question steer them: SLEEP, NAP, MISMATCH, SECOND, SUBAGENT (a sub-agent the
 * teammate started, with its own record), STRANGER (Codex: a thread no rollout names), NOSESSION, FAIL,
 * CEILING (Claude Code: model calls that keep reporting usage while it runs), STRAY (a process that
 * leaves the app's process group and ignores TERM, as a tool's child may), CREDANSWER (a key in the
 * answer). Pictures are reported by hash as each app received them: Codex the `-i` files it can open,
 * Claude Code the stream-json message on its standard input.
 */
const STEER = `question=$(cat)
id=$(printf %s "$question" | md5sum | cut -c1-8)
key=
case $question in *CREDANSWER*) key=" key ${ANSWER_KEY}";; esac
case $question in *STRAY*) setsid sh -c "trap '' TERM HUP; sleep 300 # stray of $HOME" </dev/null >/dev/null 2>&1 &;; esac
case $question in *SLEEP*) sleep 60;; esac
case $question in *NAP*) sleep 2;; esac
case $question in *FAIL*) echo 'provider error' >&2; exit 3;; esac
case $question in *NOPROFILE*) echo 'error: unknown configuration key default_permissions' >&2; exit 1;; esac
`
export function stubCodex(stubs: string, version = '0.162.1'): void {
  writeFileSync(join(stubs, 'codex'), `#!/bin/sh
[ "$1" = --version ] && echo "codex-cli ${version}" && exit 0
${CODEX_MCP_LIST}
model=; effort=; prev=; last=
pictures=
for a in "$@"; do
  [ "$prev" = -m ] && model=$a
  [ "$prev" = -o ] && last=$a
  [ "$prev" = -i ] && pictures="$pictures $(sha256sum "$a" | cut -c1-64)"
  case $a in model_reasoning_effort=*) effort=$(printf %s "$a" | sed 's/.*=//; s/"//g');; esac
  prev=$a
done
${STEER}thread=$id-0000-7000-8000-000000000000
rollouts="\${CODEX_HOME:-$HOME/.codex}/sessions/$(date +%Y/%m/%d)"
case $question in *MISMATCH*) model=gpt-6-other;; esac
case $question in *NOSESSION*) ;; *) printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread";; esac
printf '{"type":"turn.started"}\\n'
printf 'INFO turn{otel.name="session_task.turn" thread.id=%s turn.id=t-1 model=%s codex.turn.reasoning_effort=%s}: started\\n' "$thread" "$model" "$effort" >&2
case $question in *SECOND*) printf '{"type":"thread.started","thread_id":"ffffffff-0000-7000-8000-000000000000"}\\n';; esac
# A sub-agent the model started (Codex 0.162.1, measured 72.9): its own turn span names it, and its own rollout names its parent and holds its own usage.
case $question in *SUBAGENT*)
  mkdir -p "$rollouts"
  printf '{"type":"session_meta","payload":{"id":"%s","source":"exec"}}\\n' "$thread" > "$rollouts/rollout-$id-$thread.jsonl"
  printf '{"type":"session_meta","payload":{"id":"${CODEX_CHILD}","source":{"subagent":{"thread_spawn":{"parent_thread_id":"%s","agent_nickname":"Ada","agent_path":"explorer"}}}}}\\n{"type":"turn_context","payload":{"model":"%s","effort":"low"}}\\n{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":1}}}}\\n' "$thread" "$model" > "$rollouts/rollout-$id-${CODEX_CHILD}.jsonl"
  printf 'INFO turn{otel.name="session_task.turn" thread.id=${CODEX_CHILD} turn.id=t-1 model=%s codex.turn.reasoning_effort=low}: started\\n' "$model" >&2;;
esac
case $question in *STRANGER*) printf 'INFO turn{otel.name="session_task.turn" thread.id=${CODEX_STRANGER} turn.id=t-1 model=%s codex.turn.reasoning_effort=%s}: started\\n' "$model" "$effort" >&2;; esac
text="codex answer $id in $(pwd)\${pictures:+ pictures$pictures}$key"
printf '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"%s"}}\\n' "$text"
[ -n "$last" ] && printf '%s' "$text" > "$last"
printf '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5,"reasoning_output_tokens":2}}\\n'
`)
  chmodSync(join(stubs, 'codex'), 0o755)
}
export function stubClaude(stubs: string, version = '2.1.300'): void {
  writeFileSync(join(stubs, 'claude'), `#!/bin/sh
[ "$1" = --version ] && echo "${version} (Claude Code)" && exit 0
model=; effort=; prev=
for a in "$@"; do [ "$prev" = --model ] && model=$a; [ "$prev" = --effort ] && effort=$a; prev=$a; done
rules=no; format=text; prev=
for a in "$@"; do case $a in *RULES-SENTINEL*) rules=yes;; esac; [ "$prev" = --input-format ] && format=$a; prev=$a; done
${STEER}sid=$id-0000-4000-8000-000000000000
input=
[ $format = stream-json ] && input=" stdin=$(printf '%s\\n' "$question" | sha256sum | cut -c1-64)"
printf '{"type":"system","subtype":"init","session_id":"%s","model":"%s","apiKeySource":"none","tools":[]}\\n' "$sid" "$model"
case $question in *CEILING*)
  n=0
  while [ $n -lt 40 ]; do
    n=$((n + 1))
    printf '{"type":"assistant","session_id":"%s","message":{"id":"msg_%s","model":"%s","usage":{"input_tokens":400,"cache_read_input_tokens":500,"output_tokens":100}}}\\n' "$sid" "$n" "$model"
    sleep 0.2
  done;;
esac
# A sub-agent the model started with its Agent tool (Claude Code 2.1.300, measured 72.9): its task's events, its own model calls under the tool use, and the run's modelUsage counting it.
child='{"claude-made-up-teammate":{"inputTokens":3,"cacheCreationInputTokens":7,"cacheReadInputTokens":11,"outputTokens":4}}'
case $question in *SUBAGENT*)
  printf '{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"toolu_1","description":"read the tests","subagent_type":"Explore","session_id":"%s"}\\n' "$sid"
  printf '{"type":"assistant","parent_tool_use_id":"toolu_1","session_id":"%s","message":{"model":"claude-made-up-helper","usage":{"input_tokens":50,"output_tokens":6}}}\\n' "$sid"
  printf '{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed","usage":{"total_tokens":56},"session_id":"%s"}\\n' "$sid"
  child='{"claude-made-up-teammate":{"inputTokens":3,"cacheCreationInputTokens":7,"cacheReadInputTokens":11,"outputTokens":4},"claude-made-up-helper":{"inputTokens":50,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":6}}';;
esac
case $question in *SECOND*) printf '{"type":"assistant","session_id":"ffffffff-0000-4000-8000-000000000000","message":{"model":"%s"}}\\n' "$model";; esac
printf '{"type":"assistant","session_id":"%s","message":{"model":"%s","usage":{"input_tokens":3,"output_tokens":4}}}\\n' "$sid" "$model"
printf '{"type":"result","subtype":"success","is_error":false,"result":"claude answer %s rules=%s%s in %s%s","session_id":"%s","total_cost_usd":0.0123,"usage":{"input_tokens":3,"cache_creation_input_tokens":7,"cache_read_input_tokens":11,"output_tokens":4},"modelUsage":%s}\\n' "$id" "$rules" "$input" "$(pwd)" "$key" "$sid" "$child"
`)
  chmodSync(join(stubs, 'claude'), 0o755)
}

/**
 * A fresh home for one test: `process.env.HOME` set to it, both stand-in apps on its PATH, made-up
 * sign-in files where each app keeps its own, and the example team approved.
 */
export function teamAskHome(prefix: string): { home: string; stubs: string; env: Record<string, string> } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  process.env.HOME = home
  const stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stubCodex(stubs)
  stubClaude(stubs)
  for (const path of ['.codex/auth.json', '.claude/.credentials.json']) {
    mkdirSync(join(home, path, '..'), { recursive: true })
    writeFileSync(join(home, path), `{"token": "${SIGN_IN_SENTINEL}"}\n`)
  }
  approve(home, EXAMPLE)
  return { home, stubs, env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, SECRET_LOOKING_VARIABLE: ENV_SENTINEL, ...ownSystemd() } }
}

/** The owner's own systemd user manager, as a session's environment reaches it: a run's scope is started there. */
export function ownSystemd(): Record<string, string> {
  return Object.fromEntries((['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const).flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])))
}

/** Whether a run's systemd user scope starts on this computer: the tests that run an app need it, as an ask does (72.9 AC4). */
export const SCOPES = scopeStarts({ environment: process.env }).ok

/** Whether a run's scope is gone: its cgroup folder removed once its last process ended. */
export function scopeGone(cgroup: string | undefined): boolean {
  return cgroup === undefined || !existsSync(cgroup)
}

/** Every process whose command line names this home: none may outlive a run. */
export function leftovers(home: string): string[] {
  const found: string[] = []
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const line = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
      if (line.includes(home) && !line.includes('vitest')) found.push(`${pid} ${line.slice(0, 160)}`)
    } catch {
      // Gone already.
    }
  }
  return found
}

export async function settle(check: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
}

/** The made-up MAC every test session token carries; the stand-in control service accepts only it. */
export const TOKEN_MAC = 'a'.repeat(64)

/**
 * A stand-in for BMN's control service at `path`: it answers `auth` as control-auth.ts does, a
 * session token `s1.<session>.<incarnation>.<TOKEN_MAC>` naming its session and any other refused.
 * With `accept`, a forger's service instead: every token is the session `accept` names.
 */
export async function standInControl(path: string, accept?: (token: string) => string): Promise<Server> {
  mkdirSync(join(path, '..'), { recursive: true })
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string; params?: { token?: string } }
      const parts = /^s1\.([A-Za-z0-9_:-]{1,128})\.([A-Za-z0-9_:-]{1,128})\.([0-9a-f]{64})$/.exec(request.params?.token ?? '')
      if (accept !== undefined) {
        socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { scope: 'session', sessionId: accept(request.params?.token ?? '') } })}\n`)
      } else if (request.method === 'auth' && parts !== null && parts[3] === TOKEN_MAC) {
        socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { scope: 'session', sessionId: parts[1] } })}\n`)
      } else {
        socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Invalid credential', data: { code: 'UNAUTHORIZED' } } })}\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return server
}
