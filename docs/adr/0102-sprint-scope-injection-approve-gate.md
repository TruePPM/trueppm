# ADR-0102: Sprint Scope-Injection Approve-Gate (Pending-Acceptance State)

## Status
Accepted (2026-05-31) — the three 🔴 blocking questions resolved by Kelly on 2026-05-31: (1) pending tasks **show** in My Work with a muted chip; (2) sprint close **warns + offers carry-over** to the next sprint (no hard block); (3) ADR-0101 §5's scope-change write-path generalization is folded into the #881 implementation. Implementation may begin.

## Context

ADR-0101 shipped mid-sprint scope-injection as **notify-after**: any task linked to an
ACTIVE sprint after activation writes a `SprintScopeChange` row, the event surfaces on the
team-visible board banner / `SprintSection`, and the PO/SM is notified. That cured the
original 🔴 (silent injection). It did **not** stop an injected task from immediately
counting in commitment and burndown — `committed_points`, the burndown remaining line, and
the milestone rollup all reflect the new task the instant it is linked.

ADR-0101 §5 explicitly deferred the stronger form (Jordan's remaining 🟡): an injected task
should enter a **pending-acceptance** state — visible on the board but **excluded from
`committed_points`/burndown** — until the PO or SM **accepts** (joins it to the commitment)
or **rejects** (removes it from the sprint). This ADR designs that feature. It is filed
against **#881** (blocked-by #875) and is the deliberate, scoped follow-up ADR-0101 §5
promised.

**P3M layer**: Programs and Projects / Operations — single-project, team-scoped sprint
self-governance. **OSS** (consistent with ADR-0101's classification of the entire guardrail
stack as OSS). The accept/reject decision is team-owned and never crosses upward toward a
Portfolio/Senior-Leadership surface.

**VoC** (focused panel, avg 7.6/10, no hard-NO). Three findings this design must address:

1. **🔴 load-bearing — Enterprise back-door on accept (Morgan).** The accept/reject action
   must be **un-acceptable by any non-team actor**, including high-ordinal Enterprise roles,
   and inert to any externally-sourced / `guardrail_policy_resolving` policy. No org-admin /
   PMO role may force-accept or auto-accept. This must be enforced **in OSS core**, not
   delegated to the Enterprise consumer. Non-negotiable.
2. **🟡 Burndown/commitment math + forecast transparency (Jordan/Sarah).** Pending items must
   be excluded from `committed_points`/burndown **atomically**; the recompute moment on accept
   must be defined and ride the existing `sprint_scope_changed` recompute path; the UI must
   state forecasts are "accepted scope only."
3. **🟡 Assignee visibility + ceremony (Priya/Alex).** Decide whether a pending task shows in
   the contributor "My Work" view and with what non-jargon label; guarantee **no push
   notification** to the contributor; provide bulk + single-tap accept/reject; reject cleanly
   removes the task from the sprint and writes `history_change_reason`.

### Grounding in the actual code (verified 2026-05-31)

The research below is from reading the live code in this worktree, not from ADR prose.

1. **`SprintScopeChange` exists** (`models.py:2102`) as a plain `models.Model` (deliberately
   not a `VersionedModel` — not mobile-synced; display/audit metadata). It already carries
   `task`, `sprint`, `subtask_name`, `item_name` (property alias), `added_by`, `added_at`, and
   the ADR-0101 §5 `goal_impact` boolean. Rows are cleared on sprint close. The signal is
   still `subtask_sprint_scope_changed` (the §5 rename to `sprint_scope_changed` has not
   landed yet — see §"State of ADR-0101 implementation" below).

2. **VERIFICATION of ADR-0101's "a `status` column adds without a rewrite" claim — PARTIALLY
   TRUE, with a load-bearing caveat that this ADR must call out:**
   - *True for the model:* adding `status` to `SprintScopeChange` is a clean additive
     migration (a `TextChoices` CharField + index) — the model is a plain `models.Model` and
     nothing in it needs restructuring. The audit row half of the claim holds.
   - *False for the math:* the claim implies the commitment/burndown exclusion also rides on
     the audit row. It does **not**. `snapshot_committed_metrics` (`services.py:731`),
     `upsert_burndown_for_sprint` (`services.py:314`), and `compute_milestone_rollup_payload`
     (`services.py:763`) **all read `Task.objects.filter(sprint_id=...)` directly and never
     consult `SprintScopeChange` at all.** Therefore "exclude pending from commitment" is
     **not** a property of the audit row — it is a property of the *Task→sprint link*. A
     `status` on `SprintScopeChange` alone would be display-only and would not change a single
     point of math. The real design decision (see §1) is **where the pending flag lives so the
     three Task-querying math paths can exclude it**, and the honest answer is: on `Task`, not
     (only) on `SprintScopeChange`. ADR-0101's claim is corrected here.

3. **The math surfaces that must learn "exclude pending":**
   - `snapshot_committed_metrics` — runs once at activation; sums `story_points` over all
     non-deleted tasks in the sprint. (Injection is post-activation, so this is unaffected at
     activation time, but the recompute-on-accept path reuses the same summation shape.)
   - `upsert_burndown_for_sprint` — the live burndown UPSERT; sums `remaining_points` /
     `completed_points` / `scope_change_points` over `Task.objects.filter(sprint_id=...)`.
     This is the path that would *immediately* fold a pending task into the remaining line
     today.
   - `compute_milestone_rollup_payload` — its scope-change detection compares the current
     backlog-points sum against `committed_points`.

4. **RBAC** (`access/models.py:12`, ADR-0072): `Role` ordinals VIEWER=0, MEMBER=100,
   SCHEDULER=200, ADMIN=300, OWNER=400. There is **no PO or SM role in OSS** — "PO/SM" is an
   agile *hat*, not a stored role. The existing sprint-lifecycle actions (activate/close) gate
   on `role >= Role.ADMIN` (the PM/Scrum-Master persona). Accept/reject must reuse that same
   team-owned gate, **plus** the ADR-0101 team-ack inertness pattern so a high-ordinal custom
   Enterprise role cannot satisfy `role >= ADMIN` and force-accept (see §1).

5. **The sprint-sovereignty / team-ack pattern to extend** (ADR-0101 §3, `models.py:2291`
   `ProjectGuardrailPolicy.effective_level`): an EXTERNAL-sourced composition-block is
   *downgraded to inert* unless `acknowledged_by_team`. The gate is on an **explicit flag, not
   on role ordinal** — precisely because `role >= Role.OWNER` alone could be satisfied by an
   Enterprise custom role. This ADR extends the *same principle* to the accept action: accept
   authority is bound to project membership + the team-owned action gate, and is structurally
   unreachable by the `guardrail_policy_resolving` resolver.

6. **History** (ADR-0098): `sprint` and `wbs_path` are being added to the history diff set;
   guardrail mutations write `history_change_reason`. Reject (which clears `sprint`) must do
   the same so the timeline classifies it.

7. **Existing structured-error precedent**: `GuardrailBlockedError`, `MilestoneRollupLocked`,
   etc., each carry `{code, detail, suggested_action, ...}` mapped by the frontend. New errors
   in this ADR follow that pattern.

### State of ADR-0101 implementation (relevant because #881 is blocked-by #875)

ADR-0101's model layer is largely landed: `GuardrailRule`, `GuardrailLevel`,
`GuardrailPolicySource`, `ProjectGuardrailPolicy` (with `source`/`acknowledged_by_team`),
`SprintScopeChange.goal_impact`, and migration `0054` all exist. **Not yet landed:** the §5
signal rename (`subtask_sprint_scope_changed → sprint_scope_changed`), the service-layer
`record_sprint_scope_change()` helper, and generalization of the scope-change *write* beyond
the subtask path (`views.py:1800` still only writes a row when a subtask is spawned under a
parent that is already in an active sprint — the direct inline/drawer/API "assign existing
task to active sprint" write does not yet record a row). **This ADR assumes #875 lands those
§5 pieces first** and builds the pending state on top. The single write path
`record_sprint_scope_change()` is where this ADR sets `status=PENDING`.

## Decision

Add a **pending-acceptance state** to mid-sprint scope injection. A task linked to an ACTIVE
sprint after activation enters `pending`, is **excluded from commitment and burndown math**,
and is promoted into the commitment only when a team member with the sprint-lifecycle gate
**accepts** it, or removed from the sprint when they **reject** it. The gate is **team-owned
and management-inert** — this is what keeps it compatible with "warn never block."

### §1 — Where the pending flag lives (the load-bearing decision)

Because the three math paths query `Task`, not `SprintScopeChange` (verified above), the
authoritative pending flag lives on the **Task↔sprint relationship**, mirrored onto the audit
row for display:

- **`Task.sprint_pending` — `BooleanField(default=False, db_index=True)`** on `Task` (already
  a `VersionedModel`, so this rides sync to the 0.4 mobile client for free). Semantics:
  `True` ⇔ the task is linked to its sprint but **not yet accepted into the commitment**.
  Set `True` automatically when a task is linked to an ACTIVE sprint post-activation; set
  `False` on accept; the field is meaningless (and forced `False`) whenever `sprint_id` is
  null or the sprint is PLANNED (pre-activation links are part of the commitment baseline by
  definition — only *post-activation* injection is gated).
- **`SprintScopeChange.status` — `CharField(choices=ScopeChangeStatus, default=PENDING,
  db_index=True)`** with `PENDING | ACCEPTED | REJECTED`. This is the **audit/history**
  record of the decision (who, when, outcome). It is the clean additive column ADR-0101
  anticipated — but it is the *audit* of the decision, not the source of truth for the math.

Why both, not one: the math must be a cheap `WHERE` clause on the `Task` query
(`sprint_pending=False`), and `Task` is the synced entity the mobile client and board already
load — putting the flag there keeps the exclusion atomic with the task row and offline-evaluable
(ADR-0101's pure-function constraint). The `SprintScopeChange.status` column keeps the decision
auditable and team-readable after the fact (and survives task deletion via the denormalized
`item_name`). On accept, both flip in one transaction; they can never disagree because both
writes happen in the single service-layer function (§4).

**New enum** (pin via `ENUM_NAME_OVERRIDES` to avoid the drf-spectacular enum-name collision —
known regression, project memory):

```
class ScopeChangeStatus(models.TextChoices):
    PENDING  = "pending",  "Pending acceptance"
    ACCEPTED = "accepted", "Accepted into commitment"
    REJECTED = "rejected", "Rejected — removed from sprint"
```

### §2 — Commitment & burndown math: atomic exclusion of pending (resolves VoC 🟡 #2)

Every Task-querying math path adds `.exclude(sprint_pending=True)` (equivalently
`.filter(sprint_pending=False)`):

- **`upsert_burndown_for_sprint`** — the task query at `services.py:337` gains
  `sprint_pending=False`. A pending task therefore contributes **zero** to `remaining_points`,
  `completed_points`, and `scope_change_points`. The burndown line does not move when a task
  is injected; it moves only on accept.
- **`snapshot_committed_metrics`** — gains the same filter. (At activation there are no pending
  tasks, but the helper is also reused conceptually by the recompute-on-accept path, so the
  filter is added for correctness and symmetry.)
- **`compute_milestone_rollup_payload`** — its `current_points` scope-change probe and its
  live-COMPLETE count both exclude `sprint_pending=True`, so a pending injection neither
  inflates the denominator nor trips the `scope_changed` flag prematurely.

**The exact recompute moment** (VoC #2): the burndown/commitment recompute fires **on accept,
not on inject**. Accept is the event that joins the task to the commitment, so accept is the
event that:
1. sets `Task.sprint_pending = False` and `SprintScopeChange.status = ACCEPTED`,
2. inside `transaction.on_commit()`, **rides the existing `sprint_scope_changed` recompute
   path** (ADR-0101 Durable §1 — the same consumer that recomputes burndown on a scope change)
   by calling `upsert_burndown_for_sprint(sprint)`. Injection itself does **not** recompute
   (the task is excluded), so there is no flicker.

Reject sets `status = REJECTED`, clears `Task.sprint = NULL` (and forces `sprint_pending =
False`), and — because the task is leaving the sprint — also rides the same recompute on commit
(a no-op for the math since the pending task contributed nothing, but it refreshes the board
banner count). The `SprintScopeChange` row is retained with `status=REJECTED` for the audit
trail (it is cleared on sprint close like every other row).

**Forecast transparency**: any commitment/forecast surface that can have pending items behind
it (burndown header, capacity preflight, sprint detail) renders the copy **"Forecast reflects
accepted scope only — N items pending acceptance"** when `pending_count > 0`. This is a UI
contract, tracked for the frontend MR; the API supplies `pending_count` on the sprint payload
so the client never has to derive it (see §5).

### §3 — Accept/reject is team-owned and management-inert (resolves VoC 🔴 #1, the non-negotiable)

This is enforced in **OSS core**, layered so no single check is the only line of defense:

1. **Action gate (permission class).** `accept` and `reject` require
   `role >= Role.ADMIN` on the task's project — the same gate the sprint
   activate/close lifecycle actions use (the PM / Scrum-Master / PO team hat). MEMBER and below
   (the contributor — Priya) cannot accept their own injected work; SCHEDULER (resource
   manager) cannot either. This is checked object-level against the **project membership**, not
   a global role.

2. **Management-inertness (the back-door close).** Mirroring ADR-0101's team-ack pattern, the
   accept/reject endpoints are bound to an **actor who is a member of the task's project** and
   are **structurally unreachable by the `guardrail_policy_resolving` resolver** — the resolver
   supplies *policy*, never *actions*, and there is no signal, hook, or service entry point by
   which an external policy can call accept. Concretely, OSS enforces, in the service layer
   (`accept_scope_change`):
   - the actor must be a real authenticated `request.user` with a `ProjectMembership` row on
     the task's project at `role >= Role.ADMIN`; a request with no project membership (the only
     way an org-level/PMO principal could arrive) is rejected with
     `403 {"code": "scope_accept_forbidden", "detail": "Sprint scope acceptance is team-owned."}`
     **regardless of role ordinal** — so a high-ordinal Enterprise custom role (ADR-0072) that
     is *not* a project member cannot accept;
   - **no auto-accept path exists.** There is no policy level, no `ProjectGuardrailPolicy`
     field, and no signal receiver that can flip `status` to ACCEPTED. The *only* writer of
     `ACCEPTED`/`REJECTED` is the human-invoked service function behind the gated endpoints.
     This is asserted by an OSS test (§Testing) that imports the projects app and confirms no
     code path other than the two endpoints mutates `SprintScopeChange.status` away from
     `PENDING`.
   - **`guardrail_policy_resolving` is read-only for this feature.** A registered resolver may
     not set, default, or pre-accept scope-change status. The pending→accepted transition has
     no policy input at all (unlike the warn→block guardrail levels). This is stated as an
     invariant in the model docstring and the extension-point doc so Enterprise authors cannot
     mistake it for an extensible hook.

The three-layer result: even an org principal holding a custom role above OWNER **cannot**
force-accept, because (a) they will not have a project `ProjectMembership` row in the OSS
membership model, and (b) there is no non-human writer of the status field for any policy to
target. Sprint sovereignty is preserved at the OSS boundary, not delegated.

### §4 — Service layer & write paths

A single OSS service function owns every status transition (no bare `.delay()` / no
serializer-level mutation):

- **`record_sprint_scope_change(task, sprint, by, goal_impact)`** (the ADR-0101 §5 helper #875
  introduces) is extended to set `status=PENDING` and `task.sprint_pending=True` atomically
  when it records an injection into an ACTIVE sprint. Pre-activation links never call this
  (they are baseline commitment), so they are never pending.
- **`accept_scope_change(scope_change, by)`** — sets `status=ACCEPTED`, `task.sprint_pending=
  False`, writes `history_change_reason="scope accepted into sprint"`, and schedules
  `upsert_burndown_for_sprint(sprint)` + board broadcast on commit.
- **`reject_scope_change(scope_change, by)`** — sets `status=REJECTED`, clears `task.sprint`
  (→ removes from sprint) and `task.sprint_pending=False`, writes
  `history_change_reason="scope rejected — removed from sprint"`, schedules recompute + board
  broadcast on commit.

All three run inside the same DB transaction as their respective mutation; the recompute and
broadcast are deferred with `transaction.on_commit()`.

### §5 — API surface (API-first; every endpoint named)

**Accept / reject actions** (DRF `@action` on the sprint-scope-change surface; one item and a
bulk form so Alex/Priya get single-tap and batch — VoC #3):

| Method & path | Auth | Body | Response |
|---|---|---|---|
| `POST /api/v1/scope-changes/{id}/accept/` | `role >= ADMIN`, project member | — | `200` updated `SprintScopeChange` (`status=accepted`) + `sprint.pending_count` |
| `POST /api/v1/scope-changes/{id}/reject/` | `role >= ADMIN`, project member | — | `200` updated row (`status=rejected`) + `sprint.pending_count` |
| `POST /api/v1/sprints/{id}/scope-changes/accept/` | same | `{"ids": [uuid, …]}` (omit/empty = all pending in sprint) | `200 {"accepted": [...], "pending_count": N}` |
| `POST /api/v1/sprints/{id}/scope-changes/reject/` | same | `{"ids": [uuid, …]}` | `200 {"rejected": [...], "pending_count": N}` |

Responses are **synchronous `200`** (not `202 {"queued": true}`) — the status flip and the
`Task.sprint_pending` write are synchronous DB writes; only the burndown recompute + board
broadcast are deferred-on-commit and are fire-and-forget (no task id surfaced), matching
ADR-0101 §5's response shape.

**Queryset / serializer changes:**

- **`Task` model**: new `sprint_pending = BooleanField(default=False, db_index=True)`
  (synced — `server_version` bumps on accept/reject). `TaskSerializer` exposes it read-only as
  `sprint_pending` (camelCased `sprintPending` on the wire). It is **not** client-writable —
  the only way to change it is the accept/reject endpoints (so a contributor cannot self-accept
  by PATCHing the field).
- **`SprintScopeChange`**: new `status` field; `get_sprint_scope_changes` (`serializers.py:1111`)
  adds `"status": r.status` to each row dict (alongside the existing `item_name`, `goal_impact`,
  `added_by_name`, `added_at`).
- **`SprintSerializer`**: new read-only `pending_count = SerializerMethodField()` →
  `Task.objects.filter(sprint_id=obj.pk, sprint_pending=True, is_deleted=False).count()` (or an
  annotation on the sprint list queryset to avoid N+1 — see Performance). Drives the
  "N items pending acceptance" forecast-transparency copy.
- **Board / `My Work` queryset** (VoC #3 decision below) keys off `sprint_pending`.

**No new enum collisions** beyond pinning `ScopeChangeStatus` in `ENUM_NAME_OVERRIDES`.

### §6 — Contributor visibility & ceremony (resolves VoC 🟡 #3)

- **My Work**: a pending task **does show** in the assignee's "My Work" view (hiding assigned
  work from the person doing it is worse than showing it — Priya needs to see what is heading
  her way), but rendered with a **muted, non-jargon "Pending acceptance" chip** and visually
  de-emphasized (it is not yet committed work). The label is outcome-language, never "scope
  injection" / "pending-acceptance state machine." The board planning surface shows the same
  chip plus the existing scope-change banner.
- **No push notification to the contributor** — guaranteed structurally: the ADR-0101 §5
  notification targets PO/SM (audience configurable on `ProjectGuardrailPolicy`), and the
  pending state adds **no** new notification recipient. The contributor learns about it
  passively in My Work, never via push/email. (ADR-0101 §2's rule that guardrail/health UI
  never mounts in the `me` tree as a *push* stands; the My Work chip is a passive read-state,
  not a guardrail notice or notification.)
- **Bulk + single-tap**: provided by the four endpoints in §5 (per-item accept/reject for
  single-tap; sprint-level bulk for "accept all pending").
- **Reject cleanly removes from sprint**: `reject_scope_change` nulls `Task.sprint` and writes
  `history_change_reason` (ADR-0098), so the timeline shows "removed from sprint — scope
  rejected" rather than a bare "Updated" pill.

### §7 — Sprint close & lifecycle interaction

- **Close with pending items (decided: warn + carry-over, no hard block).** Closing a sprint
  that still has PENDING scope changes is **never blocked** — consistent with "warn never
  block" and sprint sovereignty (the team owns its own close). The close preflight surfaces
  "N items still pending acceptance" and offers to **carry them over to the next sprint**
  (default) or reject them; it does not force a decision and does not auto-discard. Carried-over
  pending tasks move to the incoming sprint still flagged `sprint_pending=True` (a fresh PENDING
  `SprintScopeChange` is recorded against the new sprint); rejected ones leave per §4. Because
  pending tasks were never in `committed_points`, the closing sprint's velocity snapshot is
  already correct regardless of the carry-over choice. Implementation: the close preflight
  returns a structured `scope_pending_on_close` advisory (not an error) with the pending list +
  a `carry_over` vs `reject` action; the carry-over write rides the existing
  `sprint_scope_changed` recompute path. No hard-block and no silent auto-reject variant ships.
- Existing behavior (rows cleared on close) is unchanged for ACCEPTED/REJECTED rows — they are
  display metadata and clear with the rest on close.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: pending flag on `Task` (`sprint_pending`) + `status` on `SprintScopeChange`, math excludes pending, team-owned accept/reject (chosen)** | Math is a cheap indexed `WHERE` on the entity the board/mobile already load; offline-evaluable; flag rides existing sync; audit row keeps the decision history; OSS-clean; back-door closed structurally | Two coupled fields to keep consistent (mitigated: single service writes both); touches three math paths |
| **B: status only on `SprintScopeChange`, math joins to it** | One field; matches ADR-0101's literal "status column" prose | The three math paths query `Task`, not the audit row — every one would need a subquery/join to a non-synced display model; pending state would not be offline-evaluable; couples sprint math to an audit table that is *deleted on close*. Rejected — contradicts the verified code. |
| **C: don't link the task to the sprint until accepted (staging table)** | Math needs no change (task isn't in the sprint yet) | The task is *not visible on the board* until accepted, which defeats "visible but uncommitted" — Jordan's whole requirement is that the team sees it pending. Rejected. |
| **D: accept gate on `role >= OWNER` only (no membership/inertness layer)** | Simplest RBAC | A high-ordinal Enterprise custom role satisfies `>= OWNER` and could force-accept — exactly the 🔴 back-door. Rejected. |
| **E: auto-accept after N hours if PO/SM doesn't act** | Less ceremony | Management-imposed-by-timer is a sprint-sovereignty violation in disguise; silently re-commits work the team never accepted. Rejected (violates warn-never-block). |

## Consequences

**Easier**: commitment and burndown become trustworthy mid-sprint — they reflect only what the
team accepted, so velocity/forecast (Jordan/Sarah) is no longer silently inflated by a drive-by
injection. Reject leaves a clean audit trail. The team has an explicit, low-ceremony accept gate
that is provably theirs.

**Harder**: a second consistency invariant (`Task.sprint_pending` ⇔
`SprintScopeChange.status==PENDING`) that must be written only through the service layer; three
math paths now carry a `sprint_pending=False` filter that future query authors must remember
(mitigated by a `Task.committed`-style manager helper — see Open Questions). Sprint close grows
a preflight check.

**Risks**: (1) **invariant drift** if any code links a task to an active sprint without going
through `record_sprint_scope_change` (it would be silently committed, not pending) — mitigated
by routing *all* sprint links through the service helper and a regression test. (2) **forgotten
filter**: a new aggregate that sums sprint points but forgets `sprint_pending=False` would
re-inflate — mitigated by a manager/queryset helper and a test asserting the three known paths
exclude pending. (3) **drf-spectacular enum collision** on `ScopeChangeStatus` — pin via
`ENUM_NAME_OVERRIDES` (project memory). (4) the My Work pending chip must not read as a
notification (Priya) — frontend-rule, tracked.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations (single-project, team-scoped).
- **Affected packages**: api (model fields, service functions, four `@action` endpoints,
  serializer fields, three math-path filters, close preflight), web (pending chip on
  board/My Work, accept/reject single + bulk affordance, "accepted scope only" forecast copy).
  No scheduler change. Mobile: `sprint_pending` rides sync for 0.4 reuse; pending tasks
  evaluate offline because the flag is on the synced `Task`.
- **Migration required**: **yes** — `Task.sprint_pending` (BooleanField, default False, indexed
  — safe additive, has a default so no NOT-NULL-without-default hazard) and
  `SprintScopeChange.status` (CharField, default `pending`, indexed). `Task` carries
  `HistoricalRecords`, so run `makemigrations` (never hand-write — both model and historical
  tables must get the column; project memory `feedback_historicalrecords_migrations`). Do
  **not** hard-code the migration number — at design time the projects-app counter is at 0054;
  it will move with concurrent work.
- **API changes**: yes — four accept/reject endpoints; `Task.sprint_pending` (read-only),
  `SprintScopeChange.status`, `Sprint.pending_count` serializer fields; new structured error
  `scope_accept_forbidden`; close preflight `scope_pending_on_close`. Regenerate OpenAPI
  **after merging origin/main** (`scripts/export-openapi.sh`); add `ENUM_NAME_OVERRIDES` for
  `ScopeChangeStatus`.
- **OSS or Enterprise**: **OSS** — the pending state, accept/reject, the math exclusion, and
  the team-ownership enforcement all live in OSS core. Enterprise may *observe* the existing
  scope-change signal for its audit trail, but the accept/reject decision and its
  management-inertness are OSS-enforced and have **no** policy/extension input (§3). OSS must
  never import `trueppm_enterprise`.
- **Coordinate with**: ADR-0101 (#875, parent — assumes its §5 `record_sprint_scope_change`
  helper + signal rename land first; this ADR is blocked-by #875) and ADR-0098 (#874 — write
  `history_change_reason` on reject so the removal is not a bare "Updated" pill).
- **Testing** (three-layer, same MR): pytest — accept promotes into commitment + recompute
  fires; reject removes from sprint + writes history; **a non-member high-ordinal actor is 403
  on accept (the 🔴 back-door test)**; no code path other than the two endpoints mutates status
  off PENDING; the three math paths exclude pending; close preflight blocks/force-rejects
  pending. vitest — pending chip render, "accepted scope only" copy gating on `pending_count`.
  Playwright — golden path (inject → board shows pending → PO accepts → burndown updates) + one
  reject path (inject → reject → task gone from sprint).

### Durable Execution
1. **Broker-down behaviour**: accept/reject are **synchronous DB writes** (status +
   `sprint_pending` flip) — no durability gap for the decision itself. The only async side
   effects are the burndown recompute and board broadcast, both deferred with
   `transaction.on_commit()`; the recompute rides the existing `sprint_scope_changed` path
   (ADR-0101 Durable §1), so a broker outage is covered by that path's existing outbox/retry.
2. **Drain task**: none new — reuses the existing burndown-recompute path and the existing
   board-broadcast channel. Semantics match (idempotent recompute, at-least-once broadcast).
3. **Orphan window**: N/A — the status writes are synchronous and committed before the
   on-commit recompute is scheduled; the recompute reuses the existing scope-change path's
   filtering.
4. **Service layer**: all three transitions go through `services.py` —
   `record_sprint_scope_change` (sets PENDING), `accept_scope_change`, `reject_scope_change`.
   No bare `.delay()` at the view/serializer; recompute scheduled via the existing helper inside
   `transaction.on_commit()`.
5. **API response on best-effort dispatch**: accept/reject return **synchronous `200`** with the
   updated row + `pending_count`; the recompute/broadcast are fire-and-forget (no task id),
   matching ADR-0101 §5.
6. **Outbox cleanup**: nothing new — reuses the existing burndown/notification outbox retention.
   `SprintScopeChange` rows (including ACCEPTED/REJECTED) are cleared on sprint close as today.
7. **Idempotency**: accept on an already-ACCEPTED row is a no-op (`status` guard +
   `select_for_update` on the row); reject on an already-REJECTED row likewise. Re-running the
   recompute is naturally idempotent (pure function of current task state). The status field is
   the idempotency key.
8. **Dead-letter / failure handling**: a failed recompute/broadcast falls to the existing
   burndown/broadcast failure handling (ADR-0084) — it never blocks or reverts the status
   decision, which is the durable record. A dropped broadcast self-heals on the next board load
   (the `sprint_pending` flag and `pending_count` are read from the DB, not the broadcast).
