"""The #3068 upgrade repair: duplicate live ``(project, wbs_path)`` rows.

Migration ``0148`` adds ``unique_task_wbs_path_per_project_live``. ``AddConstraint``
VALIDATES the new GiST index against every existing row, so a database that already
holds two live tasks sharing a path cannot migrate — and migrations run on container
start, making that an upgrade crash-loop.

The repair is tested through ``projects.backfill``, never by importing the migration
module: a squash deletes migration file names and takes any such test with it
(CLAUDE.md migration rule 3).

Duplicates can be *created* here at all only because the constraint is
``INITIALLY DEFERRED`` and pytest-django rolls each test back without committing, so
the check never fires on its own. ``_force_constraint_check`` below is what makes the
central assertion real: it runs ``SET CONSTRAINTS ... IMMEDIATE``, which is exactly
the validation ``AddConstraint`` performs on a live database.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.db import connection
from django.db.utils import IntegrityError

from trueppm_api.apps.projects.backfill import repair_duplicate_wbs_paths
from trueppm_api.apps.projects.models import Calendar, Project, Task

CONSTRAINT = "unique_task_wbs_path_per_project_live"


def _force_constraint_check() -> None:
    """Check the deferred constraint NOW, the way ``AddConstraint`` would on upgrade."""
    with connection.cursor() as cur:
        cur.execute(f"SET CONSTRAINTS {CONSTRAINT} IMMEDIATE")


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(
        name="Duplicate WBS", start_date=date(2026, 1, 1), calendar=calendar
    )


def _task(project: Project, path: str | None, *, sync_seq: int, deleted: bool = False) -> Task:
    """Create a row at ``path`` directly, bypassing anything that would renumber it."""
    task = Task.objects.create(project=project, name=f"task {path}", duration=1)
    Task.objects.filter(pk=task.pk).update(wbs_path=path, sync_seq=sync_seq, is_deleted=deleted)
    task.refresh_from_db()
    return task


@pytest.mark.django_db
def test_clean_database_is_a_no_op(project: Project) -> None:
    _task(project, "1", sync_seq=1)
    _task(project, "2", sync_seq=2)
    assert repair_duplicate_wbs_paths(Task) == []
    _force_constraint_check()


@pytest.mark.django_db
def test_the_fixture_really_would_break_the_upgrade(project: Project) -> None:
    """Guard the guard: if duplicates could not be created, every test below is vacuous."""
    _task(project, "1", sync_seq=1)
    _task(project, "1", sync_seq=2)
    with pytest.raises(IntegrityError):
        _force_constraint_check()


@pytest.mark.django_db
def test_duplicates_are_repaired_and_the_constraint_then_validates(project: Project) -> None:
    keeper = _task(project, "1", sync_seq=1)
    mover = _task(project, "1", sync_seq=2)

    repaired = repair_duplicate_wbs_paths(Task)

    # The whole point: this is the call that used to abort the upgrade.
    _force_constraint_check()

    assert len(repaired) == 1
    assert repaired[0].task_id == str(mover.pk)
    assert repaired[0].kept_task_id == str(keeper.pk)
    assert repaired[0].old_path == "1"

    keeper.refresh_from_db()
    mover.refresh_from_db()
    assert str(keeper.wbs_path) == "1"
    assert str(mover.wbs_path) == repaired[0].new_path != "1"


@pytest.mark.django_db
def test_the_earliest_row_in_the_project_write_sequence_keeps_the_path(
    project: Project,
) -> None:
    # Task has no created_at (#3068 proposed ordering on one); sync_seq is the
    # project's monotonic write cursor and is the closest thing that exists.
    late = _task(project, "3", sync_seq=90)
    early = _task(project, "3", sync_seq=7)

    repair_duplicate_wbs_paths(Task)

    early.refresh_from_db()
    late.refresh_from_db()
    assert str(early.wbs_path) == "3"
    assert str(late.wbs_path) != "3"


@pytest.mark.django_db
def test_a_nested_duplicate_moves_among_its_siblings_not_to_a_new_root(
    project: Project,
) -> None:
    """A row a planner put inside phase 4 must not be promoted to top level."""
    _task(project, "4", sync_seq=1)
    _task(project, "4.1", sync_seq=2)
    _task(project, "4.2", sync_seq=3)
    mover = _task(project, "4.2", sync_seq=4)

    repaired = repair_duplicate_wbs_paths(Task)
    _force_constraint_check()

    mover.refresh_from_db()
    assert str(mover.wbs_path).startswith("4.")
    assert str(mover.wbs_path) not in {"4.1", "4.2"}
    assert repaired[0].new_path == str(mover.wbs_path)


@pytest.mark.django_db
def test_a_root_duplicate_lands_past_the_project_s_highest_root(project: Project) -> None:
    _task(project, "1", sync_seq=1)
    _task(project, "2", sync_seq=2)
    _task(project, "3", sync_seq=3)
    mover = _task(project, "1", sync_seq=4)

    repair_duplicate_wbs_paths(Task)

    mover.refresh_from_db()
    assert str(mover.wbs_path) == "4"


@pytest.mark.django_db
def test_descendants_stay_with_the_kept_row_and_the_count_is_reported(
    project: Project,
) -> None:
    """The ambiguity is reported, not guessed at.

    A row at ``4.2.1`` is a child of "the ``4.2`` in this project". With two of those,
    nothing in the data says which — so the subtree stays put and the operator is told
    how many rows that covers.
    """
    _task(project, "4", sync_seq=1)
    keeper = _task(project, "4.2", sync_seq=2)
    child = _task(project, "4.2.1", sync_seq=3)
    grandchild = _task(project, "4.2.1.1", sync_seq=4)
    _task(project, "4.2", sync_seq=5)

    repaired = repair_duplicate_wbs_paths(Task)

    assert repaired[0].kept_task_id == str(keeper.pk)
    assert repaired[0].stranded_descendants == 2
    child.refresh_from_db()
    grandchild.refresh_from_db()
    assert str(child.wbs_path) == "4.2.1"
    assert str(grandchild.wbs_path) == "4.2.1.1"


@pytest.mark.django_db
def test_three_rows_on_one_path_get_distinct_new_paths(project: Project) -> None:
    _task(project, "1", sync_seq=1)
    _task(project, "1", sync_seq=2)
    _task(project, "1", sync_seq=3)

    repaired = repair_duplicate_wbs_paths(Task)
    _force_constraint_check()

    assert len(repaired) == 2
    assert len({r.new_path for r in repaired}) == 2
    assert Task.objects.filter(is_deleted=False).count() == 3


@pytest.mark.django_db
def test_soft_deleted_rows_neither_trigger_nor_block_a_repair(project: Project) -> None:
    """The constraint's condition is ``is_deleted=False``, so tombstones are invisible."""
    live = _task(project, "1", sync_seq=1)
    _task(project, "1", sync_seq=2, deleted=True)

    assert repair_duplicate_wbs_paths(Task) == []
    live.refresh_from_db()
    assert str(live.wbs_path) == "1"
    _force_constraint_check()


