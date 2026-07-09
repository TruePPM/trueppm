"""Import-hardening tests for the MS Project importer.

Covers three red-team findings:

* #1720 — non-finite (nan/inf/1e999) numeric fields must be rejected/clamped at
  the parser choke point (they bypass the model validators via ``bulk_create``
  and would poison CPM / Monte Carlo math and emit invalid JSON), and
  ``Task.percent_complete`` must carry range validators for the interactive path.
* #1721 — the parser must cap the task / resource / dependency row count (the
  upload SIZE cap alone does not bound the row count), and every ``bulk_create``
  must be chunked with a ``batch_size``.
* #1722 — ``parse_mpp`` must bound the MPXJ subprocess stdout so a
  decompression-bomb ``.mpp`` cannot OOM the worker.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from typing import Any
from unittest.mock import patch

import pytest
from django.core.exceptions import ValidationError
from django.test import override_settings

from trueppm_api.apps.msproject.dataclasses import ProjectData, TaskData
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.msproject.parser import (
    MsProjectImportError,
    _finite_float,
    parse_mpp,
    parse_xml,
)
from trueppm_api.apps.projects.models import Project, Task

_NS = "http://schemas.microsoft.com/project"


def _build_xml(
    tasks: list[dict] | None = None,
    resources: list[dict] | None = None,
    assignments: list[dict] | None = None,
) -> bytes:
    """Build a minimal MSPDI document (mirrors test_msproject._build_sample_xml)."""
    root = ET.Element(f"{{{_NS}}}Project")
    ET.SubElement(root, f"{{{_NS}}}Name").text = "Hardening Test"
    ET.SubElement(root, f"{{{_NS}}}StartDate").text = "2026-01-05T08:00:00"

    tasks_el = ET.SubElement(root, f"{{{_NS}}}Tasks")
    for t in tasks or []:
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
# #1720 — finite guard + clamp on imported numeric fields
# ---------------------------------------------------------------------------


class TestFiniteFloatHelper:
    def test_rejects_nan(self) -> None:
        assert _finite_float("nan", 0.0, low=0.0, high=1.0) == 0.0

    def test_rejects_positive_inf(self) -> None:
        assert _finite_float("inf", 7.0, low=0.0, high=1.0) == 7.0

    def test_rejects_negative_inf(self) -> None:
        assert _finite_float("-inf", 3.0, low=0.0, high=1.0) == 3.0

    def test_rejects_1e999_overflow(self) -> None:
        # float("1e999") == inf — the classic "valid literal, non-finite" case.
        assert math.isinf(float("1e999"))
        assert _finite_float("1e999", 1.0, low=0.0, high=1000.0) == 1.0

    def test_clamps_above_high(self) -> None:
        assert _finite_float("500", 1.0, low=0.0, high=100.0) == 100.0

    def test_clamps_below_low(self) -> None:
        assert _finite_float("-5", 1.0, low=0.0, high=100.0) == 0.0

    def test_finite_in_range_passes_through(self) -> None:
        assert _finite_float("42.5", 1.0, low=0.0, high=100.0) == 42.5

    def test_unparseable_falls_back(self) -> None:
        assert _finite_float("abc", 9.0, low=0.0, high=100.0) == 9.0


class TestPercentCompleteFiniteGuard:
    @pytest.mark.parametrize("bad", ["nan", "inf", "-inf", "1e999"])
    def test_non_finite_percent_becomes_zero(self, bad: str) -> None:
        data = parse_xml(_build_xml(tasks=[{"UID": "1", "Name": "T", "PercentComplete": bad}]))
        pc = data.tasks[0].percent_complete
        assert math.isfinite(pc)
        assert pc == 0.0

    def test_over_100_percent_clamped_to_one(self) -> None:
        data = parse_xml(_build_xml(tasks=[{"UID": "1", "Name": "T", "PercentComplete": "150"}]))
        assert data.tasks[0].percent_complete == 1.0

    def test_normal_percent_unchanged(self) -> None:
        data = parse_xml(_build_xml(tasks=[{"UID": "1", "Name": "T", "PercentComplete": "75"}]))
        assert data.tasks[0].percent_complete == 0.75


class TestUnitsFiniteGuard:
    @pytest.mark.parametrize("bad", ["nan", "inf", "1e999"])
    def test_non_finite_max_units_falls_back(self, bad: str) -> None:
        data = parse_xml(_build_xml(resources=[{"UID": "1", "Name": "R", "MaxUnits": bad}]))
        mu = data.resources[0].max_units
        assert math.isfinite(mu)
        assert mu == 1.0

    def test_huge_max_units_clamped(self) -> None:
        data = parse_xml(_build_xml(resources=[{"UID": "1", "Name": "R", "MaxUnits": "1000000"}]))
        assert data.resources[0].max_units == 1000.0

    def test_non_finite_assignment_units_falls_back(self) -> None:
        data = parse_xml(
            _build_xml(
                tasks=[{"UID": "1", "Name": "T"}],
                resources=[{"UID": "1", "Name": "R", "MaxUnits": "1.0"}],
                assignments=[{"TaskUID": "1", "ResourceUID": "1", "Units": "nan"}],
            )
        )
        units = data.tasks[0].resource_assignments[0].units
        assert math.isfinite(units)
        assert units == 1.0


class TestPercentCompleteModelValidator:
    """The FloatField now carries MinValueValidator(0)/MaxValueValidator(100)."""

    def _field(self) -> Any:
        return Task._meta.get_field("percent_complete")

    def test_rejects_above_100(self) -> None:
        with pytest.raises(ValidationError):
            self._field().run_validators(150)

    def test_rejects_negative(self) -> None:
        with pytest.raises(ValidationError):
            self._field().run_validators(-1)

    def test_accepts_in_range(self) -> None:
        # No exception for the valid boundary values.
        self._field().run_validators(0)
        self._field().run_validators(100)


# ---------------------------------------------------------------------------
# #1721 — row-count cap + bulk_create batch_size
# ---------------------------------------------------------------------------


class TestRowCap:
    @override_settings(MSPROJECT_MAX_ROWS=2)
    def test_task_count_over_cap_rejected(self) -> None:
        xml = _build_xml(tasks=[{"UID": str(i), "Name": f"T{i}"} for i in range(1, 5)])
        with pytest.raises(MsProjectImportError, match="too many tasks"):
            parse_xml(xml)

    @override_settings(MSPROJECT_MAX_ROWS=2)
    def test_resource_count_over_cap_rejected(self) -> None:
        xml = _build_xml(
            tasks=[{"UID": "1", "Name": "T"}],
            resources=[{"UID": str(i), "Name": f"R{i}"} for i in range(1, 5)],
        )
        with pytest.raises(MsProjectImportError, match="too many resources"):
            parse_xml(xml)

    @override_settings(MSPROJECT_MAX_ROWS=2)
    def test_dependency_count_over_cap_rejected(self) -> None:
        links = [{"PredecessorUID": str(i), "Type": "1", "LinkLag": "0"} for i in range(1, 5)]
        xml = _build_xml(tasks=[{"UID": "10", "Name": "T", "PredecessorLinks": links}])
        with pytest.raises(MsProjectImportError, match="too many dependencies"):
            parse_xml(xml)

    @override_settings(MSPROJECT_MAX_ROWS=100)
    def test_under_cap_parses(self) -> None:
        xml = _build_xml(tasks=[{"UID": str(i), "Name": f"T{i}"} for i in range(1, 5)])
        data = parse_xml(xml)
        assert len(data.tasks) == 4


@pytest.mark.django_db
class TestBatchSizeExercised:
    def _project(self) -> Project:
        return Project.objects.create(name="Batch Test", start_date="2026-01-05")

    @override_settings(IMPORT_BULK_BATCH_SIZE=2)
    def test_import_across_multiple_batches_creates_all_tasks(self) -> None:
        project = self._project()
        data = ProjectData(
            name="Batch",
            tasks=[
                TaskData(uid=i, name=f"T{i}", outline_number=str(i), outline_level=0)
                for i in range(1, 6)
            ],
        )
        summary = import_project(str(project.pk), data)
        assert summary["tasks_created"] == 5
        assert Task.objects.filter(project_id=project.pk).count() == 5

    @override_settings(IMPORT_BULK_BATCH_SIZE=2)
    def test_bulk_create_receives_batch_size(self) -> None:
        project = self._project()
        data = ProjectData(
            name="Batch",
            tasks=[
                TaskData(uid=i, name=f"T{i}", outline_number=str(i), outline_level=0)
                for i in range(1, 4)
            ],
        )
        original = Task.objects.bulk_create
        seen: dict[str, Any] = {}

        def _spy(objs: Any, *args: Any, **kwargs: Any) -> Any:
            seen["batch_size"] = kwargs.get("batch_size")
            return original(objs, *args, **kwargs)

        with patch.object(Task.objects, "bulk_create", side_effect=_spy):
            import_project(str(project.pk), data)

        assert seen["batch_size"] == 2


# ---------------------------------------------------------------------------
# #1722 — bounded MPXJ subprocess stdout
# ---------------------------------------------------------------------------


class _FakeStream:
    """Minimal stand-in for a subprocess pipe."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)

    def read(self, _n: int = -1) -> bytes:
        if self._chunks:
            return self._chunks.pop(0)
        return b""


