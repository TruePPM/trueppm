"""Constraint / actual fidelity and drop reporting for MS Project import (#2891).

Two claims are under test, and they are different in kind:

1. The fields that **do** have a TruePPM column (SNET / MSO constraint dates,
   ActualStart, ActualFinish) are carried across, and the constraint date beats
   ``<Start>`` when the two diverge.
2. The fields that do **not** have a column are *reported*. Before this change
   an MSPDI carrying constraints, deadlines, baselines, priority, work and cost
   imported with ``ProjectData.warnings == []`` — the drops were invisible, which
   is the actual defect. So the strongest assertion here is the negative one:
   the warning list is not empty for a file that lost data.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from trueppm_api.apps.msproject.dataclasses import CONSTRAINT_TYPES_APPLIED_AS_SNET
from trueppm_api.apps.msproject.exporter import (
    MSPDI_CONSTRAINT_AS_SOON_AS_POSSIBLE,
    MSPDI_CONSTRAINT_START_NO_EARLIER_THAN,
)
from trueppm_api.apps.msproject.parser import MSPDI_CONSTRAINT_NAMES, parse_xml

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES / "constraints_actuals_baselines.xml"


@pytest.fixture
def parsed() -> object:
    return parse_xml(FIXTURE.read_bytes())


def _task(parsed: object, name: str) -> object:
    return next(t for t in parsed.tasks if t.name == name)  # type: ignore[attr-defined]


class TestConstraintsAndActualsAreParsed:
    def test_constraint_type_and_date_reach_the_interchange_shape(self, parsed: object) -> None:
        design = _task(parsed, "Design")
        assert design.constraint_type == 4  # type: ignore[attr-defined]
        assert design.constraint_date == "2026-03-09"  # type: ignore[attr-defined]

    def test_actual_dates_reach_the_interchange_shape(self, parsed: object) -> None:
        design = _task(parsed, "Design")
        assert design.actual_start == "2026-03-09"  # type: ignore[attr-defined]
        assert design.actual_finish == "2026-03-13"  # type: ignore[attr-defined]

    def test_a_task_with_no_constraint_date_carries_none(self, parsed: object) -> None:
        retro = _task(parsed, "Retrospective")
        assert retro.constraint_type == 0  # type: ignore[attr-defined]
        assert retro.constraint_date is None  # type: ignore[attr-defined]

    @pytest.mark.parametrize("sentinel", ["NA", "", "   ", "not-a-date"])
    def test_sentinel_dates_do_not_become_real_dates(self, sentinel: str) -> None:
        """MS Project writes "NA" for "no value"; landing that in the model is worse
        than dropping it, so the parser must reject it rather than truncate it."""
        xml = f"""<?xml version="1.0"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Tasks><Task>
    <UID>1</UID><Name>T</Name><Duration>PT8H0M0S</Duration>
    <ActualStart>{sentinel}</ActualStart><ConstraintDate>{sentinel}</ConstraintDate>
  </Task></Tasks>
