"""Tests for the seed_capacity management command (issue #2391).

The command exists to put a known quantity of data behind the API so the
published scale envelope can be measured. Its correctness claims are therefore
narrow but load-bearing: if `--reset` under-deletes, or the requested row counts
are not what actually lands, every published capacity number is measured against
a different database than its label claims.
"""

from __future__ import annotations

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.management.commands.seed_capacity import (
    CAPACITY_OWNER_EMAIL,
    CAPACITY_PROGRAM_CODE,
)
from trueppm_api.apps.projects.models import Dependency, Program, Project, Task


@pytest.mark.django_db
def test_seeds_requested_task_count() -> None:
    call_command("seed_capacity", tasks=25, projects=1)

    program = Program.objects.get(code=CAPACITY_PROGRAM_CODE)
    projects = Project.objects.filter(program=program)
    assert projects.count() == 1
    assert Task.objects.filter(project__in=projects).count() == 25


@pytest.mark.django_db
def test_seeds_multiple_projects_with_tasks_each() -> None:
    """`--tasks` is per project, not a total — the envelope's labels depend on it."""
    call_command("seed_capacity", tasks=10, projects=3)

    program = Program.objects.get(code=CAPACITY_PROGRAM_CODE)
    projects = Project.objects.filter(program=program)
    assert projects.count() == 3
    assert Task.objects.filter(project__in=projects).count() == 30


@pytest.mark.django_db
def test_owner_gets_owner_membership_on_every_project() -> None:
    """Without this the load driver authenticates fine and then reads 403/empty."""
    call_command("seed_capacity", tasks=5, projects=2)

    memberships = ProjectMembership.objects.filter(user__email=CAPACITY_OWNER_EMAIL)
    assert memberships.count() == 2
    assert all(m.role == Role.OWNER for m in memberships)


@pytest.mark.django_db
def test_edge_ratio_drives_dependency_count() -> None:
    """CPM cost is edge-driven, so the ratio has to actually move the edge count."""
    call_command("seed_capacity", tasks=50, projects=1, edge_ratio=2.0)

    edges = Dependency.objects.count()
    # The spine contributes len(tasks) - 1; cross-links top it up toward the
    # target. Duplicate (pred, succ, type) triples are dropped by the unique
    # constraint via ignore_conflicts, so this is a floor, not an equality.
    assert edges >= 50
    assert edges <= 100


@pytest.mark.django_db
def test_dependencies_are_acyclic_forward_only() -> None:
    """A cycle in the seed would trip the engine rather than measure it."""
    call_command("seed_capacity", tasks=40, projects=1, edge_ratio=2.0)

    order = {
        task_id: index
        for index, task_id in enumerate(
            Task.objects.order_by("short_id").values_list("id", flat=True)
        )
    }
    for predecessor_id, successor_id in Dependency.objects.values_list(
        "predecessor_id", "successor_id"
    ):
        assert order[predecessor_id] < order[successor_id]


@pytest.mark.django_db
def test_reset_removes_prior_projects_rather_than_orphaning_them() -> None:
    """The regression this command shipped with.

    `Project.program` is nullable, so deleting only the Program leaves its
    projects behind as orphans and the next seed stacks on top of them. Every
    later measurement then runs against more data than its label claims.
    """
    call_command("seed_capacity", tasks=10, projects=2)
    call_command("seed_capacity", tasks=10, projects=1, reset=True)

    program = Program.objects.get(code=CAPACITY_PROGRAM_CODE)
    assert Project.objects.filter(program=program).count() == 1
    # No orphan rows survive anywhere, not merely none attached to the program.
    assert Project.objects.count() == 1
    assert Task.objects.count() == 10


@pytest.mark.django_db
def test_reset_is_safe_when_nothing_was_seeded() -> None:
    call_command("seed_capacity", tasks=5, projects=1, reset=True)
    assert Task.objects.count() == 5


@pytest.mark.django_db
def test_short_ids_are_unique_within_a_project() -> None:
    """bulk_create bypasses the save() that normally allocates short_id."""
    call_command("seed_capacity", tasks=30, projects=1)

    short_ids = list(Task.objects.values_list("short_id", flat=True))
    assert len(short_ids) == len(set(short_ids))


@pytest.mark.django_db
def test_object_sequence_is_reconciled_after_bulk_create() -> None:
    """Otherwise the next API-created task collides with a seeded short_id."""
    call_command("seed_capacity", tasks=30, projects=1)

    project = Project.objects.get()
    assert project.object_sequence == 30


@pytest.mark.django_db
@pytest.mark.parametrize(("tasks", "projects"), [(0, 1), (5, 0)])
def test_rejects_non_positive_sizes(tasks: int, projects: int) -> None:
    with pytest.raises(CommandError):
        call_command("seed_capacity", tasks=tasks, projects=projects)


@pytest.mark.django_db
def test_rejects_negative_edge_ratio() -> None:
    with pytest.raises(CommandError):
        call_command("seed_capacity", tasks=5, projects=1, edge_ratio=-1.0)


@pytest.mark.django_db
def test_is_deterministic_across_runs() -> None:
    """A capacity number that moves between runs must be the code, not the fixture."""
    call_command("seed_capacity", tasks=40, projects=1, edge_ratio=2.0)
    first = sorted(Dependency.objects.values_list("predecessor__short_id", "successor__short_id"))
    first_durations = list(Task.objects.order_by("short_id").values_list("duration", flat=True))

    call_command("seed_capacity", tasks=40, projects=1, edge_ratio=2.0, reset=True)
    second = sorted(Dependency.objects.values_list("predecessor__short_id", "successor__short_id"))
    second_durations = list(Task.objects.order_by("short_id").values_list("duration", flat=True))

    assert first == second
    assert first_durations == second_durations
