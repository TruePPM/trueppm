"""Tests for MSPDI three-point / PERT estimate mapping (#798, ADR-0093).

Covers Duration1–4 ExtendedAttribute import and export round-trip for the
three-point estimate convention. Uses inline XML strings for unit tests; the
realistic ``cloud_migration.xml`` fixture from mpp-sample-generator (#801) is
exercised by the integration round-trip case at the bottom of this file.
"""

from __future__ import annotations

import pathlib
import xml.etree.ElementTree as ET
from datetime import date

import pytest

from trueppm_api.apps.msproject.exporter import export_project_xml
from trueppm_api.apps.msproject.extended_attributes import (
    DURATION1_FIELD_ID,
    DURATION2_FIELD_ID,
    DURATION3_FIELD_ID,
    DURATION4_FIELD_ID,
    PERT_EXPECTED_FORMULA,
)
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.msproject.parser import parse_xml
from trueppm_api.apps.projects.models import Calendar, Project, Task

_NS = "http://schemas.microsoft.com/project"
_FIXTURES = pathlib.Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _pert_xml(
    *,
    pert_defs: list[dict] | None = None,
    tasks: list[dict] | None = None,
) -> bytes:
    """Build a minimal MSPDI XML document with optional PERT defs and tasks.

    ``pert_defs`` is a list of ``{"FieldID": "...", "Alias": "..."}`` dicts
    emitted under ``<ExtendedAttributes>`` at project level. ``tasks`` is a
    list of dicts where the ``ExtendedAttributes`` key (if present) is a list
    of ``{"FieldID": "...", "Value": "PT..H0M0S"}`` per-task PERT values.
    """
    root = ET.Element(f"{{{_NS}}}Project")
    ET.SubElement(root, f"{{{_NS}}}Name").text = "PERT Test"
    ET.SubElement(root, f"{{{_NS}}}StartDate").text = "2026-01-05T08:00:00"

    if pert_defs:
        defs_el = ET.SubElement(root, f"{{{_NS}}}ExtendedAttributes")
        for d in pert_defs:
            ea = ET.SubElement(defs_el, f"{{{_NS}}}ExtendedAttribute")
            for k, v in d.items():
                ET.SubElement(ea, f"{{{_NS}}}{k}").text = str(v)

    tasks_el = ET.SubElement(root, f"{{{_NS}}}Tasks")
    for t in tasks or []:
        task_el = ET.SubElement(tasks_el, f"{{{_NS}}}Task")
        eas = t.pop("ExtendedAttributes", None)
        for k, v in t.items():
            ET.SubElement(task_el, f"{{{_NS}}}{k}").text = str(v)
        for ea in eas or []:
            ea_el = ET.SubElement(task_el, f"{{{_NS}}}ExtendedAttribute")
            for k, v in ea.items():
                ET.SubElement(ea_el, f"{{{_NS}}}{k}").text = str(v)

    return ET.tostring(root, encoding="unicode").encode("utf-8")


_STANDARD_DEFS = [
    {"FieldID": DURATION1_FIELD_ID, "FieldName": "Duration1", "Alias": "Optimistic"},
    {"FieldID": DURATION2_FIELD_ID, "FieldName": "Duration2", "Alias": "Most Likely"},
    {"FieldID": DURATION3_FIELD_ID, "FieldName": "Duration3", "Alias": "Pessimistic"},
    {
        "FieldID": DURATION4_FIELD_ID,
        "FieldName": "Duration4",
        "Alias": "PERT Expected",
        "Formula": PERT_EXPECTED_FORMULA,
    },
]


def _ea(field_id: str, value: str) -> dict[str, str]:
    return {"FieldID": field_id, "Value": value}


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="PERT Project",
        start_date=date(2026, 1, 5),
        calendar=calendar,
    )


# ---------------------------------------------------------------------------
# Parser: project-level definition detection
# ---------------------------------------------------------------------------


def test_parses_standard_pert_definitions() -> None:
    xml = _pert_xml(pert_defs=_STANDARD_DEFS)
    data = parse_xml(xml)
    # No tasks => no warnings about per-task data
    assert data.warnings == []


def test_warns_when_pert_fieldid_has_contradicting_alias() -> None:
    defs = [
        {"FieldID": DURATION1_FIELD_ID, "FieldName": "Duration1", "Alias": "Risk Score"},
        {"FieldID": DURATION2_FIELD_ID, "FieldName": "Duration2", "Alias": "Most Likely"},
        {"FieldID": DURATION3_FIELD_ID, "FieldName": "Duration3", "Alias": "Pessimistic"},
    ]
    tasks = [
        {
            "UID": 1,
            "Name": "T1",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT16H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),
                _ea(DURATION3_FIELD_ID, "PT64H0M0S"),
            ],
        }
    ]
    data = parse_xml(_pert_xml(pert_defs=defs, tasks=tasks))
    assert any("non-standard alias 'Risk Score'" in w for w in data.warnings)
    # Optimistic dropped at project level => task value can't be bound;
    # partial-3pt rule then nulls the remaining two.
    td = data.tasks[0]
    assert td.optimistic_duration_days is None
    assert td.most_likely_duration_days is None
    assert td.pessimistic_duration_days is None


