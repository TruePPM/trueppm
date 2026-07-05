"""Tests for the dead-letter write actions (#695, ADR-0210).

Covers the operator write slice of the System Health dead-letter inspector:

  - requeue routes through the #652 durable workflow backend (a WorkflowInstance
    is created), NOT the old raw ``send_task`` side channel;
  - requeue honours the operator-chosen backoff (carried into the workflow input);
  - drop soft-removes (→ dismissed) and records the note/operator/timestamp audit,
    retaining the row;
  - bulk requeue_all/drop_all respect the current filter set and are bounded;
  - every action is workspace-admin gated (401 unauth, 403 non-staff);
  - idempotency: the status guard blocks a double requeue, and the workflow
    idempotency key collapses a same-failure re-requeue to a single workflow.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus
from trueppm_api.apps.workflow_engine.models import WorkflowInstance
from trueppm_api.workflows.consumers.requeue_failed_task import WORKFLOW_NAME

User = get_user_model()

BASE = "/api/v1/admin/failed-tasks"


def _admin_client() -> APIClient:
    admin = User.objects.create_user(username="dl_admin", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


def _member_client() -> APIClient:
    user = User.objects.create_user(username="dl_member", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _failed(
    task_name: str = "scheduling.recalculate_schedule",
    task_id: str = "cel-1",
    status: str = FailedTaskStatus.DEAD,
    *,
    args: list | None = None,
    kwargs: dict | None = None,
) -> FailedTask:
    return FailedTask.objects.create(
        task_name=task_name,
        task_id=task_id,
        args=args if args is not None else [1, 2],
        kwargs=kwargs if kwargs is not None else {"project": "p1"},
        exception_type="ConnectionError",
        exception_message="refused",
        traceback="Traceback ...",
        status=status,
    )


@pytest.mark.django_db
class TestRequeue:
    def test_requeue_routes_through_workflow_backend(self) -> None:
        failed = _failed()
        res = _admin_client().post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        assert res.status_code == 200

        # The requeue round-tripped through the #652 durable backend: a workflow
        # instance was started (NOT a raw send_task side channel).
        instance = WorkflowInstance.objects.get(name=WORKFLOW_NAME)
        assert instance.input["task_name"] == "scheduling.recalculate_schedule"
        assert instance.input["args"] == [1, 2]
        assert instance.input["kwargs"] == {"project": "p1"}
        assert instance.input["failed_task_id"] == str(failed.id)

        # The response carries the started workflow id and the updated row.
        assert res.data["workflow_id"] == str(instance.id)
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.RETRIED
        assert failed.resolved_by is not None
        assert failed.resolved_at is not None

    def test_requeue_honours_backoff(self) -> None:
        failed = _failed()
        res = _admin_client().post(
            f"{BASE}/{failed.id}/requeue/", {"backoff_seconds": 300}, format="json"
        )
        assert res.status_code == 200
        instance = WorkflowInstance.objects.get(name=WORKFLOW_NAME)
        assert instance.input["backoff_seconds"] == 300

    def test_requeue_rejects_out_of_range_backoff(self) -> None:
        failed = _failed()
        res = _admin_client().post(
            f"{BASE}/{failed.id}/requeue/", {"backoff_seconds": 999_999}, format="json"
        )
        assert res.status_code == 400

    def test_requeue_rejects_terminal_status(self) -> None:
        failed = _failed(status=FailedTaskStatus.DISMISSED)
        res = _admin_client().post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        assert res.status_code == 400
        assert WorkflowInstance.objects.count() == 0

    def test_double_requeue_blocked_by_status_guard(self) -> None:
        failed = _failed()
        client = _admin_client()
        assert client.post(f"{BASE}/{failed.id}/requeue/", {}, format="json").status_code == 200
        # Second requeue: the row is now RETRIED (terminal) → 400, no second enqueue.
        assert client.post(f"{BASE}/{failed.id}/requeue/", {}, format="json").status_code == 400
        assert WorkflowInstance.objects.count() == 1

    def test_same_failure_requeue_is_idempotent_at_workflow_level(self) -> None:
        """A re-requeue of the *same observed failure* collapses to one workflow.

        The workflow idempotency key is ``requeue:{id}:{failure_count}``. Resetting
        the status without bumping ``failure_count`` (as a re-request would) yields
        the same key, so ``start_workflow`` returns the existing instance instead of
        enqueuing a duplicate.
        """
        failed = _failed()
        client = _admin_client()
        client.post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        # Simulate a stray re-request: same failure_count, status forced back to dead.
        FailedTask.objects.filter(pk=failed.pk).update(status=FailedTaskStatus.DEAD)
        client.post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        assert WorkflowInstance.objects.filter(name=WORKFLOW_NAME).count() == 1


@pytest.mark.django_db
class TestDrop:
    def test_drop_soft_removes_and_records_audit(self) -> None:
        failed = _failed()
        admin = User.objects.create_user(username="dropper", password="pw", is_staff=True)
        client = APIClient()
        client.force_authenticate(user=admin)

        res = client.post(f"{BASE}/{failed.id}/drop/", {"note": "vendor relay down"}, format="json")
        assert res.status_code == 200

        # Row is retained (soft-remove), not hard-deleted — the audit survives.
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DISMISSED
        assert failed.resolution_note == "vendor relay down"
        assert failed.resolved_by_id == admin.id
        assert failed.resolved_at is not None
        assert FailedTask.objects.filter(pk=failed.pk).exists()

    def test_drop_without_note_is_allowed(self) -> None:
        failed = _failed()
        res = _admin_client().post(f"{BASE}/{failed.id}/drop/", {}, format="json")
        assert res.status_code == 200
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DISMISSED
        assert failed.resolution_note == ""

    def test_drop_note_length_is_bounded(self) -> None:
        failed = _failed()
        res = _admin_client().post(f"{BASE}/{failed.id}/drop/", {"note": "x" * 1001}, format="json")
        assert res.status_code == 400

    def test_redrop_dismissed_is_idempotent_noop(self) -> None:
        failed = _failed(status=FailedTaskStatus.DISMISSED)
        res = _admin_client().post(f"{BASE}/{failed.id}/drop/", {"note": "second"}, format="json")
        assert res.status_code == 200
        failed.refresh_from_db()
        # The original (empty) note is preserved — a re-drop does not overwrite it.
        assert failed.resolution_note == ""


@pytest.mark.django_db
class TestBulkActions:
    def test_drop_all_respects_the_current_filter_set(self) -> None:
        keep = _failed(task_name="scheduling.keep", task_id="k-1")
        target_a = _failed(task_name="scheduling.relay", task_id="r-1")
        target_b = _failed(task_name="scheduling.relay", task_id="r-2")

        res = _admin_client().post(
            f"{BASE}/drop_all/?task_name=relay", {"note": "relay outage"}, format="json"
        )
        assert res.status_code == 200
        assert res.data["processed"] == 2
        assert res.data["capped"] is False

        target_a.refresh_from_db()
        target_b.refresh_from_db()
        keep.refresh_from_db()
        assert target_a.status == FailedTaskStatus.DISMISSED
        assert target_b.status == FailedTaskStatus.DISMISSED
        assert target_a.resolution_note == "relay outage"
        # The unmatched task is untouched.
        assert keep.status == FailedTaskStatus.DEAD

    def test_requeue_all_only_touches_actionable_rows_in_the_filter(self) -> None:
        dead = _failed(task_name="scheduling.relay", task_id="r-1", status=FailedTaskStatus.DEAD)
        dismissed = _failed(
            task_name="scheduling.relay", task_id="r-2", status=FailedTaskStatus.DISMISSED
        )

        res = _admin_client().post(f"{BASE}/requeue_all/?task_name=relay", {}, format="json")
        assert res.status_code == 200
        # Only the DEAD row is actionable; the dismissed one is excluded.
        assert res.data["processed"] == 1
        assert WorkflowInstance.objects.filter(name=WORKFLOW_NAME).count() == 1

        dead.refresh_from_db()
        dismissed.refresh_from_db()
        assert dead.status == FailedTaskStatus.RETRIED
        assert dismissed.status == FailedTaskStatus.DISMISSED

    def test_bulk_is_bounded_and_reports_capped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from trueppm_api.apps.scheduling import views

        monkeypatch.setattr(views, "FAILED_TASK_BULK_ACTION_MAX", 1)
        for i in range(3):
            _failed(task_name="scheduling.relay", task_id=f"r-{i}")

        res = _admin_client().post(f"{BASE}/drop_all/", {}, format="json")
        assert res.status_code == 200
        assert res.data["processed"] == 1
        assert res.data["matched"] == 3
        assert res.data["capped"] is True
        # Exactly one row was dropped despite three matching.
        assert FailedTask.objects.filter(status=FailedTaskStatus.DISMISSED).count() == 1


@pytest.mark.django_db
class TestPermissions:
    @pytest.mark.parametrize(
        "path_suffix,body",
        [
            ("/{id}/requeue/", {}),
            ("/{id}/drop/", {}),
            ("/requeue_all/", {}),
            ("/drop_all/", {}),
        ],
    )
    def test_unauthenticated_is_denied(self, path_suffix: str, body: dict) -> None:
        failed = _failed()
        url = BASE + path_suffix.format(id=failed.id)
        assert APIClient().post(url, body, format="json").status_code in (401, 403)

    @pytest.mark.parametrize(
        "path_suffix,body",
        [
            ("/{id}/requeue/", {}),
            ("/{id}/drop/", {}),
            ("/requeue_all/", {}),
            ("/drop_all/", {}),
        ],
    )
    def test_non_staff_is_forbidden(self, path_suffix: str, body: dict) -> None:
        failed = _failed()
        url = BASE + path_suffix.format(id=failed.id)
        assert _member_client().post(url, body, format="json").status_code == 403
        # No mutation leaked through the gate.
        assert WorkflowInstance.objects.count() == 0
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD
