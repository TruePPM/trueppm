# ADR-0124: Blocker end-to-end — structured fields, impediment-clearer routing, off-device email, standup reconciliation

## Status
Accepted (2026-06-12 — all 🔴 resolved: standup pivots to the blocked-flag; email now / push 0.4; SM+PM both notified, preference-gated)

## Context

MR !574 (the contributor-retention layer, ADR-0122) shipped only the **reason-only**
blocker: `Task.blocked_reason: TextField` where non-empty ⇔ blocked, and a `task.blocked`
in-app notification fired **to the assignee only**. The VoC audit of !574 (2026-06-11)
found that this closes none of the loop that matters:

- **#1135** — a free-text reason is "a sticky note with no address." Alex/Sarah can't
  triage or sort; there is no link to the blocking work, no age, no actor.
- **#1134** — the `task.blocked` notification reaches only the assignee, *who already
  knows*. The Scrum Master (whose literal job is removing impediments) and the PM (who
  owns the schedule) are never told. There is no "blocked on my projects" roll-up.
  Raised by **Alex 🔴 and Sarah 🔴 — the strongest signal in the audit.**
- **#1136** — `task.blocked` is in-app only. Priya won't open the app mid-sprint; Sarah
  is on a job site 3 days/week. The notification system is inert off-device for exactly
  the two people it most needs to reach. **Priya 🔴, Sarah 🔴.**
- **#1125** — the standup daily-delta (ADR-0121) defines a "blocker" as *any* transition
  into `ON_HOLD`, conflating blocked / deprioritized / waiting-on-review / PM-parked.
  Morgan: teams will either misuse `On hold` to dodge the label or stop trusting the
  panel — data quality rots.

**The critical constraint (Morgan 🟡, conditional hard-NO — a sprint-sovereignty /
surveillance boundary):** the free-text blocker **reason** is contributor voice and must
NOT become a filterable/queryable PM-RBAC surveillance field.

### P3M layer
**Programs and Projects** (OSS). This is single-project task data and project-scoped
notification routing. The SM/PM roll-up aggregates *within a project / within a sprint* —
not across programs — so it stays OSS. A cross-program "blocked across my portfolio"
roll-up would be Enterprise; this ADR explicitly does not build that.

### Prior art (from research)
- **ADR-0122** owns `blocked_reason`, the `task.blocked` event type, and the signal-only
  preset (`SIGNAL_ONLY_EVENTS = {task.blocked, task.due_date_changed}`). Accepted, additive.
