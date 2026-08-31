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
    # Role-context lens (issue 412, ADR-0162): neutral 'unified' by default (no row).
    assert data["role_context"] == "unified"
    # The Schedule-in-Deliver placement opt-in (ADR-0203, #1645) is retired by
    # ADR-0942 §3 / #3137 — the payload must not carry a field nothing reads.
    assert "schedule_in_deliver" not in data
    # Display frame (#1953, ADR-0410): both prefs default to the 'auto' sentinel.
    assert data["timezone"] == "auto"
    assert data["date_format"] == "auto"


def test_me_surfaces_stored_display_prefs(db: object) -> None:
    """/auth/me/ reflects the user's stored timezone + date_format (#1953, ADR-0410).

    These are read-only, display-only projections — the API itself always emits
    aware-UTC ISO-8601; the read must not change any access fact.
    """
    from trueppm_api.apps.profiles.models import UserProfile

    user = User.objects.create_user(username="tz_me", password="pw")
    UserProfile.objects.create(user=user, timezone="Asia/Tokyo", date_format="eu")
    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["timezone"] == "Asia/Tokyo"
    assert resp.data["date_format"] == "eu"
    # Display prefs never grant authority.
    assert resp.data["can_access_admin_settings"] is False


def test_me_does_not_surface_retired_schedule_in_deliver(db: object) -> None:
    """/auth/me/ no longer carries ``schedule_in_deliver`` (ADR-0942 §3, #3137).

    The regression this guards is a re-added dead field, not a value: a boolean that
    round-trips while nothing reads it is a lie to every API and MCP client about what
    the product does, which is why #3137 dropped the column instead of no-op'ing it.
    Asserted on a user WITH a profile row, so the absence is the serializer's doing and
    not the lazy no-row path.
    """
    from trueppm_api.apps.profiles.models import UserProfile

    user = User.objects.create_user(username="sid_me", password="pw")
    UserProfile.objects.create(user=user, hidden_views=["board"])
    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert "schedule_in_deliver" not in resp.data
    # The surviving prefs still read through the same memoized single-row fetch.
    assert resp.data["hidden_views"] == ["board"]
    assert resp.data["role_context"] == "unified"
    assert resp.data["timezone"] == "auto"
    assert resp.data["date_format"] == "auto"


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
    """/auth/me/ reflects the user's stored role_context lens (issue 1263, ADR-0162).

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

    from trueppm_api.apps.workspace.models import WorkspaceRole

    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["max_project_role"] == Role.MEMBER
    # Every authenticated user is the implicit workspace MEMBER (ADR-0087 §6) —
    # MEMBER < ADMIN, so this stays a contributor.
    assert resp.data["workspace_role"] == WorkspaceRole.MEMBER
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
    from trueppm_api.apps.workspace.models import WorkspaceRole

    user = User.objects.create_user(username="loner", password="pw")
    resp = _make_client(user).get(URL)
    assert resp.data["max_project_role"] is None
    # Implicit MEMBER (every authenticated user is a workspace member), not null.
    assert resp.data["workspace_role"] == WorkspaceRole.MEMBER
    assert resp.data["can_access_admin_settings"] is False


@pytest.mark.django_db
def test_role_signal_superuser_bootstraps_as_owner(db: object) -> None:
    """A Django superuser with no explicit membership is the implicit workspace OWNER.

    Regression for the /auth/me shadow-copy bug: workspace RBAC
    (permissions._workspace_membership_role, ADR-0087 §6) grants a superuser
    implicit OWNER so the first admin can manage a fresh install, but MeSerializer
    used to ignore that bootstrap and report can_access_admin_settings=false —
    which made the web Sidebar route Settings to /me/settings/notifications and
    RequireAdminSettings bounce the superuser off /settings even though the server
    let them write workspace settings.
    """
    from trueppm_api.apps.workspace.models import WorkspaceRole

    user = User.objects.create_superuser(username="root", password="pw")
    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["max_project_role"] is None
    assert resp.data["workspace_role"] == WorkspaceRole.OWNER
    assert resp.data["can_access_admin_settings"] is True


@pytest.mark.django_db
def test_role_signal_deactivated_workspace_membership_has_no_access(db: object) -> None:
    """A deactivated explicit membership resolves to no workspace role (ADR-0087 §6).

    The status gate must win over the row's stored role so /auth/me cannot keep
    advertising admin access to a member whose account workspace RBAC has revoked.
    """
    from trueppm_api.apps.workspace.models import (
        MemberStatus,
        Workspace,
        WorkspaceMembership,
        WorkspaceRole,
    )

    ws = Workspace.objects.create(name="Acme")
    user = User.objects.create_user(username="ex_admin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=ws,
        user=user,
        role=WorkspaceRole.ADMIN,
        status=MemberStatus.DEACTIVATED,
    )
    resp = _make_client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["workspace_role"] is None
    assert resp.data["can_access_admin_settings"] is False


# ---------------------------------------------------------------------------
# The one-profile-read property (memoization lock)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_me_reads_the_profile_row_exactly_once() -> None:
    """``MeSerializer`` must hit ``profiles_userprofile`` once, not once per pref.

    Five getters on this serializer need a ``UserProfile`` column
    (``default_landing``, ``hidden_views``, ``role_context``, ``timezone``,
    ``date_format``), and they read it through one memoized ``_prefs()`` call whose
    cache is ``self._prefs_cache``. ``/auth/me/`` is a hot path, so losing that memo
    turns one query into five — a regression that no assertion in this file would
    otherwise notice, because every field still serializes to the right value.

    Locked here because #3137 edited exactly this code: it removed the
    ``schedule_in_deliver`` getter and shrank the ``get_profile_prefs`` tuple from six
    elements to five, renumbering the surviving indices. That is the kind of edit that
    can plausibly drop the ``hasattr`` guard by accident.

    Counted by *table* rather than with an absolute budget for the whole response: the
    endpoint also reads memberships, workspace roles and notification settings, and an
    absolute number would fail on any unrelated change to those while saying nothing
    about the property under test. Asserting on the profile table is the narrow claim
    that actually fails when the memo breaks (1 → 5).
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    from trueppm_api.apps.access.serializers import MeSerializer
    from trueppm_api.apps.profiles.models import UserProfile

    user = User.objects.create_user(username="prefs_once", password="pw")
    UserProfile.objects.create(user=user, hidden_views=["board"], timezone="Asia/Tokyo")

    with CaptureQueriesContext(connection) as captured:
        data = MeSerializer(user).data

    profile_reads = [q for q in captured.captured_queries if "profiles_userprofile" in q["sql"]]
    assert len(profile_reads) == 1, (
        f"expected exactly one profiles_userprofile read, got {len(profile_reads)}: "
        f"{[q['sql'] for q in profile_reads]}"
    )
    # The memo must serve the right values, not merely serve them once.
    assert data["hidden_views"] == ["board"]
    assert data["timezone"] == "Asia/Tokyo"
    assert data["role_context"] == "unified"
    assert data["date_format"] == "auto"
