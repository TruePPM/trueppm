---
title: Board (Kanban)
description: Kanban board with a backlog rail, phase swimlanes, and configurable working columns for tracking task execution within a project or sprint.
---

The **Board** tab is the primary execution surface in TruePPM. It presents the project's tasks as cards in a Kanban layout and stays in sync with the Schedule view via WebSocket — moving a card here updates the task's status everywhere.

## Board layout

The board has two zones:

- **Backlog** — `BACKLOG` cards live in a dedicated surface *beside* the working columns, not as a column of their own. Backlog is intake — undated, unrefined, not-yet-committed work — so it stays phase-agnostic and visible while you work the active board. Three layout variants are available from the toolbar's segmented control: **Rail** (left-side band, the default), **Drawer**, and **Queue**.
- **Working columns** — the committed-work columns, rendered as **phase swimlanes** (one lane per phase in the WBS). Columns are configurable per project — labels, visibility, WIP limits, and accent colors — and default to:

| Column | Status value | Meaning | Default WIP limit |
|--------|-------------|---------|-------------------|
| To Do | `NOT_STARTED` | Committed; work has not begun | — |
| In Progress | `IN_PROGRESS` | Work is active | 5 |
| Review | `REVIEW` | Work complete; awaiting review / sign-off | 3 |
| Done | `COMPLETE` | Done | — |

