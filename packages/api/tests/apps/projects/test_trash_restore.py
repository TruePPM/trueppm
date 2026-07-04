"""Tests for Trash + restore of soft-deleted projects (#1113, ADR-0199).

Covers:
- GET  /projects/trash/        — membership-scoped list, retention-window filter,
                                  deleted_by, days_remaining, can_restore gate
- POST /projects/:id/restore/  — Owner-gated, atomic un-tombstone of project + children,
                                  server_version bump, idempotency, cross-project edge rule,
                                  atomic-failure rollback
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    Calendar,
    Dependency,
    Project,
    Risk,
    Sprint,
    SprintState,
    Task,
    cascade_project_children_soft_delete,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(
        username="owner", password="pw", first_name="Olive", last_name="Owner"
    )


@pytest.fixture
def member(db: object) -> Any:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def stranger(db: object) -> Any:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _make_project(owner: Any, calendar: Calendar, name: str = "Apollo") -> Project:
    p = Project.objects.create(
        name=name, code="APL", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def populated_project(owner: Any, calendar: Calendar) -> Project:
    """A live project with one of each board-scoped child."""
    p = _make_project(owner, calendar, name="Cascade")
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
    Baseline.objects.create(project=p, name="B1")
    Risk.objects.create(project=p, title="R1", probability=3, impact=4, created_by=owner)
    return p


def _soft_delete(client: APIClient, project: Project) -> None:
    """Delete via the endpoint and run the (offloaded) child cascade synchronously."""
    resp = client.delete(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 204, resp.content
    cascade_project_children_soft_delete(project.pk)


# ---------------------------------------------------------------------------
# Restore — happy path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_restore_untombstones_project_and_all_children(
    owner: Any, populated_project: Project
) -> None:
    client = _client(owner)
    _soft_delete(client, populated_project)

    # Everything is tombstoned before restore.
    populated_project.refresh_from_db()
    assert populated_project.is_deleted is True
    assert not Task.objects.filter(project=populated_project, is_deleted=False).exists()

    resp = client.post(f"/api/v1/projects/{populated_project.pk}/restore/")
    assert resp.status_code == 200, resp.content

    populated_project.refresh_from_db()
    assert populated_project.is_deleted is False
    assert populated_project.deleted_at is None
    assert populated_project.deleted_by is None
    assert populated_project.deleted_version is None

    # Every child is live again — no half-restore.
    assert Task.objects.filter(project=populated_project, is_deleted=True).count() == 0
    assert Task.objects.filter(project=populated_project, is_deleted=False).count() == 3
    assert Sprint.objects.filter(project=populated_project, is_deleted=False).count() == 1
    assert Baseline.objects.filter(project=populated_project, is_deleted=False).count() == 1
    assert Risk.objects.filter(project=populated_project, is_deleted=False).count() == 1
    assert (
        Dependency.objects.filter(predecessor__project=populated_project, is_deleted=False).count()
        == 1
    )

    # Project is reachable again (zombie-guard lifted).
    assert client.get(f"/api/v1/projects/{populated_project.pk}/").status_code == 200


@pytest.mark.django_db
def test_restore_bumps_server_version_for_sync_rematerialization(
    owner: Any, populated_project: Project
) -> None:
    """A restored row's server_version rises so the sync pull re-materializes it."""
    client = _client(owner)
    task = Task.objects.filter(project=populated_project, is_subtask=False).first()
    assert task is not None
    _soft_delete(client, populated_project)

    project_version_deleted = Project.objects.values_list("server_version", flat=True).get(
        pk=populated_project.pk
    )
    task_version_deleted = Task.objects.values_list("server_version", flat=True).get(pk=task.pk)

    resp = client.post(f"/api/v1/projects/{populated_project.pk}/restore/")
    assert resp.status_code == 200

    assert (
        Project.objects.values_list("server_version", flat=True).get(pk=populated_project.pk)
        > project_version_deleted
    )
    assert Task.objects.values_list("server_version", flat=True).get(pk=task.pk) > (
        task_version_deleted
    )


