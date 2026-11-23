"""Agent capability scope: the per-agent grant and its per-call intersection (#4814).

A *controlled agent* is an owner-scoped API token that carries ``mcp:read`` and not
the full scope (:func:`is_controlled_agent`). It acts for exactly one person, its
owner (the *principal*). Its capability scope is a grant of one level per
**area**, on the ladder ``none < read < propose < write``:

* ``read`` — the agent may read the area on the MCP surface;
* ``propose`` — shown in the UI as **Dry run**: the grant is stored and capped now, but
  nothing consumes it yet. It takes effect when plan mode (#1813) ships, which will
  let the agent ask what a change would do without changing anything;
* ``write`` — the committing write path. It ships in 0.6, so it is **not grantable** in
  0.5, and that refusal is enforced here on the server, not by the disabled UI cell.

Lives in ``projects`` (beside ``ApiToken``, whose columns hold the grant and the pause
flag) rather than in ``agents`` so the MCP guards in ``access`` can read it without an
upward import (``app-layering.toml``).

Two properties carry the threat model on #4814:

1. **Effective scope = grant ∩ the principal's current permissions, evaluated per
   call.** Nothing here is cached: :func:`effective_scope` reads the principal's live
   memberships every time it runs, so demoting the principal shrinks the agent on the
   next call. For ``read`` the intersection is also structural — the token resolves
   ``request.user`` to its owner, so every view's own RBAC still applies.
2. **An edit can never raise a grant above the principal.** :func:`validate_grant`
   caps every raised area at the principal's ceiling at edit time, whoever makes the
   edit — a workspace admin editing someone else's agent cannot grant above that
   person. A stored level left above the ceiling by a later demotion stays stored (and
   capped by property 1) until someone lowers it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeGuard

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import ApiToken

#: Areas of the scope matrix, in display order.
AGENT_AREAS: tuple[str, ...] = ("schedule", "dependencies", "resources", "baselines")

#: Human labels for each area (the API echoes these so the UI never invents them).
AGENT_AREA_LABELS: dict[str, str] = {
    "schedule": "Schedule & tasks",
    "dependencies": "Dependencies",
    "resources": "Resources",
    "baselines": "Baselines",
}

LEVEL_NONE = "none"
LEVEL_READ = "read"
LEVEL_PROPOSE = "propose"
LEVEL_WRITE = "write"

#: The level ladder; a higher level implies every lower one.
AGENT_LEVELS: tuple[str, ...] = (LEVEL_NONE, LEVEL_READ, LEVEL_PROPOSE, LEVEL_WRITE)
_RANK = {level: rank for rank, level in enumerate(AGENT_LEVELS)}

#: Levels a grant may hold in this release. ``write`` is the 0.6 committing path.
GRANTABLE_LEVELS: frozenset[str] = frozenset({LEVEL_NONE, LEVEL_READ, LEVEL_PROPOSE})

#: The grant a token carries when it has never been edited: read on every area. This
#: is exactly what an ``mcp:read`` token could do before scopes existed, so an existing
#: agent keeps working unchanged after the upgrade.
DEFAULT_GRANT: dict[str, str] = dict.fromkeys(AGENT_AREAS, LEVEL_READ)

#: Refusal constraint code for a paused agent. ``RefusalConstraint.AGENT_PAUSED`` in the
#: ``agents`` app is defined from this constant so the two can never disagree; it lives
#: here because the guard that emits it is in ``access``, below ``agents``.
AGENT_PAUSED_CONSTRAINT = "agent_paused"

#: What a paused agent is told. Deliberately generic (threat model on #4814): an agent
#: may relay what it receives to third parties, so it never names the person who paused
#: it. The named detail ("Paused by …") is human UI only.
AGENT_PAUSED_MESSAGE = "This agent is paused. Ask the person it acts for to resume it."

#: What an agent refused for scope is told. Names the area only, which describes the
#: agent's own grant and nothing about the data it asked for.
AGENT_SCOPE_MESSAGE = "This agent's capability scope does not include reading {area}."

# The lowest project role (``access.models.Role`` ordinal) whose holder could make the
# write a dry run previews, per area. Kept as ordinals so this module needs no import of
# ``access`` at load time. MEMBER=100 edits own tasks, SCHEDULER=200 assigns resources,
# ADMIN=300 edits dependencies and creates baselines.
_PROPOSE_FLOOR: dict[str, int] = {
    "schedule": 100,
    "dependencies": 300,
    "resources": 200,
    "baselines": 300,
}

#: What each area governs on the MCP read surface, in words the Agents page shows next
#: to the matrix. Kept beside the enforcement so the two change together, and pinned
#: against the real URL resolver by ``test_every_area_governs_a_routed_mcp_view``.
AGENT_AREA_COVERS: dict[str, str] = {
    "schedule": (
        "Projects, programs, tasks, phases, sprints, risks, labels, custom fields, "
        "acceptance criteria, history, status updates, forecasts, Monte Carlo, My Work "
        "and search. Task-level summaries such as predecessor counts and readiness stay "
        "here."
    ),
    "dependencies": (
        "Dependency links between tasks, the driving chain, and the derivation that "
        "explains a computed date."
    ),
    "resources": (
        "Project cost and rates, utilization, resource allocation, the resource heat map "
        "and summary, and the resource assignments and overallocation flags on each task "
        "(left out of task reads without this area)."
    ),
    "baselines": "Baselines and their task snapshots.",
}

#: Task fields that carry resource data. A task read by an agent without ``resources``
#: read drops them (:func:`strip_resource_task_fields`), the way the blocker reason is
#: dropped for an unauthorized reader: the rest of the task is schedule data.
RESOURCE_TASK_FIELDS: tuple[str, ...] = (
    "assignments",
    "assignee_is_overallocated",
    "assignee_load_includes_estimate",
)

# Model names whose reads belong to an area other than the default ``schedule``. Every
# MCP-readable view resolves to an area through ``agent_action_areas`` (per viewset
# action), ``agent_area`` (per view), or its queryset model; a view with none of those
# falls into ``schedule``, the broadest area, so a new view is governed by the scope
# rather than escaping it.
_MODEL_AREA: dict[str, str] = {
    "Dependency": "dependencies",
    "Resource": "resources",
    "ProjectResource": "resources",
    "TaskResource": "resources",
    "Baseline": "baselines",
    "BaselineTask": "baselines",
}


def is_controlled_agent(auth: object) -> TypeGuard[ApiToken]:
    """Whether ``auth`` is an agent the pause and capability scope govern.

    Narrower than :func:`~trueppm_api.apps.projects.models.is_agent_token`, which fails
    closed on *any* non-full token for the MCP read-only guards: an owner-scoped
    ``webhooks:manage`` token is an "agent" there, but nothing here can bind it — it
    never reaches the MCP read surface — so listing it with a Pause control would show
    a control that does nothing. This is the one predicate the Agents list
    (``control.agent_tokens``), ``AgentControlGuard`` and the refusal Inbox item share.
    """
    from trueppm_api.apps.projects.models import SCOPE_MCP_READ, is_agent_token

    if not is_agent_token(auth):
        return False
    return auth.owner_id is not None and SCOPE_MCP_READ in (auth.scopes or [])


def level_rank(level: str) -> int:
    """Ordinal of ``level`` on the ladder; an unknown value ranks as ``none``."""
    return _RANK.get(level, 0)


def grant_of(token: ApiToken) -> dict[str, str]:
    """Return the token's stored grant, normalized to one known level per area."""
    stored = token.agent_scope if isinstance(token.agent_scope, dict) else None
    if stored is None:
        return dict(DEFAULT_GRANT)
    grant: dict[str, str] = {}
    for area in AGENT_AREAS:
        level = stored.get(area)
        grant[area] = level if isinstance(level, str) and level in _RANK else LEVEL_NONE
    return grant