def test_long_alias_in_warning_is_truncated() -> None:
    """A multi-MB <Alias> must not bloat the warning surface (security fix)."""
    huge_alias = "X" * 5000
    defs = [
        {"FieldID": DURATION1_FIELD_ID, "FieldName": "Duration1", "Alias": huge_alias},
        {"FieldID": DURATION2_FIELD_ID, "FieldName": "Duration2", "Alias": "Most Likely"},
        {"FieldID": DURATION3_FIELD_ID, "FieldName": "Duration3", "Alias": "Pessimistic"},
    ]
    data = parse_xml(_pert_xml(pert_defs=defs))
    assert len(data.warnings) == 1
    # Truncation cap is 100 chars; full warning string stays well under 5KB.
    assert len(data.warnings[0]) < 500


def test_parser_clamps_runaway_duration_values() -> None:
    """A crafted PT999...H must clamp to the model's MaxValueValidator bound
    so bulk_create can't smuggle astronomical integers into the database."""
    tasks = [
        {
            "UID": 1,
            "Name": "Crafted",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT9999999999H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT9999999999H0M0S"),
                _ea(DURATION3_FIELD_ID, "PT9999999999H0M0S"),
            ],
        }
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    td = data.tasks[0]
    # All three clamped to the MaxValueValidator(36_525) bound from
    # Task.optimistic_duration et al.
    assert td.optimistic_duration_days == 36_525
    assert td.most_likely_duration_days == 36_525
    assert td.pessimistic_duration_days == 36_525


def test_no_pert_block_no_pert_data() -> None:
    tasks = [{"UID": 1, "Name": "T1", "Duration": "PT40H0M0S", "OutlineLevel": 1}]
    data = parse_xml(_pert_xml(tasks=tasks))
    assert data.tasks[0].optimistic_duration_days is None
    assert data.warnings == []


# ---------------------------------------------------------------------------
# Parser: per-task value mapping
# ---------------------------------------------------------------------------


def test_imports_three_point_values_in_working_days() -> None:
    tasks = [
        {
            "UID": 1,
            "Name": "Build API",
            "Duration": "PT40H0M0S",  # 5 days
            "OutlineLevel": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT24H0M0S"),  # 3 days
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),  # 5 days
                _ea(DURATION3_FIELD_ID, "PT72H0M0S"),  # 9 days
            ],
        }
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    td = data.tasks[0]
    assert td.optimistic_duration_days == 3
    assert td.most_likely_duration_days == 5
    assert td.pessimistic_duration_days == 9


def test_partial_three_point_is_all_or_none_with_warning() -> None:
    tasks = [
        {
            "UID": 1,
            "Name": "Half-spec'd task",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT24H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),
                # Missing Duration3
            ],
        }
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    td = data.tasks[0]
    assert (
        td.optimistic_duration_days,
        td.most_likely_duration_days,
        td.pessimistic_duration_days,
    ) == (
        None,
        None,
        None,
    )
    assert any(
        "Half-spec'd task" in w and "partial three-point estimate" in w and "Pessimistic" in w
        for w in data.warnings
    )


def test_out_of_order_three_point_is_dropped_with_warning() -> None:
    """#2002: a complete but mis-ordered triple is dropped, not imported.

    optimistic=9, most_likely=5, pessimistic=3 violates
    optimistic <= most_likely <= pessimistic. The scheduler engine rejects such a
    triple at compute time (and the importer would mark it accepted), so the
    parser drops all three and warns — mirroring the all-or-none policy.
    """
    tasks = [
        {
            "UID": 1,
            "Name": "Backwards estimate",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT72H0M0S"),  # optimistic = 9 days
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),  # most_likely = 5 days
                _ea(DURATION3_FIELD_ID, "PT24H0M0S"),  # pessimistic = 3 days
            ],
        }
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    td = data.tasks[0]
    assert (
        td.optimistic_duration_days,
        td.most_likely_duration_days,
        td.pessimistic_duration_days,
    ) == (None, None, None)
    assert any("Backwards estimate" in w and "out of order" in w for w in data.warnings)


