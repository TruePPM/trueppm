"""``guest_count`` on GET/PATCH /api/v1/workspace/ (#5102).

Backs the "Enabled - N guests" readout on the Guest access toggle. The value is an
annotation over membership rows, so these tests pin what it counts and that a client
cannot write it.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.workspace.models import (
    MemberStatus,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)

User = get_user_model()
SETTINGS_URL = "/api/v1/workspace/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def admin(db: object) -> object:
    user = User.objects.create_user(username="gc-admin", email="gc-admin@example.com")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.ADMIN
    )
    return user


def _add(username: str, status: str) -> None:
    user = User.objects.create_user(username=username, email=f"{username}@example.com")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.MEMBER, status=status
    )


def test_counts_only_guest_status_members(admin: object) -> None:
    _add("g1", MemberStatus.GUEST)
    _add("g2", MemberStatus.GUEST)
    _add("a1", MemberStatus.ACTIVE)
    _add("d1", MemberStatus.DEACTIVATED)

    res = _client(admin).get(SETTINGS_URL)

    assert res.status_code == 200
    assert res.data["guest_count"] == 2


def test_zero_when_no_guests(admin: object) -> None:
    res = _client(admin).get(SETTINGS_URL)
    assert res.data["guest_count"] == 0


def test_guest_count_is_read_only(admin: object) -> None:
    _add("g1", MemberStatus.GUEST)

    res = _client(admin).patch(SETTINGS_URL, {"guest_count": 99}, format="json")

    assert res.status_code == 200
    assert res.data["guest_count"] == 1


def test_non_admin_does_not_see_count(db: object) -> None:
    member = User.objects.create_user(username="gc-member", email="gc-member@example.com")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=member, role=WorkspaceRole.MEMBER
    )
    res = _client(member).get(SETTINGS_URL)
    # The route stays readable for members; only the admin-facing count is withheld.
    assert res.status_code == 200
    assert "guest_count" not in res.data
