---
title: "Sprints and estimation API"
description: "Sprint cadence generation, sprint–milestone binding, scope and duration changes, estimation poker, retro items and velocity suggestions."
documentedFor: "0.4"
---

## Create a single sprint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/projects/{id}/sprints/` | Create one sprint on the project |

Team Member+ (`IsProjectMemberWrite`); `capacity_points` on the request body
carries its own higher gate at Resource Manager+. List and retrieve
(`GET /api/v1/projects/{id}/sprints/`, `GET /api/v1/sprints/{id}/`) are
Viewer+. Destroy is Project Manager+ and only permitted while the sprint is
still `PLANNED`.

## Sprint cadence generator

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/projects/{id}/sprints/generate/` | Lay out a whole run of sprints in one call — preview or commit |

Stands up a series of iterations in one request instead of one `POST /sprints/`
per sprint. Team Member+ (the same gate as creating a single sprint); the
optional `first_sprint_capacity_points` field additionally requires Resource
Manager+, matching the field-level gate on `capacity_points`.

**Request** — describe the cadence either by parameters or by an explicit row list:

| Field | Type | Description |
|---|---|---|
| `count` | integer | How many iterations (1–52). Required unless `sprints` is given |
| `start_date` | date | Start of the first iteration; snapped forward to a working day. Required unless `sprints` is given |
| `length_days` | integer | Working days per iteration (2–30, default 10) |
| `name_pattern` | string | Name template; must contain `{n}` (default `Sprint {n}`) |
| `first_index` | integer | Value substituted for `{n}` in the first iteration (default 1) |
| `dry_run` | boolean | Compute and return the cadence without writing anything (default `false`) |
| `first_sprint_capacity_points` | integer / null | Stored on the **first row of the cadence**, and only when supplied and that row is one this call creates. Resource Manager+ |
| `sprints` | array | `{name, start_date, finish_date}` rows — the edited preview posted back. Wins over `count`/`start_date`. Each row must span 120 days or fewer |

**Response** — the same shape for a preview (`200`) and a commit (`201`):

```json
{
  "dry_run": false,
  "sprints": [
    {
      "name": "Sprint 1",
      "start_date": "2026-04-06",
      "finish_date": "2026-04-17",
      "working_days": 10,
      "non_working_days_skipped": 4,
      "status": "created",
      "id": "…"
    }
  ],
  "created_count": 1,
  "skipped_count": 0,
  "capacity_hint": {
    "points": 24,
    "basis": "velocity_average",
    "sprints_sampled": 3,
    "note": "A starting point drawn from this team's own closed iterations — not a limit. The team decides what it commits to."
  }
}
```

Four properties are guaranteed:

- **Calendar-aware.** `length_days` counts *working* days against the project's
  composed calendar — the same fold CPM and Monte Carlo use, including holiday
  overlays and the program/workspace inheritance chain. A shutdown inside a
  window pushes the finish date out rather than shrinking the iteration, and
  `non_working_days_skipped` reports every non-working day the window spans.
- **Preview writes nothing.** `dry_run: true` returns the identical payload with
  `id: null` on every row and `status: "new"` on the rows that would be created
  (already-taken names still come back as `"exists"` — that is the point of the
  preview), so a client can render and edit it before committing.
- **Idempotent on name.** A candidate whose name already belongs to a live sprint
  in the project comes back as `status: "exists"` and is never re-created or
  overwritten. Submitting twice yields one cadence.
- **Bounded.** At most 52 iterations per call, each holding at most 30 working
  days (or, on the edited-row path, spanning at most 120 calendar days); a larger
  `count` or `sprints` list is a `400`. There is no endpoint-specific rate limit
  beyond the account-wide default — aggregate bulk-write governance is tracked
  with the token-scope work.

`capacity_hint` is a suggestion, never a ceiling: generation does not write it
anywhere by itself, and `note` is server-owned copy that clients render alongside
the number. A `400` with a `detail` message is returned when the project's
calendar has no usable working day in range; that case carries
`code: "calendar_has_no_working_day"` so a client can route the user to calendar
settings rather than surfacing prose.

## Sprint–milestone binding

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/sprints/{id}/promote-to-milestone/` | Bind the sprint's commitment to a schedule milestone so sprint velocity forecasts a P50/P80 band around its CPM finish |
| POST | `/api/v1/sprints/{id}/unbind-milestone/` | Remove the binding between the sprint and its milestone |

