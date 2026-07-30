"""Resolve — and describe — the program a seed import would replace (ADR-0726).

A seed's ``program.slug`` is persisted as ``Program.code``, so re-importing a
document whose slug matches a live program is a *replacement*, not a create. Who
that replacement is allowed to reach is a security decision (#994) and what it
would destroy is a consent decision (#2581), and both are answered here so the
import view, the dry run, and the importer itself cannot disagree about either.

The single most important line in this module is the ``pk__in=owned_program_ids``
filter: ``Program.code`` is user-assigned and carries no uniqueness constraint,
so collisions between unrelated users are realistic and enumerable. Scoping
candidates to programs the importer holds a live OWNER ``ProgramMembership`` on
is what stops a crafted seed from reaching a stranger's program.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import Program, Project, Task


@dataclass(frozen=True)
class ReplaceConflict:
    """What a confirmed re-import would tear down, as shown to the caller.

    Rendered into both the ``409`` refusal and the dry-run ``replaces`` key, so an
    operator sees the same description whether they asked first or were stopped.
    The counts are the point: "a program called Atlas" is not enough information
    to consent to destroying 812 tasks.
    """

    program_id: str
    name: str
    code: str
    project_count: int
    task_count: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "program_id": self.program_id,
            "name": self.name,
            "code": self.code,
            "project_count": self.project_count,
            "task_count": self.task_count,
        }


def resolve_replace_candidates(owner: Any, slug: str, *, lock: bool = False) -> list[Program]:
    """Return the live programs ``owner`` owns whose ``code`` is ``slug``.

    The one site of the #994 ownership scope. Every caller — the import view's
    409 check, the dry run's preview, and the importer's teardown — resolves
    candidates through here rather than re-deriving the query, because a security
    scope that exists in three places is a security scope that will eventually
    exist in two.

    Args:
        owner: the importing user. Candidacy requires a live OWNER
            ``ProgramMembership`` — a strictly higher bar than visibility, which
            is why naming a candidate back to the caller leaks nothing.
        slug: the seed's ``program.slug``, compared against ``Program.code``.
        lock: when ``True``, take ``select_for_update()`` on each candidate row.
            The teardown path must, so a concurrent member-add or project-assign
            cannot resurrect a ``PROTECT``-ed reference mid-delete. The read-only
            preview paths must not — they run outside a transaction.

    Returns:
        Matching live programs, empty when the slug is free.
    """
    if not slug:
        return []
    owned_program_ids = ProgramMembership.objects.filter(
        user=owner, role=Role.OWNER, is_deleted=False
    ).values_list("program_id", flat=True)
    qs = Program.objects.filter(code=slug, is_deleted=False, pk__in=owned_program_ids)
    if lock:
        qs = qs.select_for_update()
    return list(qs)


def describe_conflict(program: Program) -> ReplaceConflict:
    """Summarize what replacing ``program`` would tear down."""
    project_ids = list(
        Project.objects.filter(program=program, is_deleted=False).values_list("pk", flat=True)
    )
    task_count = (
        Task.objects.filter(project_id__in=project_ids, is_deleted=False).count()
        if project_ids
        else 0
    )
    return ReplaceConflict(
        program_id=str(program.pk),
        name=program.name,
        code=program.code,
        project_count=len(project_ids),
        task_count=task_count,
    )


def preview_replacement(owner: Any, payload: Any) -> dict[str, Any] | None:
    """The dry run's ``replaces`` value for ``payload`` — ``None`` when nothing collides.

    Read-only and defensive: a malformed document still yields ``None`` rather
    than raising, because the dry run's whole job is to answer for documents that
    are not yet valid (#2418).

    Deliberately *not* folded into ``inspect_seed``. That function is pure and
    lives in a module that never imports the ORM, and the dry run's
    "persists nothing" guarantee is structural because of it. The collision is
    computed at the view layer instead.
    """
    if not isinstance(payload, dict):
        return None
    program = payload.get("program")
    if not isinstance(program, dict):
        return None
    slug = program.get("slug")
    if not isinstance(slug, str):
        return None
    candidates = resolve_replace_candidates(owner, slug)
    if not candidates:
        return None
    return describe_conflict(candidates[0]).as_dict()
