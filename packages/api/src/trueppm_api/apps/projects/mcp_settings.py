"""Instance → Workspace → Program → Project MCP read-consent resolution (ADR-0678, #2482).

One inheritable setting governs whether an MCP/agent token may read a project's
data: ``mcp_enabled``. The Workspace root is non-null (default ``True``); Program
and Project are nullable, where ``None`` means *no opinion* — **never "yes"**.

**The cascade is restrictive-only (AND), not override.** This is the one place
this module deliberately diverges from the ADR-0135/0144/0151/0153/0510 settings
family, and the divergence is the point::

    effective(project) = settings.TRUEPPM_MCP_ENABLED     # ADR-0497 instance switch
                     AND workspace.mcp_enabled
                     AND (program.mcp_enabled is not False)
                     AND (project.mcp_enabled is not False)

Any scope may deny for itself and everything beneath it; **no scope may grant over
another scope's denial**. For sharing and attachments a workspace ``ENFORCE`` lock
is a security *ceiling* and pointing it downward is coherent. For a **consent**
switch it is not: an org-level lock that could force MCP back on for a team is
precisely the *"consent that only an admin can grant or revoke on the team's
behalf is consent in name only"* objection (#2415) this control exists to answer.

Consequently there is **no** ``mcp_override_policy`` field and **no** Enterprise
enforcement-provider seam here, unlike :mod:`~trueppm_api.apps.projects.attachment_policy`.
That asymmetry is deliberate, not an oversight. Enterprise governance keeps the
only lever that is coherent for a consent control — turning MCP off at the
workspace scope, org-wide — which the AND already honors.

Resolution is computed-on-read (ADR-0108); there is no denormalized effective
column to keep in sync. Clients read the serializer's ``effective_mcp_enabled`` /
``inherited_mcp_enabled`` fields and never re-implement this precedence.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The single inheritable field name — identical on Workspace (non-null root),
#: Program, and Project (nullable "no opinion").
MCP_CONSENT_FIELD = "mcp_enabled"


def _instance_enabled() -> bool:
    """The ADR-0497 instance-wide kill switch, read at call time.

    Read through ``getattr`` at call time (not import time) so ``override_settings``
    and a live operator env change both take effect, matching ``McpInstanceEnabled``.
    """
    from django.conf import settings

    return bool(getattr(settings, "TRUEPPM_MCP_ENABLED", True))


def _program_of(obj: Program | Project) -> Program | None:
    """The program scope above ``obj`` (a Project's program), or None."""
    from trueppm_api.apps.projects.models import Program

    if not isinstance(obj, Program) and getattr(obj, "program_id", None):
        return obj.program
    return None


def resolve_mcp_enabled(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
    include_instance: bool = True,
) -> bool:
    """Resolve effective MCP read consent for a program or project.

    ANDs every scope: instance → workspace → program → project. A ``None`` at the
    program or project scope contributes nothing (no opinion); only an explicit
    ``False`` denies.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.

    ``include_instance=False`` omits the ADR-0497 instance switch, for callers that
    want the *team's* answer alone — the settings UI shows the team's decision even
    on an instance where MCP is globally off, so the two switches stay legible as
    separate facts rather than collapsing into one confusing "off".
    """
    from trueppm_api.apps.workspace.models import Workspace

    if include_instance and not _instance_enabled():
        return False

    if workspace is None:
        workspace = Workspace.load()
    if not workspace.mcp_enabled:
        return False

    return _parent_and_own_enabled(obj)


def resolve_inherited_mcp_enabled(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """Value ``obj`` would resolve to if its own override were cleared to *no opinion*.

    Drives the settings "Inherit (On/Off)" affordance — it deliberately skips
    ``obj``'s own value and resolves from the parent scopes up. The instance switch
    is excluded for the same legibility reason as
    :func:`resolve_mcp_enabled`'s ``include_instance=False``.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()
    if not workspace.mcp_enabled:
        return False

    program = _program_of(obj)
    return not (program is not None and program.mcp_enabled is False)


def _parent_and_own_enabled(obj: Program | Project) -> bool:
    """AND of the program scope (if any) and ``obj``'s own value.

    Tri-state: the test is ``is False``, never truthiness — ``None`` is "no
    opinion" and must not be read as a denial.
    """
    program = _program_of(obj)
    if program is not None and program.mcp_enabled is False:
        return False
    return obj.mcp_enabled is not False


def is_mcp_readable(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """The single enforcement predicate: may an agent token read ``obj``'s data?"""
    return resolve_mcp_enabled(obj, workspace=workspace)


def mcp_opted_out_project_ids() -> QuerySet[Any]:
    """Project ids closed to agent reads by *their own or their program's* denial.

    Returns a lazy values-list queryset so callers can use it directly as an
    ``__in`` subquery without a second round trip. Deliberately does **not**
    consider the workspace or instance switch: those are all-or-nothing and are
    short-circuited by the caller (see :func:`mcp_reads_globally_disabled`) rather
    than expanded into a project-id set, which at scale would mean listing every
    project on the instance.
    """
    from django.db.models import Q

    from trueppm_api.apps.projects.models import Project

    return Project.objects.filter(Q(mcp_enabled=False) | Q(program__mcp_enabled=False)).values_list(
        "pk", flat=True
    )


def mcp_reads_globally_disabled(*, workspace: Workspace | None = None) -> bool:
    """True when a scope above every project denies — instance or workspace.

    Lets the enforcement point answer "deny everything" without materializing a
    project-id set.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if not _instance_enabled():
        return True
    if workspace is None:
        workspace = Workspace.load()
    return not workspace.mcp_enabled


def mcp_excluded_project_ids(request: Request) -> QuerySet[Any] | None:
    """Project ids this request must NOT read, or ``None`` when nothing is withheld.

    The exclusion-shaped companion to :func:`mcp_visible_project_ids`, for the
    program-level services (``compute_program_schedule``,
    ``compute_program_rollup``) whose natural seam is "drop these projects" rather
    than "keep these". Returns ``None`` for a human caller and for the common case
    where no project on the instance has opted out, so those services keep their
    existing query plan untouched on every normal request.

    A workspace/instance-level denial is not expanded here: those are caught by
    :class:`~trueppm_api.apps.access.permissions.McpProjectEnabled`, which 403s the
    request before any service runs.
    """
    from trueppm_api.apps.projects.models import is_agent_token

    if not is_agent_token(getattr(request, "auth", None)):
        return None  # Human JWT/Session or the owner's own full-access PAT (#2877).

    opted_out = mcp_opted_out_project_ids()
    if not opted_out.exists():
        return None
    return opted_out


def mcp_visible_project_ids(request: Request) -> QuerySet[Any] | None:
    """Project ids this request may read, or ``None`` when no filtering is needed.

    The primitive the hand-built aggregate views (``/me/search``, ``/me/work/``,
    workspace assets) and the program-level rollups intersect against. Returns:

    * ``None`` — the caller is not an agent token (a human, or a ``legacy:full``
      personal access token, which is a person's own credential and not subject to
      agent consent — #2877), or no project on the instance has opted out. Callers
      skip filtering entirely; this is the case on virtually every instance, so the
      common path costs one cheap ``EXISTS``.
    * an empty queryset — a scope above every project denies (instance or
      workspace off), so nothing is visible.
    * a values-list queryset of readable project ids otherwise.

    why a *positive* id set rather than an exclusion list: the aggregate views
    already join through several project relations, and an ``__in`` against the
    allowed set composes with their existing membership filters without needing
    each call site to reason about NULL semantics.
    """
    from trueppm_api.apps.projects.models import Project, is_agent_token

    if not is_agent_token(getattr(request, "auth", None)):
        return None  # Human JWT/Session or the owner's own full-access PAT (#2877).

    if mcp_reads_globally_disabled():
        return Project.objects.none().values_list("pk", flat=True)

    opted_out = mcp_opted_out_project_ids()
    if not opted_out.exists():
        return None  # Fast path: nothing opted out anywhere on the instance.
    return Project.objects.exclude(pk__in=opted_out).values_list("pk", flat=True)
