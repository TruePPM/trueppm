"""Tests for GET /api/v1/auth/me/ endpoint."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

User = get_user_model()

URL = "/api/v1/auth/me/"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Authentication gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_me_unauthenticated_returns_401(db: object) -> None:
    c = APIClient()
    resp = c.get(URL)
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Happy path — response shape
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_me_authenticated_returns_200_with_expected_fields(db: object) -> None:
    user = User.objects.create_user(
        username="sarah_chen",
        password="pw",
        email="sarah@example.com",
        first_name="Sarah",
        last_name="Chen",
    )
    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    data = resp.data
    assert str(user.pk) == data["id"]
    assert data["username"] == "sarah_chen"
    assert data["email"] == "sarah@example.com"
    assert "display_name" in data
    assert "initials" in data


# ---------------------------------------------------------------------------
# display_name
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_display_name_full_name_when_both_set(db: object) -> None:
    user = User.objects.create_user(
        username="sarah_chen",
        password="pw",
        first_name="Sarah",
        last_name="Chen",
    )
    resp = _make_client(user).get(URL)
    assert resp.data["display_name"] == "Sarah Chen"


@pytest.mark.django_db
def test_display_name_falls_back_to_username_when_names_blank(db: object) -> None:
    user = User.objects.create_user(username="sarah_chen", password="pw")
    resp = _make_client(user).get(URL)
    assert resp.data["display_name"] == "sarah_chen"


# ---------------------------------------------------------------------------
# initials
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_initials_first_and_last_name(db: object) -> None:
    user = User.objects.create_user(
        username="sarah_chen",
        password="pw",
        first_name="Sarah",
        last_name="Chen",
    )
    resp = _make_client(user).get(URL)
    assert resp.data["initials"] == "SC"


@pytest.mark.django_db
def test_initials_falls_back_to_username_prefix_when_no_name(db: object) -> None:
    user = User.objects.create_user(username="sarah_chen", password="pw")
    resp = _make_client(user).get(URL)
    assert resp.data["initials"] == "SA"


@pytest.mark.django_db
def test_initials_only_first_name_set(db: object) -> None:
    user = User.objects.create_user(
        username="sarah_chen",
        password="pw",
        first_name="Sarah",
    )
    resp = _make_client(user).get(URL)
    assert resp.data["initials"] == "S"


@pytest.mark.django_db
def test_initials_only_last_name_set(db: object) -> None:
    user = User.objects.create_user(
        username="sarah_chen",
        password="pw",
        last_name="Chen",
    )
    resp = _make_client(user).get(URL)
    assert resp.data["initials"] == "C"
