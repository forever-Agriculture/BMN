# BMN inspiration library

This folder holds products and research material that can help shape BMN. This plan is tracked, but
the other contents are local and ignored by Git so full projects, screenshots, audits, and notes can
live here without entering the BMN repository.

## Product vision

BMN should become a polished universal desktop interface for working with AI harnesses and agents.
Claude Code, Codex, and whichever future tools prove useful should feel like parts of one coherent
workspace instead of separate apps that each demand their own workflow. The harness lineup is not
fixed: BMN should make it easy to replace a tool without replacing the surrounding workflow.

BMN remains a real terminal. The installed harnesses stay in charge of their own behavior,
authentication, permissions, and conversations. BMN provides the shared experience around them:
workspaces, sessions, attention, files, navigation, and a calm interface that is pleasant to use
every day.

BMN should also become a local coordination layer for harnesses and agents. Agents running in
different sessions should be able to discover one another, exchange task-relevant context, share
files and results, and hand work off without forcing the user to copy information between apps or
terminals. This communication should be easy to follow, explicitly scoped, and under the user's
control.

Keep this coordination deliberately trivial. Start with a few obvious local actions: identify a
session, send it a short message, share a file or result, and make an explicit handoff. Prefer these
small building blocks over a general orchestration system. Add more machinery only when repeated
real workflows prove that it is needed.

BMN already has a strong foundation: its creator genuinely likes the app and enjoys working in it.
Future design work should preserve that feeling and strengthen BMN's own identity. Reference apps
are sources of ideas, not replacements for the product that already works well.

## Current inspirations

### Zen Browser — visual direction

Zen is the main reference for a beautiful, distinctive, and enjoyable interface. Study its visual
hierarchy, use of space, motion, focus, navigation, customization, and the small details that make
the product feel polished.

The goal is not to copy Zen's browser UI. It is to learn how BMN can make a dense working tool feel
calm, coherent, and personal.

### Codex — interaction and design direction

Codex is a reference for both convenience and design. Its interface is simple, restrained, and
polished without feeling plain. Study its visual hierarchy, typography, spacing, navigation, and
focused use of controls, along with how it reduces friction when starting work, moving between
projects and conversations, following agent progress, reviewing results, and responding when the
agent needs input.

The goal is to preserve that visual clarity and ease while supporting several different harnesses
through one consistent BMN experience.

### BridgeMind — candidate for investigation

BridgeMind may become the third major reference. Its role is still open. Investigate it before
deciding which problems it solves especially well and which ideas fit BMN.

### OpenCode — candidate for replacement

OpenCode is currently supported, but it is not a preferred product or a design reference. Consider
removing or replacing it after identifying a better alternative. BMN's design should not make that
choice expensive.

### Superset — existing research material

The Superset audit already stored here is broader engineering and product research. Use it as a
source of tested patterns for process supervision, PTY lifecycle, agent integration, and workspace
design. It is research material, not yet a declared primary design reference.

## How to investigate an app

For each reference app:

1. Capture the specific workflows or details worth studying. Screenshots, short recordings, source
   code, audits, and notes are all useful.
2. Explain the user problem each idea solves. A visual detail without a purpose is not yet a useful
   idea.
3. Record why the idea works in its original product and whether the same conditions exist in BMN.
4. Adapt the idea to BMN's terminal-first, multi-harness model. Do not copy the surface blindly.
5. Note the likely value, implementation cost, and risks.
6. Check that the change preserves or improves what already makes BMN enjoyable to use.
7. Promote only the strongest ideas into BMN's design or implementation plans.

A useful extracted idea should answer:

- **Source:** Where did it come from?
- **Observation:** What exactly works well?
- **Problem solved:** What friction does it remove?
- **BMN adaptation:** How should it work here?
- **Evidence:** What makes us believe it is worth building?
- **Decision:** Adopt, experiment, park, or reject?

## Direction for BMN

The target is the combination of:

- the power and compatibility of a real terminal;
- one consistent interface across Claude Code, Codex, and a replaceable set of future harnesses;
- deliberately simple communication, sharing, and handoffs between agents and harnesses;
- Codex-like visual clarity, convenience, and restraint;
- Zen-like polish, personality, and pleasure in daily use;
- BMN's own strengths in durable sessions, agent attention, files, local control, and privacy.

The aim is to make BMN more fully itself, while keeping the experience its creator already enjoys.

This document is a living plan. Update it when a new reference earns a place, an investigation
changes our view, or an idea becomes a concrete BMN decision.