def principal_ceiling(user: Any) -> dict[str, str]:
    """The highest level the principal could grant per area, from their live roles.

    ``read`` needs only an active account (the views' own RBAC narrows each read to
    the principal's projects). ``propose`` needs a live project role at or above the
    area's floor on at least one live project. ``write`` is never in the ceiling in 0.5.

    This ceiling is workspace-wide (the principal's *highest* role on any project), which
    is enough to cap an edit. It is not enough to authorize a dry run: when plan mode
    (#1813) starts consuming ``propose``, it must intersect the grant with the
    principal's role on the *project the dry run targets*, so an Admin on project A
    cannot preview Admin-only changes on project B where they are a Member.
    """
    if user is None or not getattr(user, "is_active", False):
        return dict.fromkeys(AGENT_AREAS, LEVEL_NONE)

    from django.db.models import Max

    from trueppm_api.apps.access.models import ProjectMembership

    top = ProjectMembership.objects.filter(
        user=user, is_deleted=False, project__is_deleted=False
    ).aggregate(top=Max("role"))["top"]
    top_role = int(top) if top is not None else 0
    return {
        area: LEVEL_PROPOSE if top_role >= _PROPOSE_FLOOR[area] else LEVEL_READ
        for area in AGENT_AREAS
    }


def principal_ceilings(users: list[Any]) -> dict[Any, dict[str, str]]:
    """:func:`principal_ceiling` for many principals in one query (list endpoints)."""
    from django.db.models import Max

    from trueppm_api.apps.access.models import ProjectMembership

    active = [u for u in users if u is not None and getattr(u, "is_active", False)]
    tops = dict(
        ProjectMembership.objects.filter(
            user__in=active, is_deleted=False, project__is_deleted=False
        )
        .values("user_id")
        .annotate(top=Max("role"))
        .values_list("user_id", "top")
    )
    out: dict[Any, dict[str, str]] = {}
    for user in users:
        if user is None:
            continue
        if not getattr(user, "is_active", False):
            out[user.pk] = dict.fromkeys(AGENT_AREAS, LEVEL_NONE)
            continue
        top_role = int(tops.get(user.pk) or 0)
        out[user.pk] = {
            area: LEVEL_PROPOSE if top_role >= _PROPOSE_FLOOR[area] else LEVEL_READ
            for area in AGENT_AREAS
        }
    return out


