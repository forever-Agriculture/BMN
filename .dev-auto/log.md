# Dev Auto log (append-only)

## 2026-09-20 — Epic 13 run start

- Owner command: `/dev-auto 13` (Claude Code, Opus 5 1M, session `ea13531c-e72d-4534-8edc-d155f1750851`).
- Board reconciled at `85df305`: epics 5-9 done, 13 next in the owner-decided order 13 -> 14 -> 12 -> 11 -> 10.
- `codex resume --help` on codex-cli 0.155.1 read by hand on 2026-09-20 for AC4; the accepted option
  table equals the top-level interactive options plus `--last`, `--all`, `--include-non-interactive`
  (resume-only, so a plain `codex` launch can never carry them). `--help`/`--version` deliberately
  excluded from the carried set.
- Codex rollout ids observed as UUIDv7 (`~/.codex/sessions/2026/09/19/rollout-*-01a0b657-21a8-7f00-addd-b73646828f5b.jsonl`)
  and Claude session ids as UUIDv4, both admitted by the existing `UUID_PATTERN`.
