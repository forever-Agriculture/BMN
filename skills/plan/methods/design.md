# Design

Use when an epic adds or changes something a person sees or operates (screens, dialogs, cards, messages, a CLI's output the owner reads). The team's designer designs first (`bmn roster role designer`); the owner approves; the approved design becomes the design truth document that `PLAN.md` indexes. Nothing here replaces the designer: this is what the plan must state so the design and the stories agree.

## What the plan states

- **Flows:** each journey the epic changes, step by step, from where the person starts to the result, including how they get back.
- **States:** loading, empty, error, stale, partial, offline, too long (realistic content sizes: the longest name, a hundred rows, a 4,000-character command) and the sizes it must fit (the narrowest window, a phone).
- **Interaction:** keyboard, focus, what is clickable, what never moves under the pointer; accessibility (contrast, labels, reduced motion).
- **Visual rules:** the project's standing rules (colours, type, spacing, what attention looks like) and any new one the design introduces.

## Steps

1. A design story first, by the designer, with the flows and states above as its criteria; the owner approves the result (one card).
2. Screen stories cite the approved design and carry its states as criteria; Verification names the viewport sizes and the real content sizes it checks.
3. The design truth document (or `PLAN.md`'s Decisions for a small project) gains the new rules; the epic's Truth impact names it.

## Done when

Every state a person can reach is designed, every screen story's criteria name the states and sizes it must handle, and the owner approved what he will see.
