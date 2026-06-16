"""Tests for GET/PATCH /api/v1/auth/me/profile/ (ADR-0129)."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.profiles.models import DefaultLanding, UserProfile

User = get_user_model()

URL = "/api/v1/auth/me/profile/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_profile_unauthenticated_returns_401() -> None:
    assert APIClient().get(URL).status_code == 401
    assert APIClient().patch(URL, {"default_landing": "my_work"}).status_code == 401


@pytest.mark.django_db
def test_get_profile_lazily_returns_auto_default() -> None:
    user = User.objects.create_user(username="lazy", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["default_landing"] == DefaultLanding.AUTO


@pytest.mark.django_db
def test_patch_sets_preference() -> None:
    user = User.objects.create_user(username="setter", password="pw")
    resp = _client(user).patch(URL, {"default_landing": "my_work"})
    assert resp.status_code == 200
    assert resp.data["default_landing"] == "my_work"
    assert UserProfile.objects.get(user=user).default_landing == "my_work"


@pytest.mark.django_db
def test_patch_rejects_invalid_choice() -> None:
    user = User.objects.create_user(username="bad", password="pw")
    resp = _client(user).patch(URL, {"default_landing": "not_a_surface"})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_patch_is_idempotent() -> None:
    user = User.objects.create_user(username="twice", password="pw")
    c = _client(user)
    c.patch(URL, {"default_landing": "project_overview"})
    resp = c.patch(URL, {"default_landing": "project_overview"})
    assert resp.status_code == 200
    assert UserProfile.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_user_can_only_touch_own_profile() -> None:
    """No :id in the path — a user's PATCH only ever writes their own row."""
    alice = User.objects.create_user(username="alice", password="pw")
    bob = User.objects.create_user(username="bob", password="pw")
    _client(alice).patch(URL, {"default_landing": "my_work"})

    # Bob's profile is untouched (defaults to auto), Alice's is my_work.
    assert _client(bob).get(URL).data["default_landing"] == DefaultLanding.AUTO
    assert UserProfile.objects.get(user=alice).default_landing == "my_work"
