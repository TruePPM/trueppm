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
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Health,
    Methodology,
    Program,
    Project,
    Task,
    TaskStatus,
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
# Accent color (#698) — serializer validation + round-trip
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_program_color_defaults_to_null(owner: object) -> None:
    program = _create_program(_client(owner))
    assert program.color is None


@pytest.mark.django_db
def test_update_accepts_valid_hex_color(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/", {"color": "#1C6B3A"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["color"] == "#1C6B3A"
    program.refresh_from_db()
    assert program.color == "#1C6B3A"


@pytest.mark.django_db
@pytest.mark.parametrize("bad", ["red", "1C6B3A", "#FFF", "#12345", "#1234567", "#12345G"])
def test_update_rejects_malformed_color(owner: object, bad: str) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(f"/api/v1/programs/{program.pk}/", {"color": bad}, format="json")
    assert resp.status_code == 400, resp.content
    assert "color" in resp.data


@pytest.mark.django_db
def test_update_accepts_null_color(owner: object) -> None:
    program = _create_program(_client(owner))
    program.color = "#DC2626"
    program.save(update_fields=["color"])
    resp = _client(owner).patch(f"/api/v1/programs/{program.pk}/", {"color": None}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["color"] is None
    program.refresh_from_db()
    assert program.color is None


@pytest.mark.django_db
def test_update_empty_color_normalizes_to_null(owner: object) -> None:
    """Empty string collapses to null so "unset" semantics hold (#698)."""
    program = _create_program(_client(owner))
    program.color = "#0EA5E9"
    program.save(update_fields=["color"])
    resp = _client(owner).patch(f"/api/v1/programs/{program.pk}/", {"color": ""}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["color"] is None


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


# ---------------------------------------------------------------------------
# General settings fields — code / health / visibility / lead (#523)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_retrieve_includes_new_general_fields_with_safe_defaults(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200
    # New fields are present and carry the migration defaults so an
    # un-migrated UI can still bind to them without checking for undefined.
    assert resp.data["code"] == ""
    assert resp.data["health"] == "AUTO"
    assert resp.data["visibility"] == "WORKSPACE"
    assert resp.data["lead"] is None
    assert resp.data["lead_detail"] is None


@pytest.mark.django_db
def test_patch_persists_general_settings_fields(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {
            "code": "PH2",
            "health": "AT_RISK",
            "visibility": "PRIVATE",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    assert program.code == "PH2"
    assert program.health == "AT_RISK"
    assert program.visibility == "PRIVATE"


@pytest.mark.django_db
def test_patch_lead_returns_lead_detail_nested(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    # Add other_user as a member so they're an eligible lead.  Lead is a UI
    # affordance and not membership-gated at the serializer level, but in
    # production callers will pick from existing members.
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"lead": str(other_user.pk)},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    assert program.lead_id == other_user.pk
    # Nested lead_detail mirrors the user_detail pattern from membership rows.
    assert resp.data["lead_detail"] is not None
    assert resp.data["lead_detail"]["id"] == other_user.pk
    assert resp.data["lead_detail"]["username"] == "other"


@pytest.mark.django_db
def test_patch_lead_rejects_non_member(owner: object, stranger: object) -> None:
    program = _create_program(_client(owner))
    # ``stranger`` has no ProgramMembership on this program, so the lead
    # validation must reject the assignment.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"lead": str(stranger.pk)},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    assert "lead" in resp.data
    program.refresh_from_db()
    assert program.lead_id is None


@pytest.mark.django_db
def test_patch_lead_to_null_is_always_allowed(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    program.lead = other_user
    program.save(update_fields=["lead"])
    # Unsetting the lead should succeed regardless of membership state.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"lead": None},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    assert program.lead_id is None


@pytest.mark.django_db
def test_patch_health_rejects_invalid_choice(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"health": "PURPLE"},
        format="json",
    )
    assert resp.status_code == 400
    assert "health" in resp.data


@pytest.mark.django_db
def test_patch_visibility_rejects_invalid_choice(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"visibility": "EVERYWHERE"},
        format="json",
    )
    assert resp.status_code == 400
    assert "visibility" in resp.data


@pytest.mark.django_db
def test_patch_code_rejects_overlong_value(owner: object) -> None:
    program = _create_program(_client(owner))
    # Field is CharField(max_length=40) — anything longer must 400.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"code": "X" * 41},
        format="json",
    )
    assert resp.status_code == 400
    assert "code" in resp.data


@pytest.mark.django_db
def test_general_field_patch_requires_admin(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/programs/{program.pk}/",
        {"health": "CRITICAL"},
        format="json",
    )
    assert resp.status_code == 403
    program.refresh_from_db()
    assert program.health == "AUTO"


# ---------------------------------------------------------------------------
# Ungrouped projects filter — GET /projects/?program__isnull=true (ADR-0083, #697)
# ---------------------------------------------------------------------------


def _make_project(owner_user: object, calendar: Calendar, **kwargs: object) -> Project:
    """Create a project the owner_user can see (active OWNER membership)."""
    defaults: dict[str, object] = {"name": "P", "start_date": date(2026, 4, 1)}
    defaults.update(kwargs)
    project = Project.objects.create(calendar=calendar, **defaults)
    ProjectMembership.objects.create(project=project, user=owner_user, role=Role.OWNER)
    return project


@pytest.mark.django_db
def test_ungrouped_filter_returns_only_standalone_projects(
    owner: object, calendar: Calendar
) -> None:
    program = _create_program(_client(owner))
    standalone = _make_project(owner, calendar, name="Standalone")
    _make_project(owner, calendar, name="Grouped", program=program)

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    ids = {row["id"] for row in resp.data["results"]}
    assert ids == {str(standalone.pk)}


@pytest.mark.django_db
def test_ungrouped_filter_is_rbac_scoped(
    owner: object, stranger: object, calendar: Calendar
) -> None:
    # The stranger has a standalone project; the owner has none of their own.
    _make_project(stranger, calendar, name="Stranger's standalone")

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_ungrouped_filter_annotates_member_count_and_percent_complete(
    owner: object, other_user: object, calendar: Calendar
) -> None:
    project = _make_project(owner, calendar, name="Has members and tasks")
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.MEMBER)
    # Deliberately unequal member (2) and task (3) counts: the two aggregates
    # share one .annotate() and fan out (2 × 3 = 6 joined rows). member_count
    # must stay 2 — if distinct=True were dropped it would inflate to 6.
    Task.objects.create(project=project, name="A", percent_complete=100.0)
    Task.objects.create(project=project, name="B", percent_complete=50.0)
    Task.objects.create(project=project, name="C", percent_complete=0.0)

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["member_count"] == 2  # owner + other_user, not 6 (fan-out)
    assert row["percent_complete"] == 50.0  # mean of 100, 50, 0


@pytest.mark.django_db
def test_ungrouped_filter_excludes_archived_projects(owner: object, calendar: Calendar) -> None:
    _make_project(owner, calendar, name="Archived", is_archived=True)

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_default_project_list_does_not_annotate_aggregates(
    owner: object, calendar: Calendar
) -> None:
    # The hot /projects/ list stays lightweight — the aggregates are null unless
    # the ungrouped branch is requested (ADR-0083).
    project = _make_project(owner, calendar, name="Plain")
    Task.objects.create(project=project, name="A", percent_complete=100.0)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["member_count"] is None
    assert row["percent_complete"] is None


# ---------------------------------------------------------------------------
# Per-project open-task count — GET /projects/ list annotation (#960)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_list_annotates_open_task_count(owner: object, calendar: Calendar) -> None:
    # open_task_count = non-deleted, not-yet-COMPLETE tasks. The COMPLETE and
    # soft-deleted tasks must NOT be counted; the two open tasks must be.
    project = _make_project(owner, calendar, name="Counts")
    Task.objects.create(project=project, name="Open 1", status=TaskStatus.NOT_STARTED)
    Task.objects.create(project=project, name="Open 2", status=TaskStatus.IN_PROGRESS)
    Task.objects.create(project=project, name="Done", status=TaskStatus.COMPLETE)
    Task.objects.create(project=project, name="Deleted", is_deleted=True)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["open_task_count"] == 2


@pytest.mark.django_db
def test_project_list_open_task_count_zero_when_no_open_tasks(
    owner: object, calendar: Calendar
) -> None:
    project = _make_project(owner, calendar, name="All done")
    Task.objects.create(project=project, name="Done", status=TaskStatus.COMPLETE)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["open_task_count"] == 0


@pytest.mark.django_db
def test_project_list_open_task_count_has_no_n_plus_one(owner: object, calendar: Calendar) -> None:
    """The open_task_count Subquery annotation must not add a query per project —
    listing 1 vs N projects costs the same number of queries (#960, perf-check)."""

    def seed(name: str, n_projects: int) -> None:
        for i in range(n_projects):
            p = _make_project(owner, calendar, name=f"{name}-{i}")
            Task.objects.create(project=p, name="t", status=TaskStatus.IN_PROGRESS)

    seed("one", 1)

    def list_query_count() -> int:
        with CaptureQueriesContext(connection) as ctx:
            r = _client(owner).get("/api/v1/projects/")
            assert r.status_code == 200, r.content
        return len(ctx.captured_queries)

    # Prime per-process caches (content types, permission lookups) so the
    # baseline reflects steady-state query count, not first-request overhead.
    list_query_count()
    baseline = list_query_count()
    seed("many", 5)
    assert list_query_count() == baseline


@pytest.mark.django_db
def test_serializer_exposes_real_health(owner: object, calendar: Calendar) -> None:
    # The list row carries the project's health enum so the sidebar dot can color
    # from server data rather than hardcoding 'unknown'.
    project = _make_project(owner, calendar, name="At risk", health=Health.AT_RISK)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["health"] == Health.AT_RISK


# ---------------------------------------------------------------------------
# #560 — Program.target_date + per-project overdue / at-risk rollup
# ---------------------------------------------------------------------------


def _task(
    project: Project,
    name: str,
    *,
    status: str = TaskStatus.IN_PROGRESS,
    total_float: int | None = None,
    early_finish: date | None = None,
    is_deleted: bool = False,
) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        wbs_path=name,
        duration=1,
        status=status,
        total_float=total_float,
        early_finish=early_finish,
        is_deleted=is_deleted,
    )


@pytest.mark.django_db
def test_program_target_date_defaults_to_null(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200
    assert resp.data["target_date"] is None


@pytest.mark.django_db
def test_program_admin_can_set_and_clear_target_date(owner: object) -> None:
    program = _create_program(_client(owner))  # creator is OWNER (>= ADMIN)
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"target_date": "2026-12-31"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["target_date"] == "2026-12-31"
    program.refresh_from_db()
    assert program.target_date == date(2026, 12, 31)

    # Clearing back to null is honored (open-ended program).
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"target_date": None},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["target_date"] is None


@pytest.mark.django_db
def test_program_member_cannot_set_target_date(owner: object, other_user: object) -> None:
    # A plain Member is below the IsProgramAdmin gate on update — write blocked.
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/programs/{program.pk}/",
        {"target_date": "2026-12-31"},
        format="json",
    )
    assert resp.status_code == 403
    program.refresh_from_db()
    assert program.target_date is None


