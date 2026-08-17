"""Cross-importer ``percent_complete`` scale guard (#2889).

``Task.percent_complete`` is a **0-100 percent** — its validators say so, and EVM/SPI,
the progress ring, the Gantt fill and the parent rollup all read it as one. Each of
the three importers derives that number from a different source (an MSPDI
``PercentComplete`` element, a Jira status name, a spreadsheet cell), and each
derivation is a fresh opportunity to write a 0-1 fraction into the 0-100 field.

That is not hypothetical: #1759 fixed it on the MS Project side (a 75% task landing
at 0.75%), and five weeks later #2889 found the identical defect in the Jira
importer (every Done issue at 1%) — the same bug, fixed once at one instance, with
nothing asserting the rule across the others. This module is that assertion.

Two rules, applied to every importer:

1. Every parsed ``percent_complete`` is within ``[0, 100]``.
2. A source row that is **fully delivered** parses to exactly ``100.0``.

Rule 2 is the load-bearing one. A 0-1 fraction is *inside* the [0, 100] bounds, so
rule 1 alone would have passed on both bugs — the wrong scale is only visible when
something asserts what "done" is worth.

Deliberately parser-level: the parsers are the only place the scale is chosen. The
DB-level counterparts (that the chosen value survives ``bulk_create``) live with
each importer's own suite.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from django.core.validators import MaxValueValidator, MinValueValidator

from trueppm_api.apps.csvimport.parser import parse_spreadsheet
from trueppm_api.apps.jiraimport.parser import parse_jira_xml
from trueppm_api.apps.msproject.parser import parse_xml
from trueppm_api.apps.projects.models import Task, TaskStatus

from .csvimport.fixtures import REFERENCE_CSV
from .jiraimport.fixtures import STATUS_EXPORT

if TYPE_CHECKING:
    from trueppm_api.apps.msproject.parser import TaskData

# The percent an importer must write for work the source reports as delivered.
# Stated here independently of the importers so a change to either side of the
# scale has to disagree with this file to land.
FULL_PERCENT = 100.0

_MSPDI_SAMPLE = Path(__file__).parent / "msproject" / "fixtures" / "sample.xml"


def _assert_within_bounds(tasks: list[TaskData], label: str) -> None:
    """Rule 1: no parsed percent escapes the field's own validator range."""
    for task in tasks:
        assert 0.0 <= task.percent_complete <= 100.0, (
            f"{label}: {task.name!r} parsed percent_complete="
            f"{task.percent_complete} outside the field's 0-100 range"
        )


def test_task_percent_complete_field_is_the_0_100_scale() -> None:
    """The premise every case below rests on, read off the model rather than assumed.

    If ``Task.percent_complete`` ever became a 0-1 fraction, this test fails first
    and the three importer cases below become the wrong assertion — which is the
    point of pinning it here instead of restating "0-100" in prose.
    """
    field = Task._meta.get_field("percent_complete")
    bounds = {
        type(v): v.limit_value
        for v in field.validators
        if isinstance(v, MinValueValidator | MaxValueValidator)
    }
    assert bounds.get(MinValueValidator) == 0
    assert bounds.get(MaxValueValidator) == 100


def test_jira_importer_writes_full_percent_for_a_delivered_issue() -> None:
    """#2889: a Jira ``Done`` issue is worth 100, not the 1.0 fraction that read as 1%."""
    data = parse_jira_xml(STATUS_EXPORT)
    _assert_within_bounds(data.tasks, "jiraimport")

    by_name = {task.name: task for task in data.tasks}
    shipped = by_name["Shipped work"]
    assert shipped.status == TaskStatus.COMPLETE.value
    assert shipped.percent_complete == FULL_PERCENT
    # A non-terminal issue carries no progress claim at all — the export has no
    # percent field, so anything above 0 here would be invented.
    assert by_name["Active work"].percent_complete == 0.0


def test_msproject_importer_writes_full_percent_for_a_delivered_task() -> None:
    """#1759: MSPDI ``PercentComplete`` is already 0-100; a 100% task stays 100."""
    data = parse_xml(_MSPDI_SAMPLE.read_bytes())
    _assert_within_bounds(data.tasks, "msproject")

    complete = [t for t in data.tasks if t.percent_complete == FULL_PERCENT]
    assert complete, "sample.xml carries a PercentComplete=100 task; none parsed at 100"


def test_csv_importer_writes_full_percent_for_a_delivered_row() -> None:
    """A spreadsheet ``100%`` cell is 100 on the same scale as the other two."""
    result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    _assert_within_bounds(result.project_data.tasks, "csvimport")

    by_name = {task.name: task for task in result.project_data.tasks}
    assert by_name["Stakeholder interviews"].percent_complete == FULL_PERCENT
