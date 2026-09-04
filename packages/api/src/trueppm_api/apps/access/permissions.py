"""DRF permission classes and ProjectScopedViewSet mixin for RBAC."""

from __future__ import annotations

import logging
from enum import StrEnum
from typing import TYPE_CHECKING, Any, ClassVar, cast

from django.db.models import QuerySet
from rest_framework import viewsets
from rest_framework.authentication import BaseAuthentication
from rest_framework.permissions import SAFE_METHODS, BasePermission
from rest_framework.request import Request
from rest_framework.throttling import BaseThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

logger = logging.getLogger(__name__)

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


#: Attribute names the per-request RBAC role caches live under. Read (never written)
#: by the OTel request-span annotator, which sources ``trueppm.user.role`` from them
#: so it costs no extra query — see ``observability/otel/request_attributes.py``.
RBAC_ROLE_CACHE_ATTR = "_rbac_role_cache"
PROGRAM_RBAC_ROLE_CACHE_ATTR = "_program_rbac_role_cache"


def _cache_host(request: Request) -> Any:
    """Return the object a per-request RBAC cache should be stored on.

    The underlying Django ``HttpRequest`` rather than the DRF ``Request`` wrapper.
    Lifetime and per-request identity are identical either way — DRF builds exactly
    one wrapper per ``HttpRequest`` — but only the Django request survives into
    ``process_response``, which is where OTel's Django ``response_hook`` runs and
    where ``trueppm.user.role`` is read from (#2880). Reads through the DRF wrapper
    keep working: DRF's ``Request.__getattr__`` proxies any unknown attribute to
    ``self._request``.
    """
    return getattr(request, "_request", request)


def _membership_role(request: Request, project_id: Any) -> int | None:
    """Return the requesting user's role ordinal for a project, or None if absent.

    Results are cached on the request object to prevent N+1 queries on list
    endpoints where has_object_permission is called once per row (L1 fix).
    The cache is keyed by str(project_id) and lives only for the request lifetime.

    Only active (non-soft-deleted) memberships are considered (M1 fix).
    """
    if not request.user or not request.user.is_authenticated:
        return None

    # Per-request cache, lazily initialised on the underlying Django request.
    host = _cache_host(request)
    cache: dict[str, int | None] | None = getattr(host, RBAC_ROLE_CACHE_ATTR, None)
    if cache is None:
        cache = {}
        setattr(host, RBAC_ROLE_CACHE_ATTR, cache)

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


def can_user_author_plan(request: Request, project: Any) -> bool:
    """Authoritative "may this user author a plan" predicate (ADR-0773 §2).

    Backs BOTH enforcement (:class:`IsProjectPlanAuthor` on the task-authoring
    endpoints) and the declarative ``ProjectSerializer.can_author`` field, so the
    Designer's Read/Author toggle reads the exact rule the server enforces — the
    ADR-0133 "one rule, called twice" pattern.

    The rule is ``role >= Role.MEMBER`` **minus the resource-management band**::

        role >= Role.MEMBER and not (Role.SCHEDULER <= role < Role.ADMIN)

    A plain ``role >= Role.MEMBER`` is wrong here, and the reason is a live defect
    rather than a hypothetical: ``Role.SCHEDULER`` (200) is ordinally *above* Member
    but :func:`can_user_edit_task` refuses it task content outright, while
    :class:`IsProjectMemberWrite` admits it. So a Scheduler can create a task and
    then cannot edit or delete the task they just created. Survivable in a modal —
    one task, one 403 — but in a keyboard-fast row grid it is a trap: the rows
    commit and every subsequent keystroke 403s. Author mode is therefore an explicit
    deny for the whole band, not an emergent property of a ``>=`` comparison.

    The band-range form (``Role.SCHEDULER <= role < Role.ADMIN``) rather than
    ``role == Role.SCHEDULER`` is required by ADR-0072's band contract: an
    Enterprise custom role registered in the 201-299 resource-management band
    inherits the same exclusion, instead of silently gaining authoring rights the
    OSS tier it sits beside does not have.

    This is a *project*-level capability — "may this user enter Author mode at all".
    It does not decide which rows they may touch; that stays with
    :func:`can_user_edit_task`, applied per row (ADR-0773 §3).

    Fails closed: unresolved auth, membership, or project yields ``False``.
    """
    if project is None:
        return False
    project_id = getattr(project, "pk", None)
    if project_id is None:
        return False
    return _can_author_plan_for_project_id(request, project_id)


def role_can_author_plan(role: int | None) -> bool:
    """The plan-authoring rule, as a pure function of the role ordinal (ADR-0773 §2).

    The single implementation. :func:`can_user_author_plan` and
    :class:`IsProjectPlanAuthor` resolve a role and call this; the serializer's
    ``can_author`` field calls it against the viewset's ``_my_role`` annotation so a
    project list does not pay a membership query per row. Mirrors the existing
    :func:`can_manage_backlog` ordinal-predicate shape.
    """
    if role is None:
        return False
    if Role.SCHEDULER <= role < Role.ADMIN:
        return False
    return role >= Role.MEMBER


def _can_author_plan_for_project_id(request: Request, project_id: Any) -> bool:
    """Resolve the caller's role on ``project_id`` and apply the authoring rule.

    Split out from :func:`can_user_author_plan` only so the permission class can
    reach it from a URL kwarg without loading a ``Project`` row it does not
    otherwise need.
    """
    if not (request.user and request.user.is_authenticated):
        return False
    if project_id is None:
        return False
    return role_can_author_plan(_membership_role(request, str(project_id)))


def role_can_undo_batch_operation(role: int | None) -> bool:
    """May this role reverse a recorded batch write? (ADR-0810, ADR-0773's undo matrix)

    Admin+, which is a **higher floor than the writes it reverses**: paste-many and
    the classification cascade are both ``IsProjectPlanAuthor`` (Member+ minus the
    resource-management band), so a Member can author a batch they may not undo.
    **Whether that asymmetry is right is OPEN — see #3355.** Do not read the floor
    here as settled, and in particular do not justify it with the sentence this
    docstring used to carry ("undoing removes work other collaborators may already be
    building on top of"). All three batch undos partition their snapshot on
    ``server_version`` via ``task_batch_services._partition_touched`` and write back
    only the untouched rows, reporting the rest as ``kept`` — so a row another
    collaborator has changed is left alone by construction and that hazard is
    unreachable. ADR-0880 §4 reached the same conclusion for structural undo (which
    *refuses* rather than skipping) and implements actor-or-Admin on it; ADR-0810
    says only "mirroring template-apply", and template-apply is symmetric
    (apply Admin+ *and* undo Admin+), so the asymmetry here came from copying half
    of a symmetric rule onto writes whose apply floor is Member+.

    What is settled, and is why this is a *shared* predicate rather than an inline
    comparison at each site: the apply endpoint has to tell the client which of the
    two floors the caller cleared, and a client that re-derives the rule drifts from
    it (#3304).

    A threshold, not a band exclusion, so the ADR-0072 band contract applies: an
    Enterprise custom role registered in the 301-399 project-lead band inherits it.
    Contrast :func:`role_can_author_plan`, whose rule genuinely is a band exclusion —
    which is why *that* one could never be a client-side ``>=`` and this one could.

    Fails closed: ``None`` (unresolved auth, or no membership) is ``False``.
    """
    return role is not None and role >= Role.ADMIN


