# ADR-0002: UI Harmonization — Chrome, Gantt Colors, Design Token Gaps (Issue #44)

## Status
Accepted (2026-05-31) — implemented in #44

## Context

Issue #44 requires aligning the web UI chrome (top nav, sidebar, toolbar, Gantt bar colors,
status bar) to the approved Opus mockup. This is a structural/styling change with no new backend
endpoints.

The CLAUDE.md design rules for issue #44 are already encoded in rules 35–50. However, a
systematic audit of the codebase reveals that several foundational design tokens referenced by
those rules do not yet exist in `tailwind.config.ts`. Without those tokens, no implementation
of those rules is possible — any component referencing an undefined token silently falls back
to an empty class.

## Decision

### D1 — Design token gap: add missing Gantt and dark-surface tokens before any #44 work

The following token groups are referenced in CLAUDE.md rules 40, 41, 72, 73, and the
`gantt.css` override file, but are absent from `tailwind.config.ts`:

| Token | Required Value | Rule |
|-------|---------------|------|
| `gantt.surface` | `#0F1117` | 40, 59 (canvas bg) |
| `gantt.text-primary` | `#E8E8E8` | 40, 72 |
| `gantt.text-secondary` | `rgba(148,163,184,0.6)` | 75 (arrows) |
| `gantt.text-disabled` | TBD from Opus mockup | 40 |
| `gantt.semantic-critical` | `#F87171` (Red 400) | 41, 73 |
| `gantt.semantic-at-risk` | `#FB923C` (Orange 400) | 41 |
| `gantt.semantic-on-track` | `#4ADE80` (Green 400) | 41 |

All of these are referenced by the Gantt bar and canvas rules. Without them, rule 40 ("no
`neutral-*` tokens inside the Gantt split pane") cannot be enforced by token name — components
would need to hardcode hex values, which rule 8 prohibits.

**This token addition is a prerequisite for any #44 implementation and must ship as the first
commit on the #44 branch.**

### D2 — Sidebar background: `bg-gantt-surface`, not `bg-brand-primary`

Per rule 35. Current `Sidebar.tsx` must be audited for any `bg-brand-primary` usage on the
sidebar container element and replaced with `bg-gantt-surface`. Interactive elements (buttons,
active row accents) retain `brand-primary` per rule 35.

### D3 — Sidebar section headers: `<h2>` with `text-xs font-semibold tracking-widest uppercase text-gantt-text-secondary`

Per rule 36. Currently the sidebar uses text styling that has not been verified against this
rule. The `text-[10px]` class (prohibited by rule 50) must not appear. The current implementation
must be audited on the `#44` branch.

### D4 — Sidebar active-row: 2px left border required in addition to fill

Per rule 37. `border-l-2 border-brand-primary` plus `bg-white/10` — not border alone.

### D5 — ViewTabs active state: underline only (`border-b-2 border-brand-primary`)

Per rule 38. `ViewTabs.tsx` already implements this correctly (verified in code review). No
change needed for ViewTabs.

### D6 — TopBar badges: outlined style with semantic scope copy

Per rule 39. Badges must be `<button aria-haspopup="menu">` elements opening `role="menu"`
popovers. Badge labels: `{n} at risk tasks`, `{n} critical tasks`. These must NOT use
`role="listbox"`.

### D7 — Gantt dark surface: task list and SVAR timeline use `bg-gantt-surface`

Per rule 40. The task list panel (`TaskListPanel.tsx`) and SVAR host container must use
`bg-gantt-surface` once the token is added. No `neutral-surface*` inside the Gantt split pane.

### D8 — StatusBar: exact copy, legend order, `hidden lg:flex` for online count

Per rules 44–45. Legend order is frozen: Complete · In progress · Critical path · Milestone.
Online count is `hidden lg:flex` (not `2xl:contents`). Copy format: `Last saved: {N} min ago`.
Separate "Recalculated: {time}" indicator required.

### D9 — GanttToolbar view-switcher: `role="group" aria-label="View mode"` with `aria-pressed`

Per rule 42. WBS and Table buttons remain `disabled aria-disabled="true"` until #40 ships.

### D10 — Gantt column layout: `COL_DUR_START` (100px) combining duration + start date

Per rule 43. Format: `{n}d · {MMM D}`. Separate `COL_DURATION` and `COL_START` constants
are removed.

### D11 — Branch strategy: #44 is a separate branch from #40

These issues have no code dependency on each other at the component level. #44 is purely
styling/chrome work; #40 is new view panels. Coupling them creates an unnecessarily large
diff, makes review harder, and means #44's clean token-gap fixes are held hostage to #40's
backend blockers.

**Decision: #44 ships first (or in parallel) on its own branch. #40 opens after the two
backend endpoints from ADR-0001 are merged.**

Exception: both issues reference the same token definitions. The token additions (D1 above)
must land before #40 uses any `gantt-*` token in new views. Sequencing:
1. #44 branch: add tokens + chrome harmonization.
2. #40 branch: opens after #44 tokens are on `main`, so new view components can use the
   same token set without re-adding them.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Add tokens inline as hardcoded hex in components | Faster | Violates rule 8; untestable; drift guaranteed |
| Add tokens in tailwind.config.ts (chosen) | Canonical; enforced by rule 8; shareable | One-time work before any component touches gantt-surface |
| Bundle #44 and #40 on one branch | One MR | Large diff; #40 blocked on backend; review surface too wide |
| Separate branches (chosen) | Independent review; #44 unblocked; tokens land before #40 | Slight coordination overhead |

## Consequences

**Easier:**
- Once `gantt-surface` and `gantt-text-*` tokens exist, all dark-surface components can be
  written with purely token-based classes — no hex in components anywhere.
- The canvas renderer (rules 54–85) uses the same tokens for its `ctx.fillStyle` lookups
  via a CSS variable bridge (e.g., `var(--tw-gantt-surface)`).
- Rule 8 enforcement at review time becomes unambiguous — reviewers check for token names,
  not hex pattern matches.

**Harder:**
- Any future design system color change requires only one edit in `tailwind.config.ts` and
  the canvas `colorMap` lookup table — not a grep-and-replace across components.

**Risks:**
- If `gantt-text-secondary` is expressed as `rgba(...)` it is not a valid Tailwind CSS color
  shorthand for background/text utilities. It should be defined as a CSS custom property and
  used via `style` prop for opacity-blend values, or defined as a named color at full opacity
  with Tailwind's `/opacity` modifier. Clarify before implementation.
- `gantt-surface` must also be added as a CSS custom property (e.g., `--gantt-surface:
  #0F1117`) in the Tailwind theme so the canvas renderer can read it from `getComputedStyle`
  without importing `tailwind.config.ts` at runtime.

## Implementation Notes

- Affected packages: `web` only (no API changes, no migrations)
- Migration required: no
- API changes: no
- OSS: yes
- First commit on #44 branch must be the token additions to `tailwind.config.ts`
- Reference the Opus mockup for any token values not yet specified in CLAUDE.md rules
- After token addition, work through rules 35–50 component by component:
  `Sidebar.tsx` → `TopBar.tsx` → `TaskListPanel.tsx` → `StatusBar.tsx` → `GanttView.tsx` toolbar row
