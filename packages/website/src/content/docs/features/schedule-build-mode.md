---
title: Schedule Build Mode
description: Keyboard-first surface for laying down and structuring a project plan directly in the Schedule list.
---

Schedule build mode turns the Schedule list into a keyboard-first surface for laying down and structuring a project plan. It is opt-in, gated behind the `schedule_build_mode_v1` feature flag, and is a desktop-only experience — mobile continues to use the existing Add Task modal.

The goal is to collapse the round-trip cost of structuring a plan from "open modal → fill form → save → repeat" to "type, Tab, type, Enter."

## What build mode is — and what it isn't

Build mode is a **schedule-construction** tool. It is the fastest way to lay down and structure the work breakdown structure (WBS) of a project: type a task name, `Tab` to indent it under the row above (which becomes a phase), `Space` to mark it complete, `F2` to edit it. Everything happens on the **Schedule view**, in the task list, with the keyboard.

Build mode is **not** sprint planning. It does not create sprints, move cards, set velocity, or triage a backlog — that work lives on the [Board](/features/board/), the [Sprint planning](/features/plan-sprint/) surface, and the [Product backlog](/features/product-backlog/). If you are an agile team deciding *what goes in the next sprint*, build mode is the wrong surface; if you are laying out *the shape of the plan itself* — phases, tasks, durations, and dependencies — build mode is exactly it.

| Build mode is for… | …not for |
|---|---|
| Structuring the WBS: phases, tasks, indent / outdent | Deciding sprint scope or moving cards |
| Setting durations and % complete inline | Estimating story points (that's [estimation poker](/features/estimation-poker/)) |
| Wiring predecessor / successor dependencies | Board triage or backlog refinement |
| Keyboard-first plan entry on the Schedule view | Any mobile workflow — build mode is desktop-only |

## Enabling build mode

Build mode is **off by default** and opt-in per browser. The recommended way to turn it on needs no developer tooling; the remaining methods exist for URL sharing, scripting, and self-hoster defaults.

### From Settings (recommended)

Open **Settings → Schedule** and switch **Build mode (beta)** on. The setting is per-user and applies to the browser you toggle it in — it takes effect on the Schedule view immediately, with no page reload. Turn it off again from the same place.

Once build mode is on, a **View keyboard shortcuts** link appears beside the toggle; it opens the same cheatsheet you get by pressing `?` on the Schedule view, so you can learn the hotkeys before you start.

### Other ways to enable it

| How | Where | Notes |
|---|---|---|
| URL parameter | Append `?ff=schedule_build_mode_v1` to any TruePPM URL once. | The flag is stored in `localStorage` and persists across navigations and page reloads. The `ff` query string is stripped from the URL after it's applied. Handy for sharing an enable link. |
| Browser devtools | `localStorage.setItem('trueppm.featureFlags', JSON.stringify({schedule_build_mode_v1: true}))` | Same persistence as the URL form. |
| Build-time default | Set `VITE_FEATURE_FLAGS='{"schedule_build_mode_v1":true}'` in `packages/web/.env` (or `.env.development`) before `npm run build` / `npm run dev`. | Useful for self-hosters who want to enable build mode for all users by default. Per-user `localStorage` overrides (including the Settings toggle) win over the build-time default. |

To turn it off in your browser, switch the Settings toggle off, run `localStorage.setItem('trueppm.featureFlags', JSON.stringify({schedule_build_mode_v1: false}))`, or clear the `trueppm.featureFlags` key entirely.

## What changes when build mode is on

Two visible signals appear on the Schedule view:

- A **`⌨ Build mode` pill** in the toolbar (left side, next to the +Task button). Clicking it opens the keyboard cheatsheet.
- A **bottom hint strip** that always shows the three most relevant hotkeys for what you're currently focused on. Pressing `?` opens the full cheatsheet from anywhere on the page.

The Schedule list rows also gain new keyboard behavior — see below.

## Keyboard reference

The Schedule list is in one of three focus states at any time. The same keys do different things in each — the hint strip and cheatsheet always show what's active.

### When nothing is selected (NoSelection)

| Key | Action |
|---|---|
| ↑ ↓ | Move focus into the list |
| Click a row | Select that row |
| ? | Show / hide the cheatsheet |

### When a row is focused (RowFocused)

| Key | Action |
|---|---|
| Enter | Insert a new sibling row below (same level) and drop into its Name cell — the fast "type, Enter, type" flow |
| F2 | Edit the focused cell (defaults to the Task name) |
| Letter key | Start typing — opens the Task name cell |
| Tab | Indent under the previous sibling row (forms an emergent phase) |
| Shift + Tab | Outdent one level |
| ↑ ↓ | Move focus to the next / previous row |
| Alt + ↑ / ↓ | Reorder the row among its same-indent siblings |
| Space | Mark the focused row complete / un-complete |
| ⌘ D / Ctrl + D | Duplicate the focused row |
| Right-click | Open the row context menu (Edit / Indent / Outdent / Convert to milestone / Delete) |
| Delete / Backspace | Delete the row (no confirm — undo via re-adding) |
| Esc | Clear selection |

### Schedule-wide shortcuts (always on)

| Key | Action |
|---|---|
| ⌘ M / Ctrl + M | Insert a new milestone at today's date |
| ? | Open the keyboard shortcut cheatsheet (build mode only) |

### When a cell is being edited (CellEdit)

| Key | Action |
|---|---|
| Enter | In the **Name** cell: save, then open a new sibling row below ready to name (commit-and-continue — a blank name makes the next Enter a calm stop). In the Duration / % cells: save and return focus to the row |
| Esc | Discard your edit and return focus to the row |
| Tab | Save and move to the next editable cell in the same row |
| Shift + Tab | Save and move to the previous editable cell |

The editable cells in v1 are **Task name**, **Duration**, and **% complete**. Start and Finish are computed from CPM and remain read-only — change a Planned Start to override.

### Dependencies

| Action | Result |
|---|---|
| Hover a row | Reveals its dependency chain — predecessors highlight blue, successors highlight green |
| Right-click | Opens the row menu, where **Add predecessor** / **Add successor** open a task picker |

## Indenting and emergent phases

When you indent a row under a leaf row (one with no children), the parent automatically becomes a summary task — its name goes bold, computed dates roll up from its children, and the chevron lets you collapse / expand. There is no "convert this to a phase" step; phases form as a side effect of structuring.

The reverse holds when you outdent: if a summary task loses all its children, it becomes a leaf again on the next refresh.

## What's not in v1

- **No mobile signal.** Build mode is desktop-only. On mobile, use the Add Task button as before.
- **No positional insert.** Enter adds a new sibling row, but the server appends it at the end of its parent's children rather than immediately below the focused row — precise mid-list insertion is not supported yet.
- **No optimistic indent.** Indent / outdent waits ~50ms for the server to confirm before the row position updates.
- **No multi-row select / fill-down / paste-from-Excel.** Single-row keyboard editing only.
- **No Sprint backlog parity yet.** The same inline-edit / Tab pattern will extend to the Sprint backlog table in a future release.

## See also

- [Schedule view toolbar](/features/schedule-toolbar/) — toolbar controls, filter groups, and the summary chip
