"""Import start-shift broadcast parity across MS Project, CSV and Jira (#2610).

An import can pull a project's ``start_date`` back under a task that predates it
(#867/#873). That moves the schedule boundary for everyone on the project, and
neither ``tasks_restructured`` nor the recalc's ``cpm_complete`` invalidates the
project record — both speak about tasks. So without a ``project_updated``
broadcast, a collaborator watching the Gantt sees the whole schedule shift with
no signal and no attribution.

All three importers run the same ``import_project``, but each had its own task
module, and the #873 broadcast was added to the MS Project wrapper only.

The live defect is CSV. Jira is wired to the same helper but cannot shift the
start today — its parser sets no task dates — and the test below says so rather
than asserting a behavior that does not exist; see its docstring.

The tests are deliberately weighted toward the broken path AND the one that
worked: a shared-helper refactor that quietly dropped the MS Project emit would
be the same defect in the other direction, which is exactly how this class of
bug travels.
"""

from __future__ import annotations

import base64
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest

from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus
from trueppm_api.apps.msproject.importer import broadcast_import_project_record_change
from trueppm_api.apps.projects.models import Calendar, Project

from ..csvimport.fixtures import REFERENCE_CSV
from ..jiraimport.fixtures import CHAIN_EXPORT

BROADCAST = "trueppm_api.apps.sync.broadcast.broadcast_board_event"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def late_project(calendar: Calendar) -> Project:
    """A project starting well after any fixture task, so an import must shift it."""
    return Project.objects.create(name="Late start", start_date=date(2030, 1, 1), calendar=calendar)


def _project_updated_calls(mock: Any) -> list[Any]:
    return [c for c in mock.call_args_list if c.args[1:2] == ("project_updated",)]


# ---------------------------------------------------------------------------
# The shared helper's own contract
# ---------------------------------------------------------------------------


# transaction=True on the two positive cases: the helper defers with
# transaction.on_commit, and pytest-django's default wrapping transaction never
# commits — so the callback would never run and the assertion would fail for a
# reason that has nothing to do with the code under test.
@pytest.mark.django_db(transaction=True)
def test_helper_broadcasts_on_a_start_shift(late_project: Project) -> None:
    with patch(BROADCAST) as mock:
        broadcast_import_project_record_change(
            str(late_project.pk), {"project_start_shifted": True}
        )
    assert _project_updated_calls(mock)


@pytest.mark.django_db(transaction=True)
def test_helper_broadcasts_on_a_calendar_change(late_project: Project) -> None:
    """Project.calendar is project-record state too, and rides the same event."""
    with patch(BROADCAST) as mock:
        broadcast_import_project_record_change(str(late_project.pk), {"calendar_applied": True})
    assert _project_updated_calls(mock)


@pytest.mark.django_db
def test_helper_is_silent_when_nothing_moved(late_project: Project) -> None:
    """An ordinary import must not tell every peer to re-fetch the project."""
    with patch(BROADCAST) as mock:
        broadcast_import_project_record_change(
            str(late_project.pk),
            {"project_start_shifted": False, "calendar_applied": False, "tasks_created": 12},
        )
    assert mock.call_args_list == []


@pytest.mark.django_db
def test_helper_is_silent_on_a_summary_missing_the_keys(late_project: Project) -> None:
    """Absent must read as "did not happen", not as truthy-by-omission."""
    with patch(BROADCAST) as mock:
        broadcast_import_project_record_change(str(late_project.pk), {"tasks_created": 3})
    assert mock.call_args_list == []


# ---------------------------------------------------------------------------
# The three import paths
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_csv_import_broadcasts_the_start_shift(late_project: Project) -> None:
    from trueppm_api.apps.csvimport.tasks import import_csv

    req = CsvImportRequest.objects.create(
        project=late_project,
        filename="plan.csv",
        file_content_b64=base64.b64encode(REFERENCE_CSV).decode("ascii"),
        status=CsvImportStatus.DISPATCHED,
    )
    with patch(BROADCAST) as mock:
        import_csv.apply(
            kwargs={
                "project_id": str(late_project.pk),
                "file_content_b64": req.file_content_b64,
                "filename": req.filename,
                "import_request_id": str(req.pk),
            },
            throw=True,
        )

    late_project.refresh_from_db()
    # Precondition: the import really did move the boundary. Without this the
    # assertion below could pass vacuously on a fixture whose dates changed.
    assert late_project.start_date < date(2030, 1, 1)
    assert _project_updated_calls(mock), "CSV import shifted the start without telling anyone"


