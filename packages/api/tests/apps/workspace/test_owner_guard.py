"""Unit tests for the workspace owner-counting / last-owner guard (#784).

``workspace_owner_user_ids`` and ``would_strand_workspace`` are the safety floor
that stops the workspace from being left ownerless by a member edit or a
self-demote. The last-owner *behavior* is exercised end-to-end at the members
API (``test_members_api.test_owner_cannot_demote_last_owner``), but the service
functions themselves — in particular the subtle "active superuser is an implicit
owner unless an explicit row overrides them" branch — had no direct coverage.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.workspace.models import (
    MemberStatus,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)
from trueppm_api.apps.workspace.services import (
    workspace_owner_user_ids,
    would_strand_workspace,
)

User = get_user_model()


def _membership(
    user: object,
    role: int = WorkspaceRole.OWNER,
    *,
    status: str = MemberStatus.ACTIVE,
    is_deleted: bool = False,
) -> WorkspaceMembership:
    return WorkspaceMembership.objects.create(
        workspace=Workspace.load(),
        user=user,
        role=role,
        status=status,
        is_deleted=is_deleted,
    )


# ---------------------------------------------------------------------------
# workspace_owner_user_ids
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_explicit_active_owner_is_counted() -> None:
    owner = User.objects.create_user(username="owner", password="pw")
    _membership(owner, WorkspaceRole.OWNER)
    assert workspace_owner_user_ids() == {owner.pk}


@pytest.mark.django_db
def test_non_active_owner_is_excluded() -> None:
    """A deactivated OWNER row no longer confers owner authority."""
    owner = User.objects.create_user(username="owner", password="pw")
    _membership(owner, WorkspaceRole.OWNER, status=MemberStatus.DEACTIVATED)
    assert workspace_owner_user_ids() == set()


@pytest.mark.django_db
def test_soft_deleted_owner_is_excluded() -> None:
    owner = User.objects.create_user(username="owner", password="pw")
    _membership(owner, WorkspaceRole.OWNER, is_deleted=True)
    assert workspace_owner_user_ids() == set()


@pytest.mark.django_db
def test_non_owner_role_is_not_counted() -> None:
    admin = User.objects.create_user(username="admin", password="pw")
    _membership(admin, WorkspaceRole.ADMIN)
    assert workspace_owner_user_ids() == set()


@pytest.mark.django_db
def test_active_superuser_without_explicit_row_is_implicit_owner() -> None:
    su = User.objects.create_user(username="su", password="pw", is_superuser=True)
    assert workspace_owner_user_ids() == {su.pk}


@pytest.mark.django_db
def test_superuser_with_explicit_non_owner_row_is_not_owner() -> None:
    """An explicit (overriding) membership row suppresses the superuser-implicit-owner
    promotion — the row, not the ``is_superuser`` flag, is authoritative."""
    su = User.objects.create_user(username="su", password="pw", is_superuser=True)
    _membership(su, WorkspaceRole.ADMIN)
    assert workspace_owner_user_ids() == set()


@pytest.mark.django_db
def test_inactive_superuser_is_not_an_owner() -> None:
    User.objects.create_user(username="su", password="pw", is_superuser=True, is_active=False)
    assert workspace_owner_user_ids() == set()


@pytest.mark.django_db
def test_exclude_user_id_drops_the_candidate() -> None:
    a = User.objects.create_user(username="a", password="pw")
    b = User.objects.create_user(username="b", password="pw")
    _membership(a, WorkspaceRole.OWNER)
    _membership(b, WorkspaceRole.OWNER)
    assert workspace_owner_user_ids(exclude_user_id=a.pk) == {b.pk}


# ---------------------------------------------------------------------------
# would_strand_workspace
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_removing_the_sole_owner_would_strand() -> None:
    owner = User.objects.create_user(username="owner", password="pw")
    _membership(owner, WorkspaceRole.OWNER)
    assert would_strand_workspace(owner.pk) is True


@pytest.mark.django_db
def test_second_owner_prevents_stranding() -> None:
    a = User.objects.create_user(username="a", password="pw")
    b = User.objects.create_user(username="b", password="pw")
    _membership(a, WorkspaceRole.OWNER)
    _membership(b, WorkspaceRole.OWNER)
    assert would_strand_workspace(a.pk) is False


@pytest.mark.django_db
def test_remaining_superuser_prevents_stranding() -> None:
    """Demoting the only explicit OWNER does not strand the workspace while an
    active superuser (implicit owner) is still around."""
    owner = User.objects.create_user(username="owner", password="pw")
    _membership(owner, WorkspaceRole.OWNER)
    User.objects.create_user(username="su", password="pw", is_superuser=True)
    assert would_strand_workspace(owner.pk) is False
