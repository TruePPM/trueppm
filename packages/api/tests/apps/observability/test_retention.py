"""Tests for the retention policy editor + purge runs (#693, ADR-0090).

Covers:
  - IsAdminUser gating (401 unauth / 403 non-staff) on all four endpoints
  - GET returns the five operational policies, schedule, and recent runs
  - PATCH persists RetentionPolicy overrides + schedule; weekly requires a day;
    the non-disablable sync window is forced enabled
  - resolve_retention: override (enabled) / disabled (None) / settings fallback
  - GET impact counts eligible rows without deleting
  - coordinator _execute_run records a PurgeRun and derives ok/partial/failed +
    honors on_failure=stop
  - _should_run_scheduled gating (off / before window / already-ran / due / weekday)
  - the System Health retention card flips unknown→ok/crit off PurgeRun state
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.observability import tasks as obs_tasks
from trueppm_api.apps.observability.models import (
    PurgeRun,
    RetentionPolicy,
    RetentionSchedule,
)
from trueppm_api.apps.observability.purge_registry import PurgeSpec
from trueppm_api.apps.observability.retention import resolve_retention
from trueppm_api.apps.observability.selectors import get_system_health
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

User = get_user_model()

URL = "/api/v1/health/retention/"
IMPACT_URL = "/api/v1/health/retention/impact/"
RUNS_URL = "/api/v1/health/retention/runs/"

_EXPECTED_KEYS = [
    "HISTORY_RETENTION_DAYS",
    "TASK_RUN_RETENTION_DAYS",
    "TRUEPPM_WEBHOOK_RETENTION_DAYS",
    "TRUEPPM_IMPORT_RETENTION_DAYS",
    "TRUEPPM_SYNC_BATCH_RETENTION_HOURS",
]


def _admin_client() -> APIClient:
    admin = User.objects.create_user(username="ret_admin", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


def _member_client() -> APIClient:
    user = User.objects.create_user(username="ret_member", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _fake_spec(key: str, *, rows: int = 0, fail: bool = False) -> PurgeSpec:
    def purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
        if fail:
            raise RuntimeError("boom")
        return rows

    return PurgeSpec(key=key, purge=purge, db_tables=("fake_table",))


@pytest.mark.django_db
class TestGating:
    def test_unauthenticated_rejected(self) -> None:
        anon = APIClient()
        assert anon.get(URL).status_code in (401, 403)
        assert anon.patch(URL, {}, format="json").status_code in (401, 403)
        assert anon.get(IMPACT_URL).status_code in (401, 403)
        assert anon.post(RUNS_URL, {}, format="json").status_code in (401, 403)

    def test_non_staff_forbidden(self) -> None:
        client = _member_client()
        assert client.get(URL).status_code == 403
        assert client.post(RUNS_URL, {"dry_run": True}, format="json").status_code == 403


@pytest.mark.django_db
class TestRetentionGet:
    def test_returns_five_policies_in_order(self) -> None:
        res = _admin_client().get(URL)
        assert res.status_code == 200
        keys = [p["key"] for p in res.data["policies"]]
        assert keys == _EXPECTED_KEYS

    def test_policy_rows_carry_contract_fields(self) -> None:
        res = _admin_client().get(URL)
        for row in res.data["policies"]:
            assert set(row) >= {
                "key",
                "label",
                "note",
                "unit",
                "value",
                "enabled",
                "row_count",
                "bytes",
            }

    def test_schedule_and_runs_present(self) -> None:
        res = _admin_client().get(URL)
        assert set(res.data["schedule"]) >= {
            "frequency",
            "time_of_day_utc",
            "day_of_week",
            "on_failure",
        }
        assert res.data["runs"] == []


@pytest.mark.django_db
class TestRetentionPatch:
    def test_persists_policy_override(self) -> None:
        client = _admin_client()
        res = client.patch(
            URL,
            {"policies": [{"key": "TRUEPPM_WEBHOOK_RETENTION_DAYS", "value": 3, "enabled": True}]},
            format="json",
        )
        assert res.status_code == 200
        row = RetentionPolicy.objects.get(key="TRUEPPM_WEBHOOK_RETENTION_DAYS")
        assert row.value == 3 and row.enabled is True
        # Reading back reflects the override.
        reread = next(
            p
            for p in client.get(URL).data["policies"]
            if p["key"] == "TRUEPPM_WEBHOOK_RETENTION_DAYS"
        )
        assert reread["value"] == 3

    def test_persists_schedule(self) -> None:
        client = _admin_client()
        res = client.patch(
            URL,
            {
                "schedule": {
                    "frequency": "daily",
                    "time_of_day_utc": "04:30:00",
                    "day_of_week": None,
                    "on_failure": "stop",
                }
            },
            format="json",
        )
        assert res.status_code == 200
        schedule = RetentionSchedule.objects.get(singleton_key=1)
        assert str(schedule.time_of_day_utc).startswith("04:30")
        assert schedule.on_failure == "stop"

    def test_weekly_requires_day_of_week(self) -> None:
        res = _admin_client().patch(
            URL,
            {
                "schedule": {
                    "frequency": "weekly",
                    "time_of_day_utc": "02:00:00",
                    "day_of_week": None,
                    "on_failure": "continue",
                }
            },
            format="json",
        )
        assert res.status_code == 400
        assert "day_of_week" in res.data["schedule"]

    def test_sync_window_cannot_be_disabled(self) -> None:
        _admin_client().patch(
            URL,
            {
                "policies": [
                    {"key": "TRUEPPM_SYNC_BATCH_RETENTION_HOURS", "value": 12, "enabled": False}
                ]
            },
            format="json",
        )
        row = RetentionPolicy.objects.get(key="TRUEPPM_SYNC_BATCH_RETENTION_HOURS")
        assert row.enabled is True  # forced on regardless of the request


@pytest.mark.django_db
class TestResolveRetention:
    def test_falls_back_to_settings_without_a_row(self, settings) -> None:
        settings.TRUEPPM_WEBHOOK_RETENTION_DAYS = 7
        assert resolve_retention("TRUEPPM_WEBHOOK_RETENTION_DAYS") == 7

    def test_override_value_wins(self) -> None:
        RetentionPolicy.objects.create(key="HISTORY_RETENTION_DAYS", value=120, enabled=True)
        assert resolve_retention("HISTORY_RETENTION_DAYS") == 120

    def test_disabled_override_returns_none(self) -> None:
        RetentionPolicy.objects.create(key="HISTORY_RETENTION_DAYS", value=120, enabled=False)
        assert resolve_retention("HISTORY_RETENTION_DAYS") is None


@pytest.mark.django_db
class TestImpact:
    def _old_taskrun(self, days: int) -> TaskRun:
        run = TaskRun.objects.create(
            task_name="t", celery_task_id="x", status=TaskRunStatus.SUCCESS
        )
        TaskRun.objects.filter(pk=run.pk).update(completed_at=timezone.now() - timedelta(days=days))
        return run

    def test_counts_eligible_without_deleting(self) -> None:
        self._old_taskrun(days=40)
        self._old_taskrun(days=40)
        res = _admin_client().get(IMPACT_URL, {"key": "TASK_RUN_RETENTION_DAYS", "value": 30})
        assert res.status_code == 200
        assert res.data["eligible_rows"] >= 2
        assert "eligible_bytes" in res.data
        # Nothing was deleted — impact is a pure count.
        assert TaskRun.objects.count() == 2

    def test_invalid_key_rejected(self) -> None:
        res = _admin_client().get(IMPACT_URL, {"key": "NOPE", "value": 5})
        assert res.status_code == 400


@pytest.mark.django_db
class TestCoordinator:
    def _run(self) -> PurgeRun:
        return PurgeRun.objects.create(
            trigger=PurgeRun.Trigger.MANUAL, state=PurgeRun.State.RUNNING
        )

    def test_all_ok(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "trueppm_api.apps.observability.purge_registry.get_purge_specs",
            lambda: [
                _fake_spec("HISTORY_RETENTION_DAYS", rows=5),
                _fake_spec("TASK_RUN_RETENTION_DAYS", rows=2),
            ],
        )
        run = self._run()
        obs_tasks._execute_run(run, dry_run=False)
        run.refresh_from_db()
        assert run.state == PurgeRun.State.OK
        assert run.rows_deleted == 7
        assert len(run.tables) == 2 and all(t["state"] == "ok" for t in run.tables)

    def test_partial_when_one_table_fails(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "trueppm_api.apps.observability.purge_registry.get_purge_specs",
            lambda: [
                _fake_spec("HISTORY_RETENTION_DAYS", rows=5),
                _fake_spec("TASK_RUN_RETENTION_DAYS", fail=True),
            ],
        )
        run = self._run()
        obs_tasks._execute_run(run, dry_run=False)
        run.refresh_from_db()
        assert run.state == PurgeRun.State.PARTIAL
        assert run.tables[-1]["state"] == "failed"

    def test_failed_when_all_tables_fail(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "trueppm_api.apps.observability.purge_registry.get_purge_specs",
            lambda: [_fake_spec("HISTORY_RETENTION_DAYS", fail=True)],
        )
        run = self._run()
        obs_tasks._execute_run(run, dry_run=False)
        run.refresh_from_db()
        assert run.state == PurgeRun.State.FAILED

    def test_on_failure_stop_aborts_remaining(self, monkeypatch) -> None:
        RetentionSchedule.objects.create(
            singleton_key=1, on_failure=RetentionSchedule.OnFailure.STOP
        )
        monkeypatch.setattr(
            "trueppm_api.apps.observability.purge_registry.get_purge_specs",
            lambda: [
                _fake_spec("HISTORY_RETENTION_DAYS", fail=True),
                _fake_spec("TASK_RUN_RETENTION_DAYS", rows=9),
            ],
        )
        run = self._run()
        obs_tasks._execute_run(run, dry_run=False)
        run.refresh_from_db()
        # Aborted after the first failure — the second table is never attempted.
        assert len(run.tables) == 1


@pytest.mark.django_db
class TestScheduleGating:
    def _at(self, hour: int, minute: int = 0) -> object:
        return timezone.now().replace(hour=hour, minute=minute, second=0, microsecond=0)

    def test_off_never_runs(self) -> None:
        RetentionSchedule.objects.create(singleton_key=1, frequency=RetentionSchedule.Frequency.OFF)
        assert obs_tasks._should_run_scheduled(self._at(5)) is False

    def test_before_window_does_not_run(self) -> None:
        RetentionSchedule.objects.create(
            singleton_key=1, frequency=RetentionSchedule.Frequency.DAILY
        )
        # default window 02:00 UTC; 01:00 is before it.
        assert obs_tasks._should_run_scheduled(self._at(1)) is False

    def test_due_runs(self) -> None:
        RetentionSchedule.objects.create(
            singleton_key=1, frequency=RetentionSchedule.Frequency.DAILY
        )
        assert obs_tasks._should_run_scheduled(self._at(3)) is True

    def test_already_ran_this_window(self) -> None:
        RetentionSchedule.objects.create(
            singleton_key=1, frequency=RetentionSchedule.Frequency.DAILY
        )
        now = self._at(3)
        run = PurgeRun.objects.create(trigger=PurgeRun.Trigger.SCHEDULED, state=PurgeRun.State.OK)
        PurgeRun.objects.filter(pk=run.pk).update(started_at=self._at(2, 30))
        assert obs_tasks._should_run_scheduled(now) is False

    def test_weekly_wrong_day(self) -> None:
        now = self._at(3)
        wrong_day = (now.weekday() + 1) % 7
        RetentionSchedule.objects.create(
            singleton_key=1, frequency=RetentionSchedule.Frequency.WEEKLY, day_of_week=wrong_day
        )
        assert obs_tasks._should_run_scheduled(now) is False


@pytest.mark.django_db
class TestRunsEndpoint:
    def test_queues_manual_run(self) -> None:
        res = _admin_client().post(RUNS_URL, {"dry_run": False}, format="json")
        assert res.status_code == 202
        assert res.data["queued"] is True
        run = PurgeRun.objects.get(id=res.data["run_id"])
        assert run.trigger == PurgeRun.Trigger.MANUAL

    def test_queues_dry_run(self) -> None:
        res = _admin_client().post(RUNS_URL, {"dry_run": True}, format="json")
        assert res.status_code == 202
        run = PurgeRun.objects.get(id=res.data["run_id"])
        assert run.trigger == PurgeRun.Trigger.DRY_RUN

    def test_rejects_run_while_one_is_in_flight(self) -> None:
        PurgeRun.objects.create(trigger=PurgeRun.Trigger.MANUAL, state=PurgeRun.State.RUNNING)
        res = _admin_client().post(RUNS_URL, {"dry_run": False}, format="json")
        assert res.status_code == 409

    def test_stale_running_run_does_not_block(self) -> None:
        # A run older than the in-flight window is a dead orphan, not a live run.
        old = PurgeRun.objects.create(trigger=PurgeRun.Trigger.MANUAL, state=PurgeRun.State.RUNNING)
        PurgeRun.objects.filter(pk=old.pk).update(started_at=timezone.now() - timedelta(minutes=20))
        res = _admin_client().post(RUNS_URL, {"dry_run": False}, format="json")
        assert res.status_code == 202


@pytest.mark.django_db
class TestSystemHealthCard:
    def _card(self) -> dict:
        payload = get_system_health()
        return next(c for c in payload["components"] if c["key"] == "retention_purge")

    def test_unknown_without_runs(self) -> None:
        assert self._card()["status"] == "unknown"

    def test_ok_after_successful_run(self) -> None:
        PurgeRun.objects.create(
            trigger=PurgeRun.Trigger.SCHEDULED, state=PurgeRun.State.OK, rows_deleted=12
        )
        assert self._card()["status"] == "ok"

    def test_crit_after_failed_run(self) -> None:
        PurgeRun.objects.create(trigger=PurgeRun.Trigger.SCHEDULED, state=PurgeRun.State.FAILED)
        assert self._card()["status"] == "crit"

    def test_dry_run_does_not_flip_card(self) -> None:
        PurgeRun.objects.create(trigger=PurgeRun.Trigger.DRY_RUN, state=PurgeRun.State.OK)
        assert self._card()["status"] == "unknown"