@pytest.mark.django_db
def test_projects_endpoint_annotates_overdue_and_at_risk_counts(
    owner: object, calendar: Calendar
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="A", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    past = date(2020, 1, 1)
    future = date(2099, 1, 1)
    # overdue only (past finish, ample float)
    _task(project, "overdue", total_float=20, early_finish=past)
    # at-risk only (tight float, future finish)
    _task(project, "atrisk", total_float=2, early_finish=future)
    # both overdue AND at-risk (already late = negative float)
    _task(project, "both", total_float=-1, early_finish=past)
    # excluded: COMPLETE despite past finish
    _task(project, "done", status=TaskStatus.COMPLETE, total_float=-5, early_finish=past)
    # excluded: soft-deleted despite past finish + tight float
    _task(project, "gone", total_float=0, early_finish=past, is_deleted=True)
    # neither (healthy)
    _task(project, "healthy", total_float=30, early_finish=future)

    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")
    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data if r["id"] == str(project.pk))
    assert row["overdue_count"] == 2  # overdue + both
    assert row["at_risk_count"] == 2  # atrisk + both


@pytest.mark.django_db
def test_projects_endpoint_counts_zero_with_no_qualifying_tasks(
    owner: object, calendar: Calendar
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="Empty", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    _task(project, "healthy", total_float=30, early_finish=date(2099, 1, 1))

    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")
    row = next(r for r in resp.data if r["id"] == str(project.pk))
    assert row["overdue_count"] == 0
    assert row["at_risk_count"] == 0


@pytest.mark.django_db
def test_projects_endpoint_count_annotations_are_not_n_plus_one(
    owner: object, calendar: Calendar
) -> None:
    # The two conditional COUNTs must ride the single list query, not a per-row
    # follow-up — adding more projects must not add queries.
    program = _create_program(_client(owner))
    for i in range(4):
        p = Project.objects.create(
            name=f"P{i}",
            start_date=date(2026, 4, 1),
            calendar=calendar,
            program=program,
        )
        _task(p, f"od{i}", total_float=1, early_finish=date(2020, 1, 1))

    client = _client(owner)
    with CaptureQueriesContext(connection) as ctx:
        resp = client.get(f"/api/v1/programs/{program.pk}/projects/")
    assert resp.status_code == 200
    assert len(resp.data) == 4
    # Bounded: the list query + permission/object lookups, constant regardless of
    # project count. Generous ceiling guards against a regression to per-row counts.
    assert len(ctx.captured_queries) <= 12, len(ctx.captured_queries)
