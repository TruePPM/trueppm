"""Tests for the System Health overview endpoint (#692, ADR-0086).

Covers:
  - GET /api/v1/health/system/ IsAdminUser gating (401 unauth, 403 non-staff)
  - Response shape: 5 components (fixed order), beat panel, scheduled tasks,
    dead-letter summary, retention config
  - Beat component is crit when no heartbeat, ok when fresh
  - Retention-purge component is always "unknown" (no purge-run telemetry, §3)
  - Dead-letter summary reflects only DEAD rows + by-status breakdown
  - Scheduled tasks are derived from CELERY_BEAT_SCHEDULE (config, not last-run)
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.observability.models import BeatHeartbeat
from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus

User = get_user_model()

URL = "/api/v1/health/system/"

_COMPONENT_ORDER = [
    "outbox_dispatcher",
    "celery_beat",
    "dead_letter",
    "notification_dispatcher",
    "retention_purge",
]


def _admin_client() -> APIClient:
    admin = User.objects.create_user(username="sh_admin", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


def _failed(task_name: str, task_id: str, status: str = FailedTaskStatus.DEAD) -> FailedTask:
    return FailedTask.objects.create(
        task_name=task_name,
        task_id=task_id,
        args=[],
        kwargs={},
        exception_type="ConnectionError",
        exception_message="refused",
        traceback="Traceback ...",
        status=status,
    )


def _components_by_key(payload: dict) -> dict[str, dict]:
    return {c["key"]: c for c in payload["components"]}


@pytest.mark.django_db
class TestSystemHealthGating:
    def test_requires_authentication(self) -> None:
        assert APIClient().get(URL).status_code in (401, 403)

    def test_forbidden_for_non_staff(self) -> None:
        user = User.objects.create_user(username="sh_member", password="pw")
        client = APIClient()
        client.force_authenticate(user=user)
        assert client.get(URL).status_code == 403


@pytest.mark.django_db
class TestSystemHealthShape:
    def test_returns_all_components_in_order(self) -> None:
        res = _admin_client().get(URL)
        assert res.status_code == 200
        keys = [c["key"] for c in res.data["components"]]
        assert keys == _COMPONENT_ORDER
        # Every component carries the contract fields.
        for c in res.data["components"]:
            assert set(c) >= {"key", "label", "status", "state_label", "meta"}
            assert c["status"] in {"ok", "warn", "crit", "unknown"}

    def test_top_level_sections_present(self) -> None:
        data = _admin_client().get(URL).data
        assert "generated_at" in data
        assert {"last_heartbeat", "seconds_since", "stale", "stale_threshold_seconds"} <= set(
            data["beat"]
        )
        assert isinstance(data["scheduled_tasks"], list) and data["scheduled_tasks"]
        assert {"parked", "oldest_age_seconds", "top_cause", "by_status"} <= set(data["dead_letter"])
        assert isinstance(data["retention"], list) and data["retention"]

    def test_scheduled_tasks_are_config_shape(self) -> None:
        tasks = _admin_client().get(URL).data["scheduled_tasks"]
        sample = tasks[0]
        assert {"name", "task", "cadence", "category"} <= set(sample)
        # Category is one of the known buckets — derived from the task name.
        assert {t["category"] for t in tasks} <= {
            "heartbeat",
            "drain",
            "purge",
            "snapshot",
            "other",
        }

    def test_retention_config_lists_known_keys(self) -> None:
        retention = _admin_client().get(URL).data["retention"]
        keys = {r["key"] for r in retention}
        assert "TRUEPPM_WEBHOOK_RETENTION_DAYS" in keys
        assert "HISTORY_RETENTION_DAYS" in keys
        for row in retention:
            assert {"key", "label", "unit", "value", "disabled"} <= set(row)


@pytest.mark.django_db
class TestComponentStatuses:
    def test_retention_purge_is_always_unknown(self) -> None:
        """No purge-run model exists in OSS, so this degrades to unknown, not error."""
        card = _components_by_key(_admin_client().get(URL).data)["retention_purge"]
        assert card["status"] == "unknown"

    def test_beat_crit_when_no_heartbeat(self) -> None:
        data = _admin_client().get(URL).data
        assert data["beat"]["stale"] is True
        assert data["beat"]["last_heartbeat"] is None
        assert _components_by_key(data)["celery_beat"]["status"] == "crit"

    def test_beat_ok_when_fresh_heartbeat(self) -> None:
        BeatHeartbeat.objects.create(singleton_key=1, last_heartbeat=timezone.now())
        data = _admin_client().get(URL).data
        assert data["beat"]["stale"] is False
        assert _components_by_key(data)["celery_beat"]["status"] == "ok"

    def test_dead_letter_summary_counts_only_dead(self) -> None:
        _failed("scheduling.recalculate_schedule", "d-1")
        _failed("scheduling.recalculate_schedule", "d-2")
        _failed("t.dismissed", "x-1", status=FailedTaskStatus.DISMISSED)

        data = _admin_client().get(URL).data
        assert data["dead_letter"]["parked"] == 2
        assert data["dead_letter"]["top_cause"] == "ConnectionError"
        assert data["dead_letter"]["by_status"][FailedTaskStatus.DEAD] == 2
        assert data["dead_letter"]["by_status"][FailedTaskStatus.DISMISSED] == 1
        # parked > 0 → component warns (not crit, since these are fresh).
        assert _components_by_key(data)["dead_letter"]["status"] in {"warn", "crit"}

    def test_dead_letter_clear_when_no_parked(self) -> None:
        data = _admin_client().get(URL).data
        assert data["dead_letter"]["parked"] == 0
        assert _components_by_key(data)["dead_letter"]["status"] == "ok"
