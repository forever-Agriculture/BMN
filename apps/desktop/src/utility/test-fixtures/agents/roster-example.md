<!-- MODULE: roster-example.md - synthetic Epic 60 roster reproducing dev-auto's helper table, for tests and docs -->
# Team roster (synthetic example)

A synthetic roster for BMN's tests and docs. It reproduces dev-auto's helper table as typed role
chains; nothing here is anyone's live configuration. Prose such as PROSE-SENTINEL-PREAMBLE is never
parsed and never printed to an agent.

## roster

```yaml
schema_version: 2
```

## providers

```yaml
openai: {name: OpenAI, hosts: [api.openai.com], sites: [openai.com], private_work: allowed}
anthropic: {name: Anthropic, hosts: [api.anthropic.com], sites: [anthropic.com], private_work: allowed}
zai: {name: Z.ai, hosts: [api.z.ai], private_work: public_only}
opencode-go: {name: OpenCode Go, hosts: [], private_work: public_only}
cursor: {name: Cursor, hosts: [], private_work: public_only}
```

## sol

```yaml
name: Sol
class: knight
harness: codex
model: gpt-6.1-sol
provider: openai
host: default
enabled: true
status: active
efforts: [low, medium, high, xhigh, max]
roles: [lead]
context_window: 400000
context_limit: 272000
paid_by: subscription
price: {input: 1.25, cached_input: 0.125, output: 10, source: "https://prices.example.test/PRICE-SENTINEL-SOL", as_of: 2026-10-01}
```

Owner's notes: PROSE-SENTINEL-SOL.

## opus

```yaml
name: Opus
class: knight
harness: claude
model: claude-opus-5-5
provider: anthropic
host: default
enabled: true
status: active
efforts: [low, medium, high, xhigh, max]
roles: [lead]
paid_by: subscription
```

Owner's notes: PROSE-SENTINEL-OPUS.

## astra

```yaml
name: Astra
class: bishop
harness: codex
model: gpt-6-astra
provider: openai
host: default
enabled: true
status: active
efforts: [low, medium, high]
roles: [focused-reviewer, epic-reviewer, final-reviewer, consultant]
```

## fable

```yaml
name: Fable
class: rook
harness: claude
model: claude-fable-5-1
provider: anthropic
host: default
enabled: true
status: active
efforts: [low, medium, high]
roles: [designer, epic-reviewer, final-reviewer, consultant]
aliases: [fable]
```

## luna

```yaml
name: Luna
class: pawn
harness: codex
model: gpt-6-luna
provider: openai
host: default
enabled: true
status: active
efforts: [max]
roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]
```

## sonnet

```yaml
name: Sonnet
class: bishop
harness: claude
model: claude-sonnet-5-5
provider: anthropic
host: default
enabled: true
status: proposed
efforts: [low, medium, high]
roles: []
```

## haiku

```yaml
name: Haiku
class: pawn
harness: claude
model: claude-haiku-5-5
provider: anthropic
host: default
enabled: true
status: proposed
efforts: [low, medium, high]
roles: []
context_window: 200000
context_limit: 100000
compact_at: 80000
```

## glm

```yaml
name: GLM-5.3
class: pawn
harness: claude
model: glm-5.3
provider: zai
host: api.z.ai
enabled: false
status: active
efforts: []
roles: [helper]
enabled_note: NOTE-SENTINEL-GLM
```

Deactivated in this example. PROSE-SENTINEL-GLM.

## roles

```yaml
lead: {description: leads an epic/project start to finish, candidates: [sol@xhigh, opus@xhigh], then: owner-chooses}
designer: {candidates: [fable@medium], then: lead}
helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna@max], then: lead}
focused-reviewer: {candidates: [luna@max, astra@low], then: lead}
browser: {candidates: [luna@max], then: lead}
pre-reviewer: {candidates: [luna@max], then: skip}
epic-reviewer: {candidates: [astra@medium, fable@medium], then: blocked, recheck: {same_reviewer: true, astra: low}, small_work: astra@low}
project-pre-reviewer: {candidates: [luna@max], then: skip}
final-reviewer: {candidates: [astra@high, fable@high], then: blocked, recheck: {same_reviewer: true, astra: low}}
consultant: {candidates: [astra@medium|high, fable@medium|high], then: blocked}
```

## exceptions

```yaml
zai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}
```

## harness-routes

```yaml
claude: {provider: anthropic, basis: observed-default}
codex: {provider: openai, basis: observed-default}
opencode: {provider: opencode-go, basis: observed-default}
cursor: {provider: cursor, basis: owner-declared}
```
