"""Tests for the Workspace general settings API (#517, ADR-0087)."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.workspace.models import Workspace

User = get_user_model()

URL = "/api/v1/workspace/"


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="ws_admin", password="pw", is_superuser=True)


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="ws_member", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_get_lazily_creates_singleton(member: object) -> None:
    assert Workspace.objects.count() == 0
    resp = _client(member).get(URL)
    assert resp.status_code == 200
    assert resp.data["name"] == "TruePPM Workspace"
    assert resp.data["work_week"] == [True, True, True, True, True, False, False]
    assert Workspace.objects.count() == 1
    # Idempotent: a second GET does not create another row.
    _client(member).get(URL)
    assert Workspace.objects.count() == 1


@pytest.mark.django_db
def test_get_requires_authentication() -> None:
    assert APIClient().get(URL).status_code in (401, 403)


@pytest.mark.django_db
def test_admin_can_patch(admin: object) -> None:
    resp = _client(admin).patch(URL, {"name": "Acme PMO", "allow_guests": False}, format="json")
    assert resp.status_code == 200
    assert resp.data["name"] == "Acme PMO"
    assert resp.data["allow_guests"] is False
    assert Workspace.load().name == "Acme PMO"


@pytest.mark.django_db
def test_non_admin_cannot_patch(member: object) -> None:
    resp = _client(member).patch(URL, {"name": "Hacked"}, format="json")
    assert resp.status_code == 403
    assert Workspace.load().name == "TruePPM Workspace"


@pytest.mark.django_db
def test_subdomain_is_read_only(admin: object) -> None:
    Workspace.load()  # ensure exists
    resp = _client(admin).patch(URL, {"subdomain": "evil"}, format="json")
    assert resp.status_code == 200
    assert Workspace.load().subdomain == ""


@pytest.mark.django_db
def test_work_week_must_have_seven_entries(admin: object) -> None:
    resp = _client(admin).patch(URL, {"work_week": [True, False]}, format="json")
    assert resp.status_code == 400
    assert "work_week" in resp.data