def test_milestone_three_point_values_are_dropped() -> None:
    tasks = [
        {
            "UID": 1,
            "Name": "Launch",
            "Duration": "PT0H0M0S",
            "OutlineLevel": 1,
            "Milestone": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT8H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT8H0M0S"),
                _ea(DURATION3_FIELD_ID, "PT8H0M0S"),
            ],
        }
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    td = data.tasks[0]
    assert td.is_milestone
    assert td.optimistic_duration_days is None
    assert td.most_likely_duration_days is None
    assert td.pessimistic_duration_days is None


# ---------------------------------------------------------------------------
# Importer: model writes + summary counts
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_importer_writes_three_point_fields_and_sets_accepted(project: Project) -> None:
    tasks = [
        {
            "UID": 1,
            "Name": "Design",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT24H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),
                _ea(DURATION3_FIELD_ID, "PT64H0M0S"),
            ],
        }
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    summary = import_project(str(project.pk), data, wipe_existing=True)

    t = Task.objects.get(project=project, name="Design")
    assert t.optimistic_duration == 3
    assert t.most_likely_duration == 5
    assert t.pessimistic_duration == 8
    assert t.estimate_status == "accepted"
    assert summary["tasks_with_three_point_estimates"] == 1
    assert summary["tasks_skipped_partial_three_point"] == 0


@pytest.mark.django_db
def test_importer_skips_three_point_on_summary_rows(project: Project) -> None:
    # Phase 1 (summary) followed by a child task. Even though the file
    # (incorrectly) carries Duration1/2/3 on the summary, the importer must
    # drop them because MS Project's semantics treat summaries as roll-ups.
    tasks = [
        {
            "UID": 1,
            "Name": "Phase 1",
            "Duration": "PT80H0M0S",
            "OutlineLevel": 1,
            "OutlineNumber": "1",
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT24H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),
                _ea(DURATION3_FIELD_ID, "PT80H0M0S"),
            ],
        },
        {
            "UID": 2,
            "Name": "Design API",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 2,
            "OutlineNumber": "1.1",
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT24H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),
                _ea(DURATION3_FIELD_ID, "PT64H0M0S"),
            ],
        },
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    summary = import_project(str(project.pk), data, wipe_existing=True)

    phase = Task.objects.get(project=project, name="Phase 1")
    leaf = Task.objects.get(project=project, name="Design API")
    assert phase.optimistic_duration is None
    assert phase.most_likely_duration is None
    assert phase.pessimistic_duration is None
    assert phase.estimate_status is None
    assert leaf.optimistic_duration == 3
    assert leaf.estimate_status == "accepted"
    # Counts only the leaf row.
    assert summary["tasks_with_three_point_estimates"] == 1


@pytest.mark.django_db
def test_importer_summary_counts_partial_skips(project: Project) -> None:
    tasks = [
        {
            "UID": 1,
            "Name": "Good",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 1,
            "ExtendedAttributes": [
                _ea(DURATION1_FIELD_ID, "PT24H0M0S"),
                _ea(DURATION2_FIELD_ID, "PT40H0M0S"),
                _ea(DURATION3_FIELD_ID, "PT64H0M0S"),
            ],
        },
        {
            "UID": 2,
            "Name": "Partial",
            "Duration": "PT40H0M0S",
            "OutlineLevel": 1,
            "ExtendedAttributes": [_ea(DURATION1_FIELD_ID, "PT24H0M0S")],
        },
    ]
    data = parse_xml(_pert_xml(pert_defs=_STANDARD_DEFS, tasks=tasks))
    summary = import_project(str(project.pk), data, wipe_existing=True)
    assert summary["tasks_with_three_point_estimates"] == 1
    assert summary["tasks_skipped_partial_three_point"] == 1


# ---------------------------------------------------------------------------
# Exporter
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_exporter_emits_pert_defs_when_any_task_has_estimates(project: Project) -> None:
    Task.objects.create(
        project=project,
        name="Build",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
        estimate_status="accepted",
        wbs_path="1",
        short_id="00000001",
    )
    xml = export_project_xml(str(project.pk))
    root = ET.fromstring(xml)
    ea_block = root.find(f"{{{_NS}}}ExtendedAttributes")
    assert ea_block is not None, "PERT defs missing from export"
    fids = [
        (e.findtext(f"{{{_NS}}}FieldID"), e.findtext(f"{{{_NS}}}Alias"))
        for e in ea_block.findall(f"{{{_NS}}}ExtendedAttribute")
    ]
    assert (DURATION1_FIELD_ID, "Optimistic") in fids
    assert (DURATION2_FIELD_ID, "Most Likely") in fids
    assert (DURATION3_FIELD_ID, "Pessimistic") in fids
    assert (DURATION4_FIELD_ID, "PERT Expected") in fids
    # Duration4 carries the formula
    d4 = next(
        e
        for e in ea_block.findall(f"{{{_NS}}}ExtendedAttribute")
        if e.findtext(f"{{{_NS}}}FieldID") == DURATION4_FIELD_ID
    )
    assert d4.findtext(f"{{{_NS}}}Formula") == PERT_EXPECTED_FORMULA


