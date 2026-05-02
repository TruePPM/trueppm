"""Smoke tests for the seed_demo_project management command (issue #296)."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.projects.models import (
    Methodology,
    Project,
    RetroActionItem,
    Sprint,
    SprintBurnSnapshot,
    SprintRetro,
    SprintState,
    Task,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


@pytest.mark.django_db
def test_seed_creates_two_projects() -> None:
    call_command("seed_demo_project")
    assert Project.objects.filter(name="Platform Migration").exists()
    assert Project.objects.filter(name="Pilot Deployment").exists()


@pytest.mark.django_db
def test_seed_is_idempotent() -> None:
    """Re-running the command produces the same shape, not duplicates."""
    call_command("seed_demo_project")
    first_count = Project.objects.filter(name="Platform Migration").count()
    call_command("seed_demo_project")
    second_count = Project.objects.filter(name="Platform Migration").count()
    assert first_count == 1
    assert second_count == 1


@pytest.mark.django_db
def test_seed_populates_every_wave10_surface() -> None:
    call_command("seed_demo_project")
    p = Project.objects.get(name="Platform Migration")

    # WBS — phases + work packages + milestones
    tasks = Task.objects.filter(project=p, is_deleted=False)
    assert tasks.count() >= 17, "expected ≥17 tasks (phases + WPs + milestones + sprint stories)"

    # Methodology preset (#233) — HYBRID so all tabs show
    assert p.methodology == Methodology.HYBRID

    # Sprint history (#234) — 8 closed + 1 active + 1 planned
    closed = Sprint.objects.filter(project=p, state=SprintState.COMPLETED).count()
    active = Sprint.objects.filter(project=p, state=SprintState.ACTIVE).count()
    planned = Sprint.objects.filter(project=p, state=SprintState.PLANNED).count()
    assert closed == 8, f"expected 8 closed sprints, got {closed}"
    assert active == 1, f"expected 1 active sprint, got {active}"
    assert planned == 1, f"expected 1 planned sprint, got {planned}"

    # Burndown (#228) — daily snapshots on the active sprint
    active_sprint = Sprint.objects.get(project=p, state=SprintState.ACTIVE)
    assert SprintBurnSnapshot.objects.filter(sprint=active_sprint).count() >= 7

    # Capacity (#228) — assignments + at least one over-allocation
    assignments = TaskResource.objects.filter(task__project=p)
    assert assignments.count() >= 5
    over = [r for r in Resource.objects.all() if assignments.filter(resource=r).count() > 1]
    assert len(over) >= 1, "expected at least one over-allocated resource"

    # Retro (#231) — notes + 3 items + at least one promoted
    retros = SprintRetro.objects.filter(sprint__project=p)
    assert retros.count() == 1
    items = RetroActionItem.objects.filter(retro__sprint__project=p)
    assert items.count() == 3
    promoted = [it for it in items if it.promoted_task_id is not None]
    assert len(promoted) >= 1


@pytest.mark.django_db
def test_with_personas_creates_six_users_with_memberships() -> None:
    call_command("seed_demo_project", "--with-personas")
    expected = {"maya", "raj", "diana", "sarah", "carlos", "tom"}
    actual = set(User.objects.filter(username__in=expected).values_list("username", flat=True))
    assert actual == expected
    p = Project.objects.get(name="Platform Migration")
    assert ProjectMembership.objects.filter(project=p).count() == 6
    # Diana, Sarah, Tom also see the secondary project for the multi-team lens.
    pilot = Project.objects.get(name="Pilot Deployment")
    pilot_users = set(
        ProjectMembership.objects.filter(project=pilot).values_list("user__username", flat=True)
    )
    assert {"diana", "sarah", "tom"} <= pilot_users


@pytest.mark.django_db
def test_without_personas_creates_no_demo_users() -> None:
    call_command("seed_demo_project")
    assert (
        User.objects.filter(username__in=["maya", "raj", "diana", "sarah", "carlos", "tom"]).count()
        == 0
    )
