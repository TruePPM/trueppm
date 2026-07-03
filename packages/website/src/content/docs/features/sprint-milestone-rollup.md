---
title: Sprint → milestone rollup
description: Sprints linked to a Schedule-view milestone now propagate their progress live — the milestone's percent complete and date variance reflect sprint state without a status meeting or spreadsheet reconciliation.
---

:::note[Added in 0.3]
The **persistent, clickable scope-changed chip** and its **scope-change audit
drawer** were added in 0.3 (the agile team release), available since the
`0.3.0-alpha.1` pre-release (Jun 28, 2026). The live rollup itself is shipped
behavior.
:::

Linking a sprint to a Schedule-view milestone via `Sprint.target_milestone` makes that
milestone's `percent_complete` *live*. The number a PM sees on the Schedule view and the
number a Scrum Master sees on the Sprints view are the same number, computed
from the same sprint state, with no manual reconciliation step.

This closes the longest-standing gap between TruePPM's agile and waterfall
views: before this change, the link was display-only — the AdvancingToMilestone
card showed the milestone's name and date, but its progress drifted from the
sprint's real state until someone updated the Schedule view by hand.

## What changes

When at least one sprint targets a milestone task:

- The milestone's **percent complete** rolls up live from sprint
  `committed_*` / `completed_*` snapshots and current task state. The Schedule-view
  task list shows the rolled-up value with a 🔒 lock indicator and the
  AdvancingToMilestone card shows the same number.
- A **sprint plan variance** (positive = slip past the milestone, negative =
  ahead) appears next to the rolled-up value: `Sprint plan: +3d slip` or
  `Sprint plan: -2d ahead`. This is computed from the latest ACTIVE / PLANNED
  sprint's `finish_date` against the milestone's CPM date. Sprint dates are
  never automatically mutated.
- The variance chip **will be annotated with CPM float** *(ships in 0.4)* so a
  slip reads against the schedule's tolerance, not just its magnitude. Off the
  critical path it reads `Sprint plan: +3d slip · 8d float` and its color band
  reflects slip-vs-float — red when the slip exceeds the available float, amber
  when the float absorbs it, green when ahead. On the critical path it reads
  `Sprint plan: +3d slip · critical path` in the critical color regardless of
  slip magnitude, because a critical milestone has no float to give. The
  `total_float` / `is_critical` inputs are already computed by the CPM engine.
  The annotation appears in all three milestone surfaces: the Schedule-view task
  list, the milestone Overview drawer, and the AdvancingToMilestone card.
