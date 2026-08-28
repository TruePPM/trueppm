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

Everything here is pure reads plus arithmetic — no writes, no locking. The caller
owns the transaction, and is responsible for holding it across the read and the
insert if concurrent writers are possible.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def min_root_ordinal(paths: Iterable[str | None]) -> int | None:
    """The smallest numeric root label in ``paths``, or ``None`` if there is none.

    Separated out because it is the half of the offset calculation that reads the
    incoming document rather than the project, and because a caller that has already
    computed it should not have to hand the whole path list over a second time.
    """
    heads = (str(path).partition(".")[0] for path in paths if path)
    return min((int(head) for head in heads if head.isdigit()), default=None)


def root_ordinal_offset(
    project_id: Any,
    *,
    include_deleted: bool = False,
    document_paths: Iterable[str | None] | None = None,
) -> int:
    """How far to shift an incoming document's root ordinals so they land past what exists.

    Returns ``0`` for a project with no numeric root labels — so a first adoption is
    shifted by nothing and keeps the document's paths exactly. Otherwise the shift
    lands the document's *lowest* root ordinal one position past the project's
    highest, which is what keeps the numbering contiguous across repeat adoptions.

    ``document_paths`` is the incoming document's paths. It defaults to ``None``,
    which assumes the document numbers its roots from ``1`` — the convention this
    module's docstring describes, and what every template and export we have does.
    That assumption is the whole reason the parameter exists: a document carrying a
    root of ``0`` (legal in ltree, and an ``.mpp`` or CSV can hold one) maps ``0``
    onto the project's highest existing ordinal under a from-1 shift and collides
    with it. Passing the real paths costs one pass over a list the caller already
    has and removes the assumption. The default reproduces the previous behavior
    exactly, so a caller that has not been updated is no worse off than before.

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
        # Task.Meta.ordering is ["wbs_path", "name"], and Postgres requires every
        # ORDER BY expression to appear in a SELECT DISTINCT list — so without this
        # Django widens the DISTINCT key to (root_label, wbs_path, name), which is
        # unique per task. The query then streams one row per task, plus a sort, to
        # compute a single integer. Clearing the ordering is what makes the "distinct
        # root labels" this docstring promises actually true.
        .order_by()
        .distinct()
    )
    highest = max((int(label) for label in labels if str(label).isdigit()), default=None)
    if highest is None:
        return 0
    document_floor = 1 if document_paths is None else min_root_ordinal(document_paths)
    if document_floor is None:
        return 0
    # Clamped at zero: a document numbered above the project's highest root already
    # lands past it, and a negative shift would drag it back onto occupied ground.
    return max(highest - document_floor + 1, 0)


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
