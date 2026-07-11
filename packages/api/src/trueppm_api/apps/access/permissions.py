"""DRF permission classes and ProjectScopedViewSet mixin for RBAC."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from django.db.models import QuerySet
from rest_framework import viewsets
from rest_framework.authentication import BaseAuthentication
from rest_framework.permissions import SAFE_METHODS, BasePermission
from rest_framework.request import Request
from rest_framework.throttling import BaseThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_project_id_from_obj(obj: Any) -> Any | None:
    """Extract the project PK from a model instance.

    Supports direct Project instances as well as any model with a project_id
    or project attribute (Task, Dependency, etc.).

    Uses isinstance to identify Project to avoid false-positives from future
    models that happen to have a 'memberships' attribute (M3 fix).
    """
    # Import here to avoid a module-level circular import (access → projects).
    from trueppm_api.apps.projects.models import Project

    if isinstance(obj, Project):
        return obj.pk
    if hasattr(obj, "project_id"):
        return obj.project_id
    if hasattr(obj, "project"):
        return obj.project_id
    # Dependency — look through predecessor__project_id
    if hasattr(obj, "predecessor_id"):
        predecessor = getattr(obj, "predecessor", None)
        if predecessor is not None:
            return predecessor.project_id
        return None
    return None


def _membership_role(request: Request, project_id: Any) -> int | None:
    """Return the requesting user's role ordinal for a project, or None if absent.

    Results are cached on the request object to prevent N+1 queries on list
    endpoints where has_object_permission is called once per row (L1 fix).
    The cache is keyed by str(project_id) and lives only for the request lifetime.

    Only active (non-soft-deleted) memberships are considered (M1 fix).
    """
    if not request.user or not request.user.is_authenticated:
        return None

    # Per-request cache: initialise lazily on the DRF request object.
    cache: dict[str, int | None] | None = getattr(request, "_rbac_role_cache", None)
    if cache is None:
        cache = {}
        request._rbac_role_cache = cache  # type: ignore[attr-defined]

    cache_key = str(project_id)
    if cache_key in cache:
        return cache[cache_key]

    try:
        membership = ProjectMembership.objects.get(
            project_id=project_id,
            user=request.user,
            is_deleted=False,  # M1: exclude soft-deleted memberships
        )
        role: int | None = membership.role
    except ProjectMembership.DoesNotExist:
        role = None

    cache[cache_key] = role
    return role


def _is_product_owner(request: Request, project_id: Any) -> bool:
    """Request-cached ``is_product_owner`` facet check (ADR-0078).

    ``can_user_edit_task`` is evaluated once per task row on list endpoints, and a
    Product Owner grooming a large EPIC/STORY backlog is exactly the persona who
    loads the biggest such list. The underlying ``has_team_facet`` lookup is a DB
    query, so without this cache the PO path would be N queries for N rows. The
    facet is constant per (user, project) for the request, so memoize it on the
    request object the same way ``_membership_role`` caches the role.
    """
    cache: dict[str, bool] | None = getattr(request, "_rbac_po_facet_cache", None)
    if cache is None:
        cache = {}
        request._rbac_po_facet_cache = cache  # type: ignore[attr-defined]

    cache_key = str(project_id)
    if cache_key in cache:
        return cache[cache_key]

    from trueppm_api.apps.teams.services import has_team_facet

    result = bool(has_team_facet(request.user, project_id, "is_product_owner"))
    cache[cache_key] = result
    return result


def can_user_edit_task(request: Request, task: Any, *, method: str = "PATCH") -> bool:
    """Authoritative "may this user write this task" predicate (ADR-0133).

    This is the single source of truth for task-edit permission. It backs BOTH
    enforcement (``IsProjectMemberWriteOrOwn.has_object_permission``) and the
    declarative ``TaskSerializer.can_edit`` / ``can_delete`` fields, so the
    contract the client gates off can never drift from the contract the server
    enforces. There is one rule; it is called twice.

    ``method`` is the would-be write verb: ``"DELETE"`` excludes the Product
    Owner facet branch (a PO may groom — edit — EPIC/STORY items, but removing
    another member's story stays an Admin/assignee act), so ``can_edit`` and
    ``can_delete`` legitimately differ for a PO.

    Fails closed: any unresolved context (no auth, no membership) yields
    ``False`` — never an exception, never an over-permissive ``True``.
    """
    if not (request.user and request.user.is_authenticated):
        return False

    project_id = getattr(task, "project_id", None)
    if project_id is None:
        return False

    role = _membership_role(request, project_id)
    if role is None:
        return False

    # Project Manager (3) and Project Admin (4): full write on any task.
    if role >= Role.ADMIN:
        return True

    # Product Owner facet (ADR-0078 / #1095): edits EPIC/STORY work items below
    # Admin and regardless of assignment — but never DELETE (see docstring). The
    # facet lookup is request-cached so a PO grooming a large backlog stays O(1).
    if method != "DELETE":
        from trueppm_api.apps.projects.models import TaskType

        if getattr(task, "type", None) in (
            TaskType.EPIC,
            TaskType.STORY,
        ) and _is_product_owner(request, project_id):
            return True

    # Resource Manager (2): cannot edit task content (only resource assignment).
    if role == Role.SCHEDULER:
        return False

    # Team Member (1): may only edit their own assigned tasks.
    if role == Role.MEMBER:
        assignee_id = getattr(task, "assignee_id", None)
        return assignee_id is not None and assignee_id == request.user.pk

    # Viewer (0): no writes.
    return False


def can_user_log_time(request: Request, task: Any) -> bool:
    """Authoritative "may this user log time against this task" predicate (ADR-0185 §3).

    The single source of truth for time-log permission — it backs BOTH the
    ``CanLogTime`` permission class (enforcement) and ``TaskSerializer.can_log_time``
    (declaration), so the client's gate can never drift from the server's rule.

    Deliberately diverges from ``can_user_edit_task``: logging time records *where my
    hours went*, so a Team Member may log against **any** task on a project they belong
    to (a meeting, a colleague's task they helped on) — not only their own assigned
    tasks. The entry it gates is owned by the logger (``user`` is server-set to
    ``request.user``), so this is IDOR-safe by construction.

    Rule: ``role >= Role.MEMBER`` on ``task.project``. Viewer (0) is denied; Member (1),
    Scheduler (2), Admin (3), Owner (4) — and Enterprise custom roles ≥ 100 by the
    band-threshold contract — may log. Fails closed: no auth / no membership / no
    resolvable project yields ``False`` (never an exception, never over-permissive).
    """
    if not (request.user and request.user.is_authenticated):
        return False
    project_id = getattr(task, "project_id", None)
    if project_id is None:
        return False
    role = _membership_role(request, project_id)
    return role is not None and role >= Role.MEMBER


# ---------------------------------------------------------------------------
# Permission classes
# ---------------------------------------------------------------------------


def _project_pk_from_view(view: APIView) -> Any | None:
    """Extract project_pk from a view's URL kwargs (for nested routes).

    Project-nested routes use ``project_pk`` (e.g. /projects/<project_pk>/task-runs/).
    Returns None for top-level routes that have no project_pk kwarg — in that case
    has_permission cannot enforce membership and per-class fallthrough applies
    (e.g. ProjectViewSet retrieves rely on ProjectScopedViewSet to filter the
    queryset to member projects).
    """
    return getattr(view, "kwargs", {}).get("project_pk")


class IsProjectMember(BasePermission):
    """Allow any project member (Viewer or above) to read; enforce membership on objects.

    Project-nested routes (URL contains ``project_pk``): membership is enforced
    in has_permission so list endpoints are gated before the queryset runs.
    Top-level routes without ``project_pk``: authentication is sufficient at the
    permission layer; per-object membership is enforced in has_object_permission.
    """

    message = "You must be a member of this project."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_pk = _project_pk_from_view(view)
        if project_pk is not None:
            return _membership_role(request, project_pk) is not None
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            # Org-level object (Calendar) — authentication is sufficient.
            return bool(request.user and request.user.is_authenticated)
        return _membership_role(request, project_id) is not None


class IsProjectMemberWrite(BasePermission):
    """Allow Team Member (1) or above to perform write operations.

    On safe methods falls back to IsProjectMember (Viewer+ may read).
    """

    message = "You need at least Team Member role to modify this project."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_pk = _project_pk_from_view(view)
        if project_pk is not None:
            role = _membership_role(request, project_pk)
            if role is None:
                return False
            if request.method in ("GET", "HEAD", "OPTIONS"):
                return True
            return role >= Role.MEMBER
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        if role is None:
            return False

        safe = request.method in ("GET", "HEAD", "OPTIONS")
        if safe:
            return True
        return role >= Role.MEMBER


class IsProjectMemberWriteOrOwn(BasePermission):
    """Assignee-scoped write permission for TaskViewSet update/destroy actions.

    Role matrix (issue #11):
      Viewer (0)           — read only
      Team Member (1)      — edit tasks where task.assignee == request.user
      Resource Manager (2) — read only (cannot edit task content, only assign)
      Project Manager (3+) — edit any task

    Safe methods (GET/HEAD/OPTIONS) allow any project member (Viewer+).

    Unassigned tasks (assignee=None) may only be edited by Project Manager+;
    a Team Member cannot claim or edit a task that has no assignee yet.
    """

    message = "You do not have permission to edit this task."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        if _membership_role(request, project_id) is None:
            return False

        # Safe methods: any project member may read
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True

        # Delegate the write decision to the shared predicate (ADR-0133) so the
        # rule the serializer's can_edit/can_delete fields declare is the exact
        # rule enforced here — one rule, called twice, can never drift. The PO
        # facet, Scheduler-read-only, Member-own-only, and Admin+ branches all
        # live in can_user_edit_task now.
        return can_user_edit_task(request, obj, method=request.method or "PATCH")


class CanLogTime(BasePermission):
    """Gate time-entry writes: role >= MEMBER on the task's project (ADR-0185 §3).

    Object-level by design. ``has_permission`` only verifies authentication; the
    authoritative role check is ``has_object_permission``, invoked by the view via
    ``check_object_permissions(task)`` **after** the view has resolved the task against
    a membership-scoped queryset. Doing the role check in ``has_permission`` would 403 a
    cross-project task that must instead 404 (the task is resolved member-scoped, so a
    non-member sees a 404 existence-oracle close, not a 403). A Viewer *is* a member, so
    their task resolves and this object check then yields the 403.

    Read methods only require membership (a Viewer may read their own, possibly empty,
    entries); unsafe methods require Member+ via :func:`can_user_log_time`.
    """

    message = "You need at least Team Member role to log time on this task."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        # ``obj`` is the resolved Task (the time entry's subject), or an object with a
        # ``task`` FK. Resolve to the task either way.
        task = obj if obj.__class__.__name__ == "Task" else getattr(obj, "task", None)
        if task is None:
            return False
        if request.method in ("GET", "HEAD", "OPTIONS"):
            project_id = getattr(task, "project_id", None)
            return project_id is not None and _membership_role(request, project_id) is not None
        return can_user_log_time(request, task)


class IsProjectScheduler(BasePermission):
    """Allow Resource Manager (2) or above.

    Used on: dependency creation/edit.
    """

    message = "You need at least Resource Manager role for this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_pk = _project_pk_from_view(view)
        if project_pk is not None:
            role = _membership_role(request, project_pk)
            return role is not None and role >= Role.SCHEDULER
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.SCHEDULER


class IsProjectAdmin(BasePermission):
    """Allow Project Manager (3) or above."""

    message = "You need at least Project Manager role for this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_pk = _project_pk_from_view(view)
        if project_pk is not None:
            role = _membership_role(request, project_pk)
            return role is not None and role >= Role.ADMIN
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.ADMIN


def can_manage_backlog(role: int | None) -> bool:
    """Whether ``role`` may perform structural product-backlog actions (ADR-0105).

    Structural = auto-rank, scoring-model / auto-rank toggle, epic create/delete,
    priority reorder. Maps to Admin+ today. This is the role half of the gate;
    the facet half lives in :func:`can_manage_backlog_with_facet`. Story-field
    grooming (AC, dor, points, scoring inputs on a story) is NOT gated here — that
    rides the normal Member+ task-write permission so contributors can refine their
    own stories.
    """
    return role is not None and role >= Role.ADMIN


def can_manage_backlog_with_facet(user: Any, project_id: Any, role: int | None) -> bool:
    """Whether ``user`` may perform structural product-backlog actions (ADR-0078/#1095).

    Admin+ OR the Product Owner facet. The PO facet (ADR-0078 two-axis RBAC, #927)
    grants backlog management without requiring an Admin role bump, so a Product
    Owner who is a project Member can still reorder + auto-rank the backlog. The
    facet lookup is imported lazily to avoid an access ↔ teams import cycle
    (teams.permissions already imports from access.permissions).
    """
    if can_manage_backlog(role):
        return True
    from trueppm_api.apps.teams.services import has_team_facet

    return has_team_facet(user, project_id, "is_product_owner")


class IsProjectBacklogManager(BasePermission):
    """Gate structural product-backlog actions (ADR-0105).

    Admin+ OR Product Owner facet (ADR-0078/#1095) — see
    :func:`can_manage_backlog_with_facet`.
    """

    message = (
        "You need at least Project Manager role or the Product Owner facet "
        "to manage the product backlog."
    )

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_pk = _project_pk_from_view(view)
        if project_pk is not None:
            return can_manage_backlog_with_facet(
                request.user, project_pk, _membership_role(request, project_pk)
            )
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        return can_manage_backlog_with_facet(
            request.user, project_id, _membership_role(request, project_id)
        )


def can_manage_scope_with_facet(user: Any, project_id: Any, role: int | None) -> bool:
    """Whether ``user`` may accept/reject sprint scope injections (ADR-0102 §3, ADR-0123 §3).

    Admin+ OR the Scrum Master / Product Owner facet (ADR-0078, #1140). The PO owns
    sprint scope and the SM facilitates the ceremony, so each facet grants the
    accept/reject gate without an Admin role bump — mirroring how the Product Owner
    facet widens the backlog gate (:func:`can_manage_backlog_with_facet`), but
    honoring **both** facets here because both run the sprint ceremony.

    The facet lookup resolves to a real, non-soft-deleted default-team
    ``TeamMembership`` row — preserving the ADR-0102 §3 back-door close: an
    org/PMO principal has neither an Admin ``ProjectMembership`` nor a team facet
    and is denied regardless of any role ordinal. Imported lazily to avoid the
    access ↔ teams import cycle.
    """
    if role is not None and role >= Role.ADMIN:
        return True
    from trueppm_api.apps.teams.services import user_facets

    facets = user_facets(user, project_id)
    return facets["is_scrum_master"] or facets["is_product_owner"]


class IsProjectScopeManager(BasePermission):
    """Gate sprint scope-injection accept/reject (ADR-0102 §3, widened by ADR-0123 §3).

    Admin+ OR the Scrum Master / Product Owner facet (ADR-0078, #1140) — see
    :func:`can_manage_scope_with_facet`. The matching service-layer gate
    (``assert_scope_gate_for_project``) re-enforces the same rule so the boundary
    holds even if a view forgets this class.
    """

    message = (
        "You need at least Project Manager role or the Scrum Master / "
        "Product Owner facet to accept or reject sprint scope changes."
    )

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_pk = _project_pk_from_view(view)
        if project_pk is not None:
            return can_manage_scope_with_facet(
                request.user, project_pk, _membership_role(request, project_pk)
            )
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        return can_manage_scope_with_facet(
            request.user, project_id, _membership_role(request, project_id)
        )


class IsTaskScopeManager(BasePermission):
    """Scope-manager gate for objects reached through a ``task`` FK (#1351).

    Mirrors :class:`IsProjectScopeManager` (Admin+ OR the Scrum Master / Product
    Owner facet, ADR-0102 §3) but resolves the project through ``obj.task`` rather
    than ``obj.project`` — :func:`_get_project_id_from_obj` cannot follow a ``task``
    hop, so a generic scope-manager class would deny everyone on these objects.
    Used by ``CrossProjectSlipConflictViewSet.acknowledge`` as the permission-layer
    expression of its in-body gate; the in-body check stays for defense-in-depth,
    so the boundary holds even if a view forgets this class. Read methods are not
    this class's concern — it is only attached to the unsafe acknowledge action.
    """

    message = (
        "You need Admin or the Scrum Master / Product Owner facet on this "
        "project to perform this action."
    )

    def has_permission(self, request: Request, view: APIView) -> bool:
        # No project_pk in the top-level slip-conflict route; authorization is an
        # object-level decision resolved once get_object() runs.
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        task = getattr(obj, "task", None)
        project_id = getattr(task, "project_id", None)
        if project_id is None:
            return False
        return can_manage_scope_with_facet(
            request.user, project_id, _membership_role(request, project_id)
        )


class IsProjectOwner(BasePermission):
    """Allow only Project Admin (Owner, 4).

    Used for: ProjectViewSet.destroy (only Project Admin may delete a project).
    """

    message = "Only the Project Admin can perform this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_pk = _project_pk_from_view(view)
        if project_pk is not None:
            role = _membership_role(request, project_pk)
            return role == Role.OWNER
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role == Role.OWNER


# ---------------------------------------------------------------------------
# Program permission helpers (ADR-0070)
# ---------------------------------------------------------------------------


def _program_pk_from_view(view: APIView) -> Any | None:
    """Extract ``program_pk`` from a view's URL kwargs (nested program routes).

    Program-nested routes use ``program_pk`` (e.g. /programs/<program_pk>/members/).
    Top-level program routes use ``pk``; that case is handled by individual
    permission classes that fall through to per-object checks.
    """
    return getattr(view, "kwargs", {}).get("program_pk")


def _program_membership_role(request: Request, program_id: Any) -> int | None:
    """Return the requesting user's role ordinal for a program, or None if absent.

    Mirrors :func:`_membership_role` for ``ProgramMembership``. Per-request cache
    is keyed separately (``_program_rbac_role_cache``) so program and project
    membership lookups don't collide.
    """
    # Import here to avoid the module-level circular import (access ↔ access).
    from trueppm_api.apps.access.models import ProgramMembership

    if not request.user or not request.user.is_authenticated:
        return None

    cache: dict[str, int | None] | None = getattr(request, "_program_rbac_role_cache", None)
    if cache is None:
        cache = {}
        request._program_rbac_role_cache = cache  # type: ignore[attr-defined]

    cache_key = str(program_id)
    if cache_key in cache:
        return cache[cache_key]

    try:
        membership = ProgramMembership.objects.get(
            program_id=program_id,
            user=request.user,
            is_deleted=False,
        )
        role: int | None = membership.role
    except ProgramMembership.DoesNotExist:
        role = None

    cache[cache_key] = role
    return role


def effective_project_role(request: Request, project_id: Any) -> int | None:
    """Public, request-cached lookup of the caller's role ordinal on a project.

    Thin wrapper over the internal :func:`_membership_role` so callers outside
    this module (e.g. the cross-project dependency consent gate in ADR-0120 D2)
    have a documented surface for "what role does the requester hold on project
    X" without importing a private helper. Returns ``None`` when the user has no
    active membership. Compare against :class:`~trueppm_api.apps.access.models.Role`
    ordinals (``>= Role.SCHEDULER`` for schedule authority).
    """
    return _membership_role(request, project_id)


def effective_program_role(request: Request, program_id: Any) -> int | None:
    """Public, request-cached lookup of the caller's role ordinal on a program.

    Wrapper over :func:`_program_membership_role`. Used by the ADR-0120 minimal
    visibility card / consent gate to grant *read* access to a cross-edge
    counterpart task: a ``ProgramMembership`` holder may read either member
    project's task card even without a direct ``ProjectMembership``.
    """
    return _program_membership_role(request, program_id)


def _get_program_id_from_obj(obj: Any) -> Any | None:
    """Extract a program PK from a model instance for has_object_permission checks.

    Supports direct Program instances and any model with a ``program_id``
    attribute (Project — via the new FK — and ProgramMembership).
    """
    from trueppm_api.apps.projects.models import Program

    if isinstance(obj, Program):
        return obj.pk
    if hasattr(obj, "program_id"):
        return obj.program_id
    if hasattr(obj, "program"):
        return obj.program_id
    return None


class IsProgramMember(BasePermission):
    """Allow any program member (Viewer+) to read; enforce membership on objects.

    Program-nested routes (URL contains ``program_pk``): membership is enforced
    in ``has_permission`` so list endpoints are gated before the queryset runs.
    Top-level routes without ``program_pk`` rely on per-object checks.
    """

    message = "You must be a member of this program."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        program_pk = _program_pk_from_view(view)
        if program_pk is not None:
            return _program_membership_role(request, program_pk) is not None
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        program_id = _get_program_id_from_obj(obj)
        if program_id is None:
            return False
        return _program_membership_role(request, program_id) is not None


class IsProgramScheduler(BasePermission):
    """Require Scheduler (2) or above on a program — for **reads** as well as writes.

    The program counterpart to ``IsProjectScheduler``. Resource allocation /
    contention data is Scheduler+ even on GET (web-rule 94 / the per-project
    ``resource-allocation`` gate), so unlike ``IsProgramEditor`` this does **not**
    open GET to every member — a Viewer or plain Member is denied 403.
    """

    message = "You need at least Scheduler role on this program."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        program_pk = _program_pk_from_view(view)
        if program_pk is not None:
            role = _program_membership_role(request, program_pk)
            return role is not None and role >= Role.SCHEDULER
        # Top-level routes (e.g. /programs/{pk}/…) carry no program_pk kwarg;
        # defer to the per-object check, which get_object() triggers.
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        program_id = _get_program_id_from_obj(obj)
        if program_id is None:
            return False
        role = _program_membership_role(request, program_id)
        return role is not None and role >= Role.SCHEDULER


class IsProgramEditor(BasePermission):
    """Allow Team Member (1) or above on a program.

    Used for BacklogItem create/edit endpoints (#501) and any other program-
    level write that is not Admin-gated. For #502 the only Editor-gated action
    is project add/remove on the program — that's gated by IsProgramAdmin
    because it changes program membership-adjacent state. Editor is exposed
    here for #501 to reuse.
    """

    message = "You need at least Team Member role on this program."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        program_pk = _program_pk_from_view(view)
        if program_pk is not None:
            role = _program_membership_role(request, program_pk)
            if role is None:
                return False
            if request.method in ("GET", "HEAD", "OPTIONS"):
                return True
            return role >= Role.MEMBER
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        program_id = _get_program_id_from_obj(obj)
        if program_id is None:
            return False
        role = _program_membership_role(request, program_id)
        if role is None:
            return False
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        return role >= Role.MEMBER


class IsProgramAdmin(BasePermission):
    """Allow Project Manager (3) or above on a program.

    Used for: updating program metadata, adding/removing projects from the
    program, managing membership.
    """

    message = "You need at least Project Manager role on this program."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        program_pk = _program_pk_from_view(view)
        if program_pk is not None:
            role = _program_membership_role(request, program_pk)
            return role is not None and role >= Role.ADMIN
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        program_id = _get_program_id_from_obj(obj)
        if program_id is None:
            return False
        role = _program_membership_role(request, program_id)
        return role is not None and role >= Role.ADMIN


class IsProgramOwner(BasePermission):
    """Allow only Program Owner (4). Used for: program delete."""

    message = "Only the Program Owner can perform this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        program_pk = _program_pk_from_view(view)
        if program_pk is not None:
            role = _program_membership_role(request, program_pk)
            return role == Role.OWNER
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        program_id = _get_program_id_from_obj(obj)
        if program_id is None:
            return False
        role = _program_membership_role(request, program_id)
        return role == Role.OWNER


def _is_project_archived(request: Request, project_id: Any) -> bool:
    """Per-request cache for ``Project.is_archived`` lookups (#530).

    Mirrors the cache pattern used by :func:`_membership_role` (L1 fix). Nested
    write requests (bulk task update, dependency create-many, etc.) trigger
    has_permission + has_object_permission per object — without a cache the
    archived-state .exists() query would run N+1 times per request.
    """
    from trueppm_api.apps.projects.models import Project

    cache: dict[str, bool] | None = getattr(request, "_project_archive_cache", None)
    if cache is None:
        cache = {}
        request._project_archive_cache = cache  # type: ignore[attr-defined]
    key = str(project_id)
    if key not in cache:
        cache[key] = Project.objects.filter(pk=project_id, is_archived=True).exists()
    return cache[key]


def _is_program_closed(request: Request, program_id: Any) -> bool:
    """Per-request cache for ``Program.is_closed`` lookups (#530)."""
    from trueppm_api.apps.projects.models import Program

    cache: dict[str, bool] | None = getattr(request, "_program_close_cache", None)
    if cache is None:
        cache = {}
        request._program_close_cache = cache  # type: ignore[attr-defined]
    key = str(program_id)
    if key not in cache:
        cache[key] = Program.objects.filter(pk=program_id, is_closed=True).exists()
    return cache[key]


class IsProjectNotArchived(BasePermission):
    """Block writes to projects flagged ``is_archived=True`` (#530).

    Archived projects are hard read-only — every write across tasks, deps,
    members, settings, and nested resources must fail. Reads (SAFE_METHODS)
    always pass; the ``POST /projects/<pk>/unarchive/`` action is the explicit
    exception so an Owner can restore writes without first un-archiving via
    a back-channel.

    Apply alongside the existing role permission (``IsProjectMemberWrite``,
    ``IsProjectAdmin``, etc.) on every write-capable viewset — this class
    enforces lifecycle state, not authority.
    """

    message = "This project is archived and cannot be modified. Unarchive it first."

    # Action names on ProjectViewSet that must bypass the archived check —
    # otherwise an Owner could never unarchive (catch-22), delete, or restore the row.
    # NOTE: this is matched on the action *name* only, not the viewset class. It is safe
    # today because only ProjectViewSet applies IsProjectNotArchived to these actions;
    # a same-named action (e.g. ResourceViewSet.restore) is unaffected because that
    # viewset never includes IsProjectNotArchived. If a future viewset both applies this
    # permission AND names an action in this set, scope the check by viewset before then.
    _ARCHIVE_BYPASS_ACTIONS: frozenset[str] = frozenset(
        {"unarchive", "destroy", "archive", "restore"}
    )

    def has_permission(self, request: Request, view: APIView) -> bool:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        if getattr(view, "action", None) in self._ARCHIVE_BYPASS_ACTIONS:
            return True
        project_pk = _project_pk_from_view(view)
        if project_pk is None:
            # Top-level routes (ProjectViewSet) defer to has_object_permission.
            # DRF does not call has_object_permission on list/create, so a list
            # request never reaches the archived check — that's correct (listing
            # archived projects is read-only) and a create has no project yet.
            return True
        return not _is_project_archived(request, project_pk)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        if getattr(view, "action", None) in self._ARCHIVE_BYPASS_ACTIONS:
            return True
        from trueppm_api.apps.projects.models import Project

        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return True
        # Direct Project object: read the in-memory flag rather than re-querying.
        if isinstance(obj, Project):
            return not obj.is_archived
        return not _is_project_archived(request, project_id)


class IsProgramNotClosed(BasePermission):
    """Block writes to programs flagged ``is_closed=True`` (#530).

    Closed programs are read-only at the program shell (memberships, settings,
    ceremonies). Child projects are intentionally not gated by this check —
    they retain their own lifecycle and continue to accept writes.

    The ``POST /programs/<pk>/reopen/`` action bypasses the check; ``destroy``
    also bypasses (an Owner can delete a closed program directly).
    """

    message = "This program is closed and cannot be modified. Reopen it first."

    _CLOSE_BYPASS_ACTIONS: frozenset[str] = frozenset(
        {"reopen", "destroy", "close", "remove_sample"}
    )

    def has_permission(self, request: Request, view: APIView) -> bool:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        if getattr(view, "action", None) in self._CLOSE_BYPASS_ACTIONS:
            return True
        program_pk = _program_pk_from_view(view)
        if program_pk is None:
            return True
        return not _is_program_closed(request, program_pk)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        if getattr(view, "action", None) in self._CLOSE_BYPASS_ACTIONS:
            return True
        from trueppm_api.apps.projects.models import Program

        program_id = _get_program_id_from_obj(obj)
        if program_id is None:
            return True
        if isinstance(obj, Program):
            return not obj.is_closed
        return not _is_program_closed(request, program_id)


class IsOrgScheduler(BasePermission):
    """Org-level scheduler gate for the global skill catalog (#254).

    Skill and ResourceSkill catalogs are org-shared, not project-scoped. Their
    write intent is "SCHEDULER+ on at least one project" — equivalent to
    IsOrgAdmin's pattern but at the SCHEDULER floor instead of ADMIN.

    Django superusers bypass the membership check.
    """

    message = (
        "You need at least Resource Manager role on at least one project "
        "to manage the skill catalog."
    )

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not request.user or not request.user.is_authenticated:
            return False
        if request.user.is_superuser:
            return True
        return ProjectMembership.objects.filter(
            user=request.user,
            role__gte=Role.SCHEDULER,
            is_deleted=False,
        ).exists()


class IsOrgAdmin(BasePermission):
    """Org-level admin gate for the global resource catalog (issue #155).

    OSS has no separate org-admin entity. Admin authority is derived from
    project membership: any user with Project Manager (ADMIN, 3) or Owner
    (4) role on at least one project may manage the resource catalog.

    Django superusers bypass the membership check.

    Enterprise installs satisfy this check implicitly — their admins always
    have at least one project with ADMIN role. Enterprise-specific overrides
    (LDAP group claims, SAML attributes) are injected via signals/middleware
    before this check runs, so the OSS check remains correct as a baseline.
    """

    message = (
        "You need Project Manager role on at least one project to manage the resource catalog."
    )

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not request.user or not request.user.is_authenticated:
            return False
        if request.user.is_superuser:
            return True
        return ProjectMembership.objects.filter(
            user=request.user,
            role__gte=Role.ADMIN,
            is_deleted=False,
        ).exists()


class IsWorkspaceOperator(BasePermission):
    """Install-operator gate for workspace-global infrastructure config (#712).

    Stricter than :class:`IsOrgAdmin`. Some workspace settings — the outbound
    mail transport being the first — govern the *entire installation*, not one
    project. ``IsOrgAdmin`` grants write access off a single project's ADMIN
    role, which would let a low-trust project admin repoint every outbound
    message (including reset/invite mail) at an attacker relay (ADR-0213 C1).
    Mail-transport writes therefore require the install operator: a Django
    superuser. In OSS there is no separate org-operator entity, so superuser is
    the correct and only such principal; Enterprise may widen this via a
    registered override without changing the OSS baseline.
    """

    message = "Only a workspace operator (superuser) may change this setting."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated and request.user.is_superuser)


class CanAssignResource(BasePermission):
    """Allow Resource Manager (2) or above to assign resources to tasks.

    Stub — used by a future ResourceAssignment viewset (issue #14).
    """

    message = "You need at least Resource Manager role to assign resources."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        # Nested/object routes expose ``project_pk``: enforce the SCHEDULER floor
        # declaratively (mirrors IsProjectScheduler) so the gate is visible to
        # DRF-level audits and OpenAPI security generation. List-level creates
        # carry the project in the request body, which is not resolvable here —
        # ProjectResourceViewSet.perform_create enforces the same floor on that
        # path, and has_object_permission below covers detail mutations.
        project_pk = _project_pk_from_view(view)
        if project_pk is not None and request.method not in ("GET", "HEAD", "OPTIONS"):
            role = _membership_role(request, project_pk)
            return role is not None and role >= Role.SCHEDULER
        return True

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.SCHEDULER


class IsTokenForProject(BasePermission):
    """Verify that request.auth (an ApiToken) is authorized for the URL project.

    A project-scoped token (``token.project_id`` set) authorizes writes only to
    its bound project. A program-scoped token (``token.program_id`` set) authorizes
    writes to any project within that program — the URL project is checked
    against the program's ``projects.filter(pk=...).exists()`` membership.

    Raises AuthenticationFailed (401, not PermissionDenied/403) on mismatch
    so callers cannot enumerate whether the URL project exists — a project_id
    not covered by the token is indistinguishable from a project_id that does
    not exist at all.

    Returns True unconditionally when request.auth is not an ApiToken
    (i.e. JWT/Session requests) so the class is safely composable without
    side-effects on non-token views.

    Used on: TaskSyncView (token-authenticated inbound sync endpoint).
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        import uuid

        from rest_framework.exceptions import AuthenticationFailed

        from trueppm_api.apps.projects.models import ApiToken

        token = request.auth
        if not isinstance(token, ApiToken):
            return True  # Non-token auth path; other classes handle it.

        pk = view.kwargs.get("pk") or view.kwargs.get("project_pk")
        try:
            url_project_id = uuid.UUID(str(pk))
        except (TypeError, ValueError, AttributeError):
            raise AuthenticationFailed("Invalid project id.") from None

        # Project-scoped: direct FK match.
        if token.project_id is not None:
            if token.project_id != url_project_id:
                raise AuthenticationFailed("Token does not belong to this project.")
            return True

        # Program-scoped: project must be a member of the token's program.
        # The membership check runs against the live Project.program FK
        # (and not the soft-deleted projects) so a program-scoped token never
        # authorizes writes into a project that has been removed from the
        # program after the token was minted.
        if token.program_id is not None:
            from trueppm_api.apps.projects.models import Project

            if not Project.objects.filter(
                pk=url_project_id,
                program_id=token.program_id,
                is_deleted=False,
            ).exists():
                raise AuthenticationFailed("Token does not authorize this project.")
            return True

        # Defense in depth: the DB CheckConstraint guarantees at least one of
        # project_id / program_id is non-null. If we get here, the row is
        # corrupt; reject the token rather than fail open.
        raise AuthenticationFailed("Token has no scope.")


# ---------------------------------------------------------------------------
# API-token scopes (ADR-0186 §E — read-only MCP slice, issue #601)
# ---------------------------------------------------------------------------


def TokenHasScope(required_scope: str) -> type[BasePermission]:
    """Build a permission requiring an API token to carry ``required_scope``.

    A composable factory so the same rule works in a static ``permission_classes``
    list (``TokenHasScope("mcp:read")``) and inside ``get_permissions()``.

    Semantics:
      * If ``request.auth`` is not one of our API tokens (human JWT/Session
        request), the permission PASSES — scope enforcement only constrains
        token-authenticated callers; RBAC classes still gate the human path.
      * ``legacy:full`` is a superset: a token carrying it satisfies any read
        scope, preserving pre-scopes behavior for every backfilled token.
      * Otherwise the token must list ``required_scope`` explicitly.
    """

    class _TokenHasScope(BasePermission):
        def has_permission(self, request: Request, view: APIView) -> bool:
            from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL, ApiToken

            token = getattr(request, "auth", None)
            if not isinstance(token, ApiToken):
                return True  # Non-token auth path; RBAC classes handle it.

            token_scopes = token.scopes or []
            if required_scope in token_scopes:
                return True
            # legacy:full is the historical unrestricted superset — it satisfies
            # any read scope, but never substitutes for itself being required.
            return required_scope != SCOPE_LEGACY_FULL and SCOPE_LEGACY_FULL in token_scopes

    _TokenHasScope.__name__ = f"TokenHasScope[{required_scope}]"
    _TokenHasScope.__qualname__ = _TokenHasScope.__name__
    return _TokenHasScope


class TokenReadOnlyMethods(BasePermission):
    """Restrict API-token callers to safe (read-only) HTTP methods.

    Additively mixing token auth onto a ModelViewSet would otherwise expose its
    write actions to any token. This class closes that hole: a token may only
    issue GET/HEAD/OPTIONS on the views the MCP wraps. Human JWT/Session callers
    are unaffected (their write access is governed by the RBAC classes).
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.projects.models import ApiToken

        token = getattr(request, "auth", None)
        if not isinstance(token, ApiToken):
            return True
        return request.method in SAFE_METHODS


class TokenIsOwnerScoped(BasePermission):
    """Confine the MCP read surface to owner-scoped (personal) API tokens (#1712).

    Confused-deputy / blast-radius guard. A project- or program-scoped token is
    confined to its bound scope on the *write* path by ``IsTokenForProject`` (the
    URL project pk is checked against the token's project/program). That check has
    no analogue on the MCP *read* surface: the collection tools (``list_projects``,
    ``list_programs``, ``list_tasks``, ``/me/work/``) carry no project pk, so there
    is nothing to check the token against. Because a project/program token
    authenticates *as its human minter*, those tools would then return every
    project or program the minter can see — not just the one the token is bound to.
    A token minted to read a single project becomes a credential that reads the
    minter's entire membership: exactly the over-broad, hard-to-reason-about blast
    radius a scoped token is meant to prevent.

    The simplest correct policy (per #1712) is to accept ONLY owner-scoped
    (personal) tokens here and reject project/program tokens with a 401. A personal
    token *is* its owner, so DRF's own object-level RBAC already confines its reads
    to exactly what that user may see — there is no over-return to defend against.
    Project/program tokens keep their designed write/sync surface unchanged.

    Rejects with ``AuthenticationFailed`` (401, not 403) to match the rest of the
    token surface — a caller cannot distinguish "wrong token type" from "no such
    resource", preventing enumeration. Non-token callers (human JWT/Session) pass
    unconditionally; their access is governed by the view's RBAC classes.
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        from rest_framework.exceptions import AuthenticationFailed

        from trueppm_api.apps.projects.models import ApiToken

        token = getattr(request, "auth", None)
        if not isinstance(token, ApiToken):
            return True  # Non-token auth path; RBAC classes handle it.
        if token.owner_id is not None:
            return True
        raise AuthenticationFailed("Token is not authorized for the MCP read surface.")


if TYPE_CHECKING:
    _McpViewBase = APIView
else:
    _McpViewBase = object


class McpReadableViewMixin(_McpViewBase):
    """Additively expose a read view to ``mcp:read`` API tokens (ADR-0186 §E).

    Mixed in *before* the concrete view class so ``super()`` resolves to the real
    ``APIView``/``ViewSet``. It leaves the existing authentication and RBAC
    permission classes intact and only *adds*:

      * ``ProjectApiTokenAuthentication`` (prepended, so a ``tppm_`` bearer is
        recognized before JWT — which the auth class defers to for non-``tppm_``
        bearers), and
      * ``TokenReadOnlyMethods`` + ``TokenHasScope("mcp:read")`` (appended, so a
        token caller is confined to safe methods and must carry the read scope;
        human callers pass both trivially).

    The base type is ``APIView`` only under ``TYPE_CHECKING`` (``object`` at
    runtime) so mypy resolves ``super().get_authenticators()`` /
    ``get_permissions()`` without the mixin claiming to be a standalone view.
    """

    mcp_compute_heavy: bool = False
    """Set ``True`` on a subclass whose read triggers a CPM/Monte Carlo recompute.

    Adds the tighter :class:`~trueppm_api.apps.access.throttles.McpTokenComputeThrottle`
    bucket on top of the baseline per-token read throttle for the four compute-heavy
    tools — ``whatif``, ``monte-carlo/latest``, ``forecast``, ``sprint-forecast``
    (#1808 finding F4). Leave ``False`` for the cheap metadata reads.
    """

    def get_authenticators(self) -> list[BaseAuthentication]:
        from trueppm_api.apps.projects.authentication import (
            ProjectApiTokenAuthentication,
        )

        return [ProjectApiTokenAuthentication(), *super().get_authenticators()]

    def get_throttles(self) -> list[BaseThrottle]:
        """Add per-token MCP throttles without disturbing the view's own throttles.

        Token-authenticated reads on the MCP surface were unbounded (#1808 F4). The
        baseline :class:`McpTokenReadThrottle` bounds every MCP-readable view per
        token; compute-heavy views additionally stack
        :class:`McpTokenComputeThrottle`. Both are no-ops for human JWT/Session
        callers (their ``get_cache_key`` returns ``None``), so a view's existing
        throttles and the default ``user`` throttle keep governing human traffic.
        """
        from trueppm_api.apps.access.throttles import (
            McpTokenComputeThrottle,
            McpTokenReadThrottle,
        )

        throttles = list(super().get_throttles())
        throttles.append(McpTokenReadThrottle())
        if self.mcp_compute_heavy:
            throttles.append(McpTokenComputeThrottle())
        return throttles

    def mcp_token_guards(self) -> list[BasePermission]:
        """Read-only MCP token guards to append to a view's RBAC permission list.

        All three permissions pass unconditionally for human JWT/Session auth, so
        they are safe to append to *every* action's list. For an API-token caller
        they confine it to: safe methods (``TokenReadOnlyMethods``), the
        ``mcp:read`` scope (``TokenHasScope``), and — crucially — an owner-scoped
        (personal) token (``TokenIsOwnerScoped``). The owner-scoped guard closes
        the confused-deputy hole (#1712): a project/program token has no pk to
        check against on the collection tools, so without it a scoped token would
        read the minter's entire membership. ViewSets that override
        ``get_permissions`` with per-action lists call this from their wrapper so
        no branch — including write branches — can leak a token past the guards.
        """
        from trueppm_api.apps.projects.models import SCOPE_MCP_READ

        return [
            TokenReadOnlyMethods(),
            TokenHasScope(SCOPE_MCP_READ)(),
            TokenIsOwnerScoped(),
        ]

    def get_permissions(self) -> list[BasePermission]:
        # DRF instantiates each permission_class, so these are BasePermission
        # instances at runtime; the stub types them via a Protocol, hence the cast.
        existing = cast("list[BasePermission]", list(super().get_permissions()))
        return [*existing, *self.mcp_token_guards()]


# ---------------------------------------------------------------------------
# ProjectScopedViewSet mixin
# ---------------------------------------------------------------------------


class ProjectScopedViewSet(IdempotencyMixin, viewsets.GenericViewSet):  # type: ignore[type-arg]
    """Mixin that restricts every queryset to projects the user is a member of.

    Prevents IDOR: an unauthenticated or non-member request will receive an
    empty queryset rather than all objects in the database.

    Only active (non-soft-deleted) memberships grant queryset access (M1 fix).

    Subclasses should call super().get_queryset() and then apply additional
    filters on top of the membership-scoped queryset.

    Inherits IdempotencyMixin (ADR-0170) so every project-scoped mutation honors the
    Idempotency-Key header. The mixin precedes GenericViewSet in the MRO so its
    initial()/finalize_response()/handle_exception() overrides run inside the
    ATOMIC_REQUESTS transaction. Opt out with ``idempotency_exempt = True``.
    """

    def get_queryset(self) -> QuerySet[Any]:
        qs = super().get_queryset()
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return qs.none()

        member_project_ids = ProjectMembership.objects.filter(
            user=user,
            is_deleted=False,  # M1: exclude soft-deleted memberships
        ).values_list("project_id", flat=True)

        # Determine the project FK path. Projects are their own primary key.
        # Tasks, Dependencies, and other models have project_id or
        # predecessor__project_id.
        model = qs.model
        field_names = {f.name for f in model._meta.get_fields()}

        if "project" in field_names:
            return qs.filter(project_id__in=member_project_ids)
        if "predecessor" in field_names:
            # Dependency: filter through predecessor's project
            return qs.filter(predecessor__project_id__in=member_project_ids)
        # Project itself — filter by PK membership, excluding soft-deleted
        # projects. Without is_deleted=False a soft-deleted project still
        # resolves on retrieve/list/update/destroy (the membership row survives
        # the project's soft-delete), leaving a "zombie" project reachable at its
        # old URL — the same defect the explicit is_deleted=False guard prevents
        # on every other project lookup (#1111).
        if model.__name__ == "Project":
            return qs.filter(pk__in=member_project_ids, is_deleted=False)
        # Calendar and other non-project-scoped models: fall through unfiltered.
        # Calendars are org-level shared resources; scoping is documented as
        # intentional for the OSS single-tenant model (M2 decision: accept).
        return qs
