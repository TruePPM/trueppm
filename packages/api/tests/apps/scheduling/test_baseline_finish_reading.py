"""Baseline and rollup finish comparisons are measured in working time (#4197).

Follow-up to #4178 (``test_finish_reading.py``). A zero-duration milestone that a
lag lands just after a weekend is shown at the start of the next working day
(#4173), and the end of a Friday is the same point in working time as the start
of the following Monday. These tests pin that every consumer comparing a finish
against a baseline or a sprint end — the ``baseline_drift_detected`` activity row,
the overview's "Slipped +Nd vs baseline" list, a closed sprint's milestone
``slip_days``, the milestone rollup ``variance_days``, and the program rollup's
baseline and schedule variance — reads that weekend hop as no change, and still
reports a real one-working-day slip.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient
from trueppm_scheduler.models import Calendar as SchedCalendar

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Dependency,
    Project,
    ProjectLifecycle,
    Sprint,
    SprintState,
    Task,
    TaskActivityEvent,
    TaskStatus,
)
from trueppm_api.apps.scheduling.finish_reading import values_finish_at_day_start
from trueppm_api.apps.scheduling.tasks import _baseline_drift_event, _run_schedule

User = get_user_model()

MON_FRI = SchedCalendar(working_days=31)
FRI = date(2026, 8, 7)
MON = date(2026, 8, 10)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Mon-Fri")
    return Project.objects.create(
        name="BaselineHop",
        start_date=date(2026, 8, 3),  # Monday
        status_date=date(2026, 8, 3),
        calendar=cal,
    )


@pytest.fixture
def admin(project: Project) -> Any:
    user = User.objects.create_user(username="bl_hop_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def client(admin: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


@pytest.fixture
def network(project: Project) -> tuple[Task, Dependency]:
    """``A(5d, Mon..Fri) -FS-> M``: M is the project finish."""
    a = Task.objects.create(project=project, name="A", duration=5)
    m = Task.objects.create(project=project, name="M", duration=0, is_milestone=True)
    dep = Dependency.objects.create(predecessor=a, successor=m, dep_type="FS")
    return m, dep


def _recompute(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


def _set_lag(project: Project, dep: Dependency, lag: int) -> None:
    Dependency.objects.filter(pk=dep.pk).update(lag=lag)
    _recompute(project)


def _capture_baseline(client: APIClient, project: Project) -> Baseline:
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        res = client.post(f"/api/v1/projects/{project.pk}/baselines/")
    assert res.status_code == 201, res.content
    baseline = Baseline.objects.get(pk=res.data["id"])
    Baseline.objects.filter(project=project).exclude(pk=baseline.pk).update(is_active=False)
    Baseline.objects.filter(pk=baseline.pk).update(is_active=True)
    return baseline


def _drift_events(task: Task) -> list[TaskActivityEvent]:
    return list(
        TaskActivityEvent.objects.filter(task_id=task.pk, event_type="baseline_drift_detected")
    )


def _slipped_items(client: APIClient, project: Project) -> list[dict[str, Any]]:
    res = client.get(f"/api/v1/projects/{project.pk}/attention/")
    assert res.status_code == 200
    return [i for i in res.json()["items"] if i["type"] == "baseline_drift"]


def _task_baseline_deltas(client: APIClient, project: Project, task: Task) -> tuple[Any, Any]:
    """``(start_delta_days, finish_delta_days)`` from the task's Baseline tab endpoint."""
    res = client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/baseline/")
    assert res.status_code == 200, res.content
    body = res.json()
    return body["start_delta_days"], body["finish_delta_days"]


def _sprint(project: Project, m: Task) -> Sprint:
    # Ends Friday: the milestone at the start of the next Monday is on time.
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 8, 3),
        finish_date=FRI,
        state=SprintState.ACTIVE,
        target_milestone=m,
    )


# ---------------------------------------------------------------------------
# Capture
# ---------------------------------------------------------------------------


