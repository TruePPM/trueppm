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
| ⌘ V / Ctrl + V | Paste rows from a spreadsheet — see [Paste rows from a spreadsheet](#paste-rows-from-a-spreadsheet) below |
| ⌘ Z / Ctrl + Z | Undo the most recent paste, while its receipt strip is still showing |
| F8 | Jump to the next row that needs attention — an unresolved `@owner` mention, or a row a recent paste couldn't infer a duration for |
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

## Inline authoring tokens

:::note[Ships in 0.4]
The tokens described in this section land in **TruePPM 0.4**. In the current release,
set these fields from the task drawer instead — the drawer's Assignees, Duration,
Dependencies, and Delivery mode editors write exactly the same values.
:::

While you are naming a row, a handful of short tokens set the rest of the row without
leaving the cell. Each one opens a picker, so nothing has to be memorized.

| You type | What it does |
|---|---|
| `#5d` `#2w` | Duration — 5 days, 2 weeks. A bare `#3` is 3 days |
| `@ana` `@ana:50` | Owner, at 100% or at 50% |
| `>2.3` `>Survey` | Predecessor, by WBS path or by name |
| `>2.3+2d` `>2.3-1d` | …with 2 days of lag, or 1 day of lead |
| `>2.3:SS` | …as a Start-to-Start link (`FS`, `SS`, `FF`, `SF`) |
| `!` or `#0` | Milestone |
| `~sprint` `~gated` `~kanban` | Delivery mode for this row |
| `[Design]` | File the row under the "Design" phase |
| `/` | Command menu — every token and toolbar action, found by typing |

So `Wireframes #5d @ana >2.3 [Design]` creates a 5-day task called "Wireframes",
assigns Ana, links it after task 2.3, and files it under the Design phase.

Everything a token does is also a toolbar button and a `/` menu entry. The syntax is a
shortcut for people who want one — never the only way in.

### Working with the pickers

Typing a token's first character opens a type-ahead. It is deliberately **non-modal**:

| Key | What it does |
|---|---|
| `↑` `↓` | Move through the suggestions |
| `⇥` | Accept the highlighted suggestion |
| `Esc` | Dismiss the picker — **your text is left exactly as you typed it** |
| `⌥` `→` | Cycle the dependency type of the link you are on: FS → SS → FF → SF |

Typing past a picker is always allowed, and accepting a suggestion completes the token
in place rather than saving the row — so you can keep going and add another token.
Focus never leaves the row.

### What happens to your text

**A token that resolves disappears from the name.** `Draft the plan @ana` saves a task
called "Draft the plan" — the `@ana` was an instruction, not part of the title.

**A token that doesn't resolve stays put, and the row still saves.** If `@ana` matches
nobody on the roster — or matches *two* people ambiguously — the text stays in the name
and is underlined in amber so you can see and fix it. The same goes for a phase name
that doesn't exist or a task you mistyped. Nothing is silently dropped and nothing is
silently guessed at, and one bad token never costs you the rest of the row.

**A token that loses a conflict is shown crossed out.** `Launch ! ~scrum` is a
milestone: a milestone is a zero-duration gate, so it cannot also be a scrum row. The
row saves as a milestone and the `~scrum` is echoed back struck through, so you can see
that it did not take.

### Scope of the pickers

The owner picker only ever offers people already on **this project's** roster; it never
reaches into the workspace-wide resource library, so a name typed here cannot bind work
to someone outside the project. To add somebody new, add them to the roster first from
**Team → Roster**. Predecessor and phase pickers are scoped to this project the same way.

Adding an owner this way never removes anyone else already assigned to the row — `@ana`
means "Ana owns this", not "Ana is now the only person here". Remove an assignment from
the task drawer's Assignees editor.

## Paste rows from a spreadsheet

:::note[Ships in 0.4]
Paste-many lands in **TruePPM 0.4**. In the current release, build a plan row by row
with Enter / Shift + Enter / ⌘ Enter, or bring in an existing plan with
[MS Project import](/features/schedule/) or [CSV/Excel import](/features/schedule-toolbar/).
:::

With a row focused, `⌘ V` (`Ctrl + V`) pastes multiple rows copied from a spreadsheet
straight into the outline — the fastest way to bring an existing plan in without 200
trips through the Add Task modal.

**Hierarchy comes from leading indentation.** A cell indented under the row above it —
by leading spaces or a leading tab, however your spreadsheet expressed it — becomes that
row's child. A block copied straight out of Excel, Google Sheets, or a plain indented
outline all read the same way; TruePPM does not care which application produced the
leading whitespace.

**Columns are guessed, not required to match exactly.** A header row (a first row
reading something like `Task`, `Duration`, `Owner`) is detected automatically and used
to map columns; without one, the first column is assumed to be the task name and any
column that looks like a set of durations is mapped by shape. Anything TruePPM can't
place is left out — never silently guessed at.

**A receipt strip confirms what happened**, right where you pasted: how many rows
landed, how many hierarchy levels were read from indentation, which columns matched,
how many were ignored, and how many rows have no duration yet (legal — TruePPM defaults
an unset duration to 1 day, and you review them at your own pace). It stays on screen
until you act on it:

| Action | What it does |
|---|---|
| `⌘ Z` / **Undo** | Removes the whole paste as one step |
| **Keep** | Dismisses the strip; the rows stay |
| **Map columns…** | Corrects a wrong column guess and re-applies the paste under the new mapping |
| `F8` | Walks to the next row the paste couldn't infer a duration for |

Rows without a resolved duration are never treated as failures — they commit like every
other pasted row, and `F8` is how you find and fix them afterward, on your schedule, not
the paste's.

A pasted block always lands as siblings of whichever row was focused when you pasted —
the same "same level as the focused row" placement Enter uses — so pasting while sitting
inside a phase adds to that phase, and pasting with nothing focused lands at the project
root.

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
- **No fill-down.** Multi-row select and duplicate exist, and 0.4 adds [paste-many from a spreadsheet](#paste-rows-from-a-spreadsheet); a fill-down / fill-series gesture for extending a value down a column does not exist yet.
- **No multi-step undo, no bulk-edit sheet, no Enter-to-create on the Timeline.** A paste undoes as one step (see [Paste rows from a spreadsheet](#paste-rows-from-a-spreadsheet)); undoing a cascade or an import fix as one step, a `⌘ ⇧ K` sheet for bulk-editing mode/phase/calendar/owner/dates across a selection, and creating rows from the Timeline the way Enter does on the list are tracked separately, not in this release.
- **No Sprint backlog parity yet.** The same inline-edit / Tab pattern will extend to the Sprint backlog table in a future release.

## See also

- [Schedule view toolbar](/features/schedule-toolbar/) — toolbar controls, filter groups, and the summary chip
