"""ADR-0259 graph-guard coverage for the MS Project importer (#2684).

ADR-0259 names the MS Project importer as a call site of
``scheduling.graph_guard.validate_task_graph`` — "in **both** importers (MS
Project and Jira)" — but the guard was only ever wired into Jira and CSV. The
importer persists links with ``bulk_create``, which bypasses
``DependencySerializer._check_no_cycle``, so a cyclic ``.mpp``/``.xml`` wrote an
infeasible dependency network straight into CPM: the exact vulnerability
ADR-0259's Context section was written for.

These tests pin the two properties that matter — a bad graph is rejected
*before any row is written*, and the rejection is terminal so the orphan drain
does not re-dispatch a deterministically bad file forever (ADR-0092).
"""

from __future__ import annotations

import base64
import xml.etree.ElementTree as ET
from collections.abc import Generator
from contextlib import contextmanager
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from trueppm_api.apps.msproject.importer import (
    build_children_map,
    collect_dependency_edges,
    describe_bad_graph,
)
from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus
from trueppm_api.apps.msproject.parser import parse_xml
from trueppm_api.apps.msproject.tasks import import_msproject
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.graph_guard import (
    InfeasibleGraphError,
    validate_task_graph,
)

_NS = "http://schemas.microsoft.com/project"


@contextmanager
def _stub_tracker(*_args: object, **_kwargs: object) -> Generator[MagicMock, None, None]:
    """Yield a no-op tracker so task tests don't need the channel layer."""
    yield MagicMock()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Graph Guard Target",
        start_date=date(2026, 1, 5),
        calendar=calendar,
    )


def _build_xml(tasks: list[dict[str, Any]]) -> bytes:
    """Build a minimal MSPDI document (mirrors test_import_hardening._build_xml)."""
    root = ET.Element(f"{{{_NS}}}Project")
    ET.SubElement(root, f"{{{_NS}}}Name").text = "Graph Guard Test"
    ET.SubElement(root, f"{{{_NS}}}StartDate").text = "2026-01-05T08:00:00"

    tasks_el = ET.SubElement(root, f"{{{_NS}}}Tasks")
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

    return ET.tostring(root, encoding="unicode").encode("utf-8")


def _task(uid: int, name: str, outline: str, preds: list[int] | None = None) -> dict[str, Any]:
    task: dict[str, Any] = {
        "UID": uid,
        "Name": name,
        "OutlineNumber": outline,
        "OutlineLevel": outline.count(".") + 1,
        "Duration": "PT8H0M0S",
    }
    if preds:
        task["PredecessorLinks"] = [{"PredecessorUID": p, "Type": 1} for p in preds]
    return task


# A -> B -> A. Two tasks, each the other's predecessor.
CYCLIC_XML = _build_xml(
    [
        _task(1, "Design", "1", preds=[2]),
        _task(2, "Build", "2", preds=[1]),
    ]
)

# A single task listing itself as its own predecessor.
SELF_REF_XML = _build_xml([_task(1, "Design", "1", preds=[1])])

# A -> B. The control: a well-formed file must still import.
ACYCLIC_XML = _build_xml(
    [
        _task(1, "Design", "1"),
        _task(2, "Build", "2", preds=[1]),
    ]
)


# A summary and its own child, linked in the child-depends-on-summary direction (#4856).
SUMMARY_TO_CHILD_XML = _build_xml(
    [
        _task(1, "Phase", "1"),
        _task(2, "Design", "1.1", preds=[1]),
    ]
)

# Same pair, linked the other way: the summary depends on its own child.
CHILD_TO_SUMMARY_XML = _build_xml(
    [
        _task(1, "Phase", "1", preds=[2]),
        _task(2, "Design", "1.1"),
    ]
)

# A summary may depend on a task outside it: the control for the nesting check.
SUMMARY_TO_SIBLING_XML = _build_xml(
    [
        _task(1, "Phase", "1"),
        _task(2, "Design", "1.1"),
        _task(3, "Ship", "2", preds=[1]),
    ]
)


def _leveled(uid: int, name: str, number: str, level: int, preds: list[int] | None = None):
    """A task whose hierarchy is carried by OutlineLevel only (flat OutlineNumber)."""
    task = _task(uid, name, number, preds)
    task["OutlineLevel"] = level
    return task