See [Sprint–milestone rollup](/features/sprint-milestone-rollup/) for the UI
workflow and error codes.

## Sprint scope changes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/sprints/{id}/scope-changes/` | Audit list + delta of pending mid-sprint scope-injection requests |
| POST | `/api/v1/sprints/{id}/scope-changes/accept/` / `/api/v1/scope-changes/{id}/accept/` | Accept a pending scope-injection request |
| POST | `/api/v1/sprints/{id}/scope-changes/reject/` / `/api/v1/scope-changes/{id}/reject/` | Reject a pending scope-injection request |

The mid-sprint scope-injection approve-gate (ADR-0102 §5) referenced from
[Sprints](/features/sprints/) — a task added to an active sprint after it
started lands here pending Scrum Master / Product Owner approval rather than
silently joining the commitment.

## Sprint and task duration changes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/sprints/{id}/duration-events/` | Every duration change recorded against tasks in this sprint, newest first |
| GET | `/api/v1/tasks/{id}/duration-events/` | Duration-change history for one task, newest first |

The audit behind the mid-sprint duration change (ADR-0151): when a task's
`duration` is edited, the effective percent-complete policy decides whether `%`
is kept or prorated, and one event row records the before/after and the policy
applied. Any project member (Viewer and up) may read both.

**The two endpoints return different shapes — do not assume they match.** The
per-sprint aggregate exists so a sprint changes-log renders in one request
instead of one per task, so it denormalizes `task_name` / `actor_name` and
returns a single object:

```json
{"events": [
  {"id": "…", "task_id": "…", "task_name": "Design",
   "old_duration": 10, "new_duration": 20,
   "percent_complete_at_change": 50.0, "percent_complete_after": 25.0,
   "policy_applied": "prorate", "actor_name": "Sarah Chen",
   "created_at": "2026-04-03T09:12:00+00:00"}
]}
```

Note the timestamp offset form. This aggregate is assembled as plain values rather
than through a serializer, so `created_at` is a raw ISO-8601 string with a numeric
offset — the per-task endpoint below renders the same instant as `…09:12:00Z`.
Parse both with an ISO-8601 parser rather than matching on the suffix.

`percent_complete_after` is `null` unless the policy actually changed `%` (that
is, under `prorate`) — under `keep` and `confirm` it stays null, which is how a
client distinguishes "the policy moved the number" from "the policy left it
alone". The events list is empty, never absent, for a sprint with no changes.

The **per-task** endpoint is [paginated](/api/reference/#pagination) instead, returning
`{count, next, previous, results}` where each result carries the raw `task`,
`actor`, and `sprint` foreign keys plus a `source` enum.

## Estimation poker

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/sprints/{sprint_id}/poker/` | List live rounds / open a new round (facilitator) |
| POST | `/api/v1/poker/{id}/vote/` | Cast or change my vote |
| POST | `/api/v1/poker/{id}/reveal/` | Reveal votes (facilitator) |
| POST | `/api/v1/poker/{id}/reopen/` | Reopen for a re-vote (facilitator) |
| POST | `/api/v1/poker/{id}/commit/` | Commit the agreed points — writes `Task.story_points` (facilitator) |
| POST | `/api/v1/poker/{id}/cancel/` | Cancel the round (facilitator) |

See [Estimation poker](/features/estimation-poker/).

## Retro board items

| Method | Path | Description |
|--------|------|-------------|
| PATCH / DELETE | `/api/v1/retro-items/{id}/` | Edit or remove a retro board item |
| POST | `/api/v1/retro-items/{id}/convert-to-action/` | Convert a retro item into an action item |

Complements the `/api/v1/sprints/{id}/retro/` read/upsert endpoints and the
action-item promote/pull-to-sprint routes documented in
[Retrospective](/features/retrospective/) — that page covers the retro as a
whole; these two routes edit an individual board item once it exists.

## Velocity suggestions

`/api/v1/velocity-suggestions/` (list, accept, dismiss) is fully documented in
[Velocity calibration](/features/velocity-calibration/#api-endpoints).
