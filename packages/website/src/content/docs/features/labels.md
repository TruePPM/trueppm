---
title: Task Labels
description: Colored, filterable labels that categorize tasks across the board and schedule, independent of status, sprint, or WBS.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
Task labels ship in 0.4. This page describes the planned behavior; until 0.4 is tagged, treat it as the design of record.
:::

**Labels** are colored tags you attach to tasks to categorize work along a free axis — `bug`, `tech-debt`, `blocked-external`, `frontend` — orthogonal to status columns, sprints, and the WBS. A task can carry several labels, and the board can be filtered to any of them.

Labels are **project-scoped**: each project owns its own label vocabulary. They are distinct from **backlog tags** (the free-text tags on program-backlog intake items) — an item is *tagged* while it is being groomed in the backlog, then *promoted* into a task that carries *labels*.

## Where labels appear

- **Board cards** — colored pills in the card's badge row. Card density controls how many show: **compact** renders up to three color dots, **comfortable** shows up to two pills plus a `+N` overflow chip, and **detailed** shows them all.
- **Schedule task drawer** — the task's labels, with an inline control to assign existing labels or create a new one.
- **Board filter bar** — a **Label** facet joins the existing Assignee, Priority, and Due facets. Select one or more labels and the board narrows to cards carrying any of them; non-matching cards dim out. The facet appears only when the board has labeled cards.
- **Table / Grid toolbar** and the **product backlog filter bar** — the same **Label** facet, described under [Filtering by label](#filtering-by-label) below.

## Filtering by label

A **Label** facet sits in the toolbar of the board, the **Table / Grid**, and the **product backlog**. It behaves the same way on each:

- **Pick one or more labels.** Rows carrying **any** of the selected labels are kept (OR). The label filter combines with everything else that is set — an owner, a status, a readiness state — by **AND**.
- **The list shows every label in the project**, each with a count of how many rows in the current view carry it. A label used by nothing shows a visible `0`, so choosing it is a deliberate act and the resulting empty result is expected rather than puzzling.
- **Each active label gets its own chip** below the toolbar, with its color swatch and name. The chip's ✕ removes just that label; **Clear labels** in the panel drops all of them and leaves your other filters alone; **Clear all** resets everything.
- **Filtering is instant and works offline.** It runs over the rows the view has already loaded, so there is no spinner and no waiting — when you are offline the chip strip says how many loaded rows are being filtered.
- **Keyboard-complete.** Open the panel with <kbd>Enter</kbd>, <kbd>Space</kbd> or <kbd>↓</kbd>; move with <kbd>↑</kbd>/<kbd>↓</kbd>, jump with <kbd>Home</kbd>/<kbd>End</kbd>, or type the first letters of a label's name. <kbd>Space</kbd> toggles a label without closing the panel, so you can refine and watch the rows update. <kbd>Esc</kbd> closes and returns focus to the trigger. A label's name is always shown next to its color, so the filter never depends on distinguishing hues.
- Once a project has more than eight labels the panel grows a search box. Searching narrows what you can *see* in the list, never what is *applied*.

On the **Table / Grid** the selection is part of the URL as `?fl=<label-id>[,<id>…]` — the same key the board uses — so a filtered table can be bookmarked or pasted into a status report. The product backlog's grooming filter is not stored in the URL (none of its filters are), so a label selection there lasts for the session.

If a project has no labels yet, the facet still opens and explains where labels come from, with a link to the project's label settings.

### Owner and Status on the Table / Grid

The Table / Grid toolbar carries three facets, reading left to right: **Owner**, **Status**, **Label**. They are one control with three option lists, so what you learn on any of them applies to the others — the same panel, the same counts, the same keyboard model, the same chips below.

- **Owner** lists **everyone on the project's resource pool**, split into `On these rows` (people with at least one matching row, most first) and `All members`. Someone with nothing in the current view is still listed, with a `0` — so "nobody is assigned to this" never gets confused with "that person has no rows here". Past eight people the panel grows a search box that filters both groups at once.
- **Status** lists **every status**, always in pipeline order — Backlog, Not started, In progress, Review, On hold, Done — and never re-sorts by count. A status nothing is in stays listed and selectable; picking it is a legitimate way to confirm nothing is there.
- All three are multi-select. Within a facet the values combine with **OR**; across facets they combine with **AND**. Each selected value gets its own chip, so you can drop one owner without losing the other.
- Opening one panel closes the others, and each facet is its own <kbd>Tab</kbd> stop, so you can sweep all three without a mouse.
- When the combination matches nothing, the empty state names what each filter would have kept on its own and offers to drop the one that brings back the most rows — an empty intersection reads as an intersection rather than as a broken filter.

Both selections ride the URL as `?owner=<id>[,<id>…]` and `?status=<STATUS>[,…]`, alongside `?fl=`, so the whole filtered view is one shareable link. **Links made before these controls existed keep working** — a single value is simply a one-item list, and an `?owner=` carrying a person's name still resolves.

## Finding a label across a program

Labels are project-scoped, so `security-review` in one project is a different
catalog entry from `security-review` in another — different id, and possibly a
different color. The **Labels** view on a program answers the question that
spans them: *everything tagged `security-review` anywhere in this program*.

Open a program and choose **Labels**. Pick a label name and the matching tasks
appear grouped by project, in plan order within each group. Matching is by
**name and case-insensitive**, so `Security-Review` and `security-review` are
treated as one concept rather than two.

Three things are worth knowing before you rely on it:

- **The same label can appear in different colors.** Each row shows its own
  project's pill, in that project's color, because color is a per-project
  choice and there is no canonical answer across projects. The view says so
  inline when a result set actually spans more than one color.
- **You may not see everything.** Being a member of the *program* is what opens
  this view; being a member of each *project* is what fills it. If some of the
  program's projects are ones you do not belong to, the view tells you how many
  were left out rather than quietly showing a short list.
- **It is scoped to one program, deliberately.** There is no "across all
  programs" version in the community edition — cross-program rollup is
  portfolio governance rather than program management.

The counts in the label picker are the number of **projects** carrying that
name, not the number of tasks — the picker's job is to show you where a label
is in use.

## Creating and assigning labels

Any **team member or above** can create a label — coin `needs-design` mid-retro without filing a ticket. Each project has a soft cap on the number of label definitions (50 by default, configurable by the operator) to keep the vocabulary from sprawling.

Assigning a label to a task is a task edit: a member can label the tasks they can edit, and admins can label any task. Assignment is **idempotent** — attaching a label that is already there, or removing one that is not, is a safe no-op, so two people (or an integration) toggling different labels on the same task never clobber each other.

## Managing the catalog

Project **admins** curate the catalog from **Settings → Labels**: rename, recolor, reorder, and delete. Renaming or recoloring a label updates every card that carries it. Deleting a label removes it from every task it was on.

## Labels in saved board views

A saved board view remembers its label filter along with the rest of its
filters, and the views menu shows what each view actually filters **before** you
open it — owner and priority counts, plus each label's color swatch and name.
Picking a saved view is a decision, not a guess followed by an undo.

Because a label can be deleted after a view was saved, a view can end up
pointing at a label that no longer exists. TruePPM does not quietly drop that
filter and return more rows than the view promises. Instead:

- the label appears as a struck-through **tombstone** in the menu, so the view
  is visibly incomplete from the list;
- opening the view shows a notice that names the consequence in the units on
  screen — `31 of 214 rows · label filter not applied` — and confirms your other
  filters are unchanged;
- you can **remove that filter from the view**, **create a replacement label**,
  or **keep it for now**. Keeping it changes nothing: the view is left exactly as
  saved, so it can still be repaired later, by you or by a teammate.

A deleted label's *name* is not shown, because it is genuinely gone — the label
catalog does not serve deleted entries. A saved view can also carry a label from
a project you cannot see; that renders as the same anonymous tombstone, and
TruePPM will not resolve its name.

:::note[Ships in 0.4]
Persisting a label filter in a saved view, and the tombstone and repair flow
above, ship in 0.4.
:::

## Color and accessibility

A label's color is chosen from a fixed **8-color palette** (slate, teal, purple, blue, rose, amber, green, cyan). Each color renders as a theme-aware pill that meets WCAG 2.1 AA contrast in both light and dark mode, and every pill carries a leading color dot alongside its always-visible name — so color is never the only way to tell labels apart.

## Offline and real-time

Labels sync to the offline store like the rest of the schedule: the label catalog syncs as its own collection, and a task's label assignments ride the task's own version, so a labeled task reconciles correctly after working offline. When you are online, label changes broadcast over the project WebSocket so collaborators' boards update live.

## For integrations and agents

Labels are first-class API objects. A read-only MCP client (or any API consumer) can read a task's labels, and filter the task list by them with `GET /api/v1/tasks/?labels=<id>[,<id>…]` — a comma-separated list of label UUIDs returns tasks carrying **any** of them (OR), the same semantics as the board's label facet. Labels are project-scoped, so results stay within the projects you can already see.

Across a program, two read-only endpoints back the program Labels view:

- `GET /api/v1/programs/{program_id}/label-tasks/?label=<name>` — tasks in that program carrying the label **name** (case-insensitive), paginated, each row carrying the project it belongs to. The response also reports `withheld_project_count`, the number of the program's projects excluded because you are not a member of them.
- `GET /api/v1/programs/{program_id}/label-catalog/` — the distinct label names in the program, each with the number of projects using it.

The program id is part of the **path**, not a query parameter, and that is deliberate: it means there is no way to widen the request to "every program at once" by omitting a filter.

Writing labels from an agent — attaching or detaching them — arrives with the MCP write surface in a later release.

## Not in the first release

- Labels do not yet appear in the **schedule PDF export** or color the **Gantt bars** — that is planned as a follow-up.
- The **schedule / Gantt** view does not yet carry the Label facet — it is the one task view without it, since the Board, Table/Grid, and Product Backlog all have one. It lands in 0.5 as part of a single filter vocabulary shared across the task views ([#2443](https://gitlab.com/trueppm/trueppm/-/issues/2443)), and is tracked on the [Known Issues](/overview/known-issues/#findability-and-filtering) page until then. When it arrives it will **dim** non-matching rows rather than hide them, because a filtered-out task still drives the dates of the ones that remain.
- A **workspace-wide** "tasks with label X" view does not exist — cross-project search is scoped to a single program (see [Finding a label across a program](#finding-a-label-across-a-program)).
- Label colors are chosen from the fixed palette; free hex colors are not supported.
