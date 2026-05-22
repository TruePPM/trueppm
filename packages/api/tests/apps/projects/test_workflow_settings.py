"""Tests for the Workflow settings API: phases (root-task CRUD) and custom fields (#521).

Phases are WBS L1 tasks (``wbs_path ~ '^\\d+$'``); the Workflow page edits the
subset of Task fields that show in the settings (name, color) plus exposes
``task_count``. Reordering uses the pre-existing
``PATCH /projects/<pk>/phases/reorder/`` endpoint (covered separately).

ProjectCustomField is a net-new model — values are not persisted on tasks yet.
This file covers schema CRUD only.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    PROJECT_CUSTOM_FIELD_MAX,
    Calendar,
    Project,
    ProjectCustomField,
    Task,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
    return Project.objects.create(
        name="Workflow Proj", start_date=date(2026, 1, 1), calendar=calendar
    )


@pytest.fixture
def owner_user(db):
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def admin_user(db):
    return User.objects.create_user(username="admin", password="pw")


@pytest.fixture
def scheduler_user(db):
    return User.objects.create_user(username="scheduler", password="pw")


@pytest.fixture
def member_user(db):
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def admin_client(admin_user, project):
    ProjectMembership.objects.create(project=project, user=admin_user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin_user)
    return client


@pytest.fixture
def scheduler_client(scheduler_user, project):
    ProjectMembership.objects.create(project=project, user=scheduler_user, role=Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=scheduler_user)
    return client


@pytest.fixture
def member_client(member_user, project):
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=member_user)
    return client


@pytest.fixture
def anon_client():
    return APIClient()


def _seed_phase(project: Project, name: str, root_index: int, color: str | None = None) -> Task:
    """Create a root WBS task to act as a phase."""
    return Task.objects.create(
        project=project,
        name=name,
        wbs_path=str(root_index),
        priority_rank=root_index * 10,
        color=color,
    )


# ---------------------------------------------------------------------------
# Phases — list / retrieve
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_phases_returns_only_root_tasks(scheduler_client, project):
    """The phases endpoint returns L1 root tasks only, never their children."""
    phase = _seed_phase(project, "Engineering", 1, "#1C6B3A")
    Task.objects.create(project=project, name="Child task", wbs_path="1.1")
    Task.objects.create(project=project, name="Grandchild", wbs_path="1.1.1")

    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/phases/")
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["id"] == str(phase.pk)
    assert resp.data[0]["name"] == "Engineering"
    assert resp.data[0]["color"] == "#1C6B3A"
    # task_count includes the phase itself plus all descendants.
    assert resp.data[0]["task_count"] == 3


@pytest.mark.django_db
def test_list_phases_ordered_by_priority_rank(scheduler_client, project):
    """Phases are returned in priority_rank order (matching board swim-lanes)."""
    _seed_phase(project, "Launch", 3)
    _seed_phase(project, "Engineering", 1)
    _seed_phase(project, "Procurement", 2)
    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/phases/")
    assert resp.status_code == 200
    names = [row["name"] for row in resp.data]
    assert names == ["Engineering", "Procurement", "Launch"]


@pytest.mark.django_db
def test_list_phases_excludes_deleted(scheduler_client, project):
    """Soft-deleted root tasks are excluded from the list."""
    _seed_phase(project, "Alive", 1)
    dead = _seed_phase(project, "Dead", 2)
    dead.soft_delete()
    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/phases/")
    assert {row["name"] for row in resp.data} == {"Alive"}


@pytest.mark.django_db
def test_list_phases_empty_project(scheduler_client, project):
    """An empty project returns an empty list (no defaults injected)."""
    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/phases/")
    assert resp.status_code == 200
    assert resp.data == []


# ---------------------------------------------------------------------------
# Phases — create
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_phase_appends_at_end(admin_client, project):
    """POSTing a phase appends it as the next root WBS path with a 10-step priority rank."""
    _seed_phase(project, "Engineering", 1)
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/phases/",
        data={"name": "Build", "color": "#7C3AED"},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["name"] == "Build"
    assert resp.data["wbs_path"] == "2"
    assert resp.data["priority_rank"] == 20
    assert resp.data["color"] == "#7C3AED"


@pytest.mark.django_db
def test_create_phase_accepts_null_color(admin_client, project):
    """color may be omitted or null — the row stores null and the response reflects it."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/phases/",
        data={"name": "Untinted"},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["color"] is None


@pytest.mark.django_db
@pytest.mark.parametrize("bad_color", ["red", "#FF", "#GGHHII", "FF00AA", "#ff00aa00"])
def test_create_phase_rejects_invalid_color(admin_client, project, bad_color):
    """Color must be a #RRGGBB hex string or null — anything else is a 400."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/phases/",
        data={"name": "Bad", "color": bad_color},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_phase_rejects_empty_name(admin_client, project):
    """Empty name is rejected (whitespace stripped before the check)."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/phases/",
        data={"name": "   "},
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Phases — update
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_phase_renames_and_recolors(admin_client, project):
    """PATCH updates name and color and bumps server_version."""
    phase = _seed_phase(project, "Engineering", 1, "#000000")
    initial_version = Task.objects.get(pk=phase.pk).server_version
    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/phases/{phase.pk}/",
        data={"name": "Engineering & Design", "color": "#1C6B3A"},
        format="json",
    )
    assert resp.status_code == 200
    phase.refresh_from_db()
    assert phase.name == "Engineering & Design"
    assert phase.color == "#1C6B3A"
    assert phase.server_version == initial_version + 1


