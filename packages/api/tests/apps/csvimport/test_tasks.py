"""Outbox, drain, and dispatch-service tests for CSV import (#743, ADR-0632)."""

from __future__ import annotations

import base64
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
from trueppm_api.apps.csvimport.services import enqueue_csv_import
from trueppm_api.apps.csvimport.tasks import _do_csv_import_drain
from trueppm_api.apps.projects.models import Calendar, Project

from .fixtures import REFERENCE_CSV


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="CSV Target", start_date=date(2026, 1, 5), calendar=calendar)


def _make_request(project: Project, **kwargs: object) -> CsvImportRequest:
    defaults: dict[str, object] = {
        "project": project,
        "filename": "plan.csv",
        "file_content_b64": base64.b64encode(REFERENCE_CSV).decode("ascii"),
    }
    defaults.update(kwargs)
    return CsvImportRequest.objects.create(**defaults)  # type: ignore[arg-type]


class TestNoOpTracker:
    def test_logs_progress_and_result(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.csvimport.tasks import _NoOpTracker

        tracker = _NoOpTracker()
        with caplog.at_level("INFO"):
            tracker.update(50, "halfway")
            tracker.set_result({"tasks_created": 7})
        assert "halfway" in caplog.text
        assert "tasks_created" in caplog.text


@pytest.mark.django_db
class TestEnqueueService:
    def test_successful_dispatch_flips_the_row_to_dispatched(self, project: Project) -> None:
        req = _make_request(project)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            mock_delay.return_value.id = "celery-123"
            enqueue_csv_import(str(req.pk))

        req.refresh_from_db()
        assert req.status == CsvImportStatus.DISPATCHED
        assert req.celery_task_id == "celery-123"
        assert req.dispatched_at is not None

    def test_broker_outage_leaves_the_row_pending_for_the_drain(self, project: Project) -> None:
        """The durability guarantee: a dead broker must never lose an import."""
        req = _make_request(project)
        with patch(
            "trueppm_api.apps.csvimport.tasks.import_csv.delay",
            side_effect=OSError("broker down"),
        ):
            enqueue_csv_import(str(req.pk))

        req.refresh_from_db()
        assert req.status == CsvImportStatus.PENDING
        assert req.celery_task_id == ""
        # The payload is still there, so the drain can retry it.
        assert req.file_content_b64 != ""

    def test_the_persisted_column_map_is_replayed_on_dispatch(self, project: Project) -> None:
        req = _make_request(project, column_map={"Task": "name"})
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            mock_delay.return_value.id = "celery-1"
            enqueue_csv_import(str(req.pk))
        assert mock_delay.call_args.kwargs["column_map"] == {"Task": "name"}

    def test_already_dispatched_row_is_a_no_op(self, project: Project) -> None:
        req = _make_request(project, status=CsvImportStatus.DISPATCHED)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            enqueue_csv_import(str(req.pk))
        mock_delay.assert_not_called()

    def test_missing_row_is_a_no_op(self, project: Project) -> None:
        import uuid

        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            enqueue_csv_import(str(uuid.uuid4()))
        mock_delay.assert_not_called()


@pytest.mark.django_db
class TestDrain:
    def _age(self, req: CsvImportRequest, minutes: int) -> None:
        """Backdate requested_at past the drain's minimum-age filter."""
        CsvImportRequest.objects.filter(pk=req.pk).update(
            requested_at=timezone.now() - timedelta(minutes=minutes)
        )

    def test_aged_pending_rows_are_dispatched(self, project: Project) -> None:
        req = _make_request(project)
        self._age(req, 15)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            mock_delay.return_value.id = "celery-9"
            _do_csv_import_drain()

        req.refresh_from_db()
        assert req.status == CsvImportStatus.DISPATCHED
        assert req.celery_task_id == "celery-9"

    def test_a_freshly_created_row_is_not_raced(self, project: Project) -> None:
        """A row inside an open on_commit window must not be double-dispatched."""
        req = _make_request(project)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            _do_csv_import_drain()
        mock_delay.assert_not_called()
        req.refresh_from_db()
        assert req.status == CsvImportStatus.PENDING

    def test_orphaned_dispatched_rows_are_recovered(self, project: Project) -> None:
        req = _make_request(
            project,
            status=CsvImportStatus.DISPATCHED,
            dispatched_at=timezone.now() - timedelta(minutes=30),
            celery_task_id="dead-worker",
        )
        self._age(req, 40)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            mock_delay.return_value.id = "celery-retry"
            _do_csv_import_drain()

        req.refresh_from_db()
        # Recovered to PENDING, then re-dispatched in the same drain pass.
        assert req.status == CsvImportStatus.DISPATCHED
        assert req.celery_task_id == "celery-retry"

    def test_a_recently_dispatched_row_is_left_alone(self, project: Project) -> None:
        req = _make_request(
            project,
            status=CsvImportStatus.DISPATCHED,
            dispatched_at=timezone.now() - timedelta(minutes=2),
            celery_task_id="in-flight",
        )
        self._age(req, 40)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            _do_csv_import_drain()
        mock_delay.assert_not_called()
        req.refresh_from_db()
        assert req.celery_task_id == "in-flight"

    def test_dead_rows_are_never_re_dispatched(self, project: Project) -> None:
        """A deterministically bad file must not loop forever."""
        req = _make_request(project, status=CsvImportStatus.DEAD)
        self._age(req, 60)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            _do_csv_import_drain()
        mock_delay.assert_not_called()
        req.refresh_from_db()
        assert req.status == CsvImportStatus.DEAD

    def test_done_rows_are_never_re_dispatched(self, project: Project) -> None:
        req = _make_request(project, status=CsvImportStatus.DONE)
        self._age(req, 60)
        with patch("trueppm_api.apps.csvimport.tasks.import_csv.delay") as mock_delay:
            _do_csv_import_drain()
        mock_delay.assert_not_called()

    def test_broker_outage_during_drain_leaves_the_row_pending(self, project: Project) -> None:
        req = _make_request(project)
        self._age(req, 15)
        with patch(
            "trueppm_api.apps.csvimport.tasks.import_csv.delay",
            side_effect=OSError("broker down"),
        ):
            _do_csv_import_drain()

        req.refresh_from_db()
        assert req.status == CsvImportStatus.PENDING


@pytest.mark.django_db
class TestClaimSemantics:
    def test_claim_succeeds_once_and_clears_the_payload(self, project: Project) -> None:
        from trueppm_api.apps.csvimport.tasks import _claim_import

        req = _make_request(project, status=CsvImportStatus.DISPATCHED)
        assert _claim_import(str(req.pk)) is True
        assert _claim_import(str(req.pk)) is False

        req.refresh_from_db()
        assert req.status == CsvImportStatus.DONE
        assert req.file_content_b64 == ""

    def test_dead_lettering_never_overwrites_a_completed_row(self, project: Project) -> None:
        from trueppm_api.apps.csvimport.tasks import _mark_import_dead

        req = _make_request(project, status=CsvImportStatus.DONE)
        _mark_import_dead(str(req.pk), "late failure")
        req.refresh_from_db()
        assert req.status == CsvImportStatus.DONE


class TestBeatRegistration:
    def test_the_csv_drain_is_scheduled(self) -> None:
        """A drain that is never scheduled is a durability gap, not a task."""
        from django.conf import settings

        entry = settings.CELERY_BEAT_SCHEDULE["drain-csv-import-queue"]
        assert entry["task"] == "csv.drain_import_queue"
        assert entry["schedule"] == 30.0
