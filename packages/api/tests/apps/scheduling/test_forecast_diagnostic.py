"""Forecast-basis diagnostic: explain WHY a Monte Carlo forecast is flat (#1340).

A flat forecast (P50 == P80 == P95) is correct when no committed task can vary the
finish, but the UI historically blamed "missing PERT estimates" unconditionally —
wrong when the estimates are present but withheld pending approval, when the work is
agile (velocity, not PERT), or when it sits off the critical path. ``forecast_diagnostic``
returns the real reason so the message matches the cause.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    DeliveryMode,
    Dependency,
    EstimateStatus,
    EstimationMode,
    Project,
    Task,
)
from trueppm_api.apps.scheduling.services import forecast_diagnostic

User = get_user_model()


def run_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/"


def _client(project: Project, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# --- Unit: the pure helper, exercised directly over Task rows -----------------


@pytest.mark.django_db
def test_helper_no_committed_tasks() -> None:
    basis = forecast_diagnostic(
        [], suggest_approve=False, has_velocity_signal=False, deterministic=True
    )
    assert basis["reason"] == "no_committed_tasks"
    assert basis["tasks_total"] == 0


@pytest.mark.django_db
def test_helper_all_complete() -> None:
    cal = Calendar.objects.create(name="C1")
    project = Project.objects.create(name="P1", start_date=date(2026, 1, 5), calendar=cal)
    t = Task.objects.create(
        project=project,
        name="done",
        duration=3,
        optimistic_duration=2,
        most_likely_duration=3,
        pessimistic_duration=5,
        percent_complete=100.0,
    )
    basis = forecast_diagnostic(
        [t], suggest_approve=False, has_velocity_signal=False, deterministic=True
    )
    assert basis["reason"] == "all_complete"


@pytest.mark.django_db
def test_helper_pending_approval_does_not_blame_missing_estimates() -> None:
    """The #1340 regression: full triples, but withheld in SUGGEST_APPROVE mode."""
    cal = Calendar.objects.create(name="C2")
    project = Project.objects.create(name="P2", start_date=date(2026, 1, 5), calendar=cal)
    tasks = [
        Task.objects.create(
            project=project,
            name=f"w{i}",
            duration=3,
            optimistic_duration=2,
            most_likely_duration=3,
            pessimistic_duration=5,
            estimate_status=EstimateStatus.PENDING,
        )
        for i in range(3)
    ]
    basis = forecast_diagnostic(
        tasks, suggest_approve=True, has_velocity_signal=False, deterministic=True
    )
    assert basis["reason"] == "estimates_pending_approval"
    assert basis["tasks_pending_approval"] == 3
    assert basis["tasks_with_variance"] == 0


@pytest.mark.django_db
def test_helper_no_estimates() -> None:
    cal = Calendar.objects.create(name="C3")
    project = Project.objects.create(name="P3", start_date=date(2026, 1, 5), calendar=cal)
    t = Task.objects.create(project=project, name="single", duration=4)  # only a duration
    basis = forecast_diagnostic(
        [t], suggest_approve=False, has_velocity_signal=False, deterministic=True
    )
    assert basis["reason"] == "no_estimates"


@pytest.mark.django_db
def test_helper_no_velocity_history() -> None:
    cal = Calendar.objects.create(name="C4")
    project = Project.objects.create(name="P4", start_date=date(2026, 1, 5), calendar=cal)
    t = Task.objects.create(
        project=project, name="story", duration=1, story_points=8, delivery_mode=DeliveryMode.SCRUM
    )
    basis = forecast_diagnostic(
        [t], suggest_approve=False, has_velocity_signal=False, deterministic=True
    )
    assert basis["reason"] == "no_velocity_history"
    assert basis["agile_tasks_without_velocity"] == 1


@pytest.mark.django_db
def test_helper_band_has_no_reason() -> None:
    """When the forecast carries a real band, reason is null and variance is counted."""
    cal = Calendar.objects.create(name="C5")
    project = Project.objects.create(name="P5", start_date=date(2026, 1, 5), calendar=cal)
    t = Task.objects.create(
        project=project,
        name="estimated",
        duration=3,
        optimistic_duration=2,
        most_likely_duration=3,
        pessimistic_duration=5,
    )
    basis = forecast_diagnostic(
        [t], suggest_approve=False, has_velocity_signal=False, deterministic=False
    )
    assert basis["reason"] is None
    assert basis["tasks_with_variance"] == 1


# --- Integration: through the /monte-carlo/ endpoint --------------------------


@pytest.mark.django_db
def test_endpoint_reports_pending_approval_on_flat_forecast() -> None:
    """A SUGGEST_APPROVE project with un-approved 3-point estimates: flat + the reason."""
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(
        name="Pending",
        start_date=date(2026, 1, 5),
        calendar=cal,
        estimation_mode=EstimationMode.SUGGEST_APPROVE,
    )
    prev = None
    for n in range(3):
        t = Task.objects.create(
            project=project,
            name=f"W{n}",
            duration=3,
            optimistic_duration=2,
            most_likely_duration=3,
            pessimistic_duration=5,
            estimate_status=EstimateStatus.PENDING,
            delivery_mode=DeliveryMode.WATERFALL,
        )
        if prev is not None:
            Dependency.objects.create(predecessor=prev, successor=t, dep_type="FS", lag=0)
        prev = t

    client = _client(project, "fb_pending_admin")
    res = client.post(run_url(project.pk), {"n_simulations": 500}, format="json")
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["p50"] == body["p80"] == body["p95"]  # withheld estimates → flat
    fb = body["forecast_diagnostic"]
    assert fb["deterministic"] is True
    assert fb["reason"] == "estimates_pending_approval"
    assert fb["tasks_pending_approval"] == 3


@pytest.mark.django_db
def test_endpoint_reports_null_reason_when_band_exists() -> None:
    """Accepted 3-point estimates (OPEN mode default) produce a band and no reason."""
    cal = Calendar.objects.create(name="Std2")
    project = Project.objects.create(name="Band", start_date=date(2026, 1, 5), calendar=cal)
    prev = None
    for n, (o, m, p) in enumerate([(2, 3, 5), (3, 4, 7), (2, 3, 5)]):
        t = Task.objects.create(
            project=project,
            name=f"W{n}",
            duration=m,
            optimistic_duration=o,
            most_likely_duration=m,
            pessimistic_duration=p,
            delivery_mode=DeliveryMode.WATERFALL,
        )
        if prev is not None:
            Dependency.objects.create(predecessor=prev, successor=t, dep_type="FS", lag=0)
        prev = t

    client = _client(project, "fb_band_admin")
    res = client.post(run_url(project.pk), {"n_simulations": 1000}, format="json")
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["p95"] > body["p50"]
    fb = body["forecast_diagnostic"]
    assert fb["deterministic"] is False
    assert fb["reason"] is None
    assert fb["tasks_with_variance"] == 3


@pytest.mark.django_db
def test_endpoint_reports_no_estimates_for_single_duration_tasks() -> None:
    cal = Calendar.objects.create(name="Std3")
    project = Project.objects.create(name="Bare", start_date=date(2026, 1, 5), calendar=cal)
    prev = None
    for n in range(3):
        t = Task.objects.create(project=project, name=f"W{n}", duration=3)
        if prev is not None:
            Dependency.objects.create(predecessor=prev, successor=t, dep_type="FS", lag=0)
        prev = t

    client = _client(project, "fb_bare_admin")
    res = client.post(run_url(project.pk), {"n_simulations": 500}, format="json")
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["forecast_diagnostic"]["reason"] == "no_estimates"
