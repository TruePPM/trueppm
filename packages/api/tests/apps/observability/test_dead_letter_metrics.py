"""Tests for the dead-letter Prometheus metrics endpoint (ADR-0084, issue #660).

Covers:
  - GET /api/v1/health/dead-letter/ IsAdminUser gating
  - Prometheus text exposition: content type, HELP/TYPE header, per-task gauge
  - Only DEAD (parked) tasks are counted, not dismissed/retried
  - Empty state emits the header with no series
  - Label values are escaped
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus

User = get_user_model()

URL = "/api/v1/health/dead-letter/"
METRIC = "trueppm_task_dead_letter_parked"


def _failed(task_name: str, task_id: str, status: str = FailedTaskStatus.DEAD) -> FailedTask:
    return FailedTask.objects.create(
        task_name=task_name,
        task_id=task_id,
        args=[],
        kwargs={},
        exception_type="RuntimeError",
        exception_message="boom",
        traceback="Traceback ...",
        status=status,
    )


def _admin_client() -> APIClient:
    admin = User.objects.create_user(username="dl_admin", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


@pytest.mark.django_db
class TestDeadLetterMetricsEndpoint:
    def test_requires_authentication(self) -> None:
        res = APIClient().get(URL)
        assert res.status_code in (401, 403)

    def test_forbidden_for_non_staff(self) -> None:
        user = User.objects.create_user(username="dl_member", password="pw")
        client = APIClient()
        client.force_authenticate(user=user)
        assert client.get(URL).status_code == 403

    def test_prometheus_content_type_and_header(self) -> None:
        res = _admin_client().get(URL)
        assert res.status_code == 200
        assert res["Content-Type"].startswith("text/plain; version=0.0.4")
        body = res.content.decode()
        assert f"# HELP {METRIC} " in body
        assert f"# TYPE {METRIC} gauge" in body

    def test_counts_parked_tasks_by_name(self) -> None:
        _failed("scheduling.recalculate_schedule", "a-1")
        _failed("scheduling.recalculate_schedule", "a-2")
        _failed("history.purge_old_history_records", "b-1")

        body = _admin_client().get(URL).content.decode()
        assert f'{METRIC}{{task_name="scheduling.recalculate_schedule"}} 2' in body
        assert f'{METRIC}{{task_name="history.purge_old_history_records"}} 1' in body

    def test_excludes_dismissed_and_retried(self) -> None:
        _failed("t.parked", "p-1", status=FailedTaskStatus.DEAD)
        _failed("t.dismissed", "d-1", status=FailedTaskStatus.DISMISSED)
        _failed("t.retried", "r-1", status=FailedTaskStatus.RETRIED)

        body = _admin_client().get(URL).content.decode()
        assert f'{METRIC}{{task_name="t.parked"}} 1' in body
        assert "t.dismissed" not in body
        assert "t.retried" not in body

    def test_empty_state_emits_header_only(self) -> None:
        body = _admin_client().get(URL).content.decode()
        assert f"# TYPE {METRIC} gauge" in body
        # No series lines — every non-comment line would start with the metric name.
        assert not any(
            line.startswith(METRIC) for line in body.splitlines() if not line.startswith("#")
        )

    def test_label_value_is_escaped(self) -> None:
        _failed('weird."name"', "w-1")
        body = _admin_client().get(URL).content.decode()
        assert r'task_name="weird.\"name\""' in body
