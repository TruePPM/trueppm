"""``forecast_recompute_requested`` fires when a recalculation leaves a forecast stale (#2798)."""

from __future__ import annotations

import datetime
from collections.abc import Iterator
from typing import Any

import pytest
from django.core.cache import cache

from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.scheduling.forecast_recompute import notify_if_forecast_stale
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.signals import forecast_recompute_requested

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def clear_cache() -> Iterator[None]:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project() -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Recompute", start_date=datetime.date(2026, 1, 5), calendar=cal)
    p.refresh_from_db()
    return p


@pytest.fixture
def received() -> Iterator[list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []

    def receiver(sender: Any, **kwargs: Any) -> None:
        calls.append({"sender": sender, **kwargs})

    forecast_recompute_requested.connect(receiver, weak=False)
    yield calls
    forecast_recompute_requested.disconnect(receiver)


def _run(project: Project, plan_version: int | None) -> MonteCarloRun:
    project.refresh_from_db()
    return MonteCarloRun.objects.create(
        project=project,
        n_simulations=100,
        p50=datetime.date(2026, 3, 1),
        p80=datetime.date(2026, 3, 8),
        p95=datetime.date(2026, 3, 15),
        plan_version=plan_version,
    )


def test_fires_once_when_plan_moved_since_run(
    project: Project, received: list[dict[str, Any]]
) -> None:
    run = _run(project, project.last_sync_version)
    Project.objects.filter(pk=project.pk).update(last_sync_version=project.last_sync_version + 5)

    assert notify_if_forecast_stale(project.pk) is True
    assert notify_if_forecast_stale(project.pk) is False  # once per stale run
    assert len(received) == 1
    assert received[0]["sender"] is MonteCarloRun
    assert received[0]["run_id"] == run.pk
    assert received[0]["staleness"] == "project_changed"


def test_silent_when_forecast_is_current(project: Project, received: list[dict[str, Any]]) -> None:
    _run(project, project.last_sync_version)
    project.refresh_from_db()
    assert notify_if_forecast_stale(project.pk) is False
    assert received == []


def test_silent_for_unknown_legacy_run_and_no_run(
    project: Project, received: list[dict[str, Any]]
) -> None:
    assert notify_if_forecast_stale(project.pk) is False
    _run(project, None)
    assert notify_if_forecast_stale(project.pk) is False
    assert received == []


def test_receiver_failure_does_not_propagate(project: Project) -> None:
    def boom(sender: Any, **kwargs: Any) -> None:
        raise RuntimeError("enterprise bug")

    forecast_recompute_requested.connect(boom, weak=False)
    try:
        _run(project, project.last_sync_version)
        project.refresh_from_db()
        Project.objects.filter(pk=project.pk).update(
            last_sync_version=project.last_sync_version + 1
        )
        assert notify_if_forecast_stale(project.pk) is True
    finally:
        forecast_recompute_requested.disconnect(boom)
