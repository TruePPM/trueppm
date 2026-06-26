"""Monte Carlo agile-velocity wiring (#411, ADR-0065/0106).

The MC endpoint hands the team's completed-sprint throughput to the scheduler so
SCRUM/story-point tasks sample sprints-to-completion from real velocity variance,
instead of collapsing to their deterministic placeholder duration. Before this
wiring an all-agile project (the symptom seen on the Atlas "Platform Core" project)
forecast a single flat date with no uncertainty band.
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
    Project,
    Sprint,
    SprintState,
    Task,
)

User = get_user_model()


def _client(project: Project, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def run_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/"


def _completed_velocity_history(project: Project) -> None:
    """Four closed sprints with a high-variance completed-points history (mean 30).

    The spread is deliberately wide (20–40) so a backlog sized near a sprint
    boundary takes a *variable* number of sprints across bootstrap runs — that
    variance is what the agile path must surface as an uncertainty band.
    """
    rows = [
        (20, date(2025, 10, 6), date(2025, 10, 17)),
        (40, date(2025, 10, 20), date(2025, 10, 31)),
        (25, date(2025, 11, 3), date(2025, 11, 14)),
        (35, date(2025, 11, 17), date(2025, 11, 28)),
    ]
    for i, (cp, start, finish) in enumerate(rows, start=1):
        Sprint.objects.create(
            project=project,
            name=f"Sprint {i}",
            state=SprintState.COMPLETED,
            start_date=start,
            finish_date=finish,
            committed_points=32,
            completed_points=cp,
        )


def _scrum_chain(project: Project, points: list[int]) -> None:
    prev = None
    for n, pts in enumerate(points):
        t = Task.objects.create(
            project=project,
            name=f"Story {n}",
            duration=1,
            story_points=pts,
            delivery_mode=DeliveryMode.SCRUM,
        )
        if prev is not None:
            Dependency.objects.create(predecessor=prev, successor=t, dep_type="FS", lag=0)
        prev = t


@pytest.mark.django_db
def test_agile_velocity_produces_spread() -> None:
    """An all-agile project with a velocity history forecasts a real uncertainty band."""
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(
        name="Platform Core", start_date=date(2026, 1, 5), calendar=cal
    )
    _completed_velocity_history(project)
    # One 55-point story against a 20–40 pts/sprint history straddles the 2-vs-3
    # sprint boundary: most runs finish in two sprints, a meaningful tail needs a
    # third — so the velocity variance becomes a real P50→P95 band.
    _scrum_chain(project, [55])

    client = _client(project, "mc_vel_admin")
    res = client.post(run_url(project.pk), {"n_simulations": 1000}, format="json")
    assert res.status_code == 200, res.content
    body = res.json()
    # Velocity variance now drives the band: P95 strictly later than P50.
    assert body["p95"] > body["p50"], (
        "agile velocity uncertainty must reach the forecast "
        f"(got p50={body['p50']} p80={body['p80']} p95={body['p95']})"
    )
    assert body["p80"] >= body["p50"]


@pytest.mark.django_db
def test_agile_without_velocity_history_stays_deterministic() -> None:
    """No closed sprints → no signal → engine falls back to deterministic durations.

    The fallback must not crash and must not invent a spread the data can't support.
    """
    cal = Calendar.objects.create(name="Std2")
    project = Project.objects.create(name="No history", start_date=date(2026, 1, 5), calendar=cal)
    _scrum_chain(project, [13, 13, 13])  # story points, but zero velocity history

    client = _client(project, "mc_novel_admin")
    res = client.post(run_url(project.pk), {"n_simulations": 500}, format="json")
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["p50"] == body["p80"] == body["p95"]


@pytest.mark.django_db
def test_excluded_sprints_do_not_feed_velocity() -> None:
    """A sprint flagged exclude_from_velocity must not contribute to the bootstrap."""
    cal = Calendar.objects.create(name="Std3")
    project = Project.objects.create(name="Excluded", start_date=date(2026, 1, 5), calendar=cal)
    # A single eligible sprint → degenerate (constant) distribution: honest, no spread.
    Sprint.objects.create(
        project=project,
        name="Good",
        state=SprintState.COMPLETED,
        start_date=date(2025, 11, 3),
        finish_date=date(2025, 11, 14),
        completed_points=30,
    )
    # A wildly different sprint that, if counted, would inject large variance.
    Sprint.objects.create(
        project=project,
        name="Spike (excluded)",
        state=SprintState.COMPLETED,
        start_date=date(2025, 10, 6),
        finish_date=date(2025, 10, 17),
        completed_points=1,
        exclude_from_velocity=True,
    )
    _scrum_chain(project, [30])  # exactly one sprint at the eligible velocity

    from trueppm_api.apps.projects.services import scheduler_velocity_inputs

    samples, sprint_len = scheduler_velocity_inputs(project.pk, cal.working_days)
    assert samples == [30.0]  # the excluded spike is absent
    assert sprint_len == 8  # ~11 calendar days * 5/7 working days, rounded


@pytest.mark.django_db
def test_waterfall_pert_still_has_spread() -> None:
    """Control: the waterfall 3-point (PERT) path is unaffected by the new wiring."""
    cal = Calendar.objects.create(name="Std4")
    project = Project.objects.create(name="Migration", start_date=date(2026, 1, 5), calendar=cal)
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

    client = _client(project, "mc_pert_admin")
    res = client.post(run_url(project.pk), {"n_simulations": 1000}, format="json")
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["p95"] > body["p50"]