class _FakePopen:
    def __init__(self, stdout_chunks: list[bytes], returncode: int = 0) -> None:
        self.stdout = _FakeStream(stdout_chunks)
        self.stderr = _FakeStream([b""])
        self.returncode = returncode
        self.killed = False

    def kill(self) -> None:
        self.killed = True

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode


class TestMpxjStdoutBound:
    @override_settings(MPXJ_JAR_PATH="/tmp/fake-mpxj.jar", MPXJ_MAX_OUTPUT_MB=1)
    def test_stdout_over_cap_aborts(self) -> None:
        # ~2 MB of output against a 1 MB cap → abort as a likely bomb.
        chunks = [b"x" * 65536 for _ in range(32)]
        popen = _FakePopen(chunks)
        with (
            patch("os.path.isfile", return_value=True),
            patch("subprocess.Popen", return_value=popen),
            pytest.raises(RuntimeError, match="decompression bomb"),
        ):
            parse_mpp(b"fake-mpp-bytes")
        assert popen.killed is True

    @override_settings(MPXJ_JAR_PATH="/tmp/fake-mpxj.jar", MPXJ_MAX_OUTPUT_MB=1)
    def test_small_output_parses_normally(self) -> None:
        xml = _build_xml(tasks=[{"UID": "1", "Name": "Only Task"}])
        popen = _FakePopen([xml, b""])
        with (
            patch("os.path.isfile", return_value=True),
            patch("subprocess.Popen", return_value=popen),
        ):
            data = parse_mpp(b"fake-mpp-bytes")
        assert [t.name for t in data.tasks] == ["Only Task"]
        assert popen.killed is False

    @override_settings(MPXJ_JAR_PATH="/tmp/fake-mpxj.jar", MPXJ_MAX_OUTPUT_MB=1)
    def test_nonzero_exit_raises(self) -> None:
        popen = _FakePopen([b""], returncode=1)
        popen.stderr = _FakeStream([b"boom"])
        with (
            patch("os.path.isfile", return_value=True),
            patch("subprocess.Popen", return_value=popen),
            pytest.raises(RuntimeError, match="MPXJ conversion failed"),
        ):
            parse_mpp(b"fake-mpp-bytes")