# ---------------------------------------------------------------------------
# Phases — delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_delete_phase_succeeds_when_empty(admin_client, project):
    """A phase with no descendants is soft-deleted on DELETE."""
    phase = _seed_phase(project, "Empty", 1)
    resp = admin_client.delete(f"/api/v1/projects/{project.pk}/phases/{phase.pk}/")
    assert resp.status_code == 204
    phase.refresh_from_db()
    assert phase.is_deleted is True


@pytest.mark.django_db
def test_delete_phase_refuses_with_descendants(admin_client, project):
    """Deleting a phase with active descendants is refused (400) — PM must clear children first."""
    phase = _seed_phase(project, "Engineering", 1)
    Task.objects.create(project=project, name="Child task", wbs_path="1.1")
    resp = admin_client.delete(f"/api/v1/projects/{project.pk}/phases/{phase.pk}/")
    assert resp.status_code == 400
    assert "descendant" in str(resp.data).lower()
    phase.refresh_from_db()
    assert phase.is_deleted is False


# ---------------------------------------------------------------------------
# Phases — permissions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_phases_anonymous_denied(anon_client, project):
    """An unauthenticated request to list phases is denied."""
    resp = anon_client.get(f"/api/v1/projects/{project.pk}/phases/")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_phases_non_member_denied(project):
    """A non-member of the project cannot list phases — IsProjectMember rejects at the
    view layer (403), not silently with an empty list."""
    outsider = User.objects.create_user(username="outsider", password="pw")
    client = APIClient()
    client.force_authenticate(user=outsider)
    _seed_phase(project, "Phase 1", 1)
    resp = client.get(f"/api/v1/projects/{project.pk}/phases/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_member_can_read_phases(member_client, project):
    """A MEMBER (read role) can list phases."""
    _seed_phase(project, "Phase 1", 1)
    resp = member_client.get(f"/api/v1/projects/{project.pk}/phases/")
    assert resp.status_code == 200
    assert len(resp.data) == 1


@pytest.mark.django_db
def test_member_cannot_create_phase(member_client, project):
    """A MEMBER cannot POST a phase — requires Admin (PM) or higher."""
    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/phases/",
        data={"name": "Sneaky"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_scheduler_cannot_create_phase(scheduler_client, project):
    """A SCHEDULER cannot create a phase — Admin only (matches Baseline create)."""
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/phases/",
        data={"name": "Sneaky"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_create_phase_broadcasts_task_created(
    admin_client, project, django_capture_on_commit_callbacks
):
    """Creating a phase fires task_created so connected clients refresh the swim-lanes."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        admin_client.post(
            f"/api/v1/projects/{project.pk}/phases/",
            data={"name": "Engineering"},
            format="json",
        )
    assert mock_broadcast.called
    events = [call.args[1] for call in mock_broadcast.call_args_list]
    assert "task_created" in events


# ===========================================================================
# Project custom fields
# ===========================================================================


@pytest.mark.django_db
def test_list_custom_fields_empty(scheduler_client, project):
    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/fields/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_create_text_field(scheduler_client, project):
    """A simple text field has no options, persists server_version=1, and lands at order=1."""
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={"name": "Drawing rev", "field_type": "TEXT", "required": False},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["name"] == "Drawing rev"
    assert resp.data["field_type"] == "TEXT"
    assert resp.data["options"] == []
    assert resp.data["server_version"] == 1
    assert resp.data["order"] == 1


@pytest.mark.django_db
def test_create_single_select_requires_options(scheduler_client, project):
    """SINGLE_SELECT without options is a 400."""
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={"name": "Vendor", "field_type": "SINGLE_SELECT", "options": []},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_single_select_with_options(scheduler_client, project):
    """SINGLE_SELECT with a non-empty options list succeeds; option metadata round-trips."""
    options = [
        {"value": "siemens", "label": "Siemens", "color": "#1C6B3A"},
        {"value": "abb", "label": "ABB", "color": None},
    ]
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={"name": "Vendor", "field_type": "SINGLE_SELECT", "options": options},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["options"] == options


@pytest.mark.django_db
def test_create_text_with_options_is_rejected(scheduler_client, project):
    """A TEXT field with options is a 400 — only select types accept options."""
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={
            "name": "Drawing rev",
            "field_type": "TEXT",
            "options": [{"value": "a", "label": "A"}],
        },
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_field_rejects_duplicate_option_values(scheduler_client, project):
    """Duplicate option ``value`` entries are rejected (ambiguous storage)."""
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={
            "name": "Status",
            "field_type": "SINGLE_SELECT",
            "options": [
                {"value": "a", "label": "A"},
                {"value": "a", "label": "Duplicate"},
            ],
        },
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_field_rejects_duplicate_name_case_insensitive(scheduler_client, project):
    """``Vendor`` and ``vendor`` cannot coexist — case-insensitive uniqueness per project."""
    scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={"name": "Vendor", "field_type": "TEXT"},
        format="json",
    )
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={"name": "vendor", "field_type": "TEXT"},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_field_enforces_cap(scheduler_client, project):
    """The PROJECT_CUSTOM_FIELD_MAX cap is enforced on the (max + 1)th create."""
    for i in range(PROJECT_CUSTOM_FIELD_MAX):
        ProjectCustomField.objects.create(
            project=project,
            name=f"Field {i}",
            field_type="TEXT",
            order=i + 1,
            server_version=1,
        )
    resp = scheduler_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={"name": "Overflow", "field_type": "TEXT"},
        format="json",
    )
    assert resp.status_code == 400
    assert "cap" in str(resp.data).lower()


@pytest.mark.django_db
def test_patch_field_bumps_server_version(scheduler_client, project):
    field = ProjectCustomField.objects.create(
        project=project, name="Vendor", field_type="TEXT", order=1, server_version=5
    )
    resp = scheduler_client.patch(
        f"/api/v1/projects/{project.pk}/fields/{field.pk}/",
        data={"required": True},
        format="json",
    )
    assert resp.status_code == 200
    field.refresh_from_db()
    assert field.required is True
    assert field.server_version == 6


@pytest.mark.django_db
def test_patch_field_type_is_rejected(scheduler_client, project):
    """field_type is immutable — switching a TEXT field to SINGLE_SELECT is a 400."""
    field = ProjectCustomField.objects.create(
        project=project, name="Vendor", field_type="TEXT", order=1, server_version=1
    )
    resp = scheduler_client.patch(
        f"/api/v1/projects/{project.pk}/fields/{field.pk}/",
        data={"field_type": "SINGLE_SELECT"},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_patch_field_order_reorders(scheduler_client, project):
    a = ProjectCustomField.objects.create(
        project=project, name="A", field_type="TEXT", order=1, server_version=1
    )
    b = ProjectCustomField.objects.create(
        project=project, name="B", field_type="TEXT", order=2, server_version=1
    )
    scheduler_client.patch(
        f"/api/v1/projects/{project.pk}/fields/{a.pk}/",
        data={"order": 10},
        format="json",
    )
    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/fields/")
    names = [row["name"] for row in resp.data]
    assert names == ["B", "A"]
    assert b.pk  # silence unused


@pytest.mark.django_db
def test_delete_field(scheduler_client, project):
    field = ProjectCustomField.objects.create(
        project=project, name="Drop me", field_type="TEXT", order=1, server_version=1
    )
    resp = scheduler_client.delete(f"/api/v1/projects/{project.pk}/fields/{field.pk}/")
    assert resp.status_code == 204
    assert not ProjectCustomField.objects.filter(pk=field.pk).exists()


@pytest.mark.django_db
def test_member_cannot_write_fields(member_client, project):
    """A MEMBER role cannot create, update, or delete custom fields — Scheduler+ only."""
    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/fields/",
        data={"name": "Sneaky", "field_type": "TEXT"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_member_can_read_fields(member_client, project):
    ProjectCustomField.objects.create(
        project=project, name="Vendor", field_type="TEXT", order=1, server_version=1
    )
    resp = member_client.get(f"/api/v1/projects/{project.pk}/fields/")
    assert resp.status_code == 200
    assert len(resp.data) == 1


@pytest.mark.django_db
def test_field_write_broadcasts(scheduler_client, project, django_capture_on_commit_callbacks):
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        scheduler_client.post(
            f"/api/v1/projects/{project.pk}/fields/",
            data={"name": "Vendor", "field_type": "TEXT"},
            format="json",
        )
    assert mock_broadcast.called
    args = mock_broadcast.call_args.args
    assert args[1] == "project_custom_fields_updated"
    assert args[2]["action"] == "created"


@pytest.mark.django_db
def test_field_cross_project_isolation(scheduler_user, calendar):
    """A field on project A is not visible from project B even to the same user."""
    project_a = Project.objects.create(name="A", start_date=date(2026, 1, 1), calendar=calendar)
    project_b = Project.objects.create(name="B", start_date=date(2026, 1, 1), calendar=calendar)
    ProjectMembership.objects.create(project=project_a, user=scheduler_user, role=Role.SCHEDULER)
    ProjectMembership.objects.create(project=project_b, user=scheduler_user, role=Role.SCHEDULER)
    ProjectCustomField.objects.create(
        project=project_a, name="On A", field_type="TEXT", order=1, server_version=1
    )
    client = APIClient()
    client.force_authenticate(user=scheduler_user)
    resp = client.get(f"/api/v1/projects/{project_b.pk}/fields/")
    assert resp.status_code == 200
    assert resp.data == []
