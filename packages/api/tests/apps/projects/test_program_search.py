"""Tests for ?search= on GET /api/v1/programs/ (ADR-0401, #1940).

ProgramViewSet gained name/code substring search for parity with ProjectViewSet so
the program switchers and command palette stay findable past the default page.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import Program
from trueppm_api.apps.projects.views import DirectoryPagination

User = get_user_model()


class TestDirectoryPagination:
    """The project/program directory endpoints raise the DRF-default 50 to 200 so
    the sidebar and command palette don't truncate at scale (ADR-0401, #1940)."""

    def test_default_page_size_is_raised_to_200(self) -> None:
        paginator = DirectoryPagination()
        req = Request(APIRequestFactory().get("/api/v1/projects/"))
        assert paginator.get_page_size(req) == 200

    def test_page_size_is_client_tunable_and_clamped(self) -> None:
        paginator = DirectoryPagination()
        assert (
            paginator.get_page_size(
                Request(APIRequestFactory().get("/api/v1/projects/?page_size=25"))
            )
            == 25
        )
        # Clamped at max_page_size so a huge value can't blow up the payload.
        assert (
            paginator.get_page_size(
                Request(APIRequestFactory().get("/api/v1/projects/?page_size=99999"))
            )
            == 500
        )


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _program(name: str, member: object, code: str = "") -> Program:
    p = Program.objects.create(name=name, code=code)
    ProgramMembership.objects.create(program=p, user=member, role=Role.OWNER)
    return p


def _results(resp: object) -> list[dict]:
    data = resp.json()
    return data["results"] if isinstance(data, dict) else data


class TestProgramSearch:
    def test_search_by_name_substring(self, client: APIClient, user: object) -> None:
        _program("Apollo Migration", user)
        _program("Gemini Rollout", user)
        resp = client.get("/api/v1/programs/?search=apollo")
        assert resp.status_code == 200
        names = {r["name"] for r in _results(resp)}
        assert names == {"Apollo Migration"}

    def test_search_by_code(self, client: APIClient, user: object) -> None:
        _program("Apollo Migration", user, code="APL")
        _program("Gemini Rollout", user, code="GEM")
        resp = client.get("/api/v1/programs/?search=GEM")
        assert resp.status_code == 200
        names = {r["name"] for r in _results(resp)}
        assert names == {"Gemini Rollout"}

    def test_empty_search_returns_all_member_programs(
        self, client: APIClient, user: object
    ) -> None:
        _program("Apollo Migration", user)
        _program("Gemini Rollout", user)
        resp = client.get("/api/v1/programs/")
        assert resp.status_code == 200
        assert len(_results(resp)) == 2
