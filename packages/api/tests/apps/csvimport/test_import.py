"""End-to-end import, CPM computability, and view/RBAC tests (#743, ADR-0632)."""

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
from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
from trueppm_api.apps.csvimport.parser import parse_spreadsheet
from trueppm_api.apps.csvimport.views import _require_project_scheduler
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Label,
    Project,
    Task,
    TaskLabel,
)
from trueppm_api.apps.resources.models import Resource
from trueppm_api.apps.scheduling.graph_guard import (
    InfeasibleGraphError,
    validate_task_graph,
)
from trueppm_api.apps.scheduling.tasks import _run_schedule

from .fixtures import (
    CYCLIC_CSV,
    INDENTED_CSV,
    LABELS_CSV,
    MULTI_PREDECESSOR_CSV,
    REFERENCE_CSV,
    build_xlsx,
)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="CSV Target", start_date=date(2026, 1, 5), calendar=calendar)


def _edges(data: object) -> list[tuple[str, str]]:
    return [
        (str(link.predecessor_uid), str(task.uid))
        for task in data.tasks  # type: ignore[attr-defined]
        for link in task.predecessor_links
    ]


@pytest.mark.django_db
class TestImportComputability:
    """The whole point of ADR-0632: CSV reuses the shared persistence path."""

    def test_import_creates_a_cpm_schedulable_network(self, project: Project) -> None:
        parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        validate_task_graph(_edges(parsed.project_data))

        summary = import_project(str(project.pk), parsed.project_data)
        assert summary["tasks_created"] == 7
        assert summary["dependencies_created"] == 4

        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        ):
            _run_schedule(str(project.pk))

        tasks = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
        assert tasks["Data model"].early_start is not None
        # The chain orders: Web UI cannot start before Data model.
        assert tasks["Web UI"].early_start >= tasks["Data model"].early_start

    def test_wbs_column_becomes_an_ltree_hierarchy(self, project: Project) -> None:
        parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        tasks = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
        assert str(tasks["Discovery"].wbs_path) == "1"
        assert str(tasks["Stakeholder interviews"].wbs_path) == "1.1"
        assert str(tasks["Web UI"].wbs_path) == "2.3"

    def test_indentation_becomes_an_ltree_hierarchy(self, project: Project) -> None:
        parsed = parse_spreadsheet(INDENTED_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        tasks = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
        assert str(tasks["Phase One"].wbs_path) == "1"
        assert str(tasks["Design"].wbs_path) == "1.1"
        assert str(tasks["Backend"].wbs_path) == "1.2.1"
        assert str(tasks["Phase Two"].wbs_path) == "2"

    def test_dependency_types_and_lag_persist(self, project: Project) -> None:
        parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        deps = {
            d.successor.name: d
            for d in Dependency.objects.filter(
                predecessor__project=project, is_deleted=False
            ).select_related("successor")
        }
        assert deps["API endpoints"].dep_type == "SS"
        assert deps["Web UI"].lag == 2

    def test_assignees_are_matched_or_created_as_resources(self, project: Project) -> None:
        parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        names = set(Resource.objects.values_list("name", flat=True))
        assert {"A. Rivera", "J. Chen", "P. Osei"} <= names

    def test_xlsx_takes_the_identical_path(self, project: Project) -> None:
        content = build_xlsx(
            [["Name", "Duration", "Start"], ["Design", 3, "2026-03-02"], ["Build", 5, ""]]
        )
        parsed = parse_spreadsheet(content, "plan.xlsx")
        summary = import_project(str(project.pk), parsed.project_data)
        assert summary["tasks_created"] == 2

    def test_cyclic_import_is_rejected_before_any_write(self, project: Project) -> None:
        parsed = parse_spreadsheet(CYCLIC_CSV, "plan.csv")
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(_edges(parsed.project_data))
        assert exc.value.reason == "cyclic_dependency"
        assert Task.objects.filter(project=project).count() == 0


@pytest.mark.django_db
class TestImportTaskDeadLettering:
    def test_cyclic_file_marks_the_row_dead_and_creates_no_tasks(self, project: Project) -> None:
        from trueppm_api.apps.csvimport.tasks import import_csv

        req = CsvImportRequest.objects.create(
            project=project,
            filename="cyclic.csv",
            file_content_b64=base64.b64encode(CYCLIC_CSV).decode("ascii"),
            status=CsvImportStatus.DISPATCHED,
        )
        result = import_csv.apply(
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
        # Terminal: the drain must not re-dispatch a deterministically bad file.
        assert req.status == CsvImportStatus.DEAD
        assert req.file_content_b64 == ""
        assert Task.objects.filter(project=project).count() == 0
        # The reason survives for the Schedule to show (#2151), and it is written
        # in the uploader's coordinates: CYCLIC_CSV's two tasks are data rows 0
        # and 1 -> uids 1 and 2 -> spreadsheet rows 2 and 3 under the header.
        detail = req.result_summary["error"]
        assert "circular" in detail.lower()
        assert "row 2" in detail
        assert "row 3" in detail
        # Not the exception's own repr: no internal reason code, no list literal,
        # and no uid leaking through off-by-one against the file on screen (#2501).
        assert "cyclic_dependency" not in detail
        assert "Infeasible task graph" not in detail
        assert "['" not in detail

    def test_cycle_detail_names_rows_not_uids(self) -> None:
        """`_describe_bad_graph` renders uid space as spreadsheet rows.

        Unit-level because the two reasons diverge and only one is reachable from
        a real file: `parse_spreadsheet` already drops a self-referencing link as
        a row error, so the `self_reference` branch is defense-in-depth for any
        future caller that hands `validate_task_graph` an unfiltered edge set.
        """
        from trueppm_api.apps.csvimport.tasks import _describe_bad_graph

        cyclic = _describe_bad_graph(InfeasibleGraphError("cyclic_dependency", ["1", "4", "1"]))
        assert "row 2 -> row 5 -> row 2" in cyclic

        loop = _describe_bad_graph(InfeasibleGraphError("self_reference", ["6"]))
        assert "row 7" in loop
        assert "circular" not in loop.lower()

        # A non-numeric id cannot come from this parser, but must not crash the
        # dead-letter path that is the only surface reporting the failure.
        odd = _describe_bad_graph(InfeasibleGraphError("cyclic_dependency", ["a", "b", "a"]))
        assert "task a -> task b -> task a" in odd

    def test_unreadable_file_marks_the_row_dead_with_a_reason(self, project: Project) -> None:
        from trueppm_api.apps.csvimport.tasks import import_csv

        req = CsvImportRequest.objects.create(
            project=project,
            filename="junk.csv",
            file_content_b64=base64.b64encode(b"Widget,Cost\nBolt,1\n").decode("ascii"),
            status=CsvImportStatus.DISPATCHED,
        )
        import_csv.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": req.file_content_b64,
                "filename": req.filename,
                "import_request_id": str(req.pk),
            },
            throw=False,
        )
        req.refresh_from_db()
        assert req.status == CsvImportStatus.DEAD
        assert "task name" in req.result_summary["error"]

    def test_partial_success_records_row_errors_and_still_imports(self, project: Project) -> None:
        """Partial success is the common case, and must read as a result."""
        from trueppm_api.apps.csvimport.tasks import import_csv

        from .fixtures import MESSY_CSV

        req = CsvImportRequest.objects.create(
            project=project,
            filename="messy.csv",
            file_content_b64=base64.b64encode(MESSY_CSV).decode("ascii"),
            status=CsvImportStatus.DISPATCHED,
        )
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        ):
            summary = import_csv.apply(
                kwargs={
                    "project_id": str(project.pk),
                    "file_content_b64": req.file_content_b64,
                    "filename": req.filename,
                    "import_request_id": str(req.pk),
                },
                throw=True,
            ).get()

        assert summary["tasks_created"] == 5
        assert summary["row_error_count"] == 5
        req.refresh_from_db()
        assert req.status == CsvImportStatus.DONE
        assert req.result_summary["row_error_count"] == 5
        assert Task.objects.filter(project=project, is_deleted=False).count() == 5

    def test_duplicate_delivery_does_not_double_import(self, project: Project) -> None:
        """acks_late redelivery must not bulk-create the network twice."""
        from trueppm_api.apps.csvimport.tasks import import_csv

        req = CsvImportRequest.objects.create(
            project=project,
            filename="plan.csv",
            file_content_b64=base64.b64encode(REFERENCE_CSV).decode("ascii"),
            status=CsvImportStatus.DISPATCHED,
        )
        kwargs = {
            "project_id": str(project.pk),
            "file_content_b64": req.file_content_b64,
            "filename": req.filename,
            "import_request_id": str(req.pk),
        }
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        ):
            import_csv.apply(kwargs=kwargs, throw=True)
            second = import_csv.apply(kwargs=kwargs, throw=True).get()

        assert second == {"skipped": True, "tasks_created": 0}
        assert Task.objects.filter(project=project, is_deleted=False).count() == 7


