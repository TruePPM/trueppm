"""Malformed-UUID request handling (#2125).

A non-UUID value in a URL path segment or query/filter param used to bubble up as
HTTP 500 on every endpoint that coerced it to a UUID outside DRF's own
``get_object_or_404`` (nested list routes, custom actions, query filters). The
``trueppm_api.core.exception_handlers.trueppm_exception_handler`` now maps those to
404 (malformed id in the path — the object cannot exist) or 400 (malformed UUID in
a query param — bad client input). These tests pin one representative of each
class and confirm valid-but-absent ids and well-formed UUIDs still behave.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project

# A syntactically valid UUID that matches no row — must still be a clean 404, never
# a 500, so the fix does not paper over genuine "not found" behavior.
_ABSENT_UUID = "00000000-0000-0000-0000-000000000000"


@pytest.fixture
def client(db: object) -> APIClient:
    # raise_request_exception=False so an unhandled 500 surfaces as a response with
    # status 500 (which these tests assert against) rather than raising in-process.
    user = get_user_model().objects.create_user(username="uuiduser", password="pw")
    c = APIClient(raise_request_exception=False)
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def membership(client: APIClient, project: Project) -> ProjectMembership:
    user = get_user_model().objects.get(username="uuiduser")
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.mark.django_db
class TestMalformedUuidHandling:
    def test_bad_uuid_in_detail_path_is_404(self, client: APIClient) -> None:
        # Standard DRF detail route (routes through DRF's get_object_or_404).
        r = client.get("/api/v1/projects/not-a-uuid/")
        assert r.status_code == 404

    def test_bad_uuid_in_nested_path_is_404(self, client: APIClient) -> None:
        # Nested list route: project_pk is filtered into the queryset and coerced
        # during pagination, outside get_object_or_404 — used to 500.
        r = client.get("/api/v1/projects/not-a-uuid/labels/")
        assert r.status_code == 404

    def test_bad_uuid_in_custom_action_path_is_404(self, client: APIClient) -> None:
        # Custom action using Django's get_object_or_404 (does not catch
        # ValidationError, unlike DRF's) — used to 500.
        r = client.post("/api/v1/projects/not-a-uuid/tasks/reorder/", {}, format="json")
        assert r.status_code == 404

    def test_bad_uuid_in_query_param_is_400(self, client: APIClient) -> None:
        # Malformed UUID in a filter query param is bad client input -> 400.
        r = client.get("/api/v1/tasks/?project=not-a-uuid")
        assert r.status_code == 400

    def test_valid_but_absent_uuid_detail_is_404(self, client: APIClient) -> None:
        r = client.get(f"/api/v1/projects/{_ABSENT_UUID}/")
        assert r.status_code == 404

    def test_valid_but_absent_uuid_query_param_is_ok(
        self, client: APIClient, membership: ProjectMembership
    ) -> None:
        # A well-formed UUID that matches nothing filters to an empty list, not an
        # error — the fix must not turn a valid-shaped UUID into a 400/404.
        r = client.get(f"/api/v1/tasks/?project={_ABSENT_UUID}")
        assert r.status_code == 200
        assert r.data["results"] == []

    def test_well_formed_uuid_still_resolves(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.id}/")
        assert r.status_code == 200
        assert r.data["id"] == str(project.id)
