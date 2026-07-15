"""Project → Program → Workspace working-calendar resolution (ADR-0441, #1987).

The *working calendar* (working-day mask, hours-per-day, timezone, holiday/shutdown
exceptions) that CPM uses can be set at three scopes. The *effective base calendar* a
project schedules against is resolved here, computed-on-read (ADR-0108) — there is no
stored/denormalized effective column to keep in sync. Clients (web, mobile, MCP) read
the serializer's ``effective_calendar`` / ``calendar_source``; they never re-implement
this precedence, and neither does the CPM seam (``scheduling.calendars`` calls
:func:`resolve_effective_base_calendar` to seed the composed mask).

Precedence (most specific wins):

    project.calendar → program.calendar → workspace.calendar → system default

``None`` at every scope means "system default" — the code-level Mon-Fri/8h/UTC fallback
in ``build_sched_calendar(None)`` remains the single source of the system default; we do
**not** materialize a system-default ``Calendar`` row.

This is Shape A (NULL-means-inherit), mirroring ``iteration_label`` / ``sharing_settings``
/ ``attachment_policy``: each scope's column is nullable and ``NULL`` = inherit. The base
calendar it resolves still composes with the project's ``ProjectCalendarLayer`` overlays
(ADR-0251) — inheritance picks the base; overlays stack on top of it unchanged.

``ENFORCE`` (a workspace admin locking the calendar so a program/project cannot override
it) is an Enterprise capability. OSS ships the neutral hook below and registers no
provider, so ``ENFORCE`` degrades to ``SUGGEST`` (no lock). trueppm-enterprise registers a
provider in its ``AppConfig.ready()`` — the integrations-registry idiom (ADR-0029/0049),
mirroring ``iteration_label.register_terminology_enforcement_provider``. OSS never imports
enterprise.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Calendar, Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: Where the resolved base calendar came from. ``system_default`` means nothing up the
#: chain set a calendar, so CPM uses the Mon-Fri/8h/UTC backstop.
CalendarSource = Literal["project", "program", "workspace", "system_default"]

# Enterprise registers a zero-arg predicate that returns True when calendar-override
# enforcement is licensed/active. OSS leaves it None → enforcement inactive, so a
# workspace ENFORCE policy never locks downstream overrides in the community edition.
_ENFORCEMENT_PROVIDER: Callable[[], bool] | None = None


def register_calendar_enforcement_provider(provider: Callable[[], bool] | None) -> None:
    """Register (or clear) the calendar-enforcement provider. Enterprise calls this."""
    global _ENFORCEMENT_PROVIDER
    _ENFORCEMENT_PROVIDER = provider


def calendar_enforcement_active() -> bool:
    """True only when an enterprise provider is registered AND reports active.

    OSS has no provider → always False, so a workspace ``ENFORCE`` policy never locks
    downstream calendar overrides in the community edition.
    """
    return _ENFORCEMENT_PROVIDER is not None and bool(_ENFORCEMENT_PROVIDER())


def calendar_override_locked(workspace: Workspace) -> bool:
    """Whether per-scope calendar overrides are locked to the workspace calendar.

    True under ``INHERIT`` (always — the affordance is hidden by design) or under
    ``ENFORCE`` *with* an active enterprise provider. ``SUGGEST`` (and OSS ``ENFORCE``
    with no provider) returns False, so the per-scope override is honored and editable.
    This is the single predicate the serializer and the write-permission gate both
    consult, so resolution and enforcement can never drift apart.
    """
    from trueppm_api.apps.workspace.models import TermOverridePolicy

    policy = workspace.calendar_override_policy
    if policy == TermOverridePolicy.INHERIT:
        return True
    if policy == TermOverridePolicy.ENFORCE:
        return calendar_enforcement_active()
    return False


def _program_of(obj: Program | Project) -> Program | None:
    """The owning program of a project, or None for a program/standalone project."""
    from trueppm_api.apps.projects.models import Program

    if isinstance(obj, Program):
        return None
    return obj.program if obj.program_id else None


def resolve_effective_base_calendar(
    obj: Program | Project, *, workspace: Workspace | None = None
) -> Calendar | None:
    """Resolve the base ``Calendar`` a program or project schedules against.

    Returns ``None`` when nothing up the chain sets a calendar — the caller then uses
    the system default (Mon-Fri/8h/UTC). ``workspace`` may be passed to avoid re-loading
    the singleton per object when resolving a list; otherwise it is loaded here.
    """
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if calendar_override_locked(workspace):
        # INHERIT / active ENFORCE: the workspace calendar wins regardless of any
        # lower-scope override.
        return workspace.calendar

    own = None if isinstance(obj, Program) else obj.calendar
    program = _program_of(obj)
    program_calendar = program.calendar if program else None
    if own is not None:
        return own
    if isinstance(obj, Program):
        return obj.calendar or workspace.calendar
    return program_calendar or workspace.calendar


def resolve_inherited_base_calendar(
    obj: Program | Project, *, workspace: Workspace | None = None
) -> Calendar | None:
    """Base calendar ``obj`` would schedule against if its own override were cleared.

    Drives the settings "Inherited from {scope}" affordance — it skips ``obj``'s own
    value and resolves from the parent scope up. A Program's parent is the workspace; a
    Project's parent is its program (whose own value resolves up to the workspace) or,
    standalone, the workspace. Under an active lock the inherited value is the (mandatory)
    workspace calendar.
    """
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if calendar_override_locked(workspace):
        return workspace.calendar

    if isinstance(obj, Program):
        return workspace.calendar
    program = _program_of(obj)
    program_calendar = program.calendar if program else None
    return program_calendar or workspace.calendar


def resolve_calendar_source(
    obj: Program | Project, *, workspace: Workspace | None = None
) -> CalendarSource:
    """Which scope supplied :func:`resolve_effective_base_calendar` for ``obj``.

    The breadcrumb an integration or the settings UI reads to explain *why* a schedule
    uses the calendar it does, without re-deriving the precedence (ADR-0441, VoC/Nadia).
    """
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    locked = calendar_override_locked(workspace)
    if not locked and not isinstance(obj, Program) and obj.calendar_id:
        return "project"
    if not locked and isinstance(obj, Program) and obj.calendar_id:
        return "program"
    if not locked:
        program = _program_of(obj)
        if program and program.calendar_id:
            return "program"
    if workspace.calendar_id:
        return "workspace"
    return "system_default"