# Phase (1) > Group (1.1) > Leaf (1.1.1), with the link from the grandchild's side.
GRANDCHILD_TO_SUMMARY_XML = _build_xml(
    [
        _task(1, "Phase", "1"),
        _task(2, "Group", "1.1"),
        _task(3, "Leaf", "1.1.1", preds=[1]),
    ]
)
SUMMARY_TO_GRANDCHILD_XML = _build_xml(
    [
        _task(1, "Phase", "1", preds=[3]),
        _task(2, "Group", "1.1"),
        _task(3, "Leaf", "1.1.1"),
    ]
)

# Hierarchy only in OutlineLevel: every OutlineNumber is flat.
LEVEL_ONLY_XML = _build_xml(
    [
        _leveled(1, "Phase", "1", 1),
        _leveled(2, "Design", "2", 2, preds=[1]),
    ]
)

# "1.1" is missing, so the engine treats 1 as a leaf and 1.1.1 as a root.
OUTLINE_GAP_XML = _build_xml(
    [
        _task(1, "Phase", "1"),
        _task(2, "Deep", "1.1.1", preds=[1]),
    ]
)


def _ss_task_xml(pred_type: int) -> bytes:
    """Summary 1 with child 1.1 that lists the summary as predecessor with ``pred_type``."""
    child = _task(2, "Design", "1.1")
    child["PredecessorLinks"] = [{"PredecessorUID": 1, "Type": pred_type}]
    return _build_xml([_task(1, "Phase", "1"), child])


class TestBuildChildrenMap:
    def test_outline_gap_matches_the_engines_direct_parent_rule(self) -> None:
        # The guard must not refuse what the engine would schedule.
        parsed = parse_xml(OUTLINE_GAP_XML)
        assert build_children_map(parsed) == {}
        validate_task_graph(
            collect_dependency_edges(parsed), children_map=build_children_map(parsed)
        )

    def test_outline_level_only_hierarchy_is_recognized(self) -> None:
        parsed = parse_xml(LEVEL_ONLY_XML)
        assert build_children_map(parsed) == {"1": ["2"]}

    def test_maps_a_summary_to_its_direct_children(self) -> None:
        parsed = parse_xml(SUMMARY_TO_SIBLING_XML)
        assert build_children_map(parsed) == {"1": ["2"]}

    def test_flat_file_has_no_summaries(self) -> None:
        assert build_children_map(parse_xml(ACYCLIC_XML)) == {}


class TestCollectDependencyEdges:
    """The edge set handed to the guard, in the file's own uid space."""

    def test_returns_predecessor_successor_pairs_as_strings(self) -> None:
        parsed = parse_xml(ACYCLIC_XML)
        assert collect_dependency_edges(parsed) == [("1", "2")]

    def test_a_file_with_no_links_yields_no_edges(self) -> None:
        parsed = parse_xml(_build_xml([_task(1, "Design", "1")]))
        assert collect_dependency_edges(parsed) == []

    def test_keeps_links_whose_predecessor_is_absent_from_the_file(self) -> None:
        # A dangling uid can only ever be a source node — successors are always
        # file tasks — so it cannot manufacture a cycle. Keeping it matches the
        # edge set the CSV importer validates.
        parsed = parse_xml(_build_xml([_task(1, "Design", "1", preds=[999])]))
        assert collect_dependency_edges(parsed) == [("999", "1")]


class TestGuardRejectsBadGraphs:
    """The guard's verdict on parsed files, independent of the task path."""

    def test_cyclic_file_is_rejected(self) -> None:
        parsed = parse_xml(CYCLIC_XML)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(collect_dependency_edges(parsed))
        assert exc.value.reason == "cyclic_dependency"

    def test_self_referential_file_is_rejected(self) -> None:
        parsed = parse_xml(SELF_REF_XML)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(collect_dependency_edges(parsed))
        assert exc.value.reason == "self_reference"
        assert exc.value.offending == ["1"]

    def test_acyclic_file_passes(self) -> None:
        parsed = parse_xml(ACYCLIC_XML)
        validate_task_graph(collect_dependency_edges(parsed))