@pytest.mark.django_db
def test_two_projects_are_repaired_independently(project: Project) -> None:
    other = Project.objects.create(
        name="Other", start_date=date(2026, 1, 1), calendar=project.calendar
    )
    _task(project, "1", sync_seq=1)
    _task(project, "1", sync_seq=2)
    _task(other, "1", sync_seq=1)
    _task(other, "1", sync_seq=2)

    repaired = repair_duplicate_wbs_paths(Task)
    _force_constraint_check()

    assert len(repaired) == 2
    assert {r.project_id for r in repaired} == {str(project.pk), str(other.pk)}


@pytest.mark.django_db
def test_repair_is_idempotent(project: Project) -> None:
    _task(project, "1", sync_seq=1)
    _task(project, "1", sync_seq=2)

    first = repair_duplicate_wbs_paths(Task)
    second = repair_duplicate_wbs_paths(Task)

    assert len(first) == 1
    assert second == []


@pytest.mark.django_db
def test_every_move_is_logged_at_warning_with_both_paths(
    project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    """The log is the operator's only record of what the upgrade changed.

    Asserted here rather than on the migration wrapper: CLAUDE.md migration rule 3
    forbids importing a migration module in a test, so the logging lives beside the
    repair where it can actually be covered.
    """
    keeper = _task(project, "1", sync_seq=1)
    mover = _task(project, "1", sync_seq=2)

    with caplog.at_level("WARNING", logger="trueppm_api.apps.projects.backfill"):
        repair_duplicate_wbs_paths(Task)

    text = caplog.text
    assert str(mover.pk) in text
    assert str(keeper.pk) in text
    assert "moved 1 -> " in text
    assert "#3068" in text


@pytest.mark.django_db
def test_a_clean_database_logs_nothing(project: Project, caplog: pytest.LogCaptureFixture) -> None:
    _task(project, "1", sync_seq=1)
    with caplog.at_level("WARNING", logger="trueppm_api.apps.projects.backfill"):
        repair_duplicate_wbs_paths(Task)
    assert caplog.text == ""


@pytest.mark.django_db
def test_the_log_names_the_subtree_left_behind(
    project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    _task(project, "4", sync_seq=1)
    _task(project, "4.2", sync_seq=2)
    _task(project, "4.2.1", sync_seq=3)
    _task(project, "4.2", sync_seq=4)

    with caplog.at_level("WARNING", logger="trueppm_api.apps.projects.backfill"):
        repair_duplicate_wbs_paths(Task)

    # Not merely "1 descendant" — the operator has to know the subtree did not follow
    # the row that moved, because that is the part they may need to re-parent by hand.
    assert "1 live row(s) under 4.2 stayed with task" in caplog.text
