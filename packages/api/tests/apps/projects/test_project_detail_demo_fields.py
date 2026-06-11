"""ProjectDetailSerializer exposes the demo-onramp fields the web reads (#1053).

The Schedule view shows a "recalculating" badge while a freshly-imported sample's
first CPM pass is pending (``recalculated_at`` null), and a per-project demo
indicator (``is_sample`` + ``program_detail``). All three are read-only — never
client-writable.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import Project

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def user() -> Any:
    return User.objects.create_user(username="demo-fields-pm", password="pw")


@pytest.fixture
def client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _project(user: Any, **kwargs: Any) -> Project:
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1), **kwargs)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return project


def test_detail_exposes_demo_fields_for_a_sample_project(client: APIClient, user: Any) -> None:
    program = create_program(name="Atlas Platform Launch", methodology="HYBRID", created_by=user)
    project = _project(
        user,
        program=program,
        is_sample=True,
        recalculated_at=datetime(2026, 1, 2, tzinfo=UTC),
    )
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.content
    assert resp.data["is_sample"] is True
    assert resp.data["recalculated_at"] is not None
    assert resp.data["program_detail"] == {"id": str(program.pk), "name": "Atlas Platform Launch"}


def test_recalculated_at_is_null_before_first_cpm_and_program_detail_optional(
    client: APIClient, user: Any
) -> None:
    project = _project(user, is_sample=True, recalculated_at=None)
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.content
    assert resp.data["recalculated_at"] is None  # CPM hasn't completed → web shows the badge
    assert resp.data["program_detail"] is None  # no program assigned


def test_demo_fields_are_read_only(client: APIClient, user: Any) -> None:
    project = _project(user, is_sample=False, recalculated_at=None)
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"recalculated_at": "2030-01-01T00:00:00Z", "is_sample": True},
        format="json",
    )
    assert resp.status_code in (200, 202), resp.content
    project.refresh_from_db()
    assert project.recalculated_at is None  # client write ignored
    assert project.is_sample is False