@pytest.mark.django_db
class TestCsvImportViewRBAC:
    def _upload(self, name: str = "plan.csv", body: bytes = REFERENCE_CSV) -> SimpleUploadedFile:
        return SimpleUploadedFile(name, body, content_type="text/csv")

    def _client(self, user: object) -> APIClient:
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def _user(self, project: Project, role: int, username: str) -> object:
        user = get_user_model().objects.create_user(username=username, password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=role)
        return user

    def test_anonymous_is_denied(self, project: Project) -> None:
        r = APIClient().post(
            f"/api/v1/projects/{project.pk}/import/csv/",
            {"file": self._upload()},
            format="multipart",
        )
        assert r.status_code in (401, 403)
        assert not CsvImportRequest.objects.filter(project=project).exists()

    @pytest.mark.parametrize(
        ("role", "username"), [(Role.VIEWER, "viewer"), (Role.MEMBER, "member")]
    )
    def test_viewer_and_member_cannot_import(
        self, project: Project, role: int, username: str
    ) -> None:
        user = self._user(project, role, username)
        r = self._client(user).post(
            f"/api/v1/projects/{project.pk}/import/csv/",
            {"file": self._upload()},
            format="multipart",
        )
        assert r.status_code == 403
        assert not CsvImportRequest.objects.filter(project=project).exists()

    @pytest.mark.parametrize(
        ("role", "username"),
        [(Role.SCHEDULER, "sched"), (Role.ADMIN, "admin"), (Role.OWNER, "owner")],
    )
    def test_scheduler_admin_and_owner_can_import(
        self,
        project: Project,
        role: int,
        username: str,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        user = self._user(project, role, username)
        with (
            patch("trueppm_api.apps.csvimport.services.enqueue_csv_import") as mock_enqueue,
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            r = self._client(user).post(
                f"/api/v1/projects/{project.pk}/import/csv/",
                {"file": self._upload()},
                format="multipart",
            )
        assert r.status_code == 202
        req = CsvImportRequest.objects.get(project=project)
        assert req.status == CsvImportStatus.PENDING
        mock_enqueue.assert_called_once_with(str(req.pk))

    def test_response_carries_the_outbox_id_not_a_celery_task_id(
        self, project: Project, django_capture_on_commit_callbacks: object
    ) -> None:
        """ADR-0632 decision 6 -- no celery_task_id exists at 202 time."""
        user = self._user(project, Role.SCHEDULER, "sched2")
        with (
            patch("trueppm_api.apps.csvimport.services.enqueue_csv_import"),
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            r = self._client(user).post(
                f"/api/v1/projects/{project.pk}/import/csv/",
                {"file": self._upload()},
                format="multipart",
            )
        assert r.data["queued"] is True
        assert "import_request_id" in r.data
        assert "celery_task_id" not in r.data

    def test_column_map_is_persisted_for_drain_replay(
        self, project: Project, django_capture_on_commit_callbacks: object
    ) -> None:
        """A re-dispatch must replay the operator's mapping, not re-detect."""
        user = self._user(project, Role.SCHEDULER, "sched3")
        with (
            patch("trueppm_api.apps.csvimport.services.enqueue_csv_import"),
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            self._client(user).post(
                f"/api/v1/projects/{project.pk}/import/csv/",
                {"file": self._upload(), "column_map": '{"Task": "name"}'},
                format="multipart",
            )
        req = CsvImportRequest.objects.get(project=project)
        assert req.column_map == {"Task": "name"}

    def test_rejects_unsupported_extension(self, project: Project) -> None:
        user = self._user(project, Role.SCHEDULER, "sched4")
        r = self._client(user).post(
            f"/api/v1/projects/{project.pk}/import/csv/",
            {"file": SimpleUploadedFile("plan.pdf", b"%PDF-1.4", content_type="application/pdf")},
            format="multipart",
        )
        assert r.status_code == 400
        assert not CsvImportRequest.objects.filter(project=project).exists()

    def test_rejects_missing_file_field(self, project: Project) -> None:
        user = self._user(project, Role.SCHEDULER, "sched5")
        r = self._client(user).post(
            f"/api/v1/projects/{project.pk}/import/csv/", {}, format="multipart"
        )
        assert r.status_code == 400
        assert "No file provided" in r.data["detail"]

    def test_rejects_upload_over_the_size_cap(self, project: Project, settings: object) -> None:
        settings.CSV_IMPORT_MAX_UPLOAD_MB = 0  # type: ignore[attr-defined]
        user = self._user(project, Role.SCHEDULER, "sched6")
        r = self._client(user).post(
            f"/api/v1/projects/{project.pk}/import/csv/",
            {"file": self._upload()},
            format="multipart",
        )
        assert r.status_code == 400
        assert "too large" in r.data["detail"]

    def test_filename_is_sanitized(
        self, project: Project, django_capture_on_commit_callbacks: object
    ) -> None:
        user = self._user(project, Role.SCHEDULER, "sched7")
        with (
            patch("trueppm_api.apps.csvimport.services.enqueue_csv_import"),
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            self._client(user).post(
                f"/api/v1/projects/{project.pk}/import/csv/",
                {"file": self._upload(name="../../etc/<script>.csv")},
                format="multipart",
            )
        req = CsvImportRequest.objects.get(project=project)
        assert "/" not in req.filename
        assert "<" not in req.filename

    def test_in_body_role_check_is_authoritative(self, project: Project) -> None:
        """Defense in depth behind the DRF permission class."""
        member = self._user(project, Role.MEMBER, "member2")
        with pytest.raises(PermissionDenied):
            _require_project_scheduler(member, str(project.pk))


@pytest.mark.django_db
class TestPreviewEndpoint:
    def _client(self, project: Project, role: int, username: str) -> APIClient:
        user = get_user_model().objects.create_user(username=username, password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=role)
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def test_preview_returns_mapping_and_persists_nothing(self, project: Project) -> None:
        client = self._client(project, Role.SCHEDULER, "p1")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {"file": SimpleUploadedFile("plan.csv", REFERENCE_CSV, content_type="text/csv")},
            format="multipart",
        )
        assert r.status_code == 200
        by_header = {c["header"]: c["field"] for c in r.data["columns"]}
        assert by_header["Task"] == "name"
        assert by_header["Depends On"] == "predecessors"
        assert r.data["task_count"] == 7
        # Nothing was written -- neither tasks nor an outbox row.
        assert Task.objects.filter(project=project).count() == 0
        assert not CsvImportRequest.objects.filter(project=project).exists()

    def test_preview_returns_at_most_ten_sample_rows(self, project: Project) -> None:
        body = b"Name,Duration\n" + b"".join(f"Task {i},1\n".encode() for i in range(40))
        client = self._client(project, Role.SCHEDULER, "p2")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {"file": SimpleUploadedFile("plan.csv", body, content_type="text/csv")},
            format="multipart",
        )
        assert len(r.data["sample_rows"]) == 10
        assert r.data["row_count"] == 40

    def test_preview_offers_the_field_catalog_for_the_dropdown(self, project: Project) -> None:
        client = self._client(project, Role.SCHEDULER, "p3")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {"file": SimpleUploadedFile("plan.csv", REFERENCE_CSV, content_type="text/csv")},
            format="multipart",
        )
        fields = {f["field"] for f in r.data["available_fields"]}
        assert {"name", "duration", "planned_start", "predecessors"} <= fields

    def test_preview_honors_a_column_override(self, project: Project) -> None:
        client = self._client(project, Role.SCHEDULER, "p4")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {
                "file": SimpleUploadedFile(
                    "plan.csv", b"Widget\nDesign\n", content_type="text/csv"
                ),
                "column_map": '{"Widget": "name"}',
            },
            format="multipart",
        )
        assert r.status_code == 200
        assert r.data["columns"][0]["field"] == "name"

    def test_preview_reports_an_unusable_file_as_400(self, project: Project) -> None:
        client = self._client(project, Role.SCHEDULER, "p5")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {"file": SimpleUploadedFile("plan.csv", b"Widget,Cost\nBolt,1\n")},
            format="multipart",
        )
        assert r.status_code == 400
        assert "task name" in r.data["detail"]

    def test_preview_is_gated_at_the_same_role_as_commit(self, project: Project) -> None:
        """Preview parses attacker-supplied files; it is not a lighter surface."""
        client = self._client(project, Role.MEMBER, "p6")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {"file": SimpleUploadedFile("plan.csv", REFERENCE_CSV)},
            format="multipart",
        )
        assert r.status_code == 403


