"""Tests for the Project and Program lifecycle endpoints (#530).

Covers:
- POST /projects/:id/archive/ + /unarchive/  (Owner only, idempotent)
- POST /projects/:id/transfer/               (Owner only, target must be member)
- DELETE /projects/:id/?force=true           (hard delete; requires archived)
- POST /programs/:id/close/ + /reopen/       (Owner only, idempotent)
- POST /programs/:id/transfer-sponsorship/   (Owner only, target must be member)
- POST /programs/:id/split/                  (Owner only; creates sub-programs, ADR-0156)
- IsProjectNotArchived / IsProgramNotClosed write gates
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    Calendar,
    Dependency,
    Program,
    Project,
    Risk,
    Sprint,
    SprintState,
    Task,
    cascade_project_children_soft_delete,
)
from trueppm_api.apps.projects.tasks import cascade_project_soft_delete

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


@pytest.fixture
def _mock_redis_lock() -> Iterator[object]:
    """Bypass the Redis SET NX lock so idempotent_task wrappers run inline.

    Mirrors the fixture in test_sprint_close_drain.py — the cascade task is
    wrapped by ``@idempotent_task`` and would otherwise need a live Redis.
    """
    mock_client = MagicMock()
    mock_client.set.return_value = True  # SET NX succeeded — we own the lock
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.redis_lib") as redis_module:
        redis_module.from_url.return_value = mock_client
        yield mock_client


@pytest.mark.django_db
def test_soft_delete_cascades_to_all_children(
    owner: object, populated_project: Project, _mock_redis_lock: object
) -> None:
    """After the offloaded cascade runs, no live child row survives — no orphans.

    #1111 established the no-orphan guarantee; #1112 moved the cascade into the
    ``cascade_project_soft_delete`` task, so the endpoint tombstones the row and
    the task (run here as the worker would) drains the children.
    """
    resp = _client(owner).delete(f"/api/v1/projects/{populated_project.pk}/")
    assert resp.status_code == 204

    populated_project.refresh_from_db()
    assert populated_project.is_deleted is True

    # Run the enqueued cascade task exactly as the Celery worker would.
    cascade_project_soft_delete.run(str(populated_project.pk))

    assert not Task.objects.filter(project=populated_project, is_deleted=False).exists()
    assert not Sprint.objects.filter(project=populated_project, is_deleted=False).exists()
    assert not Risk.objects.filter(project=populated_project, is_deleted=False).exists()
    assert not Baseline.objects.filter(project=populated_project, is_deleted=False).exists()
    # Dependency edges anchored in this project are tombstoned in the edge pass.
    assert not Dependency.objects.filter(
        predecessor__project=populated_project, is_deleted=False
    ).exists()


@pytest.mark.django_db
def test_soft_delete_tombstones_subtask_via_cascade(
    owner: object, populated_project: Project
) -> None:
    """Every task — subtask or not — is tombstoned by the single bulk task update."""
    _client(owner).delete(f"/api/v1/projects/{populated_project.pk}/")
    cascade_project_children_soft_delete(populated_project.pk)
    assert not Task.objects.filter(
        project=populated_project, is_subtask=True, is_deleted=False
    ).exists()


@pytest.mark.django_db
def test_soft_delete_row_tombstoned_before_cascade_runs(
    owner: object, populated_project: Project
) -> None:
    """The project reads as gone the instant the row is tombstoned — mid-cascade.

    The cascade is deferred, so immediately after DELETE the children are still
    live, yet the project already 404s on retrieve/overview and drops out of the
    list. This is the whole point of #1112: an instant tombstone, children drained
    asynchronously.
    """
    client = _client(owner)
    resp = client.delete(f"/api/v1/projects/{populated_project.pk}/")
    assert resp.status_code == 204

    # Cascade has NOT run yet (deferred to the worker), so children are still live.
    assert Task.objects.filter(project=populated_project, is_deleted=False).exists()

    # ...but the project already reads as gone to every reader.
    populated_project.refresh_from_db()
    assert populated_project.is_deleted is True
    assert client.get(f"/api/v1/projects/{populated_project.pk}/").status_code == 404
    assert client.get(f"/api/v1/projects/{populated_project.pk}/overview/").status_code == 404
    listing = client.get("/api/v1/projects/")
    rows = listing.data["results"] if isinstance(listing.data, dict) else listing.data
    assert str(populated_project.pk) not in [row["id"] for row in rows]


@pytest.mark.django_db
def test_cascade_bumps_versions_and_sets_deleted_version(
    owner: object, populated_project: Project
) -> None:
    """Bulk update replicates soft_delete: is_deleted, bumped server_version, and
    deleted_version == the new server_version."""
    task = Task.objects.filter(project=populated_project, is_subtask=False).first()
    assert task is not None
    before = task.server_version

    cascade_project_children_soft_delete(populated_project)

    task.refresh_from_db()
    assert task.is_deleted is True
    assert task.server_version == before + 1
    assert task.deleted_version == task.server_version
    assert task.deleted_at is not None


@pytest.mark.django_db
def test_cascade_is_idempotent(owner: object, populated_project: Project) -> None:
    """A re-run of the cascade tombstones nothing new and bumps no versions."""
    cascade_project_children_soft_delete(populated_project)

    versions = {str(t.pk): t.server_version for t in Task.objects.filter(project=populated_project)}
    dep_versions = {
        str(d.pk): d.server_version
        for d in Dependency.objects.filter(predecessor__project=populated_project)
    }

    # Second run must be a pure no-op (idempotency guard: filters is_deleted=False).
    cascade_project_children_soft_delete(populated_project)

    for t in Task.objects.filter(project=populated_project):
        assert t.is_deleted is True
        assert t.server_version == versions[str(t.pk)]
    for d in Dependency.objects.filter(predecessor__project=populated_project):
        assert d.is_deleted is True
        assert d.server_version == dep_versions[str(d.pk)]


@pytest.mark.django_db
def test_cascade_task_skips_hard_deleted_project(owner: object, _mock_redis_lock: object) -> None:
    """A project hard-deleted before the cascade runs is skipped without error."""
    import uuid as _uuid

    # A random UUID stands in for a project whose row is already gone.
    cascade_project_soft_delete.run(str(_uuid.uuid4()))  # must not raise


@pytest.mark.django_db
def test_soft_delete_enqueues_cascade(
    owner: object,
    populated_project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
    monkeypatch: Any,
) -> None:
    """perform_destroy dispatches the cascade task on commit with the project id."""
    calls: list[str] = []
    monkeypatch.setattr(cascade_project_soft_delete, "delay", lambda pid: calls.append(pid))

    with django_capture_on_commit_callbacks(execute=True):
        resp = _client(owner).delete(f"/api/v1/projects/{populated_project.pk}/")
    assert resp.status_code == 204
    assert calls == [str(populated_project.pk)]


@pytest.mark.django_db
def test_cascade_scale_tombstones_all_children_no_orphans(
    owner: object, calendar: Calendar, _mock_redis_lock: object
) -> None:
    """Scale-representative: a ~1000-task / ~1000-edge project fully tombstones with
    no orphaned task, dependency, sprint, risk, or baseline, and re-runs as a no-op."""
    p = Project.objects.create(name="Scale", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)

    n = 1000
    tasks = [Task(project=p, name=f"T{i}", duration=1, short_id=f"{i:08X}") for i in range(n)]
    Task.objects.bulk_create(tasks, batch_size=500)
    # Chain edges T0->T1->...->T(n-1): ~999 dependency rows.
    edges = [
        Dependency(predecessor=tasks[i], successor=tasks[i + 1], dep_type="FS")
        for i in range(n - 1)
    ]
    Dependency.objects.bulk_create(edges, batch_size=500)
    Sprint.objects.create(
        project=p,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )
    Risk.objects.create(project=p, title="R", probability=3, impact=4, created_by=owner)
    Baseline.objects.create(project=p, name="B0")

    resp = _client(owner).delete(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 204

    cascade_project_soft_delete.run(str(p.pk))

    assert not Task.objects.filter(project=p, is_deleted=False).exists()
    assert not Dependency.objects.filter(predecessor__project=p, is_deleted=False).exists()
    assert not Sprint.objects.filter(project=p, is_deleted=False).exists()
    assert not Risk.objects.filter(project=p, is_deleted=False).exists()
    assert not Baseline.objects.filter(project=p, is_deleted=False).exists()

    # Idempotent re-run.
    cascade_project_soft_delete.run(str(p.pk))
    assert Task.objects.filter(project=p, is_deleted=True).count() == n


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
# Project delete — audit event + in-app team notification (#1115)
# ---------------------------------------------------------------------------


@pytest.fixture
def team_project(owner: object, calendar: Calendar) -> Project:
    """A project with an owner plus two additional members, for fan-out tests."""
    p = Project.objects.create(name="Gemini", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    member = User.objects.create_user(username="member1", password="pw")
    viewer = User.objects.create_user(username="viewer1", password="pw")
    ProjectMembership.objects.create(project=p, user=member, role=Role.MEMBER)
    ProjectMembership.objects.create(project=p, user=viewer, role=Role.VIEWER)
    return p


@pytest.mark.django_db
def test_soft_delete_writes_audit_event(owner: object, project: Project) -> None:
    """Soft-delete records a team-readable operational audit row (#1115/#859)."""
    from trueppm_api.apps.workspace.models import AuditEvent

    resp = _client(owner).delete(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 204

    event = AuditEvent.objects.get(event_type="project_deleted", target_id=project.pk)
    assert event.target_type == "project"
    assert event.target_label == project.name
    assert event.actor_id == owner.pk  # type: ignore[attr-defined]
    assert event.metadata == {"mode": "soft"}


@pytest.mark.django_db
def test_hard_delete_writes_audit_event(owner: object, project: Project) -> None:
    """Hard-delete also records an audit row, tagged mode=hard (#1115/#859)."""
    from trueppm_api.apps.workspace.models import AuditEvent

    client = _client(owner)
    client.post(f"/api/v1/projects/{project.pk}/archive/")
    resp = client.delete(f"/api/v1/projects/{project.pk}/?force=true")
    assert resp.status_code == 204

    event = AuditEvent.objects.get(event_type="project_deleted", target_id=project.pk)
    assert event.metadata == {"mode": "hard"}


@pytest.mark.django_db
def test_soft_delete_notifies_team_in_app(
    owner: object,
    team_project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Every non-actor member gets an in-app project.deleted notification (#1115)."""
    from trueppm_api.apps.notifications.models import Notification, NotificationEventType

    with django_capture_on_commit_callbacks(execute=True):
        resp = _client(owner).delete(f"/api/v1/projects/{team_project.pk}/")
    assert resp.status_code == 204

    notes = Notification.objects.filter(event_type=NotificationEventType.PROJECT_DELETED.value)
    # One row per member, minus the actor (owner) who took the action.
    recipients = {n.recipient.username for n in notes}
    assert recipients == {"member1", "viewer1"}
    for note in notes:
        # In-app only — email is opt-in OFF by default, and there is no push channel.
        assert note.email_pending is False
        # Links back to the still-existing (soft-deleted) project for restore.
        assert note.project_id == team_project.pk
        assert "Gemini" in note.subject
        assert "restore" in note.body.lower()
        assert "owner" in note.body  # actor label appears in the body


@pytest.mark.django_db
def test_soft_delete_notification_excludes_actor(
    owner: object,
    team_project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The deleter is never notified of their own action (#1115)."""
    from trueppm_api.apps.notifications.models import Notification, NotificationEventType

    with django_capture_on_commit_callbacks(execute=True):
        _client(owner).delete(f"/api/v1/projects/{team_project.pk}/")

    assert not Notification.objects.filter(
        event_type=NotificationEventType.PROJECT_DELETED.value, recipient=owner
    ).exists()


@pytest.mark.django_db
def test_hard_delete_does_not_notify_team(
    owner: object,
    team_project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Permanent delete sends no team notification — no project row to restore (#1115)."""
    from trueppm_api.apps.notifications.models import Notification, NotificationEventType

    client = _client(owner)
    client.post(f"/api/v1/projects/{team_project.pk}/archive/")
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.delete(f"/api/v1/projects/{team_project.pk}/?force=true")
    assert resp.status_code == 204

    assert not Notification.objects.filter(
        event_type=NotificationEventType.PROJECT_DELETED.value
    ).exists()


@pytest.mark.django_db
def test_non_owner_cannot_delete_no_audit_or_notification(
    team_project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A non-owner delete is blocked before any audit row or notification (#1115)."""
    from trueppm_api.apps.notifications.models import Notification
    from trueppm_api.apps.workspace.models import AuditEvent

    member = User.objects.get(username="member1")
    with django_capture_on_commit_callbacks(execute=True):
        resp = _client(member).delete(f"/api/v1/projects/{team_project.pk}/")
    assert resp.status_code == 403

    team_project.refresh_from_db()
    assert team_project.is_deleted is False
    assert not AuditEvent.objects.filter(target_id=team_project.pk).exists()
    assert not Notification.objects.exists()


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
# Program split (ADR-0156, #967)
# ---------------------------------------------------------------------------


def _project_in_program(program: Program, calendar: Calendar, name: str) -> Project:
    return Project.objects.create(
        name=name,
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )


@pytest.mark.django_db
def test_split_program_creates_subprograms_and_moves_projects(
    owner: object, program: Program, calendar: Calendar
) -> None:
    p1 = _project_in_program(program, calendar, "Alpha")
    p2 = _project_in_program(program, calendar, "Beta")

    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {
            "splits": [
                {"name": "North", "project_ids": [str(p1.pk)]},
                {"name": "South", "project_ids": [str(p2.pk)]},
            ]
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content

    sub_programs = resp.data["sub_programs"]
    assert [s["name"] for s in sub_programs] == ["North", "South"]
    north_id = sub_programs[0]["id"]
    south_id = sub_programs[1]["id"]

    p1.refresh_from_db()
    p2.refresh_from_db()
    assert str(p1.program_id) == north_id
    assert str(p2.program_id) == south_id

    # Caller is OWNER of each sub-program (atomic via create_program).
    assert ProgramMembership.objects.get(program_id=north_id, user=owner).role == Role.OWNER
    # Parent is closed afterwards.
    program.refresh_from_db()
    assert program.is_closed is True
    assert program.closed_by_id == owner.pk
    # Sub-program copies the parent methodology.
    assert sub_programs[0]["methodology"] == program.methodology


@pytest.mark.django_db
def test_split_program_leaves_unlisted_projects_on_closed_parent(
    owner: object, program: Program, calendar: Calendar
) -> None:
    moved = _project_in_program(program, calendar, "Moved")
    stayed = _project_in_program(program, calendar, "Stayed")

    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "Spin-off", "project_ids": [str(moved.pk)]}]},
        format="json",
    )
    assert resp.status_code == 200, resp.content

    moved.refresh_from_db()
    stayed.refresh_from_db()
    assert str(moved.program_id) == resp.data["sub_programs"][0]["id"]
    # Unlisted project stays with the (now-closed) original program.
    assert stayed.program_id == program.pk


@pytest.mark.django_db
def test_split_program_bumps_moved_project_server_version(
    owner: object, program: Program, calendar: Calendar
) -> None:
    p1 = _project_in_program(program, calendar, "Alpha")
    before = p1.server_version

    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "North", "project_ids": [str(p1.pk)]}]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    p1.refresh_from_db()
    # Reassignment goes through Project.save() so mobile sync clients see it.
    assert p1.server_version > before


@pytest.mark.django_db
def test_split_program_rejects_foreign_project(
    owner: object, program: Program, calendar: Calendar
) -> None:
    # A project that is NOT a member of this program.
    foreign = Project.objects.create(
        name="Outsider", start_date=date(2026, 4, 1), calendar=calendar
    )
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "X", "project_ids": [str(foreign.pk)]}]},
        format="json",
    )
    assert resp.status_code == 400
    # Atomic: nothing was created and the parent stays open.
    program.refresh_from_db()
    assert program.is_closed is False
    assert not Program.objects.filter(name="X").exists()


@pytest.mark.django_db
def test_split_program_rejects_project_in_two_splits(
    owner: object, program: Program, calendar: Calendar
) -> None:
    p1 = _project_in_program(program, calendar, "Alpha")
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {
            "splits": [
                {"name": "A", "project_ids": [str(p1.pk)]},
                {"name": "B", "project_ids": [str(p1.pk)]},
            ]
        },
        format="json",
    )
    assert resp.status_code == 400
    program.refresh_from_db()
    assert program.is_closed is False


