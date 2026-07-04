# ADR-0206: Webhook Catalog Expansion — Risk, Baseline, Comment Events (amends ADR-0083)

## Status
Accepted

> Amends **ADR-0083** (Webhook Format Extension & CRUD Surface) — specifically the
> `OSS_WEBHOOK_EVENT_CAP` hard cap, most recently set to `14` by **ADR-0147** (the
> agile trio). ADR-0083 states that adding an event "requires its own ADR — this is
> the gate against per-customer event proliferation." This is that ADR, following
> ADR-0147's precedent for a first-party domain-event expansion.
>
> **ADR-number race note.** 0206 is reserved for #1082. Parallel worktrees may be
> claiming adjacent numbers; if 0206 collides at merge, renumber the later-merged
> ADR and repoint references — the standard renumber-at-merge drill.

## Context

After ADR-0147 the webhook catalog has 14 event types — all task, dependency,
schedule, project, and sprint. It has **zero** risk, baseline, or general comment
events. An external reporting or alerting tool (a risk dashboard, a compliance
feed, a Slack relay, a CI job) cannot observe when a risk is opened, escalates, or
is closed; when a plan baseline is captured; or when a comment lands on a task.
These are first-party domain surfaces that already exist in OSS but are invisible
to external tooling — the same API-first gap ADR-0147 closed for the sprint domain.

**P3M layer**: Programs and Projects — single-project, team-scoped events. **OSS.**
These are outbound, first-party domain events on the existing OSS webhook extension
point (ADR-0083 / ADR-0076 program fan-out). No ingest, no OAuth, no conflict
resolution → squarely OSS per the integration carve-out (ADR-0097, enterprise-check).

**Forces:**
1. **The cap is load-bearing.** ADR-0083 made the event count a deliberate gate;
   ADR-0147 raised it 11 → 14. Raising it again must preserve the
   per-customer-proliferation rationale — the cap rises only by *first-party* domain
   events shipped by TruePPM, never by custom/user-defined events (still Enterprise).
2. **Privacy conservatism for comments.** A comment body is user-authored free text
   that may carry sensitive context. A webhook consumer is external to the team, so
   `comment.created` must carry only metadata — never the body — mirroring the
   ADR-0104 "don't leak more than the event needs" posture. Unlike `sprint.closed`,
   none of these events carries a velocity/pulse signal, so the ADR-0104 privacy
   *gate* does not apply; the discipline is simply to omit the body.
3. **Transition semantics must be unambiguous.** `risk.escalated` and `risk.closed`
   fire on an *update*, so they must be defined against the pre-save value:
   escalation is a strict severity increase; closure is the transition *into* CLOSED
   (not RESOLVED, not any other terminal state).

## Decision

**1. Add five events, raise the cap 14 → 19.**

```python
RISK_OPENED = "risk.opened", "Risk Opened"
RISK_ESCALATED = "risk.escalated", "Risk Escalated"
RISK_CLOSED = "risk.closed", "Risk Closed"
BASELINE_CAPTURED = "baseline.captured", "Baseline Captured"
COMMENT_CREATED = "comment.created", "Comment Created"
# OSS_WEBHOOK_EVENT_CAP = 19  (was 14)
```

The cap rises only by these **first-party domain events**. The proliferation gate
(ADR-0083) targets *custom / user-defined* events — a customer cannot mint a 20th
event without another ADR. These five are domain events shipped by TruePPM, so the
Enterprise upsell line (custom event types, ingest hub) is unaffected.
`test_event_type_cap` is updated to assert
`len(ALL_WEBHOOK_EVENTS) == OSS_WEBHOOK_EVENT_CAP == 19` and to pin the exact
19-event set.

**2. Fire points — all via `dispatch_webhooks(project_id, event_type, payload)`
wrapped in `transaction.on_commit`, matching every existing event.** The payload is
built synchronously inside the request transaction (the row is loaded) and captured
by value, so the on-commit callback does no DB work — the same pattern as the
sprint events.

| Event | Fire point | Condition |
|-------|-----------|-----------|
| `risk.opened` | `RiskViewSet.perform_create` (alongside the `risk_created` board broadcast) | every create (new risks default to status OPEN) |
| `risk.escalated` | `RiskViewSet.perform_update` | computed severity (`probability × impact`) **increases** vs the pre-save value |
| `risk.closed` | `RiskViewSet.perform_update` | status transitions **into** CLOSED (old != CLOSED, new == CLOSED) |
| `baseline.captured` | `BaselineViewSet.perform_create` (alongside the `baseline_created` board broadcast) | every baseline capture |
| `comment.created` | `TaskCommentViewSet.perform_create` (alongside the `task_comment_created` board broadcast) | every comment |

`perform_update` captures old status + old probability + old impact **before**
`serializer.save()`, then compares after. A single update may emit **both**
`risk.escalated` and `risk.closed` (severity raised *and* moved to CLOSED in one
PATCH) — that is intentional and correct. `comment.created` fires for **every**
comment and is distinct from `task.mentioned`, which fires only when a comment
@mentions someone (the two can both fire for one comment).

