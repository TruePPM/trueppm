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
    ScheduleRequestReason,
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
        from trueppm_api.apps.scheduling.services import enqueue_recalculate

        enqueue_recalculate(project_id)

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

    def test_default_reason_is_task_change(self, project) -> None:
        """Calling without `reason=` records TASK_CHANGE on the outbox row (#355)."""
        mock_result = MagicMock()
        mock_result.id = "celery-task-default"
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            return_value=mock_result,
        ):
            self._call(str(project.pk))
        req = ScheduleRequest.objects.get(project=project)
        assert req.reason == ScheduleRequestReason.TASK_CHANGE

    def test_explicit_reason_is_recorded(self, project) -> None:
        """Caller-supplied `reason=` is persisted on the outbox row (#355)."""
        from trueppm_api.apps.scheduling.services import enqueue_recalculate

        mock_result = MagicMock()
        mock_result.id = "celery-task-explicit"
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            return_value=mock_result,
        ):
            enqueue_recalculate(str(project.pk), reason=ScheduleRequestReason.DEPENDENCY_CHANGE)
        req = ScheduleRequest.objects.get(project=project)
        assert req.reason == ScheduleRequestReason.DEPENDENCY_CHANGE

    def test_adopting_pending_row_preserves_original_reason(self, project) -> None:
        """When a PENDING row exists, the adopt path keeps its original reason.

        Forensics value: the first event that queued a recalc is the most
        useful debugging signal. Letting later edits overwrite the reason
        would mask the real trigger.
        """
        from trueppm_api.apps.scheduling.services import enqueue_recalculate

        existing = ScheduleRequest.objects.create(
            project=project, reason=ScheduleRequestReason.DEPENDENCY_CHANGE
        )
        mock_result = MagicMock()
        mock_result.id = "celery-task-adopt"
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            return_value=mock_result,
        ):
            enqueue_recalculate(str(project.pk), reason=ScheduleRequestReason.TASK_CHANGE)
        existing.refresh_from_db()
        assert existing.reason == ScheduleRequestReason.DEPENDENCY_CHANGE

    def test_duplicate_adopts_existing_pending_row(self, project) -> None:
        """A second call adopts the existing pending row and dispatches it.

        Previously this was a silent no-op which let stranded pending rows
        swallow every subsequent edit until the drain task ran. The drain
        task was itself unreachable for #314, so edits accumulated invisibly.
        """
        existing = ScheduleRequest.objects.create(project=project)
        mock_result = MagicMock()
        mock_result.id = "celery-task-xyz"
        with patch(
            "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            return_value=mock_result,
        ) as mock_delay:
            self._call(str(project.pk))
        mock_delay.assert_called_once_with(str(project.pk))
        # Still only one row, now dispatched.
        assert ScheduleRequest.objects.filter(project=project).count() == 1
        existing.refresh_from_db()
        assert existing.status == ScheduleRequestStatus.DISPATCHED
        assert existing.celery_task_id == "celery-task-xyz"


# ---------------------------------------------------------------------------
# Celery app wiring regression — covers the #314 root cause: without the
# `from .celery import app as celery_app` line in `trueppm_api/__init__.py`,
# `current_app` resolves to an unconfigured default Celery instance and every
# `shared_task.delay()` raises `OperationalError: Connection refused`.  The
# unit tests above mocked `delay()` and so could never catch it.
# ---------------------------------------------------------------------------


class TestCeleryAppWiring:
    def test_shared_task_resolves_to_configured_trueppm_app(self) -> None:
        """`current_app` must be the configured trueppm app, not the default."""
        from celery import current_app

        from trueppm_api.celery import app as trueppm_app

        # Both checks matter: the proxy must point at our app, AND that app
        # must have a real broker_url. A mismatch means __init__.py forgot to
        # import the celery app and `set_default()` was never called.
        assert current_app._get_current_object() is trueppm_app
        assert current_app.conf.broker_url, (
            "current_app has no broker_url — `from .celery import app as "
            "celery_app` is missing from trueppm_api/__init__.py. Without it "
            "every shared_task.delay() raises OperationalError and the "
            "scheduling outbox row is silently left PENDING (#314)."
        )

    def test_recalculate_schedule_delay_uses_configured_broker(self) -> None:
        """recalculate_schedule.delay() must dispatch through the configured app."""
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.celery import app as trueppm_app

        # idempotent_task wraps with @shared_task, which binds at first access
        # to whatever current_app is. If __init__.py forgot to import the
        # celery app, this assertion fails.
        assert recalculate_schedule.app is trueppm_app


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


