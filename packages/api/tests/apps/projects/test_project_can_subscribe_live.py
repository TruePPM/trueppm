"""``ProjectSerializer.can_subscribe_live`` — the socket's role floor, advertised (#4375).

The project WebSocket refuses below-Member roles with close 4003. Before this field
the web client could not know that, so a Viewer's tab reconnected and ran the 30 s
fallback poll for as long as it stayed open. The field and the consumer's connect
gate both call ``role_can_subscribe_live``; these tests pin the field to the
predicate (not to a hard-coded truth table) on both resolution paths.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import role_can_subscribe_live
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.projects.serializers import ProjectSerializer

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Live", start_date=date(2026, 1, 1), calendar=calendar)


def _client_for(project: Project, role: int) -> APIClient:
    user = User.objects.create_user(username=f"live-{role}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


ROLES = [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, 350, Role.OWNER]


@pytest.mark.django_db
@pytest.mark.parametrize("role", ROLES)
def test_detail_can_subscribe_live_agrees_with_the_consumer_predicate(
    project: Project, role: int
) -> None:
    r = _client_for(project, role).get(f"/api/v1/projects/{project.pk}/")
    assert r.status_code == 200, r.data
    assert r.data["can_subscribe_live"] is role_can_subscribe_live(role)


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_list_can_subscribe_live_uses_the_annotation_path(project: Project, role: int) -> None:
    """The list route resolves from the ``_my_role`` annotation, not a per-row lookup."""
    r = _client_for(project, role).get("/api/v1/projects/")
    assert r.status_code == 200, r.data
    rows = r.data["results"] if isinstance(r.data, dict) else r.data
    row = next(p for p in rows if p["id"] == str(project.pk))
    assert row["can_subscribe_live"] is role_can_subscribe_live(role)


@pytest.mark.django_db
def test_viewer_is_refused_and_member_is_not(project: Project) -> None:
    """The one concrete pair the web gate depends on, spelled out."""
    viewer = _client_for(project, Role.VIEWER).get(f"/api/v1/projects/{project.pk}/")
    member = _client_for(project, Role.MEMBER).get(f"/api/v1/projects/{project.pk}/")
    assert viewer.data["can_subscribe_live"] is False
    assert member.data["can_subscribe_live"] is True


@pytest.mark.django_db
def test_serializer_without_request_fails_closed(project: Project) -> None:
    assert ProjectSerializer(project).data["can_subscribe_live"] is False
