# ADR-0766: No-op PERT edits must not revoke approval, and a Scheduler needs an explicit withdraw action

## Status
Accepted — 2026-08-01, for #2597 (0.4)

## Context

`TaskSerializer._apply_estimate_governance` (`packages/api/src/trueppm_api/apps/projects/serializers.py:4732`)
downgrades `estimate_status` to `pending` whenever any PERT field
(`optimistic_duration`, `most_likely_duration`, `pessimistic_duration`) is
*present* in `validated_data`, regardless of whether the value actually
changes. `EstimatesTab.tsx` fires a debounced PATCH on blur even when the
field was not edited, so tabbing through an `accepted` estimate silently
revokes the Scheduler's approval. Once `pending`, the Monte Carlo gate
(`scheduling/services.py:455`) withholds the triple and the forecast changes
with no user-visible cause.

Separately, `approve-estimates` (`views.py:5188`) is the only estimate-status
action on `TaskViewSet`. Since #2570 made `estimate_status` read-only on the
serializer (closing a self-approval escalation), the *only* way back to
`accepted` after any downgrade — deliberate or accidental — is a Scheduler
re-running `approve-estimates`. There is no symmetric action for a Scheduler
to *withdraw* an approval they gave in error; today the only way to force a
task back to `pending` is to trigger the bug this ADR fixes on purpose.

P3M layer: **Programs and Projects** — task-level estimate governance is a
single-project concern. OSS, `trueppm-suite`. No enterprise involvement.

This is the second sibling fix in the #2570 lineage, alongside ADR-0743
(`wbs_path`/`PM_ONLY` write-authority gaps) — same root shape: intent
documented, enforcement incomplete on one of the reachable paths.

## Decision

### 1. Problem 1 — compare values, not payload presence

`_apply_estimate_governance` computes:

```python
changed = any(
    f in validated_data and validated_data[f] != getattr(instance, f)
    for f in self._PERT_FIELDS
)
if changed:
    if project.estimation_mode == EstimationMode.SUGGEST_APPROVE:
        validated_data["estimate_status"] = EstimateStatus.PENDING
    else:
        validated_data["estimate_status"] = None
```

- **Comparison semantics (🟢 resolved):** all three fields are plain
  `models.IntegerField` (`models.py:2336-2350`), not `Decimal`/`Float` — `!=`
  is exact-value comparison with no precision hazard. `None != None` is
  `False` (Python), so two unset fields compare equal correctly.
- **Clearing to null counts as a change (🟢 resolved):** `validated_data[f] != getattr(instance, f)` naturally covers `5 != None` → `True`. A PATCH that
  clears an estimate is a real edit and must still downgrade an `accepted`
  status — nothing in the fix should special-case null.
- **The OPEN/PM_ONLY `else` branch (🟢 resolved — apply the same guard):**
  the issue's snippet only gated the `SUGGEST_APPROVE` branch, but the `else`
  branch is not merely "harmless if unconditional" — it is *also* wrong
  under the presence-only bug for the same reason: a no-op re-write of a PERT
  field on an OPEN/PM_ONLY-mode task currently writes
  `estimate_status = None` every time, which is a no-op *value-wise* (it's
  already `None` in those modes almost always) but not universally — a
  project can transition `estimation_mode` while a task already carries a
  non-null `estimate_status` from a prior mode. Gating both branches behind
  the same `changed` computation is strictly more correct and costs nothing;
  do not special-case only the branch the issue's repro hit.
- **Do not compare fields absent from the payload.** The `f in validated_data`
  guard must stay — a PATCH that writes only `most_likely_duration` must not
  be compared against the *other two* PERT fields' stored values (those are
  untouched; the `_PERT_FIELDS & set(validated_data)` short-circuit at the
  top of the method already scopes this, keep it as the outer guard, just
  make the inner assignment conditional on `changed`).

### 2. Problem 2 — add `withdraw_approval` / `withdraw-approval`

Name: **`withdraw_approval`** (method), **`withdraw-approval`** (`url_path`).
"Withdraw" is correct over "reject" — nothing is being rejected (no proposal
is pending disposition in this call), an existing *approval* is being
revoked by the party who granted it. This also reads correctly for the
self-service case ("a Scheduler withdrawing their own approval") which is
the primary use case named in the issue, whereas "reject" reads as acting on
someone else's pending submission (that's what a first-time `pending →
accepted` decision would be, and `approve-estimates` already owns that
verb's negative case implicitly — there is no `reject` for a first-time
submission today, and this ADR does not add one; it is out of scope).

