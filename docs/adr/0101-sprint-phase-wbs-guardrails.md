# ADR-0101: Sprint / Phase / WBS Guardrails

## Status
Proposed

## Context

In the TruePPM data model, sprint membership and WBS hierarchy are **orthogonal**: a
`Task` carries a nullable `sprint` FK (`models.py`, `ForeignKey("Sprint", SET_NULL,
null=True)`) *and* a `wbs_path` (`LtreeField`, e.g. `"1.2.3"`). A "phase" is not a model
— it is a WBS L1 root task (`wbs_path` matching `^\d+$`, exposed via `PhaseSerializer` /
`PhaseViewSet`). Nothing prevents a single task from being a child of a phase *and*
assigned to a sprint at the same time, which is correct and intentional: it is what makes
the hybrid waterfall/agile bridge work (a task lives in a phase on the schedule and is
pulled into a sprint for execution).

The flexibility is a feature. The risk is that the *same* flexibility lets through states
that are legal but almost always mistakes — a summary/phase task assigned to a sprint
(double-counts velocity and capacity), a task slotted into Sprint 5 but scheduled for
August, a recurring task pulled into a sprint. Today these pass silently: `TaskSerializer.
validate()` enforces only the milestone invariant, same-project sprint ownership, the
progress-anchor gate, the milestone-rollup lock, and the project-start floor — none of the
above. The goal is to keep the model **extremely flexible** while adding governance so
mistakes are not *easily* made.

**P3M layer**: Programs and Projects / Operations — single-project task and sprint
governance. This is **OSS** (confirmed via `enterprise-check`: team-scoped self-governance,
single-project). A cross-program or PMO-imposed policy layer is the only part that belongs
in Enterprise.

**VoC** (2026-05-30): after a v2 revision the four personas who actually touch sprint/phase
assignment cleared their blockers — Sarah (PM) 8, Alex (Scrum Master) 7.5, Morgan (Agile
Coach) 8, Jordan (PO) 6. Both original 🔴 blockers (Tier-2 sprint-sovereignty violation;
audit that logged membership instead of scope) are resolved by this design. The remaining
🟡 (Jordan wants an approve-gate, not notify-after) is handled as a scoped follow-up, see
**Decision §5**.

**Key forces from the existing architecture** (research, 2026-05-30):

1. **Structured error codes, not bare `ValidationError`.** The codebase has a firm
   precedent: `MilestoneRollupLockedError`, `ProgressAnchorError`,
   `PlannedStartBeforeProjectStartError`, `CycleDetectedError` — each a named exception
   producing `{"code", "detail", "suggested_action", ...}` handled in the viewset, which
   the frontend maps to a prompt/confirm/snap flow.
2. **`is_summary` is annotation-only**, computed by RawSQL ltree `EXISTS` in
   `TaskViewSet.get_queryset()`. There is no stored column. Any guardrail that checks
   summary-ness must use the annotation or an equivalent DB subquery, never a Python field.
3. **`SprintScopeChange` already exists** (`models.py:2102`): records a *subtask* added to
   a task that belongs to an active sprint, with `task`, `sprint`, `subtask_name`
   (denormalized, survives deletion), `added_by`, `added_at`, firing the
   `subtask_sprint_scope_changed` signal (explicitly the **Enterprise audit extension
   point**). It is a plain `models.Model` — deliberately **not** a `VersionedModel` (not
   mobile-synced; display metadata only). Rows are cleared when the sprint closes (the
   `SprintCloseRequest` drain deletes them). It is already rendered in the frontend
   (`SprintSection.tsx` → `task.sprintScopeChanges`; `OverviewSection` scope-changed pill)
   and feeds `Sprint.scope_change_points` / `scope_change_task_count`.
4. **No `ProjectSettings` model.** Per-project policy lives on `Project`
   (`methodology`, `agile_features`, `estimation_mode`) plus singleton companions
   (`BoardColumnConfig` OneToOne→Project, `PhaseGateConfig` OneToOne→Program).
5. **RBAC ordinals** (ADR-0072): VIEWER=0, MEMBER=100, SCHEDULER=200, ADMIN=300, OWNER=400;
   use `role >= Role.X`. There is **no PMO/Scrum-Master role in OSS** — a "PMO imposes a
   block over the team" scenario is structurally impossible in OSS and only arises in
   Enterprise.
6. **Recurring tasks** (ADR-0090): `is_recurring=True` ⇒ `wbs_path=None`, excluded from CPM
   and the `Task.committed` manager. They must be exempt from WBS/phase guardrails.