class TestGuardRejectsSummaryToOwnDescendant:
    """#4856: the engine refuses these links on every recalculation, so refuse at import."""

    @pytest.mark.parametrize(
        "xml",
        [
            SUMMARY_TO_CHILD_XML,
            CHILD_TO_SUMMARY_XML,
            GRANDCHILD_TO_SUMMARY_XML,
            SUMMARY_TO_GRANDCHILD_XML,
            LEVEL_ONLY_XML,
        ],
    )
    def test_link_between_a_summary_and_its_child_is_rejected(self, xml: bytes) -> None:
        parsed = parse_xml(xml)
        edges = collect_dependency_edges(parsed)
        # Blind without the hierarchy: this is the bug.
        validate_task_graph(edges)
        with pytest.raises(InfeasibleGraphError):
            validate_task_graph(edges, children_map=build_children_map(parsed))

    def test_summary_depending_on_an_outside_task_is_accepted(self) -> None:
        parsed = parse_xml(SUMMARY_TO_SIBLING_XML)
        validate_task_graph(
            collect_dependency_edges(parsed), children_map=build_children_map(parsed)
        )

    def test_message_for_the_child_to_summary_direction(self) -> None:
        parsed = parse_xml(CHILD_TO_SUMMARY_XML)
        edges = collect_dependency_edges(parsed)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(edges, children_map=build_children_map(parsed))
        detail = describe_bad_graph(parsed, exc.value, edges)
        assert "Task Phase (uid 1) is linked to its own sub-task Design (uid 2)" in detail

    def test_message_bounds_and_sanitizes_task_names(self) -> None:
        xml = _build_xml(
            [
                _task(1, "Phase\nforged: line" + "x" * 300, "1"),
                _task(2, "Design", "1.1", preds=[1]),
            ]
        )
        parsed = parse_xml(xml)
        edges = collect_dependency_edges(parsed)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(edges, children_map=build_children_map(parsed))
        detail = describe_bad_graph(parsed, exc.value, edges)
        assert "\n" not in detail
        assert len(detail) < 300

    def test_message_names_the_summary_and_its_child(self) -> None:
        parsed = parse_xml(SUMMARY_TO_CHILD_XML)
        edges = collect_dependency_edges(parsed)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(edges, children_map=build_children_map(parsed))
        detail = describe_bad_graph(parsed, exc.value, edges)
        assert "Phase" in detail
        assert "Design" in detail
        assert "its own sub-task" in detail


class TestDescribeBadGraph:
    """The operator-facing rendering names tasks, not uids and reason codes."""

    def test_cycle_names_every_task_in_the_loop(self) -> None:
        parsed = parse_xml(CYCLIC_XML)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(collect_dependency_edges(parsed))
        detail = describe_bad_graph(parsed, exc.value)
        assert "Circular dependency" in detail
        assert "Design" in detail
        assert "Build" in detail

    def test_self_reference_reads_differently_from_a_cycle(self) -> None:
        parsed = parse_xml(SELF_REF_XML)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(collect_dependency_edges(parsed))
        detail = describe_bad_graph(parsed, exc.value)
        assert "lists itself" in detail
        assert "Design" in detail
        # A self-referencing task is a different edit from a multi-task loop.
        assert "Circular dependency" not in detail

    def test_never_leaks_the_exceptions_own_repr(self) -> None:
        parsed = parse_xml(CYCLIC_XML)
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph(collect_dependency_edges(parsed))
        detail = describe_bad_graph(parsed, exc.value)
        # Not the domain signal: no internal reason code, no list literal.
        assert "cyclic_dependency" not in detail
        assert "Infeasible task graph" not in detail
        assert "['" not in detail

    def test_falls_back_when_an_offending_uid_is_not_in_the_file(self) -> None:
        parsed = parse_xml(ACYCLIC_XML)
        exc = InfeasibleGraphError("self_reference", ["999"])
        assert "unknown task" in describe_bad_graph(parsed, exc)


