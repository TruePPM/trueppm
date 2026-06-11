"""Tests for the Project and Program lifecycle endpoints (#530).

Covers:
- POST /projects/:id/archive/ + /unarchive/  (Owner only, idempotent)
- POST /projects/:id/transfer/               (Owner only, target must be member)
- DELETE /projects/:id/?force=true           (hard delete; requires archived)
- POST /programs/:id/close/ + /reopen/       (Owner only, idempotent)
- POST /programs/:id/transfer-sponsorship/   (Owner only, target must be member)
- POST /programs/:id/split/                  (501 stub; payload validated)
- IsProjectNotArchived / IsProgramNotClosed write gates
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Program,
    Project,
    Risk,
    Sprint,
    SprintState,
    Task,
)

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


@pytest.fixture
def project(owner: object, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Apollo",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def program(owner: object) -> Program:
    p = Program.objects.create(name="Phase 2")
    ProgramMembership.objects.create(program=p, user=owner, role=Role.OWNER)
    return p


# ---------------------------------------------------------------------------
# Project archive / unarchive
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_archive_project_marks_archived(owner: object, project: Project) -> None:
    resp = _client(owner).post(f"/api/v1/projects/{project.pk}/archive/")
    assert resp.status_code == 200, resp.content
    assert resp.data["is_archived"] is True
    assert resp.data["archived_at"] is not None
    assert resp.data["archived_by"] == owner.pk

    project.refresh_from_db()
    assert project.is_archived is True


@pytest.mark.django_db
def test_archive_project_is_idempotent(owner: object, project: Project) -> None:
    client = _client(owner)
    first = client.post(f"/api/v1/projects/{project.pk}/archive/")
    assert first.status_code == 200
    first_archived_at = first.data["archived_at"]

    second = client.post(f"/api/v1/projects/{project.pk}/archive/")
    assert second.status_code == 200
    # Second call preserves the original timestamp (no-op).
    assert second.data["archived_at"] == first_archived_at


@pytest.mark.django_db
def test_archive_project_requires_owner(
    owner: object, other_user: object, project: Project
) -> None:
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.ADMIN)
    resp = _client(other_user).post(f"/api/v1/projects/{project.pk}/archive/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_unarchive_project_restores_writes(owner: object, project: Project) -> None:
    client = _client(owner)
    client.post(f"/api/v1/projects/{project.pk}/archive/")
    resp = client.post(f"/api/v1/projects/{project.pk}/unarchive/")
    assert resp.status_code == 200
    assert resp.data["is_archived"] is False
    assert resp.data["archived_at"] is None
    assert resp.data["archived_by"] is None


# ---------------------------------------------------------------------------
# Project transfer ownership
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_transfer_promotes_existing_member_to_owner(
    owner: object, other_user: object, project: Project
) -> None:
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.MEMBER)
    resp = _client(owner).post(
        f"/api/v1/projects/{project.pk}/transfer/",
        {"new_owner_user_id": str(other_user.pk)},
        format="json",
    )
    assert resp.status_code == 200, resp.content

    new_owner_row = ProjectMembership.objects.get(project=project, user=other_user)
    assert new_owner_row.role == Role.OWNER

    old_owner_row = ProjectMembership.objects.get(project=project, user=owner)
    assert old_owner_row.role == Role.ADMIN


@pytest.mark.django_db
def test_transfer_rejects_non_member_target(
    owner: object, stranger: object, project: Project
) -> None:
    resp = _client(owner).post(
        f"/api/v1/projects/{project.pk}/transfer/",
        {"new_owner_user_id": str(stranger.pk)},
        format="json",
    )
    assert resp.status_code == 400
    assert "member" in resp.data["detail"].lower()


@pytest.mark.django_db
def test_transfer_requires_owner(owner: object, other_user: object, project: Project) -> None:
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.ADMIN)
    resp = _client(other_user).post(
        f"/api/v1/projects/{project.pk}/transfer/",
        {"new_owner_user_id": str(owner.pk)},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_transfer_requires_new_owner_payload(owner: object, project: Project) -> None:
    resp = _client(owner).post(f"/api/v1/projects/{project.pk}/transfer/", {}, format="json")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Project delete — soft default + ?force=true
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_destroy_project_soft_deletes_by_default(owner: object, project: Project) -> None:
    resp = _client(owner).delete(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 204
    project.refresh_from_db()
    assert project.is_deleted is True


@pytest.mark.django_db
def test_force_delete_requires_archived_first(owner: object, project: Project) -> None:
    resp = _client(owner).delete(f"/api/v1/projects/{project.pk}/?force=true")
    assert resp.status_code == 400
    assert "archive" in str(resp.data).lower()
    # Row still exists.
    assert Project.objects.filter(pk=project.pk).exists()


@pytest.mark.django_db
def test_force_delete_archived_project_hard_deletes(owner: object, project: Project) -> None:
    client = _client(owner)
    client.post(f"/api/v1/projects/{project.pk}/archive/")
    resp = client.delete(f"/api/v1/projects/{project.pk}/?force=true")
    assert resp.status_code == 204
    assert not Project.objects.filter(pk=project.pk).exists()


# ---------------------------------------------------------------------------
# Project soft-delete cascade + zombie-URL guard (#1111)
# ---------------------------------------------------------------------------


@pytest.fixture
def populated_project(owner: object, calendar: Calendar) -> Project:
    """A project with one of each board-scoped child, for cascade assertions."""
    p = Project.objects.create(name="Cascade", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    t1 = Task.objects.create(project=p, name="T1", duration=1)
    t2 = Task.objects.create(project=p, name="T2", duration=1)
    Dependency.objects.create(predecessor=t1, successor=t2, dep_type="FS")
    Task.objects.create(project=p, name="Sub", duration=1, is_subtask=True)
    Sprint.objects.create(
        project=p,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )
    Risk.objects.create(project=p, title="R1", probability=3, impact=4, created_by=owner)
    return p


@pytest.mark.django_db
def test_soft_delete_cascades_to_all_children(owner: object, populated_project: Project) -> None:
    """A soft-deleted project leaves no live child row — no orphans (#1111)."""
    resp = _client(owner).delete(f"/api/v1/projects/{populated_project.pk}/")
    assert resp.status_code == 204

    populated_project.refresh_from_db()
    assert populated_project.is_deleted is True
    assert not Task.objects.filter(project=populated_project, is_deleted=False).exists()
    assert not Sprint.objects.filter(project=populated_project, is_deleted=False).exists()
    assert not Risk.objects.filter(project=populated_project, is_deleted=False).exists()
    # Dependency edges between the project's tasks are tombstoned via Task.soft_delete.
    assert not Dependency.objects.filter(
        predecessor__project=populated_project, is_deleted=False
    ).exists()


@pytest.mark.django_db
def test_soft_delete_tombstones_subtask_via_sweep(
    owner: object, populated_project: Project
) -> None:
    """The is_subtask row is skipped by the non-subtask loop and caught by the sweep."""
    _client(owner).delete(f"/api/v1/projects/{populated_project.pk}/")
    assert not Task.objects.filter(
        project=populated_project, is_subtask=True, is_deleted=False
    ).exists()


@pytest.mark.django_db
def test_deleted_project_overview_and_attention_404(
    owner: object, populated_project: Project
) -> None:
    """The deleted-project URL stops resolving — no empty 'zombie' overview shell."""
    client = _client(owner)
    assert client.get(f"/api/v1/projects/{populated_project.pk}/overview/").status_code == 200
    client.delete(f"/api/v1/projects/{populated_project.pk}/")
    assert client.get(f"/api/v1/projects/{populated_project.pk}/overview/").status_code == 404
    assert client.get(f"/api/v1/projects/{populated_project.pk}/attention/").status_code == 404


@pytest.mark.django_db
def test_deleted_project_excluded_from_retrieve_and_list(owner: object, project: Project) -> None:
    """A soft-deleted project 404s on retrieve and drops out of the list."""
    client = _client(owner)
    client.delete(f"/api/v1/projects/{project.pk}/")
    assert client.get(f"/api/v1/projects/{project.pk}/").status_code == 404
    listing = client.get("/api/v1/projects/")
    assert listing.status_code == 200
    rows = listing.data["results"] if isinstance(listing.data, dict) else listing.data
    assert str(project.pk) not in [row["id"] for row in rows]


# ---------------------------------------------------------------------------
# Program close / reopen
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_close_program_marks_closed(owner: object, program: Program) -> None:
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/close/")
    assert resp.status_code == 200, resp.content
    assert resp.data["is_closed"] is True
    assert resp.data["closed_at"] is not None
    assert resp.data["closed_by"] == owner.pk


@pytest.mark.django_db
def test_close_program_requires_owner(owner: object, other_user: object, program: Program) -> None:
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.ADMIN)
    resp = _client(other_user).post(f"/api/v1/programs/{program.pk}/close/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_reopen_program_clears_close_state(owner: object, program: Program) -> None:
    client = _client(owner)
    client.post(f"/api/v1/programs/{program.pk}/close/")
    resp = client.post(f"/api/v1/programs/{program.pk}/reopen/")
    assert resp.status_code == 200
    assert resp.data["is_closed"] is False
    assert resp.data["closed_at"] is None
    assert resp.data["closed_by"] is None


@pytest.mark.django_db
def test_close_program_does_not_cascade_to_projects(
    owner: object, program: Program, calendar: Calendar
) -> None:
    project = Project.objects.create(
        name="Child", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    _client(owner).post(f"/api/v1/programs/{program.pk}/close/")
    project.refresh_from_db()
    # Child project is NOT archived by program close (architect §2).
    assert project.is_archived is False


# ---------------------------------------------------------------------------
# Program transfer sponsorship
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_transfer_sponsorship_promotes_member(
    owner: object, other_user: object, program: Program
) -> None:
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/transfer-sponsorship/",
        {"new_owner_user_id": str(other_user.pk)},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert ProgramMembership.objects.get(program=program, user=other_user).role == Role.OWNER
    assert ProgramMembership.objects.get(program=program, user=owner).role == Role.ADMIN


@pytest.mark.django_db
def test_transfer_sponsorship_with_lead_updates_program_lead(
    owner: object, other_user: object, program: Program
) -> None:
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/transfer-sponsorship/",
        {
            "new_owner_user_id": str(other_user.pk),
            "new_lead_user_id": str(other_user.pk),
        },
        format="json",
    )
    assert resp.status_code == 200
    program.refresh_from_db()
    assert program.lead_id == other_user.pk


@pytest.mark.django_db
def test_transfer_sponsorship_rejects_non_member(
    owner: object, stranger: object, program: Program
) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/transfer-sponsorship/",
        {"new_owner_user_id": str(stranger.pk)},
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Program split — stub (501)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_split_program_returns_501_with_valid_payload(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "A", "project_ids": []}]},
        format="json",
    )
    assert resp.status_code == 501
    assert resp.data["tracking_issue"] == 530


