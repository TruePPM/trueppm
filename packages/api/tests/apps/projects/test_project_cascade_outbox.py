"""Durable outbox for the project soft-delete cascade (#1602)."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectCascadeRequest,
    ProjectCascadeRequestStatus,
    Task,
)
from trueppm_api.apps.projects.services import enqueue_project_cascade_soft_delete
from trueppm_api.apps.projects.tasks import (
    _do_project_cascade_drain,
    cascade_project_soft_delete,
    purge_old_project_cascade_requests,
)

Status = ProjectCascadeRequestStatus


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> Any:
    client = MagicMock()
    client.set.return_value = True
    client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.valkey") as mod:
        mod.client.return_value = client
        yield client


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    p = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)
    Task.objects.create(project=p, name="T1", wbs_path="1")
    return p


def _tombstone(project: Project) -> None:
    project.soft_delete()


def _live_tasks(project: Project) -> int:
    return Task.objects.filter(project=project, is_deleted=False).count()


def _backdate(req: ProjectCascadeRequest, **fields: Any) -> None:
    ProjectCascadeRequest.objects.filter(pk=req.pk).update(**fields)


@pytest.mark.django_db(transaction=True)
def test_happy_path_row_written_dispatched_then_done(project: Project) -> None:
    _tombstone(project)
    with patch.object(cascade_project_soft_delete, "delay") as delay:
        enqueue_project_cascade_soft_delete(project.pk)
    delay.assert_called_once_with(str(project.pk))
    req = ProjectCascadeRequest.objects.get(project=project)
    assert req.status == Status.DISPATCHED

    cascade_project_soft_delete.run(str(project.pk))

    req.refresh_from_db()
    assert req.status == Status.DONE and req.completed_at is not None
    assert _live_tasks(project) == 0


@pytest.mark.django_db(transaction=True)
def test_broker_down_then_recover(project: Project) -> None:
    _tombstone(project)
    with patch.object(cascade_project_soft_delete, "delay", side_effect=OSError("broker down")):
        enqueue_project_cascade_soft_delete(project.pk)
    req = ProjectCascadeRequest.objects.get(project=project)
    assert req.status == Status.PENDING
    assert _live_tasks(project) == 1  # orphaned until the drain runs

    # Inside the orphan window the drain leaves it to its own on-commit dispatch.
    with patch.object(cascade_project_soft_delete, "delay") as delay:
        _do_project_cascade_drain()
    delay.assert_not_called()

    _backdate(req, requested_at=timezone.now() - timedelta(minutes=10))
    # Broker still down: the row stays pending.
    with patch.object(cascade_project_soft_delete, "delay", side_effect=OSError("down")):
        _do_project_cascade_drain()
    req.refresh_from_db()
    assert req.status == Status.PENDING

    # Broker recovers: drain dispatches; the worker (run inline) tombstones children.
    with patch.object(
        cascade_project_soft_delete,
        "delay",
        side_effect=lambda pid: cascade_project_soft_delete.run(pid),
    ) as delay:
        _do_project_cascade_drain()
    delay.assert_called_once_with(str(project.pk))
    req.refresh_from_db()
    assert req.status == Status.DONE
    assert _live_tasks(project) == 0


@pytest.mark.django_db
def test_drain_picks_only_stale_rows(project: Project) -> None:
    _tombstone(project)
    now = timezone.now()
    fresh = ProjectCascadeRequest.objects.create(project=project)
    done = ProjectCascadeRequest.objects.create(project=project, status=Status.DONE)
    live_dispatch = ProjectCascadeRequest.objects.create(
        project=project, status=Status.DISPATCHED, dispatched_at=now
    )
    stale = ProjectCascadeRequest.objects.create(project=project)
    lost = ProjectCascadeRequest.objects.create(
        project=project, status=Status.DISPATCHED, dispatched_at=now - timedelta(hours=1)
    )
    old = now - timedelta(hours=1)
    for r in (done, live_dispatch, stale, lost):
        _backdate(r, requested_at=old)

    with patch.object(cascade_project_soft_delete, "delay") as delay:
        _do_project_cascade_drain()

    assert delay.call_count == 2  # stale + recovered-lost, same project id
    for r in (stale, lost):
        r.refresh_from_db()
        assert r.status == Status.DISPATCHED
    for r, expected in (
        (fresh, Status.PENDING),
        (done, Status.DONE),
        (live_dispatch, Status.DISPATCHED),
    ):
        r.refresh_from_db()
        assert r.status == expected


@pytest.mark.django_db
def test_redispatch_is_idempotent(project: Project) -> None:
    _tombstone(project)
    ProjectCascadeRequest.objects.create(project=project)
    cascade_project_soft_delete.run(str(project.pk))
    cascade_project_soft_delete.run(str(project.pk))  # duplicate dispatch: no-op
    assert _live_tasks(project) == 0
    assert ProjectCascadeRequest.objects.get(project=project).status == Status.DONE


@pytest.mark.django_db
def test_restored_project_is_not_cascaded(project: Project) -> None:
    """A drain re-dispatch after a restore must not tombstone a live project's children."""
    ProjectCascadeRequest.objects.create(project=project)  # project is live (restored)
    cascade_project_soft_delete.run(str(project.pk))
    assert _live_tasks(project) == 1
    assert ProjectCascadeRequest.objects.get(project=project).status == Status.DONE