7. **Methodology is UI-visibility, not API permission** (ADR-0041). A guardrail that should
   only apply to AGILE/HYBRID projects checks `project.methodology` in the serializer.
8. **Offline** (ADR-0082): sync is a custom server-side delta protocol, not WatermelonDB;
   no mobile client ships before 0.4. Sarah's "works offline" requirement is therefore a
   *design constraint on the rule shape* (rules must be pure functions evaluable wherever
   task data lives), enforced now in the web client and on the sync-upload path, and
   reusable by the 0.4 mobile client.
9. **History diff set is too narrow** (ADR-0098, task-history-endpoint-dead-view): `wbs_path`
   and `sprint` are not currently diffed, producing bare "Updated" pills. Guardrail mutations
   must write `history_change_reason` so the future timeline can classify them.

## Decision

A four-tier guardrail model. **Default flexible: warn, never silently block. Escalation is
team-owned, never management-imposed. Every block is visible and attributed.**

### §1 Tier 0 — Hard invariants (no override)
Data-integrity only, enforced server-side. These already exist and are unchanged:
same-project sprint ownership (`TaskSerializer.validate`), WBS cycle detection (ADR-0055).
No new DB `CheckConstraint` is added for *state-based* rules — consistent with the
single-active-sprint precedent (API 409, not a DB unique). Tier 0 also runs inside the
sync-upload batch loop and must fail the **whole batch atomically** (ADR-0082).

### §2 Tier 1 — Soft guardrails (warn + one-tap override, default ON)
Rules, each a **pure function** `(task, context) → Warning | null`:

| Rule key | Fires when | Outcome-language copy |
|---|---|---|
| `summary_in_sprint` | task with WBS children assigned to a sprint | "This double-counts in velocity — its child tasks already carry the points." |
| `phase_in_sprint` | WBS L1 root assigned to a sprint (special case) | "Phases group work; assign the tasks inside it to the sprint instead." |
| `task_outside_sprint_window` | task `planned_start`/`early_finish` falls entirely outside the sprint's `start_date`..`finish_date` | "Scheduled outside this sprint's dates — it won't complete in the sprint." |
| `recurring_in_sprint` | `is_recurring=True` assigned to a sprint | "Recurring tasks aren't tracked in sprint velocity." |
| `subtasks_split` | siblings under one parent span multiple sprints (advisory badge on the parent only) | "Subtasks span N sprints." |

Constraints (all from VoC):
- **Copy uses outcome language**, never WBS jargon ("WBS L1 root", "summary task").
- **Override is a single non-blocking tap** that proceeds immediately; the reason field is
  **always optional and may never be made required** at the warn tier by any policy.
- Rules evaluate **client-side** from already-loaded task data (web today, mobile at 0.4).
  The two rules needing cross-row data (`summary_in_sprint`, `subtasks_split`) reuse the
  existing `is_summary` annotation / a sibling query already present on the board payload.
- **Guardrail UI/badges render only in planning/assignment surfaces** (task drawer,
  inline list, sprint planning, board) — **never** in a contributor "My Tasks" view and
  **never** as a push notification (Priya). `SprintSection`/`SprintPrompt` already filter
  summary/milestone tasks out of the selector; this generalizes the rule across all entry
  points (inline list, API, sync upload) and adds the server-side warning code.

Audit **(A)** — membership-override log: a Tier-1 override rides the existing
`HistoricalRecords` on `Task` with `history_change_reason` set
(e.g. `"override: summary_in_sprint"`). **Team-readable first** — visibility follows the
existing history-endpoint RBAC (who-made-the-change is Owner/Admin-only; the event itself
is visible per project membership). No new "who broke policy" surface is created.

### §3 Tier 2 — Policy escalation (per-project, default warn)
A new singleton `ProjectGuardrailPolicy` (OneToOne→Project, following the `PhaseGateConfig`
pattern; `get_or_create`, PATCH-only). Each Tier-1 rule has a level: `warn` (default) |
`block`.

**Sprint-sovereignty rule (resolves the original 🔴):**
- **Sprint-composition** rules (`summary_in_sprint`, `phase_in_sprint`,
  `recurring_in_sprint`, `task_outside_sprint_window`) may be escalated `warn → block`
  **only by `role >= Role.OWNER`** — the team's project owner. They cannot be set by any
  external/admin actor. In OSS there is no PMO role, so a management-imposed sprint block
  is structurally impossible.
- **Structural data-hygiene** rules on the schedule side (WBS integrity) may also be
  Owner-escalatable.
- A `block` produces a structured error (`code: "guardrail_blocked"`,
  `rule`, `detail`, `suggested_action`) — the same pattern as `MilestoneRollupLockedError`.
  It is overridable only by removing the offending state, never silently.