def intersect(grant: dict[str, str], ceiling: dict[str, str]) -> dict[str, str]:
    """Per area, the lower of the two levels."""
    return {
        area: min(grant.get(area, LEVEL_NONE), ceiling.get(area, LEVEL_NONE), key=level_rank)
        for area in AGENT_AREAS
    }


def effective_scope(token: ApiToken) -> dict[str, str]:
    """The grant intersected with the principal's permissions *now* (never cached)."""
    return intersect(grant_of(token), principal_ceiling(token.owner))


def can_read_area(token: ApiToken, area: str) -> bool:
    """Whether the agent's effective scope includes ``read`` on ``area`` for this call.

    The read slice of :func:`effective_scope` without its membership query: the
    principal's read ceiling is "account active", and the view's own RBAC (the token
    acts as its owner) narrows the read to the principal's current projects.
    """
    owner = token.owner
    if owner is None or not owner.is_active:
        return False
    return level_rank(grant_of(token)[area]) >= level_rank(LEVEL_READ)


def area_for_view(view: Any) -> str | None:
    """The scope area a view's reads fall in, or ``None`` when it reads no project data.

    A viewset may map individual actions to an area with ``agent_action_areas``
    (``ProjectViewSet``'s utilization and resource actions are resource reads on a
    project route), and a view may declare ``agent_area``. Otherwise a view declaring
    ``McpScope.NO_PROJECT_DATA`` (the identity echo, the calendar library) has no area;
    anything else resolves through its queryset model, defaulting to ``schedule``.
    """
    by_action = getattr(view, "agent_action_areas", None)
    action = getattr(view, "action", None)
    if isinstance(by_action, dict) and action in by_action and by_action[action] in AGENT_AREAS:
        return str(by_action[action])
    declared = getattr(view, "agent_area", None)
    if declared in AGENT_AREAS:
        return str(declared)
    if str(getattr(view, "mcp_scope", "") or "") == "none":
        return None
    queryset = getattr(view, "queryset", None)
    model = getattr(queryset, "model", None)
    if model is not None and model.__name__ in _MODEL_AREA:
        return _MODEL_AREA[model.__name__]
    return "schedule"