@pytest.mark.django_db
def test_exporter_omits_pert_defs_when_no_task_has_estimates(project: Project) -> None:
    Task.objects.create(
        project=project, name="No-estimate", duration=5, wbs_path="1", short_id="00000001"
    )
    xml = export_project_xml(str(project.pk))
    root = ET.fromstring(xml)
    assert root.find(f"{{{_NS}}}ExtendedAttributes") is None


@pytest.mark.django_db
def test_exporter_skips_per_task_pert_on_milestones_and_summaries(project: Project) -> None:
    # Summary task with descendant + milestone — neither should emit
    # per-task PERT ExtendedAttribute children even if the model fields are
    # set (defensive behavior; the importer wouldn't have written them).
    Task.objects.create(
        project=project,
        name="Phase 1",
        duration=10,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
        wbs_path="1",
        short_id="00000001",
    )
    Task.objects.create(
        project=project,
        name="Build API",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
        wbs_path="1.1",
        short_id="00000002",
    )
    Task.objects.create(
        project=project,
        name="Launch",
        duration=0,
        is_milestone=True,
        optimistic_duration=1,
        most_likely_duration=1,
        pessimistic_duration=1,
        wbs_path="2",
        short_id="00000003",
    )
    xml = export_project_xml(str(project.pk))
    root = ET.fromstring(xml)
    tasks = root.find(f"{{{_NS}}}Tasks")
    assert tasks is not None
    found: dict[str, list[str]] = {}
    for t in tasks.findall(f"{{{_NS}}}Task"):
        name = t.findtext(f"{{{_NS}}}Name") or ""
        found[name] = [
            (e.findtext(f"{{{_NS}}}FieldID") or "")
            for e in t.findall(f"{{{_NS}}}ExtendedAttribute")
        ]
    # Leaf gets all three; summary and milestone get none.
    assert set(found["Build API"]) == {DURATION1_FIELD_ID, DURATION2_FIELD_ID, DURATION3_FIELD_ID}
    assert found["Phase 1"] == []
    assert found["Launch"] == []


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_round_trip_three_point_exact_at_8h_multiples(project: Project, calendar: Calendar) -> None:
    """Hour-multiples of 8 round-trip losslessly (ADR-0093 Q7 limitations)."""
    Task.objects.create(
        project=project,
        name="Task A",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
        wbs_path="1",
        short_id="00000001",
    )
    Task.objects.create(
        project=project,
        name="Task B",
        duration=2,
        optimistic_duration=1,
        most_likely_duration=2,
        pessimistic_duration=4,
        wbs_path="2",
        short_id="00000002",
    )

    xml = export_project_xml(str(project.pk))
    data = parse_xml(xml)

    project2 = Project.objects.create(
        name="Round-trip target",
        start_date=date(2026, 2, 1),
        calendar=calendar,
    )
    import_project(str(project2.pk), data, wipe_existing=True)

    a = Task.objects.get(project=project2, name="Task A")
    b = Task.objects.get(project=project2, name="Task B")
    assert (a.optimistic_duration, a.most_likely_duration, a.pessimistic_duration) == (3, 5, 8)
    assert (b.optimistic_duration, b.most_likely_duration, b.pessimistic_duration) == (1, 2, 4)
    assert a.estimate_status == "accepted"
    assert b.estimate_status == "accepted"


@pytest.mark.django_db
def test_cloud_migration_fixture_imports_three_point_estimates(project: Project) -> None:
    """Integration test against the realistic mpp-sample-generator fixture.

    The fixture (landed with #801 / MR !427) has 28 tasks with 17 leaf work
    tasks carrying three-point estimates and project-level Duration1–4
    ExtendedAttribute definitions.
    """
    xml = (_FIXTURES / "cloud_migration.xml").read_bytes()
    data = parse_xml(xml)
    summary = import_project(str(project.pk), data, wipe_existing=True)

    # 17 leaf work tasks carry estimates in the fixture (per fixtures/README.md).
    assert summary["tasks_with_three_point_estimates"] == 17
    assert summary["tasks_skipped_partial_three_point"] == 0
    # Every task with estimates has status accepted.
    n = Task.objects.filter(project=project, most_likely_duration__isnull=False).count()
    assert n == 17
    accepted = Task.objects.filter(
        project=project, most_likely_duration__isnull=False, estimate_status="accepted"
    ).count()
    assert accepted == 17
