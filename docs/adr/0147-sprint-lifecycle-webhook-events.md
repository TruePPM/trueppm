# ADR-0147: Sprint Lifecycle Webhook Events (amends ADR-0083)

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: SPRINT_ACTIVATED)

> Amends **ADR-0083** (Webhook Format Extension & CRUD Surface), specifically the
> `OSS_WEBHOOK_EVENT_CAP = 11` hard cap. ADR-0083 states that adding an event
> "requires its own ADR — this is the gate against per-customer event
> proliferation." This is that ADR.
>
> **ADR-number race note.** 0145 is claimed by #323/#379 (MR !694), 0146 by #1248 (MR !697); parallel
> worktrees may also be claiming numbers. If 0147 collides at merge, renumber the
> later-merged ADR and repoint references — the standard renumber-at-merge drill.

## Context

The webhook catalog has 11 event types (`apps/webhooks/models.py:13-36`) — all
task / dependency / schedule / project. There are **zero agile events**. An external
dashboard, Slack relay, or CI pipeline cannot observe a sprint activating, closing,
or accepting an injected scope item. For the 0.3 "Agile Team" release the sprint
sovereignty story (ADR-0102 scope gate, ADR-0104 signal privacy) is invisible to
external tooling — the top API-first gap from the 2026-06-10 product audit (§4.1).

**P3M layer**: Programs and Projects — single-project, team-scoped events. **OSS.**
These are outbound, first-party domain events on the existing OSS webhook extension
point (ADR-0083 / ADR-0076 program fan-out). No ingest, no OAuth, no conflict
resolution → squarely OSS per the integration carve-out (ADR-0097, enterprise-check).

**Forces:**
1. **Velocity-transparency tension (VoC 🔴→🟡, Morgan vs. Marcus).** `sprint.closed`
   naturally carries a completion snapshot (`completed_points`, `completed_task_count`)
   — that *is* team velocity. Shipping it raw over a webhook is an automatic
   velocity→external pipeline, Morgan's hard-NO ("velocity auto-exposed as a
   productivity metric"). The payload must honor ADR-0104 signal-privacy.
2. **Sprint-sovereignty consistency.** `sprint.scope_changed` must fire on the
   ADR-0102 *approve* gate (scope **accepted**), never on a raw injection — otherwise
   the event contradicts the sovereignty story it advertises.
3. **The cap is load-bearing.** ADR-0083 made 11 a deliberate gate. Raising it must
   preserve the per-customer-proliferation rationale.

## Decision

**1. Add three events, raise the cap 11 → 14.**

```python
SPRINT_ACTIVATED = "sprint.activated", "Sprint Activated"
SPRINT_CLOSED = "sprint.closed", "Sprint Closed"
SPRINT_SCOPE_CHANGED = "sprint.scope_changed", "Sprint Scope Changed"
# OSS_WEBHOOK_EVENT_CAP = 14  (was 11)
```

The cap rises only by the **first-party agile trio**. The proliferation gate
(ADR-0083) targets *custom / user-defined* events — a customer cannot mint a 15th
event without another ADR. These three are domain events shipped by TruePPM, so the
Enterprise upsell line (custom event types, ingest hub) is unaffected. `test_event_type_cap`
is updated to assert `len(ALL_WEBHOOK_EVENTS) == OSS_WEBHOOK_EVENT_CAP == 14` and to
pin the exact 14-event set.

**2. Fire points — all via `dispatch_webhooks(project_id, event_type, payload)`
wrapped in `transaction.on_commit`, matching existing task events.**

| Event | Fire point | Timing |
|-------|-----------|--------|
| `sprint.activated` | `SprintViewSet.activate` (after state→ACTIVE, alongside the existing `sprint_activated` board broadcast) | synchronous request |
| `sprint.closed` | `close_sprint` Celery task (after state→COMPLETED + `snapshot_completed_metrics`) | async outbox (already idempotent) |
| `sprint.scope_changed` | the SprintScopeChange **accept** action (only on transition to `ACCEPTED`, ADR-0102) | synchronous request |

`sprint.scope_changed` does **not** fire on injection (`record_sprint_scope_change`,
PENDING) or on reject — only on accept, per Force 2.

**3. Payload shapes.**

`sprint.activated`:
```json
{ "id", "project", "name", "goal", "state": "active",
  "start_date", "finish_date", "activated_at",
  "committed_points", "committed_task_count", "source": "..." }
```
Commitment (`committed_*`) is the *plan the team published when it pulled work in* —
not a performance metric — so it is not gated.

`sprint.closed` — completion snapshot is **velocity**, gated:
```json
{ "id", "project", "name", "goal", "state": "completed",
  "start_date", "finish_date", "activated_at", "closed_at",
  "committed_points", "committed_task_count",
  "completed_points": <int|null>, "completed_task_count": <int|null>,
  "goal_outcome": <str|null>, "velocity_suppressed": <bool>, "source": "..." }
```

`sprint.scope_changed`:
```json
{ "id" (scope-change id), "sprint", "project", "task", "item_name",
  "status": "accepted", "goal_impact": <bool>, "accepted_at", "source": "..." }
```

