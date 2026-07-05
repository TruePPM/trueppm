"""History-aware sample backfill assertions (#376, ADR-0211).

``test_sample_history`` covers the replayed event timeline (status moves, comments,
sprint verdicts). This module covers the 0.4 history-depth backfill layered on top:
60 days of ProjectForecastSnapshot drift, PTO CalendarExceptions, and the
near-infeasible cross-project commitment — the data the differentiator surfaces
(forecast-trend chart #368, capacity reality #369, dependency reality #372) read.

One import of the Atlas sample serves every assertion (the import is expensive), so
the load is a module-scoped fixture.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import (
    CalendarException,
    Dependency,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.seed.samples import load_sample
from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot

pytestmark = pytest.mark.django_db

User = get_user_model()

FORECAST_DAYS = 60


@pytest.fixture
def program(django_user_model: Any) -> Any:
    owner = django_user_model.objects.create_user(username="fc-owner", email="fc@example.com")
    return load_sample("atlas-platform-launch", owner=owner, create_users=True)


def _project(program: Any, slug_fragment: str) -> Project:
    return Project.objects.get(program=program, name__icontains=slug_fragment)


# --- forecast history --------------------------------------------------------


def test_each_project_has_60_days_of_forecast_history(program: Any) -> None:
    # The trend chart (#368) needs ~60 days of snapshots to render a line; every
    # Atlas project authors a forecast_history block, so each gets exactly 60.
    for project in Project.objects.filter(program=program):
        count = ProjectForecastSnapshot.objects.filter(project=project).count()
        assert count == FORECAST_DAYS, (
            f"{project.name}: expected {FORECAST_DAYS} snapshots, got {count}"
        )


def test_forecast_snapshots_span_the_window_and_end_today(program: Any) -> None:
    project = _project(program, "Platform Core")
    rows = list(ProjectForecastSnapshot.objects.filter(project=project).order_by("captured_at"))
    days_spanned = (rows[-1].captured_at.date() - rows[0].captured_at.date()).days
    assert days_spanned == FORECAST_DAYS - 1, days_spanned
    # Newest snapshot sits on the import day (the anchor), so the chart's right
    # edge is "today", not a stale date.
    assert rows[-1].captured_at.date() == date.today()


def test_forecast_drifts_right_while_commitment_holds(program: Any) -> None:
    # The signature demo: the CPM finish slips right over the window while the
    # promised date stays fixed, so total_float pressure crosses from + to -.
    project = _project(program, "Platform Core")
    rows = list(ProjectForecastSnapshot.objects.filter(project=project).order_by("captured_at"))
    oldest, newest = rows[0], rows[-1]

    # CPM finish walked right (later) over the window.
    assert newest.cpm_finish > oldest.cpm_finish, (oldest.cpm_finish, newest.cpm_finish)
    # Float pressure tightened and crossed zero: positive slack early, breached late.
    assert oldest.total_float_days > 0, oldest.total_float_days
    assert newest.total_float_days < 0, newest.total_float_days
    # total_float is derived as (commitment - cpm_finish): the commitment is stable,
    # so float + cpm_finish maps to the same commitment date on every row.
    commit_oldest = oldest.cpm_finish + timedelta(days=oldest.total_float_days)
    commit_newest = newest.cpm_finish + timedelta(days=newest.total_float_days)
    assert commit_oldest == commit_newest, "commitment date must not move over the window"


def test_monte_carlo_band_present_ordered_and_drifting(program: Any) -> None:
    project = _project(program, "Platform Core")
    rows = list(ProjectForecastSnapshot.objects.filter(project=project).order_by("captured_at"))
    # Every row carries an MC band (the fixture authored p50/p80/p95) that stays
    # ordered p50 <= p80 <= p95 — a demo band that inverts reads as a bug.
    for r in rows:
        assert r.mc_p50_finish is not None
        assert r.mc_p50_finish <= r.mc_p80_finish <= r.mc_p95_finish, r.captured_at
        assert r.mc_iterations == 2000
    # The P80 line walks right across the window (the "risk creeping" story).
    assert rows[-1].mc_p80_finish > rows[0].mc_p80_finish


def test_completed_task_count_ramps_up(program: Any) -> None:
    project = _project(program, "Platform Core")
    rows = list(ProjectForecastSnapshot.objects.filter(project=project).order_by("captured_at"))
    # Progress accrues: nothing complete at the window start, more complete by the end.
    assert rows[0].completed_task_count == 0
    assert rows[-1].completed_task_count > rows[0].completed_task_count
    # task_count is held constant across the window (schedule shape, not progress).
    assert len({r.task_count for r in rows}) == 1


def test_forecast_backfill_is_deterministic_on_reload(django_user_model: Any) -> None:
    # The loader wipes-and-recreates; a re-import must reproduce the identical
    # trend (seeded jitter), so a demo shown twice looks the same.
    owner = django_user_model.objects.create_user(username="fc-det", email="d@example.com")
    p1 = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    proj1 = _project(p1, "Platform Core")
    finishes1 = list(
        ProjectForecastSnapshot.objects.filter(project=proj1)
        .order_by("captured_at")
        .values_list("cpm_finish", flat=True)
    )
    p2 = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    proj2 = _project(p2, "Platform Core")
    finishes2 = list(
        ProjectForecastSnapshot.objects.filter(project=proj2)
        .order_by("captured_at")
        .values_list("cpm_finish", flat=True)
    )
    assert finishes1 == finishes2


# --- PTO calendar exceptions -------------------------------------------------


def test_pto_exceptions_created_one_current_two_past(program: Any) -> None:
    # Capacity reality (#369) reads CalendarException PTO ranges. The sample authors
    # three across its calendars: one spanning today, two in the past.
    exceptions = list(
        CalendarException.objects.filter(
            calendar__in=[
                p.calendar_id for p in Project.objects.filter(program=program) if p.calendar_id
            ]
        )
    )
    assert len(exceptions) >= 3, len(exceptions)
    today = date.today()
    current = [e for e in exceptions if e.exc_start <= today <= e.exc_end]
    past = [e for e in exceptions if e.exc_end < today]
    assert len(current) >= 1, "expected at least one current PTO range spanning today"
    assert len(past) >= 2, "expected at least two past PTO ranges"


# --- near-infeasible commitment (dependency reality #372) --------------------


def test_active_sprint_story_gated_by_late_cross_project_predecessor(program: Any) -> None:
    # A story committed to an ACTIVE sprint whose predecessor lives in ANOTHER
    # project and finishes after the sprint closes — the arrangement that makes the
    # dependency-reality at-risk indicator (#372) fire once the program CPM runs.
    story = Task.objects.get(
        project__program=program, project__name__icontains="Platform Core", wbs_path="2.6"
    )
    assert story.sprint is not None
    assert story.sprint.state == SprintState.ACTIVE

    edge = Dependency.objects.get(successor=story)
    # The predecessor is in a different project (cross-project seam).
    assert edge.predecessor.project_id != story.project_id
    assert edge.dep_type == "FS"
    # The predecessor's planned window lands after the sprint finish, so the
    # successor cannot honestly start (let alone finish) inside the sprint.
    sprint: Sprint = story.sprint
    pred_start = edge.predecessor.planned_start
    assert pred_start is not None and pred_start >= sprint.finish_date, (
        pred_start,
        sprint.finish_date,
    )
