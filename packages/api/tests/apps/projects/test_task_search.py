"""Tests for the board card full-text search action on TaskViewSet (#323, ADR-0145).

GET /api/v1/tasks/search/?project=<uuid>&q=<term> returns a slim
[{id, name, status, short_id}] list of cards whose title (name) or description
(notes) contains the term (case-insensitive substring). The slim shape carries no
cost/sensitive fields, so project membership is the only access gate.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

SEARCH_URL = "/api/v1/tasks/search/"


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="searcher", password="pw")


@pytest.fixture
def auth_client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Default")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Search Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def _membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def tasks(project: Project) -> dict[str, Task]:
    return {
        "foundation": Task.objects.create(
            project=project, name="Foundation pour", notes="Concrete works"
        ),
        "framing": Task.objects.create(
            project=project, name="Framing", notes="Erect the steel foundation frame"
        ),
        "roof": Task.objects.create(project=project, name="Roof", notes="Membrane"),
    }


@pytest.mark.django_db
class TestBoardCardSearch:
    def test_matches_title_substring(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "found"})
        assert resp.status_code == 200
        names = [r["name"] for r in resp.json()]
        # "Foundation pour" (title) and "Framing" (notes mention "foundation").
        assert "Foundation pour" in names
        assert "Framing" in names
        assert "Roof" not in names

    def test_title_match_ranks_above_notes_only_match(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "foundation"})
        assert resp.status_code == 200
        names = [r["name"] for r in resp.json()]
        # Foundation pour matches on title (rank 0); Framing only via notes (rank 1).
        assert names.index("Foundation pour") < names.index("Framing")

    def test_matches_notes_description(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "membrane"})
        assert resp.status_code == 200
        names = [r["name"] for r in resp.json()]
        assert names == ["Roof"]

    def test_case_insensitive(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "ROOF"})
        assert resp.status_code == 200
        assert [r["name"] for r in resp.json()] == ["Roof"]

    def test_empty_query_returns_empty_list(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "   "})
        assert resp.status_code == 200
        assert resp.json() == []

    def test_missing_project_is_400(
        self, auth_client: APIClient, _membership: ProjectMembership
    ) -> None:
        resp = auth_client.get(SEARCH_URL, {"q": "foundation"})
        assert resp.status_code == 400

    def test_slim_payload_has_no_sensitive_fields(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "roof"})
        assert resp.status_code == 200
        row = resp.json()[0]
        assert set(row.keys()) == {"id", "name", "status", "short_id"}

    def test_soft_deleted_tasks_excluded(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        tasks["roof"].is_deleted = True
        tasks["roof"].save(update_fields=["is_deleted"])
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "roof"})
        assert resp.status_code == 200
        assert resp.json() == []

    def test_long_query_is_capped_not_errored(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        # A 5000-char term must not error (DoS guard caps it to 100 chars).
        resp = auth_client.get(SEARCH_URL, {"project": str(project.pk), "q": "x" * 5000})
        assert resp.status_code == 200
        assert resp.json() == []

    def test_viewer_can_search(
        self,
        project: Project,
        tasks: dict[str, Task],
    ) -> None:
        """Viewer+ may search — the read gate is IsProjectMember, not write."""
        User = get_user_model()
        viewer = User.objects.create_user(username="viewer", password="pw")
        ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
        client = APIClient()
        client.force_authenticate(user=viewer)
        resp = client.get(SEARCH_URL, {"project": str(project.pk), "q": "roof"})
        assert resp.status_code == 200
        assert [r["name"] for r in resp.json()] == ["Roof"]

    def test_non_member_cannot_see_other_project_cards(
        self,
        project: Project,
        tasks: dict[str, Task],
        _membership: ProjectMembership,
    ) -> None:
        """IDOR guard: a non-member searching the project gets an empty result,
        never another project's cards (ProjectScopedViewSet membership scope)."""
        User = get_user_model()
        outsider = User.objects.create_user(username="outsider", password="pw")
        client = APIClient()
        client.force_authenticate(user=outsider)
        resp = client.get(SEARCH_URL, {"project": str(project.pk), "q": "roof"})
        assert resp.status_code == 200
        assert resp.json() == []

    def test_unauthenticated_is_denied(self, project: Project, tasks: dict[str, Task]) -> None:
        resp = APIClient().get(SEARCH_URL, {"project": str(project.pk), "q": "roof"})
        assert resp.status_code in (401, 403)
