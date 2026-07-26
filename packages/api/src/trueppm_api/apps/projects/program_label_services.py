"""Program-scoped label reads (ADR-0638, issue #2333).

Labels are project-scoped (`unique(project, name)`), so "every task tagged
`security-review` in this program" cannot be answered by label id — the same name
is a different row, with a different id and possibly a different color, in every
project that uses it. These helpers answer it by **name** instead.

Both functions take an explicit ``project_ids`` iterable rather than a ``Program``.
That is deliberate and load-bearing (ADR-0638 Decision 4): it is the seam
``trueppm-enterprise`` calls with a *portfolio's* project set to build the
cross-program view, without the OSS package ever learning that portfolios exist.
Callers in this repo are responsible for passing only project ids the requesting
user may read — the viewset does that, and these functions do not re-check.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TypedDict
from uuid import UUID

from django.db.models import Count, Min, Prefetch, QuerySet
from django.db.models.functions import Lower

from trueppm_api.apps.projects.models import Label, Task


class LabelCatalogEntry(TypedDict):
    """One distinct label name across a set of projects."""

    name: str
    project_count: int


def tasks_by_label_name(*, project_ids: Iterable[UUID | str], label_name: str) -> QuerySet[Task]:
    """Tasks in ``project_ids`` carrying a label whose name matches ``label_name``.

    Matching is **case-insensitive** (ADR-0638 Decision 3): a PM who typed
    ``Security-Review`` in one project and ``security-review`` in another means one
    concept, and treating them as two is a bug report waiting to happen.

    Ordering is ``(project.name, wbs_path)`` — grouped by project because the
    user's first question about a cross-project row is "which project is this in",
    then plan order within each group. The ordering is total and stable, which
    matters for pagination: a non-deterministic order across projects lets a page
    boundary silently skip rows.
    """
    return (
        Task.objects.filter(
            project_id__in=list(project_ids),
            is_deleted=False,
            labels__name__iexact=label_name,
            labels__is_deleted=False,
        )
        .select_related("project")
        # Soft-deleted labels must never render as a pill — the established
        # Prefetch pattern for every label read.
        .prefetch_related(Prefetch("labels", queryset=Label.objects.filter(is_deleted=False)))
        # A task carrying two labels that both match would otherwise repeat.
        .distinct()
        .order_by("project__name", "wbs_path")
    )


def program_label_catalog(*, project_ids: Iterable[UUID | str]) -> list[LabelCatalogEntry]:
    """Distinct label names across ``project_ids``, with the count of projects using each.

    The count is of **projects carrying the name**, not of tasks. A task count
    would mean joining the whole task table to render a picker — a read that looks
    free at five projects and is not at fifty (ADR-0638 Decision 5). This is the
    one place the program view deliberately differs from ADR-0620, where per-label
    counts are computed client-side over already-loaded rows; here there is no
    single loaded row set to count over.

    Grouping is **case-insensitive**, and must be: ``tasks_by_label_name`` matches
    with ``iexact``, so if the catalog grouped by exact name then ``Security-Review``
    and ``security-review`` would list as two entries that return byte-identical
    result sets — the picker would contradict the filter. Rows are keyed on the
    lowercased name and displayed using the alphabetically-first original spelling,
    so one concept yields one entry whose label still reads the way a human typed it.

    One aggregate query, not one per project.
    """
    rows = (
        Label.objects.filter(project_id__in=list(project_ids), is_deleted=False)
        .annotate(name_key=Lower("name"))
        .values("name_key")
        .annotate(project_count=Count("project", distinct=True), display_name=Min("name"))
        .order_by("name_key")
    )
    return [
        LabelCatalogEntry(name=row["display_name"], project_count=row["project_count"])
        for row in rows
    ]
