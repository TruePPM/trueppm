"""Import → CPM-computability, cyclic rejection, and view RBAC tests (#1664)."""

from __future__ import annotations

import base64
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus
from trueppm_api.apps.jiraimport.parser import parse_jira_xml
from trueppm_api.apps.jiraimport.views import _require_project_admin
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.graph_guard import (
    InfeasibleGraphError,
    validate_task_graph,
)
from trueppm_api.apps.scheduling.tasks import _run_schedule

from .fixtures import CHAIN_EXPORT, CYCLIC_EXPORT


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Jira Target", start_date=date(2026, 1, 5), calendar=calendar
    )


def _edges(data: object) -> list[tuple[str, str]]:
    return [
        (str(link.predecessor_uid), str(task.uid))
        for task in data.tasks  # type: ignore[attr-defined]
        for link in task.predecessor_links
    ]


@pytest.mark.django_db
class TestImportComputability:
    def test_import_creates_a_cpm_schedulable_network(self, project: Project) -> None:
        data = parse_jira_xml(CHAIN_EXPORT)
        # The derived graph is acyclic → the guard passes → import proceeds.
        validate_task_graph(_edges(data))

        summary = import_project(str(project.pk), data)
        assert summary["tasks_created"] == 3
        assert summary["dependencies_created"] == 2

        tasks = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
        # Nonzero durations from estimates (PROJ-3 defaulted to 1, never 0).
        assert tasks["Design the schema"].duration == 1
        assert tasks["Build the API"].duration == 5
        assert tasks["Ship it"].duration == 1
        deps = Dependency.objects.filter(predecessor__project=project, is_deleted=False)
        assert deps.count() == 2
        assert all(d.dep_type == "FS" and d.lag == 0 for d in deps)

        # CPM computes over the imported network: every task gets an early_start,
        # and the chain orders (Ship it starts no earlier than Build the API,
        # which starts no earlier than Design the schema).
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        ):
            _run_schedule(str(project.pk))

        refreshed = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
        assert refreshed["Design the schema"].early_start is not None
        assert refreshed["Build the API"].early_start is not None
        assert refreshed["Ship it"].early_start is not None
        assert (
            refreshed["Ship it"].early_start
            >= refreshed["Build the API"].early_start
            >= refreshed["Design the schema"].early_start
        )
        # The head of the chain sits on the critical path.
        assert refreshed["Design the schema"].is_critical is True

    def test_cyclic_import_is_rejected_before_any_write(self, project: Project) -> None:
        data = parse_jira_xml(CYCLIC_EXPORT)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(_edges(data))
        assert exc.value.reason == "cyclic_dependency"
        # The importer is never reached — nothing is persisted.
        assert Task.objects.filter(project=project).count() == 0


@pytest.mark.django_db
class TestImportTaskDeadLettering:
    def test_cyclic_export_marks_request_dead_and_creates_no_tasks(self, project: Project) -> None:
        from trueppm_api.apps.jiraimport.tasks import import_jira

        req = JiraImportRequest.objects.create(
            project=project,
            filename="cyclic.xml",
            file_content_b64=base64.b64encode(CYCLIC_EXPORT).decode("ascii"),
            status=JiraImportStatus.DISPATCHED,
        )
        # Run the task body synchronously; the cyclic graph raises inside it.
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
        # Terminal: the drain must not re-dispatch a deterministically bad file,
        # and the payload is cleared.
        assert req.status == JiraImportStatus.DEAD
        assert req.file_content_b64 == ""
        assert Task.objects.filter(project=project).count() == 0