# ---------------------------------------------------------------------------
# trigger_schedule view — Gap 1 fix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTriggerScheduleView:
    """trigger_schedule now routes through enqueue_recalculate (outbox)."""

    @pytest.fixture()
    def user(self, db: object) -> object:
        from django.contrib.auth import get_user_model

        User = get_user_model()
        return User.objects.create_user(username="scheduler_user", password="pw")

    @pytest.fixture()
    def project_with_member(self, project: object, user: object) -> object:
        from trueppm_api.apps.access.models import ProjectMembership, Role

        ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
        return project

    def test_trigger_creates_outbox_row(
        self, project_with_member, user, django_capture_on_commit_callbacks
    ) -> None:
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=user)
        # The view defers enqueue_recalculate via transaction.on_commit so the
        # ScheduleRequest row is only written after the request transaction
        # commits.  pytest-django's capture fixture executes callbacks on exit.
        with (
            patch(
                "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
                return_value=MagicMock(id="trigger-task-id"),
            ),
            django_capture_on_commit_callbacks(execute=True),
        ):
            resp = client.post(f"/api/v1/projects/{project_with_member.pk}/schedule/")

        assert resp.status_code == 202
        assert resp.data == {"queued": True}
        req = ScheduleRequest.objects.get(project=project_with_member)
        assert req.status == ScheduleRequestStatus.DISPATCHED

    def test_trigger_broker_down_leaves_row_pending(
        self, project_with_member, user, django_capture_on_commit_callbacks
    ) -> None:
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=user)
        with (
            patch(
                "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
                side_effect=ConnectionError("broker down"),
            ),
            django_capture_on_commit_callbacks(execute=True),
        ):
            resp = client.post(f"/api/v1/projects/{project_with_member.pk}/schedule/")

        assert resp.status_code == 202
        req = ScheduleRequest.objects.get(project=project_with_member)
        assert req.status == ScheduleRequestStatus.PENDING


# ---------------------------------------------------------------------------
# msproject import task — Gap 2 fix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestImportMSProjectOutbox:
    """import_msproject calls enqueue_recalculate at completion (outbox path)."""

    def test_import_completion_enqueues_via_outbox(self, project) -> None:
        """Tasks-created > 0: enqueue_recalculate is called, outbox row created."""
        mock_summary = {"tasks_created": 3, "tasks_updated": 0, "dependencies_created": 0}
        with (
            patch(
                "trueppm_api.apps.msproject.tasks.base64.b64decode",
                return_value=b"<xml/>",
            ),
            patch(
                "trueppm_api.apps.msproject.parser.parse_xml",
                return_value=MagicMock(),
            ),
            patch(
                "trueppm_api.apps.msproject.importer.import_project",
                return_value=mock_summary,
            ),
            patch(
                "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
                return_value=MagicMock(id="import-task-id"),
            ) as mock_delay,
        ):
            from trueppm_api.apps.msproject.tasks import import_msproject

            import_msproject(
                str(project.pk),
                "PHhtbC8+",  # base64("<xml/>")
                "test.xml",
            )

        mock_delay.assert_called_once_with(str(project.pk))
        assert ScheduleRequest.objects.filter(project=project).exists()

    def test_import_completion_zero_tasks_no_outbox(self, project) -> None:
        """No tasks created → enqueue_recalculate not called, no outbox row."""
        mock_summary = {"tasks_created": 0, "tasks_updated": 0, "dependencies_created": 0}
        with (
            patch("trueppm_api.apps.msproject.tasks.base64.b64decode", return_value=b"<xml/>"),
            patch("trueppm_api.apps.msproject.parser.parse_xml", return_value=MagicMock()),
            patch(
                "trueppm_api.apps.msproject.importer.import_project",
                return_value=mock_summary,
            ),
            patch(
                "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
            ) as mock_delay,
        ):
            from trueppm_api.apps.msproject.tasks import import_msproject

            import_msproject(str(project.pk), "PHhtbC8+", "test.xml")

        mock_delay.assert_not_called()
        assert not ScheduleRequest.objects.filter(project=project).exists()

    def test_import_broker_down_leaves_row_pending(self, project) -> None:
        """Broker outage at import completion → row stays PENDING for drain."""
        mock_summary = {"tasks_created": 2, "tasks_updated": 0, "dependencies_created": 0}
        with (
            patch("trueppm_api.apps.msproject.tasks.base64.b64decode", return_value=b"<xml/>"),
            patch("trueppm_api.apps.msproject.parser.parse_xml", return_value=MagicMock()),
            patch(
                "trueppm_api.apps.msproject.importer.import_project",
                return_value=mock_summary,
            ),
            patch(
                "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
                side_effect=ConnectionError("broker down"),
            ),
        ):
            from trueppm_api.apps.msproject.tasks import import_msproject

            import_msproject(str(project.pk), "PHhtbC8+", "test.xml")

        req = ScheduleRequest.objects.get(project=project)
        assert req.status == ScheduleRequestStatus.PENDING
