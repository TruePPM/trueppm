"""Unit tests for the Jira import outbox dispatch helper (services.py, #1664)."""

from __future__ import annotations

import base64
import uuid
from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus
from trueppm_api.apps.jiraimport.services import enqueue_jira_import
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


@pytest.fixture
def pending_request(project: Project) -> JiraImportRequest:
    return JiraImportRequest.objects.create(
        project=project,
        filename="export.xml",
        file_content_b64=base64.b64encode(CHAIN_EXPORT).decode("ascii"),
        status=JiraImportStatus.PENDING,
    )


@pytest.mark.django_db
class TestEnqueueJiraImport:
    def test_no_op_when_request_does_not_exist(self) -> None:
        # Nothing to dispatch, nothing to raise — a stale/garbage id is a no-op.
        enqueue_jira_import(str(uuid.uuid4()))

    def test_no_op_when_request_is_no_longer_pending(self, project: Project) -> None:
        req = JiraImportRequest.objects.create(
            project=project,
            filename="x.xml",
            file_content_b64="",
            status=JiraImportStatus.DISPATCHED,
        )
        enqueue_jira_import(str(req.pk))
        req.refresh_from_db()
        assert req.status == JiraImportStatus.DISPATCHED
        assert req.celery_task_id == ""

    def test_dispatches_pending_request_and_marks_dispatched(
        self, pending_request: JiraImportRequest
    ) -> None:
        with patch("trueppm_api.apps.jiraimport.tasks.import_jira.delay") as mock_delay:
            mock_delay.return_value.id = "task-123"
            enqueue_jira_import(str(pending_request.pk))

        mock_delay.assert_called_once_with(
            project_id=str(pending_request.project_id),
            file_content_b64=pending_request.file_content_b64,
            filename=pending_request.filename,
            initiated_by_id=pending_request.initiated_by_id,
            import_request_id=str(pending_request.id),
        )
        pending_request.refresh_from_db()
        assert pending_request.status == JiraImportStatus.DISPATCHED
        assert pending_request.celery_task_id == "task-123"
        assert pending_request.dispatched_at is not None

    def test_broker_failure_leaves_request_pending_for_the_drain(
        self, pending_request: JiraImportRequest
    ) -> None:
        with patch(
            "trueppm_api.apps.jiraimport.tasks.import_jira.delay",
            side_effect=RuntimeError("broker down"),
        ):
            enqueue_jira_import(str(pending_request.pk))

        pending_request.refresh_from_db()
        assert pending_request.status == JiraImportStatus.PENDING
        assert pending_request.celery_task_id == ""
