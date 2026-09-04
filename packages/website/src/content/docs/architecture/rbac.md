---
title: RBAC and permission architecture
description: How TruePPM enforces its 5-role model in code — the permission-class layering, the object-level predicate that also drives client capability flags, WebSocket-connection authorization, and the defense-in-depth pattern behind it.
---

[Roles and Permissions](/administration/rbac/) documents the 5-role model a workspace
admin configures and the matrix of what each role can do. This page is the other
side of that: how the permission classes are actually built in code, why there are
several layers rather than one, and how a role check made in one place (a REST
permission class) ends up expressed consistently in three others (the response
body, the WebSocket gate, and the client UI) without being re-implemented in each.

## The layering: membership, then threshold, then predicate

Every RBAC permission class lives in one file,
`apps/access/permissions.py`, and the design reads as three tiers stacked on top
of each other. Each tier answers a narrower question than the one below it.

**Tier 0 — does the caller belong to this project at all?** `IsProjectMember` (and
its program-level mirror `IsProgramMember`) is the Viewer-and-above read gate.
On a nested route (`/projects/{id}/tasks/`) it runs in `has_permission`, before a
single row is fetched, so a non-member's list request never reaches the
queryset. Underneath every membership check sits `ProjectScopedViewSet`, a
mixin every project-scoped viewset inherits:

```python
class ProjectScopedViewSet(IdempotencyMixin, viewsets.GenericViewSet):
    def get_queryset(self) -> QuerySet[Any]:
        qs = super().get_queryset()
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return qs.none()
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False,
        ).values_list("project_id", flat=True)
        ...
        return qs.filter(project_id__in=member_project_ids)
```

