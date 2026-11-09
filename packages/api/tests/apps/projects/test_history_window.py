"""Burn and throughput replays bound their history read to the window (#3579).

The correctness trap is the carry-in: a task whose last edit predates ``since`` must
still contribute its state to every day of the window, so a bare ``history_date >=
since`` filter is wrong. These tests pin that, equivalence with the old unbounded
read, and that the rows read stay constant as pre-window history grows.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.projects.services import (
    _burn_history_index,
    _daily_burn_series,
    _date_range_inclusive,
    _project_weekly_throughput,
    burn_series,
)


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="P", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )


def _at(day: date, hour: int = 12) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=timezone.get_current_timezone()) + (
        timedelta(hours=hour)
    )


def _edit(task: Task, when: datetime, **fields: Any) -> None:
    """Apply ``fields`` to the task and stamp the resulting history row at ``when``."""
    for k, v in fields.items():
        setattr(task, k, v)
    task.save()
    rec = task.history.latest()  # type: ignore[attr-defined]
    rec.history_date = when
    rec.save()


def _restamp_creation(task: Task, when: datetime) -> None:
    rec = task.history.earliest()  # type: ignore[attr-defined]
    rec.history_date = when
    rec.save()


def _old_index(project: Project, until: date) -> dict[Any, list[dict[str, Any]]]:
    """The pre-#3579 read: every row up to ``until``, no lower bound."""
    hist = Task.history.model
    end = _at(until, 0).replace(hour=23, minute=59, second=59, microsecond=999999)
    by_task: dict[Any, list[dict[str, Any]]] = {}
    for row in (
        hist.objects.filter(project_id=project.pk, history_date__lte=end)
        .order_by("-history_date")
        .values("id", "history_date", "status", "story_points", "history_type", "is_deleted")
    ):
        by_task.setdefault(row["id"], []).append(row)
    return by_task


@pytest.mark.django_db
def test_task_last_edited_before_window_contributes_every_day(project: Project) -> None:
    """Regression for the carry-in trap: no in-window row, state still counted."""
    today = timezone.localdate()
    long_ago = today - timedelta(days=60)
    quiet = Task.objects.create(project=project, name="quiet", duration=1, story_points=3)
    _restamp_creation(quiet, _at(long_ago))
    done = Task.objects.create(project=project, name="done", duration=1, story_points=5)
    _restamp_creation(done, _at(long_ago))
    _edit(done, _at(long_ago + timedelta(days=1)), status=TaskStatus.COMPLETE)

    since, until = today - timedelta(days=2), today
    result = burn_series(
        project.pk, chart_type="burndown", since=since, until=until, metric="points"
    )

    assert [p["scope"] for p in result["series"]] == [8, 8, 8]
    assert [p["actual"] for p in result["series"]] == [3, 3, 3]


@pytest.mark.django_db
def test_windowed_replay_matches_unbounded_replay(project: Project) -> None:
    """Edits before, inside and after the window give byte-identical series."""
    today = timezone.localdate()
    since, until = today - timedelta(days=10), today - timedelta(days=3)
    days = _date_range_inclusive(since, until)

    a = Task.objects.create(project=project, name="a", duration=1, story_points=2)
    _restamp_creation(a, _at(since - timedelta(days=30)))
    _edit(a, _at(since - timedelta(days=5)), story_points=4)  # before
    _edit(a, _at(since + timedelta(days=2)), status=TaskStatus.COMPLETE)  # inside
    _edit(a, _at(until + timedelta(days=1)), status=TaskStatus.IN_PROGRESS)  # after

    b = Task.objects.create(project=project, name="b", duration=1, story_points=1)
    _restamp_creation(b, _at(since + timedelta(days=1)))  # created inside
    _edit(b, _at(since + timedelta(days=4)), is_deleted=True)  # deleted inside

    c = Task.objects.create(project=project, name="c", duration=1, story_points=7)
    _restamp_creation(c, _at(until + timedelta(days=1)))  # created after

    d = Task.objects.create(project=project, name="d", duration=1, story_points=6)
    _restamp_creation(d, _at(since - timedelta(days=9)))
    _edit(d, _at(since - timedelta(days=1)), is_deleted=True)  # deleted before

    for chart_type in ("burndown", "burnup"):
        for metric in ("tasks", "points"):
            new = _daily_burn_series(
                _burn_history_index(project.pk, since, until),
                days,
                chart_type=chart_type,
                metric=metric,
            )
            old = _daily_burn_series(
                _old_index(project, until), days, chart_type=chart_type, metric=metric
            )
            assert new == old, (chart_type, metric)
            assert any(p["scope"] for p in new), (chart_type, metric)