@pytest.mark.django_db
class TestImportTaskRejectsBadGraphs:
    """The regression: a cyclic file must write nothing and never re-dispatch."""

    def _run(self, project: Project, xml: bytes, filename: str) -> tuple[Any, ImportRequest]:
        req = ImportRequest.objects.create(
            project=project,
            filename=filename,
            file_content_b64=base64.b64encode(xml).decode("ascii"),
            creates_project=True,
            status=ImportRequestStatus.DISPATCHED,
        )
        with patch("trueppm_api.apps.msproject.tasks._get_tracker", _stub_tracker):
            result = import_msproject.apply(
                kwargs={
                    "project_id": str(project.pk),
                    "file_content_b64": req.file_content_b64,
                    "filename": filename,
                    "import_request_id": str(req.id),
                    "creates_project": True,
                },
                throw=False,
            )
        req.refresh_from_db()
        return result, req

    def test_cyclic_file_creates_no_tasks(self, project: Project) -> None:
        result, _req = self._run(project, CYCLIC_XML, "cyclic.xml")

        assert result.failed()
        # The whole point of ADR-0259: bulk_create bypasses the serializer's
        # cycle check, so nothing must reach the database at all.
        assert Task.objects.filter(project=project).count() == 0

    def test_cyclic_file_marks_the_request_dead_and_clears_the_payload(
        self, project: Project
    ) -> None:
        _result, req = self._run(project, CYCLIC_XML, "cyclic.xml")

        # DEAD is terminal — the orphan drain must not re-dispatch a
        # deterministically bad file forever (ADR-0092).
        assert req.status == ImportRequestStatus.DEAD
        # #789: a DEAD row can never be retried, so its payload is cleared too.
        assert req.file_content_b64 == ""

    def test_self_referential_file_creates_no_tasks(self, project: Project) -> None:
        result, req = self._run(project, SELF_REF_XML, "selfref.xml")

        assert result.failed()
        assert req.status == ImportRequestStatus.DEAD
        assert Task.objects.filter(project=project).count() == 0

    def test_rejection_happens_before_the_header_is_applied(self, project: Project) -> None:
        # The guard runs ahead of _apply_header_to_project, so a create-from-import
        # shell keeps its filename-derived name rather than being half-renamed by
        # a file that is then refused.
        original_name = project.name
        self._run(project, CYCLIC_XML, "cyclic.xml")

        project.refresh_from_db()
        assert project.name == original_name

    @pytest.mark.parametrize("xml", [SUMMARY_TO_CHILD_XML, CHILD_TO_SUMMARY_XML])
    def test_summary_to_own_child_file_creates_no_tasks_and_is_dead(
        self, project: Project, xml: bytes
    ) -> None:
        result, req = self._run(project, xml, "nested.xml")

        assert result.failed()
        assert req.status == ImportRequestStatus.DEAD
        assert Task.objects.filter(project=project).count() == 0

    def test_summary_to_child_error_detail_is_the_described_text(self, project: Project) -> None:
        from trueppm_api.apps.taskruns.models import TaskRun

        result = import_msproject.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": base64.b64encode(SUMMARY_TO_CHILD_XML).decode(),
                "filename": "nested.xml",
            },
            throw=False,
        )
        assert result.failed()
        # What the user sees: TaskRun.error_detail is str(exception).
        detail = TaskRun.objects.get(project=project).error_detail
        assert "Phase" in detail
        assert "its own sub-task" in detail
        assert "cyclic_dependency" not in detail

    def test_ss_link_from_summary_to_own_child_is_skipped_not_refused(
        self, project: Project
    ) -> None:
        # Type 3 = Start-to-Start. ADR-0370 skips it with a warning; the file imports.
        result, _req = self._run(project, _ss_task_xml(3), "ss.xml")

        assert not result.failed()
        assert Task.objects.filter(project=project).count() == 2
        assert any("skipped" in w for w in result.result["warnings"])

    def test_unexpandable_summary_shape_is_dead_not_redispatched(
        self, project: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # InvalidScheduleInput is as deterministic as a cycle; without DEAD the
        # orphan drain re-dispatches the file forever (ADR-0092).
        monkeypatch.setattr("trueppm_scheduler.engine.MAX_EXPANDED_EDGES", 0)
        result, req = self._run(project, SUMMARY_TO_SIBLING_XML, "fanout.xml")

        assert result.failed()
        assert "InvalidScheduleInput" in repr(result.result)
        assert req.status == ImportRequestStatus.DEAD
        assert Task.objects.filter(project=project).count() == 0

    def test_acyclic_file_still_imports(self, project: Project) -> None:
        # The guard must not reject well-formed files.
        result, req = self._run(project, ACYCLIC_XML, "fine.xml")

        assert not result.failed()
        assert req.status == ImportRequestStatus.DONE
        assert Task.objects.filter(project=project).count() == 2