def can_user_undo_batch_operation(request: Request, project_id: Any) -> bool:
    """Resolve the caller's role on ``project_id`` and apply the undo rule.

    Backs the declarative ``can_undo`` field on the classification cascade's own 200
    response. Enforcement calls :func:`role_can_undo_batch_operation` directly (from
    ``batch_operation_views._require_admin``, which already has the role in hand), so
    the two share the *predicate* rather than this wrapper — the ADR-0133 "one rule,
    called twice" pattern that ``can_author`` follows. Change the predicate, not
    either caller.

    Two honest limits on that guarantee, so nobody reads it as stronger than it is:

    - **The field is a snapshot, enforcement is live.** ``TaskClassificationView``
      carries ``IdempotencyMixin``, which stores the rendered body and replays it on
      a repeated ``Idempotency-Key`` without re-running the view; the request hash
      covers method, path and body, not the caller's role. So a caller demoted after
      a cascade can be replayed a stale ``can_undo: true`` inside the retention
      window. Harmless — the undo endpoint re-derives the role and still refuses —
      but the client's affordance is advisory, never the gate.
    - **Two sibling modules disagree about the floor.**
      ``csvimport.views._require_project_admin`` and
      ``template_views`` still inline the same comparison, and
      ``structural_operation_services`` deliberately implements *actor-or-Admin*
      instead, on the argument that the undo skips rows touched since. Whether the
      batch-undo floor should follow it is a real open question, not an oversight
      here; see #3304's follow-ups.
    """
    if not (request.user and request.user.is_authenticated):
        return False
    if project_id is None:
        return False
    return role_can_undo_batch_operation(_membership_role(request, str(project_id)))


def can_user_write_estimates(request: Request, project: Any) -> bool:
    """Authoritative "may this user write three-point estimates" predicate (ADR-0743).

    Backs BOTH enforcement (``TaskSerializer._validate_estimate_write_permitted``)
    and the declarative ``TaskSerializer.can_edit_estimates`` field, so the contract
    the client gates off cannot drift from the one the server enforces — the
    ADR-0133 "one rule, called twice" pattern.

    Only ``EstimationMode.PM_ONLY`` restricts *who* may write. It requires
    ``Role.ADMIN`` (Project Manager) or above:

    - ``Role.SCHEDULER`` is deliberately **not** admitted. It is labelled "Resource
      Manager" and :func:`can_user_edit_task` already refuses it task content
      outright, so admitting it would be unreachable. The ``PM_ONLY`` docstring
      formerly said "Scheduler-role", which is what made the wrong threshold look
      plausible (#2596).
    - The Product Owner facet (ADR-0078) is **not** admitted either. A PO below
      Admin may groom EPIC/STORY items, but writing a PERT duration is a scheduling
      act, not grooming, and ``PM_ONLY`` exists to reserve estimates to the PM.
    - ``>=`` (not ``==``) is required by ADR-0072's band contract: Enterprise custom
      roles registered at 301-399 are meant to inherit the Admin band's
      capabilities, exactly as :func:`can_user_edit_task` already grants them full
      task write.

    ``OPEN`` and ``SUGGEST_APPROVE`` place no role restriction here — under
    ``SUGGEST_APPROVE`` a Contributor write is *permitted* and lands ``pending``,
    withheld from Monte Carlo until approved (``scheduling/services.py``).

    Fails closed: unresolved auth, membership, or project yields ``False``.
    """
    if not (request.user and request.user.is_authenticated):
        return False
    if project is None:
        return False

    from trueppm_api.apps.projects.models import EstimationMode

    if getattr(project, "estimation_mode", None) != EstimationMode.PM_ONLY:
        return True

    role = _membership_role(request, str(project.pk))
    return role is not None and role >= Role.ADMIN


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


def _mark_policy_refusal(request: Request, constraint: str) -> None:
    """Record why an MCP guard is about to deny, for the response body (#2689).

    The guards keep returning ``False`` rather than raising: they are fail-closed
    by construction and that is not worth trading for a richer body. Marking is
    advisory — an unmarked denial still denies, just with DRF's generic detail,
    which is the pre-existing behavior. The envelope is attached centrally in
    :mod:`trueppm_api.core.exception_handlers`.
    """

    from trueppm_api.apps.agents.models import AgentActionRefusalReason
    from trueppm_api.apps.agents.refusal import mark_refusal

    mark_refusal(request, AgentActionRefusalReason.POLICY, constraint)


def _mark_identity_refusal(request: Request, constraint: str) -> None:
    """As :func:`_mark_policy_refusal`, for a refusal about the credential itself."""

    from trueppm_api.apps.agents.models import AgentActionRefusalReason
    from trueppm_api.apps.agents.refusal import mark_refusal

    mark_refusal(request, AgentActionRefusalReason.IDENTITY, constraint)


def _project_exists(project_pk: Any) -> bool:
    """Does this project id name a real, live project? (#2745)

    Used to keep an unknown id a **404** rather than a 403. `_membership_role`
    returns None for "no membership" and for "no such project" alike, so a
    permission class enforcing on a resolved kwarg would answer 403 to both — and
    22 endpoints publish a 404 for an unknown project in `docs/api/openapi.json`.
    Turning those into 403s would be an API contract change, made as a side effect
    of an internal permission fix rather than as a decision.

    So when the project does not exist the permission layer stands down and lets
    the view's own `get_object_or_404` answer. Nothing is exposed by that: there is
    no object to expose, and the view still runs its own object check for ids that
    DO resolve.

    Note what this deliberately does NOT change: an existing project the caller
    cannot see still answers 403 while an unknown id answers 404, so the pair
    remains distinguishable to a prober. That is the behavior on `main` today, it
    is unchanged here, and making it uniform is a separate decision — the two
    conventions already coexist in this codebase (`ProjectViewSet` hides existence
    behind a queryset filter and 404s instead). Widening this fix into that one
    would bury an API-visible security decision inside a resolver bugfix.

    Only reached on the deny path — a caller with a membership row never gets here —
    so the happy path costs no extra query.
    """
    from trueppm_api.apps.projects.models import Project

    return Project.objects.filter(pk=project_pk, is_deleted=False).exists()


