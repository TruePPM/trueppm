# ADR-0184: RBAC defense-in-depth permission classes and the Viewer WebSocket-read decision

## Status
Proposed

## Context

The 0.3 pre-release `rbac-check` (issue #1351) found two consistency gaps in how
write authorization is expressed across the API, plus one undocumented
WebSocket-connection decision. None is a confirmed exploit — every path fails
closed — but they are worth tidying before the 0.3 surface ossifies and enterprise
code starts registering against these extension points.

**Gap 1 — in-body role gates not expressed at the DRF permission layer.**
Several write actions pass the DRF `permission_classes` layer (typically
`IsAuthenticated` + `IsProjectMember`), reach the **view body**, and only then
enforce the real role gate:

- `ProjectMembershipViewSet` / `ProgramMembershipViewSet` — `create` and
  (for project) `partial_update` are Owner-only, enforced by an in-body
  `_require_actor_role(OWNER)`. A Viewer passed `IsProjectMember`, entered the
  body, then got 403. The Owner requirement was invisible to DRF-level audits and
  OpenAPI security generation.
- `CrossProjectSlipConflictViewSet.acknowledge` — `[IsAuthenticated]` only at the
  DRF level; the scope-manager rule (Admin+ OR the Scrum Master / Product Owner
  facet, ADR-0102 §3) was enforced solely in the body.
- `SprintScopeChangeViewSet.accept`/`reject` — `[IsAuthenticated]` only; the
  service-layer gate (`_assert_scope_gate`) is the sole enforcer.

**Gap 2 — Viewer WebSocket exclusion is undocumented.** `ProjectConsumer`
(`sync/consumers.py`) and `WorkshopConsumer` (`workshops/consumers.py`) both reject
a connection when `role < Role.MEMBER` (close code 4003). A Viewer can read project
data over REST but cannot open the realtime channel, so their REST-fetched view goes
stale until a manual refresh. The behavior was never recorded as intentional, so it
read as a possible oversight.

## Decision

### 1. Add permission-layer role classes mirroring the in-body gates — additively

The in-body checks are **authoritative and stay**. The permission classes are
**defense-in-depth**: a second, declarative expression of the same rule that an
auditor (or OpenAPI generation) can see, and that rejects an unauthorized caller
before they reach the body.

- `ProjectMembershipViewSet.get_permissions()` appends `IsProjectOwner` for
  `create` and `partial_update`. **Not** `destroy` — any member may self-remove
  (the last-Owner guard prevents stranding a project), so requiring Owner there
  would be a regression.
- `ProgramMembershipViewSet.get_permissions()` appends `IsProgramOwner` for
  `create` **only**. **Not** `partial_update`: a `role_title`-only PATCH (benign
  descriptive metadata, #565) is permitted at Admin+, and the body already escalates
  to the Owner gate only when `role`/`user` change. Gating the whole action on Owner
  would regress that Admin metadata branch.
- `CrossProjectSlipConflictViewSet.get_permissions()` appends a **new**
  `IsTaskScopeManager` for `acknowledge`. The existing `IsProjectScopeManager`
  cannot be reused: its `has_object_permission` resolves the project via
  `_get_project_id_from_obj`, which follows `project`/`project_id`/`predecessor`
  but **not** a `task` FK — a slip conflict is keyed to a task, so the generic class
  would resolve `None` and deny everyone. `IsTaskScopeManager` resolves
  `obj.task.project_id` and applies the same `can_manage_scope_with_facet` rule.

### 2. SprintScopeChange keeps its service gate — carve-out, no permission class

`SprintScopeChangeViewSet.accept`/`reject` is **intentionally left** with only
`IsAuthenticated` at the permission layer. Its service gate returns a **structured**
`{"code": "scope_accept_forbidden", "detail": ...}` 403 that the frontend depends on
(asserted in `test_scope_injection_approve_gate.py`). A DRF permission class would
pre-empt the body and emit a plain `{"detail": ...}` 403, breaking that contract.

This is safe because the **existence oracle is already closed by the member-scoped
queryset** (`get_queryset` filters to the caller's member projects, so a non-member
gets a uniform 404, #996). The only caller who reaches the structured 403 is a member
below the bar — who can already see the project exists. This mirrors the
`DependencyViewSet` decision (ADR-0120 D2): a structured, contract-bearing 403 from
the service layer is preferred over a generic permission-layer denial when the
existence oracle is independently closed.

### 3. Viewer WebSocket exclusion is intentional — documented, not changed

For 0.3 we **document the status quo rather than admit Viewers to the realtime
channel**. Rationale:

- A Viewer's REST read is a **point-in-time snapshot**; live collaboration (presence,
  push invalidation) is a Member+ affordance. This is a deliberate product line, not
  an accident.
- Admitting Viewers read-only would be a **behavior and security change** (a Viewer
  appearing in presence, receiving every board event) that warrants its own
  threat-model and test pass — not something to slip into a release-hardening branch.
- Viewers already receive a clean fallback: surfaces poll on an interval and refetch
  on focus, so a Viewer's data is never permanently stale, only not push-fresh.

If a future release wants live read for Viewers, it is a separate ADR that must cover
presence visibility, per-event read-gating parity with the REST serializers, and the
connection-count cost.

## Consequences

- **No behavior change for authorized callers.** Every added permission class
  enforces a rule the body already enforced; an Owner/scope-manager who could act
  before can still act. The only observable change is *where* an unauthorized caller
  is rejected (permission layer vs body) and, for the membership viewsets, the 403
  body shape for a below-Owner member — which was already a generic 403.
- **In-body checks remain.** The permission classes do not replace them; both run.
  This is intentional belt-and-suspenders — the boundary holds even if a future edit
  drops a permission class from a viewset.
- **Extension-point stability.** Enterprise registers against these viewsets; the
  permission classes are additive and the action signatures are unchanged.
- **`IsTaskScopeManager` is reusable** for any future object reached through a `task`
  FK that needs the scope-manager gate.
- **Viewer realtime is explicitly a non-goal for 0.3**, with a documented upgrade
  path, closing the "is this a bug?" ambiguity the audit raised.

## Alternatives considered

- **Add a permission class to SprintScopeChange too.** Rejected: it breaks the tested
  `scope_accept_forbidden` structured-403 contract for no security gain (the oracle is
  already closed by the queryset).
- **Replace the in-body gates with the permission classes.** Rejected: the in-body
  checks carry invariants a permission class cannot (assign-below-self, last-Owner
  guard, the membership-row `SELECT FOR UPDATE` TOCTOU close). Defense-in-depth keeps
  both.
- **Admit Viewers to the WebSocket read-only now.** Rejected for 0.3 as an unscoped
  behavior/security change; deferred to a dedicated ADR.

## References

- Issue #1351 — rbac: express in-body role gates as DRF permission classes + Viewer
  WS read consistency
- ADR-0102 §3 — sprint scope-manager gate (Admin+ OR SM/PO facet)
- ADR-0120 D2 — DependencyViewSet structured-403 service-gate precedent
- ADR-0070 — program membership matrix
- #996 — existence-oracle (404 vs 403) hardening
