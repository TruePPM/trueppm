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

    **Two substrates, each answering the question it was built for** (see the
    ``TemplateApplication`` docstring, which says this explicitly): the *headline*
    — which template, which version, applied by whom and when — comes from the
    adoption record, because that row answers "which application wrote this batch";
    the *counts* come from the per-row provenance columns #2730 added, because
    those answer "what wrote this row", which is the question a count is.

    That split is also what keeps the query bounded. Counting through
    ``created_task_ids`` means a ``pk__in`` over the union of every adoption's id
    array — 2,000 ids per apply with no cap on applies, one bind parameter each,
    and PostgreSQL's 65,535-parameter protocol limit reached at roughly 33 full
    applications. The endpoint would then be a permanent 500 for every member of
    that project, self-inflicted and unclearable by the team. The provenance
    columns express the same set as a plain indexed predicate with no id list at
    all, so the cost does not grow with adoption history.

    Four counts over the rows a template wrote into this project — *whichever*
    adoption wrote them, which is what per-row provenance means:

    * ``unchanged`` — still present and no person has touched it. Delegated
      wholesale to ``Task.objects.untouched_seeded(..., within=None)``, THE
      definition of untouched (ADR-0786 §3). ``within=None`` because the seven-day
      window bounds a *delete* offer; inheriting it would report every long-lived
      project as fully adapted, which is a false accusation rather than a stale
      number.
    * ``adapted`` — still present and someone edited it. This is the number the
      whole feature exists to keep neutral: it is a team doing its job, and the
      digest reports it without a verdict attached.
    * ``removed`` — a template row that has since been soft-deleted. A row
      hard-deleted by the tombstone reap is genuinely gone from the database and is
      not counted; nothing can count it, and inferring it by subtracting from a
      stored id array is what forces the unbounded query above.
    * ``added`` — live rows this project has that no template wrote.

    A project with no adoption returns ``adopted=False`` and zeroed counts rather
    than raising: "this project was not created from a template" is an answer the
    settings section renders, not an error. Its ``added`` is every live row, which
    also covers the after-an-undo case — undo keeps rows a person had edited, and a
    project whose only adoption was reversed is not "from" that template, so the
    survivors are the team's.

    A template deleted after adoption returns ``template=None`` with
    ``template_name``/``template_version`` still populated — those columns are
    denormalized onto the application precisely so "this project came from Delivery
    Skeleton v3" outlives v3.
    """
    from trueppm_api.apps.projects.models import Task, TaskSource

    applications = _adoptions(project)
    rows = Task.objects.filter(project=project)
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
            "added": rows.filter(is_deleted=False).count(),
        }

    headline = applications[0]
    template_rows = rows.filter(source_kind=TaskSource.TEMPLATE)
    live_seeded = template_rows.filter(is_deleted=False).count()
    # THE definition of untouched (ADR-0786 §3), narrowed to template-written rows.
    unchanged = (
        Task.objects.untouched_seeded(project, within=None)
        .filter(source_kind=TaskSource.TEMPLATE)
        .count()
    )
    removed = template_rows.filter(is_deleted=True).count()

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
        # Derived, not stored: the three parts are counted from the same predicate,
        # so the total can never disagree with them the way a snapshot would.
        "seeded_row_count": live_seeded + removed,
        "unchanged": unchanged,
        "adapted": live_seeded - unchanged,
        "removed": removed,
        "added": rows.filter(is_deleted=False).exclude(source_kind=TaskSource.TEMPLATE).count(),
    }