@pytest.mark.django_db(transaction=True)
def test_restored_project_with_dispatched_row_is_not_cascaded(project: Project) -> None:
    _tombstone(project)
    ProjectCascadeRequest.objects.create(
        project=project, status=Status.DISPATCHED, dispatched_at=timezone.now()
    )
    project.restore()
    cascade_project_soft_delete.run(str(project.pk))
    assert _live_tasks(project) == 1
    req = ProjectCascadeRequest.objects.get(project=project)
    assert req.status == Status.DONE and req.completed_at is not None


@pytest.mark.django_db(transaction=True)
def test_restore_then_delete_again_cascades_and_closes_all_rows(project: Project) -> None:
    _tombstone(project)
    old = ProjectCascadeRequest.objects.create(
        project=project, status=Status.DISPATCHED, dispatched_at=timezone.now()
    )
    project.restore()
    project.refresh_from_db()
    _tombstone(project)
    new = ProjectCascadeRequest.objects.create(project=project)

    cascade_project_soft_delete.run(str(project.pk))

    assert _live_tasks(project) == 0
    for r in (old, new):
        r.refresh_from_db()
        assert r.status == Status.DONE


@pytest.mark.django_db
def test_rolled_back_delete_leaves_no_row_and_no_dispatch(project: Project) -> None:
    from django.db import transaction

    class _Boom(Exception):
        pass

    with (
        patch.object(cascade_project_soft_delete, "delay") as delay,
        pytest.raises(_Boom),
        transaction.atomic(),
    ):
        enqueue_project_cascade_soft_delete(project.pk)
        raise _Boom
    delay.assert_not_called()
    assert not ProjectCascadeRequest.objects.exists()


@pytest.mark.django_db
def test_purge_deletes_only_old_done_rows(project: Project) -> None:
    old = timezone.now() - timedelta(days=8)
    done_old = ProjectCascadeRequest.objects.create(project=project, status=Status.DONE)
    pending_old = ProjectCascadeRequest.objects.create(project=project)
    done_new = ProjectCascadeRequest.objects.create(project=project, status=Status.DONE)
    _backdate(done_old, requested_at=old)
    _backdate(pending_old, requested_at=old)

    purge_old_project_cascade_requests.run()

    remaining = set(ProjectCascadeRequest.objects.values_list("pk", flat=True))
    assert remaining == {pending_old.pk, done_new.pk}


@pytest.mark.django_db
def test_hard_delete_removes_outbox_rows(project: Project) -> None:
    ProjectCascadeRequest.objects.create(project=project)
    from trueppm_api.apps.access.services import hard_delete_projects

    hard_delete_projects([project.pk])
    assert not ProjectCascadeRequest.objects.exists()
