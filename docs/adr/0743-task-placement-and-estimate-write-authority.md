# ADR-0743: Task placement fields and estimate-write authority on TaskSerializer

## Status
Proposed — 2026-07-30, for #2585 and #2596 (0.4)

## Context

Two `priority::high` RBAC defects on `TaskSerializer`
(`packages/api/src/trueppm_api/apps/projects/serializers.py`, class at :2679) share
one shape: **the intent is written down and the enforcement covers only some of the
paths that can reach it.** That is the shape #2570 fixed for `estimate_status`, and
both of these were found by the sibling sweep #2570's fix demanded.

P3M layer: **Programs and Projects** — `Task` placement and estimates are single-project
concerns. OSS, `trueppm-suite`. No enterprise involvement.

### Defect 1 (#2585) — placement fields are writable on update

`Meta.fields` includes `wbs_path` (:2957), `is_subtask` (:3019) and
`parent_governance_inherited` (:3030). The `read_only_fields` block (:3056-3121)
lists `is_summary`, `is_phase` and `parent_id` — but none of those three.

So a Team Member who may PATCH their own assigned task can send `{"wbs_path": "1"}`
and relocate it anywhere in the project's WBS tree.

The intent is stated in three places and enforced in none of them on the REST path:

- `apps/sync/upload.py` — `_STRIPPED_ROW_KEYS = {"id", "project", "wbs_path"}`, whose
  comment says `wbs_path` is server-managed and stripping it "keeps the upload from
  corrupting the hierarchy without going through the reparent logic". The **sync
  upload** strips it. The REST `PATCH` does not.
- `PhaseSerializer` puts `wbs_path` in `read_only_fields` — the sibling serializer
  has the guard this one lacks.
- `tests/apps/sync/test_sync_upload.py:616` is named
  `test_wbs_path_not_writable_via_upload` and asserts a property that holds for sync
  and never for `PATCH /api/v1/tasks/{id}/`.

