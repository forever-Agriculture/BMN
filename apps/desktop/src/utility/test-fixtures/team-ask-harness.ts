// MODULE: team-ask-harness.ts - Epic 72 test harness: an isolated home with a synthetic approved team, made-up sign-in files and stand-in Codex and Claude Code apps written in sh that run inside BMN's real container; no provider is reached
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readValidRoster } from '../../../bin/agents-state.mjs'
import { approveRoster } from '../../main/agents-approval'

export const EXAMPLE = readFileSync(fileURLToPath(new URL('./agents/roster-example.md', import.meta.url)), 'utf8')
export const SIGN_IN_SENTINEL = 'SIGN-IN-SENTINEL-not-a-real-token'
export const ENV_SENTINEL = 'ENVIRONMENT-SENTINEL-value'

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
 * Stand-in apps that run inside the container with nothing but /usr: they read the prompt, take the
 * model and effort from their own arguments and answer as each app does. Words in the question
 * steer them: SLEEP, NAP, MISMATCH, SECOND, NOSESSION, FAIL, CEILING (Claude Code: model calls that
 * keep reporting usage while it runs). Pictures are reported by hash as each app received them:
 * Codex the `-i` files it can open, Claude Code the stream-json message on its standard input.
 */
const STEER = `question=$(cat)
id=$(printf %s "$question" | md5sum | cut -c1-8)
case $question in *SLEEP*) sleep 60;; esac
case $question in *NAP*) sleep 2;; esac
case $question in *FAIL*) echo 'provider error' >&2; exit 3;; esac
`
export function stubCodex(stubs: string, version = '0.162.1'): void {
  writeFileSync(join(stubs, 'codex'), `#!/bin/sh
[ "$1" = --version ] && echo "codex-cli ${version}" && exit 0
model=; effort=; prev=
pictures=
for a in "$@"; do
  [ "$prev" = -m ] && model=$a
  [ "$prev" = -i ] && pictures="$pictures $(sha256sum "$a" | cut -c1-64)"
  case $a in model_reasoning_effort=*) effort=$(printf %s "$a" | sed 's/.*="\\(.*\\)"/\\1/');; esac
  prev=$a
done
${STEER}thread=$id-0000-7000-8000-000000000000
case $question in *MISMATCH*) model=gpt-6-other;; esac
case $question in *NOSESSION*) ;; *) printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread";; esac
printf '{"type":"turn.started"}\\n'
printf 'INFO turn{otel.name="session_task.turn" thread.id=%s turn.id=t-1 model=%s codex.turn.reasoning_effort=%s}: started\\n' "$thread" "$model" "$effort" >&2
case $question in *SECOND*) printf '{"type":"thread.started","thread_id":"ffffffff-0000-7000-8000-000000000000"}\\n';; esac
printf '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"codex answer %s from %s%s"}}\\n' "$id" "$(ls /ask | tr '\\n' ' ')" "\${pictures:+pictures$pictures}"
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
printf '{"type":"assistant","session_id":"%s","message":{"model":"%s","usage":{"input_tokens":3,"output_tokens":4}}}\\n' "$sid" "$model"
printf '{"type":"result","subtype":"success","is_error":false,"result":"claude answer %s rules=%s%s","session_id":"%s","total_cost_usd":0.0123,"usage":{"input_tokens":3,"cache_creation_input_tokens":7,"cache_read_input_tokens":11,"output_tokens":4}}\\n' "$id" "$rules" "$input" "$sid"
`)
  chmodSync(join(stubs, 'claude'), 0o755)
}

/**
 * A stand-in OpenCode in sh: `auth export` and `auth import` keep a made-up sign-in in its data
 * folder, `run` answers from inside the container naming its session in every event and saving the
 * session's record, which `session export` prints. Words in the question steer it: SLEEP (waits as on
 * a provider it retries), FAIL (an error event), OTHERMODEL (the session ran another model).
 */
export function stubOpenCode(stubs: string, version = '2.0.29'): void {
  writeFileSync(join(stubs, 'opencode'), `#!/bin/sh
[ "$1" = --version ] && echo "${version}" && exit 0
data="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
case "$1 $2" in
  "auth export") if [ -f "$data/opencode.db" ]; then cat "$data/opencode.db"; else echo '[]'; fi; exit 0;;
  "auth import") mkdir -p "$data"; cat > "$data/opencode.db"; exit 0;;
  "session export") if [ -f "$data/session-$3.json" ]; then cat "$data/session-$3.json"; exit 0; fi; echo "no session" >&2; exit 1;;
esac
model=; agent=; prev=
for a in "$@"; do [ "$prev" = -m ] && model=$a; [ "$prev" = --agent ] && agent=$a; prev=$a; done
question=$(cat)
id=$(printf %s "$question" | md5sum | cut -c1-12)
sid="ses_\${id}AAAAAAAAAAAAAA"
signed=$(grep -c sk-synthetic "$data/opencode.db" 2>/dev/null || echo 0)
provider=\${model%%/*}; rest=\${model#*/}; mid=\${rest%%#*}; variant=\${rest#*#}
case $question in *OTHERMODEL*) mid=gpt-6-other;; esac
mkdir -p "$data"
printf '{"info":{"id":"%s","agent":"%s","title":"BMN ask","model":{"id":"%s","providerID":"%s","variant":"%s"},"cost":0.002,"tokens":{"input":60,"output":24,"reasoning":3,"cache":{"read":5,"write":0}}},"messages":[{"text":"MESSAGES-SENTINEL"}]}' "$sid" "$agent" "$mid" "$provider" "$variant" > "$data/session-$sid.json"
printf '{"type":"step_start","sessionID":"%s","part":{"type":"step-start"}}\\n' "$sid"
case $question in *SLEEP*) sleep 60;; esac
case $question in *FAIL*) printf '{"type":"error","sessionID":"%s","error":{"type":"provider.auth","message":"made-up sign-in failure"}}\\n' "$sid"; exit 1;; esac
printf '{"type":"text","sessionID":"%s","part":{"type":"text","text":"opencode answer %s agent=%s signed=%s from %s"}}\\n' "$sid" "$id" "$agent" "$signed" "$(ls /ask | tr '\\n' ' ')"
printf '{"type":"step_finish","sessionID":"%s","part":{"type":"step-finish","tokens":{"input":20,"output":8}}}\\n' "$sid"
`)
  chmodSync(join(stubs, 'opencode'), 0o755)
}

/** A made-up OpenCode Go sign-in in BMN's own OpenCode folder, as 70.4 copies the owner's there. */
export const GO_KEY_SENTINEL = 'sk-synthetic-go-key-SIGNIN-SENTINEL'
export function goSignInInBmnFolder(home: string, entries = [{ id: 'a1', integrationID: 'opencode-go', label: 'Go', active: true, value: { type: 'key', key: GO_KEY_SENTINEL } }]): void {
  const base = join(home, '.config/bmn/agents/state/opencode')
  for (const folder of ['home', 'config', 'state', 'cache', 'data/opencode']) mkdirSync(join(base, folder), { recursive: true })
  writeFileSync(join(base, 'data/opencode/opencode.db'), `${JSON.stringify(entries)}\n`)
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
  return { home, stubs, env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, SECRET_LOOKING_VARIABLE: ENV_SENTINEL } }
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
