"""Tests for GET /api/v1/users/search/ (ADR-0061)."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

User = get_user_model()

_URL = "/api/v1/users/search/"


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(
        username="alice",
        email="alice@example.com",
        password="pw",
        first_name="Alice",
        last_name="Smith",
        is_active=True,
    )


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(
        username="bob_dev",
        email="bob@example.com",
        password="pw",
        is_active=True,
    )


@pytest.fixture
def inactive(db: object) -> object:
    return User.objects.create_user(
        username="ghost",
        email="ghost@example.com",
        password="pw",
        is_active=False,
    )


@pytest.fixture
def authed_client(alice: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=alice)
    return c


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


def test_requires_auth(db: object) -> None:
    c = APIClient()
    res = c.get(_URL, {"q": "ali"})
    assert res.status_code == 401


# ---------------------------------------------------------------------------
# Minimum query length guard
# ---------------------------------------------------------------------------


def test_empty_q_returns_empty(authed_client: APIClient) -> None:
    res = authed_client.get(_URL)
    assert res.status_code == 200
    assert res.json() == []


def test_single_char_returns_empty(authed_client: APIClient) -> None:
    res = authed_client.get(_URL, {"q": "a"})
    assert res.status_code == 200
    assert res.json() == []


# ---------------------------------------------------------------------------
# Username match
# ---------------------------------------------------------------------------


def test_matches_username(authed_client: APIClient, bob: object) -> None:
    res = authed_client.get(_URL, {"q": "bob"})
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["username"] == "bob_dev"


def test_username_match_is_case_insensitive(authed_client: APIClient, bob: object) -> None:
    res = authed_client.get(_URL, {"q": "BOB"})
    assert res.status_code == 200
    assert len(res.json()) == 1


# ---------------------------------------------------------------------------
# Email match
# ---------------------------------------------------------------------------


def test_matches_email(authed_client: APIClient, alice: object) -> None:
    res = authed_client.get(_URL, {"q": "alice@example"})
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["email"] == "alice@example.com"


def test_email_match_is_case_insensitive(authed_client: APIClient, alice: object) -> None:
    res = authed_client.get(_URL, {"q": "ALICE@EXAMPLE"})
    assert res.status_code == 200
    assert len(res.json()) == 1


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------


def test_response_includes_display_name_and_initials(
    authed_client: APIClient, alice: object
) -> None:
    res = authed_client.get(_URL, {"q": "alice"})
    assert res.status_code == 200
    row = res.json()[0]
    assert row["display_name"] == "Alice Smith"
    assert row["initials"] == "AS"
    assert "id" in row
    assert "username" in row
    assert "email" in row


def test_display_name_falls_back_to_username_when_no_name(
    authed_client: APIClient, bob: object
) -> None:
    res = authed_client.get(_URL, {"q": "bob"})
    data = res.json()
    assert data[0]["display_name"] == "bob_dev"
    assert data[0]["initials"] == "BO"


# ---------------------------------------------------------------------------
# Inactive users excluded
# ---------------------------------------------------------------------------


def test_inactive_users_excluded(authed_client: APIClient, inactive: object) -> None:
    res = authed_client.get(_URL, {"q": "ghost"})
    assert res.status_code == 200
    assert res.json() == []


# ---------------------------------------------------------------------------
# Result cap
# ---------------------------------------------------------------------------


def test_returns_at_most_ten_results(authed_client: APIClient, db: object) -> None:
    for i in range(15):
        User.objects.create_user(
            username=f"searchme_{i:02d}", email=f"search{i}@example.com", password="pw"
        )
    res = authed_client.get(_URL, {"q": "searchme"})
    assert res.status_code == 200
    assert len(res.json()) == 10


# ---------------------------------------------------------------------------
# No match
# ---------------------------------------------------------------------------


def test_no_match_returns_empty(authed_client: APIClient) -> None:
    res = authed_client.get(_URL, {"q": "xyzzy_no_match"})
    assert res.status_code == 200
    assert res.json() == []