</Project>""".encode()
        task = parse_xml(xml).tasks[0]
        assert task.actual_start is None
        assert task.constraint_date is None


class TestDropsAreReported:
    """The heart of #2891: the file lost data and the import said so."""

    def test_the_warning_list_is_not_empty(self, parsed: object) -> None:
        assert parsed.warnings != []  # type: ignore[attr-defined]

    @pytest.mark.parametrize(
        "fragment",
        ["deadline dates", "baselines", "task priority", "work / effort hours", "cost figures"],
    )
    def test_each_dropped_family_is_named_with_a_count(self, parsed: object, fragment: str) -> None:
        matching = [w for w in parsed.warnings if fragment in w]  # type: ignore[attr-defined]
        assert len(matching) == 1, parsed.warnings  # type: ignore[attr-defined]
        # "of 4 tasks" — a bare "some values were dropped" is not actionable.
        assert "of 4 tasks" in matching[0]

    def test_an_unmappable_constraint_is_named_by_its_ms_project_name(self, parsed: object) -> None:
        assert any(
            MSPDI_CONSTRAINT_NAMES[7] in w
            for w in parsed.warnings  # type: ignore[attr-defined]
        )

    def test_a_partially_mapped_constraint_says_which_half_survived(self, parsed: object) -> None:
        partial = [
            w
            for w in parsed.warnings  # type: ignore[attr-defined]
            if w.startswith("Partially imported")
        ]
        assert len(partial) == 1
        assert MSPDI_CONSTRAINT_NAMES[2] in partial[0]
        assert "cannot also stop the task starting later" in partial[0]

    def test_the_constraint_types_we_apply_are_not_reported_as_dropped(
        self, parsed: object
    ) -> None:
        """SNET is carried across exactly, so reporting it as a loss would be a lie
        — and a warning list that cries wolf is one nobody reads."""
        snet_name = MSPDI_CONSTRAINT_NAMES[4]
        assert not any(
            w.startswith("Not imported") and snet_name in w
            for w in parsed.warnings  # type: ignore[attr-defined]
        )

    def test_ms_project_defaults_are_not_reported_as_dropped_data(self) -> None:
        """A full MS Project export writes Priority/Work/Cost on every row. If the
        defaults counted, every import would report losses it did not have."""
        xml = b"""<?xml version="1.0"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Tasks><Task>
    <UID>1</UID><Name>T</Name><Duration>PT8H0M0S</Duration>
    <ConstraintType>0</ConstraintType>
    <Priority>500</Priority><Work>PT0H0M0S</Work><Cost>0</Cost>
  </Task></Tasks>
</Project>"""
        assert parse_xml(xml).warnings == []

    def test_a_file_with_nothing_dropped_warns_about_nothing(self) -> None:
        xml = b"""<?xml version="1.0"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Tasks><Task>
    <UID>1</UID><Name>T</Name><Duration>PT8H0M0S</Duration>
    <ConstraintType>4</ConstraintType><ConstraintDate>2026-03-09T08:00:00</ConstraintDate>
  </Task></Tasks>
</Project>"""
        assert parse_xml(xml).warnings == []

    def test_the_existing_fixtures_gain_no_spurious_warnings(self) -> None:
        """Regression guard on the noise floor: the sample plans in this suite
        carry none of these families, so the new pass must stay silent on them."""
        for name in ("sample.xml", "minimal.xml", "milestones_only.xml"):
            warnings = parse_xml((FIXTURES / name).read_bytes()).warnings
            assert [w for w in warnings if "Not imported" in w] == [], name


@pytest.mark.django_db
class TestImportedTaskCarriesTheCommitment:
    @pytest.fixture
    def project(self, db: object) -> object:
        from trueppm_api.apps.projects.models import Calendar, Project

        calendar = Calendar.objects.create(name="Standard")
        return Project.objects.create(
            name="Constraint target", start_date=date(2026, 3, 2), calendar=calendar
        )

    def _import(self, project: object) -> object:
        from trueppm_api.apps.msproject.importer import import_project
        from trueppm_api.apps.projects.models import Task

        import_project(str(project.pk), parse_xml(FIXTURE.read_bytes()))  # type: ignore[attr-defined]
        return {t.name: t for t in Task.objects.filter(project_id=project.pk)}  # type: ignore[attr-defined]

    def test_the_constraint_date_beats_the_computed_start(self, project: object) -> None:
        """The whole point. `<Start>` is 16 March (CPM output); the PM's commitment
        is 9 March. Importing the computed date discards the commitment and then
        reschedules from it, producing dates the PM cannot defend."""
        tasks = self._import(project)
        assert tasks["Design"].planned_start == date(2026, 3, 9)

    def test_actual_dates_land_on_the_task(self, project: object) -> None:
        tasks = self._import(project)
        assert tasks["Design"].actual_start == date(2026, 3, 9)
        assert tasks["Design"].actual_finish == date(2026, 3, 13)
        assert tasks["Build"].actual_start == date(2026, 3, 23)
        assert tasks["Build"].actual_finish is None

    def test_a_task_with_an_unmappable_constraint_falls_back_to_start(
        self, project: object
    ) -> None:
        """FNLT has no TruePPM home, so the task keeps the previous behavior — its
        `<Start>` — rather than silently acquiring the finish constraint's date as
        a start floor."""
        tasks = self._import(project)
        assert tasks["Go live"].planned_start == date(2026, 4, 30)

    def test_the_summary_carries_the_drop_report(self, project: object) -> None:
        from trueppm_api.apps.msproject.importer import import_project

        summary = import_project(str(project.pk), parse_xml(FIXTURE.read_bytes()))  # type: ignore[attr-defined]
        assert any("Not imported" in w for w in summary["warnings"])


