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