**4. Velocity privacy gate (resolves Force 1).**

A webhook consumer is **external** — it has no `ProjectMembership` and therefore no
ladder tier (`requester_signal_tier` → `None`, which the read gate denies). Reusing
the *reader* gate verbatim would suppress velocity for **every** webhook, defeating
the legitimate "share our cadence to our own dashboard" use case. Instead we map a
webhook to the single explicit **outward-share** rung already defined by ADR-0104:

> `completed_points` / `completed_task_count` / `goal_outcome` are included **iff the
> project's `velocity` signal audience is `PROGRAM_SHARED`** — the one rung a team
> reaches only by deliberately raising the ceiling and audience to share the signal
> beyond itself. Otherwise the fields are `null` and `velocity_suppressed: true`.

This is exactly the semantics of `get_shared_team_signals()` (request-free, correct
for a no-requester context). A new thin helper
`signal_privacy_services.velocity_shared_externally(project) -> bool` encapsulates the
`audience_of("velocity") == PROGRAM_SHARED` check so the rule lives in one place
beside the existing suppression helpers. The suppressed shape mirrors
`suppress_velocity_summary` ("suppress, don't 403" — keep keys, null values, set the
`*_suppressed` marker) so consumers keep a stable contract.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. PROGRAM_SHARED gate on `velocity` (chosen)** | Reuses ADR-0104's one outward rung; team opts in once; one helper | Teams must raise the ceiling to get velocity in their own webhook |
| B. Always include completed_* | Simplest | Automatic velocity→external pipeline — Morgan 🔴 |
| C. Always suppress completed_* on webhooks | Safe | Kills the legitimate cadence-dashboard use case; webhook becomes low-value |
| D. New per-webhook "include velocity" flag | Granular | New config surface + a second privacy authority competing with ADR-0104 — drift risk |
| E. Don't raise the cap; reuse `schedule.recalculated` | No cap change | Lies about semantics; consumers can't filter sprint events |

## Consequences
- **Easier:** external dashboards/Slack/CI observe the full sprint lifecycle; the
  sovereignty story becomes API-visible; one consistent privacy authority (ADR-0104)
  now also governs webhook payloads.
- **Harder:** the 14-event cap is the new load-bearing line; a 15th event needs an ADR.
  Velocity in a webhook now depends on a team's ADR-0104 posture — documented in
  `docs/api/`.
- **Risks:** if a future contributor adds a sprint payload field that is itself a
  gated signal (e.g. a pulse score) without routing it through the privacy helper, it
  leaks. Mitigated by a regression test asserting `velocity_suppressed` toggles with
  the policy, and by keeping the gated fields in one builder.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (`apps/webhooks/models.py`, `apps/projects/views.py`,
  `apps/projects/tasks.py`, `apps/projects/signal_privacy_services.py`), docs/api
- Migration required: **yes** (choices-only `AlterField` on `webhook.events` and
  `webhookdelivery.event_type` — `webhooks/0007_sprint_lifecycle_events`; validation-only,
  no schema/data change. The enum members live in Django migration state, so adding
  choices requires a migration even though no column changes.)
- API changes: yes — 3 new outbound webhook event types + payload contracts
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. **Broker-down behaviour:** reuses the existing webhook transactional outbox.
   `dispatch_webhooks()` writes `WebhookDelivery` rows in the same transaction, then
   best-effort `deliver_webhook.delay()`; the existing drain re-dispatches failures.
   No new dispatch path.
2. **Drain task:** reuses `webhooks.drain_webhook_queue` (Beat, every 30 s,
   `@idempotent_task(on_contention="skip")`) — semantics match exactly (stranded
   PENDING `WebhookDelivery` rows).
3. **Orphan window:** reuses the existing 5-minute webhook drain filter — deliveries
   created inside an open `on_commit` are left alone until the window passes.
4. **Service layer:** outbound dispatch goes through `dispatch_webhooks()`
   (`apps/webhooks/dispatch.py`), as all existing events do. No new service fn.
5. **API response on best-effort dispatch:** N/A for `sprint.activated` /
   `sprint.scope_changed` (the user action returns its normal sprint/scope-change
   serializer synchronously; webhook fan-out is a post-commit side effect).
   `sprint.closed` rides the existing `202 {"queued": true}` close flow.
6. **Outbox cleanup:** reuses the ADR-0081 `_do_webhook_purge` retention purge — no
   new retention policy.
7. **Idempotency:** `sprint.closed` fires inside `close_sprint`, which short-circuits
   before the state change if the sprint/request is already COMPLETED, so the event
   fires at most once. `sprint.activated` / `sprint.scope_changed` fire only on the
   state-transition branch (guarded by the existing "already active / already
   accepted" early returns), so a duplicate request does not re-fire.
8. **Dead-letter / failure handling:** reuses `deliver_webhook`'s `max_retries` +
   exponential backoff + jitter; on exhaustion the `WebhookDelivery` row is marked
   FAILED (existing behaviour) and is visible in the delivery audit log.