**Enterprise extension point (named).** Cross-program policy templates and org-imposed
enforcement live in `trueppm-enterprise`, attaching via (a) a `guardrail_policy_resolving`
Django signal that lets a registered resolver supply a higher-precedence policy source, and
(b) the frontend slot registry (ADR-0029) for the policy-management surface — OSS never
imports enterprise. **The team-acknowledgment gate is enforced in OSS code, not delegated to
the Enterprise consumer:** any composition-block whose source is external to the project
(`policy.source != "owner"`) is inert until `policy.acknowledged_by_team` is set, and the
persistent team-visible banner naming who set it renders from OSS. This is deliberate — per
ADR-0072 Enterprise may register custom roles at high ordinals, so a `role >= Role.OWNER`
check *alone* could let an org-admin role silently impose a block; gating enforcement on an
explicit team-ack flag (not on role) closes that bypass and preserves sprint sovereignty.

### §4 Tier 3 — Health surfacing (never blocks)
Read-only badges on planning surfaces, computed from existing data: "N tasks in no sprint
and no phase", "Sprint 5 spans 4 phases", "3 summary tasks in sprints". These are the
signals Sarah (WBS/phase hygiene) and Alex (velocity hygiene) asked to *see*. Audience:
team/coach. The PMO sees only aggregate milestone-health (existing rollup); **velocity is
never auto-exposed to a PMO surface** by this feature.

### §5 Mid-sprint scope-injection audit **(B)** — extend `SprintScopeChange`
Generalize the existing model's trigger from "subtask spawned into an active sprint" to
**any** task linked to an ACTIVE sprint after activation (the direct inline/drawer/API/sync
paths, not only subtasks). Additions:
- generalize the denormalized `subtask_name` to an `item_name` label (keep `subtask_name`
  as a deprecated read alias for one release) so the row describes any injected task;
- a `goal_impact` boolean flag (does the injected task target the sprint's
  `target_milestone` / carry points), set at write time;
- rename the signal `subtask_sprint_scope_changed → sprint_scope_changed` (keep the old
  name as a deprecated alias for one release) — preserving the existing Enterprise audit
  extension point;
- it stays a plain `models.Model` (display/audit metadata, not mobile-synced) and continues
  to be cleared on sprint close; if the 0.4 mobile client needs scope-change visibility,
  revisit then;
