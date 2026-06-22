"""Permission tests for ProjectViewSet update/partial_update (#769).

Editing project-level settings is a Project Manager (Admin) concern. Before the
fix, update/partial_update fell through to ``IsProjectMember``, which passes for
Viewer (role 0) and Member — a read-only role could rename or recolor a project.

The gate is Scheduler+ (closing the Viewer/Member hole); the finer split is
field-level (ProjectSerializer.validate): a Scheduler may change only the
scheduling-governance fields (methodology, estimation_mode) and is rejected with
400 — not 403 — on a general setting such as the name. Admin+ may change anything.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import BoardCadence, Calendar, Methodology, Project

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="PermProj", start_date=date(2026, 3, 1), calendar=calendar)


def _client_for(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_update_project_denied_below_scheduler(project: Project, role: int) -> None:
    """Viewer/Member are blocked at the permission gate (403)."""
    client = _client_for(project, role, f"u_{int(role)}")
    resp = client.patch(f"/api/v1/projects/{project.pk}/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 403
    project.refresh_from_db()
    assert project.name == "PermProj"


@pytest.mark.django_db
def test_scheduler_cannot_change_admin_only_fields(project: Project) -> None:
    """A Scheduler reaches the serializer but is rejected (400) on a PM-only field."""
    client = _client_for(project, Role.SCHEDULER, "u_sched")
    resp = client.patch(f"/api/v1/projects/{project.pk}/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.name == "PermProj"


@pytest.mark.django_db
def test_scheduler_can_change_governance_fields(project: Project) -> None:
    """A Scheduler may change scheduling-governance fields (ADR-0041)."""
    client = _client_for(project, Role.SCHEDULER, "u_sched")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"methodology": Methodology.WATERFALL},
        format="json",
    )
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.methodology == Methodology.WATERFALL


@pytest.mark.django_db
def test_board_cadence_defaults_to_sprint(project: Project) -> None:
    """A new project starts sprint-based — the additive, non-destructive default (#410)."""
    client = _client_for(project, Role.MEMBER, "u_bc_default")
    got = client.get(f"/api/v1/projects/{project.pk}/")
    assert got.data["board_cadence"] == BoardCadence.SPRINT


@pytest.mark.django_db
def test_scheduler_can_change_board_cadence(project: Project) -> None:
    """board_cadence is a board-governance field a Scheduler may write (ADR-0161)."""
    client = _client_for(project, Role.SCHEDULER, "u_bc_sched")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"board_cadence": BoardCadence.CONTINUOUS},
        format="json",
    )
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.board_cadence == BoardCadence.CONTINUOUS


@pytest.mark.django_db
def test_member_cannot_change_board_cadence(project: Project) -> None:
    """A Member is blocked at the permission gate (403) — board_cadence is Scheduler+."""
    client = _client_for(project, Role.MEMBER, "u_bc_member")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"board_cadence": BoardCadence.CONTINUOUS},
        format="json",
    )
    assert resp.status_code == 403
    project.refresh_from_db()
    assert project.board_cadence == BoardCadence.SPRINT


@pytest.mark.django_db
def test_board_cadence_change_is_audited_via_history(project: Project) -> None:
    """The mode change is captured in HistoricalProject with the actor (ADR-0161 audit).

    Satisfies the audit requirement without a new AuditEventType verb: django-simple-history
    records the before/after value, the actor (history_user), and the timestamp.
    """
    client = _client_for(project, Role.SCHEDULER, "u_bc_audit")
    actor = User.objects.get(username="u_bc_audit")
    client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"board_cadence": BoardCadence.CONTINUOUS},
        format="json",
    )
    latest = project.history.first()
    assert latest is not None
    assert latest.board_cadence == BoardCadence.CONTINUOUS
    assert latest.history_type == "~"  # update
    assert latest.history_user_id == actor.pk


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.ADMIN, Role.OWNER])
def test_update_project_allowed_admin_and_owner(project: Project, role: int) -> None:
    client = _client_for(project, role, f"u_{int(role)}")
    resp = client.patch(f"/api/v1/projects/{project.pk}/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.name == "Renamed"


@pytest.mark.django_db
def test_admin_can_set_and_clear_status_date(project: Project) -> None:
    """The data date (ADR-0132) is a PM-level forecasting setting: starts null,
    Admin+ may set it, and it can be cleared back to null."""
    from trueppm_api.apps.access.models import Role as _Role

    client = _client_for(project, _Role.ADMIN, "u_admin_sd")

    # Defaults to null and round-trips on read.
    got = client.get(f"/api/v1/projects/{project.pk}/")
    assert got.data["status_date"] is None

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"status_date": "2026-03-23"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["status_date"] == "2026-03-23"
    project.refresh_from_db()
    assert project.status_date == date(2026, 3, 23)

    cleared = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"status_date": None},
        format="json",
    )
    assert cleared.status_code == 200
    project.refresh_from_db()
    assert project.status_date is None


@pytest.mark.django_db
def test_scheduler_cannot_set_status_date(project: Project) -> None:
    """status_date is a PM-level (Admin+) field, not a scheduling-governance one,
    so a Scheduler is rejected (400) — same as any general project setting."""
    from trueppm_api.apps.access.models import Role as _Role

    client = _client_for(project, _Role.SCHEDULER, "u_sched_sd")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"status_date": "2026-03-23"},
        format="json",
    )
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.status_date is None
