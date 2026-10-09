<!-- MODULE: roster-example.md - synthetic Epic 60 roster reproducing dev-auto's helper table, for tests and docs -->
# Team roster (synthetic example)

A synthetic roster for BMN's tests and docs. It reproduces dev-auto's helper table as typed role
chains; nothing here is anyone's live configuration. Prose such as PROSE-SENTINEL-PREAMBLE is never
parsed and never printed to an agent.

## roster

```yaml
schema_version: 1
```

## sol

```yaml
name: Sol
title: knight
harness: codex
model: gpt-6.1-sol
provider: openai
host: default
security: high
trust: 3
authority: lead
enabled: true
status: active
efforts: [low, medium, high, xhigh, max]
roles: [lead]
cost: low
quota: QUOTA-SENTINEL-SOL
tags: [TAG-SENTINEL-SOL]
```

Owner's opinion: PROSE-SENTINEL-SOL.

## opus

```yaml
name: Opus
title: knight
harness: claude
model: claude-opus-5-5
provider: anthropic
host: default
security: high
trust: 3
authority: lead
enabled: true
status: active
efforts: [low, medium, high, xhigh, max]
roles: [lead]
cost: high
```

Owner's opinion: PROSE-SENTINEL-OPUS.

## astra

```yaml
name: Astra
title: knight
harness: codex
model: gpt-6-astra
provider: openai
host: default
security: high
trust: 3
authority: review
enabled: true
status: active
efforts: [low, medium, high]
roles: [focused-reviewer, epic-reviewer, final-reviewer, consultant]
cost: high
```

## fable

```yaml
name: Fable
title: knight
harness: claude
model: claude-fable-5-1
aliases: [fable]
provider: anthropic
host: default
security: high
trust: 3
authority: review
enabled: true
status: active
efforts: [low, medium, high]
roles: [epic-reviewer, final-reviewer, consultant]
cost: high
```

## luna

```yaml
name: Luna
title: squire
harness: codex
model: gpt-6-luna
provider: openai
host: default
security: high
trust: 2
authority: read
enabled: true
status: active
efforts: [max]
roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]
cost: low
```

## sonnet

```yaml
name: Sonnet
title: knight
harness: claude
model: claude-sonnet-5-5
provider: anthropic
host: default
security: high
trust: 2
authority: review
enabled: true
status: proposed
efforts: [low, medium, high]
roles: []
```

## haiku

```yaml
name: Haiku
title: squire
harness: claude
model: claude-haiku-5-5
provider: anthropic
host: default
security: high
trust: 1
authority: read
enabled: true
status: proposed
efforts: [low, medium, high]
roles: []
max_context_tokens: 100000
```

## glm

```yaml
name: GLM-5.3
title: squire
harness: claude
model: glm-5.3
provider: zai
host: api.z.ai
security: low
trust: 1
authority: read
enabled: false
enabled_note: NOTE-SENTINEL-GLM
status: active
efforts: []
roles: [helper]
```

Deactivated in this example. PROSE-SENTINEL-GLM.

## roles

```yaml
lead: {candidates: [sol@xhigh, opus@xhigh], then: owner-chooses}
helper: {candidates: [luna@max], then: lead}
focused-reviewer: {candidates: [luna@max, astra@low], then: lead}
browser: {candidates: [luna@max], then: lead}
pre-reviewer: {candidates: [luna@max], then: skip}
epic-reviewer: {candidates: [astra@medium, fable@medium], then: blocked, recheck: {same_reviewer: true, astra: low}, small_epic: astra@low}
project-pre-reviewer: {candidates: [luna@max], then: skip}
final-reviewer: {candidates: [astra@high, fable@high], then: blocked, recheck: {same_reviewer: true, astra: low}}
consultant: {candidates: [astra@medium|high, fable@medium|high], then: blocked}
```

## data-labels

```yaml
default: private
```

## harness-routes

```yaml
claude: {provider: anthropic, security: high, basis: observed-default}
codex: {provider: openai, security: high, basis: observed-default}
opencode: {provider: opencode-go, security: low, basis: observed-default}
cursor: {provider: cursor, security: low, basis: owner-declared}
```