**Blast radius.** The three create-time placement guards live in
`_resolve_create_parent` (`views.py:3869-3919`) — milestone-has-no-children (#1773),
depth-1 (ADR-0060), phase-vs-subtask (#1750) — and are reachable only from the
`parent_id` create path. A `PATCH` bypasses all three. Because `_get_descendants` and
the summary/phase probes are ltree **prefix** queries, a forged path lets a later
delete tombstone a subtree the caller never owned, and can flip `is_summary` /
`is_phase` and corrupt rollups. `project` is separately immutable
(`_validate_project_immutable`, :3216-3232), so this is **in-project hierarchy
corruption, not cross-tenant IDOR**.

**A fact that changes the fix.** #2585 assumed making `is_subtask` read-only would
break create. It does not. `views.py:4559` reads `is_subtask` from
`self.request.data` directly and passes it as a `serializer.save(is_subtask=…)`
kwarg (:4571, :4573). Only `wbs_path` consults `validated_data`
(`views.py:4563`). **The create-vs-update question applies to `wbs_path` alone.**

### Defect 2 (#2596) — PM_ONLY is enforced only in the browser

`EstimationMode.PM_ONLY` (`models.py:1107-1122`) documents "only Scheduler-role users
may write estimate fields; Contributors see read-only values". There is no
server-side check. The sole enforcement is
`packages/web/src/features/schedule/EstimatesTab.tsx:489`. A disabled input is not an
authorization control.

**The impact inverts.** In `SUGGEST_APPROVE` an unauthorized estimate at least lands
`PENDING` and the Monte Carlo gate withholds it (`scheduling/services.py:455`). In
`PM_ONLY` that gate is inert (`suggest_approve` is `False`), and
`_apply_estimate_governance` (:4532-4556) sets `estimate_status = None`, which reads
as *not tracked / not applicable* — i.e. **fully trusted**. A Contributor's
unauthorized estimate, in the mode designed to exclude Contributors, is treated as
*more* trustworthy than one submitted through the sanctioned flow. It feeds
P50/P80/P95 with no pending marker and no approval record.

**The docstring names the wrong role.** `Role.SCHEDULER` (ordinal 200) is labelled
**"Resource Manager"**, and `can_user_edit_task:161` refuses it task content outright.
So "Scheduler-role" in the `PM_ONLY` docstring cannot mean `Role.SCHEDULER` — a check
admitting `Role.SCHEDULER` would be unreachable dead code. `PM_ONLY` means *Project
Manager only*, and Project Manager is `Role.ADMIN` (300). The docstring is the bug's
origin as much as the missing check is.

## Decision

### 1. `wbs_path` and `is_subtask` become fully read-only (#2585)

Both move into `TaskSerializer.Meta.read_only_fields`. **No create-vs-update
asymmetry** — the create-time client-supplied-path branch is removed, and the path is
always derived from `parent_id`.

This is safe because the branch has **no consumer**:

- No web or mobile code sends `wbs_path` on create. Every reference in
  `packages/web/src` is a read — display (`PromoteMilestoneDialog`,
  `TaskTrashDialog`, `ProgramLabelsPage`), prefix matching (`TaskFormModal`),
  or the share page's summary derivation. `useTaskMutations.ts` types it on the
  *response*, never in a create payload.
- The MS Project importer computes paths itself (`_build_wbs_paths`,
  `importer.py:709`) and writes the **model** directly (`importer.py:375`),
  bypassing the serializer entirely.
- No pytest POSTs `wbs_path`. Every test that sets one uses
  `Task.objects.create(…)` at the ORM layer.
- Sync upload already strips it.

With `wbs_path` read-only, `views.py:4563`'s
`if not serializer.validated_data.get("wbs_path")` is always true, so the `else`
branch (:4572-4573) becomes unreachable and is deleted along with the condition.

`is_subtask` needs no special handling: create reads it from `request.data`.

### 2. `parent_governance_inherited` is not a client toggle (#2585 comment)

It moves into `read_only_fields` and **stays** in `_HISTORY_DIFF_DISPLAY_EXCLUDED`.

The field records *whether this task inherited its governance from its parent*. That
is **derived state**, computed by inheritance logic — not a choice a client makes. A
client setting it to `False` while `governance_class` remains inherited writes a
statement that is simply false.

Making it read-only also restores the consistency of
`_HISTORY_DIFF_DISPLAY_EXCLUDED`: every other member is either not client-writable
(`short_id`, `status_changed_at`, `blocked_since`, `sprint_pending`), conveyed by
another channel (`is_deleted`), or privacy-gated (`blocked_reason`).
`parent_governance_inherited` is the only client-writable member, which is exactly
why an unaudited write was possible. Read-only removes the anomaly rather than
papering over it by un-excluding the field.

`tests/apps/projects/test_task_governance_fields.py:82`
(`test_patch_writes_all_three_fields`) must be **inverted**: it is renamed and
asserts `governance_class` and `delivery_mode` still write while
`parent_governance_inherited` is ignored. That test was written to cover the three
fields uniformly, not because anyone designed this one as a capability — nothing in
`packages/api/src/` reads it (three hits: the field list, the model, the history
exclusion).

### 3. `PM_ONLY` requires `role >= Role.ADMIN`, enforced server-side (#2596)

**Admitted set: `Role.ADMIN` (300) and above — nothing else.**

- `Role.SCHEDULER` is *not* admitted. `can_user_edit_task:161` already refuses it
  task content, so admitting it would be unreachable.
- The **Product Owner facet is not admitted**. A PO below Admin may groom EPIC/STORY
  items (ADR-0078), but writing three-point PERT durations is a scheduling act, not
  grooming. `PM_ONLY` exists to reserve estimates to the PM.
- `Role.MEMBER` is refused for the PERT fields only. The rest of the PATCH proceeds
  normally — this narrows a field group, it does not block the request.

This does **not** make `pm_only` unusable, which was the concern in #2596: `ADMIN+`
is precisely the set `can_user_edit_task` already grants full task write to, so
everyone who can meaningfully administer estimates still can.

**Placement — two layers, per ADR-0184 and ADR-0133:**

1. **Authoritative:** a new `_validate_estimate_write_permitted(attrs)` helper called
   from `validate()` (:3158-3214), alongside the ~15 existing per-guard helpers that
   #2081 decomposed it into. It raises `PermissionDenied` when any of
   `optimistic_duration` / `most_likely_duration` / `pessimistic_duration` is present
   and `project.estimation_mode == PM_ONLY` and the caller's role is below
   `Role.ADMIN`. It resolves the role through the existing `_get_caller_role`
   (:3123-3140), which reads `caller_role` from serializer context with a DB
   fallback — so this costs **no extra query on the bulk path**.

   `validate()` is the right layer for the reason `_apply_estimate_governance`'s own
   docstring gives: a co-write hook fires only when a PERT duration is present
   *alongside* something else, and a payload carrying the gated field alone sails
   past it (#2570). A `validate()` guard sees every payload.

   **The guard fires on create as well as update.** When `self.instance is None`
   the project is resolved from `attrs["project"]` rather than
   `self.instance.project`. Guarding only the update path would reproduce the exact
   one-path-covered defect class this ADR exists to close — a Member could POST a new
   task carrying PERT fields under `pm_only` and land an unauthorized estimate that
   `_apply_estimate_governance` then stamps `estimate_status = None`, i.e. trusted.
   (Surfaced by the `ai-review` gate.)

2. **Defense-in-depth:** the rule is extracted into
   `can_user_write_estimates(request, task)` in `apps/access/permissions.py`,
   following ADR-0133's "one rule, called twice" pattern. The serializer guard calls
   it, and a new read-only `can_edit_estimates` serializer field exposes it, so the
   client gates off the identical predicate the server enforces. Per ADR-0184 the
   in-body check stays authoritative; the declarative expression is additive.

The `EstimatesTab.tsx:489` client control **stays** — it is now the second line, not
the only one.

### 4. One declaration covers REST *and* sync — do not duplicate the guard

`apps/sync/upload.py:18` states that apply **reuses `TaskSerializer`** — "the same
serializer the REST PATCH path uses" — confirmed at :301, :321 and :358. So moving
the three fields into `read_only_fields` closes the REST path and the sync upload
path from a **single declaration**.

Two consequences follow, and both are decisions:

- `is_subtask` and `parent_governance_inherited` are **not** added to
  `_STRIPPED_ROW_KEYS`. Duplicating enforcement in a second place is precisely how
  the two paths drifted apart in the first place — the REST guard was missing while
  sync had its own. One rule, one site.
- `wbs_path` **stays** in `_STRIPPED_ROW_KEYS` as defense-in-depth (ADR-0184's
  additive pattern), but its rationale comment (:55-58) becomes factually wrong the
  moment this branch lands: it asserts "``wbs_path`` is writable on TaskSerializer".
  It must be corrected in the same commit. A comment that documents an enforcement
  living somewhere it does not is the artifact that let this defect survive review
  once; leaving it inverted would rebuild the trap.

(Both surfaced by the `threat-model` gate.)

### 5. Correct the two misleading docstrings

- `models.py:1113` — "only Scheduler-role users" becomes "only Project Manager
  (`Role.ADMIN`) and above". This wording is what made the wrong threshold look
  plausible.
- `IsProjectMemberWriteOrOwn` (`access/permissions.py:282-287`) carries a stale role
  matrix — "Viewer (0) / Team Member (1) / Resource Manager (2) / Project Manager
  (3+)". Real ordinals are 1 / 100 / 200 / 300 / 400 (ADR-0072, and VIEWER became 1
  in #2489). Corrected in the same pass; it is one comment above the code this ADR
  changes.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **(a1)** `wbs_path` writable at create, immutable on update | Preserves a documented capability; no schema narrowing | The capability has **zero consumers**; create and update disagree about writability, which drf-spectacular must express as two schemas; keeps a forged-path vector alive at create, where `_resolve_create_parent`'s guards are bypassed by supplying a path instead of a `parent_id` |
| **(a2, chosen)** `wbs_path` fully read-only, always derived from `parent_id` | Kills the whole class at both create and update; deletes a dead branch; one schema | Narrows `TaskRequest` — an API-contract change. Acceptable pre-1.0, and strictly a security narrowing |
| **(b1)** `parent_governance_inherited` stays writable, removed from the history exclusion so writes are audited | Preserves the behavior `test_patch_writes_all_three_fields` asserts | Audits a write that should not happen; the field is derived state, so a client value can contradict `governance_class`; leaves the only client-writable member in an exclusion set otherwise reserved for non-writable fields |
| **(b2, chosen)** read-only, stays excluded | Removes the anomaly at its source; nothing reads the field, so blast radius is nil today | Inverts an existing test and removes a (never-designed, never-used) capability |
| **(c1)** `role >= Role.SCHEDULER` | Matches the docstring's literal wording | Unreachable — `can_user_edit_task` already refuses SCHEDULER task content. Would read as enforcement while enforcing nothing |
| **(c2, chosen)** `role >= Role.ADMIN`, `validate()` helper + shared predicate | Matches what `PM_ONLY` means; reuses `_get_caller_role` so bulk stays O(1); ADR-0133/0184 patterns | Refuses the PO facet, a deliberate narrowing that must be stated in the changelog |
| **(c3)** enforce in `_apply_estimate_governance` | Smallest diff | Fires only on co-write; a PERT-only payload bypasses it — the exact #2570 failure |

## Consequences

**Easier.** The stated intent and the enforced behavior agree on every path — REST
create, REST update, and sync upload. `can_user_write_estimates` gives the client an
honest capability signal instead of a hard-coded `estimationMode === 'pm_only'`
string comparison. The dead create branch and its `else` arm leave `perform_create`
shorter.

**Harder.** `TaskRequest` no longer accepts `wbs_path`, `is_subtask` or
`parent_governance_inherited`. Any out-of-tree consumer relying on those is broken by
this change — a real API-contract narrowing, called out in the changelog as such.

**Risks.**
- The `wbs_path` create branch is judged dead from a whole-tree grep plus the
  importer and sync read. *Falsifier:* an out-of-tree API client that supplies paths
  directly. Mitigation: the schema diff makes the removal explicit and reviewable;
  fallback is option (a1).
- Refusing the PO facet in `pm_only` is a behavior change for projects using both
  ADR-0078 and `PM_ONLY`. Judged correct — but it is a narrowing, not a bugfix, from
  a PO's point of view.
- `docs/api/openapi.json` regeneration collides with !1825 (#2605), which rotates
  `info.version`. This branch **rebases onto main after !1825 merges** and
  regenerates, per the CLAUDE.md "merge origin/main before regenerating" rule.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: **api** (serializers, views, permissions, models docstring),
  **web** (consume `can_edit_estimates`; `EstimatesTab.tsx` control retained)
- Migration required: **no** — no model field changes; `parent_governance_inherited`
  keeps its column and default, only its serializer writability changes
- API changes: **yes** — `wbs_path`, `is_subtask`, `parent_governance_inherited`
  become read-only in `TaskRequest` / `PatchedTaskRequest`; new read-only
  `can_edit_estimates` field; `PATCH` with PERT fields under `pm_only` below
  `Role.ADMIN` now returns **403**
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. Broker-down behaviour: **N/A** — both fixes are synchronous serializer validation.
   No task is dispatched, no outbox row is written.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no deferred rows.
4. Service layer: no new dispatch path. The shared predicate
   `can_user_write_estimates` lands in `apps/access/permissions.py` beside
   `can_user_edit_task` / `can_user_log_time`, matching ADR-0133's placement.
5. API response on best-effort dispatch: **N/A** — synchronous. Rejections are
   `400` (placement fields, via `ValidationError`) and `403` (estimate authority,
   via `PermissionDenied`).
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: **N/A** for tasks. The validators are pure functions of
   `(attrs, instance, caller role)` with no side effects, so re-running a request
   yields the identical verdict.
8. Dead-letter / failure handling: **N/A** — no async failure path. Both guards fail
   **closed**: `_get_caller_role` returns `None` for unresolved membership, which is
   below `Role.ADMIN` and therefore denied, matching `can_user_edit_task`'s
   fail-closed contract.

### 6. Grandfathered estimates are stated, not silently carried (`ai-review` gap 2)

`_apply_estimate_governance` (:4557) writes `estimate_status = None` for **both**
`OPEN` and `PM_ONLY` — "clear status tracking — not applicable". After this fix that
one wire value carries two different trust levels: under `pm_only` it means *authored
by ADMIN+, authoritative*; under `open` it means *anyone could have written this*.
`estimation_mode` lives on the **Project** serializer (:564), not the Task, so a
headless client reading `GET /api/v1/tasks/{id}/` cannot tell them apart without a
second fetch.

The same conflation means estimates written by Contributors under `pm_only`
**before** this fix keep `None`, remain indistinguishable from PM-authored ones, and
keep feeding P50/P80/P95.

Decision for 0.4: **grandfather them, and say so.** This branch closes the forward
hole; it does not retroactively invalidate existing rows. That position is defensible
only if stated — the changelog fragment and the `docs/` estimation-mode page must
both carry it. Silent grandfathering would be the actual gap.

A retroactive fix is feasible later and is filed as follow-up rather than guessed at
here: the PERT fields are **not** in `_HISTORY_EXCLUDED_TASK` (`models.py:194-204`),
so `HistoricalTask` already retains every estimate change together with its
`history_user`. No new capture is needed — only a derivation.

## Open Questions

None blocking (🔴 none). Three were resolved by evidence during this gate rather than
left to the implementer:

- *Does the `wbs_path` create branch have a consumer?* No — whole-tree grep, importer
  read, and test survey all negative. Resolved to (a2).
- *Is `parent_governance_inherited` a designed capability?* No — nothing reads it, and
  its test covers it only incidentally alongside two fields that **are** capabilities.
  Resolved to (b2).
- *Does the estimate guard need to cover create?* Yes. Resolved in §3 — guarding only
  update would leave the create path open, which is the same defect class.

One item is deliberately deferred to a follow-up issue rather than absorbed here:
**estimate provenance** (who authored an estimate, under which mode), so an agent can
explain a forecast rather than quote it. Scoped out of 0.4 because it is a new
server-side fact, not a missing guard — see §5 for why it is cheap when it is picked
up.

## Related

- #2585, #2596 — the two issues this ADR closes
- #2570 — the defect whose sibling sweep found both
- ADR-0133 — "one rule, called twice"; the shared-predicate pattern
- ADR-0184 — in-body checks authoritative, permission classes defense-in-depth
- ADR-0072 — role ordinal bands; #2489 moved VIEWER to 1
- ADR-0060 (depth-1 subtasks), #1750 (phase-vs-subtask), #1773 (milestone children) —
  the three create-time guards a forged path bypasses
- ADR-0078 — the Product Owner facet this ADR deliberately excludes from `pm_only`