#: Default URL kwarg naming the project. A view whose route spells it differently
#: overrides this with :attr:`project_url_kwarg` — see ``_project_pk_from_view``.
DEFAULT_PROJECT_URL_KWARG = "project_pk"


def _project_pk_from_view(view: APIView) -> Any | None:
    """Extract the project id from a view's URL kwargs.

    Nested routes spell it ``project_pk`` (``/projects/<project_pk>/task-runs/``) and
    resolve with no further ceremony. Routes that spell it differently declare the
    name on the view::

        class ProjectOverviewView(APIView):
            project_url_kwarg = "pk"   # route is projects/<pk>/overview/

    **Why the declaration, rather than also trying ``pk`` (#2745).** ``pk`` names the
    project on ``projects/<pk>/…`` and names something else entirely everywhere else —
    a dependency on ``/dependencies/<pk>/``, a task on ``/tasks/<pk>/``. A blanket
    alias would hand those ids to ``_membership_role``, which would find no membership
    and **deny** every legitimate request on those routes. The failure mode of guessing
    is worse than the fail-open it replaces: a silent no-op becomes a live outage. So
    the kwarg is named by the view that knows, and by nothing else.

    Returns None when the view declares no project kwarg and the route carries none —
    a genuinely top-level route. Callers fall through to per-class handling (e.g.
    ``ProjectViewSet`` retrieves rely on ``ProjectScopedViewSet`` to filter the
    queryset to member projects, and object-level checks run on detail routes).

    That None case is still permissive by design, and it is the reason this
    indirection has to stay declarative rather than clever: an unresolvable route is
    indistinguishable from an intentionally top-level one at this layer. What stops a
    route from silently rejoining the fail-open set is the route-table invariant in
    ``tests/apps/access/test_route_table_invariants.py`` (#2772), which asserts every
    project-identifying route enforces membership by *some* path and names the ones
    that do it in the view body.
    """
    declared = getattr(view, "project_url_kwarg", None)
    kwarg = declared if isinstance(declared, str) else DEFAULT_PROJECT_URL_KWARG
    # Only a real string counts. `getattr` on an object that synthesizes attributes
    # (a bare `MagicMock` view in a permission test is the live example) hands back a
    # truthy non-string, and `kwargs.get(<that>)` then misses every key and returns
    # None — which every caller reads as "not project-scoped" and fails OPEN. That is
    # this issue's own defect re-entering through its fix, so an unusable declaration
    # is treated as no declaration rather than trusted.
    project_pk = getattr(view, "kwargs", {}).get(kwarg)
    if project_pk is None:
        return None
    # Unknown id on a route that only started enforcing here → stand down and let
    # the view 404 (see `_project_exists`). Scoped to views that DECLARE the kwarg:
    # nested `project_pk` routes have always enforced at this layer and always
    # answered 403 for an unknown id, and this fix must not quietly restate their
    # contract too. Costs one indexed EXISTS on the ~30 declaring routes.
    if isinstance(declared, str) and not _project_exists(project_pk):
        return None
    return project_pk


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


class IsProjectPlanAuthor(BasePermission):
    """Declarative wrapper on :func:`can_user_author_plan` (ADR-0773 §(b)).

    Sits *alongside* ``IsProjectMemberWrite`` on the task-authoring endpoints rather
    than replacing it, per ADR-0184's additive doctrine: the permission class is
    defense-in-depth and OpenAPI-visible, while the in-body per-row checks
    (``can_user_edit_task``, ``_require_wbs_restructure_permission``) stay
    authoritative for *which rows* a caller may touch.

    Safe methods fall through to the read gate — Read mode is open to every project
    member including Viewer, so only writes consult the authoring predicate.

    Note this class is currently defense-in-depth rather than the load-bearing gate
    on ``<pk>``-routed ``APIView``s: ``_project_pk_from_view`` reads only
    ``project_pk``, so ``has_permission`` cannot resolve the project on a
    ``projects/<pk>/...`` route and falls through (#2745). The in-body
    ``check_object_permissions(request, project)`` call is what actually enforces
    this today, which is why the authoring views call it explicitly.
    """

    message = "Your role on this project cannot author the plan."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        project_pk = _project_pk_from_view(view)
        if project_pk is None:
            return True
        return _can_author_plan_for_project_id(request, project_pk)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return _membership_role(request, project_id) is not None
        return _can_author_plan_for_project_id(request, project_id)


