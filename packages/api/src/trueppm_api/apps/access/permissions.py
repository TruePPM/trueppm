"""DRF permission classes and ProjectScopedViewSet mixin for RBAC."""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet
from rest_framework import viewsets
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
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
        role = _membership_role(request, project_id)
        if role is None:
            return False

        # Safe methods: any project member may read
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True

        # Project Manager (3) and Project Admin (4): full write on any task
        if role >= Role.ADMIN:
            return True

        # Product Owner facet (ADR-0078 / #1095): the PO owns the backlog and may
        # EDIT its EPIC/STORY work items below Admin and regardless of task
        # assignment — otherwise the PM outranks them on their own backlog. Scoped
        # tightly: (1) only EPIC/STORY work items, so the facet never widens write
        # access to schedule tasks/milestones; (2) edits only, never DELETE — removing
        # another member's story stays an Admin/assignee act (this wave needs grooming,
        # not deletion). The TaskSerializer's structural gate further confines the
        # PO-only fields (type, epic links, scoring inputs) to PO/Admin within those.
        from trueppm_api.apps.projects.models import TaskType
        from trueppm_api.apps.teams.services import has_team_facet

        if (
            request.method != "DELETE"
            and getattr(obj, "type", None) in (TaskType.EPIC, TaskType.STORY)
            and has_team_facet(request.user, project_id, "is_product_owner")
        ):
            return True

        # Resource Manager (2): cannot edit task content (only resource assignment)
        if role == Role.SCHEDULER:
            return False

        # Team Member (1): may only edit their own assigned tasks
        if role == Role.MEMBER:
            assignee_id = getattr(obj, "assignee_id", None)
            return assignee_id is not None and assignee_id == request.user.pk

        # Viewer (0): no writes
        return False


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
    # otherwise an Owner could never unarchive (catch-22) or delete the row.
    _ARCHIVE_BYPASS_ACTIONS: frozenset[str] = frozenset({"unarchive", "destroy", "archive"})

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
# ProjectScopedViewSet mixin
# ---------------------------------------------------------------------------


class ProjectScopedViewSet(IdempotencyMixin, viewsets.GenericViewSet):  # type: ignore[type-arg]
    """Mixin that restricts every queryset to projects the user is a member of.

    Prevents IDOR: an unauthenticated or non-member request will receive an
    empty queryset rather than all objects in the database.

    Only active (non-soft-deleted) memberships grant queryset access (M1 fix).

    Subclasses should call super().get_queryset() and then apply additional
    filters on top of the membership-scoped queryset.

    Inherits IdempotencyMixin (ADR-0083) so every project-scoped mutation honors the
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
