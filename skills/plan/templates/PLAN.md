# <Project name>: the plan

What this project is for and the rules every epic plans within, built on `VISION.md`. Keep it short (at most 20 KiB); detail lives in the truth documents it indexes. Epics are in `epics/`, the board is `status.yaml`.

## Purpose

<One paragraph: the problem, for whom, and why now.>

## Users

- <Who uses it, and what they need from it.>

## Goals

- <An outcome, measurable where possible.>

## Non-goals

- <What this project deliberately does not do.>

## Success signals

- <What we observe when it works: a number, a behavior, a check.>

## Standing constraints

- <A rule every epic keeps: platform, privacy, budget, a decision of the owner's with its date.>

## Architecture

How the product is built, as far as epics must keep it: a link to the architecture document (`docs/architecture.md`) with a two-line summary, or the contract inline, or `None needed: <reason>` for a small tool whose stories share no state or contracts. Inline, keep to:

- **Parts and owners:** <component or module; what it owns; what it may depend on.>
- **Invariants:** <A1: the rule that must always hold; the failure it prevents.>
- **Shared data and interfaces:** <data, files, APIs, events several stories touch, and their contract.>
- **Quality targets:** <a budget that matters (latency, size, privacy, reliability); how it is measured.>
- **Technology choices:** <choice; why; evidence.>
- **Glossary:** <a term agents must use one way; only when ambiguity has cost something.>
- **Privacy and providers:** <only when data leaves the machine or crosses an authority boundary: data → destination → who authorized it → kept how long.>
- **Assumptions and open decisions:** <assumption or open question; what would settle it; the work it blocks.>

## Decisions

Architecture and design decisions in force, each with its date and source, or where they live.

- <YYYY-MM-DD: the decision; why; link to the truth document.>

## Truth documents

What is true now about the product (epics propose changes; these documents describe the result).

- `<docs/architecture.md>`: <what it covers>
