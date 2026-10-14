// MODULE: team-ask-harness.ts - Epic 72 test harness: an isolated home with a synthetic approved team, made-up sign-in files and stand-in Codex and Claude Code apps written in sh that run inside BMN's real container; no provider is reached
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
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
 * keep reporting usage while it runs).
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
for a in "$@"; do
  [ "$prev" = -m ] && model=$a
  case $a in model_reasoning_effort=*) effort=$(printf %s "$a" | sed 's/.*="\\(.*\\)"/\\1/');; esac
  prev=$a
done
${STEER}thread=$id-0000-7000-8000-000000000000
case $question in *MISMATCH*) model=gpt-6-other;; esac
case $question in *NOSESSION*) ;; *) printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread";; esac
printf '{"type":"turn.started"}\\n'
printf 'INFO turn{otel.name="session_task.turn" thread.id=%s turn.id=t-1 model=%s codex.turn.reasoning_effort=%s}: started\\n' "$thread" "$model" "$effort" >&2
case $question in *SECOND*) printf '{"type":"thread.started","thread_id":"ffffffff-0000-7000-8000-000000000000"}\\n';; esac
printf '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"codex answer %s from %s"}}\\n' "$id" "$(ls /ask | tr '\\n' ' ')"
printf '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5,"reasoning_output_tokens":2}}\\n'
`)
  chmodSync(join(stubs, 'codex'), 0o755)
}
export function stubClaude(stubs: string, version = '2.1.300'): void {
  writeFileSync(join(stubs, 'claude'), `#!/bin/sh
[ "$1" = --version ] && echo "${version} (Claude Code)" && exit 0
model=; effort=; prev=
for a in "$@"; do [ "$prev" = --model ] && model=$a; [ "$prev" = --effort ] && effort=$a; prev=$a; done
rules=no
for a in "$@"; do case $a in *RULES-SENTINEL*) rules=yes;; esac; done
${STEER}sid=$id-0000-4000-8000-000000000000
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
printf '{"type":"result","subtype":"success","is_error":false,"result":"claude answer %s rules=%s","session_id":"%s","total_cost_usd":0.0123,"usage":{"input_tokens":3,"cache_creation_input_tokens":7,"cache_read_input_tokens":11,"output_tokens":4}}\\n' "$id" "$rules" "$sid"
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
