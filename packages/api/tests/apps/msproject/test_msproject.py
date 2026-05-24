"""Tests for MS Project import/export."""

from __future__ import annotations

import pathlib
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.msproject.dataclasses import (
    AssignmentData,
    PredecessorLinkData,
    ProjectData,
    ResourceData,
    TaskData,
)
from trueppm_api.apps.msproject.exporter import export_project_xml
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.msproject.parser import (
    _parse_duration_to_days,
    _parse_lag_to_days,
    parse_xml,
)
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()

_NS = "http://schemas.microsoft.com/project"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="msp_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="MSP Test Project",
        start_date=date(2026, 1, 5),
        calendar=calendar,
    )


@pytest.fixture
def admin_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def viewer_client(project: Project) -> APIClient:
    viewer = User.objects.create_user(username="msp_viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


def _build_sample_xml(
    tasks: list[dict] | None = None,
    resources: list[dict] | None = None,
    assignments: list[dict] | None = None,
) -> bytes:
    """Build a minimal MS Project XML document for testing."""
    root = ET.Element(f"{{{_NS}}}Project")
    ET.SubElement(root, f"{{{_NS}}}Name").text = "Test Project"
    ET.SubElement(root, f"{{{_NS}}}StartDate").text = "2026-01-05T08:00:00"

    tasks_el = ET.SubElement(root, f"{{{_NS}}}Tasks")
    if tasks:
        for t in tasks:
            task_el = ET.SubElement(tasks_el, f"{{{_NS}}}Task")
            for k, v in t.items():
                if k == "PredecessorLinks":
                    for pl in v:
                        pl_el = ET.SubElement(task_el, f"{{{_NS}}}PredecessorLink")
                        for pk2, pv in pl.items():
                            ET.SubElement(pl_el, f"{{{_NS}}}{pk2}").text = str(pv)
                else:
                    ET.SubElement(task_el, f"{{{_NS}}}{k}").text = str(v)

    if resources:
        res_el = ET.SubElement(root, f"{{{_NS}}}Resources")
        for r in resources:
            r_el = ET.SubElement(res_el, f"{{{_NS}}}Resource")
            for k, v in r.items():
                ET.SubElement(r_el, f"{{{_NS}}}{k}").text = str(v)

    if assignments:
        asgn_el = ET.SubElement(root, f"{{{_NS}}}Assignments")
        for a in assignments:
            a_el = ET.SubElement(asgn_el, f"{{{_NS}}}Assignment")
            for k, v in a.items():
                ET.SubElement(a_el, f"{{{_NS}}}{k}").text = str(v)

    return ET.tostring(root, encoding="unicode").encode("utf-8")


# ---------------------------------------------------------------------------
# Parser unit tests
# ---------------------------------------------------------------------------


class TestDurationParsing:
    def test_hours_to_days(self) -> None:
        assert _parse_duration_to_days("PT16H0M0S") == 2

    def test_days_format(self) -> None:
        assert _parse_duration_to_days("P3D") == 3

    def test_mixed_days_hours(self) -> None:
        assert _parse_duration_to_days("P1DT8H0M0S") == 2

    def test_zero_duration(self) -> None:
        assert _parse_duration_to_days("PT0H0M0S") == 0

    def test_empty_string(self) -> None:
        assert _parse_duration_to_days("") == 1

    def test_invalid_string(self) -> None:
        assert _parse_duration_to_days("not a duration") == 1


class TestLagParsing:
    def test_one_day_lag(self) -> None:
        assert _parse_lag_to_days("4800") == 1

    def test_two_day_lag(self) -> None:
        assert _parse_lag_to_days("9600") == 2

    def test_zero_lag(self) -> None:
        assert _parse_lag_to_days("0") == 0

    def test_empty(self) -> None:
        assert _parse_lag_to_days("") == 0

    def test_sub_day_lag(self) -> None:
        assert _parse_lag_to_days("2400") == 0


class TestXmlParser:
    def test_parse_basic_tasks(self) -> None:
        xml = _build_sample_xml(
            tasks=[
                {
                    "UID": "1",
                    "Name": "Task A",
                    "Duration": "PT8H0M0S",
                    "OutlineNumber": "1",
                },
                {
                    "UID": "2",
                    "Name": "Task B",
                    "Duration": "PT16H0M0S",
                    "OutlineNumber": "2",
                },
            ]
        )
        data = parse_xml(xml)
        assert data.name == "Test Project"
        assert len(data.tasks) == 2
        assert data.tasks[0].name == "Task A"
        assert data.tasks[0].duration_days == 1
        assert data.tasks[1].name == "Task B"
        assert data.tasks[1].duration_days == 2

    def test_skip_uid_zero(self) -> None:
        xml = _build_sample_xml(
            tasks=[
                {"UID": "0", "Name": "Project Summary"},
                {"UID": "1", "Name": "Real Task"},
            ]
        )
        data = parse_xml(xml)
        assert len(data.tasks) == 1
        assert data.tasks[0].name == "Real Task"

    def test_parse_milestones(self) -> None:
        xml = _build_sample_xml(
            tasks=[
                {
                    "UID": "1",
                    "Name": "Kickoff",
                    "Milestone": "1",
                    "Duration": "PT0H0M0S",
                }
            ]
        )
        data = parse_xml(xml)
        assert data.tasks[0].is_milestone is True
        assert data.tasks[0].duration_days == 0

    def test_parse_predecessor_links(self) -> None:
        xml = _build_sample_xml(
            tasks=[
                {"UID": "1", "Name": "Task A"},
                {
                    "UID": "2",
                    "Name": "Task B",
                    "PredecessorLinks": [
                        {
                            "PredecessorUID": "1",
                            "Type": "1",
                            "LinkLag": "0",
                        }
                    ],
                },
            ]
        )
        data = parse_xml(xml)
        assert len(data.tasks[1].predecessor_links) == 1
        pl = data.tasks[1].predecessor_links[0]
        assert pl.predecessor_uid == 1
        assert pl.dep_type == "FS"
        assert pl.lag_days == 0

    def test_parse_all_link_types(self) -> None:
        links = [
            {"PredecessorUID": "1", "Type": "0"},
            {"PredecessorUID": "2", "Type": "1"},
            {"PredecessorUID": "3", "Type": "2"},
            {"PredecessorUID": "4", "Type": "3"},
        ]
        xml = _build_sample_xml(
            tasks=[
                {"UID": "1", "Name": "A"},
                {"UID": "2", "Name": "B"},
                {"UID": "3", "Name": "C"},
                {"UID": "4", "Name": "D"},
                {"UID": "5", "Name": "E", "PredecessorLinks": links},
            ]
        )
        data = parse_xml(xml)
        e_task = data.tasks[4]
        types = [pl.dep_type for pl in e_task.predecessor_links]
        assert types == ["FF", "FS", "SF", "SS"]

    def test_parse_resources_and_assignments(self) -> None:
        xml = _build_sample_xml(
            tasks=[{"UID": "1", "Name": "Task A"}],
            resources=[{"UID": "1", "Name": "Alice", "MaxUnits": "1.0"}],
            assignments=[{"TaskUID": "1", "ResourceUID": "1", "Units": "0.5"}],
        )
        data = parse_xml(xml)
        assert len(data.resources) == 1
        assert data.resources[0].name == "Alice"
        assert len(data.tasks[0].resource_assignments) == 1
        assert data.tasks[0].resource_assignments[0].units == 0.5

    def test_skip_resource_uid_zero(self) -> None:
        xml = _build_sample_xml(
            resources=[
                {"UID": "0", "Name": "Unassigned"},
                {"UID": "1", "Name": "Bob"},
            ]
        )
        data = parse_xml(xml)
        assert len(data.resources) == 1
        assert data.resources[0].name == "Bob"

    def test_parse_outline_hierarchy(self) -> None:
        xml = _build_sample_xml(
            tasks=[
                {
                    "UID": "1",
                    "Name": "Phase 1",
                    "OutlineNumber": "1",
                    "OutlineLevel": "1",
                },
                {
                    "UID": "2",
                    "Name": "Design",
                    "OutlineNumber": "1.1",
                    "OutlineLevel": "2",
                },
                {
                    "UID": "3",
                    "Name": "Build",
                    "OutlineNumber": "1.2",
                    "OutlineLevel": "2",
                },
            ]
        )
        data = parse_xml(xml)
        assert data.tasks[0].outline_number == "1"
        assert data.tasks[1].outline_number == "1.1"
        assert data.tasks[2].outline_number == "1.2"

    def test_parse_percent_complete(self) -> None:
        xml = _build_sample_xml(tasks=[{"UID": "1", "Name": "Task A", "PercentComplete": "75"}])
        data = parse_xml(xml)
        assert data.tasks[0].percent_complete == 0.75

    def test_warning_on_missing_name(self) -> None:
        xml = _build_sample_xml(tasks=[{"UID": "1"}])
        data = parse_xml(xml)
        assert len(data.tasks) == 0
        assert len(data.warnings) == 1
        assert "missing name" in data.warnings[0]

    def test_parse_notes(self) -> None:
        xml = _build_sample_xml(
            tasks=[
                {
                    "UID": "1",
                    "Name": "Task A",
                    "Notes": "Important note",
                }
            ]
        )
        data = parse_xml(xml)
        assert data.tasks[0].notes == "Important note"

    def test_parse_start_date(self) -> None:
        xml = _build_sample_xml(
            tasks=[
                {
                    "UID": "1",
                    "Name": "Task A",
                    "Start": "2026-03-15T08:00:00",
                }
            ]
        )
        data = parse_xml(xml)
        assert data.tasks[0].start == "2026-03-15"

    def test_zero_duration_non_milestone_is_zero(self) -> None:
        xml = _build_sample_xml(
            tasks=[{"UID": "1", "Name": "Gate", "Milestone": "0", "Duration": "PT0H0M0S"}]
        )
        data = parse_xml(xml)
        assert data.tasks[0].is_milestone is False
        assert data.tasks[0].duration_days == 0


# ---------------------------------------------------------------------------
# Fixture-file round-trip tests (CI fixture registration)
# ---------------------------------------------------------------------------

_FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(
    "filename,expected_tasks,expected_deps,expected_resources",
    [
        ("sample.xml", 15, 11, 3),
        ("sample_legacy.xml", 13, 8, 2),
        ("sample_2019.xml", 19, 14, 4),
    ],
)
class TestFixtureFiles:
    def test_parse_counts(
        self,
        filename: str,
        expected_tasks: int,
        expected_deps: int,
        expected_resources: int,
    ) -> None:
        """Fixture file parses with expected task/dependency/resource counts."""
        content = (_FIXTURES_DIR / filename).read_bytes()
        data = parse_xml(content)
        actual_deps = sum(len(t.predecessor_links) for t in data.tasks)
        assert len(data.tasks) == expected_tasks, f"{filename}: task count"
        assert actual_deps == expected_deps, f"{filename}: dependency count"
        assert len(data.resources) == expected_resources, f"{filename}: resource count"
        assert len(data.warnings) == 0, f"{filename}: unexpected warnings: {data.warnings}"

    def test_milestone_flag(
        self,
        filename: str,
        expected_tasks: int,
        expected_deps: int,
        expected_resources: int,
    ) -> None:
        """Milestone tasks import with is_milestone=True and duration_days=0."""
        content = (_FIXTURES_DIR / filename).read_bytes()
        data = parse_xml(content)
        milestones = [t for t in data.tasks if t.is_milestone]
        assert len(milestones) > 0, f"{filename}: expected at least one milestone"
        for ms in milestones:
            assert ms.duration_days == 0, (
                f"{filename}: milestone '{ms.name}' should have duration_days=0, "
                f"got {ms.duration_days}"
            )


# ---------------------------------------------------------------------------
# Edge-case fixture-file tests (#153)
# ---------------------------------------------------------------------------

_FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(
    "filename,expected_tasks,expected_deps,expected_resources",
    [
        # Baseline regression: minimum valid import
        ("minimal.xml", 1, 0, 0),
        # All 5 tasks are milestones with duration=0
        ("milestones_only.xml", 5, 0, 0),
        # 4 outline levels: tasks 1–13, deps 3
        ("deep_wbs.xml", 13, 3, 0),
        # 6 tasks, 6 deps covering FS/SS/FF/SF + multi-predecessor
        ("all_dependency_types.xml", 6, 6, 0),
        # Performance baseline: 200 leaf tasks, UID continuity
        ("large_flat.xml", 200, 0, 0),
        # 3 tasks, 2 resources (one full-time, one part-time), 1 dep
        ("resource_overallocation.xml", 3, 1, 2),
        # 6 tasks (1 container + 3 occurrences + 2 normal), 1 dep
        ("recurring_task.xml", 6, 1, 0),
        # 3 tasks, 2 deps (1 local FS + 1 external cross-project link)
        ("cross_project_link.xml", 3, 2, 0),
        # 5 tasks with CJK/RTL/emoji names + 1 resource, 2 deps
        ("unicode_names.xml", 5, 2, 1),
        # 3 tasks, 1 dep, 1 resource; full Calendars block silently ignored
        ("calendar_exceptions.xml", 3, 1, 1),
    ],
)
class TestEdgeCaseFixtureFiles:
    def test_parse_counts(
        self,
        filename: str,
        expected_tasks: int,
        expected_deps: int,
        expected_resources: int,
    ) -> None:
        """Edge-case fixture parses with expected task/dependency/resource counts."""
        content = (_FIXTURES_DIR / filename).read_bytes()
        data = parse_xml(content)
        actual_deps = sum(len(t.predecessor_links) for t in data.tasks)
        assert len(data.tasks) == expected_tasks, f"{filename}: task count"
        assert actual_deps == expected_deps, f"{filename}: dependency count"
        assert len(data.resources) == expected_resources, f"{filename}: resource count"

    def test_no_crash(
        self,
        filename: str,
        expected_tasks: int,
        expected_deps: int,
        expected_resources: int,
    ) -> None:
        """Edge-case fixture loads without raising an exception."""
        content = (_FIXTURES_DIR / filename).read_bytes()
        data = parse_xml(content)
        assert data is not None


# ---------------------------------------------------------------------------
# Importer tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestImporter:
    def test_import_basic_tasks(self, project: Project) -> None:
        data = ProjectData(
            tasks=[
                TaskData(uid=1, name="Task A", duration_days=3, outline_number="1"),
                TaskData(uid=2, name="Task B", duration_days=5, outline_number="2"),
            ]
        )
        summary = import_project(str(project.pk), data)
        assert summary["tasks_created"] == 2
        tasks = Task.objects.filter(project=project, is_deleted=False)
        assert tasks.count() == 2

    def test_import_wbs_path(self, project: Project) -> None:
        data = ProjectData(
            tasks=[
                TaskData(uid=1, name="Phase 1", outline_number="1"),
                TaskData(uid=2, name="Design", outline_number="1.1"),
            ]
        )
        import_project(str(project.pk), data)
        t1 = Task.objects.get(project=project, name="Phase 1")
        t2 = Task.objects.get(project=project, name="Design")
        assert t1.wbs_path == "1"
        assert t2.wbs_path == "1.1"

    def test_import_dependencies(self, project: Project) -> None:
        data = ProjectData(
            tasks=[
                TaskData(uid=1, name="A"),
                TaskData(
                    uid=2,
                    name="B",
                    predecessor_links=[
                        PredecessorLinkData(predecessor_uid=1, dep_type="FS", lag_days=2)
                    ],
                ),
            ]
        )
        summary = import_project(str(project.pk), data)
        assert summary["dependencies_created"] == 1
        dep = Dependency.objects.first()
        assert dep is not None
        assert dep.dep_type == "FS"
        assert dep.lag == 2

    def test_import_resources_match_existing(self, project: Project) -> None:
        Resource.objects.create(name="Alice")
        data = ProjectData(
            tasks=[
                TaskData(
                    uid=1,
                    name="Task A",
                    resource_assignments=[AssignmentData(task_uid=1, resource_uid=10, units=0.5)],
                ),
            ],
            resources=[ResourceData(uid=10, name="Alice", max_units=1.0)],
        )
        summary = import_project(str(project.pk), data)
        assert summary["resources_matched"] == 1
        assert summary["resources_created"] == 0
        assert summary["assignments_created"] == 1

    def test_import_resources_create_new(self, project: Project) -> None:
        data = ProjectData(
            tasks=[
                TaskData(
                    uid=1,
                    name="Task A",
                    resource_assignments=[AssignmentData(task_uid=1, resource_uid=10, units=1.0)],
                ),
            ],
            resources=[ResourceData(uid=10, name="Bob", max_units=0.8)],
        )
        summary = import_project(str(project.pk), data)
        assert summary["resources_created"] == 1
        bob = Resource.objects.get(name="Bob")
        assert float(bob.max_units) == 0.8

    def test_import_resource_case_insensitive(self, project: Project) -> None:
        Resource.objects.create(name="Alice Johnson")
        data = ProjectData(
            tasks=[TaskData(uid=1, name="Task A")],
            resources=[ResourceData(uid=10, name="alice johnson")],
        )
        summary = import_project(str(project.pk), data)
        assert summary["resources_matched"] == 1
        assert summary["resources_created"] == 0

    def test_import_milestones(self, project: Project) -> None:
        data = ProjectData(
            tasks=[
                TaskData(
                    uid=1,
                    name="Kickoff",
                    is_milestone=True,
                    duration_days=0,
                )
            ]
        )
        import_project(str(project.pk), data)
        t = Task.objects.get(project=project, name="Kickoff")
        assert t.is_milestone is True

    def test_import_missing_predecessor_warning(self, project: Project) -> None:
        data = ProjectData(
            tasks=[
                TaskData(
                    uid=1,
                    name="Task A",
                    predecessor_links=[PredecessorLinkData(predecessor_uid=999, dep_type="FS")],
                ),
            ]
        )
        summary = import_project(str(project.pk), data)
        assert summary["dependencies_created"] == 0
        assert any("999" in w for w in summary["warnings"])

    def test_import_empty_tasks_warning(self, project: Project) -> None:
        data = ProjectData(tasks=[])
        summary = import_project(str(project.pk), data)
        assert summary["tasks_created"] == 0
        assert any("No tasks" in w for w in summary["warnings"])

    def test_import_with_tracker(self, project: Project) -> None:
        tracker = MagicMock()
        data = ProjectData(tasks=[TaskData(uid=1, name="Task A")])
        import_project(str(project.pk), data, tracker=tracker)
        assert tracker.update.call_count >= 3

    def test_import_auto_rosters_assigned_resources(self, project: Project) -> None:
        """Importing assignments must auto-add resources to ProjectResource (#241)."""
        data = ProjectData(
            tasks=[
                TaskData(
                    uid=1,
                    name="Task A",
                    resource_assignments=[AssignmentData(task_uid=1, resource_uid=10, units=1.0)],
                ),
                TaskData(
                    uid=2,
                    name="Task B",
                    resource_assignments=[
                        AssignmentData(task_uid=2, resource_uid=10, units=0.5),
                        AssignmentData(task_uid=2, resource_uid=11, units=1.0),
                    ],
                ),
            ],
            resources=[
                ResourceData(uid=10, name="Alice", max_units=1.0),
                ResourceData(uid=11, name="Bob", max_units=1.0),
            ],
        )
        import_project(str(project.pk), data)

        rostered = set(
            ProjectResource.objects.filter(project=project).values_list("resource__name", flat=True)
        )
        assert rostered == {"Alice", "Bob"}
        # Idempotent — re-running the import does not duplicate roster rows.
        import_project(str(project.pk), data)
        assert ProjectResource.objects.filter(project=project).count() == 2


# ---------------------------------------------------------------------------
# Exporter tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestExporter:
    def test_export_basic(self, project: Project) -> None:
        Task.objects.create(project=project, name="Task A", duration=3, wbs_path="1")
        Task.objects.create(project=project, name="Task B", duration=5, wbs_path="2")
        xml_bytes = export_project_xml(str(project.pk))
        assert xml_bytes.startswith(b"<?xml")
        root = ET.fromstring(xml_bytes)
        ns = f"{{{_NS}}}"
        tasks = root.findall(f".//{ns}Tasks/{ns}Task")
        assert len(tasks) == 3  # UID 0 + 2 tasks
        names = [t.findtext(f"{ns}Name") for t in tasks]
        assert "Task A" in names
        assert "Task B" in names

    def test_export_dependencies(self, project: Project) -> None:
        t1 = Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
        t2 = Task.objects.create(project=project, name="B", duration=1, wbs_path="2")
        Dependency.objects.create(predecessor=t1, successor=t2, dep_type="FS", lag=1)
        xml_bytes = export_project_xml(str(project.pk))
        root = ET.fromstring(xml_bytes)
        ns = f"{{{_NS}}}"
        pred_links = root.findall(f".//{ns}PredecessorLink")
        assert len(pred_links) == 1
        assert pred_links[0].findtext(f"{ns}Type") == "1"
        assert pred_links[0].findtext(f"{ns}LinkLag") == "4800"

    def test_export_resources_and_assignments(self, project: Project) -> None:
        t1 = Task.objects.create(project=project, name="A", duration=1)
        r1 = Resource.objects.create(name="Alice", max_units=1.0)
        TaskResource.objects.create(task=t1, resource=r1, units=0.5)
        xml_bytes = export_project_xml(str(project.pk))
        root = ET.fromstring(xml_bytes)
        ns = f"{{{_NS}}}"
        resources = root.findall(f".//{ns}Resources/{ns}Resource")
        assert len(resources) == 1
        assert resources[0].findtext(f"{ns}Name") == "Alice"
        assignments = root.findall(f".//{ns}Assignments/{ns}Assignment")
        assert len(assignments) == 1
        assert assignments[0].findtext(f"{ns}Units") == "0.50"

    def test_export_milestones(self, project: Project) -> None:
        Task.objects.create(
            project=project,
            name="Kickoff",
            duration=0,
            is_milestone=True,
            wbs_path="1",
        )
        xml_bytes = export_project_xml(str(project.pk))
        root = ET.fromstring(xml_bytes)
        ns = f"{{{_NS}}}"
        tasks = root.findall(f".//{ns}Tasks/{ns}Task")
        kickoff = next(t for t in tasks if t.findtext(f"{ns}Name") == "Kickoff")
        assert kickoff.findtext(f"{ns}Milestone") == "1"

    def test_export_wbs_hierarchy(self, project: Project) -> None:
        Task.objects.create(project=project, name="Phase 1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Design", duration=1, wbs_path="1.1")
        xml_bytes = export_project_xml(str(project.pk))
        root = ET.fromstring(xml_bytes)
        ns = f"{{{_NS}}}"
        tasks = root.findall(f".//{ns}Tasks/{ns}Task")
        design = next(t for t in tasks if t.findtext(f"{ns}Name") == "Design")
        assert design.findtext(f"{ns}OutlineNumber") == "1.1"
        assert design.findtext(f"{ns}OutlineLevel") == "2"


# ---------------------------------------------------------------------------
# Round-trip test
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRoundTrip:
    def test_import_then_export(self, project: Project) -> None:
        """Import XML then export -- verify data survives round trip."""
        xml_in = _build_sample_xml(
            tasks=[
                {
                    "UID": "1",
                    "Name": "Phase 1",
                    "Duration": "PT24H0M0S",
                    "OutlineNumber": "1",
                    "OutlineLevel": "1",
                    "Milestone": "0",
                    "PercentComplete": "50",
                },
                {
                    "UID": "2",
                    "Name": "Design",
                    "Duration": "PT16H0M0S",
                    "OutlineNumber": "1.1",
                    "OutlineLevel": "2",
                    "Milestone": "0",
                    "PredecessorLinks": [
                        {
                            "PredecessorUID": "1",
                            "Type": "1",
                            "LinkLag": "4800",
                        }
                    ],
                },
                {
                    "UID": "3",
                    "Name": "Kickoff",
                    "Duration": "PT0H0M0S",
                    "OutlineNumber": "2",
                    "OutlineLevel": "1",
                    "Milestone": "1",
                },
            ],
            resources=[{"UID": "1", "Name": "Alice", "MaxUnits": "0.75"}],
            assignments=[{"TaskUID": "1", "ResourceUID": "1", "Units": "0.50"}],
        )

        data = parse_xml(xml_in)
        summary = import_project(str(project.pk), data)
        assert summary["tasks_created"] == 3
        assert summary["dependencies_created"] == 1
        assert summary["resources_created"] == 1
        assert summary["assignments_created"] == 1

        xml_out = export_project_xml(str(project.pk))
        root = ET.fromstring(xml_out)
        ns = f"{{{_NS}}}"

        tasks = root.findall(f".//{ns}Tasks/{ns}Task")
        task_names = [t.findtext(f"{ns}Name") for t in tasks]
        assert "Phase 1" in task_names
        assert "Design" in task_names
        assert "Kickoff" in task_names

        design = next(t for t in tasks if t.findtext(f"{ns}Name") == "Design")
        assert design.findtext(f"{ns}OutlineNumber") == "1.1"

        kickoff = next(t for t in tasks if t.findtext(f"{ns}Name") == "Kickoff")
        assert kickoff.findtext(f"{ns}Milestone") == "1"

        pred_links = root.findall(f".//{ns}PredecessorLink")
        assert len(pred_links) == 1
        assert pred_links[0].findtext(f"{ns}Type") == "1"

        resources = root.findall(f".//{ns}Resources/{ns}Resource")
        assert len(resources) == 1
        assert resources[0].findtext(f"{ns}Name") == "Alice"

        assignments = root.findall(f".//{ns}Assignments/{ns}Assignment")
        assert len(assignments) == 1
        assert assignments[0].findtext(f"{ns}Units") == "0.50"


# ---------------------------------------------------------------------------
# REST API tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestImportAPI:
    def test_import_requires_admin(self, viewer_client: APIClient, project: Project) -> None:
        xml = _build_sample_xml(tasks=[{"UID": "1", "Name": "Task A"}])
        resp = viewer_client.post(
            f"/api/v1/projects/{project.pk}/import/msproject/",
            {"file": SimpleUploadedFile("schedule.xml", xml, content_type="application/xml")},
            format="multipart",
        )
        assert resp.status_code == 403

    def test_import_no_file(self, admin_client: APIClient, project: Project) -> None:
        resp = admin_client.post(
            f"/api/v1/projects/{project.pk}/import/msproject/",
            {},
            format="multipart",
        )
        assert resp.status_code == 400
        assert "No file" in resp.data["detail"]

    def test_import_bad_extension(self, admin_client: APIClient, project: Project) -> None:
        buf = BytesIO(b"not a project file")
        buf.name = "schedule.xlsx"
        resp = admin_client.post(
            f"/api/v1/projects/{project.pk}/import/msproject/",
            {"file": buf},
            format="multipart",
        )
        assert resp.status_code == 400
        assert "Unsupported" in resp.data["detail"]

    def test_import_creates_outbox_row(
        self,
        admin_client: APIClient,
        project: Project,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        """Upload creates an ImportRequest row and returns import_request_id."""
        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        xml = _build_sample_xml(tasks=[{"UID": "1", "Name": "Task A"}])
        buf = BytesIO(xml)
        buf.name = "schedule.xml"

        mock_result = MagicMock()
        mock_result.id = "celery-task-123"
        with (
            patch(
                "trueppm_api.apps.msproject.tasks.import_msproject.delay",
                return_value=mock_result,
            ),
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            resp = admin_client.post(
                f"/api/v1/projects/{project.pk}/import/msproject/",
                {"file": buf},
                format="multipart",
            )

        assert resp.status_code == 202
        assert "import_request_id" in resp.data
        req = ImportRequest.objects.get(pk=resp.data["import_request_id"])
        assert req.project_id == project.pk
        assert req.status == ImportRequestStatus.DISPATCHED

    def test_import_broker_down_row_stays_pending(
        self,
        admin_client: APIClient,
        project: Project,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        """Broker unavailable: ImportRequest row committed but stays PENDING."""
        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        xml = _build_sample_xml(tasks=[{"UID": "1", "Name": "Task A"}])
        buf = BytesIO(xml)
        buf.name = "schedule.xml"

        with (
            patch(
                "trueppm_api.apps.msproject.tasks.import_msproject.delay",
                side_effect=ConnectionError("broker down"),
            ),
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            resp = admin_client.post(
                f"/api/v1/projects/{project.pk}/import/msproject/",
                {"file": buf},
                format="multipart",
            )

        assert resp.status_code == 202
        req = ImportRequest.objects.get(pk=resp.data["import_request_id"])
        assert req.status == ImportRequestStatus.PENDING


@pytest.mark.django_db
class TestExportAPI:
    def test_export_xml(self, admin_client: APIClient, project: Project) -> None:
        Task.objects.create(project=project, name="Task A", duration=3, wbs_path="1")
        resp = admin_client.get(f"/api/v1/projects/{project.pk}/export/msproject.xml")
        assert resp.status_code == 200
        assert "application/xml" in resp["Content-Type"]
        assert "attachment" in resp["Content-Disposition"]

    def test_export_viewer_allowed(self, viewer_client: APIClient, project: Project) -> None:
        resp = viewer_client.get(f"/api/v1/projects/{project.pk}/export/msproject.xml")
        assert resp.status_code == 200

    def test_export_nonexistent_project(self, admin_client: APIClient) -> None:
        fake_pk = "00000000-0000-0000-0000-000000000000"
        resp = admin_client.get(f"/api/v1/projects/{fake_pk}/export/msproject.xml")
        assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# ImportRequest outbox drain + task tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestImportDrain:
    def _drain(self) -> None:
        from trueppm_api.apps.msproject.tasks import _do_import_drain

        _do_import_drain()

    def test_drain_dispatches_pending_row(self, project: Project) -> None:
        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        mock_result = MagicMock()
        mock_result.id = "drain-task-id"
        with patch(
            "trueppm_api.apps.msproject.tasks.import_msproject.delay",
            return_value=mock_result,
        ):
            self._drain()

        req.refresh_from_db()
        assert req.status == ImportRequestStatus.DISPATCHED
        assert req.celery_task_id == "drain-task-id"
        assert req.dispatched_at is not None

    def test_drain_broker_failure_leaves_row_pending(self, project: Project) -> None:
        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        with patch(
            "trueppm_api.apps.msproject.tasks.import_msproject.delay",
            side_effect=ConnectionError("broker down"),
        ):
            self._drain()  # must not raise

        req.refresh_from_db()
        assert req.status == ImportRequestStatus.PENDING

    def test_drain_recovers_orphaned_dispatched_row(self, project: Project) -> None:
        from django.utils import timezone

        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        stale_time = timezone.now() - timedelta(minutes=16)
        ImportRequest.objects.filter(pk=req.pk).update(
            status=ImportRequestStatus.DISPATCHED,
            dispatched_at=stale_time,
            celery_task_id="old-id",
        )

        mock_result = MagicMock()
        mock_result.id = "new-drain-id"
        with patch(
            "trueppm_api.apps.msproject.tasks.import_msproject.delay",
            return_value=mock_result,
        ):
            self._drain()

        req.refresh_from_db()
        assert req.status == ImportRequestStatus.DISPATCHED
        assert req.celery_task_id == "new-drain-id"

    def test_drain_leaves_recent_dispatched_row_alone(self, project: Project) -> None:
        from django.utils import timezone

        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=req.pk).update(
            status=ImportRequestStatus.DISPATCHED,
            dispatched_at=timezone.now() - timedelta(minutes=5),
            celery_task_id="live-id",
        )
        with patch(
            "trueppm_api.apps.msproject.tasks.import_msproject.delay",
        ) as mock_delay:
            self._drain()

        mock_delay.assert_not_called()
        req.refresh_from_db()
        assert req.status == ImportRequestStatus.DISPATCHED

    def test_drain_no_rows_does_nothing(self, db: object) -> None:
        with patch(
            "trueppm_api.apps.msproject.tasks.import_msproject.delay",
        ) as mock_delay:
            self._drain()

        mock_delay.assert_not_called()


@pytest.mark.django_db
class TestImportTaskMarksRowDone:
    def test_task_marks_import_request_done(self, project: Project) -> None:
        from contextlib import contextmanager

        from django.utils import timezone

        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus
        from trueppm_api.apps.msproject.tasks import _NoOpTracker

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=req.pk).update(
            status=ImportRequestStatus.DISPATCHED,
            dispatched_at=timezone.now(),
            celery_task_id="celery-123",
        )

        @contextmanager
        def _noop_tracker(*args: object, **kwargs: object):  # type: ignore[misc]
            yield _NoOpTracker()

        mock_summary = {"tasks_created": 1, "tasks_updated": 0, "dependencies_created": 0}
        with (
            patch("trueppm_api.apps.msproject.tasks._get_tracker", _noop_tracker),
            patch("trueppm_api.apps.msproject.parser.parse_xml", return_value=MagicMock()),
            patch(
                "trueppm_api.apps.msproject.importer.import_project",
                return_value=mock_summary,
            ),
            patch(
                "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
                return_value=MagicMock(id="sched-task-id"),
            ),
        ):
            from trueppm_api.apps.msproject.tasks import import_msproject

            import_msproject(
                str(project.pk),
                "PHhtbC8+",
                "p.xml",
                import_request_id=str(req.pk),
            )

        req.refresh_from_db()
        assert req.status == ImportRequestStatus.DONE

    def test_task_reject_on_worker_lost(self) -> None:
        from trueppm_api.apps.msproject.tasks import import_msproject

        assert getattr(import_msproject, "reject_on_worker_lost", False) is True


@pytest.mark.django_db
class TestImportPurge:
    def _purge(self) -> None:
        from trueppm_api.apps.msproject.tasks import _do_import_purge

        _do_import_purge()

    def test_purge_deletes_old_done_rows(self, project: Project) -> None:
        from django.utils import timezone

        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=req.pk).update(
            status=ImportRequestStatus.DONE,
            requested_at=timezone.now() - timedelta(days=8),
        )
        self._purge()
        assert not ImportRequest.objects.filter(pk=req.pk).exists()

    def test_purge_preserves_recent_rows(self, project: Project) -> None:
        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=req.pk).update(status=ImportRequestStatus.DONE)
        self._purge()
        assert ImportRequest.objects.filter(pk=req.pk).exists()

    def test_purge_preserves_pending_rows(self, project: Project) -> None:
        from django.utils import timezone

        from trueppm_api.apps.msproject.models import ImportRequest

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=req.pk).update(
            requested_at=timezone.now() - timedelta(days=30),
        )
        self._purge()
        assert ImportRequest.objects.filter(pk=req.pk).exists()

    def test_purge_respects_custom_retention_window(self, project: Project) -> None:
        from unittest.mock import patch

        from django.utils import timezone

        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        # 10 days old: purged under the default 7-day window, kept under 30 days.
        kept = ImportRequest.objects.create(
            project=project, filename="kept.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=kept.pk).update(
            status=ImportRequestStatus.DONE,
            requested_at=timezone.now() - timedelta(days=10),
        )
        # 40 days old: beyond the 30-day window.
        purged = ImportRequest.objects.create(
            project=project, filename="purged.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=purged.pk).update(
            status=ImportRequestStatus.DEAD,
            requested_at=timezone.now() - timedelta(days=40),
        )
        with patch("django.conf.settings.TRUEPPM_IMPORT_RETENTION_DAYS", 30):
            self._purge()
        assert ImportRequest.objects.filter(pk=kept.pk).exists()
        assert not ImportRequest.objects.filter(pk=purged.pk).exists()

    def test_purge_disabled_when_retention_none(self, project: Project) -> None:
        from unittest.mock import patch

        from django.utils import timezone

        from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

        req = ImportRequest.objects.create(
            project=project, filename="p.xml", file_content_b64="dGVzdA=="
        )
        ImportRequest.objects.filter(pk=req.pk).update(
            status=ImportRequestStatus.DONE,
            requested_at=timezone.now() - timedelta(days=999),
        )
        with patch("django.conf.settings.TRUEPPM_IMPORT_RETENTION_DAYS", None):
            self._purge()
        assert ImportRequest.objects.filter(pk=req.pk).exists()