def agent_lacks_read(request: Any, area: str) -> bool:
    """Whether ``request`` is a controlled agent whose scope excludes reading ``area``.

    For field-level withholding inside a view that is itself in another area (the
    resource fields on a task read). Always ``False`` for a person or any token the
    capability scope does not govern.
    """
    token = getattr(request, "auth", None) if request is not None else None
    return is_controlled_agent(token) and not can_read_area(token, area)


def strip_resource_task_fields(data: dict[str, Any], request: Any) -> dict[str, Any]:
    """Drop :data:`RESOURCE_TASK_FIELDS` from a task payload for an agent without them."""
    if agent_lacks_read(request, "resources"):
        for field in RESOURCE_TASK_FIELDS:
            data.pop(field, None)
    return data


class ScopeGrantError(ValueError):
    """A requested grant is malformed, above the principal, or not grantable yet."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def validate_grant(
    requested: object, principal: Any, current: dict[str, str] | None = None
) -> dict[str, str]:
    """Validate a requested grant and return it normalized over every area.

    Areas left out keep no implicit level: the caller merges the request over the
    current grant before calling this, so a missing key here means ``none``.

    ``current`` is the stored grant being edited. Only an area the request **raises**
    above the principal's ceiling is refused: after the principal is demoted, the
    stored grant can sit above the ceiling (the effective scope is capped per call
    anyway), and refusing every edit then would block the person from narrowing the
    agent, which is the edit a demotion calls for. An area kept at, or lowered from, a
    stored level above the ceiling is accepted as is.

    Raises:
        ScopeGrantError: ``code="invalid_scope"`` for an unknown area or level,
            ``code="write_not_grantable"`` for any ``write`` (the 0.6 path), and
            ``code="above_principal"`` when a level exceeds the principal's ceiling.
    """
    if not isinstance(requested, dict):
        raise ScopeGrantError("scope must be an object of area → level.", code="invalid_scope")
    unknown = sorted(str(k) for k in requested if k not in AGENT_AREAS)
    if unknown:
        raise ScopeGrantError(f"Unknown scope area: {', '.join(unknown)}.", code="invalid_scope")
    grant: dict[str, str] = {}
    for area in AGENT_AREAS:
        level = requested.get(area, LEVEL_NONE)
        if not isinstance(level, str) or level not in _RANK:
            raise ScopeGrantError(
                f"Unknown level for {area}: expected one of {', '.join(AGENT_LEVELS)}.",
                code="invalid_scope",
            )
        if level == LEVEL_WRITE:
            raise ScopeGrantError(
                "Write is not grantable: the committing write path ships in 0.6.",
                code="write_not_grantable",
            )
        grant[area] = level
    ceiling = principal_ceiling(principal)
    over = [
        a
        for a in AGENT_AREAS
        if level_rank(grant[a]) > level_rank(ceiling[a])
        and (current is None or level_rank(grant[a]) > level_rank(current.get(a, LEVEL_NONE)))
    ]
    if over:
        labels = ", ".join(AGENT_AREA_LABELS[a] for a in over)
        raise ScopeGrantError(
            f"An agent cannot be granted more than the person it acts for ({labels}).",
            code="above_principal",
        )
    return grant
