"""End-to-end import, CPM computability, and view/RBAC tests (#743, ADR-0632)."""

from __future__ import annotations

import base64
from datetime import date
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.exceptions import PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
from trueppm_api.apps.csvimport.parser import parse_spreadsheet
from trueppm_api.apps.csvimport.views import _parse_date_order, _require_project_scheduler
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

    def test_extreme_indent_depth_is_clamped_not_left_unbounded(self, project: Project) -> None:
        """An extreme indent depth must clamp, not reach the WBS-path builder
        unbounded (#2761).

        Unclamped, this depth would route into `_wbs_paths_from_levels` and mint
        an ltree path exceeding Postgres's label-count ceiling -- raising a
        `DataError` from `bulk_create` that used to escape every handler in
        `import_csv`. The parser must instead clamp the depth and report a
        normal row warning; the row still imports.
        """
        from trueppm_api.apps.csvimport.parser import MAX_OUTLINE_DEPTH

        from .fixtures import EXTREME_INDENT_CSV

        parsed = parse_spreadsheet(EXTREME_INDENT_CSV, "plan.csv")
        deep = next(t for t in parsed.project_data.tasks if t.name == "Deep")
        assert deep.outline_level == MAX_OUTLINE_DEPTH

        matching = [e for e in parsed.row_errors if e.code == "excessive_indent_depth"]
        assert len(matching) == 1
        assert matching[0].severity == "warning"

        # No DataError from an oversized ltree path -- the row still persists,
        # and the resulting ltree path stays well under Postgres's 65,535-label
        # ceiling rather than growing unbounded with the raw indent depth.
        import_project(str(project.pk), parsed.project_data)
        deep_task = Task.objects.get(project=project, name="Deep")
        assert len(str(deep_task.wbs_path).split(".")) <= MAX_OUTLINE_DEPTH + 1

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

    def test_owner_column_writes_task_resource_not_a_bare_assignee(self, project: Project) -> None:
        """The Owner mapping target must land on the capacity axis (ADR-0774, #2718).

        The importer already does this; the assertion exists so it cannot regress to
        ``Task.assignee`` under a future refactor. A bare ``assignee`` contributes ZERO
        to every capacity, utilization, heat-map and sprint-capacity number, silently
        and permanently — and nothing in the product would report the discrepancy.
        """
        from trueppm_api.apps.resources.models import ProjectResource, TaskResource

        parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        assignments = TaskResource.objects.filter(task__project=project)
        assert assignments.exists(), "the Owner column produced no TaskResource rows"
        assert all(a.units > 0 for a in assignments)

        # Nothing on this path may write the legacy quick-assign field.
        assert not Task.objects.filter(project=project, assignee__isnull=False).exists()

        # Every assigned person is on the roster, so they are visible in Team → Roster,
        # Allocation, and the heat map rather than assigned-but-invisible (#241).
        assigned_ids = set(assignments.values_list("resource_id", flat=True))
        rostered_ids = set(
            ProjectResource.objects.filter(project=project, is_deleted=False).values_list(
                "resource_id", flat=True
            )
        )
        assert assigned_ids <= rostered_ids

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
class TestImportReviewBranchPersists:
    """The parked rows have to be real outline tasks, not a summary field (#2732).

    The parser's own tests prove the branch is *built*; these prove it survives
    the shared persistence path as a subtree an operator can actually edit.
    """

    def test_the_branch_lands_as_a_subtree_at_the_bottom_of_the_outline(
        self, project: Project
    ) -> None:
        from .fixtures import MESSY_CSV

        parsed = parse_spreadsheet(MESSY_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        tasks = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
        branch = tasks["Import review"]
        parked = tasks["Row 7 — no task name"]
        # The parked row is a child of the branch, and the branch is a sibling
        # of the plan's top-level rows rather than nested inside one of them.
        assert str(parked.wbs_path).startswith(f"{branch.wbs_path}.")
        assert "." not in str(branch.wbs_path)

    def test_the_branch_does_not_flatten_an_indented_plan(self, project: Project) -> None:
        """Regression guard for the _build_wbs_paths mode flip.

        A dotted outline number on the review branch would push the *whole*
        import into the dotted branch of `_build_wbs_paths`, re-deriving every
        real task's path from a sequence number and flattening the hierarchy
        that indentation encoded.
        """
        from .fixtures import INDENTED_WITH_NAMELESS_CSV

        parsed = parse_spreadsheet(INDENTED_WITH_NAMELESS_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        tasks = {t.name: t for t in Task.objects.filter(project=project, is_deleted=False)}
        assert str(tasks["Phase One"].wbs_path) == "1"
        assert str(tasks["Design"].wbs_path) == "1.1"
        assert str(tasks["Build"].wbs_path) == "1.2"
        assert str(tasks["Import review"].wbs_path) == "2"
        assert str(tasks["Row 5 — no task name"].wbs_path) == "2.1"

    def test_a_file_of_only_bad_rows_still_produces_a_plan_to_open(self, project: Project) -> None:
        """ "No tasks found in file" was the old outcome — and the rows were gone."""
        from .fixtures import ALL_NAMELESS_CSV

        parsed = parse_spreadsheet(ALL_NAMELESS_CSV, "plan.csv")
        summary = import_project(str(project.pk), parsed.project_data)

        assert summary["tasks_created"] == 3
        assert "No tasks found in file" not in summary["warnings"]
        names = set(
            Task.objects.filter(project=project, is_deleted=False).values_list("name", flat=True)
        )
        assert names == {"Import review", "Row 2 — no task name", "Row 3 — no task name"}

    def test_a_parked_row_keeps_its_values_where_a_person_can_read_them(
        self, project: Project
    ) -> None:
        from .fixtures import MESSY_CSV

        parsed = parse_spreadsheet(MESSY_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        parked = Task.objects.get(project=project, name="Row 7 — no task name")
        assert "ID: 6" in parked.notes
        assert "Start: 2026-03-02" in parked.notes

    def test_parked_rows_add_no_dependencies_or_assignments(self, project: Project) -> None:
        """The branch must not perturb the network the graph guard validated."""
        from .fixtures import MESSY_CSV

        parsed = parse_spreadsheet(MESSY_CSV, "plan.csv")
        # No new edges: the guard sees exactly the real rows' graph (ADR-0259).
        validate_task_graph(_edges(parsed.project_data))
        summary = import_project(str(project.pk), parsed.project_data)

        parked = Task.objects.get(project=project, name="Row 7 — no task name")
        assert not Dependency.objects.filter(successor=parked).exists()
        assert not Dependency.objects.filter(predecessor=parked).exists()
        # An owner on a parked row would have to be a TaskResource with units,
        # never a bare assignee (#2718) — so the import writes neither.
        assert parked.assignee_id is None
        assert summary["assignments_created"] == 0

    def test_the_branch_is_a_normal_task_a_scheduler_can_delete(self, project: Project) -> None:
        """ "Every fix is a normal edit": no bespoke repair endpoint exists."""
        from .fixtures import MESSY_CSV

        parsed = parse_spreadsheet(MESSY_CSV, "plan.csv")
        import_project(str(project.pk), parsed.project_data)

        parked = Task.objects.get(project=project, name="Row 7 — no task name")
        parked.name = "Site survey"
        parked.save(update_fields=["name"])
        assert Task.objects.filter(project=project, name="Site survey").exists()

    def test_an_all_parked_import_still_tells_live_collaborators(
        self,
        project: Project,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        """A file of only bad rows used to write nothing and broadcast nothing.

        The `tasks_created > 0` guard in `import_csv` counts every row written,
        review branch included, which is why this now fires. Pinned because the
        guard reads a count: swapping it to `plan_tasks_created` — which is 0 on
        exactly this branch — would silently restore the old silence with every
        other test still green.

        The broadcast is deferred with `transaction.on_commit`, which never runs
        under pytest-django's wrapping transaction, so it has to be captured
        rather than merely patched.
        """
        from trueppm_api.apps.csvimport.tasks import import_csv

        from .fixtures import ALL_NAMELESS_CSV

        req = CsvImportRequest.objects.create(
            project=project,
            filename="all-bad.csv",
            file_content_b64=base64.b64encode(ALL_NAMELESS_CSV).decode("ascii"),
            status=CsvImportStatus.DISPATCHED,
        )
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as recalculate,
            django_capture_on_commit_callbacks(execute=True),
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

        assert summary["plan_tasks_created"] == 0
        assert summary["parked_row_count"] == 2
        broadcast.assert_any_call(str(project.pk), "tasks_restructured", {})
        recalculate.assert_called_once_with(str(project.pk))


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

    def test_extreme_wbs_depth_clamps_and_completes_the_import(self, project: Project) -> None:
        """Same failure mode as the indentation case, via the bare-digit WBS
        column, exercised end-to-end through the async task (#2761).

        The request must complete DONE with the depth clamped and reported as a
        row warning -- not dead-letter, and not hang DISPATCHED.
        """
        from trueppm_api.apps.csvimport.tasks import import_csv

        from .fixtures import EXTREME_WBS_DEPTH_CSV

        req = CsvImportRequest.objects.create(
            project=project,
            filename="deep_wbs.csv",
            file_content_b64=base64.b64encode(EXTREME_WBS_DEPTH_CSV).decode("ascii"),
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

        assert summary["tasks_created"] == 2
        assert any(e["code"] == "excessive_indent_depth" for e in summary["row_errors"])
        req.refresh_from_db()
        assert req.status == CsvImportStatus.DONE

    def test_unexpected_persistence_failure_dead_letters_instead_of_looping(
        self, project: Project
    ) -> None:
        """A persistence failure the parser's own caps did not anticipate must
        still dead-letter the request rather than leave it DISPATCHED (#2761).

        Before this fix, `import_csv` only caught `CsvImportError` and
        `InfeasibleGraphError` around `import_project`; any other exception
        (e.g. a Postgres `DataError`) escaped uncaught, so the row was never
        marked DEAD and the 15-minute orphan-recovery drain retried it
        identically forever -- a self-sustaining worker-slot DoS with no
        user-visible error.
        """
        from django.db.utils import DataError

        from trueppm_api.apps.csvimport.tasks import import_csv

        req = CsvImportRequest.objects.create(
            project=project,
            filename="plan.csv",
            file_content_b64=base64.b64encode(REFERENCE_CSV).decode("ascii"),
            status=CsvImportStatus.DISPATCHED,
        )
        with patch(
            "trueppm_api.apps.msproject.importer.import_project",
            side_effect=DataError("value too long for type character varying(65535)"),
        ):
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
        # Terminal: the drain must not re-dispatch a request stuck on a
        # persistence failure it will hit identically on every retry.
        assert req.status == CsvImportStatus.DEAD
        assert req.file_content_b64 == ""
        assert "unexpectedly" in req.result_summary["error"].lower()
        assert Task.objects.filter(project=project).count() == 0

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

        # Seven rows written: five plan tasks, plus the review branch's summary
        # and the one row that could not be resolved (#2732). The plan count is
        # reported separately so "imported 5 tasks" stays true.
        assert summary["tasks_created"] == 7
        assert summary["plan_tasks_created"] == 5
        assert summary["parked_row_count"] == 1
        assert summary["review_branch_name"] == "Import review"
        assert summary["row_error_count"] == 5
        req.refresh_from_db()
        assert req.status == CsvImportStatus.DONE
        assert req.result_summary["row_error_count"] == 5
        assert req.result_summary["parked_row_count"] == 1
        assert Task.objects.filter(project=project, is_deleted=False).count() == 7

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

    def test_preview_counts_parked_rows_apart_from_the_plan(self, project: Project) -> None:
        """The operator's decision is "how much plan, how much to fix" (#2732)."""
        from .fixtures import MESSY_CSV

        client = self._client(project, Role.SCHEDULER, "p7")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {"file": SimpleUploadedFile("messy.csv", MESSY_CSV, content_type="text/csv")},
            format="multipart",
        )
        assert r.status_code == 200
        # `task_count` is the plan, not the plan plus the review branch, so the
        # confirm step's "Import N tasks" does not count placeholders.
        assert r.data["task_count"] == 5
        assert r.data["parked_row_count"] == 1
        assert r.data["review_branch_name"] == "Import review"

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


@pytest.mark.django_db
class TestDateOrderEndpoint:
    """#2926 — `date_order` on both the preview and the commit call.

    Date order was the last locale decision that was inferred and unaddressable:
    encoding, delimiter and decimal separator are all settled from the file's own
    evidence, so the same rows could import differently depending on which values
    happened to disambiguate the column. That is a correctness bug for an
    operator and a non-determinism bug for a scripted caller.
    """

    #: Every value valid under both conventions — the file identifies nothing.
    AMBIGUOUS = b"Name,Start,Finish\nDesign,03/04/2026,05/04/2026\n"

    def _client(self, project: Project, username: str) -> APIClient:
        user = get_user_model().objects.create_user(username=username, password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def _preview(self, client: APIClient, project: Project, **extra: object) -> Any:
        return client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {
                "file": SimpleUploadedFile("plan.csv", self.AMBIGUOUS, content_type="text/csv"),
                **extra,
            },
            format="multipart",
        )

    def test_preview_reports_the_ambiguity_and_both_readings(self, project: Project) -> None:
        r = self._preview(self._client(project, "d1"), project)
        assert r.status_code == 200
        assert r.data["date_order_ambiguous"] is True
        assert r.data["date_order_resolved"] == "mdy"
        assert r.data["date_order_evidence"] is None
        durations = {x["order"]: x["duration_days"] for x in r.data["date_order_readings"]}
        # The 59-day difference the operator is being asked to rule on.
        assert durations == {"mdy": 62, "dmy": 3}

    def test_preview_under_an_override_reads_the_dates_the_operator_meant(
        self, project: Project
    ) -> None:
        r = self._preview(self._client(project, "d2"), project, date_order="dmy")
        assert r.data["date_order_resolved"] == "dmy"
        assert r.data["date_order_ambiguous"] is False
        # Still names what auto would have done, so the change is legible.
        assert r.data["date_order_auto"] == "mdy"
        assert r.data["date_preview"][0]["start"] == "2026-04-03"
        assert r.data["date_preview"][0]["duration_days"] == 3

    def test_preview_states_the_evidence_when_the_file_identifies_itself(
        self, project: Project
    ) -> None:
        client = self._client(project, "d3")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",
            {
                "file": SimpleUploadedFile(
                    "plan.csv",
                    b"Name,Start\nDesign,03/04/2026\nHandover,13/04/2026\n",
                    content_type="text/csv",
                )
            },
            format="multipart",
        )
        evidence = r.data["date_order_evidence"]
        assert r.data["date_order_resolved"] == "dmy"
        assert evidence["value"] == "13/04/2026"
        assert evidence["column"] == "Start"
        assert evidence["reason"] == "no_thirteenth_month"

    def test_an_unknown_order_is_a_400_not_a_silent_fallback(self, project: Project) -> None:
        """A misspelled parameter that quietly reverted to auto is the whole bug class."""
        r = self._preview(self._client(project, "d4"), project, date_order="d/m/y")
        assert r.status_code == 400
        assert "date_order" in r.data

    def test_a_non_string_order_is_a_400_not_a_500(self) -> None:
        """`request.data` is attacker-shaped — the #2795 container-type class.

        Asserted against the helper rather than through the endpoint on purpose:
        ``MultiPartParser`` coerces every non-file value to ``str``, so a list
        posted as multipart arrives as its last element and the container case
        is genuinely unreachable *by that parser*. Pinning it here keeps the
        guard honest if the view ever accepts JSON — and documents why the
        endpoint test below cannot be the one that covers it.
        """
        for value in (["dmy"], {"order": "dmy"}, 3):
            request = SimpleNamespace(data={"date_order": value})
            with pytest.raises(DRFValidationError):
                _parse_date_order(cast("Any", request))

    def test_omitting_the_field_keeps_the_shipped_behavior(self, project: Project) -> None:
        r = self._preview(self._client(project, "d6"), project)
        assert r.data["date_order"] == "auto"
        assert r.data["date_preview"][0]["duration_days"] == 62

    def test_commit_persists_the_order_so_a_redispatch_replays_it(self, project: Project) -> None:
        """A drain re-dispatch must not re-infer — it would import different dates
        than the preview the operator approved."""
        client = self._client(project, "d7")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/",
            {
                "file": SimpleUploadedFile("plan.csv", self.AMBIGUOUS, content_type="text/csv"),
                "date_order": "dmy",
                "date_order_confirmed": "true",
            },
            format="multipart",
        )
        assert r.status_code == 202
        req = CsvImportRequest.objects.get(project=project)
        assert req.date_order == "dmy"
        assert req.date_order_confirmed is True

    def test_commit_rejects_an_unknown_order_before_writing_the_outbox_row(
        self, project: Project
    ) -> None:
        client = self._client(project, "d8")
        r = client.post(
            f"/api/v1/projects/{project.pk}/import/csv/",
            {
                "file": SimpleUploadedFile("plan.csv", self.AMBIGUOUS, content_type="text/csv"),
                "date_order": "nope",
            },
            format="multipart",
        )
        assert r.status_code == 400
        assert not CsvImportRequest.objects.filter(project=project).exists()
