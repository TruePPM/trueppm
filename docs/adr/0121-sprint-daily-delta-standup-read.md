# ADR-0121: Sprint Daily-Delta Read — the Team "What Changed Since Yesterday" Standup Surface

## Status
Proposed

> **Companion to** ADR-0096 (unified task-activity timeline — the per-task history
> this read summarizes), ADR-0102 (`SprintScopeChange`), ADR-0104 (signal-privacy
> model — referenced for the privacy posture, not extended), ADR-0106/#861 (the
> *PM* milestone-confidence bridge digest — deliberately distinct from this
> *team* standup).

## Context

The 0.3 agile-cohort epic (#883) Wave 4 found the **Daily Scrum has no owner** in
TruePPM: the team has no "what changed since yesterday" surface for the active
sprint. Alex (Scrum Master) runs standup off memory and a manual board scan. #925
fills that gap with a lightweight, **pull-only** team view: moved cards, new
blockers, scope changes, burndown delta, and a per-person at-a-glance of what each
teammate touched.

Two hard constraints frame it (Morgan, Agile Coach): **no PMO real-time visibility
into sprint internals**, and **no hours/keystroke-level surveillance**. And Priya's
attention guard: **pull, not push** — no notifications; Alex opens it at standup.

**Key finding (codebase exploration, 2026-06-11): this needs NO new persisted
model.** Every input already exists and is queryable by timestamp:
- `HistoricalTask` (django-simple-history, `models.py:1229`, 90-day retention) —
  status/assignee/sprint changes, with `history_date` (when), `history_user`
  (actor), `history_type`. Diff logic already lives in `apps/history/views.py:77`.
- `SprintScopeChange` (`models.py:2778`, ADR-0102) — sprint injections, with
  `added_at`/`added_by`.
- `SprintBurnSnapshot` (`models.py:2206`) — one row/day with `remaining_points` /
  `completed_points`; the burndown delta is today's row vs the prior day's.

There is **no `BLOCKED` status and no blocker model** — `ON_HOLD` is the only
"stuck" signal in `TaskStatus` (BACKLOG/NOT_STARTED/IN_PROGRESS/REVIEW/ON_HOLD/
COMPLETE).

**P3M layer**: Programs and Projects / Operations — single-project, team-scoped
ceremony. **OSS.** No cross-project aggregation; nothing crosses the Apache-2.0
boundary.

## Decision

### §1 — A single read-only endpoint, computed from existing data, no model

`GET /api/v1/sprints/{id}/daily-delta/?since=<iso8601>` — a read action on
`SprintViewSet`, `IsProjectMember`. Returns a server-computed delta:

```
{
  since: iso, until: iso, sprint_id,
  task_changes:  [ { task_id, task_short_id, task_title, kind, from, to,
                     actor_id, actor_username, at } ],   # status & assignee moves
  scope_added:   [ { task_id, task_short_id, task_title, added_by_username, at,
                     status } ],                          # SprintScopeChange since T
  new_blockers:  [ { task_id, task_short_id, task_title, actor_username, at } ],  # → ON_HOLD
  burndown_delta:{ prior_date, prior_remaining, current_date, current_remaining,
                   remaining_delta, completed_delta } | null,
  per_actor:     [ { actor_id, actor_username,
                     moved, completed, added, blocked } ]  # summarized counts only
}
```

`task_changes` is derived by walking each sprint task's `HistoricalTask` rows with
`history_date >= since`, diffing consecutive rows for `status` and `assignee`
changes (reusing the ADR-0096 diff approach). `new_blockers` is the subset whose
status transitioned **into `ON_HOLD`**. `scope_added` reads `SprintScopeChange`
by `added_at >= since`. `burndown_delta` reads the two most recent
`SprintBurnSnapshot` rows. `per_actor` is a server-side rollup grouping the above
by `history_user`/`added_by` into **counts** (`moved`/`completed`/`added`/
`blocked`) — never durations, never per-event spam.

API-first: the entire delta is a server fact (`sprint_daily_delta()` service); the
client renders it and derives nothing. MCP reaches it as a plain authenticated GET.

### §2 — The "since" anchor: explicit param, default rolling-24h, floored at sprint activation

`since` is an **explicit ISO query param** the client supplies (it owns
"since my last standup" / "since I last looked" — a value it can persist locally).
When **absent**, the server defaults to **`now − 24h`** — "what changed since
yesterday" ≈ the last day, with no timezone/working-calendar machinery to get
wrong in v1. The effective floor is **`max(since, sprint.activated_at)`** so the
delta never reaches before the sprint started (and, transitively, never past the
`HistoricalTask` 90-day window for a sane sprint length). An explicit `since`
older than activation is clamped up; a missing/blank `since` uses the 24h default.
Anchoring to the prior `SprintBurnSnapshot.snapshot_date` was considered (Alt B)
but rejected for v1 — it couples the time window to the snapshot cron and is less
predictable than a rolling 24h; the client can always pass the exact anchor it
wants.

### §3 — "New blockers" = transitions into `ON_HOLD` (no blocker model invented)

With no blocker model, **"new blockers since T" = tasks whose status changed to
`ON_HOLD`** in the window (from the same `HistoricalTask` walk). This is the honest
mapping of the existing data; inventing a `Blocker` model or a `blocked` boolean
for this read would be scope the issue doesn't ask for. **Dependency-derived
blockers** (a task waiting on an unfinished predecessor) are a deliberate **future
refinement** (filed as follow-up) — they need a dependency-state diff that is out
of scope for the standup v1.

### §4 — Privacy: membership IS the boundary (no new signal key); status-level only

- **`IsProjectMember`.** The delta is team activity; every project member (the
  team, incl. the SM who runs standup, and the PM) reads it. A **PMO/org principal
  is a non-member** and is denied by the standard back-door close (`_membership_
  role(...) is None → 403`). This gives Morgan's "no PMO real-time visibility into
  sprint internals" **structurally**, with no new `ProjectSignalPrivacyPolicy`
  signal key — PMO simply has no `ProjectMembership` row. (Cross-team/PMO rollups
  remain Enterprise and are not built here.)
- **No hours/keystroke.** The delta exposes only **status-level field changes**
  (moved to Review, → ON_HOLD, added to sprint) and **counts** per actor. It never
  reads time entries, never computes durations, never counts edits — so the
  surveillance hard-NO holds by construction, not by a toggle.
- **Active-sprint ceremony.** The endpoint serves any sprint id, but the surface is
  the *active* sprint's standup; the panel renders only for `ACTIVE`.

**Reconciling with ADR-0096 (actor hidden from non-ADMIN on the per-task log).**
ADR-0096 hides `history_user` from non-admins on the **granular, full-history,
per-task forensic log** — there, surfacing every field-edit's author to everyone
invites blame-mining of the detailed audit trail. #925 deliberately shows the
actor **to the team** because it is a **different surface with a different
purpose**: a *summarized*, *time-boxed* (since-yesterday), *status-level* standup
rollup whose entire point is the collaborative "who's working on what" the Daily
Scrum exists to share. The divergence is by **granularity + recency + ceremony
intent**, not an inconsistency — and it stays within the team (PMO is excluded by
§4's membership gate). This is an explicit, documented product decision, flagged
for the security-review.

### §5 — Per-actor at-a-glance: summarized counts, grouped by the actor

`per_actor` groups the window's changes by `history_user` (the person who made the
change) / `added_by`, into **counts** — `moved` (status changes), `completed`
(→ COMPLETE), `added` (scope injections), `blocked` (→ ON_HOLD). "Alex: 2 moved,
1 completed." No raw event list per person, no timestamps-per-person beyond the
window, no durations. This is the at-a-glance the issue asks for, bounded so it
reads as standup awareness, not a productivity scoreboard.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A (chosen): read-only endpoint computing the delta from HistoricalTask + SprintScopeChange + SprintBurnSnapshot; IsProjectMember gate; rolling-24h default `since`** | No model, no migration; reuses three existing, timestamp-queryable sources; privacy is structural (membership); pull-only | A non-trivial server-side history walk/diff on each call (bounded by sprint size × window; acceptable, cacheable later) |
| B: anchor `since` to the prior `SprintBurnSnapshot.snapshot_date` | "day" aligns to the burndown grid | Couples the window to the snapshot cron; less predictable; still needs a fallback when no snapshot exists |
| C: new `StandupSnapshot`/activity-event model written on each change | O(1) read | A whole new write-path + model + migration + retention for data already in HistoricalTask — rejected (the issue's own framing is "what changed", i.e. a derived read) |
| D: push notifications / digest on a schedule | proactive | Violates pull-not-push (Priya) and risks the PMO-visibility line; this is #855/#861 territory, not the standup |
| E: gate per-actor attribution to ADMIN+ (mirror ADR-0096) | consistent with the forensic log | Defeats the ceremony — ordinary members couldn't see "who's on what" at their own standup; the granularity/purpose distinction (§4) justifies team visibility |

## Consequences

- **Easier**: Alex runs a real Daily Scrum off a server-computed delta; the team
  sees moves, new blockers, injected scope, and the burndown swing since yesterday,
  with a per-person at-a-glance — all team-private by membership, no notification
  noise, no surveillance surface.
- **Harder**: the history-walk/diff is the one piece of real logic — it must be
  bounded (sprint tasks × window) and avoid N+1 (prefetch history for the sprint
  task set in one query, ordered, diffed in Python); a future scale option is to
  cache per (sprint, since) or precompute, but v1 computes on read.
- **Risks**: (1) actor visibility to the team diverges from ADR-0096 — mitigated by
  the §4 granularity/purpose rationale + the security-review flag; (2) "blocker" =
  ON_HOLD is a proxy — documented, with dependency-blockers as a named follow-up;
  (3) an unbounded `since` could scan far — clamped to `sprint.activated_at` and the
  90-day retention floor.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations. **OSS.**
- **Affected packages**: api (`sprint_daily_delta()` service in `services.py`;
  `daily_delta` GET action on `SprintViewSet`; `SprintDailyDeltaSerializer`; url);
  web (`useSprintDailyDelta` hook; `SprintDailyDeltaPanel` in `SprintsView` for the
  active sprint, with a per-actor at-a-glance + a `since` control). No scheduler.
  Mobile: online read (like `/outcome/`).
- **Migration required**: **no** — pure read over existing models.
- **API changes**: yes — one additive GET route (`daily-delta`) + its serializer.
  Regenerate `docs/api/openapi.json` after merging origin/main.
- **OSS or Enterprise**: **OSS.** (Cross-team standup rollups, if ever, are
  Enterprise — not built here.)
- **Coordinate with**: ADR-0096 (the per-task history this summarizes + the actor-
  visibility divergence), ADR-0102 (`SprintScopeChange`), ADR-0104 (the membership
  back-door-close pattern this relies on), #861/ADR-0106 (the distinct PM digest).

### Durable Execution
1. **Broker-down behaviour**: N/A — pure synchronous read; no async dispatch, no
   `.delay()`, no outbox.
2. **Drain task**: N/A — no async work.
3. **Orphan window**: N/A — no outbox rows.
4. **Service layer**: new `sprint_daily_delta(sprint, since, request)` read function
   in `projects/services.py`; no dispatch path.
5. **API response on best-effort dispatch**: N/A — synchronous `200` with the delta.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: N/A for writes; the read is naturally idempotent (same inputs →
   same delta) and side-effect-free.
8. **Dead-letter / failure handling**: N/A — no task; a query error surfaces as a
   normal `5xx` and the client retries the GET.
