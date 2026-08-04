---
title: Schedule Build Mode
description: Keyboard-first surface for laying down and structuring a project plan directly in the Schedule list.
documentedFor: "0.4"
---

Schedule build mode turns the Schedule list into a keyboard-first surface for laying down and structuring a project plan. It is **on by default** and is a desktop-only experience — mobile continues to use the existing Add Task modal.

:::note[Ships in 0.4]
In the current release, build mode is **off by default** and opt-in per browser — turn it
on from **Settings → Schedule**. 0.4 removes that toggle and turns build mode on for
everyone on desktop.
:::

The goal is to collapse the round-trip cost of structuring a plan from "open modal → fill form → save → repeat" to "type, Alt + →, type, Enter."

## What build mode is — and what it isn't

Build mode is a **schedule-construction** tool. It is the fastest way to lay down and structure the work breakdown structure (WBS) of a project: type a task name, `Alt + →` to indent it under the row above (which becomes a phase), `Space` to mark it complete, `F2` to edit it. Everything happens on the **Schedule view**, in the task list, with the keyboard. Plain `Tab` and `Shift + Tab` are left alone on a focused row — they fall through to the browser's normal focus traversal, so keyboard users can always Tab out of the grid.

Build mode is **not** sprint planning. It does not create sprints, move cards, set velocity, or triage a backlog — that work lives on the [Board](/features/board/), the [Sprint planning](/features/plan-sprint/) surface, and the [Product backlog](/features/product-backlog/). If you are an agile team deciding *what goes in the next sprint*, build mode is the wrong surface; if you are laying out *the shape of the plan itself* — phases, tasks, durations, and dependencies — build mode is exactly it.

