# ADR-0166: Daily Standup Walk-the-Board Surface

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class StandupView)

## Context

The daily standup (Daily Scrum) is the one core Scrum ceremony with no dedicated
facilitation home on the **board**. TruePPM already ships ADR-0121 / #925: the
`SprintDailyDeltaPanel` "what changed since yesterday" team-wide **change feed**,
mounted on the Sprints view. That panel answers *"what moved?"* — a flat,
chronological delta of status transitions, new blockers, scope adds, and a
burndown delta.

A change feed is not how most teams actually run a standup. They **walk the board
person by person** — "let's hear from each of you: what did you finish, what are
you on today, what's blocking you" — going around the room one teammate at a time.
This is a distinct lens from the delta feed:

- The delta feed is **team-wide and change-centric** (what moved since `since`).
- The walk is **per-assignee and current-state-centric** (each person's
  done / doing / blocked right now), advanced by a stepper.

The VoC panel (load-bearing Alex 7 / Morgan 7 / Priya 7 / Jordan 5) confirmed the
walk is the surface a Scrum Master actually drives: *"the walk-the-board stepper
is exactly how I run the Daily Scrum — one person at a time."* This is the most
visible omission a Scrum team notices evaluating us against Jira / Azure Boards,
neither of which has a strong per-person walk.

