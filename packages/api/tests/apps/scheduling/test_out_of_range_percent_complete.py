"""A stored out-of-range ``percent_complete`` is refused by the engine (#4513).

The 0-100 bound lives in model validators, which ORM ``save()``/``bulk_create`` and
seed code do not run, so a bad row can exist. The engine now refuses it instead of
clamping. These tests pin how the API surfaces that refusal: Monte Carlo as a clean
400, and the CPM recompute by raising ``InvalidScheduleInput`` into the TaskRun
tracker (which marks the run FAILED) rather than scheduling it silently.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from trueppm_scheduler import InvalidScheduleInput

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

START = date(2026, 3, 2)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Bad pct", start_date=START, status_date=START, calendar=cal
    )
    # Bypass validators on purpose: this is the stored-bad-row case.
    Task.objects.create(project=project, name="Build", duration=5, percent_complete=150.0)
    return project


@pytest.mark.django_db
def test_monte_carlo_returns_400_for_stored_out_of_range_percent(project: Project) -> None:
    user = get_user_model().objects.create_user(username="pct_user", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.post(
        f"/api/v1/projects/{project.pk}/monte-carlo/", {"n_simulations": 100}, format="json"
    )

    assert r.status_code == 400
    assert "percent_complete" in str(r.data)


@pytest.mark.django_db(transaction=True)
def test_cpm_recompute_refuses_stored_out_of_range_percent(project: Project) -> None:
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        pytest.raises(InvalidScheduleInput, match="percent_complete"),
    ):
        _run_schedule(str(project.pk))
