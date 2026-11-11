"""Tests for the dead-letter write actions (#695, ADR-0210).

Covers the operator write slice of the System Health dead-letter inspector:

  - requeue routes through the #652 durable workflow backend (a WorkflowInstance
    is created), NOT the old raw ``send_task`` side channel;
  - requeue honours the operator-chosen backoff (carried into the workflow input);
  - drop soft-removes (→ dismissed) and records the note/operator/timestamp audit,
    retaining the row;
  - bulk requeue_all/drop_all respect the current filter set and are bounded;
  - every action is workspace-operator gated (401 unauth, 403 non-operator) — moved
    off Django ``is_staff``/``IsAdminUser`` onto ``IsWorkspaceOperator`` (superuser)
    by #4009, since ``is_staff`` was an undocumented second admin axis ungoverned
    by ``WorkspaceRole``;
  - idempotency: the status guard blocks a double requeue, and the workflow
    idempotency key collapses a same-failure re-requeue to a single workflow.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus
from trueppm_api.apps.workflow_engine.models import WorkflowInstance
from trueppm_api.workflows.consumers.requeue_failed_task import WORKFLOW_NAME
from trueppm_api.workflows.interface import NonRetryableError

User = get_user_model()

BASE = "/api/v1/admin/failed-tasks"


def _admin_client() -> APIClient:
    """A workspace operator (Django superuser) — the only principal that passes."""
    admin = User.objects.create_user(username="dl_admin", password="pw", is_superuser=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


def _member_client() -> APIClient:
    user = User.objects.create_user(username="dl_member", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _staff_only_client() -> APIClient:
    """An ``is_staff=True`` account with no workspace role or superuser flag.

    Pre-#4009 this passed ``IsAdminUser``. Post-#4009 it is refused — ``is_staff``
    is no longer a second, undocumented admin axis on this surface (#4009).
    """
    user = User.objects.create_user(username="dl_staff_only", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _workspace_admin_client(grant_workspace_admin: Callable[[Any], Any]) -> APIClient:
    """A stored ``WorkspaceRole.ADMIN`` — not the same principal as the operator.

    ``IsWorkspaceOperator`` checks ``is_superuser`` only; it does not resolve a
    workspace ADMIN membership the way ``IsWorkspaceAdminStrict`` does. This client
    is refused, and that is the point: dead-letter recovery is install-operator
    work, not a role a workspace owner can hand out in-app (#4009).
    """
    user = grant_workspace_admin(User.objects.create_user(username="dl_ws_admin", password="pw"))
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


def _run_requeue_workflow(
    instance: WorkflowInstance, redispatch_error: Exception | None = None
) -> None:
    """Drive the requeue workflow's pending step as the Celery worker would.

    Under the test transaction ``on_commit`` never fires, so the step is advanced
    explicitly; the broker hop is patched.
    """
    from unittest.mock import patch

    from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow, WorkflowOutboxStatus
    from trueppm_api.apps.workflow_engine.tasks import _do_advance

    row = WorkflowOutboxRow.objects.filter(
        workflow=instance, status=WorkflowOutboxStatus.PENDING
    ).first()
    assert row is not None
    with patch(
        "trueppm_api.apps.scheduling.services.redispatch_dead_lettered_task",
        side_effect=redispatch_error,
        return_value="celery-new",
    ):
        _do_advance(str(row.id))


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
        # RETRIED is an outcome, not a request-time claim (#2994): until the workflow
        # has actually re-dispatched, the row stays actionable.
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD
        assert failed.resolved_by is None

        _run_requeue_workflow(instance)
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.RETRIED
        assert failed.resolved_by is not None
        assert failed.resolved_at is not None

    def test_failed_redispatch_does_not_read_as_resolved(self) -> None:
        failed = _failed()
        client = _admin_client()
        client.post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        instance = WorkflowInstance.objects.get(name=WORKFLOW_NAME)
        _run_requeue_workflow(instance, redispatch_error=NonRetryableError("broker gone"))
        instance.refresh_from_db()
        assert instance.status == "failed"
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD  # still actionable, never RETRIED

        # And the operator's retry is a real re-run, not the failed instance back.
        res = client.post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        assert res.status_code == 200
        instance.refresh_from_db()
        assert instance.status == "running"
        _run_requeue_workflow(instance)
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.RETRIED

    def test_transient_broker_failure_keeps_row_dead_while_workflow_retries(self) -> None:
        """A broker blip is retried by the engine; the dead letter must not move."""
        from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow

        failed = _failed()
        _admin_client().post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        instance = WorkflowInstance.objects.get(name=WORKFLOW_NAME)
        _run_requeue_workflow(instance, redispatch_error=ConnectionError("broker down"))

        instance.refresh_from_db()
        assert instance.status == "running"  # retrying, not failed
        row = WorkflowOutboxRow.objects.get(workflow=instance)
        assert row.status == "dead" and row.next_attempt_at is not None
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD
        assert failed.resolved_at is None

    def test_requeue_skips_a_row_dropped_while_the_workflow_waited(self) -> None:
        """The activity re-checks the row: a drop in the meantime is honored."""
        from unittest.mock import patch

        from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow
        from trueppm_api.apps.workflow_engine.tasks import _do_advance

        failed = _failed()
        client = _admin_client()
        client.post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        assert client.post(f"{BASE}/{failed.id}/drop/", {}, format="json").status_code == 200
        instance = WorkflowInstance.objects.get(name=WORKFLOW_NAME)
        row = WorkflowOutboxRow.objects.get(workflow=instance)
        with patch("trueppm_api.apps.scheduling.services.redispatch_dead_lettered_task") as send:
            _do_advance(str(row.id))
        send.assert_not_called()
        instance.refresh_from_db()
        assert instance.status == "completed"
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DISMISSED  # not resurrected

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
        _run_requeue_workflow(WorkflowInstance.objects.get(name=WORKFLOW_NAME))
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
        admin = User.objects.create_user(username="dropper", password="pw", is_superuser=True)
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
            f"{BASE}/drop-all/?task_name=relay", {"note": "relay outage"}, format="json"
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

        res = _admin_client().post(f"{BASE}/requeue-all/?task_name=relay", {}, format="json")
        assert res.status_code == 200
        # Only the DEAD row is actionable; the dismissed one is excluded.
        assert res.data["processed"] == 1
        assert WorkflowInstance.objects.filter(name=WORKFLOW_NAME).count() == 1

        dead.refresh_from_db()
        dismissed.refresh_from_db()
        assert dead.status == FailedTaskStatus.DEAD  # RETRIED only once the workflow ran
        assert dismissed.status == FailedTaskStatus.DISMISSED
        _run_requeue_workflow(WorkflowInstance.objects.get(name=WORKFLOW_NAME))
        dead.refresh_from_db()
        assert dead.status == FailedTaskStatus.RETRIED

    def test_bulk_is_bounded_and_reports_capped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from trueppm_api.apps.scheduling import views

        monkeypatch.setattr(views, "FAILED_TASK_BULK_ACTION_MAX", 1)
        for i in range(3):
            _failed(task_name="scheduling.relay", task_id=f"r-{i}")

        res = _admin_client().post(f"{BASE}/drop-all/", {}, format="json")
        assert res.status_code == 200
        assert res.data["processed"] == 1
        assert res.data["matched"] == 3
        assert res.data["capped"] is True
        # Exactly one row was dropped despite three matching.
        assert FailedTask.objects.filter(status=FailedTaskStatus.DISMISSED).count() == 1

    def test_requeue_all_skips_rows_whose_requeue_is_in_flight(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A repeat "Requeue all" before workers stamp the batch moves on (#2994)."""
        from trueppm_api.apps.scheduling import views

        monkeypatch.setattr(views, "FAILED_TASK_BULK_ACTION_MAX", 1)
        for i in range(2):
            _failed(task_name="scheduling.relay", task_id=f"q-{i}")
        client = _admin_client()

        first = client.post(f"{BASE}/requeue-all/", {}, format="json")
        assert first.data["processed"] == 1
        assert first.data["capped"] is True
        second = client.post(f"{BASE}/requeue-all/", {}, format="json")
        assert second.data["processed"] == 1
        # Two distinct rows got a workflow, not the same oldest row twice.
        assert WorkflowInstance.objects.filter(name=WORKFLOW_NAME).count() == 2
        assert second.data["capped"] is False
        third = client.post(f"{BASE}/requeue-all/", {}, format="json")
        assert third.data["processed"] == 0
        assert WorkflowInstance.objects.filter(name=WORKFLOW_NAME).count() == 2

    def test_the_bound_is_actually_bound_to_a_setting(self) -> None:
        """The cap is documented as tunable, so a settings module has to bind it.

        For its whole life the view read it as
        ``getattr(settings, "FAILED_TASK_BULK_ACTION_MAX", 500)`` while NO settings
        module defined the name, so the 500 always won and an operator who set the
        env var per the System Health docs changed nothing (#2880 — the same class as
        TRUEPPM_INTEGRATION_ALLOWED_HOSTS in #2860). A `getattr` default is exactly
        what makes that invisible, so this asserts the binding exists rather than
        that the constant has a value.
        """
        from django.conf import settings

        from trueppm_api.apps.scheduling import views

        assert hasattr(settings, "FAILED_TASK_BULK_ACTION_MAX")
        assert views.FAILED_TASK_BULK_ACTION_MAX == settings.FAILED_TASK_BULK_ACTION_MAX


@pytest.mark.django_db
class TestPermissions:
    @pytest.mark.parametrize(
        "path_suffix,body",
        [
            ("/{id}/requeue/", {}),
            ("/{id}/drop/", {}),
            ("/requeue-all/", {}),
            ("/drop-all/", {}),
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
            ("/requeue-all/", {}),
            ("/drop-all/", {}),
        ],
    )
    def test_non_operator_is_forbidden(self, path_suffix: str, body: dict) -> None:
        failed = _failed()
        url = BASE + path_suffix.format(id=failed.id)
        assert _member_client().post(url, body, format="json").status_code == 403
        # No mutation leaked through the gate.
        assert WorkflowInstance.objects.count() == 0
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD

    @pytest.mark.parametrize(
        "path_suffix,body",
        [
            ("/{id}/requeue/", {}),
            ("/{id}/drop/", {}),
            ("/requeue-all/", {}),
            ("/drop-all/", {}),
        ],
    )
    def test_staff_only_is_now_forbidden(self, path_suffix: str, body: dict) -> None:
        """A formerly-allowed ``is_staff`` account with no superuser flag is refused.

        Before #4009 this account passed ``IsAdminUser``. ``IsWorkspaceOperator``
        checks ``is_superuser`` only, so ``is_staff`` alone no longer buys access to
        the dead-letter queue.
        """
        failed = _failed()
        url = BASE + path_suffix.format(id=failed.id)
        assert _staff_only_client().post(url, body, format="json").status_code == 403
        assert WorkflowInstance.objects.count() == 0
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD

    def test_staff_only_is_forbidden_on_retrieve(self) -> None:
        """The detail view (exposes ``traceback``/``args``/``kwargs``) is also refused.

        The write-action parametrization above never exercises plain ``GET``
        detail, which is the read surface #4009 was partly about — a formerly
        allowed ``is_staff`` account must not still be able to read a traceback
        even though it can no longer requeue/drop.
        """
        failed = _failed()
        url = f"{BASE}/{failed.id}/"
        assert _staff_only_client().get(url).status_code == 403

    @pytest.mark.parametrize(
        "path_suffix,body",
        [
            ("/{id}/requeue/", {}),
            ("/{id}/drop/", {}),
            ("/requeue-all/", {}),
            ("/drop-all/", {}),
        ],
    )
    def test_workspace_admin_is_not_a_workspace_operator(
        self, path_suffix: str, body: dict, grant_workspace_admin: Any
    ) -> None:
        """A stored ``WorkspaceRole.ADMIN`` is refused — it is a different principal.

        Dead-letter recovery (traceback/args/kwargs disclosure, arbitrary re-enqueue)
        is install-operator work, not lifecycle work a workspace owner can delegate
        in-app (#4009).
        """
        failed = _failed()
        url = BASE + path_suffix.format(id=failed.id)
        client = _workspace_admin_client(grant_workspace_admin)
        assert client.post(url, body, format="json").status_code == 403
        assert WorkflowInstance.objects.count() == 0
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD

    @pytest.mark.parametrize(
        "path_suffix,body",
        [
            ("/{id}/requeue/", {}),
            ("/{id}/drop/", {}),
            ("/requeue-all/", {}),
            ("/drop-all/", {}),
        ],
    )
    def test_operator_is_allowed(self, path_suffix: str, body: dict) -> None:
        """A Django superuser passes every dead-letter write action (#4009)."""
        failed = _failed()
        url = BASE + path_suffix.format(id=failed.id)
        res = _admin_client().post(url, body, format="json")
        assert res.status_code == 200


def _advance_until_settled(instance: WorkflowInstance, max_attempts: int = 3) -> None:
    """Run the requeue step and every engine retry, as the drain would.

    A transiently failed row goes DEAD with a retry clock; the drain flips it back
    to PENDING. This loop does the same, so a step that fails on every attempt
    shows up as repeated activity runs rather than a single one.
    """
    from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow, WorkflowOutboxStatus
    from trueppm_api.apps.workflow_engine.tasks import _do_advance

    for _ in range(max_attempts):
        row = WorkflowOutboxRow.objects.get(workflow=instance)
        if row.status == WorkflowOutboxStatus.DEAD and row.next_attempt_at is not None:
            WorkflowOutboxRow.objects.filter(id=row.id).update(
                status=WorkflowOutboxStatus.PENDING, next_attempt_at=None
            )
        elif row.status != WorkflowOutboxStatus.PENDING:
            return
        _do_advance(str(row.id))


@pytest.mark.django_db
class TestRequeueStampIsolation:
    """A failing RETRIED stamp must not re-dispatch the original task (#2994)."""

    def test_db_error_in_the_stamp_does_not_redispatch_again(self) -> None:
        from unittest.mock import patch

        from django.db import connection

        failed = _failed()
        _admin_client().post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        instance = WorkflowInstance.objects.get(name=WORKFLOW_NAME)

        def _broken_stamp(*_args: Any, **_kwargs: Any) -> int:
            # A real DB error aborts the enclosing savepoint, unlike a Python one.
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1/0")
            return 0

        with (
            patch(
                "trueppm_api.apps.scheduling.services.redispatch_dead_lettered_task",
                return_value="celery-new",
            ) as send,
            patch(
                "trueppm_api.apps.scheduling.services.mark_failed_task_retried",
                side_effect=_broken_stamp,
            ),
        ):
            _advance_until_settled(instance)

        instance.refresh_from_db()
        assert instance.status == "completed"
        assert send.call_count == 1
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.DEAD  # stamp failed; row stays actionable

    def test_retried_row_from_an_old_pod_is_still_redispatched(self) -> None:
        """Mixed-version rollout: an old pod stamped RETRIED at POST time."""
        from unittest.mock import patch

        failed = _failed()
        _admin_client().post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        FailedTask.objects.filter(pk=failed.pk).update(status=FailedTaskStatus.RETRIED)
        instance = WorkflowInstance.objects.get(name=WORKFLOW_NAME)
        with patch(
            "trueppm_api.apps.scheduling.services.redispatch_dead_lettered_task",
            return_value="celery-new",
        ) as send:
            _advance_until_settled(instance)
        send.assert_called_once()
        instance.refresh_from_db()
        assert instance.status == "completed"
        failed.refresh_from_db()
        assert failed.status == FailedTaskStatus.RETRIED
        assert failed.resolved_by is not None and failed.resolved_at is not None

    def test_requeue_works_against_a_legacy_backend(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A WorkflowBackend that predates ``restart_failed`` must not 500 a requeue."""
        from trueppm_api.workflows import services

        calls: list[str | None] = []

        class _Legacy:
            def start_workflow(
                self,
                name: str,
                input: dict[str, Any],
                *,
                idempotency_key: str | None = None,
                wait_for_completion: bool = False,
            ) -> str:
                calls.append(idempotency_key)
                return "legacy-id"

        monkeypatch.setattr(services, "get_backend", lambda: _Legacy())
        failed = _failed()
        res = _admin_client().post(f"{BASE}/{failed.id}/requeue/", {}, format="json")
        assert res.status_code == 200
        assert res.data["workflow_id"] == "legacy-id"
        assert len(calls) == 1


@pytest.mark.django_db(transaction=True)
def test_stamp_naming_a_deleted_user_does_not_fail_the_commit() -> None:
    """The deferred FK check fires at COMMIT, outside any try in the activity."""
    from unittest.mock import patch

    from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow, WorkflowOutboxStatus
    from trueppm_api.apps.workflow_engine.tasks import advance_workflow_step
    from trueppm_api.workflows.services import start_workflow

    failed = _failed()
    gone = User.objects.create_user(username="dl_gone", password="pw")
    with patch.object(advance_workflow_step, "delay", side_effect=ConnectionError("no broker")):
        wf_id = start_workflow(
            WORKFLOW_NAME,
            {
                "failed_task_id": str(failed.id),
                "task_name": failed.task_name,
                "args": failed.args,
                "kwargs": failed.kwargs,
                "backoff_seconds": 0,
                "resolved_by_id": gone.pk,
            },
            idempotency_key="requeue-gone-user",
        )
    gone.delete()
    instance = WorkflowInstance.objects.get(id=wf_id)
    with patch(
        "trueppm_api.apps.scheduling.services.redispatch_dead_lettered_task",
        return_value="celery-new",
    ) as send:
        _advance_until_settled(instance)
    send.assert_called_once()
    instance.refresh_from_db()
    assert instance.status == "completed"
    row = WorkflowOutboxRow.objects.get(workflow=instance)
    assert row.status == WorkflowOutboxStatus.DONE
    failed.refresh_from_db()
    assert failed.status == FailedTaskStatus.RETRIED
    assert failed.resolved_by_id is None
