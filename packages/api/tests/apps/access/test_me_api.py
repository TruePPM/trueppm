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
    # Role-based landing fact (ADR-0129).
    assert data["default_landing"] == "auto"
    assert set(data["landing"]) == {"intent", "path", "resolved_by"}
    # A user with no memberships lands on My Work (onboarding) by fallback.
    assert data["landing"]["intent"] == "my_work"
    assert data["landing"]["path"] == "/me/work"
    assert data["landing"]["resolved_by"] == "fallback"
    # Per-user nav visibility (ADR-0139): empty by default (no row).
    assert data["hidden_views"] == []
    # Role-context lens (issue 412, ADR-0161): neutral 'unified' by default (no row).
    assert data["role_context"] == "unified"


def test_me_surfaces_stored_hidden_views(db: object) -> None:
    """/auth/me/ reflects the user's stored hidden_views (ADR-0139)."""
    from trueppm_api.apps.profiles.models import UserProfile

    user = User.objects.create_user(username="hv_me", password="pw")
    UserProfile.objects.create(user=user, hidden_views=["schedule", "calendar"])
    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == ["schedule", "calendar"]


@pytest.mark.django_db
def test_me_surfaces_stored_role_context(db: object) -> None:
    """/auth/me/ reflects the user's stored role_context lens (issue 1263, ADR-0161).

    The lens is read-only here — it is written via PATCH /auth/me/profile/ — and
    the read must NOT change any access fact, only surface the stored value.
    """
    from trueppm_api.apps.profiles.models import UserProfile

    user = User.objects.create_user(username="rc_me", password="pw")
    UserProfile.objects.create(user=user, role_context="scrum_master")
    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["role_context"] == "scrum_master"
    # The lens never grants authority: a no-membership user stays a contributor.
    assert resp.data["can_access_admin_settings"] is False


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


# ---------------------------------------------------------------------------
# Role signal — can_access_admin_settings (#855/#856, ADR-0122)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_role_signal_contributor_cannot_access_admin_settings(db: object) -> None:
    """A user who is only a MEMBER in their projects gets the contributor signal."""
    from datetime import date

    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.projects.models import Calendar, Project

    cal = Calendar.objects.create(name="Standard")
    proj = Project.objects.create(name="P1", start_date=date(2026, 1, 1), calendar=cal)
    user = User.objects.create_user(username="priya", password="pw")
    ProjectMembership.objects.create(project=proj, user=user, role=Role.MEMBER)

    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["max_project_role"] == Role.MEMBER
    assert resp.data["workspace_role"] is None
    assert resp.data["can_access_admin_settings"] is False


@pytest.mark.django_db
def test_role_signal_project_admin_can_access_admin_settings(db: object) -> None:
    """ADMIN+ in any project flips can_access_admin_settings True."""
    from datetime import date

    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.projects.models import Calendar, Project

    cal = Calendar.objects.create(name="Standard")
    proj = Project.objects.create(name="P1", start_date=date(2026, 1, 1), calendar=cal)
    user = User.objects.create_user(username="sam", password="pw")
    ProjectMembership.objects.create(project=proj, user=user, role=Role.ADMIN)

    resp = _make_client(user).get(URL)
    assert resp.data["max_project_role"] == Role.ADMIN
    assert resp.data["can_access_admin_settings"] is True


@pytest.mark.django_db
def test_role_signal_no_memberships(db: object) -> None:
    """A user with no project or workspace membership is a contributor by default."""
    user = User.objects.create_user(username="loner", password="pw")
    resp = _make_client(user).get(URL)
    assert resp.data["max_project_role"] is None
    assert resp.data["workspace_role"] is None
    assert resp.data["can_access_admin_settings"] is False
