"""Lock order for retro writers against task soft-delete and sprint state changes (#4628).

The global order is: carryover target sprint row, then the project row (the sync
cursor draw), then ``RetroActionItem`` rows. A Task soft-delete takes the project
lock first and then updates items through ``reset_promoted_task_on_delete``; retro
save and carryover used to lock items first, so they could deadlock against it.
Activate, cancel and ``close_sprint`` lock a sprint and then draw a cursor, so
carryover must lock its target sprint before the project too.

Each race is forced, not hoped for: the holder thread takes its first locks and
refuses to take the rest until the contender is observably blocked in Postgres on a
lock. Under a wrong order the contender holds a lock the holder then needs, the
cycle closes, and Postgres aborts one side; every fix test has a negative control
that patches the old order back in and asserts exactly that deadlock.

Promote is not raced here: ``promote_retro_action_item`` calls
``lock_project_before_items`` before it locks the item, and the soft-delete also
locks the project and then items, so the two already share one order.

``_cancel_holder`` and ``_close_carry_holder`` model the lock sequence of the real
activate/cancel and ``close_sprint`` paths; they do not drive that code. A future
Task ``post_save`` receiver that UPDATEs the target Sprint row would reintroduce the
close deadlock while these tests stay green. The project soft-delete cascade takes
the project row before sprints, which can still cycle with a carryover (#4959).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import OperationalError, connection, connections, transaction
from django.db.transaction import TransactionManagementError
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


def _hold_and_contend(
    holder: Callable[[Callable[[], None]], Any], contender: Callable[[], Any]
) -> dict[str, Any]:
    """Run ``holder`` and ``contender`` on two connections with a forced interleaving.

    ``holder`` takes its first locks and then calls ``gate()``, which does not return
    until the contender's backend is observably waiting on a Postgres lock. Only then
    does the holder take its remaining locks, so a lock-order cycle is closed every
    run rather than by luck.
    """
    contender_pid: list[int] = []
    contender_ready = threading.Event()
    holder_holds = threading.Event()
    results: dict[str, Any] = {}

    def gate() -> None:
        holder_holds.set()
        assert contender_ready.wait(_TIMEOUT)
        results["contender_blocked"] = _wait_until_blocked_on_lock(contender_pid[0])

    def run_holder() -> None:
        try:
            results["holder"] = holder(gate)
        except Exception as exc:
            results["holder"] = exc
        finally:
            connections.close_all()

    def run_contender() -> None:
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT pg_backend_pid()")
                contender_pid.append(cur.fetchone()[0])
            assert holder_holds.wait(_TIMEOUT)
            contender_ready.set()
            results["contender"] = contender()
        except Exception as exc:
            results["contender"] = exc
        finally:
            connections.close_all()

    threads = [threading.Thread(target=run_holder), threading.Thread(target=run_contender)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(_TIMEOUT * 2)
    return results


def _soft_delete_holder(task: Task) -> Callable[[Callable[[], None]], str]:
    """Soft-delete ``task``, pausing while it holds the project and task row locks."""

    def holder(gate: Callable[[], None]) -> str:
        original = retro_services.reset_promoted_task_on_delete

        def gated_reset(task_id: str) -> None:
            # Reached only after Task.save() drew its cursor, i.e. holding the project lock.
            gate()
            original(task_id)

        with (
            patch.object(retro_services, "reset_promoted_task_on_delete", gated_reset),
            transaction.atomic(),
        ):
            Task.objects.get(pk=task.pk).soft_delete()
        return "ok"

    return holder


def _retro_save(sprint: Sprint, item: RetroActionItem, user: Any) -> Callable[[], int]:
    def contender() -> int:
        client = APIClient()
        client.force_authenticate(user=user)
        resp = client.post(
            f"/api/v1/sprints/{sprint.pk}/retro/",
            {"notes": "n", "action_items": [{"id": str(item.pk), "text": "edited"}]},
            format="json",
        )
        return resp.status_code

    return contender


def _carryover(item: RetroActionItem, target: Sprint, user: Any) -> Callable[[], Task]:
    def contender() -> Task:
        return retro_services.pull_carryover_item_to_sprint(
            RetroActionItem.objects.get(pk=item.pk), Sprint.objects.get(pk=target.pk), user
        )

    return contender


def _deadlocked(
    results: dict[str, Any], caplog: pytest.LogCaptureFixture | None = None
) -> list[Exception]:
    """The exceptions showing Postgres broke a lock cycle, whichever side it picked.

    A real ``OperationalError`` naming a deadlock counts on either side. Pass
    ``caplog`` only for controls where the soft-delete thread can be the victim:
    the receiver wraps ``reset_promoted_task_on_delete`` in ``except Exception`` and
    swallows the ``DeadlockDetected``, so the delete surfaces it as a
    ``TransactionManagementError`` from the next receiver. That alone proves nothing
    (any swallowed error would do it), so it counts only when the swallowed
    exception that was logged is itself a deadlock.
    """
    swallowed_deadlock = caplog is not None and any(
        r.exc_info and "deadlock detected" in str(r.exc_info[1]) for r in caplog.records
    )
    found: list[Exception] = []
    for key in ("holder", "contender"):
        v = results.get(key)
        if (isinstance(v, OperationalError) and "deadlock" in str(v)) or (
            key == "holder" and isinstance(v, TransactionManagementError) and swallowed_deadlock
        ):
            found.append(v)
    return found


@pytest.fixture
def scenario(db: object) -> tuple[Project, Sprint, Task, RetroActionItem, Any]:
    """A completed sprint whose retro item was promoted to ``task``, plus a PLANNED sprint."""
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
    Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.PLANNED,
    )
    return project, sprint, task, item, user


def _planned(project: Project) -> Sprint:
    return Sprint.objects.get(project=project, state=SprintState.PLANNED)


@pytest.mark.django_db(transaction=True)
def test_retro_save_and_promoted_task_soft_delete_do_not_deadlock(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
) -> None:
    _project, sprint, task, item, user = scenario
    results = _hold_and_contend(_soft_delete_holder(task), _retro_save(sprint, item, user))
    assert results["contender_blocked"] is True
    assert results["holder"] == "ok"
    assert results["contender"] == 200
    assert RetroActionItem.objects.get(pk=item.pk).promoted_task_id is None


@pytest.mark.django_db(transaction=True)
def test_negative_control_item_first_order_deadlocks(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """With the project lock step removed (the old order) the same race deadlocks."""
    _project, sprint, task, item, user = scenario
    with patch.object(retro_services, "lock_project_before_items", lambda _pid: None):
        results = _hold_and_contend(_soft_delete_holder(task), _retro_save(sprint, item, user))
    assert _deadlocked(results, caplog), f"expected a Postgres deadlock, got {results}"


@pytest.mark.django_db(transaction=True)
def test_carryover_and_promoted_task_soft_delete_do_not_deadlock(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
) -> None:
    project, _sprint, task, item, user = scenario
    target = _planned(project)
    results = _hold_and_contend(_soft_delete_holder(task), _carryover(item, target, user))
    assert results["contender_blocked"] is True
    assert results["holder"] == "ok"
    # The delete freed the item first, so the carryover promoted it afresh.
    moved = results["contender"]
    assert isinstance(moved, Task), results
    assert moved.pk != task.pk
    assert moved.sprint_id == target.pk


@pytest.mark.django_db(transaction=True)
def test_negative_control_carryover_item_first_order_deadlocks(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    project, _sprint, task, item, user = scenario
    target = _planned(project)
    with patch.object(retro_services, "lock_project_before_items", lambda _pid: None):
        results = _hold_and_contend(_soft_delete_holder(task), _carryover(item, target, user))
    assert _deadlocked(results, caplog), f"expected a Postgres deadlock, got {results}"


def _cancel_holder(target: Sprint) -> Callable[[Callable[[], None]], str]:
    """The cancel action's lock sequence: sprint row, then its save's cursor draw."""

    def holder(gate: Callable[[], None]) -> str:
        with transaction.atomic():
            sprint = Sprint.objects.select_for_update().get(pk=target.pk)
            gate()
            sprint.state = SprintState.CANCELLED
            sprint.save(update_fields=["state"])
        return "ok"

    return holder


@pytest.mark.django_db(transaction=True)
def test_carryover_and_target_sprint_cancel_do_not_deadlock(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
) -> None:
    """Cancel (and activate) lock a PLANNED sprint, then draw a project cursor."""
    project, _sprint, _task, item, user = scenario
    target = _planned(project)
    results = _hold_and_contend(_cancel_holder(target), _carryover(item, target, user))
    assert results["contender_blocked"] is True
    assert results["holder"] == "ok"
    assert isinstance(results["contender"], ValidationError), results


@pytest.mark.django_db(transaction=True)
def test_negative_control_carryover_project_before_sprint_deadlocks(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
) -> None:
    """Project lock first, sprint second (the order of the first #4628 fix) deadlocks."""
    project, _sprint, _task, item, user = scenario
    target = _planned(project)

    def project_then_sprint(pk: Any) -> Sprint:
        retro_services.lock_project_before_items(project.pk)
        return Sprint.objects.select_for_update().get(pk=pk)

    with patch.object(retro_services, "_lock_carryover_target_sprint", project_then_sprint):
        results = _hold_and_contend(_cancel_holder(target), _carryover(item, target, user))
    assert _deadlocked(results), f"expected a Postgres deadlock, got {results}"


def _close_carry_holder(
    active: Sprint, carried: Task, target: Sprint
) -> Callable[[Callable[[], None]], str]:
    """close_sprint's sequence: active sprint row, its save's cursor, then move a task
    into ``carry_over_to`` (whose foreign key takes FOR KEY SHARE on the target)."""

    def holder(gate: Callable[[], None]) -> str:
        with transaction.atomic():
            sprint = Sprint.objects.select_for_update().get(pk=active.pk)
            sprint.save()
            gate()
            moved = Task.objects.get(pk=carried.pk)
            moved.sprint_id = target.pk
            moved.save()
        return "ok"

    return holder


@pytest.fixture
def closing(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
) -> tuple[Sprint, Task]:
    project = scenario[0]
    active = Sprint.objects.create(
        project=project,
        name="S1b",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )
    carried = Task.objects.create(project=project, name="C", duration=1, sprint=active)
    return active, carried


@pytest.mark.django_db(transaction=True)
def test_carryover_and_close_carrying_into_same_sprint_do_not_deadlock(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
    closing: tuple[Sprint, Task],
) -> None:
    """Why the target lock is FOR NO KEY UPDATE: close moves tasks into it under the
    project lock, and their FK key-share must not wait on the carryover."""
    project, _sprint, _task, item, user = scenario
    active, carried = closing
    target = _planned(project)
    results = _hold_and_contend(
        _close_carry_holder(active, carried, target), _carryover(item, target, user)
    )
    assert results["contender_blocked"] is True
    assert results["holder"] == "ok"
    assert isinstance(results["contender"], Task), results


@pytest.mark.django_db(transaction=True)
def test_negative_control_carryover_for_update_target_deadlocks_with_close(
    scenario: tuple[Project, Sprint, Task, RetroActionItem, Any],
    closing: tuple[Sprint, Task],
) -> None:
    project, _sprint, _task, item, user = scenario
    active, carried = closing
    target = _planned(project)
    with patch.object(
        retro_services,
        "_lock_carryover_target_sprint",
        lambda pk: Sprint.objects.select_for_update().get(pk=pk),
    ):
        results = _hold_and_contend(
            _close_carry_holder(active, carried, target), _carryover(item, target, user)
        )
    assert _deadlocked(results), f"expected a Postgres deadlock, got {results}"