- A **scope-changed chip** appears when an active sprint's current backlog
  points sum diverges from its activation-time `committed_points` snapshot.
  *(Added in 0.3.)* The percent stays bounded; the chip surfaces the
  discrepancy so the value remains honest. The chip is **persistent and
  clickable** — not a hover-only tooltip — and shows the net scope delta
  (`+N / −M points`). It appears in all three milestone surfaces: the
  Schedule-view task list, the milestone Overview drawer, and the
  sprint-workspace AdvancingToMilestone card. See
  [scope-change audit chip](#scope-change-audit-chip) below.
- The milestone's `percent_complete` becomes **read-only against manual
  writes**. The API rejects writes with a structured 400 (`code:
  milestone_rollup_locked`). To override, unlink or close the sprint first;
  the lock releases immediately.

## Linking a sprint to a milestone

Binding is what turns on every rollup above — until a sprint targets a
milestone, none of it applies.

**In the app.** From the sprint panel, a Scheduler (or above) uses **Link
milestone** — the action appears only while the sprint is unbound. It opens a
dialog with a live **reforecast preview** (projected dates and a team-pace band,
computed on the fly and persisted to nothing), then either mints a new milestone
from the sprint goal or binds an existing milestone in the same project.

**Over the API.** `POST /api/v1/sprints/{id}/promote-to-milestone/` (Scheduler+):

- **Body `{}`** — mints a new `Task(is_milestone=true)` from the sprint goal,
  dated at the sprint finish, and binds it. Returns **201**. Optional
  `{"name", "target_date"}` rename or re-date the minted milestone (create-mode
  only; both are ignored when `milestone_id` is given).
- **Body `{"milestone_id": "<uuid>"}`** — binds an existing milestone in the
  same project. Returns **200**. Re-binding the milestone already bound is an
  idempotent **200**.

A dry run for the dialog is available at
`GET /api/v1/sprints/{id}/reforecast-preview/?milestone_id=<uuid>` (any project
member; omit `milestone_id` to preview the to-be-minted milestone).

To bind a *different* milestone, unbind first — the binding never silently
re-points. `POST /api/v1/sprints/{id}/unbind-milestone/` (Scheduler+) clears the
binding and its provenance and recomputes the freed milestone's rollup. It is
no-op-safe: an already-unbound sprint returns **200** unchanged.

### Errors

| Status | Code / body | When |
|--------|-------------|------|
| **409** | `{"code": "sprint_already_bound", "current_milestone_id": "<uuid>"}` | Binding a different milestone while the sprint is already bound. Unbind first. |
| **400** | `{"milestone_id": "Milestone not found in this project."}` | `milestone_id` does not name a milestone in the sprint's project. |

## Calculation

The rollup uses points by default and falls back to task counts when no team
member sized in points:

```
if any sprint has committed_points > 0:
    percent_complete = min(100, completed_points / committed_points * 100)
    basis = "points"
elif any sprint has committed_task_count > 0:
    percent_complete = min(100, completed_task_count / committed_task_count * 100)
    basis = "tasks"
else:
    percent_complete = null      # falls back to manual value
    basis = "none"
```

Sums are across **all** sprints targeting the milestone (completed + active
+ planned), reflecting cumulative progress toward the milestone. A milestone
targeted by three sprints reports cumulative completion, not the most recent
sprint alone.

`CANCELLED` sprints are skipped entirely — they contribute nothing to
either the denominator or the numerator.

## Scope-change audit chip

:::note[Added in 0.3]
This chip and its audit drawer were added in 0.3.
:::

The scope-changed chip is the milestone-side entry point into the same audit
the team sees on the Board. One click opens a **read-only scope-change audit
drawer** listing each per-task scope change behind the net delta — who added
or removed the task, when, the task, its point value, and whether the change
is `accepted`, `pending`, or `rejected`.

The chip is rendered identically in all three milestone surfaces — the
Schedule-view task list, the milestone Overview drawer, and the
sprint-workspace AdvancingToMilestone card — so the **PM** (looking from the
Gantt/Overview) and the **team** (looking from the sprint workspace) open the
**same audit from either side**. There is no team-private vs PM-private split
here: a scope change is a fact about the sprint's commitment, not a velocity
signal, so both audiences read it.

The drawer is backed by
[`GET /sprints/{id}/scope-changes/`](/features/board-sprint-panel/#api-endpoints-touched) —
the same endpoint that powers the [Board mid-sprint scope-change
badge](/features/board-sprint-panel/#mid-sprint-scope-changes). It is a
visibility surface only; it never accepts or rejects a change.

*Screenshot TODO: a milestone row in the Schedule-view task list showing the
persistent `Scope changed +5 / −2 pts` chip, and the open scope-change audit
drawer.*

## What is broadcast

Real-time updates use a new `milestone_rollup_updated` WebSocket event. The
payload is **aggregated only** — never includes per-assignee task lists or
raw committed/completed point counts:

```json
{
  "milestone_id": "<uuid>",
  "percent_complete": 73.5,
  "rollup_basis": "points",
  "variance_days": 3,
  "sprint_scope_changed": false,
  "sprint_count": 1
}
```

This deliberate constraint preserves team autonomy: PMO-visible surfaces see
rolled-up milestone health, but per-team velocity and individual assignments
stay on the sprint side and remain bounded by the sprint board's permissions.

## When the rollup recomputes

- **On sprint state change**: activate, cancel, close — recompute fires in the
  same transaction that runs the existing snapshot.
- **On sprint create / update / delete**: re-link to a new milestone recomputes
  both the old and new milestones so neither holds a stale value.
- **On task save**: tasks in a sprint with a target milestone recompute the
  rollup live (best-effort — broker failures don't block the underlying task
  write; the next state change reconciles).

The authoritative recompute always runs inside the
[`SprintCloseRequest` outbox drain](/administration/durability/) on
close, after the immutable `completed_*` snapshot lands, so the final value
is correct even if a live recompute was missed during an outage.

## Forecast-shift notification on close

Sprints are usually closed by the team, often outside the project manager's
working session. So when closing a sprint reforecasts a bound milestone and that
reforecast **materially** moves its likely finish or confidence, TruePPM notifies
the project's manager cohort (Project Manager and Project Admin roles) with a
short schedule-language summary — for example, *"Sprint 4 closed — GA Launch
likely finish Jul 20 → Aug 1 (est. by Aug 15, medium confidence)."* It arrives
in-app and by email, and clicking it opens the milestone in the Schedule.

The summary carries **dates and a confidence label only — never velocity points**,
matching the [signal-privacy model](/features/settings/signal-privacy/). A recompute
that changes nothing produces no notification, so a no-op close is never noise.
Any recipient can mute either channel from **Settings → Notifications**.

## Read-only override

There is no override flag in v1. To edit a milestone's percent manually:

1. Unlink the sprint by setting `target_milestone = null` on the sprint, or
2. Close all targeting sprints.

The milestone field unlocks immediately when the last live targeting sprint
is gone.

## Limitations and scope

- Rollup is **single-project** scope. A milestone in Program A and a sprint in
  Program B cannot be linked. Cross-program milestone aggregation is an
  Enterprise concern.
- Variance is **display only** — there is no "shift the milestone" button.
  The PM owns the Schedule view; the rollup advises but never mutates dates.
- Portfolio-level milestone health rollup (across many projects, for a PMO
  dashboard) is part of `trueppm-enterprise`.

## See also

- [ADR-0074](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0074-sprint-to-milestone-rollup.md) — design rationale and broadcast payload contract
- [ADR-0036 — Hybrid PM philosophy](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0036-hybrid-pm-philosophy-and-sprint-model.md) — the auto-advance promise this feature realizes
- [Sprint planning capacity (ADR-0073)](/features/board-sprint-panel/) — the planning surface that feeds `committed_points`
- [Sprint burndown](/features/sprint-burndown/) — sprint-side view of the same numbers