@pytest.mark.django_db(transaction=True)
def test_jira_import_cannot_shift_the_start_today(late_project: Project) -> None:
    """Jira imports do not move the project start — and this pins down why.

    The audit reported CSV *and* Jira as silently shifting the start. Only CSV
    does. ``jiraimport/parser.py`` never populates ``TaskData.start`` (a Jira
    export carries estimates and statuses, not dates — start-date constraints are
    explicitly deferred, ADR-0259), so ``_maybe_shift_project_start`` returns at
    its ``if not task_start_strs`` guard and nothing moves.

    The Jira wrapper is still wired to the shared helper. That is not ceremony:
    the day the parser learns to read ``duedate`` or a start custom field, the
    broadcast appears with it instead of becoming the third instance of this same
    bug. This test is the tripwire — if it starts failing because the start DID
    move, the parser gained dates and the behavior is now correct, not broken.
    """
    from trueppm_api.apps.jiraimport.tasks import import_jira

    req = JiraImportRequest.objects.create(
        project=late_project,
        filename="jira.xml",
        file_content_b64=base64.b64encode(CHAIN_EXPORT).decode("ascii"),
        status=JiraImportStatus.DISPATCHED,
    )
    with patch(BROADCAST) as mock:
        import_jira.apply(
            kwargs={
                "project_id": str(late_project.pk),
                "file_content_b64": req.file_content_b64,
                "filename": req.filename,
                "import_request_id": str(req.pk),
            },
            throw=True,
        )

    late_project.refresh_from_db()
    assert late_project.start_date == date(2030, 1, 1)
    assert not _project_updated_calls(mock)


@pytest.mark.django_db(transaction=True)
def test_msproject_import_still_broadcasts_the_start_shift(late_project: Project) -> None:
    """The path that already worked. This is the point of the test file.

    #2610 exists because a fix landed on one wrapper and never reached its
    siblings. Collapsing the three wrappers onto a shared helper fixes that —
    and creates the mirror-image risk of dropping the working emit while
    refactoring. Assert it explicitly rather than trusting the diff.
    """
    import pathlib

    from trueppm_api.apps.msproject.tasks import import_msproject

    content = (pathlib.Path(__file__).parent / "fixtures" / "minimal.xml").read_bytes()
    with patch(BROADCAST) as mock:
        import_msproject.apply(
            kwargs={
                "project_id": str(late_project.pk),
                "file_content_b64": base64.b64encode(content).decode("ascii"),
                "filename": "minimal.xml",
            },
            throw=True,
        )

    late_project.refresh_from_db()
    assert late_project.start_date < date(2030, 1, 1)
    assert _project_updated_calls(mock)


@pytest.mark.django_db(transaction=True)
def test_an_import_that_does_not_shift_the_start_stays_quiet(calendar: Calendar) -> None:
    """The negative case, on a real import rather than the helper alone."""
    from trueppm_api.apps.csvimport.tasks import import_csv

    early = Project.objects.create(
        name="Early start", start_date=date(2000, 1, 1), calendar=calendar
    )
    req = CsvImportRequest.objects.create(
        project=early,
        filename="plan.csv",
        file_content_b64=base64.b64encode(REFERENCE_CSV).decode("ascii"),
        status=CsvImportStatus.DISPATCHED,
    )
    with patch(BROADCAST) as mock:
        import_csv.apply(
            kwargs={
                "project_id": str(early.pk),
                "file_content_b64": req.file_content_b64,
                "filename": req.filename,
                "import_request_id": str(req.pk),
            },
            throw=True,
        )

    early.refresh_from_db()
    assert early.start_date == date(2000, 1, 1)
    assert not _project_updated_calls(mock)
