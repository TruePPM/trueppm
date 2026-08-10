"""Tests for the seed_capacity management command (issue #2391).

The command exists to put a known quantity of data behind the API so the
published scale envelope can be measured. Its correctness claims are therefore
narrow but load-bearing: if `--reset` under-deletes, or the requested row counts
are not what actually lands, every published capacity number is measured against
a different database than its label claims.
"""

from __future__ import annotations

import secrets

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.management.commands.seed_capacity import (
    CAPACITY_OWNER_EMAIL,
    CAPACITY_OWNER_PASSWORD_ENV,
    CAPACITY_PROGRAM_CODE,
)
from trueppm_api.apps.projects.models import Dependency, Program, Project, Task

# Generated rather than a literal so this file never carries a credential-shaped
# string of its own — the whole point of #2457.
TEST_PASSWORD = secrets.token_urlsafe(16)


@pytest.fixture(autouse=True)
def _capacity_password(monkeypatch: pytest.MonkeyPatch) -> None:
    """The owner password comes from the environment, so every seed needs it set."""
    monkeypatch.setenv(CAPACITY_OWNER_PASSWORD_ENV, TEST_PASSWORD)


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
def test_requires_the_password_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """There is no committed default — an unset variable must stop the seed (#2457)."""
    monkeypatch.delenv(CAPACITY_OWNER_PASSWORD_ENV, raising=False)

    with pytest.raises(CommandError, match=CAPACITY_OWNER_PASSWORD_ENV):
        call_command("seed_capacity", tasks=5, projects=1)

    assert not Project.objects.exists()


@pytest.mark.django_db
def test_rejects_a_password_that_fails_the_project_validators(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operator-supplied value is arbitrary, so a weak one must not stand up a login."""
    monkeypatch.setenv(CAPACITY_OWNER_PASSWORD_ENV, "1234")

    with pytest.raises(CommandError, match=CAPACITY_OWNER_PASSWORD_ENV):
        call_command("seed_capacity", tasks=5, projects=1)


@pytest.mark.django_db
def test_owner_can_authenticate_with_the_supplied_password() -> None:
    """The load driver logs in with this exact value — a mismatch fails every sweep."""
    call_command("seed_capacity", tasks=5, projects=1)

    owner = get_user_model().objects.get(email=CAPACITY_OWNER_EMAIL)
    assert owner.check_password(TEST_PASSWORD)


@pytest.mark.django_db
def test_reseeding_rotates_the_owner_password_to_the_current_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stale password on a pre-existing owner would fail the runner's login."""
    call_command("seed_capacity", tasks=5, projects=1)

    rotated = secrets.token_urlsafe(16)
    monkeypatch.setenv(CAPACITY_OWNER_PASSWORD_ENV, rotated)
    call_command("seed_capacity", tasks=5, projects=1, reset=True)

    owner = get_user_model().objects.get(email=CAPACITY_OWNER_EMAIL)
    assert owner.check_password(rotated)


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


@pytest.mark.django_db
def test_member_email_grants_owner_on_every_project() -> None:
    """`perf:load` authenticates as a DIFFERENT seeded user than the capacity owner.

    Project reads are membership-scoped, so without this grant the harness gets a
    200 with an empty page and silently measures nothing — the #2816 failure mode
    in a new costume.
    """
    other = get_user_model().objects.create_user(
        username="ci@trueppm.test", email="ci@trueppm.test", password=TEST_PASSWORD
    )
    call_command("seed_capacity", tasks=5, projects=2, member_email=other.email)

    memberships = ProjectMembership.objects.filter(user=other)
    assert memberships.count() == 2
    assert all(m.role == Role.OWNER for m in memberships)
    # The capacity owner still gets its own grant — the flag adds, never replaces.
    assert ProjectMembership.objects.filter(user__email=CAPACITY_OWNER_EMAIL).count() == 2


@pytest.mark.django_db
def test_member_email_rejects_an_unknown_user() -> None:
    """A typo must fail loudly, not seed a fixture the harness cannot read."""
    with pytest.raises(CommandError, match="does not match an existing user"):
        call_command("seed_capacity", tasks=5, projects=1, member_email="nobody@trueppm.test")


@pytest.mark.django_db
def test_member_email_is_validated_before_anything_is_seeded() -> None:
    """Fail before the write, so a bad flag cannot leave a half-built fixture behind."""
    with pytest.raises(CommandError):
        call_command("seed_capacity", tasks=5, projects=1, member_email="nobody@trueppm.test")

    assert not Project.objects.filter(program__code=CAPACITY_PROGRAM_CODE).exists()
    assert Task.objects.count() == 0


@pytest.mark.django_db
def test_member_email_matching_the_owner_is_not_double_granted() -> None:
    """get_or_create would tolerate it; assert it rather than leave it to luck."""
    call_command("seed_capacity", tasks=5, projects=1)
    call_command(
        "seed_capacity", tasks=5, projects=1, reset=True, member_email=CAPACITY_OWNER_EMAIL
    )

    assert ProjectMembership.objects.filter(user__email=CAPACITY_OWNER_EMAIL).count() == 1