@pytest.mark.django_db
def test_restore_is_idempotent(owner: Any, populated_project: Project) -> None:
    """Restoring an already-live project is a 200 no-op (double-click / retry safe)."""
    client = _client(owner)
    _soft_delete(client, populated_project)
    first = client.post(f"/api/v1/projects/{populated_project.pk}/restore/")
    assert first.status_code == 200
    live_version = Project.objects.values_list("server_version", flat=True).get(
        pk=populated_project.pk
    )
    # A second restore no longer finds it in Trash (already live) → 404, no bump.
    second = client.post(f"/api/v1/projects/{populated_project.pk}/restore/")
    assert second.status_code == 404
    assert (
        Project.objects.values_list("server_version", flat=True).get(pk=populated_project.pk)
        == live_version
    )


@pytest.mark.django_db
def test_restore_records_audit_event(owner: Any, populated_project: Project) -> None:
    from trueppm_api.apps.workspace.models import AuditEvent, AuditEventType

    client = _client(owner)
    _soft_delete(client, populated_project)
    client.post(f"/api/v1/projects/{populated_project.pk}/restore/")
    assert AuditEvent.objects.filter(
        event_type=AuditEventType.PROJECT_RESTORED, target_id=populated_project.pk
    ).exists()


# ---------------------------------------------------------------------------
# Restore — permission gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_restore_requires_owner(owner: Any, member: Any, populated_project: Project) -> None:
    ProjectMembership.objects.create(project=populated_project, user=member, role=Role.ADMIN)
    _soft_delete(_client(owner), populated_project)

    resp = _client(member).post(f"/api/v1/projects/{populated_project.pk}/restore/")
    assert resp.status_code == 403
    populated_project.refresh_from_db()
    assert populated_project.is_deleted is True


@pytest.mark.django_db
def test_restore_scoped_to_members_only(
    owner: Any, stranger: Any, populated_project: Project
) -> None:
    """A non-member cannot even see the trashed project — 404, not 403 (no leak)."""
    _soft_delete(_client(owner), populated_project)
    resp = _client(stranger).post(f"/api/v1/projects/{populated_project.pk}/restore/")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Restore — atomic failure rolls the whole thing back
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_restore_is_atomic_on_child_failure(owner: Any, populated_project: Project) -> None:
    """If a child restore raises mid-cascade, the whole restore rolls back.

    Risks are restored per-row LAST (after tasks/sprints/baselines are bulk-restored).
    Forcing Risk.restore to raise proves the earlier bulk restores are rolled back too —
    the project and every child stay tombstoned, never a half-restored state (ADR-0199).
    """
    client = _client(owner)
    _soft_delete(client, populated_project)

    with (
        patch(
            "trueppm_api.apps.projects.models.Risk.restore",
            side_effect=RuntimeError("boom"),
        ),
        pytest.raises(RuntimeError),
    ):
        client.post(f"/api/v1/projects/{populated_project.pk}/restore/")

    # Nothing was restored — atomic rollback.
    populated_project.refresh_from_db()
    assert populated_project.is_deleted is True
    assert not Task.objects.filter(project=populated_project, is_deleted=False).exists()
    assert not Sprint.objects.filter(project=populated_project, is_deleted=False).exists()
    assert not Baseline.objects.filter(project=populated_project, is_deleted=False).exists()


