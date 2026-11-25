"""``GET /projects/{id}/baselines/{baseline_id}/variance/`` (ADR-1485 D3/D10, #5129)."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    CalendarException,
    Dependency,
    Project,
    Task,
)

User = get_user_model()

MON = date(2026, 3, 2)


def _d(offset: int) -> date:
    """``MON`` + ``offset`` calendar days."""
    return MON + timedelta(days=offset)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Variance", start_date=MON, status_date=MON, calendar=calendar
    )


def _client(project: Project, role: int | None = Role.VIEWER) -> APIClient:
    user = User.objects.create_user(username=f"u-{role}", password="pw")
    if role is not None:
        ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _task(project: Project, name: str, start: date, finish: date, **extra: Any) -> Task:
    extra.setdefault("duration", 5)
    return Task.objects.create(
        project=project,
        name=name,
        early_start=start,
        early_finish=finish,
        scheduled_start=start,
        **extra,
    )


def _snap(baseline: Baseline, task: Task, start: date | None, finish: date | None) -> None:
    BaselineTask.objects.create(
        baseline=baseline,
        task_id=task.pk,
        task_name=task.name,
        start=start,
        finish=finish,
        finish_at_day_start=False,
        duration=task.duration,
    )


@pytest.fixture
def baseline(project: Project) -> Baseline:
    return Baseline.objects.create(project=project, name="v1", has_cpm_dates=True)


def _url(project: Project, baseline: Baseline, query: str = "") -> str:
    return f"/api/v1/projects/{project.pk}/baselines/{baseline.pk}/variance/{query}"


def _rows(response: Any) -> dict[str, dict[str, Any]]:
    return {row["task_name"]: row for row in response.data["results"]}


@pytest.fixture
def chain(project: Project, baseline: Baseline) -> tuple[Task, Task]:
    """A (5d from Monday) then B (2d), stored exactly as the CPM pass would.

    The baseline had B on Thu 3/5 - Fri 3/6; it now runs Mon 3/9 - Tue 3/10.
    """
    a = _task(project, "A", _d(0), _d(4))
    b = _task(project, "B", _d(7), _d(8), duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", lag=0)
    _snap(baseline, a, _d(0), _d(4))
    _snap(baseline, b, _d(3), _d(4))
    return a, b


def test_late_is_positive_and_counted_in_working_days(
    project: Project, baseline: Baseline, chain: tuple[Task, Task]
) -> None:
    response = _client(project).get(_url(project, baseline))

    assert response.status_code == 200, response.data
    rows = _rows(response)
    assert list(rows) == ["B"]  # A has not moved, so min_days=1 hides it
    # Fri -> Tue is 4 calendar days and 2 working days.
    assert rows["B"]["finish_delta_working_days"] == 2
    # Thu -> Mon: Thu and Fri.
    assert rows["B"]["start_delta_working_days"] == 2
    assert response.data["added"] == 0
    assert response.data["removed"] == 0
    assert response.data["min_days"] == 1
    assert response.data["baseline_id"] == str(baseline.pk)


def test_early_is_negative(project: Project, baseline: Baseline) -> None:
    task = _task(project, "Early", _d(3), _d(4), duration=2)
    _snap(baseline, task, _d(7), _d(8))

    row = _rows(_client(project).get(_url(project, baseline)))["Early"]

    assert row["start_delta_working_days"] == -2
    assert row["finish_delta_working_days"] == -2


def test_a_calendar_holiday_is_not_a_day_of_slip(project: Project, baseline: Baseline) -> None:
    CalendarException.objects.create(calendar=project.calendar, exc_start=_d(7), exc_end=_d(7))
    task = _task(project, "Holiday", _d(8), _d(8), duration=1)
    _snap(baseline, task, _d(4), _d(4))

    row = _rows(_client(project).get(_url(project, baseline)))["Holiday"]

    assert row["finish_delta_working_days"] == 1


def test_a_milestone_that_only_hops_the_weekend_has_not_moved(
    project: Project, baseline: Baseline
) -> None:
    gate = _task(
        project, "Gate", _d(7), _d(7), duration=0, is_milestone=True, milestone_at_day_end=False
    )
    _snap(baseline, gate, _d(4), _d(4))

    response = _client(project).get(_url(project, baseline, "?min_days=0"))

    row = _rows(response)["Gate"]
    assert (row["start_delta_working_days"], row["finish_delta_working_days"]) == (0, 0)


def test_min_days_filters_and_zero_lists_every_compared_task(
    project: Project, baseline: Baseline, chain: tuple[Task, Task]
) -> None:
    client = _client(project)

    assert list(_rows(client.get(_url(project, baseline, "?min_days=0")))) == ["B", "A"]
    assert list(_rows(client.get(_url(project, baseline, "?min_days=2")))) == ["B"]
    assert client.get(_url(project, baseline, "?min_days=3")).data["count"] == 0


@pytest.mark.parametrize("value", ["-1", "x", "1.5"])
def test_bad_min_days_is_400(project: Project, baseline: Baseline, value: str) -> None:
    response = _client(project).get(_url(project, baseline, f"?min_days={value}"))

    assert response.status_code == 400


def test_added_and_removed_are_counted(project: Project, baseline: Baseline) -> None:
    gone = _task(project, "Removed", _d(0), _d(4))
    _snap(baseline, gone, _d(0), _d(4))
    gone.soft_delete()
    _task(project, "Added", _d(0), _d(4))

    response = _client(project).get(_url(project, baseline, "?min_days=0"))

    assert (response.data["added"], response.data["removed"]) == (1, 1)
    assert response.data["results"] == []


def test_paginates_with_the_latest_slip_first(project: Project, baseline: Baseline) -> None:
    for i in range(52):
        task = _task(project, f"T{i:02d}", _d(7), _d(7), duration=1)
        _snap(baseline, task, _d(4), _d(4))
    worst = _task(project, "Worst", _d(14), _d(14), duration=1)
    _snap(baseline, worst, _d(4), _d(4))
    client = _client(project)

    first = client.get(_url(project, baseline))
    second = client.get(_url(project, baseline, "?page=2"))

    assert first.data["count"] == 53
    assert len(first.data["results"]) == 50
    assert first.data["next"] and first.data["previous"] is None
    assert first.data["results"][0]["task_name"] == "Worst"
    assert len(second.data["results"]) == 3


def test_query_count_does_not_grow_with_rows(project: Project, baseline: Baseline) -> None:
    client = _client(project)

    def add(prefix: str, n: int) -> None:
        for i in range(n):
            task = _task(project, f"{prefix}{i}", _d(7), _d(7), duration=1)
            _snap(baseline, task, _d(4), _d(4))

    def queries() -> int:
        with CaptureQueriesContext(connection) as ctx:
            assert client.get(_url(project, baseline)).status_code == 200
        return len(ctx.captured_queries)

    add("a", 3)
    queries()  # warm any per-process cache
    small = queries()
    add("b", 20)

    assert queries() == small


def test_rows_carry_the_servers_cause_and_derivation_ref(
    project: Project, baseline: Baseline, chain: tuple[Task, Task]
) -> None:
    _, b = chain

    row = _rows(_client(project).get(_url(project, baseline)))["B"]

    assert row["derivation_ref"] == {"task_id": str(b.pk), "quantity": "early_finish"}
    assert row["cause"] == (
        "Driven by 'A' (FS link): 2026-03-09. Then 2 working day(s) of work from its start."
    )


def test_no_cause_when_the_stored_finish_awaits_recalculation(
    project: Project, baseline: Baseline, chain: tuple[Task, Task]
) -> None:
    _, b = chain
    Task.objects.filter(pk=b.pk).update(early_finish=_d(11))

    row = _rows(_client(project).get(_url(project, baseline)))["B"]

    assert row["cause"] is None
    assert row["derivation_ref"]["task_id"] == str(b.pk)


def test_a_summary_row_is_a_rollup_with_no_derivation_ref(
    project: Project, baseline: Baseline
) -> None:
    summary = _task(project, "Phase", _d(0), _d(8), wbs_path="1")
    _task(project, "Leaf", _d(0), _d(4), wbs_path="1.1")
    _snap(baseline, summary, _d(0), _d(4))

    row = _rows(_client(project).get(_url(project, baseline)))["Phase"]

    assert row["cause"] == "Rolled up from its subtasks."
    assert row["derivation_ref"] is None


@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.OWNER])
def test_any_member_reads(project: Project, baseline: Baseline, role: int) -> None:
    assert _client(project, role).get(_url(project, baseline)).status_code == 200


def test_non_member_and_anonymous_are_refused(project: Project, baseline: Baseline) -> None:
    assert _client(project, None).get(_url(project, baseline)).status_code == 403
    assert APIClient().get(_url(project, baseline)).status_code == 401


def test_another_projects_or_a_deleted_baseline_is_404(
    project: Project, baseline: Baseline, calendar: Calendar
) -> None:
    other = Project.objects.create(name="Other", start_date=MON, calendar=calendar)
    foreign = Baseline.objects.create(project=other, name="theirs")
    client = _client(project)

    assert client.get(_url(project, foreign)).status_code == 404
    baseline.soft_delete()
    assert client.get(_url(project, baseline)).status_code == 404