Dragging a card from the backlog into a working column commits it (status changes to the column's status). Dragging a To Do card back to the backlog opens a confirmation dialog — demoting committed work is a deliberate decision. Cards that are In Progress or beyond cannot be demoted to the backlog.

The legacy `ON_HOLD` status is kept for data compatibility with pre-0.1 projects but does not appear as a column; on the board it is treated like Backlog for drag guards.

## Board cards

Each card shows:

- **Task name** and WBS short ID
- **Assignee avatars** (up to three, with +N overflow)
- **Readiness chip** — `idea` / `estimated` / `ready` / `baselined`
- **Risk badge** — count of linked active risks, colored by max severity
- **Blocked indicator** — shown when any predecessor is not yet `COMPLETE`
- **Sprint chip** — when the task is committed to a sprint
- **Progress ring** — % complete, fills as work progresses
- **CPI badge** — cost performance index when cost data is available (board batch 4)

## Moving cards

Drag a card to a new column to change its status. The status change is optimistic: the card moves immediately, and the API call fires in the background. If the API call fails, the card snaps back with a toast.

**Keyboard alternative**: every card's `···` overflow menu includes a **Move to…** item with a submenu. Arrow keys navigate the submenu; Enter commits. An `aria-live` region announces the move.

## Toolbar

The board toolbar (top of the board) groups its controls into these clusters:

- **Search** — a card search box (see below) that leads the toolbar
- **Primary chips** — **Group**, **Sort**, and **Density** popovers (card density, plus a separate backlog-card density)
- **Zoom** — a **Small / Normal / Large** stepper that scales the board surface (see below)
- **Quiet toggles** — **My tasks** (only tasks assigned to you), **At-risk**, and **Cost**
- **Layout segmented control** — **Rail · Drawer · Queue** backlog layout variants
- **More⋯ overflow** — collapse/expand all lanes, **WIP** limit chips, column **Tints**, **EVM** mode, the **Columns** configuration panel, and **Export PDF** (see below)

## Search

The toolbar's search box finds cards by **title and description** across the project. Press <kbd>/</kbd> anywhere on the board to focus it (typing in a form never steals focus to search).

- As you type, matching cards stay lit and the rest dim, so the card you want stands out in place — the board never reflows or hides cards.
- A chip shows the match count; clear the search with the **×** button or <kbd>Esc</kbd>.
- The query is reflected in the URL as `?q=…`, so a searched board is a **shareable link**.
- Search respects your project role: results never include cards from projects you are not a member of, and the search response carries no cost or other role-gated fields.

Matching is a case-insensitive substring (searching `foundation` finds *"Foundation pour"*). Title matches rank above description-only matches. Comment search will arrive with threaded comments.

## Zoom

The **Zoom** stepper (Small / Normal / Large) scales the **board surface only** — the phase-column width and the gaps between columns and cards — so you can fit more of a dense board on screen or spread it out for a presentation. Unlike browser zoom (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd> <kbd>±</kbd>), it leaves the sidebar, top bar, and tabs at their native size.

- Use the **−** / **+** buttons, or focus the control and press the arrow keys.
- Your choice is remembered per browser and survives a refresh.
- Zoom is an **independent axis from Density**: Density controls per-card padding; zoom controls how much of the board fits on screen. The control is hidden on phones, where the [mobile layout](#mobile) governs sizing.

## Export to PDF

:::note[0.3]
Board PDF export lands in 0.3.
:::

**Export PDF** in the More⋯ overflow will produce a boardroom-clean PDF of the board for a deck or a client who has no portal access — no screenshots, no copy-paste. The export is a faithful, static projection of what you currently see:

- **Swimlanes and columns** mirror the on-screen layout: one block per phase, the same status columns.
- **Cards** carry their title, assignee initials, due date, and key chips (critical-path marker, blocked, story points, milestone).
- A **footer** stamps the project name, the generation timestamp, the exporting user, and the active filter / sprint context, so the artifact is self-describing.

The export honors your **current view** — the selected sprint scope and any active filters (My tasks, At-risk, Tech debt, search) carry through, because the PDF renders the same filtered card set the live board draws. Tall boards paginate automatically. The whole document is generated **in your browser** — nothing is uploaded, so anyone who can view the board can export it. The action is hidden on phones; export from a desktop.

## Readiness states

Readiness is computed server-side from the task's data, resolved in this order (highest specificity first):

| State | Condition |
|-------|-----------|
| `baselined` | Task is in the active baseline (always wins) |
| `idea` | No assignee **and** still in `BACKLOG` (unrefined, uncommitted) |
| `ready` | Has an assignee + at least one predecessor link |
| `estimated` | Has an assignee without predecessors, **or** was promoted out of `BACKLOG` without an assignee (committed but unowned) |

`idea` only applies while the task is in the backlog: once a card moves to any working column, a commitment decision has been made, so it reads as `estimated` even with no assignee.

The readiness chip drives the card's left accent bar color (overridden by `isCritical` → red).

## WIP overload

When a column exceeds its configured WIP limit, the column header turns amber and a warning badge appears. See [WIP Overload](/features/wip-overload/) for details.

## Sprint integration

When a sprint is active, committed tasks appear in the **To Do → In Progress → Review → Done** columns as normal. Sprint-committed tasks are never shown in the Unscheduled gutter on the Schedule view, regardless of whether they have a planned start date.

### Sprint view

:::note[0.3]
The board sprint-view switcher lands in 0.3.
:::

By default the board shows every committed task in the project. A **scope switcher** in the toolbar (next to the saved-views dropdown) will let you focus the phase columns on a single sprint:

- **Project** — the default; all committed tasks.
- **A sprint** — only tasks committed to the selected sprint. The dropdown lists **active**, **planned**, and **completed** sprints (viewing a closed sprint's board is a legitimate retrospective read).

The selection persists in a `?sprint=` URL parameter, so a sprint-scoped board is a shareable link. The **backlog rail is unaffected** — it stays the intake source you drag from. While viewing an **active** or **planned** sprint, dragging a card from the backlog (or another phase) into a phase column **assigns it to that sprint** — for an active sprint it enters the team's [scope-injection review](/features/sprints/) as a pending item. A completed-sprint view is read-only for assignment.

## Board cadence

:::note[0.3]
The board cadence picker and per-column aging thresholds land in 0.3.
:::

Agile and hybrid projects can run their board on one of two cadences, set in **Project → Settings → Workflow & fields → Board cadence** (Scheduler+):

- **Sprint-based** (the default) — the board carries the full sprint chrome: the active-sprint panel, burndown, and sprint header.
- **Continuous flow (Kanban)** — a continuous-flow board with no sprint cadence. The sprint panel, burndown, and sprint header are hidden, and the board leans on the always-present [Flow analytics](/features/flow-analytics/) panel (cycle time, throughput, cumulative flow) instead. That panel also carries a **throughput forecast**: a Monte-Carlo estimate over recent weekly throughput that headlines a P80 "finish in ~N weeks — by &lt;date&gt;" answer for the remaining backlog, so a Kanban team gets a forward delivery date without sprints or velocity. Cards still move through the same working columns.

Switching cadence is **non-destructive** — an in-flight sprint is preserved, not deleted, so switching back to sprint-based brings it back verbatim. Waterfall projects don't use sprints, so cadence doesn't apply to them.

### Aging cards

Each working column can carry an **aging threshold** in days, configured per column in **Workflow & fields** (Scheduler+). When a card sits in its column longer than that threshold it gets a calm "aging" badge showing its dwell time — a quiet nudge that work is stalling. The signal is board-local: it's visible to everyone on the board but is never rolled up into a program or portfolio metric. Leave a column's threshold blank to use the built-in default for that status.

## Mobile

On viewports below 768px the board reflows into a **horizontal snap-scroll layout**: each status column becomes a full-width page (`scroll-snap-align: start`), and swiping settles cleanly column-to-column. The phase swimlanes collapse on a phone — each column shows a flat list of its cards across every phase, so the narrow screen carries the status axis without nesting.

A **dot-strip** above the board names every column with its task count and a health dot, and acts as the map: the active column's bar fills solid, and tapping any segment jumps to that column. Card anatomy, WIP limits, and the critical / blocked treatment are unchanged from desktop — only the layout reflows. The mobile FAB creates a task in the first visible column.

## Permissions

| Action | Minimum role |
|--------|-------------|
| View the board | Viewer |
| Move cards, update status | Member |
| Create tasks from the board | Member |
