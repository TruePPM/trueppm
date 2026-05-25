"""Tests for the dead-letter inspector list filters on FailedTaskViewSet (#694, ADR-0086).

The inspector list adds read-only ?status / ?task_name / ?failed_after /
?failed_before filters. Invalid filter values degrade to "no filter" rather
than 400, so a malformed bookmarked URL never blocks an operator mid-incident.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus

User = get_user_model()

URL = "/api/v1/admin/failed-tasks/"


def _admin_client() -> APIClient:
    admin = User.objects.create_user(username="ft_admin", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


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


def _ids(res) -> set[str]:
    return {row["task_id"] for row in res.data["results"]}


@pytest.mark.django_db
class TestFailedTaskFilters:
    def test_requires_admin(self) -> None:
        user = User.objects.create_user(username="ft_member", password="pw")
        client = APIClient()
        client.force_authenticate(user=user)
        assert client.get(URL).status_code == 403

    def test_unfiltered_returns_all(self) -> None:
        _failed("a.task", "a-1")
        _failed("b.task", "b-1", status=FailedTaskStatus.DISMISSED)
        res = _admin_client().get(URL)
        assert res.status_code == 200
        assert _ids(res) == {"a-1", "b-1"}

    def test_filter_by_status(self) -> None:
        _failed("a.task", "a-1", status=FailedTaskStatus.DEAD)
        _failed("b.task", "b-1", status=FailedTaskStatus.DISMISSED)
        res = _admin_client().get(URL, {"status": FailedTaskStatus.DEAD})
        assert _ids(res) == {"a-1"}

    def test_invalid_status_is_ignored(self) -> None:
        _failed("a.task", "a-1")
        _failed("b.task", "b-1", status=FailedTaskStatus.DISMISSED)
        # Bogus status → filter skipped → all rows returned (no 400).
        res = _admin_client().get(URL, {"status": "not-a-real-status"})
        assert res.status_code == 200
        assert _ids(res) == {"a-1", "b-1"}

    def test_filter_by_task_name_icontains(self) -> None:
        _failed("scheduling.recalculate_schedule", "s-1")
        _failed("webhooks.dispatch_delivery", "w-1")
        res = _admin_client().get(URL, {"task_name": "SCHEDUL"})  # case-insensitive
        assert _ids(res) == {"s-1"}

    def test_filter_by_failed_after(self) -> None:
        old = _failed("a.task", "old-1")
        recent = _failed("b.task", "recent-1")
        # last_failed_at is auto_now; rewrite it directly to control the window.
        now = timezone.now()
        FailedTask.objects.filter(pk=old.pk).update(last_failed_at=now - timedelta(days=10))
        FailedTask.objects.filter(pk=recent.pk).update(last_failed_at=now)

        cutoff = (now - timedelta(days=1)).isoformat()
        res = _admin_client().get(URL, {"failed_after": cutoff})
        assert _ids(res) == {"recent-1"}

    def test_filter_by_failed_before(self) -> None:
        old = _failed("a.task", "old-1")
        recent = _failed("b.task", "recent-1")
        now = timezone.now()
        FailedTask.objects.filter(pk=old.pk).update(last_failed_at=now - timedelta(days=10))
        FailedTask.objects.filter(pk=recent.pk).update(last_failed_at=now)

        cutoff = (now - timedelta(days=1)).isoformat()
        res = _admin_client().get(URL, {"failed_before": cutoff})
        assert _ids(res) == {"old-1"}

    def test_invalid_date_is_ignored(self) -> None:
        _failed("a.task", "a-1")
        res = _admin_client().get(URL, {"failed_after": "not-a-date"})
        assert res.status_code == 200
        assert _ids(res) == {"a-1"}
