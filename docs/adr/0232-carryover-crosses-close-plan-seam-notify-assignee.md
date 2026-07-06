# ADR-0232: Carryover crosses the close→plan seam — notify the assignee + auto-advance

## Status
Accepted

## Context
At sprint close, `apply_carry_over` reassigns every incomplete task's `sprint`
FK to the destination (the next planned sprint or the backlog). The move is
audited (`SprintTaskOutcome`, ADR-0176) and broadcast to connected clients
(`tasks_bulk_mutated`), but it is **invisible to the person whose work moved**:

- A contributor's own in-progress task can have its `sprint_id` changed at close
  with zero signal to the assignee — work hops sprints over the weekend and
  nobody tells them (the load-bearing 🔴 for the Team Member persona, Priya, in
  the 2026-07-01 agile cross-surface VoC audit; 4/6 persona consensus, #1470).
- The `CloseSprintDialog` success path shows no summary of what was carried.
- After close the UI stays on the just-closed sprint tab, giving no indication
  the work moved anywhere.

This is the **notification + auto-advance** facet only. The read-only→actionable
carryover *preview* is tracked separately (#865 shipped, #871 open/0.5).

**P3M layer:** Programs and Projects (single project, sprint lifecycle) — OSS.

## Decision

**1. New notification event `task.moved_sprint` (in-app ON, email opt-in OFF).**
Add `NotificationEventType.TASK_MOVED_SPRINT = "task.moved_sprint"` and its two
`DEFAULT_PREFERENCES` rows (`in_app=True, email=False`). This is a routine
pattern-extension (ADR-0085): a `CharField` enum member + default-preference
rows, no schema/OpenAPI change. Email defaults OFF — Priya's hard-NO on un-opted
email — matching every other contributor-signal event (`task.blocked`,
`task.stale`, `project.deleted`).

**Why in-app inbox and not push.** ADR-0102 §6 deliberately withholds *push* for
pending-scope board mechanics — a contributor learns of scope injections
passively. Carryover is a different act: it is an actual reassignment of the
assignee's *committed* work across the close→plan seam, closer to `task.assigned`
(ADR-0085) than to a pending-acceptance injection. The durable in-app inbox row
threads both needles: it is not an interrupting push (honoring ADR-0102's
posture) and not un-opted email (honoring Priya's VoC blocker), yet it reaches
the assignee asynchronously — which is the whole point, since the close usually
happens outside the assignee's session.

**2. `notify_carryover_assignees` service** (mirrors `notify_milestone_forecast_shift`,
ADR-0106). Fired from `close_sprint` (`projects/tasks.py`) after
`apply_carry_over` returns the faithful `carried_task_ids` set (ADR-0176: the
same tasks recorded `CARRIED`). It groups the moved tasks by `assignee`
(excluding the actor who requested the close — they already know) and emits **one
inbox row per assignee**, not per task: an assignee with several carried tasks
gets a single summary row (Priya's noise hard-NO), the single-task case naming
and deep-linking that task, the multi-task case summarising the count. The body
names the **origin sprint** and the **destination** (the target sprint's name, or
"the backlog"); story points are never surfaced (ADR-0104 velocity privacy). The
whole batch is written with one preference lookup + one `bulk_create` via a new
`create_event_notifications_batch` (notifications/services.py — the shared gating
chokepoint, so the per-recipient in-app/email rules can't drift). The write is
deferred via `transaction.on_commit` and the deferred callback is itself wrapped
in try/except, so a notification failure is logged and swallowed — it can never
propagate out of the `on_commit` hook and mislead the already-committed close
into a FAILED status, nor strand or roll back the close.

Backlog moves are in scope: "work hops off my sprint with no signal" is equally
true when the destination is the backlog. `carry_over_to == "none"` moves nothing
(`apply_carry_over` returns `[]`) so fires no notification.

**3. Close-success toast + destination auto-advance** (`SprintsView.tsx`). On the
202-queued close (`handleConfirmClose` `onSuccess` — the same signal the #1471
retro-handoff banner already uses) fire a `toast.success` summarizing "N carried
to {destination}", and when the destination is a real sprint, auto-select it
(`setSelectedSprintId`) so the user lands where the work went. Complementary to
the retro-handoff banner, which offers a one-tap jump to the *closed* sprint's
retro — no conflict: land forward, retro is one tap back.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| In-app inbox row (chosen) | Async reach off-session; no un-opted email; not an interrupt push | Assignee must open the app to see it (acceptable — durable, not time-critical) |
| Push / un-opted email | Immediate | Violates Priya's VoC hard-NO and ADR-0102's no-surprise-push posture |
| Toast only, no per-assignee notification | Simplest | Only reaches whoever closed the sprint — misses the assignee entirely (the actual 🔴) |
| Wait for server-confirmed carried count before toast | Exact count | Adds WS plumbing; delays the confirmation seconds; the authoritative per-assignee signal is the backend notification, so the toast can be an immediate approximation |

## Consequences
- **Easier:** the close→plan seam is now visible to the people it affects; the
  notification subsystem gains a contributor signal with no new surface.
- **Harder:** one more event type in the Settings → Notifications matrix (lazy
  backfilled, no migration).
- **Risks:** the toast's carry-eligible count is computed client-side at confirm
  time (before the async close completes) so it can drift by tasks in a
  non-carried status (e.g. `ON_HOLD`); mitigated by counting only the four
  `_CARRY_OVER_INCOMPLETE_STATUSES`. The backend notification is exact.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api, web
- Migration required: **no** (new `NotificationEventType` is a choiceless
  `CharField` value; `DEFAULT_PREFERENCES` is lazy-backfilled per user)
- API changes: no new endpoint; the notification rides the existing inbox/feed
  and Settings → Notifications preference matrix
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A for a *new* async path — the notification is
   created synchronously (`create_event_notifications` writes inbox rows) inside
   a `transaction.on_commit` callback appended to the already-durable
   `close_sprint` drain task. Email delivery for the (default-OFF) email channel
   rides the existing `email_pending` notification-drain outbox unchanged.
2. Drain task: reuses the existing `close_sprint` Celery task and the existing
   notification email drain — no new drain. Semantics match: the close drain is
   already the transactional owner of every close-time side effect (rollup,
   reforecast digest, `tasks_bulk_mutated` broadcast).
3. Orphan window: N/A — no new outbox category; inbox rows are created post-commit.
4. Service layer: new `notify_carryover_assignees()` in `projects/services.py`,
   mirroring `notify_milestone_forecast_shift()`.
5. API response on best-effort dispatch: N/A — the close endpoint already returns
   `202 {"queued": true}`; this ADR adds no new endpoint.
6. Outbox cleanup: N/A — reuses the notification subsystem's existing retention.
7. Idempotency: `close_sprint` is idempotent (short-circuits on an already
   COMPLETED sprint before reaching carryover), so the notification block never
   runs twice for one close. A re-drain of an already-completed request returns
   before `apply_carry_over`, so no duplicate inbox rows.
8. Dead-letter / failure handling: the notify call is wrapped in a non-blocking
   try/except (mirroring the reforecast digest) — a notification failure logs and
   is swallowed so it can never fail or revert the sprint close.
