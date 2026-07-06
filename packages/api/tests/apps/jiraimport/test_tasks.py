"""Unit tests for the Jira import Celery tasks (tasks.py, #1664)."""

from __future__ import annotations

import base64
import sys
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus
from trueppm_api.apps.projects.models import Calendar, Project

from .fixtures import CHAIN_EXPORT


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Jira Target", start_date=date(2026, 1, 5), calendar=calendar
    )


class TestNoOpTracker:
    def test_logs_progress_and_result(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.jiraimport.tasks import _NoOpTracker

        tracker = _NoOpTracker()
        with caplog.at_level("INFO"):
            tracker.update(50, "halfway")
            tracker.set_result({"tasks_created": 3})
        assert "halfway" in caplog.text
        assert "tasks_created" in caplog.text


class TestGetTrackerFallback:
    def test_falls_back_to_noop_when_taskruns_app_unavailable(self) -> None:
        from trueppm_api.apps.jiraimport.tasks import _get_tracker, _NoOpTracker

        # Setting the module to None in sys.modules forces the inline `from
        # trueppm_api.apps.taskruns.tracker import TaskRunTracker` to raise
        # ImportError, exercising the fallback without needing taskruns to
        # actually be uninstalled.
        with (
            patch.dict(sys.modules, {"trueppm_api.apps.taskruns.tracker": None}),
            _get_tracker(None, "proj-1", None) as tracker,
        ):
            assert isinstance(tracker, _NoOpTracker)


@pytest.mark.django_db
class TestImportJiraTaskParseFailure:
    def test_unparseable_export_marks_request_dead(self, project: Project) -> None:
        from trueppm_api.apps.jiraimport.tasks import import_jira

        req = JiraImportRequest.objects.create(
            project=project,
            filename="not-xml.xml",
            file_content_b64=base64.b64encode(b"not xml at all").decode("ascii"),
            status=JiraImportStatus.DISPATCHED,
        )
        result = import_jira.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": req.file_content_b64,
                "filename": req.filename,
                "import_request_id": str(req.pk),
            },
            throw=False,
        )
        assert result.failed()
        req.refresh_from_db()
        # Deterministic failure -> terminal DEAD, never re-dispatched by the drain.
        assert req.status == JiraImportStatus.DEAD
        assert req.file_content_b64 == ""


@pytest.mark.django_db
class TestImportJiraTaskHappyPath:
    def test_creates_network_marks_done_and_broadcasts(
        self, project: Project, django_capture_on_commit_callbacks: object
    ) -> None:
        from trueppm_api.apps.jiraimport.tasks import import_jira

        req = JiraImportRequest.objects.create(
            project=project,
            filename="chain.xml",
            file_content_b64=base64.b64encode(CHAIN_EXPORT).decode("ascii"),
            status=JiraImportStatus.DISPATCHED,
        )
        events: list[tuple[str, dict]] = []
        with (
            patch(
                "trueppm_api.apps.sync.broadcast.broadcast_board_event",
                side_effect=lambda _p, et, payload: events.append((et, payload)),
            ),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            result = import_jira.apply(
                kwargs={
                    "project_id": str(project.pk),
                    "file_content_b64": req.file_content_b64,
                    "filename": req.filename,
                    "import_request_id": str(req.pk),
                }
            )
        assert result.successful(), result.result
        assert result.result["tasks_created"] == 3
        req.refresh_from_db()
        assert req.status == JiraImportStatus.DONE
        assert req.file_content_b64 == ""
        assert (str(project.pk), "tasks_restructured", {}) in [
            (str(project.pk), et, payload) for et, payload in events
        ]


@pytest.mark.django_db
class TestDrainJiraImportQueue:
    def test_recovers_orphaned_dispatched_rows(self, project: Project) -> None:
        from trueppm_api.apps.jiraimport.tasks import _do_jira_import_drain

        stuck = JiraImportRequest.objects.create(
            project=project,
            filename="stuck.xml",
            file_content_b64="",
            status=JiraImportStatus.DISPATCHED,
            celery_task_id="old-task",
        )
        JiraImportRequest.objects.filter(pk=stuck.pk).update(
            dispatched_at=timezone.now() - timedelta(minutes=20)
        )

        # The drain recovers the orphan to PENDING and then re-dispatches every
        # PENDING row in the same tick — so with a live broker the row would end
        # DISPATCHED again and the recovery would be invisible. Fail the
        # re-dispatch (broker down) so the recovered PENDING state is observable:
        # this asserts the orphan-recovery step, not the dispatch step.
        with patch(
            "trueppm_api.apps.jiraimport.tasks.import_jira.delay",
            side_effect=RuntimeError("broker down"),
        ):
            _do_jira_import_drain()

        stuck.refresh_from_db()
        assert stuck.status == JiraImportStatus.PENDING
        assert stuck.celery_task_id == ""

    def test_dispatches_pending_rows(self, project: Project) -> None:
        from trueppm_api.apps.jiraimport.tasks import _do_jira_import_drain

        req = JiraImportRequest.objects.create(
            project=project,
            filename="pending.xml",
            file_content_b64=base64.b64encode(CHAIN_EXPORT).decode("ascii"),
            status=JiraImportStatus.PENDING,
        )
        with patch("trueppm_api.apps.jiraimport.tasks.import_jira.delay") as mock_delay:
            mock_delay.return_value.id = "new-task-id"
            _do_jira_import_drain()

        mock_delay.assert_called_once()
        req.refresh_from_db()
        assert req.status == JiraImportStatus.DISPATCHED
        assert req.celery_task_id == "new-task-id"
        assert req.dispatched_at is not None

    def test_broker_failure_leaves_pending_rows_untouched(self, project: Project) -> None:
        from trueppm_api.apps.jiraimport.tasks import _do_jira_import_drain

        req = JiraImportRequest.objects.create(
            project=project,
            filename="pending.xml",
            file_content_b64=base64.b64encode(CHAIN_EXPORT).decode("ascii"),
            status=JiraImportStatus.PENDING,
        )
        with patch(
            "trueppm_api.apps.jiraimport.tasks.import_jira.delay",
            side_effect=RuntimeError("broker down"),
        ):
            _do_jira_import_drain()

        req.refresh_from_db()
        assert req.status == JiraImportStatus.PENDING
        assert req.celery_task_id == ""

    def test_drain_task_is_configured_for_skip_on_contention(self) -> None:
        from trueppm_api.apps.jiraimport.tasks import drain_jira_import_queue

        assert drain_jira_import_queue._idempotent_config["on_contention"] == "skip"  # type: ignore[attr-defined]
        assert drain_jira_import_queue.soft_time_limit == 25
        assert drain_jira_import_queue.time_limit == 30
