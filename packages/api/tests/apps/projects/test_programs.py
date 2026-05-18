"""Tests for the Program viewset (ADR-0070, #502).

Covers:
- Creation auto-assigns the creator as OWNER (atomic).
- List filters to programs the user is a member of.
- Permission gates (Member → retrieve, Admin → update, Owner → delete).
- Delete cascade removes all memberships in one transaction.
- The /programs/{id}/projects/ nested endpoint.
- Project.program FK cross-permission gates (ADR-0070 §RBAC).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Methodology, Program, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="other", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _create_program(client: APIClient, name: str = "Phase 2") -> Program:
    resp = client.post(
        "/api/v1/programs/",
        {"name": name, "description": "", "methodology": "HYBRID"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    return Program.objects.get(pk=resp.data["id"])


# ---------------------------------------------------------------------------
# Create — auto-OWNER membership
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_program_auto_assigns_creator_as_owner(owner: object) -> None:
    resp = _client(owner).post(
        "/api/v1/programs/",
        {"name": "Phase 2", "methodology": "HYBRID"},
        format="json",
    )
    assert resp.status_code == 201
    program_id = resp.data["id"]
    membership = ProgramMembership.objects.get(program_id=program_id, user=owner)
    assert membership.role == Role.OWNER
    # Response includes the annotated my_role.
    assert resp.data["my_role"] == Role.OWNER
    assert resp.data["my_role_label"] == "Project Admin"


@pytest.mark.django_db
def test_create_program_requires_authentication(owner: object) -> None:
    resp = APIClient().post("/api/v1/programs/", {"name": "X"}, format="json")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_create_program_default_methodology_is_hybrid(owner: object) -> None:
    resp = _client(owner).post("/api/v1/programs/", {"name": "X"}, format="json")
    assert resp.status_code == 201
    assert resp.data["methodology"] == Methodology.HYBRID


# ---------------------------------------------------------------------------
# List — filtered to user's memberships
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_returns_only_users_programs(owner: object, other_user: object) -> None:
    _create_program(_client(owner), name="Mine")
    _create_program(_client(other_user), name="Theirs")
    resp = _client(owner).get("/api/v1/programs/")
    assert resp.status_code == 200
    names = [p["name"] for p in resp.data["results"]]
    assert names == ["Mine"]


@pytest.mark.django_db
def test_list_annotates_project_count(owner: object, calendar: Calendar) -> None:
    program = _create_program(_client(owner))
    Project.objects.create(
        name="A",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    Project.objects.create(
        name="B",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    resp = _client(owner).get("/api/v1/programs/")
    assert resp.data["results"][0]["project_count"] == 2


# ---------------------------------------------------------------------------
# Retrieve — membership gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_retrieve_blocks_non_member(owner: object, stranger: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(stranger).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_retrieve_returns_my_role(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200
    assert resp.data["my_role"] == Role.OWNER


# ---------------------------------------------------------------------------
# Update — ADMIN+ gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_requires_admin(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    # Add other_user as MEMBER (insufficient for update).
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/programs/{program.pk}/", {"name": "Renamed"}, format="json"
    )
    assert resp.status_code == 403

    # Owner can patch.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/", {"name": "Renamed"}, format="json"
    )
    assert resp.status_code == 200
    program.refresh_from_db()
    assert program.name == "Renamed"


# ---------------------------------------------------------------------------
# Delete — OWNER + cascade
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_delete_requires_owner(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.ADMIN)
    resp = _client(other_user).delete(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_delete_cascades_memberships_and_soft_deletes_program(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    project = Project.objects.create(
        name="Survivor",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )

    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 204

    # Program soft-deleted.
    program.refresh_from_db()
    assert program.is_deleted is True

    # All memberships soft-deleted in the same transaction (PROTECT honored).
    assert ProgramMembership.objects.filter(program=program, is_deleted=False).count() == 0

    # Project survives with program=NULL (SET_NULL).
    project.refresh_from_db()
    assert project.program_id is None
    assert project.is_deleted is False


# ---------------------------------------------------------------------------
# /programs/{id}/projects/ nested list endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_projects_endpoint_lists_program_projects(
    owner: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    Project.objects.create(
        name="A",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    Project.objects.create(
        name="Standalone",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")
    assert resp.status_code == 200
    names = [p["name"] for p in resp.data]
    assert names == ["A"]


# ---------------------------------------------------------------------------
# Project.program FK cross-permission (ADR-0070 §RBAC)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_assign_project_to_program_requires_admin_on_both(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="P",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )
    # other_user is OWNER on the project but NOT a member of the program.
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.OWNER)
    resp = _client(other_user).patch(
        f"/api/v1/projects/{project.pk}/",
        {"program": str(program.pk)},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    # Error message names the program (helpful for the UI's toast surface).
    assert "Project Manager" in str(resp.content) or "permission" in str(resp.content)


@pytest.mark.django_db
def test_assign_project_to_program_succeeds_with_admin_on_both(
    owner: object,
    calendar: Calendar,
) -> None:
    # owner is OWNER on program (via create) AND will be added as OWNER on project.
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="P",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    resp = _client(owner).patch(
        f"/api/v1/projects/{project.pk}/",
        {"program": str(program.pk)},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    project.refresh_from_db()
    assert project.program_id == program.pk


@pytest.mark.django_db
def test_unassign_project_requires_admin_on_source_program(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="P",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    # other_user is OWNER on project but only a MEMBER on the source program.
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/projects/{project.pk}/",
        {"program": None},
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Create-with-program — POST /projects/ with ``program`` set up-front (ADR-0070).
#
# The web "New project" button inside a Program shell sends ``program`` in the
# create payload (no second PATCH). Cross-permission rules for create:
#  - instance does not yet exist → no project-side ADMIN check applies
#  - old_program is None → no source-program check
#  - new_program is set → caller must hold ADMIN on the target program
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_project_with_program_succeeds_when_admin_on_program(
    owner: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).post(
        "/api/v1/projects/",
        {
            "name": "Tower A Buildout",
            "start_date": "2026-05-18",
            "calendar": str(calendar.pk),
            "methodology": "HYBRID",
            "program": str(program.pk),
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["program"] == program.pk
    project = Project.objects.get(pk=resp.data["id"])
    assert project.program_id == program.pk
    # The creator is auto-assigned OWNER on the new project (perform_create).
    assert ProjectMembership.objects.filter(project=project, user=owner, role=Role.OWNER).exists()


@pytest.mark.django_db
def test_create_project_with_program_rejected_when_not_admin_on_program(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    # other_user is only a MEMBER on the program — not ADMIN.
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).post(
        "/api/v1/projects/",
        {
            "name": "Sneaky Project",
            "start_date": "2026-05-18",
            "calendar": str(calendar.pk),
            "program": str(program.pk),
        },
        format="json",
    )
    assert resp.status_code == 400, resp.content
    # No project row was created — the validate_program guard fires before save().
    assert not Project.objects.filter(name="Sneaky Project").exists()


@pytest.mark.django_db
def test_create_standalone_project_omits_program(
    owner: object,
    calendar: Calendar,
) -> None:
    # No ``program`` key in the payload — the project is created standalone.
    resp = _client(owner).post(
        "/api/v1/projects/",
        {
            "name": "Standalone",
            "start_date": "2026-05-18",
            "calendar": str(calendar.pk),
            "methodology": "HYBRID",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    project = Project.objects.get(pk=resp.data["id"])
    assert project.program_id is None