Mirror `approve_estimates` (`views.py:5181-5227`) exactly:

```python
@extend_schema(
    summary="Withdraw an approved three-point estimate back to pending",
    responses={
        200: TaskSerializer,
        400: OpenApiResponse(description="Project estimation_mode is not suggest_approve."),
    },
)
@action(
    detail=True,
    methods=["post"],
    url_path="withdraw-approval",
    permission_classes=[IsAuthenticated, IsProjectScheduler, IsProjectNotArchived],
)
def withdraw_approval(self, request: Request, **kwargs: Any) -> Response:
    """Revoke an accepted three-point estimate back to pending (ADR-0766).

    Symmetric counterpart to approve_estimates: lets a Scheduler undo an
    approval given in error, without having to trigger a PERT-field no-op
    write to force the downgrade. Only meaningful when estimation_mode is
    SUGGEST_APPROVE. Idempotent — calling on an already-pending (or null)
    task is a no-op (200, no DB write, no broadcast).

    Permission: IsProjectScheduler+ (Resource Manager and above) — same gate
    as approve_estimates; whoever can grant the approval can withdraw it.
    """
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    task: Task = self.get_object()
    project: Project = task.project

    if project.estimation_mode != EstimationMode.SUGGEST_APPROVE:
        detail = "withdraw-approval is only available when estimation_mode is suggest_approve."
        return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)

    # Idempotent: not currently accepted — no write, no broadcast.
    if task.estimate_status != EstimateStatus.ACCEPTED:
        serializer = self.get_serializer(task)
        return Response(serializer.data)

    task.estimate_status = EstimateStatus.PENDING
    task.save(update_fields=["estimate_status"])

    project_id = str(task.project_id)
    task_id = str(task.pk)
    transaction.on_commit(
        lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id})
    )

    serializer = self.get_serializer(task)
    return Response(serializer.data)
```

**Idempotency boundary (🟢 resolved):** the no-op guard is
`estimate_status != ACCEPTED` (covers both `pending` and `null`/unset),
mirroring `approve_estimates`'s `== ACCEPTED` guard exactly, just inverted.
A task with no estimate yet (`estimate_status is None`) withdrawing is a
harmless no-op, not an error — there is nothing invalid about calling
withdraw on a task that was never approved.

### 3. RBAC wiring — the `_rbac_permissions()` override (🔴 mandatory, not optional)

Confirmed: `TaskViewSet.get_permissions()` (`views.py:4460`) calls
`self._rbac_permissions()` (`views.py:4466`), and that method — **not** the
`@action`'s inline `permission_classes` kwarg — is what DRF actually
consults. The inline `permission_classes=[...]` on `@action` is dead code
for any action not named in `_rbac_permissions()`'s if-chain; unnamed
actions fall through to the final `return [IsAuthenticated(),
IsProjectMember(), IsProjectNotArchived()]` (`views.py:4485`), which would
let a **Viewer** call `withdraw-approval`. This is exactly the ADR-0217
`split` action's documented gotcha (`views.py:4478` comment) repeating for a
second action. The fix:

```python
if self.action in ("approve_estimates", "withdraw_approval"):
    return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
```