# ---------------------------------------------------------------------------
# Restore — cross-project dependency liveness rule
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_restore_leaves_cross_project_edge_tombstoned_when_other_side_deleted(
    owner: Any, calendar: Calendar
) -> None:
    """A cross-project edge stays tombstoned if its other endpoint is still deleted.

    Restoring project A must not resurrect an edge A→B while B's task is still a
    tombstone — that would be a live edge to a dead task (ADR-0199 §2).
    """
    proj_a = _make_project(owner, calendar, name="A")
    proj_b = _make_project(owner, calendar, name="B")
    task_a = Task.objects.create(project=proj_a, name="A1", duration=1)
    task_b = Task.objects.create(project=proj_b, name="B1", duration=1)
    edge = Dependency.objects.create(predecessor=task_a, successor=task_b, dep_type="FS")

    client = _client(owner)
    # Delete BOTH projects (so the shared edge is tombstoned, and B stays dead).
    _soft_delete(client, proj_a)
    _soft_delete(client, proj_b)

    # Restore only A. B's task is still tombstoned.
    resp = client.post(f"/api/v1/projects/{proj_a.pk}/restore/")
    assert resp.status_code == 200

    task_b.refresh_from_db()
    edge.refresh_from_db()
    assert task_b.is_deleted is True  # B not restored
    assert edge.is_deleted is True  # edge stays tombstoned — no live-edge-to-dead-task

    # Now restore B too — the edge resurrects because both endpoints are live.
    resp = client.post(f"/api/v1/projects/{proj_b.pk}/restore/")
    assert resp.status_code == 200
    edge.refresh_from_db()
    assert edge.is_deleted is False


# ---------------------------------------------------------------------------
# Trash list
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_trash_lists_soft_deleted_projects_with_metadata(
    owner: Any, populated_project: Project
) -> None:
    client = _client(owner)
    _soft_delete(client, populated_project)

    resp = client.get("/api/v1/projects/trash/")
    assert resp.status_code == 200, resp.content
    assert len(resp.data) == 1
    row = resp.data[0]
    assert row["id"] == str(populated_project.pk)
    assert row["name"] == "Cascade"
    assert row["deleted_at"] is not None
    assert row["deleted_by"] == str(owner.pk)
    assert row["deleted_by_name"] == "Olive Owner"
    assert row["can_restore"] is True
    assert row["my_role"] == Role.OWNER
    assert row["days_remaining"] is not None and row["days_remaining"] >= 0


@pytest.mark.django_db
def test_trash_excludes_live_projects(owner: Any, calendar: Calendar) -> None:
    _make_project(owner, calendar, name="StillHere")
    resp = _client(owner).get("/api/v1/projects/trash/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_trash_is_membership_scoped(owner: Any, stranger: Any, populated_project: Project) -> None:
    """A stranger's Trash never contains another team's project."""
    _soft_delete(_client(owner), populated_project)
    resp = _client(stranger).get("/api/v1/projects/trash/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_trash_non_owner_member_sees_row_but_cannot_restore(
    owner: Any, member: Any, populated_project: Project
) -> None:
    ProjectMembership.objects.create(project=populated_project, user=member, role=Role.MEMBER)
    _soft_delete(_client(owner), populated_project)

    resp = _client(member).get("/api/v1/projects/trash/")
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["can_restore"] is False
    assert resp.data[0]["my_role"] == Role.MEMBER


@pytest.mark.django_db
def test_trash_excludes_projects_past_retention_window(
    owner: Any, populated_project: Project, settings: Any
) -> None:
    """Projects whose deleted_at is older than the retention window drop out of Trash.

    They are eligible for the background purge and may already be gone — Trash only
    shows recoverable rows.
    """
    settings.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS = 30
    client = _client(owner)
    _soft_delete(client, populated_project)

    # Backdate the delete beyond the window.
    Project.objects.filter(pk=populated_project.pk).update(
        deleted_at=timezone.now() - timedelta(days=31)
    )
    resp = client.get("/api/v1/projects/trash/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_trash_shows_legacy_null_deleted_at_with_no_countdown(
    owner: Any, populated_project: Project
) -> None:
    """A legacy tombstone (NULL deleted_at) is always shown, retained indefinitely."""
    client = _client(owner)
    _soft_delete(client, populated_project)
    Project.objects.filter(pk=populated_project.pk).update(deleted_at=None)

    resp = client.get("/api/v1/projects/trash/")
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["deleted_at"] is None
    assert resp.data[0]["days_remaining"] is None


@pytest.mark.django_db
def test_trash_requires_auth(populated_project: Project) -> None:
    resp = APIClient().get("/api/v1/projects/trash/")
    assert resp.status_code in (401, 403)
