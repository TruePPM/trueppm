"""Access-control tests for the project presence API (issue #1547).

Covers GET /api/v1/projects/<pk>/presence/.

The route binds on a bare ``pk`` (not ``project_pk``), so IsProjectMember's
has_permission short-circuits to True for any authenticated user. Object-level
membership is enforced explicitly via check_object_permissions in the view —
these tests guard that path so a non-member cannot read another project's live
presence data (IDOR regression).

The view catches Redis failures and returns an empty list with 200, so a member
request succeeds without a live Redis for the presence hash — the assertions
here are purely about the access-control boundary, not the presence payload.
"""

from __future__ import annotations

import datetime
import uuid

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="other", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Alpha",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.mark.django_db
class TestProjectPresenceAccess:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/presence/"

    def test_unauthenticated_returns_401(self, project: Project) -> None:
        res = APIClient().get(self.url(project.pk))
        assert res.status_code == 401

    def test_non_member_returns_403(self, other_user: object, project: Project) -> None:
        """A non-member must not read another project's presence data (#1547)."""
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 403

    def test_member_returns_200(self, user: object, project: Project, membership: object) -> None:
        """A project member reaches the endpoint and receives a list payload."""
        c = APIClient()
        c.force_authenticate(user=user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 200
        assert isinstance(res.json(), list)

    def test_unknown_project_returns_404(self, user: object) -> None:
        c = APIClient()
        c.force_authenticate(user=user)
        res = c.get(self.url(uuid.uuid4()))
        assert res.status_code == 404
