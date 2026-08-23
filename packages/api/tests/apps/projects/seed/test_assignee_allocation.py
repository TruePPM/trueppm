"""A seeded assignee produces the allocation row capacity actually reads (#2900).

Capacity, utilization and the heatmap sum ``TaskResource.units`` and never read
``Task.assignee``. Every bundled seed pack authors assignees and **no**
``assignments`` array at all — roughly 150 assigned tasks across the four, zero
allocation rows — which made ``_assign_resources`` dead code for every sample that
ships. An evaluator clicking "Load demo data" saw an owner on every board card and
a completely empty resource heatmap, and concluded the capacity features do not
work. They were not wrong about what they saw.

The fix synthesizes the row in the importer rather than adding ``assignments`` to
the four fixtures, so it also covers any future fixture that authors an assignee
and forgets the allocation — the mistake all four made.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Project, Task
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

pytestmark = pytest.mark.django_db

User = get_user_model()

_SEEDS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)

#: Discovered from the directory, not hard-coded: a pack added later is covered by
#: these guards automatically. A hard-coded list is exactly how all four existing
#: packs shipped unallocated without anything noticing.
BUNDLED = sorted(path.stem for path in _SEEDS_DIR.glob("*.json"))


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="alloc-owner", email="o@example.com")


def _seed() -> dict[str, Any]:
    """A minimal seed exercising every branch of the assignee fallback."""
    return {
        "schema_version": "1.0",
        "program": {
            "slug": "alloc",
            "name": "Allocation",
            "methodology": "HYBRID",
            "lead": "alex",
        },
        "accounts": [
            {
                "slug": "alex",
                "username": "alloc-alex",
                "email": "alex@example.com",
                "display_name": "Alex Rivera",
                "role": "OWNER",
            },
            {
                "slug": "unstaffed",
                "username": "alloc-unstaffed",
                "display_name": "Unstaffed Person",
                "role": "MEMBER",
            },
            {
                "slug": "ada",
                "username": "alloc-ada",
                "display_name": "Ada Advisor",
                "role": "MEMBER",
            },
        ],
        "calendars": [
            {"slug": "default", "name": "Standard", "working_days": 31, "hours_per_day": 8.0}
        ],
        "resources": [
            {
                "slug": "alex",
                "name": "Alex Rivera",
                "email": "alex@example.com",
                "max_units": 1.0,
                "calendar": "default",
                "account": "alex",
            },
            {
                "slug": "ada",
                "name": "Ada Advisor",
                "max_units": 0.1,
                "calendar": "default",
                "account": "ada",
            },
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "2026-01-05",
                "calendar": "default",
                "tasks": [
                    # The defect's shape: an assignee and no assignments array.
                    {"wbs_path": "1", "name": "Bare assignee", "duration": 5, "assignee": "alex"},
                    # An explicit assignment must still win, at its own units.
                    {
                        "wbs_path": "2",
                        "name": "Explicit",
                        "duration": 5,
                        "assignee": "alex",
                        "assignments": [{"resource": "alex", "units": 0.25}],
                    },
                    # A gate, not work somebody performs.
                    {
                        "wbs_path": "3",
                        "name": "GA",
                        "is_milestone": True,
                        "delivery_mode": "milestone",
                        "assignee": "alex",
                    },
                    # An account the seed never staffed with a resource.
                    {
                        "wbs_path": "4",
                        "name": "Unstaffed",
                        "duration": 5,
                        "assignee": "unstaffed",
                    },
                    # No owner at all.
                    {"wbs_path": "5", "name": "Unowned", "duration": 5},
                    # A 10% advisor — must not be billed a full unit.
                    {"wbs_path": "6", "name": "Advisory", "duration": 5, "assignee": "ada"},
                ],
            },
        ],
    }


def _alloc(project: Project, wbs: str) -> list[TaskResource]:
    task = Task.objects.get(project=project, wbs_path=wbs.replace(".", "_") if False else wbs)
    return list(TaskResource.objects.filter(task=task))


# --------------------------------------------------------------------------- #
# The fallback
# --------------------------------------------------------------------------- #


def test_bare_assignee_gets_an_allocation_row(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner)
    project = Project.objects.get(program=program, name="Core")

    rows = _alloc(project, "1")

    assert len(rows) == 1
    assert rows[0].resource.name == "Alex Rivera"
    assert float(rows[0].units) == 1.0


def test_a_part_time_resource_is_allocated_at_their_own_availability(owner: Any) -> None:
    """A bare assignee means "at their normal availability", not "full-time".

    The packs deliberately staff 10% advisors and half-timers. Billing an advisor
    a full unit would put her at 1000% on every task she owns — an all-red heatmap
    misrepresenting the exact capacity story the fixture exists to tell.
    """
    program = import_seed(_seed(), owner=owner)
    project = Project.objects.get(program=program, name="Core")

    rows = _alloc(project, "6")

    assert len(rows) == 1
    assert float(rows[0].units) == 0.1
    assert float(rows[0].resource.max_units) == 0.1


def test_an_explicit_assignment_wins_and_is_not_doubled(owner: Any) -> None:
    """A seed that states units means them — the fallback must not add a second row."""
    program = import_seed(_seed(), owner=owner)
    project = Project.objects.get(program=program, name="Core")

    rows = _alloc(project, "2")

    assert len(rows) == 1, "the assignee fallback must not stack on an explicit assignment"
    assert float(rows[0].units) == 0.25


def test_a_milestone_gets_no_allocation(owner: Any) -> None:
    """A milestone is a gate; giving it units would inflate every heatmap cell it lands in."""
    program = import_seed(_seed(), owner=owner)
    project = Project.objects.get(program=program, name="Core")

    assert _alloc(project, "3") == []


def test_an_assignee_with_no_resource_is_skipped(owner: Any) -> None:
    """There is no defensible units figure for a person the seed never staffed."""
    program = import_seed(_seed(), owner=owner)
    project = Project.objects.get(program=program, name="Core")

    assert _alloc(project, "4") == []


def test_an_unowned_task_gets_no_allocation(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner)
    project = Project.objects.get(program=program, name="Core")

    assert _alloc(project, "5") == []


def test_the_resource_lands_on_the_project_roster(owner: Any) -> None:
    """Anything that creates a TaskResource must roster the resource (#241), or the
    heatmap has units to sum and nobody to show them against."""
    program = import_seed(_seed(), owner=owner)
    project = Project.objects.get(program=program, name="Core")

    resource = Resource.objects.get(name="Alex Rivera")
    assert ProjectResource.objects.filter(project=project, resource=resource).exists()


def test_reload_does_not_stack_allocation(owner: Any) -> None:
    """Re-importing over an existing program (the "reload the demo" path) must
    leave one allocation row, not two."""
    payload = _seed()
    import_seed(copy.deepcopy(payload), owner=owner)
    program = import_seed(copy.deepcopy(payload), owner=owner, replace=True)
    project = Project.objects.get(program=program, name="Core")

    assert len(_alloc(project, "1")) == 1


# --------------------------------------------------------------------------- #
# The bundled packs — the surface an evaluator actually judges us on
# --------------------------------------------------------------------------- #


def _expected_allocations(payload: dict[str, Any]) -> int:
    """Tasks the fixture declares an owner for, whom it also staffs as a resource.

    Derived from the fixture rather than from ``Task.assignee``: on the generic
    import path ``create_users`` is False, so an account that does not exist
    resolves to ``None`` and the column is empty even though the seed named
    somebody. The allocation does not depend on an account being minted — the
    resource is what carries load — so the fixture is the right denominator.
    """
    by_account = {r["account"] for r in payload.get("resources", []) if r.get("account")}
    total = 0
    for project in payload["projects"]:
        for task in project.get("tasks", []):
            if task.get("assignments"):
                total += len(task["assignments"])
            elif task.get("assignee") in by_account and not task.get("is_milestone"):
                total += 1
    return total


@pytest.mark.parametrize("stem", BUNDLED)
def test_every_bundled_pack_now_produces_allocation(stem: str, owner: Any) -> None:
    """The regression guard. The four packs ship ~150 assignees between them and
    declared zero ``assignments``; before the fix every one of these was 0."""
    payload = json.loads((_SEEDS_DIR / f"{stem}.json").read_text(encoding="utf-8"))
    expected = _expected_allocations(copy.deepcopy(payload))
    program = import_seed(payload, owner=owner, create_users=True, is_sample=True)
    projects = list(Project.objects.filter(program=program))

    allocated = TaskResource.objects.filter(task__project__in=projects).count()

    assert expected > 0, f"{stem} staffs nobody at all — the fixture changed shape"
    assert allocated == expected, (
        f"{stem}: fixture declares {expected} allocatable owner(s) but {allocated} allocation "
        "row(s) landed — capacity, utilization and the heatmap read TaskResource.units, "
        "never Task.assignee"
    )


@pytest.mark.parametrize("stem", BUNDLED)
def test_every_bundled_pack_rosters_the_people_it_allocates(stem: str, owner: Any) -> None:
    payload = json.loads((_SEEDS_DIR / f"{stem}.json").read_text(encoding="utf-8"))
    program = import_seed(payload, owner=owner, create_users=True, is_sample=True)
    projects = list(Project.objects.filter(program=program))

    for project in projects:
        allocated = set(
            TaskResource.objects.filter(task__project=project).values_list("resource_id", flat=True)
        )
        rostered = set(
            ProjectResource.objects.filter(project=project).values_list("resource_id", flat=True)
        )
        assert allocated <= rostered, f"{stem}/{project.name}: allocated but not rostered"
