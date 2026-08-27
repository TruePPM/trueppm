"""Importing into a non-empty project must number past the rows already there (#3069).

``_build_wbs_paths()`` derives every path from the source file's own
``OutlineNumber`` / ``OutlineLevel``. It is handed the parsed task list and nothing
else — so it always numbers from ``1``. That is right for create-from-import, where
the project was made empty for this file, and wrong for every import into a project
that already holds rows.

Before ``unique_task_wbs_path_per_project_live`` this silently corrupted the WBS: two
live rows on one path, which collapses the next ``rewrite_level`` pass and strands the
subtree beneath. Since the constraint landed it is a hard failure at COMMIT, which is
what makes these tests possible to write as behavior rather than as a path audit.

**Why one file for three importers.** CSV, Jira and MS Project all run the same
``import_project``, so the fix is one offset in ``_create_tasks`` — but #2610 and
#3061 are both cases of a fix landing on one wrapper and never reaching its siblings,
and #3061's own sweep is what should have found these three. Asserting each path
separately is the tripwire for the next single-site fix.

**Why ``INDENTED_CSV`` and not ``REFERENCE_CSV``.** The reference fixture does not
import to its own numbering even on an empty project: its ``Phase`` column mixes bare
and dotted codes, and the parser reads a bare one as a *depth*, so "Build" lands at
``4`` and orphans ``2.1``–``2.3``. That is #3082, it reproduces identically on
unmodified ``main``, and asserting around it here would bake it in as expected. The
indented fixture parses cleanly and has a three-deep subtree, which the offset needs
to carry anyway.

Every committing test is ``transaction=True``. The constraint is ``INITIALLY
DEFERRED``, so PostgreSQL checks it at COMMIT — under pytest-django's default
non-committing fixture the check never runs, the collision never surfaces, and a test
written to prove the fix would pass just as happily without it.
"""

from __future__ import annotations

import base64
import pathlib
from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus
from trueppm_api.apps.projects.models import Calendar, Project, Task

from ..csvimport.fixtures import INDENTED_CSV
from ..jiraimport.fixtures import CHAIN_EXPORT

MSP_MINIMAL = pathlib.Path(__file__).parent / "fixtures" / "minimal.xml"

# These tests commit (``transaction=True``), so the post-commit broadcast really
# fires — and the dev stack's Valkey publishes no host port, so a real emit fails
# on connect for a reason that has nothing to do with WBS numbering. Patched at the
# same seam as the other cross-importer test file.
BROADCAST = "trueppm_api.apps.sync.broadcast.broadcast_board_event"

# The same problem one seam further in: a committed import schedules a CPM
# recalculation through Celery, whose broker is that same unreachable Valkey. It is
# irrelevant to what these tests assert — recalculation moves dates, never
# ``wbs_path`` — but an unpatched dispatch fails the commit and rolls the import
# back, so every assertion below reads an empty project. Patched at the seam
# ``test_msproject.py`` and ``jiraimport/test_tasks.py`` already use.
RECALC = "trueppm_api.apps.scheduling.services.enqueue_recalculate"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def empty_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Empty", start_date=date(2026, 9, 1), calendar=calendar)


@pytest.fixture
def occupied_project(calendar: Calendar) -> Project:
    """A project already holding two hand-typed roots, one of them with a child.

    Roots ``1`` and ``2`` are precisely the paths every fixture file below wants to
    write, so an unshifted import collides on its first row rather than needing a
    contrived overlap.
    """
    project = Project.objects.create(
        name="Occupied", start_date=date(2026, 9, 1), calendar=calendar
    )
    for path in ("1", "2", "2.1"):
        Task.objects.create(project=project, name=f"Existing {path}", wbs_path=path, duration=3)
    return project


def _paths(project: Project) -> set[str]:
    return {
        str(p)
        for p in Task.objects.filter(project=project, is_deleted=False).values_list(
            "wbs_path", flat=True
        )
        if p
    }


def _roots(project: Project) -> set[str]:
    return {p.split(".")[0] for p in _paths(project)}


def _run_csv(project: Project) -> None:
    from trueppm_api.apps.csvimport.tasks import import_csv

    req = CsvImportRequest.objects.create(
        project=project,
        filename="plan.csv",
        file_content_b64=base64.b64encode(INDENTED_CSV).decode("ascii"),
        status=CsvImportStatus.DISPATCHED,
    )
    with patch(BROADCAST), patch(RECALC):
        import_csv.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": req.file_content_b64,
                "filename": req.filename,
                "import_request_id": str(req.pk),
            },
            throw=True,
        )