Merge into the existing `approve_estimates` branch (`views.py:4473-4474`)
rather than adding a parallel `if` — the two actions share one gate for
identical reasons and should visibly share one line so a future reader
does not have to notice they must also stay in sync when the role changes.
Keep the inline `permission_classes=[...]` on the `@action` decorator too
(matching `approve_estimates`'s existing pattern) — it is inert under this
viewset's override but documents the intended gate for anyone reading the
action in isolation (e.g. via `@extend_schema`/OpenAPI tooling that
introspects the decorator), and removing it would create an asymmetry with
`approve_estimates` for no benefit.

### 4. Audit trail — no new model needed (🟢 resolved)

`Task.history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_TASK)`
(`models.py:2552`) already tracks `estimate_status` (it is not in
`_HISTORY_EXCLUDED_TASK`, `models.py:194-208`). `approve_estimates` gets
audit coverage "for free" through this — confirmed by the existing test
`test_approve_records_status_change_in_history`. `withdraw_approval` writes
`task.estimate_status` through the identical `task.save(update_fields=[...])`
path, so it is captured by `HistoricalRecords` the same way, including the
acting user (via `simple_history`'s thread-local request-user middleware,
already wired for every other Task field). No new event model, no new
migration.

### 5. Problem 3 (EstimatesTab pre-PATCH warning) — out of scope for this MR

The issue's "consider surfacing 'this edit will require re-approval' before
the PATCH fires" is UI polish contingent on Problem 1's fix actually
existing (once no-op writes stop downgrading, the warning is needed only for
*genuine* edits, which is a smaller and more debatable UX surface — does
every keystroke need a warning, or only on blur-with-a-real-diff?). This is
a legitimate but separable follow-up: file it as its own issue rather than
folding it into this backend-scoped MR, consistent with the fast-path
table's "Backend-only feature" classification for this branch. **File
issue** before closing out #2597 if not already tracked.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Compare only in `SUGGEST_APPROVE` branch (issue's literal snippet) | Matches the issue text verbatim | Leaves the same presence-only bug live in the `else` branch for a mode-transition edge case; inconsistent guard shape |
| New `EstimateApprovalEvent` audit model | Explicit domain event, queryable independent of full history | Unnecessary — `HistoricalRecords` already captures the transition with actor + timestamp; a second audit surface for the same fact is duplication the codebase's own governance model warns against |
| Route withdraw through the serializer's read-only-field path (client sends `estimate_status: "pending"`) | Reuses the PATCH endpoint, no new route | Reopens exactly the #2570 hole (client-supplied `estimate_status` must never be trusted) and requires a *second* read-only bypass mechanism parallel to `approve_estimates`'s direct-model-write pattern — strictly worse than mirroring the existing action |
| Name the action `reject-estimates` | Matches the issue's alternate proposed name; verb-symmetry with a hypothetical future `reject` of a first-time submission | "Reject" implies disposing of a pending proposal, not revoking a grant already made; "withdraw" is the accurate verb for what a Scheduler does to their own prior `approve` |

## Consequences

- Re-sending identical PERT values (blur-without-edit) no longer revokes an
  `accepted` estimate — closes the accidental-downgrade path entirely.
- A genuine PERT edit still downgrades `accepted → pending` exactly as
  before (regression-guarded by the existing `test_suggest_approve_*` tests
  plus a new explicit no-op-vs-real-change test pair).
- Schedulers gain a deliberate, audited, role-gated way to revoke an
  approval — closing the "the only un-approve path is to trigger the bug on
  purpose" gap named in the issue.
- One more `if self.action in (...)` branch to keep in sync in
  `_rbac_permissions()` if a third estimate-governance action is ever added —
  acceptable, this is the established pattern (`split`, `approve_estimates`)
  and not a new maintenance burden class.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (serializers.py, views.py, urls if action routing needs it — `@action` auto-routes, no urls.py change expected)
- Migration required: no (no model/field change; `HistoricalRecords` already covers `estimate_status`)
- API changes: yes — new `POST /api/v1/tasks/{id}/withdraw-approval/` action; `docs/api/openapi.json` regeneration required
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A — synchronous DB write + `transaction.on_commit()` WebSocket broadcast, identical to `approve_estimates`; no Celery dispatch involved.
2. Drain task: N/A — no async work.
3. Orphan window: N/A — no outbox row.
4. Service layer: none needed; both actions write `task.estimate_status` directly on the model, mirroring `approve_estimates`'s existing (already-accepted) pattern rather than introducing a new services.py indirection for a two-line state transition.
5. API response on best-effort dispatch: N/A — the write is synchronous; the response is the full `TaskSerializer` payload (200), identical to `approve_estimates`.
6. Outbox cleanup: N/A.
7. Idempotency: idempotency key is `task.pk` + current `estimate_status`; a call with `estimate_status != ACCEPTED` already is a no-op read (no write, no broadcast) — see §2 above, mirrors `approve_estimates`'s `== ACCEPTED` no-op guard.
8. Dead-letter / failure handling: N/A — no queue; a failed synchronous write surfaces as a normal 5xx to the caller and no state changes (single `save()` call, no partial-write window).
