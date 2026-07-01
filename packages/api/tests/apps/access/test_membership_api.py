"""Tests for the ProjectMembership nested CRUD API."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="admin_u", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member_u", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


@pytest.fixture
def owner_membership(project: Project, owner: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)


@pytest.fixture
def owner_client(owner: object, owner_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def member_membership(project: Project, member_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def member_client(member_user: object, member_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def non_owner_client(request: pytest.FixtureRequest, project: Project) -> APIClient:
    """A client authenticated as a member holding the parametrized non-Owner role.

    Parametrized via ``request.param`` over ADMIN/SCHEDULER/VIEWER — the roles
    adjacent to the Owner-only member-management gate. These sit *above* the
    Member-403 case already covered, so they pin that relaxing the Owner-only
    gate to Admin (a one-token change) is a privilege escalation the suite catches.
    """
    role = request.param
    user = User.objects.create_user(username=f"nonowner_{int(role)}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project, pk: object = None) -> str:
    base = f"/api/v1/projects/{project.pk}/members/"
    return f"{base}{pk}/" if pk else base


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_requires_membership(
    outsider: object, project: Project, owner_membership: ProjectMembership
) -> None:
    c = APIClient()
    c.force_authenticate(user=outsider)
    resp = c.get(_url(project))
    assert resp.status_code == 403


@pytest.mark.django_db
def test_list_visible_to_viewer(project: Project, owner_membership: ProjectMembership) -> None:
    viewer = User.objects.create_user(username="viewer_u", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    resp = c.get(_url(project))
    assert resp.status_code == 200
    assert len(resp.data) == 2  # owner + viewer


@pytest.mark.django_db
def test_list_excludes_soft_deleted(
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    member_membership.soft_delete()
    c = APIClient()
    c.force_authenticate(user=owner_membership.user)
    resp = c.get(_url(project))
    assert resp.status_code == 200
    ids = [m["id"] for m in resp.data]
    assert str(member_membership.pk) not in ids


# ---------------------------------------------------------------------------
# Create (Owner only)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_member_as_owner(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    new_user = User.objects.create_user(username="new_u", password="pw")
    resp = owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.MEMBER})
    assert resp.status_code == 201
    assert ProjectMembership.objects.filter(project=project, user=new_user).exists()


@pytest.mark.django_db
def test_create_blocked_for_member(
    member_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    new_user = User.objects.create_user(username="new_u2", password="pw")
    resp = member_client.post(_url(project), {"user": str(new_user.pk), "role": Role.VIEWER})
    assert resp.status_code == 403


@pytest.mark.django_db
def test_create_cannot_assign_owner_role(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """Owner cannot assign Owner to another user (role >= own role)."""
    new_user = User.objects.create_user(username="new_u3", password="pw")
    resp = owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.OWNER})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_duplicate_returns_409(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.VIEWER})
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Update (Owner only, role escalation rule)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_partial_update_role_as_owner(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.SCHEDULER})
    assert resp.status_code == 200
    member_membership.refresh_from_db()
    assert member_membership.role == Role.SCHEDULER


@pytest.mark.django_db
def test_partial_update_blocked_for_member(
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = member_client.patch(_url(project, owner_membership.pk), {"role": Role.VIEWER})
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Destroy — self-removal and last-Owner guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_can_self_remove(
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = member_client.delete(_url(project, member_membership.pk))
    assert resp.status_code == 204
    member_membership.refresh_from_db()
    assert member_membership.is_deleted is True


@pytest.mark.django_db
def test_last_owner_guard_on_self_remove(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    resp = owner_client.delete(_url(project, owner_membership.pk))
    assert resp.status_code == 400


@pytest.mark.django_db
def test_owner_can_remove_lower_role(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = owner_client.delete(_url(project, member_membership.pk))
    assert resp.status_code == 204
    member_membership.refresh_from_db()
    assert member_membership.is_deleted is True


@pytest.mark.django_db
def test_member_cannot_remove_owner(
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = member_client.delete(_url(project, owner_membership.pk))
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# role_label field (issue #11 label rename)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_includes_role_label(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """role_label must appear in the membership list response with the correct human label."""
    resp = owner_client.get(_url(project))
    assert resp.status_code == 200
    row = next(m for m in resp.data if m["id"] == str(owner_membership.pk))
    assert row["role_label"] == "Project Admin"


@pytest.mark.django_db
def test_retrieve_includes_role_label(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    resp = owner_client.get(_url(project, owner_membership.pk))
    assert resp.status_code == 200
    assert resp.data["role_label"] == "Project Admin"


# ---------------------------------------------------------------------------
# M4: partial_update role escalation blocked
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_partial_update_cannot_assign_equal_role(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """Owner (role == Role.OWNER) cannot assign Owner role (>= own role) to another member."""
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.OWNER})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_update_role_last_owner_guard(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """The sole Owner cannot PATCH themselves below Owner — the last-Owner guard.

    Demoting the only Owner (here to ADMIN) would strand the project with zero
    Owners. ``partial_update`` trips ``_check_last_owner_guard`` (access/views.py)
    and returns 400 with the role unchanged. Mirrors
    ``test_program_membership_api.py::test_update_role_last_owner_guard`` — the
    program suite covered this branch; the project suite did not, so removing the
    guard's three lines would let the last Owner self-demote and ship green.
    """
    resp = owner_client.patch(_url(project, owner_membership.pk), {"role": Role.ADMIN})
    assert resp.status_code == 400
    owner_membership.refresh_from_db()
    assert owner_membership.role == Role.OWNER


# ---------------------------------------------------------------------------
# Member management is Owner-only — the roles between Member and Owner must be
# blocked too (#1508). The suite tested only Owner-allowed and Member-403, so a
# relaxation of the Owner-only gate to Admin (one token) would ship green. These
# pin ADMIN/SCHEDULER/VIEWER at 403 on every write path.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "non_owner_client", [Role.ADMIN, Role.SCHEDULER, Role.VIEWER], indirect=True
)
def test_create_member_blocked_for_non_owner(
    non_owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """Adding a member requires Owner — Admin/Scheduler/Viewer are all 403."""
    new_user = User.objects.create_user(username="added_by_non_owner", password="pw")
    resp = non_owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.VIEWER})
    assert resp.status_code == 403
    assert not ProjectMembership.objects.filter(project=project, user=new_user).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "non_owner_client", [Role.ADMIN, Role.SCHEDULER, Role.VIEWER], indirect=True
)
def test_partial_update_role_blocked_for_non_owner(
    non_owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """Changing another member's role requires Owner — non-Owners are all 403."""
    resp = non_owner_client.patch(_url(project, member_membership.pk), {"role": Role.SCHEDULER})
    assert resp.status_code == 403
    member_membership.refresh_from_db()
    assert member_membership.role == Role.MEMBER