def _run_jira(project: Project) -> None:
    from trueppm_api.apps.jiraimport.tasks import import_jira

    req = JiraImportRequest.objects.create(
        project=project,
        filename="jira.xml",
        file_content_b64=base64.b64encode(CHAIN_EXPORT).decode("ascii"),
        status=JiraImportStatus.DISPATCHED,
    )
    with patch(BROADCAST), patch(RECALC):
        import_jira.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": req.file_content_b64,
                "filename": req.filename,
                "import_request_id": str(req.pk),
            },
            throw=True,
        )


def _run_msproject(project: Project) -> None:
    from trueppm_api.apps.msproject.tasks import import_msproject

    with patch(BROADCAST), patch(RECALC):
        import_msproject.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": base64.b64encode(MSP_MINIMAL.read_bytes()).decode("ascii"),
                "filename": "minimal.xml",
            },
            throw=True,
        )


# ---------------------------------------------------------------------------
# Import into a non-empty project — the defect
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_csv_reimport_appends_past_existing_rows(occupied_project: Project) -> None:
    """The CSV wizard's second delivery into a live project (``csvimport/tasks.py``)."""
    _run_csv(occupied_project)

    # The three seeded rows survive untouched, and nothing landed on their paths.
    assert {"1", "2", "2.1"} <= _paths(occupied_project)
    assert Task.objects.filter(project=occupied_project, is_deleted=False).count() == 10
    # INDENTED_CSV carries roots 1 and 2; shifted past the occupied 1 and 2 they
    # become 3 and 4. Nothing may remain at the file's own numbering.
    assert _roots(occupied_project) == {"1", "2", "3", "4"}


@pytest.mark.django_db(transaction=True)
def test_csv_reimport_moves_each_subtree_as_a_unit(occupied_project: Project) -> None:
    """A shift that renumbered children independently would scatter the phases.

    ``offset_wbs_path`` moves only the leading segment, so "1.2.1" under offset 2
    becomes "3.2.1" — the phase keeps its internal numbering and its full depth,
    not just its immediate children. This is
    the assertion that would fail if someone re-derived the paths after the shift
    instead of translating them.
    """
    _run_csv(occupied_project)

    imported = _paths(occupied_project) - {"1", "2", "2.1"}
    assert imported == {"3", "3.1", "3.2", "3.2.1", "3.2.2", "4", "4.1"}


@pytest.mark.django_db(transaction=True)
def test_jira_reimport_appends_past_existing_rows(occupied_project: Project) -> None:
    """The Jira pull's second delivery (``jiraimport/tasks.py``)."""
    _run_jira(occupied_project)

    assert {"1", "2", "2.1"} <= _paths(occupied_project)
    imported = _paths(occupied_project) - {"1", "2", "2.1"}
    assert imported, "the Jira fixture created no tasks — the assertion below is vacuous"
    assert all(int(p.split(".")[0]) > 2 for p in imported)


@pytest.mark.django_db(transaction=True)
def test_msproject_reimport_appends_past_existing_rows(occupied_project: Project) -> None:
    """The import-into-existing flow (``msproject/tasks.py``, ``creates_project`` False)."""
    _run_msproject(occupied_project)

    assert {"1", "2", "2.1"} <= _paths(occupied_project)
    imported = _paths(occupied_project) - {"1", "2", "2.1"}
    assert imported == {"3"}


# ---------------------------------------------------------------------------
# The cases that must NOT shift
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_csv_into_an_empty_project_keeps_the_files_own_numbering(
    empty_project: Project,
) -> None:
    """First import is the case the old behavior was written for; it must not move."""
    _run_csv(empty_project)

    assert _paths(empty_project) == {"1", "1.1", "1.2", "1.2.1", "1.2.2", "2", "2.1"}


@pytest.mark.django_db(transaction=True)
def test_msproject_into_an_empty_project_keeps_the_files_own_numbering(
    empty_project: Project,
) -> None:
    _run_msproject(empty_project)

    assert _paths(empty_project) == {"1"}


@pytest.mark.django_db(transaction=True)
def test_create_from_import_writes_verbatim_even_over_existing_rows(
    occupied_project: Project,
) -> None:
    """``wipe_existing=True`` is create-from-import (ADR-0092) and must stay verbatim.

    The rows it deletes are a partial prior attempt at *this same file*, so after the
    wipe the project is empty by construction and the file's numbering is correct.
    Shifting here would renumber every create-from-import against a project the user
    never saw, and an orphan-drain re-dispatch would drift further on each retry.
    """
    from trueppm_api.apps.msproject.importer import import_project
    from trueppm_api.apps.msproject.parser import parse_xml

    data = parse_xml(MSP_MINIMAL.read_bytes())
    with patch(BROADCAST), patch(RECALC):
        import_project(str(occupied_project.pk), data, wipe_existing=True)

    assert _paths(occupied_project) == {"1"}