class IsProjectMemberWriteOrOwn(BasePermission):
    """Assignee-scoped write permission for TaskViewSet update/destroy actions.

    Role matrix (issue #11; ordinals per ADR-0072, VIEWER moved to 1 in #2489):
      Viewer (1)             — read only
      Team Member (100)      — edit tasks where task.assignee == request.user
      Resource Manager (200) — read only (cannot edit task content, only assign)
      Project Manager (300+) — edit any task

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
        #
        # The task-restore action (#2078) is a POST but must gate exactly like
        # DELETE — un-deleting is a delete-class act, so the PO grooming facet
        # (which may edit but not delete an EPIC/STORY) must NOT grant restore.
        # Pass DELETE semantics so restore parity with destroy is exact.
        method = (
            "DELETE" if getattr(view, "action", None) == "restore" else (request.method or "PATCH")
        )
        return can_user_edit_task(request, obj, method=method)


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

    host = _cache_host(request)
    cache: dict[str, int | None] | None = getattr(host, PROGRAM_RBAC_ROLE_CACHE_ATTR, None)
    if cache is None:
        cache = {}
        setattr(host, PROGRAM_RBAC_ROLE_CACHE_ATTR, cache)

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
    have at least one project with ADMIN role.

    Note: this used to claim that enterprise overrides (LDAP group claims, SAML
    attributes) are "injected via signals/middleware before this check runs".
    No such seam exists (#2609). The membership-derived check above is the whole
    rule today. A documented-but-absent override point is worse than none, because
    an integrator builds against it and finds out at runtime.
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
    """Restrict *agent* API-token callers to safe (read-only) HTTP methods.

    Additively mixing token auth onto a ModelViewSet would otherwise expose its
    write actions to an agent token. This class closes that hole: an ``mcp:read``
    token may only issue GET/HEAD/OPTIONS on the views the MCP wraps, which is the
    published product promise for that scope and must not be weakened.

    Scoped to agent tokens, not to *all* tokens (#2877). A ``legacy:full`` personal
    access token is the owner's own credential on the general API surface (#2547),
    not an agent — refusing its writes 403'd every write to Task, Project, Risk,
    Sprint, Label, Program and Backlog while the docs and UI promised "reads and
    writes everything your account can." It passes here and is then governed by
    the view's ordinary RBAC classes against ``request.user = token.owner``, so it
    can never exceed its owner's own session. Human JWT/Session callers pass
    trivially. See :func:`~trueppm_api.apps.projects.models.is_agent_token` for why
    the predicate is "lacks ``legacy:full``" rather than "carries ``mcp:read``".
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.agents.models import RefusalConstraint
        from trueppm_api.apps.projects.models import is_agent_token

        if not is_agent_token(getattr(request, "auth", None)):
            return True
        if request.method in SAFE_METHODS:
            return True
        # "I minted a read-only token and pointed my write script at it" is the most
        # likely first-hour integration mistake, and a bare 403 is the least
        # diagnosable answer to it (#2878). capability_scope is disclosable: it
        # describes the caller's own credential, not any resource.
        _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
        return False


class IsNotTokenAuthenticated(BasePermission):
    """Refuse API-token callers on the credential-management surface (#2878).

    A leaked personal access token must not be able to *extend itself*. Without this
    guard a bearer-only caller reached ``/me/api-tokens/`` through the default
    authentication stack and could ``POST`` fresh siblings up to the 10-token cap,
    ``GET`` the owner's whole token inventory, and ``DELETE`` the owner's legitimate
    tokens to break their automations. Revoking the leaked token was therefore not
    containment — the attacker already held credentials the owner had never seen, and
    ``features/personal-access-tokens.md#revoking-a-token`` promises the opposite.
    GitHub blocks PAT-manages-PAT for the same reason.

    Applied to the whole surface rather than only its writes: the ``GET`` is the
    reconnaissance step (it names every sibling token, its scopes and its expiry),
    and there is no automation story for "my script enumerates my own credentials"
    that justifies leaving it open. Managing credentials requires being present —
    a session or a JWT.

    **What this covers, precisely.** API tokens (personal, project, program) and their
    audit logs, plus the per-user connected-account credential store. It does **not**
    cover every route that mints a durable grant of some kind: a leaked PAT belonging to
    a project Admin can still rotate a git-automation webhook secret or mint a public
    share link, and neither is revoked by password reset, off-boarding, or the
    ``revoke_api_tokens`` sweep (TODO(#2939)). So "revoke the token and you are
    contained" is true for the credential surface and not yet a whole-system property —
    say the narrower thing in operator docs until #2939 closes.

    **The predicate is ``request.auth``, and that is only sound because it runs as a
    permission.** An identity refusal is raised by the *authenticator*, so on that
    path ``request.auth`` is still ``None`` and this class never executes at all —
    DRF has already answered 401 before permissions are consulted. The 401 case is
    therefore covered by the authenticator, not here, and a test suite that only
    exercises live tokens (403) would prove nothing about it. Both paths are pinned
    in ``tests/apps/projects/test_token_management_is_session_only.py``.
    """

    message = "API tokens cannot manage API tokens. Sign in to create, list, or revoke tokens."

    def has_permission(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.agents.models import RefusalConstraint
        from trueppm_api.apps.projects.models import ApiToken

        if not isinstance(getattr(request, "auth", None), ApiToken):
            return True
        # Scope-blind on purpose, unlike the MCP guards (#2877): this is not an agent
        # control. *No* token of any scope may manage credentials, so asking about the
        # scope would only create a way to get the answer wrong.
        _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
        return False


class McpInstanceEnabled(BasePermission):
    """Instance-wide MCP kill switch (#2021, ADR-0497).

    When an operator sets ``TRUEPPM_MCP_ENABLED = False`` (env
    ``TRUEPPM_MCP_ENABLED``), every MCP-token read is denied at this single
    chokepoint — even though the token exists and carries ``mcp:read``. It is the
    "no agent access on this instance, period" lever a self-hosting operator
    (Persona 10) reaches for, mirroring the public-board-sharing kill switch
    (ADR-0245) but enforced at the mixin's one guard chokepoint rather than per
    view.

    Agent-scoped and fail-closed. A non-token (human JWT/Session) request PASSES
    unconditionally, so the switch never affects normal user auth on the same
    viewset; an agent token is DENIED (``False`` → 403) whenever the switch
    is off. Placed ahead of the scope checks so a disabled instance short-circuits
    them (only the credential-identity guard ``TokenIsOwnerScoped`` precedes it — see
    ``mcp_token_guards``). A denied read is still recorded as a ``POLICY`` refusal
    by the mixin's existing agent-action audit.

    A ``legacy:full`` personal access token also passes unconditionally (#2877).
    This switch is the operator's "no *agent* access on this instance" lever, and
    ``administration/mcp-server.md`` promises it affects "only agent (MCP token)
    traffic. People are never affected." A ``legacy:full`` PAT is a person's own CI
    script; blanking its reads made that sentence false and did so *silently* — a
    filtered collection returns ``count: 0``, indistinguishable from "no rows", so
    a nightly export wrote an empty file on a 200.
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        from django.conf import settings

        from trueppm_api.apps.agents.models import RefusalConstraint
        from trueppm_api.apps.projects.models import is_agent_token

        if not is_agent_token(getattr(request, "auth", None)):
            return True  # Human JWT/Session or the owner's own full-access PAT.
        # why: single operator chokepoint. When MCP is disabled instance-wide the
        # token still exists (and may carry mcp:read), but it must not grant agent
        # access. Denying here — before the scope/owner guards — fails closed for
        # the agent path only, leaving human auth on the same viewset untouched.
        if not bool(getattr(settings, "TRUEPPM_MCP_ENABLED", True)):
            _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
            return False
        return True


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

    **This guard deliberately stays keyed on the token's *type*, not its scope**,
    while the four guards around it became scope-aware in #2877. It is load-bearing
    that it did not follow them: project and program tokens carry ``legacy:full`` by
    *default* (``_default_api_token_scopes``), so a scope-aware version of this check
    would pass every one of them and re-open the exact #1712 confused-deputy hole —
    a token minted to read one project becoming a credential that reads its minter's
    entire membership, now with writes attached. The question this guard asks ("is
    this credential the human it acts as?") is orthogonal to the question
    :func:`~trueppm_api.apps.projects.models.is_agent_token` asks ("is this
    credential an agent?"), and conflating them fails open.

    Rejects with ``AuthenticationFailed`` (401, not 403) to match the rest of the
    token surface — a caller cannot distinguish "wrong token type" from "no such
    resource", preventing enumeration. Non-token callers (human JWT/Session) pass
    unconditionally; their access is governed by the view's RBAC classes.
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        from rest_framework.exceptions import AuthenticationFailed

        from trueppm_api.apps.agents.models import RefusalConstraint
        from trueppm_api.apps.projects.models import ApiToken

        token = getattr(request, "auth", None)
        if not isinstance(token, ApiToken):
            return True  # Non-token auth path; RBAC classes handle it.
        if token.owner_id is not None:
            return True
        # A project/program token on the read surface is refused for *what the
        # token is*, not for what it asked — token_identity, not capability_scope
        # (#2689). Both are disclosable: they describe the credential the caller
        # already holds.
        _mark_identity_refusal(request, RefusalConstraint.TOKEN_IDENTITY)
        raise AuthenticationFailed("Token is not authorized for the MCP read surface.")


class McpScope(StrEnum):
    """How an :class:`McpReadableViewMixin` subclass is scoped to a project (ADR-0678).

    Every subclass MUST declare one. The declaration is not documentation — it
    selects which enforcement mechanism carries the team-level MCP opt-out (#2482)
    for that view, and a subclass that declares nothing is **denied** to token
    callers by :class:`McpProjectEnabled`. A future MCP-readable view that forgets
    therefore fails *closed* rather than silently joining the agent-readable
    surface unfiltered.
    """

    PATH = "path"
    """Project is resolvable from the URL (``project_pk``/``project_id``, or a
    ``Project`` detail pk). :class:`McpProjectEnabled` denies 403 directly."""

    QUERYSET = "queryset"
    """Rows carry a project FK; the mixin's ``get_queryset`` excludes rows whose
    project has opted out. Detail routes resolve through the same filtered
    queryset, so an opted-out object 404s rather than leaking."""

    AGGREGATE = "aggregate"
    """The view spans projects and assembles its response by hand. The mixin still
    filters any queryset it has, but the view MUST additionally intersect its own
    reads with :func:`~trueppm_api.apps.projects.mcp_settings.mcp_visible_project_ids`.
    Weaker than the other three — the conformance test can only assert the helper
    is called, not that it is called correctly, so these views need direct tests."""

    NO_PROJECT_DATA = "none"
    """The response carries no project-scoped data at all (identity echo). Only
    ``MeView`` qualifies; adding a member here is a security decision."""


class McpProjectEnabled(BasePermission):
    """Team-level MCP opt-out enforcement point (ADR-0678, #2482).

    The consent counterpart to :class:`McpInstanceEnabled`: where that is the
    *operator's* instance-wide lever, this is the *team's* lever over reads of its
    own data — the answer to *"consent that only an admin can grant or revoke on
    the team's behalf is consent in name only"* (#2415).

    Agent-scoped and fail-closed, like every other guard here: a non-token (human
    JWT/Session) request — and a ``legacy:full`` personal access token, which is a
    person's own credential rather than an agent (#2877) — passes unconditionally,
    so nothing about normal user auth on the shared viewsets changes. For an agent
    token it denies when:

      * a scope above every project denies (workspace switch off — the instance
        switch is already short-circuited by :class:`McpInstanceEnabled` first), or
      * the view declares no :class:`McpScope` (declare-or-deny), or
      * the view is :attr:`McpScope.PATH` and its URL-resolved project has opted
        out — including the case where the project cannot be resolved at all,
        which is treated as a denial rather than a pass.

    ``QUERYSET`` / ``AGGREGATE`` / ``NO_PROJECT_DATA`` views pass here; their
    enforcement is row-level (see ``McpReadableViewMixin.get_queryset``) or
    explicit in the view. Because all guards are ANDed, this composes with the
    instance switch such that neither can override the other in the permissive
    direction — by construction, with no precedence logic to get wrong.
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.agents.models import RefusalConstraint
        from trueppm_api.apps.projects.mcp_settings import (
            mcp_reads_globally_disabled,
            resolve_mcp_enabled,
        )
        from trueppm_api.apps.projects.models import Project, is_agent_token

        if not is_agent_token(getattr(request, "auth", None)):
            return True  # Human JWT/Session or the owner's own full-access PAT.

        if mcp_reads_globally_disabled():
            _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
            return False

        scope = getattr(view, "mcp_scope", None)
        if scope is None:
            # Declare-or-deny: an MCP-readable view that never declared how it is
            # project-scoped is denied outright. A forgotten view fails closed.
            _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
            return False
        if scope != McpScope.PATH:
            # Row-level (QUERYSET) or view-explicit (AGGREGATE) enforcement; a
            # NO_PROJECT_DATA view exposes nothing to scope.
            return True

        view_kwargs = getattr(view, "kwargs", {}) or {}
        # Resolution order: the two nested-router conventions, then the view's
        # declared kwarg (default ``pk`` — the project-scoped APIViews are all
        # routed as ``projects/<pk>/...``). A PATH view whose ``pk`` is NOT a
        # project must override ``mcp_project_kwarg``; the per-view 403 tests are
        # what prove each one resolves correctly.
        project_kwarg = getattr(view, "mcp_project_kwarg", "pk")
        project_id = (
            view_kwargs.get("project_pk")
            or view_kwargs.get("project_id")
            or view_kwargs.get(project_kwarg)
        )
        if project_id is None:
            # A PATH view whose project could not be resolved is a declaration bug,
            # not a public read. Fail closed rather than admit an unscoped token.
            _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
            return False

        project = Project.objects.filter(pk=project_id).only("mcp_enabled", "program_id").first()
        if project is None:
            # Nonexistent/soft-deleted project — let the view's own 404 path answer;
            # there is no project data to protect.
            return True
        if not resolve_mcp_enabled(project):
            _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
            return False
        return True


class McpProgramExportConsent(BasePermission):
    """Refuse an agent a program bulk export when a member project opted out (#3014).

    The gap this closes: ``ProgramViewSet`` declares :attr:`McpScope.AGGREGATE`, so
    :class:`McpProjectEnabled` passes unconditionally, and the mixin's ``Program``
    branch in ``_mcp_filter_queryset`` governs only ``program.mcp_enabled``. Both
    program bulk exports — the synchronous JSON seed and the async ``.tar.gz``
    bundle — carry **every member project's rows verbatim**, so an ``mcp:read`` token
    could read through the parent exactly the data a child team had explicitly closed
    to agents. Read via the child's own endpoints, those rows are withheld; the
    export was the way around that.

    Applied to the two export reads only, and to **token callers only** — a human
    Admin's export is untouched under either policy, because ADR-0678 governs agents,
    not people. It is composed into ``ProgramViewSet._rbac_permissions()`` rather than
    into ``mcp_token_guards()``: the guards there apply to every action on the
    viewset, and this question is meaningful for exactly two of them.

    The behavior is chosen by ``TRUEPPM_MCP_PROGRAM_EXPORT_POLICY``, an operator
    setting — see :func:`~trueppm_api.apps.projects.mcp_settings.program_export_policy`
    for why it is deliberately not a workspace or program field.

    Marks the refusal as ``policy``/``capability_scope``, which reaches the caller
    through the ADR-0809 refusal envelope — an agent that cannot tell *why* it was
    refused makes the same call again.

    It does **not** currently reach the agent-action audit log, and that is a
    pre-existing defect of the substrate rather than of this guard: under
    ``ATOMIC_REQUESTS`` DRF's ``exception_handler`` calls ``set_rollback()`` for every
    ``APIException``, so the row ``finalize_response`` writes on a refusal path is
    discarded. **No** refusal from any guard is recorded today — measured, see #3017.
    Do not read ``finalize_response``'s docstring claim that it "commits" as fact.
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.agents.models import RefusalConstraint
        from trueppm_api.apps.projects.mcp_settings import program_export_withheld_from_agents
        from trueppm_api.apps.projects.models import Program, is_agent_token

        if not is_agent_token(getattr(request, "auth", None)):
            return True  # Human JWT/Session, or the owner's own full-access PAT.

        # The program is the detail pk on every route this guards. An unresolvable
        # id is left to the view's own 404 — there is no export to protect, and
        # answering 403 here would turn a nonexistent program into a distinguishable
        # one.
        view_kwargs = getattr(view, "kwargs", {}) or {}
        program_id = view_kwargs.get("pk")
        if program_id is None:
            return True
        program = Program.objects.filter(pk=program_id).only("pk").first()
        if program is None:
            return True

        if program_export_withheld_from_agents(program):
            _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
            return False
        return True


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

    mcp_scope: ClassVar[McpScope | None] = None
    """How this view is scoped to a project for the team MCP opt-out (ADR-0678).

    **Required on every subclass.** ``None`` means "undeclared", and
    :class:`McpProjectEnabled` denies token reads on an undeclared view — so
    forgetting this fails closed rather than exposing the view unfiltered. See
    :class:`McpScope` for which value to pick.
    """

    mcp_project_kwarg: ClassVar[str] = "pk"
    """URL kwarg holding the project id, for :attr:`McpScope.PATH` views.

    ``project_pk`` and ``project_id`` are always tried first (the nested-router
    conventions). The default ``pk`` covers the project-scoped ``APIView``s, which
    are all routed as ``projects/<pk>/...``. Override on a PATH view whose ``pk``
    is some other entity — otherwise its opt-out check would read the wrong id.
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
        """MCP agent-token guards to append to a view's RBAC permission list.

        All five pass unconditionally for human JWT/Session auth, so they are safe
        to append to *every* action's list. For an **agent** token they confine it
        to: the instance MCP switch being on (``McpInstanceEnabled``, placed first
        so a disabled instance short-circuits everything else), the team's consent
        (``McpProjectEnabled``), safe methods (``TokenReadOnlyMethods``), and the
        ``mcp:read`` scope (``TokenHasScope``). ViewSets that override
        ``get_permissions`` with per-action lists call this from their wrapper so no
        branch — including write branches — can leak a token past the guards.

        Two of the five have a wider reach than "agent", on purpose:

        * ``TokenHasScope("mcp:read")`` is satisfied by ``legacy:full`` as a read
          superset, so a full-access PAT is not stopped by it;
        * ``TokenIsOwnerScoped`` applies to **every** ``ApiToken`` regardless of
          scope, and must — it closes the confused-deputy hole (#1712) that
          project/program tokens (which default to ``legacy:full``) would otherwise
          walk straight through.

        ``TokenIsOwnerScoped`` is **first** since #2877. Before, it was
        defense-in-depth *behind* ``TokenReadOnlyMethods``, which refused every token
        an unsafe method; now that ``TokenReadOnlyMethods`` passes ``legacy:full``, it
        is the sole barrier between a project/program token and a write here. Ordering
        it first makes that structural: the question "is this credential the human it
        acts as?" is answered before any capability question, the way
        ``McpInstanceEnabled`` used to be first for the operator's question. Outcomes
        are unchanged — DRF ANDs the list — but a project/program token now gets its
        401 from the guard that is actually deciding, rather than a 403 from whichever
        capability check happened to be consulted first.
        """
        from trueppm_api.apps.projects.models import SCOPE_MCP_READ

        return [
            TokenIsOwnerScoped(),
            McpInstanceEnabled(),
            McpProjectEnabled(),
            TokenReadOnlyMethods(),
            TokenHasScope(SCOPE_MCP_READ)(),
        ]

    def get_permissions(self) -> list[BasePermission]:
        # DRF instantiates each permission_class, so these are BasePermission
        # instances at runtime; the stub types them via a Protocol, hence the cast.
        existing = cast("list[BasePermission]", list(super().get_permissions()))
        return [*existing, *self.mcp_token_guards()]

    def filter_queryset(self, queryset: QuerySet[Any]) -> QuerySet[Any]:
        """Primary collection-level enforcement point for the MCP opt-out (ADR-0678).

        why here and not only in ``get_queryset``: **three of the eight
        queryset-backed MCP viewsets build their queryset from scratch rather than
        calling ``super().get_queryset()``** (``ProgramViewSet``,
        ``BacklogItemViewSet``, ``MeWorkView``). For those, a ``get_queryset``
        override on this mixin is never reached — the filter would silently fail
        *open* on exactly the collections that need it most. DRF calls
        ``filter_queryset()`` from both ``ListModelMixin.list()`` and
        ``GenericAPIView.get_object()`` regardless of how the queryset was built, and
        no MCP-readable view overrides it, so this is the one hook every list and
        detail read passes through.

        ``get_queryset`` below *also* filters, for the five viewsets that do chain to
        super and for actions that read ``self.get_queryset()`` directly without
        going through ``filter_queryset`` (e.g. ``ProjectViewSet.health_summary``).
        Double-filtering is harmless — the narrowing is idempotent.
        """
        qs = cast("QuerySet[Any]", super().filter_queryset(queryset))  # type: ignore[misc]
        if self.mcp_scope in (None, McpScope.NO_PROJECT_DATA):
            return qs
        return self._mcp_filter_queryset(qs)

    def get_queryset(self) -> QuerySet[Any]:
        """Exclude rows whose project has opted out of agent reads (ADR-0678, #2482).

        This is the collection-level half of the enforcement point. The guard
        (:class:`McpProjectEnabled`) can only see a project that appears in the URL,
        which is ``None`` for every list endpoint — so a guard-only opt-out would be
        bypassed by any collection carrying the project as a query param
        (``/tasks/?project=X``), the same confused-deputy shape #1712 closed. Row
        filtering here closes it for all eleven queryset-backed MCP views at once.

        Applies to token callers only, so human JWT/Session reads on the same
        viewset are untouched. Runs *after* ``super().get_queryset()`` — which for a
        ``ProjectScopedViewSet`` is the membership filter — so MCP consent narrows
        an already-membership-scoped queryset and can never widen it. Detail routes
        resolve through this same queryset, so an opted-out object 404s.
        """
        qs = cast("QuerySet[Any]", super().get_queryset())  # type: ignore[misc]
        if self.mcp_scope in (None, McpScope.NO_PROJECT_DATA):
            return qs
        return self._mcp_filter_queryset(qs)

    def _mcp_filter_queryset(self, qs: QuerySet[Any]) -> QuerySet[Any]:
        """Narrow ``qs`` to projects readable by this agent token, or return it as-is.

        Resolves the project relation the same way ``ProjectScopedViewSet`` does
        (``project`` FK → ``predecessor__project`` → the ``Project`` row itself), so
        the two stay consistent and a model with an unusual shape is handled in one
        place. A model with no reachable project relation is returned unfiltered —
        it holds no project-scoped rows to withhold.
        """
        from trueppm_api.apps.projects.mcp_settings import mcp_visible_project_ids

        request = getattr(self, "request", None)
        if request is None:
            return qs
        visible = mcp_visible_project_ids(request)
        if visible is None:
            # Not a token caller, or no project on the instance has opted out.
            return qs

        model = qs.model
        field_names = {f.name for f in model._meta.get_fields()}
        if "project" in field_names:
            filtered = qs.filter(project_id__in=visible)
        elif "predecessor" in field_names:
            filtered = qs.filter(predecessor__project_id__in=visible)
        elif model.__name__ == "Project":
            filtered = qs.filter(pk__in=visible)
        elif model.__name__ == "Program":
            # A program is withheld only when the program itself denied; its
            # projects are filtered on their own endpoints. Reading the program row
            # is not reading a project's data.
            #
            # The reasoning does not hold for the two program BULK EXPORTS
            # (``ProgramViewSet.export`` and ``export_job_download``), which carry
            # every member project's rows verbatim in one artifact this branch
            # cannot narrow. Those are governed separately by
            # ``McpProgramExportConsent`` (#3014); this branch is not their ruling.
            filtered = qs.exclude(mcp_enabled=False)
        elif "program" in field_names:
            # Program-owned rows with no project FK (the program backlog pool).
            # Governed by the program's own denial — a child project's opt-out does
            # not withhold program-level intake data it does not own.
            filtered = qs.exclude(program__mcp_enabled=False)
        else:
            return qs

        # Record that something was withheld so the audit row is not an unqualified
        # "allowed" (ADR-0678 T8). Set as a flag, not a count: counting would cost a
        # second aggregate query on every filtered read.
        request._mcp_scope_filtered = True
        return filtered

    def finalize_response(self, request: Request, response: Any, *args: Any, **kwargs: Any) -> Any:
        """Record the per-action agent audit for a token-authenticated MCP read (#1805).

        ``finalize_response`` runs exactly once per request for **both** a successful
        read and a DRF-handled refusal (auth/permission exceptions are turned into
        responses, so this still runs). It is therefore the single point where an
        ``allowed`` read and a ``policy`` refusal are both audited exactly once
        (ADR-0112 RC1).

        The two halves reach the database by different routes, and must (#3017,
        ADR-0902):

        * an **allowed** read is written inline and fail-closed — if
          ``record_agent_action`` cannot persist, the exception propagates and the
          request rolls back, because an audit substrate must never serve an un-audited
          read;
        * a **refusal** is *queued*, not written. This method runs inside the
          ATOMIC_REQUESTS transaction, and DRF's ``exception_handler`` has already
          called ``set_rollback()`` for the exception that produced the 4xx — so an
          INSERT issued here would execute and then be discarded. It is drained by
          ``AgentActionAuditMiddleware`` once that transaction has closed.

        Until #3017 this docstring claimed the refusal path "commits". It did not, and
        the log held zero refusals of any kind as a result.
        """

        response = super().finalize_response(request, response, *args, **kwargs)
        self._record_mcp_agent_action(request, response)
        return response

    def _record_mcp_agent_action(self, request: Request, response: Any) -> None:
        from trueppm_api.apps.projects.models import ProjectApiToken, is_agent_token

        # Only an *agent*-token call is an agent action. A human JWT/session read on
        # the same view is not audited. ``successful_authenticator is None`` covers
        # both "auth failed" and "anonymous"; guarding on it also means we never touch
        # ``request.auth`` in a way that could re-trigger (and re-raise) a failed
        # authentication inside finalize_response. (Identity refusals — a revoked/expired
        # token — are audited in the authenticator, which still has the token context.)
        #
        # ``successful_authenticator`` is a *lazy* DRF property: if authentication was
        # never attempted this request, reading it runs ``_authenticate()`` for the
        # first time right here. That happens when an exception is raised in
        # ``initial()`` *before* ``perform_authentication()`` — e.g. an unsupported URL
        # format suffix (``/projects/0.5/`` parses as pk="0", format="5") fails content
        # negotiation first. DRF's exception_handler has already called
        # ``set_rollback()`` for that exception by the time we get here, so triggering
        # authentication's own DB lookup (``JWTAuthentication.get_user()``) now raises
        # ``TransactionManagementError`` instead of returning cleanly (#2989). Check
        # ``_authenticator`` first — DRF sets it (to an authenticator or ``None``)
        # on every *attempted* authentication, so its absence means one never ran, and
        # a request that was never authenticated is not an authenticated agent-token
        # call either way.
        if not hasattr(request, "_authenticator"):
            return
        if getattr(request, "successful_authenticator", None) is None:
            return
        token = getattr(request, "auth", None)
        if not isinstance(token, ProjectApiToken):
            return

        status_code = getattr(response, "status_code", 200)
        # A non-agent token's *successful* read is not agent activity and is not recorded
        # (#2877). The row would say otherwise on three fields at once —
        # ``actor_kind=MCP_TOKEN``, ``capability_used=mcp:read``, and a summary reading
        # "MCP POST …" — so logging a person's CI script there is the same inverted trail
        # #2878 filed against the revocation log. It would also half-close #2749
        # (governing ``legacy:full`` token writes, 0.5) on eight viewsets while leaving
        # the ~260 other token-writable routes in
        # ``tests/apps/access/token_write_surface.txt`` unrecorded, and a partial ledger
        # is worse than a documented gap because it reads as complete.
        #
        # A **refusal** is not scope-filtered, and the asymmetry is deliberate even
        # though it is inert today. Project and program tokens carry ``legacy:full`` by
        # default, so a scope-only test here would exclude exactly the event most worth
        # keeping: a scoped integration credential walked against the collection tools
        # (``/me/work/``, ``/me/search``, ``/workspace/assets``) to turn a one-project
        # token into a read of its minter's whole membership — the #1712 confused-deputy
        # attempt.
        #
        # This predicate was written while the branch below it was inert: every
        # permission-layer refusal reached a write whose INSERT ``set_rollback()`` then
        # discarded, so no refusal row survived and the asymmetry could not be observed.
        # #3017 supplied the out-of-transaction write the earlier note anticipated (the
        # refusal is queued and drained by ``AgentActionAuditMiddleware``), so the
        # predicate is now load-bearing rather than aspirational — a scoped token walked
        # against the collection tools is recorded.
        if status_code < 400 and not is_agent_token(token):
            return

        from trueppm_api.apps.agents.deferred import queue_agent_action
        from trueppm_api.apps.agents.models import (
            AgentActionRefusalReason,
            AgentActionVerdict,
            AgentActorKind,
            RefusalConstraint,
        )
        from trueppm_api.apps.agents.services import (
            hash_request_payload,
            record_agent_action,
        )
        from trueppm_api.apps.projects.models import SCOPE_MCP_READ

        status = status_code
        allowed = status < 400
        if status >= 500:
            # A server error is not a refusal. The taxonomy has no ERROR verdict, so the
            # only row this code could write says refused/policy/capability_scope — i.e.
            # "a guard denied you", about a request no guard ever ruled on. That was
            # latent while every refusal row was rolled back (#3017); now that they
            # persist, writing it would put a false denial in the operator's log and
            # inflate the exact signal the log exists to carry. Recorded as nothing
            # until the enum grows an error member.
            return
        verdict = AgentActionVerdict.ALLOWED if allowed else AgentActionVerdict.REFUSED
        # An authenticated token rejected by an MCP guard is a *policy* refusal (the
        # actor is known; a capability/scope check denied it). The finer constraint
        # (ADR-0421, #1850) is capability_scope — an MCP-scope denial carries no schedule
        # projected impact, so its side-car impact stays empty.
        refusal_reason = "" if allowed else AgentActionRefusalReason.POLICY
        refusal_constraint = "" if allowed else RefusalConstraint.CAPABILITY_SCOPE
        if not allowed:
            # Prefer what the guard that actually denied recorded (#2689). The
            # response body is built from the same marks, so the wire and the
            # audit row can never disagree about why a call was refused — which
            # they would if this kept assuming capability_scope while the caller
            # was told token_identity.
            from trueppm_api.apps.agents.refusal import refusal_marks

            marks = refusal_marks(request)
            if marks is not None:
                marked_reason, marked_constraint = marks
                refusal_reason = marked_reason or refusal_reason
                refusal_constraint = marked_constraint or refusal_constraint

        action, object_type, object_id, project_id = self._mcp_audit_target(request)
        summary = f"MCP {request.method} {action}"
        if not allowed:
            summary += f" — refused ({status})"
        elif getattr(request, "_mcp_scope_filtered", False):
            # ADR-0678 T8: a collection read that had opted-out projects filtered out
            # returns 200, so it would otherwise be recorded as an unqualified
            # "allowed". Mark it so the Agents panel (#2481) shows a scoped read for
            # what it is. Verdict stays ALLOWED deliberately — adding a PARTIAL member
            # to AgentActionVerdict is a breaking enum change consumed by the shipped
            # web client (tracked as follow-up, not smuggled into 0.4).
            summary += " — consent-scoped (opted-out projects withheld)"

        audit_kwargs: dict[str, Any] = {
            "actor_kind": AgentActorKind.MCP_TOKEN,
            "actor_token": token,
            "principal": token.owner,
            "action": action,
            "method": request.method or "",
            "capability_used": SCOPE_MCP_READ,
            "verdict": verdict,
            "refusal_reason": refusal_reason,
            "refusal_constraint": refusal_constraint,
            "object_type": object_type,
            "object_id": object_id,
            "project_id": project_id,
            "payload_hash": hash_request_payload(request),
            "summary": summary,
            "source_ip": _mcp_client_ip(request),
        }
        # Stamped now either way: the span is the *current* request's, and on the
        # deferred path it may well have ended by the time the queue drains.
        _set_agent_span_attributes(token, str(verdict))

        if allowed:
            # Fail-closed, and inline for that reason: a successful read that we could
            # not audit must not be served, so the write shares the read's transaction —
            # it raises, ATOMIC_REQUESTS rolls back, and the request 500s. This is the
            # one case where being inside the request transaction is the point.
            record_agent_action(**audit_kwargs)
            return

        # A refusal cannot be written here at all. DRF's exception_handler has already
        # called set_rollback() for the APIException that produced this 4xx, so an INSERT
        # issued now executes and is then discarded when the request transaction unwinds —
        # which is exactly why this log contained only successes (#3017). Queue it for
        # AgentActionAuditMiddleware, which runs after ATOMIC_REQUESTS has closed.
        queue_agent_action(request, **audit_kwargs)

    def _mcp_audit_target(self, request: Request) -> tuple[str, str, str, Any | None]:
        """Best-effort ``(action, object_type, object_id, project_id)`` for the audit row.

        Total by construction — never raises, so a metadata edge case cannot 500 a read
        (only the DB write itself is fail-closed).
        """

        match = getattr(request, "resolver_match", None)
        action = ""
        if match is not None:
            action = match.view_name or match.url_name or ""
        action = action or type(self).__name__

        view_kwargs = getattr(self, "kwargs", {}) or {}
        object_id = str(view_kwargs.get("pk") or "")
        project_id = view_kwargs.get("project_pk") or view_kwargs.get("project_id") or None

        object_type = ""
        queryset = getattr(self, "queryset", None)
        model = getattr(queryset, "model", None)
        if model is not None:
            object_type = model.__name__
            # A retrieve on the Project view: the object *is* the project.
            if project_id is None and object_type == "Project" and object_id:
                project_id = object_id

        return action, object_type, object_id, project_id


def _mcp_client_ip(request: Request) -> str | None:
    """Client IP for the audit row: leftmost X-Forwarded-For hop, else REMOTE_ADDR."""

    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    if xff:
        return xff.split(",")[0].strip() or None
    return request.META.get("REMOTE_ADDR") or None


def _set_agent_span_attributes(token: Any, verdict: str) -> None:
    """Attach agent attributes to the current span — best-effort (never breaks a read)."""

    try:
        from opentelemetry import trace

        from trueppm_api.apps.observability.otel import attributes as attrs

        span = trace.get_current_span()
        if span is None:
            return
        span.set_attribute(attrs.AGENT_TOKEN_PREFIX, token.token_prefix)
        span.set_attribute(attrs.AGENT_CAPABILITY, "mcp:read")
        span.set_attribute(attrs.AGENT_ACTOR_KIND, "mcp_token")
        span.set_attribute(attrs.AGENT_VERDICT, verdict)
    except Exception:
        # Telemetry is best-effort; a span/exporter hiccup must not fail an audited read.
        pass


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