@pytest.mark.django_db
class TestJiraImportViewRBAC:
    def _upload(self) -> SimpleUploadedFile:
        return SimpleUploadedFile("export.xml", CHAIN_EXPORT, content_type="text/xml")

    def _client(self, user: object) -> APIClient:
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def test_member_cannot_import(self, project: Project) -> None:
        member = get_user_model().objects.create_user(username="member", password="pw")
        ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
        r = self._client(member).post(
            f"/api/v1/projects/{project.pk}/import/jira/",
            {"file": self._upload()},
            format="multipart",
        )
        assert r.status_code == 403
        assert not JiraImportRequest.objects.filter(project=project).exists()

    def test_admin_queues_import(
        self, project: Project, django_capture_on_commit_callbacks: object
    ) -> None:
        admin = get_user_model().objects.create_user(username="admin", password="pw")
        ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
        # Isolate the view from Celery/broker — assert the outbox row is written
        # and dispatch is scheduled on commit.
        with (
            patch("trueppm_api.apps.jiraimport.services.enqueue_jira_import") as mock_enqueue,
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            r = self._client(admin).post(
                f"/api/v1/projects/{project.pk}/import/jira/",
                {"file": self._upload()},
                format="multipart",
            )
        assert r.status_code == 202
        assert "import_request_id" in r.data
        req = JiraImportRequest.objects.get(project=project)
        assert req.status == JiraImportStatus.PENDING
        assert req.filename == "export.xml"
        mock_enqueue.assert_called_once_with(str(req.pk))

    def test_rejects_non_xml_upload(self, project: Project) -> None:
        admin = get_user_model().objects.create_user(username="admin2", password="pw")
        ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
        bad = SimpleUploadedFile("export.csv", b"a,b,c", content_type="text/csv")
        r = self._client(admin).post(
            f"/api/v1/projects/{project.pk}/import/jira/",
            {"file": bad},
            format="multipart",
        )
        assert r.status_code == 400
        assert not JiraImportRequest.objects.filter(project=project).exists()

    def test_rejects_missing_file_field(self, project: Project) -> None:
        admin = get_user_model().objects.create_user(username="admin3", password="pw")
        ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
        r = self._client(admin).post(
            f"/api/v1/projects/{project.pk}/import/jira/", {}, format="multipart"
        )
        assert r.status_code == 400
        assert "No file provided" in r.data["detail"]
        assert not JiraImportRequest.objects.filter(project=project).exists()

    def test_rejects_upload_exceeding_max_size(self, project: Project, settings: object) -> None:
        # Any nonzero upload exceeds a 0 MB cap — avoids uploading a real
        # multi-megabyte fixture just to exercise the size-limit branch.
        settings.JIRA_IMPORT_MAX_UPLOAD_MB = 0  # type: ignore[attr-defined]
        admin = get_user_model().objects.create_user(username="admin4", password="pw")
        ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
        r = self._client(admin).post(
            f"/api/v1/projects/{project.pk}/import/jira/",
            {"file": self._upload()},
            format="multipart",
        )
        assert r.status_code == 400
        assert "too large" in r.data["detail"].lower()
        assert not JiraImportRequest.objects.filter(project=project).exists()


@pytest.mark.django_db
class TestRequireProjectAdmin:
    """Direct unit tests of the in-body defense-in-depth Admin check.

    IsProjectAdmin already rejects these callers at the DRF permission layer,
    so the view-level tests above never reach _require_project_admin's own
    raise — exercise it directly to cover its no-membership and below-Admin
    branches.
    """

    def test_raises_when_no_membership(self, project: Project) -> None:
        user = get_user_model().objects.create_user(username="nomember", password="pw")
        with pytest.raises(PermissionDenied):
            _require_project_admin(user, str(project.pk))

    def test_raises_when_role_below_admin(self, project: Project) -> None:
        user = get_user_model().objects.create_user(username="belowadmin", password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
        with pytest.raises(PermissionDenied):
            _require_project_admin(user, str(project.pk))


@pytest.mark.django_db
class TestJiraImportRequestStr:
    def test_str_includes_project_filename_and_status(self, project: Project) -> None:
        req = JiraImportRequest.objects.create(
            project=project, filename="export.xml", file_content_b64=""
        )
        assert str(req) == f"JiraImportRequest({project.pk}, export.xml, pending)"


@pytest.mark.django_db
def test_jira_import_persists_mapped_status(project: Project) -> None:
    """#1768: end-to-end, imported Jira issues carry their source status onto
    Task.status instead of all landing as NOT_STARTED."""
    from trueppm_api.apps.projects.models import TaskStatus

    from .fixtures import STATUS_EXPORT

    data = parse_jira_xml(STATUS_EXPORT)
    import_project(str(project.pk), data)
    by_name = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
    assert by_name["Shipped work"].status == TaskStatus.COMPLETE
    assert by_name["Active work"].status == TaskStatus.IN_PROGRESS
    assert by_name["Not yet started"].status == TaskStatus.NOT_STARTED
    # Unknown / missing status falls back to the model default.
    assert by_name["Unknown status"].status == TaskStatus.NOT_STARTED
    assert by_name["No status element"].status == TaskStatus.NOT_STARTED
    # A COMPLETE issue is 100% delivered (1.0 fraction), not the 0% bulk_create
    # would otherwise persist; non-terminal statuses stay 0%.
    assert by_name["Shipped work"].percent_complete == 1.0
    assert by_name["Active work"].percent_complete == 0.0
