"""Tests for GET/PATCH /api/v1/auth/me/profile/ (ADR-0129)."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.profiles.models import DefaultLanding, RoleContext, UserProfile

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


# --- hidden_views (ADR-0139) -----------------------------------------------


@pytest.mark.django_db
def test_get_profile_lazily_returns_empty_hidden_views() -> None:
    user = User.objects.create_user(username="hv_lazy", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == []


@pytest.mark.django_db
def test_patch_sets_hidden_views() -> None:
    user = User.objects.create_user(username="hv_set", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": ["schedule", "calendar"]}, format="json")
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == ["schedule", "calendar"]
    assert UserProfile.objects.get(user=user).hidden_views == ["schedule", "calendar"]


@pytest.mark.django_db
def test_patch_hidden_views_does_not_clobber_default_landing() -> None:
    """A partial PATCH of one preference field leaves the other untouched."""
    user = User.objects.create_user(username="hv_partial", password="pw")
    c = _client(user)
    c.patch(URL, {"default_landing": "my_work"}, format="json")
    c.patch(URL, {"hidden_views": ["board"]}, format="json")
    profile = UserProfile.objects.get(user=user)
    assert profile.default_landing == "my_work"
    assert profile.hidden_views == ["board"]


@pytest.mark.django_db
def test_reset_clears_hidden_views() -> None:
    """'Reset to default' is PATCH hidden_views: []."""
    user = User.objects.create_user(username="hv_reset", password="pw")
    c = _client(user)
    c.patch(URL, {"hidden_views": ["schedule", "grid"]}, format="json")
    resp = c.patch(URL, {"hidden_views": []}, format="json")
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == []
    assert UserProfile.objects.get(user=user).hidden_views == []


@pytest.mark.django_db
def test_patch_rejects_unknown_view_key() -> None:
    user = User.objects.create_user(username="hv_bad", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": ["schedule", "bogus"]}, format="json")
    assert resp.status_code == 400
    assert "hidden_views" in resp.data


@pytest.mark.django_db
def test_patch_rejects_overview_as_non_hideable() -> None:
    """overview is the always-on landing — never hideable (ADR-0139)."""
    user = User.objects.create_user(username="hv_overview", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": ["overview"]}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_patch_deduplicates_hidden_views() -> None:
    user = User.objects.create_user(username="hv_dupe", password="pw")
    resp = _client(user).patch(
        URL, {"hidden_views": ["schedule", "schedule", "grid"]}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == ["schedule", "grid"]


# --- role_context (#412) ----------------------------------------------------


@pytest.mark.django_db
def test_role_context_unauthenticated_returns_401() -> None:
    assert APIClient().patch(URL, {"role_context": "pm"}).status_code == 401


@pytest.mark.django_db
def test_get_profile_lazily_returns_unified_role_context() -> None:
    """A fresh profile defaults to the dual-hat 'Unified Today' lens (#412)."""
    user = User.objects.create_user(username="rc_lazy", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["role_context"] == RoleContext.UNIFIED


@pytest.mark.django_db
@pytest.mark.parametrize("choice", ["pm", "scrum_master", "unified"])
def test_patch_role_context_round_trips_every_choice(choice: str) -> None:
    user = User.objects.create_user(username=f"rc_{choice}", password="pw")
    resp = _client(user).patch(URL, {"role_context": choice})
    assert resp.status_code == 200
    assert resp.data["role_context"] == choice
    assert UserProfile.objects.get(user=user).role_context == choice


@pytest.mark.django_db
def test_patch_rejects_invalid_role_context() -> None:
    user = User.objects.create_user(username="rc_bad", password="pw")
    resp = _client(user).patch(URL, {"role_context": "not_a_role"})
    assert resp.status_code == 400
    assert "role_context" in resp.data


@pytest.mark.django_db
def test_patch_role_context_does_not_clobber_other_prefs() -> None:
    """A partial PATCH of role_context leaves default_landing/hidden_views alone."""
    user = User.objects.create_user(username="rc_partial", password="pw")
    c = _client(user)
    c.patch(URL, {"default_landing": "my_work"}, format="json")
    c.patch(URL, {"hidden_views": ["board"]}, format="json")
    c.patch(URL, {"role_context": "scrum_master"}, format="json")
    profile = UserProfile.objects.get(user=user)
    assert profile.default_landing == "my_work"
    assert profile.hidden_views == ["board"]
    assert profile.role_context == "scrum_master"


@pytest.mark.django_db
def test_user_can_only_touch_own_role_context() -> None:
    """No :id in the path — a user's PATCH only ever writes their own row."""
    alice = User.objects.create_user(username="rc_alice", password="pw")
    bob = User.objects.create_user(username="rc_bob", password="pw")
    _client(alice).patch(URL, {"role_context": "pm"})

    # Bob's profile is untouched (defaults to unified), Alice's is pm.
    assert _client(bob).get(URL).data["role_context"] == RoleContext.UNIFIED
    assert UserProfile.objects.get(user=alice).role_context == "pm"