@pytest.mark.django_db
def test_rows_read_do_not_grow_with_pre_window_history(project: Project) -> None:
    """Rows fetched stay constant as pre-window history grows (one carry-in per task)."""
    today = timezone.localdate()
    since, until = today - timedelta(days=2), today
    t = Task.objects.create(project=project, name="t", duration=1, story_points=1)
    _restamp_creation(t, _at(today - timedelta(days=100)))

    def rows_read() -> int:
        return sum(len(v) for v in _burn_history_index(project.pk, since, until).values())

    baseline = rows_read()
    for i in range(12):
        _edit(t, _at(today - timedelta(days=90 - i)), story_points=i + 2)
    assert rows_read() == baseline == 1
    # The unbounded read would have grown with every edit.
    assert sum(len(v) for v in _old_index(project, until).values()) == 13


@pytest.mark.django_db
def test_history_reads_are_two_queries_and_carry_in_is_distinct_on(project: Project) -> None:
    Task.objects.create(project=project, name="t", duration=1)
    today = timezone.localdate()
    with CaptureQueriesContext(connection) as ctx:
        _burn_history_index(project.pk, today - timedelta(days=1), today)
    hist = [q["sql"] for q in ctx.captured_queries if "historicaltask" in q["sql"].lower()]
    assert len(hist) == 2
    carry = [q for q in hist if "DISTINCT ON" in q]
    assert len(carry) == 1
    # DISTINCT ON must lead its ORDER BY with its own key (the id column, position 1) or
    # Postgres rejects it; a leaked Meta.ordering would put history_date first.
    assert " ORDER BY 1 ASC," in carry[0]


@pytest.mark.django_db
def test_weekly_throughput_counts_completion_with_carry_in(project: Project) -> None:
    """Throughput: in-window transitions count; an edit while already COMPLETE does not."""
    today = timezone.localdate()
    window_start = today - timedelta(days=89)

    # IN_PROGRESS before the window, completes inside it -> 1 event.
    a = Task.objects.create(project=project, name="a", duration=1)
    _restamp_creation(a, _at(window_start - timedelta(days=20)))
    _edit(a, _at(window_start - timedelta(days=10)), status=TaskStatus.IN_PROGRESS)
    _edit(a, _at(today - timedelta(days=3)), status=TaskStatus.COMPLETE)

    # COMPLETE before the window, edited inside it -> carry-in prevents a false event.
    b = Task.objects.create(project=project, name="b", duration=1)
    _restamp_creation(b, _at(window_start - timedelta(days=20)))
    _edit(b, _at(window_start - timedelta(days=10)), status=TaskStatus.COMPLETE)
    _edit(b, _at(today - timedelta(days=5)), name="renamed")

    weeks, since = _project_weekly_throughput(project.pk, window_days=90)
    assert since == window_start
    assert sum(w["completed_count"] for w in weeks) == 1


@pytest.mark.django_db
def test_equal_history_date_tiebreaks_on_history_id(project: Project) -> None:
    """Two rows at the same instant: window and carry-in queries pick the same latest."""
    today = timezone.localdate()
    since, until = today - timedelta(days=2), today
    stamp = _at(today - timedelta(days=30))
    t = Task.objects.create(project=project, name="t", duration=1)
    _restamp_creation(t, stamp)
    _edit(t, stamp, status=TaskStatus.COMPLETE)  # same instant, larger history_id

    # Carry-in path: both rows pre-date the window.
    carry = _burn_history_index(project.pk, since, until)[t.pk]
    assert [r["status"] for r in carry] == [TaskStatus.COMPLETE]

    # Window path: both rows inside a window containing the instant.
    win = _burn_history_index(project.pk, today - timedelta(days=40), until)[t.pk]
    assert [r["status"] for r in win] == [TaskStatus.COMPLETE, TaskStatus.NOT_STARTED]
