"""The asynchronous contract of POST /api/v1/projects/<pk>/monte-carlo/ (#2273).

Every test here requests ``mc_async``, which switches off the conftest shim that
runs a queued simulation to completion — these pin the 202 handle, the PENDING run,
the on_commit dispatch, and what the worker records, rather than the forecast.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from typing import Any
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.tasks import execute_monte_carlo_task_run
from trueppm_api.apps.scheduling.views import MC_TASK_NAME, mc_latest_cache_key
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

User = get_user_model()

_APPLY_ASYNC = "trueppm_api.apps.scheduling.tasks.run_monte_carlo_simulation.apply_async"
_CELERY_TASK = SimpleNamespace(request=SimpleNamespace(id="test-celery-id"), name="test")


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="MC Async", start_date=date(2026, 1, 5), calendar=calendar)
    Task.objects.create(
        project=p,
        name="T1",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=10,
    )
    return p


def _client(project: Project, username: str, role: int) -> tuple[APIClient, Any]:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c, user


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/monte-carlo/"


def _run_queued(run: TaskRun, project: Project, **overrides: Any) -> Any:
    kwargs: dict[str, Any] = {
        "n_simulations": 100,
        "n_explicit": True,
        "user_id": run.initiated_by_id,
        "persist": False,
    }
    kwargs.update(overrides)
    return execute_monte_carlo_task_run(_CELERY_TASK, str(run.pk), str(project.pk), **kwargs)


@pytest.mark.django_db
class TestQueueing:
    def test_returns_202_with_a_pending_run_and_no_simulation(
        self, mc_async: None, project: Project, django_capture_on_commit_callbacks: Any
    ) -> None:
        client, user = _client(project, "mc_member", Role.MEMBER)
        with (
            mock.patch("trueppm_scheduler.engine.monte_carlo") as engine,
            mock.patch(_APPLY_ASYNC) as apply_async,
            django_capture_on_commit_callbacks(execute=True),
        ):
            resp = client.post(_url(project), {"n_simulations": 100}, format="json")

        assert resp.status_code == 202, resp.data
        assert resp.data["queued"] is True
        assert resp.data["status"] == "pending"
        assert resp.data["n_simulations"] == 100
        run = TaskRun.objects.get(pk=resp.data["task_run_id"])
        assert run.status == TaskRunStatus.PENDING
        assert run.task_name == MC_TASK_NAME
        assert run.project_id == project.pk
        assert run.initiated_by_id == user.pk
        # The request thread never simulates; it only publishes after commit.
        engine.assert_not_called()
        apply_async.assert_called_once()
        call = apply_async.call_args.kwargs
        assert call["args"] == [str(run.pk), str(project.pk)]
        assert call["kwargs"] == {
            "n_simulations": 100,
            "n_explicit": True,
            "user_id": user.pk,
            # A Member refreshes the forecast but records no attributed row (#1502).
            "persist": False,
        }

    def test_dispatch_waits_for_commit(
        self, mc_async: None, project: Project, django_capture_on_commit_callbacks: Any
    ) -> None:
        client, _ = _client(project, "mc_member", Role.MEMBER)
        with (
            mock.patch(_APPLY_ASYNC) as apply_async,
            django_capture_on_commit_callbacks(execute=False) as callbacks,
        ):
            resp = client.post(_url(project), {}, format="json")
        assert resp.status_code == 202
        assert resp.data["n_simulations"] is None
        apply_async.assert_not_called()
        assert len(callbacks) == 1

    def test_scheduler_run_is_queued_to_persist(
        self, mc_async: None, project: Project, django_capture_on_commit_callbacks: Any
    ) -> None:
        client, _ = _client(project, "mc_sched", Role.SCHEDULER)
        with (
            mock.patch(_APPLY_ASYNC) as apply_async,
            django_capture_on_commit_callbacks(execute=True),
        ):
            assert client.post(_url(project), {}, format="json").status_code == 202
        assert apply_async.call_args.kwargs["kwargs"]["persist"] is True

    def test_broker_failure_fails_the_run_instead_of_stranding_it(
        self, mc_async: None, project: Project, django_capture_on_commit_callbacks: Any
    ) -> None:
        client, _ = _client(project, "mc_member", Role.MEMBER)
        with (
            mock.patch(_APPLY_ASYNC, side_effect=ConnectionError("broker down")),
            django_capture_on_commit_callbacks(execute=True),
        ):
            resp = client.post(_url(project), {}, format="json")
        assert resp.status_code == 202
        run = TaskRun.objects.get(pk=resp.data["task_run_id"])
        assert run.status == TaskRunStatus.FAILED
        assert run.result_summary["error"] == "simulation_queue_unavailable"
        assert run.result_summary["status_code"] == 503

    def test_size_cap_refuses_synchronously_and_queues_nothing(
        self, mc_async: None, project: Project, settings: Any
    ) -> None:
        settings.MC_TASK_CAP = 0
        client, _ = _client(project, "mc_member", Role.MEMBER)
        resp = client.post(_url(project), {}, format="json")
        assert resp.status_code == 402
        assert resp.data["error"] == "simulation_cap_exceeded"
        assert not TaskRun.objects.filter(project=project).exists()

    def test_invalid_n_simulations_refuses_synchronously(
        self, mc_async: None, project: Project
    ) -> None:
        client, _ = _client(project, "mc_member", Role.MEMBER)
        resp = client.post(_url(project), {"n_simulations": 0}, format="json")
        assert resp.status_code == 400
        assert not TaskRun.objects.filter(project=project).exists()

    def test_non_member_is_forbidden(self, mc_async: None, project: Project) -> None:
        outsider = User.objects.create_user(username="mc_outsider", password="pw")
        c = APIClient()
        c.force_authenticate(user=outsider)
        assert c.post(_url(project), {}, format="json").status_code in (403, 404)
        assert not TaskRun.objects.filter(project=project).exists()

    def test_viewer_may_queue_a_run_that_records_no_history(
        self, mc_async: None, project: Project, django_capture_on_commit_callbacks: Any
    ) -> None:
        # A run is Member-level (any member refreshes the forecast); only the
        # attributed history row is Scheduler+ (#1502), so a Viewer queues with
        # persist=False rather than being refused.
        client, _ = _client(project, "mc_viewer", Role.VIEWER)
        with (
            mock.patch(_APPLY_ASYNC) as apply_async,
            django_capture_on_commit_callbacks(execute=True),
        ):
            resp = client.post(_url(project), {}, format="json")
        assert resp.status_code == 202
        assert apply_async.call_args.kwargs["kwargs"]["persist"] is False

    def test_explicit_count_above_the_static_cap_refuses_synchronously(
        self, mc_async: None, project: Project, settings: Any
    ) -> None:
        settings.MC_SIMULATION_CAP = 10
        client, _ = _client(project, "mc_member", Role.MEMBER)
        with mock.patch(_APPLY_ASYNC) as apply_async:
            resp = client.post(_url(project), {"n_simulations": 11}, format="json")
        assert resp.status_code == 402
        assert resp.data["error"] == "simulation_cap_exceeded"
        assert resp.data["tier"] == "team"
        assert "max_runs=10" in resp.data["message"]
        apply_async.assert_not_called()
        assert not TaskRun.objects.filter(project=project).exists()
        # At the cap is admitted.
        with mock.patch(_APPLY_ASYNC):
            at_cap = client.post(_url(project), {"n_simulations": 10}, format="json")
        assert at_cap.status_code == 202

    def test_throttle_still_applies_to_the_enqueue(
        self, mc_async: None, project: Project, django_capture_on_commit_callbacks: Any
    ) -> None:
        client, _ = _client(project, "mc_member", Role.MEMBER)
        with (
            mock.patch.object(
                ScopedRateThrottle,
                "THROTTLE_RATES",
                {**ScopedRateThrottle.THROTTLE_RATES, "monte_carlo": "2/min"},
            ),
            mock.patch(_APPLY_ASYNC),
            django_capture_on_commit_callbacks(execute=True),
        ):
            codes = [client.post(_url(project), {}, format="json").status_code for _ in range(3)]
        assert codes == [202, 202, 429]
        assert TaskRun.objects.filter(project=project).count() == 2


@pytest.mark.django_db
class TestWorker:
    def _queue(self, project: Project, client: APIClient, body: dict[str, Any]) -> TaskRun:
        with mock.patch(_APPLY_ASYNC):
            resp = client.post(_url(project), body, format="json")
        assert resp.status_code == 202
        return TaskRun.objects.get(pk=resp.data["task_run_id"])

    def test_success_records_the_run_and_refreshes_latest(
        self, mc_async: None, project: Project
    ) -> None:
        client, user = _client(project, "mc_sched", Role.SCHEDULER)
        run = self._queue(project, client, {"n_simulations": 100})
        cache.delete(mc_latest_cache_key(project.pk))

        summary = _run_queued(run, project, user_id=user.pk, persist=True)

        run.refresh_from_db()
        assert run.status == TaskRunStatus.SUCCESS
        assert run.celery_task_id == "test-celery-id"
        assert run.started_at is not None and run.completed_at is not None
        assert run.result_summary == summary
        assert run.result_summary["n_simulations"] == 100
        persisted = MonteCarloRun.objects.get(project=project)
        assert run.result_summary["run_id"] == str(persisted.pk)
        assert persisted.triggered_by_id == user.pk
        # The client's next read is the latest forecast the worker cached.
        latest = client.get(f"{_url(project)}latest/")
        assert latest.status_code == 200
        assert latest.data["n_simulations"] == 100
        # And the run itself is readable by any member, not only its author.
        viewer, _ = _client(project, "mc_viewer", Role.VIEWER)
        polled = viewer.get(f"/api/v1/projects/{project.pk}/task-runs/{run.pk}/")
        assert polled.status_code == 200
        assert polled.data["status"] == "success"

    def test_member_run_refreshes_latest_without_a_history_row(
        self, mc_async: None, project: Project
    ) -> None:
        client, user = _client(project, "mc_member", Role.MEMBER)
        run = self._queue(project, client, {})
        _run_queued(run, project, user_id=user.pk, persist=False, n_explicit=False)
        run.refresh_from_db()
        assert run.status == TaskRunStatus.SUCCESS
        assert run.result_summary["run_id"] is None
        assert not MonteCarloRun.objects.filter(project=project).exists()
        assert cache.get(mc_latest_cache_key(project.pk)) is not None

    def test_engine_refusal_is_a_failed_run_every_member_can_read(
        self, mc_async: None, project: Project, settings: Any
    ) -> None:
        client, _ = _client(project, "mc_member", Role.MEMBER)
        run = self._queue(project, client, {"n_simulations": 50})
        # The cap tightened while the run waited in the queue: the engine refuses.
        settings.MC_SIMULATION_CAP = 10

        assert _run_queued(run, project, n_simulations=50) is None

        run.refresh_from_db()
        assert run.status == TaskRunStatus.FAILED
        assert run.result_summary["status_code"] == 402
        assert run.result_summary["error"] == "simulation_cap_exceeded"
        polled = client.get(f"/api/v1/projects/{project.pk}/task-runs/{run.pk}/")
        assert polled.data["result_summary"]["status_code"] == 402
        # The raw exception text stays Admin-only; the refusal body is the public answer.
        assert polled.data["error_detail"] == ""

    def test_project_deleted_while_queued_exits_cleanly(
        self, mc_async: None, project: Project
    ) -> None:
        client, _ = _client(project, "mc_member", Role.MEMBER)
        run = self._queue(project, client, {})
        # A hard project delete CASCADEs its TaskRun rows; drop the row directly so
        # the test does not depend on what else protects the project from deletion.
        TaskRun.objects.filter(pk=run.pk).delete()
        result = execute_monte_carlo_task_run(
            _CELERY_TASK,
            str(run.pk),
            str(project.pk),
            n_simulations=100,
            n_explicit=False,
            user_id=None,
            persist=False,
        )
        assert result is None


@pytest.mark.django_db
class TestWorkerRechecks:
    """The worker re-checks what the request checked, because a run can wait in the queue."""

    def _queue(self, project: Project, client: APIClient, body: dict[str, Any]) -> TaskRun:
        with mock.patch(_APPLY_ASYNC):
            resp = client.post(_url(project), body, format="json")
        assert resp.status_code == 202
        return TaskRun.objects.get(pk=resp.data["task_run_id"])

    def test_archived_while_queued_fails_without_writing(
        self, mc_async: None, project: Project
    ) -> None:
        client, user = _client(project, "mc_sched", Role.SCHEDULER)
        run = self._queue(project, client, {"n_simulations": 100})
        cache.delete(mc_latest_cache_key(project.pk))
        Project.objects.filter(pk=project.pk).update(is_archived=True)

        with mock.patch("trueppm_scheduler.engine.monte_carlo") as engine:
            assert _run_queued(run, project, user_id=user.pk, persist=True) is None

        run.refresh_from_db()
        assert run.status == TaskRunStatus.FAILED
        assert run.result_summary["status_code"] == 403
        engine.assert_not_called()
        assert not MonteCarloRun.objects.filter(project=project).exists()
        assert cache.get(mc_latest_cache_key(project.pk)) is None

    def test_membership_removed_while_queued_fails(self, mc_async: None, project: Project) -> None:
        client, user = _client(project, "mc_member", Role.MEMBER)
        run = self._queue(project, client, {})
        ProjectMembership.objects.filter(project=project, user=user).delete()

        assert _run_queued(run, project, user_id=user.pk) is None

        run.refresh_from_db()
        assert run.status == TaskRunStatus.FAILED
        assert run.result_summary["status_code"] == 403
        assert cache.get(mc_latest_cache_key(project.pk)) is None

    def test_scheduler_demoted_while_queued_records_no_history_row(
        self, mc_async: None, project: Project
    ) -> None:
        client, user = _client(project, "mc_sched", Role.SCHEDULER)
        run = self._queue(project, client, {"n_simulations": 100})
        ProjectMembership.objects.filter(project=project, user=user).update(role=Role.MEMBER)

        _run_queued(run, project, user_id=user.pk, persist=True)

        run.refresh_from_db()
        # Still a member, so the forecast refreshes; no longer Scheduler, so the
        # request's persist decision is downgraded rather than honored.
        assert run.status == TaskRunStatus.SUCCESS
        assert run.result_summary["run_id"] is None
        assert not MonteCarloRun.objects.filter(project=project).exists()

    def test_redelivery_of_a_finished_run_is_a_no_op(
        self, mc_async: None, project: Project
    ) -> None:
        client, user = _client(project, "mc_sched", Role.SCHEDULER)
        run = self._queue(project, client, {"n_simulations": 100})
        _run_queued(run, project, user_id=user.pk, persist=True)
        run.refresh_from_db()
        assert run.status == TaskRunStatus.SUCCESS
        settled = (run.started_at, run.completed_at, run.result_summary)

        # acks_late redelivers the same message after the run settled.
        with mock.patch("trueppm_scheduler.engine.monte_carlo") as engine:
            assert _run_queued(run, project, user_id=user.pk, persist=True) is None

        run.refresh_from_db()
        assert run.status == TaskRunStatus.SUCCESS
        assert (run.started_at, run.completed_at, run.result_summary) == settled
        engine.assert_not_called()
        assert MonteCarloRun.objects.filter(project=project).count() == 1

    def test_cancel_requested_while_pending_skips_the_simulation(
        self, mc_async: None, project: Project
    ) -> None:
        from trueppm_api.apps.taskruns.tracker import TaskRunTracker

        client, user = _client(project, "mc_member", Role.MEMBER)
        run = self._queue(project, client, {})
        cancel_flag = mock.Mock()
        cancel_flag.exists.return_value = True  # the cancel endpoint set the key

        with (
            mock.patch.object(TaskRunTracker, "_get_redis", return_value=cancel_flag),
            mock.patch("trueppm_scheduler.engine.monte_carlo") as engine,
        ):
            assert _run_queued(run, project, user_id=user.pk) is None

        run.refresh_from_db()
        assert run.status == TaskRunStatus.CANCELLED
        engine.assert_not_called()
        assert cache.get(mc_latest_cache_key(project.pk)) is None

    def test_member_run_after_the_cache_expires_falls_back_to_the_last_scheduler_row(
        self, mc_async: None, project: Project
    ) -> None:
        sched, sched_user = _client(project, "mc_sched", Role.SCHEDULER)
        member, member_user = _client(project, "mc_member", Role.MEMBER)
        first = self._queue(project, sched, {"n_simulations": 100})
        _run_queued(first, project, user_id=sched_user.pk, persist=True)
        second = self._queue(project, member, {"n_simulations": 200})
        _run_queued(second, project, user_id=member_user.pk, n_simulations=200)
        assert member.get(f"{_url(project)}latest/").data["n_simulations"] == 200

        # The Member's forecast lives only in the 24 h cache (#1502). Once it is
        # gone, latest/ serves the last persisted (Scheduler) run, not the
        # Member's newer one — documented in ADR-1430.
        cache.delete(mc_latest_cache_key(project.pk))
        latest = member.get(f"{_url(project)}latest/").data
        assert latest["n_simulations"] == 100
        assert latest["from_history"] is True
