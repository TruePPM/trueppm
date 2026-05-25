# 2026-05 Design batch → Claude Code handoff

Single package covering 14 issues across 5 surfaces. All open decisions
listed in the briefs are **resolved** below; the spec docs assume those
decisions. If you want to revisit a decision, do it before implementation
— don't drift from the spec mid-build.

## What's in here

| File | Issue(s) | Surface |
|---|---|---|
| `00-design-system-context.md` | — | Tokens, file paths, AA baseline, glossary |
| `01-board-bulk-select.md` | #276 | Multi-select + bulk action bar |
| `02-board-search.md` | #323 | Dim-in-place search |
| `03-board-groupby.md` | #324, #608 | Unified groupBy + swimlanes (reconciles #608) |
| `04-board-activity.md` | #325 | Board activity rail |
| `05-board-pdf.md` | #326 | Print stylesheet (WeasyPrint) |
| `06-board-zoom.md` | #379 | Density-tier zoom |
| `07-schedule-pan.md` | #491 | Drag-to-pan (pair with #351) |
| `08-cross-view-drag.md` | #318 | Backlog → Schedule cross-view drag |
| `09-import-pattern.md` | #68 | Import modal + export — sets the file-IO pattern |
| `10-import-wizard.md` | #111 | CSV/Excel 3-step wizard (extends #68) |
| `11-overalloc-language.md` | #330, #489, #747 | Shared overallocation visual language |
| `12-notes-mentions-decisions.md` | #735, #740, #745, #748 | Notes, blocker, mentions, decisions |
| `visual-specs.html` | — | Annotated visual reference for the 5 surfaces a picture helps |
| `claude-code-prompt.md` | — | Paste into Claude Code to start the implementation pass |

## Cross-cutting decisions

These are referenced by multiple specs — settle once, apply everywhere.

### D1. Persistence layer for board view state (resolves #324 ↔ #608)
**Decision: `BoardSavedView` is the source of truth. `useBoardToolbarPrefs`
becomes a thin "last-used view" pointer + transient unsaved overrides.**

- groupBy, zoom level, search query (transient — not persisted), activity
  panel collapsed/expanded → all live on `BoardSavedView`.
- `useBoardToolbarPrefs` keeps: `lastViewId` per board, and a transient
  `dirtyOverrides` patch for unsaved changes (cleared on view switch or
  explicit save).
- Migration: existing per-user prefs (groupBy, zoom) copy into a synthesized
  "My view" saved view on first load, scoped private to the user.

Rationale: groupBy + sprint axis + collapsed lanes are sharing-worthy
("here's the view I used in the standup"). Per-user prefs aren't.

### D2. groupBy axis set (resolves #324)
**Decision: `Phase | Sprint | Assignee | Team`** — single segmented control,
overflows to dropdown below 720px. No Assignee+Team or Assignee+Sprint
cross-axis grouping in v1; users who need both pivot through saved views.

### D3. Selection model (resolves #276)
**Decision: implicit selection via card checkbox on hover/focus + Shift-click
range + ⌘/Ctrl-click toggle.** No explicit "Select mode" toggle. Mobile
gets long-press → enters a transient multi-select state that auto-exits
when selection drops to 0.

Rationale: matches Linear / Notion / GitHub norms; no mode-switching tax.

### D4. Cross-view drag layout (resolves #318)
**Decision: Schedule view gains a "Plan" affordance — a docked, collapsible
**backlog rail** on its left edge.** The board is NOT shown side-by-side
in Schedule view; the rail is a focused subset (backlog cards for the
current sprint/project, filterable). Cross-view drag = drag from rail
onto the canvas. Mobile: rail becomes a bottom sheet; drag is replaced by
the keyboard/touch "Schedule…" path.

Rationale: avoids the layout disaster of two heavyweight surfaces splitting
the viewport; matches how the team currently triages.

### D5. Import entry point (resolves #68)
**Decision: project toolbar overflow menu** (`···` → "Import…" / "Export…").
Settings has a deep link to the same modal. Modal — not full page — even
for large imports; the wizard scrolls.

### D6. Overallocation visual language (shared across #330, #489)
One pattern, three densities — defined in `11-overalloc-language.md`.
**Both the assignee picker and the Team-tab allocation table consume the
same `<OverallocBadge>` and `<OverallocBanner>` components.**

## How to use this package

1. Read `00-design-system-context.md` first — tokens and file paths.
2. Read `claude-code-prompt.md` and paste it into Claude Code.
3. Implement one surface at a time, in the order Claude Code suggests
   (it'll start with the shared primitives: import modal pattern,
   overallocation language, board-toolbar refactor).
4. Open `visual-specs.html` in the browser when a spec says
   "see visual-specs.html → §N".

## What this package deliberately does NOT do

- It does not redesign the board card itself (epic #303, separate handoff).
- It does not spec keyboard shortcuts beyond what's listed per ticket.
- It does not invent new icons; reuse the existing icon set (lucide-react
  inventory in `apps/web/src/components/icons/`).
- It does not specify backend / API contracts. Where a UI assumes an API,
  the spec calls it out as a `[BACKEND]` note.