- **ADR-0121** (Proposed) computes the standup "new blockers" from `HistoricalTask`
  transitions into `TaskStatus.ON_HOLD` — but `ON_HOLD` is **legacy/deprecated** ("New
  tasks should never be set to ON_HOLD", migrated to BACKLOG in migration 0020). This is
  the mismatch #1125 surfaces.
- **ADR-0085** (Accepted, shipped): `create_event_notifications(...)` deferred via
  `transaction.on_commit`, plus a live **email** drain (`drain_notification_emails`,
  every 30s). Email defaults OFF per event. **No push/FCM/APNs delivery exists** —
  `mobile_push`/`slack` channels are dead UI toggles.
- **ADR-0078** defines `TeamMembership.is_scrum_master` / `is_product_owner` facets, but
  **no recipient resolver consumes them** today. `access/groups.py::resolve_group_members`
  resolves `@admins`/`@scrum-team` etc., but `@scrum-team` = active-sprint assignees, NOT
  the SM person.
- **ADR-0104** (Proposed): the team-signal privacy ladder — status-level signals are
  team-visible; reader-gated by audience tier. Consistent with showing blocked *status*
  to the team while keeping reason text private.

## Decision

Ship the blocker loop as **additive fields on `Task` + recipient-resolution expansion +
an opt-in email channel + a standup reconciliation** — **no new entity**, honoring
#1125's "smallest step toward an impediment model." This is a **new ADR building on
ADR-0122**, not an amendment: it introduces a structured model, a new SM/PM resolver, a
new off-device delivery decision, and a privacy boundary that together exceed the scope
of patching an Accepted ADR. (Decision (a) resolved: **new ADR-0124**, referencing 0122.)

### The organizing principle: type is shareable, reason is private

| Signal | Visibility | Queryable / routable | Purpose |
|---|---|---|---|
| `blocker_type` (enum) | team (roll-ups, notifications) | **yes** | triage signal — "3 waiting on external vendor → one call" |
| `blocking_task` (soft link) | team | yes | route the unblock |
| `blocked_since` / age | team | yes | escalation + burnout signal |
| `blocked_by` (actor) | team (per ADR-0121 precedent) | yes | who raised it |
| **`blocked_reason` (free text)** | **assignee + @-mentioned only** | **never** | contributor voice |

This split is what satisfies Morgan: the structured **type** carries the triage signal
the SM/PM need, while the free-text **reason** stays contributor-private. Notifications
and roll-ups carry type/age/link; they never carry the reason text.

### 1. Structured fields (#1135) — additive on `Task`

```python
class BlockerType(models.TextChoices):
    DEPENDENCY      = "dependency", "Waiting on dependency"
    RESOURCE        = "resource",   "Missing resource"
    VENDOR          = "vendor",     "External vendor"
    DECISION        = "decision",   "Decision needed"
    OTHER           = "other",      "Other"

# on Task (all nullable / defaulted — migration-safe on a populated table):
blocker_type  = CharField(max_length=12, choices=BlockerType.choices, blank=True, default="")
blocking_task = ForeignKey("self", on_delete=SET_NULL, null=True, blank=True,
                           related_name="blocking")   # SOFT link — NOT a CPM edge
blocked_since = DateTimeField(null=True, blank=True)  # auto-stamped in save()
blocked_by    = ForeignKey(AUTH_USER_MODEL, on_delete=SET_NULL, null=True, blank=True,
                           related_name="+")
```

- **`blocking_task` is deliberately NOT a `Dependency`.** `Dependency` is a hard CPM edge
  feeding float/dates/Monte Carlo. A soft "waiting on" link must never enter CPM input
  (it would corrupt schedule math — same reason `is_recurring`/EPIC are excluded). Self-FK
  precedent: `Task.parent_epic`.
- **`blocked_since` is derived, stamped in `Task.save()`** mirroring the existing
  `status_changed_at` pattern: set on the empty→non-empty `blocked_reason` transition,
  cleared (→ null) on non-empty→empty. The flag-of-record stays `blocked_reason` non-empty
  (ADR-0122 contract preserved); type/link/since/by are optional structured context.
- **`blocked_by` is a new actor column on `Task`** (Task has no `created_by` today). Set
  to `request.user` on the flag transition. Justified over reading `HistoricalTask`
  because the roll-up needs it in one indexed query.
- Fields ride `VersionedModel.save()` `server_version` sync for free → mobile delta gets
  them automatically. **Migration `projects/0076_…` (next free; verify vs origin/main
  before push — Wave-4/5 branches have migrations in flight, renumber if a 0076 lands first).**

### 2. Impediment-clearer routing (#1134)

- **New resolver** `resolve_impediment_recipients(task)` bridging project→team→facet:
  returns assignee (existing) **+** the SM (`TeamMembership.is_scrum_master` on the team(s)
  linked to the task's sprint/project) **+** the PM (project `Role.ADMIN`). Built next to
  `access/groups.py::resolve_group_members`; reuses the facet defined in ADR-0078.
- **The notification to SM/PM carries type + age + link, NEVER the reason text.** The
  pre-rendered `subject`/`body` read: *"Task X flagged blocked — External vendor · 2d."*
  This is the privacy boundary enforced at the point of render, not just at the serializer.
- **Reuse the `task.blocked` event type** (no new event, no notifications migration). The
  only change is recipient set: assignee + SM + PM instead of assignee-only. Each recipient
  is still gated by their own `NotificationPreference` (SM/PM who muted task.blocked don't
  get it).
- **Roll-up surfaces (pure reads):**
  - `GET /api/v1/projects/{id}/blocked/` — "blocked on my projects" for PM, grouped by team.
  - `GET /api/v1/sprints/{id}/blocked/` — sprint-scoped impediment list for SM.
  - Both return **status + type + age + assignee + blocking_task**, grouped by team.
    **Reason text is included per-row only when the requester is the assignee or
    @-mentioned on that task** (field-level gate, see §4). Filtering/sorting is exposed on
    type / age / status — **never on reason**.
- **Designated-impediment-owner: DEFERRED** (follow-up issue). 0.3 routes to the SM facet
  + PM; a configurable owner is additional surface not needed for the wedge.

### 3. Off-device delivery (#1136) — email now, push deferred

- **0.3 ships an opt-in EMAIL channel for `task.blocked` only** (+ `task.due_date_changed`,
  already the signal-only set). Email infra is live (`drain_notification_emails`); this is
  a default-flip + a narrow preset, not new infrastructure. The `task.blocked` email
  default stays OFF; the **signal-only preset** is extended so opting into it turns email
  ON for these two events specifically — the one interruption both personas asked for.
- **True push (FCM/APNs/web-push) is DEFERRED to 0.4** (#1100 mobile/offline). Building a
  device-token registry + push gateway from scratch is out of scope for a 0.3 polish wave
  and would reopen the notification-spam surface. The issue (#1136) is satisfied for 0.3
  by email; push is explicitly a follow-up. **(Decision (e) resolved.)**
- Morgan's caveat honored: scope stays `{task.blocked, due_date_changed}` — no broad blasts.

### 4. Standup reconciliation (#1125) — read the flag, not the deprecated status

- **Reconcile ADR-0121's "new blockers" to read the explicit `blocked_reason` transition**
  (empty→non-empty) instead of `ON_HOLD` transitions. `ON_HOLD` is deprecated; the
  `blocked_reason` flag is the human signal of record. This eliminates #1125's
  conflation at the source — a blocked flag is intentional, a status move is not.
- The standup splits the label using the new structure: **"N impediment"** (tasks with a
  blocked flag, shown with `blocker_type` + age) vs **"M paused"** (tasks moved to
  BACKLOG/ON_HOLD with no blocker flag). This is exactly #1125's "impediment (reason
  recorded) vs paused (no reason)" — delivered by the type field, with **no separate
  on-hold reason field** (one reason field, surfaced two ways).
- **Reason text in the standup follows the same gate**: the shared standup screen shows
  type + age + actor (team-visible per ADR-0121); the free-text reason is shown only to
  the assignee + @-mentioned. Priya's friction ("'Priya — 1 blocked' with no way to record
  why") is answered by the type enum she sets, visible to all, with her free-text reason
  staying her voice.
- **(Decision (b) resolved: fields on Task, no Impediment entity; (c) SM via facet + PM,
  designated-owner deferred; (d) reason-privacy enforced at serializer field-level AND at
  notification render.)**

### Reason-privacy enforcement (§4 detail, the Morgan boundary)
- `TaskSerializer.blocked_reason` becomes a gated field: a `get_fields`/`to_representation`
  rule strips `blocked_reason` to `""` (or omits it) unless `request.user` is the assignee
  or is @-mentioned on the task. (Task currently has NO per-field serializer gating — this
  is the new pattern this ADR introduces; it must be covered by tests.)
- The roll-up endpoints and the standup serializer apply the **same** per-row gate.
- No endpoint accepts `blocked_reason` as a filter/order/search param. CI/security-review
  must confirm there is no queryable path to reason text for non-assignee/non-mentioned.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **New `Impediment` entity** (FK to Task, own lifecycle) | clean separation; room for SLA/owner | new model + migration + sync wiring + serializer surface; #1125 explicitly says "no new entity"; over-built for 0.3 |
| **Fields on Task (chosen)** | additive; rides server_version; reuses task.blocked + email infra; smallest step | Task gains 4 fields + first per-field gate; standup query reconciled |
| **Notify SM/PM with full reason text** | one render path | violates Morgan's hard-NO — reason leaks to PM via notification body |
| **Type+age in notification, reason private (chosen)** | satisfies Morgan; type is the triage signal anyway | two-tier render; must be enforced at render not just serializer |
| **Build FCM push in 0.3** | true off-device for Sarah/Priya | greenfield device-registry + gateway; reopens spam surface; 0.4 mobile owns it |
| **Opt-in email in 0.3, push in 0.4 (chosen)** | reuses live email drain; narrow scope | Sarah/Priya get email not push until 0.4 |
| **Keep standup on ON_HOLD** | no change | perpetuates the conflation #1125 filed; reads a deprecated status |
| **Standup reads blocked_reason flag (chosen)** | accurate; intentional signal; delivers #1125's split for free | standup service query change + HistoricalTask must capture blocked_reason (it does — in history since 0074) |

## Consequences

**Easier:** Alex/Sarah see impediments routed to them with a triageable type and an age,
without polling boards. The standup stops crying wolf. Sarah gets blocked email off-device.
The type enum gives triage without exposing private reason text.

**Harder:** Task gains its first per-field serializer visibility gate — every serializer
and the two roll-up endpoints + the standup must apply it consistently (test burden, and a
security-review focus). The SM-resolver bridges project→team→facet, a path that didn't
exist. The standup query moves from a status transition to a field transition (must verify
`HistoricalTask` carries `blocked_reason` — it does, since migration 0074).

**Risks:**
- *Reason leak* — the highest risk. Any serializer, roll-up, notification body, standup
  row, or filter param that exposes reason text to a non-assignee/non-mentioned user breaks
  Morgan's constraint. Mitigation: single gated source-of-truth helper, applied everywhere;
  explicit security-review + rbac-check; a test that asserts a PM cannot read reason text
  via any of the new surfaces.
- *Migration collision* — `projects/0076` may race Wave-4/5 branches; renumber whichever
  merges second (repo convention).
- *drf-spectacular enum collision* — new `BlockerType` enum may clash; pin via
  `ENUM_NAME_OVERRIDES` if `schema-drift` flags "Removed schemas".
- *SM-facet emptiness* — if a project has no team / no SM facet set, the resolver falls
  back to PM (Role.ADMIN) only; document that blockers still reach *someone* who can act.

## Implementation Notes
- P3M layer: **Programs and Projects** (OSS)
- Affected packages: **api, web** (mobile gets fields via sync; push deferred to 0.4)
- Migration required: **yes** — `projects/0076_…` (4 additive nullable/defaulted fields on
  Task + HistoricalTask). No notifications migration (reuses `task.blocked`).
- API changes: **yes** — Task serializer gains structured fields + reason-gate; two new
  read-only roll-up endpoints (`/projects/{id}/blocked/`, `/sprints/{id}/blocked/`);
  signal-only preset extended to flip email ON for the two signal events; standup serializer
  splits impediment/paused.
- OSS or Enterprise: **OSS** (within-project routing; cross-program roll-up would be Enterprise)

### Durable Execution
1. **Broker-down behaviour:** No new async dispatch. The `task.blocked` notification
   already routes through `create_event_notifications` deferred via
   `transaction.on_commit` (ADR-0085); expanding the recipient set does not change the
   dispatch path. `blocked_since` is stamped synchronously in `Task.save()`. Roll-up
   endpoints are pure synchronous reads. **No outbox row needed** — the existing
   notification path already commits the in-app rows in the same transaction and only the
   email send is async (drained).
2. **Drain task:** Reuses the existing `drain_notification_emails` Beat task (every 30s).
   No new drain — email semantics are identical to ADR-0085; only the recipient set and the
   preset default differ.
3. **Orphan window:** N/A for in-app (same-transaction insert). Email drain's existing
   window (`email_pending` + attempts state machine) is unchanged.
4. **Service layer:** Notification dispatch stays in `notifications/services.py::
   create_event_notifications`. New helper `access/groups.py (or a sibling)::
   resolve_impediment_recipients(task)` for recipient resolution. No CPM involvement
   (soft `blocking_task` link is excluded from the scheduler).
5. **API response on best-effort dispatch:** N/A — the `PATCH /tasks/{id}/` that sets the
   blocker returns the updated Task synchronously (in-app notifications committed in-band,
   email queued by the existing drain). No 202/queued response introduced.
6. **Outbox cleanup:** N/A — no new outbox category. Existing notification/email retention
   is unchanged.
7. **Idempotency:** The blocker flag transition is detected by comparing prior vs new
   `blocked_reason` emptiness (same guard the `task.blocked` notification already uses at
   `views.py:2501`). Re-saving an already-blocked task with an unchanged reason does NOT
   re-stamp `blocked_since`, re-fire the notification, or re-route — the empty→non-empty
   edge is the idempotency key. `blocked_since` is only set when transitioning from null.
8. **Dead-letter / failure handling:** Inherits the email drain's existing
   `email_attempts` retry + failure state (`email_failed_at`). In-app notification creation
   is in-transaction; a failed transaction rolls back the flag and the notification together
   (no partial state). No new DLQ.

## Resolved decisions (2026-06-12)
1. **Standup reinterpretation (#1125): PIVOT confirmed.** The standup "new blockers" reads
   the `blocked_reason`-flag transition (empty→non-empty); the "impediment vs paused" split
   is delivered via `blocker_type` — no separate on-hold reason field. ON_HOLD is no longer
   the trigger.
2. **Push deferral (#1136): EMAIL now, push 0.4.** 0.3 ships opt-in email for `task.blocked`
   (+ due-date-changed) reusing the live email drain; true push (FCM/APNs) defers to
   0.4/#1100. The issue is satisfied for 0.3 by email.
3. **PM routing (#1134): notify SM + PM, preference-gated.** Blocked notifications route to
   assignee + resolved SM facet + PM (Role.ADMIN). Sarah (PM, 🔴) explicitly wants the
   off-device nudge; the notification carries type + age only (never reason text) and is
   `NotificationPreference`-gated so a PM on a noisy project can mute it.
