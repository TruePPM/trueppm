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

Build mode adds an entry to the toolbar's mode chip and a single **teaching band** under the plan:

- The toolbar's **mode chip** — the control that reads `Author` or `Read`. It is always there, and its **`Keyboard shortcuts…`** entry opens the cheatsheet. There is no separate `Build mode` pill: build mode is not something you switch on, so a control that only ever said "on" was reporting a constant. Whether you can type into the plan is the one thing that varies, and that is what the chip states.
- A **teaching band** directly under the plan. It shows one of two things, never both at once:
  - The **how-to bar**, while nothing in the outline is selected. Three lines covering indent, grouping, and the row controls that only appear when you hover a row — the things you cannot discover by looking. Hide it with its **×**; bring it back from **Display → Outline → How-to bar**.
  - The **hint strip**, from the moment you focus a row. It shows the three most relevant hotkeys for the state you are in, and swaps to selection actions — group, delete, clear — once more than one row is selected.

  If you have read-only access to the project, the band still appears and the **`?` All shortcuts** button still works, but the strip shows only what you can actually do — move between rows, and open a row's details. It never names an edit you would not be allowed to make.

Pressing `?` opens the full cheatsheet from anywhere on the page, and the band's own **`?` All shortcuts** button does the same.

Neither appears on a plan with no rows: a blank project opens with a live row already holding the cursor, which is the only thing there is to teach at that point.

The Schedule list rows also gain new keyboard behavior — see below.

## Keyboard reference

