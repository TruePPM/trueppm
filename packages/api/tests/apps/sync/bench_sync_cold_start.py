"""Cold-start sync pull benchmark for #2510 (not collected by default).

Run explicitly:  pytest tests/apps/sync/bench_sync_cold_start.py -q -s

Seeds 5,000 tasks that all share one ``sync_seq`` (the post-upgrade backfill
shape, where ties are universal) and times a full ``since=0`` drain of the
tasks collection page by page, comparing the old OR-form resume predicate with
the row-comparison predicate ``paginate_changes`` uses now.
"""

from __future__ import annotations

import time
from datetime import date

import pytest
from django.db.models import F, Q
from django.db.models.fields.tuple_lookups import TupleGreaterThan

from trueppm_api.apps.projects.models import Calendar, Project, Task

N = 5000
PAGE = 500


def _drain(project: Project, resume) -> tuple[float, int]:
    last: tuple[int, object] | None = None
    start = time.perf_counter()
    pages = 0
    while True:
        qs = Task.objects.filter(project=project, sync_seq__gt=0)
        if last is not None:
            qs = qs.filter(resume(*last))
        rows = list(qs.order_by("sync_seq", "id").values_list("sync_seq", "id")[: PAGE + 1])
        pages += 1
        if len(rows) <= PAGE:
            break
        last = rows[PAGE - 1]
    return time.perf_counter() - start, pages


@pytest.mark.django_db
def test_cold_start_drain_or_form_vs_row_comparison() -> None:
    project = Project.objects.create(
        name="Bench", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )
    Task.objects.bulk_create(
        [
            Task(project=project, name=f"T{i}", duration=1, server_version=1, short_id=f"{i:08X}")
            for i in range(N)
        ]
    )
    Task.objects.filter(project=project).update(sync_seq=7)

    def or_form(v: int, i: object) -> Q:
        return Q(sync_seq__gt=v) | Q(sync_seq=v, id__gt=i)

    def row_form(v: int, i: object) -> TupleGreaterThan:
        return TupleGreaterThan((F("sync_seq"), F("pk")), (v, i))

    t_or, pages = _drain(project, or_form)
    t_row, _ = _drain(project, row_form)
    print(f"\n{N} tasks, one sync_seq, {pages} pages: OR {t_or:.3f}s, row-cmp {t_row:.3f}s")
    assert t_row > 0