**3. Payload shapes.**

`risk.opened` / `risk.escalated` / `risk.closed` (identical shape):
```json
{ "id", "project", "short_id", "title", "status",
  "probability", "impact", "severity",   // severity = probability × impact (computed)
  "category", "owner", "source": "..." }
```
Severity is computed, not stored (the model derives it at read time); it is included
so a consumer does not have to recompute it. None of these fields is a
team-performance signal, so no privacy gate applies.

`baseline.captured`:
```json
{ "id", "project", "name", "has_cpm_dates", "task_count",
  "created_by", "source": "..." }
```
Baseline name and dates are plan facts, not performance signals — not gated.

`comment.created` — **no body**:
```json
{ ...task payload (id, project, name, status, ...),
  "comment_id", "author", "author_display", "created_at", "source": "..." }
```
The comment **body is deliberately excluded** (Force 2). The event carries that a
comment was created, by whom, on which task, and when — never its content.

**4. No new privacy gate.** Unlike `sprint.closed` (ADR-0147), none of these five
events carries a velocity or pulse signal — risk severity/status, baseline
name/dates, and comment metadata are not team-performance signals. The ADR-0104
`velocity_shared_externally` gate is therefore **not** applied. The comment-body
omission is a payload-design choice, not a gated field.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Five first-party events, raise cap 14 → 19 (chosen)** | Matches ADR-0147 precedent; observable risk/baseline/comment domains; cap rationale intact | The cap becomes the new load-bearing line at 19 |
| B. Include the comment body in `comment.created` | Richer payload | Leaks user-authored content to an external consumer — Force 2 🔴 |
| C. Fire `risk.escalated` on any scoring-field change | Simpler | Fires on de-escalation and no-op edits — lies about "escalated" semantics |
| D. Reuse `task.updated` for comments / a generic `risk.updated` | No cap change | Consumers can't filter the specific domain transition; lies about semantics |
| E. Defer to Enterprise ingest hub | No OSS change | Risk/baseline/comment observability is table-stakes OSS reporting, not org governance (ADR-0097) |

## Consequences
- **Easier:** external risk dashboards, compliance feeds, and CI observe the risk
  register, baseline captures, and the comment thread; the OSS reporting story
  extends beyond agile with no ingest hub.
- **Harder:** the 19-event cap is the new load-bearing line; a 20th event needs an
  ADR. `risk.escalated` / `risk.closed` semantics are defined against the pre-save
  value, so a future refactor of `perform_update` must preserve the
  capture-before-save ordering.
- **Risks:** if a future contributor adds a comment payload field that echoes the
  body, or a risk payload field that is itself a gated signal, it leaks. Mitigated
  by the behavioral test asserting `comment.created` carries no `body`, and by
  keeping each payload in one builder.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (`apps/webhooks/models.py`, `apps/webhooks/migrations/`,
  `apps/projects/views.py`), docs (`features/webhooks.md`, `api/websockets.md`)
- Migration required: **yes** (choices-only `AlterField` on `webhook.events` and
  `webhookdelivery.event_type` — `webhooks/0008_risk_baseline_comment_events`;
  validation-only, no schema/data change. The enum members live in Django migration
  state, so adding choices requires a migration even though no column changes. The
  migration depends on the current squash leaf,
  `0001_squashed_0007_sprint_lifecycle_events`, since the pre-0.4 history was
  collapsed with `replaces=` per the migration-discipline squash.)
- API changes: yes — 5 new outbound webhook event types + payload contracts
- Dispatch: uses the existing `dispatch_webhooks()` (`apps/webhooks/dispatch.py`),
  which is event-type-agnostic — **no new service function**. The `_dispatch_webhooks`
  trampoline in `apps/projects/views.py` is reused unchanged.
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. **Broker-down behaviour:** reuses the existing webhook transactional outbox.
   `dispatch_webhooks()` writes `WebhookDelivery` rows in the same transaction, then
   best-effort `deliver_webhook.delay()`; the existing drain re-dispatches failures.
   No new dispatch path.
2. **Drain task:** reuses `webhooks.drain_webhook_queue` (Beat, every 30 s) — stranded
   PENDING `WebhookDelivery` rows are re-dispatched with matching semantics.
3. **Orphan window:** reuses the existing 5-minute webhook drain filter.
4. **Service layer:** outbound dispatch goes through `dispatch_webhooks()`, as all
   existing events do. No new service fn.
5. **API response on best-effort dispatch:** N/A — the user action returns its normal
   serializer synchronously; webhook fan-out is a post-commit side effect.
6. **Outbox cleanup:** reuses the ADR-0081 `_do_webhook_purge` retention purge.
7. **Idempotency:** each event fires only on the specific create/transition branch,
   inside `transaction.on_commit`, so a rolled-back write emits nothing and a
   committed one emits once per transition.
8. **Dead-letter / failure handling:** reuses `deliver_webhook`'s `max_retries` +
   exponential backoff + jitter; on exhaustion the `WebhookDelivery` row is marked
   FAILED (existing behaviour) and is visible in the delivery audit log.