@pytest.mark.django_db
class TestStatusEndpoint:
    def _client(self, project: Project, role: int, username: str) -> APIClient:
        user = get_user_model().objects.create_user(username=username, password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=role)
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def test_status_returns_the_terminal_summary(self, project: Project) -> None:
        req = CsvImportRequest.objects.create(
            project=project,
            filename="plan.csv",
            file_content_b64="",
            status=CsvImportStatus.DONE,
            result_summary={"tasks_created": 7, "row_error_count": 2},
        )
        client = self._client(project, Role.SCHEDULER, "s1")
        r = client.get(f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/")
        assert r.status_code == 200
        assert r.data["status"] == "done"
        assert r.data["summary"]["tasks_created"] == 7

    def test_an_id_from_another_project_is_not_readable(
        self, project: Project, calendar: Calendar
    ) -> None:
        """Scoping by project as well as pk closes the IDOR."""
        other = Project.objects.create(name="Other", start_date=date(2026, 1, 5), calendar=calendar)
        req = CsvImportRequest.objects.create(
            project=other, filename="secret.csv", file_content_b64=""
        )
        client = self._client(project, Role.SCHEDULER, "s2")
        r = client.get(f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/")
        assert r.status_code == 404


@pytest.mark.django_db
class TestTemplateEndpoint:
    def test_template_downloads_as_csv(self) -> None:
        user = get_user_model().objects.create_user(username="tpl", password="pw")
        client = APIClient()
        client.force_authenticate(user=user)
        r = client.get("/api/v1/import-templates/csv/")
        assert r.status_code == 200
        assert r["Content-Type"].startswith("text/csv")
        assert "attachment" in r["Content-Disposition"]
        assert b"Predecessors" in r.content

    def test_template_requires_authentication(self) -> None:
        r = APIClient().get("/api/v1/import-templates/csv/")
        assert r.status_code in (401, 403)


# --- labels (#2406, ADR-0400) ----------------------------------------------


def _import_labels_csv(project: Project, csv: bytes = LABELS_CSV) -> dict:
    data = parse_spreadsheet(csv, "labels.csv").project_data
    return import_project(str(project.pk), data)


def test_labels_are_created_and_attached(project: Project) -> None:
    summary = _import_labels_csv(project)

    assert summary["labels_created"] == 5  # safety, rework, Civil, permit, Structural
    assert set(Label.objects.filter(project=project).values_list("name", flat=True)) == {
        "safety",
        "rework",
        "Civil",
        "permit",
        "Structural",
    }
    survey = Task.objects.get(project=project, name="Site survey")
    assert set(survey.labels.values_list("name", flat=True)) == {"safety", "rework", "Civil"}


def test_a_task_with_no_labels_gets_none(project: Project) -> None:
    _import_labels_csv(project)
    assert Task.objects.get(project=project, name="Fit-out").labels.count() == 0


def test_existing_catalog_entries_are_matched_case_insensitively(project: Project) -> None:
    """An import must reuse `safety` rather than minting `Safety` beside it."""
    existing = Label.objects.create(project=project, name="Safety")

    summary = _import_labels_csv(project)

    assert summary["labels_matched"] == 1
    assert Label.objects.filter(project=project, name__iexact="safety").count() == 1
    survey = Task.objects.get(project=project, name="Site survey")
    # The curated catalog spelling wins over the spreadsheet's.
    assert existing in survey.labels.all()


def test_labels_are_scoped_to_the_target_project(project: Project, calendar: Calendar) -> None:
    """`Label` is project-scoped — a same-named label elsewhere is not a match."""
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 5), calendar=calendar)
    Label.objects.create(project=other, name="safety")

    _import_labels_csv(project)

    assert Label.objects.filter(project=project, name="safety").exists()
    assert Label.objects.filter(project=other, name="safety").count() == 1


