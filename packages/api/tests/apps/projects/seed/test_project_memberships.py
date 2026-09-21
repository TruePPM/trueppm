"""Seeded accounts reach the projects they are named on (#3092).

Project access is scoped by ``ProjectMembership``. A ``ProgramMembership`` reaches
the program rail and *no* project, so before this fix the importer — which granted
only the importing owner a project row — produced packs whose every persona signed
in to an empty project list. ``evaluation-guide.md`` names four of those accounts
in more than twenty steps, so the documented walkthrough dead-ended at "sign in as
atlas-alex" while every gate stayed green.

The tests below fix the two halves separately: that *some* access exists at all
(the blocker), and that a project may declare its own roster so one person can hold
different roles on different projects (what makes project-scoped RBAC demonstrable).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.seed.validation import SeedValidationError, validate_seed

pytestmark = pytest.mark.django_db

User = get_user_model()

_SEEDS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)
BUNDLED = sorted(path.stem for path in _SEEDS_DIR.glob("*.json"))


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="member-owner", email="o@example.com")


def _seed(project_extra: dict[str, Any] | None = None) -> dict[str, Any]:
    project: dict[str, Any] = {
        "slug": "core",
        "name": "Core",
        "methodology": "AGILE",
        "start_date": "A-10",
        "tasks": [{"wbs_path": "1", "name": "Build"}],
    }
    project.update(project_extra or {})
    return {
        "schema_version": "2.0",
        "program": {"slug": "mem-demo", "name": "Membership Demo", "methodology": "AGILE"},
        "accounts": [
            {"slug": "ada", "username": "mem-ada", "role": "VIEWER"},
            {"slug": "bo", "username": "mem-bo", "role": "MEMBER"},
            {"slug": "cy", "username": "mem-cy", "role": "ADMIN"},
        ],
        "projects": [project],
    }


def _roles(project: Project) -> dict[str, int]:
    return {
        m.user.get_username(): m.role
        for m in ProjectMembership.objects.filter(project=project, is_deleted=False).select_related(
            "user"
        )
    }


# --- the fallback: a pack written before `members` existed still grants access ---


def test_accounts_without_declared_members_inherit_the_program_role(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)
    project = Project.objects.get(program=program)

    assert _roles(project) == {
        owner.get_username(): Role.OWNER,
        "mem-ada": Role.VIEWER,
        "mem-bo": Role.MEMBER,
        "mem-cy": Role.ADMIN,
    }


# --- the declared roster: different roles on different projects ---


def test_declared_members_replace_the_program_role(owner: Any) -> None:
    """The whole point of the key: `ada` is a program VIEWER and a project ADMIN."""
    program = import_seed(
        _seed({"members": [{"account": "ada", "role": "ADMIN"}]}),
        owner=owner,
        create_users=True,
    )
    project = Project.objects.get(program=program)

    roles = _roles(project)
    assert roles["mem-ada"] == Role.ADMIN
    # bo and cy are program members but were not named on this project.
    assert "mem-bo" not in roles
    assert "mem-cy" not in roles


def test_a_declared_roster_cannot_demote_the_importing_owner(owner: Any) -> None:
    """A seed must never be able to strip the importer of their own project."""
    seed = _seed({"members": [{"account": "ada", "role": "VIEWER"}]})
    seed["accounts"].append({"slug": "self", "username": owner.get_username(), "role": "VIEWER"})
    seed["projects"][0]["members"].append({"account": "self", "role": "VIEWER"})

    program = import_seed(seed, owner=owner, create_users=True)
    project = Project.objects.get(program=program)

    assert _roles(project)[owner.get_username()] == Role.OWNER


def test_an_empty_member_list_grants_only_the_owner(owner: Any) -> None:
    """`[]` is a declaration ("nobody but the owner"), not an omission."""
    program = import_seed(_seed({"members": []}), owner=owner, create_users=True)
    project = Project.objects.get(program=program)

    assert _roles(project) == {owner.get_username(): Role.OWNER}


def test_a_member_naming_no_account_is_a_validation_error() -> None:
    """Silent otherwise: the importer resolves it to None and skips the grant, so
    a typo reproduces the exact blindness this key exists to fix."""
    seed = _seed({"members": [{"account": "nobody", "role": "MEMBER"}]})

    with pytest.raises(SeedValidationError) as exc:
        validate_seed(seed)

    assert any("members[0].account" in e for e in exc.value.errors)


# --- the bundled packs: the surface an evaluator actually judges us on ---


@pytest.mark.parametrize("stem", BUNDLED)
def test_every_bundled_pack_account_can_see_a_project(stem: str, owner: Any) -> None:
    """The regression guard. Before the fix every one of these was zero, and the
    evaluation guide told readers to sign in as these exact usernames."""
    payload = json.loads((_SEEDS_DIR / f"{stem}.json").read_text(encoding="utf-8"))
    usernames = [a["username"] for a in payload.get("accounts", [])]
    assert usernames, f"{stem} declares no accounts — the fixture changed shape"

    program = import_seed(payload, owner=owner, create_users=True, is_sample=True)
    project_ids = list(Project.objects.filter(program=program).values_list("pk", flat=True))

    for username in usernames:
        user = User.objects.get(username=username)
        visible = ProjectMembership.objects.filter(
            user=user, project_id__in=project_ids, is_deleted=False
        ).count()
        assert visible > 0, (
            f"{stem}: {username} holds no ProjectMembership, so signing in as them shows an "
            "empty project list — project access is scoped by ProjectMembership, never by "
            "ProgramMembership"
        )


# --- re-importing over a revoked member (#3410) --------------------------------


def test_re_import_revives_a_revoked_program_membership(owner: Any) -> None:
    """A seed grant must confer access, not report success and confer nothing.

    ``(program, user)`` uniqueness is unconditional, so a revoked member's row
    still owns the slot. An ``update_or_create`` whose defaults carried only
    ``role`` matched that tombstone and updated the role on a row that stayed
    ``is_deleted=True`` — the grant looked like it worked and granted nothing
    (#3410). The membership models' own viewsets were the loud half of this
    defect; the importer was the silent half.
    """
    from trueppm_api.apps.access.models import ProgramMembership

    program = import_seed(_seed(), owner=owner, create_users=True)
    ada = User.objects.get(username="mem-ada")
    revoked = ProgramMembership.objects.get(program=program, user=ada)
    revoked.soft_delete()

    # target_program adopts the existing shell rather than minting a new one, so
    # the tombstoned row is the one the grant has to reuse.
    import_seed(_seed(), owner=owner, create_users=True, target_program=program)

    revived = ProgramMembership.objects.get(pk=revoked.pk)
    assert revived.is_deleted is False
    assert revived.deleted_version is None
    assert ProgramMembership.objects.filter(program=program, user=ada).count() == 1


# --- the interactive demo's published account (#3925, ADR-1197 D5) -------------


def test_the_demo_account_reaches_the_program_rail_and_every_atlas_project(
    owner: Any,
) -> None:
    """``atlas-visitor`` is the credential the interactive demo publishes.

    Everything a visitor is shown hangs off these rows. A ``ProgramMembership``
    alone reaches the program rail and *no* project, and a project that declares a
    ``members`` roster replaces the program-role fallback for itself — so an account
    added to ``ACCOUNTS`` and left out of the three rosters signs in to an empty
    project list. That is a broken demo, not a failing assertion, which is why this
    asserts the rows rather than the seed file's claim about them.
    """
    from rest_framework.test import APIClient

    from trueppm_api.apps.access.models import ProgramMembership

    payload = json.loads((_SEEDS_DIR / "atlas-platform-launch.json").read_text(encoding="utf-8"))
    program = import_seed(payload, owner=owner, create_users=True, is_sample=True)
    visitor = User.objects.get(username="atlas-visitor")

    program_row = ProgramMembership.objects.get(program=program, user=visitor, is_deleted=False)
    assert program_row.role == Role.MEMBER

    projects = Project.objects.filter(program=program)
    assert projects.count() == 3
    reached = ProjectMembership.objects.filter(user=visitor, project__in=projects, is_deleted=False)
    assert reached.count() == 3
    assert {row.role for row in reached} == {Role.MEMBER}

    client = APIClient()
    client.force_authenticate(user=visitor)
    assert client.get(f"/api/v1/programs/{program.pk}/rollup/").status_code == 200


def test_the_demo_account_holds_no_privileged_role_anywhere(owner: Any) -> None:
    """The published password must never open an ADMIN/OWNER account (ADR-1197 D5).

    The read-only fence is a property of the *deployment*, so it can be turned off
    by a misconfiguration that leaves the seeded data in place. If that happens the
    published credential is whatever role this account holds — which is why Member,
    not Admin, and why this is asserted here rather than left to the chart.
    """
    payload = json.loads((_SEEDS_DIR / "atlas-platform-launch.json").read_text(encoding="utf-8"))
    program = import_seed(payload, owner=owner, create_users=True, is_sample=True)
    visitor = User.objects.get(username="atlas-visitor")

    assert visitor.is_staff is False
    assert visitor.is_superuser is False
    assert not ProjectMembership.objects.filter(
        user=visitor, project__program=program, is_deleted=False, role__gte=Role.ADMIN
    ).exists()
