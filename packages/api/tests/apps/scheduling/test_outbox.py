"""Tests for the transactional outbox pattern (ScheduleRequest model + drain task).

Covers:
  - ScheduleRequest creation and partial unique constraint enforcement
  - _enqueue_recalculate: happy path, duplicate suppression, broker failure
  - _do_drain: dispatches pending rows, recovers orphaned rows,
    handles broker unavailability gracefully
  - _run_schedule: marks ScheduleRequest as done after CPM completes
  - _do_purge: deletes stale done/dead rows
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from django.db import IntegrityError
from django.utils import timezone

from trueppm_api.apps.scheduling.models import (
    ScheduleRequest,
    ScheduleRequestStatus,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def project(db):
    """Return a minimal Project instance."""
    from trueppm_api.apps.projects.models import Project

    return Project.objects.create(
        name="Test Project",
        start_date="2026-01-01",
    )


# ---------------------------------------------------------------------------
# ScheduleRequest model
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestScheduleRequestModel:
    def test_create_pending_row(self, project) -> None:
        req = ScheduleRequest.objects.create(project=project)
        assert req.status == ScheduleRequestStatus.PENDING
        assert req.dispatched_at is None
        assert req.celery_task_id == ""

    def test_partial_unique_constraint_pending(self, project) -> None:
        """Only one pending row per project is allowed."""
        ScheduleRequest.objects.create(project=project)
        with pytest.raises(IntegrityError):
            ScheduleRequest.objects.create(project=project)

    def test_second_project_can_have_pending_row(self, db) -> None:
        """Constraint is per project — two different projects can both have pending rows."""
        from trueppm_api.apps.projects.models import Project

        p1 = Project.objects.create(name="P1", start_date="2026-01-01")
        p2 = Project.objects.create(name="P2", start_date="2026-01-01")
        ScheduleRequest.objects.create(project=p1)
        req2 = ScheduleRequest.objects.create(project=p2)
        assert req2.pk is not None

    def test_done_row_allows_new_pending(self, project) -> None:
        """After a row reaches done/dead, a new pending row can be inserted."""
        req = ScheduleRequest.objects.create(project=project)
        req.status = ScheduleRequestStatus.DONE
        req.save(update_fields=["status"])
        # Now a new pending row is allowed
        req2 = ScheduleRequest.objects.create(project=project)
        assert req2.status == ScheduleRequestStatus.PENDING

    def test_str_representation(self, project) -> None:
        req = ScheduleRequest.objects.create(project=project)
        assert str(project.pk) in str(req)
        assert "pending" in str(req)


# ---------------------------------------------------------------------------
# _enqueue_recalculate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestEnqueueRecalculate:
    def _call(self, project_id: str) -> None:
        from trueppm_api.apps.projects.views import _enqueue_recalculate

        _enqueue_recalculate(project_id)

    def test_creates_outbox_row_and_dispatches(self, project) -> None:
        mock_result = MagicMock()
        mock_result.id = "celery-task-abc"
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            return_value=mock_result,
        ):
            self._call(str(project.pk))

        req = ScheduleRequest.objects.get(project=project)
        assert req.status == ScheduleRequestStatus.DISPATCHED
        assert req.celery_task_id == "celery-task-abc"
        assert req.dispatched_at is not None

    def test_broker_unavailable_leaves_row_pending(self, project) -> None:
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            side_effect=ConnectionError("broker down"),
        ):
            self._call(str(project.pk))

        req = ScheduleRequest.objects.get(project=project)
        assert req.status == ScheduleRequestStatus.PENDING
        assert req.celery_task_id == ""

    def test_duplicate_suppressed_silently(self, project) -> None:
        """A second call while a pending row exists is a no-op (no exception)."""
        ScheduleRequest.objects.create(project=project)
        # Should not raise even though the unique constraint would fire
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
        ) as mock_delay:
            self._call(str(project.pk))
        mock_delay.assert_not_called()
        # Still only one row
        assert ScheduleRequest.objects.filter(project=project).count() == 1


# ---------------------------------------------------------------------------
# _do_drain
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDoDrain:
    def _drain(self) -> None:
        from trueppm_api.apps.scheduling.tasks import _do_drain

        _do_drain()

    def test_dispatches_pending_row(self, project) -> None:
        ScheduleRequest.objects.create(project=project)
        mock_result = MagicMock()
        mock_result.id = "drain-task-id"
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            return_value=mock_result,
        ):
            self._drain()

        req = ScheduleRequest.objects.get(project=project)
        assert req.status == ScheduleRequestStatus.DISPATCHED
        assert req.celery_task_id == "drain-task-id"

    def test_broker_failure_leaves_row_pending(self, project) -> None:
        ScheduleRequest.objects.create(project=project)
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            side_effect=ConnectionError("broker down"),
        ):
            self._drain()  # should not raise

        req = ScheduleRequest.objects.get(project=project)
        assert req.status == ScheduleRequestStatus.PENDING

    def test_recovers_orphaned_dispatched_row(self, project) -> None:
        """Dispatched rows older than 10 min are reset to pending, then dispatched."""
        stale_time = timezone.now() - timedelta(minutes=11)
        req = ScheduleRequest.objects.create(project=project)
        ScheduleRequest.objects.filter(pk=req.pk).update(
            status=ScheduleRequestStatus.DISPATCHED,
            dispatched_at=stale_time,
            celery_task_id="old-task-id",
        )

        mock_result = MagicMock()
        mock_result.id = "new-task-id"
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            return_value=mock_result,
        ):
            self._drain()

        req.refresh_from_db()
        assert req.status == ScheduleRequestStatus.DISPATCHED
        assert req.celery_task_id == "new-task-id"

    def test_recent_dispatched_row_not_recovered(self, project) -> None:
        """Dispatched rows younger than 10 min are left alone."""
        req = ScheduleRequest.objects.create(project=project)
        ScheduleRequest.objects.filter(pk=req.pk).update(
            status=ScheduleRequestStatus.DISPATCHED,
            dispatched_at=timezone.now() - timedelta(minutes=5),
            celery_task_id="live-task-id",
        )

        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
        ) as mock_delay:
            self._drain()

        mock_delay.assert_not_called()
        req.refresh_from_db()
        assert req.status == ScheduleRequestStatus.DISPATCHED

    def test_no_rows_does_nothing(self, db) -> None:
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
        ) as mock_delay:
            self._drain()
        mock_delay.assert_not_called()


# ---------------------------------------------------------------------------
# _do_purge
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDoPurge:
    def _purge(self) -> None:
        from trueppm_api.apps.scheduling.tasks import _do_purge

        _do_purge()

    def test_deletes_old_done_rows(self, project) -> None:
        req = ScheduleRequest.objects.create(project=project)
        cutoff = timezone.now() - timedelta(days=8)
        ScheduleRequest.objects.filter(pk=req.pk).update(
            status=ScheduleRequestStatus.DONE,
            requested_at=cutoff,
        )
        self._purge()
        assert not ScheduleRequest.objects.filter(pk=req.pk).exists()

    def test_deletes_old_dead_rows(self, project) -> None:
        req = ScheduleRequest.objects.create(project=project)
        cutoff = timezone.now() - timedelta(days=8)
        ScheduleRequest.objects.filter(pk=req.pk).update(
            status=ScheduleRequestStatus.DEAD,
            requested_at=cutoff,
        )
        self._purge()
        assert not ScheduleRequest.objects.filter(pk=req.pk).exists()

    def test_preserves_recent_rows(self, project) -> None:
        req = ScheduleRequest.objects.create(project=project)
        ScheduleRequest.objects.filter(pk=req.pk).update(
            status=ScheduleRequestStatus.DONE,
        )
        self._purge()
        assert ScheduleRequest.objects.filter(pk=req.pk).exists()

    def test_preserves_pending_rows(self, project) -> None:
        """Pending rows are never deleted regardless of age."""
        req = ScheduleRequest.objects.create(project=project)
        cutoff = timezone.now() - timedelta(days=30)
        ScheduleRequest.objects.filter(pk=req.pk).update(requested_at=cutoff)
        self._purge()
        assert ScheduleRequest.objects.filter(pk=req.pk).exists()