The Schedule list is in one of three focus states at any time. The same keys do different things in each — the hint strip tracks the state you are actually in, and the cheatsheet (`?`) lists every binding at once.

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
| Alt + Enter | **Open the focused row's details** in the task drawer. Works in both Author and Read mode and at every role — opening a task is a read, not an edit |
| F2 | Edit the focused cell (defaults to the Task name) |
| Letter key | Start typing — opens the Task name cell |
| Alt + → | Indent under the previous sibling row (forms an emergent phase) |
| Alt + ← | Outdent one level |
| ↑ ↓ | Move focus to the next / previous row |
| Shift + ↑ / ↓ | Extend a contiguous selection from the focused row |
| ⌘ A / Ctrl + A | Select every sibling of the focused row; press again to expand to the whole visible tree |
| Alt + ↑ / ↓ | Move the row **and its subtree** among its same-indent siblings — no-op on a selection that spans more than one parent |
| ⌘ V / Ctrl + V | Paste rows from a spreadsheet — see [Paste rows from a spreadsheet](#paste-rows-from-a-spreadsheet) below |
| ⌘ Z / Ctrl + Z | Undo the most recent structural change — a move, indent, outdent, reorder, or grouping. While a paste receipt strip is showing, undoes the paste instead. See [Undoing a structural change](#undoing-a-structural-change) |
| F8 | Jump to the next row that needs attention — an unresolved `@owner` mention, or a row a recent paste couldn't infer a duration for |
| Shift + F8 | Jump to the previous such row |
| F7 | Jump to the next row that still **needs dates** — no committed start yet |
| Shift + F7 | Jump to the previous such row |
| Alt + A | Toggle **Author** / **Read** mode for the whole Schedule (see below) — persists per project, per browser |
| Space | Mark the focused row complete / un-complete |
| ⌘ D / Ctrl + D | Duplicate the row **and its subtree**, appended below with "(copy)" on the duplicated root only — internal dependencies inside the subtree are not cloned, matching single-row duplicate's existing "dependencies are never cloned" rule. With a multi-row selection, duplicates every top-level selected row as its own subtree |
| Right-click | Open the row context menu (Edit / Indent / Outdent / Move to… / Convert to milestone / Delete) |
| Delete / Backspace | Delete the focused row — or, with a multi-row selection active, every selected row (no confirm; undo via re-adding, or the delete toast's Undo action) |
| Esc | Clear the current selection or row focus |

### A blank project is a canvas

A project with no tasks opens as a working surface, not an empty card:

- **The outline starts with a live row and the caret already in it.** Type a name,
  press Enter, and it becomes a task — then the caret stays put so the next row is
  the next thing you type. Nothing is saved until there is a name to save, so
  opening a project and backing out leaves nothing behind.
- **The timeline draws a horizon** against the project's chosen calendar. An empty
  grid says "nothing is planned yet"; a blank panel would say "something is broken".
- **A quiet side panel** offers the other ways to fill it — import a file, and the
  project's own stated facts (starts, calendar, default mode, views) so the ruler
  beside it is legible.

### Rows without dates are legal

A row with no committed start is not an error. It renders with em-dashes and joins
the **needs dates** count, which `F7` / `Shift + F7` walk. Getting the shape down
first and dating it afterwards is a normal way to plan, so the outline never refuses
a row for want of a date.

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
| Right-click | Opens the row menu, where **Add dependency** opens a task picker |

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
| `#4h` | Duration in hours — divided by the project calendar's hours per working day and rounded **up** to whole days, so an estimate is never quietly under-planned |
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
| `⌘ Z` / **Undo** | Removes the whole paste as one step, keeping any row you've already edited since. Needs the Project Manager role — see below |
| **Keep** | Dismisses the strip; the rows stay |
| **Map columns…** | Corrects a wrong column guess and re-applies the paste under the new mapping |
| `F8` | Walks to the next row the paste couldn't infer a duration for |

**Undoing a paste needs the Project Manager role — pasting does not.** Team Member and
above can paste rows; reversing a paste in a single step is Project Manager and above.
If your role is below that line the strip says so and shows no Undo, rather than
offering an action the server would refuse — and `⌘ Z` is left alone, so it never
promises an undo it cannot deliver. **Keep** and **Map columns…** are unaffected: they
are not undos, and deleting rows you just created is within the rights that created
them.

Rows without a resolved duration are never treated as failures — they commit like every
other pasted row, and `F8` is how you find and fix them afterward, on your schedule, not
the paste's.

**An Owner column is matched against the project's team, and the receipt says when it
couldn't be.** A name is resolved against the people on *this* project — never a
workspace-wide directory — which is what stops a name typed on one project binding work
to somebody who is a member of none. Two things can go wrong, and the receipt tells them
apart because the repairs differ:

| What the receipt says | What happened | What to do |
|---|---|---|
| *N owners were not on the roster, so were not applied* | The cell named nobody on this project — a typo, or somebody who has left | Fix the spelling in your source, or add them to the team and re-paste |
| *N owners matched more than one person, so were not applied* | The cell named several people — `Ana` where the team has both Ana Rivera and Ana Silva | Use a fuller name |

In both cases the **row still commits**, just without that owner. TruePPM never picks one
of several candidates on your behalf: binding work to the wrong person silently is worse
than leaving it unassigned and saying so.

A pasted block always lands as siblings of whichever row was focused when you pasted —
the same "same level as the focused row" placement Enter uses — so pasting while sitting
inside a phase adds to that phase, and pasting with nothing focused lands at the project
root.

## Indenting and emergent phases

When you indent a row under a leaf row (one with no children), the parent automatically becomes a summary task — its name goes bold, computed dates roll up from its children, and the chevron lets you collapse / expand. There is no "convert this to a phase" step; phases form as a side effect of structuring.

The reverse holds when you outdent: if a summary task loses all its children, it becomes a leaf again on the next refresh.

## Undoing a structural change

Every change you make to the *shape* of the plan is recorded and can be reversed.
Press **⌘ Z** (Ctrl + Z), or open the **N changes this session** panel in the toolbar and
press **Undo** on the entry.

### What undo covers

| Act | Undoable |
|---|---|
| Moving a row (drag, or **Move to…**) | Yes |
| Indent (`⌥ →`) and outdent (`⌥ ←`) | Yes |
| Reordering rows within a level | Yes |
| Grouping rows into a phase | Yes — the phase is removed again |
| Ungrouping a phase | Yes — the phase comes back **with its original name, notes and links** |
| Deleting a row | Yes, but through the delete toast's own **Undo**, not ⌘ Z |
| Duplicating a row (`⌘ D`) | **No** — delete the copy instead |
| Turning a row into a milestone | **No** — set its duration back above zero |
| Adding a single row | **No** — delete it |

The panel says the same thing, so you never have to remember this table. An act that
cannot be reversed appears in the trail as a record with **no Undo button** next to it.

### One gesture, one undo

A change is reversed as the single act you performed, not as the row-by-row edits it
implied. Grouping four rows into a phase is **one** press of ⌘ Z, not four. The same
holds for a move that renumbers a dozen siblings.

The one exception: indenting or outdenting a **multi-row selection** is sent as one
request per row, so it takes one ⌘ Z per row to reverse. Each press is safe on its own.

### Undo goes backwards one step at a time

⌘ Z reverses your most recent structural change. Press it again and it reverses the one
before that, and so on back through the panel. Only the newest reversible change offers
a button, which is why the panel shows exactly one **Undo** at a time.

Undo is scoped to **your** changes. A colleague restructuring a different part of the
plan does not consume your undo, and you cannot reverse their change unless you are a
Project Manager or above.

### When undo is not offered

If somebody has changed the same part of the outline since — moved a row, added one
inside it, or restored something you had grouped away — undo **refuses** rather than
reverting part of it. You will see *"The outline has changed here since — this can no
longer be undone."*

This is deliberate. Restoring only some of a level's rows can leave two rows claiming
the same position in the plan, and nothing downstream would notice. Refusing is the safe
outcome; nothing is written when it happens.

Two other cases produce a refusal:

- **A very large change.** A restructure touching more than about 2,000 rows is recorded
  but not reversible. The change itself still succeeds — only the undo is unavailable,
  and the panel says so.
- **An older change with a newer one on top of it.** Reverse the newer one first.

### How long an undo lasts

The panel is scoped to your current session and holds the last ten changes. The server
keeps the underlying record for **7 days**, so an undo is still possible through the API
after a reload — but the panel itself starts empty in a new session.

## Where a new row lands

There are three ways to add a row, and **each one lands where its own position implies**.
That is the whole rule; you should never have to remember which control does what.

| Affordance | Where the row lands |
|---|---|
| The **`+`** that appears on a row's bottom edge when you hover it | Directly below *that* row, at that row's own depth |
| **`+ Item`** in the toolbar (and its keyboard twin, `⏎`) | Beside the row you have selected — same parent, same level |
| **Add an item at the end**, at the foot of the list | At the end of the plan, at the top level |

The toolbar states where its insert will go, immediately beside `+ Item`: *"⏎ adds a row
after 2.4 · same level"*. The number is the row the new one will follow, which is the last
row at that level — a new sibling is appended within its phase rather than wedged in
mid-list, so the sentence names where it actually lands rather than where the cursor
happens to be. On a narrow window there is no room to draw it, but it is still read out as
the button's description by a screen reader.

While the row you are on has no name yet, the same place reads *"⏎ saves 2.5 · name it to
add the next"*, and `+ Item` is inert until you name it. Pressing `⏎` on a blank row saves
it rather than stacking another blank row behind it, and the toolbar says so instead of
offering a row you will not get. With nothing selected there is no row to land after, so
the toolbar says nothing and `+ Item` opens the task form, where you choose the parent
yourself.

The footer is the one that ignores your cursor entirely. It sits at the end of the plan
because that is where its row goes — put the caret three levels deep inside a phase and
**Add an item at the end** still appends at the top level, after the last row.

Without edit rights none of the three is there at all — not dimmed, not refused on click.
In **Read** mode they stay where they were and are inert, because one key gets you back.

## Rearranging with a pointer

The keyboard stays the primary path — typing forty rows into an empty plan is the job
build mode exists for, and no drag competes with `type, Alt + →, type, Enter`. But once a
plan exists, *rearranging* it is a job a pointer is genuinely better at, so every row
carries a **⋮⋮ grip** on its left edge. Hover a row to reveal it, then drag.

There is one drop model, and it distinguishes two outcomes by where you release:

- **Between two rows** places the row *beside* the one below the gap — same level, same
  parent. The insertion line is drawn at that level's own indent guide, so you can read
  the depth you are about to land at rather than infer it.
- **Onto a row** places it *inside* that row. If the target had no children it becomes a
  phase, exactly as `Alt + →` would have made it one. The line for a child drop sits one
  indent step deeper than the line for a sibling drop at the same height, so the two are
  never ambiguous.

**The target row says what will happen before you let go** — *"↳ becomes a phase"*,
*"into this phase"*, or *"same level as {row}"*. Two drops are refused, and the refusal
says why rather than doing nothing: a **milestone cannot hold work** (*"a gate cannot
hold work"* — a milestone is a date, not a container), and a row **cannot move inside its
own subtree**. Press `Esc` at any point during the drag to abandon it; nothing is written
until you release.

On a touch screen, **press and hold** the grip to lift the row — a swipe that starts on
the grip still scrolls the list, so the outline never becomes unscrollable.

Touch also changes the outline's proportions. On a **touchscreen tablet or laptop** —
the devices that get this surface at all; phones use the full-width timeline described in
[Schedule view](/features/schedule/) and do not show the outline — **every row grows from
28px to 44px**, and the grip grows with it to a full 44 x 44 target with a lane of its
own, so it never sits on top of another control. The ⊕ insert affordance, which a mouse
reveals on hover, stays visible for the same reason.

This follows the *pointer*, not the window width: a tablet with a keyboard and trackpad
attached keeps the compact mouse-sized rows, and a large touchscreen gets the finger-sized
ones — and the outline re-flows if you attach or detach a keyboard mid-session. Task bars
stay centered in the taller row, and nothing changes on a mouse or trackpad.

Everything the drag does has a non-drag equivalent, and none of them changes any dates:

| Instead of | Use |
|---|---|
| Dragging a row up or down among its siblings | `Alt + ↑` / `Alt + ↓` |
| Dragging a row into the row above it | `Alt + →` (indent) |
| Dragging a row out of its phase | `Alt + ←` (outdent) |
| Dragging a row under a phase somewhere else in the plan | **Move to…** in the row context menu |

**Move to…** exists because it is the only one of these the `Alt` keys cannot reach: they
step one level against the row immediately above, while a drag can move a row under *any*
phase in the plan. It opens a list of every legal destination — the top level, plus every
phase that is not a milestone and not inside the row you are moving — so the same
operation is available with no drag at all. On touch it is usually the faster path.

## Author / Read mode

`Alt + A` toggles the whole Schedule between **Author** (the default — every build-mode
key works normally) and **Read**. Read mode is a personal "look, don't touch" setting: it
forces the view read-only regardless of your project role, so you can review a plan
without risking an accidental edit. It is **not a permission change** — the server's
role-based access control is untouched, and it never restricts anyone else. The choice
persists per project, per browser, and a toolbar pill always shows which mode is active
so it is never silently on.

Switching mode also moves the **layout**. Entering Author switches you to **Grid** — the
layout the row list, outline controls and inline editing live in — and returning to Read
puts you back in whichever layout you came from. If you pick a layout yourself while
authoring, that choice stands: the switch happens once, on the mode change, and never
overrides you afterwards. On mobile nothing changes, because the layout is already
Timeline at that width.

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

## Edit many rows at once

:::note[Ships in 0.4]
The bulk-edit sheet lands in **TruePPM 0.4**. In the current release, edit each row
individually from the outline or the task drawer.
:::

`⌘ ⇧ K` (`Ctrl + Shift + K`) opens a sheet that applies one change to every selected item
at once. With no selection, it acts on the focused item alone — the same rule `Delete`
uses. With a selection active you can also click **Edit N items** in the build-mode strip
at the foot of the Schedule, or **Edit selected items…** in the toolbar's `···` menu.

**It acts on exactly the items you selected, and never their children.** To change a whole
subtree including descendants, use [`⌘ ⇧ M`](/features/task-classification/) instead — the
two shortcuts differ in scope, not in what they can set.

Every field starts on **Leave**, so a field you don't touch is never written. Where the
selected items disagree, the option reads "Leave — Mixed" rather than showing a single
value the selection doesn't actually have.

| Group | Field | What it does |
|---|---|---|
| Plan | **Planned start** / **Planned finish** | Set a committed date, or clear one |
| Plan | **Duration** | Set an absolute number of working days, or increase / reduce every item by an amount |
| Plan | **Percent complete** | Set an absolute percentage, or increase / reduce every item by an amount |
| Placement & policy | **Sprint** | Move the selection into a planned or running sprint, or take it out of its sprint |
| Placement & policy | **Governed by** / **Progress from** | The two classification axes — the same pair `⌘ ⇧ M` sets, applied to just these items |
| People | **Owner** | Add a person from the project roster, with an allocation percent |

### Relative changes to duration and progress

Duration and percent complete are the two fields a weekly re-plan actually moves, so they
take a **relative** change as well as an absolute one. Pick **Set to**, **Increase by** or
**Reduce by** — or just type `+2` or `-2` in the amount, which flips the operator for you.
The worded control is always there, so you never have to know the shortcut.

Three rules keep a relative change honest:

- **An item with no current value is left alone.** "Increase by 2 days" has no meaning on
  an item that has no duration, so the sheet skips it and tells you how many before you
  apply — it never starts a value from nothing. **Set to** still writes, because it names
  the value outright.
- **Results clamp; they never wrap.** Percent complete stops at 0 and 100, and duration
  stops at one working day. An item at 90% asked to go up 30 lands on 100, not on 20, and
  the sheet counts how many items a limit moved before you apply.
- **Dates stay absolute.** There is no "shift everything a week" here — moving a plan in
  time is a reschedule, and it belongs to the scheduling engine rather than to a field
  write.

Summary rows roll their estimate up from their children and milestones have no duration,
so a duration change leaves both alone. Setting an item to 100% also promotes its status,
exactly as it does one row at a time — the sheet says how many items that affects, and
which status they will move to, before you apply.

### Moving a batch into a sprint

Adding items to a **running** sprint is an injection, and it is recorded like every other
one: the items appear in the sprint but are held **pending** until someone accepts them,
and they stay out of the burndown until that happens. The sheet says so before you apply.
Moving into a *planned* sprint has nothing to protect and is written straight through.

### The owner field

Owner offers four arms — **Leave**, **Add**, **Remove** and **Replace**. **Add** is the
one that writes today; **Remove** and **Replace** are visible, labelled and reachable but
carry a `0.5` badge, because removal goes through a different endpoint that has not been
opened to a batch yet. They are laid out at their final size now so that when removal
lands nothing on this sheet moves.

**Adding an owner is an upsert — it adds a co-owner and never replaces one.** An item that
already has somebody keeps them and gains the person you picked; to reduce someone's
allocation, add them again at a lower percent. Removing an assignment stays on the item
itself, in the task drawer's Assignees editor. Summary rows cannot take an owner at all;
the sheet says how many of your selected items that affects before you apply, and their
other changes still land.

### Reading the review, and the result

Above **Apply** the sheet writes **one line per field**, each with its own count — how
many items it will update, how many are already at that value, and how many it will leave
alone. There is no single number at the top of the sheet, because most of these fields
don't apply to every kind of item and no one number could be true about all of them. The
header counts your **selection** instead.

If any field is set to take something away — clearing a date, taking items out of a
sprint — the first `⌘ ⏎` does not apply. It moves focus to **Apply** and reads the review
back to you; press it again, or click Apply, to go ahead.

**Items are applied independently, and the sheet reports what happened.** The result is
the review in past tense: same fields, same order, same counts, now reading *updated*,
*unchanged*, *left alone* and *refused* — and for each field those four always add up to
your selection size, so nothing can be quietly dropped. The header counts **changes**, not
items, because one item can be updated for one field and refused for another. **Retry the
N** turns exactly the refused items into your new selection so you can deal with them
without hunting for them in a long outline; a clean result clears the selection instead.

Setting a planned start applies it as a *no-earlier-than* constraint to every selected
item, not as a literal identical start date — the schedule engine still decides when each
item actually starts. See [How dates work](/features/schedule/).

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

The mode named in that label is the **rolled-up** one — the same value the outline's mode
chip shows, not the row's own stored field. A phase whose subtree mixes modes is announced
as mixed and names what it is mixed from ("…, Mixed delivery — this branch contains gated
and scrum work"). A waterfall row is announced without a mode suffix at all, matching the
outline, where the baseline deliberately draws no chip and no gutter: on a 400-row gated
plan the alternative is 400 identical announcements with nothing on screen to match them.
See [Task classification](/features/task-classification/#seeing-the-split-without-auditing-it).

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
- **No Enter-to-create on the Timeline.** Creating rows from the Timeline the way Enter does on the list is tracked separately, not in this release. (Multi-step undo itself *has* landed for structural changes — see [Undoing a structural change](#undoing-a-structural-change) — and a paste, a classification cascade and a spreadsheet import each still undo as one step: [Paste rows from a spreadsheet](#paste-rows-from-a-spreadsheet) above, [Classify a subtree](/features/task-classification/#undo-a-cascade), and [CSV/Excel import](/features/csv-import-export/#undo-an-import).)
- **A bulk edit is not undoable with `⌘ Z`.** The [bulk-edit sheet](#edit-many-rows-at-once) ships in 0.4, but unlike a paste or a cascade it records no undo step — re-open the sheet and set the field back. Take particular care with **Add owner**, which the sheet cannot reverse at all: remove the assignment from the item's own Assignees editor.
- **The bulk-edit sheet cannot remove or replace an owner.** Both arms are present and labelled, badged `0.5`; removal goes through a different endpoint that has not been opened to a batch. Until then, remove an assignment from the item's own Assignees editor.
- **The bulk-edit sheet cannot move rows under a phase, or set a calendar.** Phase changes go one row at a time (drag, `Alt + →`, or the `[Phase name]` inline token); the working calendar is a project-level setting, not a per-task one, and lives in **Project settings → Schedule**. Shifting a selection's *dates* by a relative amount ("everything slips a week") is likewise not available — a reschedule belongs to the scheduling engine, so the sheet sets absolute dates only. Duration and percent complete *do* take a relative change; see [Relative changes to duration and progress](#relative-changes-to-duration-and-progress).
- **No Sprint backlog parity yet.** The same inline-edit / Tab pattern will extend to the Sprint backlog table in a future release.

## See also

- [Schedule view toolbar](/features/schedule-toolbar/) — toolbar controls, filter groups, and the summary chip
