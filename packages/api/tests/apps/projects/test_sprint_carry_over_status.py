"""What a carry-over does to a task's status (#2913).

``apply_carry_over``'s ``backlog`` branch overwrote **every** carry-eligible status
with ``BACKLOG`` while the sprint-target branch preserved status, and nothing said so —
the function docstring called the move a "pure FK reassignment", and the API surfaced
nothing. A contributor's real state ("I am working on this", "this is in review") was
discarded by sprint housekeeping they did not perform, and they found out by noticing
their own board looked wrong.

The two policies stay asymmetric on purpose, and this suite pins the line:

* a sprint target is a **re-commitment** — nothing but the FK moves;
* ``backlog`` is a **de-commitment**, so ``NOT_STARTED`` ("committed, not begun")
  becomes ``BACKLOG`` — which is also what keeps the row in the product-backlog
  grooming list;
* ``IN_PROGRESS`` and ``REVIEW`` describe what a person is doing rather than a
  commitment level, and survive the move.
"""

from __future__ import annotations

from datetime import date

import pytest

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import apply_carry_over


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Apollo", start_date=date(2026, 1, 1), calendar=cal)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.ACTIVE,
    )


@pytest.fixture
def next_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 1, 15),
        finish_date=date(2026, 1, 28),
        state=SprintState.PLANNED,
    )


def _task(project: Project, sprint: Sprint, wbs: str, status: str) -> Task:
    return Task.objects.create(
        project=project, sprint=sprint, name=f"T{wbs}", wbs_path=wbs, duration=2, status=status
    )


# ---------------------------------------------------------------------------
# carry_over_to="backlog" — work in flight keeps its status
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("status", [TaskStatus.IN_PROGRESS, TaskStatus.REVIEW])
def test_backlog_carry_over_preserves_work_in_flight(
    project: Project, sprint: Sprint, status: str
) -> None:
    """The defect: a contributor's own state, erased by somebody else's sprint close."""
    task = _task(project, sprint, "1", status)

    moved = apply_carry_over(sprint, "backlog")

    task.refresh_from_db()
    assert str(task.pk) in moved
    assert task.sprint_id is None
    assert task.status == status


@pytest.mark.django_db
def test_backlog_carry_over_decommits_a_not_started_task(project: Project, sprint: Sprint) -> None:
    """NOT_STARTED means "committed, not begun" — untrue once the task leaves the sprint.

    It is also what keeps the row in the product-backlog grooming list, which is scoped
    ``status=BACKLOG AND sprint IS NULL``.
    """
    task = _task(project, sprint, "1", TaskStatus.NOT_STARTED)

    apply_carry_over(sprint, "backlog")

    task.refresh_from_db()
    assert task.sprint_id is None
    assert task.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_backlog_carry_over_leaves_a_backlog_task_alone(project: Project, sprint: Sprint) -> None:
    task = _task(project, sprint, "1", TaskStatus.BACKLOG)

    apply_carry_over(sprint, "backlog")

    task.refresh_from_db()
    assert task.sprint_id is None
    assert task.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_backlog_carry_over_applies_the_right_rule_per_task_in_one_pass(
    project: Project, sprint: Sprint
) -> None:
    """A real sprint carries a mix — the rule is per task, not per close."""
    in_progress = _task(project, sprint, "1", TaskStatus.IN_PROGRESS)
    review = _task(project, sprint, "2", TaskStatus.REVIEW)
    not_started = _task(project, sprint, "3", TaskStatus.NOT_STARTED)

    moved = apply_carry_over(sprint, "backlog")

    for t in (in_progress, review, not_started):
        t.refresh_from_db()
        assert str(t.pk) in moved
        assert t.sprint_id is None
    assert in_progress.status == TaskStatus.IN_PROGRESS
    assert review.status == TaskStatus.REVIEW
    assert not_started.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_backlog_carry_over_bumps_server_version_so_mobile_sync_sees_it(
    project: Project, sprint: Sprint
) -> None:
    """Regression guard on the reason this branch iterates instead of using .update()."""
    task = _task(project, sprint, "1", TaskStatus.IN_PROGRESS)
    before = task.server_version

    apply_carry_over(sprint, "backlog")

    task.refresh_from_db()
    assert task.server_version > before


@pytest.mark.django_db
def test_backlog_carry_over_leaves_a_completed_task_in_the_closed_sprint(
    project: Project, sprint: Sprint
) -> None:
    """Only carry-eligible statuses move; the completed set is what completed_* counted."""
    done = _task(project, sprint, "1", TaskStatus.COMPLETE)

    moved = apply_carry_over(sprint, "backlog")

    done.refresh_from_db()
    assert str(done.pk) not in moved
    assert done.sprint_id == sprint.pk
    assert done.status == TaskStatus.COMPLETE


# ---------------------------------------------------------------------------
# carry_over_to=<sprint> — the branch that was already correct
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "status", [TaskStatus.IN_PROGRESS, TaskStatus.REVIEW, TaskStatus.NOT_STARTED]
)
def test_sprint_target_carry_over_preserves_every_status(
    project: Project, sprint: Sprint, next_sprint: Sprint, status: str
) -> None:
    """A re-commitment: the FK moves and nothing else does. Unchanged by #2913."""
    task = _task(project, sprint, "1", status)

    apply_carry_over(sprint, str(next_sprint.pk))

    task.refresh_from_db()
    assert task.sprint_id == next_sprint.pk
    assert task.status == status


@pytest.mark.django_db
def test_carry_over_none_moves_nothing(project: Project, sprint: Sprint) -> None:
    task = _task(project, sprint, "1", TaskStatus.IN_PROGRESS)

    assert apply_carry_over(sprint, "none") == []

    task.refresh_from_db()
    assert task.sprint_id == sprint.pk
    assert task.status == TaskStatus.IN_PROGRESS
