"""Placing an externally-numbered block of tasks into a project that already has rows.

Every document that carries a WBS — a published template, an ``.mpp`` export, a CSV,
a Jira pull — numbers its tasks from ``1``, because it was written against a project
that started empty. That is correct exactly once. Writing those paths verbatim into a
project that already holds rows puts two live tasks on the same ``wbs_path``, and
``wbs_path`` is the only thing that records parenthood (there is no ``parent_id``
column), so the collision is not a cosmetic numbering clash — it collapses the next
``rewrite_level`` pass and strands the subtree underneath.

The pair here is the fix for that, and it lives in its own module because it is not
template-specific: it was written for template adoption (#3061) and the three
importer paths need the identical rule (#3069). One definition means a repaired row,
a seeded row and an imported row all agree about where "past the end" is.

Both functions are pure reads plus arithmetic — no writes, no locking. The caller
owns the transaction, and is responsible for holding it across the read and the
insert if concurrent writers are possible.
"""

from __future__ import annotations

from typing import Any


def root_ordinal_offset(project_id: Any, *, include_deleted: bool = False) -> int:
    """How far to shift an incoming document's root ordinals so they land past what exists.

    Returns the highest numeric root label already present in the project, or ``0``
    for an empty one — so a first adoption is shifted by nothing and keeps the
    document's paths exactly. Only distinct root labels are read, not one row per
    task.

    ``include_deleted`` widens the scan to tombstoned rows. The uniqueness constraint
    covers live rows only, so a tombstone cannot collide with anything being written
    now — but it still *holds* its number, and a later restore has to have somewhere
    to come back to. Callers allocating a number that a restore might later contend
    with should pass ``True``; callers that only care about what is legal right now
    can leave it ``False``.
    """
    from django.db.models.expressions import RawSQL

    from trueppm_api.apps.projects.models import Task

    rows = Task.objects.filter(project_id=project_id, wbs_path__isnull=False)
    if not include_deleted:
        rows = rows.filter(is_deleted=False)
    labels = (
        # nosec B611 — static SQL literal (no user input), empty params list; the
        # ltree subpath() call can't be expressed in the ORM. Bandit flags any RawSQL.
        # nosemgrep: avoid-raw-sql
        rows.annotate(root_label=RawSQL("subpath(projects_task.wbs_path, 0, 1)::text", []))  # nosec B611
        .values_list("root_label", flat=True)
        .distinct()
    )
    return max((int(label) for label in labels if str(label).isdigit()), default=0)


def offset_wbs_path(path: str | None, offset: int) -> str | None:
    """Shift a path's leading segment by ``offset``, preserving its subtree.

    Only the leading segment moves: every path in an incoming document is relative
    to a fresh project rooted at ``1``, so remapping just the head keeps the
    document's whole tree shape intact ("2.1.3" under offset 4 becomes "6.1.3").
    That is also why the ancestor/descendant relationships the caller derives from
    these paths — summary-task detection, for one — are unaffected by the shift.

    A non-numeric root label is left alone: it cannot be offset meaningfully, and
    the ``(project, wbs_path)`` constraint now rejects it loudly if it does collide.
    """
    if not path or offset == 0:
        return path or None
    head, _, rest = str(path).partition(".")
    if not head.isdigit():
        return str(path)
    shifted = str(int(head) + offset)
    return f"{shifted}.{rest}" if rest else shifted
