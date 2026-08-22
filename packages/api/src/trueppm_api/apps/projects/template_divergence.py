"""How a project has diverged from the template it was created from (#2971, epic #2743).

**One digest, one function, one endpoint — and no audience parameter.** That is the
whole of the symmetry requirement, expressed structurally rather than as a promise:
:func:`compute_template_divergence` takes a project and nothing else, so there is no
"team view" and "PMO view" that could drift apart, and no reader whose copy could be
narrowed later without deleting the argument that does not exist. A report about a
team's decisions that the team cannot read is surveillance with better typography;
the way to not build that is to make the second version unrepresentable.

Governance position (epic #2743, settled in #2970/#2909 and not relitigated here):
**divergence produces a visible signal, never a block.** Nothing in this module
approves, rejects, queues, or scores. It counts rows and says who wrote them.

Nothing here is a second definition of anything. "A machine wrote this row and no
person has touched it since" is :meth:`TaskManager.untouched_seeded` (ADR-0786 §3) and
is called, not re-implemented — a copy of that filter that drifts by one clause is how
a whole class of typed work goes silently missing. "Which rows did this adoption write"
is ``TemplateApplication.created_task_ids``, which is exact rather than heuristic
because it is also the undo set.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project, TemplateApplication


def _display_name(user: Any) -> str:
    """The name to attribute an adoption to, or '' once the account is gone.

    Empty rather than "Unknown": the adoption record survives ``applied_by`` being
    nulled by a user deletion, and a placeholder name would read as a real person.
    """
    if user is None:
        return ""
    return str(getattr(user, "display_name", "") or getattr(user, "username", "") or "")


def _adoptions(project: Project) -> list[TemplateApplication]:
    """Every adoption that actually seeded rows into ``project``, newest first.

    Undone applications are excluded for the same reason the gallery's usage count
    excludes them (#2909): an application whose seeding was reversed was not adopted,
    and counting its rows would attribute work to a template that no longer wrote any.
    """
    from trueppm_api.apps.projects.models import (
        TemplateApplication,
        TemplateApplicationStatus,
    )

    return list(
        TemplateApplication.objects.filter(
            project=project,
            status=TemplateApplicationStatus.SUCCESS,
            undone_at__isnull=True,
        )
        .select_related("applied_by", "template")
        .order_by("-created_at")
    )


def compute_template_divergence(project: Project) -> dict[str, Any]:
    """The digest for one project — the same body for every reader.

    Four counts over the rows a template wrote, plus one over the rows it did not:

    * ``unchanged`` — seeded, still present, and no person has touched it. Delegated
      wholesale to ``Task.objects.untouched_seeded(..., within=None)``; ``within=None``
      because the seven-day sweep window is about offering a *delete*, and a project
      adopted last quarter has diverged just as legibly as one adopted on Tuesday.
    * ``adapted`` — seeded, still present, and someone edited it. This is the number
      the whole feature exists to keep neutral: it is a team doing its job, and the
      digest reports it without a verdict attached.
    * ``removed`` — seeded and no longer live (soft-deleted, or reaped by the
      tombstone sweep). Derived by subtraction rather than by querying deleted rows,
      because a hard-deleted row leaves nothing to query.
    * ``added`` — live rows in this project that no adoption wrote. Named for what it
      counts, not for when it happened: a project that already had rows before the
      template was applied contributes them here too, and calling that "added since"
      would be a claim the data does not support.

    ``seeded_row_count`` is the union across every non-undone adoption, so a project
    that adopted twice does not report the second batch's rows as team-authored.

    A project with no adoption returns ``adopted=False`` and zeroed counts rather
    than raising: "this project was not created from a template" is an answer the
    settings section renders, not an error.

    A template deleted after adoption returns ``template=None`` with
    ``template_name``/``template_version`` still populated — those columns are
    denormalized onto the application precisely so "this project came from Delivery
    Skeleton v3" outlives v3.
    """
    from trueppm_api.apps.projects.models import Task

    applications = _adoptions(project)
    if not applications:
        return {
            "project": str(project.pk),
            "adopted": False,
            "application": None,
            "application_count": 0,
            "template": None,
            "template_name": "",
            "template_version": 0,
            "template_available": False,
            "applied_at": None,
            "applied_by_name": "",
            "seeded_row_count": 0,
            "unchanged": 0,
            "adapted": 0,
            "removed": 0,
            "added": Task.objects.filter(project=project, is_deleted=False).count(),
        }

    headline = applications[0]
    # Union across adoptions, de-duplicated: an id can in principle appear twice if a
    # template is applied, undone, and re-applied — and double-counting it would make
    # `added` negative on a project whose rows all came from a template.
    seeded_ids: set[Any] = set()
    for application in applications:
        seeded_ids.update(application.created_task_ids or [])

    seeded_row_count = len(seeded_ids)
    live_seeded = Task.objects.filter(project=project, pk__in=seeded_ids, is_deleted=False).count()
    # THE definition of untouched (ADR-0786 §3), narrowed to this project's seeded set.
    unchanged = (
        Task.objects.untouched_seeded(project, within=None).filter(pk__in=seeded_ids).count()
    )
    adapted = live_seeded - unchanged
    removed = seeded_row_count - live_seeded
    added = (
        Task.objects.filter(project=project, is_deleted=False).exclude(pk__in=seeded_ids).count()
    )

    return {
        "project": str(project.pk),
        "adopted": True,
        "application": str(headline.pk),
        "application_count": len(applications),
        "template": str(headline.template_id) if headline.template_id else None,
        "template_name": headline.template_name,
        "template_version": headline.template_version,
        # False means the template row is gone, not that the adoption is in doubt.
        # The digest still names it; what it cannot do is link you to it.
        "template_available": headline.template_id is not None,
        "applied_at": headline.completed_at or headline.created_at,
        "applied_by_name": _display_name(headline.applied_by),
        "seeded_row_count": seeded_row_count,
        "unchanged": unchanged,
        "adapted": adapted,
        "removed": removed,
        "added": added,
    }