@pytest.mark.django_db
@pytest.mark.parametrize(
    "non_owner_client", [Role.ADMIN, Role.SCHEDULER, Role.VIEWER], indirect=True
)
def test_destroy_other_member_blocked_for_non_owner(
    non_owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """Removing another member requires Owner — non-Owners are all 403 (self-removal excepted)."""
    resp = non_owner_client.delete(_url(project, member_membership.pk))
    assert resp.status_code == 403
    member_membership.refresh_from_db()
    assert member_membership.is_deleted is False


# ---------------------------------------------------------------------------
# #590: per-project access evidence (joined_at / role_changed_at)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_new_membership_backfills_joined_at_and_null_role_changed_at(
    member_membership: ProjectMembership,
) -> None:
    """A freshly created membership has joined_at set and role_changed_at NULL.

    role_changed_at NULL is the "no role change since joining" signal the read
    serializer and UI key off; the migration leaves existing rows in the same
    state (joined_at backfilled via default, role_changed_at NULL).
    """
    assert member_membership.joined_at is not None
    assert member_membership.role_changed_at is None


@pytest.mark.django_db
def test_list_includes_access_evidence_fields(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    resp = owner_client.get(_url(project))
    assert resp.status_code == 200
    row = next(m for m in resp.data if m["id"] == str(owner_membership.pk))
    assert row["joined_at"] is not None
    assert row["role_changed_at"] is None


@pytest.mark.django_db
def test_partial_update_stamps_role_changed_at(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """An actual role change stamps role_changed_at at/after the join time."""
    assert member_membership.role_changed_at is None
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.SCHEDULER})
    assert resp.status_code == 200
    assert resp.data["role_changed_at"] is not None
    member_membership.refresh_from_db()
    assert member_membership.role_changed_at is not None
    assert member_membership.role_changed_at >= member_membership.joined_at