- **whole-team visibility**: the event already surfaces on the board/`SprintSection` (which
  is inherently team-visible — this satisfies Morgan's whole-team default). A *push*
  notification (via the per-user email pipeline, ADR-0085) goes to the PO/SM by default,
  audience configurable on `ProjectGuardrailPolicy`.

**Open question — resolved: notify-after now, approve-gate as a scoped follow-up.**
Jordan wants the injected task to enter a *pending-acceptance* state (not counted in
commitment/velocity until PO/SM accepts). That is a genuinely different feature: it adds a
new task-in-sprint pending state, changes `committed_points`/burndown math, and adds
accept/reject actions and their RBAC. It is an **enhancement (🟡), not a blocker** — the
original 🔴 was *silent* injection, which notify-after + the board banner already cure.
An approve-gate is also philosophically compatible with "warn never block" **because the
gate is team-owned** (PO/SM gates their own sprint), so it is deferred deliberately, not
rejected. **Ship notify-after in this ADR; file the approve-gate as a follow-up ADR**,
designing the `SprintScopeChange` extension so a `pending`/`accepted` status column can be
added later without a rewrite.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: Tiered warn→team-owned-block + extend SprintScopeChange (chosen)** | Preserves flexibility; clears both VoC 🔴; reuses existing audit model and error-code pattern; OSS-clean | Two policy concepts (rule levels + scope audit) to document; annotation-based summary checks add query cost |
| B: DB `CheckConstraint`s forbidding summary/recurring tasks in sprints | Cheap, bulletproof | Removes flexibility (no override); breaks the "warn never block" principle; can't be team-configured; recurring/summary are annotation/null states a CheckConstraint can't cleanly express |
| C: Hard serializer blocks (no policy tier) | Simple | Same loss of flexibility; Alex/Morgan 🔴 (no team control); no override path |
| D: New `GuardrailEvent` model for all audit | Uniform | Duplicates `SprintScopeChange` and `HistoricalRecords`; more sync surface; rejected — extend what exists |
| E: Approve-gate for mid-sprint injection in this ADR | Tops Jordan to 8 | Touches commitment/velocity math + new state machine; scope creep on a foundation feature; deferred to follow-up |

## Consequences

**Easier**: catching fat-finger sprint/phase mistakes before they corrupt velocity,
capacity, and rollups; trustworthy data for everything downstream (Janet/Marcus/David
benefit indirectly — this is the foundation their dashboards stand on); a single,
team-owned governance dial.

**Harder**: summary/sibling checks require the `is_summary` annotation on the queryset
(query cost; mitigated because the board payload already annotates it); two audit paths
(history for overrides, `SprintScopeChange` for injection) that must be kept conceptually
distinct in docs and UI.

**Risks**: (1) warning fatigue if too many fire at once — mitigated by bulk-op aggregation
(one confirm for a batch) and default-`warn`. (2) The offline guarantee is *forward-looking*
— real validation on a no-signal device only lands with the 0.4 mobile client; until then
the promise is "rules are pure and run wherever the data is", enforced in web + sync upload.
(3) drf-spectacular enum-name collision when adding the rule-level / rule-key enums — pin
both via `ENUM_NAME_OVERRIDES` (known regression, see project memory).

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations.
- **Affected packages**: api (serializer rules, `ProjectGuardrailPolicy`, `SprintScopeChange`
  extension, sync-upload Tier-0), web (warning UI in planning surfaces, Tier-3 badges,
  policy settings page). No scheduler change. Mobile: rules authored as pure functions for
  0.4 reuse.
- **Migration required**: yes — a new `ProjectGuardrailPolicy` singleton + `SprintScopeChange`
  fields (`goal_impact`, `item_name`, `source`, `acknowledged_by_team`). Run `makemigrations`
  for the real number — the projects-app migration counter is moving with concurrent work
  (~0053+ at design time); do **not** hard-code it. HistoricalRecords on any new model must
  hit both tables, so never hand-write.
- **API changes**: yes — `ProjectGuardrailPolicy` CRUD (PATCH-only, `role >= Role.OWNER`
  for composition-block levels); new structured error `guardrail_blocked`; server warning
  codes for the rules needing cross-row data; widened `SprintScopeChange` payload
  (`goal_impact`). Regenerate OpenAPI **after merging origin/main**; add `ENUM_NAME_OVERRIDES`
  for new enums.
- **OSS or Enterprise**: **OSS** (Tier 0–3, team-owned Tier-2, both audit logs, badges).
  Enterprise registers against the `guardrail_policy_resolving` signal + slot registry for
  cross-program policy templates + immutable tamper-evident audit + org-imposed enforcement
  (with the team-ack gate + banner enforced in OSS). OSS must never import `trueppm_enterprise`.
- **Follow-up ADR**: mid-sprint scope-injection **approve-gate** (pending-acceptance state,
  commitment/velocity exclusion, accept/reject + RBAC).
- **Coordinate with ADR-0098** (task-history-endpoint-dead-view, #874): add `sprint`/`wbs_path`
  to the history diff set and write `history_change_reason` on overrides so they are not bare
  "Updated" pills.

### Durable Execution
1. **Broker-down behaviour**: Tier-0/1/2 evaluation is **synchronous and pure** — no async
   dispatch, no durability gap. The only async side effect is the scope-injection
   notification (§5), which goes through the existing per-user email pipeline (ADR-0085)
   via its outbox; if the broker is down the outbox drain re-dispatches it. Burndown
   recompute on scope change already rides the existing `sprint_scope_changed` consumer.
2. **Drain task**: none new — reuses the existing notification outbox drain and the existing
   burndown-recompute path. Semantics match (best-effort notification, idempotent recompute).
3. **Orphan window**: N/A for synchronous validation; the notification reuses the existing
   5-min webhook/email orphan filter.
4. **Service layer**: scope-injection writes go through a `services.py` helper
   (`record_sprint_scope_change(task, sprint, by, goal_impact)`) that both inserts the
   `SprintScopeChange` row and fires `sprint_scope_changed` inside `transaction.on_commit()`
   — never a bare `.delay()` at the serializer.
5. **API response on best-effort dispatch**: the task PATCH returns synchronously (200 with
   the updated task + any `warnings[]`); the notification is fire-and-forget, not surfaced
   as a task id.
6. **Outbox cleanup**: reuses the existing notification outbox 7-day purge — nothing new.
7. **Idempotency**: scope-injection is keyed on `(task, sprint)` (existing index
   `scope_change_task_sprint_idx`); a duplicate add to the same active sprint updates rather
   than duplicates. Validation is naturally idempotent (pure function of current state).
8. **Dead-letter / failure handling**: notification failures fall to the existing
   notification DLQ/alerting (ADR-0084); a dropped notification never blocks the task write
   — the board banner remains the durable, team-visible record of the scope change.