def test_values_row_reading_mirrors_the_task_rule() -> None:
    row = {
        "early_finish": MON,
        "is_milestone": True,
        "milestone_at_day_end": False,
        "actual_start": None,
        "actual_finish": None,
        "percent_complete": 0.0,
    }
    assert values_finish_at_day_start(row) is True
    assert values_finish_at_day_start({**row, "milestone_at_day_end": True}) is False
    assert values_finish_at_day_start({**row, "is_milestone": False}) is False
    # No finish, no edge to read.
    assert values_finish_at_day_start({**row, "early_finish": None}) is None


@pytest.mark.django_db
def test_baseline_capture_records_the_edge_of_the_day(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    _m, dep = network
    _set_lag(project, dep, 1)  # M at the start of Monday
    baseline = _capture_baseline(client, project)
    readings = dict(
        BaselineTask.objects.filter(baseline=baseline).values_list(
            "task_name", "finish_at_day_start"
        )
    )
    assert readings == {"A": False, "M": True}
    # A first-class API fact, so a client comparing baselines reads it too.
    res = client.get(f"/api/v1/projects/{project.pk}/baselines/{baseline.pk}/")
    assert res.status_code == 200
    assert {t["task_name"]: t["finish_at_day_start"] for t in res.json()["tasks"]} == readings


@pytest.mark.django_db
def test_commit_moment_records_the_edge_of_the_day(
    project: Project, network: tuple[Task, Dependency]
) -> None:
    from trueppm_api.apps.projects.commit_moment import commit_project

    _m, dep = network
    _set_lag(project, dep, 1)
    Project.objects.filter(pk=project.pk).update(lifecycle=ProjectLifecycle.DRAFT)
    project.refresh_from_db()
    result = commit_project(project, user=None)
    readings = dict(
        BaselineTask.objects.filter(baseline=result.baseline).values_list(
            "task_name", "finish_at_day_start"
        )
    )
    assert readings == {"A": False, "M": True}


# ---------------------------------------------------------------------------
# End to end: a weekend hop is no drift, a real slip still is
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_weekend_hop_against_the_baseline_is_no_drift_anywhere(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    from trueppm_api.apps.projects.program_rollup import _baseline_variance_by_project
    from trueppm_api.apps.projects.services import (
        _milestone_slip_for_sprint,
        batch_compute_milestone_rollups,
        compute_milestone_rollup_payload,
    )

    m, dep = network
    _recompute(project)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (FRI, True)
    _capture_baseline(client, project)

    # A one-day lag lands M at Sunday midnight, shown at the start of Monday:
    # the same working-time point as the baselined end of Friday.
    _set_lag(project, dep, 1)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, False)
    assert m.is_critical

    assert _drift_events(m) == []
    assert _slipped_items(client, project) == []
    assert _task_baseline_deltas(client, project, m) == (0, 0)
    assert _baseline_variance_by_project([project.pk]) == {project.pk: 0.0}

    sprint = _sprint(project, m)
    slip = _milestone_slip_for_sprint(
        Sprint.objects.select_related("target_milestone").get(pk=sprint.pk)
    )
    assert slip is not None
    assert slip["slip_days"] == 0
    rollup = compute_milestone_rollup_payload(m)
    assert rollup is not None
    assert rollup["variance_days"] == 0
    batched = batch_compute_milestone_rollups([m])[m.pk]
    assert batched is not None
    assert batched["variance_days"] == 0


@pytest.mark.django_db
def test_a_real_one_working_day_slip_is_still_drift(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    from trueppm_api.apps.projects.program_rollup import _baseline_variance_by_project
    from trueppm_api.apps.projects.services import (
        _milestone_slip_for_sprint,
        compute_milestone_rollup_payload,
    )

    m, dep = network
    _recompute(project)
    _capture_baseline(client, project)

    # Three days of lag end at Tuesday midnight, after Monday's work: the end of
    # Monday, one working day (three calendar days) past the baselined Friday.
    _set_lag(project, dep, 3)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, True)

    events = _drift_events(m)
    assert [e.detail["drift_days"] for e in events] == [3]
    assert _task_baseline_deltas(client, project, m) == (3, 3)
    assert [i["detail"] for i in _slipped_items(client, project)] == ["Slipped +3d vs baseline"]
    assert _baseline_variance_by_project([project.pk]) == {project.pk: 3.0}

    sprint = _sprint(project, m)
    slip = _milestone_slip_for_sprint(
        Sprint.objects.select_related("target_milestone").get(pk=sprint.pk)
    )
    assert slip is not None
    assert slip["slip_days"] == 3
    rollup = compute_milestone_rollup_payload(m)
    assert rollup is not None
    # The sprint ends a working day before the milestone.
    assert rollup["variance_days"] == -3


@pytest.mark.django_db
def test_start_of_day_baseline_now_at_end_of_same_day_is_a_slip(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    """A baseline at the start of Monday, now at the end of it: +1 working day.

    The shown day did not move at all, so the overview's shown-day SQL filter must
    not drop this candidate before the working-time comparison sees it.
    """
    m, dep = network
    _set_lag(project, dep, 1)  # start of Monday
    _capture_baseline(client, project)
    _set_lag(project, dep, 3)  # end of Monday
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, True)

    assert [e.detail["drift_days"] for e in _drift_events(m)] == [3]
    assert [i["detail"] for i in _slipped_items(client, project)] == ["Slipped +3d vs baseline"]


@pytest.mark.django_db
def test_hitting_a_start_of_day_milestone_the_friday_before_is_on_time(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    """Program schedule variance: an actual finish is read as the end of its day."""
    from trueppm_api.apps.projects.program_rollup import _schedule_variance_by_project

    m, dep = network
    _set_lag(project, dep, 1)  # baselined at the start of Monday
    _capture_baseline(client, project)
    Task.objects.filter(pk=m.pk).update(
        status=TaskStatus.COMPLETE, actual_finish=FRI, percent_complete=100
    )
    assert _schedule_variance_by_project([project.pk]) == {project.pk: 0.0}


# ---------------------------------------------------------------------------
# Per-task variances on the task list (#4203)
# ---------------------------------------------------------------------------


def _task_row(client: APIClient, project: Project, task: Task) -> dict[str, Any]:
    res = client.get(f"/api/v1/tasks/?project={project.pk}&page_size=500")
    assert res.status_code == 200, res.content
    body = res.json()
    rows = body["results"] if isinstance(body, dict) else body
    return next(r for r in rows if r["id"] == str(task.pk))


@pytest.mark.django_db
def test_task_list_forecast_variance_reads_a_weekend_hop_as_zero(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    """``baseline_finish_variance_days``: the board/drawer baseline chip's number."""
    m, dep = network
    _recompute(project)
    _capture_baseline(client, project)  # end of Friday
    _set_lag(project, dep, 1)  # start of Monday: same working-time point
    row = _task_row(client, project, m)
    assert (row["baseline_finish"], row["early_finish"]) == (FRI.isoformat(), MON.isoformat())
    assert row["baseline_finish_variance_days"] == 0
    # The Baseline tab endpoint (#4197) and the list now agree.
    assert _task_baseline_deltas(client, project, m)[1] == 0


@pytest.mark.django_db
def test_task_list_forecast_variance_still_reports_a_real_slip(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    m, dep = network
    _recompute(project)
    _capture_baseline(client, project)
    _set_lag(project, dep, 3)  # end of Monday: one working day late
    assert _task_row(client, project, m)["baseline_finish_variance_days"] == 3


@pytest.mark.django_db
def test_task_list_schedule_variance_matches_the_program_rollup(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    """``schedule_variance_days``: a start-of-day milestone hit the Friday before is on time.

    Previously -3 on the task list while the program rollup's average of the same
    quantity (#4197) read 0 — the two must agree.
    """
    from trueppm_api.apps.projects.program_rollup import _schedule_variance_by_project

    m, dep = network
    _set_lag(project, dep, 1)  # baselined at the start of Monday
    _capture_baseline(client, project)
    Task.objects.filter(pk=m.pk).update(
        status=TaskStatus.COMPLETE, actual_finish=FRI, percent_complete=100
    )
    assert _task_row(client, project, m)["schedule_variance_days"] == 0
    assert _schedule_variance_by_project([project.pk]) == {project.pk: 0.0}

    # A real lateness is still reported: finished the Monday after = +3.
    Task.objects.filter(pk=m.pk).update(actual_finish=MON)
    assert _task_row(client, project, m)["schedule_variance_days"] == 3


@pytest.mark.django_db
def test_task_variances_without_a_baseline_are_null(
    client: APIClient, project: Project, network: tuple[Task, Dependency]
) -> None:
    m, _ = network
    _recompute(project)
    row = _task_row(client, project, m)
    assert row["baseline_finish_variance_days"] is None
    assert row["schedule_variance_days"] is None


def test_task_list_variance_query_count_does_not_grow_with_rows(
    client: APIClient, project: Project, admin: Any, django_assert_num_queries: Any
) -> None:
    """No N+1: the calendar is composed once per project per response, not per row.

    Every row here is a start-of-day milestone against an end-of-day baseline —
    the case that needs the project calendar — so a per-row compose would scale
    the count with the page.
    """
    baseline = Baseline.objects.create(
        project=project, name="B", created_by=admin, is_active=True, has_cpm_dates=True
    )

    def add(n: int) -> None:
        for i in range(n):
            ms = Task.objects.create(
                project=project,
                name=f"M{Task.objects.count()}-{i}",
                duration=0,
                is_milestone=True,
                early_start=MON,
                early_finish=MON,
                milestone_at_day_end=False,
            )
            BaselineTask.objects.create(
                baseline=baseline,
                task_id=ms.pk,
                task_name=ms.name,
                start=FRI,
                finish=FRI,
                duration=0,
                finish_at_day_start=False,
            )

    def fetch() -> list[dict[str, Any]]:
        res = client.get(f"/api/v1/tasks/?project={project.pk}&page_size=500")
        assert res.status_code == 200, res.content
        body = res.json()
        return body["results"] if isinstance(body, dict) else body

    add(1)
    fetch()  # warm-up: first-use singletons would count once only
    with CaptureQueriesContext(connection) as ctx:
        rows = fetch()
    assert [r["baseline_finish_variance_days"] for r in rows] == [0]
    one = len(ctx.captured_queries)

    add(4)
    with django_assert_num_queries(one):
        rows = fetch()
    assert [r["baseline_finish_variance_days"] for r in rows] == [0] * 5


def test_bulk_response_composes_the_calendar_once_not_per_row(
    client: APIClient, project: Project, admin: Any
) -> None:
    """The bulk endpoint serializes each applied row on its own; the calendar memo
    must still span the batch — one compose per response, not one per row."""
    from trueppm_api.apps.scheduling import calendars

    baseline = Baseline.objects.create(
        project=project, name="B", created_by=admin, is_active=True, has_cpm_dates=True
    )
    milestones = []
    for i in range(4):
        ms = Task.objects.create(
            project=project,
            name=f"BM{i}",
            duration=0,
            is_milestone=True,
            early_start=MON,
            early_finish=MON,
            milestone_at_day_end=False,
        )
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=ms.pk,
            task_name=ms.name,
            start=FRI,
            finish=FRI,
            duration=0,
            finish_at_day_start=False,
        )
        milestones.append(ms)

    real = calendars.project_sched_calendars
    calls: list[Any] = []

    def counting(project_ids: Any) -> dict[str, Any]:
        ids = list(project_ids)
        calls.append(ids)
        return real(ids)

    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch.object(calendars, "project_sched_calendars", counting),
    ):
        res = client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/",
            {
                "operations": [
                    {"op": "update", "id": str(ms.pk), "data": {"name": f"{ms.name} renamed"}}
                    for ms in milestones
                ]
            },
            format="json",
        )
    assert res.status_code == 207, res.content
    assert [e["task"]["baseline_finish_variance_days"] for e in res.data["applied"]] == [0] * 4
    # Other batched readers (the milestone rollup attach) call it with no ids,
    # which composes nothing and issues no query; count real composes only.
    assert len([ids for ids in calls if ids]) == 1


# ---------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------


def _milestone(day: date, *, day_end: bool) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(
        id="m",
        early_finish=day,
        is_milestone=True,
        milestone_at_day_end=day_end,
        actual_start=None,
        actual_finish=None,
        percent_complete=0.0,
    )


def test_drift_event_reads_both_sides_in_working_time() -> None:
    hopped = _milestone(MON, day_end=False)
    # Baselined at the end of Friday, now at the start of Monday: no drift.
    assert _baseline_drift_event(hopped, FRI, ("b", FRI, False), calendar=MON_FRI) is None
    # A pre-upgrade baseline row (reading unknown) reads as the end of its day.
    assert _baseline_drift_event(hopped, FRI, ("b", FRI, None), calendar=MON_FRI) is None
    # Without a calendar it falls back to the shown-day difference, as before.
    fallback = _baseline_drift_event(hopped, FRI, ("b", FRI, False))
    assert fallback is not None
    assert fallback.detail["drift_days"] == 3
    # A real slip, from within the baseline to past it.
    slipped = _baseline_drift_event(
        _milestone(MON, day_end=True), FRI, ("b", FRI, False), calendar=MON_FRI
    )
    assert slipped is not None
    assert slipped.detail["drift_days"] == 3
    # Already drifted last pass (the prior reading was the end of Monday): no re-fire.
    assert (
        _baseline_drift_event(
            _milestone(MON, day_end=True),
            MON,
            ("b", FRI, False),
            prior_day_end=True,
            calendar=MON_FRI,
        )
        is None
    )


def test_rollup_variance_reads_a_start_of_day_milestone_in_working_time() -> None:
    from types import SimpleNamespace

    from trueppm_api.apps.projects.services import _assemble_milestone_rollup

    sprint = SimpleNamespace(
        pk=1,
        state=SprintState.ACTIVE,
        finish_date=FRI,
        committed_points=0,
        committed_task_count=0,
        completed_points=0,
        completed_task_count=0,
        binding_committed_snapshot=None,
    )
    hopped = _milestone(MON, day_end=False)
    with_cal = _assemble_milestone_rollup(hopped, [sprint], {}, {}, MON_FRI)
    assert with_cal is not None
    assert with_cal["variance_days"] == 0
    without = _assemble_milestone_rollup(hopped, [sprint], {}, {})
    assert without is not None
    assert without["variance_days"] == -3


@pytest.mark.django_db
def test_batch_rollup_composes_one_calendar_per_project_not_per_milestone(
    project: Project,
) -> None:
    """The start-of-day variance path loads calendars in one batch (no N+1)."""
    from trueppm_api.apps.projects.services import batch_compute_milestone_rollups

    def milestones(n: int) -> list[Task]:
        out = []
        for i in range(n):
            ms = Task.objects.create(
                project=project,
                name=f"M{n}-{i}",
                duration=0,
                is_milestone=True,
                early_start=MON,
                early_finish=MON,
                milestone_at_day_end=False,
            )
            _sprint(project, ms)
            out.append(ms)
        return out

    one, three = milestones(1), milestones(3)

    def count(ms: list[Task]) -> int:
        with CaptureQueriesContext(connection) as ctx:
            result = batch_compute_milestone_rollups(ms)
        assert all(r is not None and r["variance_days"] == 0 for r in result.values())
        return len(ctx.captured_queries)

    # One warm-up first: the workspace singleton the calendar resolver reads is
    # created on first use, which would count as a query only on that call.
    count(one)
    assert count(three) == count(one)


def test_fixture_dates_are_one_mon_fri_weekend_apart() -> None:
    assert FRI.weekday() == 4
    assert MON.weekday() == 0
    assert (MON - FRI).days == 3
