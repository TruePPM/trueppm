"""An imported MS Project plan with milestones recomputes to the file's own dates (#4079).

MS Project treats a zero-duration milestone as an instant: a gate after five days of
work sits on the Friday that work finishes, and the next task starts Monday. Until
#4079 the CPM engine gave every milestone a working day of its own, so an imported
plan recomputed one working day later per milestone on the path and no longer
matched its source file. These tests import an MS Project XML document whose
``<Start>``/``<Finish>`` are what MS Project computes for the network, run the real
recalculation, and compare.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.msproject.parser import parse_xml
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule

_NS = "http://schemas.microsoft.com/project"
_FS = "1"  # MS Project PredecessorLink/Type for finish-to-start

# (UID, name, duration, milestone, start, finish, predecessor UIDs) — the dates are
# the ones MS Project computes on a standard Mon-Fri calendar from Mon 2026-01-05.
_PLAN = [
    ("1", "Kickoff", "PT0H0M0S", True, "2026-01-05T08:00:00", "2026-01-05T08:00:00", []),
    ("2", "Design", "PT40H0M0S", False, "2026-01-05T08:00:00", "2026-01-09T17:00:00", ["1"]),
    ("3", "Design gate", "PT0H0M0S", True, "2026-01-09T17:00:00", "2026-01-09T17:00:00", ["2"]),
    ("4", "Build", "PT24H0M0S", False, "2026-01-12T08:00:00", "2026-01-14T17:00:00", ["3"]),
    ("5", "Release", "PT0H0M0S", True, "2026-01-14T17:00:00", "2026-01-14T17:00:00", ["4"]),
]


def _plan_xml() -> bytes:
    root = ET.Element(f"{{{_NS}}}Project")
    ET.SubElement(root, f"{{{_NS}}}Name").text = "Milestone parity"
    ET.SubElement(root, f"{{{_NS}}}StartDate").text = "2026-01-05T08:00:00"
    tasks_el = ET.SubElement(root, f"{{{_NS}}}Tasks")
    for uid, name, duration, milestone, start, finish, preds in _PLAN:
        task_el = ET.SubElement(tasks_el, f"{{{_NS}}}Task")
        for key, value in (
            ("UID", uid),
            ("ID", uid),
            ("Name", name),
            ("Duration", duration),
            ("Milestone", "1" if milestone else "0"),
            ("Start", start),
            ("Finish", finish),
        ):
            ET.SubElement(task_el, f"{{{_NS}}}{key}").text = value
        for pred in preds:
            link = ET.SubElement(task_el, f"{{{_NS}}}PredecessorLink")
            ET.SubElement(link, f"{{{_NS}}}PredecessorUID").text = pred
            ET.SubElement(link, f"{{{_NS}}}Type").text = _FS
            ET.SubElement(link, f"{{{_NS}}}LinkLag").text = "0"
    return ET.tostring(root, encoding="unicode").encode("utf-8")


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="Milestone parity",
        start_date=date(2026, 1, 5),
        # Pin the data date to the plan start: an unset one floors every task at
        # today, which would move the whole plan off the file's dates.
        status_date=date(2026, 1, 5),
        calendar=Calendar.objects.create(name="Standard"),
    )


@pytest.mark.django_db
def test_recomputed_dates_equal_the_ms_project_file(project: Project) -> None:
    import_project(str(project.pk), parse_xml(_plan_xml()))
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))

    by_name = {t.name: t for t in Task.objects.filter(project=project)}
    for _uid, name, _duration, _milestone, start, finish, _preds in _PLAN:
        task = by_name[name]
        assert task.early_start == date.fromisoformat(start[:10]), name
        assert task.early_finish == date.fromisoformat(finish[:10]), name
    # Every task is on the one path, so none of them has float to spare.
    assert all(t.total_float == 0 for t in by_name.values())


def _recalculated(project: Project) -> dict[str, Task]:
    import_project(str(project.pk), parse_xml(_plan_xml()))
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
    return {t.name: t for t in Task.objects.filter(project=project)}


@pytest.mark.django_db
def test_recalculation_persists_which_end_of_the_day_a_milestone_sits_on(
    project: Project,
) -> None:
    """#4079: the engine's instant reading reaches the row, for both kinds.

    ``early_start`` alone cannot say it — "Fri" is the end of Friday for the gate
    after Design and would be the start of Friday for a floor-held milestone — and
    the Gantt drew every diamond at the start of its day, over its predecessor.
    """
    by_name = _recalculated(project)
    # Held by the project-start floor: the start of its day.
    assert by_name["Kickoff"].milestone_at_day_end is False
    # Driven by work: the end of the predecessor's finish day.
    assert by_name["Design gate"].milestone_at_day_end is True
    assert by_name["Release"].milestone_at_day_end is True
    # Never set on work.
    assert by_name["Design"].milestone_at_day_end is False
    assert by_name["Build"].milestone_at_day_end is False


@pytest.mark.django_db
def test_recalculation_clears_a_stale_end_of_day_flag(project: Project) -> None:
    """A milestone that stops following work loses the flag on the next pass."""
    by_name = _recalculated(project)
    gate = by_name["Design gate"]
    assert gate.milestone_at_day_end is True
    # An SNET on the following Monday now holds it: the start of that day.
    Task.objects.filter(pk=gate.pk).update(planned_start=date(2026, 1, 12))
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
    gate.refresh_from_db()
    assert gate.early_start == date(2026, 1, 12)
    assert gate.milestone_at_day_end is False


@pytest.mark.django_db
def test_export_writes_an_end_of_day_milestone_at_the_calendar_finish_time(
    project: Project,
) -> None:
    """#4079: MSPDI Start/Finish carry the instant, not midnight of the shown day.

    The emitted calendar is one 08:00 shift of ``hours_per_day`` (8h -> 16:00);
    an end-of-day milestone sits at that finish time. A floor-held one and all
    work keep the exporter's midnight.
    """
    from trueppm_api.apps.msproject.exporter import export_project_xml

    _recalculated(project)
    root = ET.fromstring(export_project_xml(str(project.pk)))
    ns = {"m": _NS}
    dates = {
        el.findtext("m:Name", namespaces=ns): (
            el.findtext("m:Start", namespaces=ns),
            el.findtext("m:Finish", namespaces=ns),
        )
        for el in root.findall("m:Tasks/m:Task", ns)
    }
    assert dates["Design gate"] == ("2026-01-09T16:00:00", "2026-01-09T16:00:00")
    assert dates["Release"] == ("2026-01-14T16:00:00", "2026-01-14T16:00:00")
    assert dates["Kickoff"] == ("2026-01-05T00:00:00", "2026-01-05T00:00:00")
    assert dates["Design"] == ("2026-01-05T00:00:00", "2026-01-09T00:00:00")
    # The same instant the <Calendars> block declares as the end of the day.
    to_times = {el.text for el in root.iter(f"{{{_NS}}}ToTime")}
    assert to_times == {"16:00:00"}
