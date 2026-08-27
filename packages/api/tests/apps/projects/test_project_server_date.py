"""``server_date`` on the project payload, and the rule it lets a client predict (#3075).

``PATCH { planned_start }`` on a NOT_STARTED task whose date has arrived also injects
``status = IN_PROGRESS`` (``_apply_date_gated_start_transition``, #336), and back-stamps
``actual_start`` for a date in the past. Two UI controls named for a date issue exactly
that PATCH, and neither disclosed it.

The disclosure has to be made *before* the click, which means the client has to know
whether the date has arrived — and "arrived" is judged by Django's
``timezone.localdate()`` under ``settings.TIME_ZONE``, not by the browser's clock. The
two disagree across a timezone boundary, which is the one case where the answer matters.
So the server emits its own date rather than leaving the client to guess.

These tests pin the *contract*: that the field exists, that it is the same call the
task rule makes, and that it is read-only. The transition itself is already covered by
#336 and is deliberately not retested here.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def client_and_project() -> tuple[APIClient, Project]:
    user = User.objects.create_user(username="server-date-pm", password="pw")
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c, project


def test_detail_carries_the_servers_own_date(
    client_and_project: tuple[APIClient, Project],
) -> None:
    client, project = client_and_project
    r = client.get(f"/api/v1/projects/{project.pk}/")
    assert r.status_code == 200, r.data
    assert r.data["server_date"] == timezone.localdate().isoformat()


def test_it_is_the_same_call_the_date_gated_task_rule_makes(
    client_and_project: tuple[APIClient, Project],
) -> None:
    """Not "today" from any other source — the field is only useful if it agrees.

    ``_apply_date_gated_start_transition`` compares ``planned_start`` against
    ``timezone.localdate()``. A client predicting that rule from a value derived any
    other way (UTC, the request's ``Date`` header, the project's start timezone) would
    be right most days and wrong at exactly the boundary the field exists to get right.
    """
    client, project = client_and_project
    fixed = date(2026, 3, 14)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(timezone, "localdate", lambda *a, **k: fixed)
        r = client.get(f"/api/v1/projects/{project.pk}/")
    assert r.data["server_date"] == "2026-03-14"


def test_it_cannot_be_written(client_and_project: tuple[APIClient, Project]) -> None:
    """A client-settable "today" would let a caller talk the UI into the wrong label."""
    client, project = client_and_project
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"server_date": "1999-01-01"},
        format="json",
    )
    assert r.status_code == 200, r.data
    assert r.data["server_date"] == timezone.localdate().isoformat()