| Build mode is for… | …not for |
|---|---|
| Structuring the WBS: phases, tasks, indent / outdent | Deciding sprint scope or moving cards |
| Setting durations and % complete inline | Estimating story points (that's [estimation poker](/features/estimation-poker/)) |
| Wiring predecessor / successor dependencies | Board triage or backlog refinement |
| Keyboard-first plan entry on the Schedule view | Any mobile workflow — build mode is desktop-only |

## Learning the shortcuts

Build mode needs no setup — open any project's Schedule view and it's already there.
**Settings → Schedule** has a **View keyboard shortcuts** link that opens the same
cheatsheet you get by pressing `?` on the Schedule view, so you can learn the hotkeys
before you start.

## What you see on the Schedule view

Two visible signals appear:

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
| Shift + Enter | Insert a new sibling row **above** the focused row |
| ⌘ Enter / Ctrl + Enter | Insert a new **child** row one level deeper — the focused row becomes a summary as a side effect of gaining a child |
| F2 | Edit the focused cell (defaults to the Task name) |
| Letter key | Start typing — opens the Task name cell |
| Alt + → | Indent under the previous sibling row (forms an emergent phase) |
| Alt + ← | Outdent one level |
| ↑ ↓ | Move focus to the next / previous row |
| Shift + ↑ / ↓ | Extend a contiguous selection from the focused row |
| ⌘ A / Ctrl + A | Select every sibling of the focused row; press again to expand to the whole visible tree |
| Alt + ↑ / ↓ | Move the row **and its subtree** among its same-indent siblings — no-op on a selection that spans more than one parent |
| F8 | Jump to the next row whose name still carries an unresolved `@owner` mention |
| Shift + F8 | Jump to the previous such row |
| Alt + A | Toggle **Author** / **Read** mode for the whole Schedule (see below) — persists per project, per browser |
| Space | Mark the focused row complete / un-complete |
| ⌘ D / Ctrl + D | Duplicate the row **and its subtree**, appended below with "(copy)" on the duplicated root only — internal dependencies inside the subtree are not cloned, matching single-row duplicate's existing "dependencies are never cloned" rule. With a multi-row selection, duplicates every top-level selected row as its own subtree |
| Right-click | Open the row context menu (Edit / Indent / Outdent / Convert to milestone / Delete) |
| Delete / Backspace | Delete the focused row — or, with a multi-row selection active, every selected row (no confirm; undo via re-adding, or the delete toast's Undo action) |
| Esc | Clear the current selection or row focus |

### Schedule-wide shortcuts (always on)

| Key | Action |
|---|---|
| ⌘ M / Ctrl + M | Insert a new milestone at today's date |
| ? | Open the keyboard shortcut cheatsheet |

### When a cell is being edited (CellEdit)

| Key | Action |
|---|---|
| Enter | In the **Name** cell: save, then open a new sibling row below ready to name (commit-and-continue — a blank name makes the next Enter a calm stop). Shift + Enter inserts the sibling **above** instead, and ⌘ / Ctrl + Enter inserts a **child** row — same three variants as Enter on a focused row. In the Duration / % cells: save and return focus to the row |
| Backspace, on an emptied Name cell | Deletes the row and lands the caret at the **end** of the previous row's Name text — the outliner "backspace merges into the line above" convention |
| Esc | On a row you just created and never typed into: **discards** the row entirely, since there is nothing to revert to. On any other row: reverts to its last committed value and returns focus to the row |
| Tab | Save and move to the next editable cell in the same row |
| Shift + Tab | Save and move to the previous editable cell |

The editable cells in v1 are **Task name**, **Duration**, and **% complete**. Start and Finish are computed from CPM and remain read-only — change a Planned Start to override.

### Dependencies

| Action | Result |
|---|---|
| Hover a row | Reveals its dependency chain — predecessors highlight blue, successors highlight green |
| Right-click | Opens the row menu, where **Add predecessor** / **Add successor** open a task picker |

## Assigning an owner inline with `@`

:::note[Ships in 0.4]
The `@owner` token described in this section lands in **TruePPM 0.4**. In the current
release, assign people from the task drawer's **Assignees** editor instead — it writes
the same kind of assignment.
:::

While you are naming a row, type `@` to give the task an owner without leaving the cell.
A picker lists the people on the **project's resource roster**; keep typing to filter it,
then `↑` / `↓` and `Enter` (or click) to choose.

| You type | What happens |
|---|---|
| `Draft the plan @ana` | Ana is assigned at 100%; the task is named "Draft the plan" |
| `Review specs @ana:50` | Ana is assigned at 50% |
| `Kickoff @"Ana Rivera"` | Quotes let you name someone whose name contains a space |

Two things are worth knowing about how this behaves:

**The token disappears from the name once it resolves.** `Draft the plan @ana` saves a
task called "Draft the plan" — the `@ana` is an instruction, not part of the title.

**A name that matches nobody stays put.** If `@ana` matches no one on the roster — or
matches *two* people ambiguously — the row still saves, the text stays in the name, and
the token is underlined in amber so you can see and fix it. Nothing is silently dropped
and nothing is silently guessed at.

The picker only ever offers people already on **this project's** roster; it never reaches
into the workspace-wide resource library, so a name typed here cannot bind work to
someone outside the project. To add somebody new, add them to the roster first from
**Team → Roster**.

Adding an owner this way never removes anyone else already assigned to the row — `@ana`
means "Ana owns this", not "Ana is now the only person here". Remove an assignment from
the task drawer's Assignees editor.

## Indenting and emergent phases

When you indent a row under a leaf row (one with no children), the parent automatically becomes a summary task — its name goes bold, computed dates roll up from its children, and the chevron lets you collapse / expand. There is no "convert this to a phase" step; phases form as a side effect of structuring.

The reverse holds when you outdent: if a summary task loses all its children, it becomes a leaf again on the next refresh.

## Author / Read mode

`Alt + A` toggles the whole Schedule between **Author** (the default — every build-mode
key works normally) and **Read**. Read mode is a personal "look, don't touch" setting: it
forces the view read-only regardless of your project role, so you can review a plan
without risking an accidental edit. It is **not a permission change** — the server's
role-based access control is untouched, and it never restricts anyone else. The choice
persists per project, per browser, and a toolbar pill always shows which mode is active
so it is never silently on.

## Selecting and acting on multiple rows

`Shift + ↑` / `Shift + ↓` extends a contiguous selection from whichever row you started
on. `⌘ A` (`Ctrl + A`) selects every sibling of the focused row on the first press, and
expands to the entire visible tree on a second press while that exact sibling set is
still selected. With a selection active, the structural keys act on every selected row
instead of just the one you started on: `Alt + →` / `←` indents or outdents the whole
selection, `Delete` / `Backspace` removes every selected row, and `⌘ D` duplicates each
top-level selected row (and its subtree) as its own copy. `Alt + ↑` / `↓` moves a
selection only when it is a contiguous run of rows that share the same parent — a
scattered or cross-level selection has no single well-defined destination, so the key is
a no-op there rather than guessing. Any plain arrow-key move or a click collapses the
selection back to a single row.

## Accessibility

The Schedule task list is a real **treegrid**: each row carries a genuine `aria-level`
(its WBS depth), `aria-expanded` on rows that have children (never on a leaf row, so
assistive technology never sees a phantom disclosure control), and `aria-selected` that
now covers a multi-row selection, not just the single focused row.

The canvas Timeline has its own accessible overlay, invisibly layered over the bars:
`role="listbox"` with one `role="option"` per task bar, each with its own descriptive
label — the task's name, duration, start/finish dates, and critical-path status, plus its
delivery mode when the task has one ("Design review, 3 days, starts Aug 4, finishes
Aug 6, Scrum delivery"). Every bar is independently reachable and readable by a screen
reader; nothing on the Timeline is a decorative image.

A task's delivery mode (Waterfall, Scrum, Kanban) is never shown by color alone on the
Gantt bars. Each mode gets a left-edge gutter accent, a low-contrast texture across the
bar body (diagonal stripes for Scrum, a dot grid for Kanban — Waterfall, the default, gets
neither), and a letter prefixed onto the existing progress chip ("S 40%"). Under a
forced-colors / high-contrast theme, the texture pattern is what survives — color is
never the only signal.

## What's not in v1

- **No mobile signal.** Build mode is desktop-only. On mobile, use the Add Task button as before.
- **Enter's positional insert is one-directional.** Plain `Enter` appends the new row at the end of its parent's children rather than immediately after the focused row. `Shift + Enter` (insert above) *does* land exactly where you'd expect — it composes the create with a reorder — but the common "type, Enter, type" flow still appends.
- **No optimistic indent.** Indent / outdent waits ~50ms for the server to confirm before the row position updates.
- **No fill-down or paste-from-Excel.** Multi-row select and duplicate exist; bulk paste from a spreadsheet does not yet.
- **No multi-step undo, no bulk-edit sheet, no Enter-to-create on the Timeline.** Undoing a paste/cascade/import fix as one step, a `⌘ ⇧ K` sheet for bulk-editing mode/phase/calendar/owner/dates across a selection, and creating rows from the Timeline the way Enter does on the list are tracked separately, not in this release.
- **No Sprint backlog parity yet.** The same inline-edit / Tab pattern will extend to the Sprint backlog table in a future release.

## See also

- [Schedule view toolbar](/features/schedule-toolbar/) — toolbar controls, filter groups, and the summary chip
