"""The changeset is fed by every structural write path, and tells people once (ADR-1477).

§2: sync upload and MS Project import are structural writes like any REST route,
or they are a bypass of the changeset. §4: the recalc stamps the finish impact
on every run, honoring its input snapshot. §6: the assignees of the touched
tasks and of the downstream tasks the run re-dated hear once per entry, and a
re-run sends nothing.
"""

from __future__ import annotations

import base64
import pathlib
import uuid
from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification, NotificationEventType
from trueppm_api.apps.projects import amend
from trueppm_api.apps.projects.commit_moment import commit_project
from trueppm_api.apps.projects.models import (
    Calendar,
    ChangesetEntry,
    Project,
    ProjectLifecycle,
    Task,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

_FIXTURES = pathlib.Path(__file__).parent.parent / "msproject" / "fixtures"


@pytest.fixture
def owner(db: object) -> Any:
    return get_user_model().objects.create_user(username="wp-owner", password="pw")


def _task(project: Project, name: str, path: str, finish: date) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=5,
        wbs_path=path,
        early_start=finish - timedelta(days=4),
        early_finish=finish,
    )


@pytest.fixture
def committed(owner: Any) -> Project:
    p = Project.objects.create(
        name="Pad 40",
        start_date=date(2026, 3, 2),
        calendar=Calendar.objects.create(name="Standard"),
        lifecycle=ProjectLifecycle.DRAFT,
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    _task(p, "Permits", "1", date(2026, 3, 6))
    _task(p, "Survey", "2", date(2026, 3, 11))
    commit_project(p, user=owner)
    p.refresh_from_db()
    return p


def _assign(task: Task, username: str) -> Any:
    user = get_user_model().objects.filter(username=username).first()
    if user is None:
        user = get_user_model().objects.create_user(username=username, password="pw")
    res = Resource.objects.filter(user=user).first() or Resource.objects.create(
        name=username, user=user
    )
    TaskResource.objects.create(task=task, resource=res)
    return user


def _plan_notices(user: Any) -> int:
    return Notification.objects.filter(
        recipient=user, event_type=NotificationEventType.PLAN_AMENDED
    ).count()


# ── B1: sync upload ──────────────────────────────────────────────────────────


def test_sync_upload_records_one_add_and_one_delete(committed: Project, owner: Any) -> None:
    gone = Task.objects.get(project=committed, name="Survey")
    c = APIClient()
    c.force_authenticate(user=owner)
    resp = c.post(
        f"/api/v1/projects/{committed.pk}/sync/",
        {
            "client_batch_id": str(uuid.uuid4()),
            "changes": {
                "tasks": {
                    "created": [{"id": str(uuid.uuid4()), "name": "Field note"}],
                    "updated": [],
                    "deleted": [str(gone.pk)],
                }
            },
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    entries = ChangesetEntry.objects.filter(project=committed)
    assert sorted((e.kind, e.surface) for e in entries) == [("add", "sync"), ("delete", "sync")]
    assert next(e for e in entries if e.kind == "delete").task_ids == [str(gone.pk)]


# ── B2: MS Project import into a committed plan ──────────────────────────────


def test_msproject_import_into_committed_plan_records_one_entry(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    from trueppm_api.apps.msproject.tasks import import_msproject

    b64 = base64.b64encode((_FIXTURES / "all_dependency_types.xml").read_bytes()).decode()
    with (
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        result = import_msproject.apply(args=(str(committed.pk), b64, "import.xml", owner.pk))
    assert result.successful(), result.result
    assert "_created_task_ids" not in result.result
    entries = list(ChangesetEntry.objects.filter(project=committed))
    assert [(e.kind, e.surface, e.author_id) for e in entries] == [("add", "import", owner.pk)]
    assert len(entries[0].task_ids) == result.result["tasks_created"]


# ── B4 / G3 / G7: notifications and the stamp ────────────────────────────────


def test_one_assignee_on_five_tasks_hears_once(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = [_task(committed, f"Row {i}", f"9.{i}", date(2026, 3, 20)) for i in range(5)]
    crew = None
    for t in tasks:
        crew = _assign(t, "crew")
    with django_capture_on_commit_callbacks(execute=True):
        amend.record_structural_change(
            committed, kind="add", surface="grid", actor=owner, tasks=tasks
        )
    assert _plan_notices(crew) == 1


def _notify_queries(committed: Project, owner: Any, n: int, tag: str) -> int:
    tasks = [_task(committed, f"{tag} {i}", f"8.{tag}{i}", date(2026, 3, 20)) for i in range(n)]
    for i, t in enumerate(tasks):
        _assign(t, f"{tag}-person-{i}")
    entry = ChangesetEntry.objects.create(
        project=committed, kind="add", surface="grid", author=owner,
        task_ids=[str(t.pk) for t in tasks], task_names=[t.name for t in tasks],
    )  # fmt: skip
    with CaptureQueriesContext(connection) as ctx:
        amend._notify_entry(entry, [str(t.pk) for t in tasks], actor=owner)
    return len(ctx.captured_queries)


def test_entry_notification_queries_do_not_grow_with_rows(committed: Project, owner: Any) -> None:
    assert _notify_queries(committed, owner, 2, "a") == _notify_queries(committed, owner, 8, "b")


def test_downstream_assignee_hears_once_and_a_rerun_sends_nothing(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    moved = Task.objects.get(project=committed, name="Permits")
    successor = Task.objects.get(project=committed, name="Survey")
    mover_crew = _assign(moved, "mover-crew")
    succ_crew = _assign(successor, "succ-crew")
    with django_capture_on_commit_callbacks(execute=True):
        entry = amend.record_structural_change(
            committed, kind="move", surface="grid", actor=owner, tasks=[moved]
        )
    assert _plan_notices(mover_crew) == 1
    assert _plan_notices(succ_crew) == 0

    # The recalc that follows re-dated the successor (and the moved task itself).
    snapshot = timezone.now()
    stamped = amend.stamp_finish_after(
        [committed.pk], snapshot_at=snapshot, moved_tasks=[moved, successor]
    )
    assert [e.pk for e in stamped] == [entry.pk]
    assert _plan_notices(succ_crew) == 1
    assert _plan_notices(mover_crew) == 1  # its own task: told once already

    # A re-run (the stamp is set) and a re-stamp after an absorbed act send nothing.
    amend.stamp_finish_after([committed.pk], snapshot_at=snapshot, moved_tasks=[successor])
    ChangesetEntry.objects.filter(pk=entry.pk).update(finish_after=None)
    amend.stamp_finish_after([committed.pk], snapshot_at=timezone.now(), moved_tasks=[successor])
    assert _plan_notices(succ_crew) == 1


def test_stamp_honors_the_run_snapshot_and_runs_when_nothing_moved(
    committed: Project, owner: Any
) -> None:
    task = Task.objects.get(project=committed, name="Permits")
    entry = amend.record_structural_change(
        committed, kind="move", surface="grid", actor=owner, tasks=[task]
    )
    # A run whose inputs were read before the act does not stamp it.
    before = entry.last_act_at - timedelta(seconds=1)
    assert amend.stamp_finish_after([committed.pk], snapshot_at=before) == []
    entry.refresh_from_db()
    assert entry.finish_after is None
    # A later run stamps it even though it re-dated nothing.
    assert amend.stamp_finish_after([committed.pk], snapshot_at=timezone.now(), moved_tasks=[])
    entry.refresh_from_db()
    assert entry.finish_after == date(2026, 3, 11)
