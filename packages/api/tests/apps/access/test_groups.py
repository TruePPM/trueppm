"""Tests for the auto-group resolver (apps/access/groups.py, ADR-0075)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.groups import (
    ALL_GROUP_HARD_CAP,
    KNOWN_GROUP_KEYS,
    GroupTooLargeError,
    InvalidGroupKeyError,
    resolve_group_members,
)
from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, SprintState, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def users() -> dict[str, object]:
    """Five users, one per role band, plus an extra Member for cap math."""
    return {
        "owner": User.objects.create_user(username="o1", password="pw"),
        "admin": User.objects.create_user(username="a1", password="pw"),
        "scheduler": User.objects.create_user(username="s1", password="pw"),
        "member": User.objects.create_user(username="m1", password="pw"),
        "viewer": User.objects.create_user(username="v1", password="pw"),
        "member2": User.objects.create_user(username="m2", password="pw"),
    }


@pytest.fixture
def memberships(project: Project, users: dict[str, object]) -> dict[str, ProjectMembership]:
    out: dict[str, ProjectMembership] = {}
    out["owner"] = ProjectMembership.objects.create(
        project=project, user=users["owner"], role=Role.OWNER
    )
    out["admin"] = ProjectMembership.objects.create(
        project=project, user=users["admin"], role=Role.ADMIN
    )
    out["scheduler"] = ProjectMembership.objects.create(
        project=project, user=users["scheduler"], role=Role.SCHEDULER
    )
    out["member"] = ProjectMembership.objects.create(
        project=project, user=users["member"], role=Role.MEMBER
    )
    out["viewer"] = ProjectMembership.objects.create(
        project=project, user=users["viewer"], role=Role.VIEWER
    )
    out["member2"] = ProjectMembership.objects.create(
        project=project, user=users["member2"], role=Role.MEMBER
    )
    return out


# ---------------------------------------------------------------------------
# Role-floor groups
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRoleBandedGroups:
    def test_owners_returns_only_owner_role(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        resolved = resolve_group_members(project.pk, "owners")
        assert set(resolved) == {users["owner"].pk}  # type: ignore[attr-defined]

    def test_admins_includes_owner(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        resolved = resolve_group_members(project.pk, "admins")
        assert set(resolved) == {users["owner"].pk, users["admin"].pk}  # type: ignore[attr-defined]

    def test_schedulers_includes_admin_and_owner(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        resolved = resolve_group_members(project.pk, "schedulers")
        assert set(resolved) == {  # type: ignore[attr-defined]
            users["owner"].pk,
            users["admin"].pk,
            users["scheduler"].pk,
        }

    def test_members_excludes_viewer(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        """`@members` floor is MEMBER, so the lone Viewer is excluded."""
        resolved = resolve_group_members(project.pk, "members")
        ids = set(resolved)
        assert users["viewer"].pk not in ids  # type: ignore[attr-defined]
        assert users["member"].pk in ids  # type: ignore[attr-defined]
        assert users["member2"].pk in ids  # type: ignore[attr-defined]

    def test_viewers_includes_everyone(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        """`@viewers` floor is VIEWER, so every active member resolves."""
        resolved = resolve_group_members(project.pk, "viewers")
        assert len(set(resolved)) == 6

    def test_case_and_whitespace_normalized(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        a = resolve_group_members(project.pk, "  OWNERS  ")
        b = resolve_group_members(project.pk, "Owners")
        c = resolve_group_members(project.pk, "owners")
        assert set(a) == set(b) == set(c)

    def test_soft_deleted_membership_excluded(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        memberships["member"].is_deleted = True
        memberships["member"].save(update_fields=["is_deleted"])
        resolved = resolve_group_members(project.pk, "members")
        assert users["member"].pk not in set(resolved)  # type: ignore[attr-defined]
        assert users["member2"].pk in set(resolved)  # type: ignore[attr-defined]

    def test_other_project_membership_isolated(
        self,
        project: Project,
        users: dict[str, object],
        memberships: dict[str, ProjectMembership],
        calendar: Calendar,
    ) -> None:
        """A user who is an Owner of another project must not resolve here."""
        other = Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=calendar)
        outsider = User.objects.create_user(username="outsider", password="pw")
        ProjectMembership.objects.create(project=other, user=outsider, role=Role.OWNER)
        resolved = resolve_group_members(project.pk, "owners")
        assert outsider.pk not in set(resolved)


# ---------------------------------------------------------------------------
# @all + cardinality cap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAllGroup:
    def test_all_returns_every_member(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        resolved = resolve_group_members(project.pk, "all")
        assert len(set(resolved)) == 6

    def test_all_too_large_raises_group_too_large(
        self, project: Project, memberships: dict[str, ProjectMembership]
    ) -> None:
        """Patching the cap to 5 with 6 members in the project should raise."""
        with (
            patch("trueppm_api.apps.access.groups.ALL_GROUP_HARD_CAP", 5),
            pytest.raises(GroupTooLargeError) as exc_info,
        ):
            resolve_group_members(project.pk, "all")
        # We patched the constant but the exception default arg captured the
        # original value at function-definition time — assert via the exception
        # attributes, not the message text.
        assert exc_info.value.key == "all"
        assert exc_info.value.count == 6

    def test_group_too_large_message_includes_counts(self) -> None:
        exc = GroupTooLargeError("all", 250)
        assert "250" in str(exc)
        assert str(ALL_GROUP_HARD_CAP) in str(exc)


# ---------------------------------------------------------------------------
# @scrum-team
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestScrumTeamGroup:
    def test_scrum_team_returns_active_sprint_assignees(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        active = Sprint.objects.create(
            project=project,
            name="S1",
            start_date=date(2026, 1, 1),
            finish_date=date(2026, 1, 14),
            state=SprintState.ACTIVE,
        )
        Task.objects.create(
            project=project, name="T1", duration=1, sprint=active, assignee=users["member"]
        )
        Task.objects.create(
            project=project, name="T2", duration=1, sprint=active, assignee=users["scheduler"]
        )
        # Unassigned tasks and tasks in PLANNED sprints don't contribute.
        Task.objects.create(project=project, name="T3", duration=1, sprint=active, assignee=None)
        planned = Sprint.objects.create(
            project=project,
            name="S2",
            start_date=date(2026, 2, 1),
            finish_date=date(2026, 2, 14),
            state=SprintState.PLANNED,
        )
        Task.objects.create(
            project=project, name="T4", duration=1, sprint=planned, assignee=users["admin"]
        )

        resolved = resolve_group_members(project.pk, "scrum-team")
        ids = set(resolved)
        assert ids == {users["member"].pk, users["scheduler"].pk}  # type: ignore[attr-defined]

    def test_scrum_team_empty_when_no_active_sprint(
        self, project: Project, users: dict[str, object], memberships: dict[str, ProjectMembership]
    ) -> None:
        resolved = resolve_group_members(project.pk, "scrum-team")
        assert resolved == []


# ---------------------------------------------------------------------------
# Unknown keys
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestInvalidGroupKey:
    def test_unknown_key_raises(self, project: Project) -> None:
        with pytest.raises(InvalidGroupKeyError):
            resolve_group_members(project.pk, "nope")

    def test_empty_string_raises(self, project: Project) -> None:
        with pytest.raises(InvalidGroupKeyError):
            resolve_group_members(project.pk, "")

    def test_known_keys_match_documentation(self) -> None:
        expected = frozenset(
            {"owners", "admins", "schedulers", "members", "viewers", "all", "scrum-team"}
        )
        assert expected == KNOWN_GROUP_KEYS