class TestRoundTrip:
    """A plan that goes out and comes back must keep its commitment."""

    def test_export_emits_the_snet_constraint_for_a_planned_start(self) -> None:
        import xml.etree.ElementTree as ET

        from trueppm_api.apps.msproject.exporter import _add_task_element

        class _Task:
            pk = "1"
            name = "Design"
            duration = 5
            wbs_path = "1"
            is_milestone = False
            percent_complete = 0
            notes = ""
            early_start = date(2026, 3, 16)
            early_finish = date(2026, 3, 20)
            planned_start = date(2026, 3, 9)
            actual_start = date(2026, 3, 9)
            actual_finish = None
            optimistic_duration = None
            most_likely_duration = None
            pessimistic_duration = None

        root = ET.Element("Tasks")
        _add_task_element(root, _Task(), 1, is_pert=False, preds=[], task_pk_to_uid={})
        emitted = {child.tag.split("}")[-1]: child.text for child in root[0]}
        assert emitted["ConstraintType"] == str(MSPDI_CONSTRAINT_START_NO_EARLIER_THAN)
        assert emitted["ConstraintDate"] == "2026-03-09T00:00:00"
        assert emitted["ActualStart"] == "2026-03-09T00:00:00"
        assert "ActualFinish" not in emitted
        # <Start> is still CPM output; the constraint is what carries the commitment.
        assert emitted["Start"] == "2026-03-16T00:00:00"

    def test_export_declares_as_soon_as_possible_when_there_is_no_floor(self) -> None:
        """An omitted ConstraintType lets MS Project infer one from `<Start>`,
        which re-creates the computed-becomes-committed promotion in reverse."""
        import xml.etree.ElementTree as ET

        from trueppm_api.apps.msproject.exporter import _add_task_element

        class _Task:
            pk = "1"
            name = "Unpinned"
            duration = 5
            wbs_path = "1"
            is_milestone = False
            percent_complete = 0
            notes = ""
            early_start = date(2026, 3, 16)
            early_finish = date(2026, 3, 20)
            planned_start = None
            actual_start = None
            actual_finish = None
            optimistic_duration = None
            most_likely_duration = None
            pessimistic_duration = None

        root = ET.Element("Tasks")
        _add_task_element(root, _Task(), 1, is_pert=False, preds=[], task_pk_to_uid={})
        emitted = {child.tag.split("}")[-1]: child.text for child in root[0]}
        assert emitted["ConstraintType"] == str(MSPDI_CONSTRAINT_AS_SOON_AS_POSSIBLE)
        assert "ConstraintDate" not in emitted

    def test_the_exporter_and_importer_agree_on_which_code_means_snet(self) -> None:
        """The round trip only closes if the code the exporter writes is one the
        importer applies — two constants in two modules that must not drift."""
        assert MSPDI_CONSTRAINT_START_NO_EARLIER_THAN in CONSTRAINT_TYPES_APPLIED_AS_SNET
        assert MSPDI_CONSTRAINT_AS_SOON_AS_POSSIBLE not in CONSTRAINT_TYPES_APPLIED_AS_SNET