@pytest.mark.django_db
def test_partial_update_same_role_does_not_stamp(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """A no-op PATCH that re-sends the current role must not advance role_changed_at."""
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.MEMBER})
    assert resp.status_code == 200
    member_membership.refresh_from_db()
    assert member_membership.role_changed_at is None


@pytest.mark.django_db
def test_transfer_project_ownership_stamps_both_rows(
    project: Project,
    owner: object,
    member_user: object,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """The ownership-transfer service stamps role_changed_at on both affected rows.

    This is the second role-change path (alongside the PATCH endpoint); without
    stamping here the access-evidence timestamp would silently miss transfers.
    """
    from trueppm_api.apps.access.services import transfer_project_ownership

    transfer_project_ownership(project=project, new_owner=member_user, actor=owner)

    owner_membership.refresh_from_db()
    member_membership.refresh_from_db()
    assert owner_membership.role == Role.ADMIN
    assert member_membership.role == Role.OWNER
    assert owner_membership.role_changed_at is not None
    assert member_membership.role_changed_at is not None


# ---------------------------------------------------------------------------
# Other-active-projects count + visibility-gated names (#598)
# ---------------------------------------------------------------------------


def _make_project(name: str, *, archived: bool = False, deleted: bool = False) -> Project:
    p = Project.objects.create(name=name, start_date=date(2026, 1, 1))
    if archived:
        p.is_archived = True
        p.save(update_fields=["is_archived"])
    if deleted:
        p.is_deleted = True
        p.save(update_fields=["is_deleted"])
    return p


def _row_for(resp: object, user: object) -> dict[str, object]:
    return next(r for r in resp.data if str(r["user"]) == str(user.pk))  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_list_includes_other_active_project_count(
    owner_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    for name in ("Apollo", "Gemini"):
        ProjectMembership.objects.create(
            project=_make_project(name), user=member_user, role=Role.MEMBER
        )
    resp = owner_client.get(_url(project))
    assert resp.status_code == 200
    assert _row_for(resp, member_user)["other_active_project_count"] == 2


@pytest.mark.django_db
def test_count_excludes_archived_and_soft_deleted_projects(
    owner_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    ProjectMembership.objects.create(
        project=_make_project("ActiveOne"), user=member_user, role=Role.MEMBER
    )
    ProjectMembership.objects.create(
        project=_make_project("Archived", archived=True), user=member_user, role=Role.MEMBER
    )
    ProjectMembership.objects.create(
        project=_make_project("Deleted", deleted=True), user=member_user, role=Role.MEMBER
    )
    resp = owner_client.get(_url(project))
    assert _row_for(resp, member_user)["other_active_project_count"] == 1  # only ActiveOne


@pytest.mark.django_db
def test_count_excludes_the_current_project(
    owner_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    resp = owner_client.get(_url(project))
    assert _row_for(resp, member_user)["other_active_project_count"] == 0


@pytest.mark.django_db
def test_names_listed_only_for_projects_the_requester_owns(
    owner: object,
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    # member_user is on two other active projects; the requester (owner) is OWNER of
    # Apollo but only a MEMBER of Gemini — so only Apollo's name may be revealed.
    apollo = _make_project("Apollo")
    gemini = _make_project("Gemini")
    ProjectMembership.objects.create(project=apollo, user=member_user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=gemini, user=member_user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=apollo, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=gemini, user=owner, role=Role.MEMBER)

    row = _row_for(owner_client.get(_url(project)), member_user)
    assert row["other_active_project_count"] == 2  # full count is not gated
    assert row["other_active_project_names"] == ["Apollo"]  # names are gated to owned projects


@pytest.mark.django_db
def test_names_empty_when_requester_owns_no_shared_projects(
    owner: object,
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    # The requester (a plain MEMBER) owns no other projects, so they see counts but
    # no project names for anyone.
    ProjectMembership.objects.create(project=_make_project("Apollo"), user=owner, role=Role.MEMBER)
    row = _row_for(member_client.get(_url(project)), owner)
    assert row["other_active_project_count"] == 1
    assert row["other_active_project_names"] == []