This is the mechanism [Roles and Permissions](/administration/rbac/#idor-prevention)
calls IDOR prevention: a non-member's request resolves against an **empty**
queryset, so a detail request 404s exactly as it would for an object that does
not exist. The requester learns nothing about whether the project is real. This
"existence oracle" framing recurs through the RBAC design — closing it is what
lets a later tier return a richer, structured error without leaking anything a
plain 404 wouldn't have.

**Tier 1 — does the caller's role clear a threshold?** `IsProjectMemberWrite`
(Member+), `IsProjectScheduler` (Scheduler+), `IsProjectAdmin` (Admin+), and
`IsProjectOwner` (Owner, exactly) each compare the caller's `ProjectMembership.role`
against a `Role` ordinal. Two comparison styles appear, and the choice between
them is a real design decision, not a style preference:

- **`role >= Role.X`** — "at least this band." A future Enterprise custom role
  registered inside a band (say, ordinal 250, between Scheduler and Admin)
  inherits this check automatically, with no OSS code change.
- **`role == Role.X`** — "specifically this OSS tier." The last-Owner guard and a
  handful of Owner-only actions use this deliberately; a custom role must never
  silently absorb an Owner-only capability just by sitting near it.

See [Roles and Permissions](/administration/rbac/#why-the-ordinals-jump-by-100)
for the ordinal bands themselves; the point here is that the *comparison
operator*, not just the ordinal value, is part of the contract. A raw integer
comparison (`role < 1`) is treated as a defect wherever it's found — it hard-codes
today's spacing into a permission check that is supposed to survive a future
re-spacing. [ADR-0072](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0072-role-ordinals-extension-point.md)
is the ADR that formalizes this contract, and its Amendment 1 is the reason the
Viewer ordinal is `1`, not `0` — a falsy JSON `0` in a client's `role || DEFAULT`
would otherwise read a Viewer as "no role" and silently grant the default.

**Tier 2 — does the caller's role, plus something about *this* object, clear the
bar?** Role thresholds alone can't express "a Member may edit their own assigned
task but no one else's," or "a Product Owner may edit an EPIC without holding
Admin." Those rules live in shared predicate functions that a permission class
calls from `has_object_permission`, and — this is the part worth dwelling on —
the *same* function backs the client-visible capability flags on the API
response. See the next section.

A composed viewset typically stacks all three tiers per action rather than
picking one:

```python
class TaskViewSet(...):
    def _rbac_permissions(self) -> list[BasePermission]:
        if self.action in ("update", "partial_update", "destroy", "restore"):
            return [IsAuthenticated(), IsProjectMemberWriteOrOwn(), IsProjectNotArchived()]
        if self.action == "create":
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        ...
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
```

`IsProjectNotArchived` is a fourth kind of gate — a lifecycle check, not a role
check — appended alongside the role gate on every action except the ones that
manage archival itself. It composes *additively*: a role that would otherwise
pass is still blocked while the project is archived.

## Naming the project kwarg: the fail-open a route inherits by accident

Tier 0 only runs if the permission layer can find the project, and it finds it by
reading **one URL kwarg by name**:

```python
def _project_pk_from_view(view: APIView) -> Any | None:
    declared = getattr(view, "project_url_kwarg", None)
    kwarg = declared if isinstance(declared, str) else DEFAULT_PROJECT_URL_KWARG
    ...
```

Every project-scoped class then follows the same shape — enforce if the project
resolved, and otherwise `return True`, because a genuinely top-level route
(`/api/v1/dependencies/`) has no project in its URL and must fall through to the
object-level check.

That fallthrough is the trap. A route declared `projects/<pk>/…` rather than
`projects/<project_pk>/…` resolves **nothing**, so the class returns `True` for
everyone — while still sitting in `permission_classes` and reading as a live gate
to anyone reviewing the view. Three separate issues turned out to share this one
root cause, which is what makes it a pattern rather than an incident.

**So a view whose route spells it differently says so:**

```python
class ProjectOverviewView(APIView):
    project_url_kwarg = "pk"          # route is projects/<pk>/overview/
    permission_classes = [IsAuthenticated, IsProjectMember]
```

Two things that look like simpler fixes, and why neither is one:

- **Do not alias `pk` globally.** `pk` names the project on `projects/<pk>/…` and
  names something else entirely everywhere else — a dependency on
  `/dependencies/<pk>/`, a task on `/tasks/<pk>/`. A blanket alias would hand those
  ids to the membership lookup, find no membership, and **deny every legitimate
  request** on those routes. Guessing fails worse than the fail-open it replaces: a
  silent no-op becomes a live outage.
- **Do not make an unresolved project fail closed.** Top-level routes legitimately
  resolve nothing, and denying them would break the object-level tier that is
  supposed to handle them.

Because neither the resolver nor the type system can tell an intentionally
top-level route from a mistyped one, the guard is a **route-table test** rather
than a runtime rule: `tests/apps/access/test_route_table_invariants.py` walks the
live URL resolver and asserts that every route naming a project enforces access by
*some* path — the declared kwarg, a ViewSet's object check, or an explicit call in
the view body — and it names the routes in that last category so removing one is a
failing test rather than a silent downgrade.

One deliberate wrinkle: when a declared route is given an id that matches **no live
project**, the permission layer stands down so the view's own `get_object_or_404`
answers. Without that, an unknown id would start returning 403 where the published
schema documents 404. Note the consequence — an existing-but-forbidden project
answers 403 while an unknown one answers 404, so the two remain distinguishable
here. That is deliberate scope, not an oversight: `ProjectScopedViewSet` above
takes the opposite approach and hides existence behind an empty queryset, and
reconciling the two conventions is an API-visible decision rather than something to
settle inside a resolver fix.

## The shared predicate: one rule, enforced and declared from the same place

`can_user_edit_task(request, task, method)` is the authoritative "may this user
write this task" rule. It is not merely called by the permission class that
enforces the write — it is also called by the serializer to populate the
`can_edit` / `can_delete` fields [Roles and
Permissions](/administration/rbac/#server-derived-capability-flags) documents
from the client's side:

```python
def can_user_edit_task(request, task, *, method="PATCH") -> bool:
    role = _membership_role(request, task.project_id)
    if role is None:
        return False
    if role >= Role.ADMIN:
        return True
    if method != "DELETE" and task.type in (TaskType.EPIC, TaskType.STORY) \
            and _is_product_owner(request, task.project_id):
        return True          # PO facet: may edit, never delete
    if role == Role.SCHEDULER:
        return False          # read-only on task content
    if role == Role.MEMBER:
        return task.assignee_id == request.user.pk
    return False               # Viewer: no writes
```

This predicate is why the frontend never re-implements the rule. Before this
existed, the web client's own approximation of "can I edit this task"
(`role >= Member`) drifted from the server in three separate ways — it missed
the Scheduler read-only carve-out, the Member-owns-this-task-only restriction,
and the Product Owner facet — so the client would show an edit control the
server then rejected. Fusing enforcement and declaration into one function
makes that class of drift structurally impossible: the client capability flag
and the server's write decision are, by construction, the same boolean.

A sibling predicate, `can_user_log_time`, backs `CanLogTime` and `can_log_time`
the same way but deliberately diverges in scope — any Member+ may log time
against any task in their project, not only their own, because the log entry's
`user` field is server-set and therefore already IDOR-safe without a
narrower gate.

The facet axis behind the Product Owner and Scrum Master carve-outs is a
`TeamMembership` boolean (`is_product_owner`, `is_scrum_master`) — orthogonal to
the role ordinal, not a rung on the role ladder. [Roles and
Permissions](/administration/rbac/#why-product-owner-and-scrum-master-map-to-project-manager-admin)
covers why that split exists from the persona side; the architectural point is
that `can_user_edit_task` and the backlog/scope-manager predicates are exactly
where role and facet are combined into one write decision.

## WebSocket-connection enforcement

A REST permission class runs once, on a request. A WebSocket connection is
long-lived, so the same role check has to run at connect time and then survive
until the socket closes — including surviving a role change that happens
*while the socket is still open*.

`ProjectConsumer` (the board/project real-time channel) gates the initial
connection like this:

```python
role = await self._get_role(user, project_pk)
if role is None or role < Role.MEMBER:
    await self.close(code=4003)
    return
```

A Viewer is rejected outright — real-time push is a Member+ affordance, not a
Viewer one. [ADR-0184](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0184-rbac-defense-in-depth-and-viewer-ws-read.md)
documents this as an intentional design decision, not an oversight the 0.3 RBAC
audit happened to leave unfixed: a Viewer's REST reads are a point-in-time
snapshot they can always refresh, and admitting Viewers to the realtime channel
(presence visibility, every board event) is a separate design question — about
per-event read-gating parity and connection-count cost — the ADR explicitly
defers rather than folds in as a side effect.

Membership is checked once, at connect. To keep a role change effective
immediately rather than "whenever this socket happens to reconnect,"
`ProjectConsumer` also listens for a `connection.evict` channel-layer message
and force-closes (code 4003) any live socket belonging to a user whose
membership was just demoted below Member or removed — the same authorization
boundary the REST layer enforces per-request, re-applied to a connection that
REST's request/response model doesn't otherwise touch.

Close codes carry meaning: **4001** is "no valid credential" (see [Auth
architecture](/architecture/auth/#the-websocket-ticket) for how that credential
is minted and validated); and **4003** is "authenticated, but role below
Member".

## Defense-in-depth: why the same rule sometimes appears twice

ADR-0184 is also the record of a deliberate redundancy the 0.3 `rbac-check`
audit introduced on purpose. Several endpoints — project/program membership
management, cross-project slip-conflict acknowledgment — enforced their real
role gate only *inside* the view body (`_require_actor_role(OWNER)` and
similar), with `[IsAuthenticated, IsProjectMember]` at the DRF permission layer.
Every path still failed closed; the gap was one of **visibility**, not safety —
a body-only check is invisible to an OpenAPI security-scheme audit and to a
reviewer scanning `permission_classes`.

The fix layers a second, declarative expression of the same rule at the
permission-class level, without removing the body check:

- `ProjectMembershipViewSet` gains `IsProjectOwner` on `create`/`partial_update`
  — but pointedly not on `destroy`, because any member may remove themselves,
  and the last-Owner guard (a `SELECT FOR UPDATE`-protected invariant, see below)
  is what actually prevents a project from being left ownerless.
- `CrossProjectSlipConflictViewSet.acknowledge` gains a purpose-built
  `IsTaskScopeManager`, created because the ADR needed a scope-manager class
  that resolves its project id by following a `task` foreign key — the existing
  `IsProjectScopeManager` only follows `project`/`project_id`/`predecessor` and
  would have resolved `None` (denying everyone) on a task-keyed object.

One endpoint, `SprintScopeChangeViewSet.accept`/`reject`, deliberately keeps its
gate body-only. Its service layer returns a structured `{"code":
"scope_accept_forbidden", ...}` 403 body the frontend depends on; a permission
class would pre-empt the body and return a generic `{"detail": ...}` 403
instead, breaking that contract for no security gain — the existence oracle is
already closed by the member-scoped queryset, so only a *member* below the
scope-manager bar ever reaches the structured 403, never a non-member probing
for object existence.

The general shape — a body-level check that carries an invariant a permission
class cannot express (an atomic `SELECT FOR UPDATE` guard, a structured error
contract, an assign-below-your-own-role rule) stays in the body; a permission
class is added *alongside* it when the same rule should also be visible at the
DRF/OpenAPI layer — is the pattern to reach for the next time a new write path
needs this kind of audit-visible enforcement.

## Where to go next

- [Roles and Permissions](/administration/rbac/) — the role table, the ordinal
  bands, and the capability matrix this page's permission classes enforce.
- [Auth architecture](/architecture/auth/) — how a caller's identity and the
  WebSocket ticket that gates a socket connection are established in the first
  place.
- [Architecture Decision Records](/architecture/decisions/) — ADR-0072 (role
  ordinals), ADR-0184 (defense-in-depth and the Viewer WS decision), and
  ADR-0133 (server-derived task capabilities) are the primary records behind
  this page.