@pytest.mark.django_db
def test_split_program_rejects_empty_payload(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/", {"splits": []}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize("body", ["just a string", ["splits"], 7])
def test_split_program_rejects_non_object_body(
    owner: object, program: Program, body: object
) -> None:
    """A non-object JSON body (string/list/scalar) has no ``.get`` — the action must
    return 400, not raise AttributeError → 500 (#2126 class 2)."""
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/split/", body, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_split_program_rejects_malformed_entry(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "A"}]},  # missing project_ids
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_split_program_rejects_too_many_splits(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": f"S{i}", "project_ids": []} for i in range(51)]},
        format="json",
    )
    assert resp.status_code == 400
    program.refresh_from_db()
    assert program.is_closed is False


@pytest.mark.django_db
def test_split_program_requires_owner(owner: object, other_user: object, program: Program) -> None:
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.ADMIN)
    resp = _client(other_user).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "A", "project_ids": []}]},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_split_closed_program_is_blocked(owner: object, program: Program) -> None:
    program.is_closed = True
    program.save(update_fields=["is_closed"])
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/split/",
        {"splits": [{"name": "A", "project_ids": []}]},
        format="json",
    )
    # IsProgramNotClosed gate — a closed program cannot be split (also makes a
    # replayed request safe after the first split closes the parent).
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


