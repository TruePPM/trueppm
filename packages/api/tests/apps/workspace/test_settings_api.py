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


# ---------------------------------------------------------------------------
# Structured fiscal-year anchor (#756)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_fiscal_defaults_to_january_first(member: object) -> None:
    resp = _client(member).get(URL)
    assert resp.status_code == 200
    assert resp.data["fiscal_year_start_month"] == 1
    assert resp.data["fiscal_year_start_day"] == 1
    assert resp.data["fiscal_year_start_display"] == "January 1"


@pytest.mark.django_db
def test_admin_can_patch_fiscal_month(admin: object) -> None:
    resp = _client(admin).patch(
        URL, {"fiscal_year_start_month": 4, "fiscal_year_start_day": 1}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["fiscal_year_start_display"] == "April 1"
    ws = Workspace.load()
    assert (ws.fiscal_year_start_month, ws.fiscal_year_start_day) == (4, 1)


@pytest.mark.django_db
def test_admin_can_patch_custom_fiscal_day(admin: object) -> None:
    # UK tax year (April 6) — the oddball the custom picker exists for.
    resp = _client(admin).patch(
        URL, {"fiscal_year_start_month": 4, "fiscal_year_start_day": 6}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["fiscal_year_start_display"] == "April 6"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("month", "day"),
    [
        (2, 29),  # Feb is year-agnostic-capped at 28
        (2, 30),
        (4, 31),  # 30-day month
        (6, 31),
        (1, 32),  # out of range entirely
        (13, 1),  # invalid month
    ],
)
def test_fiscal_rejects_impossible_day_for_month(admin: object, month: int, day: int) -> None:
    resp = _client(admin).patch(
        URL, {"fiscal_year_start_month": month, "fiscal_year_start_day": day}, format="json"
    )
    assert resp.status_code == 400
    # Unchanged in the DB.
    ws = Workspace.load()
    assert (ws.fiscal_year_start_month, ws.fiscal_year_start_day) == (1, 1)


@pytest.mark.django_db
def test_fiscal_partial_patch_validates_against_existing_month(admin: object) -> None:
    # Set February first, then PATCH only the day to 29 — validation must read
    # the stored month (Feb) to know 29 is invalid.
    _client(admin).patch(
        URL, {"fiscal_year_start_month": 2, "fiscal_year_start_day": 1}, format="json"
    )
    resp = _client(admin).patch(URL, {"fiscal_year_start_day": 29}, format="json")
    assert resp.status_code == 400
    assert "fiscal_year_start_day" in resp.data


@pytest.mark.django_db
def test_fiscal_display_is_read_only(admin: object) -> None:
    resp = _client(admin).patch(URL, {"fiscal_year_start_display": "July 4"}, format="json")
    assert resp.status_code == 200
    # The computed display ignores the write and still reflects the default pair.
    assert resp.data["fiscal_year_start_display"] == "January 1"


@pytest.mark.django_db
def test_non_admin_cannot_patch_fiscal(member: object) -> None:
    resp = _client(member).patch(URL, {"fiscal_year_start_month": 7}, format="json")
    assert resp.status_code == 403
    assert Workspace.load().fiscal_year_start_month == 1
