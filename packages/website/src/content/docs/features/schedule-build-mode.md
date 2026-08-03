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
| ? | Open the keyboard shortcut cheatsheet |

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
