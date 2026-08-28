"""``root_ordinal_offset`` — the shift that lands an incoming document past what exists.

Two properties are pinned here, and they fail for different reasons.

The first is a *cost* property, not a correctness one: the query must read one row per
distinct root label. ``max()`` over duplicates returns the same integer, so nothing
observable was ever wrong — which is precisely why the defect survived. It is asserted
by re-executing the SQL the function actually issued and counting rows, because that is
the only place the difference is visible (#3072).

The second is the root-``0`` collision. A document numbered from ``1`` shifted by the
project's highest ordinal always lands clear; a document carrying a root of ``0`` maps
that ``0`` straight onto the highest existing ordinal. ``0`` is a legal ltree label and
nothing rejects it on write, so this is reachable from any ``.mpp``/CSV import.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.wbs_paths import (
    min_root_ordinal,
    offset_wbs_path,
    root_ordinal_offset,
)


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(
        name="Root offset", start_date=date(2026, 1, 1), calendar=calendar
    )


def _task(project: Project, path: str, *, deleted: bool = False) -> Task:
    """Create a row at ``path`` directly, bypassing anything that would renumber it."""
    task = Task.objects.create(project=project, name=f"task {path}", duration=1)
    Task.objects.filter(pk=task.pk).update(wbs_path=path, is_deleted=deleted)
    return task


# ---------------------------------------------------------------------------
# The DISTINCT defeat
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_query_reads_one_row_per_root_label_not_one_per_task(project: Project) -> None:
    """Three roots, thirty tasks — the scan must return three rows, not thirty.

    Re-executes the captured SQL rather than trusting a substring match, so this
    asserts the property the docstring claims instead of the syntax that produces it.
    """
    for root in ("1", "2", "3"):
        _task(project, root)
        for child in range(1, 10):
            _task(project, f"{root}.{child}")
    assert Task.objects.filter(project=project).count() == 30

    with CaptureQueriesContext(connection) as captured:
        assert root_ordinal_offset(project.pk) == 3
    label_queries = [q["sql"] for q in captured.captured_queries if "subpath" in q["sql"]]
    assert len(label_queries) == 1, label_queries

    with connection.cursor() as cur:
        cur.execute(label_queries[0])
        rows = cur.fetchall()
    assert len(rows) == 3, f"expected one row per distinct root label, got {len(rows)}: {rows}"


@pytest.mark.django_db
def test_the_label_scan_carries_no_ordering(project: Project) -> None:
    """``Task.Meta.ordering`` must not survive into the DISTINCT key.

    Postgres requires every ORDER BY expression to appear in a SELECT DISTINCT list,
    so an inherited ordering silently widens the key to ``(root_label, wbs_path, name)``
    — unique per task. This is the mechanism behind the row count above; pinned
    separately so a regression names its own cause.
    """
    _task(project, "1")
    _task(project, "1.1")
    with CaptureQueriesContext(connection) as captured:
        root_ordinal_offset(project.pk)
    sql = next(q["sql"] for q in captured.captured_queries if "subpath" in q["sql"])
    assert "ORDER BY" not in sql.upper(), sql
    assert "name" not in sql.split("FROM")[0], sql


# ---------------------------------------------------------------------------
# The offset itself
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_an_empty_project_shifts_by_nothing(project: Project) -> None:
    assert root_ordinal_offset(project.pk) == 0


@pytest.mark.django_db
def test_a_second_adoption_lands_contiguously_past_the_first(project: Project) -> None:
    """The shipped behavior, pinned so the root-0 fix cannot introduce a numbering gap."""
    _task(project, "1")
    _task(project, "2")
    offset = root_ordinal_offset(project.pk, document_paths=["1", "1.1", "2"])
    assert offset == 2
    assert [offset_wbs_path(p, offset) for p in ("1", "1.1", "2")] == ["3", "3.1", "4"]


@pytest.mark.django_db
def test_tombstoned_roots_are_ignored_unless_asked_for(project: Project) -> None:
    _task(project, "1")
    _task(project, "7", deleted=True)
    assert root_ordinal_offset(project.pk) == 1
    assert root_ordinal_offset(project.pk, include_deleted=True) == 7


@pytest.mark.django_db
def test_non_numeric_roots_do_not_move_the_offset(project: Project) -> None:
    _task(project, "alpha")
    assert root_ordinal_offset(project.pk) == 0


# ---------------------------------------------------------------------------
# The root-0 collision (#3072)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_project_whose_only_root_is_zero_gets_a_non_colliding_offset(
    project: Project,
) -> None:
    """The named case: existing root ``0``, and a document that also carries ``0``."""
    _task(project, "0")
    _task(project, "0.1")
    document = ["0", "0.1", "1"]
    offset = root_ordinal_offset(project.pk, document_paths=document)
    shifted = [offset_wbs_path(p, offset) for p in document]
    assert "0" not in shifted, shifted
    assert shifted == ["1", "1.1", "2"]


@pytest.mark.django_db
def test_a_document_rooted_at_zero_clears_a_populated_project(project: Project) -> None:
    """The class, not just the named instance.

    Flooring the offset at 1 would fix the ``only root is 0`` case above and leave this
    one collided: under the from-1 assumption a document root of ``0`` maps onto the
    project's *highest* ordinal, whatever that is.
    """
    for root in ("3", "4", "5"):
        _task(project, root)
    document = ["0", "0.2", "1"]
    offset = root_ordinal_offset(project.pk, document_paths=document)
    shifted = [offset_wbs_path(p, offset) for p in document]
    occupied = set(Task.objects.filter(project=project).values_list("wbs_path", flat=True))
    assert not (set(shifted) & occupied), (shifted, occupied)
    assert shifted == ["6", "6.2", "7"]


@pytest.mark.django_db
def test_a_document_numbered_above_the_project_is_not_dragged_backwards(
    project: Project,
) -> None:
    """A negative shift would pull the document onto occupied ground; it clamps at 0."""
    _task(project, "1")
    document = ["9", "10"]
    offset = root_ordinal_offset(project.pk, document_paths=document)
    assert offset == 0
    assert [offset_wbs_path(p, offset) for p in document] == ["9", "10"]


@pytest.mark.django_db
def test_omitting_document_paths_reproduces_the_previous_behavior(project: Project) -> None:
    """The default is the from-1 assumption, so an un-updated caller is no worse off."""
    for root in ("1", "2", "3"):
        _task(project, root)
    assert root_ordinal_offset(project.pk) == 3
    assert root_ordinal_offset(project.pk, document_paths=["1", "2"]) == 3


# ---------------------------------------------------------------------------
# min_root_ordinal
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (["1", "2.3", "10"], 1),
        (["4", "0.1"], 0),
        (["alpha", "beta.1"], None),
        ([None, "", "2"], 2),
        ([], None),
    ],
)
def test_min_root_ordinal(paths: list[str | None], expected: int | None) -> None:
    assert min_root_ordinal(paths) == expected