# ---------------------------------------------------------------------------
# Project export (#967) — GET /projects/:id/export/ (Admin/Owner-only, #1957)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_export_project_member_downloads_json(owner: object, project: Project) -> None:
    resp = _client(owner).get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code == 200, resp.content
    assert resp["Content-Type"] == "application/json"
    assert "attachment" in resp["Content-Disposition"]
    body = json.loads(resp.content)
    assert body["schema_version"] == "1.0"
    assert len(body["projects"]) == 1
    # The `project` fixture is standalone (no program) — export still produces a
    # valid single-project seed via the synthesized program wrapper (#967).
    assert body["projects"][0]["name"] == "Apollo"
    assert body["program"]["name"] == "Apollo"


@pytest.mark.django_db
def test_export_project_requires_auth(project: Project) -> None:
    resp = APIClient().get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_export_project_non_member_denied(stranger: object, project: Project) -> None:
    resp = _client(stranger).get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_export_project_viewer_denied(owner: object, other_user: object, project: Project) -> None:
    # The seed export carries raw team-private points/velocity without field-level
    # ADR-0104 gating, so it is Admin/Owner-only (#1957) — a Viewer now gets 403.
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.VIEWER)
    resp = _client(other_user).get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code == 403, resp.content


@pytest.mark.django_db
def test_export_project_available_when_archived(owner: object, project: Project) -> None:
    # Export stays available on an archived project (portability for archival),
    # unlike write actions which the IsProjectNotArchived gate blocks.
    project.is_archived = True
    project.save(update_fields=["is_archived"])
    resp = _client(owner).get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code == 200, resp.content
    body = json.loads(resp.content)
    assert body["projects"][0]["name"] == "Apollo"
