"""Workspace → Program → Project attachment-policy resolution (ADR-0153, #976).

Two inheritable settings govern task file attachments:

* ``attachments_enabled`` — whether file uploads are permitted at all. NULL on a
  program/project means "inherit"; the Workspace root is non-null (default True).
* ``allowed_attachment_types`` — the per-scope MIME allow-list. On a
  program/project it is tri-state: ``None`` = inherit the parent's effective set,
  ``[]`` = an explicit *empty* allow-list (attachments on, but no type permitted),
  ``[...]`` = an explicit set. The resolver therefore tests ``is None``, never
  truthiness — an empty list is a deliberate value, not "inherit".

Both are resolved computed-on-read (ADR-0108) — there is no denormalized effective
column to keep in sync. Clients (web, mobile, MCP) read the serializer's
``effective_*`` / ``inherited_*`` fields and never re-implement this precedence.

Precedence: project override → program override → workspace value → (for the
type-list, the workspace seed, which itself defaults to
:data:`SYSTEM_DEFAULT_ATTACHMENT_TYPES`).

:data:`SYSTEM_ATTACHMENT_DENYLIST` is a non-overridable security floor: types in
it (``text/html`` etc., active stored-XSS vectors) are subtracted from every
resolved allow-list, so a workspace admin "widening" the policy can never
re-admit them, in any edition.

``ENFORCE`` (a workspace admin *locking* the policy so lower scopes cannot change
it) is an Enterprise capability. OSS ships the neutral provider hook below and
registers nothing, so ``ENFORCE`` degrades to ``SUGGEST`` (no lock). trueppm-
enterprise registers a provider in its ``AppConfig.ready()`` — the same
integrations-registry idiom as ``sharing_settings`` (ADR-0029/0030/0135). OSS
never imports enterprise.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The system seed allow-list — the floor of the inheritance chain and the
#: Workspace column default (see ``Workspace._default_allowed_attachment_types``).
#: This is the single source of truth for the historic hardcoded set; the
#: attachment serializer aliases it as ``ALLOWED_ATTACHMENT_MIMES`` so the seed
#: and the live default can never drift.
SYSTEM_DEFAULT_ATTACHMENT_TYPES: frozenset[str] = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
)

#: Non-overridable security floor. These types are subtracted from every resolved
#: allow-list and rejected by :func:`is_attachment_mime_allowed`, regardless of
#: scope, policy, or edition — an admin "widen" can never re-admit them. They are
#: active stored-XSS vectors when served same-origin (markup that can carry
#: <script>). External *links* are served off-origin and are unaffected.
SYSTEM_ATTACHMENT_DENYLIST: frozenset[str] = frozenset(
    {
        "text/html",
        "application/xhtml+xml",
        "image/svg+xml",
    }
)

#: The two inheritable policy fields. The field name is identical on Workspace
#: (non-null root), Program, and Project (nullable override).
ATTACHMENT_POLICY_FIELDS = ("attachments_enabled", "allowed_attachment_types")

# Enterprise registers a zero-arg predicate that returns True when attachment
# policy enforcement is licensed/active. OSS leaves it None → enforcement
# inactive, so a workspace ENFORCE policy never locks downstream overrides.
_ENFORCEMENT_PROVIDER: Callable[[], bool] | None = None


def register_attachment_policy_enforcement_provider(
    provider: Callable[[], bool] | None,
) -> None:
    """Register (or clear) the enforcement provider. Enterprise calls this."""
    global _ENFORCEMENT_PROVIDER
    _ENFORCEMENT_PROVIDER = provider


def attachment_policy_enforcement_active() -> bool:
    """True only when an enterprise provider is registered AND reports active.

    OSS has no provider → always False, so a workspace ``ENFORCE`` policy never
    locks downstream attachment overrides in the community edition.
    """
    return _ENFORCEMENT_PROVIDER is not None and bool(_ENFORCEMENT_PROVIDER())


def _enforced(workspace: Workspace) -> bool:
    """Whether the workspace value is a hard ceiling (Enterprise lock active)."""
    from trueppm_api.apps.workspace.models import TermOverridePolicy

    return (
        workspace.attachments_override_policy == TermOverridePolicy.ENFORCE
        and attachment_policy_enforcement_active()
    )


def _apply_denylist(types: Iterable[str]) -> list[str]:
    """Subtract the non-overridable denylist and return a sorted, deduped list."""
    return sorted({t for t in types} - SYSTEM_ATTACHMENT_DENYLIST)


def _program_of(obj: Program | Project) -> Program | None:
    """The program scope above ``obj`` (a Project's program), or None."""
    from trueppm_api.apps.projects.models import Program

    if not isinstance(obj, Program) and getattr(obj, "program_id", None):
        return obj.program
    return None


# --- attachments_enabled (boolean) ----------------------------------------


def resolve_attachments_enabled(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """Resolve effective ``attachments_enabled`` for a program or project.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if _enforced(workspace):
        return bool(workspace.attachments_enabled)

    own = obj.attachments_enabled  # nullable override
    if own is not None:
        return bool(own)
    return _parent_enabled(obj, workspace)


def resolve_inherited_attachments_enabled(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """Value ``obj`` would inherit if its own override were cleared.

    Drives the settings "Inherit (On/Off)" affordance — it deliberately skips
    ``obj``'s own override and resolves from the parent up.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if _enforced(workspace):
        return bool(workspace.attachments_enabled)
    return _parent_enabled(obj, workspace)


def _parent_enabled(obj: Program | Project, workspace: Workspace) -> bool:
    program = _program_of(obj)
    if program is not None and program.attachments_enabled is not None:
        return bool(program.attachments_enabled)
    return bool(workspace.attachments_enabled)


# --- allowed_attachment_types (list, tri-state on children) ----------------


def resolve_effective_attachment_types(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> list[str]:
    """Resolve the effective allow-list for a program or project (denylist applied).

    Tri-state on children: ``None`` = inherit, ``[]`` = explicit empty (no type
    allowed), ``[...]`` = explicit set — so the test is ``is not None``, never
    truthiness.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if _enforced(workspace):
        base: Iterable[str] = workspace.allowed_attachment_types or []
    else:
        # Tri-state: None = inherit, [] = explicit empty, [...] = explicit set —
        # so test ``is not None``, never truthiness ([] is a deliberate value).
        own = obj.allowed_attachment_types
        base = own if own is not None else _parent_types(obj, workspace)
    return _apply_denylist(base)


def resolve_inherited_attachment_types(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> list[str]:
    """Allow-list ``obj`` would inherit if its own override were cleared."""
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if _enforced(workspace):
        return _apply_denylist(workspace.allowed_attachment_types or [])
    return _apply_denylist(_parent_types(obj, workspace))


def _parent_types(obj: Program | Project, workspace: Workspace) -> list[str]:
    program = _program_of(obj)
    if program is not None and program.allowed_attachment_types is not None:
        return list(program.allowed_attachment_types)
    return list(workspace.allowed_attachment_types or [])


def is_attachment_mime_allowed(
    obj: Program | Project,
    mime: str,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """The single enforcement predicate: is ``mime`` permitted for ``obj``?

    Normalizes the MIME (drops any ``; charset=`` trailer, lowercases), rejects
    anything on the security denylist outright, then checks the resolved
    effective allow-list (which has already had the denylist subtracted).
    """
    norm = (mime or "").split(";", 1)[0].strip().lower()
    if not norm or norm in SYSTEM_ATTACHMENT_DENYLIST:
        return False
    return norm in resolve_effective_attachment_types(obj, workspace=workspace)