def test_re_import_is_idempotent(project: Project) -> None:
    """Re-running the same file must not duplicate catalog entries or links."""
    _import_labels_csv(project)
    before_labels = Label.objects.filter(project=project).count()
    before_links = TaskLabel.objects.filter(task__project=project).count()

    # wipe_existing mirrors the create-from-import path (ADR-0092); the labels
    # survive because the catalog is project-scoped, not task-scoped.
    data = parse_spreadsheet(LABELS_CSV, "labels.csv").project_data
    import_project(str(project.pk), data, wipe_existing=True)

    assert Label.objects.filter(project=project).count() == before_labels
    assert TaskLabel.objects.filter(task__project=project).count() == before_links


def test_new_labels_get_distinguishable_colors(project: Project) -> None:
    """A wall of the default color makes the pill row useless."""
    _import_labels_csv(project)
    colors = list(Label.objects.filter(project=project).values_list("color", flat=True))
    assert len(set(colors)) > 1


def test_a_file_with_no_label_column_creates_no_labels(project: Project) -> None:
    data = parse_spreadsheet(REFERENCE_CSV, "ref.csv").project_data
    summary = import_project(str(project.pk), data)
    assert summary["labels_created"] == 0
    assert not Label.objects.filter(project=project).exists()


def test_multi_column_predecessors_create_both_dependencies(project: Project) -> None:
    data = parse_spreadsheet(MULTI_PREDECESSOR_CSV, "preds.csv").project_data
    import_project(str(project.pk), data)

    build = Task.objects.get(project=project, name="Build")
    assert Dependency.objects.filter(successor=build).count() == 2
    # The same ref repeated across two columns is one relationship, not two.
    inspect = Task.objects.get(project=project, name="Inspect")
    assert Dependency.objects.filter(successor=inspect).count() == 1
