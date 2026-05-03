# Card Information Dialogs

_Started 2026-05-01 02:23 UTC_

---

## User

create dialogs for card information & tasks.

## Assistant

I'll explore the attached folder to understand the project's design system and existing patterns before creating the dialogs.

_[tool: local_ls]_

_[tool: local_ls]_

Acknowledged on the reminder — I'll create original UI for TruePPM, not recreate any branded/copyrighted product UI.

Let me explore the design context to understand the existing visual system.

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_ls]_

_[tool: local_ls]_

Let me read the existing card and task drawer components to match patterns.

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

I have enough context to design the dialogs. Let me ask a few quick clarifying questions and check the Task type.

_[tool: snip]_

_[tool: local_read]_

_[tool: local_ls]_

_[tool: local_read]_

_[tool: snip]_

I have enough context now. Let me ask focused questions before building.

_[tool: questions_v2]_

## User

Questions answered:
- scope: All three: Card info + Task create/edit + Task detail drawer
- fidelity: Decide for me
- variations: 2 — A/B layouts
- fields: Name, status, dates, duration, Assignees + units, Progress + readiness, Dependencies (predecessors/successors), Description / notes
- modes: Decide for me
- theme: Decide for me
- tweaks: Decide for me
- context: Decide for me
- novelty: Decide for me

## Assistant

_[tool: snip]_

Plan: I'll build a single design canvas with 3 sections (Quick Card Info popover · Task Create/Edit modal · Task Detail Drawer) × 2 variation columns each. All variants follow TruePPM tokens (no shadows, neutral/brand/semantic, Inter + JetBrains Mono, .tppm-mono for numerics). Light mode primary, with one dark variation.

Aesthetic: rule-respecting, with composition variety — A is "structured form" (label-above), B is "inline-editable" (click-to-edit, denser).

_[tool: copy_starter_component]_

Now let me build the dialogs.

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

Now let me build the three dialog files (card popover, create/edit modal, detail drawer) — each with two variations.

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Built three dialog families × two layouts each on a single canvas:

- **Card information popover** (clicked from a board card): A is a structured label/value summary with critical-path accent; B is a hero header with progress ring, inline meta strip, and "blocked by" preview.
- **Task create/edit modal**: A is a 560px centered modal with label-above fields (works for create); B is a 760px two-pane edit with a Notion-style properties side panel.
- **Task detail drawer** (right-side slide-in): A is the tabbed pattern (Overview / Dependencies / Activity) with a 4-stat strip and progress bar; B is single-scroll with a left meta rail and collapsible sections — better for skimming.

All variants stick to the rules in `CLAUDE.md`: no shadows, neutral/brand/semantic tokens only, Inter + JetBrains Mono with `.tppm-mono` on every numeric, focus rings on every interactive, CP/readiness chip patterns matching the existing BoardCard. Dark-mode counterparts shown for one variant in each section.

