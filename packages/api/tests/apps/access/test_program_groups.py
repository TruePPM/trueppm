"""Tests for the program-scoped @mention auto-groups (#514, ADR-0075 §C ext).

`@program-pms` / `@program-schedulers` / `@program-stakeholders` / `@program-all`
resolve against the UNION of ProjectMembership across every project in the
mention's program — deduplicated across projects, role-banded, and gated the
same way `@all` is. These tests exercise the resolver directly plus the parser
classification and the actor-role gate on the fan-out path.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.groups import (
    ALL_AUTO_GROUP_KEYS,
    PROGRAM_GROUP_KEYS,
    GroupTooLargeError,
    InvalidGroupKeyError,
    resolve_group_members,
)
from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.notifications.services import parse_mentions, resolve_parsed_mentions
from trueppm_api.apps.projects.models import Calendar, Methodology, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures — one program with two projects + one standalone project
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(db: object) -> object:
    # The creator gets an OWNER ProgramMembership — deliberately NOT a project
    # member, so it must not leak into @program-* resolution (which draws from
    # ProjectMembership only).
    prog_owner = User.objects.create_user(username="prog-owner", password="pw")
    return create_program(
        name="Program Alpha",
        description="",
        methodology=Methodology.HYBRID,
        created_by=prog_owner,
    )


@pytest.fixture
def users() -> dict[str, object]:
    return {
        name: User.objects.create_user(username=name, password="pw")
        for name in ("alice", "bob", "carol", "dave", "erin", "frank")
    }


@pytest.fixture
def proj_a(calendar: Calendar, program: object) -> Project:
    return Project.objects.create(
        name="A", start_date=date(2026, 1, 1), calendar=calendar, program=program
    )


@pytest.fixture
def proj_b(calendar: Calendar, program: object) -> Project:
    return Project.objects.create(
        name="B", start_date=date(2026, 1, 1), calendar=calendar, program=program
    )


@pytest.fixture
def standalone(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Solo", start_date=date(2026, 1, 1), calendar=calendar, program=None
    )


@pytest.fixture
def memberships(proj_a: Project, proj_b: Project, users: dict[str, object]) -> dict[str, object]:
    """alice=Admin·A, bob=Scheduler·A, carol=Viewer·A, dave=Member·A&B,
    erin=Owner·B, frank=Viewer·B. dave spans both projects (dedup probe)."""
    ProjectMembership.objects.create(project=proj_a, user=users["alice"], role=Role.ADMIN)
    ProjectMembership.objects.create(project=proj_a, user=users["bob"], role=Role.SCHEDULER)
    ProjectMembership.objects.create(project=proj_a, user=users["carol"], role=Role.VIEWER)
    ProjectMembership.objects.create(project=proj_a, user=users["dave"], role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_b, user=users["erin"], role=Role.OWNER)
    ProjectMembership.objects.create(project=proj_b, user=users["frank"], role=Role.VIEWER)
    ProjectMembership.objects.create(project=proj_b, user=users["dave"], role=Role.MEMBER)
    return users


# ---------------------------------------------------------------------------
# Resolver — role bands, union across projects, dedup
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProgramGroupResolver:
    def _ids(self, users: dict[str, object], *names: str) -> set[object]:
        return {users[n].pk for n in names}

    def test_program_pms_is_admin_and_owner_across_program(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        got = set(resolve_group_members(proj_a.id, "program-pms"))
        assert got == self._ids(memberships, "alice", "erin")

    def test_program_schedulers_includes_scheduler_and_above(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        got = set(resolve_group_members(proj_a.id, "program-schedulers"))
        assert got == self._ids(memberships, "alice", "bob", "erin")

    def test_program_stakeholders_is_exact_viewer_role(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        # Exact VIEWER — NOT a role>=VIEWER floor (that would equal @program-all).
        got = set(resolve_group_members(proj_a.id, "program-stakeholders"))
        assert got == self._ids(memberships, "carol", "frank")

    def test_program_all_is_every_member_deduplicated(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        result = resolve_group_members(proj_a.id, "program-all")
        # dave is a member of BOTH projects — appears exactly once.
        assert len(result) == len(set(result))
        assert set(result) == self._ids(
            memberships, "alice", "bob", "carol", "dave", "erin", "frank"
        )

    def test_resolution_is_program_wide_regardless_of_origin_project(
        self, proj_a: Project, proj_b: Project, memberships: dict[str, object]
    ) -> None:
        # Same program → same resolution whether the mention was written in A or B.
        assert set(resolve_group_members(proj_a.id, "program-pms")) == set(
            resolve_group_members(proj_b.id, "program-pms")
        )

    def test_standalone_project_raises_invalid_group(self, standalone: Project) -> None:
        # No program to resolve against → unresolvable (caller skips it).
        with pytest.raises(InvalidGroupKeyError):
            resolve_group_members(standalone.id, "program-pms")

    def test_soft_deleted_sibling_project_excluded(
        self, proj_a: Project, proj_b: Project, memberships: dict[str, object]
    ) -> None:
        proj_b.is_deleted = True
        proj_b.save(update_fields=["is_deleted"])
        got = set(resolve_group_members(proj_a.id, "program-all"))
        # Only project A members remain (erin/frank were B-only; dave via A stays).
        assert got == self._ids(memberships, "alice", "bob", "carol", "dave")

    def test_soft_deleted_membership_excluded(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        pm = ProjectMembership.objects.get(project=proj_a, user=memberships["alice"])
        pm.is_deleted = True
        pm.save(update_fields=["is_deleted"])
        assert memberships["alice"].pk not in set(resolve_group_members(proj_a.id, "program-pms"))

    def test_program_all_honors_cardinality_cap(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        with (
            patch("trueppm_api.apps.access.groups.ALL_GROUP_HARD_CAP", 3),
            pytest.raises(GroupTooLargeError),
        ):
            resolve_group_members(proj_a.id, "program-all")

    def test_role_banded_program_groups_are_not_capped(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        # Only @program-all is capped (mirrors @all). @program-pms (2 members)
        # resolves fine even under a tiny cap.
        with patch("trueppm_api.apps.access.groups.ALL_GROUP_HARD_CAP", 1):
            assert len(resolve_group_members(proj_a.id, "program-pms")) == 2


# ---------------------------------------------------------------------------
# Parser + fan-out gate
# ---------------------------------------------------------------------------


class TestProgramGroupParsing:
    def test_program_keys_classify_as_group(self) -> None:
        parsed = parse_mentions("ping @program-pms and @program-all now")
        assert {(m.kind, m.value) for m in parsed} == {
            ("group", "program-pms"),
            ("group", "program-all"),
        }

    def test_unknown_program_key_is_a_user_not_a_group(self) -> None:
        # Only the four reserved keys are auto-groups; anything else is a @user.
        parsed = parse_mentions("hi @program-bogus")
        assert parsed == [type(parsed[0])("user", "program-bogus")]

    def test_program_keys_are_all_reserved(self) -> None:
        assert PROGRAM_GROUP_KEYS <= ALL_AUTO_GROUP_KEYS


@pytest.mark.django_db
class TestProgramAllGate:
    def test_program_all_requires_admin(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        parsed = parse_mentions("@program-all standup")
        # Member-level actor is blocked — program-all lands in skipped_groups.
        result = resolve_parsed_mentions(parsed, proj_a.id, actor_role=Role.MEMBER)
        assert "program-all" in result.skipped_groups
        assert result.group_targets == []

    def test_program_all_allowed_for_admin(
        self, proj_a: Project, memberships: dict[str, object]
    ) -> None:
        parsed = parse_mentions("@program-all standup")
        result = resolve_parsed_mentions(parsed, proj_a.id, actor_role=Role.ADMIN)
        assert "program-all" not in result.skipped_groups
        assert [key for key, _ in result.group_targets] == ["program-all"]

    def test_program_group_skipped_on_standalone_project(self, standalone: Project) -> None:
        parsed = parse_mentions("@program-pms heads up")
        result = resolve_parsed_mentions(parsed, standalone.id, actor_role=Role.OWNER)
        # Unresolvable (no program) → skipped, not raised to the caller.
        assert "program-pms" in result.skipped_groups