This ADR designs the **per-person walk-the-board standup surface** (#1278) as a
complement to ADR-0121, reusing the same primitives (HistoricalTask diffs,
calendar working-day math, blocker-flag semantics, membership-scoped privacy).

### P3M layer
**Operations** — a single-team daily ceremony driven by the Scrum Master / team in
the room. Loved by Alex / Priya / Morgan / Jordan; the portfolio personas
(Marcus / Janet) scored it 2/10 🔴, which **confirms** correct OSS scoping rather
than signalling a gap (a feature aggregating *across* projects would serve them —
this one deliberately does not). **OSS.**

## Decision

Add a read-only, project-scoped **standup walk** endpoint and a board-mounted
walk-the-board web surface. No new model, no migration, no new write path, no new
WebSocket event.

### API (API-first)

`GET /api/v1/projects/{id}/standup/`

- Resolves the project's **ACTIVE** sprint server-side (`Sprint.state == "ACTIVE"`).
- Honest empty (200, not 404) when there is no active sprint or the board runs in
  continuous cadence (`Project.board_cadence != "sprint"`, ADR-0164): returns
  `{"active": false, "reason": "no_active_sprint" | "continuous_cadence", "walk": []}`
  so the client renders an empty state instead of an error.
- When active, returns the fully-assembled walk so no domain math leaks to the
  client (server-side facts, MCP-reachable, explainable):

```jsonc
{
  "active": true,
  "sprint": { "id", "name", "goal", "day_of": 4, "length": 10,
              "start_date", "finish_date" },
  "generated_at": "<iso8601>",
  "window_since": "<iso8601>",   // calendar-aware "done since" boundary (see below)
  "walk": [
    {
      "assignee": { "id", "name" } | null,   // null = the Unassigned bucket, last
      "done":        [ <card> ],   // became COMPLETE within the window (not carried)
      "in_progress": [ <card> ],   // current IN_PROGRESS / REVIEW
      "blockers":    [ <card> ]    // current blocked_reason != "" (ADR-0124)
    }
  ]
}
```

`<card>` = `{ id, name, status, story_points, dwell_days, aging,
blocker_type | null, blocked_since | null }`. **`blocked_reason` free text is
never serialized** (ADR-0124 §4 / #325) — only the structured `blocker_type` and
`blocked_since` travel, so the shared standup screen never leaks a contributor's
private reason.

### Permission and privacy (resolves Morgan's 🔴-priority constraint)

`permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]`,
copied verbatim from `BoardActivityView`. **Membership *is* the boundary**
(ADR-0104 back-door-close): a PMO / portfolio role that is not a project member
gets 403. The walk groups by **assignee**, which is already visible on every board
card — it exposes no new change-actor attribution, so it sits inside the existing
ADR-0104 / ADR-0119 privacy envelope. It is never rolled up cross-project; there is
no program/portfolio variant. `role = _membership_role(request, project.pk)` is
resolved for parity with the activity feed, but the only field it gates
(`blocked_reason`) is already excluded for everyone by construction.

### "Done since yesterday" — calendar-aware (resolves Alex's 🔴-priority constraint)

"Done" = tasks whose status **became** `COMPLETE` within the window, with their
prior history row's status `!= COMPLETE` (so already-complete carried cards are
excluded). The window start is the **last working day**, not a 24h delta — a Monday
standup must include Friday's completions:

- `window_since = start_of_day(last_working_day_before(today))`, computed by
  reverse-scanning from `today - 1 day` with `_is_working_day(working_days_mask,
  exception_ranges, d)` (`projects/utilization.py`), in the project calendar's
  timezone.
- Floored at `sprint.activated_at` (never count completions from before the sprint
  started).

The completion set comes from `Task.history.model` (`HistoricalTask`,
`history_type="~"`, `status=COMPLETE`, `history_date__gte=window_since`), with the
predecessor-row status check `board_activity.py` already demonstrates.

### Aging flags

Per card, `aging = dwell_days > column.age_threshold_days` where
`age_threshold_days` is read from `BoardColumnConfig.columns` (ADR-0164 #410) for
the card's status, and `dwell_days` derives from `status_changed_at`. `null`
threshold → not aging (client default applies elsewhere; the walk treats `null` as
"no server-configured threshold" → `aging = false`). The flag surfaces stale work
during the walk without anyone hunting for it.

### Sprint Goal header (resolves Alex's cheap high-value ask)

`sprint.goal` is returned at the top of the payload so the walk anchors to the
commitment — a Daily Scrum, not a status recital.

### Service layer

New `standup.py` module mirroring `board_activity.py`:
`standup_walk(project, *, role) -> dict`. One query for active-sprint tasks
(`select_related("assignee")`), one `HistoricalTask` query for the done-window, one
`BoardColumnConfig` read; bucketing happens in Python — **no N+1 over assignees**.

### Real-time (no new broadcast)

The web surface subscribes to the **existing** board WebSocket events
(`task_updated`, `sprint_scope_changed` — ADR-0152 / ADR-0160 Amendment B) and
invalidates its `['project', id, 'standup']` query. No new WS event type; the
FROZEN event contract is untouched.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. New `GET /projects/{id}/standup/` walk endpoint (chosen)** | Server owns calendar/aging/bucket math (API-first, MCP-reachable); single round trip; honest empty state | One new (read-only) endpoint + serializer |
| B. Reshape from the shipped `daily-delta` endpoint client-side | No new endpoint | `daily-delta` is change-centric — it has no per-assignee *current* in-progress buckets; client would re-implement the calendar window + aging math (leaks domain logic, fails AI-readiness) |
| C. Add a "walk by person" toggle to `SprintDailyDeltaPanel` | Reuses a panel | Different data shape (current-state vs delta), different mount point (Sprints view vs board); conflates two distinct lenses; couples two surfaces |
| D. Sprint-scoped `GET /sprints/{id}/standup/` | Mirrors `daily-delta` routing | Client must resolve the active sprint first; the walk is conceptually "this project's active-sprint standup" — project-scoped is friendlier and resolves the active sprint authoritatively |

## Consequences

- **Easier**: a Scrum Master runs the room person-by-person off TruePPM data;
  blocked + aging cards surface without hunting; the standup anchors to the Sprint
  Goal. Complements, rather than duplicates, the shipped delta feed.
- **Harder**: two standup lenses now coexist (delta feed on Sprints view, walk on
  the board). The web design must make their relationship legible (handled in
  ux-design) so a user understands "what changed" vs "walk by person".
- **Risks**: (1) the calendar-aware window is the correctness-critical path —
  covered by pytest boundary cases (Monday-includes-Friday, carried-task exclusion,
  DST). (2) ADR number collision: `0165` is in flight in another worktree; this ADR
  takes `0166` — re-verify at MR time. (3) `blocked_reason` leakage is guarded by
  construction (never serialized) and asserted in tests.

## Implementation Notes
- P3M layer: **Operations** (single-team ceremony)
- Affected packages: **api** (new read endpoint + `standup.py` service + serializer),
  **web** (new `useStandup` hook + board-mounted walk view with stepper)
- Migration required: **no** — every field exists (data-model audit confirmed
  zero new columns)
- API changes: **yes** — one new read-only action `GET /projects/{id}/standup/`;
  OpenAPI schema regenerated
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. Broker-down behaviour: **N/A** — pure read endpoint, zero async side effects, no
   dispatch.
2. Drain task: **N/A** — no async work enqueued.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **new function** `standup_walk(project, *, role)` in
   `projects/standup.py` (read-only aggregator, mirrors `board_activity.py`).
5. API response on best-effort dispatch: **N/A** — synchronous read; returns the
   assembled walk (200) or honest empty (`{"active": false, ...}`).
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A for writes** — the GET is naturally idempotent and
   side-effect-free; repeated calls return the same walk for the same `generated_at`
   inputs.
8. Dead-letter / failure handling: **N/A** — no task. A query error surfaces as a
   standard 5xx; the client retries via TanStack Query.
