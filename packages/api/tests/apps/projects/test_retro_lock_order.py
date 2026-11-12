"""Lock order between retro save and a promoted-task soft-delete (#4628).

Every writer of ``RetroActionItem`` rows must take the project row lock (the sync
cursor draw) before item row locks. A Task soft-delete already does: its save draws
a cursor, then ``reset_promoted_task_on_delete`` updates items. Retro save used to
lock items first, so the two could deadlock.

The race is forced, not hoped for: the soft-delete thread holds the project lock and
refuses to touch items until the retro-save thread is observably blocked in Postgres
on a lock. Under the old order the saver then holds item locks while waiting for the
project, so the deleter's item update closes the cycle and Postgres aborts one side.
Under the shared order the saver holds nothing while it waits, and both succeed.
"""

from __future__ import annotations

import threading
import time
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import OperationalError, connection, connections, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import retro_services
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    RetroActionItem,
    Sprint,
    SprintRetro,
    SprintState,
    Task,
)

User = get_user_model()

_TIMEOUT = 30.0


def _wait_until_blocked_on_lock(pid: int) -> bool:
    """Poll pg_stat_activity until backend ``pid`` waits on a heavyweight lock."""
    deadline = time.monotonic() + _TIMEOUT
    while time.monotonic() < deadline:
        with connection.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = 'Lock'",
                [pid],
            )
            if cur.fetchone():
                return True
        time.sleep(0.02)
    return False


def _race(project: Project, sprint: Sprint, task: Task, item: RetroActionItem, user: Any) -> dict:
    saver_pid: list[int] = []
    saver_ready = threading.Event()
    deleter_has_project_lock = threading.Event()
    results: dict[str, Any] = {}
    original = retro_services.reset_promoted_task_on_delete

    def gated_reset(task_id: str) -> None:
        # Reached only after Task.save() drew its cursor, i.e. holding the project lock.
        deleter_has_project_lock.set()
        assert saver_ready.wait(_TIMEOUT)
        results["saver_blocked"] = _wait_until_blocked_on_lock(saver_pid[0])
        original(task_id)

    def deleter() -> None:
        try:
            with (
                patch.object(retro_services, "reset_promoted_task_on_delete", gated_reset),
                transaction.atomic(),
            ):
                Task.objects.get(pk=task.pk).soft_delete()
            results["deleter"] = "ok"
        except Exception as exc:
            results["deleter"] = exc
        finally:
            connections.close_all()

    def saver() -> None:
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT pg_backend_pid()")
                saver_pid.append(cur.fetchone()[0])
            assert deleter_has_project_lock.wait(_TIMEOUT)
            saver_ready.set()
            client = APIClient()
            client.force_authenticate(user=user)
            resp = client.post(
                f"/api/v1/sprints/{sprint.pk}/retro/",
                {"notes": "n", "action_items": [{"id": str(item.pk), "text": "edited"}]},
                format="json",
            )
            results["saver"] = resp.status_code
        except Exception as exc:
            results["saver"] = exc
        finally:
            connections.close_all()

    threads = [threading.Thread(target=deleter), threading.Thread(target=saver)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(_TIMEOUT * 2)
    return results


@pytest.fixture
def scenario(db: object) -> tuple[Project, Sprint, Task, RetroActionItem, Any]:
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)
    user = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
    )
    retro = SprintRetro.objects.create(sprint=sprint, notes="r")
    task = Task.objects.create(project=project, name="T", duration=1)
    item = RetroActionItem.objects.create(retro=retro, text="x", promoted_task_id=task.pk)
    return project, sprint, task, item, user


@pytest.mark.django_db(transaction=True)
def test_retro_save_and_promoted_task_soft_delete_do_not_deadlock(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
) -> None:
    project, sprint, task, item, user = scenario
    results = _race(project, sprint, task, item, user)
    assert results["saver_blocked"] is True
    assert results["deleter"] == "ok"
    assert results["saver"] == 200
    assert RetroActionItem.objects.get(pk=item.pk).promoted_task_id is None


@pytest.mark.django_db(transaction=True)
def test_negative_control_item_first_order_deadlocks(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
) -> None:
    """With the project lock step removed (the old order) the same race deadlocks."""
    project, sprint, task, item, user = scenario
    with patch.object(retro_services, "lock_project_before_items", lambda _pid: None):
        results = _race(project, sprint, task, item, user)
    failures = [
        v for k in ("deleter", "saver") if isinstance(v := results.get(k), OperationalError)
    ]
    assert failures, f"expected a Postgres deadlock, got {results}"