@pytest.mark.django_db
def test_split_program_rejects_empty_payload(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/", {"splits": []}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_split_program_requires_owner(owner: object, other_user: object, program: Program) -> None:
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.ADMIN)
    resp = _client(other_user).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "A", "project_ids": []}]},
        format="json",
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Archive enforcement — IsProjectNotArchived gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_archived_project_rejects_metadata_update(owner: object, project: Project) -> None:
    """An archived project's own PATCH must be rejected (the archive flag itself
    can only flip via the dedicated archive/unarchive actions)."""
    client = _client(owner)
    client.post(f"/api/v1/projects/{project.pk}/archive/")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"name": "Renamed"},
        format="json",
    )
    assert resp.status_code == 403
    project.refresh_from_db()
    assert project.name == "Apollo"


@pytest.mark.django_db
def test_archived_project_rejects_task_create(owner: object, project: Project) -> None:
    client = _client(owner)
    client.post(f"/api/v1/projects/{project.pk}/archive/")
    resp = client.post(
        "/api/v1/tasks/",
        {"project": str(project.pk), "name": "New work", "duration": 1},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_archived_project_allows_reads(owner: object, project: Project) -> None:
    """Reads are unrestricted — the archive freeze only applies to writes."""
    client = _client(owner)
    client.post(f"/api/v1/projects/{project.pk}/archive/")
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_archived_project_allows_unarchive(owner: object, project: Project) -> None:
    """The unarchive action is the only write that must succeed on an archived
    project — otherwise an Owner could never restore writes (catch-22)."""
    client = _client(owner)
    client.post(f"/api/v1/projects/{project.pk}/archive/")
    resp = client.post(f"/api/v1/projects/{project.pk}/unarchive/")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Closed-program enforcement — IsProgramNotClosed gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_closed_program_rejects_metadata_update(owner: object, program: Program) -> None:
    client = _client(owner)
    client.post(f"/api/v1/programs/{program.pk}/close/")
    resp = client.patch(
        f"/api/v1/programs/{program.pk}/",
        {"name": "Renamed"},
        format="json",
    )
    assert resp.status_code == 403
    program.refresh_from_db()
    assert program.name == "Phase 2"


@pytest.mark.django_db
def test_closed_program_rejects_ceremony_create(owner: object, program: Program) -> None:
    client = _client(owner)
    client.post(f"/api/v1/programs/{program.pk}/close/")
    resp = client.post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        {"name": "Sync", "cadence_type": "weekly", "cadence_day": "monday"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_closed_program_allows_reopen(owner: object, program: Program) -> None:
    client = _client(owner)
    client.post(f"/api/v1/programs/{program.pk}/close/")
    resp = client.post(f"/api/v1/programs/{program.pk}/reopen/")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Transfer service — defense-in-depth actor verification
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_transfer_project_ownership_rejects_non_owner_actor(
    owner: object, other_user: object, stranger: object, project: Project
) -> None:
    """The service must verify the actor is currently an OWNER, even though the
    view layer already gates with IsProjectOwner — a misconfigured caller (mgmt
    command, signal handler) must not be able to silently bypass."""
    from django.core.exceptions import ValidationError as DjangoValidationError

    from trueppm_api.apps.access.services import transfer_project_ownership

    ProjectMembership.objects.create(project=project, user=other_user, role=Role.MEMBER)
    # stranger is not even a member, let alone an OWNER.
    with pytest.raises(DjangoValidationError):
        transfer_project_ownership(project=project, new_owner=other_user, actor=stranger)

    # other_user holds MEMBER, not OWNER.
    with pytest.raises(DjangoValidationError):
        transfer_project_ownership(project=project, new_owner=stranger, actor=other_user)
